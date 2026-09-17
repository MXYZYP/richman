import { getMapPack, type MapPack, type MapRef } from '@richman/board-data';
import { hydrateGameState, type GameState } from '@richman/engine';
import type { StorageLike } from './sessionStorage';

export type { StorageLike } from './sessionStorage';

export const LOCAL_GAME_SAVE_KEYS = ['richman_local_game_1', 'richman_local_game_2'] as const;
export type LocalSaveSlot = 1 | 2;
export const LOCAL_GAME_SCHEMA_VERSION = 2;

export interface LocalGameSaveV2 {
  schemaVersion: 2;
  gameId: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  state: GameState;
}

export interface LocalSaveSummary {
  slot: LocalSaveSlot;
  gameId: string;
  revision: number;
  recordToken: string;
  title: string;
  players: { nickname: string; isBot: boolean }[];
  turn: number;
  updatedAt: number;
}

export type LocalSaveCard =
  | { kind: 'valid'; summary: LocalSaveSummary }
  | { kind: 'invalid'; slot: LocalSaveSlot; reason: string; recordToken?: string };

export type LocalSaveReadResult =
  | { kind: 'valid'; slot: LocalSaveSlot; save: LocalGameSaveV2; summary: LocalSaveSummary; recordToken: string }
  | { kind: 'incompatible'; slot: LocalSaveSlot; reason: string; recordToken: string }
  | { kind: 'corrupt'; slot: LocalSaveSlot; reason: string; recordToken?: string }
  | { kind: 'completed'; slot: LocalSaveSlot; gameId: string; revision: number; recordToken: string; reason: string }
  | { kind: 'empty'; slot: LocalSaveSlot };

export type CreateLocalSaveResult =
  | { ok: true; slot: LocalSaveSlot; gameId: string; revision: number; recordToken: string }
  | { ok: false; reason: 'no_empty_slot'; oldestSlot: LocalSaveSlot; oldestGameId: string }
  | { ok: false; reason: 'no_replaceable_slot' | 'storage_error' };

export type CommitLocalSaveResult =
  | { ok: true; slot: LocalSaveSlot; revision: number }
  | { ok: false; reason: 'not_found' | 'game_id_mismatch' | 'revision_mismatch' | 'storage_error' };

type CommitLocalSaveWithTokenResult =
  | { ok: true; slot: LocalSaveSlot; revision: number; recordToken: string }
  | Extract<CommitLocalSaveResult, { ok: false }>;

export type RemoveLocalSaveResult =
  | { ok: true; slot: LocalSaveSlot }
  | { ok: false; reason: 'record_mismatch' | 'storage_error' };

export type ReplaceLocalSaveResult =
  | { ok: true; slot: LocalSaveSlot; gameId: string; revision: number; recordToken: string }
  | { ok: false; reason: 'not_found' | 'record_mismatch' | 'storage_error' };

export type SlotChoice =
  | { kind: 'empty'; slot: LocalSaveSlot }
  | { kind: 'replace_oldest'; slot: LocalSaveSlot; gameId: string }
  | { kind: 'unavailable' };

export interface LocalSaveMapRegistry {
  getMapPack(ref: MapRef): MapPack;
}

export interface LocalGamePersistence {
  readonly slot: LocalSaveSlot;
  readonly gameId: string;
  readonly revision: number;
  readonly recordToken: string;
  commit(nextState: GameState): Promise<CommitLocalSaveResult>;
  complete(finalState: GameState): Promise<CommitLocalSaveResult>;
}

export interface LocalSaveIdentity {
  readonly slot: LocalSaveSlot;
  readonly gameId: string;
  readonly revision: number;
  readonly recordToken: string;
}

export interface LocalSaveObservedRecord {
  readonly slot: LocalSaveSlot;
  readonly recordToken: string;
}

export interface LocalSaveMutationLock {
  runExclusive<T>(operation: () => T): Promise<T>;
}

