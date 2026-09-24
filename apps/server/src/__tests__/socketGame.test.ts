import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { io as connectSocket, type Socket as ClientSocket } from 'socket.io-client';
import { applyIntent, chooseBotIntent, createGame } from '@richman/engine';
import type { ApplyResult, BotDifficulty, GameEvent, GameState, Intent } from '@richman/engine';
import { createRoomServer, type RunningRoomServer } from '../server';
import type { Ack, ClientToServerEvents, CreateRoomAck, JoinRoomAck, PublicGameSnapshot, ServerToClientEvents } from '@richman/protocol';
import { RoomManager } from '../rooms/roomManager';
import type { RoomDomainEvent, RoomManagerDependencies } from '../rooms/roomTypes';
import type { GameRuntimeGateway } from '../game/gameRuntime';

type Deferred<T> = { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void; reject(reason: unknown): void };
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
type TimerHandle = { callback: () => void; delayMs: number; active: boolean };
type RoomClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;
type RoomManagerFactory = (onAsyncEvents: (events: RoomDomainEvent[]) => void) => RoomManager<TimerHandle>;
type EmptyAck = Ack<Record<string, never>>;
type Message = 'room_state' | 'events' | 'snapshot' | 'ack';
type Recorder = { messages: Message[]; stop(): void };
type Running = { url: string; manager: RoomManager<TimerHandle> };
type StartedGame = { host: RoomClient; guest: RoomClient; manager: RoomManager<TimerHandle>; state: GameState; sockets: Map<string, RoomClient> };
type Options = { seed?: string; delays?: number[]; gameGateway?: GameRuntimeGateway; timers?: TimerHandle[] };

const EVENT_TIMEOUT_MS = 250;
const clients: RoomClient[] = [];
const servers: RunningRoomServer<TimerHandle>[] = [];

afterEach(async () => {
  for (const socket of clients.splice(0).reverse()) socket.disconnect();
  for (const server of servers.splice(0).reverse()) await server.close();
});

