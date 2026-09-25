// caravan-market@1（丝路商队 / 丝绸之路）的模块级测试。
//
// 覆盖四件事：
//   1) 落点只摆选项（进货 / 出货 / 不交易），同一动作名下多分支。
//   2) 个体库存：每人最多囤 3 件，货清零时删键（不是写 0）——存档字节表示唯一。
//   3) 全场共享的浮动市价：越界值会被夹回 [200, 1600]，且每回合结算一次随机浮动。
//   4) hydrate 的严格校验：市价必须是 200 的整数倍、库存键必须是存活玩家且件数在 1..3。
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@richman/board-data';
import { silkRoadMap } from '@richman/board-data';
import { applyIntent, createGame, skipCurrentTurn } from '../engine';
import { resolveLanding } from '../effects';
import { chooseBotIntent } from '../bot';
import { hydrateGameState } from '../hydrate';
import { defaultRuleModuleRegistry } from '../moduleRegistry';
import { CARAVAN_MARKET_MODULE_KEY, caravanCells } from '../caravanMarketModule';
import type { GameEvent, GameState, PendingModuleAction } from '../types';

const caravanRef = { id: 'caravan-market', version: 1 } as const;
const coreRef = { id: 'core', version: 1 } as const;

/** 丝绸之路上四处集市（按**棋盘数组顺序**，不是 id 升序）。 */
const CARAVAN_CELLS = [44, 56, 54, 36] as const;
const CARAVAN_A = CARAVAN_CELLS[0];
const UNIT_COST = 500;
const MAX_UNITS = 3;
const MARKET_INITIAL = 1000;
const MARKET_MIN = 200;
const MARKET_MAX = 1600;
const MARKET_STEP = 200;
const BOT_BUY_RESERVE = 2000;
const BOT_SELL_PRICE = 1200;

/** 探针验证过：此种子下第一次跨回合结算市价一定会动。 */
const MOVING_SEED = 'caravan-1';

