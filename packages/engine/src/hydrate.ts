import type { GameConfig, JsonValue, MapPack, RuleModuleRef } from '@richman/board-data';
import type { GameEvent, GameState, PendingModuleAction } from './types';
import {
  validateWorldTourPublicModuleState,
  WORLD_TOUR_MODULE_KEY,
} from './worldTourModule';
import {
  validateGreatWallPublicModuleState,
  GREAT_WALL_MODULE_KEY,
} from './greatWallModule';

export type HydrateGameStateResult =
  | { ok: true; state: GameState }
  | { ok: false; reason: string };

const PLAYER_COLORS = new Set(['red', 'blue', 'yellow', 'green', 'purple', 'orange']);
const PHASES = new Set(['playing', 'game_over']);
const TURN_PHASES = new Set([
  'awaiting_roll',
  'awaiting_airport_roll',
  'awaiting_buy_decision',
  'awaiting_build_decision',
  'managing',
]);
const MIN_RNG_STATE = -2_147_483_648;
const MAX_RNG_STATE = 2_147_483_647;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isCanonicalRngState(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?:0|-?[1-9]\d*)$/u.test(value)) return false;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= MIN_RNG_STATE && parsed <= MAX_RNG_STATE;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]));
}

/** 深冻结（config 含 `utilityMultipliers`/`cashGoalPresets` 这类嵌套集合）。 */
function deepFreezeConfig<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeConfig(item);
  } else if (isRecord(value)) {
    for (const key of Object.keys(value)) deepFreezeConfig(value[key]);
  }
  return Object.freeze(value);
}

function moduleKey(module: RuleModuleRef): string {
  return `${module.id}@${module.version}`;
}