const defaultRegistry: LocalSaveMapRegistry = { getMapPack };
const CORRUPT_REASON = '存档内容已损坏，无法恢复';
const INCOMPATIBLE_REASON = '该存档来自不兼容的游戏版本';
const MAP_REASON = '找不到这局使用的地图版本';
const STORAGE_REASON = '浏览器无法保存本次操作，请检查存储权限后重试';
const LOCAL_SAVE_LOCK_NAME = 'richman-local-game-saves';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isMapRef(value: unknown): value is MapRef {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'version', 'contentHash'])
    && typeof value.id === 'string' && value.id.trim() !== ''
    && typeof value.version === 'number' && Number.isSafeInteger(value.version) && value.version > 0
    && typeof value.contentHash === 'string' && value.contentHash.trim() !== '';
}

function parseEnvelope(value: unknown): LocalGameSaveV2 | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion', 'gameId', 'createdAt', 'updatedAt', 'revision', 'state',
  ])) return null;
  if (value.schemaVersion !== LOCAL_GAME_SCHEMA_VERSION
    || typeof value.gameId !== 'string' || value.gameId.trim() === ''
    || !isValidTimestamp(value.createdAt)
    || !isValidTimestamp(value.updatedAt) || value.updatedAt < value.createdAt
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision <= 0
    || !isRecord(value.state)) return null;
  return value as unknown as LocalGameSaveV2;
}

function readRaw(storage: StorageLike, slot: LocalSaveSlot): { ok: true; raw: string | null } | { ok: false } {
  try {
    return { ok: true, raw: storage.getItem(LOCAL_GAME_SAVE_KEYS[slot - 1]) };
  } catch {
    return { ok: false };
  }
}

