// 规则模块 `piaohao@1`：晋商票号（山西之旅）
//
// 机制（core / world-tour / great-wall / prison 都没有的「独立资金池」玩法）：
//   · 地图上的 `piaohao` 模块格叫「票号」。落到票号格可以**存入** 1000 元（现金转入票号）或
//     **取现**（把票号里的本息一次性拿回现金）。
//   · 票号余额每回合结算一次利息（8%），上限 5000 —— 存得越久越值钱，但钱压在票号里就动不了。
//   · **垫付**：回合开始时若该玩家现金不足 1000 而票号里有钱，票号自动划 550 出来送 500 现金
//     （差额 50 是晋商的「汇水」）。这是全仓唯一能让玩家「钱不够时还有一笔兜底」的机制，
//     也是「存款」这件事真正的战略意义 —— 否则它只是个收益略高的存钱罐。
//
// 与既有三个模块一致的两条硬约束（细节见 great-wall 的文件头）：
//   1) 同一时刻的待选动作必须是同一个 `模块@版本:动作`；三个选项共用 `piaohao-choice`，
//      分支放在 `payload.kind`（'deposit' | 'withdraw' | 'skip'）。
//   2) 待选动作的 requiredPhase 必须等于当时的 turnPhase，playerId 必须是当前玩家；
//      落点结算后先把 turnPhase 归到 `managing`，选项的 requiredPhase 也写 `managing`。
//
// 待选动作只在**落点结算时**生成一次；postTransitionHook 只做三件不生成选项的事：
// 生息、垫付、清理失效状态与失效动作。若在 hook 里重新生成选项，「不办理」会被立刻摆回来，
// 形成点不完的循环（great-wall 已经踩过这个坑）。
import type { DeepReadonly, JsonValue, ModuleCell, RuleModuleRef } from '@richman/board-data';
import type { ApplyResult, GameEvent, GameState, PendingModuleAction, PlayerState } from './types';
import type { IntentExecutionContext, RuleModuleDefinition } from './moduleRegistry';
import { finishCashGoalIfReached } from './moduleToolkit';
import { crossedTurnBoundary, moduleEventFor, withRawModuleState } from './moduleSupport';

export const PIAOHAO_MODULE_REF = Object.freeze({ id: 'piaohao', version: 1 }) satisfies RuleModuleRef;
export const PIAOHAO_MODULE_KEY = 'piaohao@1';

/** 落到票号格一次存入的金额。 */
const DEPOSIT_AMOUNT = 1000;
/** 票号余额上限：防止「一直存、永远不吃亏」把对局拖成单机存钱。 */
const DEPOSIT_CAP = 5000;
/** 每回合结算的利息率（复利）。 */
const INTEREST_RATE = 0.08;
/** 垫付触发线：回合开始时现金低于此值才考虑垫付。 */
const ADVANCE_THRESHOLD = 1000;
/** 垫付交给玩家的现金。 */
const ADVANCE_CASH = 500;
/** 垫付从票号扣掉的金额（含 50 元汇水）。 */
const ADVANCE_COST = 550;
/** 机器人存款前保留的现金安全垫：不至于为吃利息而掏空现金。 */
const BOT_DEPOSIT_RESERVE = 2000;

export interface PiaohaoPublicModuleState {
  /** playerId → 票号余额（本息合计，整数元）。 */
  readonly depositByPlayerId: Readonly<Record<string, number>>;
}

const KIND_DEPOSIT = 'deposit';
const KIND_WITHDRAW = 'withdraw';
const KIND_SKIP = 'skip';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPiaohaoCell(cell: DeepReadonly<ModuleCell> | undefined): cell is DeepReadonly<ModuleCell> {
  return cell?.type === 'module'
    && cell.module.id === PIAOHAO_MODULE_REF.id
    && cell.module.version === PIAOHAO_MODULE_REF.version
    && cell.cellType === 'piaohao';
}

/** 棋盘上全部票号格（按数组顺序）。 */
export function piaohaoCells(
  board: { readonly cells: readonly unknown[] },
): DeepReadonly<ModuleCell>[] {
  const cells: DeepReadonly<ModuleCell>[] = [];
  for (const candidate of board.cells) {
    const cell = candidate as DeepReadonly<ModuleCell>;
    if (isPiaohaoCell(cell)) cells.push(cell);
  }
  return cells;
}

