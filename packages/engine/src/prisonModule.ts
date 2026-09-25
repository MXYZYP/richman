// 规则模块 `prison@1`：监狱（入狱 / 狱中 / 出狱）
//
// 这是 plan/01 §8 里「规格保留、本版关闭」的监狱机制的第一个实现。规则出处是官方说明书第八条。
// 说明书没写明、由 owner 在 2026-09-23 明确拍板的四个点（本文件按 owner 的答复实现）：
//
//   1) **狱中可照常收过路费 / 做抵押、卖地这类财务操作**（说明书未禁止；盖房天然不可能 ——
//      盖房要求「停留」，而在押者本回合的移动已经结束）。
//      落地上：入狱后与每次出狱失败后都进入 `managing`，玩家做完财务操作再自己结束回合。
//   2) **掷骰达标出狱后按该点数正常移动**并结算落点（不浪费一次好点数）。
//   3) **三次尝试用尽后，下一个本人回合起自动出狱**（说明书没写；不能让玩家被无限期关着，
//      否则对局可能不收敛）。实现上：`attempts` 达到 `config.jailMaxAttempts` 后不再给出狱选项，
//      由 postTransitionHook 在轮到该玩家时直接放人并恢复正常掷骰。
//   4) **保释金（bail，owner 2026-09-23 追加的机制）**：说明书没写这条，是 owner 要求补的。
//      地图可配 `config.jailBailCost`（正安全整数，元）：在押玩家在自己回合、还有出狱机会、且
//      **现金足够**时，除了「掷骰 / 用卡」之外多出一个「缴纳保释金出狱」选项 —— 扣该金额**付给银行**
//      （不进任何玩家口袋），立即出狱，**本回合照常掷骰移动**（与用卡同一条路径，都落到 awaiting_roll）。
//      现金不足时不生成该选项（沿用 great-wall「买不起就不给占据选项」的范式）；被绕过提交时
//      意图处理器返回 INSUFFICIENT_FUNDS。
//      刻意不做成「三次机会用尽后才能花钱」：那等于强迫玩家在还有免费机会时先浪费掉三次，
//      既反直觉，也让「掷骰尝试」这条主路径变得没有意义 —— 保释应当是一个随时可选的「花钱买时间」。
//      另注：`jailBailCost` 是可选项且只在 `jailEnabled === true` 的图上出现；给别的图补这个键
//      （哪怕写 undefined）会让它们的 contentHash 一起漂移，本地存档与房间快照会被判「地图不匹配」。
//
// 机制：
//   · 盘面上有两类模块格：`goto-jail`（进牢格）与 `jail`（监狱角格）。整张图**恰好一个** `jail` 格。
//   · 停在 `goto-jail` 格、或抽到 `prison-confine` 卡 → 棋子**直接移到** `jail` 格
//     （不经过起点、不领报酬金，E19），`attempts` 归零，本回合的移动到此为止。
//   · 恰好停在 `jail` 格本身只是「路过 / 探监」：不产生任何费用，也不入狱。
//   · 轮到自己且仍在狱中时给出待选动作：
//       掷骰尝试出狱（`choice: 'roll'`） / 使用出狱许可证（`choice: 'card'`，仅持有该卡时出现）
//       / 缴纳保释金出狱（`choice: 'bail'`，仅现金足够时出现，见上面第 4 条）。
//   · 卡牌效果 `prison-card` 赠予一张出狱许可证；用掉即销记。卡牌本体始终留在牌堆里循环
//     （core 的「抽顶补底」本就把抽到的牌放回堆底），所以模块状态只记「谁手里有几张未使用的
//     许可证」，不去改 `state.decks` —— 见下面第 3 条硬约束。
//
// 三处必须遵守的引擎/存档硬约束（前两条与 great-wall@1 相同，第三条是监狱特有的坑）：
//
//   1) **同一快照里所有待选动作的 `${id}@${version}:${action}` 必须唯一**（hydrate 的
//      validatePublicRuleState 用 decisionKinds 集合校验）。所以「掷骰 / 用卡 / 保释」三个选项共用动作名
//      `jail-choice`，真正的分支放在 `payload.choice` 里 —— 与 great-wall 的 `payload.claim` 同套路。
//   2) **待选动作的 requiredPhase 必须等于当时的 turnPhase，且 playerId 必须是当前玩家**。
//   3) **绝不改动 `state.decks`**：hydrate 要求每个牌堆的队列长度与牌面集合与地图包逐项一致
//      （`[...queue].sort()` 必须等于该牌堆全部卡 id 排序后的结果）。任何「把持卡从牌堆里摘掉 /
//      用完再塞回」的写法都会让存档、房间快照一律被判损坏 —— 这不是洁癖，是硬门禁。
//
// ★ 为什么**没有**新增 `awaiting_jail_decision` 阶段（types.ts 的老注释曾预告要加）：
//   监狱决策复用 core 的 `awaiting_roll`，待选动作的 requiredPhase 也写 `awaiting_roll`。
//   理由是这条路径上「阶段」这一层的语义已经由 `pendingActions` 完整表达：
//     · 客户端 `getAvailableActions` **先**投影 pendingActions（命中就不再回落到按阶段的按钮表），
//       所以玩家看到的是「掷骰尝试出狱 / 使用出狱许可证」两个按钮，不会看到会必然被拒的「掷骰子」；
//     · 服务端 `chooseTakeoverIntent` 同样先按「当前玩家 + 当前阶段」筛模块待选动作，托管玩家
//       会走 bot 策略产出 module 意图（绝不返回 null）；
//     · 引擎 `applyIntent` 的全局闸门在 pendingActions 非空时只放行匹配的 module 意图，
//       普通的 `roll_dice` 会被挡掉。
//   而新增阶段要同时改 4 处**穷尽式**结构（`Record<TurnPhase, Intent>` 的 TAKEOVER_POLICY、
//   客户端按阶段的按钮 switch、hydrate 的 TURN_PHASES、types 的联合类型），其中 TAKEOVER_POLICY
//   还必须硬塞一个「其实永远不会被用到、且语义必然是错的」意图。收益为零、风险却集中在
//   「某个穷尽 switch 漏改 → 编译期或运行期才炸」。故取复用。
//
// 待选动作只在「轮到自己、且还站在监狱格里」时由 postTransitionHook 生成（见 synchronizePrisonState），
// 且只在 `turnPhase === 'awaiting_roll'` 时生成 —— 这样出狱选择完成后落到 `managing`（掷骰失败）
// 或已不在押（用卡/达标），钩子都不会把选项摆回来（否则会形成点不完的循环，great-wall 也踩过）。
import type {
  Cell,
  DeepReadonly,
  JsonValue,
  ModuleCell,
  ModuleEvent,
  ModuleIntent,
  RuleModuleRef,
} from '@richman/board-data';
import type {
  ApplyResult,
  GameEvent,
  GameState,
  PendingModuleAction,
  PlayerState,
  TurnPhase,
} from './types';
import type {
  CellSettlementContext,
  IntentExecutionContext,
  ModuleEffectExecutionContext,
  RuleModuleDefinition,
} from './moduleRegistry';
import { finishCashGoalIfReached, landingFor, rollDice, walkPath } from './moduleToolkit';

