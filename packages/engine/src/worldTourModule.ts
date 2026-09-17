import type {
  DeepReadonly,
  JsonValue,
  ModuleCell,
  ModuleEvent,
  ModuleIntent,
  RuleModuleRef,
} from '@richman/board-data';
import type { ApplyResult, GameEvent, GameState, PlayerState } from './types';
import type { ModuleEffectExecutionContext, RuleModuleDefinition } from './moduleRegistry';
import {
  advanceToNextPlayableTurn,
  applyCardEffect,
  finishCashGoalIfReached,
  getNextCellId,
  processQueuedPayments,
  resolveLanding,
  rollDice,
  rollSingleDice,
  walkPath,
} from './moduleToolkit';

export const WORLD_TOUR_MODULE_REF = Object.freeze({ id: 'world-tour', version: 1 }) satisfies RuleModuleRef;
export const WORLD_TOUR_MODULE_KEY = 'world-tour@1';

interface WorldTourAirportPayload {
  readonly outerNextId: number;
  readonly branchEntryId: number;
  readonly branchCellIds: readonly number[];
  readonly mergeCellId: number;
}

export interface WorldTourPublicModuleState {
  readonly pendingAirportByPlayerId: Readonly<Record<string, number>>;
  readonly branchAirportByPlayerId: Readonly<Record<string, number>>;
  readonly tollImmunityPlayerIds: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isWorldTourAirport(cell: DeepReadonly<ModuleCell> | undefined): cell is DeepReadonly<ModuleCell> {
  return cell?.type === 'module'
    && cell.module.id === WORLD_TOUR_MODULE_REF.id
    && cell.module.version === WORLD_TOUR_MODULE_REF.version
    && cell.cellType === 'airport-branch';
}

function airportPayload(cell: DeepReadonly<ModuleCell>): WorldTourAirportPayload | undefined {
  const payload = cell.payload;
  if (!isRecord(payload)
    || !hasExactKeys(payload, ['outerNextId', 'branchEntryId', 'branchCellIds', 'mergeCellId'])
    || !Number.isSafeInteger(payload.outerNextId)
    || !Number.isSafeInteger(payload.branchEntryId)
    || !Number.isSafeInteger(payload.mergeCellId)
    || !Array.isArray(payload.branchCellIds)
    || payload.branchCellIds.some((cellId) => !Number.isSafeInteger(cellId))) return undefined;
  return payload as unknown as WorldTourAirportPayload;
}

function validateAirportMap(
  value: unknown,
  playersById: ReadonlyMap<string, DeepReadonly<PlayerState>>,
  airportsById: ReadonlyMap<number, DeepReadonly<ModuleCell>>,
  kind: 'pending' | 'branch',
): value is Readonly<Record<string, number>> {
  if (!isRecord(value)) return false;
  for (const [playerId, rawAirportId] of Object.entries(value)) {
    if (!Number.isSafeInteger(rawAirportId)) return false;
    const player = playersById.get(playerId);
    const airport = airportsById.get(rawAirportId as number);
    if (!player || player.bankrupt || !airport) return false;
    const payload = airportPayload(airport);
    if (!payload) return false;
    if (kind === 'pending' && player.position !== airport.id) return false;
    if (kind === 'branch' && !payload.branchCellIds.includes(player.position)) return false;
  }
  return true;
}

export function validateWorldTourPublicModuleState(
  value: unknown,
  board: { readonly cells: readonly unknown[] },
  players: readonly DeepReadonly<PlayerState>[],
): value is WorldTourPublicModuleState {
  if (!isRecord(value) || !hasExactKeys(value, [
    'pendingAirportByPlayerId',
    'branchAirportByPlayerId',
    'tollImmunityPlayerIds',
  ])) return false;

  const playersById = new Map(players.map((player) => [player.id, player]));
  const airportsById = new Map<number, DeepReadonly<ModuleCell>>();
  for (const candidate of board.cells) {
    const cell = candidate as DeepReadonly<ModuleCell>;
    if (isWorldTourAirport(cell)) airportsById.set(cell.id, cell);
  }

  if (!validateAirportMap(value.pendingAirportByPlayerId, playersById, airportsById, 'pending')
    || !validateAirportMap(value.branchAirportByPlayerId, playersById, airportsById, 'branch')) return false;

  const pendingPlayers = new Set(Object.keys(value.pendingAirportByPlayerId));
  const branchPlayers = Object.keys(value.branchAirportByPlayerId);
  if (branchPlayers.some((playerId) => pendingPlayers.has(playerId))) return false;

  if (!Array.isArray(value.tollImmunityPlayerIds)) return false;
  const immunityPlayers = new Set<string>();
  for (const playerId of value.tollImmunityPlayerIds) {
    if (typeof playerId !== 'string' || immunityPlayers.has(playerId)) return false;
    const player = playersById.get(playerId);
    if (!player || player.bankrupt) return false;
    immunityPlayers.add(playerId);
  }
  return true;
}

export function worldTourStateAsJson(value: WorldTourPublicModuleState): JsonValue {
  return value as unknown as JsonValue;
}

function emptyWorldTourState(): WorldTourPublicModuleState {
  return {
    pendingAirportByPlayerId: {},
    branchAirportByPlayerId: {},
    tollImmunityPlayerIds: [],
  };
}

function readWorldTourState(state: GameState): WorldTourPublicModuleState {
  const value = state.publicRuleState.modules[WORLD_TOUR_MODULE_KEY];
  return isRecord(value)
    ? value as unknown as WorldTourPublicModuleState
    : emptyWorldTourState();
}

function hasWorldTourState(value: WorldTourPublicModuleState): boolean {
  return Object.keys(value.pendingAirportByPlayerId).length > 0
    || Object.keys(value.branchAirportByPlayerId).length > 0
    || value.tollImmunityPlayerIds.length > 0;
}

function withWorldTourState(
  state: GameState,
  worldState: WorldTourPublicModuleState,
  pendingActions = state.publicRuleState.pendingActions,
): GameState {
  const modules = { ...state.publicRuleState.modules };
  if (hasWorldTourState(worldState)) modules[WORLD_TOUR_MODULE_KEY] = worldTourStateAsJson(worldState);
  else delete modules[WORLD_TOUR_MODULE_KEY];
  return {
    ...state,
    publicRuleState: { modules, pendingActions },
  };
}

function getAirport(state: GameState, airportId: number): DeepReadonly<ModuleCell> | undefined {
  const cell = state.board.cells.find((candidate) => candidate.id === airportId) as DeepReadonly<ModuleCell> | undefined;
  return isWorldTourAirport(cell) && airportPayload(cell) ? cell : undefined;
}

function cleanWorldTourState(state: GameState): WorldTourPublicModuleState {
  const current = readWorldTourState(state);
  const pendingAirportByPlayerId: Record<string, number> = {};
  const branchAirportByPlayerId: Record<string, number> = {};
  const alivePlayers = new Map(state.players.filter((player) => !player.bankrupt).map((player) => [player.id, player]));

  for (const [playerId, airportId] of Object.entries(current.pendingAirportByPlayerId)) {
    const player = alivePlayers.get(playerId);
    const airport = getAirport(state, airportId);
    if (player && airport && player.position === airportId) pendingAirportByPlayerId[playerId] = airportId;
  }
  for (const [playerId, airportId] of Object.entries(current.branchAirportByPlayerId)) {
    const player = alivePlayers.get(playerId);
    const airport = getAirport(state, airportId);
    const payload = airport && airportPayload(airport);
    if (player && payload?.branchCellIds.includes(player.position)) branchAirportByPlayerId[playerId] = airportId;
  }

  return {
    pendingAirportByPlayerId,
    branchAirportByPlayerId,
    tollImmunityPlayerIds: current.tollImmunityPlayerIds.filter((playerId, index, all) => (
      alivePlayers.has(playerId) && all.indexOf(playerId) === index
    )),
  };
}

function worldTourRollAction(
  state: GameState,
  worldState: WorldTourPublicModuleState,
): GameState['publicRuleState']['pendingActions'][number] | undefined {
  if (state.phase !== 'playing' || state.debt !== null || state.turnPhase !== 'awaiting_roll') return undefined;
  const playerId = state.currentPlayerId;
  const airportId = worldState.pendingAirportByPlayerId[playerId];
  if (airportId !== undefined) {
    const optionId = `${WORLD_TOUR_MODULE_KEY}:airport-entry:${playerId}:${airportId}:${state.turn}`;
    return {
      optionId,
      module: WORLD_TOUR_MODULE_REF,
      playerId,
      requiredPhase: 'awaiting_roll',
      label: '掷骰子',
      action: 'enter-airport-branch',
      payload: { optionId, airportCellId: airportId },
    };
  }
  const branchAirportId = worldState.branchAirportByPlayerId[playerId];
  if (branchAirportId !== undefined) {
    const optionId = `${WORLD_TOUR_MODULE_KEY}:branch-roll:${playerId}:${branchAirportId}:${state.turn}`;
    return {
      optionId,
      module: WORLD_TOUR_MODULE_REF,
      playerId,
      requiredPhase: 'awaiting_roll',
      label: '掷骰子',
      action: 'roll-branch',
      payload: { optionId },
    };
  }
  return undefined;
}

function synchronizeWorldTourState(state: GameState): GameState {
  const worldState = cleanWorldTourState(state);
  const otherActions = state.publicRuleState.pendingActions.filter((action) => (
    action.module.id !== WORLD_TOUR_MODULE_REF.id
    || action.module.version !== WORLD_TOUR_MODULE_REF.version
    || (action.action !== 'enter-airport-branch' && action.action !== 'roll-branch')
  ));
  const rollAction = worldTourRollAction(state, worldState);
  return withWorldTourState(state, worldState, rollAction ? [...otherActions, rollAction] : otherActions);
}

function moduleEvent(eventType: string, payload: JsonValue): ModuleEvent {
  return { type: 'module', module: WORLD_TOUR_MODULE_REF, eventType, payload };
}

function settleAirportLanding(context: Parameters<NonNullable<RuleModuleDefinition['cellHandlers'][number]>['handle']>[0]) {
  const airport = context.cell as DeepReadonly<ModuleCell>;
  const player = context.state.players.find((candidate) => candidate.id === context.playerId);
  if (!player || player.position !== airport.id || !getAirport(context.state, airport.id)) return context.applyCore();

  const current = readWorldTourState(context.state);
  const pendingAirportByPlayerId = { ...current.pendingAirportByPlayerId, [context.playerId]: airport.id };
  const branchAirportByPlayerId = { ...current.branchAirportByPlayerId };
  delete branchAirportByPlayerId[context.playerId];
  const event = moduleEvent('airport_wait_started', {
    playerId: context.playerId,
    airportCellId: airport.id,
  });
  const waitingState = withWorldTourState(
    { ...context.state, turnPhase: 'managing' },
    { ...current, pendingAirportByPlayerId, branchAirportByPlayerId },
    context.state.publicRuleState.pendingActions.filter((action) => action.playerId !== context.playerId),
  );
  const advanced = advanceToNextPlayableTurn(waitingState, context.playerId, [...context.events, event]);
  return { state: advanced.state, events: advanced.events, newDebt: advanced.state.debt };
}

function matchingPendingAction(state: GameState, playerId: string, intent: ModuleIntent) {
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

function optionId(
  state: GameState,
  playerId: string,
  cardId: string,
  action: string,
  suffix: string | number,
): string {
  return `${WORLD_TOUR_MODULE_KEY}:${cardId}:${action}:${playerId}:${state.turn}:${suffix}`;
}

function makeChoiceAction(
  state: GameState,
  playerId: string,
  cardId: string,
  action: string,
  label: string,
  suffix: string | number,
  extraPayload: Readonly<Record<string, JsonValue>>,
): GameState['publicRuleState']['pendingActions'][number] {
  const id = optionId(state, playerId, cardId, action, suffix);
  return {
    optionId: id,
    module: WORLD_TOUR_MODULE_REF,
    playerId,
    requiredPhase: 'managing',
    label,
    action,
    payload: { optionId: id, ...extraPayload },
  };
}

function withChoiceActions(
  state: GameState,
  playerId: string,
  actions: readonly GameState['publicRuleState']['pendingActions'][number][],
): GameState {
  return {
    ...state,
    turnPhase: 'managing',
    publicRuleState: {
      ...state.publicRuleState,
      pendingActions: [
        ...state.publicRuleState.pendingActions.filter((action) => action.playerId !== playerId),
        ...actions,
      ],
    },
  };
}

function withoutPlayerWorldTourActions(state: GameState, playerId: string): GameState {
  return {
    ...state,
    publicRuleState: {
      ...state.publicRuleState,
      pendingActions: state.publicRuleState.pendingActions.filter((action) => !(
        action.playerId === playerId
        && action.module.id === WORLD_TOUR_MODULE_REF.id
        && action.module.version === WORLD_TOUR_MODULE_REF.version
      )),
    },
  };
}

function outerRoute(state: GameState): readonly number[] {
  const start = state.board.cells.find((cell) => cell.type === 'start');
  if (!start) return [];
  const route = [start.id];
  let current = getNextCellId(state.board, start.id);
  while (current !== start.id && route.length <= state.board.cells.length) {
    route.push(current);
    current = getNextCellId(state.board, current);
  }
  return current === start.id ? route : [];
}

function isPurchasableCell(state: GameState, cellId: number): boolean {
  return state.board.cells.some(
    (cell) => cell.id === cellId
      && cell.type === 'property'
      && (cell.subtype === 'normal' || cell.subtype === 'station'),
  );
}

function moduleEffectResult(
  state: GameState,
  events: GameEvent[],
): { state: GameState; events: GameEvent[]; newDebt: GameState['debt'] } {
  return { state, events, newDebt: state.debt };
}

function grantTollImmunity(context: ModuleEffectExecutionContext) {
  const current = readWorldTourState(context.state);
  const tollImmunityPlayerIds = current.tollImmunityPlayerIds.includes(context.playerId)
    ? current.tollImmunityPlayerIds
    : [...current.tollImmunityPlayerIds, context.playerId];
  const state = withWorldTourState(context.state, { ...current, tollImmunityPlayerIds });
  return moduleEffectResult(state, [
    ...context.events,
    moduleEvent('toll_immunity_granted', { playerId: context.playerId }),
  ]);
}

function offerBusChoice(context: ModuleEffectExecutionContext) {
  const [dice, seed] = rollDice(Number(context.state.seed));
  const values = [dice[0], dice[1], dice[0] + dice[1]];
  const labels = [
    `前进 ${values[0]} 格（骰子 A）`,
    `前进 ${values[1]} 格（骰子 B）`,
    `前进 ${values[2]} 格（两骰之和）`,
  ];
  const actions = values.map((steps, index) => makeChoiceAction(
    context.state,
    context.playerId,
    context.card.id,
    'bus-move',
    labels[index],
    index,
    { steps },
  ));
  const state = withChoiceActions({
    ...context.state,
    seed: String(seed),
    lastDice: dice,
  }, context.playerId, actions);
  return moduleEffectResult(state, [
    ...context.events,
    { type: 'dice_rolled', playerId: context.playerId, dice },
  ]);
}

function offerFlight(context: ModuleEffectExecutionContext, longDistance: boolean) {
  const payload = context.card.effect.payload;
  if (!isRecord(payload) || !Number.isSafeInteger(payload.cost)) return context.applyCore();
  const cost = payload.cost as number;
  const player = context.state.players.find((candidate) => candidate.id === context.playerId);
  if (!player) return context.applyCore();
  const action = longDistance ? 'long-flight' : 'short-flight';
  const targets: number[] = [];
  if (player.cash >= cost) {
    const outer = new Set(outerRoute(context.state));
    if (longDistance) {
      for (const cellId of outer) {
        if (isPurchasableCell(context.state, cellId)) targets.push(cellId);
      }
    } else if (Number.isSafeInteger(payload.maxForwardSteps)) {
      let current = player.position;
      for (let step = 1; step <= (payload.maxForwardSteps as number); step += 1) {
        current = getNextCellId(context.state.board, current);
        if (outer.has(current) && isPurchasableCell(context.state, current)) targets.push(current);
      }
    }
  }
  const actions = [
    makeChoiceAction(context.state, context.playerId, context.card.id, action, '不搭乘', 'decline', {
      targetCellId: null,
      cost,
    }),
    ...targets.map((cellId) => {
      const cell = context.state.board.cells.find((candidate) => candidate.id === cellId)!;
      return makeChoiceAction(context.state, context.playerId, context.card.id, action, cell.name, cellId, {
        targetCellId: cellId,
        cost,
      });
    }),
  ];
  return moduleEffectResult(withChoiceActions(context.state, context.playerId, actions), [...context.events]);
}

function offerFreeUpgrade(context: ModuleEffectExecutionContext) {
  const eligible = context.state.board.cells.filter((cell) => {
    if (cell.type !== 'property' || cell.subtype !== 'normal') return false;
    const property = context.state.properties[cell.id];
    return property !== undefined
      && !property.mortgaged
      && property.level < context.state.config.maxHouseLevel;
  });
  const actions = eligible.map((cell) => makeChoiceAction(
    context.state,
    context.playerId,
    context.card.id,
    'free-upgrade',
    `升级 ${cell.name}`,
    cell.id,
    { cellId: cell.id },
  ));
  return moduleEffectResult(withChoiceActions(context.state, context.playerId, actions), [...context.events]);
}

function offerDiceDuel(context: ModuleEffectExecutionContext) {
  const payload = context.card.effect.payload;
  if (!isRecord(payload) || !Number.isSafeInteger(payload.amount)) return context.applyCore();
  const actions = context.state.players
    .filter((player) => player.id !== context.playerId && !player.bankrupt)
    .map((player) => makeChoiceAction(
      context.state,
      context.playerId,
      context.card.id,
      'dice-duel',
      `挑战 ${player.nickname}`,
      player.id,
      { opponentId: player.id, amount: payload.amount as number },
    ));
  return moduleEffectResult(withChoiceActions(context.state, context.playerId, actions), [...context.events]);
}

function applyLowestCashAid(context: ModuleEffectExecutionContext) {
  const payload = context.card.effect.payload;
  if (!isRecord(payload) || !Number.isSafeInteger(payload.amount)) return context.applyCore();
  const amount = payload.amount as number;
  const alive = context.state.players.filter((player) => !player.bankrupt);
  const minimum = Math.min(...alive.map((player) => player.cash));
  const drawerIndex = context.state.players.findIndex((player) => player.id === context.playerId);
  let target = context.state.players[drawerIndex];
  for (let offset = 0; offset < context.state.players.length; offset += 1) {
    const candidate = context.state.players[(drawerIndex + offset) % context.state.players.length];
    if (!candidate.bankrupt && candidate.cash === minimum) {
      target = candidate;
      break;
    }
  }
  const events: GameEvent[] = [
    ...context.events,
    { type: 'bank_received', playerId: target.id, amount },
  ];
  const state = {
    ...context.state,
    players: context.state.players.map((player) => (
      player.id === target.id ? { ...player, cash: player.cash + amount } : player
    )),
  };
  const win = finishCashGoalIfReached(state, events);
  return {
    state: win?.state ?? state,
    events: win?.events ?? events,
    newDebt: null,
  };
}

function handleWorldTourEffect(context: ModuleEffectExecutionContext) {
  switch (context.card.effect.effectType) {
    case 'toll-immunity':
      return grantTollImmunity(context);
    case 'bus-choice':
      return offerBusChoice(context);
    case 'short-flight':
      return offerFlight(context, false);
    case 'long-flight':
      return offerFlight(context, true);
    case 'free-upgrade':
      return offerFreeUpgrade(context);
    case 'dice-duel':
      return offerDiceDuel(context);
    case 'lowest-cash-aid':
      return applyLowestCashAid(context);
    default:
      return context.applyCore();
  }
}

function finishSingleDieMovement(
  state: GameState,
  playerId: string,
  path: number[],
  finalCellId: number,
  die: number,
  rngState: number,
  worldState: WorldTourPublicModuleState,
): ApplyResult {
  const events: GameEvent[] = [
    { type: 'dice_rolled', playerId, dice: [die] },
    { type: 'token_moved', playerId, path },
  ];
  const workingState = withWorldTourState({
    ...state,
    players: state.players.map((player) => (
      player.id === playerId ? { ...player, position: finalCellId } : player
    )),
    seed: String(rngState),
    lastDice: [die],
  }, worldState, state.publicRuleState.pendingActions.filter((action) => action.playerId !== playerId));
  const settled = resolveLanding(workingState, playerId, events);
  return {
    ok: true,
    state: {
      ...settled.state,
      debt: settled.newDebt,
      recentLog: [...state.recentLog, ...settled.events].slice(-200),
    },
    events: settled.events,
  };
}

function handleAirportEntry(state: GameState, playerId: string, intent: ModuleIntent): ApplyResult {
  if (state.turnPhase !== 'awaiting_roll' || !matchingPendingAction(state, playerId, intent)) {
    return { ok: false, code: 'WRONG_PHASE' };
  }
  const current = readWorldTourState(state);
  const airportId = current.pendingAirportByPlayerId[playerId];
  const airport = airportId === undefined ? undefined : getAirport(state, airportId);
  const payload = airport && airportPayload(airport);
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!airport || !payload || player?.position !== airportId) return { ok: false, code: 'ILLEGAL_INTENT' };

  const [die, rngState] = rollSingleDice(Number(state.seed));
  const walk = walkPath(state.board, payload.branchEntryId, die - 1);
  const pendingAirportByPlayerId = { ...current.pendingAirportByPlayerId };
  delete pendingAirportByPlayerId[playerId];
  return finishSingleDieMovement(
    state,
    playerId,
    [payload.branchEntryId, ...walk.path],
    walk.finalCellId,
    die,
    rngState,
    {
      ...current,
      pendingAirportByPlayerId,
      branchAirportByPlayerId: { ...current.branchAirportByPlayerId, [playerId]: airportId },
    },
  );
}

function handleBranchRoll(state: GameState, playerId: string, intent: ModuleIntent): ApplyResult {
  if (state.turnPhase !== 'awaiting_roll' || !matchingPendingAction(state, playerId, intent)) {
    return { ok: false, code: 'WRONG_PHASE' };
  }
  const current = readWorldTourState(state);
  const airportId = current.branchAirportByPlayerId[playerId];
  const airport = airportId === undefined ? undefined : getAirport(state, airportId);
  const payload = airport && airportPayload(airport);
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!payload || !player || !payload.branchCellIds.includes(player.position)) {
    return { ok: false, code: 'ILLEGAL_INTENT' };
  }

