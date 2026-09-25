// river-tide@1（黄河汛期 / 黄河之旅）的模块级测试。
//
// 覆盖四件事：
//   1) 水位是**全场共享**的宏观量（0~10）：落在河工段可以花钱修堤压水位；每回合边界随机涨落。
//   2) 本仓唯一实现 `positiveRentHook` 的模块：水位 ≥8 全场过路费 ×1.5，≤2 全场 ×0.6，
//      中间档不动租金也不产出模块事件（钩子必须「无副作用地穿透」）。
//   3) 修堤是「自己掏钱、全场受益」的公共事务，因此水位变化必须发生在回合边界而不是某次落点里，
//      否则同一回合先掷骰的人与后掷骰的人会看到不同水位。
//   4) 回归：postTransitionHook 必须清掉失效待选动作，否则投降 / 托管跳过会把下一位玩家锁死。
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@richman/board-data';
import { yellowRiverMap } from '@richman/board-data';
import { applyIntent, createGame, skipCurrentTurn } from '../engine';
import { resolveLanding } from '../effects';
import { chooseBotIntent } from '../bot';
import { hydrateGameState } from '../hydrate';
import { defaultRuleModuleRegistry } from '../moduleRegistry';
import { pickRandomIndex } from '../moduleSupport';
import { RIVER_TIDE_MODULE_KEY, rentMultiplierFor, riverWorksCells } from '../riverTideModule';
import type { GameEvent, GameState, PendingModuleAction } from '../types';

const riverTideRef = { id: 'river-tide', version: 1 } as const;
const coreRef = { id: 'core', version: 1 } as const;

/** 黄河之旅的四段河工（棋盘数组顺序）。 */
const WORKS_CELLS = [8, 24, 42, 57];
const WORKS_A = 8;
const TIDE_INITIAL = 4;
const TIDE_MAX = 10;
const DIKE_COST = 1000;
const DIKE_REDUCTION = 2;
const BOT_DIKE_LEVEL = 6;
const BOT_DIKE_RESERVE = 1500;
/** 模块的涨落表固定为 [-2, -1, -1, 0, 1, 1, 2]（见模块头部注释）。 */
const TIDE_DELTAS = [-2, -1, -1, 0, 1, 1, 2] as const;
const DELTA_INDEX_PLUS_TWO = 6;
const DELTA_INDEX_ZERO = 3;

/** 黄河之旅第一个普通地产格：租金表 rents[0] = 140。 */
const PROPERTY_CELL = 1;
const PROPERTY_RENT_0 = 140;

