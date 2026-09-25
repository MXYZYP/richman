// 规则模块 `yangtze-ferry@1`：长江渡轮（长江之旅）
//
// 机制（既有四个模块都没有的「玩家主动选择落点」玩法）：
//   · 地图上的 `ferry` 模块格叫「渡口」，共 3 个，沿棋盘顺序构成一条上下游航线。
//   · 落到渡口可以选择**顺流下**（付 400 船资，直达下一渡口）或**逆流上**（免费，回到上一渡口），
//     也可以**不换乘**。这是全仓唯一由玩家自己决定「这次停在哪儿」的机制 ——
//     core 的 move_to / move_steps 都是被动挨效果，渡轮是主动选择。
//   · **一回合只换乘一次**：换乘抵达的渡口**不再结算落点**、不再摆出换乘选项。
//     这既符合直觉（船一天一班），也顺手掐掉了「顺流 → 逆流 → 顺流」的无限循环 ——
//     否则玩家可以原地把现金一次次付给船家，机器人更是会一路刷到破产。
//
// 本模块**不写任何公共状态**（不需要持久化：航线由棋盘决定，选择由待选动作承载）。
// 因此 `publicRuleState.modules` 里出现本模块的键即视为损坏存档（见 hydrate 的
// STATELESS_MODULE_KEYS 分支）—— 这是刻意的：状态越少，快照与存档越不可能漂移。
import type { DeepReadonly, JsonValue, ModuleCell, RuleModuleRef } from '@richman/board-data';
import type { ApplyResult, GameEvent, GameState, PendingModuleAction, PlayerState } from './types';
import type { CellSettlementContext, IntentExecutionContext, RuleModuleDefinition } from './moduleRegistry';
import { moduleEventFor } from './moduleSupport';

export const YANGTZE_FERRY_MODULE_REF = Object.freeze({ id: 'yangtze-ferry', version: 1 }) satisfies RuleModuleRef;
export const YANGTZE_FERRY_MODULE_KEY = 'yangtze-ferry@1';

/** 顺流下的船资（逆流上免费：逆水行舟不划算，索性让玩家白坐）。 */
const DOWNSTREAM_COST = 400;
/** 机器人愿意为一次顺流跳跃付钱的最低现金（留足安全垫）。 */
const BOT_DOWNSTREAM_RESERVE = 2600;

const KIND_DOWNSTREAM = 'downstream';
const KIND_UPSTREAM = 'upstream';
const KIND_SKIP = 'skip';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFerryCell(cell: DeepReadonly<ModuleCell> | undefined): cell is DeepReadonly<ModuleCell> {
  return cell?.type === 'module'
    && cell.module.id === YANGTZE_FERRY_MODULE_REF.id
    && cell.module.version === YANGTZE_FERRY_MODULE_REF.version
    && cell.cellType === 'ferry';
}

/** 棋盘上全部渡口格（按数组顺序 = 上下游顺序）。 */
export function ferryCells(
  board: { readonly cells: readonly unknown[] },
): DeepReadonly<ModuleCell>[] {
  const cells: DeepReadonly<ModuleCell>[] = [];
  for (const candidate of board.cells) {
    const cell = candidate as DeepReadonly<ModuleCell>;
    if (isFerryCell(cell)) cells.push(cell);
  }
  return cells;
}