describe('Socket.IO game dispatch integration', () => {
  test('initial game:snapshot serializes a public snapshot without random state or deck order', async () => {
    const running = await startServer();
    const host = await connectClient(running.url);
    const guest = await connectClient(running.url);
    await createAndJoin(host, guest);
    const hostRecorder = record(host);
    const guestRecorder = record(guest);
    const hostSnapshot = nextSnapshot(host, 'host opening snapshot');
    const guestSnapshot = nextSnapshot(guest, 'guest opening snapshot');

    const start = await emitStart(host, hostRecorder);
    const [hostGame, guestGame] = await Promise.all([hostSnapshot, guestSnapshot]);

    expect(start).toEqual({ ok: true });
    expect(hostRecorder.messages).toEqual(['room_state', 'snapshot', 'ack']);
    expect(guestRecorder.messages).toEqual(['room_state', 'snapshot']);
    expect(hostGame).toEqual(guestGame);
    expect(hostGame.state.phase).toBe('playing');
    const authoritative = running.manager.getGameSnapshot('000007');
    if (authoritative === null) throw new Error('missing authoritative game snapshot after start');
    expectPublicGameSnapshot(hostGame.state, authoritative);
    expectNoPrivateData(hostGame);
    hostRecorder.stop();
    guestRecorder.stop();
  });

  test('a current-player intent broadcasts events, authoritative snapshot, then acknowledgement', async () => {
    const game = await startTwoClientGame();
    const actor = socketForCurrentPlayer(game);
    const peer = otherSocket(game, actor);
    const actorRecorder = record(actor);
    const peerRecorder = record(peer);
    const actorEvents = nextEvents(actor, 'actor events');
    const peerEvents = nextEvents(peer, 'peer events');
    const actorSnapshot = nextSnapshot(actor, 'actor transition snapshot');
    const peerSnapshot = nextSnapshot(peer, 'peer transition snapshot');

    const [ack, events, peerBatch, snapshot, peerGame] = await Promise.all([
      emitIntent(actor, { type: 'roll_dice' }, actorRecorder),
      actorEvents,
      peerEvents,
      actorSnapshot,
      peerSnapshot,
    ]);

    expect(ack).toEqual({ ok: true });
    expect(events).toEqual(peerBatch);
    expect(snapshot).toEqual(peerGame);
    expect(events.events).not.toHaveLength(0);
    expect(actorRecorder.messages).toEqual(['events', 'snapshot', 'ack']);
    expect(peerRecorder.messages).toEqual(['events', 'snapshot']);
    const authoritative = game.manager.getGameSnapshot('000007');
    if (authoritative === null) throw new Error('missing authoritative transition snapshot');
    expectPublicGameSnapshot(snapshot.state, authoritative);
    expectNoPrivateData(events);
    expectNoPrivateData(snapshot);
    actorRecorder.stop();
    peerRecorder.stop();
  });

  test('a non-current player receives NOT_YOUR_TURN and emits no game events', async () => {
    const game = await startTwoClientGame();
    const nonActor = otherSocket(game, socketForCurrentPlayer(game));
    const noHostEvents = expectNoEvent(game.host, 'game:events', 'host event after rejected intent');
    const noGuestEvents = expectNoEvent(game.guest, 'game:events', 'guest event after rejected intent');

    const ack = await emitIntent(nonActor, { type: 'roll_dice' });

    expectFailure(ack, 'NOT_YOUR_TURN');
    await Promise.all([noHostEvents, noGuestEvents]);
  });

  test('a full normal engine turn broadcasts events, then the fallback snapshot, then ack', async () => {
    const game = await startTwoClientGame();
    const actor = socketForCurrentPlayer(game);
    const peer = otherSocket(game, actor);
    const actorRecorder = record(actor);
    const peerRecorder = record(peer);

    await playSocketTurn(actor, game.state, actorRecorder);

    expect(actorRecorder.messages.at(-2)).toBe('snapshot');
    expect(actorRecorder.messages.at(-1)).toBe('ack');
    expect(actorRecorder.messages.filter((message) => message === 'events').length).toBeGreaterThan(0);
    expect(peerRecorder.messages.at(-1)).toBe('snapshot');
    expect(peerRecorder.messages.filter((message) => message === 'events').length).toBeGreaterThan(0);
    actorRecorder.stop();
    peerRecorder.stop();
  });

  test('simultaneous actor and non-actor intents produce exactly one accepted batch', async () => {
    const game = await startTwoClientGame();
    const actor = socketForCurrentPlayer(game);
    const nonActor = otherSocket(game, actor);
    const hostEvents = collectEvents(game.host);
    const guestEvents = collectEvents(game.guest);

    const [actorAck, nonActorAck] = await Promise.all([
      emitIntent(actor, { type: 'roll_dice' }),
      emitIntent(nonActor, { type: 'roll_dice' }),
    ]);
    await zeroDelayMacrotask();

    expect([actorAck, nonActorAck].filter((ack) => ack.ok)).toEqual([{ ok: true }]);
    expect([actorAck, nonActorAck].filter((ack) => !ack.ok)).toMatchObject([{ ok: false, code: 'NOT_YOUR_TURN' }]);
    expect(hostEvents.events).toHaveLength(1);
    expect(guestEvents.events).toEqual(hostEvents.events);
    hostEvents.stop();
    guestEvents.stop();
  });

  test('malformed payload and missing acknowledgement do not mutate deep state or broadcast', async () => {
    const game = await startTwoClientGame();
    const actor = socketForCurrentPlayer(game);
    const before = game.manager.getGameSnapshot('000007');
    expect(before).not.toBeNull();
    if (before === null) throw new Error('missing authoritative game state');
    const beforeValue = structuredClone(before);
    const stablePlayers = before.players;
    const stableProperties = before.properties;
    const noHostEvents = expectNoEvent(game.host, 'game:events', 'host event after malformed or unacknowledged intent');
    const noGuestEvents = expectNoEvent(game.guest, 'game:events', 'guest event after malformed or unacknowledged intent');

    const malformed = await emitMalformedIntent(actor, { intent: { type: 'sell_house', cellId: 'wrong' } });
    emitIntentWithoutAck(actor, { type: 'roll_dice' });
    await zeroDelayMacrotask();

    expect(malformed.ok).toBe(false);
    const after = game.manager.getGameSnapshot('000007');
    expect(after).toEqual(beforeValue);
    expect(after?.players[0]).toBe(stablePlayers[0]);
    expect(after?.properties).toBe(stableProperties);
    await Promise.all([noHostEvents, noGuestEvents]);
  });

  test('a controlled game-over gateway sends a final snapshot and rejects later intents', async () => {
    const scripted = gameOverGateway();
    const game = await startTwoClientGame({ gameGateway: scripted.gateway });
    const actor = socketForCurrentPlayer(game);
    const finalSnapshot = nextSnapshot(actor, 'final game-over snapshot');

    const [ending, final] = await Promise.all([
      emitIntent(actor, { type: 'end_turn' }),
      finalSnapshot,
    ]);
    const later = await emitIntent(actor, { type: 'roll_dice' });

    expect(ending).toEqual({ ok: true });
    expect(final.state.phase).toBe('game_over');
    expect(final.state.winnerId).toBe(game.state.currentPlayerId);
    expectFailure(later, 'INVALID_ROOM_ACTION');
    const authoritative = game.manager.getGameSnapshot('000007');
    if (authoritative === null) throw new Error('missing authoritative final game snapshot');
    expectPublicGameSnapshot(final.state, authoritative);
    expect(scripted.applyCalls()).toBe(1);
  });
});