export const PRISON_MODULE_REF = Object.freeze({ id: 'prison', version: 1 }) satisfies RuleModuleRef;
export const PRISON_MODULE_KEY = 'prison@1';

/** 进牢格：停在此格即被送进监狱角格。 */
export const PRISON_GOTO_JAIL_CELL_TYPE = 'goto-jail';
/** 监狱角格：整张图恰好一个；停在它本身只是路过 / 探监。 */
export const PRISON_JAIL_CELL_TYPE = 'jail';
/** 卡牌效果：进牢。 */
export const PRISON_CONFINE_EFFECT_TYPE = 'prison-confine';
/** 卡牌效果：获得一张出狱许可证。 */
export const PRISON_CARD_EFFECT_TYPE = 'prison-card';
/** 唯一的待选动作名：掷骰尝试出狱 / 使用出狱许可证（分支在 `payload.choice`）。 */
export const PRISON_CHOICE_ACTION = 'jail-choice';

/**
 * 监狱决策所处的 turnPhase。
 * 刻意复用 core 的 `awaiting_roll`（理由见文件头「为什么没有新增 awaiting_jail_decision」）：
 * 待选动作的 `requiredPhase` 与它保持一致，玩家在客户端只会看到监狱选项而不是「掷骰子」。
 */
export const PRISON_DECISION_PHASE: TurnPhase = 'awaiting_roll';

/**
 * 狱中可选的三种出狱方式。三者在待选动作里共用动作名 `jail-choice`，
 * 靠 `payload.choice` 区分（见文件头第 1 条硬约束）。
 */
export type PrisonChoice = 'roll' | 'card' | 'bail';

/** 玩家持有的出狱许可证：记住来源牌堆，供战报/UI 说明与回放（牌堆本身不动，见文件头第 3 条）。 */
export interface PrisonHeldCard {
  readonly deck: 'chance' | 'destiny';
  readonly cardId: string;
}

/** 一名在押玩家的状态。`attempts` = 已经用掉的出狱掷骰次数。 */
export interface PrisonDetention {
  readonly attempts: number;
}