/** 渡口格 payload 必须为空对象（航线由棋盘顺序决定，不需要逐格参数）。 */
export function isFerryCellPayload(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

/** 沿航线取第 delta 个渡口（+1 下、-1 上），只有一个渡口时返回 undefined。 */
function ferryTarget(state: GameState, cellId: number, delta: 1 | -1): number | undefined {
  const chain = ferryCells(state.board).map((cell) => cell.id);
  if (chain.length < 2) return undefined;
  const index = chain.indexOf(cellId);
  if (index < 0) return undefined;
  return chain[(index + delta + chain.length) % chain.length];
}

function isFerryCellId(state: GameState, cellId: number): boolean {
  return ferryCells(state.board).some((cell) => cell.id === cellId);
}

function event(eventType: string, payload: JsonValue): GameEvent {
  return moduleEventFor(YANGTZE_FERRY_MODULE_REF, eventType, payload);
}

function ferryOptionId(state: GameState, playerId: string, cellId: number, kind: string): string {
  return `${YANGTZE_FERRY_MODULE_KEY}:ferry-choice:${playerId}:${state.turn}:${cellId}:${kind}`;
}

function ferryChoiceAction(
  state: GameState,
  playerId: string,
  cellId: number,
  kind: string,
  label: string,
): PendingModuleAction {
  const optionId = ferryOptionId(state, playerId, cellId, kind);
  return {
    optionId,
    module: YANGTZE_FERRY_MODULE_REF,
    playerId,
    requiredPhase: 'managing',
    label,
    action: 'ferry-choice',
    payload: { optionId, cellId, kind },
  };
}

/** 当前玩家站在渡口格上时，给出此刻可行的换乘选项。 */
function ferryChoiceActions(state: GameState, player: PlayerState): PendingModuleAction[] {
  if (!isFerryCellId(state, player.position)) return [];
  const actions: PendingModuleAction[] = [];
  const downstream = ferryTarget(state, player.position, 1);
  const upstream = ferryTarget(state, player.position, -1);
  if (downstream !== undefined && player.cash >= DOWNSTREAM_COST) {
    actions.push(ferryChoiceAction(
      state,
      player.id,
      player.position,
      KIND_DOWNSTREAM,
      `顺流下（付 ${DOWNSTREAM_COST} 元，直达下一渡口）`,
    ));
  }
  if (upstream !== undefined) {
    actions.push(ferryChoiceAction(
      state,
      player.id,
      player.position,
      KIND_UPSTREAM,
      '逆流上（免费，回到上一渡口）',
    ));
  }
  actions.push(ferryChoiceAction(state, player.id, player.position, KIND_SKIP, '不换乘'));
  return actions;
}

/** 落点结算：只负责把阶段归到 managing 并摆出选项，不产生任何金钱变动。 */
function settleFerryLanding(context: CellSettlementContext) {
  const cell = context.cell as DeepReadonly<ModuleCell>;
  const player = context.state.players.find((candidate) => candidate.id === context.playerId);
  if (!player || player.position !== cell.id || !isFerryCellPayload(cell.payload)) {
    return context.applyCore();
  }

  const actions = ferryChoiceActions(context.state, player);
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
    events: [...context.events, event('ferry_visited', { playerId: context.playerId, cellId: cell.id })],
    newDebt: state.debt,
  };
}

function isOwnAction(action: PendingModuleAction): boolean {
  return action.module.id === YANGTZE_FERRY_MODULE_REF.id
    && action.module.version === YANGTZE_FERRY_MODULE_REF.version;
}

function withoutPlayerFerryActions(state: GameState, playerId: string): GameState {
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

function handleFerryChoice(
  context: IntentExecutionContext,
): ApplyResult {
  const { state, playerId, intent } = context;
  if (state.turnPhase !== 'managing') return { ok: false, code: 'WRONG_PHASE' };
  const pending = matchingPendingAction(state, playerId, intent);
  if (pending === undefined || !isRecord(pending.payload)) return { ok: false, code: 'ILLEGAL_INTENT' };
  const cellId = pending.payload.cellId;
  const kind = pending.payload.kind;
  if (!Number.isSafeInteger(cellId) || typeof kind !== 'string') return { ok: false, code: 'ILLEGAL_INTENT' };

  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player || player.bankrupt || player.position !== cellId) return { ok: false, code: 'ILLEGAL_INTENT' };

  const base = withoutPlayerFerryActions(state, playerId);
  const finish = (nextState: GameState, events: GameEvent[]): ApplyResult => ({
    ok: true,
    state: { ...nextState, turnPhase: 'managing', recentLog: [...state.recentLog, ...events].slice(-200) },
    events,
  });

  if (kind === KIND_SKIP) {
    return finish(base, [event('ferry_declined', { playerId, cellId })]);
  }

  const isDownstream = kind === KIND_DOWNSTREAM;
  if (!isDownstream && kind !== KIND_UPSTREAM) return { ok: false, code: 'ILLEGAL_INTENT' };
  if (isDownstream && player.cash < DOWNSTREAM_COST) return { ok: false, code: 'INSUFFICIENT_FUNDS' };

  const target = ferryTarget(state, cellId, isDownstream ? 1 : -1);
  if (target === undefined) return { ok: false, code: 'ILLEGAL_INTENT' };
  const cost = isDownstream ? DOWNSTREAM_COST : 0;

  const events: GameEvent[] = [
    event('ferry_transferred', {
      playerId,
      fromCellId: cellId,
      toCellId: target,
      cost,
      direction: isDownstream ? KIND_DOWNSTREAM : KIND_UPSTREAM,
    }),
    // 顺流船费离开牌桌，必须发 bank_paid 才守现金守恒；逆流免费（cost=0）不发，免得多一条 0 元流水。
    ...(cost > 0
      ? ([{ type: 'bank_paid', playerId, amount: cost }] as GameEvent[])
      : []),
    // 换乘是「坐船」不是「走路」：不领过起点工资，路径只有终点一格（客户端按跳跃播放）。
    { type: 'token_moved', playerId, path: [target] },
  ];
  const next: GameState = {
    ...base,
    players: state.players.map((candidate) => (
      candidate.id === playerId
        ? { ...candidate, cash: candidate.cash - cost, position: target }
        : candidate
    )),
  };
  return finish(next, events);
}

