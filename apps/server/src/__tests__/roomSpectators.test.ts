import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RoomManager } from '../rooms/roomManager';
import type { RoomManagerDependencies } from '../rooms/roomTypes';

type TimerHandle = { callback: () => void; delayMs: number; active: boolean; timerId?: NodeJS.Timeout };
type RoomFailure = { ok: false; code: string; message: string };
type RoomSuccess<T> = { ok: true; value: T; events: unknown[] };
type RoomResult<T> = RoomSuccess<T> | RoomFailure;

const spectatorRequestId = 'aabbccddeeff00112233445566778899';
const guestRequestId = 'ffeeddccbbaa99887766554433221100';

function expectSuccess<T>(result: RoomResult<T>): asserts result is RoomSuccess<T> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.message}`);
}

function expectFailure<T>(result: RoomResult<T>, code: string): asserts result is RoomFailure {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error(`expected ${code}, received success`);
  expect(result.code).toBe(code);
}

function createManager(options: {
  playerIds?: string[];
  tokens?: string[];
  useFakeTimers?: boolean;
} = {}) {
  const playerIds = options.playerIds ?? [];
  const tokens = options.tokens ?? [];
  const asyncEvents: unknown[] = [];
  const timers: TimerHandle[] = [];
  let playerIdIndex = 0;
  let tokenIndex = 0;
  const dependencies: RoomManagerDependencies<TimerHandle> = {
    generatePlayerId() {
      const nextIndex = playerIdIndex++;
      return playerIds[nextIndex] ?? `player-${nextIndex}`;
    },
    generateToken() {
      const nextIndex = tokenIndex++;
      return tokens[nextIndex] ?? `token-${nextIndex}`;
    },
    nextRoomNumber() {
      return 7;
    },
    compareTokens(actual, supplied) {
      return actual === supplied;
    },
    setTimer(callback, delayMs) {
      const handle: TimerHandle = { callback, delayMs, active: true };
      timers.push(handle);
      if (options.useFakeTimers === true) {
        handle.timerId = setTimeout(() => {
          if (handle.active) callback();
        }, delayMs);
      }
      return handle;
    },
    clearTimer(handle) {
      handle.active = false;
      clearTimeout(handle.timerId);
    },
    onAsyncEvents(events) {
      asyncEvents.push(...events);
    },
    generateGameSeed() {
      return 'spectator-test-seed';
    },
    nextAutomationDelayMs() {
      return 1000;
    },
  };
  return { manager: new RoomManager(dependencies), asyncEvents, timers };
}

describe('RoomManager spectators', () => {
  test('joinRoom default role remains player and spectator seats stay empty', () => {
    const { manager } = createManager({ playerIds: ['host', 'guest'], tokens: ['tok-host', 'tok-guest'] });
    expectSuccess(manager.createRoom('房主', 'china-tour'));
    const joined = manager.joinRoom('000007', '客人');
    expectSuccess(joined);
    expect(joined.value.room.players.map((player) => player.id)).toEqual(['host', 'guest']);
    expect(joined.value.room.spectators).toEqual([]);
    manager.dispose();
  });

  test('joinRoom as spectator publishes a spectator seat without occupying a player seat', () => {
    const { manager } = createManager({ playerIds: ['host', 'spec'], tokens: ['tok-host', 'tok-spec'] });
    expectSuccess(manager.createRoom('房主', 'china-tour'));
    const joined = manager.joinRoom('000007', '  观众  ', undefined, 'spectator');
    expectSuccess(joined);
    expect(joined.value).toMatchObject({ playerId: 'spec', token: 'tok-spec' });
    expect(joined.value.room.players).toHaveLength(1);
    expect(joined.value.room.spectators).toEqual([{ id: 'spec', nickname: '观众', online: true }]);
    expect(JSON.stringify(joined.value.room)).not.toContain('tok-spec');
    expect(manager.getPublicRoom('000007')?.spectators).toEqual(joined.value.room.spectators);
    manager.dispose();
  });

  test('joinRoom rejects an invalid role before seating anyone', () => {
    const { manager } = createManager({ playerIds: ['host', 'intruder'], tokens: ['tok-host', 'tok-intruder'] });
    expectSuccess(manager.createRoom('房主', 'china-tour'));
    const result = manager.joinRoom('000007', '闯入者', undefined, 'admin' as 'player');
    expectFailure(result, 'INVALID_ROOM_ACTION');
    expect(manager.getPublicRoom('000007')?.players).toHaveLength(1);
    expect(manager.getPublicRoom('000007')?.spectators).toEqual([]);
    manager.dispose();
  });

  test('spectators may join a playing room while players may not', () => {
    const { manager } = createManager({
      playerIds: ['host', 'bot', 'spec'],
      tokens: ['tok-host', 'tok-spec'],
    });
    expectSuccess(manager.createRoom('房主', 'china-tour'));
    expectSuccess(manager.addBot('000007', 'host'));
    expectSuccess(manager.startRoom('000007', 'host'));
    expectFailure(manager.joinRoom('000007', '迟到玩家'), 'GAME_ALREADY_STARTED');
    const spectator = manager.joinRoom('000007', '观众', undefined, 'spectator');
    expectSuccess(spectator);
    expect(spectator.value.room.status).toBe('playing');
    expect(spectator.value.room.spectators).toEqual([{ id: 'spec', nickname: '观众', online: true }]);
    manager.dispose();
  });

  test('spectator ROOM_FULL precedes duplicate nickname checks at three seats', () => {
    const { manager } = createManager({
      playerIds: ['host', 's1', 's2', 's3', 's4'],
      tokens: ['tok-host', 't1', 't2', 't3', 't4'],
    });
    expectSuccess(manager.createRoom('房主', 'china-tour'));
    expectSuccess(manager.joinRoom('000007', '观众一', undefined, 'spectator'));
    expectSuccess(manager.joinRoom('000007', '观众二', undefined, 'spectator'));
    expectSuccess(manager.joinRoom('000007', '观众三', undefined, 'spectator'));
    expectFailure(manager.joinRoom('000007', ' 房主 ', undefined, 'spectator'), 'ROOM_FULL');
    expect(manager.getPublicRoom('000007')?.spectators).toHaveLength(3);
    manager.dispose();
  });

  test('player and spectator nicknames are unique across both rosters', () => {
    const { manager } = createManager({
      playerIds: ['host', 'spec', 'guest'],
      tokens: ['tok-host', 'tok-spec', 'tok-guest'],
    });
    expectSuccess(manager.createRoom('房主', 'china-tour'));
    expectSuccess(manager.joinRoom('000007', '观众', undefined, 'spectator'));
    expectFailure(manager.joinRoom('000007', '观众'), 'NICKNAME_TAKEN');
    expectFailure(manager.joinRoom('000007', '房主', undefined, 'spectator'), 'NICKNAME_TAKEN');
    manager.dispose();
  });

  test('addBot skips spectator-occupied computer names and never duplicates them', () => {
    const { manager } = createManager({
      playerIds: ['host', 's1', 's2', 's3', 'bot-d'],
      tokens: ['tok-host', 't1', 't2', 't3'],
    });
    expectSuccess(manager.createRoom('房主', 'china-tour'));
    expectSuccess(manager.joinRoom('000007', '电脑 A', undefined, 'spectator'));
    expectSuccess(manager.joinRoom('000007', '电脑 B', undefined, 'spectator'));
    expectSuccess(manager.joinRoom('000007', '电脑 C', undefined, 'spectator'));
    const added = manager.addBot('000007', 'host');
    expectSuccess(added);
    expect(added.value.players.find((player) => player.isBot)?.nickname).toBe('电脑 D');
    const nicknames = [...added.value.players, ...added.value.spectators].map((member) => member.nickname);
    expect(nicknames).toEqual(['房主', '电脑 D', '电脑 A', '电脑 B', '电脑 C']);
    expect(new Set(nicknames).size).toBe(nicknames.length);
    manager.dispose();
  });

  test('renameBot rejects a nickname already used by a spectator', () => {
    const { manager } = createManager({
      playerIds: ['host', 'bot-a', 'spec'],
      tokens: ['tok-host', 'tok-spec'],
    });
    expectSuccess(manager.createRoom('房主', 'china-tour'));
    expectSuccess(manager.addBot('000007', 'host'));
    expectSuccess(manager.joinRoom('000007', '电脑甲', undefined, 'spectator'));
    expectFailure(manager.renameBot('000007', 'host', 'bot-a', '电脑甲'), 'NICKNAME_TAKEN');
    manager.dispose();
  });

  test('host can add five bots then hits ROOM_FULL rather than name exhaustion', () => {
    const { manager } = createManager({
      playerIds: ['host', 'bot-a', 'bot-b', 'bot-c', 'bot-d', 'bot-e'],
      tokens: ['tok-host'],
    });
    expectSuccess(manager.createRoom('房主', 'china-tour'));
    for (const expected of ['电脑 A', '电脑 B', '电脑 C', '电脑 D', '电脑 E']) {
      const added = manager.addBot('000007', 'host');
      expectSuccess(added);
      expect(added.value.players.at(-1)).toMatchObject({ nickname: expected, isBot: true });
    }
    expectFailure(manager.addBot('000007', 'host'), 'ROOM_FULL');
    expect(manager.getPublicRoom('000007')?.players).toHaveLength(6);
    manager.dispose();
  });

  test('the same requestId cannot be replayed as the opposite role', () => {
    const { manager } = createManager({
      playerIds: ['host', 'guest', 'spec'],
      tokens: ['tok-host', 'tok-guest', 'tok-spec'],
    });
    expectSuccess(manager.createRoom('房主', 'china-tour'));
    expectSuccess(manager.joinRoom('000007', '客人', guestRequestId, 'player'));
    expectFailure(manager.joinRoom('000007', '客人', guestRequestId, 'spectator'), 'INVALID_ROOM_ACTION');
    expect(manager.getPublicRoom('000007')?.players).toHaveLength(2);
    expect(manager.getPublicRoom('000007')?.spectators).toEqual([]);
    expectSuccess(manager.joinRoom('000007', '观众', spectatorRequestId, 'spectator'));
    expectFailure(manager.joinRoom('000007', '观众', spectatorRequestId, 'player'), 'INVALID_ROOM_ACTION');
    expect(manager.getPublicRoom('000007')?.spectators).toHaveLength(1);
    manager.dispose();
  });

  test('spectator join requestId replay is idempotent and does not add a second seat', () => {
    const { manager } = createManager({
      playerIds: ['host', 'spec', 'unexpected'],
      tokens: ['tok-host', 'tok-spec', 'tok-unexpected'],
    });
    expectSuccess(manager.createRoom('房主', 'china-tour'));
    const first = manager.joinRoom('000007', '  观众  ', spectatorRequestId, 'spectator');
    expectSuccess(first);
    const replay = manager.joinRoom('000007', '观众', spectatorRequestId, 'spectator');
    expectSuccess(replay);
    expect(replay.value).toMatchObject({ playerId: 'spec', token: 'tok-spec' });
    expect(manager.getPublicRoom('000007')?.spectators).toHaveLength(1);
    manager.dispose();
  });

  test('explicit spectator leave releases the seat immediately', () => {
    const { manager } = createManager({
      playerIds: ['host', 'spec', 'spec-2'],
      tokens: ['tok-host', 'tok-spec', 'tok-spec-2'],
    });
    expectSuccess(manager.createRoom('房主', 'china-tour'));
    expectSuccess(manager.joinRoom('000007', '观众', undefined, 'spectator'));
    const left = manager.leaveRoom('000007', 'spec');
    expectSuccess(left);
    expect(left.value?.spectators).toEqual([]);
    const rejoined = manager.joinRoom('000007', '观众', undefined, 'spectator');
    expectSuccess(rejoined);
    expect(rejoined.value.playerId).toBe('spec-2');
    manager.dispose();
  });

  test('last lobby human leave closes the room and drops spectators', () => {
    const { manager } = createManager({
      playerIds: ['host', 'spec'],
      tokens: ['tok-host', 'tok-spec'],
    });
    expectSuccess(manager.createRoom('房主', 'china-tour'));
    expectSuccess(manager.joinRoom('000007', '观众', undefined, 'spectator'));
    const left = manager.leaveRoom('000007', 'host');
    expectSuccess(left);
    expect(left.events).toEqual([{ type: 'room_closed', roomCode: '000007', reason: 'empty_lobby' }]);
    expect(manager.getPublicRoom('000007')).toBeNull();
    expectFailure(manager.resumeRoom('000007', 'spec', 'tok-spec'), 'ROOM_NOT_FOUND');
    manager.dispose();
  });

  test('spectators cannot host, add bots, start, or apply game intents', () => {
    const { manager } = createManager({
      playerIds: ['host', 'spec', 'bot'],
      tokens: ['tok-host', 'tok-spec'],
    });
    expectSuccess(manager.createRoom('房主', 'china-tour'));
    expectSuccess(manager.joinRoom('000007', '观众', undefined, 'spectator'));
    expectFailure(manager.addBot('000007', 'spec'), 'NOT_HOST');
    expectFailure(manager.startRoom('000007', 'spec'), 'NOT_HOST');
    expectSuccess(manager.addBot('000007', 'host'));
    expectSuccess(manager.startRoom('000007', 'host'));
    const intent = manager.applyGameIntent('000007', 'spec', { type: 'roll_dice' });
    expect(intent).toMatchObject({ ok: false, code: 'INVALID_ROOM_ACTION' });
    expect(manager.getPublicRoom('000007')?.hostId).toBe('host');
    manager.dispose();
  });

  test('resume spectator with a bad token is rejected and a valid resume does not steal host', () => {
    const { manager } = createManager({
      playerIds: ['host', 'guest', 'spec'],
      tokens: ['tok-host', 'tok-guest', 'tok-spec'],
    });
    expectSuccess(manager.createRoom('房主', 'china-tour'));
    expectSuccess(manager.joinRoom('000007', '客人'));
    expectSuccess(manager.joinRoom('000007', '观众', undefined, 'spectator'));
    expectSuccess(manager.startRoom('000007', 'host'));
    expectSuccess(manager.markDisconnected('000007', 'guest'));
    expectSuccess(manager.markDisconnected('000007', 'host'));
    expectFailure(manager.resumeRoom('000007', 'spec', 'wrong-token'), 'INVALID_TOKEN');
    const resumed = manager.resumeRoom('000007', 'spec', 'tok-spec');
    expectSuccess(resumed);
    expect(resumed.value.hostId).toBe('host');
    expect(resumed.value.spectators).toEqual([{ id: 'spec', nickname: '观众', online: true }]);
    const guestBack = manager.resumeRoom('000007', 'guest', 'tok-guest');
    expectSuccess(guestBack);
    expect(guestBack.value.hostId).toBe('guest');
    manager.dispose();
  });
});

describe('RoomManager spectator disconnect grace', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  test('disconnected spectators expire after 300000ms in lobby', () => {
    const { manager, asyncEvents, timers } = createManager({
      playerIds: ['host', 'spec'],
      tokens: ['tok-host', 'tok-spec'],
      useFakeTimers: true,
    });
    expectSuccess(manager.createRoom('房主', 'china-tour'));
    expectSuccess(manager.joinRoom('000007', '观众', undefined, 'spectator'));
    const disconnected = manager.markDisconnected('000007', 'spec');
    expectSuccess(disconnected);
    expect(disconnected.value?.spectators).toEqual([{ id: 'spec', nickname: '观众', online: false }]);
    expect(timers).toHaveLength(1);
    expect(timers[0]).toMatchObject({ delayMs: 300_000, active: true });
    vi.advanceTimersByTime(299_999);
    expect(manager.getPublicRoom('000007')?.spectators).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(asyncEvents).toEqual([
      expect.objectContaining({ type: 'room_state', roomCode: '000007' }),
    ]);
    expect(manager.getPublicRoom('000007')?.spectators).toEqual([]);
    expect(manager.getPublicRoom('000007')?.players).toHaveLength(1);
    manager.dispose();
  });

  test('starting the game does not cancel a spectator disconnect timer', () => {
    const { manager, timers } = createManager({
      playerIds: ['host', 'bot', 'spec'],
      tokens: ['tok-host', 'tok-spec'],
      useFakeTimers: true,
    });
    expectSuccess(manager.createRoom('房主', 'china-tour'));
    expectSuccess(manager.addBot('000007', 'host'));
    expectSuccess(manager.joinRoom('000007', '观众', undefined, 'spectator'));
    expectSuccess(manager.markDisconnected('000007', 'spec'));
    expect(timers[0]).toMatchObject({ delayMs: 300_000, active: true });
    expectSuccess(manager.startRoom('000007', 'host'));
    const spectatorTimer = timers.find((timer) => timer.delayMs === 300_000);
    expect(spectatorTimer?.active).toBe(true);
    spectatorTimer?.callback();
    expect(manager.getPublicRoom('000007')?.status).toBe('playing');
    expect(manager.getPublicRoom('000007')?.spectators).toEqual([]);
    manager.dispose();
  });
});
