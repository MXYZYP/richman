import type { Server as SocketIoServer, Socket } from 'socket.io';
import type {
  Ack,
  ChatMessage,
  ClientToServerEvents,
  CreateRoomAck,
  CreateRoomPayload,
  InterServerEvents,
  JoinRoomAck,
  JoinRoomPayload,
  PublicRoomState,
  ResumeAck,
  RoomListAck,
  RoomSettings,
  RoomSettingsPatch,
  ServerToClientEvents,
  SocketData,
  UndoRequestInfo,
} from '@richman/protocol';
import { CHAT_HISTORY_LIMIT, CHAT_TEXT_MAX_LENGTH } from '@richman/protocol';
import { toPublicGameSnapshot } from '../publicGameSnapshot';
import { isValidIntent } from '../game/gameRuntime';
import {
  createSlidingWindowRateLimiter,
  type RateLimitRule,
} from '../http/slidingWindowRateLimiter';
import { roomFailure, type RoomFailure } from '../rooms/roomErrors';
import type { RoomManager } from '../rooms/roomManager';
import type { GameActionResult, Intent, RoomDomainEvent, RoomResult } from '../rooms/roomTypes';

type RoomIo = SocketIoServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
type RoomSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

type SocketBinding = {
  roomCode: string;
  playerId: string;
};

export interface RoomSocketAdapterLogger {
  error?(message: string, error?: unknown): void;
}

export interface RoomSocketAdapter<TTimerHandle = unknown> {
  bind(): void;
  dispatchDomainEvents(events: RoomDomainEvent[]): void;
}

/**
 * 建房限流规则。形状就是通用滑动窗口限流器的 `RateLimitRule`（见 `http/slidingWindowRateLimiter`），
 * 这里保留一个独立名字，是因为它是**本适配器对外契约**的一部分（`server.ts` 与测试都用它），
 * 而 `RateLimitRule` 是实现细节 —— 两者同源，不会再各写一套字段。
 */
export type CreateRoomRateLimit = RateLimitRule;

export interface RoomSocketAdapterOptions<TTimerHandle = unknown> {
  io: RoomIo;
  roomManager: RoomManager<TTimerHandle>;
  logger?: RoomSocketAdapterLogger;
  /** Create-room rate limit (per client IP, sliding window). Pass `false` to disable (tests). */
  rateLimit?: CreateRoomRateLimit | false;
  /**
   * 只读时钟，默认 `Date.now`，**仅**用于计算限流滑动窗口。
   * 有它才能在测试里把「窗口滑过 60s」做成确定的事件：去 mock 全局 `Date.now`
   * 会连带影响同进程的 Socket.IO 客户端，上一版就是这么把用例挂死在等待 ack 上的。
   */
  now?: () => number;
}

const INVALID_ROOM_ACTION_ACK = {
  ok: false,
  code: 'INVALID_ROOM_ACTION',
  message: 'Invalid room action payload.',
} as const;

// 用 roomFailure 构造（而不是裸对象字面量）：这样错误码一旦写错、或没加进 ROOM_ERROR_CODES
// 联合类型，编译期就会报出来，不必等到线上被限流的玩家看到一个没人认识的码。
const CREATE_RATE_LIMITED_ACK: RoomFailure = roomFailure(
  'CREATE_RATE_LIMITED',
  '创建房间过于频繁，请稍后再试。',
);

const ROOM_LIST_RATE_LIMITED_ACK: RoomFailure = roomFailure(
  'ROOM_LIST_RATE_LIMITED',
  '刷新房间列表过于频繁，请稍后再试。',
);

const REQUEST_ID_RE = /^[0-9a-fA-F]{32}$/;

// 创建房间频率限流默认值：按客户端 IP 滑动窗口，防公网刷房间码/刷房。
// 必须定义在模块级（而非函数体内），否则默认参数作用域读不到该常量会抛 ReferenceError。
const CREATE_WINDOW_MS = 60_000;
const CREATE_MAX_PER_WINDOW = 5;

// 公开房间列表的限流（#108）：比建房宽松得多（它是一次只读查询，正常使用就是手动刷新几下），
// 但绝不能完全不限——它是一条**枚举全网房间码**的入口，不设阈值就等于给爬虫开了后门。
// 与建房共用同一个 `rateLimit !== false` 开关：测试环境一并关掉，避免用例被误拦。
const LIST_WINDOW_MS = 10_000;
const LIST_MAX_PER_WINDOW = 30;

