// yangtze-ferry@1（长江渡轮 / 长江之旅）的模块级测试。
//
// 覆盖四件事：
//   1) 全仓唯一「玩家主动选择落点」的机制：顺流下（付费直达下一渡口）/ 逆流上（免费回上一渡口）。
//   2) 一回合只换乘一次：换乘抵达的渡口不再结算落点、不再摆换乘选项（顺手掐掉无限往返）。
//   3) 本模块不写任何公共状态：publicRuleState.modules 里出现它的键即视为损坏存档。
//   4) 回归（这是本轮修掉的真实缺陷）：无状态模块**仍然必须**有 postTransitionHook。
//      投降与托管跳过会在不消费待选动作的情况下推进回合，残留的 `managing` 选项会让
//      下一位玩家掷骰 / 买地 / 结束回合全部拿到 WRONG_PHASE——表现为零计时器、零报错的静默冻结。
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@richman/board-data';
import { yangtzeTourMap } from '@richman/board-data';
import { applyIntent, createGame, skipCurrentTurn } from '../engine';
import { resolveLanding } from '../effects';
import { chooseBotIntent } from '../bot';
import { hydrateGameState } from '../hydrate';
import { defaultRuleModuleRegistry } from '../moduleRegistry';
import { YANGTZE_FERRY_MODULE_KEY, ferryCells } from '../yangtzeFerryModule';
import type { GameEvent, GameState, PendingModuleAction } from '../types';

const ferryRef = { id: 'yangtze-ferry', version: 1 } as const;
const coreRef = { id: 'core', version: 1 } as const;

/** 长江之旅的三处渡口（棋盘数组顺序 = 上下游顺序）。 */
const FERRY_CELLS = [15, 33, 50];
const FERRY_A = 15;
const FERRY_B = 33;
/** 环回首尾：第 1 个渡口的上一站是最后 1 个渡口。 */
const FERRY_C = 50;
const DOWNSTREAM_COST = 400;
const BOT_DOWNSTREAM_RESERVE = 2600;

function makeGame(playerCount = 2): GameState {
  return createGame({
    mapRef: yangtzeTourMap.ref,
    ruleModules: yangtzeTourMap.game.requiredRuleModules,
    board: yangtzeTourMap.game.board,
    cards: yangtzeTourMap.game.cards,
    config: yangtzeTourMap.game.config,
    players: [
      { id: 'p1', nickname: '甲' },
      { id: 'p2', nickname: '乙' },
      { id: 'p3', nickname: '丙' },
    ].slice(0, playerCount),
    seed: '20260923',
  });
}

function cashOf(state: GameState, playerId: string): number {
  return state.players.find((player) => player.id === playerId)!.cash;
}

function playerOf(state: GameState, playerId: string) {
  return state.players.find((player) => player.id === playerId)!;
}

function placePlayer(state: GameState, playerId: string, position: number): GameState {
  return {
    ...state,
    players: state.players.map((player) => (
      player.id === playerId ? { ...player, position } : player
    )),
  };
}

function setCash(state: GameState, playerId: string, cash: number): GameState {
  return {
    ...state,
    players: state.players.map((player) => (
      player.id === playerId ? { ...player, cash } : player
    )),
  };
}

function pendingOfKind(state: GameState, kind: string): PendingModuleAction {
  const action = state.publicRuleState.pendingActions.find((candidate) => (
    typeof candidate.payload === 'object'
    && candidate.payload !== null
    && (candidate.payload as Record<string, JsonValue>).kind === kind
  ));
  if (!action) throw new Error(`missing ferry-choice action with kind=${kind}`);
  return action;
}

function hasKind(state: GameState, kind: string): boolean {
  return state.publicRuleState.pendingActions.some((candidate) => (
    (candidate.payload as Record<string, JsonValue>).kind === kind
  ));
}

function intentFor(action: PendingModuleAction) {
  return {
    type: 'module' as const,
    module: action.module,
    action: action.action,
    payload: action.payload,
  };
}

function moduleEvents(events: readonly GameEvent[]): GameEvent[] {
  return events.filter((event) => event.type === 'module');
}

function landOnFerry(state: GameState, playerId: string, cellId = FERRY_A) {
  return resolveLanding(placePlayer(state, playerId, cellId), playerId, []);
}

