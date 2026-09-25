// 规则模块 `caravan-market@1`：丝路商队（丝绸之路）
//
// 机制（既有模块里唯一的「全局共享浮动市价」）：
//   · 地图上的 `caravan` 模块格叫「集市」。落到集市可以**进货**（500 元/件，最多囤 3 件）
//     或**出货**（按当前市价把一件货换成现金）。
//   · 市价是**全场共享**的一个宏观变量：每回合随机上下浮动一档（每档 200 元，区间 200~1600），
//     与谁在哪个集市无关。于是「趁低价囤货、趁高价出货」成了所有玩家共同参与的一件公共事件 ——
//     这是本模块与其它七个模块最大的区别：它不是一个人的选择，是全场共同的行情。
//   · 低买高卖的上限收益：一件货最多赚 1100（200 进货价不变，市价 1600 出货），
//     满仓 3 件最多赚 3300 —— 足以影响排名，但要熬过市价随机游走的等待成本。
//
// 两条与既有模块一致的硬约束：同一时刻的待选动作必须是同一个 `模块:动作`（三选项共用
// `caravan-choice`，分支放在 payload.kind）；待选动作只在落点结算时生成一次，
// postTransitionHook 只做「市价涨落 + 清理」，绝不重新生成选项。
import type { DeepReadonly, JsonValue, ModuleCell, RuleModuleRef } from '@richman/board-data';
import type { ApplyResult, GameEvent, GameState, PendingModuleAction, PlayerState } from './types';
import type { CellSettlementContext, IntentExecutionContext, RuleModuleDefinition } from './moduleRegistry';
import { finishCashGoalIfReached } from './moduleToolkit';
import { crossedTurnBoundary, moduleEventFor, pickRandomIndex, readRawModuleState, withRawModuleState } from './moduleSupport';

export const CARAVAN_MARKET_MODULE_REF = Object.freeze({ id: 'caravan-market', version: 1 }) satisfies RuleModuleRef;
export const CARAVAN_MARKET_MODULE_KEY = 'caravan-market@1';

/** 进货单价（恒定：涨的是市价，不是进价）。 */
const UNIT_COST = 500;
/** 每人最多囤货件数。 */
const MAX_UNITS = 3;
/** 市价区间与初始值。 */
const MARKET_MIN = 200;
const MARKET_MAX = 1600;
const MARKET_INITIAL = 1000;
/** 市价档位粒度：所有市价都是它的整数倍。 */
const MARKET_STEP = 200;
/** 每回合市价浮动档数（随机游走）：偏中性、偶尔大动。 */
const MARKET_DELTAS: readonly number[] = [-2, -1, -1, 0, 1, 1, 2];
/** 机器人愿意囤货前保留的现金。 */
const BOT_BUY_RESERVE = 2000;
/** 机器人出货的市价门槛（低于此价宁可继续持有）。 */
const BOT_SELL_PRICE = 1200;

const KIND_BUY = 'buy';
const KIND_SELL = 'sell';
const KIND_SKIP = 'skip';

