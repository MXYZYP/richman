// 规则模块 `rail-hub@1`：高铁枢纽（中国之旅）
//
// 机制（既有模块里唯一的「负面状态解除 + 传送」）：
//   · 地图上的 `rail-hub` 模块格叫「枢纽」。落到枢纽可以**候车休息**：
//       - 若身上还背着「暂停 N 回合」（skip_turn 效果 / 机场支线拖延等），一次性全部清空；
//       - 若身上本来就干净，则领 300 元候车补贴。
//     这是全仓唯一能主动消除 skipTurns 的机制 —— 在此之前，被 skip_turn 打中只能硬扛。
//   · 也可以**换乘**：付 500 元直达下一个枢纽（跳跃，不结算落点、不领过起点工资）。
//     与长江渡轮同构，但方向只有一个（高铁不回头），并且是「跳跃」而非「坐船」——
//     落点选择权 + 状态解除权合在同一格上，玩家要自己权衡「清停赛」与「抢位子」哪个更值。
//   · **一回合只换乘一次**：换乘抵达的枢纽不再结算落点。见 yangtzeFerryModule 的同款说明。
//
// 本模块不写任何公共状态（枢纽不记忆任何东西），
// 因此 `publicRuleState.modules` 里出现本模块的键即视为损坏存档。
import type { DeepReadonly, JsonValue, ModuleCell, RuleModuleRef } from '@richman/board-data';
import type { ApplyResult, GameEvent, GameState, PendingModuleAction, PlayerState } from './types';
import type { CellSettlementContext, IntentExecutionContext, RuleModuleDefinition } from './moduleRegistry';
import { finishCashGoalIfReached } from './moduleToolkit';
import { moduleEventFor } from './moduleSupport';

export const RAIL_HUB_MODULE_REF = Object.freeze({ id: 'rail-hub', version: 1 }) satisfies RuleModuleRef;
export const RAIL_HUB_MODULE_KEY = 'rail-hub@1';

/** 换乘车票。 */
const TRANSFER_FARE = 500;
/** 候车补贴（身上没有停赛时领取）。 */
const WAIT_BONUS = 300;
/** 机器人愿意换乘前保留的现金。 */
const BOT_TRANSFER_RESERVE = 3000;

const KIND_WAIT = 'wait';
const KIND_TRANSFER = 'transfer';
const KIND_SKIP = 'skip';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRailHubCell(cell: DeepReadonly<ModuleCell> | undefined): cell is DeepReadonly<ModuleCell> {
  return cell?.type === 'module'
    && cell.module.id === RAIL_HUB_MODULE_REF.id
    && cell.module.version === RAIL_HUB_MODULE_REF.version
    && cell.cellType === 'rail-hub';
}

/** 棋盘上全部枢纽格（按数组顺序 = 线路顺序）。 */
export function railHubCells(board: { readonly cells: readonly unknown[] }): DeepReadonly<ModuleCell>[] {
  const cells: DeepReadonly<ModuleCell>[] = [];
  for (const candidate of board.cells) {
    const cell = candidate as DeepReadonly<ModuleCell>;
    if (isRailHubCell(cell)) cells.push(cell);
  }
  return cells;
}