async function startTwoClientGame(options: Options = {}): Promise<StartedGame> {
  const running = await startServer(options);
  const host = await connectClient(running.url);
  const guest = await connectClient(running.url);
  await createAndJoin(host, guest);
  const hostSnapshot = nextSnapshot(host, 'host opening snapshot');
  const guestSnapshot = nextSnapshot(guest, 'guest opening snapshot');
  await emitStart(host);
  const [hostGame, guestGame] = await Promise.all([hostSnapshot, guestSnapshot]);
  expect(hostGame).toEqual(guestGame);
  const state = running.manager.getGameSnapshot('000007');
  if (state === null) throw new Error('missing authoritative game snapshot after start');
  return { host, guest, manager: running.manager, state, sockets: new Map([['player-host', host], ['player-guest', guest]]) };
}

async function startServer(options: Options = {}): Promise<Running> {
  let manager: RoomManager<TimerHandle> | undefined;
  const server = createRoomServer<TimerHandle>({
    rateLimit: false,
    roomManagerFactory: deterministicFactory(options, (captured) => { manager = captured; }),
  });
  servers.push(server);
  await listen(server.httpServer);
  const address = server.httpServer.address();
  if (address === null || typeof address === 'string' || manager === undefined) throw new Error('test server did not start');
  return { url: `http://127.0.0.1:${(address as AddressInfo).port}`, manager };
}

function deterministicFactory(options: Options, capture: (manager: RoomManager<TimerHandle>) => void): RoomManagerFactory {
  let player = 0;
  let token = 0;
  let delay = 0;
  return (onAsyncEvents) => {
    const dependencies: RoomManagerDependencies<TimerHandle> = {
      generatePlayerId: () => ['player-host', 'player-guest'][player++] ?? `player-${player}`,
      generateToken: () => ['token-host', 'token-guest'][token++] ?? `token-${token}`,
      nextRoomNumber: () => 7,
      compareTokens: (actual, supplied) => actual === supplied,
      setTimer(callback, delayMs) {
        const handle = { callback, delayMs, active: true };
        options.timers?.push(handle);
        return handle;
      },
      clearTimer: (handle) => { handle.active = false; },
      onAsyncEvents,
      generateGameSeed: () => options.seed ?? 'socket-game-seed',
      nextAutomationDelayMs: () => options.delays?.[delay++] ?? 1_000,
      gameGateway: options.gameGateway,
    };
    const manager = new RoomManager(dependencies);
    capture(manager);
    return manager;
  };
}

async function listen(server: HttpServer): Promise<void> {
  const { promise, resolve, reject } = createDeferred<void>();
  const onError = (error: Error) => { server.off('error', onError); reject(error); };
  server.once('error', onError);
  server.listen(0, '127.0.0.1', () => { server.off('error', onError); resolve(); });
  await promise;
}

async function connectClient(url: string): Promise<RoomClient> {
  const socket: RoomClient = connectSocket(url, { forceNew: true, reconnection: false, transports: ['websocket'] });
  clients.push(socket);
  const { promise, resolve, reject } = createDeferred<void>();
  socket.once('connect', resolve);
  socket.once('connect_error', reject);
  await withTimeout(promise, 'Socket.IO connection');
  return socket;
}

async function createAndJoin(host: RoomClient, guest: RoomClient): Promise<void> {
  const create = await emitRoomAck(host, 'room:create', {
    mapId: 'china-tour', nickname: '房主',
    requestId: '00112233445566778899aabbccddeeff',
  });
  expect(create).toMatchObject({ ok: true, roomCode: '000007', playerId: 'player-host' });
  const join = await emitRoomAck(guest, 'room:join', {
    roomCode: '000007',
    nickname: '玩家二',
    requestId: 'ffeeddccbbaa99887766554433221100',
  });
  expect(join).toMatchObject({ ok: true, playerId: 'player-guest' });
}

