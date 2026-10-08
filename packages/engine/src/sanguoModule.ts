// 规则模块 `sanguo@1`：三国风云（屯兵粮草 · 战场厮杀 · 招兵买马人物卡）
//
// 机制（core 与其余 10 个模块都没有的「军粮投资 + 人物卡」玩法）：
//   · **屯兵（粮草）**：地图上 2 个 `battle` 模块格是「战场」（官渡之战 / 赤壁之战）。
//     落到战场格可以**屯兵**——支付 2000 两换 1 份粮草（`supplyByPlayerId`，上限 12 份）。
//     粮草的**唯一硬通货用途**是犒军升级：花 2 份粮草，让自己任意一座**已建成城池**免费升一级
//     （`level + 1`，maxHouseLevel=3 ⇒ 兵营两级 + 城池一级，与实物产权纸的四档过路费一一对应）。
//     粮草还有一条**被动出口**：每份粮草在交过路费时减免 10%（单次最多减 300，取 10 的倍数），
//     靠 `positiveRentHook` 生效。于是「屯兵」不是存款而是**投资**：粮草既能换升级、又能长期减租。
//   · **出阵厮杀**：战场格的第二个选项。`pickRandomIndex` 掷一次（胜 1/2），
//     胜得 2000 两（`bank_received`），负付 1000 两；现金不够时转 core 的 `debt` 流程。
//     招兵买马「吕布」给的 `battleShieldByPlayerId` 可以**免厮杀**（免掉则不生成该选项）。
//   · **功德祠**：2 个 `shrine` 模块格。付 800 两上一炷香，此后**每落一次战场格**额外得 300 两
//     香火钱。这是「先付一笔、之后每场战斗都回血」的长线投入。
//     `incenseByPlayerId` 记的是「是否已上香」（0/1，上限 1）：收益是**每次落战场**都发，
//     与上香次数无关，重复上香只是重复付 800 两，所以一人只允许一炷香。
//   · **招兵买马 12 张人物卡**（chance 牌堆）与 **锦囊妙计 15 张**（destiny 牌堆）：
//     **抽卡本身完全交给 core** —— 棋盘上这两个格是 core 的 `chance` / `destiny` 格，
//     洗牌、补底、`card_drawn` 事件、递归深度上限都由 `applyCardEffect` 负责（已充分测试）。
//     卡面效果若需要新机制，走本模块的 6 个 effectHandler：
//     `sanguo-grant`（发奖/罚金）、`sanguo-shield`（免 N 场厮杀）、`sanguo-swap`（与最远对手换位）、
//     `sanguo-fortify`（免费建一座城池）、`sanguo-freeze`（暂停一次）、`sanguo-supply`（白得粮草）。
//     本模块**不自己维护牌堆** —— 少一份状态就少一处 hydrate 风险。
//
// 记账契约（与 piaohao 同一标准）：**模块扣走玩家现金、但钱不进任何玩家口袋时，
// 必须补发一条 core 的 `bank_paid`**；模块凭空发钱时必须发 `bank_received`。
// 否则 simulate.ts 的「sum(cash) + bankBalance === initialCash × 人数」不变量会被打破。
// 本文件里每一处现金变动都成对写了这两条（`grep -n "cash:" sanguoModule.ts` 可自查）。
//
// 与既有模块一致的两条硬约束（见 piaohaoModule.ts 文件头）：
//   1) 同一时刻的待选动作必须是同一个 `模块@版本:动作`；分支放在 `payload.kind`。
//   2) 待选动作的 requiredPhase 必须等于当时的 turnPhase，playerId 必须是当前玩家。
// 待选动作只在**落点结算时**生成一次；postTransitionHook 只做清理，不重新生成选项
// （否则「按兵不动」会被立刻摆回来，形成点不完的循环 —— great-wall 已踩过这个坑）。
import type { DeepReadonly, JsonValue, ModuleCell, RuleModuleRef } from '@richman/board-data';
import type { ApplyResult, GameEvent, GameState, PendingModuleAction, PlayerState } from './types';
import type {
  IntentExecutionContext,
  ModuleEffectExecutionContext,
  PositiveRentContext,
  PositiveRentResult,
  RuleEffectResult,
  RuleModuleDefinition,
} from './moduleRegistry';
import { finishCashGoalIfReached } from './moduleToolkit';
import { isRecord, moduleEventFor, pickRandomIndex, withRawModuleState } from './moduleSupport';
import { processQueuedPayments } from './payments';

export const SANGUO_MODULE_REF = Object.freeze({ id: 'sanguo', version: 1 }) satisfies RuleModuleRef;
export const SANGUO_MODULE_KEY = 'sanguo@1';

/** 屯兵一次支付的军饷（实物规则书：「屯兵：支付 2000 两 获得粮草」）。 */
export const TUNBIN_COST = 2000;
/** 粮草份数上限：屯满后战场格只提供「犒军升级 / 出阵厮杀 / 按兵不动」。 */
export const SUPPLY_CAP = 12;
/** 犒军升级消耗的粮草份数。 */
export const UPGRADE_SUPPLY_COST = 2;
/** 上香费用与每次落战场格的香火钱。 */
export const INCENSE_COST = 800;
export const INCENSE_PAYOUT = 300;
/** 每份粮草减免的过路费比例、单次减免上限与取整粒度。 */
export const SUPPLY_RELIEF_RATE = 0.1;
export const SUPPLY_RELIEF_CAP = 300;
const RELIEF_ROUNDING = 10;

/** 出阵厮杀的胜负金额。 */
export const SKIRMISH_WIN = 2000;
export const SKIRMISH_LOSS = 1000;
/** 机器人屯兵时保留的周转现金。 */
const BOT_TUNBIN_RESERVE = 1500;
/** 机器人上香时保留的周转现金。 */
const BOT_INCENSE_RESERVE = 2000;

const CELL_BATTLE = 'battle';
const CELL_SHRINE = 'shrine';

const KIND_TUNBIN = 'tunbin';
const KIND_UPGRADE = 'upgrade';
const KIND_SKIRMISH = 'skirmish';
const KIND_WAIT = 'wait';
const KIND_INCENSE = 'incense';
const KIND_SALUTE = 'salute';