/** 枢纽格 payload 必须为空对象（票价与补贴都是模块常量）。 */
export function isRailHubCellPayload(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

/** 沿线路取下一个枢纽（只有一个枢纽时返回 undefined）。 */
function railHubTarget(state: GameState, cellId: number): number | undefined {
  const chain = railHubCells(state.board).map((cell) => cell.id);
  if (chain.length < 2) return undefined;
  const index = chain.indexOf(cellId);
  if (index < 0) return undefined;
  return chain[(index + 1) % chain.length];
}

function isRailHubCellId(state: GameState, cellId: number): boolean {
  return railHubCells(state.board).some((cell) => cell.id === cellId);
}

function event(eventType: string, payload: JsonValue): GameEvent {
  return moduleEventFor(RAIL_HUB_MODULE_REF, eventType, payload);
}

function railOptionId(state: GameState, playerId: string, cellId: number, kind: string): string {
  return `${RAIL_HUB_MODULE_KEY}:rail-choice:${playerId}:${state.turn}:${cellId}:${kind}`;
}

function railChoiceAction(
  state: GameState,
  playerId: string,
  cellId: number,
  kind: string,
  label: string,
): PendingModuleAction {
  const optionId = railOptionId(state, playerId, cellId, kind);
  return {
    optionId,
    module: RAIL_HUB_MODULE_REF,
    playerId,
    requiredPhase: 'managing',
    label,
    action: 'rail-choice',
    payload: { optionId, cellId, kind },
  };
}

function railChoiceActions(state: GameState, player: PlayerState): PendingModuleAction[] {
  if (!isRailHubCellId(state, player.position)) return [];
  const actions: PendingModuleAction[] = [
    player.skipTurns > 0
      ? railChoiceAction(
        state,
        player.id,
        player.position,
        KIND_WAIT,
        `候车休息（清空 ${player.skipTurns} 回合停赛）`,
      )
      : railChoiceAction(
        state,
        player.id,
        player.position,
        KIND_WAIT,
        `候车补贴（+${WAIT_BONUS} 元）`,
      ),
  ];
  const target = railHubTarget(state, player.position);
  if (target !== undefined && player.cash >= TRANSFER_FARE) {
    actions.push(railChoiceAction(
      state,
      player.id,
      player.position,
      KIND_TRANSFER,
      `换乘（付 ${TRANSFER_FARE} 元，直达下一枢纽）`,
    ));
  }
  actions.push(railChoiceAction(state, player.id, player.position, KIND_SKIP, '不换乘'));
  return actions;
}

/** 落点结算：只摆出选项，不产生任何金钱变动。 */
function settleRailHubLanding(context: CellSettlementContext) {
  const cell = context.cell as DeepReadonly<ModuleCell>;
  const player = context.state.players.find((candidate) => candidate.id === context.playerId);
  if (!player || player.position !== cell.id || !isRailHubCellPayload(cell.payload)) {
    return context.applyCore();
  }
  const actions = railChoiceActions(context.state, player);
  const state: GameState = {
    ...context.state,
    turnPhase: 'managing',
    publicRuleState: {
      ...context.state.publicRuleState,
      pendingActions: [
        ...context.state.publicRuleState.pendingActions.filter(
          (action) => action.playerId !== context.playerId,
        ),
        ...actions,
      ],
    },
  };
  return {
    state,
    events: [...context.events, event('rail_visited', { playerId: context.playerId, cellId: cell.id })],
    newDebt: state.debt,
  };
}

function isOwnAction(action: PendingModuleAction): boolean {
  return action.module.id === RAIL_HUB_MODULE_REF.id
    && action.module.version === RAIL_HUB_MODULE_REF.version;
}

function withoutPlayerRailActions(state: GameState, playerId: string): GameState {
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

function handleRailChoice(context: IntentExecutionContext): ApplyResult {
  const { state, playerId, intent } = context;
  if (state.turnPhase !== 'managing') return { ok: false, code: 'WRONG_PHASE' };
  const pending = matchingPendingAction(state, playerId, intent);
  if (pending === undefined || !isRecord(pending.payload)) return { ok: false, code: 'ILLEGAL_INTENT' };
  const cellId = pending.payload.cellId;
  const kind = pending.payload.kind;
  if (!Number.isSafeInteger(cellId) || typeof kind !== 'string') return { ok: false, code: 'ILLEGAL_INTENT' };

  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player || player.bankrupt || player.position !== cellId) return { ok: false, code: 'ILLEGAL_INTENT' };

  const base = withoutPlayerRailActions(state, playerId);
  const finish = (nextState: GameState, events: GameEvent[]): ApplyResult => ({
    ok: true,
    state: { ...nextState, turnPhase: 'managing', recentLog: [...state.recentLog, ...events].slice(-200) },
    events,
  });

  if (kind === KIND_SKIP) {
    return finish(base, [event('rail_declined', { playerId, cellId })]);
  }

  if (kind === KIND_WAIT) {
    const clearedTurns = player.skipTurns;
    const bonus = clearedTurns > 0 ? 0 : WAIT_BONUS;
    const events: GameEvent[] = [event('rail_waited', { playerId, cellId, clearedTurns, bonus })];
    if (bonus > 0) events.push({ type: 'bank_received', playerId, amount: bonus });
    const next: GameState = {
      ...base,
      players: state.players.map((candidate) => (
        candidate.id === playerId
          ? { ...candidate, skipTurns: 0, cash: candidate.cash + bonus }
          : candidate
      )),
    };
    const win = bonus > 0 ? finishCashGoalIfReached(next, events) : null;
    return finish(win?.state ?? next, win?.events ?? events);
  }

  if (kind !== KIND_TRANSFER) return { ok: false, code: 'ILLEGAL_INTENT' };
  if (player.cash < TRANSFER_FARE) return { ok: false, code: 'INSUFFICIENT_FUNDS' };
  const target = railHubTarget(state, cellId);
  if (target === undefined) return { ok: false, code: 'ILLEGAL_INTENT' };

  const events: GameEvent[] = [
    event('rail_transferred', { playerId, fromCellId: cellId, toCellId: target, fare: TRANSFER_FARE }),
    // 车费进「铁路」这个非玩家账户，账面上等同付给银行：必须发 bank_paid，
    // 否则现金守恒（sum(cash) + bankBalance）会凭空少 500（simulate.ts 的不变量会红）。
    { type: 'bank_paid', playerId, amount: TRANSFER_FARE },
    // 换乘是「坐高铁」不是「走路」：不领过起点工资，路径只有终点一格（客户端按跳跃播放）。
    { type: 'token_moved', playerId, path: [target] },
  ];
  const next: GameState = {
    ...base,
    players: state.players.map((candidate) => (
      candidate.id === playerId
        ? { ...candidate, cash: candidate.cash - TRANSFER_FARE, position: target }
        : candidate
    )),
  };
  return finish(next, events);
}

/** 待选动作是否仍然有效（当前玩家、同一阶段、仍站在枢纽格上、无债务）。 */
function isValidRailChoice(state: GameState, action: PendingModuleAction): boolean {
  if (action.playerId !== state.currentPlayerId) return false;
  if (action.requiredPhase !== state.turnPhase || state.debt !== null) return false;
  if (!isRecord(action.payload) || !Number.isSafeInteger(action.payload.cellId)) return false;
  const player = state.players.find((candidate) => candidate.id === action.playerId);
  if (!player || player.bankrupt) return false;
  return player.position === action.payload.cellId && isRailHubCellId(state, player.position);
}

/**
 * 只做清理，不重新生成选项。
 *
 * 本模块没有任何公共状态，但**仍然必须有这个 hook**：投降与托管跳过这两条路径会在
 * **不消费待选动作**的情况下推进回合（applyIntent 对 surrender 放行、skipCurrentTurn 直接换人），
 * 残留的 `managing` 选项会让下一位玩家无论掷骰、买地还是结束回合都拿到 WRONG_PHASE ——
 * 表现为「零活跃计时器、零服务端错误」的整局静默冻结。
 */
function synchronizeRailActions(state: GameState): GameState {
  const kept = state.publicRuleState.pendingActions.filter((action) => (
    !isOwnAction(action) || isValidRailChoice(state, action)
  ));
  if (kept.length === state.publicRuleState.pendingActions.length) return state;
  return { ...state, publicRuleState: { ...state.publicRuleState, pendingActions: kept } };
}

/** 机器人/托管：身上有停赛先休息；否则留着钱不换乘。 */
function chooseBotRailChoice(
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
  if (player.skipTurns > 0) {
    const wait = toIntent(byKind(KIND_WAIT));
    if (wait !== undefined) return wait;
  }
  if (player.cash >= TRANSFER_FARE + BOT_TRANSFER_RESERVE) {
    const transfer = toIntent(byKind(KIND_TRANSFER));
    if (transfer !== undefined) return transfer;
  }
  return toIntent(byKind(KIND_WAIT) ?? byKind(KIND_SKIP));
}

const railHubRuleModuleInput: RuleModuleDefinition = {
  ref: RAIL_HUB_MODULE_REF,
  cellHandlers: [{
    type: 'module',
    cellType: 'rail-hub',
    handle: settleRailHubLanding,
  }],
  effectHandlers: [],
  intentHandlers: [{
    type: 'module',
    action: 'rail-choice',
    handle: handleRailChoice,
  }],
  botStrategyHook: {
    decide: (context) => {
      const decided = chooseBotRailChoice(context.state, context.playerId);
      return decided ?? context.currentDecision;
    },
  },
  postTransitionHook: {
    apply: (context) => (context.result.ok
      ? { ...context.result, state: synchronizeRailActions(context.result.state) }
      : context.result),
  },
};

export const railHubRuleModuleDefinition = railHubRuleModuleInput;
