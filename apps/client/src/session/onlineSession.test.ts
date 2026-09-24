import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTIVE_ONLINE_SESSION_KEY, PENDING_ROOM_REQUEST_KEY } from './sessionStorage';
import { createOnlineSession, type OnlineGameSession } from './onlineSession';
import { createGame } from '@richman/engine';
import { getActiveMapPack } from '@richman/board-data';
import type { ChatMessage, PublicGameSnapshot } from '@richman/protocol';

const chinaMapPack = getActiveMapPack('china-tour');
const CHINA_ROOM_MAP = { ref: chinaMapPack.ref, title: chinaMapPack.metadata.title };
const MAP_COMPATIBILITY_ERROR = '当前客户端缺少房间所需地图，请刷新或更新后重试。';

function createPublicSnapshot(overrides: Partial<PublicGameSnapshot> = {}): PublicGameSnapshot {
  const state = createGame({
    mapRef: chinaMapPack.ref,
    ruleModules: chinaMapPack.game.requiredRuleModules,
    board: chinaMapPack.game.board,
    cards: chinaMapPack.game.cards,
    config: chinaMapPack.game.config,
    players: [
      { id: 'player-1', nickname: '玩家一' },
      { id: 'player-2', nickname: '玩家二' },
    ],
    seed: 'online-session-snapshot',
  });
  return {
    mapRef: state.mapRef,
    turn: state.turn,
    phase: state.phase,
    turnPhase: state.turnPhase,
    currentPlayerId: state.currentPlayerId,
    players: state.players,
    properties: state.properties,
    debt: state.debt,
    lastDice: state.lastDice,
    recentLog: state.recentLog,
    winnerId: state.winnerId,
    cashGoal: state.cashGoal,
    deckCounts: {
      chance: state.decks.chance.length,
      destiny: state.decks.destiny.length,
    },
    // 议价（#105/#106）三个新字段：`?? null` / `=== true` 归一，与 publicGameSnapshot 的服务端投影同源。
    pendingTrade: state.pendingTrade ?? null,
    pendingAuction: state.pendingAuction ?? null,
    auctionOnDecline: state.auctionOnDecline === true,
    ...overrides,
  };
}

