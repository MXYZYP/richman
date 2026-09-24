import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { MapPack, MapRef } from '@richman/board-data';
import { worldTourMap } from '@richman/board-data';
import board from '../../../../packages/board-data/maps/__test__/test-map-v1/board.json';
import cards from '../../../../packages/board-data/maps/__test__/test-map-v1/cards.json';
import config from '../../../../packages/board-data/maps/__test__/test-map-v1/game-config.json';
import manifest from '../../../../packages/board-data/maps/__test__/test-map-v1/manifest.json';
import { createGame } from '@richman/engine';
import type { GameEvent, GameState, Intent } from '@richman/engine';
import type {
  Ack,
  ClientToServerEvents,
  CreateRoomAck,
  JoinRoomAck,
  PublicGameSnapshot,
  ResumeAck,
  ServerToClientEvents,
} from '@richman/protocol';
import { io as connectSocket, type Socket as ClientSocket } from 'socket.io-client';
import { toPublicGameSnapshot } from '../publicGameSnapshot';
import { defaultGameGateway, type GameRuntimeGateway } from '../game/gameRuntime';
import { RoomManager } from '../rooms/roomManager';
import type { RoomManagerDependencies } from '../rooms/roomTypes';
import { createRoomServer, type RunningRoomServer } from '../server';

const fixtureManifest = manifest as unknown as Pick<MapPack, 'ref' | 'metadata' | 'presentation'> & {
  readonly requiredRuleModules: MapPack['game']['requiredRuleModules'];
};

const testMap = {
  ref: fixtureManifest.ref,
  metadata: fixtureManifest.metadata,
  game: {
    board: board as MapPack['game']['board'],
    cards: cards as MapPack['game']['cards'],
    config: config as unknown as MapPack['game']['config'],
    requiredRuleModules: fixtureManifest.requiredRuleModules,
  },
  presentation: fixtureManifest.presentation,
} satisfies MapPack;

const REQUEST_ID = '00112233445566778899aabbccddeeff';
const clients: Array<ClientSocket<ServerToClientEvents, ClientToServerEvents>> = [];
const servers: Array<RunningRoomServer<unknown>> = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  for (const server of servers.splice(0)) await server.close();
});

type MapResolver = {
  getActiveMapPack(mapId: string): MapPack;
  getMapPack(mapRef: MapRef): MapPack;
};

function createDependencies(mapResolver: MapResolver): RoomManagerDependencies {
  let roomNumber = 7;
  let playerNumber = 0;
  const dependencies = {
    generatePlayerId: () => `player-${playerNumber++}`,
    generateToken: () => `token-${playerNumber}`,
    nextRoomNumber: () => roomNumber++,
    compareTokens: (actual: string, supplied: string) => actual === supplied,
    setTimer: () => ({ timer: true }),
    clearTimer: () => undefined,
    onAsyncEvents: () => undefined,
    generateGameSeed: () => 'phase-3-seed',
    nextAutomationDelayMs: () => 1_000,
    mapResolver,
  };
  return dependencies;
}

