// 规则模块 `river-tide@1`：黄河汛期（黄河之旅）
//
// 机制（既有模块里唯一的「全局共享宏观变量」）：
//   · 地图上有一组 `river-works` 模块格叫「河工段」。黄河水位是**全场共享**的一个变量（0~10），
//     每回合随机涨落 ±0~2 格。
//   · 水位高（≥8）时全场过路费 ×1.5 —— 持有地产的人集体受益；
//     水位低（≤2）时全场过路费 ×0.6 —— 地产收益集体缩水。
//   · 落到河工段可以**修堤**：付 1000 元把水位压低 2 格。于是「谁出钱治河」成了一件公共事务：
//     修堤的人自己掏钱，受益的是**所有**地主 —— 典型的搭便车困境，多人对局里非常好玩。
//   · 与丝路集市（个体库存 + 共享市价）不同，这里连「库存」都没有：水位是纯宏观量，
//     所有人的策略都围绕它调整，这是本模块最"新意"的地方。
//
// 这是全仓**第一个使用 positiveRentHook 的模块**（此前该 hook 从未被任何模块实现过）：
// 租金倍率只能在 core 的地产租金分支上挂钩，见 effects.ts 的 runPositiveRentHooks 调用点。
import type { DeepReadonly, JsonValue, ModuleCell, RuleModuleRef } from '@richman/board-data';
import type { ApplyResult, GameEvent, GameState, PendingModuleAction, PlayerState } from './types';
import type {
  CellSettlementContext,
  IntentExecutionContext,
  PositiveRentContext,
  PositiveRentResult,
  RuleModuleDefinition,
} from './moduleRegistry';
import { crossedTurnBoundary, moduleEventFor, pickRandomIndex, readRawModuleState, withRawModuleState } from './moduleSupport';

export const RIVER_TIDE_MODULE_REF = Object.freeze({ id: 'river-tide', version: 1 }) satisfies RuleModuleRef;
export const RIVER_TIDE_MODULE_KEY = 'river-tide@1';

/** 水位区间与初始值。 */
const TIDE_MIN = 0;
const TIDE_MAX = 10;
const TIDE_INITIAL = 4;
/** 高水位阈值与倍率（租金上浮）。 */
const HIGH_TIDE = 8;
const HIGH_MULTIPLIER = 1.5;
/** 低水位阈值与倍率（租金缩水）。 */
const LOW_TIDE = 2;
const LOW_MULTIPLIER = 0.6;
/** 修堤费用与一次压低的水位格数。 */
const DIKE_COST = 1000;
const DIKE_REDUCTION = 2;
/** 每回合水位涨落（随机游走，单位=水位格）。 */
const TIDE_DELTAS: readonly number[] = [-2, -1, -1, 0, 1, 1, 2];
/** 机器人修堤的触发水位与所需现金。 */
const BOT_DIKE_LEVEL = 6;
const BOT_DIKE_RESERVE = 1500;

const KIND_DIKE = 'dike';
const KIND_SKIP = 'skip';

