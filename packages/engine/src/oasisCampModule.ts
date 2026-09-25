// 规则模块 `oasis-camp@1`：绿洲营地（新疆之旅）
//
// 机制（既有模块里唯一的「经过即触发」）：
//   · 地图上的 `oasis` 模块格叫「绿洲」。落到绿洲可以**扎营**（600 元）——营地对每人仅一处，
//     在原处再扎营等于迁移（旧营地随之作废）。
//   · 扎营之后，**每次经过自己的营地（含停留）都能领 500 元补给**。这是全仓唯一奖励
//     「路径」而不是「落点」的机制：core 的所有收益都发生在落脚那一格，
//     而营地让玩家开始在意自己「会走过哪里」。
//   · 撤营可退回 300（半价），给不想被营地锚定路线的玩家一个退出通道。
//
// 为什么放在 postTransitionHook：经过即触发不属于任何一次落点结算（落点是别的格），
// 只能在整次转移结束后回看本次掷骰走过的路径。路径取 `firstMovedPath` ——
// 一次转移里可能有多条 token_moved（卡牌位移会追加），只有第一条是掷骰走出来的那条。
import type { DeepReadonly, JsonValue, ModuleCell, RuleModuleRef } from '@richman/board-data';
import type { ApplyResult, GameEvent, GameState, PendingModuleAction, PlayerState } from './types';
import type { CellSettlementContext, IntentExecutionContext, RuleModuleDefinition } from './moduleRegistry';
import { finishCashGoalIfReached } from './moduleToolkit';
import {
  moduleEventFor,
  passedThroughCell,
  readRawModuleState,
  withRawModuleState,
} from './moduleSupport';

export const OASIS_CAMP_MODULE_REF = Object.freeze({ id: 'oasis-camp', version: 1 }) satisfies RuleModuleRef;
export const OASIS_CAMP_MODULE_KEY = 'oasis-camp@1';

/** 扎营费用。 */
const CAMP_COST = 600;
/** 每次经过自己的营地领到的补给。 */
const CAMP_BONUS = 500;
/** 撤营退回的金额。 */
const CAMP_REFUND = 300;
/** 机器人扎营前保留的现金安全垫。 */
const BOT_CAMP_RESERVE = 1800;

const KIND_CAMP = 'camp';
const KIND_REFUND = 'refund';
const KIND_SKIP = 'skip';

