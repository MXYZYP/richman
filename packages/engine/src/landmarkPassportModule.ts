// 规则模块 `landmark-passport@1`：地标护照（世界经典之旅）
//
// 机制（既有模块里唯一的「收集式阶梯奖励」）：
//   · 地图上的 `landmark` 模块格叫「地标」。落到地标可以**盖一枚纪念章**（免费）。
//   · 每人每格只能盖一次（不可被夺走、也不怕别人先盖），集章数阶梯奖励：
//     第 1 枚 +1000、第 2 枚 +2000、第 3 枚 +3000 ……（即第 n 枚给 n × 1000）。
//   · 集满全部地标后，此后**每次经过起点**再领 1000「环球旅行家津贴」。
//   · 与「抢占式」机制（烽火台占据、地产购地）完全相反：护照是**人人可盖、互不冲突**的，
//     所以它奖励的是「跑得多」而不是「抢得快」——同一张图上两种节奏并存。
//     （本仓既有模块里的唯一非零和玩法。）
//
// 两条与既有模块一致的硬约束：三选项共用同一动作名 `passport-choice`（这里只有两个分支），
// 待选动作只在落点结算时生成一次；postTransitionHook 只做「过起点津贴 + 清理」。
import type { DeepReadonly, JsonValue, ModuleCell, RuleModuleRef } from '@richman/board-data';
import type { ApplyResult, GameEvent, GameState, PendingModuleAction, PlayerState } from './types';
import type { CellSettlementContext, IntentExecutionContext, RuleModuleDefinition } from './moduleRegistry';
import { finishCashGoalIfReached } from './moduleToolkit';
import { moduleEventFor, readRawModuleState, withRawModuleState } from './moduleSupport';

export const LANDMARK_PASSPORT_MODULE_REF = Object.freeze({ id: 'landmark-passport', version: 1 }) satisfies RuleModuleRef;
export const LANDMARK_PASSPORT_MODULE_KEY = 'landmark-passport@1';

/** 每枚纪念章的单价：第 n 枚奖励 n × 此值（阶梯递增）。 */
const STAMP_REWARD_UNIT = 1000;
/** 集满全部地标后，每次经过起点的津贴。 */
const LAP_BONUS = 1000;

const KIND_STAMP = 'stamp';
const KIND_SKIP = 'skip';