export interface CaravanMarketPublicModuleState {
  /** 全场共享市价（MARKET_STEP 的整数倍，落在 [MARKET_MIN, MARKET_MAX]）。 */
  readonly marketPrice: number;
  /** playerId → 囤货件数（1..MAX_UNITS；清零时删键）。 */
  readonly unitsByPlayerId: Readonly<Record<string, number>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isCaravanCell(cell: DeepReadonly<ModuleCell> | undefined): cell is DeepReadonly<ModuleCell> {
  return cell?.type === 'module'
    && cell.module.id === CARAVAN_MARKET_MODULE_REF.id
    && cell.module.version === CARAVAN_MARKET_MODULE_REF.version
    && cell.cellType === 'caravan';
}

/** 棋盘上全部集市格（按数组顺序）。 */
export function caravanCells(board: { readonly cells: readonly unknown[] }): DeepReadonly<ModuleCell>[] {
  const cells: DeepReadonly<ModuleCell>[] = [];
  for (const candidate of board.cells) {
    const cell = candidate as DeepReadonly<ModuleCell>;
    if (isCaravanCell(cell)) cells.push(cell);
  }
  return cells;
}

/** 集市格 payload 必须为空对象（进价/上限/市价区间都是模块常量）。 */
export function isCaravanCellPayload(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

function clampPrice(value: number): number {
  const stepped = Math.round(value / MARKET_STEP) * MARKET_STEP;
  return Math.max(MARKET_MIN, Math.min(MARKET_MAX, stepped));
}

function emptyCaravanState(): CaravanMarketPublicModuleState {
  return { marketPrice: MARKET_INITIAL, unitsByPlayerId: {} };
}

function readCaravanState(state: GameState): CaravanMarketPublicModuleState {
  const value = readRawModuleState(state, CARAVAN_MARKET_MODULE_KEY);
  if (!isRecord(value)) return emptyCaravanState();
  const marketPrice = typeof value.marketPrice === 'number' && Number.isFinite(value.marketPrice)
    ? clampPrice(value.marketPrice)
    : MARKET_INITIAL;
  const unitsByPlayerId: Record<string, number> = {};
  if (isRecord(value.unitsByPlayerId)) {
    for (const [playerId, units] of Object.entries(value.unitsByPlayerId)) {
      if (typeof units === 'number' && Number.isSafeInteger(units) && units > 0 && units <= MAX_UNITS) {
        unitsByPlayerId[playerId] = units;
      }
    }
  }
  return { marketPrice, unitsByPlayerId };
}

function hasCaravanState(value: CaravanMarketPublicModuleState): boolean {
  return value.marketPrice !== MARKET_INITIAL || Object.keys(value.unitsByPlayerId).length > 0;
}

function withCaravanState(
  state: GameState,
  caravanState: CaravanMarketPublicModuleState,
  pendingActions: readonly PendingModuleAction[] = state.publicRuleState.pendingActions,
): GameState {
  return withRawModuleState(
    state,
    CARAVAN_MARKET_MODULE_KEY,
    hasCaravanState(caravanState) ? (caravanState as unknown as JsonValue) : null,
    pendingActions,
  );
}

/** 丢弃失效账目：破产/已离场的玩家不再持有库存。 */
function cleanCaravanState(state: GameState): CaravanMarketPublicModuleState {
  const current = readCaravanState(state);
  const alive = new Set(state.players.filter((player) => !player.bankrupt).map((player) => player.id));
  const unitsByPlayerId: Record<string, number> = {};
  for (const [playerId, units] of Object.entries(current.unitsByPlayerId)) {
    if (alive.has(playerId)) unitsByPlayerId[playerId] = units;
  }
  return { marketPrice: current.marketPrice, unitsByPlayerId };
}

function isCaravanCellId(state: GameState, cellId: number): boolean {
  return caravanCells(state.board).some((cell) => cell.id === cellId);
}

function event(eventType: string, payload: JsonValue): GameEvent {
  return moduleEventFor(CARAVAN_MARKET_MODULE_REF, eventType, payload);
}

function caravanOptionId(state: GameState, playerId: string, cellId: number, kind: string): string {
  return `${CARAVAN_MARKET_MODULE_KEY}:caravan-choice:${playerId}:${state.turn}:${cellId}:${kind}`;
}

function caravanChoiceAction(
  state: GameState,
  playerId: string,
  cellId: number,
  kind: string,
  label: string,
): PendingModuleAction {
  const optionId = caravanOptionId(state, playerId, cellId, kind);
  return {
    optionId,
    module: CARAVAN_MARKET_MODULE_REF,
    playerId,
    requiredPhase: 'managing',
    label,
    action: 'caravan-choice',
    payload: { optionId, cellId, kind },
  };
}

function caravanChoiceActions(
  state: GameState,
  caravanState: CaravanMarketPublicModuleState,
  player: PlayerState,
): PendingModuleAction[] {
  if (!isCaravanCellId(state, player.position)) return [];
  const units = caravanState.unitsByPlayerId[player.id] ?? 0;
  const actions: PendingModuleAction[] = [];
  if (player.cash >= UNIT_COST && units < MAX_UNITS) {
    actions.push(caravanChoiceAction(
      state,
      player.id,
      player.position,
      KIND_BUY,
      `进货一件（${UNIT_COST} 元，现囤 ${units}/${MAX_UNITS}）`,
    ));
  }
  if (units > 0) {
    actions.push(caravanChoiceAction(
      state,
      player.id,
      player.position,
      KIND_SELL,
      `出货一件（现价 ${caravanState.marketPrice} 元）`,
    ));
  }
  actions.push(caravanChoiceAction(state, player.id, player.position, KIND_SKIP, '不交易'));
  return actions;
}

/** 落点结算：只摆出选项，不产生任何金钱变动。 */
function settleCaravanLanding(context: CellSettlementContext) {
  const cell = context.cell as DeepReadonly<ModuleCell>;
  const player = context.state.players.find((candidate) => candidate.id === context.playerId);
  if (!player || player.position !== cell.id || !isCaravanCellPayload(cell.payload)) {
    return context.applyCore();
  }
  const caravanState = cleanCaravanState(context.state);
  const actions = caravanChoiceActions(context.state, caravanState, player);
  const state = withCaravanState(
    { ...context.state, turnPhase: 'managing' },
    caravanState,
    [
      ...context.state.publicRuleState.pendingActions.filter(
        (action) => action.playerId !== context.playerId,
      ),
      ...actions,
    ],
  );
  return {
    state,
    events: [...context.events, event('caravan_visited', {
      playerId: context.playerId,
      cellId: cell.id,
      marketPrice: caravanState.marketPrice,
    })],
    newDebt: state.debt,
  };
}

function isOwnAction(action: PendingModuleAction): boolean {
  return action.module.id === CARAVAN_MARKET_MODULE_REF.id
    && action.module.version === CARAVAN_MARKET_MODULE_REF.version;
}

function withoutPlayerCaravanActions(state: GameState, playerId: string): GameState {
  return {
    ...state,
    publicRuleState: {
      ...state.publicRuleState,
      pendingActions: state.publicRuleState.pendingActions.filter((action) => !(
        action.playerId === playerId && isOwnAction(action)
      )),
    },
  };
}

function matchingPendingAction(
  state: GameState,
  playerId: string,
  intent: IntentExecutionContext['intent'],
): PendingModuleAction | undefined {
  return state.publicRuleState.pendingActions.find((action) => (
    action.playerId === playerId
    && isOwnAction(action)
    && intent.type === 'module'
    && action.action === intent.action
    && isRecord(action.payload)
    && isRecord(intent.payload)
    && action.payload.optionId === intent.payload.optionId
  ));
}

function handleCaravanChoice(context: IntentExecutionContext): ApplyResult {
  const { state, playerId, intent } = context;
  if (state.turnPhase !== 'managing') return { ok: false, code: 'WRONG_PHASE' };
  const pending = matchingPendingAction(state, playerId, intent);
  if (pending === undefined || !isRecord(pending.payload)) return { ok: false, code: 'ILLEGAL_INTENT' };
  const cellId = pending.payload.cellId;
  const kind = pending.payload.kind;
  if (!Number.isSafeInteger(cellId) || typeof kind !== 'string') return { ok: false, code: 'ILLEGAL_INTENT' };

  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player || player.bankrupt || player.position !== cellId) return { ok: false, code: 'ILLEGAL_INTENT' };

  const base = withoutPlayerCaravanActions(state, playerId);
  const caravanState = cleanCaravanState(state);
  const units = caravanState.unitsByPlayerId[playerId] ?? 0;
  const finish = (nextState: GameState, events: GameEvent[]): ApplyResult => ({
    ok: true,
    state: { ...nextState, turnPhase: 'managing', recentLog: [...state.recentLog, ...events].slice(-200) },
    events,
  });
  const withUnits = (nextUnits: number): CaravanMarketPublicModuleState => {
    const unitsByPlayerId = { ...caravanState.unitsByPlayerId };
    if (nextUnits > 0) unitsByPlayerId[playerId] = nextUnits;
    else delete unitsByPlayerId[playerId];
    return { marketPrice: caravanState.marketPrice, unitsByPlayerId };
  };

  if (kind === KIND_SKIP) {
    return finish(base, [event('caravan_declined', { playerId, cellId })]);
  }

  if (kind === KIND_BUY) {
    if (player.cash < UNIT_COST || units >= MAX_UNITS) return { ok: false, code: 'ILLEGAL_INTENT' };
    const events: GameEvent[] = [event('caravan_traded', {
      playerId,
      cellId,
      kind: KIND_BUY,
      units: units + 1,
      marketPrice: caravanState.marketPrice,
      amount: UNIT_COST,
    }),
    // 进货的 500 元离开牌桌（对照出货已发的 bank_received）：不发这条会破坏现金守恒。
    { type: 'bank_paid', playerId, amount: UNIT_COST }];
    const next = withCaravanState(
      {
        ...base,
        players: state.players.map((candidate) => (
          candidate.id === playerId ? { ...candidate, cash: candidate.cash - UNIT_COST } : candidate
        )),
      },
      withUnits(units + 1),
    );
    return finish(next, events);
  }

  if (kind !== KIND_SELL) return { ok: false, code: 'ILLEGAL_INTENT' };
  if (units <= 0) return { ok: false, code: 'ILLEGAL_INTENT' };
  const price = caravanState.marketPrice;
  const events: GameEvent[] = [
    event('caravan_traded', {
      playerId,
      cellId,
      kind: KIND_SELL,
      units: units - 1,
      marketPrice: price,
      amount: price,
    }),
    { type: 'bank_received', playerId, amount: price },
  ];
  const next = withCaravanState(
    {
      ...base,
      players: state.players.map((candidate) => (
        candidate.id === playerId ? { ...candidate, cash: candidate.cash + price } : candidate
      )),
    },
    withUnits(units - 1),
  );
  const win = finishCashGoalIfReached(next, events);
  return finish(win?.state ?? next, win?.events ?? events);
}

/**
 * 回合边界结算：市价随机浮动一档区间。只改市价，不生成任何待选动作。
 * 注意这里**不与任何玩家互动** —— 市价是全场共享的宏观量。
 */
function settleCaravanTurnBoundary(state: GameState): { state: GameState; events: GameEvent[] } {
  const current = cleanCaravanState(state);
  const picked = pickRandomIndex(state, MARKET_DELTAS.length);
  if (picked === null) return { state: withCaravanState(state, current), events: [] };
  const delta = MARKET_DELTAS[picked.index]!;
  const nextPrice = clampPrice(current.marketPrice + delta * MARKET_STEP);
  const next = withCaravanState({ ...state, seed: picked.seed }, {
    marketPrice: nextPrice,
    unitsByPlayerId: current.unitsByPlayerId,
  });
  if (nextPrice === current.marketPrice) return { state: next, events: [] };
  return {
    state: next,
    events: [event('caravan_market', {
      previous: current.marketPrice,
      price: nextPrice,
      delta: nextPrice - current.marketPrice,
    })],
  };
}

/** 只做清理，不重新生成选项。 */
function synchronizeCaravanState(state: GameState): GameState {
  const caravanState = cleanCaravanState(state);
  const kept = state.publicRuleState.pendingActions.filter((action) => (
    !isOwnAction(action) || isValidCaravanChoice(state, action)
  ));
  return withCaravanState(state, caravanState, kept);
}

function isValidCaravanChoice(state: GameState, action: PendingModuleAction): boolean {
  if (action.playerId !== state.currentPlayerId) return false;
  if (action.requiredPhase !== state.turnPhase || state.debt !== null) return false;
  if (!isRecord(action.payload) || !Number.isSafeInteger(action.payload.cellId)) return false;
  const player = state.players.find((candidate) => candidate.id === action.playerId);
  if (!player || player.bankrupt) return false;
  return player.position === action.payload.cellId && isCaravanCellId(state, player.position);
}

/** 机器人/托管：高价出货、闲钱囤货，其余不交易。 */
function chooseBotCaravanChoice(
  state: GameState,
  playerId: string,
): { type: 'module'; module: RuleModuleRef; action: string; payload: JsonValue } | undefined {
  const options = state.publicRuleState.pendingActions.filter(
    (action) => action.playerId === playerId && isOwnAction(action),
  );
  if (options.length === 0) return undefined;
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) return undefined;
  const caravanState = readCaravanState(state);
  const units = caravanState.unitsByPlayerId[playerId] ?? 0;
  const byKind = (kind: string): PendingModuleAction | undefined => options.find(
    (action) => isRecord(action.payload) && action.payload.kind === kind,
  );
  const toIntent = (action: PendingModuleAction | undefined) => (action === undefined ? undefined : {
    type: 'module' as const,
    module: action.module,
    action: action.action,
    payload: action.payload,
  });