export interface RiverTidePublicModuleState {
  /** 全场共享水位（整数，[TIDE_MIN, TIDE_MAX]）。 */
  readonly level: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRiverWorksCell(cell: DeepReadonly<ModuleCell> | undefined): cell is DeepReadonly<ModuleCell> {
  return cell?.type === 'module'
    && cell.module.id === RIVER_TIDE_MODULE_REF.id
    && cell.module.version === RIVER_TIDE_MODULE_REF.version
    && cell.cellType === 'river-works';
}

/** 棋盘上全部河工格（按数组顺序）。 */
export function riverWorksCells(board: { readonly cells: readonly unknown[] }): DeepReadonly<ModuleCell>[] {
  const cells: DeepReadonly<ModuleCell>[] = [];
  for (const candidate of board.cells) {
    const cell = candidate as DeepReadonly<ModuleCell>;
    if (isRiverWorksCell(cell)) cells.push(cell);
  }
  return cells;
}

/** 河工格 payload 必须为空对象（费用/落差/阈值都是模块常量）。 */
export function isRiverWorksCellPayload(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

function clampLevel(value: number): number {
  return Math.max(TIDE_MIN, Math.min(TIDE_MAX, Math.round(value)));
}

function emptyTideState(): RiverTidePublicModuleState {
  return { level: TIDE_INITIAL };
}

/** 供其它模块/客户端/测试读取当前水位。 */
export function readTideState(state: GameState): RiverTidePublicModuleState {
  const value = readRawModuleState(state, RIVER_TIDE_MODULE_KEY);
  if (!isRecord(value) || typeof value.level !== 'number' || !Number.isFinite(value.level)) {
    return emptyTideState();
  }
  return { level: clampLevel(value.level) };
}

function withTideState(
  state: GameState,
  tideState: RiverTidePublicModuleState,
  pendingActions: readonly PendingModuleAction[] = state.publicRuleState.pendingActions,
): GameState {
  // 水位等于初始值时也照常落键：它是全场共享的宏观量，客户端要靠它渲染「黄河水位」指示条，
  // 删键会让「水位 4」和「水位未知」在 UI 上无法区分。
  return withRawModuleState(
    state,
    RIVER_TIDE_MODULE_KEY,
    tideState as unknown as JsonValue,
    pendingActions,
  );
}

/** 当前水位对应的租金倍率（非高非低时为 1）。 */
export function rentMultiplierFor(level: number): number {
  if (level >= HIGH_TIDE) return HIGH_MULTIPLIER;
  if (level <= LOW_TIDE) return LOW_MULTIPLIER;
  return 1;
}

function isRiverWorksCellId(state: GameState, cellId: number): boolean {
  return riverWorksCells(state.board).some((cell) => cell.id === cellId);
}

function event(eventType: string, payload: JsonValue): GameEvent {
  return moduleEventFor(RIVER_TIDE_MODULE_REF, eventType, payload);
}

function tideOptionId(state: GameState, playerId: string, cellId: number, kind: string): string {
  return `${RIVER_TIDE_MODULE_KEY}:river-works-choice:${playerId}:${state.turn}:${cellId}:${kind}`;
}

function tideChoiceAction(
  state: GameState,
  playerId: string,
  cellId: number,
  kind: string,
  label: string,
): PendingModuleAction {
  const optionId = tideOptionId(state, playerId, cellId, kind);
  return {
    optionId,
    module: RIVER_TIDE_MODULE_REF,
    playerId,
    requiredPhase: 'managing',
    label,
    action: 'river-works-choice',
    payload: { optionId, cellId, kind },
  };
}

function tideChoiceActions(
  state: GameState,
  tideState: RiverTidePublicModuleState,
  player: PlayerState,
): PendingModuleAction[] {
  if (!isRiverWorksCellId(state, player.position)) return [];
  const actions: PendingModuleAction[] = [];
  if (player.cash >= DIKE_COST && tideState.level > TIDE_MIN) {
    actions.push(tideChoiceAction(
      state,
      player.id,
      player.position,
      KIND_DIKE,
      `修堤（付 ${DIKE_COST} 元，水位 ${tideState.level} → ${Math.max(TIDE_MIN, tideState.level - DIKE_REDUCTION)}）`,
    ));
  }
  actions.push(tideChoiceAction(state, player.id, player.position, KIND_SKIP, '不修堤'));
  return actions;
}

/** 落点结算：只摆出选项，不产生任何金钱变动。 */
function settleRiverWorksLanding(context: CellSettlementContext) {
  const cell = context.cell as DeepReadonly<ModuleCell>;
  const player = context.state.players.find((candidate) => candidate.id === context.playerId);
  if (!player || player.position !== cell.id || !isRiverWorksCellPayload(cell.payload)) {
    return context.applyCore();
  }
  const tideState = readTideState(context.state);
  const actions = tideChoiceActions(context.state, tideState, player);
  const state = withTideState(
    { ...context.state, turnPhase: 'managing' },
    tideState,
    [
      ...context.state.publicRuleState.pendingActions.filter(
        (action) => action.playerId !== context.playerId,
      ),
      ...actions,
    ],
  );
  return {
    state,
    events: [...context.events, event('river_works_visited', {
      playerId: context.playerId,
      cellId: cell.id,
      level: tideState.level,
    })],
    newDebt: state.debt,
  };
}

function isOwnAction(action: PendingModuleAction): boolean {
  return action.module.id === RIVER_TIDE_MODULE_REF.id
    && action.module.version === RIVER_TIDE_MODULE_REF.version;
}

function withoutPlayerTideActions(state: GameState, playerId: string): GameState {
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

function handleTideChoice(context: IntentExecutionContext): ApplyResult {
  const { state, playerId, intent } = context;
  if (state.turnPhase !== 'managing') return { ok: false, code: 'WRONG_PHASE' };
  const pending = matchingPendingAction(state, playerId, intent);
  if (pending === undefined || !isRecord(pending.payload)) return { ok: false, code: 'ILLEGAL_INTENT' };
  const cellId = pending.payload.cellId;
  const kind = pending.payload.kind;
  if (!Number.isSafeInteger(cellId) || typeof kind !== 'string') return { ok: false, code: 'ILLEGAL_INTENT' };

  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player || player.bankrupt || player.position !== cellId) return { ok: false, code: 'ILLEGAL_INTENT' };

  const base = withoutPlayerTideActions(state, playerId);
  const tideState = readTideState(state);
  const finish = (nextState: GameState, events: GameEvent[]): ApplyResult => ({
    ok: true,
    state: { ...nextState, turnPhase: 'managing', recentLog: [...state.recentLog, ...events].slice(-200) },
    events,
  });

  if (kind === KIND_SKIP) {
    return finish(base, [event('river_works_declined', { playerId, cellId, level: tideState.level })]);
  }
  if (kind !== KIND_DIKE) return { ok: false, code: 'ILLEGAL_INTENT' };
  if (player.cash < DIKE_COST) return { ok: false, code: 'INSUFFICIENT_FUNDS' };

  const level = Math.max(TIDE_MIN, tideState.level - DIKE_REDUCTION);
  const events: GameEvent[] = [
    event('river_dike_built', {
      playerId,
      cellId,
      cost: DIKE_COST,
      previous: tideState.level,
      level,
    }),
    { type: 'bank_paid', playerId, amount: DIKE_COST },
  ];
  const next = withTideState(
    {
      ...base,
      players: state.players.map((candidate) => (
        candidate.id === playerId ? { ...candidate, cash: candidate.cash - DIKE_COST } : candidate
      )),
    },
    { level },
  );
  return finish(next, events);
}

/**
 * 回合边界：水位随机涨落。只改水位，不生成任何待选动作。
 * 这是**所有**模块里唯一会影响「别人收租」的落回合结算 —— 因此它必须在这里（postTransition），
 * 不能在某个落点结算里做，否则同一回合内先掷骰的人与后掷骰的人会看到不同水位。
 */
function settleTideTurnBoundary(state: GameState): { state: GameState; events: GameEvent[] } {
  const current = readTideState(state);
  const picked = pickRandomIndex(state, TIDE_DELTAS.length);
  if (picked === null) return { state: withTideState(state, current), events: [] };
  const nextLevel = clampLevel(current.level + TIDE_DELTAS[picked.index]!);
  const next = withTideState({ ...state, seed: picked.seed }, { level: nextLevel });
  if (nextLevel === current.level) return { state: next, events: [] };
  return {
    state: next,
    events: [event('river_tide_changed', {
      previous: current.level,
      level: nextLevel,
      delta: nextLevel - current.level,
      multiplier: rentMultiplierFor(nextLevel),
    })],
  };
}

/** 只做清理，不重新生成选项。 */
function synchronizeTideState(state: GameState): GameState {
  const tideState = readTideState(state);
  const kept = state.publicRuleState.pendingActions.filter((action) => (
    !isOwnAction(action) || isValidTideChoice(state, action)
  ));
  return withTideState(state, tideState, kept);
}

function isValidTideChoice(state: GameState, action: PendingModuleAction): boolean {
  if (action.playerId !== state.currentPlayerId) return false;
  if (action.requiredPhase !== state.turnPhase || state.debt !== null) return false;
  if (!isRecord(action.payload) || !Number.isSafeInteger(action.payload.cellId)) return false;
  const player = state.players.find((candidate) => candidate.id === action.playerId);
  if (!player || player.bankrupt) return false;
  return player.position === action.payload.cellId && isRiverWorksCellId(state, player.position);
}

/** 全场共享水位对过路费的倍率（本仓第一个 positiveRentHook 实现）。 */
function applyTideRent(context: PositiveRentContext): PositiveRentResult {
  const level = readTideState(context.state).level;
  const multiplier = rentMultiplierFor(level);
  if (multiplier === 1) return { state: context.state, events: context.events, amount: context.amount };
  const amount = Math.max(0, Math.round(context.amount * multiplier));
  return {
    state: context.state,
    events: [...context.events, event('river_tide_rent', {
      payerId: context.payerId,
      ownerId: context.ownerId,
      cellId: context.cellId,
      level,
      multiplier,
      base: context.amount,
      amount,
    })],
    amount,
  };
}

/** 机器人/托管：水位偏高且钱够就修堤（自己掏钱、全场受益，但高水位时地主本来就该治河）。 */
function chooseBotTideChoice(
  state: GameState,
  playerId: string,
): { type: 'module'; module: RuleModuleRef; action: string; payload: JsonValue } | undefined {
  const options = state.publicRuleState.pendingActions.filter(
    (action) => action.playerId === playerId && isOwnAction(action),
  );
  if (options.length === 0) return undefined;
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) return undefined;
  const byKind = (kind: string): PendingModuleAction | undefined => options.find(
    (action) => isRecord(action.payload) && action.payload.kind === kind,
  );
  const toIntent = (action: PendingModuleAction | undefined) => (action === undefined ? undefined : {
    type: 'module' as const,
    module: action.module,
    action: action.action,
    payload: action.payload,
  });
  const level = readTideState(state).level;
  if (level >= BOT_DIKE_LEVEL && player.cash >= DIKE_COST + BOT_DIKE_RESERVE) {
    const dike = toIntent(byKind(KIND_DIKE));
    if (dike !== undefined) return dike;
  }
  return toIntent(byKind(KIND_SKIP) ?? byKind(KIND_DIKE));
}

/** hydrate 用的严格校验：水位必须是 [TIDE_MIN, TIDE_MAX] 内的整数。 */
export function validateRiverTidePublicModuleState(
  value: unknown,
  players: readonly DeepReadonly<PlayerState>[],
): value is RiverTidePublicModuleState {
  void players;
  if (!isRecord(value) || Object.keys(value).length !== 1) return false;
  if (typeof value.level !== 'number' || !Number.isSafeInteger(value.level)) return false;
  return value.level >= TIDE_MIN && value.level <= TIDE_MAX;
}

const riverTideRuleModuleInput: RuleModuleDefinition = {
  ref: RIVER_TIDE_MODULE_REF,
  cellHandlers: [{
    type: 'module',
    cellType: 'river-works',
    handle: settleRiverWorksLanding,
  }],
  effectHandlers: [],
  intentHandlers: [{
    type: 'module',
    action: 'river-works-choice',
    handle: handleTideChoice,
  }],
  botStrategyHook: {
    decide: (context) => {
      const decided = chooseBotTideChoice(context.state, context.playerId);
      return decided ?? context.currentDecision;
    },
  },
  positiveRentHook: {
    apply: applyTideRent,
  },
  postTransitionHook: {
    apply: (context) => {
      if (!context.result.ok) return context.result;
      const synced = synchronizeTideState(context.result.state);
      if (!crossedTurnBoundary(context.previousState, synced)) {
        return { ...context.result, state: synced };
      }
      const settled = settleTideTurnBoundary(synced);
      const resynced = synchronizeTideState(settled.state);
      return {
        ok: true,
        state: { ...resynced, recentLog: [...resynced.recentLog, ...settled.events].slice(-200) },
        events: [...context.result.events, ...settled.events],
      };
    },
  },
};

export const riverTideRuleModuleDefinition = riverTideRuleModuleInput;