function emitRoomAck(
  socket: RoomClient,
  event: 'room:create',
  payload: { nickname: string; mapId: string; requestId: string },
): Promise<Ack<CreateRoomAck>>;
function emitRoomAck(
  socket: RoomClient,
  event: 'room:join',
  payload: { roomCode: string; nickname: string; requestId: string; role?: "player" | "spectator" },
): Promise<Ack<JoinRoomAck>>;
function emitRoomAck(
  socket: RoomClient,
  event: 'room:create' | 'room:join',
  payload: { nickname: string; mapId: string; requestId: string } | { roomCode: string; nickname: string; requestId: string; role?: "player" | "spectator" },
): Promise<Ack<CreateRoomAck> | Ack<JoinRoomAck>> {
  const { promise, resolve } = createDeferred<Ack<CreateRoomAck> | Ack<JoinRoomAck>>();
  if (event === 'room:create') socket.emit(event, payload as { nickname: string; mapId: string; requestId: string }, resolve);
  else socket.emit(event, { role: "player" as const, ...(payload as { roomCode: string; nickname: string; requestId: string; role?: "player" | "spectator" }) }, resolve);
  return withTimeout(promise, `${event} acknowledgement`);
}

function emitStart(socket: RoomClient, recorder?: Recorder): Promise<EmptyAck> {
  const { promise, resolve } = createDeferred<EmptyAck>();
  socket.emit('room:start', (ack) => { recorder?.messages.push('ack'); resolve(ack); });
  return withTimeout(promise, 'room:start acknowledgement');
}

function emitIntent(socket: RoomClient, intent: Intent, recorder?: Recorder): Promise<EmptyAck> {
  const { promise, resolve } = createDeferred<EmptyAck>();
  socket.emit('game:intent', { intent }, (ack) => { recorder?.messages.push('ack'); resolve(ack); });
  return withTimeout(promise, 'game:intent acknowledgement');
}

function emitMalformedIntent(socket: RoomClient, payload: unknown): Promise<EmptyAck> {
  const { promise, resolve } = createDeferred<EmptyAck>();
  (socket as ClientSocket).emit('game:intent', payload, resolve);
  return withTimeout(promise, 'malformed game:intent acknowledgement');
}

function emitIntentWithoutAck(socket: RoomClient, intent: Intent): void {
  (socket as ClientSocket).emit('game:intent', { intent });
}

function nextSnapshot(socket: RoomClient, label: string): Promise<{ state: PublicGameSnapshot }> {
  return nextEvent(socket, 'game:snapshot', label);
}

function nextEvents(socket: RoomClient, label: string): Promise<{ events: GameEvent[] }> {
  return nextEvent(socket, 'game:events', label);
}

function nextEvent<T>(socket: RoomClient, event: 'game:snapshot' | 'game:events', label: string): Promise<T> {
  const { promise, resolve } = createDeferred<T>();
  socket.once(event, resolve as never);
  return withTimeout(promise, label);
}

function record(socket: RoomClient): Recorder {
  const messages: Message[] = [];
  const onRoomState = () => messages.push('room_state');
  const onEvents = () => messages.push('events');
  const onSnapshot = () => messages.push('snapshot');
  socket.on('room:state', onRoomState);
  socket.on('game:events', onEvents);
  socket.on('game:snapshot', onSnapshot);
  return { messages, stop: () => { socket.off('room:state', onRoomState); socket.off('game:events', onEvents); socket.off('game:snapshot', onSnapshot); } };
}

function collectEvents(socket: RoomClient): { events: { events: GameEvent[] }[]; stop(): void } {
  const events: { events: GameEvent[] }[] = [];
  const listener = (payload: { events: GameEvent[] }) => events.push(payload);
  socket.on('game:events', listener);
  return { events, stop: () => socket.off('game:events', listener) };
}