export interface PrisonPublicModuleState {
  /** playerId → 在押状态。**键存在即在押**；出狱即删键，不留 `attempts: 0` 的僵尸项。 */
  readonly jailedByPlayerId: Record<string, PrisonDetention>;
  /** playerId → 持有的出狱许可证（按获得顺序）。空数组不入表，保持状态规范。 */
  readonly heldCardsByPlayerId: Record<string, readonly PrisonHeldCard[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isPrisonCell(cell: DeepReadonly<Cell> | undefined): cell is DeepReadonly<ModuleCell> {
  return cell?.type === 'module'
    && cell.module.id === PRISON_MODULE_REF.id
    && cell.module.version === PRISON_MODULE_REF.version;
}

export function isPrisonGotoJail(cell: DeepReadonly<Cell> | undefined): cell is DeepReadonly<ModuleCell> {
  return isPrisonCell(cell) && cell.cellType === PRISON_GOTO_JAIL_CELL_TYPE;
}

export function isPrisonJail(cell: DeepReadonly<Cell> | undefined): cell is DeepReadonly<ModuleCell> {
  return isPrisonCell(cell) && cell.cellType === PRISON_JAIL_CELL_TYPE;
}

/** 棋盘上的监狱角格。正常棋盘只有一个；多个时取 id 最小的那个，让行为确定。 */
export function prisonJailCellId(board: { readonly cells: readonly unknown[] }): number | undefined {
  const ids: number[] = [];
  for (const candidate of board.cells) {
    const cell = candidate as DeepReadonly<Cell>;
    if (isPrisonJail(cell)) ids.push(cell.id);
  }
  return ids.length === 0 ? undefined : Math.min(...ids);
}

/** 棋盘上的全部进牢格（供 UI/测试查询）。 */
export function prisonGotoJailCellIds(board: { readonly cells: readonly unknown[] }): number[] {
  const ids: number[] = [];
  for (const candidate of board.cells) {
    const cell = candidate as DeepReadonly<Cell>;
    if (isPrisonGotoJail(cell)) ids.push(cell.id);
  }
  return ids;
}

function emptyPrisonState(): PrisonPublicModuleState {
  return { jailedByPlayerId: {}, heldCardsByPlayerId: {} };
}

function readPrisonState(state: GameState): PrisonPublicModuleState {
  const value = state.publicRuleState.modules[PRISON_MODULE_KEY];
  return isRecord(value) ? value as unknown as PrisonPublicModuleState : emptyPrisonState();
}

/** 空状态不写进 modules：状态规范（地图没用到监狱时不留空对象）。 */
function hasPrisonState(value: PrisonPublicModuleState): boolean {
  return Object.keys(value.jailedByPlayerId).length > 0
    || Object.keys(value.heldCardsByPlayerId).length > 0;
}

function withPrisonState(
  state: GameState,
  prisonState: PrisonPublicModuleState,
  pendingActions: readonly PendingModuleAction[] = state.publicRuleState.pendingActions,
): GameState {
  const modules = { ...state.publicRuleState.modules };
  if (hasPrisonState(prisonState)) modules[PRISON_MODULE_KEY] = prisonState as unknown as JsonValue;
  else delete modules[PRISON_MODULE_KEY];
  return { ...state, publicRuleState: { modules, pendingActions } };
}

function isOwnAction(action: PendingModuleAction): boolean {
  return action.module.id === PRISON_MODULE_REF.id
    && action.module.version === PRISON_MODULE_REF.version;
}

/** 摘掉某玩家名下全部监狱待选动作（入狱打断本回合、出狱、掷骰失败都要用）。 */
function withoutPlayerPrisonActions(
  pendingActions: readonly PendingModuleAction[],
  playerId: string,
): PendingModuleAction[] {
  return pendingActions.filter((action) => !(action.playerId === playerId && isOwnAction(action)));
}

function moduleEvent(eventType: string, payload: JsonValue): ModuleEvent {
  return { type: 'module', module: PRISON_MODULE_REF, eventType, payload };
}

/** 把模块事件同时追加到 `recentLog`（日志上限 200 与 core 一致）。 */
function withEvents(state: GameState, events: readonly GameEvent[]): GameState {
  if (events.length === 0) return state;
  return { ...state, recentLog: [...state.recentLog, ...events].slice(-200) };
}

// ---------------------------------------------------------------------------
// 状态读写
// ---------------------------------------------------------------------------

function isDetained(state: GameState, playerId: string): boolean {
  return readPrisonState(state).jailedByPlayerId[playerId] !== undefined;
}

/**
 * 本图的保释金。地图没配（非监狱图，或旧 config 里缺字段）时返回 `undefined` = **不提供保释**。
 * 只认「正安全整数」，与 mapValidation 的 assertConfig 同一标准，避免坏数据变成一条 0 元出狱的漏洞。
 */
function bailCostOf(config: { readonly jailBailCost?: number }): number | undefined {
  const cost = config.jailBailCost;
  return Number.isSafeInteger(cost) && (cost as number) > 0 ? cost : undefined;
}

function attemptsOf(state: GameState, playerId: string): number {
  return readPrisonState(state).jailedByPlayerId[playerId]?.attempts ?? 0;
}

function heldCardsOf(state: GameState, playerId: string): readonly PrisonHeldCard[] {
  return readPrisonState(state).heldCardsByPlayerId[playerId] ?? [];
}

/**
 * 丢弃失效的在押与持卡记录：玩家已破产或已被移到别处，卡牌已不在任何牌堆定义里。
 * 「在押」必须与棋子位置严格一致 —— 位置被挪走的记录一律作废，避免出现「人在别处却仍在狱中」
 * 这种谁也说不清的状态。
 */
function cleanPrisonState(state: GameState): PrisonPublicModuleState {
  const current = readPrisonState(state);
  const alive = new Set(
    state.players.filter((player) => !player.bankrupt).map((player) => player.id),
  );
  const jailCellId = prisonJailCellId(state.board);

  const jailedByPlayerId: Record<string, PrisonDetention> = {};
  for (const [playerId, detention] of Object.entries(current.jailedByPlayerId)) {
    if (!alive.has(playerId)) continue;
    // 棋盘上没有监狱格（不该发生，但别让损坏数据把对局带偏）→ 在押状态无意义，丢掉。
    if (jailCellId === undefined) continue;
    const player = state.players.find((candidate) => candidate.id === playerId);
    if (!player || player.position !== jailCellId) continue;
    jailedByPlayerId[playerId] = { attempts: detention.attempts };
  }

  const heldCardsByPlayerId: Record<string, readonly PrisonHeldCard[]> = {};
  for (const [playerId, held] of Object.entries(current.heldCardsByPlayerId)) {
    if (!alive.has(playerId) || !Array.isArray(held) || held.length === 0) continue;
    const valid = held.filter((card) => (
      isRecord(card)
      && (card.deck === 'chance' || card.deck === 'destiny')
      && typeof card.cardId === 'string'
      && state.cards[card.deck as 'chance' | 'destiny'].some((definition) => definition.id === card.cardId)
    ));
    if (valid.length > 0) heldCardsByPlayerId[playerId] = valid;
  }

  return { jailedByPlayerId, heldCardsByPlayerId };
}

// ---------------------------------------------------------------------------
// 入狱 / 出狱 / 持卡
// ---------------------------------------------------------------------------

/**
 * 把玩家送进监狱角格：棋子**直接移到**监狱格（不经过起点、不领报酬金，E19），`attempts` 归零，
 * 本回合的移动到此为止（进入 `managing`，财务操作仍可做，见文件头第 1 条）。
 *
 * 刻意不递归调用落点结算：否则「进牢格 → 移到监狱格 → 再结算监狱格」会绕回本函数，
 * 形成「反复入狱」的链式效果。
 */
function confinePlayer(
  state: GameState,
  playerId: string,
  jailCellId: number,
  events: readonly GameEvent[],
): { state: GameState; events: GameEvent[]; newDebt: GameState['debt'] } {
  const prisonState = cleanPrisonState(state);
  const nextState = withPrisonState(
    {
      ...state,
      turnPhase: 'managing',
      players: state.players.map((player) => (
        player.id === playerId ? { ...player, position: jailCellId } : player
      )),
    },
    {
      jailedByPlayerId: { ...prisonState.jailedByPlayerId, [playerId]: { attempts: 0 } },
      heldCardsByPlayerId: prisonState.heldCardsByPlayerId,
    },
    withoutPlayerPrisonActions(state.publicRuleState.pendingActions, playerId),
  );
  const nextEvents: GameEvent[] = [
    ...events,
    moduleEvent('sent_to_jail', { playerId, jailCellId }),
  ];
  return { state: withEvents(nextState, nextEvents), events: nextEvents, newDebt: nextState.debt };
}

/** 真正释放：删掉在押键 + 摘掉待选动作。 */
function removeFromJail(
  state: GameState,
  playerId: string,
  prisonState: PrisonPublicModuleState,
  turnPhase: TurnPhase,
): GameState {
  const jailedByPlayerId = { ...prisonState.jailedByPlayerId };
  delete jailedByPlayerId[playerId];
  return withPrisonState(
    { ...state, turnPhase },
    { jailedByPlayerId, heldCardsByPlayerId: prisonState.heldCardsByPlayerId },
    withoutPlayerPrisonActions(state.publicRuleState.pendingActions, playerId),
  );
}

/**
 * 掷骰未达标：**保留在押键**、把已用次数 +1，并进入 `managing` 让玩家处理财务操作。
 * （曾经的写法借用 removeFromJail 改 attempts，结果把玩家从监狱里放了出来 —— 别再用这招。）
 */
function withIncrementedAttempts(
  state: GameState,
  playerId: string,
  prisonState: PrisonPublicModuleState,
  attempts: number,
  turnPhase: TurnPhase,
): GameState {
  return withPrisonState(
    { ...state, turnPhase },
    {
      jailedByPlayerId: { ...prisonState.jailedByPlayerId, [playerId]: { attempts } },
      heldCardsByPlayerId: prisonState.heldCardsByPlayerId,
    },
    withoutPlayerPrisonActions(state.publicRuleState.pendingActions, playerId),
  );
}

/** 用掉一张出狱许可证：从持有列表里移除**一张**（同名的多张只消一张），牌堆原样不动。 */
function consumeJailCard(
  state: GameState,
  playerId: string,
  prisonState: PrisonPublicModuleState,
  card: PrisonHeldCard,
): { state: GameState; events: GameEvent[] } {
  const held = prisonState.heldCardsByPlayerId[playerId] ?? [];
  const index = held.findIndex((candidate) => (
    candidate.deck === card.deck && candidate.cardId === card.cardId
  ));
  const remaining = index < 0 ? [...held] : held.filter((_, position) => position !== index);

  const heldCardsByPlayerId = { ...prisonState.heldCardsByPlayerId };
  if (remaining.length > 0) heldCardsByPlayerId[playerId] = remaining;
  else delete heldCardsByPlayerId[playerId];

  const nextState = withPrisonState(state, {
    jailedByPlayerId: prisonState.jailedByPlayerId,
    heldCardsByPlayerId,
  });
  const events: GameEvent[] = [
    moduleEvent('jail_card_used', { playerId, deck: card.deck, cardId: card.cardId }),
  ];
  return { state: withEvents(nextState, events), events };
}

// ---------------------------------------------------------------------------
// 待选动作
// ---------------------------------------------------------------------------

function optionId(state: GameState, playerId: string, choice: PrisonChoice): string {
  return `${PRISON_MODULE_KEY}:${PRISON_CHOICE_ACTION}:${playerId}:${state.turn}:${choice}`;
}

function jailChoiceAction(
  state: GameState,
  playerId: string,
  choice: PrisonChoice,
  label: string,
): PendingModuleAction {
  const id = optionId(state, playerId, choice);
  return {
    optionId: id,
    module: PRISON_MODULE_REF,
    playerId,
    requiredPhase: PRISON_DECISION_PHASE,
    label,
    action: PRISON_CHOICE_ACTION,
    payload: { optionId: id, choice },
  };
}

/**
 * 在押玩家当前可用的选项。
 * `config.jailMaxAttempts` 用尽后**不再给选项** —— 那个玩家将由 postTransitionHook 自动放出。
 * 保释选项只在**现金足够**时出现（与 great-wall「买不起就不给占据选项」同一范式）。
 */
function jailChoiceActions(
  state: GameState,
  playerId: string,
  prisonState: PrisonPublicModuleState = readPrisonState(state),
): PendingModuleAction[] {
  const detention = prisonState.jailedByPlayerId[playerId];
  if (!detention) return [];
  if (detention.attempts >= state.config.jailMaxAttempts) return [];
  const actions: PendingModuleAction[] = [
    jailChoiceAction(
      state,
      playerId,
      'roll',
      `掷骰尝试出狱（点数 ≥ ${state.config.jailExitMinRoll} 即可出狱）`,
    ),
  ];
  const held = prisonState.heldCardsByPlayerId[playerId] ?? [];
  if (held.length > 0) {
    actions.push(jailChoiceAction(state, playerId, 'card', `使用出狱许可证（持有 ${held.length} 张）`));
  }
  const bailCost = bailCostOf(state.config);
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (bailCost !== undefined && player !== undefined && player.cash >= bailCost) {
    actions.push(jailChoiceAction(state, playerId, 'bail', `缴纳保释金出狱（${bailCost} 元）`));
  }
  return actions;
}

function isValidJailChoice(
  state: GameState,
  action: PendingModuleAction,
  prisonState: PrisonPublicModuleState,
): boolean {
  if (!isOwnAction(action)) return false;
  if (action.playerId !== state.currentPlayerId) return false;
  if (action.requiredPhase !== state.turnPhase || state.debt !== null) return false;
  if (!isRecord(action.payload) || typeof action.payload.choice !== 'string') return false;
  const detention = prisonState.jailedByPlayerId[action.playerId];
  if (!detention) return false;
  // 三种出狱方式都以「还有出狱机会」为前提；用尽后由 postTransitionHook 自动放人，选项一并清掉。
  if (detention.attempts >= state.config.jailMaxAttempts) return false;
  if (action.payload.choice === 'card') {
    return (prisonState.heldCardsByPlayerId[action.playerId] ?? []).length > 0;
  }
  if (action.payload.choice === 'bail') {
    const bailCost = bailCostOf(state.config);
    const player = state.players.find((candidate) => candidate.id === action.playerId);
    return bailCost !== undefined && player !== undefined && player.cash >= bailCost;
  }
  return action.payload.choice === 'roll';
}

// ---------------------------------------------------------------------------
// 回合同步（postTransitionHook）
// ---------------------------------------------------------------------------

/**
 * 每次成功迁移后同步监狱状态。**只做三件事**：清理失效记录、在轮到在押玩家时摆出出狱选项、
 * 把用尽机会的玩家自动放出来。
 *
 * 刻意只在 `turnPhase === 'awaiting_roll'` 时摆选项：掷骰失败会落到 `managing`，
 * 用卡/达标后已不在押，这两种情况都不该再有选项 —— 否则玩家点完「掷骰」钩子会立刻把选项
 * 摆回来，形成点不完的循环（great-wall 踩过同一个坑）。
 */
function synchronizePrisonState(state: GameState): { state: GameState; events: GameEvent[] } {
  const prisonState = cleanPrisonState(state);
  let next = withPrisonState(state, prisonState);
  let events: GameEvent[] = [];

  if (state.phase === 'playing' && state.debt === null) {
    const playerId = state.currentPlayerId;
    const detention = prisonState.jailedByPlayerId[playerId];
    if (detention && detention.attempts >= state.config.jailMaxAttempts) {
      // 三次尝试用尽 → 下一个本人回合起自动出狱（owner 定案），恢复正常掷骰。
      const released = removeFromJail(next, playerId, prisonState, PRISON_DECISION_PHASE);
      events = [moduleEvent('jail_released', {
        playerId,
        reason: 'attempts-exhausted',
        attempts: detention.attempts,
      })];
      next = withEvents(released, events);
    } else if (detention && state.turnPhase === PRISON_DECISION_PHASE) {
      const actions = jailChoiceActions(state, playerId, prisonState);
      next = withPrisonState(
        { ...next, turnPhase: PRISON_DECISION_PHASE },
        prisonState,
        [...withoutPlayerPrisonActions(state.publicRuleState.pendingActions, playerId), ...actions],
      );
    }
  }

  // 清掉不再合法（换人、阶段变了、已经把卡用掉、机会用尽……）的监狱选项。
  const kept = next.publicRuleState.pendingActions.filter((action) => (
    !isOwnAction(action) || isValidJailChoice(next, action, prisonState)
  ));
  if (kept.length !== next.publicRuleState.pendingActions.length) {
    next = withPrisonState(next, prisonState, kept);
  }
  return { state: next, events };
}

// ---------------------------------------------------------------------------
// 意图处理
// ---------------------------------------------------------------------------

function matchingPendingAction(
  state: GameState,
  playerId: string,
  intent: ModuleIntent,
): PendingModuleAction | undefined {
  return state.publicRuleState.pendingActions.find((action) => (
    action.playerId === playerId
    && action.module.id === intent.module.id
    && action.module.version === intent.module.version
    && action.action === intent.action
    && isRecord(action.payload)
    && isRecord(intent.payload)
    && action.payload.optionId === intent.payload.optionId
  ));
}

function handleJailChoice(context: IntentExecutionContext): ApplyResult {
  const { state, playerId } = context;
  if (context.intent.type !== 'module') return { ok: false, code: 'ILLEGAL_INTENT' };
  if (state.turnPhase !== PRISON_DECISION_PHASE || state.debt !== null) {
    return { ok: false, code: 'WRONG_PHASE' };
  }

  const pending = matchingPendingAction(state, playerId, context.intent);
  if (!pending || !isRecord(pending.payload)) return { ok: false, code: 'WRONG_PHASE' };
  const choice = pending.payload.choice;
  if (choice !== 'roll' && choice !== 'card' && choice !== 'bail') {
    return { ok: false, code: 'ILLEGAL_INTENT' };
  }

  const prisonState = cleanPrisonState(state);
  const detention = prisonState.jailedByPlayerId[playerId];
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!detention || !player) return { ok: false, code: 'ILLEGAL_INTENT' };

  if (choice === 'card') return handleJailCardChoice(context, prisonState, player);
  if (choice === 'bail') return handleJailBailChoice(context, prisonState, player);
  return handleJailRollChoice(context, prisonState, player, detention);
}

/** 使用出狱许可证：立即出狱，本回合恢复正常掷骰（之后再按点数移动）。 */
function handleJailCardChoice(
  context: IntentExecutionContext,
  prisonState: PrisonPublicModuleState,
  player: PlayerState,
): ApplyResult {
  const { state, playerId } = context;
  const card = (prisonState.heldCardsByPlayerId[playerId] ?? [])[0];
  if (!card) return { ok: false, code: 'ILLEGAL_INTENT' };
  // 在押记录必须与棋子位置一致（cleanPrisonState 已保证），这里再确认一次以免损坏状态被消费。
  const jailCellId = prisonJailCellId(state.board);
  if (jailCellId === undefined || player.position !== jailCellId) {
    return { ok: false, code: 'ILLEGAL_INTENT' };
  }

  const consumed = consumeJailCard(state, playerId, prisonState, card);
  const released = removeFromJail(
    consumed.state,
    playerId,
    readPrisonState(consumed.state),
    PRISON_DECISION_PHASE,
  );
  const events: GameEvent[] = [
    ...consumed.events,
    moduleEvent('jail_exited_by_card', { playerId, deck: card.deck, cardId: card.cardId }),
  ];
  return { ok: true, state: withEvents(released, events), events };
}

/**
 * 缴纳保释金出狱（owner 2026-09-23 追加的机制，详见文件头第 4 条）。
 *
 * 扣 `jailBailCost` 付给银行（**不进任何玩家口袋**），立即出狱，并在本回合照常掷骰移动 ——
 * 与「使用出狱许可证」落到同一阶段（`awaiting_roll`），区别只是代价从「一张许可证」换成现金。
 * 除模块事件外补发一条 core 的 `bank_paid`（金额同为 `jailBailCost`）：保释金真的离开了牌桌，
 * 只有留下这条流水，simulate.ts 的现金守恒不变量（sum(玩家现金) + bankBalance === 初始资金 × 人数）
 * 才能逐局守衡。模块事件只是给客户端看的语义事件，不参与银行记账，因此不会重复计数。
 * 与 great-wall 的 `beacon_claimed`、world-tour 的付费换乘同属一套约定。
 *
 * 现金不足时返回 `INSUFFICIENT_FUNDS`：正常路径下引擎根本不会给出这个选项
 * （`jailChoiceActions` 已按现金过滤），走到这里只能是房间快照过期或客户端乱提交。
 */
function handleJailBailChoice(
  context: IntentExecutionContext,
  prisonState: PrisonPublicModuleState,
  player: PlayerState,
): ApplyResult {
  const { state, playerId } = context;
  const cost = bailCostOf(state.config);
  if (cost === undefined) return { ok: false, code: 'ILLEGAL_INTENT' };
  // 在押记录必须与棋子位置一致（cleanPrisonState 已保证），这里再确认一次以免损坏状态被消费。
  const jailCellId = prisonJailCellId(state.board);
  if (jailCellId === undefined || player.position !== jailCellId) {
    return { ok: false, code: 'ILLEGAL_INTENT' };
  }
  if (player.cash < cost) return { ok: false, code: 'INSUFFICIENT_FUNDS' };

  const paid: GameState = {
    ...state,
    players: state.players.map((candidate) => (
      candidate.id === playerId ? { ...candidate, cash: candidate.cash - cost } : candidate
    )),
  };
  const released = removeFromJail(paid, playerId, prisonState, PRISON_DECISION_PHASE);
  const events: GameEvent[] = [
    moduleEvent('jail_exited_by_bail', { playerId, cost }),
    // 保释金离开牌桌：按仓库既有约定补一条 bank_paid，否则现金守恒不变量会持续失配（simulate.ts）。
    { type: 'bank_paid', playerId, amount: cost },
  ];
  return { ok: true, state: withEvents(released, events), events };
}

/**
 * 掷骰尝试出狱。
 * 达标 → 立即出狱**并按该点数正常移动**、照常结算落点（owner 定案）。
 * 未达标 → 已用次数 +1，本回合不再移动（进入 `managing` 处理财务操作，然后自己结束回合）。
 */
function handleJailRollChoice(
  context: IntentExecutionContext,
  prisonState: PrisonPublicModuleState,
  player: PlayerState,
  detention: PrisonDetention,
): ApplyResult {
  const { state, playerId } = context;
  if (detention.attempts >= state.config.jailMaxAttempts) return { ok: false, code: 'WRONG_PHASE' };

  const [dice, nextSeed] = rollDice(Number(state.seed));
  const total = dice[0] + dice[1];
  const base: GameState = { ...state, seed: String(nextSeed), lastDice: dice };
  const rollEvents: GameEvent[] = [{ type: 'dice_rolled', playerId, dice }];

  if (total < state.config.jailExitMinRoll) {
    const attempts = detention.attempts + 1;
    const stayed = withIncrementedAttempts(base, playerId, prisonState, attempts, 'managing');
    const events: GameEvent[] = [
      ...rollEvents,
      moduleEvent('jail_roll_failed', {
        playerId,
        dice,
        total,
        attempts,
        attemptsLeft: Math.max(0, state.config.jailMaxAttempts - attempts),
      }),
    ];
    return { ok: true, state: withEvents(stayed, events), events };
  }

  // 达标：先摘掉在押状态，再按点数走棋并结算落点。
  const freed = removeFromJail(base, playerId, prisonState, 'managing');
  const walked = walkPath(freed.board, player.position, total);
  let cash = player.cash;
  const moveEvents: GameEvent[] = [...rollEvents, { type: 'token_moved', playerId, path: walked.path }];
  if (walked.crossedStart) {
    cash += freed.config.passStartSalary;
    moveEvents.push({ type: 'salary_collected', playerId, amount: freed.config.passStartSalary });
  }
  const moved: GameState = {
    ...freed,
    players: freed.players.map((candidate) => (
      candidate.id === playerId
        ? { ...candidate, position: walked.finalCellId, cash }
        : candidate
    )),
  };
  moveEvents.push(moduleEvent('jail_exited_by_roll', { playerId, dice, total }));

  // 落点结算必须把本次实际使用的注册表原样透传（landingFor 已绑定 context.registry）。
  const settled = landingFor(context)(withEvents(moved, moveEvents), playerId, moveEvents, 0);
  const win = finishCashGoalIfReached(settled.state, settled.events);
  const finalState = win?.state ?? settled.state;
  return {
    ok: true,
    state: {
      ...finalState,
      // 终局态不允许残留债务（hydrate 会拒绝），达标获胜时按 0 处理。
      debt: finalState.phase === 'game_over' ? null : settled.newDebt,
    },
    events: win?.events ?? settled.events,
  };
}

// ---------------------------------------------------------------------------
// 卡牌效果
// ---------------------------------------------------------------------------

/** `prison-confine`：进牢（抽到「进牢」卡）。 */
function applyPrisonConfine(context: ModuleEffectExecutionContext) {
  const jailCellId = prisonJailCellId(context.state.board);
  if (jailCellId === undefined) return context.applyCore();
  return confinePlayer(context.state, context.playerId, jailCellId, context.events);
}

/**
 * `prison-card`：获得一张出狱许可证，保留在手（可留到以后用）。
 * payload 为 `{ deck }`，卡面取自 `context.card.id`（就是抽到的那张）。
 * **不改 `state.decks`** —— 见文件头第 3 条硬约束。
 */
function applyPrisonCardGrant(context: ModuleEffectExecutionContext) {
  const payload = context.card.effect.payload;
  const deck = isRecord(payload) ? payload.deck : undefined;
  if (deck !== 'chance' && deck !== 'destiny') return context.applyCore();

  const cardId = context.card.id;
  if (!context.state.cards[deck].some((definition) => definition.id === cardId)) return context.applyCore();

  const prisonState = cleanPrisonState(context.state);
  const held = prisonState.heldCardsByPlayerId[context.playerId] ?? [];
  const next = withPrisonState(context.state, {
    jailedByPlayerId: prisonState.jailedByPlayerId,
    heldCardsByPlayerId: {
      ...prisonState.heldCardsByPlayerId,
      [context.playerId]: [...held, { deck, cardId }],
    },
  });
  const events: GameEvent[] = [
    ...context.events,
    moduleEvent('jail_card_granted', { playerId: context.playerId, deck, cardId }),
  ];
  return { state: withEvents(next, events), events, newDebt: context.state.debt };
}

// ---------------------------------------------------------------------------
// 机器人 / 托管策略
// ---------------------------------------------------------------------------

/** 机器人缴保释金后要留的现金安全垫：交完保释金还得有钱应付落点费用，否则不如继续掷骰。 */
export const BOT_BAIL_RESERVE = 1000;

/**
 * 在押且有选项时自己拿主意，优先级：出狱许可证（免费、必定成功）→ 缴纳保释金 → 掷骰。
 * 保释选项本身只在现金 ≥ 保释金时才会被摆出来，这里再额外要求一笔 `BOT_BAIL_RESERVE`：
 * 把现金全砸在出狱上、出门就因付不起过路费而破产，比多关两回合更糟。
 * 其余情况返回 `undefined`，交回既有决策链（`chooseTakeoverIntent` 的模块待选动作闸门也会兜底）。
 */
function chooseBotJailChoice(state: GameState, playerId: string): ModuleIntent | undefined {
  const options = state.publicRuleState.pendingActions.filter((action) => (
    action.playerId === playerId && isOwnAction(action)
  ));
  if (options.length === 0) return undefined;

  const toIntent = (action: PendingModuleAction | undefined): ModuleIntent | undefined => (
    action === undefined ? undefined : {
      type: 'module',
      module: action.module,
      action: action.action,
      payload: action.payload,
    }
  );
  const choiceOf = (action: PendingModuleAction): unknown => (
    isRecord(action.payload) ? action.payload.choice : undefined
  );
  const cardOption = options.find((action) => choiceOf(action) === 'card');
  if (cardOption !== undefined) return toIntent(cardOption);

  const bailCost = bailCostOf(state.config);
  const player = state.players.find((candidate) => candidate.id === playerId);
  const bailOption = options.find((action) => choiceOf(action) === 'bail');
  if (bailOption !== undefined && bailCost !== undefined && player !== undefined
    && player.cash - bailCost >= BOT_BAIL_RESERVE) {
    return toIntent(bailOption);
  }
  return toIntent(options.find((action) => choiceOf(action) === 'roll'));
}

// ---------------------------------------------------------------------------
// hydrate 严格校验
// ---------------------------------------------------------------------------

function isHeldCardRecord(value: unknown): value is PrisonHeldCard {
  return isRecord(value)
    && hasExactKeys(value, ['deck', 'cardId'])
    && (value.deck === 'chance' || value.deck === 'destiny')
    && typeof value.cardId === 'string'
    && value.cardId !== '';
}

/**
 * hydrate 用的严格校验：在押玩家必须是本局存活玩家、且棋子确实停在监狱角格上；`attempts` 必须是
 * 非负安全整数且不超过 `jailMaxAttempts`；出狱许可证必须指向牌堆里真实存在的卡。
 * 全部逐项验，避免损坏存档把 UI 与对局带偏（与 great-wall 的校验同一条标准）。
 */
export function validatePrisonPublicModuleState(
  value: unknown,
  board: { readonly cells: readonly unknown[] },
  players: readonly DeepReadonly<PlayerState>[],
  cards: {
    readonly chance: readonly { readonly id: string }[];
    readonly destiny: readonly { readonly id: string }[];
  },
  jailMaxAttempts: number,
): value is PrisonPublicModuleState {
  if (!isRecord(value) || !hasExactKeys(value, ['jailedByPlayerId', 'heldCardsByPlayerId'])) return false;
  if (!isRecord(value.jailedByPlayerId) || !isRecord(value.heldCardsByPlayerId)) return false;

  const jailCellId = prisonJailCellId(board);
  if (jailCellId === undefined && Object.keys(value.jailedByPlayerId).length > 0) return false;

  const playersById = new Map(players.map((player) => [player.id, player]));
  for (const [playerId, detention] of Object.entries(value.jailedByPlayerId)) {
    if (!isRecord(detention) || !hasExactKeys(detention, ['attempts'])) return false;
    const attempts = detention.attempts;
    if (!Number.isSafeInteger(attempts) || (attempts as number) < 0) return false;
    if ((attempts as number) > jailMaxAttempts) return false;
    const player = playersById.get(playerId);
    if (!player || player.bankrupt) return false;
    if (player.position !== jailCellId) return false;
  }

  for (const [playerId, held] of Object.entries(value.heldCardsByPlayerId)) {
    const player = playersById.get(playerId);
    if (!player || player.bankrupt) return false;
    if (!Array.isArray(held) || held.length === 0) return false;
    for (const card of held) {
      if (!isHeldCardRecord(card)) return false;
      if (!cards[card.deck].some((definition) => definition.id === card.cardId)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// 注册定义
// ---------------------------------------------------------------------------

const prisonRuleModuleInput: RuleModuleDefinition = {
  ref: PRISON_MODULE_REF,
  cellHandlers: [
    {
      type: 'module',
      cellType: PRISON_GOTO_JAIL_CELL_TYPE,
      handle: (context: CellSettlementContext) => {
        const jailCellId = prisonJailCellId(context.state.board);
        if (jailCellId === undefined) return context.applyCore();
        return confinePlayer(context.state, context.playerId, jailCellId, context.events);
      },
    },
    {
      type: 'module',
      cellType: PRISON_JAIL_CELL_TYPE,
      // 恰好停在监狱角格 = 探监 / 路过：只记一条日志，不产生任何费用，也不入狱。
      handle: (context: CellSettlementContext) => {
        const events: GameEvent[] = [
          ...context.events,
          moduleEvent('jail_visited', { playerId: context.playerId, jailCellId: context.cell.id }),
        ];
        const base = context.applyCore();
        return { state: withEvents(base.state, events), events, newDebt: base.newDebt };
      },
    },
  ],
  effectHandlers: [
    { type: 'module', effectType: PRISON_CONFINE_EFFECT_TYPE, handle: applyPrisonConfine },
    { type: 'module', effectType: PRISON_CARD_EFFECT_TYPE, handle: applyPrisonCardGrant },
  ],
  intentHandlers: [{
    type: 'module',
    action: PRISON_CHOICE_ACTION,
    handle: handleJailChoice,
  }],
  botStrategyHook: {
    decide: (context) => chooseBotJailChoice(context.state, context.playerId) ?? context.currentDecision,
  },
  postTransitionHook: {
    apply: (context) => {
      if (!context.result.ok) return context.result;
      const synced = synchronizePrisonState(context.result.state);
      if (synced.events.length === 0) {
        return synced.state === context.result.state
          ? context.result
          : { ...context.result, state: synced.state };
      }
      return {
        ...context.result,
        state: synced.state,
        events: [...context.result.events, ...synced.events],
      };
    },
  },
};

export const prisonRuleModuleDefinition = prisonRuleModuleInput;

/** 供其它模块 / 测试 / 服务端自动化使用的只读查询。 */
export function prisonIsDetained(state: GameState, playerId: string): boolean {
  return isDetained(state, playerId);
}

export function prisonAttemptsOf(state: GameState, playerId: string): number {
  return attemptsOf(state, playerId);
}

export function prisonHeldCardsOf(state: GameState, playerId: string): readonly PrisonHeldCard[] {
  return heldCardsOf(state, playerId);
}

/** 全部在押玩家的 playerId（按 modules 状态里的键序）。 */
export function prisonDetainedPlayerIds(state: GameState): string[] {
  return Object.keys(readPrisonState(state).jailedByPlayerId);
}

/** 当前在押玩家是否正处在「必须选择如何出狱」的阶段。 */
export function prisonAwaitsDecision(state: GameState): boolean {
  return state.turnPhase === PRISON_DECISION_PHASE && isDetained(state, state.currentPlayerId);
}

/** 本图的保释金；非监狱图（config 里没有有效 `jailBailCost`）返回 `undefined` = 不提供保释。 */
export function prisonBailCost(state: GameState): number | undefined {
  return bailCostOf(state.config);
}
