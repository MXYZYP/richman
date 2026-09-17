import type { RoomRole, RoomStatus } from '@richman/protocol';
import type { ConnectionStatus } from './gameSession';
import type { PendingRoomRequest } from './sessionStorage';

/**
 * Which experience the app shell is currently driving.
 * - `online`   — the single OnlineSession owns routing (restore / home / lobby / game / settlement).
 * - `local_setup` — the user is configuring a local hot-seat game.
 * - `local_game`  — a LocalSession is running.
 */
export type AppShellStage = 'online' | 'local_setup' | 'local_game';

/** A restore attempt whose stored session survived the failure and can be retried. */
export type RestoreFailure = 'transient';

/** Read-only snapshot of everything the reducer needs — no session refs, no side effects. */
export interface AppFlowSnapshot {
  stage: AppShellStage;
  /** `readOnlineSession(storage) !== null`: a resumable session is persisted. */
  storedActive: boolean;
  /** `readPendingRoomRequest(storage)`: an unfinished create/join to offer for continuation. */
  pending: PendingRoomRequest | null;
  connection: ConnectionStatus;
  /** `room.value?.status ?? null`: null means "not recovered into a room yet". */
  room: RoomStatus | null;
  /** `state.value?.phase === 'game_over'`: the authoritative snapshot has ended. */
  gameOver: boolean;
  /**
   * The user chose 「暂不恢复」 on a failed restore: route to home this session without
   * touching storage. The stored session survives so home can still offer 回到上一局.
   */
  restoreDeferred: boolean;
}

export type AppPage =
  | { kind: 'restoring'; failure: RestoreFailure | null }
  | { kind: 'home'; resume: PendingRoomRequest | null; canResumeActive: boolean }
  | { kind: 'local_setup' }
  | { kind: 'game' }
  | { kind: 'lobby' }
  | { kind: 'settlement' };

/**
 * Pure page-state reducer. Given the current shell stage and observable session
 * facts, decide exactly one page to render.
 *
 * Priority is deliberate: recovery into a room outranks the restore screen, and an
 * ended game (room `ended` or a `game_over` snapshot) outranks the playing page so a
 * stale `playing` room can never render the live game after the match is over.
 */
export function resolvePage(snapshot: AppFlowSnapshot): AppPage {
  if (snapshot.stage === 'local_setup') return { kind: 'local_setup' };
  if (snapshot.stage === 'local_game') {
    return { kind: snapshot.gameOver ? 'settlement' : 'game' };
  }

  // Online shell.
  if (snapshot.room !== null) {
    if (snapshot.room === 'ended' || snapshot.gameOver) return { kind: 'settlement' };
    if (snapshot.room === 'lobby') return { kind: 'lobby' };
    return { kind: 'game' };
  }

  // A stored active session normally drives the restore screen. If the user chose
  // 「暂不恢复」, honour that for this session: fall through to home, where the surviving
  // session is offered as an independent 回到上一局 (canResumeActive) rather than auto-restored.
  if (snapshot.storedActive && !snapshot.restoreDeferred) {
    return { kind: 'restoring', failure: snapshot.connection === 'failed' ? 'transient' : null };
  }

  return { kind: 'home', resume: snapshot.pending, canResumeActive: snapshot.storedActive };
}

const ROOM_CODE_PATTERN = /^\d{4}$/;
const ROOM_CODE_LENGTH = 4;
const ASCII_WHITESPACE = /[ \t\r\n\f\v]+/g;

/** Strip ASCII whitespace so pasted / autofilled codes normalize before validation. */
export function normalizeRoomCode(raw: string): string {
  return raw.replace(ASCII_WHITESPACE, '');
}

/**
 * Normalize a raw room-code input, then cap to the code length. Normalizing before
 * capping is deliberate: a raw `maxlength` would truncate "12 34" to "12 3" before the
 * whitespace is stripped, corrupting the code. Callers bind this to the input instead.
 */
export function capRoomCode(raw: string): string {
  return normalizeRoomCode(raw).slice(0, ROOM_CODE_LENGTH);
}

/** A room code is exactly four ASCII digits (full-width digits are rejected). */
export function isValidRoomCode(code: string): boolean {
  return ROOM_CODE_PATTERN.test(code);
}

/** Trim surrounding whitespace from a nickname. */
export function normalizeNickname(raw: string): string {
  return raw.trim();
}

/** A nickname is any non-empty value once trimmed. */
export function isValidNickname(nickname: string): boolean {
  return nickname.trim().length > 0;
}

/**
 * Resolve an explicit create submission into its emit payload, or null when it must not
 * fire — already submitting (no accidental double-trigger) or an invalid nickname.
 */
export function planCreateSubmission(rawNickname: string, submitting: boolean): { nickname: string } | null {
  if (submitting) return null;
  const nickname = normalizeNickname(rawNickname);
  return isValidNickname(nickname) ? { nickname } : null;
}

/**
 * Resolve an explicit join submission into its emit payload, or null when it must not
 * fire — already submitting, an invalid room code, or an invalid nickname.
 */
export function planJoinSubmission(
  rawRoomCode: string,
  rawNickname: string,
  submitting: boolean,
  role: RoomRole = 'player',
): { roomCode: string; nickname: string; role: RoomRole } | null {
  if (submitting) return null;
  const roomCode = capRoomCode(rawRoomCode);
  const nickname = normalizeNickname(rawNickname);
  return isValidRoomCode(roomCode) && isValidNickname(nickname)
    ? { roomCode, nickname, role }
    : null;
}

export type EntryFailureKind = 'definitive' | 'transient';

/**
 * Entry (create/join) rejections that a same-request-id retry can never fix: the room or
 * nickname state is settled server-side, so the user must abandon and start fresh. Every
 * other code (timeouts, disconnects, in-progress) is transient and defaults to retry.
 */
const DEFINITIVE_ENTRY_ERROR_CODES: Record<string, true> = {
  ROOM_NOT_FOUND: true,
  ROOM_FULL: true,
  NICKNAME_TAKEN: true,
  GAME_ALREADY_STARTED: true,
  INVALID_NICKNAME: true,
  INVALID_ROOM_ACTION: true,
};

export function classifyEntryFailure(code: string): EntryFailureKind {
  return DEFINITIVE_ENTRY_ERROR_CODES[code] === true ? 'definitive' : 'transient';
}