export function createRoomSocketAdapter<TTimerHandle = unknown>({
  io,
  roomManager,
  logger,
  rateLimit = { windowMs: CREATE_WINDOW_MS, maxPerWindow: CREATE_MAX_PER_WINDOW },
  now = Date.now,
}: RoomSocketAdapterOptions<TTimerHandle>): RoomSocketAdapter<TTimerHandle> {
  const socketBindings = new Map<string, SocketBinding>();
  const playerSocketIds = new Map<string, string>();
  // 聊天频率限流：每玩家最小发送间隔（毫秒），防公网刷屏。
  const chatRate = new Map<string, number>();
  const CHAT_MIN_INTERVAL_MS = 700;
  // 房间聊天历史（内存态，跟随房间生命周期，最多 CHAT_HISTORY_LIMIT 条）：
  // 新加入 / 掉线重连的成员会收到这段历史，避免「刷新一下记录就空了」。房间关闭时清除。
  const chatHistory = new Map<string, ChatMessage[]>();
  // 创建房间频率限流：按客户端 IP 滑动窗口，防公网刷房间码/刷房。
  // 公开房间列表限流（#108）与它共用同一个 `rateLimit !== false` 开关。
  // 两者都走通用限流器（`http/slidingWindowRateLimiter`）—— 这段逻辑原本在本文件里
  // 内联了两遍，第三个调用方（排行榜接口 #116）出现时就该合并，否则阈值与窗口的语义
  // 只能靠「抄得对不对」保持一致。
  const createLimiter = rateLimit === false ? null : createSlidingWindowRateLimiter(rateLimit, now);
  const listLimiter = rateLimit === false
    ? null
    : createSlidingWindowRateLimiter({ windowMs: LIST_WINDOW_MS, maxPerWindow: LIST_MAX_PER_WINDOW }, now);

  function bindSocket(socket: RoomSocket, binding: SocketBinding): void {
    unbindSocket(socket);

    const bindingKey = getPlayerBindingKey(binding.roomCode, binding.playerId);
    const previousSocketId = playerSocketIds.get(bindingKey);
    if (previousSocketId !== undefined && previousSocketId !== socket.id) {
      const previousSocket = io.sockets.sockets.get(previousSocketId) as RoomSocket | undefined;
      const previousBinding = socketBindings.get(previousSocketId);
      socketBindings.delete(previousSocketId);
      if (previousSocket !== undefined && previousBinding !== undefined) {
        previousSocket.leave(previousBinding.roomCode);
        delete previousSocket.data.roomCode;
        delete previousSocket.data.playerId;
      }
    }

    socketBindings.set(socket.id, binding);
    playerSocketIds.set(bindingKey, socket.id);
    socket.data.roomCode = binding.roomCode;
    socket.data.playerId = binding.playerId;
    socket.join(binding.roomCode);
  }

  function unbindSocket(socket: RoomSocket): SocketBinding | null {
    const binding = socketBindings.get(socket.id);
    if (binding === undefined) {
      return null;
    }

    socketBindings.delete(socket.id);
    const bindingKey = getPlayerBindingKey(binding.roomCode, binding.playerId);
    if (playerSocketIds.get(bindingKey) === socket.id) {
      playerSocketIds.delete(bindingKey);
    }
    socket.leave(binding.roomCode);
    delete socket.data.roomCode;
    delete socket.data.playerId;
    return binding;
  }

  function cleanupSocketBeforeRebind(socket: RoomSocket, nextBinding: SocketBinding): void {
    const currentBinding = socketBindings.get(socket.id);
    if (currentBinding === undefined) {
      return;
    }
    if (currentBinding.roomCode === nextBinding.roomCode && currentBinding.playerId === nextBinding.playerId) {
      return;
    }

    try {
      const leaveResult = roomManager.leaveRoom(currentBinding.roomCode, currentBinding.playerId);
      unbindSocket(socket);
      if (leaveResult.ok) {
        dispatchDomainEvents(leaveResult.events);
        return;
      }
      logger?.error?.('socket rebind cleanup failed', leaveResult);
    } catch (error) {
      unbindSocket(socket);
      logger?.error?.('socket rebind cleanup failed unexpectedly', error);
    }
  }

  function dispatchDomainEvents(events: RoomDomainEvent[]): void {
    for (const event of events) {
      if (event.type === 'room_state') {
        io.to(event.roomCode).emit('room:state', event.room);
        continue;
      }

      if (event.type === 'room_settings') {
        io.to(event.roomCode).emit('room:settings', event.settings);
        continue;
      }

      if (event.type === 'player_connection') {
        io.to(event.roomCode).emit('player:connection', {
          playerId: event.playerId,
          online: event.online,
        });
        continue;
      }

      if (event.type === 'game_events') {
        io.to(event.roomCode).emit('game:events', { events: event.events });
        continue;
      }

      if (event.type === 'game_snapshot') {
        io.to(event.roomCode).emit('game:snapshot', { state: toPublicGameSnapshot(event.state) });
        continue;
      }

      // 悔棋三条（#101）：都是房间内广播，各自独立一条事件，沿用 room:settings 的模式。
      if (event.type === 'undo_request') {
        io.to(event.roomCode).emit('room:undo_request', event.request);
        continue;
      }

      if (event.type === 'undo_result') {
        io.to(event.roomCode).emit('room:undo_result', event.result);
        continue;
      }

      if (event.type === 'undo_available') {
        io.to(event.roomCode).emit('room:undo_available', { playerId: event.playerId });
        continue;
      }

      // 回合限时两条（#107）：同样各自独立一条事件。
      if (event.type === 'turn_deadline') {
        io.to(event.roomCode).emit('room:turn_deadline', event.info);
        continue;
      }

      if (event.type === 'turn_timeout') {
        io.to(event.roomCode).emit('room:turn_timeout', { playerId: event.playerId, nickname: event.nickname });
        continue;
      }

      io.to(event.roomCode).emit('room:closed', { reason: event.reason });
      chatHistory.delete(event.roomCode);
      for (const [socketId, binding] of socketBindings) {
        if (binding.roomCode !== event.roomCode) continue;
        const socket = io.sockets.sockets.get(socketId);
        if (socket !== undefined) unbindSocket(socket);
      }
    }
  }

  function dispatchLobbyStateAfterConnectionEvent(result: RoomResult<PublicRoomState | null>): void {
    if (!result.ok || result.value === null || result.value.status !== 'lobby') {
      return;
    }
    if (!result.events.some((event) => event.type === 'player_connection')) {
      return;
    }
    if (result.events.some((event) => event.type === 'room_state')) {
      return;
    }

    io.to(result.value.roomCode).emit('room:state', result.value);
  }

  function dispatchEntryEvents(
    entryEvents: RoomDomainEvent[],
    resumeEvents: RoomDomainEvent[],
    roomCode: string,
    resumedRoom: PublicRoomState,
  ): void {
    if (!resumeEvents.some((event) => event.type === 'player_connection')) {
      dispatchDomainEvents(entryEvents);
      dispatchDomainEvents(resumeEvents);
      return;
    }

    dispatchDomainEvents(resumeEvents.filter((event) => event.type !== 'room_state'));
    io.to(roomCode).emit('room:state', roomManager.getPublicRoom(roomCode) ?? resumedRoom);
  }

  function toAck<T extends object>(result: RoomResult<T>): Ack<T> {
    if (!result.ok) {
      return result;
    }

    return {
      ok: true,
      ...result.value,
    };
  }

  function toActionAck(result: RoomResult<unknown> | GameActionResult<unknown>): Ack<Record<string, never>> {
    if (!result.ok) {
      return result;
    }

    return { ok: true };
  }

  /**
   * 房间聊天历史：新进入者（加入 / 观战 / 掉线重连）单播收到最近记录。
   * 刻意放在 ack **之后**：客户端的 ack 处理里可能 resetSession()（清空 chatLog），
   * 同一连接上事件按序到达，先 ack 后历史，历史才不会被那次清空吞掉。
   *
   * 泛型显式传 `TSuccess`（而非让它从 `ack` 推断）：`Ack<TSuccess>` 出现在函数参数的
   * 逆变位置，推断会把带可选 `snapshot` 的 ack 收窄成 `snapshot?: undefined`，
   * 于是下面那个会返回 `snapshot` 的工厂函数就对不上了（TS2345）。
   */
  function emitChatHistory(socket: RoomSocket, roomCode: string): void {
    const history = chatHistory.get(roomCode);
    if (history === undefined || history.length === 0) {
      return;
    }
    socket.emit('room:chat_history', { messages: history.map((message) => ({ ...message })) });
  }

  /**
   * 房间设置单播（#4 / #6）：进入房间（建房 / 加入 / 重连）各发一次，
   * 之后由 `room_settings` 领域事件广播同步。**必须排在 ack 之后**，理由见
   * `ackThenRoomEntryState`（客户端的 ack 处理可能 resetSession()）。
   */
  function emitRoomSettings(socket: RoomSocket, roomCode: string): void {
    const settings = roomManager.getRoomSettings(roomCode);
    if (settings === null) {
      return;
    }
    socket.emit('room:settings', settings);
  }

  /**
   * 「此刻谁可以悔棋」单播（#101）：与房间设置同样的时机（进入房间时一次）。
   *
   * 不这么做的话，**掉线重连/刷新后按钮会消失**：`room:undo_available` 只在状态变化时广播，
   * 而那一次广播早于本次连接，重连的客户端拿不到——明明有一手可悔，按钮却是灰的。
   */
  function emitUndoAvailability(socket: RoomSocket, roomCode: string): void {
    if (roomManager.getRoomSettings(roomCode) === null) {
      return;
    }
    socket.emit('room:undo_available', { playerId: roomManager.getUndoAvailability(roomCode) });
  }

  /**
   * 「此刻谁的回合钟在走」单播（#107）：与房间设置、可悔权同样的时机（进入房间时一次）。
   *
   * 不这么做的话，**刷新 / 掉线重连后倒计时会消失**：`room:turn_deadline` 只在行动者变化时
   * 广播，而那一次广播早于本次连接。刷新页面的人于是看到「轮到我了却没有倒计时」，
   * 以为房间没开限时，直到自己超时被代走一步才发现。
   */
  function emitTurnDeadline(socket: RoomSocket, roomCode: string): void {
    const info = roomManager.getTurnDeadline(roomCode);
    if (info === null) {
      return;
    }
    socket.emit('room:turn_deadline', info);
  }

  /**
   * 补齐「进入房间」时必须单播、但**不在 ack 里**的两份快照：聊天历史与房间设置（#4 / #6）。
   *
   * 两者都刻意排在 ack **之后**：客户端的 ack 处理里可能 resetSession()（会把 chatLog 与
   * roomSettings 一起清空），先发的会被那次清空吞掉。
   *
   * ★ 建房（`room:create`）也必须走这里：`CreateRoomAck` 只带
   *   roomCode / playerId / token / room，**不含 settings**。少了这次单播，房主端
   *   `roomSettings` 会一直是 null，`LobbyView` 的 `rulesVisible` 因此为 false ——
   *   「房间规则」面板（含电脑难度）要等刷新触发 `session:resume` 才出现
   *   （2026-09-24 实测线上复现的正是这条路径）。
   */
  function ackThenRoomEntryState<TSuccess extends object>(
    socket: RoomSocket,
    roomCode: string,
    ack: (response: Ack<TSuccess>) => void,
  ): (response: Ack<TSuccess>) => void {
    return (response) => {
      ack(response);
      emitChatHistory(socket, roomCode);
      emitRoomSettings(socket, roomCode);
      emitUndoAvailability(socket, roomCode);
      emitTurnDeadline(socket, roomCode);
    };
  }

  /**
   * 公开房间列表（#108）。这是本适配器里唯一**不需要绑定的房间**的读操作——
   * 未加入任何房间的人正是它的目标用户，因此不检查 `socketBindings`。
   *
   * 按客户端 IP 做滑动窗口限流：它是一条枚举全网房间码的入口，不设阈值等于给爬虫开后门。
   * 阈值远比建房宽松（10s 内 30 次），正常「手动刷新几下」永远碰不到。
   */
  function handleListRooms(socket: RoomSocket, ack: (response: Ack<RoomListAck>) => void): void {
    if (listLimiter !== null && !listLimiter.allow(socket.handshake.address ?? socket.id)) {
      ack(ROOM_LIST_RATE_LIMITED_ACK);
      return;
    }

    try {
      ack({ ok: true, rooms: roomManager.listPublicRooms() });
    } catch (error) {
      logger?.error?.('room:list failed unexpectedly', error);
      ack(INVALID_ROOM_ACTION_ACK);
    }
  }

  function handleCreate(socket: RoomSocket, payload: unknown, ack: (response: Ack<CreateRoomAck>) => void): void {
    if (!isCreateRoomPayload(payload)) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }

    // 创建房间滑动窗口限流（按客户端 IP）。超阈值直接拒绝，不给刷房机会。
    // `rateLimit: false` 时 `createLimiter` 为 null（测试环境禁用，避免快速连续建房被误拦）。
    if (createLimiter !== null && !createLimiter.allow(socket.handshake.address ?? socket.id)) {
      ack(CREATE_RATE_LIMITED_ACK);
      return;
    }

    try {
      const result = roomManager.createRoom(payload.nickname, payload.mapId, payload.requestId, payload.botDifficulty);
      if (!result.ok) {
        ack(toAck(result));
        return;
      }

      const binding = {
        roomCode: result.value.roomCode,
        playerId: result.value.playerId,
      };
      cleanupSocketBeforeRebind(socket, binding);
      const resumed = roomManager.resumeRoom(binding.roomCode, binding.playerId, result.value.token);
      if (!resumed.ok) {
        ack(resumed);
        return;
      }
      bindSocket(socket, binding);
      dispatchEntryEvents(result.events, resumed.events, binding.roomCode, resumed.value);
      // 建房也要补聊天历史与房间设置：ack 里没有 settings，少了这次单播房主的规则面板不显示。
      ackAfterEventFlushFrom(ackThenRoomEntryState<CreateRoomAck>(socket, binding.roomCode, ack), () => ({
        ok: true,
        ...result.value,
        room: roomManager.getPublicRoom(binding.roomCode) ?? result.value.room,
      }));
    } catch (error) {
      logger?.error?.('room:create failed unexpectedly', error);
      ack(INVALID_ROOM_ACTION_ACK);
    }
  }

  function handleJoin(socket: RoomSocket, payload: unknown, ack: (response: Ack<JoinRoomAck>) => void): void {
    if (!isJoinRoomPayload(payload)) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }

    try {
      const result = roomManager.joinRoom(payload.roomCode, payload.nickname, payload.requestId, payload.role, payload.password);
      if (!result.ok) {
        ack(toAck(result));
        return;
      }

      const binding = {
        roomCode: result.value.room.roomCode,
        playerId: result.value.playerId,
      };
      cleanupSocketBeforeRebind(socket, binding);
      const resumed = roomManager.resumeRoom(binding.roomCode, binding.playerId, result.value.token);
      if (!resumed.ok) {
        ack(resumed);
        return;
      }
      bindSocket(socket, binding);
      dispatchEntryEvents(result.events, resumed.events, binding.roomCode, resumed.value);
      ackAfterEventFlushFrom(ackThenRoomEntryState<JoinRoomAck>(socket, binding.roomCode, ack), () => {
        const room = roomManager.getPublicRoom(binding.roomCode) ?? result.value.room;
        const snapshot = roomManager.getGameSnapshot(binding.roomCode);
        return {
          ok: true,
          ...result.value,
          room,
          ...(snapshot === null ? {} : { snapshot: toPublicGameSnapshot(snapshot) }),
        };
      });
    } catch (error) {
      logger?.error?.('room:join failed unexpectedly', error);
      ack(INVALID_ROOM_ACTION_ACK);
    }
  }

  function handleResume(
    socket: RoomSocket,
    payload: unknown,
    ack: (response: Ack<ResumeAck>) => void,
  ): void {
    if (!isResumePayload(payload)) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }

    try {
      const result = roomManager.resumeRoom(payload.roomCode, payload.playerId, payload.token);
      if (!result.ok) {
        ack(result);
        return;
      }

      const binding = {
        roomCode: payload.roomCode,
        playerId: payload.playerId,
      };
      cleanupSocketBeforeRebind(socket, binding);
      bindSocket(socket, binding);
      dispatchDomainEvents(result.events);
      dispatchLobbyStateAfterConnectionEvent(result);
      ackAfterEventFlushFrom(ackThenRoomEntryState<ResumeAck>(socket, payload.roomCode, ack), () => {
        const room = roomManager.getPublicRoom(payload.roomCode) ?? result.value;
        const snapshot = roomManager.getGameSnapshot(payload.roomCode);
        return snapshot === null
          ? { ok: true, room }
          : { ok: true, room, snapshot: toPublicGameSnapshot(snapshot) };
      });
    } catch (error) {
      logger?.error?.('session:resume failed unexpectedly', error);
      ack(INVALID_ROOM_ACTION_ACK);
    }
  }

  function handleAddBot(socket: RoomSocket, ack: (response: Ack<Record<string, never>>) => void): void {
    const binding = socketBindings.get(socket.id);
    if (binding === undefined) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }

    try {
      const result = roomManager.addBot(binding.roomCode, binding.playerId);
      if (result.ok) {
        dispatchDomainEvents(result.events);
      }
      ackAfterEventFlush(ack, toActionAck(result));
    } catch (error) {
      logger?.error?.('room:add_bot failed unexpectedly', error);
      ack(INVALID_ROOM_ACTION_ACK);
    }
  }

  function handleRemoveBot(
    socket: RoomSocket,
    payload: unknown,
    ack: (response: Ack<Record<string, never>>) => void,
  ): void {
    if (!isRemoveBotPayload(payload)) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }

    const binding = socketBindings.get(socket.id);
    if (binding === undefined) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }

    try {
      const result = roomManager.removeBot(binding.roomCode, binding.playerId, payload.playerId);
      if (result.ok) {
        dispatchDomainEvents(result.events);
      }
      ackAfterEventFlush(ack, toActionAck(result));
    } catch (error) {
      logger?.error?.('room:remove_bot failed unexpectedly', error);
      ack(INVALID_ROOM_ACTION_ACK);
    }
  }

  function handleRenameBot(
    socket: RoomSocket,
    payload: unknown,
    ack: (response: Ack<Record<string, never>>) => void,
  ): void {
    if (!isRenameBotPayload(payload)) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }

    const binding = socketBindings.get(socket.id);
    if (binding === undefined) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }

    try {
      const result = roomManager.renameBot(
        binding.roomCode,
        binding.playerId,
        payload.playerId,
        payload.nickname,
      );
      if (result.ok) {
        dispatchDomainEvents(result.events);
      }
      ackAfterEventFlush(ack, toActionAck(result));
    } catch (error) {
      logger?.error?.('room:rename_bot failed unexpectedly', error);
      ack(INVALID_ROOM_ACTION_ACK);
    }
  }

  /**
   * 房主调整房间设置（#4 规则自定义 / #6 电脑难度）。
   * 权限（只认房主、只在 lobby）与数值范围全部由 `RoomManager.updateRoomSettings` 把关，
   * 这里只做「payload 形状是否正确」这一层，避免非法形状引发运行时异常。
   */
  function handleUpdateSettings(
    socket: RoomSocket,
    payload: unknown,
    ack: (response: Ack<RoomSettings>) => void,
  ): void {
    if (!isUpdateSettingsPayload(payload)) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }

    const binding = socketBindings.get(socket.id);
    if (binding === undefined) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }

    try {
      const result = roomManager.updateRoomSettings(binding.roomCode, binding.playerId, payload);
      if (result.ok) {
        dispatchDomainEvents(result.events);
      }
      ackAfterEventFlush(ack, toAck(result));
    } catch (error) {
      logger?.error?.('room:update_settings failed unexpectedly', error);
      ack(INVALID_ROOM_ACTION_ACK);
    }
  }

  function handleStart(socket: RoomSocket, ack: (response: Ack<Record<string, never>>) => void): void {
    const binding = socketBindings.get(socket.id);
    if (binding === undefined) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }

    try {
      const result = roomManager.startRoom(binding.roomCode, binding.playerId);
      if (result.ok) {
        dispatchDomainEvents(result.events);
      }
      ackAfterEventFlush(ack, toActionAck(result));
    } catch (error) {
      logger?.error?.('room:start failed unexpectedly', error);
      ack(INVALID_ROOM_ACTION_ACK);
    }
  }

  function handleSkipOfflineTurn(socket: RoomSocket, ack: (response: Ack<Record<string, never>>) => void): void {
    const binding = socketBindings.get(socket.id);
    if (binding === undefined) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }

    try {
      const result = roomManager.requestSkipOfflineTurn(binding.roomCode, binding.playerId);
      if (result.ok) {
        dispatchDomainEvents(result.events);
      }
      ackAfterEventFlush(ack, toActionAck(result));
    } catch (error) {
      logger?.error?.('room:skip_offline_turn failed unexpectedly', error);
      ack(INVALID_ROOM_ACTION_ACK);
    }
  }

  function handleGameIntent(
    socket: RoomSocket,
    payload: unknown,
    ack: (response: Ack<Record<string, never>>) => void,
  ): void {
    if (!isGameIntentPayload(payload)) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }

    const binding = socketBindings.get(socket.id);
    if (binding === undefined) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }

    try {
      const result = roomManager.applyGameIntent(binding.roomCode, binding.playerId, payload.intent);
      if (result.ok) {
        dispatchDomainEvents(result.events);
      }
      ackAfterEventFlush(ack, toActionAck(result));
    } catch (error) {
      logger?.error?.('game:intent failed unexpectedly', error);
      ack(INVALID_ROOM_ACTION_ACK);
    }
  }

  /**
   * 悔棋三条（#101）：发起 / 表决 / 撤回。
   *
   * 三条都不接受「谁在操作」这样的参数——身份一律取自 socket 绑定（`socketBindings`），
   * 与 `game:intent` 同一套做法：客户端没有伪造他人身份的入口。
   * 业务约束（是否开了悔棋、是否轮得到你、你还要不要表态）全部由 `RoomManager` 把关，
   * 这里只负责 payload 形状与广播。
   */
  function handleUndoRequest(socket: RoomSocket, ack: (response: Ack<UndoRequestInfo>) => void): void {
    const binding = socketBindings.get(socket.id);
    if (binding === undefined) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }

    try {
      const result = roomManager.requestUndo(binding.roomCode, binding.playerId);
      if (result.ok) {
        dispatchDomainEvents(result.events);
      }
      ackAfterEventFlush(ack, toAck(result));
    } catch (error) {
      logger?.error?.('room:undo_request failed unexpectedly', error);
      ack(INVALID_ROOM_ACTION_ACK);
    }
  }

  function handleUndoVote(
    socket: RoomSocket,
    payload: unknown,
    ack: (response: Ack<Record<string, never>>) => void,
  ): void {
    if (!isUndoVotePayload(payload)) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }

    const binding = socketBindings.get(socket.id);
    if (binding === undefined) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }

    try {
      const result = roomManager.voteUndo(binding.roomCode, binding.playerId, payload.requestId, payload.approve);
      if (result.ok) {
        dispatchDomainEvents(result.events);
      }
      ackAfterEventFlush(ack, toActionAck(result));
    } catch (error) {
      logger?.error?.('room:undo_vote failed unexpectedly', error);
      ack(INVALID_ROOM_ACTION_ACK);
    }
  }

  function handleUndoCancel(socket: RoomSocket, ack: (response: Ack<Record<string, never>>) => void): void {
    const binding = socketBindings.get(socket.id);
    if (binding === undefined) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }

    try {
      const result = roomManager.cancelUndo(binding.roomCode, binding.playerId);
      if (result.ok) {
        dispatchDomainEvents(result.events);
      }
      ackAfterEventFlush(ack, toActionAck(result));
    } catch (error) {
      logger?.error?.('room:undo_cancel failed unexpectedly', error);
      ack(INVALID_ROOM_ACTION_ACK);
    }
  }

  function handleLeave(socket: RoomSocket, ack: (response: Ack<Record<string, never>>) => void): void {
    const binding = socketBindings.get(socket.id);
    if (binding === undefined) {
      ack({ ok: true });
      return;
    }

    try {
      const result = roomManager.leaveRoom(binding.roomCode, binding.playerId);
      if (result.ok) {
        unbindSocket(socket);
        dispatchDomainEvents(result.events);
      }
      ackAfterEventFlush(ack, toActionAck(result));
    } catch (error) {
      logger?.error?.('room:leave failed unexpectedly', error);
      ack(INVALID_ROOM_ACTION_ACK);
    }
  }

  function handleKick(
    socket: RoomSocket,
    payload: unknown,
    ack: (response: Ack<Record<string, never>>) => void,
  ): void {
    if (!isKickPayload(payload)) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }

    const binding = socketBindings.get(socket.id);
    if (binding === undefined) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }

    try {
      const result = roomManager.kickPlayer(binding.roomCode, binding.playerId, payload.playerId);
      if (result.ok) {
        dispatchDomainEvents(result.events);
      }
      ackAfterEventFlush(ack, toActionAck(result));
    } catch (error) {
      logger?.error?.('room:kick_player failed unexpectedly', error);
      ack(INVALID_ROOM_ACTION_ACK);
    }
  }

  function handleChat(
    socket: RoomSocket,
    payload: unknown,
    ack: (response: Ack<Record<string, never>>) => void,
  ): void {
    if (!isChatPayload(payload)) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }

    const binding = socketBindings.get(socket.id);
    if (binding === undefined) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }

    const text = payload.text.trim();
    if (text.length === 0) {
      ack({ ok: true });
      return;
    }

    const now = Date.now();
    const last = chatRate.get(binding.playerId) ?? 0;
    if (now - last < CHAT_MIN_INTERVAL_MS) {
      // 频率过高：静默丢弃，避免给客户端错误刷屏反馈。
      ack({ ok: true });
      return;
    }
    chatRate.set(binding.playerId, now);

    const room = roomManager.getPublicRoom(binding.roomCode);
    if (room === null) {
      ack({ ok: true });
      return;
    }
    const player = room.players.find((member) => member.id === binding.playerId);
    const spectator = player === undefined
      ? room.spectators.find((member) => member.id === binding.playerId)
      : undefined;
    const nickname = player?.nickname ?? spectator?.nickname ?? '玩家';
    const role: ChatMessage['role'] = player !== undefined ? 'player' : 'spectator';
    const message: ChatMessage = {
      playerId: binding.playerId,
      nickname,
      text: text.length > CHAT_TEXT_MAX_LENGTH ? text.slice(0, CHAT_TEXT_MAX_LENGTH) : text,
      ts: now,
      role,
    };
    io.to(binding.roomCode).emit('room:chat_broadcast', message);
    // 同步写入房间历史（有界）：后加入 / 重连的成员能拿到这段记录。
    const history = chatHistory.get(binding.roomCode);
    if (history === undefined) {
      chatHistory.set(binding.roomCode, [message]);
    } else {
      history.push(message);
      if (history.length > CHAT_HISTORY_LIMIT) {
        history.splice(0, history.length - CHAT_HISTORY_LIMIT);
      }
    }
    ack({ ok: true });
  }

  function handleDisconnect(socket: RoomSocket): void {
    const binding = socketBindings.get(socket.id);
    if (binding === undefined) {
      return;
    }

    const bindingKey = getPlayerBindingKey(binding.roomCode, binding.playerId);
    if (playerSocketIds.get(bindingKey) !== socket.id) {
      socketBindings.delete(socket.id);
      return;
    }

    unbindSocket(socket);
    const result = roomManager.markDisconnected(binding.roomCode, binding.playerId);
    if (result.ok) {
      dispatchDomainEvents(result.events);
      dispatchLobbyStateAfterConnectionEvent(result);
    }
  }

  function bind(): void {
    io.on('connection', (socket) => {
      socket.on('room:create', (payload, ack) => {
        if (typeof ack !== 'function') {
          return;
        }

        handleCreate(socket, payload, ack);
      });
      socket.on('room:join', (payload, ack) => {
        if (typeof ack !== 'function') {
          return;
        }

        handleJoin(socket, payload, ack);
      });
      socket.on('room:list', (ack) => {
        if (typeof ack !== 'function') {
          return;
        }

        handleListRooms(socket, ack);
      });
      socket.on('session:resume', (payload, ack) => {
        if (typeof ack !== 'function') {
          return;
        }

        handleResume(socket, payload, ack);
      });
      socket.on('room:add_bot', (ack) => {
        if (typeof ack !== 'function') {
          return;
        }

        handleAddBot(socket, ack);
      });
      socket.on('room:remove_bot', (payload, ack) => {
        if (typeof ack !== 'function') {
          return;
        }

        handleRemoveBot(socket, payload, ack);
      });
      socket.on('room:rename_bot', (payload, ack) => {
        if (typeof ack !== 'function') {
          return;
        }

        handleRenameBot(socket, payload, ack);
      });
      socket.on('room:update_settings', (payload, ack) => {
        if (typeof ack !== 'function') {
          return;
        }

        handleUpdateSettings(socket, payload, ack);
      });
      socket.on('room:start', (ack) => {
        if (typeof ack !== 'function') {
          return;
        }

        handleStart(socket, ack);
      });
      socket.on('room:skip_offline_turn', (ack) => {
        if (typeof ack !== 'function') {
          return;
        }

        handleSkipOfflineTurn(socket, ack);
      });
      socket.on('game:intent', (payload, ack) => {
        if (typeof ack !== 'function') {
          return;
        }

        handleGameIntent(socket, payload, ack);
      });
      socket.on('room:leave', (ack) => {
        if (typeof ack !== 'function') {
          return;
        }

        handleLeave(socket, ack);
      });
      socket.on('room:kick_player', (payload, ack) => {
        if (typeof ack !== 'function') {
          return;
        }

        handleKick(socket, payload, ack);
      });
      socket.on('room:chat_message', (payload, ack) => {
        if (typeof ack !== 'function') {
          return;
        }

        handleChat(socket, payload, ack);
      });
      socket.on('room:undo_request', (ack) => {
        if (typeof ack !== 'function') {
          return;
        }

        handleUndoRequest(socket, ack);
      });
      socket.on('room:undo_vote', (payload, ack) => {
        if (typeof ack !== 'function') {
          return;
        }

        handleUndoVote(socket, payload, ack);
      });
      socket.on('room:undo_cancel', (ack) => {
        if (typeof ack !== 'function') {
          return;
        }

        handleUndoCancel(socket, ack);
      });
      socket.on('disconnect', () => {
        handleDisconnect(socket);
      });
    });
  }

  return {
    bind,
    dispatchDomainEvents,
  };
}

