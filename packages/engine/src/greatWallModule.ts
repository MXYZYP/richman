// 规则模块 `great-wall@1`：长城烽火台
//
// 机制（核心规则与 world-tour 都没有的「盘面据点」玩法）：
//   · 地图上的 `beacon` 模块格叫「烽火台」。落在无主烽火台上，玩家可以花 claimCost 元占据它
//     （占据关系是模块自己的公共状态，与 core 的 properties 完全独立）。
//   · 其他玩家之后再落到同一座已被占据的烽火台，要向占据者支付 toll 元通行费。
//   · 占领者本人再次落回自家烽火台只是「巡视」，不产生任何费用。
//   · 卡牌效果 `beacon-patrol`（巡边）：你名下的每座烽火台为你带来 perBeacon 元。
//
// 设计上刻意对齐 `worldTourModule.ts` 的既有模式（公共模块状态 + pendingActions + 意图处理 +
// hydrate 严格校验），但有两处必须遵守的硬约束：
//
//   1) **同一时刻的待选动作必须是同一个 `模块@版本:动作`**。hydrate 的 validatePublicRuleState
//      用 `decisionKinds` 集合做校验，出现两个不同的 action 会直接判存档非法。所以「占据 / 不占据」
//      两个选项共用动作名 `beacon-choice`，真正的分支放在 payload.claim 布尔里——这与 world-tour
//      的 `short-flight` 用 `targetCellId: null` 表示「不搭乘」是同一个套路。
//   2) **待选动作的 requiredPhase 必须等于当时的 turnPhase，且 playerId 必须是当前玩家**。
//      所以落地后先把 turnPhase 归到 `managing`（与 world-tour 的 withChoiceActions 一致），
//      待选动作的 requiredPhase 也写 `managing`。
//
// 待选动作只在**落点结算时**生成一次，postTransitionHook 只负责**清理失效动作**（换人、阶段变了、
// 已无主可占、现金不够、进了债务）。之所以不在 hook 里重新生成：否则玩家点「不占据」后钩子会
// 立刻把选项又摆回来，形成点不完的循环。
import type {
  DeepReadonly,
  JsonValue,
  ModuleCell,
  ModuleEvent,
  ModuleIntent,
  RuleModuleRef,
} from '@richman/board-data';
import type { ApplyResult, GameEvent, GameState, PendingModuleAction, PlayerState } from './types';
import type {
  ModuleEffectExecutionContext,
  RuleModuleDefinition,
  RuleModuleRegistry,
} from './moduleRegistry';
import { finishCashGoalIfReached, processQueuedPayments } from './moduleToolkit';

export const GREAT_WALL_MODULE_REF = Object.freeze({ id: 'great-wall', version: 1 }) satisfies RuleModuleRef;
export const GREAT_WALL_MODULE_KEY = 'great-wall@1';

/** 烽火台格 payload：claimCost = 占据费用；toll = 他人落在已被占据的烽火台时应付给占据者的通行费。 */
export interface GreatWallBeaconPayload {
  readonly claimCost: number;
  readonly toll: number;
}

export interface GreatWallPublicModuleState {
  /** cellId（字符串键）→ 占据者 playerId。 */
  readonly beaconOwnersByCellId: Readonly<Record<string, string>>;
}

/** 机器人决策的现金安全垫：占据后至少还要留这么多钱，避免为了一座烽火台把自己掏空。 */
const BOT_CLAIM_RESERVE = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function isGreatWallBeacon(cell: DeepReadonly<ModuleCell> | undefined): cell is DeepReadonly<ModuleCell> {
  return cell?.type === 'module'
    && cell.module.id === GREAT_WALL_MODULE_REF.id
    && cell.module.version === GREAT_WALL_MODULE_REF.version
    && cell.cellType === 'beacon';
}

function beaconPayload(cell: DeepReadonly<ModuleCell>): GreatWallBeaconPayload | undefined {
  const payload = cell.payload;
  if (!isRecord(payload)
    || !hasExactKeys(payload, ['claimCost', 'toll'])
    || !Number.isSafeInteger(payload.claimCost) || (payload.claimCost as number) < 0
    || !Number.isSafeInteger(payload.toll) || (payload.toll as number) <= 0) return undefined;
  return payload as unknown as GreatWallBeaconPayload;
}