async function startServer(mapResolver: MapResolver, gameGateway?: GameRuntimeGateway): Promise<string> {
  const server = createRoomServer({
    rateLimit: false,
    roomManagerFactory(onAsyncEvents) {
      return new RoomManager({ ...createDependencies(mapResolver), onAsyncEvents, gameGateway });
    },
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const address = server.httpServer.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function connectClient(url: string): Promise<ClientSocket<ServerToClientEvents, ClientToServerEvents>> {
  const socket = connectSocket(url, { transports: ['websocket'], reconnection: false });
  clients.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

function emitCreate(
  socket: ClientSocket<ServerToClientEvents, ClientToServerEvents>,
  payload: { nickname: string; mapId: string; requestId: string },
): Promise<Ack<CreateRoomAck>> {
  return new Promise((resolve) => socket.emit('room:create', payload, resolve));
}

function emitMalformedCreate(
  socket: ClientSocket<ServerToClientEvents, ClientToServerEvents>,
  payload: unknown,
): Promise<Ack<CreateRoomAck>> {
  const untypedSocket = socket as unknown as {
    emit(
      event: 'room:create',
      value: unknown,
      ack: (result: Ack<CreateRoomAck>) => void,
    ): void;
  };
  return new Promise((resolve) => untypedSocket.emit('room:create', payload, resolve));
}

function emitJoin(
  socket: ClientSocket<ServerToClientEvents, ClientToServerEvents>,
  payload: { roomCode: string; nickname: string; requestId: string; role?: "player" | "spectator" },
): Promise<Ack<JoinRoomAck>> {
  return new Promise((resolve) => socket.emit('room:join', { role: 'player', ...payload }, resolve));
}

function emitStart(
  socket: ClientSocket<ServerToClientEvents, ClientToServerEvents>,
): Promise<Ack<Record<string, never>>> {
  return new Promise((resolve) => socket.emit('room:start', resolve));
}

function emitResume(
  socket: ClientSocket<ServerToClientEvents, ClientToServerEvents>,
  payload: { roomCode: string; playerId: string; token: string },
): Promise<Ack<ResumeAck>> {
  return new Promise((resolve) => socket.emit('session:resume', payload, resolve));
}

function emitGameIntent(
  socket: ClientSocket<ServerToClientEvents, ClientToServerEvents>,
  intent: Intent,
): Promise<Ack<Record<string, never>>> {
  return new Promise((resolve) => socket.emit('game:intent', { intent }, resolve));
}

function nextSnapshot(
  socket: ClientSocket<ServerToClientEvents, ClientToServerEvents>,
): Promise<{ state: PublicGameSnapshot }> {
  return new Promise((resolve) => socket.once('game:snapshot', resolve));
}

function expectSuccess<T extends { ok: boolean }>(result: T): asserts result is T & { ok: true } {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected success');
}

describe('Phase 3 authoritative map locking', () => {
  test('locks the active exact ref, publishes only its safe summary, and starts from exact resolution', () => {
    let activeLookupAllowed = true;
    const getActiveMapPack = vi.fn((mapId: string) => {
      if (!activeLookupAllowed || mapId !== testMap.ref.id) throw new Error('Inactive map');
      return testMap;
    });
    const getMapPack = vi.fn((ref: MapRef) => {
      if (
        ref.id !== testMap.ref.id
        || ref.version !== testMap.ref.version
        || ref.contentHash !== testMap.ref.contentHash
      ) {
        throw new Error('Unknown exact map');
      }
      return testMap;
    });
    const manager = new RoomManager(createDependencies({ getActiveMapPack, getMapPack }));

    const created = manager.createRoom('房主', testMap.ref.id, REQUEST_ID);
    expectSuccess(created);
    expect(created.value.room).toMatchObject({
      map: { ref: testMap.ref, title: testMap.metadata.title },
    });

    const joined = manager.joinRoom(created.value.roomCode, '访客');
    expectSuccess(joined);
    activeLookupAllowed = false;

    const started = manager.startRoom(created.value.roomCode, created.value.playerId);
    expectSuccess(started);
    expect(getActiveMapPack).toHaveBeenCalledTimes(1);
    expect(getMapPack).toHaveBeenCalledWith(testMap.ref);

    const state = manager.getGameSnapshot(created.value.roomCode);
    expect(state?.mapRef).toEqual(testMap.ref);
    expect(state?.ruleModules).toEqual(testMap.game.requiredRuleModules);
    expect(state?.board.cells).toHaveLength(8);
    expect(manager.getPublicRoom(created.value.roomCode)).toMatchObject({
      map: { ref: testMap.ref, title: testMap.metadata.title },
    });
  });

  test('rejects unavailable map ids without allocating a room', () => {
    const getActiveMapPack = vi.fn(() => {
      throw new Error('Inactive map');
    });
    const manager = new RoomManager(createDependencies({
      getActiveMapPack,
      getMapPack: () => testMap,
    }));

    const rejected = manager.createRoom('房主', 'missing-map', REQUEST_ID);
    expect(rejected).toMatchObject({
      ok: false,
      code: 'INVALID_ROOM_ACTION',
      message: expect.stringMatching(/map.*unavailable/i),
    });
    expect(manager.getPublicRoom('000007')).toBeNull();
  });

  test('same create requestId cannot replay a different map choice', () => {
    const chinaRef = {
      id: 'china-tour',
      version: 1,
      contentHash: 'a'.repeat(64),
    } satisfies MapRef;
    const chinaMap = {
      ...testMap,
      ref: chinaRef,
      metadata: { ...testMap.metadata, title: 'China Tour' },
    } satisfies MapPack;
    const manager = new RoomManager(createDependencies({
      getActiveMapPack: (mapId) => {
        if (mapId === chinaRef.id) return chinaMap;
        if (mapId === testMap.ref.id) return testMap;
        throw new Error('Inactive map');
      },
      getMapPack: () => chinaMap,
    }));

    const first = manager.createRoom('房主', chinaRef.id, REQUEST_ID);
    expectSuccess(first);
    const mismatch = manager.createRoom('房主', testMap.ref.id, REQUEST_ID);

    expect(mismatch).toMatchObject({ ok: false, code: 'INVALID_ROOM_ACTION' });
    expect(manager.getPublicRoom('000008')).toBeNull();
  });

  test('rejects an exact resolver result whose ref differs from the room lock', () => {
    const mismatchedMap = {
      ...testMap,
      ref: { ...testMap.ref, contentHash: 'e'.repeat(64) },
    } satisfies MapPack;
    const onServerError = vi.fn();
    const manager = new RoomManager({
      ...createDependencies({
        getActiveMapPack: () => testMap,
        getMapPack: () => mismatchedMap,
      }),
      onServerError,
    });

    const created = manager.createRoom('房主', testMap.ref.id, REQUEST_ID);
    expectSuccess(created);
    expectSuccess(manager.joinRoom(created.value.roomCode, '访客'));

    expect(manager.startRoom(created.value.roomCode, created.value.playerId)).toMatchObject({
      ok: false,
      code: 'INVALID_ROOM_ACTION',
    });
    expect(manager.getGameSnapshot(created.value.roomCode)).toBeNull();
    expect(onServerError).toHaveBeenCalledWith(
      'startRoom exact map resolution returned a mismatched ref',
      expect.any(Error),
    );
  });

  test('bot and offline-takeover automation retain the test-only exact map identity', () => {
    type TestTimer = { active: boolean; run(): void };
    const resolver: MapResolver = {
      getActiveMapPack: () => testMap,
      getMapPack: () => testMap,
    };
    const createAutomationManager = (actorId: string) => {
      const timers: TestTimer[] = [];
      const asyncSnapshots: PublicGameSnapshot[] = [];
      const dependencies: RoomManagerDependencies<TestTimer> = {
        ...createDependencies(resolver),
        setTimer(callback: () => void): TestTimer {
          const timer: TestTimer = {
            active: true,
            run() {
              if (!timer.active) return;
              timer.active = false;
              callback();
            },
          };
          timers.push(timer);
          return timer;
        },
        clearTimer(timer: TestTimer) {
          timer.active = false;
        },
        onAsyncEvents(events: Parameters<RoomManagerDependencies['onAsyncEvents']>[0]) {
          for (const event of events) {
            if (event.type === 'game_snapshot') asyncSnapshots.push(toPublicGameSnapshot(event.state));
          }
        },
        gameGateway: {
          ...defaultGameGateway,
          createGame(input: Parameters<typeof defaultGameGateway.createGame>[0]) {
            return { ...defaultGameGateway.createGame(input), currentPlayerId: actorId };
          },
        },
      };
      return { manager: new RoomManager<TestTimer>(dependencies), timers, asyncSnapshots };
    };

    const botHarness = createAutomationManager('player-1');
    const botRoom = botHarness.manager.createRoom('房主', testMap.ref.id);
    expectSuccess(botRoom);
    expectSuccess(botHarness.manager.addBot(botRoom.value.roomCode, botRoom.value.playerId));
    expectSuccess(botHarness.manager.startRoom(botRoom.value.roomCode, botRoom.value.playerId));
    botHarness.timers.find((timer) => timer.active)?.run();
    expect(botHarness.manager.getGameSnapshot(botRoom.value.roomCode)).toMatchObject({
      mapRef: testMap.ref,
      lastDice: expect.any(Array),
    });
    expect(botHarness.asyncSnapshots).not.toHaveLength(0);
    expect(botHarness.asyncSnapshots.every((snapshot) => (
      snapshot.mapRef.id === testMap.ref.id
      && snapshot.mapRef.version === testMap.ref.version
      && snapshot.mapRef.contentHash === testMap.ref.contentHash
    ))).toBe(true);

    const takeoverHarness = createAutomationManager('player-1');
    const takeoverRoom = takeoverHarness.manager.createRoom('房主', testMap.ref.id);
    expectSuccess(takeoverRoom);
    const guest = takeoverHarness.manager.joinRoom(takeoverRoom.value.roomCode, '访客');
    expectSuccess(guest);
    expectSuccess(takeoverHarness.manager.startRoom(takeoverRoom.value.roomCode, takeoverRoom.value.playerId));
    expectSuccess(takeoverHarness.manager.markDisconnected(takeoverRoom.value.roomCode, guest.value.playerId));
    expectSuccess(takeoverHarness.manager.requestSkipOfflineTurn(takeoverRoom.value.roomCode, takeoverRoom.value.playerId));
    // markDisconnected 会先排一个 15s「自动托管宽限」计时器；取最新一个活跃计时器才是真正的托管自动化。
    takeoverHarness.timers.filter((timer) => timer.active).at(-1)?.run();
    expect(takeoverHarness.manager.getGameSnapshot(takeoverRoom.value.roomCode)).toMatchObject({
      mapRef: testMap.ref,
      lastDice: expect.any(Array),
    });
    expect(takeoverHarness.asyncSnapshots).not.toHaveLength(0);
    expect(takeoverHarness.asyncSnapshots.every((snapshot) => (
      snapshot.mapRef.id === testMap.ref.id
      && snapshot.mapRef.version === testMap.ref.version
      && snapshot.mapRef.contentHash === testMap.ref.contentHash
    ))).toBe(true);
  });

  test('offline takeover plays out a World Tour airport wait and hands the turn back on', () => {
    type TestTimer = { active: boolean; run(): void };
    const timers: TestTimer[] = [];
    const asyncSnapshots: PublicGameSnapshot[] = [];
    const actorId = 'player-1';
    const resolver: MapResolver = {
      getActiveMapPack: () => worldTourMap,
      getMapPack: () => worldTourMap,
    };
    const manager = new RoomManager<TestTimer>({
      ...createDependencies(resolver),
      setTimer(callback: () => void): TestTimer {
        const timer: TestTimer = {
          active: true,
          run() {
            if (!timer.active) return;
            timer.active = false;
            callback();
          },
        };
        timers.push(timer);
        return timer;
      },
      clearTimer(timer) { timer.active = false; },
      onAsyncEvents(events) {
        for (const event of events) {
          if (event.type === 'game_snapshot') asyncSnapshots.push(toPublicGameSnapshot(event.state));
        }
      },
      gameGateway: {
        ...defaultGameGateway,
        createGame(input) {
          const state = defaultGameGateway.createGame(input);
          const optionId = `world-tour@1:airport-entry:${actorId}:10:${state.turn}`;
          return {
            ...state,
            currentPlayerId: actorId,
            players: state.players.map((player) => (
              player.id === actorId ? { ...player, position: 10 } : player
            )),
            publicRuleState: {
              modules: {
                'world-tour@1': {
                  pendingAirportByPlayerId: { [actorId]: 10 },
                  branchAirportByPlayerId: {},
                  tollImmunityPlayerIds: [],
                },
              },
              pendingActions: [{
                optionId,
                module: { id: 'world-tour', version: 1 },
                playerId: actorId,
                requiredPhase: 'awaiting_roll',
                label: '掷骰子',
                action: 'enter-airport-branch',
                payload: { optionId, airportCellId: 10 },
              }],
            },
          };
        },
      },
    });

    const room = manager.createRoom('房主', worldTourMap.ref.id);
    expectSuccess(room);
    const guest = manager.joinRoom(room.value.roomCode, '访客');
    expectSuccess(guest);
    expect(guest.value.playerId).toBe(actorId);
    expectSuccess(manager.startRoom(room.value.roomCode, room.value.playerId));
    expectSuccess(manager.markDisconnected(room.value.roomCode, actorId));
    const before = manager.getGameSnapshot(room.value.roomCode)!;
    expectSuccess(manager.requestSkipOfflineTurn(room.value.roomCode, room.value.playerId));

    // 托管开始的第一拍必须真的推进：掷出支线骰、棋子离开机场格、消费掉机场待选项。
    // （历史缺陷：这里曾返回 null 走「跳过回合」，于是离线玩家永远停在机场格、被每回合跳过，
    //   对局永不收敛——整局冒烟实测回合数到 626 仍未终局，并会演变成静默硬冻结。）
    const takeoverTick = timers.filter((timer) => timer.active).at(-1);
    expect(takeoverTick).toBeDefined();
    takeoverTick?.run();
    const afterTakeover = manager.getGameSnapshot(room.value.roomCode)!;

    expect(afterTakeover.seed).not.toEqual(before.seed);
    expect(afterTakeover.lastDice).not.toBeNull();
    expect(afterTakeover.players.find((player) => player.id === actorId)?.position).not.toBe(10);
    expect(afterTakeover.publicRuleState.pendingActions).toEqual([]);
    expect(afterTakeover.publicRuleState.modules['world-tour@1']).toMatchObject({
      pendingAirportByPlayerId: {},
      branchAirportByPlayerId: { [actorId]: 10 },
    });

    // 回合必须有界地交回在线房主：绝不允许离线玩家被无限跳过。
    const hostId = room.value.playerId;
    let handedOver = false;
    for (let tick = 0; tick < 8 && !handedOver; tick += 1) {
      const next = timers.filter((timer) => timer.active).at(-1);
      if (next === undefined) break;
      next.run();
      handedOver = manager.getGameSnapshot(room.value.roomCode)!.currentPlayerId === hostId;
    }
    expect(handedOver).toBe(true);

    const after = manager.getGameSnapshot(room.value.roomCode)!;
    expect(after.currentPlayerId).toBe(hostId);
    expect(after.turn).toBeGreaterThan(before.turn);
    expect(after.publicRuleState.pendingActions).toEqual([]);
    // 公开快照与权威状态保持一致（异步广播不得落后于权威状态）。
    expect(asyncSnapshots.at(-1)?.publicRuleState).toEqual(after.publicRuleState);
  });
});

describe('Phase 3 public snapshot allowlist', () => {
  test('serializes exactly the approved public runtime fields', () => {
    const state = createGame({
      mapRef: testMap.ref,
      ruleModules: testMap.game.requiredRuleModules,
      board: testMap.game.board,
      cards: testMap.game.cards,
      config: testMap.game.config,
      players: [
        { id: 'player-a', nickname: 'A' },
        { id: 'player-b', nickname: 'B' },
      ],
      seed: 'snapshot-seed',
    });

    const snapshot = toPublicGameSnapshot(state);

    expect(Object.keys(snapshot).sort()).toEqual([
      'auctionOnDecline',
      'cashGoal',
      'currentPlayerId',
      'debt',
      'deckCounts',
      'lastDice',
      'mapRef',
      'pendingAuction',
      'pendingTrade',
      'phase',
      'players',
      'properties',
      'publicRuleState',
      'recentLog',
      'turn',
      'turnPhase',
      'winnerId',
    ].sort());
    expect(snapshot.mapRef).toEqual(testMap.ref);
    expect(snapshot.publicRuleState).toEqual(state.publicRuleState);
    expect(snapshot.deckCounts).toEqual({
      chance: state.decks.chance.length,
      destiny: state.decks.destiny.length,
    });
    expect(snapshot).not.toHaveProperty('seed');
    expect(snapshot).not.toHaveProperty('decks');
    expect(snapshot).not.toHaveProperty('board');
    expect(snapshot).not.toHaveProperty('cards');
    expect(snapshot).not.toHaveProperty('config');
    expect(snapshot).not.toHaveProperty('ruleModules');
  });
});

describe('Phase 3 real Socket.IO map flow', () => {
  test('create, start, and reconnect preserve the test-only exact map without private snapshot data', async () => {
    let activeLookupAllowed = true;
    const resolver: MapResolver = {
      getActiveMapPack(mapId) {
        if (!activeLookupAllowed || mapId !== testMap.ref.id) throw new Error('Inactive map');
        return testMap;
      },
      getMapPack(ref) {
        if (
          ref.id !== testMap.ref.id
          || ref.version !== testMap.ref.version
          || ref.contentHash !== testMap.ref.contentHash
        ) throw new Error('Unknown exact map');
        return testMap;
      },
    };
    const url = await startServer(resolver);
    const host = await connectClient(url);
    const guest = await connectClient(url);

    const created = await emitCreate(host, {
      nickname: '房主',
      mapId: testMap.ref.id,
      requestId: REQUEST_ID,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.message);
    expect(created.room.map).toEqual({ ref: testMap.ref, title: testMap.metadata.title });

    const joined = await emitJoin(guest, {
      roomCode: created.roomCode,
      nickname: '访客',
      requestId: '11223344556677889900aabbccddeeff',
    });
    expect(joined.ok).toBe(true);
    if (!joined.ok) throw new Error(joined.message);
    expect(joined.room.map.ref).toEqual(testMap.ref);

    activeLookupAllowed = false;
    const snapshotPromise = nextSnapshot(host);
    const started = await emitStart(host);
    expect(started).toEqual({ ok: true });
    const snapshot = (await snapshotPromise).state;
    expect(snapshot.mapRef).toEqual(testMap.ref);
    expect(Object.keys(snapshot).sort()).toEqual([
      'auctionOnDecline', 'cashGoal', 'currentPlayerId', 'debt', 'deckCounts', 'lastDice', 'mapRef',
      'pendingAuction', 'pendingTrade', 'phase',
      'players', 'properties', 'publicRuleState', 'recentLog', 'turn', 'turnPhase', 'winnerId',
    ].sort());

    const resumedClient = await connectClient(url);
    const resumed = await emitResume(resumedClient, {
      roomCode: created.roomCode,
      playerId: joined.playerId,
      token: joined.token,
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error(resumed.message);
    expect(resumed.room.map.ref).toEqual(testMap.ref);
    expect(resumed.snapshot?.mapRef).toEqual(testMap.ref);
  });

  test('unknown maps and same-requestId different-map races fail clearly without a second room', async () => {
    const chinaMap = {
      ...testMap,
      ref: { id: 'china-tour', version: 1, contentHash: 'a'.repeat(64) },
      metadata: { ...testMap.metadata, title: 'China Tour' },
    } satisfies MapPack;
    const resolver: MapResolver = {
      getActiveMapPack(mapId) {
        if (mapId === chinaMap.ref.id) return chinaMap;
        if (mapId === testMap.ref.id) return testMap;
        throw new Error('Inactive map');
      },
      getMapPack: () => chinaMap,
    };
    const url = await startServer(resolver);
    const host = await connectClient(url);

    const missingMapId = await emitMalformedCreate(host, {
      nickname: '房主',
      requestId: '11111111111111111111111111111111',
    });
    expect(missingMapId).toMatchObject({ ok: false, code: 'INVALID_ROOM_ACTION' });
    const emptyMapId = await emitMalformedCreate(host, {
      nickname: '房主',
      mapId: '',
      requestId: '22222222222222222222222222222222',
    });
    expect(emptyMapId).toMatchObject({ ok: false, code: 'INVALID_ROOM_ACTION' });

    const unknown = await emitCreate(host, {
      nickname: '房主',
      mapId: 'missing-map',
      requestId: 'abcdefabcdefabcdefabcdefabcdefab',
    });
    expect(unknown).toMatchObject({
      ok: false,
      code: 'INVALID_ROOM_ACTION',
      message: expect.stringMatching(/map.*unavailable/i),
    });

    const [first, mismatch] = await Promise.all([
      emitCreate(host, { nickname: '房主', mapId: chinaMap.ref.id, requestId: REQUEST_ID }),
      emitCreate(host, { nickname: '房主', mapId: testMap.ref.id, requestId: REQUEST_ID }),
    ]);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.roomCode).toBe('000007');
    expect(mismatch).toMatchObject({ ok: false, code: 'INVALID_ROOM_ACTION' });
  });

  test('World Tour airport wait, intervening turn, one-die branch, reconnect, stale rejection, and Norway exit stay authoritative', async () => {
    const resolver: MapResolver = {
      getActiveMapPack(mapId) {
        if (mapId !== worldTourMap.ref.id) throw new Error('Inactive map');
        return worldTourMap;
      },
      getMapPack(ref) {
        if (
          ref.id !== worldTourMap.ref.id
          || ref.version !== worldTourMap.ref.version
          || ref.contentHash !== worldTourMap.ref.contentHash
        ) throw new Error('Unknown exact map');
        return worldTourMap;
      },
    };
    const gameGateway: GameRuntimeGateway = {
      ...defaultGameGateway,
      createGame(input) {
        const state = defaultGameGateway.createGame(input);
        const safeChance = ['C01', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C12', 'C13', 'C14', 'C15', 'C17'];
        const safeDestiny = ['D01', 'D04', 'D05', 'D07', 'D08', 'D10', 'D11', 'D13', 'D14', 'D15', 'D17', 'D19'];
        return {
          ...state,
          seed: '324',
          currentPlayerId: 'player-0',
          decks: {
            chance: [...safeChance, ...state.decks.chance.filter((id) => !safeChance.includes(id))],
            destiny: [...safeDestiny, ...state.decks.destiny.filter((id) => !safeDestiny.includes(id))],
          },
          players: state.players.map((player) => (
            player.id === 'player-0' ? { ...player, position: 48 } : player
          )),
        };
      },
    };
    const url = await startServer(resolver, gameGateway);
    const host = await connectClient(url);
    const guest = await connectClient(url);
    const observedEvents: GameEvent[] = [];
    guest.on('game:events', ({ events }) => observedEvents.push(...events));

    const created = await emitCreate(host, {
      nickname: '房主',
      mapId: worldTourMap.ref.id,
      requestId: REQUEST_ID,
    });
    expectSuccess(created);
    const joined = await emitJoin(guest, {
      roomCode: created.roomCode,
      nickname: '访客',
      requestId: '33445566778899001122aabbccddeeff',
    });
    expectSuccess(joined);
    expect(created.playerId).toBe('player-0');
    expect(joined.playerId).toBe('player-1');
    expectSuccess(await emitStart(host));
    const running = servers.at(-1)!;

    expectSuccess(await emitGameIntent(host, { type: 'roll_dice' }));
    let state = running.roomManager.getGameSnapshot(created.roomCode)!;
    expect(state.players.find((player) => player.id === created.playerId)?.position).toBe(10);
    expect(state.currentPlayerId).toBe(joined.playerId);
    expect(state.publicRuleState.modules['world-tour@1']).toMatchObject({
      pendingAirportByPlayerId: { [created.playerId]: 10 },
    });

    await driveSocketActorTurn(running, guest, joined.playerId, created.roomCode);
    state = running.roomManager.getGameSnapshot(created.roomCode)!;
    expect(state.currentPlayerId).toBe(created.playerId);
    const entryAction = state.publicRuleState.pendingActions.find((action) => (
      action.playerId === created.playerId && action.action === 'enter-airport-branch'
    ));
    if (!entryAction) throw new Error('missing authoritative airport entry');
    const entryIntent: Intent = {
      type: 'module',
      module: entryAction.module,
      action: entryAction.action,
      payload: entryAction.payload,
    };
    expectSuccess(await emitGameIntent(host, entryIntent));
    state = running.roomManager.getGameSnapshot(created.roomCode)!;
    expect(state.lastDice).toHaveLength(1);
    const branchPosition = state.players.find((player) => player.id === created.playerId)?.position;
    expect(branchPosition).toBe(41);
    expect(state.players.find((player) => player.id === created.playerId)?.skipTurns).toBe(1);
    expect(state.publicRuleState.modules['world-tour@1']).toMatchObject({
      branchAirportByPlayerId: { [created.playerId]: 10 },
    });

    const stale = await emitGameIntent(host, entryIntent);
    expect(stale).toMatchObject({ ok: false, code: 'ILLEGAL_INTENT' });
    const offline = new Promise<void>((resolve) => {
      guest.once('player:connection', ({ playerId, online }) => {
        expect({ playerId, online }).toEqual({ playerId: created.playerId, online: false });
        resolve();
      });
    });
    host.disconnect();
    await offline;
    const resumedHost = await connectClient(url);
    const resumed = await emitResume(resumedHost, {
      roomCode: created.roomCode,
      playerId: created.playerId,
      token: created.token,
    });
    expectSuccess(resumed);
    expect(resumed.snapshot?.publicRuleState?.modules['world-tour@1']).toMatchObject({
      branchAirportByPlayerId: { [created.playerId]: 10 },
    });
    expect(JSON.stringify(resumed.snapshot)).not.toContain('"seed"');
    expect(JSON.stringify(resumed.snapshot)).not.toContain('"decks"');
    expect(JSON.stringify(resumed.snapshot)).not.toContain('"cards"');
    expect(JSON.stringify(resumed.snapshot)).not.toContain('"config"');

    const socketsByPlayer = new Map([
      [created.playerId, resumedHost],
      [joined.playerId, guest],
    ]);
    for (let step = 0; step < 30; step += 1) {
      state = running.roomManager.getGameSnapshot(created.roomCode)!;
      const hostPosition = state.players.find((player) => player.id === created.playerId)?.position;
      if (hostPosition !== undefined && hostPosition < 40 && observedEvents.some((event) => (
        event.type === 'token_moved'
        && event.playerId === created.playerId
        && event.path.includes(31)
      ))) break;
      const actorSocket = socketsByPlayer.get(state.currentPlayerId);
      if (!actorSocket) throw new Error(`missing socket for ${state.currentPlayerId}`);
      const intent = nextAuthoritativeIntent(state);
      expectSuccess(await emitGameIntent(actorSocket, intent));
    }

    state = running.roomManager.getGameSnapshot(created.roomCode)!;
    expect(state.players.find((player) => player.id === created.playerId)?.position).toBeLessThan(40);
    expect(state.lastDice).toHaveLength(1);
    expect(state.publicRuleState.modules['world-tour@1']).toBeUndefined();
    expect(observedEvents).toContainEqual(expect.objectContaining({
      type: 'token_moved',
      playerId: created.playerId,
      path: expect.arrayContaining([47]),
    }));
    expect(observedEvents).toContainEqual(expect.objectContaining({
      type: 'token_moved',
      playerId: created.playerId,
      path: expect.arrayContaining([31]),
    }));
  });
});

function nextAuthoritativeIntent(state: GameState): Intent {
  const pending = state.publicRuleState.pendingActions.find((action) => (
    action.playerId === state.currentPlayerId && action.requiredPhase === state.turnPhase
  ));
  if (pending) {
    return { type: 'module', module: pending.module, action: pending.action, payload: pending.payload };
  }
  switch (state.turnPhase) {
    case 'awaiting_roll': return { type: 'roll_dice' };
    case 'awaiting_airport_roll': return { type: 'roll_airport_branch' };
    case 'awaiting_buy_decision': return { type: 'skip_buy' };
    case 'awaiting_build_decision': return { type: 'skip_build' };
    case 'managing': return { type: 'end_turn' };
    // 议价阶段（#105 / #106）：本套件不开「放弃购买即拍卖」，拍卖分支不可达；交易分支用撤回。
    case 'awaiting_trade_response': return { type: 'cancel_trade' };
    case 'awaiting_auction_bid': return { type: 'pass_bid' };
  }
}

async function driveSocketActorTurn(
  running: RunningRoomServer<unknown>,
  socket: ClientSocket<ServerToClientEvents, ClientToServerEvents>,
  playerId: string,
  roomCode: string,
): Promise<void> {
  for (let step = 0; step < 20; step += 1) {
    const state = running.roomManager.getGameSnapshot(roomCode);
    if (!state || state.currentPlayerId !== playerId || state.phase === 'game_over') return;
    expectSuccess(await emitGameIntent(socket, nextAuthoritativeIntent(state)));
  }
  throw new Error(`socket actor ${playerId} did not finish within 20 intents`);
}
