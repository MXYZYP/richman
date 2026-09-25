import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getActiveMapPack } from '@richman/board-data';
import { createGame, type GameState } from '@richman/engine';
import type { RoomRuleConfig } from '@richman/protocol';
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
  | 'INVALID_ROOM_ACTION'
  // #23 ③：房间密码与观战开关两条独立错误码。
  | 'WRONG_ROOM_PASSWORD'
  | 'SPECTATING_DISABLED';


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
  | { type: 'undo_request'; roomCode: string; request: unknown }
  | { type: 'undo_result'; roomCode: string; result: unknown }
  | { type: 'undo_available'; roomCode: string; playerId: string | null }
  | { type: 'turn_deadline'; roomCode: string; info: { playerId: string | null; deadlineAt: number | null; limitSec: number } }
  | { type: 'turn_timeout'; roomCode: string; playerId: string; nickname: string }
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
  joinRoom(
    roomCode: string,
    nickname: string,
    requestId?: string,
    role?: "player" | "spectator",
    password?: string,
  ): RoomResult<JoinRoomValue>;
  addBot(roomCode: string, requesterId: string): RoomResult<PublicRoomState>;
  removeBot(roomCode: string, requesterId: string, playerId: string): RoomResult<PublicRoomState>;
  renameBot(roomCode: string, requesterId: string, playerId: string, nickname: string): RoomResult<PublicRoomState>;
  startRoom(roomCode: string, requesterId: string): RoomResult<PublicRoomState>;
  kickPlayer(roomCode: string, requesterId: string, targetPlayerId: string): RoomResult<PublicRoomState | null>;
  updateRoomSettings(
    roomCode: string,
    requesterId: string,
    patch: {
      isPublic?: boolean;
      turnTimeLimitSec?: number;
      ruleConfig?: RoomRuleConfig | null;
      cashGoal?: number | null;
      password?: string | null;
      allowSpectators?: boolean;
    },
  ): RoomResult<RoomSettings>;
  /** 单播用投影（#23 ③）：密码只以布尔出现，绝不回带凭据。 */
  getRoomSettings(roomCode: string): RoomSettings | null;
  getGameSnapshot(roomCode: string): GameState | null;
  listPublicRooms(): PublicRoomSummary[];
  getPublicRoom(roomCode: string): PublicRoomState | null;
  leaveRoom(roomCode: string, playerId: string): RoomResult<PublicRoomState | null>;
  markDisconnected(roomCode: string, playerId: string): RoomResult<PublicRoomState | null>;
  resumeRoom(roomCode: string, playerId: string, token: string): RoomResult<PublicRoomState>;
  dispose(): void;
}

/** 房间设置投影（#4 / #6 / #101 / #106 / #107 / #108 / #23 ③）。 */
interface RoomSettings {
  isPublic: boolean;
  turnTimeLimitSec: number;
  ruleConfig: RoomRuleConfig | null;
  cashGoal: number | null;
  passwordProtected: boolean;
  allowSpectators: boolean;
}

