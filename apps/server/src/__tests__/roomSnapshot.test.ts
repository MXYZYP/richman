import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { getActiveMapPack } from '@richman/board-data';
import { createGame } from '@richman/engine';
import type { GameState } from '@richman/engine';
import { RoomManager } from '../rooms/roomManager';
import {
  createRoomSnapshotStore,
  isRoomSnapshotRecord,
  ROOM_SNAPSHOT_SCHEMA_VERSION,
} from '../rooms/roomSnapshotStore';
import type { RoomSnapshotRecord, RoomSnapshotStore } from '../rooms/roomSnapshotStore';
import type { RoomDomainEvent, RoomManagerDependencies } from '../rooms/roomTypes';

/**
 * C-③ / #22 / #34：服务端房间落盘快照。
 *
 * 覆盖三类契约：
 *  1. 存储层自身的硬约束——原子写（不留 `.tmp`）、版本号、损坏隔离、保留期清理。
 *  2. 恢复语义——「重启」后对局原样回来、真人一律先置离线、可重连继续。
 *  3. 容错——任何一条坏快照都只丢它自己，不阻断启动，也不影响别的房间。
 */

type TimerHandle = {
  callback: () => void;
  delayMs: number;
  active: boolean;
};

type HarnessOptions = {
  playerIds?: string[];
  tokens?: string[];
  roomNumbers?: number[];
  seed?: string;
  delays?: number[];
  snapshotStore?: RoomSnapshotStore;
  onServerError?: (message: string, error: unknown) => void;
};

const CHINA_PACK = getActiveMapPack('china-tour');
const ROOM_CODE = '000007';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeSnapshotDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'richman-snap-'));
  tempDirectories.push(directory);
  return directory;
}

function createHarness(options: HarnessOptions = {}) {
  const roomNumbers = options.roomNumbers ?? [7];
  const playerIds = options.playerIds ?? [];
  const tokens = options.tokens ?? [];
  const delays = options.delays ?? [];
  const asyncEvents: RoomDomainEvent[] = [];
  const timers: TimerHandle[] = [];
  let roomNumberIndex = 0;
  let playerIdIndex = 0;
  let tokenIndex = 0;
  let delayIndex = 0;

  const dependencies: RoomManagerDependencies<TimerHandle> = {
    generatePlayerId() {
      const nextIndex = playerIdIndex;
      playerIdIndex += 1;
      return playerIds[nextIndex] ?? `player-${nextIndex}`;
    },
    generateToken() {
      const nextIndex = tokenIndex;
      tokenIndex += 1;
      return tokens[nextIndex] ?? `token-${nextIndex}`;
    },
    nextRoomNumber() {
      const nextIndex = roomNumberIndex;
      roomNumberIndex += 1;
      return roomNumbers[nextIndex] ?? nextIndex;
    },
    compareTokens(actual, supplied) {
      return actual === supplied;
    },
    setTimer(callback, delayMs) {
      let handle: TimerHandle;
      handle = {
        delayMs,
        active: true,
        callback: () => {
          handle.active = false;
          callback();
        },
      };
      timers.push(handle);
      return handle;
    },
    clearTimer(handle) {
      handle.active = false;
    },
    onAsyncEvents(events) {
      asyncEvents.push(...events);
    },
    generateGameSeed() {
      return options.seed ?? 'game-seed';
    },
    nextAutomationDelayMs() {
      const nextIndex = delayIndex;
      delayIndex += 1;
      return delays[nextIndex] ?? 1000;
    },
    snapshotStore: options.snapshotStore,
    onServerError: options.onServerError,
  };

  const manager = new RoomManager<TimerHandle>(dependencies);
  return { manager, asyncEvents, timers };
}

/** 找一个「房主先手」的确定性种子，好让测试能直接用手动意图推进回合。 */
function seedWithHostFirst(players: { id: string; nickname: string; isBot: boolean }[]): string {
  for (let index = 0; index < 5000; index += 1) {
    const seed = `host-first-${index}`;
    const state = createGame({
      mapRef: CHINA_PACK.ref,
      ruleModules: CHINA_PACK.game.requiredRuleModules,
      board: CHINA_PACK.game.board,
      cards: CHINA_PACK.game.cards,
      config: CHINA_PACK.game.config,
      players,
      seed,
      cashGoal: null,
    });
    if (state.currentPlayerId === 'host') return seed;
  }
  throw new Error('no host-first seed found within 5000 deterministic seeds');
}