/** 票号格 payload 必须为空对象（参数全部是模块常量，和 prison@1 的格同一标准）。 */
export function isPiaohaoCellPayload(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

function emptyPiaohaoState(): PiaohaoPublicModuleState {
  return { depositByPlayerId: {} };
}

function readPiaohaoState(state: GameState): PiaohaoPublicModuleState {
  const value = state.publicRuleState.modules[PIAOHAO_MODULE_KEY];
  if (!isRecord(value) || !isRecord(value.depositByPlayerId)) return emptyPiaohaoState();
  const depositByPlayerId: Record<string, number> = {};
  for (const [playerId, amount] of Object.entries(value.depositByPlayerId)) {
    if (typeof amount === 'number' && Number.isSafeInteger(amount) && amount > 0) {
      depositByPlayerId[playerId] = amount;
    }
  }
  return { depositByPlayerId };
}

function piaohaoStateAsJson(value: PiaohaoPublicModuleState): JsonValue {
  return value as unknown as JsonValue;
}

function hasPiaohaoState(value: PiaohaoPublicModuleState): boolean {
  return Object.keys(value.depositByPlayerId).length > 0;
}

function withPiaohaoState(
  state: GameState,
  piaohaoState: PiaohaoPublicModuleState,
  pendingActions: readonly PendingModuleAction[] = state.publicRuleState.pendingActions,
): GameState {
  return withRawModuleState(
    state,
    PIAOHAO_MODULE_KEY,
    hasPiaohaoState(piaohaoState) ? piaohaoStateAsJson(piaohaoState) : null,
    pendingActions,
  );
}

function isOwnAction(action: PendingModuleAction): boolean {
  return action.module.id === PIAOHAO_MODULE_REF.id
    && action.module.version === PIAOHAO_MODULE_REF.version;
}

function event(eventType: string, payload: JsonValue): GameEvent {
  return moduleEventFor(PIAOHAO_MODULE_REF, eventType, payload);
}

/** 丢弃失效余额：破产/已离场的玩家不再持有票号账目。 */
function cleanPiaohaoState(state: GameState): PiaohaoPublicModuleState {
  const current = readPiaohaoState(state);
  const alive = new Set(state.players.filter((player) => !player.bankrupt).map((player) => player.id));
  const depositByPlayerId: Record<string, number> = {};
  for (const [playerId, amount] of Object.entries(current.depositByPlayerId)) {
    if (alive.has(playerId)) depositByPlayerId[playerId] = amount;
  }
  return { depositByPlayerId };
}

function isPiaohaoCellId(state: GameState, cellId: number): boolean {
  return piaohaoCells(state.board).some((cell) => cell.id === cellId);
}

function piaohaoOptionId(
  state: GameState,
  playerId: string,
  cellId: number,
  kind: string,
): string {
  return `${PIAOHAO_MODULE_KEY}:piaohao-choice:${playerId}:${state.turn}:${cellId}:${kind}`;
}

function piaohaoChoiceAction(
  state: GameState,
  playerId: string,
  cellId: number,
  kind: string,
  label: string,
): PendingModuleAction {
  const optionId = piaohaoOptionId(state, playerId, cellId, kind);
  return {
    optionId,
    module: PIAOHAO_MODULE_REF,
    playerId,
    requiredPhase: 'managing',
    label,
    action: 'piaohao-choice',
    payload: { optionId, cellId, kind },
  };
}

/** 当前玩家站在票号格上时，给出「存入 / 取现 / 不办理」中此刻可行的选项。 */
function piaohaoChoiceActions(
  state: GameState,
  piaohaoState: PiaohaoPublicModuleState,
  player: PlayerState,
): PendingModuleAction[] {
  if (!isPiaohaoCellId(state, player.position)) return [];
  const deposit = piaohaoState.depositByPlayerId[player.id] ?? 0;
  const actions: PendingModuleAction[] = [];
  if (player.cash >= DEPOSIT_AMOUNT && deposit + DEPOSIT_AMOUNT <= DEPOSIT_CAP) {
    actions.push(piaohaoChoiceAction(
      state,
      player.id,
      player.position,
      KIND_DEPOSIT,
      `存入票号（${DEPOSIT_AMOUNT} 元）`,
    ));
  }
  if (deposit > 0) {
    actions.push(piaohaoChoiceAction(
      state,
      player.id,
      player.position,
      KIND_WITHDRAW,
      `取现本息（${deposit} 元）`,
    ));
  }
  actions.push(piaohaoChoiceAction(state, player.id, player.position, KIND_SKIP, '不办理'));
  return actions;
}

/** 落点结算：只负责把阶段归到 managing 并摆出选项，不产生任何金钱变动。 */
function settlePiaohaoLanding(
  context: Parameters<RuleModuleDefinition['cellHandlers'][number]['handle']>[0],
) {
  const cell = context.cell as DeepReadonly<ModuleCell>;
  const player = context.state.players.find((candidate) => candidate.id === context.playerId);
  if (!player || player.position !== cell.id || !isPiaohaoCellPayload(cell.payload)) {
    return context.applyCore();
  }

  const piaohaoState = cleanPiaohaoState(context.state);
  const actions = piaohaoChoiceActions(context.state, piaohaoState, player);
  const state = withPiaohaoState(
    { ...context.state, turnPhase: 'managing' },
    piaohaoState,
    [
      ...context.state.publicRuleState.pendingActions.filter((action) => action.playerId !== context.playerId),
      ...actions,
    ],
  );
  return {
    state,
    events: [...context.events, event('piaohao_visited', { playerId: context.playerId, cellId: cell.id })],
    newDebt: state.debt,
  };
}

/** 待选动作是否仍然有效（当前玩家、同一阶段、仍站在票号格上、无债务）。 */
function isValidPiaohaoChoice(state: GameState, action: PendingModuleAction): boolean {
  if (action.playerId !== state.currentPlayerId) return false;
  if (action.requiredPhase !== state.turnPhase || state.debt !== null) return false;
  if (!isRecord(action.payload) || !Number.isSafeInteger(action.payload.cellId)) return false;
  const player = state.players.find((candidate) => candidate.id === action.playerId);
  if (!player || player.bankrupt) return false;
  return player.position === action.payload.cellId && isPiaohaoCellId(state, player.position);
}

function matchingPendingAction(
  state: GameState,
  playerId: string,
  intent: { readonly action: string; readonly payload: JsonValue | undefined },
): PendingModuleAction | undefined {
  return state.publicRuleState.pendingActions.find((action) => (
    action.playerId === playerId
    && isOwnAction(action)
    && action.action === intent.action
    && isRecord(action.payload)
    && isRecord(intent.payload)
    && action.payload.optionId === intent.payload.optionId
  ));
}

function withoutPlayerPiaohaoActions(state: GameState, playerId: string): GameState {
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

function handlePiaohaoChoice(state: GameState, playerId: string, intent: IntentExecutionContext['intent']): ApplyResult {
  if (state.turnPhase !== 'managing') return { ok: false, code: 'WRONG_PHASE' };
  const pending = matchingPendingAction(
    state,
    playerId,
    { action: intent.type === 'module' ? intent.action : '', payload: intent.type === 'module' ? intent.payload : undefined },
  );
  if (pending === undefined || !isRecord(pending.payload)) return { ok: false, code: 'ILLEGAL_INTENT' };
  const cellId = pending.payload.cellId;
  const kind = pending.payload.kind;
  if (!Number.isSafeInteger(cellId) || typeof kind !== 'string') return { ok: false, code: 'ILLEGAL_INTENT' };

  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player || player.bankrupt || player.position !== cellId) return { ok: false, code: 'ILLEGAL_INTENT' };

  const cleanState = withoutPlayerPiaohaoActions(state, playerId);
  const piaohaoState = cleanPiaohaoState(state);
  const deposit = piaohaoState.depositByPlayerId[playerId] ?? 0;
  const finish = (nextState: GameState, events: GameEvent[]): ApplyResult => ({
    ok: true,
    state: { ...nextState, turnPhase: 'managing', recentLog: [...state.recentLog, ...events].slice(-200) },
    events,
  });

  if (kind === KIND_SKIP) {
    return finish(
      withPiaohaoState(cleanState, piaohaoState),
      [event('piaohao_declined', { playerId, cellId })],
    );
  }

  if (kind === KIND_DEPOSIT) {
    if (player.cash < DEPOSIT_AMOUNT) return { ok: false, code: 'INSUFFICIENT_FUNDS' };
    if (deposit + DEPOSIT_AMOUNT > DEPOSIT_CAP) return { ok: false, code: 'ILLEGAL_INTENT' };
    const events: GameEvent[] = [event('piaohao_deposited', {
      playerId,
      cellId,
      amount: DEPOSIT_AMOUNT,
      balance: deposit + DEPOSIT_AMOUNT,
    }),
    // 票号存银是「钱离开牌桌」：账面等同付给银行。取现时已发 bank_received（含利息），
    // 两头对称才让 sum(cash) + bankBalance 守衡（simulate.ts 的不变量会逐局校验）。
    { type: 'bank_paid', playerId, amount: DEPOSIT_AMOUNT }];
    const next = withPiaohaoState(
      {
        ...cleanState,
        players: state.players.map((candidate) => (
          candidate.id === playerId ? { ...candidate, cash: candidate.cash - DEPOSIT_AMOUNT } : candidate
        )),
      },
      {
        depositByPlayerId: {
          ...piaohaoState.depositByPlayerId,
          [playerId]: deposit + DEPOSIT_AMOUNT,
        },
      },
    );
    return finish(next, events);
  }

  if (kind === KIND_WITHDRAW) {
    if (deposit <= 0) return { ok: false, code: 'ILLEGAL_INTENT' };
    const remaining = { ...piaohaoState.depositByPlayerId };
    delete remaining[playerId];
    const events: GameEvent[] = [
      event('piaohao_withdrawn', { playerId, cellId, amount: deposit }),
      { type: 'bank_received', playerId, amount: deposit },
    ];
    const next = withPiaohaoState(
      {
        ...cleanState,
        players: state.players.map((candidate) => (
          candidate.id === playerId ? { ...candidate, cash: candidate.cash + deposit } : candidate
        )),
      },
      { depositByPlayerId: remaining },
    );
    const win = finishCashGoalIfReached(next, events);
    return finish(win?.state ?? next, win?.events ?? events);
  }

  return { ok: false, code: 'ILLEGAL_INTENT' };
}

/**
 * 回合边界结算：① 全体票号余额计息（封顶）；② 给新的行动者做一次「票号垫付」。
 * 顺序刻意如此：先计息，垫付时用到的余额才是含本期利息的余额。
 */
function settleTurnBoundary(state: GameState): { state: GameState; events: GameEvent[] } {
  const events: GameEvent[] = [];
  const piaohaoState = cleanPiaohaoState(state);

  const interestByPlayerId: Record<string, number> = {};
  for (const [playerId, balance] of Object.entries(piaohaoState.depositByPlayerId)) {
    const grown = Math.min(DEPOSIT_CAP, balance + Math.floor(balance * INTEREST_RATE));
    interestByPlayerId[playerId] = grown;
    if (grown > balance) {
      events.push(event('piaohao_interest', { playerId, amount: grown - balance, balance: grown }));
    }
  }

  let next: GameState = withPiaohaoState(state, { depositByPlayerId: interestByPlayerId });

  const actor = next.players.find((player) => player.id === next.currentPlayerId);
  const balance = actor === undefined ? 0 : interestByPlayerId[actor.id] ?? 0;
  if (actor !== undefined && !actor.bankrupt && actor.cash < ADVANCE_THRESHOLD && balance >= ADVANCE_COST) {
    const remaining = { ...interestByPlayerId };
    remaining[actor.id] = balance - ADVANCE_COST;
    if (remaining[actor.id] === 0) delete remaining[actor.id];
    events.push(event('piaohao_advance', {
      playerId: actor.id,
      amount: ADVANCE_CASH,
      cost: ADVANCE_COST,
      balance: remaining[actor.id] ?? 0,
    }));
    events.push({ type: 'bank_received', playerId: actor.id, amount: ADVANCE_CASH });
    next = withPiaohaoState(
      {
        ...next,
        players: next.players.map((candidate) => (
          candidate.id === actor.id ? { ...candidate, cash: candidate.cash + ADVANCE_CASH } : candidate
        )),
      },
      { depositByPlayerId: remaining },
    );
    const win = finishCashGoalIfReached(next, events);
    return { state: win?.state ?? next, events: win?.events ?? events };
  }

  return { state: next, events };
}

/** 只做清理，不重新生成选项（否则「不办理」会被立刻摆回来）。 */
function synchronizePiaohaoState(state: GameState): GameState {
  const piaohaoState = cleanPiaohaoState(state);
  const kept = state.publicRuleState.pendingActions.filter((action) => (
    !isOwnAction(action) || isValidPiaohaoChoice(state, action)
  ));
  return withPiaohaoState(state, piaohaoState, kept);
}

/** 机器人/托管：有票号选项时自己拿主意，其余情况交回既有决策链。 */
function chooseBotPiaohaoChoice(state: GameState, playerId: string): { type: 'module'; module: RuleModuleRef; action: string; payload: JsonValue } | undefined {
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

  const withdraw = byKind(KIND_WITHDRAW);
  const deposit = byKind(KIND_DEPOSIT);
  const skip = byKind(KIND_SKIP);

  // 现金告急优先取现；宽裕且能存就存；否则不办理。
  if (withdraw !== undefined && player.cash < ADVANCE_THRESHOLD) return toIntent(withdraw);
  if (deposit !== undefined && player.cash >= DEPOSIT_AMOUNT + BOT_DEPOSIT_RESERVE) return toIntent(deposit);
  if (withdraw !== undefined && player.cash >= DEPOSIT_AMOUNT + BOT_DEPOSIT_RESERVE * 2) return toIntent(withdraw);
  return toIntent(skip ?? withdraw ?? deposit);
}

/**
 * hydrate 用的严格校验：账目键必须是本局存活玩家、金额必须是正安全整数且不超过上限。
 * 上限也要校验：损坏存档里一个天文数字的余额会让后续每回合派发巨额利息，等于毁掉整局。
 */
export function validatePiaohaoPublicModuleState(
  value: unknown,
  players: readonly DeepReadonly<PlayerState>[],
): value is PiaohaoPublicModuleState {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isRecord(value.depositByPlayerId)) {
    return false;
  }
  const alive = new Set(players.filter((player) => !player.bankrupt).map((player) => player.id));
  for (const [playerId, amount] of Object.entries(value.depositByPlayerId)) {
    if (!alive.has(playerId)) return false;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount)) return false;
    if (amount <= 0 || amount > DEPOSIT_CAP) return false;
  }
  return true;
}