/** 公开房间列表条目（#108）。刻意不含成员名单 / 观战者名单 / 托管状态 —— 见 `listPublicRooms`。 */
interface PublicRoomSummary {
  roomCode: string;
  hostNickname: string;
  mapTitle: string;
  status: RoomStatus;
  playerCount: number;
  spectatorCount: number;
  playerLimit: number;
  spectatorLimit: number;
  joinable: boolean;
  spectatable: boolean;
  turnTimeLimitSec: number;
  botDifficulty: string;
  /** #23 ③：列表只提示「要不要密码」，不含密码本身。 */
  hasPassword: boolean;
  /** #23 ③：房主是否允许观战；`false` 时 `spectatable` 必然是 `false`。 */
  allowSpectators: boolean;
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

describe('RoomManager public room list (#108)', () => {
  test('lists only published, still-joinable-or-watchable rooms and orders joinable → spectatable → rest', () => {
    // 房间号按建房顺序发放：000007=A、000008=B、000009=C、000010=D、000011=E。
    const manager = createManager({ roomNumbers: [7, 8, 9, 10, 11] });

    // A：大厅 1 人、已公开 → 既能加入也能旁观。
    const roomA = createChinaRoom(manager, '房主甲');
    expectRoomSuccess(roomA);
    expectRoomSuccess(manager.updateRoomSettings(roomA.value.roomCode, roomA.value.playerId, { isPublic: true }));

    // B：已开局 2 人、已公开 → 不能再以玩家加入，但可以旁观。
    const roomB = createChinaRoom(manager, '房主乙');
    expectRoomSuccess(roomB);
    const guestB = manager.joinRoom(roomB.value.roomCode, '乙的对手');
    expectRoomSuccess(guestB);
    expectRoomSuccess(manager.updateRoomSettings(roomB.value.roomCode, roomB.value.playerId, { isPublic: true }));
    expectRoomSuccess(manager.startRoom(roomB.value.roomCode, roomB.value.playerId));

    // C：大厅坐满 6 人、已公开 → 同样只能旁观，与 B 同组，排序时靠房间号决先后。
    const roomC = createChinaRoom(manager, '房主丙');
    expectRoomSuccess(roomC);
    for (let seat = 0; seat < 5; seat += 1) {
      expectRoomSuccess(manager.joinRoom(roomC.value.roomCode, `丙的客人${seat}`));
    }
    expectRoomSuccess(manager.updateRoomSettings(roomC.value.roomCode, roomC.value.playerId, { isPublic: true }));

    // D：公开后又收回（大厅里随时可撤）。
    const roomD = createChinaRoom(manager, '房主丁');
    expectRoomSuccess(roomD);
    expectRoomSuccess(manager.updateRoomSettings(roomD.value.roomCode, roomD.value.playerId, { isPublic: true }));
    expectRoomSuccess(manager.updateRoomSettings(roomD.value.roomCode, roomD.value.playerId, { isPublic: false }));

    // E：从头到尾没公开过。
    const roomE = createChinaRoom(manager, '房主戊');
    expectRoomSuccess(roomE);

    // 只列 3 个：D 收回了、E 没公开过。排序是「可加入 → 可旁观 → 其余」，同组内按房间号升序 ——
    // 确定性排序不是洁癖：列表每次刷新都在跳会让用户以为自己点错了。
    expect(manager.listPublicRooms()).toEqual([
      {
        roomCode: '000007',
        hostNickname: '房主甲',
        mapTitle: CHINA_MAP_SUMMARY.title,
        status: 'lobby',
        playerCount: 1,
        spectatorCount: 0,
        playerLimit: 6,
        spectatorLimit: 3,
        joinable: true,
        spectatable: true,
        turnTimeLimitSec: 0,
        botDifficulty: 'normal',
        // #23 ③：这两间房都没设密码、也没关观战 —— 新字段必须出现在全等断言里，
        // 否则「摘要悄悄多带了一个字段」这种回归会溜过这一整条测试。
        hasPassword: false,
        allowSpectators: true,
      },
      expect.objectContaining({ roomCode: '000008', status: 'playing', playerCount: 2, joinable: false, spectatable: true }),
      expect.objectContaining({ roomCode: '000009', status: 'lobby', playerCount: 6, joinable: false, spectatable: true }),
    ]);
  });

  test('drops a room out of the list the moment it ends, even though it is still published', () => {
    const manager = createManager({ roomNumbers: [7] });
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const guest = manager.joinRoom(created.value.roomCode, '客人');
    expectRoomSuccess(guest);
    expectRoomSuccess(manager.updateRoomSettings(created.value.roomCode, created.value.playerId, { isPublic: true }));
    expectRoomSuccess(manager.startRoom(created.value.roomCode, created.value.playerId));
    expect(manager.listPublicRooms()).toHaveLength(1);

    // 两人局里踢掉对手 = 仅剩一名存活玩家 → 直接终局。已结束的房间连 `room:join` 都拒绝，
    // 留在列表里只会让人点进去才发现进不去。
    expectRoomSuccess(manager.kickPlayer(created.value.roomCode, created.value.playerId, guest.value.playerId));

    expect(manager.getPublicRoom(created.value.roomCode)?.status).toBe('ended');
    expect(manager.listPublicRooms()).toEqual([]);
  });

  test('a published room whose spectator seats are taken is neither joinable nor spectatable', () => {
    const manager = createManager({ roomNumbers: [7] });
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const guest = manager.joinRoom(created.value.roomCode, '客人');
    expectRoomSuccess(guest);
    expectRoomSuccess(manager.updateRoomSettings(created.value.roomCode, created.value.playerId, { isPublic: true }));
    expectRoomSuccess(manager.startRoom(created.value.roomCode, created.value.playerId));

    for (let seat = 0; seat < 3; seat += 1) {
      expectRoomSuccess(manager.joinRoom(created.value.roomCode, `观众${seat}`, undefined, 'spectator'));
    }

    // 第 4 个观众挤不进来 —— 摘要里的 `spectatable: false` 必须与真实准入判断一致，
    // 否则列表会给出一个点下去就报错的「旁观」按钮。
    expectRoomFailure(manager.joinRoom(created.value.roomCode, '观众4', undefined, 'spectator'), 'ROOM_FULL');

    expect(manager.listPublicRooms()).toEqual([
      expect.objectContaining({ roomCode: '000007', spectatorCount: 3, joinable: false, spectatable: false }),
    ]);
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

/**
 * 房间设置扩项（#23 ③ / 待-5 剩余）：现金目标 / 房间密码 / 观战开关。
 *
 * 三项的共同点是「都只挂 Room、不进 GameConfig」——那条约束的理由见 protocol 里各字段的注释。
 * 这组用例盯的是三件事：**入口校验**（不该存的组合存不进去）、**开局透传**（设置真的生效了）、
 * **不泄露**（密码只以布尔出现在任何投影与事件里）。
 */
describe('RoomManager room access & win-goal rules (#23 ③)', () => {
  test('a password-protected room rejects missing or wrong passwords and never leaks the credential', () => {
    const manager = createManager({ roomNumbers: [7] });
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const code = created.value.roomCode;

    // 明文带着首尾空格进来，服务端须自己 trim 后再哈希。
    const updated = manager.updateRoomSettings(code, created.value.playerId, { password: '  密室密码  ' });
    expectRoomSuccess(updated);
    // 广播事件里绝不含密码原文——它会被发给房间里的每一个人，包括只是来看的。
    expect(JSON.stringify(updated.events)).not.toContain('密室密码');

    const settings = manager.getRoomSettings(code);
    expect(settings?.passwordProtected).toBe(true);
    // 投影形状里根本没有承载密码的字段，序列化后也不该出现原文。
    expect(settings === null ? [] : Object.keys(settings)).not.toContain('password');
    expect(JSON.stringify(settings)).not.toContain('密室密码');

    expectRoomFailure(manager.joinRoom(code, '没带密码'), 'WRONG_ROOM_PASSWORD');
    expectRoomFailure(manager.joinRoom(code, '密码错了', undefined, 'player', 'wrong'), 'WRONG_ROOM_PASSWORD');
    // 密码保护的是整间房：观战同样要答对，否则设了密码的房间照样能把局势看光。
    expectRoomFailure(manager.joinRoom(code, '想围观', undefined, 'spectator'), 'WRONG_ROOM_PASSWORD');

    expectRoomSuccess(manager.joinRoom(code, '知道密码', undefined, 'player', '密室密码'));
    expectRoomSuccess(manager.joinRoom(code, '围观成功', undefined, 'spectator', '密室密码'));
  });

  test('password length is enforced by code points at the setting entry, and only the host may set it', () => {
    const manager = createManager({ roomNumbers: [7] });
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const code = created.value.roomCode;
    const guest = manager.joinRoom(code, '客人');
    expectRoomSuccess(guest);

    // 沿用本类既有的房主门禁：非房主不能设密码。
    expectRoomFailure(manager.updateRoomSettings(code, guest.value.playerId, { password: 'abcd' }), 'NOT_HOST');

    for (const bad of ['abc', 'x'.repeat(13), '', '     ']) {
      expectRoomFailure(manager.updateRoomSettings(code, created.value.playerId, { password: bad }), 'INVALID_ROOM_ACTION');
    }
    expect(manager.getRoomSettings(code)?.passwordProtected).toBe(false);

    // 按**码点**计数：4 个 emoji 是 4 个字符（UTF-16 长度会是 8，用 .length 判就会误判上限）。
    expectRoomSuccess(manager.updateRoomSettings(code, created.value.playerId, { password: '🔒🔒🔒🔒' }));
    expect(manager.getRoomSettings(code)?.passwordProtected).toBe(true);

    // `null` = 取消密码；取消之后新成员无需密码即可进入。
    expectRoomSuccess(manager.updateRoomSettings(code, created.value.playerId, { password: null }));
    expect(manager.getRoomSettings(code)?.passwordProtected).toBe(false);
    expectRoomSuccess(manager.joinRoom(code, '后来的人'));
  });

  test('disabling spectating blocks newcomers without kicking the people already watching', () => {
    const manager = createManager({ roomNumbers: [7] });
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const code = created.value.roomCode;

    // 先让人坐进观战位，再关掉开关——顺序决定这条用例到底在测什么。
    expectRoomSuccess(manager.joinRoom(code, '老观众', undefined, 'spectator'));
    expectRoomSuccess(manager.updateRoomSettings(code, created.value.playerId, { allowSpectators: false }));

    expect(manager.getRoomSettings(code)?.allowSpectators).toBe(false);
    expectRoomFailure(manager.joinRoom(code, '新观众', undefined, 'spectator'), 'SPECTATING_DISABLED');
    // 关开关不是踢人：已在场的观战者原样留着。
    expect(manager.getPublicRoom(code)?.spectators.map((member) => member.nickname)).toEqual(['老观众']);
    // 参赛席位不受这个开关影响。
    expectRoomSuccess(manager.joinRoom(code, '参赛者'));

    // 公开列表里的 `spectatable` 必须与真实准入判断一致：否则列表会给出一个点下去就报错的「旁观」。
    expectRoomSuccess(manager.updateRoomSettings(code, created.value.playerId, { isPublic: true }));
    expect(manager.listPublicRooms()[0]).toMatchObject({
      allowSpectators: false,
      spectatable: false,
      joinable: true,
      hasPassword: false,
    });
  });

  test('the cash goal must beat the effective initial cash and reaches the started game state', () => {
    const manager = createManager({ roomNumbers: [7] });
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const code = created.value.roomCode;
    const guest = manager.joinRoom(code, '客人');
    expectRoomSuccess(guest);

    // 默认不设目标（= 打到只剩最后一人）。
    expect(manager.getRoomSettings(code)?.cashGoal).toBeNull();

    // 地图初始资金是 15000：等于它、低于它、非整数一律拒（引擎硬要求 `cashGoal > initialCash`）。
    for (const bad of [15000, 10000, -1, 1.5]) {
      expectRoomFailure(manager.updateRoomSettings(code, created.value.playerId, { cashGoal: bad }), 'INVALID_ROOM_ACTION');
    }

    expectRoomSuccess(manager.updateRoomSettings(code, created.value.playerId, { cashGoal: 30000 }));
    expect(manager.getRoomSettings(code)?.cashGoal).toBe(30000);
    expectRoomSuccess(manager.startRoom(code, created.value.playerId));
    // 设置真的透传进了对局状态；否则界面上写着「目标 30000」而引擎根本没这回事。
    expect(manager.getGameSnapshot(code)?.cashGoal).toBe(30000);
  });

  test('raising the initial cash above an active cash goal is rejected instead of starting a doomed game', () => {
    const manager = createManager({ roomNumbers: [7] });
    const created = createChinaRoom(manager, '房主');
    expectRoomSuccess(created);
    const code = created.value.roomCode;
    expectRoomSuccess(manager.updateRoomSettings(code, created.value.playerId, { cashGoal: 30000 }));

    // 目标 30000 + 初始资金 30000 会被 createGame 拒；这个组合必须在**设置的那一刻**就顶回去。
    expectRoomFailure(
      manager.updateRoomSettings(code, created.value.playerId, {
        ruleConfig: { initialCash: 30000, maxHouseLevel: 5, mortgageInterestRate: 0.1 },
      }),
      'INVALID_ROOM_ACTION',
    );
    expect(manager.getRoomSettings(code)).toMatchObject({ ruleConfig: null, cashGoal: 30000 });

    // 先把目标抬到 50000，再抬初始资金就成立了。
    expectRoomSuccess(manager.updateRoomSettings(code, created.value.playerId, { cashGoal: 50000 }));
    expectRoomSuccess(manager.updateRoomSettings(code, created.value.playerId, {
      ruleConfig: { initialCash: 30000, maxHouseLevel: 5, mortgageInterestRate: 0.1 },
    }));
    expect(manager.getRoomSettings(code)).toMatchObject({
      cashGoal: 50000,
      ruleConfig: { initialCash: 30000 },
    });

    // 反方向同样受约束：把目标降回到 30000（= 新的生效初始资金）会被拒。
    expectRoomFailure(manager.updateRoomSettings(code, created.value.playerId, { cashGoal: 30000 }), 'INVALID_ROOM_ACTION');
    // 清掉目标则永远成立。
    expectRoomSuccess(manager.updateRoomSettings(code, created.value.playerId, { cashGoal: null }));
    expect(manager.getRoomSettings(code)?.cashGoal).toBeNull();
  });
});
