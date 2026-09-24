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
  // 创建房间频率限流（按客户端 IP 滑动窗口）。刻意独立于 INVALID_ROOM_ACTION：
  // 这条不是「当前状态不允许」，而是「稍等即可」——客户端据此走可重试分支并给出等待提示。
  'CREATE_RATE_LIMITED',
  // 公开房间列表频率限流（#108）。同 CREATE_RATE_LIMITED 的理由：它是「刷太快了」，
  // 不是「你不该做这件事」——房间列表本身对任何人都开放。
  'ROOM_LIST_RATE_LIMITED',
  // 联机最小悔棋（#101）。三条都不是「房间坏了」，而是「这次悔棋不成立」，
  // 客户端按瞬时提示（transient notice）呈现，不占住持久错误位。
  /** 房主没有开启悔棋。 */
  'UNDO_DISABLED',
  /** 没有可悔的上一手，或当前状态不允许回退（未开局 / 有未清债务 / 没有在场对手可确认）。 */
  'UNDO_UNAVAILABLE',
  /** 房间里已有一个悬而未决的悔棋请求。 */
  'UNDO_PENDING',
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