export interface OasisCampPublicModuleState {
  /** playerId → 该玩家营地所在的绿洲格 id（每人最多一处）。 */
  readonly campByPlayerId: Readonly<Record<string, number>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isOasisCell(cell: DeepReadonly<ModuleCell> | undefined): cell is DeepReadonly<ModuleCell> {
  return cell?.type === 'module'
    && cell.module.id === OASIS_CAMP_MODULE_REF.id
    && cell.module.version === OASIS_CAMP_MODULE_REF.version
    && cell.cellType === 'oasis';
}

/** 棋盘上全部绿洲格（按数组顺序）。 */
export function oasisCells(board: { readonly cells: readonly unknown[] }): DeepReadonly<ModuleCell>[] {
  const cells: DeepReadonly<ModuleCell>[] = [];
  for (const candidate of board.cells) {
    const cell = candidate as DeepReadonly<ModuleCell>;
    if (isOasisCell(cell)) cells.push(cell);
  }
  return cells;
}

/** 绿洲格 payload 必须为空对象（费用/补给/退还都是模块常量）。 */
export function isOasisCellPayload(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

function emptyOasisState(): OasisCampPublicModuleState {
  return { campByPlayerId: {} };
}

function readOasisState(state: GameState): OasisCampPublicModuleState {
  const value = readRawModuleState(state, OASIS_CAMP_MODULE_KEY);
  if (!isRecord(value) || !isRecord(value.campByPlayerId)) return emptyOasisState();
  const campByPlayerId: Record<string, number> = {};
  for (const [playerId, cellId] of Object.entries(value.campByPlayerId)) {
    if (typeof cellId === 'number' && Number.isSafeInteger(cellId) && cellId >= 0) {
      campByPlayerId[playerId] = cellId;
    }
  }
  return { campByPlayerId };
}

function hasOasisState(value: OasisCampPublicModuleState): boolean {
  return Object.keys(value.campByPlayerId).length > 0;
}

function withOasisState(
  state: GameState,
  oasisState: OasisCampPublicModuleState,
  pendingActions: readonly PendingModuleAction[] = state.publicRuleState.pendingActions,
): GameState {
  return withRawModuleState(
    state,
    OASIS_CAMP_MODULE_KEY,
    hasOasisState(oasisState) ? (oasisState as unknown as JsonValue) : null,
    pendingActions,
  );
}

/** 丢弃失效营地：破产/已离场的玩家营地作废；营地必须落在真实绿洲格上。 */
function cleanOasisState(state: GameState): OasisCampPublicModuleState {
  const current = readOasisState(state);
  const alive = new Set(state.players.filter((player) => !player.bankrupt).map((player) => player.id));
  const oasisIds = new Set(oasisCells(state.board).map((cell) => cell.id));
  const campByPlayerId: Record<string, number> = {};
  for (const [playerId, cellId] of Object.entries(current.campByPlayerId)) {
    if (alive.has(playerId) && oasisIds.has(cellId)) campByPlayerId[playerId] = cellId;
  }
  return { campByPlayerId };
}

function isOasisCellId(state: GameState, cellId: number): boolean {
  return oasisCells(state.board).some((cell) => cell.id === cellId);
}

function event(eventType: string, payload: JsonValue): GameEvent {
  return moduleEventFor(OASIS_CAMP_MODULE_REF, eventType, payload);
}

function oasisOptionId(state: GameState, playerId: string, cellId: number, kind: string): string {
  return `${OASIS_CAMP_MODULE_KEY}:oasis-choice:${playerId}:${state.turn}:${cellId}:${kind}`;
}

function oasisChoiceAction(
  state: GameState,
  playerId: string,
  cellId: number,
  kind: string,
  label: string,
): PendingModuleAction {
  const optionId = oasisOptionId(state, playerId, cellId, kind);
  return {
    optionId,
    module: OASIS_CAMP_MODULE_REF,
    playerId,
    requiredPhase: 'managing',
    label,
    action: 'oasis-choice',
    payload: { optionId, cellId, kind },
  };
}

function oasisChoiceActions(
  state: GameState,
  oasisState: OasisCampPublicModuleState,
  player: PlayerState,
): PendingModuleAction[] {
  if (!isOasisCellId(state, player.position)) return [];
  const campCellId = oasisState.campByPlayerId[player.id];
  const actions: PendingModuleAction[] = [];
  if (campCellId === player.position) {
    actions.push(oasisChoiceAction(
      state,
      player.id,
      player.position,
      KIND_REFUND,
      `撤营（退回 ${CAMP_REFUND} 元）`,
    ));
  } else if (player.cash >= CAMP_COST) {
    actions.push(oasisChoiceAction(
      state,
      player.id,
      player.position,
      KIND_CAMP,
      campCellId === undefined
        ? `扎营（${CAMP_COST} 元，此后经过可领 ${CAMP_BONUS}）`
        : `迁营到此（${CAMP_COST} 元，原营地作废）`,
    ));
  }
  actions.push(oasisChoiceAction(state, player.id, player.position, KIND_SKIP, '不扎营'));
  return actions;
}

/** 落点结算：只摆出选项，不产生任何金钱变动（经过奖励由 postTransitionHook 统一发放）。 */
function settleOasisLanding(context: CellSettlementContext) {
  const cell = context.cell as DeepReadonly<ModuleCell>;
  const player = context.state.players.find((candidate) => candidate.id === context.playerId);
  if (!player || player.position !== cell.id || !isOasisCellPayload(cell.payload)) {
    return context.applyCore();
  }
  const oasisState = cleanOasisState(context.state);
  const actions = oasisChoiceActions(context.state, oasisState, player);
  const state = withOasisState(
    { ...context.state, turnPhase: 'managing' },
    oasisState,
    [
      ...context.state.publicRuleState.pendingActions.filter(
        (action) => action.playerId !== context.playerId,
      ),
      ...actions,
    ],
  );
  return {
    state,
    events: [...context.events, event('oasis_visited', { playerId: context.playerId, cellId: cell.id })],
    newDebt: state.debt,
  };
}

function isOwnAction(action: PendingModuleAction): boolean {
  return action.module.id === OASIS_CAMP_MODULE_REF.id
    && action.module.version === OASIS_CAMP_MODULE_REF.version;
}

function withoutPlayerOasisActions(state: GameState, playerId: string): GameState {
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

function handleOasisChoice(context: IntentExecutionContext): ApplyResult {
  const { state, playerId, intent } = context;
  if (state.turnPhase !== 'managing') return { ok: false, code: 'WRONG_PHASE' };
  const pending = matchingPendingAction(state, playerId, intent);
  if (pending === undefined || !isRecord(pending.payload)) return { ok: false, code: 'ILLEGAL_INTENT' };
  const cellId = pending.payload.cellId;
  const kind = pending.payload.kind;
  if (!Number.isSafeInteger(cellId) || typeof kind !== 'string') return { ok: false, code: 'ILLEGAL_INTENT' };

  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player || player.bankrupt || player.position !== cellId) return { ok: false, code: 'ILLEGAL_INTENT' };

  const base = withoutPlayerOasisActions(state, playerId);
  const oasisState = cleanOasisState(state);
  const finish = (nextState: GameState, events: GameEvent[]): ApplyResult => ({
    ok: true,
    state: { ...nextState, turnPhase: 'managing', recentLog: [...state.recentLog, ...events].slice(-200) },
    events,
  });

  if (kind === KIND_SKIP) {
    return finish(base, [event('oasis_declined', { playerId, cellId })]);
  }

  if (kind === KIND_CAMP) {
    if (player.cash < CAMP_COST) return { ok: false, code: 'INSUFFICIENT_FUNDS' };
    if (oasisState.campByPlayerId[playerId] === cellId) return { ok: false, code: 'ILLEGAL_INTENT' };
    const events: GameEvent[] = [event('oasis_camped', {
      playerId,
      cellId,
      cost: CAMP_COST,
      previousCellId: oasisState.campByPlayerId[playerId] ?? null,
    }),
    // 扎营费离开牌桌（对照撤营/路过奖励已发的 bank_received）：不发这条会破坏现金守恒。
    { type: 'bank_paid', playerId, amount: CAMP_COST }];
    const next = withOasisState(
      {
        ...base,
        players: state.players.map((candidate) => (
          candidate.id === playerId ? { ...candidate, cash: candidate.cash - CAMP_COST } : candidate
        )),
      },
      {
        campByPlayerId: { ...oasisState.campByPlayerId, [playerId]: cellId },
      },
    );
    return finish(next, events);
  }

  if (kind !== KIND_REFUND) return { ok: false, code: 'ILLEGAL_INTENT' };
  if (oasisState.campByPlayerId[playerId] !== cellId) return { ok: false, code: 'ILLEGAL_INTENT' };
  const campByPlayerId = { ...oasisState.campByPlayerId };
  delete campByPlayerId[playerId];
  const events: GameEvent[] = [
    event('oasis_abandoned', { playerId, cellId, refund: CAMP_REFUND }),
    { type: 'bank_received', playerId, amount: CAMP_REFUND },
  ];
  const next = withOasisState(
    {
      ...base,
      players: state.players.map((candidate) => (
        candidate.id === playerId ? { ...candidate, cash: candidate.cash + CAMP_REFUND } : candidate
      )),
    },
    { campByPlayerId },
  );
  const win = finishCashGoalIfReached(next, events);
  return finish(win?.state ?? next, win?.events ?? events);
}

/**
 * 经过即触发：本次转移中若行动者走过自己的营地，发 500 补给。
 *
 * 只在 `ok` 且未终局时执行，并且只看**第一条** token_moved（掷骰走出来的那条路径）——
 * 卡牌追加的位移不算，避免「营地 + 传送卡」被刷成双重收益。
 */
function settleOasisPassThrough(context: {
  readonly result: ApplyResult;
  readonly playerId: string;
}): ApplyResult {
  if (!context.result.ok) return context.result;
  const state = context.result.state;
  if (state.phase !== 'playing' || state.debt !== null) return context.result;

  const oasisState = cleanOasisState(state);
  const campCellId = oasisState.campByPlayerId[context.playerId];
  if (campCellId === undefined) return context.result;
  if (!passedThroughCell(context.result.events, context.playerId, campCellId)) return context.result;

  const events: GameEvent[] = [
    event('oasis_bonus', { playerId: context.playerId, cellId: campCellId, amount: CAMP_BONUS }),
    { type: 'bank_received', playerId: context.playerId, amount: CAMP_BONUS },
  ];
  const next = withOasisState(
    {
      ...state,
      players: state.players.map((candidate) => (
        candidate.id === context.playerId ? { ...candidate, cash: candidate.cash + CAMP_BONUS } : candidate
      )),
    },
    oasisState,
  );
  const win = finishCashGoalIfReached(next, events);
  const finalState = win?.state ?? next;
  const finalEvents = win?.events ?? events;
  return {
    ok: true,
    state: { ...finalState, recentLog: [...finalState.recentLog, ...finalEvents].slice(-200) },
    events: [...context.result.events, ...finalEvents],
  };
}

/** 只做清理，不重新生成选项。 */
function synchronizeOasisState(state: GameState): GameState {
  const oasisState = cleanOasisState(state);
  const kept = state.publicRuleState.pendingActions.filter((action) => (
    !isOwnAction(action) || isValidOasisChoice(state, action)
  ));
  return withOasisState(state, oasisState, kept);
}

function isValidOasisChoice(state: GameState, action: PendingModuleAction): boolean {
  if (action.playerId !== state.currentPlayerId) return false;
  if (action.requiredPhase !== state.turnPhase || state.debt !== null) return false;
  if (!isRecord(action.payload) || !Number.isSafeInteger(action.payload.cellId)) return false;
  const player = state.players.find((candidate) => candidate.id === action.playerId);
  if (!player || player.bankrupt) return false;
  return player.position === action.payload.cellId && isOasisCellId(state, player.position);
}

/** 机器人/托管：有余钱且尚未扎营时扎营，现金告急则撤营。 */
function chooseBotOasisChoice(
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
  const refund = toIntent(byKind(KIND_REFUND));
  if (refund !== undefined && player.cash < CAMP_COST) return refund;
  const camp = toIntent(byKind(KIND_CAMP));
  if (camp !== undefined && player.cash >= CAMP_COST + BOT_CAMP_RESERVE) return camp;
  return toIntent(byKind(KIND_SKIP) ?? byKind(KIND_REFUND) ?? byKind(KIND_CAMP));
}

/**
 * hydrate 用的严格校验：营地必须属于本局存活玩家，且必须落在该地图真实的绿洲格上。
 * 落点合法性必须校验：损坏存档里一个指向普通地产的营地会让玩家每次路过都白拿 500。
 */
export function validateOasisCampPublicModuleState(
  value: unknown,
  players: readonly DeepReadonly<PlayerState>[],
  board: { readonly cells: readonly unknown[] },
): value is OasisCampPublicModuleState {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isRecord(value.campByPlayerId)) return false;
  const alive = new Set(players.filter((player) => !player.bankrupt).map((player) => player.id));
  const oasisIds = new Set(oasisCells(board).map((cell) => cell.id));
  for (const [playerId, cellId] of Object.entries(value.campByPlayerId)) {
    if (!alive.has(playerId)) return false;
    if (typeof cellId !== 'number' || !Number.isSafeInteger(cellId)) return false;
    if (!oasisIds.has(cellId)) return false;
  }
  return true;
}

const oasisCampRuleModuleInput: RuleModuleDefinition = {
  ref: OASIS_CAMP_MODULE_REF,
  cellHandlers: [{
    type: 'module',
    cellType: 'oasis',
    handle: settleOasisLanding,
  }],
  effectHandlers: [],
  intentHandlers: [{
    type: 'module',
    action: 'oasis-choice',
    handle: handleOasisChoice,
  }],
  botStrategyHook: {
    decide: (context) => {
      const decided = chooseBotOasisChoice(context.state, context.playerId);
      return decided ?? context.currentDecision;
    },
  },
  postTransitionHook: {
    apply: (context) => settleOasisPassThrough({
      result: synchronizeOasisStateResult(context.result),
      playerId: context.playerId,
    }),
  },
};

/** 同步清理包一层，保持 hook 里两步（清理 → 经过奖励）读起来是顺序的。 */
function synchronizeOasisStateResult(result: ApplyResult): ApplyResult {
  if (!result.ok) return result;
  return { ...result, state: synchronizeOasisState(result.state) };
}

export const oasisCampRuleModuleDefinition = oasisCampRuleModuleInput;
