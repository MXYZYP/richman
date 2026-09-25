// oasis-camp@1（绿洲营地 / 新疆之旅）的模块级测试。
//
// 覆盖四件事：
//   1) 落点结算只摆选项、不动钱；扎营/迁营/撤营/不扎营共用同一动作名 `oasis-choice`。
//   2) 每人只有一处营地：在原处再扎营 = 迁营（旧营地作废）；撤营退半价。
//   3) 「经过即触发」是全仓唯一奖励**路径**而不是**落点**的机制：本次掷骰走过自己的营地
//      就领 500（停在营地上也算），由 postTransitionHook 回看第一条 token_moved 判定。
//   4) 回归：postTransitionHook 必须清掉失效待选动作，否则投降 / 托管跳过会留下
//      `managing` 选项把下一位玩家永久锁在 WRONG_PHASE。
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@richman/board-data';
import { xinjiangTourMap } from '@richman/board-data';
import { applyIntent, createGame, skipCurrentTurn } from '../engine';
import { resolveLanding } from '../effects';
import { chooseBotIntent } from '../bot';
import { hydrateGameState } from '../hydrate';
import { defaultRuleModuleRegistry } from '../moduleRegistry';
import { rollDice } from '../rng';
import { OASIS_CAMP_MODULE_KEY, oasisCells } from '../oasisCampModule';
import type { GameEvent, GameState, PendingModuleAction } from '../types';

const oasisRef = { id: 'oasis-camp', version: 1 } as const;
const coreRef = { id: 'core', version: 1 } as const;

/** 新疆之旅的两处绿洲（棋盘数组顺序）。 */
const OASIS_A = 12;
const OASIS_B = 38;
const CAMP_COST = 600;
const CAMP_BONUS = 500;
const CAMP_REFUND = 300;
const BOT_CAMP_RESERVE = 1800;