  if (units > 0 && caravanState.marketPrice >= BOT_SELL_PRICE) {
    const sell = toIntent(byKind(KIND_SELL));
    if (sell !== undefined) return sell;
  }
  if (units < MAX_UNITS && player.cash >= UNIT_COST + BOT_BUY_RESERVE) {
    const buy = toIntent(byKind(KIND_BUY));
    if (buy !== undefined) return buy;
  }
  return toIntent(byKind(KIND_SELL) ?? byKind(KIND_SKIP) ?? byKind(KIND_BUY));
}

/**
 * hydrate 用的严格校验：市价必须是合法档位，库存键必须是本局存活玩家且件数在 [1, MAX_UNITS]。
 * 上限必须校验：损坏存档里一个超大件数会让玩家一次性套现巨额现金，等于毁掉整局。
 */
export function validateCaravanMarketPublicModuleState(
  value: unknown,
  players: readonly DeepReadonly<PlayerState>[],
): value is CaravanMarketPublicModuleState {
  if (!isRecord(value) || Object.keys(value).length !== 2
    || typeof value.marketPrice !== 'number' || !Number.isSafeInteger(value.marketPrice)
    || value.marketPrice < MARKET_MIN || value.marketPrice > MARKET_MAX
    || value.marketPrice % MARKET_STEP !== 0
    || !isRecord(value.unitsByPlayerId)) return false;
  const alive = new Set(players.filter((player) => !player.bankrupt).map((player) => player.id));
  for (const [playerId, units] of Object.entries(value.unitsByPlayerId)) {
    if (!alive.has(playerId)) return false;
    if (typeof units !== 'number' || !Number.isSafeInteger(units)) return false;
    if (units < 1 || units > MAX_UNITS) return false;
  }
  return true;
}

const caravanMarketRuleModuleInput: RuleModuleDefinition = {
  ref: CARAVAN_MARKET_MODULE_REF,
  cellHandlers: [{
    type: 'module',
    cellType: 'caravan',
    handle: settleCaravanLanding,
  }],
  effectHandlers: [],
  intentHandlers: [{
    type: 'module',
    action: 'caravan-choice',
    handle: handleCaravanChoice,
  }],
  botStrategyHook: {
    decide: (context) => {
      const decided = chooseBotCaravanChoice(context.state, context.playerId);
      return decided ?? context.currentDecision;
    },
  },
  postTransitionHook: {
    apply: (context) => {
      if (!context.result.ok) return context.result;
      const synced = synchronizeCaravanState(context.result.state);
      if (!crossedTurnBoundary(context.previousState, synced)) {
        return { ...context.result, state: synced };
      }
      const settled = settleCaravanTurnBoundary(synced);
      const resynced = synchronizeCaravanState(settled.state);
      return {
        ok: true,
        state: { ...resynced, recentLog: [...resynced.recentLog, ...settled.events].slice(-200) },
        events: [...context.result.events, ...settled.events],
      };
    },
  },
};

export const caravanMarketRuleModuleDefinition = caravanMarketRuleModuleInput;
