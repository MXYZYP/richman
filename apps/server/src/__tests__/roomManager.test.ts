import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getActiveMapPack } from '@richman/board-data';
import { createGame, type GameState } from '@richman/engine';
import { RoomManager } from '../rooms/roomManager';

type RoomStatus = 'lobby' | 'playing' | 'ended';
type RoomErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'GAME_ALREADY_STARTED'
  | 'NICKNAME_TAKEN'
  | 'INVALID_TOKEN'
  | 'NOT_HOST'
  | 'INVALID_NICKNAME'
  | 'NOT_ENOUGH_PLAYERS'
  | 'INVALID_ROOM_ACTION';

interface PublicRoomPlayer {
  id: string;
  nickname: string;
  isBot: boolean;
  online: boolean;
}

interface PublicRoomSpectator {
  id: string;
  nickname: string;
  online: boolean;
}

interface PublicRoomState {
  roomCode: string;
  status: RoomStatus;
  hostId: string;
  players: PublicRoomPlayer[];
  spectators: PublicRoomSpectator[];
  takeoverPlayerId: string | null;
  map: {
    ref: GameState['mapRef'];
    title: string;
  };
}

type RoomDomainEvent =
  | { type: 'room_state'; roomCode: string; room: PublicRoomState }
  | { type: 'room_settings'; roomCode: string; settings: unknown }
  | { type: 'player_connection'; roomCode: string; playerId: string; online: boolean }
  | { type: 'room_closed'; roomCode: string; reason: 'empty_lobby' | 'lobby_idle_timeout' }
  | { type: 'game_events'; roomCode: string; events: unknown[] }
  | { type: 'game_snapshot'; roomCode: string; state: GameState };

const chinaMapPack = getActiveMapPack('china-tour');
const CHINA_MAP_SUMMARY = { ref: chinaMapPack.ref, title: chinaMapPack.metadata.title };

interface CreateRoomValue {
  roomCode: string;
  playerId: string;
  token: string;
  room: PublicRoomState;
}

interface JoinRoomValue {
  playerId: string;
  token: string;
  room: PublicRoomState;
}

type RoomFailure = {
  ok: false;
  code: RoomErrorCode;
  message: string;
};

type RoomSuccess<T> = {
  ok: true;
  value: T;
  events: RoomDomainEvent[];
};

type RoomResult<T> = RoomSuccess<T> | RoomFailure;

interface RoomManagerDependencies {
  generatePlayerId(): string;
  generateToken(): string;
  nextRoomNumber(): number;
  compareTokens(actual: string, supplied: string): boolean;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
  onAsyncEvents(events: RoomDomainEvent[]): void;
  generateGameSeed(): string;
  nextAutomationDelayMs(): number;
}

interface RoomManagerContract {
  createRoom(nickname: string, mapId: string, requestId?: string): RoomResult<CreateRoomValue>;
  joinRoom(roomCode: string, nickname: string, requestId?: string, role?: "player" | "spectator"): RoomResult<JoinRoomValue>;
  addBot(roomCode: string, requesterId: string): RoomResult<PublicRoomState>;
  removeBot(roomCode: string, requesterId: string, playerId: string): RoomResult<PublicRoomState>;
  renameBot(roomCode: string, requesterId: string, playerId: string, nickname: string): RoomResult<PublicRoomState>;
  startRoom(roomCode: string, requesterId: string): RoomResult<PublicRoomState>;
  getPublicRoom(roomCode: string): PublicRoomState | null;
  leaveRoom(roomCode: string, playerId: string): RoomResult<PublicRoomState | null>;
  markDisconnected(roomCode: string, playerId: string): RoomResult<PublicRoomState | null>;
  resumeRoom(roomCode: string, playerId: string, token: string): RoomResult<PublicRoomState>;
  dispose(): void;
}

function createChinaRoom(
  manager: RoomManagerContract,
  nickname: string,
  requestId?: string,
): RoomResult<CreateRoomValue> {
  return manager.createRoom(nickname, 'china-tour', requestId);
}

type TimerHandle = {
  callback: () => void;
  delayMs: number;
  active: boolean;
  timerId?: NodeJS.Timeout;
};

type HarnessOptions = {
  roomNumbers?: number[];
  repeatRoomNumber?: number;
  playerIds?: string[];
  tokens?: string[];
  useFakeTimers?: boolean;
};

type Harness = {
  asyncEvents: RoomDomainEvent[];
  dependencies: RoomManagerDependencies;
  timers: TimerHandle[];
};

function createHarness(options: HarnessOptions = {}): Harness {
  const roomNumbers = options.roomNumbers ?? [7];
  const playerIds = options.playerIds ?? [];
  const tokens = options.tokens ?? [];
  const asyncEvents: RoomDomainEvent[] = [];
  const timers: TimerHandle[] = [];
  let roomNumberIndex = 0;
  let playerIdIndex = 0;
  let tokenIndex = 0;

  const dependencies: RoomManagerDependencies = {
    generatePlayerId() {
      const nextIndex = playerIdIndex++;
      return playerIds[nextIndex] ?? `player-${nextIndex}`;
    },
    generateToken() {
      const nextIndex = tokenIndex++;
      return tokens[nextIndex] ?? `token-${nextIndex}`;
    },
    nextRoomNumber() {
      if (roomNumberIndex < roomNumbers.length) {
        return roomNumbers[roomNumberIndex++];
      }

      if (options.repeatRoomNumber !== undefined) {
        return options.repeatRoomNumber;
      }

      throw new Error('No more deterministic room numbers were provided');
    },
    compareTokens(actual, supplied) {
      return actual === supplied;
    },
    setTimer(callback, delayMs) {
      const handle: TimerHandle = { callback, delayMs, active: true };
      timers.push(handle);
      if (options.useFakeTimers === true) {
        handle.timerId = setTimeout(() => {
          if (handle.active) {
            callback();
          }
        }, delayMs);
      }
      return handle;
    },
    clearTimer(handle) {
      const timerHandle = handle as TimerHandle;
      timerHandle.active = false;
      clearTimeout(timerHandle.timerId);
    },
    onAsyncEvents(events) {
      asyncEvents.push(...events);
    },
    generateGameSeed() {
      return 'test-game-seed';
    },
    nextAutomationDelayMs() {
      return 1000;
    },
  };

  return { asyncEvents, dependencies, timers };
}

function createManager(options?: HarnessOptions): RoomManagerContract {
  const harness = createHarness(options);
  return new RoomManager(harness.dependencies) as RoomManagerContract;
}

function expectRoomSuccess<T>(result: RoomResult<T>): asserts result is RoomSuccess<T> {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`Expected room operation to succeed, received ${result.code}: ${result.message}`);
  }
}

function expectRoomFailure<T>(result: RoomResult<T>, code: RoomErrorCode): asserts result is RoomFailure {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error(`Expected room operation to fail with ${code}, received success`);
  }
  expect(result.code).toBe(code);
}

