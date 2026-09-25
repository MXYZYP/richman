// 规则模块 `port-trade@1`：湾区口岸（珠江之旅）
//
// 机制（既有模块里唯一的「掷骰博弈」）：
//   · 地图上的 `port` 模块格叫「口岸」。落到口岸可以**押货下注**：押 600 元，
//     现场掷两颗骰子，点数之和 ≥ 8 则连本带利拿回 1500（净赚 900），否则押金没收。
//   · 期望值刻意做成近乎中性：胜率 15/36 ≈ 41.7%，EV = 0.4167×900 − 0.5833×600 ≈ +25 元。
//     **正期望但极低**，所以它不是一个"必点"的按钮而是一个真正的取舍：缺钱的人不该赌，
//     领先的人也不该赌 —— 单次 ±600 的波动足以改变排名，却改变不了终局。
//   · 掷骰用的是引擎自己的 `rollDice`，随机数状态继续写回 `state.seed`，
//     因此同 seed 全局可复现，联机双方看到同一组点数（与监狱的掷骰出狱同一套做法）。
//
// 本模块不写任何公共状态（下注是即时结算，无跨回合记忆），
// 因此 `publicRuleState.modules` 里出现本模块的键即视为损坏存档。
import type { DeepReadonly, JsonValue, ModuleCell, RuleModuleRef } from '@richman/board-data';
import type { ApplyResult, GameEvent, GameState, PendingModuleAction, PlayerState } from './types';
import type { CellSettlementContext, IntentExecutionContext, RuleModuleDefinition } from './moduleRegistry';
import { finishCashGoalIfReached } from './moduleToolkit';
import { moduleEventFor } from './moduleSupport';
import { rollDice } from './rng';

export const PORT_TRADE_MODULE_REF = Object.freeze({ id: 'port-trade', version: 1 }) satisfies RuleModuleRef;
export const PORT_TRADE_MODULE_KEY = 'port-trade@1';

/** 押金。 */
const STAKE = 600;
/** 两颗骰子之和达到此值即赢。 */
const WIN_THRESHOLD = 8;
/** 赢时从银行拿回的总额（含押金），净收益 = WIN_PAYOUT - STAKE。 */
const WIN_PAYOUT = 1500;
/** 机器人下注前保留的现金安全垫。 */
const BOT_STAKE_RESERVE = 800;

const KIND_STAKE = 'stake';
const KIND_SKIP = 'skip';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPortCell(cell: DeepReadonly<ModuleCell> | undefined): cell is DeepReadonly<ModuleCell> {
  return cell?.type === 'module'
    && cell.module.id === PORT_TRADE_MODULE_REF.id
    && cell.module.version === PORT_TRADE_MODULE_REF.version
    && cell.cellType === 'port';
}

/** 棋盘上全部口岸格（按数组顺序）。 */
export function portCells(board: { readonly cells: readonly unknown[] }): DeepReadonly<ModuleCell>[] {
  const cells: DeepReadonly<ModuleCell>[] = [];
  for (const candidate of board.cells) {
    const cell = candidate as DeepReadonly<ModuleCell>;
    if (isPortCell(cell)) cells.push(cell);
  }
  return cells;
}

/** 口岸格 payload 必须为空对象（押金与赔率都是模块常量）。 */
export function isPortCellPayload(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

function isPortCellId(state: GameState, cellId: number): boolean {
  return portCells(state.board).some((cell) => cell.id === cellId);
}

function event(eventType: string, payload: JsonValue): GameEvent {
  return moduleEventFor(PORT_TRADE_MODULE_REF, eventType, payload);
}

function portOptionId(state: GameState, playerId: string, cellId: number, kind: string): string {
  return `${PORT_TRADE_MODULE_KEY}:port-choice:${playerId}:${state.turn}:${cellId}:${kind}`;
}

function portChoiceAction(
  state: GameState,
  playerId: string,
  cellId: number,
  kind: string,
  label: string,
): PendingModuleAction {
  const optionId = portOptionId(state, playerId, cellId, kind);
  return {
    optionId,
    module: PORT_TRADE_MODULE_REF,
    playerId,
    requiredPhase: 'managing',
    label,
    action: 'port-choice',
    payload: { optionId, cellId, kind },
  };
}

function portChoiceActions(state: GameState, player: PlayerState): PendingModuleAction[] {
  if (!isPortCellId(state, player.position)) return [];
  const actions: PendingModuleAction[] = [];
  if (player.cash >= STAKE) {
    actions.push(portChoiceAction(
      state,
      player.id,
      player.position,
      KIND_STAKE,
      `押货下注（押 ${STAKE}，两骰 ≥ ${WIN_THRESHOLD} 得 ${WIN_PAYOUT}）`,
    ));
  }
  actions.push(portChoiceAction(state, player.id, player.position, KIND_SKIP, '不押货'));
  return actions;
}

/** 落点结算：只摆出选项，不产生任何金钱变动。 */
function settlePortLanding(context: CellSettlementContext) {
  const cell = context.cell as DeepReadonly<ModuleCell>;
  const player = context.state.players.find((candidate) => candidate.id === context.playerId);
  if (!player || player.position !== cell.id || !isPortCellPayload(cell.payload)) {
    return context.applyCore();
  }
  const actions = portChoiceActions(context.state, player);
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
    events: [...context.events, event('port_visited', { playerId: context.playerId, cellId: cell.id })],
    newDebt: state.debt,
  };
}