function makeGame(playerCount = 2): GameState {
  return createGame({
    mapRef: yellowRiverMap.ref,
    ruleModules: yellowRiverMap.game.requiredRuleModules,
    board: yellowRiverMap.game.board,
    cards: yellowRiverMap.game.cards,
    config: yellowRiverMap.game.config,
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

/** 写入水位（模块状态键）。 */
function withTide(state: GameState, level: number): GameState {
  return {
    ...state,
    publicRuleState: {
      ...state.publicRuleState,
      modules: { ...state.publicRuleState.modules, [RIVER_TIDE_MODULE_KEY]: { level } },
    },
  };
}

/** 把 PROPERTY_CELL 记到 ownerId 名下。 */
function withOwner(state: GameState, cellId: number, ownerId: string): GameState {
  return {
    ...state,
    properties: { ...state.properties, [cellId]: { ownerId, level: 0, mortgaged: false } },
  };
}

function tideLevel(state: GameState): number | undefined {
  const value = state.publicRuleState.modules[RIVER_TIDE_MODULE_KEY] as { level?: number } | undefined;
  return value?.level;
}

function pendingOfKind(state: GameState, kind: string): PendingModuleAction {
  const action = state.publicRuleState.pendingActions.find((candidate) => (
    typeof candidate.payload === 'object'
    && candidate.payload !== null
    && (candidate.payload as Record<string, JsonValue>).kind === kind
  ));
  if (!action) throw new Error(`missing river-works-choice action with kind=${kind}`);
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

function landOnWorks(state: GameState, playerId: string, cellId = WORKS_A) {
  return resolveLanding(placePlayer(state, playerId, cellId), playerId, []);
}

/** 找一个「涨落表取到指定下标」的数值种子（掷骰/随机游走都只读 state.seed）。 */
function seedWithDeltaIndex(index: number): string {
  const probe = makeGame();
  for (let value = 1; value < 100000; value += 1) {
    const picked = pickRandomIndex({ ...probe, seed: String(value) }, TIDE_DELTAS.length);
    if (picked !== null && picked.index === index) return String(value);
  }
  throw new Error(`no seed picking delta index ${index}`);
}

describe('river-tide@1 水位与倍率', () => {
  it('createGame 初始化干净的公开规则状态，且注册表认识 river-tide@1', () => {
    const state = makeGame();

    expect(state.publicRuleState).toEqual({ modules: {}, pendingActions: [] });
    expect(state.ruleModules).toEqual([coreRef, riverTideRef]);
    expect(yellowRiverMap.game.requiredRuleModules).toEqual([coreRef, riverTideRef]);
  });

  it('棋盘上恰好四段河工，且默认 registry 认识 river-works 格的处理器', () => {
    const state = makeGame();

    expect(riverWorksCells(state.board).map((cell) => cell.id)).toEqual(WORKS_CELLS);
    for (const cell of riverWorksCells(state.board)) {
      expect(() => defaultRuleModuleRegistry.getCellHandler(state.ruleModules, cell)).not.toThrow();
    }
  });

  it('倍率表：水位 ≥8 是 1.5 倍、≤2 是 0.6 倍、中间档原价', () => {
    expect([0, 1, 2].map((level) => rentMultiplierFor(level))).toEqual([0.6, 0.6, 0.6]);
    expect([3, 4, 5, 6, 7].map((level) => rentMultiplierFor(level))).toEqual([1, 1, 1, 1, 1]);
    expect([8, 9, 10].map((level) => rentMultiplierFor(level))).toEqual([1.5, 1.5, 1.5]);
  });
});

describe('river-tide@1 落点结算与修堤', () => {
  it('落在河工段生成两个共用 action 名的选项，且落点不动钱，只把水位落键', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnWorks(base, playerId);

    expect(landed.state.turnPhase).toBe('managing');
    const actions = landed.state.publicRuleState.pendingActions;
    expect(actions).toHaveLength(2);
    expect([...new Set(actions.map((action) => `${action.module.id}@${action.module.version}:${action.action}`))])
      .toEqual([`${RIVER_TIDE_MODULE_KEY}:river-works-choice`]);
    expect(actions.map((action) => action.requiredPhase)).toEqual(['managing', 'managing']);
    expect(actions.map((action) => action.playerId)).toEqual([playerId, playerId]);
    expect(actions.map((action) => action.label)).toEqual([
      `修堤（付 ${DIKE_COST} 元，水位 ${TIDE_INITIAL} → ${TIDE_INITIAL - DIKE_REDUCTION}）`,
      '不修堤',
    ]);
    expect(actions.every((action) => (
      (action.payload as Record<string, JsonValue>).optionId === action.optionId
    ))).toBe(true);
    expect(cashOf(landed.state, playerId)).toBe(base.config.initialCash);
    // 水位是全局量：即使等于初始值也照常落键，客户端才能渲染水位条。
    expect(tideLevel(landed.state)).toBe(TIDE_INITIAL);
    expect(landed.events).toContainEqual({
      type: 'module',
      module: riverTideRef,
      eventType: 'river_works_visited',
      payload: { playerId, cellId: WORKS_A, level: TIDE_INITIAL },
    });
  });

  it('水位已见底或现金不足时不生成修堤选项', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;

    const dry = landOnWorks(withTide(base, 0), playerId);
    expect(dry.state.publicRuleState.pendingActions).toHaveLength(1);
    expect(hasKind(dry.state, 'dike')).toBe(false);
    expect(hasKind(dry.state, 'skip')).toBe(true);

    const poor = landOnWorks(setCash(withTide(base, 8), playerId, DIKE_COST - 1), playerId);
    expect(poor.state.publicRuleState.pendingActions).toHaveLength(1);
    expect(hasKind(poor.state, 'dike')).toBe(false);
  });

  it('修堤扣 1000 并把水位压低 2 格，压到 0 以下不会变成负数', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnWorks(base, playerId);

    const diked = applyIntent(landed.state, playerId, intentFor(pendingOfKind(landed.state, 'dike')));
    expect(diked.ok).toBe(true);
    if (!diked.ok) return;

    expect(cashOf(diked.state, playerId)).toBe(base.config.initialCash - DIKE_COST);
    expect(tideLevel(diked.state)).toBe(TIDE_INITIAL - DIKE_REDUCTION);
    expect(diked.state.publicRuleState.pendingActions).toEqual([]);
    expect(diked.state.recentLog.slice(-2)).toEqual([
      {
        type: 'module',
        module: riverTideRef,
        eventType: 'river_dike_built',
        payload: { playerId, cellId: WORKS_A, cost: DIKE_COST, previous: TIDE_INITIAL, level: TIDE_INITIAL - DIKE_REDUCTION },
      },
      { type: 'bank_paid', playerId, amount: DIKE_COST },
    ]);

    const shallow = landOnWorks(withTide(base, 1), playerId);
    const dikedShallow = applyIntent(shallow.state, playerId, intentFor(pendingOfKind(shallow.state, 'dike')));
    expect(dikedShallow.ok).toBe(true);
    if (!dikedShallow.ok) return;
    expect(tideLevel(dikedShallow.state)).toBe(0);
  });

  it('不修堤只记事件，不动钱，选项消费后可以正常结束回合', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnWorks(base, playerId);

    const declined = applyIntent(landed.state, playerId, intentFor(pendingOfKind(landed.state, 'skip')));
    expect(declined.ok).toBe(true);
    if (!declined.ok) return;

    expect(cashOf(declined.state, playerId)).toBe(base.config.initialCash);
    expect(declined.state.recentLog.slice(-1)).toEqual([{
      type: 'module',
      module: riverTideRef,
      eventType: 'river_works_declined',
      payload: { playerId, cellId: WORKS_A, level: TIDE_INITIAL },
    }]);
    expect(applyIntent({ ...declined.state, turnPhase: 'managing' }, playerId, { type: 'end_turn' }).ok).toBe(true);
  });
});