function parseRawEnvelope(raw: string | null): LocalGameSaveV2 | null {
  if (raw === null) return null;
  try {
    return parseEnvelope(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function hasLocalSaveChanged(storage: StorageLike, identity: LocalSaveIdentity): boolean {
  const read = readRaw(storage, identity.slot);
  if (!read.ok) return true;
  const current = parseRawEnvelope(read.raw);
  return current === null
    || current.gameId !== identity.gameId
    || current.revision !== identity.revision
    || read.raw !== identity.recordToken;
}

export function createBrowserLocalSaveMutationLock(): LocalSaveMutationLock | undefined {
  const lockManager = globalThis.navigator?.locks;
  if (lockManager === undefined) return undefined;
  return {
    runExclusive: (operation) => lockManager.request(LOCAL_SAVE_LOCK_NAME, { mode: 'exclusive' }, operation),
  };
}

export function readLocalSaveSlot(
  storage: StorageLike,
  slot: LocalSaveSlot,
  mapRegistry: LocalSaveMapRegistry = defaultRegistry,
): LocalSaveReadResult {
  const read = readRaw(storage, slot);
  if (!read.ok) return { kind: 'corrupt', slot, reason: STORAGE_REASON };
  if (read.raw === null) return { kind: 'empty', slot };

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.raw);
  } catch {
    return { kind: 'corrupt', slot, reason: CORRUPT_REASON, recordToken: read.raw };
  }
  if (isRecord(parsed) && parsed.schemaVersion !== LOCAL_GAME_SCHEMA_VERSION) {
    return { kind: 'incompatible', slot, reason: INCOMPATIBLE_REASON, recordToken: read.raw };
  }
  const save = parseEnvelope(parsed);
  if (save === null || !isRecord(save.state) || !isMapRef(save.state.mapRef)) {
    return { kind: 'corrupt', slot, reason: CORRUPT_REASON, recordToken: read.raw };
  }

  let pack: MapPack;
  try {
    pack = mapRegistry.getMapPack(save.state.mapRef);
  } catch {
    return { kind: 'incompatible', slot, reason: MAP_REASON, recordToken: read.raw };
  }
  const hydrated = hydrateGameState(save.state, pack);
  if (!hydrated.ok) return { kind: 'corrupt', slot, reason: CORRUPT_REASON, recordToken: read.raw };
  if (hydrated.state.phase === 'game_over') {
    return {
      kind: 'completed', slot, gameId: save.gameId, revision: save.revision,
      recordToken: read.raw, reason: '已完成的本机存档等待清理',
    };
  }

  const hydratedSave: LocalGameSaveV2 = { ...save, state: hydrated.state };
  return {
    kind: 'valid',
    slot,
    save: hydratedSave,
    recordToken: read.raw,
    summary: {
      slot,
      gameId: save.gameId,
      revision: save.revision,
      recordToken: read.raw,
      title: pack.metadata.title,
      players: hydrated.state.players.map(({ nickname, isBot }) => ({ nickname, isBot })),
      turn: hydrated.state.turn,
      updatedAt: save.updatedAt,
    },
  };
}

export function readAllLocalSaveSlots(
  storage: StorageLike,
  mapRegistry: LocalSaveMapRegistry = defaultRegistry,
): LocalSaveReadResult[] {
  return [
    readLocalSaveSlot(storage, 1, mapRegistry),
    readLocalSaveSlot(storage, 2, mapRegistry),
  ];
}

export function toLocalSaveCards(results: readonly LocalSaveReadResult[]): LocalSaveCard[] {
  const valid = results
    .filter((result): result is Extract<LocalSaveReadResult, { kind: 'valid' }> => result.kind === 'valid')
    .map((result) => ({ kind: 'valid' as const, summary: result.summary }))
    .sort((left, right) => right.summary.updatedAt - left.summary.updatedAt || left.summary.slot - right.summary.slot);
  const invalid = results
    .filter((result): result is Extract<LocalSaveReadResult, { kind: 'corrupt' | 'incompatible' }> => (
      result.kind === 'corrupt' || result.kind === 'incompatible'
    ))
    .map((result) => ({
      kind: 'invalid' as const, slot: result.slot, reason: result.reason, recordToken: result.recordToken,
    }))
    .sort((left, right) => left.slot - right.slot);
  return [...valid, ...invalid].slice(0, 2);
}

export function chooseLocalSaveSlot(results: readonly LocalSaveReadResult[]): SlotChoice {
  for (const slot of [1, 2] as const) {
    if (results.some((result) => result.slot === slot && result.kind === 'empty')) return { kind: 'empty', slot };
  }
  const valid = results
    .filter((result): result is Extract<LocalSaveReadResult, { kind: 'valid' }> => result.kind === 'valid')
    .sort((left, right) => left.save.updatedAt - right.save.updatedAt || left.slot - right.slot);
  const oldest = valid[0];
  return oldest === undefined
    ? { kind: 'unavailable' }
    : { kind: 'replace_oldest', slot: oldest.slot, gameId: oldest.save.gameId };
}

function createGameId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid !== undefined) return randomUuid;
  return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function writeEnvelope(storage: StorageLike, slot: LocalSaveSlot, save: LocalGameSaveV2): string | null {
  try {
    const recordToken = JSON.stringify(save);
    storage.setItem(LOCAL_GAME_SAVE_KEYS[slot - 1], recordToken);
    return recordToken;
  } catch {
    return null;
  }
}

export function createLocalSave(storage: StorageLike, state: GameState, now: number): CreateLocalSaveResult {
  const results = readAllLocalSaveSlots(storage);
  if (results.some((result) => result.kind === 'corrupt' && result.reason === STORAGE_REASON)) {
    return { ok: false, reason: 'storage_error' };
  }
  const choice = chooseLocalSaveSlot(results);
  if (choice.kind === 'replace_oldest') {
    return { ok: false, reason: 'no_empty_slot', oldestSlot: choice.slot, oldestGameId: choice.gameId };
  }
  if (choice.kind === 'unavailable') return { ok: false, reason: 'no_replaceable_slot' };
  if (!isValidTimestamp(now)) return { ok: false, reason: 'storage_error' };
  const gameId = createGameId();
  const save: LocalGameSaveV2 = {
    schemaVersion: LOCAL_GAME_SCHEMA_VERSION,
    gameId,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    state,
  };
  const recordToken = writeEnvelope(storage, choice.slot, save);
  return recordToken === null
    ? { ok: false, reason: 'storage_error' }
    : { ok: true, slot: choice.slot, gameId, revision: 1, recordToken };
}

