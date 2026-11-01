import { describe, expect, it } from 'vitest';
import { RoomManager } from '../rooms/roomManager';
import type { RoomDomainEvent, RoomManagerDependencies } from '../rooms/roomTypes';

type TimerHandle = { id: string };

/**
 * `RoomManager.stats()` 是「此刻有多少人在玩」的唯一来源（运营 O2）。
 * 它只读、不广播、不改任何房间状态 —— 用真实的 RoomManager 走一遍才算验证过。
 */
function manager(): RoomManager<TimerHandle> {
  let player = 0;
  let token = 0;
  return new RoomManager<TimerHandle>({
    generatePlayerId: () => `p${++player}`,
    generateToken: () => `token-${++token}`,
    nextRoomNumber: () => 7,
    setTimer: () => ({ id: 'unused' }),
    clearTimer: () => undefined,
    compareTokens: (actual: string, expected: string) => actual === expected,
    onAsyncEvents: (_events: RoomDomainEvent[]) => undefined,
    generateGameSeed: () => 'stats-game-seed',
    nextAutomationDelayMs: () => 1000,
  } satisfies RoomManagerDependencies<TimerHandle>);
}

function createRoom(instance: RoomManager<TimerHandle>): { roomCode: string; hostId: string; token: string } {
  const created = instance.createRoom('房主', 'china-tour', '00112233445566778899aabbccddeeff');
  if (!created.ok) throw new Error(`createRoom failed: ${created.code}`);
  return { roomCode: created.value.room.roomCode, hostId: created.value.playerId, token: created.value.token };
}

describe('RoomManager.stats()', () => {
  it('starts empty', () => {
    expect(manager().stats()).toEqual({ rooms: 0, players: 0, playing: 0 });
  });

  it('counts rooms and online players', () => {
    const instance = manager();
    createRoom(instance);

    expect(instance.stats()).toEqual({ rooms: 1, players: 1, playing: 0 });
  });

  it('counts a room as playing only after it starts', () => {
    const instance = manager();
    const { roomCode, hostId } = createRoom(instance);
    expect(instance.stats().playing).toBe(0);
    // 开局最少两人（真人或电脑都行）：一人局在这里就会被拒，所以先加一个电脑。
    const added = instance.addBot(roomCode, hostId);
    expect(added.ok).toBe(true);

    const started = instance.startRoom(roomCode, hostId);

    expect(started.ok).toBe(true);
    expect(instance.stats().playing).toBe(1);
  });

  it('stops counting a player who disconnected, without dropping the room', () => {
    const instance = manager();
    const { roomCode, hostId } = createRoom(instance);

    const marked = instance.markDisconnected(roomCode, hostId);

    expect(marked.ok).toBe(true);
    const stats = instance.stats();
    expect(stats.rooms).toBe(1);
    expect(stats.players).toBe(0);
  });
});