describe('yangtze-ferry@1 落点结算与选项', () => {
  it('createGame 初始化干净的公开规则状态，且注册表认识 yangtze-ferry@1', () => {
    const state = makeGame();

    expect(state.publicRuleState).toEqual({ modules: {}, pendingActions: [] });
    expect(state.ruleModules).toEqual([coreRef, ferryRef]);
    expect(yangtzeTourMap.game.requiredRuleModules).toEqual([coreRef, ferryRef]);
  });

  it('棋盘上恰好三处渡口，且默认 registry 认识 ferry 格的处理器', () => {
    const state = makeGame();

    expect(ferryCells(state.board).map((cell) => cell.id)).toEqual(FERRY_CELLS);
    for (const cell of ferryCells(state.board)) {
      expect(() => defaultRuleModuleRegistry.getCellHandler(state.ruleModules, cell)).not.toThrow();
    }
  });

  it('落在渡口生成三个共用 action 名的选项，且落点不动钱也不写状态', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnFerry(base, playerId);

    expect(landed.state.turnPhase).toBe('managing');
    const actions = landed.state.publicRuleState.pendingActions;
    expect(actions).toHaveLength(3);
    expect([...new Set(actions.map((action) => `${action.module.id}@${action.module.version}:${action.action}`))])
      .toEqual([`${YANGTZE_FERRY_MODULE_KEY}:ferry-choice`]);
    expect(actions.map((action) => action.requiredPhase)).toEqual(['managing', 'managing', 'managing']);
    expect(actions.map((action) => action.playerId)).toEqual([playerId, playerId, playerId]);
    expect(actions.map((action) => action.label)).toEqual([
      `顺流下（付 ${DOWNSTREAM_COST} 元，直达下一渡口）`,
      '逆流上（免费，回到上一渡口）',
      '不换乘',
    ]);
    expect(actions.every((action) => (
      (action.payload as Record<string, JsonValue>).optionId === action.optionId
    ))).toBe(true);
    expect(cashOf(landed.state, playerId)).toBe(base.config.initialCash);
    expect(landed.state.publicRuleState.modules).toEqual({});
    expect(moduleEvents(landed.events).map((event) => (event as unknown as { eventType: string }).eventType))
      .toEqual(['ferry_visited']);
  });

  it('现金不足船资时不生成顺流选项，逆流（免费）照常在', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnFerry(setCash(base, playerId, DOWNSTREAM_COST - 1), playerId);

    expect(landed.state.publicRuleState.pendingActions).toHaveLength(2);
    expect(hasKind(landed.state, 'downstream')).toBe(false);
    expect(hasKind(landed.state, 'upstream')).toBe(true);
    expect(pendingOfKind(landed.state, 'skip').label).toBe('不换乘');
  });
});

describe('yangtze-ferry@1 换乘', () => {
  it('顺流下付费直达下一渡口，路径只有终点一格，且不领过起点工资', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnFerry(base, playerId);

    const moved = applyIntent(landed.state, playerId, intentFor(pendingOfKind(landed.state, 'downstream')));
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;

    expect(cashOf(moved.state, playerId)).toBe(base.config.initialCash - DOWNSTREAM_COST);
    expect(playerOf(moved.state, playerId).position).toBe(FERRY_B);
    // 尾巴上固定三条：模块事件 → 顺流船费的 bank_paid → token_moved。
    // bank_paid 是现金守恒（simulate.ts）的依据——船费离开牌桌却不留流水，残差会一直挂在账上。
    expect(moved.state.recentLog.slice(-3)).toEqual([
      {
        type: 'module',
        module: ferryRef,
        eventType: 'ferry_transferred',
        payload: { playerId, fromCellId: FERRY_A, toCellId: FERRY_B, cost: DOWNSTREAM_COST, direction: 'downstream' },
      },
      { type: 'bank_paid', playerId, amount: DOWNSTREAM_COST },
      { type: 'token_moved', playerId, path: [FERRY_B] },
    ]);
    // 坐船不是走路：没有过起点工资，也没有在目的地重新摆出换乘选项（一回合只换乘一次）。
    expect(moved.events.some((event) => event.type === 'salary_collected')).toBe(false);
    expect(moved.state.publicRuleState.pendingActions).toEqual([]);
    expect(moved.state.publicRuleState.modules).toEqual({});
  });

  it('逆流上免费，且从第一座渡口环回到最后一座渡口', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnFerry(base, playerId);

    const moved = applyIntent(landed.state, playerId, intentFor(pendingOfKind(landed.state, 'upstream')));
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;

    expect(cashOf(moved.state, playerId)).toBe(base.config.initialCash);
    expect(playerOf(moved.state, playerId).position).toBe(FERRY_C);
    expect(moduleEvents(moved.events)).toEqual([{
      type: 'module',
      module: ferryRef,
      eventType: 'ferry_transferred',
      payload: { playerId, fromCellId: FERRY_A, toCellId: FERRY_C, cost: 0, direction: 'upstream' },
    }]);
    expect(moved.state.publicRuleState.pendingActions).toEqual([]);
  });

  it('不换乘只记事件，不动钱，选项消费后可以正常结束回合', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnFerry(base, playerId);

    const declined = applyIntent(landed.state, playerId, intentFor(pendingOfKind(landed.state, 'skip')));
    expect(declined.ok).toBe(true);
    if (!declined.ok) return;

    expect(cashOf(declined.state, playerId)).toBe(base.config.initialCash);
    expect(playerOf(declined.state, playerId).position).toBe(FERRY_A);
    expect(declined.state.publicRuleState.pendingActions).toEqual([]);
    expect(declined.state.recentLog.slice(-1)).toEqual([{
      type: 'module',
      module: ferryRef,
      eventType: 'ferry_declined',
      payload: { playerId, cellId: FERRY_A },
    }]);
    expect(applyIntent({ ...declined.state, turnPhase: 'managing' }, playerId, { type: 'end_turn' }).ok).toBe(true);
  });
});