function makeGame(playerCount = 2): GameState {
  return createGame({
    mapRef: xinjiangTourMap.ref,
    ruleModules: xinjiangTourMap.game.requiredRuleModules,
    board: xinjiangTourMap.game.board,
    cards: xinjiangTourMap.game.cards,
    config: xinjiangTourMap.game.config,
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

/** 把公开模块状态写成「某玩家营地在某格」。 */
function withCamp(state: GameState, campByPlayerId: Readonly<Record<string, number>>): GameState {
  return {
    ...state,
    publicRuleState: {
      ...state.publicRuleState,
      modules: { ...state.publicRuleState.modules, [OASIS_CAMP_MODULE_KEY]: { campByPlayerId: { ...campByPlayerId } } },
    },
  };
}

function pendingOfKind(state: GameState, kind: string): PendingModuleAction {
  const action = state.publicRuleState.pendingActions.find((candidate) => (
    typeof candidate.payload === 'object'
    && candidate.payload !== null
    && (candidate.payload as Record<string, JsonValue>).kind === kind
  ));
  if (!action) throw new Error(`missing oasis-choice action with kind=${kind}`);
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

function landOnOasis(state: GameState, playerId: string, cellId = OASIS_A) {
  return resolveLanding(placePlayer(state, playerId, cellId), playerId, []);
}

/** 找一个「两骰和为 target」的数值种子——掷骰只读 state.seed，所以这是确定性的。 */
function seedWithDiceSum(target: number): string {
  for (let value = 1; value < 100000; value += 1) {
    const [dice] = rollDice(value);
    if (dice[0] + dice[1] === target) return String(value);
  }
  throw new Error(`no seed with dice sum ${target}`);
}

describe('oasis-camp@1 落点结算与选项', () => {
  it('createGame 初始化干净的公开规则状态，且注册表认识 oasis-camp@1', () => {
    const state = makeGame();

    expect(state.publicRuleState).toEqual({ modules: {}, pendingActions: [] });
    expect(state.ruleModules).toEqual([coreRef, oasisRef]);
    expect(xinjiangTourMap.game.requiredRuleModules).toEqual([coreRef, oasisRef]);
  });

  it('棋盘上恰好两处绿洲，且默认 registry 认识 oasis 格的处理器', () => {
    const state = makeGame();

    expect(oasisCells(state.board).map((cell) => cell.id)).toEqual([OASIS_A, OASIS_B]);
    for (const cell of oasisCells(state.board)) {
      expect(() => defaultRuleModuleRegistry.getCellHandler(state.ruleModules, cell)).not.toThrow();
    }
  });

  it('落在绿洲生成两个共用 action 名的选项，且落点不动钱也不写状态', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnOasis(base, playerId);

    expect(landed.state.turnPhase).toBe('managing');
    const actions = landed.state.publicRuleState.pendingActions;
    expect(actions).toHaveLength(2);
    expect([...new Set(actions.map((action) => `${action.module.id}@${action.module.version}:${action.action}`))])
      .toEqual([`${OASIS_CAMP_MODULE_KEY}:oasis-choice`]);
    expect(actions.map((action) => action.requiredPhase)).toEqual(['managing', 'managing']);
    expect(actions.map((action) => action.playerId)).toEqual([playerId, playerId]);
    expect(actions.map((action) => action.label)).toEqual([
      `扎营（${CAMP_COST} 元，此后经过可领 ${CAMP_BONUS}）`,
      '不扎营',
    ]);
    expect(actions.every((action) => (
      (action.payload as Record<string, JsonValue>).optionId === action.optionId
    ))).toBe(true);
    expect(cashOf(landed.state, playerId)).toBe(base.config.initialCash);
    expect(landed.state.publicRuleState.modules).toEqual({});
    expect(moduleEvents(landed.events).map((event) => (event as unknown as { eventType: string }).eventType))
      .toEqual(['oasis_visited']);
  });

  it('现金不足营地费时不生成扎营选项', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnOasis(setCash(base, playerId, CAMP_COST - 1), playerId);

    expect(landed.state.publicRuleState.pendingActions).toHaveLength(1);
    expect(hasKind(landed.state, 'camp')).toBe(false);
    expect(pendingOfKind(landed.state, 'skip').label).toBe('不扎营');
  });

  it('已站在自己营地时提供撤营选项，站在别人营地格时提供迁营选项', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const camped = withCamp(base, { [playerId]: OASIS_A });

    const onOwn = landOnOasis(camped, playerId, OASIS_A);
    expect(onOwn.state.publicRuleState.pendingActions.map((action) => action.label)).toEqual([
      `撤营（退回 ${CAMP_REFUND} 元）`,
      '不扎营',
    ]);
    expect(hasKind(onOwn.state, 'camp')).toBe(false);

    const onOther = landOnOasis(camped, playerId, OASIS_B);
    expect(onOther.state.publicRuleState.pendingActions.map((action) => action.label)).toEqual([
      `迁营到此（${CAMP_COST} 元，原营地作废）`,
      '不扎营',
    ]);
  });
});

describe('oasis-camp@1 扎营 / 迁营 / 撤营', () => {
  it('扎营扣款并写入营地位置，事件带上旧营地（首次为 null）', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnOasis(base, playerId);

    const camped = applyIntent(landed.state, playerId, intentFor(pendingOfKind(landed.state, 'camp')));
    expect(camped.ok).toBe(true);
    if (!camped.ok) return;

    expect(cashOf(camped.state, playerId)).toBe(base.config.initialCash - CAMP_COST);
    expect(camped.state.publicRuleState.modules).toEqual({
      [OASIS_CAMP_MODULE_KEY]: { campByPlayerId: { [playerId]: OASIS_A } },
    });
    expect(camped.state.publicRuleState.pendingActions).toEqual([]);
    // 尾巴上固定是「模块事件 + 一条 core 的 bank_paid」：扎营费离开牌桌必须有银行流水，
    // 否则现金守恒不变量（simulate.ts）会持续失配。
    expect(camped.state.recentLog.slice(-2)).toEqual([
      {
        type: 'module',
        module: oasisRef,
        eventType: 'oasis_camped',
        payload: { playerId, cellId: OASIS_A, cost: CAMP_COST, previousCellId: null },
      },
      { type: 'bank_paid', playerId, amount: CAMP_COST },
    ]);
  });

  it('在他处再扎营等于迁营：旧营地作废，只保留新的一处', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const camped = withCamp(base, { [playerId]: OASIS_A });
    const landed = landOnOasis(camped, playerId, OASIS_B);

    const migrated = applyIntent(landed.state, playerId, intentFor(pendingOfKind(landed.state, 'camp')));
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;

    expect(cashOf(migrated.state, playerId)).toBe(base.config.initialCash - CAMP_COST);
    expect(migrated.state.publicRuleState.modules).toEqual({
      [OASIS_CAMP_MODULE_KEY]: { campByPlayerId: { [playerId]: OASIS_B } },
    });
    expect(migrated.state.recentLog.slice(-2)).toEqual([
      {
        type: 'module',
        module: oasisRef,
        eventType: 'oasis_camped',
        payload: { playerId, cellId: OASIS_B, cost: CAMP_COST, previousCellId: OASIS_A },
      },
      { type: 'bank_paid', playerId, amount: CAMP_COST },
    ]);
  });

  it('撤营退回半价，且营地记录被整条删除（不留空壳）', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const camped = withCamp(base, { [playerId]: OASIS_A });
    const landed = landOnOasis(camped, playerId, OASIS_A);

    const refunded = applyIntent(landed.state, playerId, intentFor(pendingOfKind(landed.state, 'refund')));
    expect(refunded.ok).toBe(true);
    if (!refunded.ok) return;

    expect(cashOf(refunded.state, playerId)).toBe(base.config.initialCash + CAMP_REFUND);
    expect(refunded.state.publicRuleState.modules).toEqual({});
    expect(refunded.events).toContainEqual({
      type: 'module',
      module: oasisRef,
      eventType: 'oasis_abandoned',
      payload: { playerId, cellId: OASIS_A, refund: CAMP_REFUND },
    });
    expect(refunded.events).toContainEqual({ type: 'bank_received', playerId, amount: CAMP_REFUND });
  });

  it('不扎营只记事件，不花钱，选项消费后可以正常结束回合', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnOasis(base, playerId);

    const declined = applyIntent(landed.state, playerId, intentFor(pendingOfKind(landed.state, 'skip')));
    expect(declined.ok).toBe(true);
    if (!declined.ok) return;

    expect(cashOf(declined.state, playerId)).toBe(base.config.initialCash);
    expect(declined.state.publicRuleState.modules).toEqual({});
    expect(declined.state.recentLog.slice(-1)).toEqual([{
      type: 'module',
      module: oasisRef,
      eventType: 'oasis_declined',
      payload: { playerId, cellId: OASIS_A },
    }]);
    expect(applyIntent({ ...declined.state, turnPhase: 'managing' }, playerId, { type: 'end_turn' }).ok).toBe(true);
  });
});

