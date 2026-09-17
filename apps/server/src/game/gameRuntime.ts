import { applyIntent, chooseBotIntent, createGame, skipCurrentTurn } from '@richman/engine';
import type { BoardData, CardsData, DeepReadonly, GameConfig, MapRef, RuleModuleRef } from '@richman/board-data';
import type {
  ApplyResult,
  CreateGameInput,
  ErrorCode,
  GameEvent,
  GameState,
  Intent,
} from '@richman/engine';

export interface GameRuntimeGateway {
  createGame(input: CreateGameInput): GameState;
  applyIntent(state: GameState, playerId: string, intent: Intent): ApplyResult;
  chooseBotIntent(state: GameState, playerId: string): Intent;
}

export const defaultGameGateway: GameRuntimeGateway = { createGame, applyIntent, chooseBotIntent };

const NO_ARG_INTENTS = new Set<Intent['type']>([
  'roll_dice',
  'roll_airport_branch',
  'buy_property',
  'skip_buy',
  'build_house',
  'skip_build',
  'end_turn',
  'declare_bankrupt',
]);

const CELL_ID_INTENTS = new Set<Intent['type']>([
  'sell_house',
  'sell_property',
  'mortgage_property',
  'redeem_property',
]);

const MODULE_INTENT_MAX_BYTES = 16 * 1024;

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(record);
  return actual.length === keys.length && actual.every((key) => typeof key === 'string')
    && keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      return descriptor?.enumerable === true && 'value' in descriptor;
    });
}

function dataValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function hasPlainPrototype(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown, seen = new Set<object>(), depth = 0, nodes = { count: 0 }): boolean {
  nodes.count += 1;
  if (nodes.count > 2_048 || depth > 32) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== 'string')
      || ownKeys.length !== value.length + 1
      || !ownKeys.includes('length')) {
      seen.delete(value);
      return false;
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)
        || !isJsonValue(descriptor.value, seen, depth + 1, nodes)) {
        seen.delete(value);
        return false;
      }
    }
    seen.delete(value);
    return true;
  }

  if (!hasPlainPrototype(value)) {
    seen.delete(value);
    return false;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      seen.delete(value);
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)
      || !isJsonValue(descriptor.value, seen, depth + 1, nodes)) {
      seen.delete(value);
      return false;
    }
  }
  seen.delete(value);
  return true;
}

function isValidModuleIntent(record: Record<string, unknown>): boolean {
  if (!hasPlainPrototype(record) || !hasExactKeys(record, ['type', 'module', 'action', 'payload'])) return false;
  const moduleValue = dataValue(record, 'module');
  const action = dataValue(record, 'action');
  const payload = dataValue(record, 'payload');
  if (moduleValue === null || typeof moduleValue !== 'object' || Array.isArray(moduleValue)
    || !hasPlainPrototype(moduleValue)) return false;
  const module = moduleValue as Record<string, unknown>;
  const moduleId = dataValue(module, 'id');
  const moduleVersion = dataValue(module, 'version');
  if (!hasExactKeys(module, ['id', 'version'])
    || typeof moduleId !== 'string'
    || moduleId.length === 0
    || moduleId.length > 64
    || moduleId.trim() !== moduleId
    || !Number.isSafeInteger(moduleVersion)
    || (moduleVersion as number) <= 0
    || typeof action !== 'string'
    || action.length === 0
    || action.length > 128
    || action.trim() !== action
    || !isJsonValue(payload)) return false;

  return new TextEncoder().encode(JSON.stringify(record)).byteLength <= MODULE_INTENT_MAX_BYTES;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => (
    key === rightKeys[index] && jsonEqual(leftRecord[key], rightRecord[key])
  ));
}

function isAuthorizedModuleIntent(state: GameState, playerId: string, intent: Extract<Intent, { type: 'module' }>): boolean {
  const enabled = state.ruleModules.some((module) => (
    module.id === intent.module.id && module.version === intent.module.version
  ));
  if (!enabled || state.currentPlayerId !== playerId || state.debt !== null) return false;
  return state.publicRuleState.pendingActions.some((action) => (
    action.playerId === playerId
    && action.requiredPhase === state.turnPhase
    && action.module.id === intent.module.id
    && action.module.version === intent.module.version
    && action.action === intent.action
    && jsonEqual(action.payload, intent.payload)
  ));
}

export function isValidIntent(value: unknown): value is Intent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;

  const record = value as Record<string, unknown>;
  const type = dataValue(record, 'type');
  if (typeof type !== 'string') return false;
  if (type === 'module') return isValidModuleIntent(record);
  if (NO_ARG_INTENTS.has(type as Intent['type'])) return true;
  if (CELL_ID_INTENTS.has(type as Intent['type'])) return Number.isInteger(dataValue(record, 'cellId'));
  return false;
}

export type CreateInitialGameResult =
  | { ok: true; state: GameState }
  | { ok: false; message: string; error: unknown };

export function createInitialGame(
  gateway: GameRuntimeGateway,
  players: { id: string; nickname: string; isBot: boolean }[],
  seed: string,
  board: DeepReadonly<BoardData>,
  cards: DeepReadonly<CardsData>,
  config: DeepReadonly<GameConfig>,
  mapRef: MapRef,
  ruleModules: readonly RuleModuleRef[],
): CreateInitialGameResult {
  try {
    return {
      ok: true,
      state: gateway.createGame({ board, cards, config, mapRef, ruleModules, players, seed, cashGoal: null }),
    };
  } catch (error) {
    return { ok: false, message: 'Unable to start the game with the current room players.', error };
  }
}

export type GameApplyOutcome =
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; code: ErrorCode; error?: unknown };

export function applyGameIntent(
  gateway: GameRuntimeGateway,
  state: GameState,
  playerId: string,
  intent: Intent,
): GameApplyOutcome {
  if (intent.type === 'module' && !isAuthorizedModuleIntent(state, playerId, intent)) {
    return { ok: false, code: 'ILLEGAL_INTENT' };
  }
  let result: ApplyResult;
  try {
    result = gateway.applyIntent(state, playerId, intent);
  } catch (error) {
    return { ok: false, code: 'ILLEGAL_INTENT', error };
  }

  if (!result.ok) return { ok: false, code: result.code };
  return { ok: true, state: result.state, events: result.events };
}

export function skipOfflineTakeoverTurn(state: GameState, playerId: string): GameApplyOutcome {
  try {
    const result = skipCurrentTurn(state, playerId);
    return result.ok
      ? { ok: true, state: result.state, events: result.events }
      : { ok: false, code: result.code };
  } catch (error) {
    return { ok: false, code: 'ILLEGAL_INTENT', error };
  }
}

const TAKEOVER_POLICY: Record<GameState['turnPhase'], Intent> = {
  awaiting_roll: { type: 'roll_dice' },
  awaiting_airport_roll: { type: 'roll_airport_branch' },
  awaiting_buy_decision: { type: 'skip_buy' },
  awaiting_build_decision: { type: 'skip_build' },
  managing: { type: 'end_turn' },
};

export function chooseTakeoverIntent(state: GameState): Intent | null {
  const pendingActions = state.publicRuleState.pendingActions.filter((action) => (
    action.playerId === state.currentPlayerId
    && action.requiredPhase === state.turnPhase
    && action.module.id === 'world-tour'
    && action.module.version === 1
  ));
  if (pendingActions.some((action) => (
    action.action === 'enter-airport-branch' || action.action === 'roll-branch'
  ))) return null;
  if (pendingActions.length > 0) return chooseBotIntent(state, state.currentPlayerId);
  return TAKEOVER_POLICY[state.turnPhase];
}