/** 棋盘上全部烽火台格（按数组顺序）。 */
export function greatWallBeaconCells(
  board: { readonly cells: readonly unknown[] },
): DeepReadonly<ModuleCell>[] {
  const beacons: DeepReadonly<ModuleCell>[] = [];
  for (const candidate of board.cells) {
    const cell = candidate as DeepReadonly<ModuleCell>;
    if (isGreatWallBeacon(cell)) beacons.push(cell);
  }
  return beacons;
}

function emptyGreatWallState(): GreatWallPublicModuleState {
  return { beaconOwnersByCellId: {} };
}

function readGreatWallState(state: GameState): GreatWallPublicModuleState {
  const value = state.publicRuleState.modules[GREAT_WALL_MODULE_KEY];
  return isRecord(value) ? value as unknown as GreatWallPublicModuleState : emptyGreatWallState();
}

function hasGreatWallState(value: GreatWallPublicModuleState): boolean {
  return Object.keys(value.beaconOwnersByCellId).length > 0;
}

function withGreatWallState(
  state: GameState,
  greatWallState: GreatWallPublicModuleState,
  pendingActions: readonly PendingModuleAction[] = state.publicRuleState.pendingActions,
): GameState {
  const modules = { ...state.publicRuleState.modules };
  if (hasGreatWallState(greatWallState)) modules[GREAT_WALL_MODULE_KEY] = greatWallStateAsJson(greatWallState);
  else delete modules[GREAT_WALL_MODULE_KEY];
  return { ...state, publicRuleState: { modules, pendingActions } };
}

export function greatWallStateAsJson(value: GreatWallPublicModuleState): JsonValue {
  return value as unknown as JsonValue;
}

function isOwnAction(action: PendingModuleAction): boolean {
  return action.module.id === GREAT_WALL_MODULE_REF.id
    && action.module.version === GREAT_WALL_MODULE_REF.version;
}

/**
 * 丢弃失效的占据关系：烽火台格已不存在，或占据者已破产。
 * （占据者破产后烽火台回到无主状态，供其他人继续争夺。）
 */
function cleanGreatWallState(state: GameState): GreatWallPublicModuleState {
  const current = readGreatWallState(state);
  const beaconIds = new Set(greatWallBeaconCells(state.board).map((cell) => cell.id));
  const alive = new Set(
    state.players.filter((player) => !player.bankrupt).map((player) => player.id),
  );
  const beaconOwnersByCellId: Record<string, string> = {};
  for (const [cellKey, ownerId] of Object.entries(current.beaconOwnersByCellId)) {
    const cellId = Number(cellKey);
    if (!Number.isSafeInteger(cellId) || !beaconIds.has(cellId) || !alive.has(ownerId)) continue;
    beaconOwnersByCellId[cellKey] = ownerId;
  }
  return { beaconOwnersByCellId };
}

function moduleEvent(eventType: string, payload: JsonValue): ModuleEvent {
  return { type: 'module', module: GREAT_WALL_MODULE_REF, eventType, payload };
}

function optionId(state: GameState, playerId: string, cellId: number, claim: boolean): string {
  return `${GREAT_WALL_MODULE_KEY}:beacon-choice:${playerId}:${state.turn}:${cellId}:${claim ? 'claim' : 'skip'}`;
}

function beaconChoiceAction(
  state: GameState,
  playerId: string,
  cellId: number,
  claim: boolean,
  label: string,
): PendingModuleAction {
  const id = optionId(state, playerId, cellId, claim);
  return {
    optionId: id,
    module: GREAT_WALL_MODULE_REF,
    playerId,
    requiredPhase: 'managing',
    label,
    action: 'beacon-choice',
    payload: { optionId: id, cellId, claim },
  };
}