describe('yangtze-ferry@1 bot 策略', () => {
  it('现金宽裕时搭一次顺风船', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnFerry(setCash(base, playerId, BOT_DOWNSTREAM_RESERVE), playerId);

    expect(chooseBotIntent(landed.state, playerId)).toEqual({
      type: 'module',
      module: ferryRef,
      action: 'ferry-choice',
      payload: pendingOfKind(landed.state, 'downstream').payload,
    });
  });

  it('现金没到安全垫时不换乘', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnFerry(setCash(base, playerId, BOT_DOWNSTREAM_RESERVE - 1), playerId);

    expect(chooseBotIntent(landed.state, playerId)).toEqual({
      type: 'module',
      module: ferryRef,
      action: 'ferry-choice',
      payload: pendingOfKind(landed.state, 'skip').payload,
    });
  });

  it('没有渡口选项时把决策交回既有链路（掷骰）', () => {
    const base = makeGame();
    expect(chooseBotIntent(base, base.currentPlayerId)).toEqual({ type: 'roll_dice' });
  });
});

describe('yangtze-ferry@1 失效选项清理（静默冻结回归）', () => {
  it('投降推进回合后清掉失效渡口选项，下一位玩家可以正常掷骰', () => {
    const base = makeGame(3);
    const playerId = base.currentPlayerId;
    const landed = landOnFerry(base, playerId);
    expect(landed.state.publicRuleState.pendingActions).toHaveLength(3);

    const surrendered = applyIntent(landed.state, playerId, { type: 'surrender' });
    expect(surrendered.ok).toBe(true);
    if (!surrendered.ok) return;

    expect(surrendered.state.publicRuleState.pendingActions).toEqual([]);
    const next = surrendered.state.currentPlayerId;
    expect(next).not.toBe(playerId);
    // 关键：闸门「有待选动作时非匹配意图一律 WRONG_PHASE」不会再把下一位玩家锁住。
    expect(applyIntent(surrendered.state, next, { type: 'roll_dice' }).ok).toBe(true);
  });

  it('托管跳过当前玩家后同样清掉失效选项，且不带任何公共状态', () => {
    const base = makeGame(3);
    const playerId = base.currentPlayerId;
    const landed = landOnFerry(base, playerId);

    const skipped = skipCurrentTurn(landed.state, playerId);
    expect(skipped.ok).toBe(true);
    if (!skipped.ok) return;

    expect(skipped.state.publicRuleState.pendingActions).toEqual([]);
    expect(skipped.state.publicRuleState.modules).toEqual({});
    expect(applyIntent(skipped.state, skipped.state.currentPlayerId, { type: 'roll_dice' }).ok).toBe(true);
  });
});

describe('yangtze-ferry@1 hydrate 校验', () => {
  it('正常状态可以无损恢复', () => {
    const state = makeGame();
    expect(hydrateGameState(structuredClone(state), yangtzeTourMap)).toMatchObject({ ok: true });
  });

  it('无状态模块在 publicRuleState.modules 里出现键即视为损坏存档', () => {
    const state = makeGame();
    const broken = {
      ...structuredClone(state),
      publicRuleState: { modules: { [YANGTZE_FERRY_MODULE_KEY]: { chain: [15, 33, 50] } }, pendingActions: [] },
    };

    expect(hydrateGameState(broken, yangtzeTourMap)).toMatchObject({ ok: false });
  });
});