function commitLocalSaveWithToken(
  storage: StorageLike,
  slot: LocalSaveSlot,
  expectedGameId: string,
  expectedRevision: number,
  state: GameState,
  now: number,
): CommitLocalSaveWithTokenResult {
  const read = readRaw(storage, slot);
  if (!read.ok) return { ok: false, reason: 'storage_error' };
  if (read.raw === null) return { ok: false, reason: 'not_found' };
  const current = parseRawEnvelope(read.raw);
  if (current === null) return { ok: false, reason: 'not_found' };
  if (current.gameId !== expectedGameId) return { ok: false, reason: 'game_id_mismatch' };
  if (current.revision !== expectedRevision) return { ok: false, reason: 'revision_mismatch' };
  if (!isValidTimestamp(now) || now < current.createdAt) return { ok: false, reason: 'storage_error' };
  const revision = expectedRevision + 1;
  const recordToken = writeEnvelope(storage, slot, {
    ...current,
    updatedAt: Math.max(current.updatedAt, now),
    revision,
    state,
  });
  return recordToken === null
    ? { ok: false, reason: 'storage_error' }
    : { ok: true, slot, revision, recordToken };
}

export function commitLocalSave(
  storage: StorageLike,
  slot: LocalSaveSlot,
  expectedGameId: string,
  expectedRevision: number,
  state: GameState,
  now: number,
): CommitLocalSaveResult {
  const result = commitLocalSaveWithToken(storage, slot, expectedGameId, expectedRevision, state, now);
  return result.ok
    ? { ok: true, slot: result.slot, revision: result.revision }
    : result;
}

export function removeLocalSave(
  storage: StorageLike,
  observed: LocalSaveObservedRecord,
): RemoveLocalSaveResult {
  const read = readRaw(storage, observed.slot);
  if (!read.ok) return { ok: false, reason: 'storage_error' };
  if (read.raw !== observed.recordToken) return { ok: false, reason: 'record_mismatch' };
  try {
    storage.removeItem(LOCAL_GAME_SAVE_KEYS[observed.slot - 1]);
  } catch {
    return { ok: false, reason: 'storage_error' };
  }
  const after = readRaw(storage, observed.slot);
  if (!after.ok) return { ok: false, reason: 'storage_error' };
  if (after.raw !== null) return { ok: false, reason: 'record_mismatch' };
  return { ok: true, slot: observed.slot };
}

export function replaceLocalSave(
  storage: StorageLike,
  observed: LocalSaveIdentity,
  state: GameState,
  now: number,
): ReplaceLocalSaveResult {
  const read = readRaw(storage, observed.slot);
  if (!read.ok) return { ok: false, reason: 'storage_error' };
  if (read.raw === null) return { ok: false, reason: 'not_found' };
  if (read.raw !== observed.recordToken) return { ok: false, reason: 'record_mismatch' };
  const current = parseRawEnvelope(read.raw);
  if (current === null) return { ok: false, reason: 'not_found' };
  if (current.gameId !== observed.gameId || current.revision !== observed.revision) {
    return { ok: false, reason: 'record_mismatch' };
  }
  if (!isValidTimestamp(now)) return { ok: false, reason: 'storage_error' };
  const gameId = createGameId();
  const replacement: LocalGameSaveV2 = {
    schemaVersion: LOCAL_GAME_SCHEMA_VERSION,
    gameId,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    state,
  };
  const recordToken = writeEnvelope(storage, observed.slot, replacement);
  return recordToken === null
    ? { ok: false, reason: 'storage_error' }
    : { ok: true, slot: observed.slot, gameId, revision: 1, recordToken };
}

export function createLocalSaveLocked(
  storage: StorageLike,
  lock: LocalSaveMutationLock,
  state: GameState,
  now: number,
  isCurrent?: () => boolean,
): Promise<CreateLocalSaveResult> {
  return runMutationLocked(lock, () => {
    const result = createLocalSave(storage, state, now);
    if (!result.ok) return result;
    const read = readRaw(storage, result.slot);
    return read.ok && read.raw === result.recordToken ? result : { ok: false as const, reason: 'storage_error' as const };
  }, { ok: false, reason: 'storage_error' }, isCurrent);
}