const piaohaoRuleModuleInput: RuleModuleDefinition = {
  ref: PIAOHAO_MODULE_REF,
  cellHandlers: [{
    type: 'module',
    cellType: 'piaohao',
    handle: settlePiaohaoLanding,
  }],
  effectHandlers: [],
  intentHandlers: [{
    type: 'module',
    action: 'piaohao-choice',
    handle: (context) => handlePiaohaoChoice(context.state, context.playerId, context.intent),
  }],
  botStrategyHook: {
    decide: (context) => {
      const decided = chooseBotPiaohaoChoice(context.state, context.playerId);
      return decided ?? context.currentDecision;
    },
  },
  postTransitionHook: {
    apply: (context) => {
      if (!context.result.ok) return context.result;
      const synced = synchronizePiaohaoState(context.result.state);
      if (!crossedTurnBoundary(context.previousState, synced)) {
        return { ...context.result, state: synced };
      }
      const settled = settleTurnBoundary(synced);
      const synced2 = synchronizePiaohaoState(settled.state);
      return {
        ok: true,
        state: { ...synced2, recentLog: [...synced2.recentLog, ...settled.events].slice(-200) },
        events: [...context.result.events, ...settled.events],
      };
    },
  },
};

export const piaohaoRuleModuleDefinition = piaohaoRuleModuleInput;