describe('river-tide@1 过路费倍率（positiveRentHook）', () => {
  it('高水位把过路费抬到 1.5 倍，并留下 base / amount 都在的模块事件', () => {
    const base = makeGame();
    const payerId = base.currentPlayerId;
    // 起始玩家由种子决定，地主必须显式挑一个「不是付款人」的玩家。
    const ownerId = base.players.find((player) => player.id !== payerId)!.id;
    const state = withTide(withOwner(placePlayer(base, payerId, PROPERTY_CELL), PROPERTY_CELL, ownerId), 8);
    const before = cashOf(state, payerId);

    const landed = resolveLanding(state, payerId, []);
    const expected = Math.round(PROPERTY_RENT_0 * 1.5);

    expect(landed.events).toContainEqual({
      type: 'module',
      module: riverTideRef,
      eventType: 'river_tide_rent',
      payload: { payerId, ownerId, cellId: PROPERTY_CELL, level: 8, multiplier: 1.5, base: PROPERTY_RENT_0, amount: expected },
    });
    // 实际扣款用的是 hook 改写后的金额，而不是 core 的原始租金。
    expect(landed.events).toContainEqual({
      type: 'rent_paid',
      from: payerId,
      to: ownerId,
      cellId: PROPERTY_CELL,
      amount: expected,
    });
    expect(cashOf(landed.state, payerId)).toBe(before - expected);
    expect(expected).not.toBe(PROPERTY_RENT_0);
  });

  it('低水位把过路费压到 0.6 倍', () => {
    const base = makeGame();
    const payerId = base.currentPlayerId;
    const ownerId = base.players.find((player) => player.id !== payerId)!.id;
    const state = withTide(withOwner(placePlayer(base, payerId, PROPERTY_CELL), PROPERTY_CELL, ownerId), 2);
    const before = cashOf(state, payerId);

    const landed = resolveLanding(state, payerId, []);
    const expected = Math.round(PROPERTY_RENT_0 * 0.6);

    expect(landed.events).toContainEqual({
      type: 'module',
      module: riverTideRef,
      eventType: 'river_tide_rent',
      payload: { payerId, ownerId, cellId: PROPERTY_CELL, level: 2, multiplier: 0.6, base: PROPERTY_RENT_0, amount: expected },
    });
    expect(cashOf(landed.state, payerId)).toBe(before - expected);
    expect(expected).toBeLessThan(PROPERTY_RENT_0);
  });

  it('中间水位原价结算，且不产出任何模块事件（钩子无副作用地穿透）', () => {
    const base = makeGame();
    const payerId = base.currentPlayerId;
    const ownerId = base.players.find((player) => player.id !== payerId)!.id;
    const state = withTide(withOwner(placePlayer(base, payerId, PROPERTY_CELL), PROPERTY_CELL, ownerId), 4);
    const before = cashOf(state, payerId);

    const landed = resolveLanding(state, payerId, []);

    expect(moduleEvents(landed.events)).toEqual([]);
    expect(landed.events).toContainEqual({
      type: 'rent_paid',
      from: payerId,
      to: ownerId,
      cellId: PROPERTY_CELL,
      amount: PROPERTY_RENT_0,
    });
    expect(cashOf(landed.state, payerId)).toBe(before - PROPERTY_RENT_0);
  });

  it('水位是全场共享的：有人修堤之后，另一位玩家付的租金也跟着变', () => {
    const base = makeGame();
    const payerId = base.currentPlayerId;
    const landlordId = base.players.find((player) => player.id !== payerId)!.id;
    const shared = withTide(withOwner(base, PROPERTY_CELL, landlordId), 8);

    const beforeDike = resolveLanding(placePlayer(shared, payerId, PROPERTY_CELL), payerId, []);
    const beforeAmount = (beforeDike.events.find((event) => event.type === 'rent_paid') as { amount: number }).amount;
    expect(beforeAmount).toBe(Math.round(PROPERTY_RENT_0 * 1.5));

    // 修堤者不是地主：自己掏 1000，降下来的水位却让所有地主的租金一起缩水。
    const worksLanding = landOnWorks(shared, payerId);
    const diked = applyIntent(
      worksLanding.state,
      payerId,
      intentFor(pendingOfKind(worksLanding.state, 'dike')),
    );
    expect(diked.ok).toBe(true);
    if (!diked.ok) return;

    const afterDike = resolveLanding(placePlayer(diked.state, payerId, PROPERTY_CELL), payerId, []);
    const afterAmount = (afterDike.events.find((event) => event.type === 'rent_paid') as { amount: number }).amount;

    expect(afterAmount).toBe(PROPERTY_RENT_0);
    expect(afterAmount).toBeLessThan(beforeAmount);
    expect(moduleEvents(afterDike.events)).toEqual([]);
  });
});

