import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GameState, Intent } from '@richman/engine';
import type { TurnDeadlineInfo } from '@richman/protocol';
import { RoomManager } from '../rooms/roomManager';

/**
 * 每回合限时（#107）的服务端行为。
 *
 * 这一套断言刻意全部落在**可观察的对外行为**上（广播事件 + 房间钟的排期 + 状态是否推进），
 * 而不是去读私有字段：限时的难点从来不是「算对秒数」，而是
 *   ① 该排的时候排了、② 不该排的时候一根都不排、③ 到点真的把回合推进一步、
 *   ④ 人不在（掉线 / 电脑）时不与托管和自动化抢方向盘、⑤ 迟到的钟不会代走别人。
 */

type RoomStatus = 'lobby' | 'playing' | 'ended';

interface PublicRoomState {
  roomCode: string;
  status: RoomStatus;
  hostId: string;
  players: { id: string; nickname: string; isBot: boolean; online: boolean }[];
  spectators: { id: string; nickname: string; online: boolean }[];
  takeoverPlayerId: string | null;
  map: { ref: GameState['mapRef']; title: string };
}

type RoomDomainEvent =
  | { type: 'room_state'; roomCode: string; room: PublicRoomState }
  | { type: 'room_settings'; roomCode: string; settings: { turnTimeLimitSec: number } }
  | { type: 'undo_available'; roomCode: string; playerId: string | null }
  | { type: 'turn_deadline'; roomCode: string; info: TurnDeadlineInfo }
  | { type: 'turn_timeout'; roomCode: string; playerId: string; nickname: string }
  | { type: 'player_connection'; roomCode: string; playerId: string; online: boolean }
  | { type: 'room_closed'; roomCode: string; reason: 'empty_lobby' | 'lobby_idle_timeout' }
  | { type: 'game_events'; roomCode: string; events: unknown[] }
  | { type: 'game_snapshot'; roomCode: string; state: GameState };

type RoomSuccess<T> = { ok: true; value: T; events: RoomDomainEvent[] };
type RoomFailure = { ok: false; code: string; message: string };
type RoomResult<T> = RoomSuccess<T> | RoomFailure;

interface RoomManagerContract {
  createRoom(nickname: string, mapId: string, requestId?: string): RoomResult<{ roomCode: string; playerId: string; token: string; room: PublicRoomState }>;
  joinRoom(roomCode: string, nickname: string, requestId?: string, role?: 'player' | 'spectator'): RoomResult<{ playerId: string; token: string; room: PublicRoomState }>;
  addBot(roomCode: string, requesterId: string): RoomResult<PublicRoomState>;
  updateRoomSettings(roomCode: string, requesterId: string, patch: { turnTimeLimitSec?: number }): RoomResult<{ turnTimeLimitSec: number }>;
  getRoomSettings(roomCode: string): { turnTimeLimitSec: number } | null;
  getTurnDeadline(roomCode: string): TurnDeadlineInfo | null;
  getPublicRoom(roomCode: string): PublicRoomState | null;
  getGameSnapshot(roomCode: string): GameState | null;
  startRoom(roomCode: string, requesterId: string): RoomResult<PublicRoomState>;
  applyGameIntent(roomCode: string, playerId: string, intent: Intent): { ok: boolean; events?: RoomDomainEvent[] };
  markDisconnected(roomCode: string, playerId: string): RoomResult<PublicRoomState | null>;
  resumeRoom(roomCode: string, playerId: string, token: string): RoomResult<PublicRoomState>;
  dispose(): void;
}

type TimerHandle = { callback: () => void; delayMs: number; active: boolean; timerId?: NodeJS.Timeout };

const ROOM_CODE = '000101';

function createManager(options: { roomNumber?: number } = {}): {
  manager: RoomManagerContract;
  asyncEvents: RoomDomainEvent[];
  timers: TimerHandle[];
} {
  const asyncEvents: RoomDomainEvent[] = [];
  const timers: TimerHandle[] = [];
  let playerIdIndex = 0;
  let tokenIndex = 0;

  const manager = new RoomManager({
    generatePlayerId: () => `player-${playerIdIndex++}`,
    generateToken: () => `token-${tokenIndex++}`,
    nextRoomNumber: () => options.roomNumber ?? 101,
    compareTokens: (actual, supplied) => actual === supplied,
    setTimer(callback, delayMs) {
      const handle: TimerHandle = { callback, delayMs, active: true };
      handle.timerId = setTimeout(() => {
        if (handle.active) callback();
      }, delayMs);
      timers.push(handle);
      return handle;
    },
    clearTimer(handle) {
      const target = handle as TimerHandle;
      target.active = false;
      clearTimeout(target.timerId);
    },
    onAsyncEvents(events) {
      asyncEvents.push(...(events as RoomDomainEvent[]));
    },
    generateGameSeed: () => 'turn-timer-seed',
    nextAutomationDelayMs: () => 1000,
  }) as unknown as RoomManagerContract;

  return { manager, asyncEvents, timers };
}

