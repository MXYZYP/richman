import { describe, expect, test } from 'vitest';
import { RoomManager } from '../rooms/roomManager';
import type { RoomDomainEvent, RoomManagerDependencies } from '../rooms/roomTypes';

type TimerHandle = { callback: () => void; delayMs: number; active: boolean };

function createHarness(playerIds: string[], tokens: string[]) {
  const timers: TimerHandle[] = [];
  let pid = 0;
  let tid = 0;
  const dependencies: RoomManagerDependencies<TimerHandle> = {
    generatePlayerId() {
      return playerIds[pid++] ?? `player-${pid}`;
    },
    generateToken() {
      return tokens[tid++] ?? `token-${tid}`;
    },
    nextRoomNumber() {
      return 7;
    },
    compareTokens(actual, supplied) {
      return actual === supplied;
    },
    setTimer(callback, delayMs) {
      const handle: TimerHandle = {
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
    onAsyncEvents() {},
    generateGameSeed() {
      return 'game-seed';
    },
    nextAutomationDelayMs() {
      return 1000;
    },
  };
  return { manager: new RoomManager<TimerHandle>(dependencies), timers };
}

function startTwoHuman(manager: RoomManager<unknown>): void {
  expect(manager.createRoom('房主', 'china-tour').ok).toBe(true);
  expect(manager.joinRoom('000007', '客人').ok).toBe(true);
  expect(manager.startRoom('000007', 'host').ok).toBe(true);
}

describe('kickPlayer 对局内房主踢人（出局语义）', () => {
  test('对局中房主踢人 = 强制出局：被踢者破产、地产释放、仅剩一人即终局', () => {
    const { manager } = createHarness(['host', 'guest'], ['tok-host', 'tok-guest']);
    startTwoHuman(manager);

    const kicked = manager.kickPlayer('000007', 'host', 'guest');
    expect(kicked.ok).toBe(true);
    if (!kicked.ok) throw new Error('kickPlayer 应成功');

    // 广播了游戏快照（客户端据此刷新出局状态）。
    expect(kicked.events.some((event: RoomDomainEvent) => event.type === 'game_snapshot')).toBe(true);

    const state = manager.getGameSnapshot('000007');
    expect(state).not.toBeNull();
    // 被踢者破产（出局）。
    expect(state!.players.find((player) => player.id === 'guest')?.bankrupt).toBe(true);
    // 两人局：对手（房主）获胜，直接终局。
    const alive = state!.players.filter((player) => !player.bankrupt);
    expect(alive).toHaveLength(1);
    expect(alive[0]!.id).toBe('host');
    expect(state!.phase).toBe('game_over');
    expect(state!.winnerId).toBe('host');
  });

  test('踢掉非当前行动者不打断回合；其破产后从行动轮次跳过', () => {
    const { manager } = createHarness(['host', 'guest', 'guest2'], ['tok-host', 'tok-guest', 'tok-guest2']);
    expect(manager.createRoom('房主', 'china-tour').ok).toBe(true);
    expect(manager.joinRoom('000007', '客人A').ok).toBe(true);
    expect(manager.joinRoom('000007', '客人B').ok).toBe(true);
    expect(manager.startRoom('000007', 'host').ok).toBe(true);

    // 找到当前行动者；若是房主则先让出回合，使当前行动者变为一名客人。
    let current = manager.getGameSnapshot('000007')!.currentPlayerId;
    if (current === 'host') {
      expect(manager.applyGameIntent('000007', 'host', { type: 'end_turn' }).ok).toBe(true);
      current = manager.getGameSnapshot('000007')!.currentPlayerId;
    }
    expect(current).not.toBe('host');

    const kicked = manager.kickPlayer('000007', 'host', current);
    expect(kicked.ok).toBe(true);

    const after = manager.getGameSnapshot('000007')!;
    // 被踢者已出局，且不再指向他。
    expect(after.players.find((player) => player.id === current)?.bankrupt).toBe(true);
    expect(after.currentPlayerId).not.toBe(current);
    expect(after.players.filter((player) => !player.bankrupt).map((player) => player.id)).not.toContain(current);
  });

  test('房主不能踢自己；非房主不能踢人', () => {
    const { manager } = createHarness(['host', 'guest'], ['tok-host', 'tok-guest']);
    startTwoHuman(manager);

    expect(manager.kickPlayer('000007', 'host', 'host').ok).toBe(false);
    expect(manager.kickPlayer('000007', 'guest', 'host').ok).toBe(false);
  });

  test('对局中踢观众仍直接将其移出房间（不影响在局玩家）', () => {
    const { manager } = createHarness(['host', 'guest'], ['tok-host', 'tok-guest']);
    startTwoHuman(manager);
    const joined = manager.joinRoom('000007', '观众', undefined, 'spectator');
    expect(joined.ok).toBe(true);
    if (!joined.ok) throw new Error('spectator join 应成功');
    expect(manager.getPublicRoom('000007')?.spectators).toHaveLength(1);

    // 观众 id 由依赖注入生成，与昵称不同；踢人必须按 id 定位。
    const kicked = manager.kickPlayer('000007', 'host', joined.value.playerId);
    expect(kicked.ok).toBe(true);
    // 观众被移除，在局玩家保持不变（未被出局）。
    expect(manager.getPublicRoom('000007')?.spectators).toHaveLength(0);
    expect(manager.getGameSnapshot('000007')!.players.filter((player) => !player.bankrupt)).toHaveLength(2);
  });

  test('已被踢出局（破产）的玩家再次被踢不会重复结算，返回成功且不破坏终局', () => {
    const { manager } = createHarness(['host', 'guest'], ['tok-host', 'tok-guest']);
    startTwoHuman(manager);
    expect(manager.kickPlayer('000007', 'host', 'guest').ok).toBe(true);

    // 二次踢已被出局的玩家：引擎拒绝（已是破产态），回退为标记离线，整体仍成功。
    const again = manager.kickPlayer('000007', 'host', 'guest');
    expect(again.ok).toBe(true);
    const state = manager.getGameSnapshot('000007')!;
    expect(state.phase).toBe('game_over');
    expect(state.players.find((player) => player.id === 'guest')?.bankrupt).toBe(true);
  });
});