describe('oasis-camp@1 经过即触发', () => {
  it('掷骰路过自己的营地就领 500 补给', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const state = {
      ...placePlayer(withCamp(base, { [playerId]: OASIS_A }), playerId, OASIS_A - 2),
      turnPhase: 'awaiting_roll' as const,
      seed: seedWithDiceSum(3),
    };
    const before = cashOf(state, playerId);

    const rolled = applyIntent(state, playerId, { type: 'roll_dice' });
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;

    const path = (rolled.events.find((event) => event.type === 'token_moved') as { path: number[] }).path;
    expect(path).toContain(OASIS_A);
    expect(path.at(-1)).not.toBe(OASIS_A); // 只是路过，不是停留
    expect(rolled.events).toContainEqual({
      type: 'module',
      module: oasisRef,
      eventType: 'oasis_bonus',
      payload: { playerId, cellId: OASIS_A, amount: CAMP_BONUS },
    });
    expect(rolled.events).toContainEqual({ type: 'bank_received', playerId, amount: CAMP_BONUS });
    expect(cashOf(rolled.state, playerId)).toBe(before + CAMP_BONUS);
  });

  it('停在营地上同样领补给（经过即触发含停留）', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const state = {
      ...placePlayer(withCamp(base, { [playerId]: OASIS_A }), playerId, OASIS_A - 2),
      turnPhase: 'awaiting_roll' as const,
      seed: seedWithDiceSum(2),
    };
    const before = cashOf(state, playerId);

    const rolled = applyIntent(state, playerId, { type: 'roll_dice' });
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;

    expect(playerOf(rolled.state, playerId).position).toBe(OASIS_A);
    expect(rolled.events).toContainEqual({
      type: 'module',
      module: oasisRef,
      eventType: 'oasis_bonus',
      payload: { playerId, cellId: OASIS_A, amount: CAMP_BONUS },
    });
    expect(cashOf(rolled.state, playerId)).toBe(before + CAMP_BONUS);
    // 停在自家营地上，撤营选项照常摆出来。
    expect(hasKind(rolled.state, 'refund')).toBe(true);
  });

  it('没扎营时路过绿洲不发补给', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const state = {
      ...placePlayer(base, playerId, OASIS_A - 2),
      turnPhase: 'awaiting_roll' as const,
      seed: seedWithDiceSum(3),
    };

    const rolled = applyIntent(state, playerId, { type: 'roll_dice' });
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;

    expect(rolled.events.some((event) => (
      event.type === 'module' && (event as unknown as { eventType: string }).eventType === 'oasis_bonus'
    ))).toBe(false);
    expect(rolled.state.publicRuleState.modules).toEqual({});
  });

  it('营地在别人名下时路过不发补给', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const otherId = base.players.find((player) => player.id !== playerId)!.id;
    const state = {
      ...placePlayer(withCamp(base, { [otherId]: OASIS_A }), playerId, OASIS_A - 2),
      turnPhase: 'awaiting_roll' as const,
      seed: seedWithDiceSum(3),
    };

    const rolled = applyIntent(state, playerId, { type: 'roll_dice' });
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;

    expect(rolled.events.some((event) => (
      event.type === 'module' && (event as unknown as { eventType: string }).eventType === 'oasis_bonus'
    ))).toBe(false);
    expect(rolled.state.publicRuleState.modules).toEqual({
      [OASIS_CAMP_MODULE_KEY]: { campByPlayerId: { [otherId]: OASIS_A } },
    });
  });
});

