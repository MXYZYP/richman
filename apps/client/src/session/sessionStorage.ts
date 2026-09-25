import type { RoomRole } from '@richman/protocol';
import type { BotDifficulty } from '@richman/engine';

export const ACTIVE_ONLINE_SESSION_KEY = 'richman_session';
export const PENDING_ROOM_REQUEST_KEY = 'richman_pending_room_request';

export interface StorageLike {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export interface OnlineSession {
  roomCode: string;
  playerId: string;
  token: string;
}

export interface CreateRoomRequest {
  operation: 'create';
  requestId: string;
  nickname: string;
  mapId: string;
  /** 电脑玩家难度（P1-6）；不传时服务器按 normal 处理。 */
  botDifficulty?: BotDifficulty;
}

export interface JoinRoomRequest {
  operation: 'join';
  requestId: string;
  roomCode: string;
  nickname: string;
  /** 加入身份：参赛者或观战者。必填——旧格式（无该字段）在读取时按无效记录清理，不默认成参赛。 */
  role: RoomRole;
  /**
   * 房间密码（#23 ③）：房间设了密码时随请求一起持久化。
   *
   * 会写进 localStorage —— 这是**刻意**的：待恢复请求存在的意义就是「断线后不用重新输入」，
   * 若把密码剔出去，设了密码的房间一旦断线就变成「恢复得了房间、恢复不了身份」。
   * 代价是明文落本地存储，可接受：它本来就要由用户手输，且与同处一个存储的玩家 token
   * 相比权限小得多（token 能直接冒充身份，密码只是进门）。
   */
  password?: string;
}

export type PendingRoomRequest = CreateRoomRequest | JoinRoomRequest;

const ROOM_CODE_PATTERN = /^\d{6}$/;
const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const valueKeys = Object.keys(value);
  return valueKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRoomCode(value: unknown): value is string {
  return typeof value === 'string' && ROOM_CODE_PATTERN.test(value);
}

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

function isBotDifficulty(value: unknown): value is BotDifficulty {
  return value === 'easy' || value === 'normal' || value === 'hard';
}

function isOnlineSession(value: unknown): value is OnlineSession {
  return isRecord(value)
    && hasExactKeys(value, ['roomCode', 'playerId', 'token'])
    && isRoomCode(value.roomCode)
    && isNonEmptyString(value.playerId)
    && isNonEmptyString(value.token);
}

function isPendingRoomRequest(value: unknown): value is PendingRoomRequest {
  if (!isRecord(value) || !isRequestId(value.requestId) || !isNonEmptyString(value.nickname)) return false;

  if (value.operation === 'create') {
    // botDifficulty 为可选扩展字段：旧版/未传时仅 4 键即合法；携带时须恰好 5 键且难度值合法。
    if (hasExactKeys(value, ['operation', 'requestId', 'nickname', 'mapId']) && isNonEmptyString(value.mapId)) {
      return true;
    }
    return hasExactKeys(value, ['operation', 'requestId', 'nickname', 'mapId', 'botDifficulty'])
      && isNonEmptyString(value.mapId)
      && isBotDifficulty(value.botDifficulty);
  }
  if (value.operation !== 'join') return false;
  if (!isRoomCode(value.roomCode)) return false;
  if (value.role !== 'player' && value.role !== 'spectator') return false;
  // password 为可选扩展字段（#23 ③）：旧版记录仅 5 键即合法；携带时须恰好 6 键且是非空串。
  // 空串按无效处理——「有密码但这个字段是空的」是一种谁也验不过的中间态，
  // 与其带着它去请求、再被服务端以「密码错误」驳回，不如当它没写。
  if (hasExactKeys(value, ['operation', 'requestId', 'roomCode', 'nickname', 'role'])) {
    return true;
  }
  return hasExactKeys(value, ['operation', 'requestId', 'roomCode', 'nickname', 'role', 'password'])
    && isNonEmptyString(value.password);
}

function readRecord(storage: StorageLike, key: string, validate: (value: unknown) => boolean): unknown | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (validate(parsed)) return parsed;
  } catch {
    // Invalid local storage data is discarded below.
  }

  try {
    storage.removeItem(key);
  } catch {
    // A storage implementation can reject deletion; callers still receive no untrusted data.
  }
  return null;
}

export function readOnlineSession(storage: StorageLike): OnlineSession | null {
  const value = readRecord(storage, ACTIVE_ONLINE_SESSION_KEY, isOnlineSession);
  return isOnlineSession(value) ? value : null;
}

export function readPendingRoomRequest(storage: StorageLike): PendingRoomRequest | null {
  const value = readRecord(storage, PENDING_ROOM_REQUEST_KEY, isPendingRoomRequest);
  return isPendingRoomRequest(value) ? value : null;
}

export function savePendingRoomRequest(storage: StorageLike, request: PendingRoomRequest): boolean {
  if (!isPendingRoomRequest(request)) return false;

  try {
    storage.setItem(PENDING_ROOM_REQUEST_KEY, JSON.stringify(request));
    return true;
  } catch {
    return false;
  }
}

export function commitOnlineSession(storage: StorageLike, session: OnlineSession): boolean {
  if (!isOnlineSession(session)) return false;

  try {
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify(session));
  } catch {
    return false;
  }

  try {
    storage.removeItem(PENDING_ROOM_REQUEST_KEY);
  } catch {
    // Non-critical cleanup: active session is the authoritative state.
    // A stale pending request is harmless and may be overwritten next time.
  }
  return true;
}

/**
 * Discard the persisted active session so the user returns to a clean entry screen.
 * The pending request (a separate concern) is intentionally left untouched.
 * Returns whether the removal succeeded so the caller can surface an honest error
 * instead of pretending the record was cleared; never throws.
 */
export function clearOnlineSession(storage: StorageLike): boolean {
  try {
    storage.removeItem(ACTIVE_ONLINE_SESSION_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discard a complete online recovery record without ever losing the active credential
 * when stale pending-entry cleanup is unavailable. Pending is deliberately removed first:
 * if it rejects, the authoritative active session remains available for resume.
 */
export function clearStoredOnlineSession(storage: StorageLike): boolean {
  return clearPendingRoomRequest(storage) && clearOnlineSession(storage);
}

/**
 * Discard the persisted pending create/join request. The active session (a separate
 * concern) is left untouched. Returns whether the removal succeeded; never throws.
 */
export function clearPendingRoomRequest(storage: StorageLike): boolean {
  try {
    storage.removeItem(PENDING_ROOM_REQUEST_KEY);
    return true;
  } catch {
    return false;
  }
}
