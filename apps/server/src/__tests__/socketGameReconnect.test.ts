import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { io as connectSocket, type Socket as ClientSocket } from 'socket.io-client';
import { getActiveMapPack } from '@richman/board-data';
import { createGame } from '@richman/engine';
import type { GameEvent, GameState, Intent } from '@richman/engine';
import { createRoomServer, type RunningRoomServer } from '../server';
import type { Ack, ClientToServerEvents, CreateRoomAck, JoinRoomAck, PublicGameSnapshot, PublicRoomState, ResumeAck, ServerToClientEvents } from '@richman/protocol';
import { RoomManager } from '../rooms/roomManager';
import type { RoomDomainEvent, RoomManagerDependencies } from '../rooms/roomTypes';

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason: unknown): void;
};

type TimerHandle = { callback: () => void; delayMs: number; active: boolean };
type RoomClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;
type RoomManagerFactory = (onAsyncEvents: (events: RoomDomainEvent[]) => void) => RoomManager<TimerHandle>;
type ActionAck = Ack<Record<string, never>>;
type ResumeResponse = Ack<ResumeAck>;
type Running = { url: string; manager: RoomManager<TimerHandle> };
type Options = { seed?: string; timers?: TimerHandle[] };
type TwoClientGame = {
  url: string;
  host: RoomClient;
  guest: RoomClient;
  hostToken: string;
  guestToken: string;
  manager: RoomManager<TimerHandle>;
  state: GameState;
  sockets: Map<string, RoomClient>;
};
type OfflineActorGame = TwoClientGame & {
  actorId: string;
  actor: RoomClient;
  actorToken: string;
  hostSocket: RoomClient;
};
type Message = 'connection' | 'events' | 'snapshot' | 'ack';
type Recorder = { messages: Message[]; stop(): void };

const EVENT_TIMEOUT_MS = 300;
const chinaMap = getActiveMapPack('china-tour');
const clients: RoomClient[] = [];
const servers: RunningRoomServer<TimerHandle>[] = [];

afterEach(async () => {
  for (const socket of clients.splice(0).reverse()) socket.disconnect();
  for (const server of servers.splice(0).reverse()) await server.close();
});