  const [die, rngState] = rollSingleDice(Number(state.seed));
  const walk = walkPath(state.board, player.position, die);
  return finishSingleDieMovement(state, playerId, walk.path, walk.finalCellId, die, rngState, current);
}

function handleWorldTourIntent(state: GameState, playerId: string, intent: ModuleIntent): ApplyResult {
  if (intent.action === 'enter-airport-branch') return handleAirportEntry(state, playerId, intent);
  if (intent.action === 'roll-branch') return handleBranchRoll(state, playerId, intent);
  const pending = matchingPendingAction(state, playerId, intent);
  if (!pending || !isRecord(pending.payload)) return { ok: false, code: 'WRONG_PHASE' };
  const cleanState = withoutPlayerWorldTourActions(state, playerId);

  if (intent.action === 'bus-move') {
    const steps = pending.payload.steps;
    if (!Number.isSafeInteger(steps) || (steps as number) <= 0) return { ok: false, code: 'ILLEGAL_INTENT' };
    const result = applyCardEffect(cleanState, playerId, {
      id: 'world-tour-bus-move',
      effect: { type: 'move_steps', steps: steps as number },
    }, []);
    return {
      ok: true,
      state: { ...result.state, debt: result.newDebt, recentLog: [...state.recentLog, ...result.events].slice(-200) },
      events: result.events,
    };
  }

  if (intent.action === 'short-flight' || intent.action === 'long-flight') {
    const targetCellId = pending.payload.targetCellId;
    const cost = pending.payload.cost;
    if (targetCellId === null) {
      const events = [moduleEvent('flight_declined', { playerId, kind: intent.action })];
      return {
        ok: true,
        state: { ...cleanState, turnPhase: 'managing', recentLog: [...state.recentLog, ...events].slice(-200) },
        events,
      };
    }
    if (!Number.isSafeInteger(targetCellId) || !Number.isSafeInteger(cost)) {
      return { ok: false, code: 'ILLEGAL_INTENT' };
    }
    const player = cleanState.players.find((candidate) => candidate.id === playerId);
    if (!player || player.cash < (cost as number)) return { ok: false, code: 'INSUFFICIENT_FUNDS' };
    const events: GameEvent[] = [
      { type: 'bank_paid', playerId, amount: cost as number },
      { type: 'token_moved', playerId, path: [targetCellId as number] },
    ];
    const moved: GameState = {
      ...cleanState,
      players: cleanState.players.map((candidate) => (
        candidate.id === playerId
          ? { ...candidate, cash: candidate.cash - (cost as number), position: targetCellId as number }
          : candidate
      )),
    };
    const settled = resolveLanding(moved, playerId, events);
    return {
      ok: true,
      state: {
        ...settled.state,
        debt: settled.newDebt,
        recentLog: [...state.recentLog, ...settled.events].slice(-200),
      },
      events: settled.events,
    };
  }

  if (intent.action === 'free-upgrade') {
    const cellId = pending.payload.cellId;
    if (!Number.isSafeInteger(cellId)) return { ok: false, code: 'ILLEGAL_INTENT' };
    const cell = cleanState.board.cells.find((candidate) => candidate.id === cellId);
    const property = cleanState.properties[cellId as number];
    if (cell?.type !== 'property' || cell.subtype !== 'normal' || !property
      || property.mortgaged || property.level >= cleanState.config.maxHouseLevel) {
      return { ok: false, code: 'ILLEGAL_INTENT' };
    }
    const level = property.level + 1;
    const events: GameEvent[] = [{ type: 'house_built', cellId: cellId as number, level, amount: 0 }];
    return {
      ok: true,
      state: {
        ...cleanState,
        turnPhase: 'managing',
        properties: {
          ...cleanState.properties,
          [cellId as number]: { ...property, level },
        },
        recentLog: [...state.recentLog, ...events].slice(-200),
      },
      events,
    };
  }

  if (intent.action === 'dice-duel') {
    const opponentId = pending.payload.opponentId;
    const amount = pending.payload.amount;
    const opponent = cleanState.players.find((candidate) => candidate.id === opponentId);
    if (typeof opponentId !== 'string' || opponentId === playerId || opponent?.bankrupt
      || !Number.isSafeInteger(amount) || (amount as number) <= 0) {
      return { ok: false, code: 'ILLEGAL_INTENT' };
    }
    let seed = Number(cleanState.seed);
    let playerDie = 0;
    let opponentDie = 0;
    const events: GameEvent[] = [];
    do {
      [playerDie, seed] = rollSingleDice(seed);
      [opponentDie, seed] = rollSingleDice(seed);
      events.push({ type: 'dice_rolled', playerId, dice: [playerDie] });
      events.push({ type: 'dice_rolled', playerId: opponentId, dice: [opponentDie] });
    } while (playerDie === opponentDie);
    const winnerId = playerDie > opponentDie ? playerId : opponentId;
    const loserId = winnerId === playerId ? opponentId : playerId;
    const paid = processQueuedPayments(
      { ...cleanState, seed: String(seed), turnPhase: 'managing' },
      [{ debtorId: loserId, creditorId: winnerId, amount: amount as number }],
      events,
    );
    return {
      ok: true,
      state: {
        ...paid.state,
        debt: paid.newDebt,
        recentLog: [...state.recentLog, ...paid.events].slice(-200),
      },
      events: paid.events,
    };
  }
  return { ok: false, code: 'ILLEGAL_INTENT' };
}