function hasExactModule(module: unknown, enabledModules: ReadonlySet<string>): boolean {
  return isRecord(module)
    && hasExactKeys(module, ['id', 'version'])
    && isNonEmptyString(module.id)
    && isPositiveSafeInteger(module.version)
    && enabledModules.has(`${module.id}@${module.version}`);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function validPlayerReference(value: unknown, playerIds: ReadonlySet<string>, nullable = false): boolean {
  return (nullable && value === null) || (typeof value === 'string' && playerIds.has(value));
}

function validAmount(value: unknown): boolean {
  return isFiniteNonNegative(value);
}

function validateRecentEvent(
  value: unknown,
  playerIds: ReadonlySet<string>,
  cellIds: ReadonlySet<number>,
  cardIds: Readonly<Record<'chance' | 'destiny', ReadonlySet<string>>>,
  enabledModules: ReadonlySet<string>,
): value is GameEvent {
  if (!isRecord(value) || !isNonEmptyString(value.type)) return false;
  const player = (field = 'playerId') => validPlayerReference(value[field], playerIds);
  const amount = (field = 'amount') => validAmount(value[field]);
  const cell = (field = 'cellId') => Number.isSafeInteger(value[field]) && cellIds.has(value[field] as number);

  switch (value.type) {
    case 'game_started':
    case 'buy_declined':
      return hasExactKeys(value, ['type']);
    case 'turn_started':
    case 'turn_ended':
      return hasExactKeys(value, ['type', 'playerId']) && player();
    case 'dice_rolled':
      return hasExactKeys(value, ['type', 'playerId', 'dice'])
        && player()
        && Array.isArray(value.dice)
        && (value.dice.length === 1 || value.dice.length === 2)
        && value.dice.every((die) => Number.isSafeInteger(die) && die >= 1 && die <= 6);
    case 'token_moved':
      return hasExactKeys(value, ['type', 'playerId', 'path'])
        && player()
        && Array.isArray(value.path)
        && value.path.every((id) => Number.isSafeInteger(id) && cellIds.has(id));
    case 'salary_collected':
    case 'bank_paid':
    case 'bank_received':
      return hasExactKeys(value, ['type', 'playerId', 'amount']) && player() && amount();
    case 'property_bought':
      return hasExactKeys(value, ['type', 'playerId', 'cellId', 'price'])
        && player() && cell() && amount('price');
    case 'rent_paid':
      return hasExactKeys(value, ['type', 'from', 'to', 'cellId', 'amount'])
        && validPlayerReference(value.from, playerIds)
        && validPlayerReference(value.to, playerIds)
        && cell() && amount();
    case 'tax_paid':
      return hasExactKeys(value, ['type', 'playerId', 'amount']) && player() && amount();
    case 'card_drawn':
      return hasExactKeys(value, ['type', 'playerId', 'deck', 'cardId'])
        && player()
        && (value.deck === 'chance' || value.deck === 'destiny')
        && typeof value.cardId === 'string'
        && cardIds[value.deck].has(value.cardId);
    case 'house_built':
      return hasExactKeys(value, ['type', 'cellId', 'level', 'amount'])
        && cell()
        && Number.isSafeInteger(value.level)
        && (value.level as number) >= 0
        && isFiniteNonNegative(value.amount);
    case 'house_sold':
      return hasExactKeys(value, ['type', 'cellId', 'level'])
        && cell()
        && Number.isSafeInteger(value.level)
        && (value.level as number) >= 0;
    case 'property_sold':
      return hasExactKeys(value, ['type', 'playerId', 'cellId', 'amount'])
        && player() && cell() && amount();
    case 'property_mortgaged':
    case 'property_redeemed':
      return hasExactKeys(value, ['type', 'playerId', 'cellId', 'amount'])
        && player() && cell() && amount();
    case 'payment_made':
      return hasExactKeys(value, ['type', 'from', 'to', 'amount'])
        && validPlayerReference(value.from, playerIds)
        && validPlayerReference(value.to, playerIds, true)
        && amount();
    case 'debt_entered':
      return hasExactKeys(value, ['type', 'debtorId', 'amount', 'creditorId'])
        && validPlayerReference(value.debtorId, playerIds)
        && validPlayerReference(value.creditorId, playerIds, true)
        && amount();
    case 'debt_resolved':
      return hasExactKeys(value, ['type', 'amount', 'creditorId'])
        && validPlayerReference(value.creditorId, playerIds, true)
        && amount();
    case 'player_bankrupt':
    case 'player_surrendered':
      return hasExactKeys(value, ['type', 'playerId', 'creditorId', 'transferredCash'])
        && player()
        && validPlayerReference(value.creditorId, playerIds, true)
        && amount('transferredCash');
    case 'game_over':
      return hasExactKeys(value, ['type', 'winnerId', 'reason'])
        && validPlayerReference(value.winnerId, playerIds)
        && (value.reason === 'last_standing' || value.reason === 'cash_goal');
    case 'module':
      return hasExactKeys(value, ['type', 'module', 'eventType', 'payload'])
        && hasExactModule(value.module, enabledModules)
        && isNonEmptyString(value.eventType)
        && isJsonValue(value.payload);
    default:
      return false;
  }
}

function validateDebt(value: unknown, playerIds: ReadonlySet<string>): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  const keys = value.resume === undefined
    ? ['debtorId', 'creditorId', 'amount']
    : ['debtorId', 'creditorId', 'amount', 'resume'];
  if (!hasExactKeys(value, keys)
    || !validPlayerReference(value.debtorId, playerIds)
    || !validPlayerReference(value.creditorId, playerIds, true)
    || !isFiniteNonNegative(value.amount)
    || value.amount <= 0) return false;
  if (value.resume === undefined) return true;
  if (!isRecord(value.resume) || !hasExactKeys(value.resume, ['payments']) || !Array.isArray(value.resume.payments)) {
    return false;
  }
  return value.resume.payments.every((payment) => isRecord(payment)
    && hasExactKeys(payment, ['debtorId', 'creditorId', 'amount'])
    && validPlayerReference(payment.debtorId, playerIds)
    && validPlayerReference(payment.creditorId, playerIds, true)
    && isFiniteNonNegative(payment.amount)
    && payment.amount > 0);
}