describe('Socket.IO game reconnect integration', () => {
  test('playing resume returns the authoritative snapshot after connection events without broadcasting a peer snapshot', async () => {
    const game = await startTwoClientGame();
    const actorId = game.state.currentPlayerId;
    const actor = socketFor(game, actorId);
    const peer = otherSocket(game, actor);
    const actorToken = tokenFor(game, actorId);
    const offline = nextConnection(peer, 'offline connection event');
    actor.disconnect();
    await offline;

    const resumed = await connectClient(gameUrl(game));
    const recorder = record(resumed);
    const noPeerSnapshot = expectNoEvent(peer, 'game:snapshot', 'peer snapshot while another player resumes');
    const resume = await emitResume(resumed, { roomCode: '0007', playerId: actorId, token: actorToken }, recorder);
    const authoritative = game.manager.getGameSnapshot('0007');

    expectResumeSuccess(resume);
    expect(authoritative).not.toBeNull();
    if (authoritative === null) throw new Error('missing authoritative game snapshot after resume');
    expect(resume).toMatchObject({
      ok: true,
      room: expect.objectContaining({ roomCode: '0007', status: 'playing' }),
    });
    if (resume.snapshot === undefined) throw new Error('playing resume did not return a snapshot');
    expect(resume.snapshot).not.toHaveProperty('state');
    expect(resume.snapshot.players.find((player) => player.id === actorId)?.online).toBe(true);
    expectPublicGameSnapshot(resume.snapshot, authoritative);
    expect(resume.room.players.find((player) => player.id === actorId)?.online).toBe(true);
    expect(recorder.messages).toEqual(['connection', 'ack']);
    expectNoTokens(resume, [game.hostToken, game.guestToken]);
    await noPeerSnapshot;
    recorder.stop();
  });

  test('lobby resume retains the authoritative public room map and does not include a game snapshot', async () => {
    const running = await startServer();
    const host = await connectClient(running.url);
    const guest = await connectClient(running.url);
    const { create, join } = await createAndJoin(host, guest);
    const hostOffline = nextConnection(host, 'guest lobby offline event');
    guest.disconnect();
    await hostOffline;

    const resumed = await connectClient(running.url);
    const recorder = record(resumed);
    const resume = await emitResume(resumed, {
      roomCode: create.roomCode,
      playerId: join.playerId,
      token: join.token,
    }, recorder);

    expectResumeSuccess(resume);
    expect(resume).toEqual({
      ok: true,
      room: {
        roomCode: '0007',
        status: 'lobby',
        hostId: 'player-host',
        players: [
          { id: 'player-host', nickname: '房主', isBot: false, online: true },
          { id: 'player-guest', nickname: '玩家二', isBot: false, online: true },
        ],
        spectators: [],
        takeoverPlayerId: null,
        map: create.room.map,
      },
    });
    expect('snapshot' in resume).toBe(false);
    expect(recorder.messages).toEqual(['connection', 'ack']);
    expectNoTokens(resume, [create.token, join.token]);
    recorder.stop();
  });

  test('offline takeover schedules one timer, locks a reconnecting actor, and emits its timer transition before completion', async () => {
    const timers: TimerHandle[] = [];
    const game = await startTwoClientGameOfflineActor({ timers });
    const scheduledState = nextRoomState(game.hostSocket, 'takeover lock schedule');
    const skip = await emitSkipOfflineTurn(game.hostSocket);

    expect(skip).toEqual({ ok: true });
    await expect(scheduledState).resolves.toEqual(expect.objectContaining({
      takeoverPlayerId: game.actorId,
    }));
    expect(activeTimers(timers)).toHaveLength(1);
    const timer = activeTimers(timers)[0];
    const resumed = await connectClient(gameUrl(game));
    const resumeRecorder = record(resumed);
    const resume = await emitResume(resumed, {
      roomCode: '0007',
      playerId: game.actorId,
      token: game.actorToken,
    }, resumeRecorder);
    const lockedManual = await emitGameIntent(resumed, { type: 'roll_dice' });

    expectResumeSuccess(resume);
    expect(resume.room.takeoverPlayerId).toBe(game.actorId);
    expect(resume.room.players.find((player) => player.id === game.actorId)?.online).toBe(true);
    expect(resumeRecorder.messages).toEqual(['connection', 'ack']);
    expectFailure(lockedManual, 'INVALID_ROOM_ACTION');
    expect(activeTimers(timers)).toEqual([timer]);

    const hostRecorder = record(game.hostSocket);
    const hostEvents = nextEvents(game.hostSocket, 'offline takeover events for host');
    const actorEvents = nextEvents(resumed, 'offline takeover events for resumed actor');
    const hostSnapshot = nextSnapshot(game.hostSocket, 'offline takeover snapshot for host');
    const actorSnapshot = nextSnapshot(resumed, 'offline takeover snapshot for resumed actor');
    fireTimer(timer);
    const [hostBatch, actorBatch, hostGame, actorGame] = await Promise.all([
      hostEvents,
      actorEvents,
      hostSnapshot,
      actorSnapshot,
    ]);

    expect(hostBatch).toEqual(actorBatch);
    expect(hostGame).toEqual(actorGame);
    expect(hostBatch.events).not.toHaveLength(0);
    expect(hostRecorder.messages).toEqual(['events', 'snapshot']);
    expect(resumeRecorder.messages.slice(-2)).toEqual(['events', 'snapshot']);
    const authoritative = game.manager.getGameSnapshot('0007');
    if (authoritative === null) throw new Error('missing authoritative offline takeover state');
    expectPublicGameSnapshot(hostGame.state as unknown as PublicGameSnapshot, authoritative);
    expect(activeTimers(timers)).toHaveLength(1);

    const clearedState = nextRoomState(game.hostSocket, 'offline takeover completion clears public lock');
    for (let step = 0; step < 8 && game.manager.getPublicRoom('0007')?.takeoverPlayerId !== null; step += 1) {
      const nextTimer = activeTimers(timers)[0];
      if (nextTimer === undefined) throw new Error('takeover stopped before clearing its public lock');
      fireTimer(nextTimer);
      await zeroDelayMacrotask();
    }
    expect(await clearedState).toEqual(expect.objectContaining({ takeoverPlayerId: null }));
    expect(game.manager.getPublicRoom('0007')?.takeoverPlayerId).toBeNull();
    hostRecorder.stop();
    resumeRecorder.stop();
  });

  test('builds resume acknowledgement from state committed before the deferred acknowledgement runs', async () => {
    const timers: TimerHandle[] = [];
    const game = await startTwoClientGameOfflineActor({ timers });
    const beforeResume = game.manager.getGameSnapshot('0007');
    const skip = await emitSkipOfflineTurn(game.hostSocket);
    const [timer] = activeTimers(timers);
    if (timer === undefined) throw new Error('offline takeover did not schedule its deterministic timer');
    const resumed = await connectClient(gameUrl(game));
    const connectionObserved = nextConnection(resumed, 'resumed player connection event');
    expect(skip).toEqual({ ok: true });
    expect(beforeResume).not.toBeNull();

    const deferredZeroTimers: (() => void)[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    function interceptTimeout<TArgs extends unknown[]>(
      callback: (...args: TArgs) => void,
      delay?: number,
      ...args: TArgs
    ): NodeJS.Timeout {
      if (delay === 0) {
        deferredZeroTimers.push(() => callback(...args));
        return 0 as unknown as NodeJS.Timeout;
      }
      return originalSetTimeout(callback, delay, ...args);
    }
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(interceptTimeout);
    let resumePromise: Promise<ResumeResponse> | undefined;
    try {
      resumePromise = emitResume(resumed, {
        roomCode: '0007',
        playerId: game.actorId,
        token: game.actorToken,
      });
      await connectionObserved;
    } finally {
      timeoutSpy.mockRestore();
    }

    expect(deferredZeroTimers).toHaveLength(1);
    const [runDeferredAck] = deferredZeroTimers;
    if (runDeferredAck === undefined || resumePromise === undefined) {
      throw new Error('resume acknowledgement was not deferred');
    }
    let resumeSettled = false;
    void resumePromise.finally(() => {
      resumeSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resumeSettled).toBe(false);

    const transitionEvents = nextEvents(resumed, 'takeover transition events before deferred resume acknowledgement');
    fireTimer(timer);
    const events = await transitionEvents;
    const authoritative = game.manager.getGameSnapshot('0007');
    const publicRoom = game.manager.getPublicRoom('0007');
    runDeferredAck();
    const resume = await resumePromise;

    expectResumeSuccess(resume);
    expect(authoritative).not.toBeNull();
    if (authoritative === null || beforeResume === null) throw new Error('missing authoritative game snapshot for resume freshness');
    expect(events.events).not.toHaveLength(0);
    expect(authoritative.recentLog).not.toEqual(beforeResume.recentLog);
    if (resume.snapshot === undefined) throw new Error('resume acknowledgement did not include a snapshot');
    expect(resume.snapshot.recentLog).toEqual(authoritative.recentLog);
    expectPublicGameSnapshot(resume.snapshot, authoritative);
    expect(resume.room).toEqual(publicRoom);
  });

  test('a BOT-first game emits events then snapshot per fired timer and maintains at most one active timer', async () => {
    const timers: TimerHandle[] = [];
    const game = await startHumanBotGame({ timers });
    const recorder = record(game.host);
    const batches: { events: GameEvent[] }[] = [];
    const collectBatch = (payload: { events: GameEvent[] }) => batches.push(payload);
    game.host.on('game:events', collectBatch);
    const initialTimers = activeTimers(timers);

    expect(initialTimers).toHaveLength(1);
    const actionBatch = nextEvents(game.host, 'BOT action batch after its timer fires');
    const actionSnapshot = nextSnapshot(game.host, 'BOT snapshot after its timer fires');
    fireTimer(initialTimers[0]);
    const [batch, snapshot] = await Promise.all([actionBatch, actionSnapshot]);
    await expectNoEvent(game.host, 'game:events', 'second BOT action batch from one timer');

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(batch);
    expect(batch.events).not.toHaveLength(0);
    expect(recorder.messages).toEqual(['events', 'snapshot']);
    const authoritative = game.manager.getGameSnapshot('0007');
    if (authoritative === null) throw new Error('missing authoritative BOT state');
    expectPublicGameSnapshot(snapshot.state as unknown as PublicGameSnapshot, authoritative);
    expect(activeTimers(timers)).toHaveLength(1);
    game.host.off('game:events', collectBatch);
    recorder.stop();
  });

  test('replacement socket makes the player and game state online while a stale disconnect emits no false offline event', async () => {
    const game = await startTwoClientGame();
    const actorId = game.state.currentPlayerId;
    const original = socketFor(game, actorId);
    const peer = otherSocket(game, original);
    const replacement = await connectClient(gameUrl(game));
    const noOffline = expectNoConnection(peer, 'offline event from stale replacement socket');
    const resume = await emitResume(replacement, {
      roomCode: '0007',
      playerId: actorId,
      token: tokenFor(game, actorId),
    });
    original.disconnect();
    await zeroDelayMacrotask();
    const publicRoom = game.manager.getPublicRoom('0007');
    const snapshot = game.manager.getGameSnapshot('0007');

    expectResumeSuccess(resume);
    expect(publicRoom?.players.find((player) => player.id === actorId)?.online).toBe(true);
    expect(snapshot?.players.find((player) => player.id === actorId)?.online).toBe(true);
    await noOffline;
  });
});

async function startTwoClientGame(options: Options = {}): Promise<TwoClientGame> {
  const running = await startServer(options);
  const host = await connectClient(running.url);
  const guest = await connectClient(running.url);
  const { create, join } = await createAndJoin(host, guest);
  const hostSnapshot = nextSnapshot(host, 'host opening snapshot');
  const guestSnapshot = nextSnapshot(guest, 'guest opening snapshot');
  const started = await emitStart(host);
  const [hostGame, guestGame] = await Promise.all([hostSnapshot, guestSnapshot]);

  expect(started).toEqual({ ok: true });
  expect(hostGame).toEqual(guestGame);
  return {
    url: running.url,
    host,
    guest,
    hostToken: create.token,
    guestToken: join.token,
    manager: running.manager,
    state: hostGame.state,
    sockets: new Map([
      ['player-host', host],
      ['player-guest', guest],
    ]),
  };
}

async function startTwoClientGameOfflineActor(options: Options): Promise<OfflineActorGame> {
  const game = await startTwoClientGame(options);
  const state = game.state.currentPlayerId === 'player-host'
    ? await advanceSocketTurn(game.host, game.manager, game.state)
    : game.state;
  const actorId = state.currentPlayerId;
  const actor = socketFor(game, actorId);
  const hostSocket = game.host;
  if (actor === hostSocket) throw new Error('offline takeover fixture requires guest to be current actor');
  const offline = nextConnection(hostSocket, 'offline actor event before takeover request');
  actor.disconnect();
  await offline;
  return { ...game, state, actorId, actor, actorToken: tokenFor(game, actorId), hostSocket };
}

async function startHumanBotGame(options: Options): Promise<TwoClientGame> {
  const seed = seedWithBotFirstSocket();
  const running = await startServer({ ...options, seed });
  const host = await connectClient(running.url);
  const create = await emitRoomAck(host, 'room:create', {
    mapId: 'china-tour', nickname: '房主',
    requestId: '1234567890abcdef1234567890abcdef',
  });
  expectCreateSuccess(create);
  expect(await emitAddBot(host)).toEqual({ ok: true });
  const snapshot = nextSnapshot(host, 'human-and-BOT opening snapshot');
  expect(await emitStart(host)).toEqual({ ok: true });
  const opening = await snapshot;
  expect(opening.state.currentPlayerId).toBe('player-guest');
  return {
    url: running.url,
    host,
    guest: host,
    hostToken: create.token,
    guestToken: '',
    manager: running.manager,
    state: opening.state,
    sockets: new Map([
      ['player-host', host],
      ['player-guest', host],
    ]),
  };
}

function seedWithBotFirstSocket(): string {
  for (let index = 0; index < 5_000; index += 1) {
    const seed = `socket-reconnect-${index}`;
    const state = createGame({
      mapRef: chinaMap.ref,
      ruleModules: chinaMap.game.requiredRuleModules,
      board: chinaMap.game.board,
      cards: chinaMap.game.cards,
      config: chinaMap.game.config,
      players: [
        { id: 'player-host', nickname: '房主', isBot: false },
        { id: 'player-guest', nickname: '电脑 A', isBot: true },
      ],
      seed,
      cashGoal: null,
    });
    if (state.currentPlayerId === 'player-guest') return seed;
  }
  throw new Error('No bounded deterministic seed can produce the BOT-first socket fixture');
}

async function startServer(options: Options = {}): Promise<Running> {
  let manager: RoomManager<TimerHandle> | undefined;
  const server = createRoomServer<TimerHandle>({
    roomManagerFactory: deterministicFactory(options, (captured) => {
      manager = captured;
    }),
  });
  servers.push(server);
  await listen(server.httpServer);
  const address = server.httpServer.address();
  if (address === null || typeof address === 'string' || manager === undefined) {
    throw new Error('test server did not start');
  }
  return { url: `http://127.0.0.1:${(address as AddressInfo).port}`, manager };
}

function deterministicFactory(options: Options, capture: (manager: RoomManager<TimerHandle>) => void): RoomManagerFactory {
  let player = 0;
  let token = 0;
  return (onAsyncEvents) => {
    const dependencies: RoomManagerDependencies<TimerHandle> = {
      generatePlayerId: () => ['player-host', 'player-guest', 'player-bot'][player++] ?? `player-${player}`,
      generateToken: () => ['token-host', 'token-guest'][token++] ?? `token-${token}`,
      nextRoomNumber: () => 7,
      compareTokens: (actual, supplied) => actual === supplied,
      setTimer(callback, delayMs) {
        const handle = { callback, delayMs, active: true };
        options.timers?.push(handle);
        return handle;
      },
      clearTimer(handle) {
        handle.active = false;
      },
      onAsyncEvents,
      generateGameSeed: () => options.seed ?? 'socket-reconnect-default',
      nextAutomationDelayMs: () => 1_000,
    };
    const manager = new RoomManager(dependencies);
    capture(manager);
    return manager;
  };
}

async function listen(server: HttpServer): Promise<void> {
  const deferred = createDeferred<void>();
  const onError = (error: Error) => {
    server.off('error', onError);
    deferred.reject(error);
  };
  server.once('error', onError);
  server.listen(0, '127.0.0.1', () => {
    server.off('error', onError);
    deferred.resolve();
  });
  await deferred.promise;
}

async function connectClient(url: string): Promise<RoomClient> {
  const socket: RoomClient = connectSocket(url, { forceNew: true, reconnection: false, transports: ['websocket'] });
  clients.push(socket);
  const deferred = createDeferred<void>();
  socket.once('connect', deferred.resolve);
  socket.once('connect_error', deferred.reject);
  await withTimeout(deferred.promise, 'Socket.IO connection');
  return socket;
}

async function createAndJoin(host: RoomClient, guest: RoomClient): Promise<{ create: CreateRoomAck; join: JoinRoomAck }> {
  const create = await emitRoomAck(host, 'room:create', {
    mapId: 'china-tour', nickname: '房主',
    requestId: '00112233445566778899aabbccddeeff',
  });
  const join = await emitRoomAck(guest, 'room:join', {
    roomCode: '0007',
    nickname: '玩家二',
    requestId: 'ffeeddccbbaa99887766554433221100',
  });
  expectCreateSuccess(create);
  expectJoinSuccess(join);
  return { create, join };
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
  const deferred = createDeferred<Ack<CreateRoomAck> | Ack<JoinRoomAck>>();
  if (event === 'room:create') socket.emit(event, payload as { nickname: string; mapId: string; requestId: string }, deferred.resolve);
  else socket.emit(event, { role: "player" as const, ...(payload as { roomCode: string; nickname: string; requestId: string; role?: "player" | "spectator" }) }, deferred.resolve);
  return withTimeout(deferred.promise, `${event} acknowledgement`);
}

function emitStart(socket: RoomClient): Promise<ActionAck> {
  const deferred = createDeferred<ActionAck>();
  socket.emit('room:start', deferred.resolve);
  return withTimeout(deferred.promise, 'room:start acknowledgement');
}

function emitAddBot(socket: RoomClient): Promise<ActionAck> {
  const deferred = createDeferred<ActionAck>();
  socket.emit('room:add_bot', deferred.resolve);
  return withTimeout(deferred.promise, 'room:add_bot acknowledgement');
}

function emitResume(
  socket: RoomClient,
  payload: { roomCode: string; playerId: string; token: string },
  recorder?: Recorder,
): Promise<ResumeResponse> {
  const deferred = createDeferred<ResumeResponse>();
  socket.emit('session:resume', payload, (response) => {
    const snapshot: ResumeAck['snapshot'] | undefined = response.ok ? response.snapshot : undefined;
    void snapshot;
    recorder?.messages.push('ack');
    deferred.resolve(response);
  });
  return withTimeout(deferred.promise, 'session:resume acknowledgement');
}

function emitSkipOfflineTurn(socket: RoomClient): Promise<ActionAck> {
  const deferred = createDeferred<ActionAck>();
  socket.emit('room:skip_offline_turn', deferred.resolve);
  return withTimeout(deferred.promise, 'room:skip_offline_turn acknowledgement');
}

function emitGameIntent(socket: RoomClient, intent: Intent): Promise<ActionAck> {
  const deferred = createDeferred<ActionAck>();
  socket.emit('game:intent', { intent }, deferred.resolve);
  return withTimeout(deferred.promise, 'game:intent acknowledgement');
}

function nextSnapshot(socket: RoomClient, label: string): Promise<{ state: GameState }> {
  return nextEvent(socket, 'game:snapshot', label);
}

function nextEvents(socket: RoomClient, label: string): Promise<{ events: GameEvent[] }> {
  return nextEvent(socket, 'game:events', label);
}

function nextRoomState(socket: RoomClient, label: string): Promise<PublicRoomState> {
  return nextEvent(socket, 'room:state', label);
}

function nextConnection(socket: RoomClient, label: string): Promise<{ playerId: string; online: boolean }> {
  return nextEvent(socket, 'player:connection', label);
}

function nextEvent<T>(socket: RoomClient, event: 'game:snapshot' | 'game:events' | 'player:connection' | 'room:state', label: string): Promise<T> {
  const deferred = createDeferred<T>();
  socket.once(event, deferred.resolve as never);
  return withTimeout(deferred.promise, label);
}

function record(socket: RoomClient): Recorder {
  const messages: Message[] = [];
  const onConnection = () => messages.push('connection');
  const onEvents = () => messages.push('events');
  const onSnapshot = () => messages.push('snapshot');
  socket.on('player:connection', onConnection);
  socket.on('game:events', onEvents);
  socket.on('game:snapshot', onSnapshot);
  return {
    messages,
    stop() {
      socket.off('player:connection', onConnection);
      socket.off('game:events', onEvents);
      socket.off('game:snapshot', onSnapshot);
    },
  };
}



function expectNoEvent(socket: RoomClient, event: 'game:snapshot' | 'game:events', label: string): Promise<void> {
  const deferred = createDeferred<void>();
  const listener = (payload: unknown) => {
    clearTimeout(timeout);
    socket.off(event, listener);
    deferred.reject(new Error(`Expected no ${label}, received ${JSON.stringify(payload)}`));
  };
  const timeout = setTimeout(() => {
    socket.off(event, listener);
    deferred.resolve();
  }, EVENT_TIMEOUT_MS);
  socket.once(event, listener);
  return deferred.promise;
}

function expectNoConnection(socket: RoomClient, label: string): Promise<void> {
  const deferred = createDeferred<void>();
  const listener = (payload: unknown) => {
    clearTimeout(timeout);
    socket.off('player:connection', listener);
    deferred.reject(new Error(`Expected no ${label}, received ${JSON.stringify(payload)}`));
  };
  const timeout = setTimeout(() => {
    socket.off('player:connection', listener);
    deferred.resolve();
  }, EVENT_TIMEOUT_MS);
  socket.once('player:connection', listener);
  return deferred.promise;
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  const deferred = createDeferred<never>();
  const timeout = setTimeout(() => deferred.reject(new Error(`Timed out waiting for ${label}`)), EVENT_TIMEOUT_MS);
  return Promise.race([promise, deferred.promise]).finally(() => clearTimeout(timeout));
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function advanceSocketTurn(socket: RoomClient, manager: RoomManager<TimerHandle>, initial: GameState): Promise<GameState> {
  let state = initial;
  for (let step = 0; step < 8; step += 1) {
    const intent = intentFor(state.turnPhase);
    const ack = await emitGameIntent(socket, intent);
    expect(ack).toEqual({ ok: true });
    const next = manager.getGameSnapshot('0007');
    if (next === null) throw new Error('missing authoritative game state while advancing a turn');
    if (next.currentPlayerId !== initial.currentPlayerId) return next;
    state = next;
  }
  throw new Error('did not reach the next player within a bounded normal turn');
}

function intentFor(turnPhase: GameState['turnPhase']): Intent {
  switch (turnPhase) {
    case 'awaiting_roll':
      return { type: 'roll_dice' };
    case 'awaiting_airport_roll':
      return { type: 'roll_airport_branch' };
    case 'awaiting_buy_decision':
      return { type: 'skip_buy' };
    case 'awaiting_build_decision':
      return { type: 'skip_build' };
    case 'managing':
      return { type: 'end_turn' };
  }
}

async function zeroDelayMacrotask(): Promise<void> {
  const deferred = createDeferred<void>();
  setTimeout(deferred.resolve, 0);
  await deferred.promise;
}

function socketFor(game: TwoClientGame, playerId: string): RoomClient {
  const socket = game.sockets.get(playerId);
  if (socket === undefined) throw new Error(`missing socket for ${playerId}`);
  return socket;
}

function otherSocket(game: TwoClientGame, socket: RoomClient): RoomClient {
  return socket === game.host ? game.guest : game.host;
}

function tokenFor(game: TwoClientGame, playerId: string): string {
  if (playerId === 'player-host') return game.hostToken;
  if (playerId === 'player-guest') return game.guestToken;
  throw new Error(`missing token for ${playerId}`);
}

function gameUrl(game: TwoClientGame): string {
  return game.url;
}

function activeTimers(timers: TimerHandle[]): TimerHandle[] {
  return timers.filter((timer) => timer.active);
}

function fireTimer(timer: TimerHandle): void {
  if (!timer.active) throw new Error('cannot fire an inactive timer');
  timer.active = false;
  timer.callback();
}

function expectCreateSuccess(response: Ack<CreateRoomAck>): asserts response is { ok: true } & CreateRoomAck {
  expect(response.ok).toBe(true);
  if (!response.ok) throw new Error(`room:create failed: ${response.code}`);
}

function expectJoinSuccess(response: Ack<JoinRoomAck>): asserts response is { ok: true } & JoinRoomAck {
  expect(response.ok).toBe(true);
  if (!response.ok) throw new Error(`room:join failed: ${response.code}`);
}

function expectResumeSuccess(response: ResumeResponse): asserts response is { ok: true } & ResumeAck {
  expect(response.ok).toBe(true);
  if (!response.ok) throw new Error(`session:resume failed: ${response.code}`);
}

function expectFailure(response: ActionAck, code: string): asserts response is Extract<ActionAck, { ok: false }> {
  expect(response.ok).toBe(false);
  if (response.ok) throw new Error(`expected ${code}, got success`);
  expect(response.code).toBe(code);
}

function expectNoTokens(value: unknown, tokens: string[]): void {
  const serialized = JSON.stringify(value);
  for (const token of tokens) expect(serialized).not.toContain(token);
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
