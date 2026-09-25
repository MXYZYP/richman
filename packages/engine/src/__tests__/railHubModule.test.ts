// rail-hub@1（高铁枢纽 / 中国之旅）的模块级测试。
//
// 覆盖四件事：
//   1) 落点结算只摆选项、不动钱；同一动作名下多分支（候车 / 换乘 / 不换乘）。
//   2) 候车：有停赛则清空、没有则领补贴——全仓唯一能主动解除 skip_turns 的机制。
//   3) 换乘：付费跳跃、不领过起点工资、一回合只跳一次（目的地不再结算落点）。
//   4) 回归：本模块没有公共状态，但必须靠 postTransitionHook 清掉失效待选动作，
//      否则投降 / 托管跳过会留下 `managing` 选项把下一位玩家彻底卡死。
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@richman/board-data';
import { chinaTourMap } from '@richman/board-data';
import { applyIntent, createGame, skipCurrentTurn } from '../engine';
import { resolveLanding } from '../effects';
import { chooseBotIntent } from '../bot';
import { hydrateGameState } from '../hydrate';
import { defaultRuleModuleRegistry } from '../moduleRegistry';
import { RAIL_HUB_MODULE_KEY, railHubCells } from '../railHubModule';
import type { GameEvent, GameState, PendingModuleAction } from '../types';

const railHubRef = { id: 'rail-hub', version: 1 } as const;
const coreRef = { id: 'core', version: 1 } as const;

/** 中国之旅的两座枢纽（棋盘数组顺序 = 线路顺序）。 */
const HUB_A = 26;
const HUB_B = 39;
const TRANSFER_FARE = 500;
const WAIT_BONUS = 300;
const BOT_TRANSFER_RESERVE = 3000;