function makeGame(playerCount = 2, seed = 'caravan-base'): GameState {
  return createGame({
    mapRef: silkRoadMap.ref,
    ruleModules: silkRoadMap.game.requiredRuleModules,
    board: silkRoadMap.game.board,
    cards: silkRoadMap.game.cards,
    config: silkRoadMap.game.config,
    players: [
      { id: 'p1', nickname: '甲' },
      { id: 'p2', nickname: '乙' },
      { id: 'p3', nickname: '丙' },
    ].slice(0, playerCount),
    seed,
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

function withModuleState(
  state: GameState,
  moduleState: JsonValue,
  pendingActions: PendingModuleAction[] = [],
): GameState {
  return {
    ...state,
    publicRuleState: { modules: { [CARAVAN_MARKET_MODULE_KEY]: moduleState }, pendingActions },
  };
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
  if (!action) throw new Error(`missing caravan-choice action with kind=${kind}`);
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

function landOnCaravan(state: GameState, playerId: string, cellId = CARAVAN_A) {
  return resolveLanding(placePlayer(state, playerId, cellId), playerId, []);
}

describe('caravan-market@1 落点结算与交易', () => {
  it('createGame 初始化干净的公开规则状态，且注册表认识 caravan-market@1', () => {
    const state = makeGame();

    expect(state.publicRuleState).toEqual({ modules: {}, pendingActions: [] });
    expect(state.ruleModules).toEqual([coreRef, caravanRef]);
  });

  it('棋盘上四处集市，且默认 registry 认识 caravan 格的处理器', () => {
    const state = makeGame();

    expect(caravanCells(state.board).map((cell) => cell.id)).toEqual([...CARAVAN_CELLS]);
    for (const cell of caravanCells(state.board)) {
      expect(() => defaultRuleModuleRegistry.getCellHandler(state.ruleModules, cell)).not.toThrow();
    }
  });

  it('首次落点只有「进货 / 不交易」两个选项，落点本身不动钱', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnCaravan(base, playerId);

    const actions = landed.state.publicRuleState.pendingActions;
    expect(actions).toHaveLength(2);
    expect([...new Set(actions.map((action) => `${action.module.id}@${action.module.version}:${action.action}`))])
      .toEqual([`${CARAVAN_MARKET_MODULE_KEY}:caravan-choice`]);
    expect(actions.map((action) => action.requiredPhase)).toEqual(['managing', 'managing']);
    expect(actions.map((action) => action.label)).toEqual([
      `进货一件（${UNIT_COST} 元，现囤 0/${MAX_UNITS}）`,
      '不交易',
    ]);
    expect(cashOf(landed.state, playerId)).toBe(base.config.initialCash);
    expect(moduleEventTypes(landed.events)).toEqual(['caravan_visited']);
    expect(landed.events).toContainEqual({
      type: 'module',
      module: caravanRef,
      eventType: 'caravan_visited',
      payload: { playerId, cellId: CARAVAN_A, marketPrice: MARKET_INITIAL },
    });
  });

  it('进货扣款并写入库存，市价保持不变', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnCaravan(base, playerId);

    const bought = applyIntent(landed.state, playerId, intentFor(pendingOfKind(landed.state, 'buy')));
    expect(bought.ok).toBe(true);
    if (!bought.ok) return;

    expect(cashOf(bought.state, playerId)).toBe(base.config.initialCash - UNIT_COST);
    expect(bought.state.publicRuleState.modules[CARAVAN_MARKET_MODULE_KEY]).toEqual({
      marketPrice: MARKET_INITIAL,
      unitsByPlayerId: { [playerId]: 1 },
    });
    expect(bought.events).toContainEqual({
      type: 'module',
      module: caravanRef,
      eventType: 'caravan_traded',
      payload: {
        playerId,
        cellId: CARAVAN_A,
        kind: 'buy',
        units: 1,
        marketPrice: MARKET_INITIAL,
        amount: UNIT_COST,
      },
    });
    expect(bought.state.publicRuleState.pendingActions).toEqual([]);
  });

  it('满仓时不再给出进货选项，只剩出货与不交易', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const full = withModuleState(base, {
      marketPrice: 1400,
      unitsByPlayerId: { [playerId]: MAX_UNITS },
    });

    const landed = landOnCaravan(full, playerId);

    expect(landed.state.publicRuleState.pendingActions).toHaveLength(2);
    expect(landed.state.publicRuleState.pendingActions.some((action) => (
      (action.payload as Record<string, JsonValue>).kind === 'buy'
    ))).toBe(false);
    expect(pendingOfKind(landed.state, 'sell').label).toBe(`出货一件（现价 1400 元）`);
  });

  it('出货按当前市价结算，库存清零时删除键而不是写 0', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const holding = withModuleState(base, {
      marketPrice: 1400,
      unitsByPlayerId: { [playerId]: 1 },
    });

    const landed = landOnCaravan(holding, playerId);
    const sold = applyIntent(landed.state, playerId, intentFor(pendingOfKind(landed.state, 'sell')));
    expect(sold.ok).toBe(true);
    if (!sold.ok) return;

    expect(cashOf(sold.state, playerId)).toBe(base.config.initialCash + 1400);
    expect(sold.events).toContainEqual({ type: 'bank_received', playerId, amount: 1400 });
    // 市价不是初始值，所以模块状态仍在；但该玩家的库存键必须消失（键的缺失 = 0 件）。
    expect(sold.state.publicRuleState.modules[CARAVAN_MARKET_MODULE_KEY]).toEqual({
      marketPrice: 1400,
      unitsByPlayerId: {},
    });
  });

  it('不交易只记事件，不扣钱也不改库存', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnCaravan(base, playerId);

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

describe('caravan-market@1 全场共享市价', () => {
  it('跨回合结算时市价随机浮动，且始终是 200 的整数倍并落在 [200, 1600]', () => {
    const base = makeGame(2, MOVING_SEED);

    const skipped = skipCurrentTurn(base, base.currentPlayerId);
    expect(skipped.ok).toBe(true);
    if (!skipped.ok) return;

    const events = skipped.events.filter((event) => (
      event.type === 'module' && (event as unknown as { eventType: string }).eventType === 'caravan_market'
    ));
    expect(events).toHaveLength(1);
    const payload = (events[0] as unknown as { payload: { previous: number; price: number; delta: number } }).payload;
    expect(payload.previous).toBe(MARKET_INITIAL);
    expect(payload.price).not.toBe(payload.previous);
    expect(payload.delta).toBe(payload.price - payload.previous);
    expect(payload.price % MARKET_STEP).toBe(0);
    expect(payload.price).toBeGreaterThanOrEqual(MARKET_MIN);
    expect(payload.price).toBeLessThanOrEqual(MARKET_MAX);

    const moduleState = skipped.state.publicRuleState.modules[CARAVAN_MARKET_MODULE_KEY] as {
      marketPrice: number;
    };
    expect(moduleState.marketPrice).toBe(payload.price);
  });

  it('损坏存档里的越界市价在读取时被夹回区间上限', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const corrupted = withModuleState(base, {
      marketPrice: 9999,
      unitsByPlayerId: { [playerId]: 1 },
    });

    const landed = landOnCaravan(corrupted, playerId);

    expect(pendingOfKind(landed.state, 'sell').label).toBe(`出货一件（现价 ${MARKET_MAX} 元）`);
  });

  it('市价长期随机游走也不会越界（从上限出发连续推进 10 个回合）', () => {
    const base = makeGame(2, 'caravan-walk');
    let state = withModuleState(base, { marketPrice: MARKET_MAX, unitsByPlayerId: {} });

    for (let round = 0; round < 10; round += 1) {
      const skipped = skipCurrentTurn(state, state.currentPlayerId);
      if (!skipped.ok) throw new Error(skipped.code);
      state = skipped.state;
      // 市价回到初始档且无人持仓时，模块会把自己的状态键裁掉（省快照体积），
      // 因此这里必须按「缺键 = 初始档」读取。
      const raw = state.publicRuleState.modules[CARAVAN_MARKET_MODULE_KEY] as { marketPrice: number } | undefined;
      const price = raw?.marketPrice ?? MARKET_INITIAL;
      if (raw === undefined) expect(price).toBe(MARKET_INITIAL);
      expect(price % MARKET_STEP).toBe(0);
      expect(price).toBeGreaterThanOrEqual(MARKET_MIN);
      expect(price).toBeLessThanOrEqual(MARKET_MAX);
    }
  });

  it('市价回到初始档且无人持仓时，模块状态键被裁掉而不是留一个空壳', () => {
    const base = makeGame(2, 'caravan-walk');
    let state = withModuleState(base, { marketPrice: MARKET_MAX, unitsByPlayerId: {} });

    let sawPriceMove = false;
    let sawPruned = false;
    for (let round = 0; round < 10; round += 1) {
      const skipped = skipCurrentTurn(state, state.currentPlayerId);
      if (!skipped.ok) throw new Error(skipped.code);
      state = skipped.state;
      const raw = state.publicRuleState.modules[CARAVAN_MARKET_MODULE_KEY] as { marketPrice: number } | undefined;
      if (raw !== undefined && raw.marketPrice !== MARKET_MAX) sawPriceMove = true;
      if (raw === undefined) {
        sawPruned = true;
        expect(Object.prototype.hasOwnProperty.call(state.publicRuleState.modules, CARAVAN_MARKET_MODULE_KEY)).toBe(false);
      }
    }
    expect(sawPriceMove).toBe(true);
    // 10 个回合内市价必然至少回到过一次初始档（步长 200、区间 200..1600、随机游走）。
    expect(sawPruned).toBe(true);
  });
});

describe('caravan-market@1 bot 策略', () => {
  it('市价高且有库存时出货', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const holding = withModuleState(base, {
      marketPrice: BOT_SELL_PRICE,
      unitsByPlayerId: { [playerId]: 1 },
    });
    const landed = landOnCaravan(holding, playerId);

    expect(chooseBotIntent(landed.state, playerId)).toEqual({
      type: 'module',
      module: caravanRef,
      action: 'caravan-choice',
      payload: pendingOfKind(landed.state, 'sell').payload,
    });
  });

  it('市价低但现金宽裕且未满仓时进货', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const rich = {
      ...base,
      players: base.players.map((player) => (
        player.id === playerId ? { ...player, cash: UNIT_COST + BOT_BUY_RESERVE + base.config.initialCash } : player
      )),
    };
    const landed = landOnCaravan(rich, playerId);

    expect(chooseBotIntent(landed.state, playerId)).toEqual({
      type: 'module',
      module: caravanRef,
      action: 'caravan-choice',
      payload: pendingOfKind(landed.state, 'buy').payload,
    });
  });

  it('没有集市选项时把决策交回既有链路（掷骰）', () => {
    const base = makeGame();
    expect(chooseBotIntent(base, base.currentPlayerId)).toEqual({ type: 'roll_dice' });
  });
});