function isCreateRoomPayload(payload: unknown): payload is CreateRoomPayload {
  return (
    isRecord(payload) &&
    typeof payload.nickname === 'string' &&
    typeof payload.mapId === 'string' &&
    payload.mapId.length > 0 &&
    typeof payload.requestId === 'string' &&
    REQUEST_ID_RE.test(payload.requestId)
  );
}

function isJoinRoomPayload(payload: unknown): payload is JoinRoomPayload {
  return (
    isRecord(payload) &&
    typeof payload.roomCode === 'string' &&
    typeof payload.nickname === 'string' &&
    (payload.role === 'player' || payload.role === 'spectator') &&
    typeof payload.requestId === 'string' &&
    REQUEST_ID_RE.test(payload.requestId) &&
    // 房间密码（#23 ③）：可选。这里只挡「类型不对」，
    // 长度与正确性都交给 `RoomManager.joinRoom`——把长度规则抄成两份，早晚会漂移。
    (payload.password === undefined || typeof payload.password === 'string')
  );
}

function ackAfterEventFlush<TSuccess extends object>(
  ack: (response: Ack<TSuccess>) => void,
  response: Ack<TSuccess>,
): void {
  setTimeout(() => {
    ack(response);
  }, 0);
}

function ackAfterEventFlushFrom<TSuccess extends object>(
  ack: (response: Ack<TSuccess>) => void,
  responseFactory: () => Ack<TSuccess>,
): void {
  setTimeout(() => {
    ack(responseFactory());
  }, 0);
}