const ACTION_BATTLE_CHOICE = 'sanguo-battle-choice';
const ACTION_SHRINE_CHOICE = 'sanguo-shrine-choice';

/** 本模块的两种 cellType（供 mapValidation 的白名单与单测引用）。 */
export const SANGUO_CELL_TYPES = Object.freeze([CELL_BATTLE, CELL_SHRINE]);

export interface SanguoPublicModuleState {
  /** playerId → 粮草份数（正整数，上限 SUPPLY_CAP）。 */
  readonly supplyByPlayerId: Readonly<Record<string, number>>;
  /** playerId → 尚可免除的战场厮杀次数（「吕布」给的，最多 2 次）。 */
  readonly battleShieldByPlayerId: Readonly<Record<string, number>>;
  /** playerId → 累计上香次数（每落一次战场格按此数发一次香火钱）。 */
  readonly incenseByPlayerId: Readonly<Record<string, number>>;
}

/** 上香次数上限：1 —— 功德祠的收益是「每落一次战场格得香火钱」的**长线**投入，
 *  重复上香只是重复付 800 两，不叠任何效果，因此一人只允许一炷香（避免玩家白砸钱）。 */
const INCENSE_CAP = 1;
const SHIELD_CAP = 2;

function emptySanguoState(): SanguoPublicModuleState {
  return { supplyByPlayerId: {}, battleShieldByPlayerId: {}, incenseByPlayerId: {} };
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function readCounterMap(value: unknown, cap: number): Record<string, number> {
  if (!isRecord(value)) return {};
  const out: Record<string, number> = {};
  for (const [playerId, amount] of Object.entries(value)) {
    if (isPositiveInt(amount) && amount <= cap) out[playerId] = amount;
  }
  return out;
}

/**
 * 读本模块公共状态。三张计数表**逐项丢弃非法值**而非整体拒绝：
 * hydrate 走下面的严格校验，运行期读状态走宽容清洗（与 piaohao 同一标准）。
 */
export function readSanguoState(state: GameState): SanguoPublicModuleState {
  const raw = state.publicRuleState.modules[SANGUO_MODULE_KEY];
  if (!isRecord(raw)) return emptySanguoState();
  return {
    supplyByPlayerId: readCounterMap(raw.supplyByPlayerId, SUPPLY_CAP),
    battleShieldByPlayerId: readCounterMap(raw.battleShieldByPlayerId, SHIELD_CAP),
    incenseByPlayerId: readCounterMap(raw.incenseByPlayerId, INCENSE_CAP),
  };
}

function hasSanguoState(value: SanguoPublicModuleState): boolean {
  return Object.keys(value.supplyByPlayerId).length > 0
    || Object.keys(value.battleShieldByPlayerId).length > 0
    || Object.keys(value.incenseByPlayerId).length > 0;
}

function withSanguoState(
  state: GameState,
  sanguoState: SanguoPublicModuleState,
  pendingActions: readonly PendingModuleAction[] = state.publicRuleState.pendingActions,
): GameState {
  return withRawModuleState(
    state,
    SANGUO_MODULE_KEY,
    hasSanguoState(sanguoState) ? (sanguoState as unknown as JsonValue) : null,
    pendingActions,
  );
}

function event(eventType: string, payload: JsonValue): GameEvent {
  return moduleEventFor(SANGUO_MODULE_REF, eventType, payload);
}

function getPlayer(state: GameState, playerId: string): PlayerState | undefined {
  return state.players.find((candidate) => candidate.id === playerId);
}

function withCash(state: GameState, playerId: string, cash: number): GameState {
  return {
    ...state,
    players: state.players.map((candidate) => (
      candidate.id === playerId ? { ...candidate, cash: Math.max(0, cash) } : candidate
    )),
  };
}

/** 丢弃已离场玩家的账目（破产 / 投降者不再持有粮草、免战、上香记录）。 */
function cleanSanguoState(state: GameState): SanguoPublicModuleState {
  const current = readSanguoState(state);
  const alive = new Set(state.players.filter((player) => !player.bankrupt).map((player) => player.id));
  const keep = (table: Readonly<Record<string, number>>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [playerId, amount] of Object.entries(table)) {
      if (alive.has(playerId)) out[playerId] = amount;
    }
    return out;
  };
  return {
    supplyByPlayerId: keep(current.supplyByPlayerId),
    battleShieldByPlayerId: keep(current.battleShieldByPlayerId),
    incenseByPlayerId: keep(current.incenseByPlayerId),
  };
}

function isSanguoCell(cell: DeepReadonly<ModuleCell> | undefined, cellType: string): boolean {
  return cell?.type === 'module'
    && cell.module.id === SANGUO_MODULE_REF.id
    && cell.module.version === SANGUO_MODULE_REF.version
    && cell.cellType === cellType;
}

export function isSanguoBattleCell(cell: DeepReadonly<ModuleCell> | undefined): boolean {
  return isSanguoCell(cell, CELL_BATTLE);
}

export function isSanguoShrineCell(cell: DeepReadonly<ModuleCell> | undefined): boolean {
  return isSanguoCell(cell, CELL_SHRINE);
}