/** 当前玩家站在无主烽火台上、且买得起时，给出「占据 / 不占据」两个选项。 */
function beaconChoiceActions(
  state: GameState,
  greatWallState: GreatWallPublicModuleState,
  player: PlayerState,
): PendingModuleAction[] {
  const beacon = greatWallBeaconCells(state.board).find((cell) => cell.id === player.position);
  const payload = beacon && beaconPayload(beacon);
  if (!beacon || !payload) return [];
  if (greatWallState.beaconOwnersByCellId[String(beacon.id)] !== undefined) return [];
  if (player.cash < payload.claimCost) return [];
  return [
    beaconChoiceAction(state, player.id, beacon.id, true, `占据烽火台（${payload.claimCost} 元）`),
    beaconChoiceAction(state, player.id, beacon.id, false, '不占据'),
  ];
}

/** 落点结算：已被他人占据则付通行费；无主或自家则只清理状态（选项在落点时生成）。 */
function settleBeaconLanding(
  context: Parameters<RuleModuleDefinition['cellHandlers'][number]['handle']>[0],
) {
  const beacon = context.cell as DeepReadonly<ModuleCell>;
  const player = context.state.players.find((candidate) => candidate.id === context.playerId);
  if (!player || player.position !== beacon.id || !beaconPayload(beacon)) return context.applyCore();

  const current = readGreatWallState(context.state);
  const ownerId = current.beaconOwnersByCellId[String(beacon.id)];
  const owner = ownerId === undefined
    ? undefined
    : context.state.players.find((candidate) => candidate.id === ownerId);
  const ownedByOther = owner !== undefined && !owner.bankrupt && owner.id !== context.playerId;

  if (ownedByOther) {
    const payload = beaconPayload(beacon)!;
    const paid = processQueuedPayments(
      { ...context.state, turnPhase: 'managing' },
      [{ debtorId: context.playerId, creditorId: owner.id, amount: payload.toll }],
      [
        ...context.events,
        moduleEvent('beacon_toll_paid', {
          playerId: context.playerId,
          ownerId: owner.id,
          cellId: beacon.id,
          amount: payload.toll,
        }),
      ],
    );
    return { state: paid.state, events: paid.events, newDebt: paid.newDebt };
  }

  const greatWallState = cleanGreatWallState(context.state);
  const events: GameEvent[] = owner?.id === context.playerId
    ? [...context.events, moduleEvent('beacon_revisited', { playerId: context.playerId, cellId: beacon.id })]
    : [...context.events];
  const actions = beaconChoiceActions(context.state, greatWallState, player);
  const state = withGreatWallState(
    { ...context.state, turnPhase: 'managing' },
    greatWallState,
    [
      ...context.state.publicRuleState.pendingActions.filter((action) => action.playerId !== context.playerId),
      ...actions,
    ],
  );
  return { state, events, newDebt: state.debt };
}

/** 待选动作是否仍然有效（当前玩家、同一阶段、仍站在无主且买得起的烽火台上）。 */
function isValidBeaconChoice(
  state: GameState,
  action: PendingModuleAction,
  greatWallState: GreatWallPublicModuleState,
): boolean {
  if (action.playerId !== state.currentPlayerId) return false;
  if (action.requiredPhase !== state.turnPhase || state.debt !== null) return false;
  if (!isRecord(action.payload) || !Number.isSafeInteger(action.payload.cellId)) return false;
  const player = state.players.find((candidate) => candidate.id === action.playerId);
  const cellId = action.payload.cellId as number;
  if (!player || player.bankrupt || player.position !== cellId) return false;
  const beacon = greatWallBeaconCells(state.board).find((cell) => cell.id === cellId);
  const payload = beacon && beaconPayload(beacon);
  if (!beacon || !payload) return false;
  if (greatWallState.beaconOwnersByCellId[String(cellId)] !== undefined) return false;
  return player.cash >= payload.claimCost;
}

/** 只做清理，不重新生成选项（否则「不占据」会被立刻摆回来）。 */
function synchronizeGreatWallState(state: GameState): GameState {
  const greatWallState = cleanGreatWallState(state);
  const kept = state.publicRuleState.pendingActions.filter((action) => (
    !isOwnAction(action) || isValidBeaconChoice(state, action, greatWallState)
  ));
  return withGreatWallState(state, greatWallState, kept);
}

