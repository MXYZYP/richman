// 工坊自定义图房间（D6 阶段 1）：RoomManager 层的行为测试。
// 覆盖：开关关闭拒绝 / 开关开启建房成功且房间持有包 / mapId 与包不符拒绝 /
//       房规上限按自定义包校验 / 自定义图能正常开局（game_snapshot 带自定义 ref）/ 内置图回归。
import { describe, expect, test } from 'vitest';
import { chinaTourMap, computeContentHash } from '@richman/board-data';
import type { MapPack } from '@richman/board-data';
import type { RoomDomainEvent } from '../rooms/roomTypes';
import { RoomManager } from '../rooms/roomManager';

const CUSTOM_MAP_ID = 'my-workshop-map';

function buildCustomPack(): MapPack {
  const pack = structuredClone(chinaTourMap) as MapPack;
  pack.ref = { id: CUSTOM_MAP_ID, version: 1, contentHash: '' };
  pack.ref.contentHash = computeContentHash(pack);
  return pack;
}

interface CapturedResult<T> {
  result: { ok: boolean; code?: string; message?: string; value?: T };
  events: RoomDomainEvent[];
}

function createManager(customMapRoomsEnabled: boolean): {
  manager: RoomManager<NodeJS.Timeout>;
  events: RoomDomainEvent[];
} {
  const events: RoomDomainEvent[] = [];
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
    generateGameSeed: () => 'custom-map-room-seed',
    nextAutomationDelayMs: () => 50,
    customMapRoomsEnabled,
  });
  return { manager, events };
}

function expectOk<T>(captured: CapturedResult<T>): T {
  expect(captured.result.ok).toBe(true);
  return captured.result.value as T;
}

function expectRejected(captured: CapturedResult<unknown>, needle: string): void {
  expect(captured.result.ok).toBe(false);
  expect(captured.result.message ?? '').toContain(needle);
}

let createRoomRequestSeq = 0;

function createRoom(
  manager: RoomManager<NodeJS.Timeout>,
  mapId: string,
  customMapPack: MapPack | undefined,
): CapturedResult<{ roomCode: string; playerId: string; token: string; room: { map: { ref: unknown; title: string } } }> {
  const events: RoomDomainEvent[] = [];
  // requestId 必须全局唯一：同一 manager 上连开两间房时，重复 id 会被当成重放请求拒绝。
  const result = manager.createRoom('房主', mapId, `req-${++createRoomRequestSeq}-x`, 'normal', customMapPack);
  return { result, events };
}

describe('D6 阶段 1：工坊自定义图房间', () => {
  test('开关关闭时，带包建房被拒（防半成品房间上线）', () => {
    const { manager } = createManager(false);
    const captured = createRoom(manager, CUSTOM_MAP_ID, buildCustomPack());
    expectRejected(captured, 'not enabled');
  });

  test('开关开启：建房成功，房间地图 ref/title 来自自定义包', () => {
    const { manager } = createManager(true);
    const pack = buildCustomPack();
    const created = expectOk(createRoom(manager, CUSTOM_MAP_ID, pack));
    expect(created.room.map.ref).toEqual(pack.ref);
    expect(created.room.map.title).toBe(pack.metadata.title);
  });

  test('payload mapId 与包内 ref.id 不一致拒绝', () => {
    const { manager } = createManager(true);
    const captured = createRoom(manager, 'another-id', buildCustomPack());
    expectRejected(captured, 'does not match');
  });

  test('未过门禁的包（哈希被篡改）在建房时被拒', () => {
    const { manager } = createManager(true);
    const pack = buildCustomPack();
    pack.metadata.description = `${pack.metadata.description ?? ''}篡改`;
    const captured = createRoom(manager, CUSTOM_MAP_ID, pack);
    expectRejected(captured, 'Custom map rejected');
  });

  test('房规 maxHouseLevel 按自定义包的 game.config 校验', () => {
    const { manager } = createManager(true);
    const pack = buildCustomPack();
    const created = expectOk(createRoom(manager, CUSTOM_MAP_ID, pack));
    const maxLevel = pack.game.config.maxHouseLevel;
    expect(maxLevel).toBeGreaterThanOrEqual(1);

    const over = manager.updateRoomSettings(created.roomCode, created.playerId, {
      ruleConfig: { initialCash: 15000, maxHouseLevel: maxLevel + 1, mortgageInterestRate: 0.1 },
    });
    expect(over.ok).toBe(false);

    const within = manager.updateRoomSettings(created.roomCode, created.playerId, {
      ruleConfig: { initialCash: 15000, maxHouseLevel: maxLevel, mortgageInterestRate: 0.1 },
    });
    expect(within.ok).toBe(true);
  });

  test('自定义图房间能正常开局，game_snapshot 携带自定义 ref', () => {
    const { manager, events } = createManager(true);
    const pack = buildCustomPack();
    const created = expectOk(createRoom(manager, CUSTOM_MAP_ID, pack));
    const bot = manager.addBot(created.roomCode, created.playerId);
    expect(bot.ok).toBe(true);
    const started = manager.startRoom(created.roomCode, created.playerId);
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    expect(started.value.status).toBe('playing');
    // startRoom 的 game_snapshot 是同步事件，随返回值顶层 events 下发（onAsyncEvents 只收异步批次）。
    const snapshot = started.events.find((event) => event.type === 'game_snapshot') as
      | { type: 'game_snapshot'; state: { mapRef: { id: string } } }
      | undefined;
    expect(snapshot).toBeDefined();
    expect(snapshot?.state.mapRef.id).toBe(CUSTOM_MAP_ID);
  });

  test('内置图建房回归：不带 customMapPack 行为不变', () => {
    const { manager } = createManager(true);
    const created = expectOk(createRoom(manager, 'china-tour', undefined));
    expect(created.room.map.ref).toEqual(chinaTourMap.ref);
  });

  test('getRoomCustomMapPack：自定义图房间返回包，内置图房间返回 undefined', () => {
    const { manager } = createManager(true);
    const pack = buildCustomPack();
    const created = expectOk(createRoom(manager, CUSTOM_MAP_ID, pack));
    expect(manager.getRoomCustomMapPack(created.roomCode)).toEqual(pack);
    const builtin = expectOk(createRoom(manager, 'china-tour', undefined));
    expect(manager.getRoomCustomMapPack(builtin.roomCode)).toBeUndefined();
  });
});
