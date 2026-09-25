// piaohao@1（晋商票号 / 山西之旅）的模块级测试。
//
// 覆盖五件事：
//   1) 落点只摆选项（存入 / 取现 / 不办理），同一动作名下多分支。
//   2) 存入封顶 5000：到顶后不再摆「存入」选项，避免「一直存、永远不吃亏」把对局拖成单机存钱。
//   3) 回合边界：全体余额计息 8%（复利、封顶），然后给新的行动者做一次「票号垫付」。
//   4) 垫付顺序刻意是「先计息、后垫付」——垫付用的余额必须是含本期利息的余额。
//   5) hydrate 的严格校验：金额必须是 (0, 5000] 内的安全整数，键必须是本局存活玩家。
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@richman/board-data';
import { shanxiTourMap } from '@richman/board-data';
import { applyIntent, createGame, skipCurrentTurn } from '../engine';
import { resolveLanding } from '../effects';
import { chooseBotIntent } from '../bot';
import { hydrateGameState } from '../hydrate';
import { defaultRuleModuleRegistry } from '../moduleRegistry';
import { PIAOHAO_MODULE_KEY, piaohaoCells } from '../piaohaoModule';
import type { GameEvent, GameState, PendingModuleAction } from '../types';

const piaohaoRef = { id: 'piaohao', version: 1 } as const;
const coreRef = { id: 'core', version: 1 } as const;

const PIAOHAO_A = 7;
const PIAOHAO_B = 26;
const DEPOSIT_AMOUNT = 1000;
const DEPOSIT_CAP = 5000;
const ADVANCE_THRESHOLD = 1000;
const ADVANCE_CASH = 500;
const ADVANCE_COST = 550;
const BOT_DEPOSIT_RESERVE = 2000;