function matchingPendingAction(state: GameState, playerId: string, intent: ModuleIntent): PendingModuleAction | undefined {
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

function withoutPlayerGreatWallActions(state: GameState, playerId: string): GameState {
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

function handleBeaconChoice(state: GameState, playerId: string, intent: ModuleIntent): ApplyResult {
  if (state.turnPhase !== 'managing' || !matchingPendingAction(state, playerId, intent)) {
    return { ok: false, code: 'WRONG_PHASE' };
  }
  const pending = matchingPendingAction(state, playerId, intent)!;
  if (!isRecord(pending.payload)) return { ok: false, code: 'ILLEGAL_INTENT' };
  const cellId = pending.payload.cellId;
  const claim = pending.payload.claim;
  if (!Number.isSafeInteger(cellId) || typeof claim !== 'boolean') {
    return { ok: false, code: 'ILLEGAL_INTENT' };
  }

  const player = state.players.find((candidate) => candidate.id === playerId);
  const beacon = greatWallBeaconCells(state.board).find((cell) => cell.id === cellId);
  const payload = beacon && beaconPayload(beacon);
  if (!player || !beacon || !payload || player.position !== cellId) {
    return { ok: false, code: 'ILLEGAL_INTENT' };
  }

  const cleanState = withoutPlayerGreatWallActions(state, playerId);
  if (!claim) {
    const events: GameEvent[] = [moduleEvent('beacon_declined', { playerId, cellId })];
    return {
      ok: true,
      state: {
        ...cleanState,
        turnPhase: 'managing',
        recentLog: [...state.recentLog, ...events].slice(-200),
      },
      events,
    };
  }

  const greatWallState = cleanGreatWallState(state);
  if (greatWallState.beaconOwnersByCellId[String(cellId)] !== undefined) {
    return { ok: false, code: 'ILLEGAL_INTENT' };
  }
  if (player.cash < payload.claimCost) return { ok: false, code: 'INSUFFICIENT_FUNDS' };

  const events: GameEvent[] = [
    moduleEvent('beacon_claimed', { playerId, cellId, cost: payload.claimCost }),
  ];
  const claimed = withGreatWallState(
    {
      ...cleanState,
      turnPhase: 'managing',
      players: state.players.map((candidate) => (
        candidate.id === playerId ? { ...candidate, cash: candidate.cash - payload.claimCost } : candidate
      )),
    },
    {
      beaconOwnersByCellId: {
        ...greatWallState.beaconOwnersByCellId,
        [String(cellId)]: playerId,
      },
    },
  );
  return {
    ok: true,
    state: { ...claimed, recentLog: [...state.recentLog, ...events].slice(-200) },
    events,
  };
}

/** 卡牌效果 `beacon-patrol`（巡边）：名下每座烽火台带来 perBeacon 元。 */
function applyBeaconPatrol(context: ModuleEffectExecutionContext) {
  const payload = context.card.effect.payload;
  if (!isRecord(payload)
    || !Number.isSafeInteger(payload.perBeacon)
    || (payload.perBeacon as number) <= 0) return context.applyCore();

  const perBeacon = payload.perBeacon as number;
  const greatWallState = cleanGreatWallState(context.state);
  const owned = Object.values(greatWallState.beaconOwnersByCellId)
    .filter((ownerId) => ownerId === context.playerId).length;
  if (owned === 0) {
    return {
      state: withGreatWallState(context.state, greatWallState),
      events: [...context.events, moduleEvent('beacon_patrol_idle', { playerId: context.playerId })],
      newDebt: context.state.debt,
    };
  }

  const amount = perBeacon * owned;
  const events: GameEvent[] = [
    ...context.events,
    moduleEvent('beacon_patrol_paid', { playerId: context.playerId, beacons: owned, amount }),
    { type: 'bank_received', playerId: context.playerId, amount },
  ];
  const state = {
    ...withGreatWallState(context.state, greatWallState),
    players: context.state.players.map((candidate) => (
      candidate.id === context.playerId ? { ...candidate, cash: candidate.cash + amount } : candidate
    )),
  };
  const win = finishCashGoalIfReached(state, events);
  return { state: win?.state ?? state, events: win?.events ?? events, newDebt: null };
}

/** 机器人/托管：有烽火台选项时自己拿主意，其余情况交回既有决策链。 */
function chooseBotBeaconChoice(state: GameState, playerId: string): ModuleIntent | undefined {
  const options = state.publicRuleState.pendingActions.filter(
    (action) => action.playerId === playerId && isOwnAction(action),
  );
  if (options.length === 0) return undefined;
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) return undefined;

  const claimOption = options.find((action) => isRecord(action.payload) && action.payload.claim === true);
  const skipOption = options.find((action) => isRecord(action.payload) && action.payload.claim === false);
  const toIntent = (action: PendingModuleAction | undefined): ModuleIntent | undefined => (
    action === undefined ? undefined : {
      type: 'module',
      module: action.module,
      action: action.action,
      payload: action.payload,
    }
  );

  if (claimOption === undefined) return toIntent(skipOption);
  // 必须先把 payload 提成 const：在 `.find(...)` 的回调里访问 `claimOption.payload`
  // 会丢掉外层对属性访问的类型收窄（TS 不信任回调执行期间属性未被改动）。
  const claimPayload = claimOption.payload;
  if (!isRecord(claimPayload)) return toIntent(skipOption);
  const claimCellId = claimPayload.cellId;
  if (typeof claimCellId !== 'number' || !Number.isSafeInteger(claimCellId)) {
    return toIntent(skipOption);
  }
  const beacon = greatWallBeaconCells(state.board).find((cell) => cell.id === claimCellId);
  const payload = beacon && beaconPayload(beacon);
  if (!payload) return toIntent(skipOption);
  const affordable = player.cash >= payload.claimCost + BOT_CLAIM_RESERVE;
  return toIntent(affordable ? claimOption : skipOption);
}

/**
 * hydrate 用的严格校验：占据关系必须指向棋盘上真实存在的烽火台，且占据者是本局存活玩家。
 * 键必须是烽火台格 id、值必须是玩家 id，两个方向都验，避免损坏存档把 UI/对局带偏。
 */
export function validateGreatWallPublicModuleState(
  value: unknown,
  board: { readonly cells: readonly unknown[] },
  players: readonly DeepReadonly<PlayerState>[],
): value is GreatWallPublicModuleState {
  if (!isRecord(value) || !hasExactKeys(value, ['beaconOwnersByCellId'])) return false;
  if (!isRecord(value.beaconOwnersByCellId)) return false;

  const beaconIds = new Set(greatWallBeaconCells(board).map((cell) => cell.id));
  const playersById = new Map(players.map((player) => [player.id, player]));
  for (const [cellKey, ownerId] of Object.entries(value.beaconOwnersByCellId)) {
    const cellId = Number(cellKey);
    if (!Number.isSafeInteger(cellId) || String(cellId) !== cellKey) return false;
    if (!beaconIds.has(cellId)) return false;
    if (typeof ownerId !== 'string') return false;
    const owner = playersById.get(ownerId);
    if (!owner || owner.bankrupt) return false;
  }
  return true;
}

const greatWallRuleModuleInput: RuleModuleDefinition = {
  ref: GREAT_WALL_MODULE_REF,
  cellHandlers: [{
    type: 'module',
    cellType: 'beacon',
    handle: settleBeaconLanding,
  }],
  effectHandlers: [{
    type: 'module',
    effectType: 'beacon-patrol',
    handle: applyBeaconPatrol,
  }],
  intentHandlers: [{
    type: 'module',
    action: 'beacon-choice',
    handle: (context) => (context.intent.type === 'module'
      ? handleBeaconChoice(context.state, context.playerId, context.intent)
      : { ok: false, code: 'ILLEGAL_INTENT' }),
  }],
  botStrategyHook: {
    decide: (context) => {
      const decided = chooseBotBeaconChoice(context.state, context.playerId);
      return decided ?? context.currentDecision;
    },
  },
  postTransitionHook: {
    apply: (context) => (context.result.ok
      ? { ...context.result, state: synchronizeGreatWallState(context.result.state) }
      : context.result),
  },
};

export const greatWallRuleModuleDefinition = greatWallRuleModuleInput;