function isOwnAction(action: PendingModuleAction): boolean {
  return action.module.id === PORT_TRADE_MODULE_REF.id
    && action.module.version === PORT_TRADE_MODULE_REF.version;
}

function withoutPlayerPortActions(state: GameState, playerId: string): GameState {
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

function handlePortChoice(context: IntentExecutionContext): ApplyResult {
  const { state, playerId, intent } = context;
  if (state.turnPhase !== 'managing') return { ok: false, code: 'WRONG_PHASE' };
  const pending = matchingPendingAction(state, playerId, intent);
  if (pending === undefined || !isRecord(pending.payload)) return { ok: false, code: 'ILLEGAL_INTENT' };
  const cellId = pending.payload.cellId;
  const kind = pending.payload.kind;
  if (!Number.isSafeInteger(cellId) || typeof kind !== 'string') return { ok: false, code: 'ILLEGAL_INTENT' };

  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player || player.bankrupt || player.position !== cellId) return { ok: false, code: 'ILLEGAL_INTENT' };

  const base = withoutPlayerPortActions(state, playerId);
  const finish = (nextState: GameState, events: GameEvent[]): ApplyResult => ({
    ok: true,
    state: { ...nextState, turnPhase: 'managing', recentLog: [...state.recentLog, ...events].slice(-200) },
    events,
  });

  if (kind === KIND_SKIP) {
    return finish(base, [event('port_declined', { playerId, cellId })]);
  }
  if (kind !== KIND_STAKE) return { ok: false, code: 'ILLEGAL_INTENT' };
  if (player.cash < STAKE) return { ok: false, code: 'INSUFFICIENT_FUNDS' };

  const [dice, nextSeed] = rollDice(Number(state.seed));
  const sum = dice[0] + dice[1];
  const win = sum >= WIN_THRESHOLD;
  const payout = win ? WIN_PAYOUT : 0;
  const delta = payout - STAKE;

  const events: GameEvent[] = [
    event('port_traded', { playerId, cellId, dice, sum, win, stake: STAKE, payout }),
    ...(win
      ? [{ type: 'bank_received', playerId, amount: delta } as GameEvent]
      : [{ type: 'bank_paid', playerId, amount: STAKE } as GameEvent]),
  ];
  const next: GameState = {
    ...base,
    seed: String(nextSeed),
    lastDice: dice,
    players: state.players.map((candidate) => (
      candidate.id === playerId ? { ...candidate, cash: candidate.cash + delta } : candidate
    )),
  };
  const winResult = win ? finishCashGoalIfReached(next, events) : null;
  return finish(winResult?.state ?? next, winResult?.events ?? events);
}

/** 待选动作是否仍然有效（当前玩家、同一阶段、仍站在口岸格上、无债务）。 */
function isValidPortChoice(state: GameState, action: PendingModuleAction): boolean {
  if (action.playerId !== state.currentPlayerId) return false;
  if (action.requiredPhase !== state.turnPhase || state.debt !== null) return false;
  if (!isRecord(action.payload) || !Number.isSafeInteger(action.payload.cellId)) return false;
  const player = state.players.find((candidate) => candidate.id === action.playerId);
  if (!player || player.bankrupt) return false;
  return player.position === action.payload.cellId && isPortCellId(state, player.position);
}

/**
 * 只做清理，不重新生成选项。
 *
 * 本模块不写任何公共状态，但**仍然必须有这个 hook**：投降与托管跳过这两条路径会在
 * **不消费待选动作**的情况下推进回合（applyIntent 对 surrender 放行、skipCurrentTurn 直接换人），
 * 残留的 `managing` 选项会让下一位玩家无论掷骰、买地还是结束回合都拿到 WRONG_PHASE ——
 * 表现为「零活跃计时器、零服务端错误」的整局静默冻结。
 */
function synchronizePortActions(state: GameState): GameState {
  const kept = state.publicRuleState.pendingActions.filter((action) => (
    !isOwnAction(action) || isValidPortChoice(state, action)
  ));
  if (kept.length === state.publicRuleState.pendingActions.length) return state;
  return { ...state, publicRuleState: { ...state.publicRuleState, pendingActions: kept } };
}

/** 机器人/托管：留足安全垫才下注（期望值为正，钱多就该赌）。 */
function chooseBotPortChoice(
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
  if (player.cash >= STAKE + BOT_STAKE_RESERVE) {
    const stake = toIntent(byKind(KIND_STAKE));
    if (stake !== undefined) return stake;
  }
  return toIntent(byKind(KIND_SKIP) ?? byKind(KIND_STAKE));
}

const portTradeRuleModuleInput: RuleModuleDefinition = {
  ref: PORT_TRADE_MODULE_REF,
  cellHandlers: [{
    type: 'module',
    cellType: 'port',
    handle: settlePortLanding,
  }],
  effectHandlers: [],
  intentHandlers: [{
    type: 'module',
    action: 'port-choice',
    handle: handlePortChoice,
  }],
  botStrategyHook: {
    decide: (context) => {
      const decided = chooseBotPortChoice(context.state, context.playerId);
      return decided ?? context.currentDecision;
    },
  },
  postTransitionHook: {
    apply: (context) => (context.result.ok
      ? { ...context.result, state: synchronizePortActions(context.result.state) }
      : context.result),
  },
};

export const portTradeRuleModuleDefinition = portTradeRuleModuleInput;