describe('RoomManager deterministic room creation', () => {
  test('createRoom zero-pads the chosen code and publishes a trimmed host lobby without leaking the token', () => {
    const manager = createManager({
      roomNumbers: [7],
      playerIds: ['player-host'],
      tokens: ['secret-token'],
    });

    const result = createChinaRoom(manager, '  玩家一  ');

    expectRoomSuccess(result);
    const expectedRoom: PublicRoomState = { roomCode: '000007', status: 'lobby', hostId: 'player-host', players: [
      {
        id: 'player-host',
        nickname: '玩家一',
        isBot: false,
        online: true,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(result.value).toEqual({
      roomCode: '000007',
      playerId: 'player-host',
      token: 'secret-token',
      room: expectedRoom,
    });
    expect(result.events).toEqual([{ type: 'room_state', roomCode: '000007', room: expectedRoom }]);
    expect(manager.getPublicRoom('000007')).toEqual(expectedRoom);
    expect(JSON.stringify(result.value.room)).not.toContain('secret-token');
    expect(JSON.stringify(result.events)).not.toContain('secret-token');
    expect(JSON.stringify(manager.getPublicRoom('000007'))).not.toContain('secret-token');

    manager.dispose();
  });

  test('createRoom retries an occupied random candidate and uses the next available six-digit code', () => {
    const manager = createManager({ roomNumbers: [7, 7, 8] });

    const first = createChinaRoom(manager, '玩家一');
    const second = createChinaRoom(manager, '玩家二');

    expectRoomSuccess(first);
    expectRoomSuccess(second);
    expect(first.value.roomCode).toBe('000007');
    expect(second.value.roomCode).toBe('000008');
    expect(manager.getPublicRoom('000008')).toEqual(second.value.room);

    manager.dispose();
  });

  test('createRoom sequentially scans from 0000 after one hundred colliding random candidates', () => {
    const manager = createManager({ roomNumbers: [0, ...Array(100).fill(0)] });

    const occupied = createChinaRoom(manager, '占用零号');
    const fallback = createChinaRoom(manager, '顺序兜底');

    expectRoomSuccess(occupied);
    expectRoomSuccess(fallback);
    expect(occupied.value.roomCode).toBe('000000');
    expect(fallback.value.roomCode).toBe('000001');
    expect(manager.getPublicRoom('000001')).toEqual(fallback.value.room);

    manager.dispose();
  });

  test('createRoom assigns zero-padded six-digit codes and keeps allocating past the first ten thousand', () => {
    const firstTenThousand = Array.from({ length: 10_000 }, (_, roomNumber) => roomNumber);
    const manager = createManager({ roomNumbers: firstTenThousand, repeatRoomNumber: 0 });

    for (const roomNumber of firstTenThousand) {
      const result = createChinaRoom(manager, `玩家${roomNumber}`);
      expectRoomSuccess(result);
      expect(result.value.roomCode).toBe(roomNumber.toString().padStart(6, '0'));
    }

    const extra = createChinaRoom(manager, '第十批玩家');
    expectRoomSuccess(extra);
    // After consuming 0..9999 the next free number is 10000 -> '010000'.
    expect(extra.value.roomCode).toBe('010000');

    manager.dispose();
  });

  test('createRoom rejects a nickname that is empty after trimming', () => {
    const manager = createManager();

    const result = createChinaRoom(manager, ' \n\t ');

    expectRoomFailure(result, 'INVALID_NICKNAME');

    manager.dispose();
  });

  test('createRoom accepts a nickname containing exactly twenty Unicode code points', () => {
    const nickname = '🚀'.repeat(20);
    const manager = createManager({ roomNumbers: [42] });

    const result = createChinaRoom(manager, nickname);

    expectRoomSuccess(result);
    expect(result.value.roomCode).toBe('000042');
    expect(result.value.room.players).toHaveLength(1);
    expect(result.value.room.players[0]?.nickname).toBe(nickname);

    manager.dispose();
  });

  test('createRoom rejects a nickname containing twenty-one Unicode code points', () => {
    const manager = createManager();

    const result = createChinaRoom(manager, '🚀'.repeat(21));

    expectRoomFailure(result, 'INVALID_NICKNAME');

    manager.dispose();
  });
});

describe('RoomManager deterministic membership and lobby start', () => {
  test('joinRoom returns ROOM_NOT_FOUND before validating the requested nickname', () => {
    const manager = createManager();

    const result = manager.joinRoom('9999', ' \n\t ');

    expectRoomFailure(result, 'ROOM_NOT_FOUND');

    manager.dispose();
  });

  test('joinRoom appends a trimmed human player, returns a private token, and never leaks tokens publicly', () => {
    const manager = createManager({
      roomNumbers: [11],
      playerIds: ['player-host', 'player-guest'],
      tokens: ['host-token', 'guest-token'],
    });
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);

    const joined = manager.joinRoom('000011', '  玩家二  ');

    expectRoomSuccess(joined);
    const expectedRoom: PublicRoomState = { roomCode: '000011', status: 'lobby', hostId: 'player-host', players: [
      {
        id: 'player-host',
        nickname: '房主',
        isBot: false,
        online: true,
      },
      {
        id: 'player-guest',
        nickname: '玩家二',
        isBot: false,
        online: true,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(joined.value).toEqual({
      playerId: 'player-guest',
      token: 'guest-token',
      room: expectedRoom,
    });
    expect(joined.events).toEqual([{ type: 'room_state', roomCode: '000011', room: expectedRoom }]);
    expect(manager.getPublicRoom('000011')).toEqual(expectedRoom);
    expect(JSON.stringify(joined.value.room)).not.toContain('guest-token');
    expect(JSON.stringify(joined.events)).not.toContain('guest-token');
    expect(JSON.stringify(manager.getPublicRoom('000011'))).not.toContain('guest-token');

    manager.dispose();
  });

  test('joinRoom rejects a playing room before nickname validation', () => {
    const manager = createManager({
      roomNumbers: [12],
      playerIds: ['player-host', 'bot-a'],
      tokens: ['host-token'],
    });
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const botAdded = manager.addBot('000012', 'player-host');
    expectRoomSuccess(botAdded);
    const started = manager.startRoom('000012', 'player-host');
    expectRoomSuccess(started);

    const result = manager.joinRoom('000012', ' \n\t ');

    expectRoomFailure(result, 'GAME_ALREADY_STARTED');

    manager.dispose();
  });

  test('joinRoom returns ROOM_FULL before duplicate nickname validation', () => {
    const manager = createManager({
      roomNumbers: [13],
      playerIds: ['player-host', 'player-two', 'player-three', 'player-four', 'player-five', 'player-six'],
      tokens: ['token-host', 'token-two', 'token-three', 'token-four', 'token-five', 'token-six'],
    });
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    for (const nickname of ['玩家二', '玩家三', '玩家四', '玩家五', '玩家六']) {
      const joined = manager.joinRoom('000013', nickname);
      expectRoomSuccess(joined);
    }

    const result = manager.joinRoom('000013', ' 房主 ');

    expectRoomFailure(result, 'ROOM_FULL');

    manager.dispose();
  });

  test('joinRoom validates nickname syntax and rejects trimmed duplicates while the lobby has capacity', () => {
    const manager = createManager({
      roomNumbers: [14],
      playerIds: ['player-host', 'player-guest'],
      tokens: ['host-token', 'guest-token'],
    });
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);

    expectRoomFailure(manager.joinRoom('000014', ' \n\t '), 'INVALID_NICKNAME');
    expectRoomFailure(manager.joinRoom('000014', '  房主  '), 'NICKNAME_TAKEN');

    const joined = manager.joinRoom('000014', '玩家二');
    expectRoomSuccess(joined);
    expect(joined.value.playerId).toBe('player-guest');

    manager.dispose();
  });

  test('addBot chooses the smallest unused computer name and publishes an online bot without a private token', () => {
    const manager = createManager({
      roomNumbers: [15],
      playerIds: ['player-host', 'bot-b'],
      tokens: ['host-token'],
    });
    const created = createChinaRoom(manager, '电脑 A');
    expectRoomSuccess(created);

    const result = manager.addBot('000015', 'player-host');

    expectRoomSuccess(result);
    const expectedRoom: PublicRoomState = { roomCode: '000015', status: 'lobby', hostId: 'player-host', players: [
      {
        id: 'player-host',
        nickname: '电脑 A',
        isBot: false,
        online: true,
      },
      {
        id: 'bot-b',
        nickname: '电脑 B',
        isBot: true,
        online: true,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(result.value).toEqual(expectedRoom);
    expect(result.events).toEqual([{ type: 'room_state', roomCode: '000015', room: expectedRoom }]);
    expect(JSON.stringify(result.value)).not.toContain('host-token');

    manager.dispose();
  });

  test('addBot reports ROOM_FULL when six player seats are occupied', () => {
    const fullManager = createManager({
      roomNumbers: [16],
      playerIds: ['player-host', 'player-two', 'player-three', 'player-four', 'player-five', 'player-six'],
      tokens: ['token-host', 'token-two', 'token-three', 'token-four', 'token-five', 'token-six'],
    });
    const fullCreated = createChinaRoom(fullManager, '房主');
    expectRoomSuccess(fullCreated);
    for (const nickname of ['玩家二', '玩家三', '玩家四', '玩家五', '玩家六']) {
      expectRoomSuccess(fullManager.joinRoom('000016', nickname));
    }

    expectRoomFailure(fullManager.addBot('000016', 'player-host'), 'ROOM_FULL');
    fullManager.dispose();
  });

  test('addBot and removeBot return specific host and lobby errors before generic invalid actions', () => {
    const manager = createManager({
      roomNumbers: [18],
      playerIds: ['player-host', 'player-guest', 'bot-a'],
      tokens: ['host-token', 'guest-token'],
    });
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const joined = manager.joinRoom('000018', '玩家二');
    expectRoomSuccess(joined);

    expectRoomFailure(manager.addBot('000018', 'player-guest'), 'NOT_HOST');
    expectRoomFailure(manager.removeBot('000018', 'player-guest', 'missing-player'), 'NOT_HOST');
    expectRoomFailure(manager.removeBot('000018', 'player-host', 'missing-player'), 'INVALID_ROOM_ACTION');
    expectRoomFailure(manager.removeBot('000018', 'player-host', 'player-guest'), 'INVALID_ROOM_ACTION');

    const botAdded = manager.addBot('000018', 'player-host');
    expectRoomSuccess(botAdded);
    const started = manager.startRoom('000018', 'player-host');
    expectRoomSuccess(started);

    expectRoomFailure(manager.addBot('000018', 'player-host'), 'GAME_ALREADY_STARTED');
    expectRoomFailure(manager.removeBot('000018', 'player-host', 'bot-a'), 'GAME_ALREADY_STARTED');

    manager.dispose();
  });

  test('removeBot removes only bot players and emits the updated lobby snapshot', () => {
    const manager = createManager({
      roomNumbers: [19],
      playerIds: ['player-host', 'bot-a', 'bot-b'],
      tokens: ['host-token'],
    });
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    expectRoomSuccess(manager.addBot('000019', 'player-host'));
    expectRoomSuccess(manager.addBot('000019', 'player-host'));

    const result = manager.removeBot('000019', 'player-host', 'bot-a');

    expectRoomSuccess(result);
    const expectedRoom: PublicRoomState = { roomCode: '000019', status: 'lobby', hostId: 'player-host', players: [
      {
        id: 'player-host',
        nickname: '房主',
        isBot: false,
        online: true,
      },
      {
        id: 'bot-b',
        nickname: '电脑 B',
        isBot: true,
        online: true,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(result.value).toEqual(expectedRoom);
    expect(result.events).toEqual([{ type: 'room_state', roomCode: '000019', room: expectedRoom }]);
    expect(manager.getPublicRoom('000019')).toEqual(expectedRoom);

    manager.dispose();
  });


  test('renameBot lets the host rename a bot, rejects guests, humans, blank, duplicate, and started rooms, and broadcasts the new nickname', () => {
    const manager = createManager({
      roomNumbers: [21],
      playerIds: ['player-host', 'player-guest', 'bot-a'],
      tokens: ['host-token', 'guest-token'],
    });
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const joined = manager.joinRoom('000021', '玩家二');
    expectRoomSuccess(joined);
    expectRoomSuccess(manager.addBot('000021', 'player-host'));

    expectRoomFailure(manager.renameBot('000021', 'player-guest', 'bot-a', '新电脑'), 'NOT_HOST');
    expectRoomFailure(manager.renameBot('000021', 'player-host', 'player-guest', '新名字'), 'INVALID_ROOM_ACTION');
    expectRoomFailure(manager.renameBot('000021', 'player-host', 'bot-a', '   '), 'INVALID_NICKNAME');
    expectRoomFailure(manager.renameBot('000021', 'player-host', 'bot-a', '玩家二'), 'NICKNAME_TAKEN');

    const unchanged = manager.renameBot('000021', 'player-host', 'bot-a', '  电脑 A  ');
    expectRoomSuccess(unchanged);
    expect(unchanged.value.players.find((player) => player.id === 'bot-a')?.nickname).toBe('电脑 A');

    const renamed = manager.renameBot('000021', 'player-host', 'bot-a', '  电脑甲  ');
    expectRoomSuccess(renamed);
    const expectedRoom: PublicRoomState = { roomCode: '000021', status: 'lobby', hostId: 'player-host', players: [
      { id: 'player-host', nickname: '房主', isBot: false, online: true },
      { id: 'player-guest', nickname: '玩家二', isBot: false, online: true },
      { id: 'bot-a', nickname: '电脑甲', isBot: true, online: true },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(renamed.value).toEqual(expectedRoom);
    expect(renamed.events).toEqual([{ type: 'room_state', roomCode: '000021', room: expectedRoom }]);
    expect(manager.getPublicRoom('000021')).toEqual(expectedRoom);

    const started = manager.startRoom('000021', 'player-host');
    expectRoomSuccess(started);
    expectRoomFailure(manager.renameBot('000021', 'player-host', 'bot-a', '晚改名'), 'GAME_ALREADY_STARTED');

    manager.dispose();
  });

  test('startRoom enforces host ownership before player count and reports insufficient players for a lone host', () => {
    const manager = createManager({
      roomNumbers: [20],
      playerIds: ['player-host'],
      tokens: ['host-token'],
    });
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);

    expectRoomFailure(manager.startRoom('000020', 'player-guest'), 'NOT_HOST');
    expectRoomFailure(manager.startRoom('000020', 'player-host'), 'NOT_ENOUGH_PLAYERS');

    manager.dispose();
  });

  test('startRoom allows a host with one bot, emits room_state then game_snapshot, and rejects a repeat start', () => {
    const manager = createManager({
      roomNumbers: [21],
      playerIds: ['player-host', 'bot-a'],
      tokens: ['host-token'],
    });
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    expectRoomSuccess(manager.addBot('000021', 'player-host'));

    const result = manager.startRoom('000021', 'player-host');

    expectRoomSuccess(result);
    const expectedRoom: PublicRoomState = { roomCode: '000021', status: 'playing', hostId: 'player-host', players: [
      {
        id: 'player-host',
        nickname: '房主',
        isBot: false,
        online: true,
      },
      {
        id: 'bot-a',
        nickname: '电脑 A',
        isBot: true,
        online: true,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    const expectedGameState = createGame({
      mapRef: chinaMapPack.ref,
      ruleModules: chinaMapPack.game.requiredRuleModules,
      board: chinaMapPack.game.board,
      cards: chinaMapPack.game.cards,
      config: chinaMapPack.game.config,
      players: [
        { id: 'player-host', nickname: '房主', isBot: false },
        { id: 'bot-a', nickname: '电脑 A', isBot: true },
      ],
      seed: 'test-game-seed',
      cashGoal: null,
    });
    expect(result.value).toEqual(expectedRoom);
    expect(result.events).toEqual([
      { type: 'room_state', roomCode: '000021', room: expectedRoom },
      { type: 'game_snapshot', roomCode: '000021', state: expectedGameState },
    ]);
    expect(manager.getPublicRoom('000021')).toEqual(expectedRoom);

    expectRoomFailure(manager.startRoom('000021', 'player-host'), 'GAME_ALREADY_STARTED');

    manager.dispose();
  });
});

describe('RoomManager leave, disconnect, and resume lifecycle', () => {
  test('leaveRoom treats a missing room or player as a no-op without events', () => {
    const manager = createManager({
      roomNumbers: [22],
      playerIds: ['player-host'],
      tokens: ['host-token'],
    });

    const missingRoom = manager.leaveRoom('9999', 'player-missing');
    expectRoomSuccess(missingRoom);
    expect(missingRoom.events).toEqual([]);

    const created = createChinaRoom(manager, '0022 host');
    expectRoomSuccess(created);
    const unchangedRoom = manager.getPublicRoom('000022');

    const missingPlayer = manager.leaveRoom('000022', 'player-missing');
    expectRoomSuccess(missingPlayer);
    expect(missingPlayer.events).toEqual([]);
    expect(manager.getPublicRoom('000022')).toEqual(unchangedRoom);

    manager.dispose();
  });

  test('leaveRoom removes a lobby guest and emits the lobby snapshot after removal', () => {
    const manager = createManager({
      roomNumbers: [23],
      playerIds: ['player-host', 'player-guest'],
      tokens: ['host-token', 'guest-token'],
    });
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const joined = manager.joinRoom('000023', '玩家二');
    expectRoomSuccess(joined);

    const result = manager.leaveRoom('000023', 'player-guest');

    expectRoomSuccess(result);
    const expectedRoom: PublicRoomState = { roomCode: '000023', status: 'lobby', hostId: 'player-host', players: [
      {
        id: 'player-host',
        nickname: '房主',
        isBot: false,
        online: true,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(result.value).toEqual(expectedRoom);
    expect(result.events).toEqual([{ type: 'room_state', roomCode: '000023', room: expectedRoom }]);
    expect(manager.getPublicRoom('000023')).toEqual(expectedRoom);

    manager.dispose();
  });

  test('leaveRoom transfers a lobby host to the next human instead of an earlier bot', () => {
    const manager = createManager({
      roomNumbers: [24],
      playerIds: ['player-host', 'bot-a', 'player-guest'],
      tokens: ['host-token', 'guest-token'],
    });
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const botAdded = manager.addBot('000024', 'player-host');
    expectRoomSuccess(botAdded);
    const joined = manager.joinRoom('000024', '玩家二');
    expectRoomSuccess(joined);

    const result = manager.leaveRoom('000024', 'player-host');

    expectRoomSuccess(result);
    const expectedRoom: PublicRoomState = { roomCode: '000024', status: 'lobby', hostId: 'player-guest', players: [
      {
        id: 'bot-a',
        nickname: '电脑 A',
        isBot: true,
        online: true,
      },
      {
        id: 'player-guest',
        nickname: '玩家二',
        isBot: false,
        online: true,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(result.value).toEqual(expectedRoom);
    expect(result.events).toEqual([{ type: 'room_state', roomCode: '000024', room: expectedRoom }]);
    expect(manager.getPublicRoom('000024')).toEqual(expectedRoom);

    manager.dispose();
  });

  test('leaveRoom transfers a lobby host to the immediate next human after the removed host', () => {
    const manager = createManager({
      roomNumbers: [33],
      playerIds: ['player-host', 'player-a', 'player-b'],
      tokens: ['host-token', 'a-token', 'b-token'],
    });
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const joinedA = manager.joinRoom('000033', '玩家 A');
    expectRoomSuccess(joinedA);
    const joinedB = manager.joinRoom('000033', '玩家 B');
    expectRoomSuccess(joinedB);

    const result = manager.leaveRoom('000033', 'player-host');

    expectRoomSuccess(result);
    const expectedRoom: PublicRoomState = { roomCode: '000033', status: 'lobby', hostId: 'player-a', players: [
      {
        id: 'player-a',
        nickname: '玩家 A',
        isBot: false,
        online: true,
      },
      {
        id: 'player-b',
        nickname: '玩家 B',
        isBot: false,
        online: true,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(result.value).toEqual(expectedRoom);
    expect(result.events).toEqual([{ type: 'room_state', roomCode: '000033', room: expectedRoom }]);
    expect(manager.getPublicRoom('000033')).toEqual(expectedRoom);

    manager.dispose();
  });

  test('leaveRoom closes a lobby and removes bots when the last human leaves', () => {
    const manager = createManager({
      roomNumbers: [25],
      playerIds: ['player-host', 'bot-a'],
      tokens: ['host-token'],
    });
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const botAdded = manager.addBot('000025', 'player-host');
    expectRoomSuccess(botAdded);

    const result = manager.leaveRoom('000025', 'player-host');

    expectRoomSuccess(result);
    expect(result.events).toEqual([{ type: 'room_closed', roomCode: '000025', reason: 'empty_lobby' }]);
    expect(manager.getPublicRoom('000025')).toBeNull();

    manager.dispose();
  });

  test('leaveRoom keeps a playing guest seated offline and emits only the connection change', () => {
    const manager = createManager({
      roomNumbers: [26],
      playerIds: ['player-host', 'player-guest'],
      tokens: ['host-token', 'guest-token'],
    });
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const joined = manager.joinRoom('000026', '玩家二');
    expectRoomSuccess(joined);
    const started = manager.startRoom('000026', 'player-host');
    expectRoomSuccess(started);

    const result = manager.leaveRoom('000026', 'player-guest');

    expectRoomSuccess(result);
    const expectedRoom: PublicRoomState = { roomCode: '000026', status: 'playing', hostId: 'player-host', players: [
      {
        id: 'player-host',
        nickname: '房主',
        isBot: false,
        online: true,
      },
      {
        id: 'player-guest',
        nickname: '玩家二',
        isBot: false,
        online: false,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(result.value).toEqual(expectedRoom);
    expect(result.events).toEqual([
      { type: 'player_connection', roomCode: '000026', playerId: 'player-guest', online: false },
    ]);
    expect(manager.getPublicRoom('000026')).toEqual(expectedRoom);

    manager.dispose();
  });

  test('leaveRoom transfers a playing host after emitting the host connection loss', () => {
    const manager = createManager({
      roomNumbers: [27],
      playerIds: ['player-host', 'player-guest', 'bot-a'],
      tokens: ['host-token', 'guest-token'],
    });
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const joined = manager.joinRoom('000027', '玩家二');
    expectRoomSuccess(joined);
    const botAdded = manager.addBot('000027', 'player-host');
    expectRoomSuccess(botAdded);
    const started = manager.startRoom('000027', 'player-host');
    expectRoomSuccess(started);

    const result = manager.leaveRoom('000027', 'player-host');

    expectRoomSuccess(result);
    const expectedRoom: PublicRoomState = { roomCode: '000027', status: 'playing', hostId: 'player-guest', players: [
      {
        id: 'player-host',
        nickname: '房主',
        isBot: false,
        online: false,
      },
      {
        id: 'player-guest',
        nickname: '玩家二',
        isBot: false,
        online: true,
      },
      {
        id: 'bot-a',
        nickname: '电脑 A',
        isBot: true,
        online: true,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(result.value).toEqual(expectedRoom);
    expect(result.events).toEqual([
      { type: 'player_connection', roomCode: '000027', playerId: 'player-host', online: false },
      { type: 'room_state', roomCode: '000027', room: expectedRoom },
      // 掉线自动托管：当前行动者正是刚离线的房主时，服务端会再广播一次 room_state，
      // 告知客户端已进入 15s 托管宽限期（见 roomManager #maybeAutoTakeover）。
      { type: 'room_state', roomCode: '000027', room: expectedRoom },
    ]);
    expect(manager.getPublicRoom('000027')).toEqual(expectedRoom);

    manager.dispose();
  });

  test('markDisconnected transfers a playing host like leave without scheduling lobby timers', () => {
    const harness = createHarness({
      roomNumbers: [28],
      playerIds: ['player-host', 'player-guest'],
      tokens: ['host-token', 'guest-token'],
    });
    const manager = new RoomManager(harness.dependencies) as RoomManagerContract;
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const joined = manager.joinRoom('000028', '玩家二');
    expectRoomSuccess(joined);
    const started = manager.startRoom('000028', 'player-host');
    expectRoomSuccess(started);

    const result = manager.markDisconnected('000028', 'player-host');

    expectRoomSuccess(result);
    const expectedRoom: PublicRoomState = { roomCode: '000028', status: 'playing', hostId: 'player-guest', players: [
      {
        id: 'player-host',
        nickname: '房主',
        isBot: false,
        online: false,
      },
      {
        id: 'player-guest',
        nickname: '玩家二',
        isBot: false,
        online: true,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(result.value).toEqual(expectedRoom);
    expect(result.events).toEqual([
      { type: 'player_connection', roomCode: '000028', playerId: 'player-host', online: false },
      { type: 'room_state', roomCode: '000028', room: expectedRoom },
      // 同 leaveRoom：当前行动者离线时额外广播一次托管宽限提示。
      { type: 'room_state', roomCode: '000028', room: expectedRoom },
    ]);
    // 只应有掉线自动托管的 15s 宽限计时器；对局中的断线绝不排大厅清理计时器（300000ms）。
    expect(harness.timers.map((timer) => timer.delayMs)).toEqual([15_000]);
    expect(manager.getPublicRoom('000028')).toEqual(expectedRoom);

    manager.dispose();
  });

  test('markDisconnected keeps a lobby player seated offline and schedules the lobby idle timeout', () => {
    const harness = createHarness({
      roomNumbers: [32],
      playerIds: ['player-host', 'player-guest'],
      tokens: ['host-token', 'guest-token'],
    });
    const manager = new RoomManager(harness.dependencies) as RoomManagerContract;
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const joined = manager.joinRoom('000032', '玩家二');
    expectRoomSuccess(joined);

    const result = manager.markDisconnected('000032', 'player-guest');

    expectRoomSuccess(result);
    const expectedRoom: PublicRoomState = { roomCode: '000032', status: 'lobby', hostId: 'player-host', players: [
      {
        id: 'player-host',
        nickname: '房主',
        isBot: false,
        online: true,
      },
      {
        id: 'player-guest',
        nickname: '玩家二',
        isBot: false,
        online: false,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(result.value).toEqual(expectedRoom);
    expect(result.events).toEqual([
      { type: 'player_connection', roomCode: '000032', playerId: 'player-guest', online: false },
    ]);
    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0]).toMatchObject({ delayMs: 300_000, active: true });
    expect(manager.getPublicRoom('000032')).toEqual(expectedRoom);

    manager.dispose();
  });

  test('resumeRoom maps missing rooms, unknown players, bots, and bad tokens to the public error contract', () => {
    const manager = createManager({
      roomNumbers: [29],
      playerIds: ['player-host', 'player-guest', 'bot-a'],
      tokens: ['host-token', 'guest-token'],
    });

    expectRoomFailure(manager.resumeRoom('9999', 'player-host', 'host-token'), 'ROOM_NOT_FOUND');

    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const joined = manager.joinRoom('000029', '玩家二');
    expectRoomSuccess(joined);
    const botAdded = manager.addBot('000029', 'player-host');
    expectRoomSuccess(botAdded);

    expectRoomFailure(manager.resumeRoom('000029', 'player-missing', 'host-token'), 'INVALID_TOKEN');
    expectRoomFailure(manager.resumeRoom('000029', 'bot-a', 'any-token'), 'INVALID_TOKEN');
    expectRoomFailure(manager.resumeRoom('000029', 'player-guest', 'wrong-token'), 'INVALID_TOKEN');

    manager.dispose();
  });

  test('resumeRoom restores the original player identity without reclaiming transferred host ownership', () => {
    const manager = createManager({
      roomNumbers: [30],
      playerIds: ['player-host', 'player-guest'],
      tokens: ['host-token', 'guest-token'],
    });
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const joined = manager.joinRoom('000030', '玩家二');
    expectRoomSuccess(joined);
    const started = manager.startRoom('000030', 'player-host');
    expectRoomSuccess(started);
    const disconnected = manager.markDisconnected('000030', 'player-host');
    expectRoomSuccess(disconnected);

    const result = manager.resumeRoom('000030', 'player-host', 'host-token');

    expectRoomSuccess(result);
    const expectedRoom: PublicRoomState = { roomCode: '000030', status: 'playing', hostId: 'player-guest', players: [
      {
        id: 'player-host',
        nickname: '房主',
        isBot: false,
        online: true,
      },
      {
        id: 'player-guest',
        nickname: '玩家二',
        isBot: false,
        online: true,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(result.value).toEqual(expectedRoom);
    expect(result.events).toEqual([
      { type: 'player_connection', roomCode: '000030', playerId: 'player-host', online: true },
    ]);
    expect(manager.getPublicRoom('000030')).toEqual(expectedRoom);

    manager.dispose();
  });

  test('resumeRoom makes the first returning human host when no humans are online', () => {
    const manager = createManager({
      roomNumbers: [31],
      playerIds: ['player-host', 'player-guest'],
      tokens: ['host-token', 'guest-token'],
    });
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const joined = manager.joinRoom('000031', '玩家二');
    expectRoomSuccess(joined);
    const started = manager.startRoom('000031', 'player-host');
    expectRoomSuccess(started);
    const guestDisconnected = manager.markDisconnected('000031', 'player-guest');
    expectRoomSuccess(guestDisconnected);
    const hostDisconnected = manager.markDisconnected('000031', 'player-host');
    expectRoomSuccess(hostDisconnected);

    const result = manager.resumeRoom('000031', 'player-guest', 'guest-token');

    expectRoomSuccess(result);
    const expectedRoom: PublicRoomState = { roomCode: '000031', status: 'playing', hostId: 'player-guest', players: [
      {
        id: 'player-host',
        nickname: '房主',
        isBot: false,
        online: false,
      },
      {
        id: 'player-guest',
        nickname: '玩家二',
        isBot: false,
        online: true,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(result.value).toEqual(expectedRoom);
    expect(result.events).toEqual([
      { type: 'player_connection', roomCode: '000031', playerId: 'player-guest', online: true },
      { type: 'room_state', roomCode: '000031', room: expectedRoom },
    ]);
    expect(manager.getPublicRoom('000031')).toEqual(expectedRoom);

    manager.dispose();
  });
});

describe('RoomManager lobby disconnect grace period', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  test('lobby disconnect waits 299999ms and removes the offline guest at 300000ms through async room_state', () => {
    const harness = createHarness({
      roomNumbers: [34],
      playerIds: ['player-host', 'player-guest'],
      tokens: ['host-token', 'guest-token'],
      useFakeTimers: true,
    });
    const manager = new RoomManager(harness.dependencies) as RoomManagerContract;
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const joined = manager.joinRoom('000034', '玩家二');
    expectRoomSuccess(joined);

    const disconnected = manager.markDisconnected('000034', 'player-guest');

    expectRoomSuccess(disconnected);
    const offlineRoom: PublicRoomState = { roomCode: '000034', status: 'lobby', hostId: 'player-host', players: [
      {
        id: 'player-host',
        nickname: '房主',
        isBot: false,
        online: true,
      },
      {
        id: 'player-guest',
        nickname: '玩家二',
        isBot: false,
        online: false,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(disconnected.value).toEqual(offlineRoom);
    expect(disconnected.events).toEqual([
      { type: 'player_connection', roomCode: '000034', playerId: 'player-guest', online: false },
    ]);
    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0]).toMatchObject({ delayMs: 300_000, active: true });

    vi.advanceTimersByTime(299_999);

    expect(harness.asyncEvents).toEqual([]);
    expect(manager.getPublicRoom('000034')).toEqual(offlineRoom);

    vi.advanceTimersByTime(1);

    const expectedRoom: PublicRoomState = { roomCode: '000034', status: 'lobby', hostId: 'player-host', players: [
      {
        id: 'player-host',
        nickname: '房主',
        isBot: false,
        online: true,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(harness.asyncEvents).toEqual([{ type: 'room_state', roomCode: '000034', room: expectedRoom }]);
    expect(manager.getPublicRoom('000034')).toEqual(expectedRoom);

    manager.dispose();
  });

  test('resume before the lobby timeout cancels cleanup and preserves the returning player', () => {
    const harness = createHarness({
      roomNumbers: [35],
      playerIds: ['player-host', 'player-guest'],
      tokens: ['host-token', 'guest-token'],
      useFakeTimers: true,
    });
    const manager = new RoomManager(harness.dependencies) as RoomManagerContract;
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const joined = manager.joinRoom('000035', '玩家二');
    expectRoomSuccess(joined);
    const disconnected = manager.markDisconnected('000035', 'player-guest');
    expectRoomSuccess(disconnected);
    expect(harness.timers).toHaveLength(1);

    vi.advanceTimersByTime(299_999);
    const resumed = manager.resumeRoom('000035', 'player-guest', 'guest-token');

    expectRoomSuccess(resumed);
    const expectedRoom: PublicRoomState = { roomCode: '000035', status: 'lobby', hostId: 'player-host', players: [
      {
        id: 'player-host',
        nickname: '房主',
        isBot: false,
        online: true,
      },
      {
        id: 'player-guest',
        nickname: '玩家二',
        isBot: false,
        online: true,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(resumed.value).toEqual(expectedRoom);
    expect(resumed.events).toEqual([
      { type: 'player_connection', roomCode: '000035', playerId: 'player-guest', online: true },
    ]);
    expect(harness.timers[0].active).toBe(false);

    vi.advanceTimersByTime(1);

    expect(harness.asyncEvents).toEqual([]);
    expect(manager.getPublicRoom('000035')).toEqual(expectedRoom);

    manager.dispose();
  });

  test('explicit lobby host leave transfers ownership to the remaining offline human', () => {
    const harness = createHarness({
      roomNumbers: [42],
      playerIds: ['player-host', 'player-guest'],
      tokens: ['host-token', 'guest-token'],
      useFakeTimers: true,
    });
    const manager = new RoomManager(harness.dependencies) as RoomManagerContract;
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const joined = manager.joinRoom('000042', '玩家二');
    expectRoomSuccess(joined);
    const guestDisconnected = manager.markDisconnected('000042', 'player-guest');
    expectRoomSuccess(guestDisconnected);
    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0]).toMatchObject({ delayMs: 300_000, active: true });

    const result = manager.leaveRoom('000042', 'player-host');

    expectRoomSuccess(result);
    const expectedRoom: PublicRoomState = { roomCode: '000042', status: 'lobby', hostId: 'player-guest', players: [
      {
        id: 'player-guest',
        nickname: '玩家二',
        isBot: false,
        online: false,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(result.value).toEqual(expectedRoom);
    expect(result.events).toEqual([{ type: 'room_state', roomCode: '000042', room: expectedRoom }]);
    expect(manager.getPublicRoom('000042')).toEqual(expectedRoom);
    expect(harness.timers[0].active).toBe(true);

    manager.dispose();
  });

  test('timed-out lobby host removal transfers ownership to the remaining offline human before that player times out', () => {
    const harness = createHarness({
      roomNumbers: [43],
      playerIds: ['player-host', 'player-guest'],
      tokens: ['host-token', 'guest-token'],
      useFakeTimers: true,
    });
    const manager = new RoomManager(harness.dependencies) as RoomManagerContract;
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const joined = manager.joinRoom('000043', '玩家二');
    expectRoomSuccess(joined);
    const guestDisconnected = manager.markDisconnected('000043', 'player-guest');
    expectRoomSuccess(guestDisconnected);
    const hostDisconnected = manager.markDisconnected('000043', 'player-host');
    expectRoomSuccess(hostDisconnected);
    expect(harness.timers).toHaveLength(2);
    expect(harness.timers[0]).toMatchObject({ delayMs: 300_000, active: true });
    expect(harness.timers[1]).toMatchObject({ delayMs: 300_000, active: true });

    harness.timers[1].callback();

    const expectedRoom: PublicRoomState = { roomCode: '000043', status: 'lobby', hostId: 'player-guest', players: [
      {
        id: 'player-guest',
        nickname: '玩家二',
        isBot: false,
        online: false,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(harness.asyncEvents).toEqual([{ type: 'room_state', roomCode: '000043', room: expectedRoom }]);
    expect(manager.getPublicRoom('000043')).toEqual(expectedRoom);

    manager.dispose();
  });

  test('explicit lobby leave cancels the disconnected player timeout before removing that seat', () => {
    const harness = createHarness({
      roomNumbers: [36],
      playerIds: ['player-host', 'player-guest'],
      tokens: ['host-token', 'guest-token'],
      useFakeTimers: true,
    });
    const manager = new RoomManager(harness.dependencies) as RoomManagerContract;
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const joined = manager.joinRoom('000036', '玩家二');
    expectRoomSuccess(joined);
    const disconnected = manager.markDisconnected('000036', 'player-guest');
    expectRoomSuccess(disconnected);
    expect(harness.timers).toHaveLength(1);

    const left = manager.leaveRoom('000036', 'player-guest');

    expectRoomSuccess(left);
    const expectedRoom: PublicRoomState = { roomCode: '000036', status: 'lobby', hostId: 'player-host', players: [
      {
        id: 'player-host',
        nickname: '房主',
        isBot: false,
        online: true,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(left.value).toEqual(expectedRoom);
    expect(left.events).toEqual([{ type: 'room_state', roomCode: '000036', room: expectedRoom }]);
    expect(harness.timers[0].active).toBe(false);

    vi.advanceTimersByTime(300_000);

    expect(harness.asyncEvents).toEqual([]);
    expect(manager.getPublicRoom('000036')).toEqual(expectedRoom);

    manager.dispose();
  });

  test('timed-out lobby host removal transfers host to the immediate next human and skips bots', () => {
    const harness = createHarness({
      roomNumbers: [37],
      playerIds: ['player-host', 'bot-a', 'player-a', 'player-b'],
      tokens: ['host-token', 'a-token', 'b-token'],
      useFakeTimers: true,
    });
    const manager = new RoomManager(harness.dependencies) as RoomManagerContract;
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const botAdded = manager.addBot('000037', 'player-host');
    expectRoomSuccess(botAdded);
    const joinedA = manager.joinRoom('000037', '玩家 A');
    expectRoomSuccess(joinedA);
    const joinedB = manager.joinRoom('000037', '玩家 B');
    expectRoomSuccess(joinedB);

    const disconnected = manager.markDisconnected('000037', 'player-host');

    expectRoomSuccess(disconnected);
    expect(disconnected.value?.players.find((player) => player.id === 'player-host')).toMatchObject({
      online: false,
    });
    expect(disconnected.events).toContainEqual({
      type: 'player_connection',
      roomCode: '000037',
      playerId: 'player-host',
      online: false,
    });
    expect(harness.timers).toHaveLength(1);

    vi.advanceTimersByTime(300_000);

    const expectedRoom: PublicRoomState = { roomCode: '000037', status: 'lobby', hostId: 'player-a', players: [
      {
        id: 'bot-a',
        nickname: '电脑 A',
        isBot: true,
        online: true,
      },
      {
        id: 'player-a',
        nickname: '玩家 A',
        isBot: false,
        online: true,
      },
      {
        id: 'player-b',
        nickname: '玩家 B',
        isBot: false,
        online: true,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(harness.asyncEvents).toEqual([{ type: 'room_state', roomCode: '000037', room: expectedRoom }]);
    expect(manager.getPublicRoom('000037')).toEqual(expectedRoom);

    manager.dispose();
  });

  test('timed-out last lobby human closes the room with lobby_idle_timeout and removes bots with it', () => {
    const harness = createHarness({
      roomNumbers: [38],
      playerIds: ['player-host', 'bot-a'],
      tokens: ['host-token'],
      useFakeTimers: true,
    });
    const manager = new RoomManager(harness.dependencies) as RoomManagerContract;
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const botAdded = manager.addBot('000038', 'player-host');
    expectRoomSuccess(botAdded);

    const disconnected = manager.markDisconnected('000038', 'player-host');

    expectRoomSuccess(disconnected);
    const offlineRoom: PublicRoomState = { roomCode: '000038', status: 'lobby', hostId: 'player-host', players: [
      {
        id: 'player-host',
        nickname: '房主',
        isBot: false,
        online: false,
      },
      {
        id: 'bot-a',
        nickname: '电脑 A',
        isBot: true,
        online: true,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(disconnected.value).toEqual(offlineRoom);
    expect(disconnected.events).toEqual([
      { type: 'player_connection', roomCode: '000038', playerId: 'player-host', online: false },
    ]);
    expect(harness.timers).toHaveLength(1);

    vi.advanceTimersByTime(300_000);

    expect(harness.asyncEvents).toEqual([{ type: 'room_closed', roomCode: '000038', reason: 'lobby_idle_timeout' }]);
    expect(manager.getPublicRoom('000038')).toBeNull();

    manager.dispose();
  });

  test('playing disconnect never schedules a lobby cleanup timer', () => {
    const harness = createHarness({
      roomNumbers: [39],
      playerIds: ['player-host', 'player-guest'],
      tokens: ['host-token', 'guest-token'],
      useFakeTimers: true,
    });
    const manager = new RoomManager(harness.dependencies) as RoomManagerContract;
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const joined = manager.joinRoom('000039', '玩家二');
    expectRoomSuccess(joined);
    const started = manager.startRoom('000039', 'player-host');
    expectRoomSuccess(started);

    const disconnected = manager.markDisconnected('000039', 'player-guest');

    expectRoomSuccess(disconnected);
    const expectedRoom: PublicRoomState = { roomCode: '000039', status: 'playing', hostId: 'player-host', players: [
      {
        id: 'player-host',
        nickname: '房主',
        isBot: false,
        online: true,
      },
      {
        id: 'player-guest',
        nickname: '玩家二',
        isBot: false,
        online: false,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(disconnected.value).toEqual(expectedRoom);
    expect(disconnected.events).toEqual([
      { type: 'player_connection', roomCode: '000039', playerId: 'player-guest', online: false },
    ]);
    expect(harness.timers).toEqual([]);

    vi.advanceTimersByTime(300_000);

    expect(harness.asyncEvents).toEqual([]);
    expect(manager.getPublicRoom('000039')).toEqual(expectedRoom);

    manager.dispose();
  });

  test('dispose cancels every pending lobby disconnect timer without firing timeout events', () => {
    const harness = createHarness({
      roomNumbers: [40],
      playerIds: ['player-host', 'player-guest'],
      tokens: ['host-token', 'guest-token'],
      useFakeTimers: true,
    });
    const manager = new RoomManager(harness.dependencies) as RoomManagerContract;
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const joined = manager.joinRoom('000040', '玩家二');
    expectRoomSuccess(joined);
    const disconnected = manager.markDisconnected('000040', 'player-guest');
    expectRoomSuccess(disconnected);
    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0].active).toBe(true);

    manager.dispose();

    expect(harness.timers[0].active).toBe(false);

    vi.advanceTimersByTime(300_000);

    expect(harness.asyncEvents).toEqual([]);
  });

  test('stale lobby timeout callback rechecks that the player is still offline before removing', () => {
    const harness = createHarness({
      roomNumbers: [41],
      playerIds: ['player-host', 'player-guest'],
      tokens: ['host-token', 'guest-token'],
      useFakeTimers: true,
    });
    const manager = new RoomManager(harness.dependencies) as RoomManagerContract;
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const joined = manager.joinRoom('000041', '玩家二');
    expectRoomSuccess(joined);
    const disconnected = manager.markDisconnected('000041', 'player-guest');
    expectRoomSuccess(disconnected);
    expect(harness.timers).toHaveLength(1);
    const staleTimer = harness.timers[0];

    const resumed = manager.resumeRoom('000041', 'player-guest', 'guest-token');
    expectRoomSuccess(resumed);
    staleTimer.callback();

    const expectedRoom: PublicRoomState = { roomCode: '000041', status: 'lobby', hostId: 'player-host', players: [
      {
        id: 'player-host',
        nickname: '房主',
        isBot: false,
        online: true,
      },
      {
        id: 'player-guest',
        nickname: '玩家二',
        isBot: false,
        online: true,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(harness.asyncEvents).toEqual([]);
    expect(manager.getPublicRoom('000041')).toEqual(expectedRoom);

    manager.dispose();
  });
});

describe('RoomManager room entry idempotency', () => {
  const hostRequestId = '00112233445566778899aabbccddeeff';
  const guestRequestId = 'ffeeddccbbaa99887766554433221100';

  test('replays create with the original room, player, token, and public state for a normalized payload', () => {
    const manager = createManager({
      roomNumbers: [7, 8],
      playerIds: ['player-host', 'player-unexpected'],
      tokens: ['host-token', 'unexpected-token'],
    });

    const first = createChinaRoom(manager, '  房主  ', hostRequestId);
    const replay = createChinaRoom(manager, '房主', hostRequestId);

    expectRoomSuccess(first);
    expect(replay).toEqual(first);
    expect(manager.getPublicRoom('000007')?.players).toHaveLength(1);
    expect(JSON.stringify(first.value.room)).not.toMatch(/token|requestId/i);
  });

  test('rejects create request ID reuse with a different normalized payload', () => {
    const manager = createManager({ roomNumbers: [7] });

    expectRoomSuccess(createChinaRoom(manager, '房主', hostRequestId));
    expectRoomFailure(createChinaRoom(manager, '另一位房主', hostRequestId), 'INVALID_ROOM_ACTION');
  });

  test('rejects join request ID reuse for a different room or nickname', () => {
    const manager = createManager({
      roomNumbers: [7, 8],
      playerIds: ['player-host-a', 'player-host-b', 'player-guest'],
    });
    const firstRoom = createChinaRoom(manager, '房主甲', hostRequestId);
    const secondRoom = createChinaRoom(manager, '房主乙', '11223344556677889900aabbccddeeff');
    expectRoomSuccess(firstRoom);
    expectRoomSuccess(secondRoom);
    expectRoomSuccess(manager.joinRoom(firstRoom.value.roomCode, '玩家二', guestRequestId));

    expectRoomFailure(
      manager.joinRoom(secondRoom.value.roomCode, '玩家二', guestRequestId),
      'INVALID_ROOM_ACTION',
    );
    expectRoomFailure(
      manager.joinRoom(firstRoom.value.roomCode, '玩家三', guestRequestId),
      'INVALID_ROOM_ACTION',
    );
  });

  test('replays join after the room starts without adding a player', () => {
    const manager = createManager({
      roomNumbers: [7],
      playerIds: ['player-host', 'player-guest'],
      tokens: ['host-token', 'guest-token'],
    });

    const created = createChinaRoom(manager, '房主', hostRequestId);
    expectRoomSuccess(created);
    const joined = manager.joinRoom(created.value.roomCode, '  玩家二  ', guestRequestId);
    expectRoomSuccess(joined);
    expectRoomSuccess(manager.startRoom(created.value.roomCode, created.value.playerId));

    const replay = manager.joinRoom(created.value.roomCode, '玩家二', guestRequestId);

    expectRoomSuccess(replay);
    expect(replay.value).toMatchObject({ playerId: joined.value.playerId, token: joined.value.token });
    expect(replay.value.room.status).toBe('playing');
    expect(manager.getPublicRoom(created.value.roomCode)?.players).toHaveLength(2);
  });

  test('releases a guest join request ID when the guest leaves the lobby', () => {
    const manager = createManager({
      roomNumbers: [7],
      playerIds: ['player-host', 'player-guest', 'player-retry'],
      tokens: ['host-token', 'guest-token', 'retry-token'],
    });
    const created = createChinaRoom(manager, '房主', hostRequestId);
    expectRoomSuccess(created);
    const joined = manager.joinRoom(created.value.roomCode, '客人', guestRequestId);
    expectRoomSuccess(joined);
    expectRoomSuccess(manager.leaveRoom(created.value.roomCode, joined.value.playerId));

    const retriedAfterLeave = manager.joinRoom(created.value.roomCode, '客人', guestRequestId);

    expectRoomSuccess(retriedAfterLeave);
    expect(retriedAfterLeave.value).toMatchObject({
      playerId: 'player-retry',
      token: 'retry-token',
    });
  });

  test('releases a guest join request ID when the lobby disconnect timeout removes the guest', () => {
    const harness = createHarness({
      roomNumbers: [7],
      playerIds: ['player-host', 'player-guest', 'player-retry'],
      tokens: ['host-token', 'guest-token', 'retry-token'],
    });
    const manager = new RoomManager(harness.dependencies) as RoomManagerContract;
    const created = createChinaRoom(manager, '房主', hostRequestId);
    expectRoomSuccess(created);
    const joined = manager.joinRoom(created.value.roomCode, '客人', guestRequestId);
    expectRoomSuccess(joined);
    expectRoomSuccess(manager.markDisconnected(created.value.roomCode, joined.value.playerId));
    harness.timers[0]?.callback();

    const retriedAfterTimeout = manager.joinRoom(created.value.roomCode, '客人', guestRequestId);

    expectRoomSuccess(retriedAfterTimeout);
    expect(retriedAfterTimeout.value).toMatchObject({
      playerId: 'player-retry',
      token: 'retry-token',
    });
    manager.dispose();
  });

  test('releases all remaining join request IDs when deleting an empty lobby room', () => {
    const manager = createManager({
      roomNumbers: [7, 7],
      playerIds: ['player-host', 'player-guest', 'player-retry-host', 'player-retry-guest'],
      tokens: ['host-token', 'guest-token', 'retry-host-token', 'retry-guest-token'],
    });
    const first = createChinaRoom(manager, '房主', hostRequestId);
    expectRoomSuccess(first);
    const joined = manager.joinRoom(first.value.roomCode, '客人', guestRequestId);
    expectRoomSuccess(joined);
    expectRoomSuccess(manager.leaveRoom(first.value.roomCode, first.value.playerId));
    expectRoomSuccess(manager.leaveRoom(first.value.roomCode, joined.value.playerId));

    const replacement = createChinaRoom(manager, '新房主', '11223344556677889900aabbccddeeff');
    expectRoomSuccess(replacement);
    const retriedAfterRoomDeletion = manager.joinRoom(replacement.value.roomCode, '客人', guestRequestId);

    expectRoomSuccess(retriedAfterRoomDeletion);
    expect(retriedAfterRoomDeletion.value).toMatchObject({
      playerId: 'player-retry-guest',
      token: 'retry-guest-token',
    });
  });

  test('releases create request IDs when their room is deleted', () => {
    const manager = createManager({
      roomNumbers: [7, 8],
      playerIds: ['player-host', 'player-retry'],
      tokens: ['host-token', 'retry-token'],
    });

    const first = createChinaRoom(manager, '房主', hostRequestId);
    expectRoomSuccess(first);
    expectRoomSuccess(manager.leaveRoom(first.value.roomCode, first.value.playerId));

    const retriedAfterDeletion = createChinaRoom(manager, '房主', hostRequestId);

    expectRoomSuccess(retriedAfterDeletion);
    expect(retriedAfterDeletion.value).toMatchObject({
      roomCode: '000008',
      playerId: 'player-retry',
      token: 'retry-token',
    });
  });
  test('fails create replay when the original lobby creator left and host ownership transferred', () => {
    const manager = createManager({
      roomNumbers: [7],
      playerIds: ['player-creator', 'player-guest'],
      tokens: ['creator-token', 'guest-token'],
    });
    const created = createChinaRoom(manager, '创建者', hostRequestId);
    expectRoomSuccess(created);
    const joined = manager.joinRoom(created.value.roomCode, '客人', guestRequestId);
    expectRoomSuccess(joined);
    expectRoomSuccess(manager.leaveRoom(created.value.roomCode, created.value.playerId));

    expectRoomFailure(createChinaRoom(manager, '创建者', hostRequestId), 'INVALID_ROOM_ACTION');
    expect(manager.getPublicRoom(created.value.roomCode)?.hostId).toBe(joined.value.playerId);
  });
  test('preserves a replacement create replay index while deleting the original stale room', () => {
    const manager = createManager({
      roomNumbers: [7, 8],
      playerIds: ['player-creator', 'player-guest', 'player-replacement'],
      tokens: ['creator-token', 'guest-token', 'replacement-token'],
    });
    const original = createChinaRoom(manager, '创建者', hostRequestId);
    expectRoomSuccess(original);
    const guest = manager.joinRoom(original.value.roomCode, '客人', guestRequestId);
    expectRoomSuccess(guest);
    expectRoomSuccess(manager.leaveRoom(original.value.roomCode, original.value.playerId));

    expectRoomFailure(createChinaRoom(manager, '创建者', hostRequestId), 'INVALID_ROOM_ACTION');
    const replacement = createChinaRoom(manager, '创建者', hostRequestId);
    expectRoomSuccess(replacement);
    expect(replacement.value).toMatchObject({
      roomCode: '000008',
      playerId: 'player-replacement',
      token: 'replacement-token',
    });

    expectRoomSuccess(manager.leaveRoom(original.value.roomCode, guest.value.playerId));
    const replay = createChinaRoom(manager, '创建者', hostRequestId);

    expectRoomSuccess(replay);
    expect(replay.value).toEqual(replacement.value);
    expect(manager.getPublicRoom(replacement.value.roomCode)).toEqual(replacement.value.room);
  });

  test('replays the original playing creator identity after host ownership transfers', () => {
    const manager = createManager({
      roomNumbers: [7],
      playerIds: ['player-creator', 'player-guest'],
      tokens: ['creator-token', 'guest-token'],
    });
    const created = createChinaRoom(manager, '创建者', hostRequestId);
    expectRoomSuccess(created);
    const joined = manager.joinRoom(created.value.roomCode, '客人', guestRequestId);
    expectRoomSuccess(joined);
    expectRoomSuccess(manager.startRoom(created.value.roomCode, created.value.playerId));
    expectRoomSuccess(manager.leaveRoom(created.value.roomCode, created.value.playerId));

    const replay = createChinaRoom(manager, '创建者', hostRequestId);
    expectRoomSuccess(replay);
    expect(replay.value).toMatchObject({
      playerId: created.value.playerId,
      token: created.value.token,
      room: { hostId: joined.value.playerId },
    });
  });

  test('checks an existing join request globally before room or nickname validation', () => {
    const manager = createManager({
      roomNumbers: [7, 8],
      playerIds: ['player-host-a', 'player-host-b', 'player-guest'],
    });
    const roomA = createChinaRoom(manager, '房主甲', hostRequestId);
    const roomB = createChinaRoom(manager, '房主乙', '11223344556677889900aabbccddeeff');
    expectRoomSuccess(roomA);
    expectRoomSuccess(roomB);
    expectRoomSuccess(manager.joinRoom(roomA.value.roomCode, '玩家二', guestRequestId));

    for (const [roomCode, nickname] of [
      ['9999', '玩家二'],
      [roomB.value.roomCode, '玩家二'],
      [roomA.value.roomCode, ''],
      [roomA.value.roomCode, 'x'.repeat(21)],
    ]) {
      expectRoomFailure(manager.joinRoom(roomCode, nickname, guestRequestId), 'INVALID_ROOM_ACTION');
    }
  });

  test('checks an existing create request before nickname validation while preserving new request validation', () => {
    const manager = createManager({ roomNumbers: [7] });
    expectRoomSuccess(createChinaRoom(manager, '房主', hostRequestId));

    expectRoomFailure(createChinaRoom(manager, '', hostRequestId), 'INVALID_ROOM_ACTION');
    expectRoomFailure(createChinaRoom(manager, '另一位房主', hostRequestId), 'INVALID_ROOM_ACTION');
    expectRoomFailure(createChinaRoom(manager, '', '11223344556677889900aabbccddeeff'), 'INVALID_NICKNAME');
  });
});