function makeGame(playerCount = 2): GameState {
  return createGame({
    mapRef: chinaTourMap.ref,
    ruleModules: chinaTourMap.game.requiredRuleModules,
    board: chinaTourMap.game.board,
    cards: chinaTourMap.game.cards,
    config: chinaTourMap.game.config,
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

function setSkipTurns(state: GameState, playerId: string, skipTurns: number): GameState {
  return {
    ...state,
    players: state.players.map((player) => (
      player.id === playerId ? { ...player, skipTurns } : player
    )),
  };
}

function moduleEvents(events: readonly GameEvent[]): GameEvent[] {
  return events.filter((event) => event.type === 'module');
}

function pendingOfKind(state: GameState, kind: string): PendingModuleAction {
  const action = state.publicRuleState.pendingActions.find((candidate) => (
    typeof candidate.payload === 'object'
    && candidate.payload !== null
    && (candidate.payload as Record<string, JsonValue>).kind === kind
  ));
  if (!action) throw new Error(`missing rail-choice action with kind=${kind}`);
  return action;
}

function intentFor(action: PendingModuleAction) {
  return {
    type: 'module' as const,
    module: action.module,
    action: action.action,
    payload: action.payload,
  };
}

/** 落在指定枢纽格上，返回落点结算结果。 */
function landOnHub(state: GameState, playerId: string, cellId = HUB_A) {
  return resolveLanding(placePlayer(state, playerId, cellId), playerId, []);
}

describe('rail-hub@1 落点结算与选项', () => {
  it('createGame 初始化干净的公开规则状态，且注册表认识 rail-hub@1', () => {
    const state = makeGame();

    expect(state.publicRuleState).toEqual({ modules: {}, pendingActions: [] });
    expect(state.ruleModules).toEqual([coreRef, railHubRef]);
    expect(chinaTourMap.game.requiredRuleModules).toEqual([coreRef, railHubRef]);
  });

  it('棋盘上恰好两座枢纽，且默认 registry 认识 rail-hub 格的处理器', () => {
    const state = makeGame();

    expect(railHubCells(state.board).map((cell) => cell.id)).toEqual([HUB_A, HUB_B]);
    for (const hub of railHubCells(state.board)) {
      expect(() => defaultRuleModuleRegistry.getCellHandler(state.ruleModules, hub)).not.toThrow();
    }
  });

  it('落在枢纽生成三个共用 action 名的选项，且 requiredPhase 与阶段一致', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnHub(base, playerId);

    expect(landed.state.turnPhase).toBe('managing');
    const actions = landed.state.publicRuleState.pendingActions;
    expect(actions).toHaveLength(3);
    expect([...new Set(actions.map((action) => `${action.module.id}@${action.module.version}:${action.action}`))])
      .toEqual([`${RAIL_HUB_MODULE_KEY}:rail-choice`]);
    expect(actions.map((action) => action.requiredPhase)).toEqual(['managing', 'managing', 'managing']);
    expect(actions.map((action) => action.playerId)).toEqual([playerId, playerId, playerId]);
    expect(actions.map((action) => action.label)).toEqual([
      `候车补贴（+${WAIT_BONUS} 元）`,
      `换乘（付 ${TRANSFER_FARE} 元，直达下一枢纽）`,
      '不换乘',
    ]);
    expect(actions.every((action) => (
      (action.payload as Record<string, JsonValue>).optionId === action.optionId
    ))).toBe(true);
    // 落点结算本身不产生任何金钱变动。
    expect(cashOf(landed.state, playerId)).toBe(base.config.initialCash);
    expect(moduleEvents(landed.events).map((event) => (event as unknown as { eventType: string }).eventType))
      .toEqual(['rail_visited']);
  });

  it('身上带着停赛时候车会一次性清空停赛，且不发补贴', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnHub(setSkipTurns(base, playerId, 3), playerId);
    const wait = pendingOfKind(landed.state, 'wait');
    expect(wait.label).toBe('候车休息（清空 3 回合停赛）');

    const rested = applyIntent(landed.state, playerId, intentFor(wait));
    expect(rested.ok).toBe(true);
    if (!rested.ok) return;

    expect(playerOf(rested.state, playerId).skipTurns).toBe(0);
    expect(cashOf(rested.state, playerId)).toBe(base.config.initialCash);
    expect(rested.state.recentLog.slice(-1)).toEqual([{
      type: 'module',
      module: railHubRef,
      eventType: 'rail_waited',
      payload: { playerId, cellId: HUB_A, clearedTurns: 3, bonus: 0 },
    }]);
    expect(rested.state.publicRuleState.pendingActions).toEqual([]);
  });

  it('身上没有停赛时候车领候车补贴', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnHub(base, playerId);
    const wait = pendingOfKind(landed.state, 'wait');

    const rested = applyIntent(landed.state, playerId, intentFor(wait));
    expect(rested.ok).toBe(true);
    if (!rested.ok) return;

    expect(cashOf(rested.state, playerId)).toBe(base.config.initialCash + WAIT_BONUS);
    expect(rested.events).toContainEqual({ type: 'bank_received', playerId, amount: WAIT_BONUS });
  });

  it('换乘付费跳到下一座枢纽，不领过起点工资，也不再结算落点', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnHub(base, playerId);
    const transfer = pendingOfKind(landed.state, 'transfer');

    const moved = applyIntent(landed.state, playerId, intentFor(transfer));
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;

    expect(cashOf(moved.state, playerId)).toBe(base.config.initialCash - TRANSFER_FARE);
    expect(playerOf(moved.state, playerId).position).toBe(HUB_B);
    expect(moved.events).toContainEqual({ type: 'token_moved', playerId, path: [HUB_B] });
    // 坐高铁不是走路：没有过起点工资，也没有在目的地重新摆出换乘选项（一回合只换乘一次）。
    expect(moved.events.some((event) => event.type === 'salary_collected')).toBe(false);
    expect(moved.state.publicRuleState.pendingActions).toEqual([]);
    expect(moved.events).toContainEqual({
      type: 'module',
      module: railHubRef,
      eventType: 'rail_transferred',
      payload: { playerId, fromCellId: HUB_A, toCellId: HUB_B, fare: TRANSFER_FARE },
    });
  });

  it('现金不足车票时不生成换乘选项', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnHub(setCash(base, playerId, TRANSFER_FARE - 1), playerId);

    expect(landed.state.publicRuleState.pendingActions).toHaveLength(2);
    expect(landed.state.publicRuleState.pendingActions.some((action) => (
      (action.payload as Record<string, JsonValue>).kind === 'transfer'
    ))).toBe(false);
  });

  it('不换乘只记事件，不扣钱，且选项不会被立刻摆回来', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnHub(base, playerId);
    const skip = pendingOfKind(landed.state, 'skip');

    const declined = applyIntent(landed.state, playerId, intentFor(skip));
    expect(declined.ok).toBe(true);
    if (!declined.ok) return;

    expect(cashOf(declined.state, playerId)).toBe(base.config.initialCash);
    expect(declined.state.publicRuleState.pendingActions).toEqual([]);
    expect(declined.state.publicRuleState.modules).toEqual({});

    // 选项消费后本回合可以正常结束。
    const ended = applyIntent(declined.state, playerId, { type: 'end_turn' });
    expect(ended.ok).toBe(true);
  });
});

