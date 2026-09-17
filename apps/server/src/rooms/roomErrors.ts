import type { ErrorCode } from '@richman/engine';

export const ROOM_ERROR_CODES = [
  'ROOM_NOT_FOUND',
  'ROOM_FULL',
  'GAME_ALREADY_STARTED',
  'NICKNAME_TAKEN',
  'INVALID_TOKEN',
  'NOT_HOST',
  'INVALID_NICKNAME',
  'NOT_ENOUGH_PLAYERS',
  'INVALID_ROOM_ACTION',
] as const;

export type RoomErrorCode = (typeof ROOM_ERROR_CODES)[number];

export type RoomFailure = {
  ok: false;
  code: RoomErrorCode;
  message: string;
};

export function roomFailure(code: RoomErrorCode, message: string): RoomFailure {
  return { ok: false, code, message };
}

export type GameErrorCode = ErrorCode;

export const GAME_ERROR_MESSAGES: Record<GameErrorCode, string> = {
  NOT_YOUR_TURN: '还没轮到你行动。',
  WRONG_PHASE: '当前阶段不能执行该操作。',
  INSUFFICIENT_FUNDS: '现金不足，无法执行该操作。',
  ILLEGAL_INTENT: '该操作不合法。',
};

export type GameFailure = { ok: false; code: GameErrorCode; message: string };

export type WireFailure = RoomFailure | GameFailure;

export function gameFailure(code: GameErrorCode): GameFailure {
  return { ok: false, code, message: GAME_ERROR_MESSAGES[code] };
}
