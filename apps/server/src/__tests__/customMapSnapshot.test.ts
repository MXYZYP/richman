// 工坊自定义图 · 阶段 3：快照恢复 + 防滥用。
// 覆盖：带包房间快照往返（大厅 + 对局中）/ 坏包快照整间丢弃 / mapRef 与包不符的拼装快照丢弃 /
//       全服存活上限 / 快照体积硬上限。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { chinaTourMap, computeContentHash } from '@richman/board-data';
import type { MapPack } from '@richman/board-data';
import type { RoomDomainEvent } from '../rooms/roomTypes';
import type { RoomSnapshotRecord } from '../rooms/roomSnapshotStore';
import { createRoomSnapshotStore, MAX_SNAPSHOT_BYTES } from '../rooms/roomSnapshotStore';
import { RoomManager } from '../rooms/roomManager';

const CUSTOM_MAP_ID = 'my-workshop-map';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeSnapshotDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'richman-custom-snap-'));
  tempDirectories.push(directory);
  return directory;
}

function buildCustomPack(): MapPack {
  const pack = structuredClone(chinaTourMap) as MapPack & {
    ref: { id: string; version: number; contentHash: string };
  };
  pack.ref = { id: CUSTOM_MAP_ID, version: 1, contentHash: '' };
  pack.ref.contentHash = computeContentHash(pack);
  return pack;
}

function createManager(customMapRoomsEnabled: boolean, snapshotDir?: string): {
  manager: RoomManager<NodeJS.Timeout>;
  events: RoomDomainEvent[];
  errors: string[];
} {
  const events: RoomDomainEvent[] = [];
  const errors: string[] = [];
  let playerSeq = 0;
  let tokenSeq = 0;
  let roomSeq = 0;
  const manager = new RoomManager<NodeJS.Timeout>({
    generatePlayerId: () => `player-${++playerSeq}`,
    generateToken: () => `token-${++tokenSeq}`,
    nextRoomNumber: () => ++roomSeq,
    compareTokens: (actual, supplied) => actual === supplied,
    setTimer: (callback) => setTimeout(callback, 60_000),
    clearTimer: (handle) => clearTimeout(handle),
    onAsyncEvents: (batch) => {
      events.push(...batch);
    },
    generateGameSeed: () => 'stage3-seed',
    nextAutomationDelayMs: () => 50,
    customMapRoomsEnabled,
    // retentionMs: 0 = 测试期间不做保留期清理，快照在两次「重启」之间一定还在。
    ...(snapshotDir === undefined
      ? {}
      : { snapshotStore: createRoomSnapshotStore({ directory: snapshotDir, retentionMs: 0 }) }),
    onServerError: (message) => errors.push(message),
  });
  return { manager, events, errors };
}

function expectOk<T>(result: { ok: boolean; message?: string; value?: T }): T {
  expect(result.ok).toBe(true);
  return result.value as T;
}