describe('rail-hub@1 bot 策略', () => {
  it('身上有停赛时选择候车休息', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnHub(setSkipTurns(base, playerId, 2), playerId);

    expect(chooseBotIntent(landed.state, playerId)).toEqual({
      type: 'module',
      module: railHubRef,
      action: 'rail-choice',
      payload: pendingOfKind(landed.state, 'wait').payload,
    });
  });

  it('现金宽裕时选择换乘', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnHub(setCash(base, playerId, TRANSFER_FARE + BOT_TRANSFER_RESERVE), playerId);

    expect(chooseBotIntent(landed.state, playerId)).toEqual({
      type: 'module',
      module: railHubRef,
      action: 'rail-choice',
      payload: pendingOfKind(landed.state, 'transfer').payload,
    });
  });

  it('现金只能买车票而没有安全垫时选择候车', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnHub(setCash(base, playerId, TRANSFER_FARE + BOT_TRANSFER_RESERVE - 1), playerId);

    expect(chooseBotIntent(landed.state, playerId)).toEqual({
      type: 'module',
      module: railHubRef,
      action: 'rail-choice',
      payload: pendingOfKind(landed.state, 'wait').payload,
    });
  });

  it('没有枢纽选项时把决策交回既有链路（掷骰）', () => {
    const base = makeGame();
    expect(chooseBotIntent(base, base.currentPlayerId)).toEqual({ type: 'roll_dice' });
  });
});

describe('rail-hub@1 失效选项清理（回归）', () => {
  it('投降推进回合后不留下失效的枢纽选项，下一位玩家可以正常掷骰', () => {
    const base = makeGame(3);
    const playerId = base.currentPlayerId;
    const landed = landOnHub(base, playerId);
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

  it('托管跳过当前玩家后同样清掉失效选项', () => {
    const base = makeGame(3);
    const playerId = base.currentPlayerId;
    const landed = landOnHub(base, playerId);

    const skipped = skipCurrentTurn(landed.state, playerId);
    expect(skipped.ok).toBe(true);
    if (!skipped.ok) return;

    expect(skipped.state.publicRuleState.pendingActions).toEqual([]);
  });
});

describe('rail-hub@1 hydrate 校验', () => {
  it('正常状态可以无损恢复', () => {
    const state = makeGame();
    expect(hydrateGameState(structuredClone(state), chinaTourMap)).toMatchObject({ ok: true });
  });

  it('无状态模块在 publicRuleState.modules 里出现键即视为损坏存档', () => {
    const state = makeGame();
    const broken = {
      ...structuredClone(state),
      publicRuleState: { modules: { [RAIL_HUB_MODULE_KEY]: { level: 1 } }, pendingActions: [] },
    };

    expect(hydrateGameState(broken, chinaTourMap)).toMatchObject({ ok: false });
  });
});