function expectNoEvent(socket: RoomClient, event: 'game:events', label: string): Promise<void> {
  const { promise, resolve, reject } = createDeferred<void>();
  const listener = (payload: unknown) => { clearTimeout(timeout); socket.off(event, listener); reject(new Error(`Expected no ${label}, received ${JSON.stringify(payload)}`)); };
  // A bounded real-server listener timeout proves absence without an arbitrary sleep.
  const timeout = setTimeout(() => { socket.off(event, listener); resolve(); }, EVENT_TIMEOUT_MS);
  socket.once(event, listener);
  return promise;
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  const { promise: timeout, reject } = createDeferred<never>();
  // Real Socket.IO integration needs a bounded escape hatch when a handler is absent.
  const timeoutId = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), EVENT_TIMEOUT_MS);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function playSocketTurn(socket: RoomClient, initial: GameState, recorder: Recorder): Promise<void> {
  let state = initial;
  for (let step = 0; step < 8; step += 1) {
    const intent = intentFor(state.turnPhase);
    const expected = applyIntent(state, state.currentPlayerId, intent);
    expect(expected.ok).toBe(true);
    if (!expected.ok) throw new Error(`engine rejected ${intent.type}: ${expected.code}`);
    const events = nextEvents(socket, `events for ${intent.type}`);
    const snapshot = expected.events.some((event) => event.type === 'turn_ended') ? nextSnapshot(socket, 'turn-ending snapshot') : null;
    const ack = emitIntent(socket, intent, recorder);
    const waits: Promise<unknown>[] = [ack, events];
    if (snapshot !== null) waits.push(snapshot);
    const [response] = await Promise.all(waits);
    expect(response).toEqual({ ok: true });
    if (snapshot !== null) return;
    state = expected.state;
  }
  throw new Error(`did not finish a turn from ${initial.turnPhase}`);
}

function intentFor(turnPhase: GameState['turnPhase']): Intent {
  switch (turnPhase) {
    case 'awaiting_roll': return { type: 'roll_dice' };
    case 'awaiting_airport_roll': return { type: 'roll_airport_branch' };
    case 'awaiting_buy_decision': return { type: 'skip_buy' };
    case 'awaiting_build_decision': return { type: 'skip_build' };
    case 'managing': return { type: 'end_turn' };
  }
}

async function zeroDelayMacrotask(): Promise<void> {
  const { promise, resolve } = createDeferred<void>();
  // Deliberately one zero-delay macrotask to establish no second concurrent batch arrived.
  setTimeout(resolve, 0);
  await promise;
}

function socketForCurrentPlayer(game: StartedGame): RoomClient {
  const socket = game.sockets.get(game.state.currentPlayerId);
  if (socket === undefined) throw new Error(`no socket for current player ${game.state.currentPlayerId}`);
  return socket;
}

function otherSocket(game: StartedGame, socket: RoomClient): RoomClient {
  return socket === game.host ? game.guest : game.host;
}

function gameOverGateway(): { gateway: GameRuntimeGateway; applyCalls: () => number } {
  let calls = 0;
  return {
    applyCalls: () => calls,
    gateway: {
      createGame,
      // 网关签名是 (state, playerId, difficulty?)；引擎 chooseBotIntent 的第 3 参是 registry。
      // 这里适配为「使用默认注册表」，与生产 gameRuntime 的 defaultGameGateway 一致。
      chooseBotIntent: (state: GameState, playerId: string, difficulty?: BotDifficulty) =>
        chooseBotIntent(state, playerId, undefined, difficulty),
      applyIntent(state: GameState, playerId: string): ApplyResult {
        calls += 1;
        if (state.phase !== 'playing') return { ok: false, code: 'WRONG_PHASE' };
        const events: GameEvent[] = [{ type: 'turn_ended', playerId }, { type: 'game_over', winnerId: playerId, reason: 'cash_goal' }];
        return { ok: true, state: { ...state, phase: 'game_over', winnerId: playerId, recentLog: [...state.recentLog, ...events].slice(-200) }, events };
      },
    },
  };
}

function expectFailure(ack: EmptyAck, code: string): asserts ack is Extract<EmptyAck, { ok: false }> {
  expect(ack.ok).toBe(false);
  if (ack.ok) throw new Error(`expected ${code}, got success`);
  expect(ack.code).toBe(code);
  expect(ack.message).not.toHaveLength(0);
}

function expectNoPrivateData(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain('token-host');
  expect(serialized).not.toContain('token-guest');
  expect(serialized).not.toContain('"token"');
}

function expectPublicGameSnapshot(snapshot: PublicGameSnapshot, authoritative: GameState): void {
  const serialized = JSON.stringify(snapshot);
  expect(serialized).not.toContain('"seed"');
  expect(serialized).not.toContain('"decks"');
  const { chance, destiny } = snapshot.deckCounts;
  expect(Number.isInteger(chance)).toBe(true);
  expect(Number.isInteger(destiny)).toBe(true);
  expect(chance).toBe(authoritative.decks.chance.length);
  expect(destiny).toBe(authoritative.decks.destiny.length);
}