/** 本模块两种模块格的 payload 一律必须是空对象（所有参数都是模块常量）。 */
export function isSanguoCellPayload(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

/** 抽出本模块的全部模块格（按棋盘数组顺序）。 */
export function sanguoCells(board: { readonly cells: readonly unknown[] }): DeepReadonly<ModuleCell>[] {
  const out: DeepReadonly<ModuleCell>[] = [];
  for (const candidate of board.cells) {
    const cell = candidate as DeepReadonly<ModuleCell>;
    if (isSanguoBattleCell(cell) || isSanguoShrineCell(cell)) out.push(cell);
  }
  return out;
}

function isOwnAction(action: PendingModuleAction): boolean {
  return action.module.id === SANGUO_MODULE_REF.id
    && action.module.version === SANGUO_MODULE_REF.version;
}

// === 过路费减免（positiveRentHook）===

/**
 * 粮草的被动出口：每份粮草减免 10% 过路费，单次最多减 300，且减免额取 10 的倍数
 * （避免出现 137 这种零头租金）。`runPositiveRentHooks` 改 `amount` 即改实收租金，
 * core 随后按 `effectiveToll` 收钱并把 `amount - effectiveToll` 记给地主。
 */
function applySupplyRelief(
  state: GameState,
  playerId: string,
  amount: number,
): { amount: number; relief: number } {
  const supply = readSanguoState(state).supplyByPlayerId[playerId] ?? 0;
  if (supply <= 0 || amount <= 0) return { amount, relief: 0 };
  const rawRelief = Math.min(SUPPLY_RELIEF_CAP, Math.floor(amount * SUPPLY_RELIEF_RATE * supply));
  if (rawRelief <= 0) return { amount, relief: 0 };
  const relief = Math.min(amount, Math.floor(rawRelief / RELIEF_ROUNDING) * RELIEF_ROUNDING);
  return relief > 0 ? { amount: amount - relief, relief } : { amount, relief: 0 };
}

// === 城池工具 ===

/** 该玩家名下是否还有可升级的城池（level < maxHouseLevel 且未抵押）。 */
function hasUpgradableProperty(state: GameState, playerId: string): boolean {
  for (const cell of state.board.cells) {
    if (cell.type !== 'property' || cell.subtype !== 'normal') continue;
    const owned = state.properties[cell.id];
    if (owned && owned.ownerId === playerId && !owned.mortgaged && owned.level < state.config.maxHouseLevel) {
      return true;
    }
  }
  return false;
}

/**
 * 「犒军升级」的目标：先挑 level 低的（保证粮草能一路把它升满），同 level 取地价高的。
 * 与 {@link pickFortifyTarget} 的差别是**方向相反**：升级要「从低往高推满」，
 * 而「免费建一座城池」要「在已有兵营上直接落成城池」。
 */
function pickUpgradeTarget(state: GameState, playerId: string): number | null {
  let best: { cellId: number; level: number; price: number } | null = null;
  for (const cell of state.board.cells) {
    if (cell.type !== 'property' || cell.subtype !== 'normal') continue;
    const owned = state.properties[cell.id];
    if (!owned || owned.ownerId !== playerId || owned.mortgaged) continue;
    if (owned.level >= state.config.maxHouseLevel) continue;
    if (best === null || owned.level < best.level
      || (owned.level === best.level && cell.price > best.price)) {
      best = { cellId: cell.id, level: owned.level, price: cell.price };
    }
  }
  return best?.cellId ?? null;
}

/**
 * 「免费建一座城池」（孙策 / 周瑜）的目标：**优先 level 最高**的那座。
 *
 * 卡面承诺的是「一座城池」而不是「一座兵营」，所以从已有兵营（level>=1）往上加才兑现承诺；
 * 同 level 取地价高的（升一级后过路费涨得多）。名下没有任何可加的领地时返回 null，
 * 由调用方退化成「无事发生」——卡面写的是建城，不是发钱。
 */
function pickFortifyTarget(state: GameState, playerId: string): number | null {
  let best: { cellId: number; level: number; price: number } | null = null;
  for (const cell of state.board.cells) {
    if (cell.type !== 'property' || cell.subtype !== 'normal') continue;
    const owned = state.properties[cell.id];
    if (!owned || owned.ownerId !== playerId || owned.mortgaged) continue;
    if (owned.level >= state.config.maxHouseLevel) continue;
    if (best === null || owned.level > best.level
      || (owned.level === best.level && cell.price > best.price)) {
      best = { cellId: cell.id, level: owned.level, price: cell.price };
    }
  }
  return best?.cellId ?? null;
}

function withPropertyLevel(state: GameState, cellId: number, ownerId: string, level: number): GameState {
  const existing = state.properties[cellId] ?? { ownerId, level: 0, mortgaged: false };
  return { ...state, properties: { ...state.properties, [cellId]: { ...existing, level } } };
}

// === 战场格 ===

function battleOptionId(state: GameState, playerId: string, cellId: number, kind: string): string {
  return `${SANGUO_MODULE_KEY}:${ACTION_BATTLE_CHOICE}:${playerId}:${state.turn}:${cellId}:${kind}`;
}

function battleChoiceAction(
  state: GameState,
  playerId: string,
  cellId: number,
  kind: string,
  label: string,
): PendingModuleAction {
  const optionId = battleOptionId(state, playerId, cellId, kind);
  return {
    optionId,
    module: SANGUO_MODULE_REF,
    playerId,
    requiredPhase: 'managing',
    label,
    action: ACTION_BATTLE_CHOICE,
    payload: { optionId, cellId, kind },
  };
}

function battleChoiceActions(
  state: GameState,
  sanguoState: SanguoPublicModuleState,
  player: PlayerState,
  cellId: number,
): PendingModuleAction[] {
  const supply = sanguoState.supplyByPlayerId[player.id] ?? 0;
  const shield = sanguoState.battleShieldByPlayerId[player.id] ?? 0;
  const actions: PendingModuleAction[] = [];

  if (player.cash >= TUNBIN_COST && supply < SUPPLY_CAP) {
    actions.push(battleChoiceAction(
      state,
      player.id,
      cellId,
      KIND_TUNBIN,
      `屯兵（付 ${TUNBIN_COST} 两换 1 份粮草）`,
    ));
  }
  if (supply >= UPGRADE_SUPPLY_COST && hasUpgradableProperty(state, player.id)) {
    actions.push(battleChoiceAction(
      state,
      player.id,
      cellId,
      KIND_UPGRADE,
      `犒军升级（付 ${UPGRADE_SUPPLY_COST} 份粮草，免费升一级城池）`,
    ));
  }
  // 有免战次数时不生成厮杀选项：免掉的那场就是「不必再打」，直接按兵不动即可。
  if (shield <= 0) {
    actions.push(battleChoiceAction(
      state,
      player.id,
      cellId,
      KIND_SKIRMISH,
      `出阵厮杀（胜得 ${SKIRMISH_WIN} 两，负付 ${SKIRMISH_LOSS} 两）`,
    ));
  }
  actions.push(battleChoiceAction(state, player.id, cellId, KIND_WAIT, '按兵不动'));
  return actions;
}

/** 战场格落点：先给上香玩家发香火钱，再摆出战场选项（把阶段归到 managing）。 */
function settleBattleLanding(
  context: Parameters<RuleModuleDefinition['cellHandlers'][number]['handle']>[0],
): RuleEffectResult {
  const cell = context.cell as DeepReadonly<ModuleCell>;
  const player = getPlayer(context.state, context.playerId);
  if (!player || player.position !== cell.id || !isSanguoCellPayload(cell.payload)) {
    return context.applyCore();
  }

  const cleaned = cleanSanguoState(context.state);
  const incenseCount = cleaned.incenseByPlayerId[player.id] ?? 0;
  let next = context.state;
  const events: GameEvent[] = [event('sanguo_battle_landed', { playerId: player.id, cellId: cell.id })];

  if (incenseCount > 0) {
    events.push(event('sanguo_incense_paid', {
      playerId: player.id,
      cellId: cell.id,
      incenseCount,
      amount: INCENSE_PAYOUT,
    }));
    events.push({ type: 'bank_received', playerId: player.id, amount: INCENSE_PAYOUT });
    next = withCash(next, player.id, player.cash + INCENSE_PAYOUT);
  }

  const base = withSanguoState(next, cleaned);
  const payer = getPlayer(base, player.id) ?? player;
  const actions = battleChoiceActions(base, cleaned, payer, cell.id);
  const state: GameState = {
    ...base,
    turnPhase: 'managing',
    publicRuleState: {
      ...base.publicRuleState,
      pendingActions: [
        ...base.publicRuleState.pendingActions.filter((action) => action.playerId !== player.id),
        ...actions,
      ],
    },
  };
  return { state, events: [...context.events, ...events], newDebt: state.debt };
}

// === 功德祠格 ===

function shrineOptionId(state: GameState, playerId: string, cellId: number, kind: string): string {
  return `${SANGUO_MODULE_KEY}:${ACTION_SHRINE_CHOICE}:${playerId}:${state.turn}:${cellId}:${kind}`;
}

function shrineChoiceAction(
  state: GameState,
  playerId: string,
  cellId: number,
  kind: string,
  label: string,
): PendingModuleAction {
  const optionId = shrineOptionId(state, playerId, cellId, kind);
  return {
    optionId,
    module: SANGUO_MODULE_REF,
    playerId,
    requiredPhase: 'managing',
    label,
    action: ACTION_SHRINE_CHOICE,
    payload: { optionId, cellId, kind },
  };
}

function settleShrineLanding(
  context: Parameters<RuleModuleDefinition['cellHandlers'][number]['handle']>[0],
): RuleEffectResult {
  const cell = context.cell as DeepReadonly<ModuleCell>;
  const player = getPlayer(context.state, context.playerId);
  if (!player || player.position !== cell.id || !isSanguoCellPayload(cell.payload)) {
    return context.applyCore();
  }

  const cleaned = cleanSanguoState(context.state);
  const actions: PendingModuleAction[] = [];
  // 已上香者不再重复卖「上香」：收益不叠加，再付 800 两是纯浪费（选项恒为「不祈福」）。
  if ((cleaned.incenseByPlayerId[player.id] ?? 0) === 0 && player.cash >= INCENSE_COST) {
    actions.push(shrineChoiceAction(
      context.state,
      player.id,
      cell.id,
      KIND_INCENSE,
      `上香祈福（付 ${INCENSE_COST} 两，此后每落战场格得 ${INCENSE_PAYOUT} 两）`,
    ));
  }
  actions.push(shrineChoiceAction(context.state, player.id, cell.id, KIND_SALUTE, '不祈福（不付香火钱）'));

  const state = withSanguoState(
    { ...context.state, turnPhase: 'managing' },
    cleaned,
    [
      ...context.state.publicRuleState.pendingActions.filter((action) => action.playerId !== player.id),
      ...actions,
    ],
  );
  return {
    state,
    events: [...context.events, event('sanguo_shrine_landed', { playerId: player.id, cellId: cell.id })],
    newDebt: state.debt,
  };
}

// === 待选动作有效性 ===

function isValidOwnChoice(
  state: GameState,
  action: PendingModuleAction,
  actionName: string,
  expectedCellType: string,
): boolean {
  if (action.playerId !== state.currentPlayerId) return false;
  if (action.requiredPhase !== state.turnPhase || state.debt !== null) return false;
  if (action.action !== actionName || !isRecord(action.payload)) return false;
  // 先把 cellId 收进局部常量：isRecord 的收窄不会跨闭包传递给Array.find 的回调，
  // 在回调里再读 action.payload.cellId 会退回 JsonValue（TS18047/TS2339）。
  const cellId = action.payload.cellId;
  if (!Number.isSafeInteger(cellId)) return false;
  const player = getPlayer(state, action.playerId);
  if (!player || player.bankrupt) return false;
  if (player.position !== cellId) return false;
  const cell = state.board.cells.find((candidate) => candidate.id === cellId);
  if (cell === undefined || cell.type !== 'module') return false;
  return isSanguoCell(cell as DeepReadonly<ModuleCell>, expectedCellType);
}

function withoutPlayerSanguoActions(state: GameState, playerId: string): GameState {
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

/** 取出本模块某个待选动作的 payload（校验归属 + optionId 匹配）。 */
function matchOwnChoice(
  state: GameState,
  playerId: string,
  actionName: string,
  expectedCellType: string,
  intent: IntentExecutionContext['intent'],
): { cellId: number; kind: string } | null {
  if (intent.type !== 'module' || !isRecord(intent.payload)) return null;
  const intentOptionId = intent.payload.optionId;
  const pending = state.publicRuleState.pendingActions.find((action) => (
    action.playerId === playerId
    && isOwnAction(action)
    && action.action === actionName
    && isRecord(action.payload)
    // 同上：optionId 先取出来，闭包里只比这个局部值。
    && action.payload.optionId === intentOptionId
  ));
  if (pending === undefined || !isRecord(pending.payload)) return null;
  if (!isValidOwnChoice(state, pending, actionName, expectedCellType)) return null;
  const cellId = pending.payload.cellId;
  const kind = pending.payload.kind;
  if (typeof cellId !== 'number' || !Number.isSafeInteger(cellId) || typeof kind !== 'string') return null;
  return { cellId, kind };
}

// === 战场选择结算 ===

function handleBattleChoice(state: GameState, playerId: string, intent: IntentExecutionContext['intent']): ApplyResult {
  if (state.turnPhase !== 'managing') return { ok: false, code: 'WRONG_PHASE' };
  const matched = matchOwnChoice(state, playerId, ACTION_BATTLE_CHOICE, CELL_BATTLE, intent);
  if (matched === null) return { ok: false, code: 'ILLEGAL_INTENT' };
  const { cellId, kind } = matched;

  const player = getPlayer(state, playerId);
  if (!player || player.bankrupt) return { ok: false, code: 'ILLEGAL_INTENT' };

  const cleanState = withoutPlayerSanguoActions(state, playerId);
  const sanguoState = cleanSanguoState(state);
  const supply = sanguoState.supplyByPlayerId[playerId] ?? 0;
  const shield = sanguoState.battleShieldByPlayerId[playerId] ?? 0;
  const finish = (nextState: GameState, events: GameEvent[]): ApplyResult => ({
    ok: true,
    state: { ...nextState, turnPhase: 'managing', recentLog: [...state.recentLog, ...events].slice(-200) },
    events,
  });

  if (kind === KIND_WAIT) {
    return finish(
      withSanguoState(cleanState, sanguoState),
      [event('sanguo_battle_waited', { playerId, cellId })],
    );
  }

  if (kind === KIND_TUNBIN) {
    if (player.cash < TUNBIN_COST) return { ok: false, code: 'INSUFFICIENT_FUNDS' };
    if (supply >= SUPPLY_CAP) return { ok: false, code: 'ILLEGAL_INTENT' };
    const events: GameEvent[] = [
      event('sanguo_tunbinned', { playerId, cellId, amount: TUNBIN_COST, supply: supply + 1 }),
      // 军饷离开牌桌进国库，账面等同付给银行（记账契约，见文件头）。
      { type: 'bank_paid', playerId, amount: TUNBIN_COST },
    ];
    const next = withSanguoState(
      withCash(cleanState, playerId, player.cash - TUNBIN_COST),
      {
        ...sanguoState,
        supplyByPlayerId: { ...sanguoState.supplyByPlayerId, [playerId]: supply + 1 },
      },
    );
    return finish(next, events);
  }

  if (kind === KIND_UPGRADE) {
    if (supply < UPGRADE_SUPPLY_COST) return { ok: false, code: 'ILLEGAL_INTENT' };
    const target = pickUpgradeTarget(state, playerId);
    if (target === null) return { ok: false, code: 'ILLEGAL_INTENT' };
    const nextLevel = (state.properties[target]?.level ?? 0) + 1;
    const events: GameEvent[] = [
      event('sanguo_upgraded', {
        playerId,
        cellId: target,
        level: nextLevel,
        supply: supply - UPGRADE_SUPPLY_COST,
      }),
      // amount=0：粮草付的，不是现金。
      { type: 'house_built', cellId: target, level: nextLevel, amount: 0 },
    ];
    return finish(
      withSanguoState(
        withPropertyLevel(cleanState, target, playerId, nextLevel),
        {
          ...sanguoState,
          supplyByPlayerId: decrement(sanguoState.supplyByPlayerId, playerId, UPGRADE_SUPPLY_COST),
        },
      ),
      events,
    );
  }

  if (kind === KIND_SKIRMISH) {
    if (shield > 0) return { ok: false, code: 'ILLEGAL_INTENT' };
    // 厮杀用 seed 推进的确定性随机：同 seed 全局可复现（与 riverTideModule 同一做法）。
    const picked = pickRandomIndex(state, 2);
    if (picked === null) {
      return finish(
        withSanguoState(cleanState, sanguoState),
        [event('sanguo_skirmish_draw', { playerId, cellId })],
      );
    }
    if (picked.index === 0) {
      const events: GameEvent[] = [
        event('sanguo_skirmished', { playerId, cellId, won: true, amount: SKIRMISH_WIN }),
        { type: 'bank_received', playerId, amount: SKIRMISH_WIN },
      ];
      const next = withSanguoState(
        withCash({ ...cleanState, seed: picked.seed }, playerId, player.cash + SKIRMISH_WIN),
        sanguoState,
      );
      const win = finishCashGoalIfReached(next, events);
      return finish(win?.state ?? next, win?.events ?? events);
    }
    // 战败：缴清已有现金，不足部分进 core 债务队列（与 core 的 pay_bank 同一套流程）。
    //刻意走 processQueuedPayments 而不是手写 bank_paid + debt_entered：
    // 意图处理器不会经过 payDebtIfPossible，debt 必须由本函数自己写进 state.debt，
    // 否则事件说「欠 1000」而状态里没有债务 —— 玩家白欠一次、后续回合也不会被冻结。
    const lossEvents: GameEvent[] = [
      event('sanguo_skirmished', { playerId, cellId, won: false, amount: SKIRMISH_LOSS }),
    ];
    const paid = processQueuedPayments(
      { ...cleanState, seed: picked.seed },
      [{ debtorId: playerId, creditorId: null, amount: SKIRMISH_LOSS }],
      lossEvents,
    );
    return finish(
      withSanguoState({ ...paid.state, debt: paid.newDebt }, sanguoState),
      paid.events,
    );
  }

  return { ok: false, code: 'ILLEGAL_INTENT' };
}

/** 计数表按 key 减 delta，归零时删键（与 piaohao 的取现删键同一标准）。 */
function decrement(table: Readonly<Record<string, number>>, key: string, delta: number): Record<string, number> {
  const rest = { ...table };
  const next = (rest[key] ?? 0) - delta;
  if (next <= 0) delete rest[key];
  else rest[key] = next;
  return rest;
}

/** 计数表按 key 加 delta，超过上限时截断（卡面写「免二场」但玩家已有 1 次免战时只加 1）。 */
function bump(
  table: Readonly<Record<string, number>>,
  key: string,
  delta: number,
  cap: number,
): Record<string, number> {
  const next = { ...table };
  const value = Math.min(cap, (next[key] ?? 0) + delta);
  if (value > 0) next[key] = value;
  return next;
}

// === 功德祠选择结算 ===

function handleShrineChoice(state: GameState, playerId: string, intent: IntentExecutionContext['intent']): ApplyResult {
  if (state.turnPhase !== 'managing') return { ok: false, code: 'WRONG_PHASE' };
  const matched = matchOwnChoice(state, playerId, ACTION_SHRINE_CHOICE, CELL_SHRINE, intent);
  if (matched === null) return { ok: false, code: 'ILLEGAL_INTENT' };
  const { cellId, kind } = matched;

  const player = getPlayer(state, playerId);
  if (!player || player.bankrupt) return { ok: false, code: 'ILLEGAL_INTENT' };

  const cleanState = withoutPlayerSanguoActions(state, playerId);
  const sanguoState = cleanSanguoState(state);
  const finish = (nextState: GameState, events: GameEvent[]): ApplyResult => ({
    ok: true,
    state: { ...nextState, turnPhase: 'managing', recentLog: [...state.recentLog, ...events].slice(-200) },
    events,
  });

  if (kind === KIND_SALUTE) {
    return finish(
      withSanguoState(cleanState, sanguoState),
      [event('sanguo_saluted', { playerId, cellId })],
    );
  }

  if (kind === KIND_INCENSE) {
    if (player.cash < INCENSE_COST) return { ok: false, code: 'INSUFFICIENT_FUNDS' };
    if ((sanguoState.incenseByPlayerId[playerId] ?? 0) > 0) return { ok: false, code: 'ILLEGAL_INTENT' };
    const nextCount = (sanguoState.incenseByPlayerId[playerId] ?? 0) + 1;
    const events: GameEvent[] = [
      event('sanguo_incensed', { playerId, cellId, amount: INCENSE_COST, incenseCount: nextCount }),
      { type: 'bank_paid', playerId, amount: INCENSE_COST },
    ];
    return finish(
      withSanguoState(withCash(cleanState, playerId, player.cash - INCENSE_COST), {
        ...sanguoState,
        incenseByPlayerId: bump(sanguoState.incenseByPlayerId, playerId, 1, INCENSE_CAP),
      }),
      events,
    );
  }

  return { ok: false, code: 'ILLEGAL_INTENT' };
}

// === 人物卡 / 锦囊卡效果（effectHandlers）===

/** 从模块卡的 payload 里读一个正安全整数金额。 */
function readAmount(payload: unknown, field = 'amount'): number | null {
  if (!isRecord(payload)) return null;
  const value = payload[field];
  return isPositiveInt(value) ? value : null;
}

function finishEffect(
  state: GameState,
  context: { readonly events: readonly GameEvent[] },
  nextState: GameState,
  events: GameEvent[],
): RuleEffectResult {
  const win = finishCashGoalIfReached(nextState, events);
  const finalState = win?.state ?? nextState;
  const finalEvents = win?.events ?? events;
  return {
    state: { ...finalState, recentLog: [...finalState.recentLog, ...finalEvents].slice(-200) },
    events: [...context.events, ...finalEvents],
    newDebt: finalState.debt,
  };
}

/**
 * `sanguo-grant`：发奖 / 罚金。payload `{ amount }`，amount 为正数。
 * 实物人物卡里「奖 2000」（赵云 / 关羽）、「奖 1200」（华佗）、「罚 3000」（马谡）、
 * 「罚 2000」（张飞）都归到这一个效果，方向由 `kind` 区分：
 * `kind: 'reward'` 进钱（`bank_received`），`kind: 'penalty'` 出钱（`bank_paid`）。
 */
function applyGrant(context: ModuleEffectExecutionContext): RuleEffectResult {
  const amount = readAmount(context.card.effect.payload);
  if (amount === null) return context.applyCore();
  const player = getPlayer(context.state, context.playerId);
  if (!player || player.bankrupt) return context.applyCore();

  const kind = isRecord(context.card.effect.payload) ? context.card.effect.payload.kind : undefined;
  if (kind === 'penalty') {
    // 罚金与 core 的 pay_bank 同一套：现金不够时差额进债务队列（不设「付不清就免单」的后门）。
    const events: GameEvent[] = [event('sanguo_penalized', { playerId: context.playerId, amount })];
    const paid = processQueuedPayments(
      context.state,
      [{ debtorId: context.playerId, creditorId: null, amount }],
      events,
    );
    return finishEffect(context.state, context, { ...paid.state, debt: paid.newDebt }, paid.events);
  }

  const events: GameEvent[] = [
    event('sanguo_granted', { playerId: context.playerId, amount }),
    { type: 'bank_received', playerId: context.playerId, amount },
  ];
  return finishEffect(
    context.state,
    context,
    withCash(context.state, context.playerId, player.cash + amount),
    events,
  );
}

/**
 * `sanguo-shield`：免 N 场厮杀（吕布「免二场厮杀」）。上限 SHIELD_CAP = 2，
 * 超出的部分直接丢弃——否则一张卡就能让某人永久免战，模块会退化成「无敌」键。
 */
function applyShield(context: ModuleEffectExecutionContext): RuleEffectResult {
  const count = readAmount(context.card.effect.payload, 'battles');
  if (count === null) return context.applyCore();
  const player = getPlayer(context.state, context.playerId);
  if (!player || player.bankrupt) return context.applyCore();
  const current = readSanguoState(context.state);
  const existing = current.battleShieldByPlayerId[player.id] ?? 0;
  const battles = Math.min(SHIELD_CAP, existing + count);
  const events: GameEvent[] = [event('sanguo_shielded', {
    playerId: context.playerId,
    added: battles - existing,
    battles,
  })];
  return finishEffect(
    context.state,
    context,
    withSanguoState(context.state, {
      ...current,
      battleShieldByPlayerId: bump(current.battleShieldByPlayerId, player.id, count, SHIELD_CAP),
    }),
    events,
  );
}

/**
 * `sanguo-swap`：与任意玩家交换位置（徐庶）。**只能和别的玩家换**，因此：
 * 只有存在至少一名「与自己位置不同」的存活对手时才生效；否则退化为无事发生。
 * 交换后发 `token_moved` 事件，让客户端把两枚棋子都挪到新位置。
 */
function applySwap(context: ModuleEffectExecutionContext): RuleEffectResult {
  const player = getPlayer(context.state, context.playerId);
  if (!player || player.bankrupt) return context.applyCore();
  const targets = context.state.players.filter((candidate) => (
    !candidate.bankrupt && candidate.id !== player.id && candidate.position !== player.position
  ));
  if (targets.length === 0) {
    return finishEffect(
      context.state,
      context,
      context.state,
      [event('sanguo_swap_skipped', { playerId: context.playerId })],
    );
  }
  // 选「离自己最远」的那名对手（棋盘上 28 格，取环行序差值最大者），交换更有戏剧性。
  const ringSize = context.state.board.cells.length;
  const distance = (from: number, to: number): number => {
    const raw = Math.abs(from - to) % ringSize;
    return Math.min(raw, ringSize - raw);
  };
  let target = targets[0]!;
  for (const candidate of targets) {
    if (distance(player.position, candidate.position) > distance(player.position, target.position)) {
      target = candidate;
    }
  }
  const events: GameEvent[] = [
    event('sanguo_swapped', {
      playerId: context.playerId,
      from: player.position,
      to: target.position,
      counterpartId: target.id,
    }),
    { type: 'token_moved', playerId: context.playerId, path: [target.position] },
    { type: 'token_moved', playerId: target.id, path: [player.position] },
  ];
  const next: GameState = {
    ...context.state,
    players: context.state.players.map((candidate) => {
      if (candidate.id === context.playerId) return { ...candidate, position: target.position };
      if (candidate.id === target.id) return { ...candidate, position: player.position };
      return candidate;
    }),
  };
  return finishEffect(context.state, context, next, events);
}

/**
 * `sanguo-fortify`：在自己任意领地免费建一座城池（孙策 / 周瑜）。
 * 名下无可建之地时退化为「无事发生」而不是白给钱——卡面写的是「建城」，不是「发钱」。
 */
function applyFortify(context: ModuleEffectExecutionContext): RuleEffectResult {
  const player = getPlayer(context.state, context.playerId);
  if (!player || player.bankrupt) return context.applyCore();
  const target = pickFortifyTarget(context.state, context.playerId);
  if (target === null) {
    return finishEffect(
      context.state,
      context,
      context.state,
      [event('sanguo_fortify_skipped', { playerId: context.playerId })],
    );
  }
  const nextLevel = (context.state.properties[target]?.level ?? 0) + 1;
  const events: GameEvent[] = [
    event('sanguo_fortified', { playerId: context.playerId, cellId: target, level: nextLevel }),
    { type: 'house_built', cellId: target, level: nextLevel, amount: 0 },
  ];
  return finishEffect(
    context.state,
    context,
    withPropertyLevel(context.state, target, context.playerId, nextLevel),
    events,
  );
}

/**
 * `sanguo-freeze`：暂停一次（貂蝉）。走 `PlayerState.skipTurns`，
 * 由 core 在回合开始时消费——**刻意复用 core 字段**而不是模块自建计数器，
 * 这样「暂停一次」与地图上「隔岸观火」格的效果完全同构，玩家只记一套规则。
 */
function applyFreeze(context: ModuleEffectExecutionContext): RuleEffectResult {
  const player = getPlayer(context.state, context.playerId);
  if (!player || player.bankrupt) return context.applyCore();
  const next: GameState = {
    ...context.state,
    players: context.state.players.map((candidate) => (
      candidate.id === context.playerId ? { ...candidate, skipTurns: candidate.skipTurns + 1 } : candidate
    )),
  };
  return finishEffect(
    context.state,
    context,
    next,
    [event('sanguo_frozen', { playerId: context.playerId, skipTurns: player.skipTurns + 1 })],
  );
}

/**
 * `sanguo-supply`：白得 N 份粮草（锦囊妙计里的「犒军」「屯田」类卡）。
 * 粮草不是钱，所以这里**不发** bank 事件：它既没从牌桌拿走钱，也没凭空造钱。
 */
function applySupply(context: ModuleEffectExecutionContext): RuleEffectResult {
  const count = readAmount(context.card.effect.payload, 'supply');
  if (count === null) return context.applyCore();
  const player = getPlayer(context.state, context.playerId);
  if (!player || player.bankrupt) return context.applyCore();
  const current = readSanguoState(context.state);
  const existing = current.supplyByPlayerId[context.playerId] ?? 0;
  const supply = Math.min(SUPPLY_CAP, existing + count);
  const events: GameEvent[] = [event('sanguo_supply_gained', {
    playerId: context.playerId,
    added: supply - existing,
    supply,
  })];
  return finishEffect(
    context.state,
    context,
    withSanguoState(context.state, {
      ...current,
      supplyByPlayerId: bump(current.supplyByPlayerId, context.playerId, count, SUPPLY_CAP),
    }),
    events,
  );
}

// === 回合边界：清理失效状态（不重新生成选项）===

function synchronizeSanguoState(state: GameState): GameState {
  const sanguoState = cleanSanguoState(state);
  const kept = state.publicRuleState.pendingActions.filter((action) => (
    !isOwnAction(action)
      || (action.action === ACTION_BATTLE_CHOICE
        && isValidOwnChoice(state, action, ACTION_BATTLE_CHOICE, CELL_BATTLE))
      || (action.action === ACTION_SHRINE_CHOICE
        && isValidOwnChoice(state, action, ACTION_SHRINE_CHOICE, CELL_SHRINE))
  ));
  return withSanguoState(state, sanguoState, kept);
}

// === 机器人策略 ===

type BotIntent = { type: 'module'; module: RuleModuleRef; action: string; payload: JsonValue } | undefined;

function findBotOption(
  state: GameState,
  playerId: string,
  actionName: string,
  kind: string,
): BotIntent {
  const action = state.publicRuleState.pendingActions.find((candidate) => (
    candidate.playerId === playerId
    && isOwnAction(candidate)
    && candidate.action === actionName
    && isRecord(candidate.payload)
    && candidate.payload.kind === kind
  ));
  if (action === undefined) return undefined;
  return { type: 'module', module: action.module, action: action.action, payload: action.payload };
}

/** 现金充裕先屯兵；有粮草且有可升级城池就升级；否则厮杀；最后按兵不动。 */
function chooseBotBattleChoice(state: GameState, playerId: string): BotIntent {
  const hasOptions = state.publicRuleState.pendingActions.some((action) => (
    action.playerId === playerId && isOwnAction(action) && action.action === ACTION_BATTLE_CHOICE
  ));
  if (!hasOptions) return undefined;
  const player = getPlayer(state, playerId);
  if (!player) return undefined;
  if (player.cash >= TUNBIN_COST + BOT_TUNBIN_RESERVE) {
    const tunbin = findBotOption(state, playerId, ACTION_BATTLE_CHOICE, KIND_TUNBIN);
    if (tunbin !== undefined) return tunbin;
  }
  const upgrade = findBotOption(state, playerId, ACTION_BATTLE_CHOICE, KIND_UPGRADE);
  if (upgrade !== undefined) return upgrade;
  // 现金够支付败局损失才参战，避免机器人主动把自己送进债务队列。
  if (player.cash >= SKIRMISH_LOSS) {
    const skirmish = findBotOption(state, playerId, ACTION_BATTLE_CHOICE, KIND_SKIRMISH);
    if (skirmish !== undefined) return skirmish;
  }
  return findBotOption(state, playerId, ACTION_BATTLE_CHOICE, KIND_WAIT);
}

function chooseBotShrineChoice(state: GameState, playerId: string): BotIntent {
  const hasOptions = state.publicRuleState.pendingActions.some((action) => (
    action.playerId === playerId && isOwnAction(action) && action.action === ACTION_SHRINE_CHOICE
  ));
  if (!hasOptions) return undefined;
  const player = getPlayer(state, playerId);
  if (!player) return undefined;
  if (player.cash >= INCENSE_COST + BOT_INCENSE_RESERVE) {
    const incense = findBotOption(state, playerId, ACTION_SHRINE_CHOICE, KIND_INCENSE);
    if (incense !== undefined) return incense;
  }
  return findBotOption(state, playerId, ACTION_SHRINE_CHOICE, KIND_SALUTE);
}

// === hydrate 严格校验 ===

/**
 * 三张计数表的键必须都是本局存活玩家，值必须是正安全整数且不超上限。
 * 上限也要校验：损坏存档里的天文数字会让每次落战场格都派发巨额香火钱，等于毁掉整局。
 */
export function validateSanguoPublicModuleState(
  value: unknown,
  players: readonly DeepReadonly<PlayerState>[],
): value is SanguoPublicModuleState {
  if (!isRecord(value) || Object.keys(value).length !== 3) return false;
  const alive = new Set(players.filter((player) => !player.bankrupt).map((player) => player.id));
  const check = (table: unknown, cap: number): boolean => {
    if (!isRecord(table)) return false;
    for (const [playerId, amount] of Object.entries(table)) {
      if (!alive.has(playerId)) return false;
      if (!isPositiveInt(amount) || amount > cap) return false;
    }
    return true;
  };
  return check(value.supplyByPlayerId, SUPPLY_CAP)
    && check(value.battleShieldByPlayerId, SHIELD_CAP)
    && check(value.incenseByPlayerId, INCENSE_CAP);
}

function applySupplyReliefHook(context: PositiveRentContext): PositiveRentResult {
  const { amount, relief } = applySupplyRelief(context.state, context.payerId, context.amount);
  if (relief <= 0) return context;
  return {
    ...context,
    amount,
    events: [...context.events, event('sanguo_relief_applied', {
      playerId: context.payerId,
      cellId: context.cellId,
      relief,
      amount,
    })],
  };
}

const sanguoRuleModuleInput: RuleModuleDefinition = {
  ref: SANGUO_MODULE_REF,
  cellHandlers: [
    { type: 'module', cellType: CELL_BATTLE, handle: settleBattleLanding },
    { type: 'module', cellType: CELL_SHRINE, handle: settleShrineLanding },
  ],
  effectHandlers: [
    { type: 'module', effectType: 'sanguo-grant', handle: applyGrant },
    { type: 'module', effectType: 'sanguo-shield', handle: applyShield },
    { type: 'module', effectType: 'sanguo-swap', handle: applySwap },
    { type: 'module', effectType: 'sanguo-fortify', handle: applyFortify },
    { type: 'module', effectType: 'sanguo-freeze', handle: applyFreeze },
    { type: 'module', effectType: 'sanguo-supply', handle: applySupply },
  ],
  intentHandlers: [
    {
      type: 'module',
      action: ACTION_BATTLE_CHOICE,
      handle: (context) => handleBattleChoice(context.state, context.playerId, context.intent),
    },
    {
      type: 'module',
      action: ACTION_SHRINE_CHOICE,
      handle: (context) => handleShrineChoice(context.state, context.playerId, context.intent),
    },
  ],
  botStrategyHook: {
    decide: (context) => {
      const battle = chooseBotBattleChoice(context.state, context.playerId);
      if (battle !== undefined) return battle;
      return chooseBotShrineChoice(context.state, context.playerId) ?? context.currentDecision;
    },
  },
  positiveRentHook: { apply: applySupplyReliefHook },
  // 本模块**没有**回合边界结算（粮草减租走 positiveRentHook、香火钱在落战场格时发），
  // 所以 postTransitionHook 只做一件事：清理失效状态与失效待选动作。
  // 刻意不在这里重新生成选项 —— 「按兵不动」会被立刻摆回来，形成点不完的循环（great-wall 已踩过）。
  postTransitionHook: {
    apply: (context) => {
      if (!context.result.ok) return context.result;
      return { ...context.result, state: synchronizeSanguoState(context.result.state) };
    },
  },
};

export const sanguoRuleModuleDefinition = sanguoRuleModuleInput;