const worldTourRuleModuleInput: RuleModuleDefinition = {
  ref: WORLD_TOUR_MODULE_REF,
  cellHandlers: [{
    type: 'module',
    cellType: 'airport-branch',
    handle: settleAirportLanding,
  }],
  effectHandlers: [
    'toll-immunity',
    'bus-choice',
    'short-flight',
    'long-flight',
    'free-upgrade',
    'dice-duel',
    'lowest-cash-aid',
  ].map((effectType) => ({
    type: 'module' as const,
    effectType,
    handle: handleWorldTourEffect,
  })),
  intentHandlers: [
    {
      type: 'module',
      action: 'enter-airport-branch',
      handle: (context) => context.intent.type === 'module'
        ? handleWorldTourIntent(context.state, context.playerId, context.intent)
        : { ok: false, code: 'ILLEGAL_INTENT' },
    },
    {
      type: 'module',
      action: 'roll-branch',
      handle: (context) => context.intent.type === 'module'
        ? handleWorldTourIntent(context.state, context.playerId, context.intent)
        : { ok: false, code: 'ILLEGAL_INTENT' },
    },
    ...['bus-move', 'short-flight', 'long-flight', 'free-upgrade', 'dice-duel'].map((action) => ({
      type: 'module' as const,
      action,
      handle: (context: Parameters<RuleModuleDefinition['intentHandlers'][number]['handle']>[0]) => (
        context.intent.type === 'module'
          ? handleWorldTourIntent(context.state, context.playerId, context.intent)
          : { ok: false as const, code: 'ILLEGAL_INTENT' as const }
      ),
    })),
  ],
  botStrategyHook: {
    decide: (context) => {
      const action = context.state.publicRuleState.pendingActions.find((candidate) => (
        candidate.playerId === context.playerId
        && candidate.module.id === WORLD_TOUR_MODULE_REF.id
        && candidate.module.version === WORLD_TOUR_MODULE_REF.version
      ));
      return action ? {
        type: 'module',
        module: action.module,
        action: action.action,
        payload: action.payload,
      } : context.currentDecision;
    },
  },
  postTransitionHook: {
    apply: (context) => context.result.ok
      ? { ...context.result, state: synchronizeWorldTourState(context.result.state) }
      : context.result,
  },
  positiveRentHook: {
    apply: (context) => {
      if (context.amount <= 0) return context;
      const current = readWorldTourState(context.state);
      if (!current.tollImmunityPlayerIds.includes(context.payerId)) return context;
      const tollImmunityPlayerIds = current.tollImmunityPlayerIds.filter((playerId) => playerId !== context.payerId);
      return {
        state: withWorldTourState(context.state, { ...current, tollImmunityPlayerIds }),
        events: [
          ...context.events,
          moduleEvent('toll_immunity_used', {
            playerId: context.payerId,
            ownerId: context.ownerId,
            cellId: context.cellId,
            amount: context.amount,
          }),
        ],
        amount: 0,
      };
    },
  },
};

export const worldTourRuleModuleDefinition = worldTourRuleModuleInput;