export function removeLocalSaveLocked(
  storage: StorageLike,
  lock: LocalSaveMutationLock,
  observed: LocalSaveObservedRecord,
): Promise<RemoveLocalSaveResult> {
  return runMutationLocked(lock, () => removeLocalSave(storage, observed), { ok: false, reason: 'storage_error' });
}

export function replaceLocalSaveLocked(
  storage: StorageLike,
  lock: LocalSaveMutationLock,
  observed: LocalSaveIdentity,
  state: GameState,
  now: number,
  isCurrent?: () => boolean,
): Promise<ReplaceLocalSaveResult> {
  return runMutationLocked(
    lock,
    () => {
      const result = replaceLocalSave(storage, observed, state, now);
      if (!result.ok) return result;
      const read = readRaw(storage, result.slot);
      return read.ok && read.raw === result.recordToken
        ? result
        : { ok: false as const, reason: 'record_mismatch' as const };
    },
    { ok: false, reason: 'storage_error' },
    isCurrent,
  );
}

async function runMutationLocked<T>(
  lock: LocalSaveMutationLock,
  operation: () => T,
  lockFailure: T,
  isCurrent?: () => boolean,
): Promise<T> {
  try {
    return await lock.runExclusive(() => (
      isCurrent !== undefined && !isCurrent() ? lockFailure : operation()
    ));
  } catch {
    return lockFailure;
  }
}

export function createLocalSavePersistence(
  storage: StorageLike,
  lock: LocalSaveMutationLock,
  initialIdentity: LocalSaveIdentity,
  now: () => number = Date.now,
): LocalGamePersistence {
  const { slot, gameId } = initialIdentity;
  let revision = initialIdentity.revision;
  let recordToken = initialIdentity.recordToken;
  return {
    slot,
    gameId,
    get revision() { return revision; },
    get recordToken() { return recordToken; },
    async commit(nextState) {
      return runMutationLocked(lock, () => {
        const current = readRaw(storage, slot);
        if (!current.ok) return { ok: false as const, reason: 'storage_error' as const };
        if (current.raw !== recordToken) return { ok: false as const, reason: 'revision_mismatch' as const };
        const result = commitLocalSaveWithToken(storage, slot, gameId, revision, nextState, now());
        if (!result.ok) return result;
        const read = readRaw(storage, slot);
        if (!read.ok) return { ok: false as const, reason: 'storage_error' as const };
        if (read.raw !== result.recordToken) return { ok: false as const, reason: 'revision_mismatch' as const };
        revision = result.revision;
        recordToken = result.recordToken;
        return { ok: true as const, slot: result.slot, revision: result.revision };
      }, { ok: false as const, reason: 'storage_error' as const });
    },
    async complete(_finalState) {
      return runMutationLocked(lock, () => {
        const current = readRaw(storage, slot);
        if (!current.ok) return { ok: false as const, reason: 'storage_error' as const };
        if (current.raw !== recordToken) return { ok: false as const, reason: 'revision_mismatch' as const };
        const removed = removeLocalSave(storage, { slot, recordToken });
        return removed.ok
          ? { ok: true, slot, revision }
          : {
              ok: false,
              reason: removed.reason === 'record_mismatch' ? 'revision_mismatch' as const : 'storage_error' as const,
            };
      }, { ok: false as const, reason: 'storage_error' as const });
    },
  };
}

export function isStorageAvailable(
  storage: StorageLike | undefined,
  lock: LocalSaveMutationLock | undefined,
): boolean {
  if (storage === undefined || lock === undefined) return false;
  const key = 'richman_local_storage_probe';
  try {
    storage.setItem(key, key);
    const available = storage.getItem(key) === key;
    storage.removeItem(key);
    return available;
  } catch {
    try { storage.removeItem(key); } catch { /* storage remains unavailable */ }
    return false;
  }
}