function makeGame(playerCount = 2): GameState {
  return createGame({
    mapRef: shanxiTourMap.ref,
    ruleModules: shanxiTourMap.game.requiredRuleModules,
    board: shanxiTourMap.game.board,
    cards: shanxiTourMap.game.cards,
    config: shanxiTourMap.game.config,
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

function withModuleState(
  state: GameState,
  moduleState: JsonValue,
  pendingActions: PendingModuleAction[] = [],
): GameState {
  return {
    ...state,
    publicRuleState: { modules: { [PIAOHAO_MODULE_KEY]: moduleState }, pendingActions },
  };
}

function balanceOf(state: GameState, playerId: string): number | undefined {
  const moduleState = state.publicRuleState.modules[PIAOHAO_MODULE_KEY] as
    | { depositByPlayerId?: Record<string, number> }
    | undefined;
  return moduleState?.depositByPlayerId?.[playerId];
}

function moduleEventTypes(events: readonly GameEvent[]): string[] {
  return events
    .filter((event) => event.type === 'module')
    .map((event) => (event as unknown as { eventType: string }).eventType);
}

function pendingOfKind(state: GameState, kind: string): PendingModuleAction {
  const action = state.publicRuleState.pendingActions.find((candidate) => (
    typeof candidate.payload === 'object'
    && candidate.payload !== null
    && (candidate.payload as Record<string, JsonValue>).kind === kind
  ));
  if (!action) throw new Error(`missing piaohao-choice action with kind=${kind}`);
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

function landOnPiaohao(state: GameState, playerId: string, cellId = PIAOHAO_A) {
  return resolveLanding(placePlayer(state, playerId, cellId), playerId, []);
}

describe('piaohao@1 落点结算与存取', () => {
  it('createGame 初始化干净的公开规则状态，且注册表认识 piaohao@1', () => {
    const state = makeGame();

    expect(state.publicRuleState).toEqual({ modules: {}, pendingActions: [] });
    expect(state.ruleModules).toEqual([coreRef, piaohaoRef]);
  });

  it('棋盘上恰好两处票号，且默认 registry 认识 piaohao 格的处理器', () => {
    const state = makeGame();

    expect(piaohaoCells(state.board).map((cell) => cell.id)).toEqual([PIAOHAO_A, PIAOHAO_B]);
    for (const cell of piaohaoCells(state.board)) {
      expect(() => defaultRuleModuleRegistry.getCellHandler(state.ruleModules, cell)).not.toThrow();
    }
  });

  it('没有余额时只有「存入 / 不办理」两个选项，落点本身不动钱', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnPiaohao(base, playerId);

    const actions = landed.state.publicRuleState.pendingActions;
    expect(actions).toHaveLength(2);
    expect([...new Set(actions.map((action) => `${action.module.id}@${action.module.version}:${action.action}`))])
      .toEqual([`${PIAOHAO_MODULE_KEY}:piaohao-choice`]);
    expect(actions.map((action) => action.requiredPhase)).toEqual(['managing', 'managing']);
    expect(actions.map((action) => action.label)).toEqual([`存入票号（${DEPOSIT_AMOUNT} 元）`, '不办理']);
    expect(cashOf(landed.state, playerId)).toBe(base.config.initialCash);
    expect(moduleEventTypes(landed.events)).toEqual(['piaohao_visited']);
  });

  it('存入把现金转进票号，选项随即被消费掉', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnPiaohao(base, playerId);

    const deposited = applyIntent(landed.state, playerId, intentFor(pendingOfKind(landed.state, 'deposit')));
    expect(deposited.ok).toBe(true);
    if (!deposited.ok) return;

    expect(cashOf(deposited.state, playerId)).toBe(base.config.initialCash - DEPOSIT_AMOUNT);
    expect(balanceOf(deposited.state, playerId)).toBe(DEPOSIT_AMOUNT);
    expect(deposited.events).toContainEqual({
      type: 'module',
      module: piaohaoRef,
      eventType: 'piaohao_deposited',
      payload: { playerId, cellId: PIAOHAO_A, amount: DEPOSIT_AMOUNT, balance: DEPOSIT_AMOUNT },
    });
    expect(deposited.state.publicRuleState.pendingActions).toEqual([]);
  });

  it('有余额时多出「取现本息」选项，标签带上当前余额', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const holding = withModuleState(base, { depositByPlayerId: { [playerId]: 1800 } });

    const landed = landOnPiaohao(holding, playerId);

    expect(landed.state.publicRuleState.pendingActions).toHaveLength(3);
    expect(pendingOfKind(landed.state, 'withdraw').label).toBe('取现本息（1800 元）');
  });

  it('余额到顶后不再摆出「存入」选项', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const full = withModuleState(base, { depositByPlayerId: { [playerId]: DEPOSIT_CAP } });

    const landed = landOnPiaohao(full, playerId);

    expect(landed.state.publicRuleState.pendingActions).toHaveLength(2);
    expect(landed.state.publicRuleState.pendingActions.some((action) => (
      (action.payload as Record<string, JsonValue>).kind === 'deposit'
    ))).toBe(false);
  });

  it('取现把本息一次性拿回现金，并清掉票号账目', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const holding = withModuleState(base, { depositByPlayerId: { [playerId]: 2600 } });

    const landed = landOnPiaohao(holding, playerId);
    const withdrawn = applyIntent(landed.state, playerId, intentFor(pendingOfKind(landed.state, 'withdraw')));
    expect(withdrawn.ok).toBe(true);
    if (!withdrawn.ok) return;

    expect(cashOf(withdrawn.state, playerId)).toBe(base.config.initialCash + 2600);
    expect(withdrawn.events).toContainEqual({ type: 'bank_received', playerId, amount: 2600 });
    // 账目清空 = 模块键整体消失（空对象不占键）。
    expect(withdrawn.state.publicRuleState.modules).toEqual({});
  });

  it('不办理只记事件、不动钱也不写账目', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnPiaohao(base, playerId);

    const declined = applyIntent(landed.state, playerId, intentFor(pendingOfKind(landed.state, 'skip')));
    expect(declined.ok).toBe(true);
    if (!declined.ok) return;

    expect(cashOf(declined.state, playerId)).toBe(base.config.initialCash);
    expect(declined.state.publicRuleState.modules).toEqual({});
    expect(declined.state.publicRuleState.pendingActions).toEqual([]);

    const ended = applyIntent(declined.state, playerId, { type: 'end_turn' });
    expect(ended.ok).toBe(true);
  });
});