function validatePublicRuleState(
  value: unknown,
  state: {
    readonly currentPlayerId: string;
    readonly turnPhase: GameState['turnPhase'];
    readonly players: GameState['players'];
  },
  pack: MapPack,
  enabledModules: ReadonlySet<string>,
): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['modules', 'pendingActions'])
    || !isRecord(value.modules) || !Array.isArray(value.pendingActions)) return false;

  for (const [key, moduleState] of Object.entries(value.modules)) {
    if (!enabledModules.has(key) || !isJsonValue(moduleState)) return false;
    if (key === WORLD_TOUR_MODULE_KEY
      && !validateWorldTourPublicModuleState(moduleState, pack.game.board, state.players)) return false;
    // 烽火台占据关系必须指向棋盘上真实存在的烽火台格，且占据者是本局存活玩家。
    if (key === GREAT_WALL_MODULE_KEY
      && !validateGreatWallPublicModuleState(moduleState, pack.game.board, state.players)) return false;
  }

  const optionIds = new Set<string>();
  const decisionKinds = new Set<string>();
  const cellIds = new Set(pack.game.board.cells.map((cell) => cell.id));
  const playerIds = new Set(state.players.map((player) => player.id));
  for (const candidate of value.pendingActions) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, [
      'optionId', 'module', 'playerId', 'requiredPhase', 'label', 'action', 'payload',
    ])
      || !isNonEmptyString(candidate.optionId) || optionIds.has(candidate.optionId)
      || !hasExactModule(candidate.module, enabledModules)
      || candidate.playerId !== state.currentPlayerId
      || candidate.requiredPhase !== state.turnPhase
      || !isNonEmptyString(candidate.label)
      || !isNonEmptyString(candidate.action)
      || !isJsonValue(candidate.payload)) return false;
    optionIds.add(candidate.optionId);

    const module = candidate.module as RuleModuleRef;
    decisionKinds.add(`${module.id}@${module.version}:${candidate.action}`);
    if (`${module.id}@${module.version}` === WORLD_TOUR_MODULE_KEY) {
      if (!isRecord(candidate.payload)
        || candidate.payload.optionId !== candidate.optionId) return false;
      const moduleState = value.modules[WORLD_TOUR_MODULE_KEY];
      switch (candidate.action) {
        case 'enter-airport-branch':
          if (!isRecord(moduleState)
            || !isRecord(moduleState.pendingAirportByPlayerId)
            || !hasExactKeys(candidate.payload, ['optionId', 'airportCellId'])
            || !Number.isSafeInteger(candidate.payload.airportCellId)
            || moduleState.pendingAirportByPlayerId[candidate.playerId as string] !== candidate.payload.airportCellId) {
            return false;
          }
          break;
        case 'roll-branch':
          if (!isRecord(moduleState)
            || !isRecord(moduleState.branchAirportByPlayerId)
            || !hasExactKeys(candidate.payload, ['optionId'])
            || moduleState.branchAirportByPlayerId[candidate.playerId as string] === undefined) return false;
          break;
        case 'bus-move':
          if (!hasExactKeys(candidate.payload, ['optionId', 'steps'])
            || !Number.isSafeInteger(candidate.payload.steps)
            || (candidate.payload.steps as number) < 1
            || (candidate.payload.steps as number) > 12) return false;
          break;
        case 'short-flight':
        case 'long-flight': {
          const expectedCost = candidate.action === 'short-flight' ? 3500 : 8000;
          if (!hasExactKeys(candidate.payload, ['optionId', 'targetCellId', 'cost'])
            || candidate.payload.cost !== expectedCost
            || !(candidate.payload.targetCellId === null
              || (Number.isSafeInteger(candidate.payload.targetCellId)
                && cellIds.has(candidate.payload.targetCellId as number)))) return false;
          break;
        }
        case 'free-upgrade':
          if (!hasExactKeys(candidate.payload, ['optionId', 'cellId'])
            || !Number.isSafeInteger(candidate.payload.cellId)
            || !cellIds.has(candidate.payload.cellId as number)) return false;
          break;
        case 'dice-duel':
          if (!hasExactKeys(candidate.payload, ['optionId', 'opponentId', 'amount'])
            || !isNonEmptyString(candidate.payload.opponentId)
            || candidate.payload.opponentId === candidate.playerId
            || !playerIds.has(candidate.payload.opponentId)
            || candidate.payload.amount !== 1200) return false;
          break;
        default:
          return false;
      }
    }
    if (`${module.id}@${module.version}` === GREAT_WALL_MODULE_KEY) {
      // 烽火台的「占据 / 不占据」共用动作名 `beacon-choice`，分支放在 payload.claim 里
      // （同一时刻的待选动作必须是同一个 模块:动作，见 decisionKinds 校验）。
      if (!isRecord(candidate.payload)
        || candidate.payload.optionId !== candidate.optionId
        || candidate.action !== 'beacon-choice'
        || !hasExactKeys(candidate.payload, ['optionId', 'cellId', 'claim'])
        || !Number.isSafeInteger(candidate.payload.cellId)
        || !cellIds.has(candidate.payload.cellId as number)
        || typeof candidate.payload.claim !== 'boolean') return false;
    }
  }
  if (decisionKinds.size > 1) return false;

  const worldState = value.modules[WORLD_TOUR_MODULE_KEY];
  if (isRecord(worldState) && isRecord(worldState.pendingAirportByPlayerId)) {
    const pendingAirportId = worldState.pendingAirportByPlayerId[state.currentPlayerId];
    if (pendingAirportId !== undefined && state.turnPhase === 'awaiting_roll') {
      const hasEntryAction = (value.pendingActions as PendingModuleAction[]).some((action) => (
        action.module.id === 'world-tour'
        && action.module.version === 1
        && action.playerId === state.currentPlayerId
        && action.action === 'enter-airport-branch'
      ));
      if (!hasEntryAction) return false;
    }
    if (isRecord(worldState.branchAirportByPlayerId)
      && worldState.branchAirportByPlayerId[state.currentPlayerId] !== undefined
      && state.turnPhase === 'awaiting_roll') {
      const hasBranchAction = (value.pendingActions as PendingModuleAction[]).some((action) => (
        action.module.id === 'world-tour'
        && action.module.version === 1
        && action.playerId === state.currentPlayerId
        && action.action === 'roll-branch'
        && isRecord(action.payload)
        && action.payload.optionId === action.optionId
      ));
      if (!hasBranchAction) return false;
    }
  }
  return true;
}

