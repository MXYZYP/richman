import type { Server as SocketIoServer, Socket } from 'socket.io';
import type {
  Ack,
  ClientToServerEvents,
  CreateRoomAck,
  CreateRoomPayload,
  InterServerEvents,
  JoinRoomAck,
  JoinRoomPayload,
  PublicRoomState,
  ResumeAck,
  ServerToClientEvents,
  SocketData,
} from '@richman/protocol';
import { toPublicGameSnapshot } from '../publicGameSnapshot';
import { isValidIntent } from '../game/gameRuntime';
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

export interface RoomSocketAdapterOptions<TTimerHandle = unknown> {
  io: RoomIo;
  roomManager: RoomManager<TTimerHandle>;
  logger?: RoomSocketAdapterLogger;
}

const INVALID_ROOM_ACTION_ACK = {
  ok: false,
  code: 'INVALID_ROOM_ACTION',
  message: 'Invalid room action payload.',
} as const;

const REQUEST_ID_RE = /^[0-9a-fA-F]{32}$/;

export function createRoomSocketAdapter<TTimerHandle = unknown>({
  io,
  roomManager,
  logger,
}: RoomSocketAdapterOptions<TTimerHandle>): RoomSocketAdapter<TTimerHandle> {
  const socketBindings = new Map<string, SocketBinding>();
  const playerSocketIds = new Map<string, string>();

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

      io.to(event.roomCode).emit('room:closed', { reason: event.reason });
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

  function handleCreate(socket: RoomSocket, payload: unknown, ack: (response: Ack<CreateRoomAck>) => void): void {
    if (!isCreateRoomPayload(payload)) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }

    try {
      const result = roomManager.createRoom(payload.nickname, payload.mapId, payload.requestId);
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
      ackAfterEventFlushFrom(ack, () => ({
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
      const result = roomManager.joinRoom(payload.roomCode, payload.nickname, payload.requestId, payload.role);
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
      ackAfterEventFlushFrom(ack, () => {
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
      ackAfterEventFlushFrom(ack, () => {
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
    REQUEST_ID_RE.test(payload.requestId)
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

function isRenameBotPayload(payload: unknown): payload is { playerId: string; nickname: string } {
  return isRecord(payload)
    && typeof payload.playerId === 'string'
    && typeof payload.nickname === 'string';
}

function isGameIntentPayload(payload: unknown): payload is { intent: Intent } {
  return isRecord(payload) && isValidIntent(payload.intent);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getPlayerBindingKey(roomCode: string, playerId: string): string {
  return `${roomCode}:${playerId}`;
}