describe('river-tide@1 回合边界的涨落', () => {
  function endTurnAt(state: GameState, playerId: string) {
    return applyIntent({ ...state, turnPhase: 'managing' }, playerId, { type: 'end_turn' });
  }

  it('回合边界按涨落表改变水位，事件里的 delta / multiplier 与最终水位自洽', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const seed = seedWithDeltaIndex(DELTA_INDEX_PLUS_TWO);
    const ended = endTurnAt({ ...withTide(base, 4), seed }, playerId);
    expect(ended.ok).toBe(true);
    if (!ended.ok) return;

    const expected = 4 + TIDE_DELTAS[DELTA_INDEX_PLUS_TWO];
    expect(tideLevel(ended.state)).toBe(expected);
    expect(ended.events).toContainEqual({
      type: 'module',
      module: riverTideRef,
      eventType: 'river_tide_changed',
      payload: { previous: 4, level: expected, delta: TIDE_DELTAS[DELTA_INDEX_PLUS_TWO], multiplier: rentMultiplierFor(expected) },
    });
  });

  it('抽到涨落 0 时不产出事件，但水位仍然照常落键', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const seed = seedWithDeltaIndex(DELTA_INDEX_ZERO);
    const ended = endTurnAt({ ...withTide(base, 4), seed }, playerId);
    expect(ended.ok).toBe(true);
    if (!ended.ok) return;

    expect(moduleEvents(ended.events)).toEqual([]);
    expect(tideLevel(ended.state)).toBe(4);
  });

  it('水位顶到上限时涨潮不再越界', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const seed = seedWithDeltaIndex(DELTA_INDEX_PLUS_TWO);
    const ended = endTurnAt({ ...withTide(base, TIDE_MAX), seed }, playerId);
    expect(ended.ok).toBe(true);
    if (!ended.ok) return;

    expect(tideLevel(ended.state)).toBe(TIDE_MAX);
    expect(moduleEvents(ended.events)).toEqual([]);
  });

  it('连续推进 30 个回合水位始终落在 [0, 10] 且键始终存在', () => {
    let state = makeGame(2);
    for (let round = 0; round < 30; round += 1) {
      const playerId = state.currentPlayerId;
      const ended = endTurnAt(state, playerId);
      expect(ended.ok).toBe(true);
      if (!ended.ok) return;
      state = ended.state;
      // 水位是全局量，键必须一直在（客户端靠它渲染水位条）。
      expect(Object.prototype.hasOwnProperty.call(state.publicRuleState.modules, RIVER_TIDE_MODULE_KEY)).toBe(true);
      const level = tideLevel(state) ?? -1;
      expect(Number.isSafeInteger(level)).toBe(true);
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(TIDE_MAX);
    }
  });
});