/** 允许房主覆盖的三项规则键（#4）：其余 config 键必须与地图默认值逐键相等。 */
const OVERRIDABLE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'initialCash',
  'maxHouseLevel',
  'mortgageInterestRate',
]);

/**
 * 从「可能被自定义过」的 config 推导出可信的 config（#4 房主自定义规则）。
 *
 * 为什么需要它：`hydrateGameState` 原本要求 `config` 与地图 `game.config` 逐键相等，
 * 于是任何自定义过初始资金/房级的对局（单机存档、联机房间快照）**都恢复不回来**——
 * 表现为用户一读档就被判定「存档损坏」。反过来，若直接把 config 放开，玩家又能借它
 * 写入 `utilityMultipliers`/`diceMode`/`jailEnabled` 这类结构性字段，造出引擎根本不会走的规则。
 *
 * 折中方案：只放行三项数值差异，且每项都做范围校验。其中最高房级仍以地图档位为天花板——
 * 过路费按 `rents[level]` 取档，而 `rents.length` 恒为 `maxHouseLevel + 1`，超出即收 0 元。
 *
 * 返回 `null` 表示「这份 config 不可信」，调用方应按损坏处理（丢弃存档/快照）。
 */
export function resolveOverriddenGameConfig(
  config: unknown,
  pack: MapPack,
): MapPack['game']['config'] | null {
  const base = pack.game.config as unknown as Record<string, unknown>;
  if (!isRecord(config)) return null;
  if (!hasExactKeys(config, Object.keys(base))) return null;
  for (const key of Object.keys(base)) {
    if (OVERRIDABLE_CONFIG_KEYS.has(key)) continue;
    if (!deepEqual(config[key], base[key])) return null;
  }

  const { initialCash, maxHouseLevel, mortgageInterestRate } = config;
  if (typeof initialCash !== 'number' || !Number.isFinite(initialCash) || initialCash <= 0) return null;
  if (typeof maxHouseLevel !== 'number' || !Number.isSafeInteger(maxHouseLevel)
    || maxHouseLevel < 1 || maxHouseLevel > (base.maxHouseLevel as number)) return null;
  if (typeof mortgageInterestRate !== 'number' || !Number.isFinite(mortgageInterestRate)
    || mortgageInterestRate < 0 || mortgageInterestRate > 1) return null;

  return deepFreezeConfig({
    ...(base as unknown as GameConfig),
    initialCash,
    maxHouseLevel,
    mortgageInterestRate,
  });
}