/** 建一间「房主 + 一名真人对手」的房间，并把当前行动者（房主）返回给调用方。 */
function setupPlayingRoom(manager: RoomManagerContract): { roomCode: string; hostId: string; guestId: string } {
  const created = manager.createRoom('房主', 'china-tour');
  if (!created.ok) throw new Error(created.message);
  const joined = manager.joinRoom(created.value.roomCode, '对手');
  if (!joined.ok) throw new Error(joined.message);
  const started = manager.startRoom(created.value.roomCode, created.value.playerId);
  if (!started.ok) throw new Error(started.message);
  return { roomCode: created.value.roomCode, hostId: created.value.playerId, guestId: joined.value.playerId };
}

/** 当前活跃的「回合钟」计时器（只看本用例自己配的那一档延迟）。 */
function activeTurnTimers(timers: TimerHandle[], delayMs: number): TimerHandle[] {
  return timers.filter((timer) => timer.delayMs === delayMs && timer.active);
}

describe('RoomManager turn time limit (#107)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  test('an unlimited room (the default) never schedules a clock and never broadcasts a deadline', () => {
    const { manager, asyncEvents, timers } = createManager();
    const { roomCode } = setupPlayingRoom(manager);

    expect(manager.getRoomSettings(roomCode)?.turnTimeLimitSec).toBe(0);
    expect(manager.getTurnDeadline(roomCode)).toEqual({ playerId: null, deadlineAt: null, limitSec: 0 });
    expect(timers).toHaveLength(0);
    expect(asyncEvents.filter((event) => event.type === 'turn_deadline')).toEqual([]);

    manager.dispose();
  });

  test('startRoom arms the clock for the opening actor and publishes a turn_deadline pointing at them', () => {
    const { manager, timers } = createManager();
    const created = manager.createRoom('房主', 'china-tour');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const joined = manager.joinRoom(created.value.roomCode, '对手');
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;

    const updated = manager.updateRoomSettings(created.value.roomCode, created.value.playerId, { turnTimeLimitSec: 30 });
    expect(updated.ok).toBe(true);

    const started = manager.startRoom(created.value.roomCode, created.value.playerId);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const deadline = started.events.find((event) => event.type === 'turn_deadline');
    expect(deadline).toEqual({
      type: 'turn_deadline',
      roomCode: ROOM_CODE,
      info: { playerId: created.value.playerId, deadlineAt: Date.now() + 30_000, limitSec: 30 },
    });
    expect(activeTurnTimers(timers, 30_000)).toHaveLength(1);

    manager.dispose();
  });

  test('when the clock expires the server plays one step for the idle player and reports it', () => {
    const { manager, asyncEvents, timers } = createManager();
    const created = manager.createRoom('房主', 'china-tour');
    if (!created.ok) throw new Error(created.message);
    const joined = manager.joinRoom(created.value.roomCode, '对手');
    if (!joined.ok) throw new Error(joined.message);
    manager.updateRoomSettings(created.value.roomCode, created.value.playerId, { turnTimeLimitSec: 30 });
    const started = manager.startRoom(created.value.roomCode, created.value.playerId);
    if (!started.ok) throw new Error(started.message);

    const before = manager.getGameSnapshot(created.value.roomCode);
    expect(before?.turnPhase).toBe('awaiting_roll');

    vi.advanceTimersByTime(30_000);

    // 通报在最前（客户端先弹一句人话），随后才是这一步的真实状态变更。
    expect(asyncEvents.map((event) => event.type)).toEqual(['turn_timeout', 'game_events', 'game_snapshot', 'turn_deadline']);
    expect(asyncEvents[0]).toEqual({
      type: 'turn_timeout',
      roomCode: ROOM_CODE,
      playerId: created.value.playerId,
      nickname: '房主',
    });

    const after = manager.getGameSnapshot(created.value.roomCode);
    expect(after?.lastDice).not.toBeNull();
    expect(after?.turnPhase).not.toBe('awaiting_roll');

    // 代走一步之后立刻重排下一根钟：挂机的人不会被「催一次就放过」。
    // 两道口径都要看：权威答案是房间钟指着谁，泄漏检查是「没有留下已跑完却仍标记在走的钟」。
    expect(manager.getTurnDeadline(created.value.roomCode)?.playerId).not.toBeNull();
    expect(activeTurnTimers(timers, 30_000)).toHaveLength(1);

    manager.dispose();
  });

  test('a stale clock cannot advance a turn that already moved on', () => {
    const { manager, asyncEvents, timers } = createManager();
    const created = manager.createRoom('房主', 'china-tour');
    if (!created.ok) throw new Error(created.message);
    const joined = manager.joinRoom(created.value.roomCode, '对手');
    if (!joined.ok) throw new Error(joined.message);
    manager.updateRoomSettings(created.value.roomCode, created.value.playerId, { turnTimeLimitSec: 30 });
    const started = manager.startRoom(created.value.roomCode, created.value.playerId);
    if (!started.ok) throw new Error(started.message);

    // 真人自己先把这一步走掉：这一下会取消旧钟并排一根新的（同一个 30s 档位）。
    const moved = manager.applyGameIntent(created.value.roomCode, created.value.playerId, { type: 'roll_dice' });
    expect(moved.ok).toBe(true);

    vi.advanceTimersByTime(30_000);

    // 恰好一次代走 —— 旧钟若没被真正清掉，这里会看到两次 turn_timeout（把同一个回合推进两步）。
    expect(asyncEvents.filter((event) => event.type === 'turn_timeout')).toHaveLength(1);
    expect(manager.getTurnDeadline(created.value.roomCode)?.playerId).not.toBeNull();
    expect(activeTurnTimers(timers, 30_000)).toHaveLength(1);

    manager.dispose();
  });

  test('the clock stops while the actor is offline and starts again on reconnect', () => {
    const { manager, timers } = createManager();
    const created = manager.createRoom('房主', 'china-tour');
    if (!created.ok) throw new Error(created.message);
    const joined = manager.joinRoom(created.value.roomCode, '对手');
    if (!joined.ok) throw new Error(joined.message);
    manager.updateRoomSettings(created.value.roomCode, created.value.playerId, { turnTimeLimitSec: 60 });
    const started = manager.startRoom(created.value.roomCode, created.value.playerId);
    if (!started.ok) throw new Error(started.message);
    expect(activeTurnTimers(timers, 60_000)).toHaveLength(1);

    const offline = manager.markDisconnected(created.value.roomCode, created.value.playerId);
    expect(offline.ok).toBe(true);
    if (!offline.ok) return;

    // 人都不在了，还催他倒计时毫无意义；此刻的权威回答是「没有钟在走」。
    expect(manager.getTurnDeadline(created.value.roomCode)).toEqual({ playerId: null, deadlineAt: null, limitSec: 60 });
    expect(activeTurnTimers(timers, 60_000)).toHaveLength(0);
    expect(offline.events.some((event) => event.type === 'turn_deadline')).toBe(true);

    const resumed = manager.resumeRoom(created.value.roomCode, created.value.playerId, created.value.token);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;

    // 重连后重新计时：否则「掉线一下再回来」就等于白拿无限思考时间。
    expect(activeTurnTimers(timers, 60_000)).toHaveLength(1);
    expect(manager.getTurnDeadline(created.value.roomCode)?.playerId).toBe(created.value.playerId);

    manager.dispose();
  });

  test('updateRoomSettings only accepts a whole number within 0-600 and rejects non-hosts', () => {
    const { manager } = createManager();
    const created = manager.createRoom('房主', 'china-tour');
    if (!created.ok) throw new Error(created.message);
    const joined = manager.joinRoom(created.value.roomCode, '对手');
    if (!joined.ok) throw new Error(joined.message);

    for (const bad of [-1, 1.5, 601, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = manager.updateRoomSettings(created.value.roomCode, created.value.playerId, { turnTimeLimitSec: bad });
      expect(result.ok).toBe(false);
    }
    // 0 是合法值（= 关闭限时），绝不能因为「假值」而被判非法。
    expect(manager.updateRoomSettings(created.value.roomCode, created.value.playerId, { turnTimeLimitSec: 0 }).ok).toBe(true);
    expect(manager.updateRoomSettings(created.value.roomCode, created.value.playerId, { turnTimeLimitSec: 120 }).ok).toBe(true);
    expect(manager.getRoomSettings(created.value.roomCode)?.turnTimeLimitSec).toBe(120);

    const byGuest = manager.updateRoomSettings(created.value.roomCode, joined.value.playerId, { turnTimeLimitSec: 60 });
    expect(byGuest.ok).toBe(false);
    expect(manager.getRoomSettings(created.value.roomCode)?.turnTimeLimitSec).toBe(120);

    manager.dispose();
  });

  test('a finished game stops the clock for good and tells the clients to drop the countdown', () => {
    const { manager, timers } = createManager();
    const created = manager.createRoom('房主', 'china-tour');
    if (!created.ok) throw new Error(created.message);
    manager.addBot(created.value.roomCode, created.value.playerId);
    manager.updateRoomSettings(created.value.roomCode, created.value.playerId, { turnTimeLimitSec: 30 });
    const started = manager.startRoom(created.value.roomCode, created.value.playerId);
    if (!started.ok) throw new Error(started.message);
    expect(activeTurnTimers(timers, 30_000)).toHaveLength(1);

    // 房主认输 → 场上只剩电脑 → 引擎直接终局。终局后绝不能再有人被倒计时判超时。
    const surrendered = manager.applyGameIntent(created.value.roomCode, created.value.playerId, { type: 'surrender' });
    expect(surrendered.ok).toBe(true);
    expect(manager.getPublicRoom(created.value.roomCode)?.status).toBe('ended');

    expect(activeTurnTimers(timers, 30_000)).toHaveLength(0);
    expect(manager.getTurnDeadline(created.value.roomCode)).toEqual({ playerId: null, deadlineAt: null, limitSec: 30 });
    expect(surrendered.events?.some((event) => event.type === 'turn_deadline')).toBe(true);

    // 即便再走完一整轮假时钟，也不会有任何代走发生。
    vi.advanceTimersByTime(120_000);
    expect(timers.filter((timer) => timer.active && timer.delayMs === 30_000)).toHaveLength(0);

    manager.dispose();
  });
});