describe('river-tide@1 bot 策略', () => {
  it('水位偏高且现金宽裕时修堤', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const state = setCash(withTide(base, BOT_DIKE_LEVEL + 1), playerId, DIKE_COST + BOT_DIKE_RESERVE);
    const landed = landOnWorks(state, playerId);

    expect(chooseBotIntent(landed.state, playerId)).toEqual({
      type: 'module',
      module: riverTideRef,
      action: 'river-works-choice',
      payload: pendingOfKind(landed.state, 'dike').payload,
    });
  });

  it('水位不高时不修堤，现金只够修堤而无安全垫时也不修堤', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;

    const calm = landOnWorks(setCash(withTide(base, BOT_DIKE_LEVEL - 1), playerId, 100000), playerId);
    expect(chooseBotIntent(calm.state, playerId)).toEqual({
      type: 'module',
      module: riverTideRef,
      action: 'river-works-choice',
      payload: pendingOfKind(calm.state, 'skip').payload,
    });

    const tight = landOnWorks(
      setCash(withTide(base, BOT_DIKE_LEVEL + 1), playerId, DIKE_COST + BOT_DIKE_RESERVE - 1),
      playerId,
    );
    expect(chooseBotIntent(tight.state, playerId)).toEqual({
      type: 'module',
      module: riverTideRef,
      action: 'river-works-choice',
      payload: pendingOfKind(tight.state, 'skip').payload,
    });
  });

  it('没有河工选项时把决策交回既有链路（掷骰）', () => {
    const base = makeGame();
    expect(chooseBotIntent(base, base.currentPlayerId)).toEqual({ type: 'roll_dice' });
  });
});

describe('river-tide@1 失效选项清理（回归）', () => {
  it('投降推进回合后不留下失效的河工选项，下一位玩家可以正常掷骰', () => {
    const base = makeGame(3);
    const playerId = base.currentPlayerId;
    const landed = landOnWorks(base, playerId);
    expect(landed.state.publicRuleState.pendingActions).toHaveLength(2);

    const surrendered = applyIntent(landed.state, playerId, { type: 'surrender' });
    expect(surrendered.ok).toBe(true);
    if (!surrendered.ok) return;

    expect(surrendered.state.publicRuleState.pendingActions).toEqual([]);
    const next = surrendered.state.currentPlayerId;
    expect(next).not.toBe(playerId);
    expect(applyIntent(surrendered.state, next, { type: 'roll_dice' }).ok).toBe(true);
  });

  it('托管跳过当前玩家后同样清掉失效选项', () => {
    const base = makeGame(3);
    const playerId = base.currentPlayerId;
    const landed = landOnWorks(base, playerId);

    const skipped = skipCurrentTurn(landed.state, playerId);
    expect(skipped.ok).toBe(true);
    if (!skipped.ok) return;

    expect(skipped.state.publicRuleState.pendingActions).toEqual([]);
  });
});

describe('river-tide@1 hydrate 校验', () => {
  it('正常状态可以无损恢复', () => {
    const state = makeGame();
    expect(hydrateGameState(structuredClone(state), yellowRiverMap)).toMatchObject({ ok: true });
  });

  it('水位边界 0 / 10 合法', () => {
    for (const level of [0, TIDE_MAX]) {
      expect(hydrateGameState(structuredClone(withTide(makeGame(), level)), yellowRiverMap))
        .toMatchObject({ ok: true });
    }
  });

  it('水位越界 / 非整数都视为损坏存档', () => {
    const base = makeGame();
    for (const broken of [withTide(base, TIDE_MAX + 1), withTide(base, -1), withTide(base, 4.5)]) {
      expect(hydrateGameState(structuredClone(broken), yellowRiverMap)).toMatchObject({ ok: false });
    }
  });
});