/** 手写一条最小可读的快照记录（只过 isRoomSnapshotRecord 的形状关）。 */
function buildSnapshotRecord(overrides: Partial<RoomSnapshotRecord>): RoomSnapshotRecord {
  return {
    schemaVersion: 1,
    savedAt: Date.now(),
    code: '000099',
    mapRef: { ...chinaTourMap.ref },
    mapTitle: '测试图',
    status: 'lobby',
    hostId: 'host-1',
    botDifficulty: 'normal',
    players: [
      { id: 'host-1', nickname: '房主', token: 'token-1', isBot: false, online: true, joinRequestId: null, joinRequestNickname: null },
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

describe('D6 阶段 3：工坊自定义图快照恢复与防滥用', () => {
  test('带包房间快照往返：重启后包、ref、标题原样回来', () => {
    const dir = makeSnapshotDirectory();
    const pack = buildCustomPack();
    const first = createManager(true, dir);
    const created = expectOk(first.manager.createRoom('房主', CUSTOM_MAP_ID, 'req-1', 'normal', pack));
    first.manager.dispose();

    const second = createManager(true, dir);
    expect(second.manager.getRoomCustomMapPack(created.roomCode)).toEqual(pack);
    // 恢复出的房间投影必须挂着同一张自定义图。
    const resumed = second.manager.getPublicRoom(created.roomCode);
    expect(resumed).not.toBeNull();
    expect(resumed?.map.ref).toEqual(pack.ref);
    expect(resumed?.map.title).toBe(pack.metadata.title);
    second.manager.dispose();
  });

  test('对局中的带包房间重启后恢复为 playing，快照 ref 指向自定义图', () => {
    const dir = makeSnapshotDirectory();
    const pack = buildCustomPack();
    const first = createManager(true, dir);
    const created = expectOk(first.manager.createRoom('房主', CUSTOM_MAP_ID, 'req-1', 'normal', pack));
    expectOk(first.manager.addBot(created.roomCode, created.playerId));
    expectOk(first.manager.startRoom(created.roomCode, created.playerId));
    first.manager.dispose();

    const second = createManager(true, dir);
    const resumed = second.manager.getPublicRoom(created.roomCode);
    expect(resumed?.status).toBe('playing');
    const snapshot = second.manager.getGameSnapshot(created.roomCode);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.mapRef.id).toBe(CUSTOM_MAP_ID);
    expect(second.manager.getRoomCustomMapPack(created.roomCode)).toEqual(pack);
    second.manager.dispose();
  });

  test('快照里的包被篡改（哈希不符）→ 整间丢弃并记录服务端错误', () => {
    const dir = makeSnapshotDirectory();
    const pack = buildCustomPack();
    pack.metadata.description = `${pack.metadata.description ?? ''}篡改`;
    writeFileSync(
      join(dir, 'room-000099.json'),
      JSON.stringify(buildSnapshotRecord({ mapRef: { ...pack.ref }, mapTitle: pack.metadata.title, customMapPack: pack })),
      'utf8',
    );

    const second = createManager(true, dir);
    expect(second.manager.getPublicRoom('000099')).toBeNull();
    expect(second.manager.getRoomCustomMapPack('000099')).toBeUndefined();
    expect(second.errors.some((message) => message.includes('custom map pack is invalid'))).toBe(true);
    second.manager.dispose();
  });

  test('快照 mapRef 与包 ref 三元组不符的拼装快照 → 整间丢弃', () => {
    const dir = makeSnapshotDirectory();
    const pack = buildCustomPack();
    writeFileSync(
      join(dir, 'room-000099.json'),
      JSON.stringify(buildSnapshotRecord({
        mapRef: { ...chinaTourMap.ref },
        mapTitle: chinaTourMap.metadata.title,
        customMapPack: pack,
      })),
      'utf8',
    );

    const second = createManager(true, dir);
    expect(second.manager.getPublicRoom('000099')).toBeNull();
    expect(second.errors.some((message) => message.includes('does not match its custom pack'))).toBe(true);
    second.manager.dispose();
  });

  test('全服自定义图房间存活上限：第 21 间被拒，内置图不受影响', () => {
    const { manager } = createManager(true);
    const pack = buildCustomPack();
    for (let index = 0; index < 20; index += 1) {
      expectOk(manager.createRoom('房主', CUSTOM_MAP_ID, `req-${index}`, 'normal', pack));
    }
    const overLimit = manager.createRoom('房主', CUSTOM_MAP_ID, 'req-over', 'normal', pack);
    expect(overLimit.ok).toBe(false);
    expect(overLimit.message ?? '').toContain('limit reached');
    // 内置图建房与配额无关。
    const builtin = expectOk(manager.createRoom('房主', 'china-tour', 'req-builtin'));
    expect(builtin.room.map.ref).toEqual(chinaTourMap.ref);
    manager.dispose();
  });

  test('快照体积硬上限：超 600KB 拒写（抛错），不产出超限文件', () => {
    const dir = makeSnapshotDirectory();
    const store = createRoomSnapshotStore({ directory: dir, retentionMs: 0 });
    const record = buildSnapshotRecord({
      gameState: { pad: 'x'.repeat(MAX_SNAPSHOT_BYTES + 1024) },
    });
    expect(() => store.save(record)).toThrow(/over the/);
    // 上限内照常可写。
    store.save(buildSnapshotRecord({}));
  });
});