function isResumePayload(payload: unknown): payload is { roomCode: string; playerId: string; token: string } {
  return (
    isRecord(payload) &&
    typeof payload.roomCode === 'string' &&
    typeof payload.playerId === 'string' &&
    typeof payload.token === 'string'
  );
}

function isRemoveBotPayload(payload: unknown): payload is { playerId: string } {
  return isRecord(payload) && typeof payload.playerId === 'string';
}

function isKickPayload(payload: unknown): payload is { playerId: string } {
  return isRecord(payload) && typeof payload.playerId === 'string';
}

function isChatPayload(payload: unknown): payload is { text: string } {
  return isRecord(payload) && typeof payload.text === 'string' && payload.text.length <= 2000;
}

function isRenameBotPayload(payload: unknown): payload is { playerId: string; nickname: string } {
  return isRecord(payload)
    && typeof payload.playerId === 'string'
    && typeof payload.nickname === 'string';
}

/** 房间设置 patch（#4 / #6 / #101 / #23 ③）：各字段均可省略；`ruleConfig: null` 表示「恢复地图默认」。 */
function isUpdateSettingsPayload(payload: unknown): payload is RoomSettingsPatch {
  if (!isRecord(payload)) return false;
  const { botDifficulty, ruleConfig, minimalUndoEnabled, auctionOnDecline, cashGoal, password, allowSpectators } = payload;
  if (botDifficulty !== undefined
    && botDifficulty !== 'easy'
    && botDifficulty !== 'normal'
    && botDifficulty !== 'hard') {
    return false;
  }
  if (ruleConfig !== undefined && ruleConfig !== null && !isRuleConfigShape(ruleConfig)) {
    return false;
  }
  if (minimalUndoEnabled !== undefined && typeof minimalUndoEnabled !== 'boolean') {
    return false;
  }
  // 拍卖房规（#106）与 minimalUndoEnabled 同类：布尔门禁在适配器层就拦掉，
  // 不让「字符串 true」这类载荷走到 RoomManager 再回一个语义更模糊的错误。
  if (auctionOnDecline !== undefined && typeof auctionOnDecline !== 'boolean') {
    return false;
  }
  // 现金目标（#23 ③）：`null` = 关闭，否则必须是有限数。范围（> 生效初始资金）由
  // RoomManager 结合地图配置与 ruleConfig 判定——适配器拿不到这两样东西。
  if (cashGoal !== undefined && cashGoal !== null
    && (typeof cashGoal !== 'number' || !Number.isFinite(cashGoal))) {
    return false;
  }
  // 房间密码（#23 ③）：`null` = 取消，否则必须是字符串（明文，仅此一次）。
  // 长度规则不在这里重复——见 `isJoinRoomPayload` 的说明。
  if (password !== undefined && password !== null && typeof password !== 'string') {
    return false;
  }
  if (allowSpectators !== undefined && typeof allowSpectators !== 'boolean') {
    return false;
  }
  return true;
}

/** 只校验三个数值字段的形状；范围（房级上限等）由 RoomManager 结合地图配置判定。 */
function isRuleConfigShape(value: unknown): boolean {
  return isRecord(value)
    && typeof value.initialCash === 'number'
    && typeof value.maxHouseLevel === 'number'
    && typeof value.mortgageInterestRate === 'number';
}

function isGameIntentPayload(payload: unknown): payload is { intent: Intent } {
  return isRecord(payload) && isValidIntent(payload.intent);
}

/**
 * 悔棋表决 payload（#101）。
 *
 * `requestId` 只校验「非空字符串」而**不**套 `REQUEST_ID_RE`：那个 32 位十六进制的约束
 * 是客户端建房/加入时自己生成的关联 id，而悔棋的 requestId 由服务端 `generateToken()` 产出
 * （单测里就是 `token-1` 这样的字面量），两者根本不是同一套格式。
 */
function isUndoVotePayload(payload: unknown): payload is { requestId: string; approve: boolean } {
  return isRecord(payload)
    && typeof payload.requestId === 'string'
    && payload.requestId.length > 0
    && typeof payload.approve === 'boolean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getPlayerBindingKey(roomCode: string, playerId: string): string {
  return `${roomCode}:${playerId}`;
}
