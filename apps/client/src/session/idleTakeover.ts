/**
 * Idle-detection rules for AI takeover.
 *
 * Kept as pure functions because this package has no component-mount harness — the
 * behaviour is pinned by unit tests instead of by poking a rendered dialog.
 *
 * Two independent things live here:
 *   1. whether a takeover should start at all (guards against opening one while the
 *      player is actually present, or while the game is not theirs to decide);
 *   2. how long is left before it does, so the UI can warn before it fires.
 */

/** Takeover starts after this long without an action. */
export const IDLE_TAKEOVER_MS = 30_000;

/** The warning appears once the remaining time drops below this. */
export const IDLE_WARNING_MS = 10_000;

export interface IdleTakeoverInput {
  /** ms since epoch of the player's last action (or of the turn becoming theirs). */
  lastActionAt: number;
  /** Current clock, ms since epoch. */
  now: number;
  /** The player has taken over manually — the timer must not fight them. */
  takeoverOn: boolean;
  /** It is this player's turn, so a decision is actually required. */
  isTheirTurn: boolean;
  /** The session is a live game (not finished, not replaying). */
  isPlaying: boolean;
  /** The player may act right now (not animating, not in debt, not a spectator). */
  canAct: boolean;
}

/** Why a takeover will not start, or `'idle'` when it is about to fire. */
export type IdleBlockReason =
  | 'idle'
  | 'manual'
  | 'not-your-turn'
  | 'not-playing'
  | 'cannot-act';

export function getIdleTakeoverReason(input: IdleTakeoverInput): IdleBlockReason {
  if (input.takeoverOn) return 'manual';
  if (!input.isPlaying) return 'not-playing';
  if (!input.isTheirTurn) return 'not-your-turn';
  // A turn the player cannot legally act on (animation, debt cutscene) must not be
  // counted as inactivity: the game is moving on its own, they are not ignoring it.
  if (!input.canAct) return 'cannot-act';
  return 'idle';
}

/** ms left before the takeover fires, or null when it will not. */
export function getIdleTakeoverRemainingMs(input: IdleTakeoverInput): number | null {
  if (getIdleTakeoverReason(input) !== 'idle') return null;
  // A clock that jumped backwards (system time change) must not produce a negative or
  // absurdly long wait; treat it as "the timer just started".
  const elapsed = input.now - input.lastActionAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) return IDLE_TAKEOVER_MS;
  return Math.max(0, IDLE_TAKEOVER_MS - elapsed);
}

/** True once the player should see the "auto-takeover starting" warning. */
export function shouldWarnIdleTakeover(input: IdleTakeoverInput): boolean {
  const remaining = getIdleTakeoverRemainingMs(input);
  return remaining !== null && remaining <= IDLE_WARNING_MS;
}

/** "29秒" / "9秒" — the countdown label. Returns '' when no countdown is running. */
export function formatIdleCountdown(remainingMs: number | null): string {
  if (remainingMs === null) return '';
  const seconds = Math.ceil(remainingMs / 1000);
  return `${Math.max(0, seconds)} 秒后自动托管`;
}