/**
 * Hydrate browser-owned JSON only against one already-resolved exact map pack.
 *
 * `configOverride`（#4）：不传 = 严格使用地图 `game.config`，行为与引入前**完全一致**
 * （所有既有调用与测试都走这条默认路径）。只有服务端房间才传覆盖值——它的 config 由本进程
 * 持有并在 `RoomManager` 侧清洗过。客户端存档不要直接把存档里的 config 传进来，
 * 它来路不可信，应先过 `resolveOverriddenGameConfig` 只放行三项差异。
 */
export function hydrateGameState(
  value: unknown,
  pack: MapPack,
  configOverride?: MapPack['game']['config'],
): HydrateGameStateResult {
  const targetConfig: MapPack['game']['config'] = configOverride ?? pack.game.config;
  const fail = (reason: string): HydrateGameStateResult => ({ ok: false, reason });
  const stateKeys = [
    'mapRef', 'ruleModules', 'seed', 'turn', 'phase', 'turnPhase', 'currentPlayerId',
    'players', 'properties', 'decks', 'debt', 'lastDice', 'recentLog', 'winnerId',
    'cashGoal', 'publicRuleState', 'board', 'cards', 'config',
  ];
  // 单机真人抽卡确认（cardChoice）为可选字段：旧存档没有该键，联机快照也不会出现。
  if (!isRecord(value) || !hasExactKeys(value, value.cardChoice === undefined ? stateKeys : [...stateKeys, 'cardChoice'])) {
    return fail('invalid game state shape');
  }

  if (!deepEqual(value.mapRef, pack.ref)
    || !deepEqual(value.ruleModules, pack.game.requiredRuleModules)
    || !deepEqual(value.board, pack.game.board)
    || !deepEqual(value.cards, pack.game.cards)
    // 地图数据必须逐键与地图包一致；config 比对的则是**本局生效**的那份：
    // 房主自定义过规则时 targetConfig 不等于地图默认值，仍比 pack.game.config 就会
    // 把自定义规则的对局（单机存档、联机房间快照）一律判成损坏。
    || !deepEqual(value.config, targetConfig)) {
    return fail('exact map data or rule modules do not match');
  }

  if (!isCanonicalRngState(value.seed)) return fail('invalid RNG state');
  if (!isPositiveSafeInteger(value.turn)) return fail('invalid turn');
  if (typeof value.phase !== 'string' || !PHASES.has(value.phase)) return fail('invalid phase');
  if (typeof value.turnPhase !== 'string' || !TURN_PHASES.has(value.turnPhase)) return fail('invalid turn phase');
  if (!Array.isArray(value.players) || value.players.length < 2 || value.players.length > 6) return fail('invalid players');

  const playerIds = new Set<string>();
  for (const player of value.players) {
    if (!isRecord(player) || !hasExactKeys(player, [
      'id', 'nickname', 'color', 'isBot', 'cash', 'position', 'skipTurns',
      'bankrupt', 'bankruptTurn', 'online',
    ])) return fail('invalid player');
    if (!isNonEmptyString(player.id) || playerIds.has(player.id)
      || !isNonEmptyString(player.nickname)
      || typeof player.color !== 'string' || !PLAYER_COLORS.has(player.color)
      || typeof player.isBot !== 'boolean'
      || !isFiniteNonNegative(player.cash)
      || !Number.isSafeInteger(player.position)
      || typeof player.skipTurns !== 'number' || !Number.isSafeInteger(player.skipTurns) || player.skipTurns < 0
      || typeof player.bankrupt !== 'boolean'
      || !(player.bankruptTurn === null || isPositiveSafeInteger(player.bankruptTurn))
      || (player.bankrupt !== (player.bankruptTurn !== null))
      || typeof player.online !== 'boolean') return fail('invalid player fields');
    playerIds.add(player.id);
  }

  const cellIds = new Set(pack.game.board.cells.map((cell) => cell.id));
  if (value.players.some((player) => !cellIds.has((player as Record<string, unknown>).position as number))) {
    return fail('invalid player position');
  }
  if (!validPlayerReference(value.currentPlayerId, playerIds)) return fail('invalid current player');
  if (value.phase === 'playing' ? value.winnerId !== null : !validPlayerReference(value.winnerId, playerIds)) {
    return fail('invalid winner');
  }
  const players = value.players as unknown as GameState['players'];
  const currentPlayer = players.find((player) => player.id === value.currentPlayerId)!;
  const winner = players.find((player) => player.id === value.winnerId);
  if (value.phase === 'playing' && currentPlayer.bankrupt) return fail('invalid current player state');
  if (value.phase === 'game_over' && winner?.bankrupt) return fail('invalid winner state');
  if (value.phase === 'playing' && value.turnPhase === 'awaiting_airport_roll') {
    const currentCell = pack.game.board.cells.find((cell) => cell.id === currentPlayer.position);
    if (currentCell?.type !== 'airport') return fail('invalid airport turn phase');
  }

  const enabledModules = new Set(pack.game.requiredRuleModules.map(moduleKey));
  if (!validatePublicRuleState(value.publicRuleState, {
    currentPlayerId: value.currentPlayerId as string,
    turnPhase: value.turnPhase as GameState['turnPhase'],
    players,
  }, pack, enabledModules)) return fail('invalid public rule state');

  const propertyCells = pack.game.board.cells.filter((cell) => cell.type === 'property');
  const propertyIds = new Set(propertyCells.map((cell) => cell.id));
  if (!isRecord(value.properties) || Object.keys(value.properties).length !== propertyIds.size) {
    return fail('invalid properties');
  }
  for (const [rawCellId, property] of Object.entries(value.properties)) {
    const cellId = Number(rawCellId);
    const cell = propertyCells.find((candidate) => candidate.id === cellId);
    if (!Number.isSafeInteger(cellId) || !propertyIds.has(cellId)
      || cell === undefined
      || !isRecord(property) || !hasExactKeys(property, ['ownerId', 'level', 'mortgaged'])
      || !validPlayerReference(property.ownerId, playerIds, true)
      || typeof property.level !== 'number' || !Number.isSafeInteger(property.level)
      || property.level < 0 || property.level > targetConfig.maxHouseLevel
      || typeof property.mortgaged !== 'boolean'
      || (property.ownerId === null && (
        property.mortgaged
        || (property.level !== 0 && !(enabledModules.has(WORLD_TOUR_MODULE_KEY) && cell.subtype === 'normal'))
      ))
      || (cell.subtype !== 'normal' && property.level !== 0)
      || (property.mortgaged && property.level !== 0)) return fail('invalid property state');
  }

  if (!isRecord(value.decks) || !hasExactKeys(value.decks, ['chance', 'destiny'])) return fail('invalid decks');
  const cardIds = {
    chance: new Set(pack.game.cards.chance.map((card) => card.id)),
    destiny: new Set(pack.game.cards.destiny.map((card) => card.id)),
  };
  for (const deck of ['chance', 'destiny'] as const) {
    const queue = value.decks[deck];
    const expected = pack.game.cards[deck].map((card) => card.id).sort();
    if (!Array.isArray(queue)
      || queue.some((cardId) => typeof cardId !== 'string')
      || queue.length !== expected.length
      || [...queue].sort().some((cardId, index) => cardId !== expected[index])) return fail('invalid deck queue');
  }

  // 单机真人作弊的待确认卡牌：必须是当前未破产真人玩家、牌面属于所声明牌堆、且仍处于可行动阶段。
  if (value.cardChoice !== undefined) {
    const choice = value.cardChoice;
    if (!isRecord(choice) || !hasExactKeys(choice, ['mode', 'pending']) || choice.mode !== 'local-human') {
      return fail('invalid card choice state');
    }
    const pending = choice.pending;
    if (pending !== null) {
      if (!isRecord(pending) || !hasExactKeys(pending, ['playerId', 'deck', 'cardId', 'resumeTurnPhase'])) {
        return fail('invalid pending card choice');
      }
      const pendingPlayerId = pending.playerId;
      const pendingDeck = pending.deck;
      const pendingCardId = pending.cardId;
      const isCardInDeclaredDeck = (pendingDeck === 'chance' || pendingDeck === 'destiny')
        && typeof pendingCardId === 'string'
        && cardIds[pendingDeck].has(pendingCardId);
      const pendingPlayer = players.find((player) => player.id === pendingPlayerId);
      if (value.phase !== 'playing' || value.turnPhase !== 'managing'
        || !validPlayerReference(pendingPlayerId, playerIds)
        || pendingPlayerId !== value.currentPlayerId
        || !isCardInDeclaredDeck
        || typeof pending.resumeTurnPhase !== 'string'
        || !TURN_PHASES.has(pending.resumeTurnPhase)
        || pendingPlayer === undefined || pendingPlayer.isBot || pendingPlayer.bankrupt) {
        return fail('invalid pending card choice');
      }
    }
  }

  if (!validateDebt(value.debt, playerIds)) return fail('invalid debt');
  const debt = value.debt as GameState['debt'];
  if (value.phase === 'game_over' && debt !== null) return fail('invalid terminal debt');
  if (debt !== null && players.find((player) => player.id === debt.debtorId)?.bankrupt) {
    return fail('invalid debtor state');
  }
  if (!(value.lastDice === null || (Array.isArray(value.lastDice)
    && (value.lastDice.length === 1 || value.lastDice.length === 2)
    && value.lastDice.every((die) => Number.isSafeInteger(die) && die >= 1 && die <= 6)))) {
    return fail('invalid dice');
  }
  if (!Array.isArray(value.recentLog) || value.recentLog.length > 200
    || value.recentLog.some((event) => !validateRecentEvent(event, playerIds, cellIds, cardIds, enabledModules))) {
    return fail('invalid recent log');
  }
  if (!(value.cashGoal === null || (isFiniteNonNegative(value.cashGoal) && value.cashGoal > targetConfig.initialCash))) {
    return fail('invalid cash goal');
  }

  const clone = structuredClone(value) as unknown as GameState;
  const state: GameState = {
    ...clone,
    mapRef: pack.ref,
    ruleModules: pack.game.requiredRuleModules,
    board: pack.game.board,
    cards: pack.game.cards,
    // 写回本局生效的 config（而不是地图默认值），否则调用方拿到的 state 会丢掉房主自定义的规则。
    // 地图包自带的那份已冻结、原样复用；房主自定义的那份是运行期拼出来的普通对象，需要就地冻结。
    config: targetConfig === pack.game.config ? targetConfig : deepFreezeConfig(targetConfig),
  };
  return { ok: true, state };
}