describe('oasis-camp@1 bot 策略', () => {
  it('现金宽裕时扎营', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const rich = setCash(base, playerId, CAMP_COST + BOT_CAMP_RESERVE);
    const landed = landOnOasis(rich, playerId);

    expect(chooseBotIntent(landed.state, playerId)).toEqual({
      type: 'module',
      module: oasisRef,
      action: 'oasis-choice',
      payload: pendingOfKind(landed.state, 'camp').payload,
    });
  });

  it('现金只够营地费而无安全垫时不扎营', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const tight = setCash(base, playerId, CAMP_COST + BOT_CAMP_RESERVE - 1);
    const landed = landOnOasis(tight, playerId);

    expect(chooseBotIntent(landed.state, playerId)).toEqual({
      type: 'module',
      module: oasisRef,
      action: 'oasis-choice',
      payload: pendingOfKind(landed.state, 'skip').payload,
    });
  });

  it('现金告急且站在自己营地时撤营回血', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const poor = setCash(withCamp(base, { [playerId]: OASIS_A }), playerId, CAMP_COST - 1);
    const landed = landOnOasis(poor, playerId, OASIS_A);

    expect(chooseBotIntent(landed.state, playerId)).toEqual({
      type: 'module',
      module: oasisRef,
      action: 'oasis-choice',
      payload: pendingOfKind(landed.state, 'refund').payload,
    });
  });

  it('没有绿洲选项时把决策交回既有链路（掷骰）', () => {
    const base = makeGame();
    expect(chooseBotIntent(base, base.currentPlayerId)).toEqual({ type: 'roll_dice' });
  });
});

describe('oasis-camp@1 失效选项清理（回归）', () => {
  it('投降推进回合后不留下失效的绿洲选项，下一位玩家可以正常掷骰', () => {
    const base = makeGame(3);
    const playerId = base.currentPlayerId;
    const landed = landOnOasis(base, playerId);
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
    const landed = landOnOasis(base, playerId);

    const skipped = skipCurrentTurn(landed.state, playerId);
    expect(skipped.ok).toBe(true);
    if (!skipped.ok) return;

    expect(skipped.state.publicRuleState.pendingActions).toEqual([]);
  });
});

describe('oasis-camp@1 hydrate 校验', () => {
  it('正常状态（还没人扎营）可以无损恢复', () => {
    const state = makeGame();
    expect(hydrateGameState(structuredClone(state), xinjiangTourMap)).toMatchObject({ ok: true });
  });

  it('合法营地（存活玩家 + 真实绿洲格）可以恢复', () => {
    const state = withCamp(makeGame(), { p1: OASIS_A, p2: OASIS_B });
    expect(hydrateGameState(structuredClone(state), xinjiangTourMap)).toMatchObject({ ok: true });
  });

  it('幽灵玩家 / 营地在非绿洲格 / 负数格都视为损坏存档', () => {
    const base = makeGame();
    const cases = [
      withCamp(base, { px: OASIS_A }),
      withCamp(base, { p1: OASIS_A + 1 }),
      withCamp(base, { p1: -1 }),
    ];
    for (const broken of cases) {
      expect(hydrateGameState(structuredClone(broken), xinjiangTourMap)).toMatchObject({ ok: false });
    }
  });
});