/** 待选动作是否仍然有效（当前玩家、同一阶段、仍站在渡口格上、无债务）。 */
function isValidFerryChoice(state: GameState, action: PendingModuleAction): boolean {
  if (action.playerId !== state.currentPlayerId) return false;
  if (action.requiredPhase !== state.turnPhase || state.debt !== null) return false;
  if (!isRecord(action.payload) || !Number.isSafeInteger(action.payload.cellId)) return false;
  const player = state.players.find((candidate) => candidate.id === action.playerId);
  if (!player || player.bankrupt) return false;
  return player.position === action.payload.cellId && isFerryCellId(state, player.position);
}

/**
 * 只做清理，不重新生成选项。
 *
 * 本模块不写任何公共状态，但**仍然必须有这个 hook**：投降与托管跳过这两条路径会在
 * **不消费待选动作**的情况下推进回合（applyIntent 对 surrender 放行、skipCurrentTurn 直接换人），
 * 残留的 `managing` 选项会让下一位玩家无论掷骰、买地还是结束回合都拿到 WRONG_PHASE ——
 * 表现为「零活跃计时器、零服务端错误」的整局静默冻结。
 */
function synchronizeFerryActions(state: GameState): GameState {
  const kept = state.publicRuleState.pendingActions.filter((action) => (
    !isOwnAction(action) || isValidFerryChoice(state, action)
  ));
  if (kept.length === state.publicRuleState.pendingActions.length) return state;
  return { ...state, publicRuleState: { ...state.publicRuleState, pendingActions: kept } };
}

/** 机器人/托管：现金充裕时搭一次顺风船，否则不换乘。 */
function chooseBotFerryChoice(
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
  if (player.cash >= BOT_DOWNSTREAM_RESERVE) {
    const downstream = toIntent(byKind(KIND_DOWNSTREAM));
    if (downstream !== undefined) return downstream;
  }
  return toIntent(byKind(KIND_SKIP) ?? byKind(KIND_UPSTREAM));
}

const yangtzeFerryRuleModuleInput: RuleModuleDefinition = {
  ref: YANGTZE_FERRY_MODULE_REF,
  cellHandlers: [{
    type: 'module',
    cellType: 'ferry',
    handle: settleFerryLanding,
  }],
  effectHandlers: [],
  intentHandlers: [{
    type: 'module',
    action: 'ferry-choice',
    handle: handleFerryChoice,
  }],
  botStrategyHook: {
    decide: (context) => {
      const decided = chooseBotFerryChoice(context.state, context.playerId);
      return decided ?? context.currentDecision;
    },
  },
  postTransitionHook: {
    apply: (context) => (context.result.ok
      ? { ...context.result, state: synchronizeFerryActions(context.result.state) }
      : context.result),
  },
};

export const yangtzeFerryRuleModuleDefinition = yangtzeFerryRuleModuleInput;