/** 重启恢复后所有真人都会被标记离线，比对状态前先把期望值里真人的 online 抹平。 */
function offlineHumans(state: GameState): GameState {
  return { ...state, players: state.players.map((player) => (player.isBot ? player : { ...player, online: false })) };
}

function startTwoHumanRoom(store: RoomSnapshotStore) {
  const harness = createHarness({
    playerIds: ['host', 'guest'],
    tokens: ['tok-host', 'tok-guest'],
    seed: seedWithHostFirst([
      { id: 'host', nickname: '房主', isBot: false },
      { id: 'guest', nickname: '客人', isBot: false },
    ]),
    snapshotStore: store,
  });

  const created = harness.manager.createRoom('房主', 'china-tour');
  expect(created.ok).toBe(true);
  const joined = harness.manager.joinRoom(ROOM_CODE, '客人');
  expect(joined.ok).toBe(true);
  const started = harness.manager.startRoom(ROOM_CODE, 'host');
  expect(started.ok).toBe(true);

  return harness;
}

function snapshotFile(directory: string, roomCode = ROOM_CODE): string {
  return join(directory, `room-${roomCode}.json`);
}

function readRecord(directory: string, roomCode = ROOM_CODE): RoomSnapshotRecord {
  const parsed: unknown = JSON.parse(readFileSync(snapshotFile(directory, roomCode), 'utf8'));
  expect(isRoomSnapshotRecord(parsed)).toBe(true);
  return parsed as RoomSnapshotRecord;
}

function validRecord(overrides: Partial<RoomSnapshotRecord> = {}): RoomSnapshotRecord {
  return {
    schemaVersion: ROOM_SNAPSHOT_SCHEMA_VERSION,
    savedAt: Date.now(),
    code: ROOM_CODE,
    mapRef: CHINA_PACK.ref,
    mapTitle: CHINA_PACK.metadata.title,
    status: 'lobby',
    hostId: 'host',
    botDifficulty: 'normal',
    players: [
      { id: 'host', nickname: '房主', token: 'tok-host', isBot: false, online: true, joinRequestId: null, joinRequestNickname: null },
    ],
    spectators: [],
    createRequestId: null,
    createRequestNickname: null,
    createRequestPlayerId: null,
    createRequestToken: null,
    gameState: null,
    ...overrides,
  };
}

describe('房间快照存储（原子写 / 版本号 / 容错 / 保留期）', () => {
  test('save 后 loadAll 原样读回，且不残留 .tmp 临时文件', () => {
    const directory = makeSnapshotDirectory();
    const store = createRoomSnapshotStore({ directory });
    const record = validRecord();

    store.save(record);

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(record);
    expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toHaveLength(0);
  });

  test('重复 save 同一房间只保留最新一条（原子 rename 顶替旧文件）', () => {
    const directory = makeSnapshotDirectory();
    const store = createRoomSnapshotStore({ directory });

    store.save(validRecord({ savedAt: 1 }));
    store.save(validRecord({ savedAt: 2, status: 'playing' }));

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].savedAt).toBe(2);
    expect(loaded[0].status).toBe('playing');
  });

  test('损坏的 JSON 被隔离为 .corrupt，其余快照照常读出', () => {
    const directory = makeSnapshotDirectory();
    const store = createRoomSnapshotStore({ directory });
    store.save(validRecord());
    writeFileSync(snapshotFile(directory, '000099'), '{ this is not json', 'utf8');

    const loaded = store.loadAll();

    expect(loaded).toHaveLength(1);
    expect(loaded[0].code).toBe(ROOM_CODE);
    expect(readdirSync(directory).some((name) => name.endsWith('.corrupt'))).toBe(true);
    // 隔离后不再参与下一轮读取。
    expect(store.loadAll()).toHaveLength(1);
  });

  test('schemaVersion 不符或结构不合法的快照被忽略', () => {
    const directory = makeSnapshotDirectory();
    const store = createRoomSnapshotStore({ directory });
    store.save(validRecord({ code: '000007' }));
    store.save(validRecord({ code: '000008', schemaVersion: ROOM_SNAPSHOT_SCHEMA_VERSION + 1 }));
    store.save(validRecord({ code: '000009', players: [] }));

    const loaded = store.loadAll();

    expect(loaded.map((record) => record.code)).toEqual(['000007']);
  });

  test('超过保留期的快照在 loadAll 时被清理', () => {
    const directory = makeSnapshotDirectory();
    const fresh = createRoomSnapshotStore({ directory, retentionMs: 60_000 });
    fresh.save(validRecord());
    expect(fresh.loadAll()).toHaveLength(1);

    // 时钟推到 10 分钟后：1 秒保留期意味着该快照已过期。
    const later = createRoomSnapshotStore({ directory, retentionMs: 1_000, now: () => Date.now() + 600_000 });
    expect(later.loadAll()).toHaveLength(0);
    expect(readdirSync(directory).filter((name) => name.endsWith('.json'))).toHaveLength(0);
  });

  test('remove 删除指定房间的快照', () => {
    const directory = makeSnapshotDirectory();
    const store = createRoomSnapshotStore({ directory });
    store.save(validRecord({ code: '000007' }));
    store.save(validRecord({ code: '000008' }));

    store.remove('000007');

    expect(store.loadAll().map((record) => record.code)).toEqual(['000008']);
  });
});