export interface LandmarkPassportPublicModuleState {
  /** playerId → 已盖章的地标格 id（升序、去重的不可变数组）。 */
  readonly stampsByPlayerId: Readonly<Record<string, readonly number[]>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isLandmarkCell(cell: DeepReadonly<ModuleCell> | undefined): cell is DeepReadonly<ModuleCell> {
  return cell?.type === 'module'
    && cell.module.id === LANDMARK_PASSPORT_MODULE_REF.id
    && cell.module.version === LANDMARK_PASSPORT_MODULE_REF.version
    && cell.cellType === 'landmark';
}

/** 棋盘上全部地标格（按数组顺序 = 盖章顺序无关，仅用于校验与总数）。 */
export function landmarkCells(board: { readonly cells: readonly unknown[] }): DeepReadonly<ModuleCell>[] {
  const cells: DeepReadonly<ModuleCell>[] = [];
  for (const candidate of board.cells) {
    const cell = candidate as DeepReadonly<ModuleCell>;
    if (isLandmarkCell(cell)) cells.push(cell);
  }
  return cells;
}

/** 地标格 payload 必须为空对象（奖励阶梯与津贴都是模块常量）。 */
export function isLandmarkCellPayload(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

function emptyPassportState(): LandmarkPassportPublicModuleState {
  return { stampsByPlayerId: {} };
}

function readStamps(value: unknown): readonly number[] {
  if (!Array.isArray(value)) return [];
  const stamps: number[] = [];
  for (const entry of value) {
    if (typeof entry === 'number' && Number.isSafeInteger(entry)) stamps.push(entry);
  }
  stamps.sort((left, right) => left - right);
  return stamps;
}

function readPassportState(state: GameState): LandmarkPassportPublicModuleState {
  const value = readRawModuleState(state, LANDMARK_PASSPORT_MODULE_KEY);
  if (!isRecord(value) || !isRecord(value.stampsByPlayerId)) return emptyPassportState();
  const stampsByPlayerId: Record<string, readonly number[]> = {};
  for (const [playerId, stamps] of Object.entries(value.stampsByPlayerId)) {
    const normalized = readStamps(stamps);
    if (normalized.length > 0) stampsByPlayerId[playerId] = normalized;
  }
  return { stampsByPlayerId };
}

function hasPassportState(value: LandmarkPassportPublicModuleState): boolean {
  return Object.keys(value.stampsByPlayerId).length > 0;
}

function withPassportState(
  state: GameState,
  passportState: LandmarkPassportPublicModuleState,
  pendingActions: readonly PendingModuleAction[] = state.publicRuleState.pendingActions,
): GameState {
  return withRawModuleState(
    state,
    LANDMARK_PASSPORT_MODULE_KEY,
    hasPassportState(passportState) ? (passportState as unknown as JsonValue) : null,
    pendingActions,
  );
}

/** 丢弃失效护照：破产/已离场的玩家记录作废；指向不存在地标的章一并剔除。 */
function cleanPassportState(state: GameState): LandmarkPassportPublicModuleState {
  const current = readPassportState(state);
  const alive = new Set(state.players.filter((player) => !player.bankrupt).map((player) => player.id));
  const landmarkIds = new Set(landmarkCells(state.board).map((cell) => cell.id));
  const stampsByPlayerId: Record<string, readonly number[]> = {};
  for (const [playerId, stamps] of Object.entries(current.stampsByPlayerId)) {
    if (!alive.has(playerId)) continue;
    const valid = stamps.filter((cellId) => landmarkIds.has(cellId));
    if (valid.length > 0) stampsByPlayerId[playerId] = valid;
  }
  return { stampsByPlayerId };
}

function isLandmarkCellId(state: GameState, cellId: number): boolean {
  return landmarkCells(state.board).some((cell) => cell.id === cellId);
}

function event(eventType: string, payload: JsonValue): GameEvent {
  return moduleEventFor(LANDMARK_PASSPORT_MODULE_REF, eventType, payload);
}

function passportOptionId(state: GameState, playerId: string, cellId: number, kind: string): string {
  return `${LANDMARK_PASSPORT_MODULE_KEY}:passport-choice:${playerId}:${state.turn}:${cellId}:${kind}`;
}

function passportChoiceAction(
  state: GameState,
  playerId: string,
  cellId: number,
  kind: string,
  label: string,
): PendingModuleAction {
  const optionId = passportOptionId(state, playerId, cellId, kind);
  return {
    optionId,
    module: LANDMARK_PASSPORT_MODULE_REF,
    playerId,
    requiredPhase: 'managing',
    label,
    action: 'passport-choice',
    payload: { optionId, cellId, kind },
  };
}

/**
 * 落点结算。已经盖过章的地标不再摆选项（直接交回 core）——
 * 否则玩家每次路过旧地标都要点一次「不盖章」，纯噪音。
 */
function settleLandmarkLanding(context: CellSettlementContext) {
  const cell = context.cell as DeepReadonly<ModuleCell>;
  const player = context.state.players.find((candidate) => candidate.id === context.playerId);
  if (!player || player.position !== cell.id || !isLandmarkCellPayload(cell.payload)) {
    return context.applyCore();
  }
  const passportState = cleanPassportState(context.state);
  const stamps = passportState.stampsByPlayerId[player.id] ?? [];
  if (stamps.includes(cell.id)) return context.applyCore();

  const nextCount = stamps.length + 1;
  const total = landmarkCells(context.state.board).length;
  const state: GameState = {
    ...context.state,
    turnPhase: 'managing',
    publicRuleState: {
      ...context.state.publicRuleState,
      pendingActions: [
        ...context.state.publicRuleState.pendingActions.filter(
          (action) => action.playerId !== context.playerId,
        ),
        passportChoiceAction(
          context.state,
          player.id,
          cell.id,
          KIND_STAMP,
          `盖纪念章（第 ${nextCount}/${total} 枚，得 ${nextCount * STAMP_REWARD_UNIT} 元）`,
        ),
        passportChoiceAction(context.state, player.id, cell.id, KIND_SKIP, '不盖章'),
      ],
    },
  };
  return {
    state,
    events: [...context.events, event('landmark_visited', { playerId: context.playerId, cellId: cell.id })],
    newDebt: state.debt,
  };
}

function isOwnAction(action: PendingModuleAction): boolean {
  return action.module.id === LANDMARK_PASSPORT_MODULE_REF.id
    && action.module.version === LANDMARK_PASSPORT_MODULE_REF.version;
}

function withoutPlayerPassportActions(state: GameState, playerId: string): GameState {
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

function handlePassportChoice(context: IntentExecutionContext): ApplyResult {
  const { state, playerId, intent } = context;
  if (state.turnPhase !== 'managing') return { ok: false, code: 'WRONG_PHASE' };
  const pending = matchingPendingAction(state, playerId, intent);
  if (pending === undefined || !isRecord(pending.payload)) return { ok: false, code: 'ILLEGAL_INTENT' };
  const cellId = pending.payload.cellId;
  const kind = pending.payload.kind;
  if (!Number.isSafeInteger(cellId) || typeof kind !== 'string') return { ok: false, code: 'ILLEGAL_INTENT' };

  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player || player.bankrupt || player.position !== cellId) return { ok: false, code: 'ILLEGAL_INTENT' };

  const base = withoutPlayerPassportActions(state, playerId);
  const passportState = cleanPassportState(state);
  const finish = (nextState: GameState, events: GameEvent[]): ApplyResult => ({
    ok: true,
    state: { ...nextState, turnPhase: 'managing', recentLog: [...state.recentLog, ...events].slice(-200) },
    events,
  });

  if (kind === KIND_SKIP) {
    return finish(base, [event('landmark_declined', { playerId, cellId })]);
  }
  if (kind !== KIND_STAMP) return { ok: false, code: 'ILLEGAL_INTENT' };

  const stamps = passportState.stampsByPlayerId[playerId] ?? [];
  if (stamps.includes(cellId)) return { ok: false, code: 'ILLEGAL_INTENT' };
  if (!isLandmarkCellId(state, cellId)) return { ok: false, code: 'ILLEGAL_INTENT' };

  const nextStamps = [...stamps, cellId].sort((left, right) => left - right);
  const total = landmarkCells(state.board).length;
  const reward = nextStamps.length * STAMP_REWARD_UNIT;
  const events: GameEvent[] = [
    event('landmark_stamped', {
      playerId,
      cellId,
      count: nextStamps.length,
      total,
      reward,
      completed: nextStamps.length >= total,
    }),
    { type: 'bank_received', playerId, amount: reward },
  ];
  const next = withPassportState(
    {
      ...base,
      players: state.players.map((candidate) => (
        candidate.id === playerId ? { ...candidate, cash: candidate.cash + reward } : candidate
      )),
    },
    { stampsByPlayerId: { ...passportState.stampsByPlayerId, [playerId]: nextStamps } },
  );
  const win = finishCashGoalIfReached(next, events);
  return finish(win?.state ?? next, win?.events ?? events);
}

/**
 * 集满后的「环球旅行家津贴」：本次转移中行动者领过过起点工资（salary_collected）才发。
 *
 * 为什么用 salary_collected 而不是自己回看路径：过起点这件事引擎已经在掷骰与两类移动效果里
 * 统一判定并发过事件了，再自己走一遍 walkPath 只会多出一条会与引擎漂移的第二真相。
 */
function settlePassportLapBonus(context: {
  readonly result: ApplyResult;
  readonly playerId: string;
}): ApplyResult {
  if (!context.result.ok) return context.result;
  const state = context.result.state;
  if (state.phase !== 'playing' || state.debt !== null) return context.result;
  if (!context.result.events.some((event) => (
    event.type === 'salary_collected' && event.playerId === context.playerId
  ))) return context.result;

  const passportState = cleanPassportState(state);
  const stamps = passportState.stampsByPlayerId[context.playerId] ?? [];
  const total = landmarkCells(state.board).length;
  if (total === 0 || stamps.length < total) return context.result;

  const events: GameEvent[] = [
    event('passport_lap_bonus', { playerId: context.playerId, amount: LAP_BONUS, stamps: stamps.length }),
    { type: 'bank_received', playerId: context.playerId, amount: LAP_BONUS },
  ];
  const next = withPassportState(
    {
      ...state,
      players: state.players.map((candidate) => (
        candidate.id === context.playerId ? { ...candidate, cash: candidate.cash + LAP_BONUS } : candidate
      )),
    },
    passportState,
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
function synchronizePassportState(state: GameState): GameState {
  const passportState = cleanPassportState(state);
  const kept = state.publicRuleState.pendingActions.filter((action) => (
    !isOwnAction(action) || isValidPassportChoice(state, action)
  ));
  return withPassportState(state, passportState, kept);
}

function isValidPassportChoice(state: GameState, action: PendingModuleAction): boolean {
  if (action.playerId !== state.currentPlayerId) return false;
  if (action.requiredPhase !== state.turnPhase || state.debt !== null) return false;
  if (!isRecord(action.payload) || !Number.isSafeInteger(action.payload.cellId)) return false;
  const player = state.players.find((candidate) => candidate.id === action.playerId);
  if (!player || player.bankrupt) return false;
  return player.position === action.payload.cellId && isLandmarkCellId(state, player.position);
}

/** 机器人/托管：盖章免费又只赚不亏，一律盖。 */
function chooseBotPassportChoice(
  state: GameState,
  playerId: string,
): { type: 'module'; module: RuleModuleRef; action: string; payload: JsonValue } | undefined {
  const options = state.publicRuleState.pendingActions.filter(
    (action) => action.playerId === playerId && isOwnAction(action),
  );
  if (options.length === 0) return undefined;
  const byKind = (kind: string): PendingModuleAction | undefined => options.find(
    (action) => isRecord(action.payload) && action.payload.kind === kind,
  );
  const action = byKind(KIND_STAMP) ?? byKind(KIND_SKIP);
  if (action === undefined) return undefined;
  return { type: 'module', module: action.module, action: action.action, payload: action.payload };
}

/**
 * hydrate 用的严格校验：章必须属于本局存活玩家、必须指向该地图真实的地标格、且严格递增去重。
 * 严格递增是刻意的：它同时挡住「重复盖章刷奖励」和「乱序数组导致同一存档有两种字节表示」。
 */
export function validateLandmarkPassportPublicModuleState(
  value: unknown,
  players: readonly DeepReadonly<PlayerState>[],
  board: { readonly cells: readonly unknown[] },
): value is LandmarkPassportPublicModuleState {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isRecord(value.stampsByPlayerId)) return false;
  const alive = new Set(players.filter((player) => !player.bankrupt).map((player) => player.id));
  const landmarkIds = new Set(landmarkCells(board).map((cell) => cell.id));
  for (const [playerId, stamps] of Object.entries(value.stampsByPlayerId)) {
    if (!alive.has(playerId)) return false;
    if (!Array.isArray(stamps) || stamps.length === 0) return false;
    if (stamps.length > landmarkIds.size) return false;
    let previous = -1;
    for (const cellId of stamps) {
      if (typeof cellId !== 'number' || !Number.isSafeInteger(cellId)) return false;
      if (!landmarkIds.has(cellId)) return false;
      if (cellId <= previous) return false;
      previous = cellId;
    }
  }
  return true;
}

const landmarkPassportRuleModuleInput: RuleModuleDefinition = {
  ref: LANDMARK_PASSPORT_MODULE_REF,
  cellHandlers: [{
    type: 'module',
    cellType: 'landmark',
    handle: settleLandmarkLanding,
  }],
  effectHandlers: [],
  intentHandlers: [{
    type: 'module',
    action: 'passport-choice',
    handle: handlePassportChoice,
  }],
  botStrategyHook: {
    decide: (context) => {
      const decided = chooseBotPassportChoice(context.state, context.playerId);
      return decided ?? context.currentDecision;
    },
  },
  postTransitionHook: {
    apply: (context) => settlePassportLapBonus({
      result: context.result.ok
        ? { ...context.result, state: synchronizePassportState(context.result.state) }
        : context.result,
      playerId: context.playerId,
    }),
  },
};

export const landmarkPassportRuleModuleDefinition = landmarkPassportRuleModuleInput;