describe('caravan-market@1 hydrate 校验', () => {
  function brokenWith(moduleState: JsonValue): unknown {
    const state = makeGame(3);
    return {
      ...structuredClone(state),
      publicRuleState: { modules: { [CARAVAN_MARKET_MODULE_KEY]: moduleState }, pendingActions: [] },
    };
  }

  it('合法的市价 + 库存可以无损恢复', () => {
    const broken = brokenWith({ marketPrice: 1200, unitsByPlayerId: { p1: 2 } });
    expect(hydrateGameState(broken, silkRoadMap)).toMatchObject({ ok: true });
  });

  it('市价不是 200 的整数倍时拒绝恢复', () => {
    expect(hydrateGameState(brokenWith({ marketPrice: 1300, unitsByPlayerId: {} }), silkRoadMap))
      .toMatchObject({ ok: false });
  });

  it('库存件数超过 3 件时拒绝恢复（否则损坏存档会一次性套现巨额现金）', () => {
    expect(hydrateGameState(brokenWith({ marketPrice: 1000, unitsByPlayerId: { p1: 4 } }), silkRoadMap))
      .toMatchObject({ ok: false });
  });

  it('库存键不是本局玩家时拒绝恢复', () => {
    expect(hydrateGameState(brokenWith({ marketPrice: 1000, unitsByPlayerId: { ghost: 1 } }), silkRoadMap))
      .toMatchObject({ ok: false });
  });
});