describe('RoomManager 落盘与恢复', () => {
  test('startRoom 后快照里带着完整对局状态', () => {
    const directory = makeSnapshotDirectory();
    const harness = startTwoHumanRoom(createRoomSnapshotStore({ directory }));
    const state = harness.manager.getGameSnapshot(ROOM_CODE);
    expect(state).not.toBeNull();

    const record = readRecord(directory);

    expect(record.status).toBe('playing');
    expect(record.players.map((player) => player.id)).toEqual(['host', 'guest']);
    expect(record.players.map((player) => player.token)).toEqual(['tok-host', 'tok-guest']);
    expect(record.gameState).toEqual(state);
  });

  test('「重启」后新建 RoomManager 能把进行中的对局原样恢复，且真人一律先置离线', () => {
    const directory = makeSnapshotDirectory();
    startTwoHumanRoom(createRoomSnapshotStore({ directory }));
    const before = harnessState(directory);

    const restarted = createHarness({ snapshotStore: createRoomSnapshotStore({ directory }) });

    const publicRoom = restarted.manager.getPublicRoom(ROOM_CODE);
    expect(publicRoom?.status).toBe('playing');
    expect(publicRoom?.map.ref).toEqual(CHINA_PACK.ref);
    expect(publicRoom?.players).toEqual([
      { id: 'host', nickname: '房主', isBot: false, online: false },
      { id: 'guest', nickname: '客人', isBot: false, online: false },
    ]);
    expect(restarted.manager.getGameSnapshot(ROOM_CODE)).toEqual(offlineHumans(before));
  });

  test('恢复后客户端可用原 token 重连继续（resumeRoom 通过且置为在线）', () => {
    const directory = makeSnapshotDirectory();
    startTwoHumanRoom(createRoomSnapshotStore({ directory }));
    const restarted = createHarness({ snapshotStore: createRoomSnapshotStore({ directory }) });

    const resumed = restarted.manager.resumeRoom(ROOM_CODE, 'host', 'tok-host');

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.players.find((player) => player.id === 'host')?.online).toBe(true);
    expect(restarted.manager.resumeRoom(ROOM_CODE, 'guest', 'wrong-token').ok).toBe(false);
  });

  test('每一次回合推进都会刷新快照（不丢步）', () => {
    const directory = makeSnapshotDirectory();
    const store = createRoomSnapshotStore({ directory });
    const harness = startTwoHumanRoom(store);
    const before = harness.manager.getGameSnapshot(ROOM_CODE);
    expect(before).not.toBeNull();

    const rolled = harness.manager.applyGameIntent(ROOM_CODE, 'host', { type: 'roll_dice' });
    expect(rolled.ok).toBe(true);

    const after = harness.manager.getGameSnapshot(ROOM_CODE);
    expect(after).not.toBeNull();
    expect(readRecord(directory).gameState).toEqual(after);
    expect(harness.manager.getGameSnapshot(ROOM_CODE)).not.toEqual(before);

    // 重启后恢复出的是「最后一次成功提交」的状态。
    const restarted = createHarness({ snapshotStore: createRoomSnapshotStore({ directory }) });
    expect(restarted.manager.getGameSnapshot(ROOM_CODE)).toEqual(offlineHumans(after!));
  });

  test('房主自定义规则的房间：开局用生效 config，重启后原样恢复', () => {
    const directory = makeSnapshotDirectory();
    const store = createRoomSnapshotStore({ directory });
    const harness = createHarness({
      playerIds: ['host', 'guest'],
      tokens: ['tok-host', 'tok-guest'],
      seed: seedWithHostFirst([
        { id: 'host', nickname: '房主', isBot: false },
        { id: 'guest', nickname: '客人', isBot: false },
      ]),
      snapshotStore: store,
    });
    expect(harness.manager.createRoom('房主', 'china-tour').ok).toBe(true);
    expect(harness.manager.joinRoom(ROOM_CODE, '客人').ok).toBe(true);

    const ruleConfig = { initialCash: 25000, maxHouseLevel: 3, mortgageInterestRate: 0.2 };
    const updated = harness.manager.updateRoomSettings(ROOM_CODE, 'host', { ruleConfig });
    expect(updated.ok).toBe(true);
    expect(harness.manager.startRoom(ROOM_CODE, 'host').ok).toBe(true);

    // 开局用的就是房间规则，而不是地图默认值。
    expect(harness.manager.getGameSnapshot(ROOM_CODE)?.config.initialCash).toBe(25000);
    expect(readRecord(directory).ruleConfig).toEqual(ruleConfig);

    const restarted = createHarness({ snapshotStore: createRoomSnapshotStore({ directory }) });

    // 自定义 config 的对局必须恢复得回来（快照 config 不等于地图默认值时曾被判损坏而整间丢弃）。
    expect(restarted.manager.getPublicRoom(ROOM_CODE)?.status).toBe('playing');
    expect(restarted.manager.getGameSnapshot(ROOM_CODE)?.config.initialCash).toBe(25000);
    expect(restarted.manager.getGameSnapshot(ROOM_CODE)?.config.maxHouseLevel).toBe(3);
    expect(restarted.manager.getRoomSettings(ROOM_CODE)).toMatchObject({ ruleConfig });
  });

  test('悔棋开关随快照落盘并在重启后恢复；旧快照缺这个字段则按「关闭」处理', () => {
    const directory = makeSnapshotDirectory();
    const harness = createHarness({
      playerIds: ['host', 'guest'],
      tokens: ['tok-host', 'tok-guest'],
      snapshotStore: createRoomSnapshotStore({ directory }),
    });
    expect(harness.manager.createRoom('房主', 'china-tour').ok).toBe(true);
    expect(harness.manager.joinRoom(ROOM_CODE, '客人').ok).toBe(true);
    expect(harness.manager.updateRoomSettings(ROOM_CODE, 'host', { minimalUndoEnabled: true }).ok).toBe(true);
    expect(readRecord(directory).minimalUndoEnabled).toBe(true);

    const restarted = createHarness({ snapshotStore: createRoomSnapshotStore({ directory }) });
    expect(restarted.manager.getRoomSettings(ROOM_CODE)?.minimalUndoEnabled).toBe(true);

    // 旧版本写下的快照里根本没这个字段：恢复时按「关闭」处理即可，
    // 绝不能因为少一个可选的设置项就把整间房判成损坏丢掉。
    const legacy = readRecord(directory);
    delete (legacy as { minimalUndoEnabled?: boolean }).minimalUndoEnabled;
    writeFileSync(snapshotFile(directory), JSON.stringify(legacy), 'utf8');

    const legacyRestarted = createHarness({ snapshotStore: createRoomSnapshotStore({ directory }) });
    expect(legacyRestarted.manager.getPublicRoom(ROOM_CODE)?.status).toBe('lobby');
    expect(legacyRestarted.manager.getRoomSettings(ROOM_CODE)?.minimalUndoEnabled).toBe(false);
  });

  test('房间规则越界或非房主提交时被拒，已有设置不被污染', () => {
    const directory = makeSnapshotDirectory();
    const harness = createHarness({
      playerIds: ['host', 'guest'],
      tokens: ['tok-host', 'tok-guest'],
      snapshotStore: createRoomSnapshotStore({ directory }),
    });
    expect(harness.manager.createRoom('房主', 'china-tour').ok).toBe(true);
    expect(harness.manager.joinRoom(ROOM_CODE, '客人').ok).toBe(true);

    const byGuest = harness.manager.updateRoomSettings(ROOM_CODE, 'guest', {
      ruleConfig: { initialCash: 25000, maxHouseLevel: 3, mortgageInterestRate: 0.2 },
    });
    expect(byGuest.ok).toBe(false);

    const tooHigh = harness.manager.updateRoomSettings(ROOM_CODE, 'host', {
      ruleConfig: {
        initialCash: 25000,
        maxHouseLevel: CHINA_PACK.game.config.maxHouseLevel + 1,
        mortgageInterestRate: 0.2,
      },
    });
    expect(tooHigh.ok).toBe(false);

    expect(harness.manager.getRoomSettings(ROOM_CODE)).toMatchObject({ ruleConfig: null });
  });

  test('房间解散后快照被删除，不会在重启时复活', () => {
    const directory = makeSnapshotDirectory();
    const store = createRoomSnapshotStore({ directory });
    const harness = createHarness({
      playerIds: ['host'],
      tokens: ['tok-host'],
      snapshotStore: store,
    });
    expect(harness.manager.createRoom('房主', 'china-tour').ok).toBe(true);
    expect(store.loadAll()).toHaveLength(1);

    const left = harness.manager.leaveRoom(ROOM_CODE, 'host');

    expect(left.ok).toBe(true);
    expect(store.loadAll()).toHaveLength(0);
    expect(readdirSync(directory).filter((name) => name.endsWith('.json'))).toHaveLength(0);
  });

  test('损坏快照不阻断启动：坏房间被跳过，好房间照常恢复', () => {
    const directory = makeSnapshotDirectory();
    const store = createRoomSnapshotStore({ directory });
    startTwoHumanRoom(store);
    writeFileSync(snapshotFile(directory, '000099'), 'not json at all', 'utf8');

    const errors: string[] = [];
    const restarted = createHarness({
      snapshotStore: createRoomSnapshotStore({ directory }),
      onServerError: (message) => errors.push(message),
    });

    expect(restarted.manager.getPublicRoom('000099')).toBeNull();
    expect(restarted.manager.getPublicRoom(ROOM_CODE)?.status).toBe('playing');
    expect(errors).toHaveLength(0);
  });

  test('快照里的 gameState 被篡改时该房间被丢弃并报错，其余房间不受影响', () => {
    const directory = makeSnapshotDirectory();
    const store = createRoomSnapshotStore({ directory });
    startTwoHumanRoom(store);

    const tampered = readRecord(directory);
    const tamperedState = tampered.gameState as GameState;
    writeFileSync(
      snapshotFile(directory),
      JSON.stringify({ ...tampered, gameState: { ...tamperedState, mapRef: { id: 'other-map', version: 1, contentHash: 'deadbeef' } } }),
      'utf8',
    );

    const errors: string[] = [];
    const restarted = createHarness({
      snapshotStore: createRoomSnapshotStore({ directory }),
      onServerError: (message) => errors.push(message),
    });

    expect(restarted.manager.getPublicRoom(ROOM_CODE)).toBeNull();
    expect(errors.some((message) => message.includes('not restorable'))).toBe(true);
    // 不可恢复的快照已被丢弃，不会每轮启动都白试一次。
    expect(createRoomSnapshotStore({ directory }).loadAll()).toHaveLength(0);
  });

  test('快照写盘失败只记录错误，对局照常继续（落盘不是对局的前置条件）', () => {
    const failingStore: RoomSnapshotStore = {
      save() {
        throw new Error('disk full');
      },
      loadAll() {
        return [];
      },
      remove() {
        return undefined;
      },
      prune() {
        return 0;
      },
    };
    const errors: string[] = [];
    const harness = createHarness({
      playerIds: ['host', 'guest'],
      tokens: ['tok-host', 'tok-guest'],
      seed: seedWithHostFirst([
        { id: 'host', nickname: '房主', isBot: false },
        { id: 'guest', nickname: '客人', isBot: false },
      ]),
      snapshotStore: failingStore,
      onServerError: (message) => errors.push(message),
    });

    expect(harness.manager.createRoom('房主', 'china-tour').ok).toBe(true);
    expect(harness.manager.joinRoom(ROOM_CODE, '客人').ok).toBe(true);
    expect(harness.manager.startRoom(ROOM_CODE, 'host').ok).toBe(true);
    expect(errors.filter((message) => message.includes('snapshot save failed')).length).toBeGreaterThan(0);

    expect(harness.manager.applyGameIntent(ROOM_CODE, 'host', { type: 'roll_dice' }).ok).toBe(true);
    expect(harness.manager.getPublicRoom(ROOM_CODE)?.status).toBe('playing');
  });
});

/** 从磁盘快照里取出当前对局状态（用于「重启前」的基准值）。 */
function harnessState(directory: string): GameState {
  const record = readRecord(directory);
  expect(record.gameState).not.toBeNull();
  return record.gameState as GameState;
}
