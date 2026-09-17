import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { createOnlineSession, type OnlineGameSession } from '../../../client/src/session/onlineSession';
import { ACTIVE_ONLINE_SESSION_KEY } from '../../../client/src/session/sessionStorage';
import { createRoomServer, type RunningRoomServer } from '../server';
import { RoomManager } from '../rooms/roomManager';
import type { RoomManagerDependencies } from '../rooms/roomTypes';
import type { PublicRoomState } from '@richman/protocol';

class MemoryStorage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

type TimerHandle = { active: boolean };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

// Await real `room:state` socket events until the session's authoritative room satisfies the
// predicate. The session registers its own `room:state` handler before this one, so once our
// resolver fires the reactive room has already been updated — no timers, no polling.
async function untilRoom(
  session: OnlineGameSession,
  socket: Socket,
  predicate: (room: PublicRoomState | null) => boolean,
): Promise<void> {
  while (!predicate(session.room.value)) {
    const { promise, resolve } = deferred<void>();
    socket.once('room:state', () => { resolve(); });
    await promise;
  }
}
const servers: RunningRoomServer<TimerHandle>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

describe('client online session over Socket.IO', () => {
  test('creates, joins, and retains an opening snapshot emitted before start acknowledgement', async () => {
    let roomNumber = 7;
    let playerNumber = 0;
    const server = createRoomServer<TimerHandle>({
      roomManagerFactory: (onAsyncEvents) => new RoomManager<TimerHandle>({
        generatePlayerId: () => `player-${++playerNumber}`,
        generateToken: () => `token-${playerNumber}`,
        nextRoomNumber: () => roomNumber++,
        compareTokens: (actual, supplied) => actual === supplied,
        setTimer: () => ({ active: true }),
        clearTimer: (handle) => { handle.active = false; },
        onAsyncEvents,
        generateGameSeed: () => 'client-online-test-seed',
        nextAutomationDelayMs: () => 1_000,
      } satisfies RoomManagerDependencies<TimerHandle>),
    });
    servers.push(server);
    const listening = deferred<void>();
    server.httpServer.listen(0, '127.0.0.1', () => listening.resolve());
    await listening.promise;
    const address = server.httpServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;
    const host = createOnlineSession({ url, storage: new MemoryStorage(), socketFactory: (target) => io(target) as never });
    const guest = createOnlineSession({ url, storage: new MemoryStorage(), socketFactory: (target) => io(target) as never });

    await host.create('房主', 'china-tour');
    await guest.join(host.room.value!.roomCode, '客人');
    await host.start();

    expect(host.room.value?.status).toBe('playing');
    expect(guest.room.value?.players).toHaveLength(2);
    expect(host.state.value?.phase).toBeDefined();
    const guestPlayerId = guest.localPlayerId.value;
    await guest.leave();
    expect(server.roomManager.getPublicRoom(host.room.value!.roomCode)?.players.find((player) => player.id === guestPlayerId)).toMatchObject({
      online: false,
    });
    host.dispose();
    guest.dispose();
  });

  test('retries a create whose committed server acknowledgement packet was dropped without duplicating the room', async () => {
    let roomNumber = 7;
    let playerNumber = 0;
    const server = createRoomServer<TimerHandle>({
      roomManagerFactory: (onAsyncEvents) => new RoomManager<TimerHandle>({
        generatePlayerId: () => `player-${++playerNumber}`,
        generateToken: () => `token-${playerNumber}`,
        nextRoomNumber: () => roomNumber++,
        compareTokens: (actual, supplied) => actual === supplied,
        setTimer: () => ({ active: true }),
        clearTimer: (handle) => { handle.active = false; },
        onAsyncEvents,
        generateGameSeed: () => 'client-online-test-seed',
        nextAutomationDelayMs: () => 1_000,
      } satisfies RoomManagerDependencies<TimerHandle>),
    });
    servers.push(server);
    const listening = deferred<void>();
    server.httpServer.listen(0, '127.0.0.1', () => listening.resolve());
    await listening.promise;
    const address = server.httpServer.address() as AddressInfo;
    let swallowNextCreateAck = true;
    let cryptoCalls = 0;
    const hostStorage = new MemoryStorage();
    const host = createOnlineSession({
      url: `http://127.0.0.1:${address.port}`,
      storage: hostStorage,
      ackTimeoutMs: 500,
      crypto: { getRandomValues: (bytes) => { cryptoCalls += 1; return bytes.fill(0xab); } },
      socketFactory: (target) => {
        const socket = io(target);
        return {
          get connected() { return socket.connected; },
          on(event: string, listener: (...args: never[]) => void) { socket.on(event as never, listener as never); return this; },
          off(event: string, listener: (...args: never[]) => void) { socket.off(event as never, listener as never); return this; },
          emit(event: string, ...args: unknown[]) {
            if (event === 'room:create' && swallowNextCreateAck) {
              swallowNextCreateAck = false;
              args[args.length - 1] = () => undefined;
            }
            socket.emit(event as never, ...(args as never[]));
            return this;
          },
          disconnect() { socket.disconnect(); return this; },
        } as never;
      },
    });

    await host.create('房主', 'china-tour');
    await host.retryPending();

    expect(cryptoCalls).toBe(1);
    expect(host.room.value?.roomCode).toBe('0007');
    expect(host.localPlayerId.value).toBe('player-1');
    expect(server.roomManager.getPublicRoom('0007')?.players).toHaveLength(1);
    host.dispose();
    expect(JSON.parse(hostStorage.getItem(ACTIVE_ONLINE_SESSION_KEY) ?? '')).toMatchObject({
      roomCode: '0007', playerId: 'player-1', token: 'token-1',
    });
  });

  test('retries a join whose committed server acknowledgement packet was dropped without duplicating the guest', async () => {
    let roomNumber = 7;
    let playerNumber = 0;
    const server = createRoomServer<TimerHandle>({
      roomManagerFactory: (onAsyncEvents) => new RoomManager<TimerHandle>({
        generatePlayerId: () => `player-${++playerNumber}`,
        generateToken: () => `token-${playerNumber}`,
        nextRoomNumber: () => roomNumber++,
        compareTokens: (actual, supplied) => actual === supplied,
        setTimer: () => ({ active: true }),
        clearTimer: (handle) => { handle.active = false; },
        onAsyncEvents,
        generateGameSeed: () => 'client-online-test-seed',
        nextAutomationDelayMs: () => 1_000,
      } satisfies RoomManagerDependencies<TimerHandle>),
    });
    servers.push(server);
    const listening = deferred<void>();
    server.httpServer.listen(0, '127.0.0.1', () => listening.resolve());
    await listening.promise;
    const address = server.httpServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;
    const host = createOnlineSession({ url, storage: new MemoryStorage(), socketFactory: (target) => io(target) as never });
    await host.create('房主', 'china-tour');
    let swallowNextJoinAck = true;
    let cryptoCalls = 0;
    const guestStorage = new MemoryStorage();
    const guest = createOnlineSession({
      url,
      storage: guestStorage,
      ackTimeoutMs: 500,
      crypto: { getRandomValues: (bytes) => { cryptoCalls += 1; return bytes.fill(0xcd); } },
      socketFactory: (target) => {
        const socket = io(target);
        return {
          get connected() { return socket.connected; },
          on(event: string, listener: (...args: never[]) => void) { socket.on(event as never, listener as never); return this; },
          off(event: string, listener: (...args: never[]) => void) { socket.off(event as never, listener as never); return this; },
          emit(event: string, ...args: unknown[]) {
            if (event === 'room:join' && swallowNextJoinAck) {
              swallowNextJoinAck = false;
              args[args.length - 1] = () => undefined;
            }
            socket.emit(event as never, ...(args as never[]));
            return this;
          },
          disconnect() { socket.disconnect(); return this; },
        } as never;
      },
    });

    await guest.join('0007', '客人');
    await guest.retryPending();

    expect(cryptoCalls).toBe(1);
    expect(guest.localPlayerId.value).toBe('player-2');
    expect(server.roomManager.getPublicRoom('0007')?.players).toHaveLength(2);
    expect(server.roomManager.getPublicRoom('0007')?.players.map((player) => player.id)).toEqual(['player-1', 'player-2']);
    host.dispose();
    expect(JSON.parse(guestStorage.getItem(ACTIVE_ONLINE_SESSION_KEY) ?? '')).toMatchObject({
      roomCode: '0007', playerId: 'player-2', token: 'token-2',
    });
    guest.dispose();
  });

  test('host manages bots and starts while the guest sees an identical read-only room', async () => {
    let roomNumber = 7;
    let playerNumber = 0;
    const server = createRoomServer<TimerHandle>({
      roomManagerFactory: (onAsyncEvents) => new RoomManager<TimerHandle>({
        generatePlayerId: () => `player-${++playerNumber}`,
        generateToken: () => `token-${playerNumber}`,
        nextRoomNumber: () => roomNumber++,
        compareTokens: (actual, supplied) => actual === supplied,
        setTimer: () => ({ active: true }),
        clearTimer: (handle) => { handle.active = false; },
        onAsyncEvents,
        generateGameSeed: () => 'client-online-test-seed',
        nextAutomationDelayMs: () => 1_000,
      } satisfies RoomManagerDependencies<TimerHandle>),
    });
    servers.push(server);
    const listening = deferred<void>();
    server.httpServer.listen(0, '127.0.0.1', () => listening.resolve());
    await listening.promise;
    const address = server.httpServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;
    let hostSocket!: Socket;
    let guestSocket!: Socket;
    const host = createOnlineSession({ url, storage: new MemoryStorage(), socketFactory: (target) => (hostSocket = io(target)) as never });
    const guest = createOnlineSession({ url, storage: new MemoryStorage(), socketFactory: (target) => (guestSocket = io(target)) as never });

    await host.create('房主', 'china-tour');
    await guest.join(host.room.value!.roomCode, '客人');
    await untilRoom(host, hostSocket, (room) => room?.players.length === 2);
    await untilRoom(guest, guestSocket, (room) => room?.players.length === 2);

    // Host identity and start readiness are derived from the authoritative room.
    expect(host.isHost.value).toBe(true);
    expect(guest.isHost.value).toBe(false);
    expect(host.startBlockedReason.value).toBeNull();
    expect(guest.startBlockedReason.value).toBe('只有房主可以开始游戏');

    // Host adds a bot; both sides converge on an identical roster with the bot labelled.
    await host.addBot();
    await untilRoom(host, hostSocket, (room) => room?.players.length === 3);
    await untilRoom(guest, guestSocket, (room) => room?.players.length === 3);
    const bot = host.room.value!.players.find((player) => player.isBot);
    expect(bot).toMatchObject({ nickname: '电脑 A', isBot: true });
    expect(guest.room.value).toEqual(host.room.value);

    // Guest lobby commands are rejected by the server and never mutate either roster.
    await guest.addBot();
    await guest.removeBot(bot!.id);
    await guest.start();
    expect(guest.lastError.value).not.toBeNull();
    expect(host.room.value!.players).toHaveLength(3);
    expect(guest.room.value!.players).toHaveLength(3);
    expect(guest.room.value!.status).toBe('lobby');
    expect(host.room.value!.status).toBe('lobby');

    // Host removes the bot, then starts; the server room:state is the sole authority for playing.
    await host.removeBot(bot!.id);
    await untilRoom(host, hostSocket, (room) => room?.players.length === 2);
    await untilRoom(guest, guestSocket, (room) => room?.players.length === 2);
    await host.start();
    await untilRoom(host, hostSocket, (room) => room?.status === 'playing');
    await untilRoom(guest, guestSocket, (room) => room?.status === 'playing');
    expect(host.room.value!.status).toBe('playing');
    expect(guest.room.value!.status).toBe('playing');
    expect(guest.room.value).toEqual(host.room.value);

    host.dispose();
    guest.dispose();
  });

  test('join as spectator sits on the spectator roster and cannot mutate the lobby', async () => {
    let roomNumber = 7;
    let playerNumber = 0;
    const server = createRoomServer<TimerHandle>({
      roomManagerFactory: (onAsyncEvents) => new RoomManager<TimerHandle>({
        generatePlayerId: () => `player-${++playerNumber}`,
        generateToken: () => `token-${playerNumber}`,
        nextRoomNumber: () => roomNumber++,
        compareTokens: (actual, supplied) => actual === supplied,
        setTimer: () => ({ active: true }),
        clearTimer: (handle) => { handle.active = false; },
        onAsyncEvents,
        generateGameSeed: () => 'client-online-test-seed',
        nextAutomationDelayMs: () => 1_000,
      } satisfies RoomManagerDependencies<TimerHandle>),
    });
    servers.push(server);
    const listening = deferred<void>();
    server.httpServer.listen(0, '127.0.0.1', () => listening.resolve());
    await listening.promise;
    const address = server.httpServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;
    let hostSocket!: Socket;
    let spectatorSocket!: Socket;
    const host = createOnlineSession({ url, storage: new MemoryStorage(), socketFactory: (target) => (hostSocket = io(target)) as never });
    const spectator = createOnlineSession({ url, storage: new MemoryStorage(), socketFactory: (target) => (spectatorSocket = io(target)) as never });

    await host.create('房主', 'china-tour');
    await spectator.join(host.room.value!.roomCode, '观众', 'spectator');
    await untilRoom(host, hostSocket, (room) => (room?.spectators.length ?? 0) === 1);
    await untilRoom(spectator, spectatorSocket, (room) => (room?.spectators.length ?? 0) === 1);

    expect(spectator.isSpectator.value).toBe(true);
    expect(spectator.isHost.value).toBe(false);
    expect(host.room.value?.players).toHaveLength(1);
    expect(host.room.value?.spectators).toEqual([
      expect.objectContaining({ id: spectator.localPlayerId.value, nickname: '观众', online: true }),
    ]);
    await spectator.addBot();
    expect(host.room.value?.players).toHaveLength(1);
    expect(host.room.value?.spectators).toHaveLength(1);

    host.dispose();
    spectator.dispose();
  });
});