function createIncompatibleSnapshot(): PublicGameSnapshot {
  const snapshot = createPublicSnapshot();
  return {
    ...snapshot,
    mapRef: { ...snapshot.mapRef, contentHash: 'f'.repeat(64) },
  };
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

afterEach(() => { vi.useRealTimers(); });

describe('online session', () => {
  it('writes a generated pending create request before emitting it', async () => {
    const emissions: unknown[][] = [];
    const session = createOnlineSession({
      storage: new MemoryStorage(),
      crypto: { getRandomValues: (bytes) => bytes.fill(0xab) },
      socketFactory: () => ({
        connected: true,
        on() { return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        connect() { return this; },
        disconnect() { return this; },
      }),
    });

    void session.create('房主', 'test-harbor-loop');

    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.[0]).toBe('room:create');
    expect(emissions[0]?.[1]).toEqual({
      nickname: '房主',
      requestId: 'abababababababababababababababab',
      mapId: 'test-harbor-loop',
    });
  });

  it('registers every listener before an operation and ignores stale callbacks after dispose', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const emissions: unknown[][] = [];
    const storage = new MemoryStorage();
    const socket = {
      connected: true,
      on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
      off(event: string) { listeners.delete(event); return this; },
      emit(...args: unknown[]) { emissions.push(args); return this; },
      disconnect() { return this; },
    };
    const session = createOnlineSession({ storage, socketFactory: () => socket as never });

    expect([...listeners.keys()]).toEqual([
      'room:state', 'player:connection', 'room:closed', 'game:events', 'game:snapshot', 'room:chat_broadcast', 'room:chat_history', 'room:settings',
      'room:undo_request', 'room:undo_result', 'room:undo_available',
      'connect', 'disconnect', 'connect_error',
    ]);
    const staleRoomState = listeners.get('room:state');
    void session.create('房主', 'china-tour');
    expect(emissions).toHaveLength(1);
    session.dispose();
    staleRoomState?.({
      roomCode: '123456', status: 'lobby', hostId: 'host', players: [], spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP,
    });

    expect(session.room.value).toBeNull();
  });

  it('replaces the chat log with the server history and keeps live broadcasts appended after it', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const socket = {
      connected: true,
      on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
      off(event: string) { listeners.delete(event); return this; },
      emit() { return this; },
      disconnect() { return this; },
    };
    const session = createOnlineSession({ storage: new MemoryStorage(), socketFactory: () => socket as never });

    const history: ChatMessage[] = [
      { playerId: 'p1', nickname: '房主', text: '历史一', ts: 1, role: 'player' },
      { playerId: 'p2', nickname: '客人', text: '历史二', ts: 2, role: 'player' },
    ];
    // 进入房间 / 重连时服务端单播最近记录 → 本地 chatLog 以服务端为准整体覆盖。
    listeners.get('room:chat_history')?.({ messages: history });
    expect(session.chatLog.value.map((message) => message.text)).toEqual(['历史一', '历史二']);

    // 之后到达的实时广播追加在历史之后。
    listeners.get('room:chat_broadcast')?.({ playerId: 'p1', nickname: '房主', text: '实时', ts: 3, role: 'player' });
    expect(session.chatLog.value.map((message) => message.text)).toEqual(['历史一', '历史二', '实时']);

    // 再次收到历史（例如刷新后重连）不会把已有记录重复累加。
    listeners.get('room:chat_history')?.({ messages: history });
    expect(session.chatLog.value.map((message) => message.text)).toEqual(['历史一', '历史二']);

    // 畸形载荷被忽略，不影响既有记录。
    listeners.get('room:chat_history')?.({ messages: 'oops' });
    expect(session.chatLog.value.map((message) => message.text)).toEqual(['历史一', '历史二']);

    session.dispose();
  });

  it('reuses the persisted pending request on retry instead of generating a second request id', async () => {    const storage = new MemoryStorage();
    const emissions: unknown[][] = [];
    let cryptoCalls = 0;
    const session = createOnlineSession({
      storage,
      ackTimeoutMs: 1,
      crypto: { getRandomValues: (bytes) => { cryptoCalls += 1; return bytes.fill(0xcd); } },
      socketFactory: () => ({
        connected: true,
        on() { return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });

    await session.create('房主', 'test-harbor-loop');
    await session.retryPending();

    expect(cryptoCalls).toBe(1);
    expect(emissions.map((emission) => emission[1])).toEqual([
      { nickname: '房主', requestId: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd', mapId: 'test-harbor-loop' },
      { nickname: '房主', requestId: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd', mapId: 'test-harbor-loop' },
    ]);
  });

  it('keeps a retry gate owned by its attempt when an expired attempt acknowledges late', async () => {
    vi.useFakeTimers();
    const emissions: unknown[][] = [];
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    const session = createOnlineSession({
      storage,
      ackTimeoutMs: 1,
      socketFactory: () => ({
        connected: true,
        on() { return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });

    (emissions[0]?.at(-1) as (ack: unknown) => void)({
      ok: true,
      room: { roomCode: '123456', status: 'lobby', hostId: 'player-1', players: [], spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP },
    });
    await Promise.resolve();
    await Promise.resolve();

    const first = session.start();
    await vi.advanceTimersByTimeAsync(1);
    await first;
    const second = session.start();
    const firstAck = emissions[1]?.at(-1) as ((ack: { ok: boolean }) => void);
    firstAck({ ok: true });
    await Promise.resolve();
    void session.start();

    expect(emissions).toHaveLength(3);
    const secondAck = emissions[2]?.at(-1) as ((ack: { ok: boolean }) => void);
    secondAck({ ok: true });
    await second;
    void session.start();
    expect(emissions).toHaveLength(4);
  });

  it('still emits the create request when pending storage fails, keeping the entry recoverable', async () => {
    const emissions: unknown[][] = [];
    const storage = new MemoryStorage();
    storage.setItem = () => { throw new Error('storage unavailable'); };
    const session = createOnlineSession({
      storage,
      socketFactory: () => ({
        connected: true,
        on() { return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });

    void session.create('sensitive-nickname', 'china-tour');
    await Promise.resolve();

    // 持久化待恢复请求属"尽力而为"：写失败只意味着失去断线自动恢复，不应阻断建房。
    expect(emissions).toHaveLength(1);
    // 失败原因也不应把敏感昵称回显给用户。
    expect(session.lastError.value ?? '').not.toContain('sensitive-nickname');
  });

  it('makes a captured create acknowledgement inert after disposal', async () => {
    const emissions: unknown[][] = [];
    const storage = new MemoryStorage();
    const session = createOnlineSession({
      storage,
      socketFactory: () => ({
        connected: true,
        on() { return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });

    const creating = session.create('owner', 'china-tour');
    const acknowledge = emissions[0]?.at(-1) as ((ack: unknown) => void);
    session.dispose();
    acknowledge({
      ok: true,
      playerId: 'player-1',
      token: 'secret-token',
      room: { roomCode: '123456', status: 'lobby', hostId: 'player-1', players: [], spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP },
    });
    await creating;

    expect(storage.getItem(ACTIVE_ONLINE_SESSION_KEY)).toBeNull();
    expect(storage.getItem(PENDING_ROOM_REQUEST_KEY)).not.toBeNull();
    expect(session.room.value).toBeNull();
    expect(session.localPlayerId.value).toBeNull();
  });

  it('preserves local session state when leave fails', async () => {
    const emissions: unknown[][] = [];
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    storage.setItem(PENDING_ROOM_REQUEST_KEY, JSON.stringify({ operation: 'create', mapId: 'china-tour', nickname: 'owner', requestId: 'abababababababababababababababab' }));
    const session = createOnlineSession({
      storage,
      socketFactory: () => ({
        connected: true,
        on() { return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });

    const leaving = session.leave();
    const acknowledge = emissions.at(-1)?.at(-1) as ((ack: { ok: boolean; code: string }) => void);
    acknowledge({ ok: false, code: 'REQUEST_TIMEOUT' });
    await leaving;

    expect(storage.getItem(ACTIVE_ONLINE_SESSION_KEY)).not.toBeNull();
    expect(storage.getItem(PENDING_ROOM_REQUEST_KEY)).not.toBeNull();
  });

  it('preserves local session storage when leave times out', async () => {
    vi.useFakeTimers();
    const emissions: unknown[][] = [];
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    storage.setItem(PENDING_ROOM_REQUEST_KEY, JSON.stringify({ operation: 'create', mapId: 'china-tour', nickname: 'owner', requestId: 'abababababababababababababababab' }));
    const session = createOnlineSession({
      storage,
      ackTimeoutMs: 1,
      socketFactory: () => ({
        connected: true,
        on() { return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });

    (emissions[0]?.at(-1) as (ack: unknown) => void)({
      ok: true,
      room: { roomCode: '123456', status: 'lobby', hostId: 'player-1', players: [], spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP },
    });
    await Promise.resolve();
    await Promise.resolve();
    const leaving = session.leave();
    await vi.advanceTimersByTimeAsync(1);
    await leaving;

    expect(emissions[1]?.[0]).toBe('room:leave');
    expect(storage.getItem(ACTIVE_ONLINE_SESSION_KEY)).not.toBeNull();
    expect(storage.getItem(PENDING_ROOM_REQUEST_KEY)).not.toBeNull();
  });

  it('resumes an active session immediately when a factory returns an already connected socket', () => {
    const emissions: unknown[][] = [];
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));

    createOnlineSession({
      storage,
      socketFactory: () => ({
        connected: true,
        on() { return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });

    expect(emissions[0]?.[0]).toBe('session:resume');
  });
  it('keeps a connect-error recovery deferred until an explicit retry', async () => {
    const listeners = new Map<string, (...args: never[]) => void>();
    const emissions: unknown[][] = [];
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    const socket = {
      connected: false,
      on(event: string, listener: (...args: never[]) => void) { listeners.set(event, listener); return this; },
      off() { return this; },
      emit(...args: unknown[]) { emissions.push(args); return this; },
      disconnect() { return this; },
    };
    const session = createOnlineSession({ storage, socketFactory: () => socket as never });

    listeners.get('connect_error')?.();
    session.deferResume();
    socket.connected = true;
    listeners.get('connect')?.();

    expect(emissions.filter(([event]) => event === 'session:resume')).toHaveLength(0);
    expect(session.room.value).toBeNull();
    expect(session.state.value).toBeNull();
    expect(session.connectionStatus.value).toBe('connected');
    expect(storage.getItem(ACTIVE_ONLINE_SESSION_KEY)).not.toBeNull();
  });

  it('cancels an in-flight resume when recovery is deferred and ignores its late acknowledgement', async () => {
    const emissions: unknown[][] = [];
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    const session = createOnlineSession({
      storage,
      socketFactory: () => ({
        connected: true,
        on() { return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });

    session.deferResume();
    (emissions[0]?.at(-1) as (ack: unknown) => void)({
      ok: true,
      room: { roomCode: '123456', status: 'lobby', hostId: 'player-1', players: [], spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(session.room.value).toBeNull();
    expect(session.state.value).toBeNull();
    expect(session.connectionStatus.value).toBe('connected');
  });

  it('does not restore a reset session when an in-flight resume acknowledges late', async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (...args: never[]) => void>();
    const emissions: unknown[][] = [];
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    const session = createOnlineSession({
      storage,
      socketFactory: () => ({
        connected: true,
        on(event: string, listener: (...args: never[]) => void) { listeners.set(event, listener); return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });

    listeners.get('room:closed')?.({ reason: 'game_over' } as never);
    (emissions[0]?.at(-1) as (ack: unknown) => void)({
      ok: true,
      room: { roomCode: '123456', status: 'lobby', hostId: 'player-1', players: [], spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP },
    });
    await Promise.resolve();
    await Promise.resolve();
    await vi.runAllTimersAsync();

    expect(session.room.value).toBeNull();
    expect(session.state.value).toBeNull();
    expect(storage.getItem(ACTIVE_ONLINE_SESSION_KEY)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('explicitly retries a deferred recovery once and restores reconnect auto-resume', async () => {
    const listeners = new Map<string, (...args: never[]) => void>();
    const emissions: unknown[][] = [];
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    const socket = {
      connected: false,
      on(event: string, listener: (...args: never[]) => void) { listeners.set(event, listener); return this; },
      off() { return this; },
      emit(...args: unknown[]) { emissions.push(args); return this; },
      disconnect() { return this; },
    };
    const session = createOnlineSession({ storage, socketFactory: () => socket as never });

    session.deferResume();
    socket.connected = true;
    listeners.get('connect')?.();
    const retry = session.retryResume();
    expect(emissions.filter(([event]) => event === 'session:resume')).toHaveLength(1);
    (emissions[0]?.at(-1) as (ack: unknown) => void)({
      ok: true,
      room: { roomCode: '123456', status: 'lobby', hostId: 'player-1', players: [], spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP },
    });
    await retry;

    expect(session.room.value?.roomCode).toBe('123456');
    socket.connected = false;
    listeners.get('disconnect')?.();
    socket.connected = true;
    listeners.get('connect')?.();
    expect(emissions.filter(([event]) => event === 'session:resume')).toHaveLength(2);
  });

  it('reconnects a failed session on retry: opens the transport once and resumes exactly once after connect', async () => {
    const listeners = new Map<string, (...args: never[]) => void>();
    const emissions: unknown[][] = [];
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    let connectCalls = 0;
    const socket = {
      connected: false,
      on(event: string, listener: (...args: never[]) => void) { listeners.set(event, listener); return this; },
      off() { return this; },
      emit(...args: unknown[]) { emissions.push(args); return this; },
      connect() { connectCalls += 1; return this; },
      disconnect() { return this; },
    };
    const session = createOnlineSession({ storage, socketFactory: () => socket as never });

    // Initial transport failure leaves the session failed and the socket dead.
    (listeners.get('connect_error') as ((error: unknown) => void) | undefined)?.(new Error('xhr poll error'));
    expect(session.connectionStatus.value).toBe('failed');

    // Retry must open the transport rather than emit a doomed resume against a dead socket.
    const retry = session.retryResume();
    expect(connectCalls).toBe(1);
    expect(session.connectionStatus.value).toBe('reconnecting');
    expect(emissions.filter(([event]) => event === 'session:resume')).toHaveLength(0);

    // A second retry while still connecting must not re-open the transport.
    await session.retryResume();
    expect(connectCalls).toBe(1);
    expect(emissions.filter(([event]) => event === 'session:resume')).toHaveLength(0);

    // The socket comes up; exactly one resume follows the connect.
    socket.connected = true;
    listeners.get('connect')?.();
    expect(emissions.filter(([event]) => event === 'session:resume')).toHaveLength(1);

    // Retrying again while that resume is still in flight must not emit a duplicate.
    void session.retryResume();
    expect(connectCalls).toBe(1);
    expect(emissions.filter(([event]) => event === 'session:resume')).toHaveLength(1);
    await retry;
  });
  it('releases the retry latch after every connect_error and ignores a late error after disposal', () => {
    const listeners = new Map<string, (...args: never[]) => void>();
    const emissions: unknown[][] = [];
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    let connectCalls = 0;
    const socket = {
      connected: false,
      on(event: string, listener: (...args: never[]) => void) { listeners.set(event, listener); return this; },
      off(event: string) { listeners.delete(event); return this; },
      emit(...args: unknown[]) { emissions.push(args); return this; },
      connect() { connectCalls += 1; return this; },
      disconnect() { return this; },
    };
    const session = createOnlineSession({ storage, socketFactory: () => socket as never });
    const connectError = listeners.get('connect_error') as ((error: unknown) => void);

    connectError(new Error('first transport failure'));
    void session.retryResume();
    expect(connectCalls).toBe(1);

    connectError(new Error('second transport failure'));
    void session.retryResume();
    expect(connectCalls).toBe(2);

    connectError(new Error('third transport failure'));
    void session.retryResume();
    expect(connectCalls).toBe(3);

    socket.connected = true;
    listeners.get('connect')?.();
    expect(emissions.filter(([event]) => event === 'session:resume')).toHaveLength(1);

    session.dispose();
    connectError(new Error('late transport failure'));
    expect(connectCalls).toBe(3);
    expect(emissions.filter(([event]) => event === 'session:resume')).toHaveLength(1);
  });

  it('ignores a late connect after dispose during a failed-session retry', async () => {
    const listeners = new Map<string, (...args: never[]) => void>();
    const emissions: unknown[][] = [];
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    let connectCalls = 0;
    const socket = {
      connected: false,
      on(event: string, listener: (...args: never[]) => void) { listeners.set(event, listener); return this; },
      off(event: string) { listeners.delete(event); return this; },
      emit(...args: unknown[]) { emissions.push(args); return this; },
      connect() { connectCalls += 1; return this; },
      disconnect() { return this; },
    };
    const session = createOnlineSession({ storage, socketFactory: () => socket as never });

    (listeners.get('connect_error') as ((error: unknown) => void) | undefined)?.(new Error('boom'));
    void session.retryResume();
    expect(connectCalls).toBe(1);
    session.dispose();

    // A retry after dispose must not touch the transport, and a late connect must not resume.
    await session.retryResume();
    expect(connectCalls).toBe(1);
    socket.connected = true;
    listeners.get('connect')?.();
    expect(emissions.filter(([event]) => event === 'session:resume')).toHaveLength(0);
  });

  it('supersedes a timed-out resume on reconnect and ignores its late acknowledgement', async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    const listeners = new Map<string, (...args: never[]) => void>();
    const emissions: unknown[][] = [];
    const socket = {
      connected: true,
      on(event: string, listener: (...args: never[]) => void) { listeners.set(event, listener); return this; },
      off() { return this; },
      emit(...args: unknown[]) { emissions.push(args); return this; },
      disconnect() { return this; },
    };
    const session = createOnlineSession({ storage, ackTimeoutMs: 1, socketFactory: () => socket as never });

    await vi.advanceTimersByTimeAsync(1);
    socket.connected = false;
    listeners.get('disconnect')?.();
    socket.connected = true;
    listeners.get('connect')?.();

    await Promise.resolve();
    expect(emissions.filter(([event]) => event === 'session:resume')).toHaveLength(2);
    const firstAck = emissions[0]?.at(-1) as (ack: unknown) => void;
    const secondAck = emissions[1]?.at(-1) as (ack: unknown) => void;
    firstAck({
      ok: true,
      room: { roomCode: 'late', status: 'lobby', hostId: 'player-1', players: [], spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP },
    });
    secondAck({
      ok: true,
      room: { roomCode: '123456', status: 'lobby', hostId: 'player-1', players: [], spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(session.room.value?.roomCode).toBe('123456');
    expect(session.localPlayerId.value).toBe('player-1');
  });

  it('retains transiently failed resume credentials and retries on the current socket', async () => {
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    const emissions: unknown[][] = [];
    const session = createOnlineSession({
      storage,
      socketFactory: () => ({
        connected: true,
        on() { return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });

    const firstAck = emissions[0]?.at(-1) as (ack: { ok: false; code: string; message: string }) => void;
    firstAck({ ok: false, code: 'REQUEST_TIMEOUT', message: '' });
    await Promise.resolve();
    const retry = session.retryResume();
    const retryAck = emissions[1]?.at(-1) as (ack: unknown) => void;
    retryAck({
      ok: true,
      room: { roomCode: '123456', status: 'lobby', hostId: 'player-1', players: [], spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP },
    });
    await retry;
    await Promise.resolve();

    expect(storage.getItem(ACTIVE_ONLINE_SESSION_KEY)).not.toBeNull();
    expect(session.connectionStatus.value).toBe('connected');
    expect(session.room.value?.roomCode).toBe('123456');
  });

  it('clears confidential local session state for permanent resume failure and safe room closure reasons', async () => {
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    storage.setItem(PENDING_ROOM_REQUEST_KEY, JSON.stringify({ operation: 'create', mapId: 'china-tour', nickname: 'owner', requestId: 'abababababababababababababababab' }));
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const emissions: unknown[][] = [];
    const session = createOnlineSession({
      storage,
      socketFactory: () => ({
        connected: true,
        on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });

    const resumeAck = emissions[0]?.at(-1) as (ack: { ok: false; code: string; message: string }) => void;
    resumeAck({ ok: false, code: 'INVALID_TOKEN', message: 'secret-token' });
    await Promise.resolve();
    await Promise.resolve();

    expect(storage.getItem(ACTIVE_ONLINE_SESSION_KEY)).toBeNull();
    expect(storage.getItem(PENDING_ROOM_REQUEST_KEY)).toBeNull();
    expect(session.connectionStatus.value).toBe('failed');
    expect(session.lastError.value).not.toContain('secret-token');

    listeners.get('room:closed')?.({ reason: 'game_over' });
    expect(session.lastError.value).toBe('本局游戏已结束');
    listeners.get('room:closed')?.({ reason: 'unrecognized-secret-reason' });
    expect(session.lastError.value).toBe('房间已关闭');
  });

  it('keeps the first pending request when duplicate create is still in flight', async () => {
    const storage = new MemoryStorage();
    const emissions: unknown[][] = [];
    const session = createOnlineSession({
      storage,
      crypto: { getRandomValues: (bytes) => bytes.fill(emissions.length ? 0xcd : 0xab) },
      socketFactory: () => ({
        connected: true,
        on() { return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });

    void session.create('owner', 'china-tour');
    await session.create('owner', 'china-tour');

    expect(emissions).toHaveLength(1);
    expect(storage.getItem(PENDING_ROOM_REQUEST_KEY)).toContain('abababababababababababababababab');
  });

  it('publishes the room even when active session storage cannot commit, keeping the pending request recoverable', async () => {
    const storage = new MemoryStorage();
    const emissions: unknown[][] = [];
    storage.setItem = (key, value) => {
      if (key === ACTIVE_ONLINE_SESSION_KEY) throw new Error('active storage unavailable');
      MemoryStorage.prototype.setItem.call(storage, key, value);
    };
    const session = createOnlineSession({
      storage,
      socketFactory: () => ({
        connected: true,
        on() { return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });

    const creating = session.create('owner', 'china-tour');
    (emissions[0]?.at(-1) as (ack: unknown) => void)({
      ok: true, playerId: 'player-1', token: 'secret-token',
      room: { roomCode: '123456', status: 'lobby', hostId: 'player-1', players: [], spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP },
    });
    await creating;

    // 持久化活跃会话同样属"尽力而为"：写失败不应把已经成功的建房结果藏起来，
    // 否则用户明明建房成功却仍停在首页。待恢复请求被保留，刷新后可 retryPending。
    expect(session.localPlayerId.value).toBe('player-1');
    expect(session.room.value).not.toBeNull();
    expect(storage.getItem(PENDING_ROOM_REQUEST_KEY)).not.toBeNull();
    expect(session.lastError.value ?? '').not.toContain('secret-token');
  });

  it('settles a preconnect command immediately when disposed', async () => {
    vi.useFakeTimers();
    const session = createOnlineSession({
      ackTimeoutMs: 8_000,
      storage: new MemoryStorage(),
      socketFactory: () => ({
        connected: false,
        on() { return this; },
        off() { return this; },
        emit() { return this; },
        disconnect() { return this; },
      }) as never,
    });

    const creating = session.create('owner', 'china-tour');
    session.dispose();
    await expect(creating).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('creates an online session when Promise.withResolvers is unavailable', () => {
    const promiseConstructor = Promise as PromiseConstructor & { withResolvers?: unknown };
    const original = promiseConstructor.withResolvers;
    delete promiseConstructor.withResolvers;
    try {
      expect(() => createOnlineSession({
        storage: new MemoryStorage(),
        socketFactory: () => ({
          connected: true,
          on() { return this; },
          off() { return this; },
          emit() { return this; },
          disconnect() { return this; },
        }) as never,
      })).not.toThrow();
    } finally {
      promiseConstructor.withResolvers = original;
    }
  });

  it('does not make an auto-resume acknowledgement stale when retried immediately', async () => {
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    const emissions: unknown[][] = [];
    const session = createOnlineSession({
      storage,
      socketFactory: () => ({
        connected: true,
        on() { return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });

    const retry = session.retryResume();
    (emissions[0]?.at(-1) as (ack: unknown) => void)({
      ok: true,
      room: { roomCode: '123456', status: 'lobby', hostId: 'player-1', players: [], spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP },
    });
    await retry;

    expect(emissions.filter(([event]) => event === 'session:resume')).toHaveLength(1);
    expect(session.connectionStatus.value).toBe('connected');
  });

  it('returns to connected after create succeeds following room closure', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const emissions: unknown[][] = [];
    const session = createOnlineSession({
      storage: new MemoryStorage(),
      socketFactory: () => ({
        connected: true,
        on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });

    listeners.get('room:closed')?.({ reason: 'game_over' });
    const creating = session.create('owner', 'china-tour');
    (emissions[0]?.at(-1) as (ack: unknown) => void)({
      ok: true, playerId: 'player-1', token: 'secret-token',
      room: { roomCode: '123456', status: 'lobby', hostId: 'player-1', players: [], spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP },
    });
    await creating;

    expect(session.connectionStatus.value).toBe('connected');
  });
  it('rejects a join while a create entry is in flight without replacing its retry request', async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    const emissions: unknown[][] = [];
    const session = createOnlineSession({
      storage,
      ackTimeoutMs: 1,
      crypto: { getRandomValues: (bytes) => bytes.fill(emissions.length ? 0xcd : 0xab) },
      socketFactory: () => ({
        connected: true,
        on() { return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });

    const creating = session.create('owner', 'china-tour');
    void session.join('123456', 'guest', 'player');
    await Promise.resolve();
    expect(emissions).toHaveLength(1);
    expect(storage.getItem(PENDING_ROOM_REQUEST_KEY)).toContain('abababababababababababababababab');
    expect(session.lastError.value).toBe('请求正在处理中');

    await vi.advanceTimersByTimeAsync(1);
    await creating;
    void session.retryPending();
    await Promise.resolve();

    expect(emissions.map(([, payload]) => payload)).toEqual([
      { nickname: 'owner', requestId: 'abababababababababababababababab', mapId: 'china-tour' },
      { nickname: 'owner', requestId: 'abababababababababababababababab', mapId: 'china-tour' },
    ]);
  });

  it('publishes early room broadcasts immediately even when credentials cannot persist, then re-publishes the retry atomically', async () => {
    const storage = new MemoryStorage();
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const emissions: unknown[][] = [];
    let rejectActiveCommit = true;
    storage.setItem = (key, value) => {
      if (key === ACTIVE_ONLINE_SESSION_KEY && rejectActiveCommit) throw new Error('active storage unavailable');
      MemoryStorage.prototype.setItem.call(storage, key, value);
    };
    const session = createOnlineSession({
      storage,
      crypto: { getRandomValues: (bytes) => bytes.fill(0xab) },
      socketFactory: () => ({
        connected: true,
        on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });
    const earlyRoom = { roomCode: '123456', status: 'playing' as const, hostId: 'player-1', players: [], spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP };
    const earlySnapshot = createPublicSnapshot();

    const first = session.create('owner', 'china-tour');
    listeners.get('room:state')?.(earlyRoom);
    listeners.get('game:snapshot')?.({ state: earlySnapshot });
    (emissions[0]?.at(-1) as (ack: unknown) => void)({
      ok: true, playerId: 'player-1', token: 'secret-token',
      room: { ...earlyRoom, status: 'lobby' },
    });
    await first;

    // 活跃会话写入失败属"尽力而为"：早到的房间广播与快照仍应立即发布，
    // 不能因为本地持久化失败就把已经到达的房间状态藏起来。待恢复请求被保留，可 retryPending。
    expect(session.localPlayerId.value).toBe('player-1');
    expect(session.room.value).not.toBeNull();
    expect(session.state.value).not.toBeNull();
    expect(storage.getItem(PENDING_ROOM_REQUEST_KEY)).not.toBeNull();

    rejectActiveCommit = false;
    const retry = session.retryPending();
    listeners.get('room:state')?.(earlyRoom);
    listeners.get('game:snapshot')?.({ state: earlySnapshot });
    (emissions[1]?.at(-1) as (ack: unknown) => void)({
      ok: true, playerId: 'player-1', token: 'secret-token',
      room: { ...earlyRoom, status: 'lobby' },
    });
    await retry;

    expect(session.localPlayerId.value).toBe('player-1');
    expect(session.room.value).toEqual(earlyRoom);
    expect(session.state.value).toMatchObject({
      mapRef: earlySnapshot.mapRef,
      phase: earlySnapshot.phase,
      board: chinaMapPack.game.board,
    });
    expect(storage.getItem(PENDING_ROOM_REQUEST_KEY)).toBeNull();
  });

  it('clears an existing presenter and every derived display value after an incompatible live snapshot', async () => {
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const emissions: unknown[][] = [];
    const session = createOnlineSession({
      storage,
      socketFactory: () => ({
        connected: true,
        on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });
    const room = {
      roomCode: '123456', status: 'playing' as const, hostId: 'player-1',
      players: [{ id: 'player-1', nickname: '玩家一', isBot: false, online: true }],
      spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP,
    };
    (emissions[0]?.at(-1) as (ack: unknown) => void)({
      ok: true,
      room,
      snapshot: createPublicSnapshot({ lastDice: [2, 5] }),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(session.state.value).not.toBeNull();
    expect(Object.keys(session.displayCash.value)).not.toHaveLength(0);

    listeners.get('game:snapshot')?.({ state: createIncompatibleSnapshot() });

    expect(session.state.value).toBeNull();
    expect(session.displayPositions.value).toEqual({});
    expect(session.displayCash.value).toEqual({});
    expect(session.dice.value).toBeNull();
    expect(session.activeCard.value).toBeNull();
    expect(session.eventMessage.value).toBe('');
    expect(session.isAnimating.value).toBe(false);
    expect(session.cashNotices.value).toEqual([]);
    expect(session.compatibilityError.value).toBe(MAP_COMPATIBILITY_ERROR);
  });

  it('keeps the compatibility error visible when a resume acknowledgement contains a bad map ref', async () => {
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    const emissions: unknown[][] = [];
    const session = createOnlineSession({
      storage,
      socketFactory: () => ({
        connected: true,
        on() { return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });
    const room = {
      roomCode: '123456', status: 'playing' as const, hostId: 'player-1', players: [],
      spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP,
    };

    (emissions[0]?.at(-1) as (ack: unknown) => void)({
      ok: true,
      room,
      snapshot: createIncompatibleSnapshot(),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(session.state.value).toBeNull();
    expect(session.compatibilityError.value).toBe(MAP_COMPATIBILITY_ERROR);
  });

  it.each(['create', 'join'] as const)(
    'keeps the compatibility error visible when a %s acknowledgement commits a buffered bad snapshot',
    async (operation) => {
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const emissions: unknown[][] = [];
      const session = createOnlineSession({
        storage: new MemoryStorage(),
        crypto: { getRandomValues: (bytes) => bytes.fill(0xab) },
        socketFactory: () => ({
          connected: true,
          on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
          off() { return this; },
          emit(...args: unknown[]) { emissions.push(args); return this; },
          disconnect() { return this; },
        }) as never,
      });
      const room = {
        roomCode: '123456', status: 'playing' as const, hostId: 'player-1', players: [],
        spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP,
      };
      const entering = operation === 'create'
        ? session.create('房主', 'china-tour')
        : session.join('123456', '玩家二', 'player');
      listeners.get('game:snapshot')?.({ state: createIncompatibleSnapshot() });
      (emissions[0]?.at(-1) as (ack: unknown) => void)({
        ok: true,
        roomCode: '123456',
        playerId: 'player-1',
        token: 'secret-token',
        room,
      });
      await entering;

      expect(session.state.value).toBeNull();
      expect(session.compatibilityError.value).toBe(MAP_COMPATIBILITY_ERROR);
    },
  );

  it('becomes connected after an initial socket connect without stored credentials', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const socket = {
      connected: false,
      on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
      off() { return this; },
      emit() { return this; },
      disconnect() { return this; },
    };
    const session = createOnlineSession({ storage: new MemoryStorage(), socketFactory: () => socket as never });

    socket.connected = true;
    listeners.get('connect')?.();

    expect(session.connectionStatus.value).toBe('connected');
  });
  it('keeps every active command locked after an active credential commit fails until the same pending retry commits', async () => {
    const storage = new MemoryStorage();
    const emissions: unknown[][] = [];
    let rejectActiveCommit = true;
    storage.setItem = (key, value) => {
      if (key === ACTIVE_ONLINE_SESSION_KEY && rejectActiveCommit) throw new Error('active storage unavailable');
      MemoryStorage.prototype.setItem.call(storage, key, value);
    };
    const session = createOnlineSession({
      storage,
      crypto: { getRandomValues: (bytes) => bytes.fill(0xab) },
      socketFactory: () => ({
        connected: true,
        on() { return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });

    const first = session.create('owner', 'china-tour');
    (emissions[0]?.at(-1) as (ack: unknown) => void)({
      ok: true, playerId: 'player-1', token: 'secret-token',
      room: { roomCode: '123456', status: 'lobby', hostId: 'player-1', players: [], spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP },
    });
    await first;

    void session.start();
    void session.addBot();
    void session.removeBot('bot-1');
    void session.sendIntent({ type: 'roll' } as never);
    void session.skipOfflineTurn();
    void session.leave();
    expect(emissions).toHaveLength(1);
    expect(session.lastError.value).toBe('会话尚未恢复，请重试');

    rejectActiveCommit = false;
    const retry = session.retryPending();
    (emissions[1]?.at(-1) as (ack: unknown) => void)({
      ok: true, playerId: 'player-1', token: 'secret-token',
      room: { roomCode: '123456', status: 'lobby', hostId: 'player-1', players: [], spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP },
    });
    await retry;

    void session.start();
    expect(emissions[2]?.[0]).toBe('room:start');
  });

  it('keeps state-changing commands locked while persisted active credentials are resuming', async () => {
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    const emissions: unknown[][] = [];
    const session = createOnlineSession({
      storage,
      socketFactory: () => ({
        connected: true,
        on() { return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });

    expect(session.connectionStatus.value).toBe('reconnecting');
    void session.start();
    void session.addBot();
    void session.removeBot('bot-1');
    void session.sendIntent({ type: 'roll' } as never);
    void session.skipOfflineTurn();
    void session.leave();
    expect(emissions).toHaveLength(1);
    expect(session.lastError.value).toBe('会话尚未恢复，请重试');

    (emissions[0]?.at(-1) as (ack: unknown) => void)({
      ok: true,
      room: { roomCode: '123456', status: 'lobby', hostId: 'player-1', players: [], spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP },
    });
    await Promise.resolve();
    await Promise.resolve();

    void session.start();
    expect(emissions[1]?.[0]).toBe('room:start');
  });

  it('clears an active room on closure even if stale pending cleanup throws after a successful commit', async () => {
    const storage = new MemoryStorage();
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const emissions: unknown[][] = [];
    storage.removeItem = (key) => {
      if (key === PENDING_ROOM_REQUEST_KEY) throw new Error('stale pending cleanup unavailable');
      MemoryStorage.prototype.removeItem.call(storage, key);
    };
    const session = createOnlineSession({
      storage,
      socketFactory: () => ({
        connected: true,
        on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });

    const creating = session.create('owner', 'china-tour');
    (emissions[0]?.at(-1) as (ack: unknown) => void)({
      ok: true, playerId: 'player-1', token: 'secret-token',
      room: { roomCode: '123456', status: 'lobby', hostId: 'player-1', players: [], spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP },
    });
    await creating;
    listeners.get('room:closed')?.({ reason: 'game_over' });

    expect(storage.getItem(ACTIVE_ONLINE_SESSION_KEY)).toBeNull();
    expect(session.localPlayerId.value).toBeNull();
    expect(session.room.value).toBeNull();
    expect(session.state.value).toBeNull();
    expect(session.lastError.value).toBe('本局游戏已结束');
  });
  it('overlays the latest room presence onto a snapshot received after an older connection update', async () => {
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    const emissions: unknown[][] = [];
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const session = createOnlineSession({
      storage,
      socketFactory: () => ({
        connected: true,
        on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });
    const room = {
      roomCode: '123456', status: 'playing' as const, hostId: 'player-1',
      players: [{ id: 'player-1', nickname: '玩家一', isBot: false, online: true }],
      spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP,
    };
    (emissions[0]?.at(-1) as (ack: unknown) => void)({ ok: true, room });
    await Promise.resolve();
    await Promise.resolve();

    listeners.get('player:connection')?.({ playerId: 'player-1', online: false });
    listeners.get('game:snapshot')?.({
      state: createPublicSnapshot({
        currentPlayerId: 'player-1',
        players: createPublicSnapshot().players.map((player) => ({
          ...player,
          online: player.id === 'player-1' ? true : player.online,
        })),
      }),
    });

    expect(session.state.value?.players.find((player) => player.id === 'player-1')?.online).toBe(false);
  });
  it('does not use a first start late progression to settle a retry after a blocked lobby command', async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const emissions: unknown[][] = [];
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    const session = createOnlineSession({
      storage,
      ackTimeoutMs: 10,
      socketFactory: () => ({
        connected: true,
        on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });
    const lobby = { roomCode: '123456', status: 'lobby' as const, hostId: 'player-1', players: [], spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP };
    (emissions[0]?.at(-1) as (ack: unknown) => void)({ ok: true, room: lobby });
    await Promise.resolve();
    await Promise.resolve();

    const firstStart = session.start();
    listeners.get('game:snapshot')?.({ state: createPublicSnapshot() });
    await vi.advanceTimersByTimeAsync(10);
    await firstStart;
    expect(session.lastError.value).toBe('请求超时，请重试');

    const secondStart = session.start();
    let secondSettled = false;
    void secondStart.then(() => { secondSettled = true; });
    await session.leave();
    expect(session.lastError.value).toBe('请求正在处理中');
    listeners.get('room:state')?.({ ...lobby, status: 'playing' });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    const secondAck = emissions.filter(([event]) => event === 'room:start').at(-1)?.at(-1) as (ack: unknown) => void;
    secondAck({ ok: true });
    await secondStart;

    expect(session.lastError.value).toBeNull();
    expect(emissions.filter(([event]) => event === 'room:start')).toHaveLength(2);
  });

  it('plays each staged entry transition in FIFO order after commit', async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const emissions: unknown[][] = [];
    const session = createOnlineSession({
      storage: new MemoryStorage(),
      crypto: { getRandomValues: (bytes) => bytes.fill(0xab) },
      socketFactory: () => ({
        connected: true,
        on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });
    const firstSnapshot = createPublicSnapshot({ turn: 1 });
    const secondSnapshot = createPublicSnapshot({ turn: 2 });
    const room = {
      roomCode: '123456', status: 'playing' as const, hostId: 'player-1',
      players: [
        { id: 'player-1', nickname: '玩家一', isBot: false, online: true },
        { id: 'player-2', nickname: '玩家二', isBot: false, online: true },
      ], spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP,
    };

    const creating = session.create('owner', 'china-tour');
    listeners.get('game:events')?.({ events: [{ type: 'dice_rolled', playerId: 'player-1', dice: [1, 2] }] });
    listeners.get('game:snapshot')?.({ state: firstSnapshot });
    listeners.get('game:events')?.({ events: [{ type: 'dice_rolled', playerId: 'player-1', dice: [3, 4] }] });
    listeners.get('game:snapshot')?.({ state: secondSnapshot });
    (emissions[0]?.at(-1) as (ack: unknown) => void)({ ok: true, playerId: 'player-1', token: 'secret-token', room });
    await creating;
    await vi.advanceTimersByTimeAsync(1_200);

    expect(session.state.value).toMatchObject({
      mapRef: secondSnapshot.mapRef,
      turn: secondSnapshot.turn,
      board: chinaMapPack.game.board,
    });
    expect(session.dice.value).toEqual([3, 4]);
    expect(session.isAnimating.value).toBe(false);
  });
  it('reconciles a dropped intent acknowledgement only after its post-emit transition pair', async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const emissions: unknown[][] = [];
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    const session = createOnlineSession({
      storage,
      ackTimeoutMs: 10,
      socketFactory: () => ({
        connected: true,
        on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });
    const snapshot = createPublicSnapshot();
    const room = {
      roomCode: '123456', status: 'playing' as const, hostId: 'player-1',
      players: [
        { id: 'player-1', nickname: '玩家一', isBot: false, online: true },
        { id: 'player-2', nickname: '玩家二', isBot: false, online: true },
      ], spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP,
    };
    (emissions[0]?.at(-1) as (ack: unknown) => void)({ ok: true, room, snapshot });
    await Promise.resolve();
    await Promise.resolve();

    const intent = session.sendIntent({ type: 'roll_dice' });
    let settled = false;
    void intent.then(() => { settled = true; });
    listeners.get('game:snapshot')?.({ state: snapshot });
    await Promise.resolve();
    expect(settled).toBe(false);
    listeners.get('game:events')?.({ events: [{ type: 'dice_rolled', playerId: 'player-1', dice: [2, 3] }] });
    listeners.get('game:snapshot')?.({ state: snapshot });
    await vi.advanceTimersByTimeAsync(10);
    await intent;

    expect(session.lastError.value).toBeNull();
    expect(emissions.filter(([event]) => event === 'game:intent')).toHaveLength(1);
  });
  it('keeps post-failure staged broadcasts until the same request commits', async () => {
    const storage = new MemoryStorage();
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const emissions: unknown[][] = [];
    let rejectActiveCommit = true;
    storage.setItem = (key, value) => {
      if (key === ACTIVE_ONLINE_SESSION_KEY && rejectActiveCommit) throw new Error('active storage unavailable');
      MemoryStorage.prototype.setItem.call(storage, key, value);
    };
    const session = createOnlineSession({
      storage,
      crypto: { getRandomValues: (bytes) => bytes.fill(0xab) },
      socketFactory: () => ({
        connected: true,
        on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });
    const playing = { roomCode: '123456', status: 'playing' as const, hostId: 'player-1', players: [], spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP };
    const latestSnapshot = createPublicSnapshot();

    const first = session.create('owner', 'china-tour');
    (emissions[0]?.at(-1) as (ack: unknown) => void)({
      ok: true, playerId: 'player-1', token: 'secret-token', room: { ...playing, status: 'lobby' },
    });
    await first;
    listeners.get('room:state')?.(playing);
    listeners.get('game:snapshot')?.({ state: latestSnapshot });

    rejectActiveCommit = false;
    const retry = session.retryPending();
    (emissions[1]?.at(-1) as (ack: unknown) => void)({
      ok: true, playerId: 'player-1', token: 'secret-token', room: playing,
    });
    await retry;

    expect(session.room.value).toEqual(playing);
    expect(session.state.value).toMatchObject({
      mapRef: latestSnapshot.mapRef,
      phase: latestSnapshot.phase,
      board: chinaMapPack.game.board,
    });
  });
  it('resets a disconnected intent reconciliation before accepting the next recovered intent', async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const emissions: unknown[][] = [];
    const socket = {
      connected: true,
      on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
      off() { return this; },
      emit(...args: unknown[]) { emissions.push(args); return this; },
      disconnect() { return this; },
    };
    const session = createOnlineSession({ storage, ackTimeoutMs: 10, socketFactory: () => socket as never });
    const room = {
      roomCode: '123456', status: 'playing' as const, hostId: 'player-1',
      players: [{ id: 'player-1', nickname: '玩家一', isBot: false, online: true }],
      spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP,
    };
    const snapshot = createPublicSnapshot({ currentPlayerId: 'player-1' });
    (emissions[0]?.at(-1) as (ack: unknown) => void)({ ok: true, room, snapshot });
    await Promise.resolve();
    await Promise.resolve();

    void session.sendIntent({ type: 'roll_dice' });
    listeners.get('game:events')?.({ events: [] });
    socket.connected = false;
    listeners.get('disconnect')?.();
    socket.connected = true;
    listeners.get('connect')?.();
    (emissions[2]?.at(-1) as (ack: unknown) => void)({ ok: true, room, snapshot });
    await Promise.resolve();
    await Promise.resolve();

    const nextIntent = session.sendIntent({ type: 'roll_dice' });
    expect(emissions.filter(([event]) => event === 'game:intent')).toHaveLength(2);
    listeners.get('game:events')?.({ events: [] });
    listeners.get('game:snapshot')?.({ state: snapshot });
    await vi.advanceTimersByTimeAsync(10);
    await nextIntent;
    expect(session.lastError.value).toBeNull();
  });
  it('announces local takeover from authoritative room state and clears only that status', async () => {
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const emissions: unknown[][] = [];
    const session = createOnlineSession({
      storage,
      socketFactory: () => ({
        connected: true,
        on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });
    const room = {
      roomCode: '123456', status: 'playing' as const, hostId: 'host',
      players: [{ id: 'player-1', nickname: '玩家一', isBot: false, online: true }],
      spectators: [], takeoverPlayerId: 'player-1', map: CHINA_ROOM_MAP,
    };
    (emissions[0]?.at(-1) as (ack: unknown) => void)({ ok: true, room });
    await Promise.resolve();
    await Promise.resolve();

    expect(session.availableActions.value).toEqual([]);
    expect(session.lastError.value).toBe('房主托管正在执行');
    listeners.get('room:state')?.({ ...room, spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP });
    expect(session.lastError.value).toBeNull();
  });
  it('abandon clears the in-game session locally when the socket is dead', async () => {
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const emissions: unknown[][] = [];
    const session = createOnlineSession({
      storage,
      socketFactory: () => ({
        connected: true,
        on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });
    const room = {
      roomCode: '123456', status: 'playing' as const, hostId: 'player-1',
      players: [{ id: 'player-1', nickname: '玩家一', isBot: false, online: true }],
      spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP,
    };
    (emissions[0]?.at(-1) as (ack: unknown) => void)({ ok: true, room });
    await Promise.resolve();
    await Promise.resolve();
    listeners.get('game:snapshot')?.({ state: createPublicSnapshot() });
    expect(session.room.value).not.toBeNull();
    expect(session.state.value).not.toBeNull();

    // The connection dies — a server room:leave could never be acknowledged.
    listeners.get('connect_error')?.();
    expect(session.connectionStatus.value).toBe('failed');

    session.abandon();

    expect(session.room.value).toBeNull();
    expect(session.state.value).toBeNull();
    expect(storage.getItem(ACTIVE_ONLINE_SESSION_KEY)).toBeNull();
  });

  it('abandon keeps the session and reports STORAGE_UNAVAILABLE when the record cannot be removed', async () => {
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    storage.setItem(PENDING_ROOM_REQUEST_KEY, JSON.stringify({
      operation: 'create', mapId: 'china-tour', nickname: 'stale', requestId: '0123456789abcdef0123456789abcdef',
    }));
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const emissions: unknown[][] = [];
    const session = createOnlineSession({
      storage,
      socketFactory: () => ({
        connected: true,
        on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });
    const room = {
      roomCode: '123456', status: 'playing' as const, hostId: 'player-1',
      players: [{ id: 'player-1', nickname: '玩家一', isBot: false, online: true }],
      spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP,
    };
    (emissions[0]?.at(-1) as (ack: unknown) => void)({ ok: true, room });
    await Promise.resolve();
    await Promise.resolve();
    listeners.get('game:snapshot')?.({ state: createPublicSnapshot() });
    expect(session.room.value).not.toBeNull();
    expect(session.state.value).not.toBeNull();

    // Pending cleanup must happen first: a failure there cannot sacrifice the active credential.
    vi.spyOn(storage, 'removeItem').mockImplementation((key: string) => {
      if (key === PENDING_ROOM_REQUEST_KEY) throw new Error('storage locked');
      MemoryStorage.prototype.removeItem.call(storage, key);
    });
    listeners.get('connect_error')?.();

    const cleared = session.abandon();

    // Storage-first: a rejected removal leaves the in-memory room/state, the stored record,
    // and the local player intact, and surfaces a safe storage error rather than pretending.
    expect(cleared).toBe(false);
    expect(session.room.value).not.toBeNull();
    expect(session.state.value).not.toBeNull();
    expect(session.localPlayerId.value).toBe('player-1');
    expect(storage.getItem(ACTIVE_ONLINE_SESSION_KEY)).not.toBeNull();
    expect(storage.getItem(PENDING_ROOM_REQUEST_KEY)).not.toBeNull();
    expect(session.lastError.value).toBe('无法更新本地存档，请稍后重试');

    // Once storage recovers, abandon commits and tears the session down.
    vi.restoreAllMocks();
    expect(session.abandon()).toBe(true);
    expect(session.room.value).toBeNull();
    expect(session.state.value).toBeNull();
    expect(storage.getItem(ACTIVE_ONLINE_SESSION_KEY)).toBeNull();
  });

  it('fails the connection with a safe message on an initial connect_error and stays retryable', () => {
    const listeners = new Map<string, (...args: never[]) => void>();
    const emissions: unknown[][] = [];
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    const socket = {
      connected: false,
      on(event: string, listener: (...args: never[]) => void) { listeners.set(event, listener); return this; },
      off(event: string) { listeners.delete(event); return this; },
      emit(...args: unknown[]) { emissions.push(args); return this; },
      disconnect() { return this; },
    };
    const session = createOnlineSession({ storage, socketFactory: () => socket as never });

    (listeners.get('connect_error') as ((error: unknown) => void) | undefined)?.(new Error('xhr poll error'));

    expect(session.connectionStatus.value).toBe('failed');
    expect(session.lastError.value).not.toBeNull();
    expect(session.lastError.value).not.toContain('secret-token');

    socket.connected = true;
    listeners.get('connect')?.();
    // A later successful connect drives recovery of the stored session rather than staying failed.
    expect(session.connectionStatus.value).toBe('reconnecting');
    expect(emissions.filter(([event]) => event === 'session:resume')).toHaveLength(1);
  });

  it('recovers to connected after a connect_error when there is no stored session', () => {
    const listeners = new Map<string, (...args: never[]) => void>();
    const socket = {
      connected: false,
      on(event: string, listener: (...args: never[]) => void) { listeners.set(event, listener); return this; },
      off(event: string) { listeners.delete(event); return this; },
      emit() { return this; },
      disconnect() { return this; },
    };
    const session = createOnlineSession({ storage: new MemoryStorage(), socketFactory: () => socket as never });

    (listeners.get('connect_error') as ((error: unknown) => void) | undefined)?.(new Error('boom'));
    expect(session.connectionStatus.value).toBe('failed');
    expect(session.lastError.value).not.toBeNull();

    socket.connected = true;
    listeners.get('connect')?.();
    expect(session.connectionStatus.value).toBe('connected');
    expect(session.lastError.value).toBeNull();
  });

  it('removes the connect_error listener on dispose', () => {
    const listeners = new Map<string, (...args: never[]) => void>();
    const socket = {
      connected: false,
      on(event: string, listener: (...args: never[]) => void) { listeners.set(event, listener); return this; },
      off(event: string) { listeners.delete(event); return this; },
      emit() { return this; },
      disconnect() { return this; },
    };
    const session = createOnlineSession({ storage: new MemoryStorage(), socketFactory: () => socket as never });

    expect(listeners.has('connect_error')).toBe(true);
    session.dispose();
    expect(listeners.has('connect_error')).toBe(false);
  });

  it('classifies a definitive entry rejection and keeps the request staged for an explicit abandon', async () => {
    const storage = new MemoryStorage();
    const emissions: unknown[][] = [];
    const session = createOnlineSession({
      storage,
      socketFactory: () => ({
        connected: true,
        on() { return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });

    const creating = session.create('owner', 'china-tour');
    (emissions[0]?.at(-1) as (ack: unknown) => void)({ ok: false, code: 'ROOM_FULL', message: 'Room is full.' });
    await creating;

    expect(session.entryFailure.value).toBe('definitive');
    expect(storage.getItem(PENDING_ROOM_REQUEST_KEY)).not.toBeNull();
    // 拒绝原因要落到界面上：只说「上次操作未完成」，玩家无从判断该换昵称还是该放弃。
    expect(session.lastError.value).toBe('房间人数已满');
  });

  it('surfaces the rate-limit reason and keeps the entry retryable when create is throttled', async () => {
    const storage = new MemoryStorage();
    const emissions: unknown[][] = [];
    const session = createOnlineSession({
      storage,
      socketFactory: () => ({
        connected: true,
        on() { return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });

    const creating = session.create('owner', 'china-tour');
    (emissions[0]?.at(-1) as (ack: unknown) => void)({
      ok: false,
      code: 'CREATE_RATE_LIMITED',
      message: '创建房间过于频繁，请稍后再试。',
    });
    await creating;

    // 限流是「等一会儿再来」，绝不能归到 definitive（那会引导玩家放弃并重开，永远撞墙）。
    expect(session.entryFailure.value).toBe('transient');
    expect(session.lastError.value).toBe('创建房间过于频繁，请稍后再试');
    expect(storage.getItem(PENDING_ROOM_REQUEST_KEY)).not.toBeNull();
  });

  it('classifies a transient entry timeout as retryable', async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    const emissions: unknown[][] = [];
    const session = createOnlineSession({
      storage,
      ackTimeoutMs: 1,
      socketFactory: () => ({
        connected: true,
        on() { return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });

    const creating = session.create('owner', 'china-tour');
    await vi.advanceTimersByTimeAsync(1);
    await creating;

    expect(session.entryFailure.value).toBe('transient');
    expect(storage.getItem(PENDING_ROOM_REQUEST_KEY)).not.toBeNull();
  });

  it('aborts a staged entry only after the pending request is removed from storage', async () => {
    const storage = new MemoryStorage();
    const emissions: unknown[][] = [];
    const session = createOnlineSession({
      storage,
      socketFactory: () => ({
        connected: true,
        on() { return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });

    const creating = session.create('owner', 'china-tour');
    (emissions[0]?.at(-1) as (ack: unknown) => void)({ ok: false, code: 'ROOM_FULL', message: 'Room is full.' });
    await creating;
    expect(storage.getItem(PENDING_ROOM_REQUEST_KEY)).not.toBeNull();

    expect(session.abortEntry()).toBe(true);
    expect(storage.getItem(PENDING_ROOM_REQUEST_KEY)).toBeNull();
    expect(session.entryFailure.value).toBeNull();

    const emittedBeforeRetry = emissions.length;
    await session.retryPending();
    expect(emissions).toHaveLength(emittedBeforeRetry);
  });

  it('keeps the staged entry retryable and reports a safe error when storage refuses to drop the pending request', async () => {
    class FailingPendingRemoveStorage extends MemoryStorage {
      override removeItem(key: string) {
        if (key === PENDING_ROOM_REQUEST_KEY) throw new Error('storage locked');
        super.removeItem(key);
      }
    }
    const storage = new FailingPendingRemoveStorage();
    const emissions: unknown[][] = [];
    const session = createOnlineSession({
      storage,
      socketFactory: () => ({
        connected: true,
        on() { return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });

    const creating = session.create('owner', 'china-tour');
    (emissions[0]?.at(-1) as (ack: unknown) => void)({ ok: false, code: 'ROOM_FULL', message: 'Room is full.' });
    await creating;

    expect(session.abortEntry()).toBe(false);
    // Do not pretend the record was cleared.
    expect(storage.getItem(PENDING_ROOM_REQUEST_KEY)).not.toBeNull();
    expect(session.lastError.value).not.toBeNull();

    // The retry path survives so the user is never deadlocked: it re-emits the same request.
    const emittedBeforeRetry = emissions.length;
    const retrying = session.retryPending();
    await Promise.resolve();
    expect(emissions).toHaveLength(emittedBeforeRetry + 1);
    (emissions.at(-1)?.at(-1) as (ack: unknown) => void)({ ok: false, code: 'REQUEST_TIMEOUT', message: '' });
    await retrying;
  });
});

describe('online session transient gameplay feedback', () => {
  const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };
  const expected = {
    OPERATION_IN_PROGRESS: '操作过快，请稍候重试',
    INSUFFICIENT_FUNDS: '现金不足',
    WRONG_PHASE: '当前阶段不能执行这个操作',
    NOT_YOUR_TURN: '还没轮到你行动',
    ILLEGAL_INTENT: '这个操作现在不可用',
  } as const;

  async function connectGameplay() {
    const emissions: unknown[][] = [];
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    const socket = {
      connected: true,
      on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
      off(event: string) { listeners.delete(event); return this; },
      emit(...args: unknown[]) { emissions.push(args); return this; },
      disconnect() { return this; },
    };
    const session = createOnlineSession({ storage, socketFactory: () => socket as never });
    const room = {
      roomCode: '123456', status: 'playing' as const, hostId: 'player-1',
      players: [{ id: 'player-1', nickname: '玩家一', isBot: false, online: true }],
      spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP,
    };
    const snapshot = createPublicSnapshot({ currentPlayerId: 'player-1' });
    (emissions[0]?.at(-1) as (ack: unknown) => void)({ ok: true, room, snapshot });
    await flush();
    const intent = () => session.sendIntent({ type: 'roll_dice' });
    const intentAck = () => emissions.filter(([event]) => event === 'game:intent').at(-1)?.at(-1) as (ack: unknown) => void;
    return { session, emissions, listeners, intent, intentAck, room };
  }

  it.each(Object.entries(expected))('maps intent rejection %s to the exact transient notice', async (code, message) => {
    const { session, intent, intentAck } = await connectGameplay();

    const request = intent();
    intentAck()({ ok: false, code, message: '' });
    await request;

    expect(session.transientNotice.value).toMatchObject({ message });
    expect(session.lastError.value).toBeNull();
  });

  it('clears persistent feedback when a mapped intent rejection is published', async () => {
    vi.useFakeTimers();
    const { session, intent, intentAck } = await connectGameplay();
    const timedOut = intent();
    intentAck()({ ok: false, code: 'REQUEST_TIMEOUT', message: '' });
    await timedOut;
    expect(session.lastError.value).not.toBeNull();

    const rejected = intent();
    intentAck()({ ok: false, code: 'INSUFFICIENT_FUNDS', message: '' });
    await rejected;

    expect(session.lastError.value).toBeNull();
    expect(session.transientNotice.value).toMatchObject({ message: expected.INSUFFICIENT_FUNDS });
    session.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a late mapped intent acknowledgement after the room closes', async () => {
    vi.useFakeTimers();
    const { session, listeners, intent, intentAck } = await connectGameplay();
    const request = intent();
    const lateAck = intentAck();
    listeners.get('room:closed')?.({ reason: 'game_over' });
    lateAck({ ok: false, code: 'INSUFFICIENT_FUNDS', message: '' });
    await request;

    expect(session.transientNotice.value).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires a transient gameplay rejection after 2,500 ms', async () => {
    vi.useFakeTimers();
    const { session, intent, intentAck } = await connectGameplay();
    const request = intent();
    intentAck()({ ok: false, code: 'INSUFFICIENT_FUNDS', message: '' });
    await request;

    await vi.advanceTimersByTimeAsync(2_499);
    expect(session.transientNotice.value).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(session.transientNotice.value).toBeNull();
  });

  it('replaces an identical transient rejection with a new id and restarted expiry', async () => {
    vi.useFakeTimers();
    const { session, intent, intentAck } = await connectGameplay();
    const first = intent();
    intentAck()({ ok: false, code: 'WRONG_PHASE', message: '' });
    await first;
    const firstId = session.transientNotice.value?.id;
    await vi.advanceTimersByTimeAsync(2_000);

    const second = intent();
    intentAck()({ ok: false, code: 'WRONG_PHASE', message: '' });
    await second;
    expect(session.transientNotice.value?.id).not.toBe(firstId);
    await vi.advanceTimersByTimeAsync(2_499);
    expect(session.transientNotice.value).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(session.transientNotice.value).toBeNull();
  });

  it('clears only the transient notice present when a successful intent began', async () => {
    const { session, intent, intentAck } = await connectGameplay();
    const rejected = intent();
    intentAck()({ ok: false, code: 'ILLEGAL_INTENT', message: '' });
    await rejected;

    const successful = intent();
    intentAck()({ ok: true });
    await successful;
    expect(session.transientNotice.value).toBeNull();
  });

  it('does not let an older successful intent clear a newer duplicate rejection', async () => {
    const { session, intent, intentAck } = await connectGameplay();
    const older = intent();
    const duplicate = intent();
    await duplicate;
    const duplicateNotice = session.transientNotice.value;
    expect(duplicateNotice).toMatchObject({ message: expected.OPERATION_IN_PROGRESS });

    intentAck()({ ok: true });
    await older;
    expect(session.transientNotice.value).toEqual(duplicateNotice);
  });

  it('keeps takeover and absent-debtor messages persistent', async () => {
    const { session, listeners, room } = await connectGameplay();
    listeners.get('room:state')?.({ ...room, spectators: [], takeoverPlayerId: 'player-1', map: CHINA_ROOM_MAP });
    await session.sendIntent({ type: 'roll_dice' });
    expect(session.lastError.value).toBe('房主托管正在执行');
    expect(session.transientNotice.value).toBeNull();
  });

  it('retains a specific room-closed reason after clearing session state', async () => {
    const { session, listeners } = await connectGameplay();
    listeners.get('room:closed')?.({ reason: 'game_over' });
    expect(session.state.value).toBeNull();
    expect(session.room.value).toBeNull();
    expect(session.lastError.value).toBe('本局游戏已结束');
  });

  it('keeps a failed-resume reason after reset clears the recovered state', async () => {
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    const emissions: unknown[][] = [];
    const session = createOnlineSession({
      storage,
      socketFactory: () => ({
        connected: true,
        on() { return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });

    (emissions[0]?.at(-1) as (ack: unknown) => void)({ ok: false, code: 'INVALID_TOKEN', message: '' });
    await flush();
    expect(session.state.value).toBeNull();
    expect(session.room.value).toBeNull();
    expect(session.lastError.value).toBe('会话已失效，请重新加入房间');
    expect(session.connectionStatus.value).toBe('failed');
  });

  it('clears the transient timer when reset or dispose ends the session', async () => {
    vi.useFakeTimers();
    const { session, listeners, intent, intentAck } = await connectGameplay();
    const rejected = intent();
    intentAck()({ ok: false, code: 'NOT_YOUR_TURN', message: '' });
    await rejected;
    expect(vi.getTimerCount()).toBe(1);

    listeners.get('room:closed')?.({ reason: 'game_over' });
    expect(session.transientNotice.value).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    session.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('online session lobby controls', () => {
  interface LobbyPlayer { id: string; nickname: string; isBot: boolean; online: boolean }
  interface LobbyRoom {
    roomCode: string;
    status: string;
    hostId: string;
    players: LobbyPlayer[];
    spectators: { id: string; nickname: string; online: boolean }[];
    takeoverPlayerId: string | null;
    map: typeof CHINA_ROOM_MAP;
  }
  interface LobbyHarness {
    session: OnlineGameSession;
    emissions: unknown[][];
    listeners: Map<string, (...args: unknown[]) => void>;
    socket: { connected: boolean };
  }

  const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

  function buildRoom(overrides: Partial<LobbyRoom> = {}): LobbyRoom {
    return {
      roomCode: '000007',
      status: 'lobby',
      hostId: 'player-1',
      players: [{ id: 'player-1', nickname: '房主', isBot: false, online: true }],
      spectators: [], takeoverPlayerId: null, map: CHINA_ROOM_MAP,
      ...overrides,
    };
  }

  async function connectLobby(options: { localPlayerId?: string; room?: LobbyRoom; ackTimeoutMs?: number } = {}): Promise<LobbyHarness> {
    const localPlayerId = options.localPlayerId ?? 'player-1';
    const room = options.room ?? buildRoom();
    const emissions: unknown[][] = [];
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '000007', playerId: localPlayerId, token: 'tkn' }));
    const socket = {
      connected: true,
      on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
      off(event: string) { listeners.delete(event); return this; },
      emit(...args: unknown[]) { emissions.push(args); return this; },
      disconnect() { return this; },
    };
    const session = createOnlineSession({ storage, ackTimeoutMs: options.ackTimeoutMs, socketFactory: () => socket as never });
    const resumeEmit = emissions.find((emission) => emission[0] === 'session:resume');
    (resumeEmit?.at(-1) as (ack: unknown) => void)({ ok: true, room });
    await flush();
    return { session, emissions, listeners, socket };
  }

  const twoHumans: LobbyPlayer[] = [
    { id: 'player-1', nickname: '房主', isBot: false, online: true },
    { id: 'player-2', nickname: '客人', isBot: false, online: true },
  ];

  it('exposes host identity and start readiness derived from the authoritative room', async () => {
    const alone = await connectLobby();
    expect(alone.session.isHost.value).toBe(true);
    expect(alone.session.startBlockedReason.value).toBe('至少需要 2 位玩家');

    const ready = await connectLobby({ room: buildRoom({ players: twoHumans }) });
    expect(ready.session.isHost.value).toBe(true);
    expect(ready.session.startBlockedReason.value).toBeNull();
  });

  it('blocks a non-host guest from starting with a host-only reason', async () => {
    const guest = await connectLobby({ localPlayerId: 'player-2', room: buildRoom({ players: twoHumans }) });
    expect(guest.session.isHost.value).toBe(false);
    expect(guest.session.startBlockedReason.value).toBe('只有房主可以开始游戏');
  });

  it('blocks start while reconnecting even with enough players', async () => {
    const { session, listeners } = await connectLobby({ room: buildRoom({ players: twoHumans }) });
    expect(session.startBlockedReason.value).toBeNull();
    listeners.get('disconnect')?.();
    expect(session.connectionStatus.value).toBe('reconnecting');
    expect(session.startBlockedReason.value).toBe('正在与房间同步，请稍候');
  });

  it('single-flights lobby commands: a pending start blocks and reasons out add-bot', async () => {
    const { session, emissions } = await connectLobby({ room: buildRoom({ players: twoHumans }) });
    void session.start();
    await flush();
    expect(session.pendingCommand.value).toBe('start');
    expect(session.startBlockedReason.value).toBe('正在处理上一步操作');
    const startCount = emissions.filter((emission) => emission[0] === 'room:start').length;
    void session.addBot();
    await flush();
    expect(emissions.some((emission) => emission[0] === 'room:add_bot')).toBe(false);
    expect(emissions.filter((emission) => emission[0] === 'room:start')).toHaveLength(startCount);
    expect(session.lastError.value).toBe('请求正在处理中');
  });

  it('never mutates players locally on add-bot: only the server room:state broadcast changes the roster', async () => {
    const { session, emissions, listeners } = await connectLobby({ room: buildRoom({ players: twoHumans }) });
    void session.addBot();
    await flush();
    const addBotEmit = emissions.find((emission) => emission[0] === 'room:add_bot');
    (addBotEmit?.at(-1) as (ack: unknown) => void)({ ok: true });
    await flush();
    expect(session.room.value?.players).toHaveLength(2);
    expect(session.pendingCommand.value).toBeNull();

    listeners.get('room:state')?.(buildRoom({
      players: [...twoHumans, { id: 'player-3', nickname: '电脑 A', isBot: true, online: true }],
    }));
    expect(session.room.value?.players).toHaveLength(3);
  });

  it('treats the server room:state as final authority for start: no optimistic playing flip', async () => {
    const { session, emissions, listeners } = await connectLobby({ room: buildRoom({ players: twoHumans }) });
    void session.start();
    await flush();
    const startEmit = emissions.find((emission) => emission[0] === 'room:start');
    (startEmit?.at(-1) as (ack: unknown) => void)({ ok: true });
    await flush();
    expect(session.room.value?.status).toBe('lobby');

    listeners.get('room:state')?.(buildRoom({ status: 'playing', players: twoHumans }));
    expect(session.room.value?.status).toBe('playing');
  });

  const botPlayer = (id: string, nickname: string): LobbyPlayer => ({ id, nickname, isBot: true, online: true });

  it('reconciles a lost add-bot ack when a newer room:state introduces the expected bot', async () => {
    vi.useFakeTimers();
    const { session, emissions, listeners } = await connectLobby({ room: buildRoom({ players: twoHumans }), ackTimeoutMs: 10 });
    const adding = session.addBot();
    await flush();
    const addAck = emissions.find((emission) => emission[0] === 'room:add_bot')?.at(-1) as (ack: unknown) => void;
    // The ack was lost in transit; only the authoritative broadcast carries the new bot.
    listeners.get('room:state')?.(buildRoom({ players: [...twoHumans, botPlayer('bot-1', '电脑 A')] }));
    await adding;
    expect(session.pendingCommand.value).toBeNull();
    expect(session.lastError.value).toBeNull();
    // The abandoned timeout and a late server ack are both no-ops after reconciliation.
    await vi.advanceTimersByTimeAsync(20);
    addAck({ ok: true });
    await flush();
    expect(session.pendingCommand.value).toBeNull();
    expect(session.lastError.value).toBeNull();
  });

  it('reconciles a lost remove-bot ack only when the targeted bot leaves the roster', async () => {
    vi.useFakeTimers();
    const seeded = buildRoom({ players: [...twoHumans, botPlayer('bot-1', '电脑 A')] });
    const { session, listeners } = await connectLobby({ room: seeded, ackTimeoutMs: 10 });
    const removing = session.removeBot('bot-1');
    await flush();
    listeners.get('room:state')?.(buildRoom({ players: twoHumans }));
    await removing;
    expect(session.pendingCommand.value).toBeNull();
    expect(session.lastError.value).toBeNull();
    await vi.advanceTimersByTimeAsync(20);
    expect(session.lastError.value).toBeNull();
  });

  it('ignores an unrelated room:state that adds no bot while add-bot is pending', async () => {
    vi.useFakeTimers();
    const { session, listeners } = await connectLobby({ room: buildRoom({ players: twoHumans }), ackTimeoutMs: 10 });
    const adding = session.addBot();
    await flush();
    // A human toggles offline — no new bot, so the pending command must not settle.
    listeners.get('room:state')?.(buildRoom({ players: [twoHumans[0], { ...twoHumans[1], online: false }] }));
    await vi.advanceTimersByTimeAsync(10);
    await adding;
    expect(session.lastError.value).toBe('请求超时，请重试');
  });

  it('does not settle a pending add-bot when a human joins: only a new bot counts', async () => {
    vi.useFakeTimers();
    const { session, listeners } = await connectLobby({ room: buildRoom({ players: twoHumans }), ackTimeoutMs: 10 });
    const adding = session.addBot();
    await flush();
    // A real human joins (roster grows), but no bot appeared — the add-bot must still time out.
    listeners.get('room:state')?.(buildRoom({
      players: [...twoHumans, { id: 'player-3', nickname: '第三人', isBot: false, online: true }],
    }));
    await vi.advanceTimersByTimeAsync(10);
    await adding;
    expect(session.lastError.value).toBe('请求超时，请重试');
  });


  it('never mutates bot nicknames locally on rename-bot: only the server room:state broadcast changes the roster', async () => {
    const seeded = buildRoom({ players: [...twoHumans, botPlayer('bot-1', '电脑 A')] });
    const { session, emissions, listeners } = await connectLobby({ room: seeded });
    void session.renameBot('bot-1', '电脑甲');
    await flush();
    const renameEmit = emissions.find((emission) => emission[0] === 'room:rename_bot');
    (renameEmit?.at(-1) as (ack: unknown) => void)({ ok: true });
    await flush();
    expect(session.room.value?.players.find((player) => player.id === 'bot-1')?.nickname).toBe('电脑 A');
    expect(session.pendingCommand.value).toBeNull();

    listeners.get('room:state')?.(buildRoom({
      players: [...twoHumans, botPlayer('bot-1', '电脑甲')],
    }));
    expect(session.room.value?.players.find((player) => player.id === 'bot-1')?.nickname).toBe('电脑甲');
  });

  it.each([
    ['INVALID_NICKNAME', '昵称需为 1 至 20 个字符'],
    ['NICKNAME_TAKEN', '昵称已被使用，请换一个'],
    ['NOT_HOST', '只有房主可以执行此操作'],
    ['GAME_ALREADY_STARTED', '游戏已开始，无法加入（仅可切换为观战）'],
    ['INVALID_ROOM_ACTION', '当前房间状态无法执行此操作'],
  ])('shows a specific message when rename-bot returns %s', async (code, expectedMessage) => {
    const seeded = buildRoom({ players: [...twoHumans, botPlayer('bot-1', '电脑 A')] });
    const { session, emissions } = await connectLobby({ room: seeded });
    const renaming = session.renameBot('bot-1', '电脑甲');
    await flush();
    const renameEmit = emissions.find((emission) => emission[0] === 'room:rename_bot');
    (renameEmit?.at(-1) as (ack: unknown) => void)({ ok: false, code, message: 'safe server detail' });
    await renaming;

    expect(session.lastError.value).toBe(expectedMessage);
  });

  it('reconciles a lost rename-bot ack when the targeted bot nickname changes in room:state', async () => {
    vi.useFakeTimers();
    const seeded = buildRoom({ players: [...twoHumans, botPlayer('bot-1', '电脑 A')] });
    const { session, listeners } = await connectLobby({ room: seeded, ackTimeoutMs: 10 });
    const renaming = session.renameBot('bot-1', '电脑甲');
    await flush();
    listeners.get('room:state')?.(buildRoom({ players: [...twoHumans, botPlayer('bot-1', '电脑甲')] }));
    await renaming;
    expect(session.pendingCommand.value).toBeNull();
    expect(session.lastError.value).toBeNull();
    await vi.advanceTimersByTimeAsync(20);
    expect(session.lastError.value).toBeNull();
  });

  it('ignores an unrelated room:state while rename-bot is pending', async () => {
    vi.useFakeTimers();
    const seeded = buildRoom({ players: [...twoHumans, botPlayer('bot-1', '电脑 A')] });
    const { session, listeners } = await connectLobby({ room: seeded, ackTimeoutMs: 10 });
    const renaming = session.renameBot('bot-1', '电脑甲');
    await flush();
    listeners.get('room:state')?.(buildRoom({ players: [twoHumans[0], { ...twoHumans[1], online: false }, botPlayer('bot-1', '电脑 A')] }));
    await vi.advanceTimersByTimeAsync(10);
    await renaming;
    expect(session.lastError.value).toBe('请求超时，请重试');
  });

  it('does not reconcile rename-bot when room:state shows a different nickname than requested', async () => {
    vi.useFakeTimers();
    const seeded = buildRoom({ players: [...twoHumans, botPlayer('bot-1', '电脑 A')] });
    const { session, listeners } = await connectLobby({ room: seeded, ackTimeoutMs: 10 });
    const renaming = session.renameBot('bot-1', '  电脑甲  ');
    await flush();
    listeners.get('room:state')?.(buildRoom({ players: [...twoHumans, botPlayer('bot-1', '别的名字')] }));
    await vi.advanceTimersByTimeAsync(10);
    await renaming;
    expect(session.lastError.value).toBe('请求超时，请重试');
    expect(session.room.value?.players.find((player) => player.id === 'bot-1')?.nickname).toBe('别的名字');
  });

  it('single-flights rename-bot with other lobby commands', async () => {
    const seeded = buildRoom({ players: [...twoHumans, botPlayer('bot-1', '电脑 A')] });
    const { session, emissions } = await connectLobby({ room: seeded });
    void session.renameBot('bot-1', '电脑甲');
    await flush();
    expect(session.pendingCommand.value).toBe('renameBot');
    const renameCount = emissions.filter((emission) => emission[0] === 'room:rename_bot').length;
    void session.removeBot('bot-1');
    await flush();
    expect(emissions.filter((emission) => emission[0] === 'room:rename_bot')).toHaveLength(renameCount);
    expect(session.lastError.value).toBe('请求正在处理中');
  });

  it('ignores a room:state that still contains the targeted bot while remove-bot is pending', async () => {
    vi.useFakeTimers();
    const seeded = buildRoom({ players: [...twoHumans, botPlayer('bot-1', '电脑 A')] });
    const { session, listeners } = await connectLobby({ room: seeded, ackTimeoutMs: 10 });
    const removing = session.removeBot('bot-1');
    await flush();
    // A different bot is added; the target is still present, so no reconciliation.
    listeners.get('room:state')?.(buildRoom({ players: [...seeded.players, botPlayer('bot-2', '电脑 B')] }));
    await vi.advanceTimersByTimeAsync(10);
    await removing;
    expect(session.lastError.value).toBe('请求超时，请重试');
  });

  it('gates lobby command readiness on live connection authority, not just pending', async () => {
    const { session, socket, listeners, emissions } = await connectLobby({ room: buildRoom({ players: twoHumans }) });
    expect(session.isLobbyCommandReady.value).toBe(true);

    socket.connected = false;
    listeners.get('disconnect')?.();
    expect(session.connectionStatus.value).toBe('reconnecting');
    expect(session.isLobbyCommandReady.value).toBe(false);

    socket.connected = true;
    listeners.get('connect')?.();
    await flush();
    const resumeAck = emissions.filter((emission) => emission[0] === 'session:resume').at(-1)?.at(-1) as (ack: unknown) => void;
    resumeAck({ ok: true, room: buildRoom({ players: twoHumans }) });
    await flush();
    expect(session.connectionStatus.value).toBe('connected');
    expect(session.isLobbyCommandReady.value).toBe(true);
  });

  it('single-flights leave against a pending command with no duplicate emit', async () => {
    const { session, emissions } = await connectLobby({ room: buildRoom({ players: twoHumans }) });
    const starting = session.start();
    await flush();
    expect(session.pendingCommand.value).toBe('start');
    const leavesBefore = emissions.filter((emission) => emission[0] === 'room:leave').length;
    void session.leave();
    await flush();
    expect(emissions.filter((emission) => emission[0] === 'room:leave')).toHaveLength(leavesBefore);
    expect(session.lastError.value).toBe('请求正在处理中');

    const startAck = emissions.find((emission) => emission[0] === 'room:start')?.at(-1) as (ack: unknown) => void;
    startAck({ ok: true });
    await starting;

    expect(session.lastError.value).toBeNull();
  });

  it('clears a blocked-command notice when the pending leave succeeds and resets the session', async () => {
    const { session, emissions } = await connectLobby({ room: buildRoom({ players: twoHumans }) });
    const leaving = session.leave();
    await flush();
    expect(session.pendingCommand.value).toBe('leave');

    void session.addBot();
    await flush();
    expect(session.lastError.value).toBe('请求正在处理中');

    const leaveAck = emissions.find((emission) => emission[0] === 'room:leave')?.at(-1) as (ack: unknown) => void;
    leaveAck({ ok: true });
    await leaving;

    expect(session.room.value).toBeNull();
    expect(session.pendingCommand.value).toBeNull();
    expect(session.lastError.value).toBeNull();
  });

  it('replaces a blocked-command notice when the pending command times out', async () => {
    vi.useFakeTimers();
    const { session } = await connectLobby({ room: buildRoom({ players: twoHumans }), ackTimeoutMs: 10 });
    const starting = session.start();
    await flush();

    void session.leave();
    await flush();
    expect(session.lastError.value).toBe('请求正在处理中');

    await vi.advanceTimersByTimeAsync(10);
    await starting;

    expect(session.lastError.value).toBe('请求超时，请重试');
  });
});

describe('online session stale error lifecycle', () => {
  const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };
  const humanPlayers = [
    { id: 'player-1', nickname: '玩家一', isBot: false, online: true },
    { id: 'player-2', nickname: '玩家二', isBot: false, online: true },
  ];
  const bot = { id: 'bot-1', nickname: '电脑 A', isBot: true, online: true };

  function room(overrides: Record<string, unknown> = {}) {
    return {
      roomCode: '123456',
      status: 'playing' as const,
      hostId: 'player-1',
      players: humanPlayers,
      spectators: [], takeoverPlayerId: null,
      map: CHINA_ROOM_MAP,
      ...overrides,
    };
  }

  async function connectActive(options: {
    room?: ReturnType<typeof room>;
    snapshot?: PublicGameSnapshot;
    ackTimeoutMs?: number;
  } = {}) {
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '123456', playerId: 'player-1', token: 'secret-token' }));
    const emissions: unknown[][] = [];
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const socket = {
      connected: true,
      on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
      off(event: string) { listeners.delete(event); return this; },
      emit(...args: unknown[]) { emissions.push(args); return this; },
      connect() { return this; },
      disconnect() { return this; },
    };
    const session = createOnlineSession({
      storage,
      ackTimeoutMs: options.ackTimeoutMs ?? 10,
      socketFactory: () => socket as never,
    });
    const currentRoom = options.room ?? room();
    const resumeAck = emissions.find(([event]) => event === 'session:resume')?.at(-1) as (ack: unknown) => void;
    resumeAck({ ok: true, room: currentRoom, snapshot: options.snapshot });
    await flush();
    return { session, storage, emissions, listeners, socket, room: currentRoom };
  }

  it('clears a timed-out intent after its late transition and keeps the new battle report visible', async () => {
    vi.useFakeTimers();
    const snapshot = createPublicSnapshot({ currentPlayerId: 'player-1' });
    const { session, listeners } = await connectActive({ snapshot });

    const request = session.sendIntent({ type: 'roll_dice' });
    await vi.advanceTimersByTimeAsync(10);
    await request;
    expect(session.lastError.value).toBe('请求超时，请重试');

    listeners.get('game:events')?.({ events: [{ type: 'dice_rolled', playerId: 'player-1', dice: [2, 3] }] });
    listeners.get('game:snapshot')?.({ state: snapshot });
    await vi.advanceTimersByTimeAsync(120);

    expect(session.lastError.value).toBeNull();
    expect(session.eventMessage.value).toBe('玩家一 掷出 2 + 3');
  });

  it('does not let a timed-out intent late transition settle a retry after a duplicate notice', async () => {
    vi.useFakeTimers();
    const snapshot = createPublicSnapshot({ currentPlayerId: 'player-1' });
    const { session, listeners, emissions } = await connectActive({ snapshot });
    const first = session.sendIntent({ type: 'roll_dice' });
    await vi.advanceTimersByTimeAsync(10);
    await first;

    const retry = session.sendIntent({ type: 'roll_dice' });
    let retrySettled = false;
    void retry.then(() => { retrySettled = true; });
    const retryAck = emissions.filter(([event]) => event === 'game:intent').at(-1)?.at(-1) as (ack: unknown) => void;
    await session.sendIntent({ type: 'roll_dice' });
    expect(session.transientNotice.value).toMatchObject({ message: '操作过快，请稍候重试' });

    listeners.get('game:events')?.({ events: [{ type: 'dice_rolled', playerId: 'player-1', dice: [2, 3] }] });
    listeners.get('game:snapshot')?.({ state: snapshot });
    await flush();

    expect(retrySettled).toBe(false);
    retryAck({ ok: false, code: 'INSUFFICIENT_FUNDS', message: '' });
    await retry;
    expect(session.transientNotice.value).toMatchObject({ message: '现金不足' });
  });

  it('keeps consecutive timed-out intent markers isolated from a later retry', async () => {
    vi.useFakeTimers();
    const snapshot = createPublicSnapshot({ currentPlayerId: 'player-1' });
    const { session, listeners, emissions } = await connectActive({ snapshot });

    const first = session.sendIntent({ type: 'roll_dice' });
    await vi.advanceTimersByTimeAsync(10);
    await first;
    const second = session.sendIntent({ type: 'roll_dice' });
    await vi.advanceTimersByTimeAsync(10);
    await second;
    expect(session.lastError.value).toBe('请求超时，请重试');

    listeners.get('game:events')?.({ events: [] });
    listeners.get('game:snapshot')?.({ state: snapshot });
    await vi.advanceTimersByTimeAsync(0);
    expect(session.lastError.value).toBe('请求超时，请重试');
    expect(session.isAnimating.value).toBe(false);

    const third = session.sendIntent({ type: 'roll_dice' });
    let thirdSettled = false;
    void third.then(() => { thirdSettled = true; });
    const thirdAck = emissions.filter(([event]) => event === 'game:intent').at(-1)?.at(-1) as (ack: unknown) => void;
    listeners.get('game:events')?.({ events: [] });
    listeners.get('game:snapshot')?.({ state: snapshot });
    await flush();
    expect(thirdSettled).toBe(false);

    thirdAck({ ok: false, code: 'INSUFFICIENT_FUNDS', message: '' });
    await third;
    expect(session.transientNotice.value).toMatchObject({ message: '现金不足' });
  });

  it('lets a new room request replace the previous room terminal error', async () => {
    vi.useFakeTimers();
    const { session, listeners } = await connectActive();
    listeners.get('room:closed')?.({ reason: 'game_over' });
    expect(session.lastError.value).toBe('本局游戏已结束');

    const request = session.create('新玩家', 'china-tour');
    await vi.advanceTimersByTimeAsync(10);
    await request;

    expect(session.lastError.value).toBe('请求超时，请重试');
  });

  it('clears a timed-out start only when the late room state reaches playing', async () => {
    vi.useFakeTimers();
    const lobby = room({ status: 'lobby' as const });
    const { session, listeners } = await connectActive({ room: lobby });

    const request = session.start();
    await vi.advanceTimersByTimeAsync(10);
    await request;
    expect(session.lastError.value).toBe('请求超时，请重试');

    listeners.get('room:state')?.({ ...lobby, players: [{ ...humanPlayers[0], online: false }, humanPlayers[1]] });
    expect(session.lastError.value).toBe('请求超时，请重试');

    listeners.get('room:state')?.({ ...lobby, status: 'playing' });
    expect(session.lastError.value).toBeNull();
  });

  it.each([
    {
      name: 'add-bot',
      initialPlayers: humanPlayers,
      run: (session: OnlineGameSession) => session.addBot(),
      targetPlayers: [...humanPlayers, bot],
    },
    {
      name: 'remove-bot',
      initialPlayers: [...humanPlayers, bot],
      run: (session: OnlineGameSession) => session.removeBot('bot-1'),
      targetPlayers: humanPlayers,
    },
    {
      name: 'rename-bot',
      initialPlayers: [...humanPlayers, bot],
      run: (session: OnlineGameSession) => session.renameBot('bot-1', '电脑甲'),
      targetPlayers: [...humanPlayers, { ...bot, nickname: '电脑甲' }],
    },
  ])('clears a timed-out $name after its late target roster arrives', async ({ initialPlayers, run, targetPlayers }) => {
    vi.useFakeTimers();
    const lobby = room({ status: 'lobby' as const, players: initialPlayers });
    const { session, listeners } = await connectActive({ room: lobby });

    const request = run(session);
    await vi.advanceTimersByTimeAsync(10);
    await request;
    expect(session.lastError.value).toBe('请求超时，请重试');

    listeners.get('room:state')?.({ ...lobby, players: targetPlayers });
    expect(session.lastError.value).toBeNull();
  });

  it('clears a timed-out offline skip after a late authoritative transition advances the turn', async () => {
    vi.useFakeTimers();
    const offlineRoom = room({
      players: [humanPlayers[0], { ...humanPlayers[1], online: false }],
    });
    const initial = createPublicSnapshot({ currentPlayerId: 'player-2', debt: null });
    const advanced = createPublicSnapshot({ currentPlayerId: 'player-1', turn: initial.turn + 1, debt: null });
    const { session, listeners } = await connectActive({ room: offlineRoom, snapshot: initial });

    const request = session.skipOfflineTurn();
    await vi.advanceTimersByTimeAsync(10);
    await request;
    expect(session.lastError.value).toBe('请求超时，请重试');

    listeners.get('game:events')?.({ events: [{ type: 'turn_started', playerId: 'player-1' }] });
    listeners.get('game:snapshot')?.({ state: advanced });
    expect(session.lastError.value).toBeNull();
  });

  it('keeps a timed-out offline skip after empty events and an unchanged snapshot', async () => {
    vi.useFakeTimers();
    const offlineRoom = room({
      players: [humanPlayers[0], { ...humanPlayers[1], online: false }],
    });
    const snapshot = createPublicSnapshot({ currentPlayerId: 'player-2', debt: null });
    const { session, listeners } = await connectActive({ room: offlineRoom, snapshot });

    const request = session.skipOfflineTurn();
    await vi.advanceTimersByTimeAsync(10);
    await request;
    expect(session.lastError.value).toBe('请求超时，请重试');

    listeners.get('game:events')?.({ events: [] });
    listeners.get('game:snapshot')?.({ state: snapshot });

    expect(session.lastError.value).toBe('请求超时，请重试');
  });

  it('does not let a timed-out skip late transition settle a retry after a duplicate error', async () => {
    vi.useFakeTimers();
    const offlineRoom = room({
      players: [humanPlayers[0], { ...humanPlayers[1], online: false }],
    });
    const initial = createPublicSnapshot({ currentPlayerId: 'player-2', debt: null });
    const advanced = createPublicSnapshot({ currentPlayerId: 'player-1', turn: initial.turn + 1, debt: null });
    const { session, listeners, emissions } = await connectActive({ room: offlineRoom, snapshot: initial });
    const first = session.skipOfflineTurn();
    await vi.advanceTimersByTimeAsync(10);
    await first;

    const retry = session.skipOfflineTurn();
    let retrySettled = false;
    void retry.then(() => { retrySettled = true; });
    const retryAck = emissions.filter(([event]) => event === 'room:skip_offline_turn').at(-1)?.at(-1) as (ack: unknown) => void;
    await session.skipOfflineTurn();
    expect(session.lastError.value).toBe('请求正在处理中');

    listeners.get('game:events')?.({ events: [{ type: 'turn_started', playerId: 'player-1' }] });
    listeners.get('game:snapshot')?.({ state: advanced });
    await flush();

    expect(retrySettled).toBe(false);
    retryAck({ ok: false, code: 'REQUEST_TIMEOUT', message: '' });
    await retry;
    expect(session.lastError.value).toBe('请求超时，请重试');
  });

  it.each([
    {
      name: 'start',
      initialPlayers: humanPlayers,
      run: (session: OnlineGameSession) => session.start(),
      target: { status: 'playing' as const, players: humanPlayers },
    },
    {
      name: 'add-bot',
      initialPlayers: humanPlayers,
      run: (session: OnlineGameSession) => session.addBot(),
      target: { status: 'lobby' as const, players: [...humanPlayers, bot] },
    },
    {
      name: 'remove-bot',
      initialPlayers: [...humanPlayers, bot],
      run: (session: OnlineGameSession) => session.removeBot('bot-1'),
      target: { status: 'lobby' as const, players: humanPlayers },
    },
    {
      name: 'rename-bot',
      initialPlayers: [...humanPlayers, bot],
      run: (session: OnlineGameSession) => session.renameBot('bot-1', '电脑甲'),
      target: { status: 'lobby' as const, players: [...humanPlayers, { ...bot, nickname: '电脑甲' }] },
    },
  ])('shows takeover after a late $name room state clears its timeout', async ({ initialPlayers, run, target }) => {
    vi.useFakeTimers();
    const lobby = room({ status: 'lobby' as const, players: initialPlayers });
    const { session, listeners } = await connectActive({ room: lobby });
    const request = run(session);
    await vi.advanceTimersByTimeAsync(10);
    await request;

    listeners.get('room:state')?.({ ...lobby, ...target, spectators: [], takeoverPlayerId: 'player-1' });

    expect(session.lastError.value).toBe('房主托管正在执行');
  });

  it('keeps a manually surfaced offline-debtor status while the debt snapshot is unchanged', async () => {
    const offlineRoom = room({
      spectators: [], takeoverPlayerId: null,
      players: [humanPlayers[0], { ...humanPlayers[1], online: false }],
    });
    const debt = { debtorId: 'player-2', creditorId: null, amount: 300 };
    const snapshot = createPublicSnapshot({ currentPlayerId: 'player-2', debt });
    const { session, listeners } = await connectActive({ room: offlineRoom, snapshot });
    await session.skipOfflineTurn();
    expect(session.lastError.value).toBe('需要 玩家二 回来处理债务');

    listeners.get('game:snapshot')?.({ state: snapshot });

    expect(session.lastError.value).toBe('需要 玩家二 回来处理债务');
  });

  it.each(['debt-resolved', 'debtor-reconnected'] as const)(
    'clears a manually surfaced offline-debtor status when %s',
    async (resolution) => {
      const offlineRoom = room({
        spectators: [], takeoverPlayerId: null,
        players: [humanPlayers[0], { ...humanPlayers[1], online: false }],
      });
      const debt = { debtorId: 'player-2', creditorId: null, amount: 300 };
      const snapshot = createPublicSnapshot({ currentPlayerId: 'player-2', debt });
      const { session, listeners } = await connectActive({ room: offlineRoom, snapshot });
      await session.skipOfflineTurn();
      expect(session.lastError.value).toBe('需要 玩家二 回来处理债务');

      if (resolution === 'debt-resolved') {
        listeners.get('game:snapshot')?.({ state: createPublicSnapshot({ currentPlayerId: 'player-2', debt: null }) });
      } else {
        listeners.get('player:connection')?.({ playerId: 'player-2', online: true });
      }

      expect(session.lastError.value).toBeNull();
    },
  );

  it('replaces and clears debtor/takeover status as its authoritative conditions end', async () => {
    const debt = { debtorId: 'player-2', creditorId: null, amount: 300 };
    const takeoverRoom = room({ spectators: [], takeoverPlayerId: 'player-1' });
    const indebted = createPublicSnapshot({ currentPlayerId: 'player-2', debt });
    const resolved = createPublicSnapshot({ currentPlayerId: 'player-2', debt: null });
    const { session, listeners } = await connectActive({ room: takeoverRoom, snapshot: indebted });

    expect(session.lastError.value).toBe('需要 玩家二 回来处理债务');

    listeners.get('game:snapshot')?.({ state: resolved });
    expect(session.lastError.value).toBe('房主托管正在执行');

    listeners.get('room:state')?.({ ...takeoverRoom, spectators: [], takeoverPlayerId: null });
    expect(session.lastError.value).toBeNull();
  });

  it('does not clear a connection error on ordinary room or game authority', async () => {
    const snapshot = createPublicSnapshot();
    const { session, listeners, room: currentRoom } = await connectActive({ snapshot });
    listeners.get('connect_error')?.(new Error('network down'));
    expect(session.lastError.value).toBe('无法连接服务器，请重试');

    listeners.get('room:state')?.({ ...currentRoom, spectators: [], takeoverPlayerId: 'player-1' });
    listeners.get('game:events')?.({ events: [{ type: 'turn_started', playerId: 'player-1' }] });
    listeners.get('game:snapshot')?.({ state: snapshot });

    expect(session.lastError.value).toBe('无法连接服务器，请重试');
  });

  it('does not let takeover authority overwrite a storage error', async () => {
    const snapshot = createPublicSnapshot();
    const { session, storage, listeners, room: currentRoom } = await connectActive({ snapshot });
    vi.spyOn(storage, 'removeItem').mockImplementation((key: string) => {
      if (key === ACTIVE_ONLINE_SESSION_KEY) throw new Error('storage locked');
      MemoryStorage.prototype.removeItem.call(storage, key);
    });
    expect(session.discardStoredSession()).toBe(false);
    expect(session.lastError.value).toBe('无法更新本地存档，请稍后重试');

    listeners.get('room:state')?.({ ...currentRoom, spectators: [], takeoverPlayerId: 'player-1' });
    listeners.get('game:events')?.({ events: [{ type: 'turn_started', playerId: 'player-1' }] });
    listeners.get('game:snapshot')?.({ state: snapshot });

    expect(session.lastError.value).toBe('无法更新本地存档，请稍后重试');
  });

  it('does not clear a terminal room-closed reason on late authority', async () => {
    const snapshot = createPublicSnapshot();
    const { session, listeners, room: currentRoom } = await connectActive({ snapshot });
    listeners.get('room:closed')?.({ reason: 'game_over' });

    listeners.get('room:state')?.(currentRoom);
    listeners.get('game:events')?.({ events: [{ type: 'turn_started', playerId: 'player-1' }] });
    listeners.get('game:snapshot')?.({ state: snapshot });

    expect(session.lastError.value).toBe('本局游戏已结束');
  });

});
describe('online session spectators', () => {
  const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

  function spectatorRoom(overrides: Record<string, unknown> = {}) {
    return {
      roomCode: '123456',
      status: 'playing' as const,
      hostId: 'player-1',
      players: [
        { id: 'player-1', nickname: '玩家一', isBot: false, online: true },
        { id: 'player-2', nickname: '玩家二', isBot: false, online: true },
      ],
      spectators: [{ id: 'spec-1', nickname: '观众甲', online: true }],
      takeoverPlayerId: null,
      map: CHINA_ROOM_MAP,
      ...overrides,
    };
  }

  it('emits a required join role and applies a mid-game spectator snapshot', async () => {
    const emissions: unknown[][] = [];
    const session = createOnlineSession({
      storage: new MemoryStorage(),
      crypto: { getRandomValues: (bytes) => bytes.fill(0xab) },
      socketFactory: () => ({
        connected: true,
        on() { return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });
    const joining = session.join('123456', '观众甲', 'spectator');
    expect(emissions[0]?.[0]).toBe('room:join');
    expect(emissions[0]?.[1]).toEqual({
      roomCode: '123456',
      nickname: '观众甲',
      requestId: 'abababababababababababababababab',
      role: 'spectator',
    });
    const snapshot = createPublicSnapshot();
    (emissions[0]?.at(-1) as (ack: unknown) => void)({
      ok: true,
      playerId: 'spec-1',
      token: 'spec-token',
      room: spectatorRoom(),
      snapshot,
    });
    await joining;
    expect(session.isSpectator.value).toBe(true);
    expect(session.isHost.value).toBe(false);
    expect(session.localPlayerId.value).toBe('spec-1');
    expect(session.state.value?.currentPlayerId).toBe(snapshot.currentPlayerId);
    expect(session.availableActions.value).toEqual([]);
  });

  it('defaults a two-argument join to the player role', async () => {
    const emissions: unknown[][] = [];
    const session = createOnlineSession({
      storage: new MemoryStorage(),
      crypto: { getRandomValues: (bytes) => bytes.fill(0xcd) },
      socketFactory: () => ({
        connected: true,
        on() { return this; },
        off() { return this; },
        emit(...args: unknown[]) { emissions.push(args); return this; },
        disconnect() { return this; },
      }) as never,
    });
    void session.join('123456', '客人');
    expect(emissions[0]?.[1]).toEqual({
      roomCode: '123456',
      nickname: '客人',
      requestId: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
      role: 'player',
    });
  });

  async function connectSpectator() {
    const emissions: unknown[][] = [];
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({
      roomCode: '123456', playerId: 'spec-1', token: 'spec-token',
    }));
    const socket = {
      connected: true,
      on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
      off() { return this; },
      emit(...args: unknown[]) { emissions.push(args); return this; },
      disconnect() { return this; },
    };
    const session = createOnlineSession({ storage, socketFactory: () => socket as never });
    const snapshot = createPublicSnapshot();
    (emissions[0]?.at(-1) as (ack: unknown) => void)({ ok: true, room: spectatorRoom(), snapshot });
    await flush();
    return { session, emissions, listeners, snapshot };
  }

  it('restores spectator identity from a resume acknowledgement', async () => {
    const { session } = await connectSpectator();
    expect(session.isSpectator.value).toBe(true);
    expect(session.localPlayerId.value).toBe('spec-1');
    expect(session.isHost.value).toBe(false);
  });

  it('refuses spectator writes locally and still allows leave', async () => {
    const { session, emissions } = await connectSpectator();
    const before = emissions.length;
    await session.start();
    await session.addBot();
    await session.removeBot('bot-1');
    await session.renameBot('bot-1', 'x');
    await session.sendIntent({ type: 'roll_dice' });
    await session.skipOfflineTurn();
    expect(emissions.slice(before).map((row) => row[0])).toEqual([]);
    expect(session.lastError.value).toBe('只有房主可以执行此操作');
    const leaving = session.leave();
    await flush();
    const leaveEmit = emissions.find((row) => row[0] === 'room:leave');
    expect(leaveEmit?.[0]).toBe('room:leave');
    (leaveEmit?.at(-1) as (ack: unknown) => void)({ ok: true });
    await leaving;
  });

  it('updates spectator presence from player:connection', async () => {
    const { session, listeners } = await connectSpectator();
    listeners.get('player:connection')?.({ playerId: 'spec-1', online: false });
    expect(session.room.value?.spectators).toEqual([
      { id: 'spec-1', nickname: '观众甲', online: false },
    ]);
    expect(session.room.value?.players.every((player) => player.online)).toBe(true);
  });
});

describe('online session minimal undo', () => {
  const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

  function undoRoom() {
    return {
      roomCode: '000007',
      status: 'playing',
      hostId: 'player-1',
      players: [
        { id: 'player-1', nickname: '房主', isBot: false, online: true },
        { id: 'player-2', nickname: '客人', isBot: false, online: true },
      ],
      spectators: [],
      takeoverPlayerId: null,
      map: CHINA_ROOM_MAP,
    };
  }

  function undoRequest(overrides: Record<string, unknown> = {}) {
    return {
      requestId: 'req-1',
      requesterId: 'player-1',
      requesterNickname: '房主',
      voterIds: ['player-2'],
      approvals: [],
      expiresAt: 1_800_000_000_000,
      ...overrides,
    };
  }

  async function connectUndoSession(localPlayerId = 'player-1', snapshot: PublicGameSnapshot | null = null) {
    const emissions: unknown[][] = [];
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify({ roomCode: '000007', playerId: localPlayerId, token: 'tkn' }));
    const socket = {
      connected: true,
      on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); return this; },
      off(event: string) { listeners.delete(event); return this; },
      emit(...args: unknown[]) { emissions.push(args); return this; },
      disconnect() { return this; },
    };
    const session = createOnlineSession({ storage, socketFactory: () => socket as never });
    const resumeEmit = emissions.find((emission) => emission[0] === 'session:resume');
    (resumeEmit?.at(-1) as (ack: unknown) => void)({
      ok: true,
      room: undoRoom(),
      ...(snapshot === null ? {} : { snapshot }),
    });
    await flush();
    return { session, emissions, listeners };
  }

  it('只把可悔权交给服务端指名的那个人', async () => {
    const { session, listeners } = await connectUndoSession('player-1');
    expect(session.undoAvailability.value).toBeNull();
    expect(session.canRequestUndo.value).toBe(false);

    listeners.get('room:undo_available')?.({ playerId: 'player-1' });
    expect(session.undoAvailability.value).toBe('player-1');
    expect(session.canRequestUndo.value).toBe(true);

    // 可悔权在别人手上（对手刚走完一步）：本机不该出现任何按钮。
    listeners.get('room:undo_available')?.({ playerId: 'player-2' });
    expect(session.canRequestUndo.value).toBe(false);

    // 没人可悔。
    listeners.get('room:undo_available')?.({ playerId: null });
    expect(session.canRequestUndo.value).toBe(false);
    session.dispose();
  });

  it('按请求内容派生「我该不该投票」与「是不是我在等确认」', async () => {
    const voter = await connectUndoSession('player-2');
    voter.listeners.get('room:undo_request')?.(undoRequest());
    expect(voter.session.undoRequest.value?.requestId).toBe('req-1');
    expect(voter.session.canVoteUndo.value).toBe(true);
    expect(voter.session.isUndoRequester.value).toBe(false);

    // 已经表态过的人不再显示投票按钮（重复同意是幂等的，UI 也不该留一个能重复点的按钮）。
    voter.listeners.get('room:undo_request')?.(undoRequest({ approvals: ['player-2'] }));
    expect(voter.session.canVoteUndo.value).toBe(false);
    voter.session.dispose();

    const requester = await connectUndoSession('player-1');
    requester.listeners.get('room:undo_request')?.(undoRequest());
    expect(requester.session.isUndoRequester.value).toBe(true);
    expect(requester.session.canVoteUndo.value).toBe(false);
    requester.session.dispose();
  });

  it('等待请求存在时不能再发起，收到结果后立刻恢复', async () => {
    const { session, listeners } = await connectUndoSession('player-1');
    listeners.get('room:undo_available')?.({ playerId: 'player-1' });
    expect(session.canRequestUndo.value).toBe(true);

    listeners.get('room:undo_request')?.(undoRequest());
    expect(session.canRequestUndo.value).toBe(false);

    listeners.get('room:undo_result')?.({ requestId: 'req-1', outcome: 'rejected' });
    expect(session.undoRequest.value).toBeNull();
    expect(session.canRequestUndo.value).toBe(true);
    session.dispose();
  });

  it('四种结局各给一句即时提示', async () => {
    const { session, listeners } = await connectUndoSession('player-1');

    for (const [outcome, message] of [
      ['applied', '悔棋已通过，退回上一步'],
      ['rejected', '悔棋被拒绝'],
      ['cancelled', '悔棋请求已撤回'],
      ['expired', '悔棋请求超时，未获全部确认'],
    ] as const) {
      listeners.get('room:undo_result')?.({ requestId: `req-${outcome}`, outcome });
      expect(session.transientNotice.value?.message).toBe(message);
    }
    session.dispose();
  });

  it('applied 之后的快照按硬重置同步落地，不留动画尾巴', async () => {
    const initial = createPublicSnapshot();
    const { session, listeners } = await connectUndoSession('player-1', initial);
    // 重连时带下来的快照同样是硬重置路径，位置应当已经就位。
    expect(session.displayPositions.value['player-1']).toBe(initial.players[0]?.position);

    const jumped = createPublicSnapshot({
      players: initial.players.map((player, index) => (index === 0 ? { ...player, position: 9 } : player)),
    });
    listeners.get('game:snapshot')?.({ state: jumped });
    listeners.get('room:undo_result')?.({ requestId: 'req-applied', outcome: 'applied' });
    listeners.get('game:snapshot')?.({ state: initial });

    // 时间线倒退了，不能拿增量动画播：位置必须同步回到快照值，也不能留下动画态。
    expect(session.displayPositions.value['player-1']).toBe(initial.players[0]?.position);
    expect(session.isAnimating.value).toBe(false);
    expect(session.state.value?.players.find((player) => player.id === 'player-1')?.position)
      .toBe(initial.players[0]?.position);
    session.dispose();
  });

  it('迟到的结果不会抹掉刚发起的新请求', async () => {
    const { session, listeners } = await connectUndoSession('player-1');

    listeners.get('room:undo_request')?.(undoRequest({ requestId: 'req-new' }));
    listeners.get('room:undo_result')?.({ requestId: 'req-old', outcome: 'expired' });
    expect(session.undoRequest.value?.requestId).toBe('req-new');

    listeners.get('room:undo_result')?.({ requestId: 'req-new', outcome: 'cancelled' });
    expect(session.undoRequest.value).toBeNull();
    session.dispose();
  });

  it('发起 / 表决 / 撤回各发一条事件，且身份不随载荷传递', async () => {
    const { session, emissions } = await connectUndoSession('player-1');
    const before = emissions.length;

    void session.requestUndo();
    void session.voteUndo('req-1', true);
    void session.cancelUndo();
    await flush();

    const sent = emissions.slice(before);
    expect(sent.map((row) => row[0])).toEqual(['room:undo_request', 'room:undo_vote', 'room:undo_cancel']);
    expect(sent[1]?.[1]).toEqual({ requestId: 'req-1', approve: true });
    // 请求体里不带「我是谁」：服务端从连接绑定里取身份，客户端没有伪造入口。
    expect(typeof sent[0]?.[1]).toBe('function');
    expect(typeof sent[2]?.[1]).toBe('function');
    session.dispose();
  });

  it('悔棋开关只认服务端给的 room:settings，缺字段按关闭处理', async () => {
    const { session, listeners } = await connectUndoSession('player-1');

    listeners.get('room:settings')?.({ botDifficulty: 'normal', ruleConfig: null, minimalUndoEnabled: true });
    expect(session.roomSettings.value?.minimalUndoEnabled).toBe(true);

    listeners.get('room:settings')?.({ botDifficulty: 'normal', ruleConfig: null });
    expect(session.roomSettings.value?.minimalUndoEnabled).toBe(false);
    session.dispose();
  });

  it('观战者不能发起 / 表决 / 撤回悔棋', async () => {
    const harness = await connectUndoSession('player-1');
    // 房间广播把我从成员名单挪进观众名单：身份是派生的，一切悔棋操作随之失效。
    harness.listeners.get('room:state')?.({
      ...undoRoom(),
      players: [{ id: 'player-2', nickname: '客人', isBot: false, online: true }],
      spectators: [{ id: 'player-1', nickname: '房主', online: true }],
    });
    expect(harness.session.isSpectator.value).toBe(true);

    const before = harness.emissions.length;
    void harness.session.requestUndo();
    void harness.session.voteUndo('req-1', true);
    void harness.session.cancelUndo();
    await flush();

    expect(harness.emissions.slice(before)).toEqual([]);
    harness.session.dispose();
  });
});