describe('piaohao@1 回合边界：计息与垫付', () => {
  it('跨回合结算按 8% 复利计息', () => {
    const base = makeGame();
    const depositor = base.currentPlayerId;
    const holding = withModuleState(base, { depositByPlayerId: { [depositor]: 1000 } });

    const skipped = skipCurrentTurn(holding, depositor);
    expect(skipped.ok).toBe(true);
    if (!skipped.ok) return;

    expect(balanceOf(skipped.state, depositor)).toBe(1080);
    expect(skipped.events).toContainEqual({
      type: 'module',
      module: piaohaoRef,
      eventType: 'piaohao_interest',
      payload: { playerId: depositor, amount: 80, balance: 1080 },
    });
  });

  it('计息不会让余额超过 5000 上限', () => {
    const base = makeGame();
    const depositor = base.currentPlayerId;
    const holding = withModuleState(base, { depositByPlayerId: { [depositor]: 4900 } });

    const skipped = skipCurrentTurn(holding, depositor);
    expect(skipped.ok).toBe(true);
    if (!skipped.ok) return;

    expect(balanceOf(skipped.state, depositor)).toBe(DEPOSIT_CAP);
  });

  it('新行动者现金不足时票号自动垫付：先计息、再按含息余额划 550 送 500 现金', () => {
    const base = makeGame();
    const depositor = 'p1';
    const other = 'p2';
    // 把当前玩家换成 p2，于是跳过之后新的行动者正是 p1。
    const prepared = withModuleState(
      { ...base, currentPlayerId: other },
      { depositByPlayerId: { [depositor]: 1000 } },
    );
    const broke = setCash(prepared, depositor, 0);

    const skipped = skipCurrentTurn(broke, other);
    expect(skipped.ok).toBe(true);
    if (!skipped.ok) return;

    expect(skipped.state.currentPlayerId).toBe(depositor);
    expect(cashOf(skipped.state, depositor)).toBe(ADVANCE_CASH);
    // 1000 计息到 1080，再扣 550 汇水 → 530。
    expect(balanceOf(skipped.state, depositor)).toBe(1080 - ADVANCE_COST);
    expect(skipped.events).toContainEqual({
      type: 'module',
      module: piaohaoRef,
      eventType: 'piaohao_advance',
      payload: {
        playerId: depositor,
        amount: ADVANCE_CASH,
        cost: ADVANCE_COST,
        balance: 1080 - ADVANCE_COST,
      },
    });
    expect(skipped.events).toContainEqual({
      type: 'bank_received',
      playerId: depositor,
      amount: ADVANCE_CASH,
    });
  });

  it('现金充足时不触发垫付（垫付只在余额足以覆盖汇水时发生）', () => {
    const base = makeGame();
    const depositor = 'p1';
    const other = 'p2';
    const prepared = withModuleState(
      { ...base, currentPlayerId: other },
      { depositByPlayerId: { [depositor]: 1000 } },
    );
    // 余额 1000 → 计息 1080；但余额不足 550 的场景另测，这里验现金充足不垫付。
    const skipped = skipCurrentTurn(prepared, other);
    expect(skipped.ok).toBe(true);
    if (!skipped.ok) return;

    expect(skipped.state.currentPlayerId).toBe(depositor);
    expect(moduleEventTypes(skipped.events)).toEqual(['piaohao_interest']);
    expect(cashOf(skipped.state, depositor)).toBe(base.config.initialCash);
  });
});

describe('piaohao@1 bot 策略', () => {
  it('现金宽裕时存入', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const rich = setCash(base, playerId, DEPOSIT_AMOUNT + BOT_DEPOSIT_RESERVE);
    const landed = landOnPiaohao(rich, playerId);

    expect(chooseBotIntent(landed.state, playerId)).toEqual({
      type: 'module',
      module: piaohaoRef,
      action: 'piaohao-choice',
      payload: pendingOfKind(landed.state, 'deposit').payload,
    });
  });

  it('现金告急且有余额时取现', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const tight = withModuleState(setCash(base, playerId, 0), { depositByPlayerId: { [playerId]: 1500 } });
    const landed = landOnPiaohao(tight, playerId);

    expect(chooseBotIntent(landed.state, playerId)).toEqual({
      type: 'module',
      module: piaohaoRef,
      action: 'piaohao-choice',
      payload: pendingOfKind(landed.state, 'withdraw').payload,
    });
  });

  it('没有票号选项时把决策交回既有链路（掷骰）', () => {
    const base = makeGame();
    expect(chooseBotIntent(base, base.currentPlayerId)).toEqual({ type: 'roll_dice' });
  });
});

describe('piaohao@1 hydrate 校验', () => {
  function brokenWith(moduleState: JsonValue): unknown {
    const state = makeGame(3);
    return {
      ...structuredClone(state),
      publicRuleState: { modules: { [PIAOHAO_MODULE_KEY]: moduleState }, pendingActions: [] },
    };
  }

  it('合法余额可以无损恢复', () => {
    expect(hydrateGameState(brokenWith({ depositByPlayerId: { p1: 2500 } }), shanxiTourMap))
      .toMatchObject({ ok: true });
  });

  it('余额超过上限时拒绝恢复（否则每回合派发巨额利息等于毁掉整局）', () => {
    expect(hydrateGameState(brokenWith({ depositByPlayerId: { p1: DEPOSIT_CAP + 1 } }), shanxiTourMap))
      .toMatchObject({ ok: false });
  });

  it('余额不是正整数时拒绝恢复', () => {
    expect(hydrateGameState(brokenWith({ depositByPlayerId: { p1: 0 } }), shanxiTourMap))
      .toMatchObject({ ok: false });
    expect(hydrateGameState(brokenWith({ depositByPlayerId: { p1: 1.5 } }), shanxiTourMap))
      .toMatchObject({ ok: false });
  });

  it('账目键不是本局玩家时拒绝恢复', () => {
    expect(hydrateGameState(brokenWith({ depositByPlayerId: { ghost: 1000 } }), shanxiTourMap))
      .toMatchObject({ ok: false });
  });

  it('形状多余键时拒绝恢复', () => {
    expect(hydrateGameState(
      brokenWith({ depositByPlayerId: { p1: 1000 }, extra: true }),
      shanxiTourMap,
    )).toMatchObject({ ok: false });
  });
});
