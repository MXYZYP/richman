import { describe, it, expect } from 'vitest';
import { getActiveMapPack } from '@richman/board-data';
import { applyIntent, createGame } from '../engine';
import { hydrateGameState } from '../hydrate';
import type { GameState } from '../types';

// 六人参赛（联机 2-6）关键边界：创建/颜色、保存恢复、轮转与破产。
// 单机表单仍限 2-4（由客户端入口约束），引擎层只把安全门放宽到 6。
const chinaMap = getActiveMapPack('china-tour');

const SIX_IDS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];

function makeSixPlayerGame(playerCount = 6, seed = 'six-players-test'): GameState {
  return createGame({
    mapRef: chinaMap.ref,
    ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: chinaMap.game.config,
    players: Array.from({ length: playerCount }, (_, i) => ({ id: `p${i + 1}`, nickname: `p${i + 1}` })),
    seed,
  });
}

/** 测试便利：当前玩家设为 players[0] 并进入 managing。*/
function makeManaging(playerCount = 6): GameState {
  const s = makeSixPlayerGame(playerCount);
  return { ...s, currentPlayerId: s.players[0].id, turnPhase: 'managing' as const };
}

describe('createGame 六人扩展', () => {
  it('六人局座次颜色为 红蓝黄绿紫橙，互不重复且无 undefined', () => {
    const s = makeSixPlayerGame();
    expect(s.players.map((p) => p.color)).toEqual([
      'red', 'blue', 'yellow', 'green', 'purple', 'orange',
    ]);
    expect(new Set(s.players.map((p) => p.color)).size).toBe(6);
  });

  it('五人局沿用前五个座次颜色：紫色在席、橙色不出现', () => {
    const s = makeSixPlayerGame(5);
    expect(s.players.map((p) => p.color)).toEqual([
      'red', 'blue', 'yellow', 'green', 'purple',
    ]);
  });

  it('同 seed 六人局颜色分配稳定', () => {
    const a = makeSixPlayerGame(6, 'stable-colors');
    const b = makeSixPlayerGame(6, 'stable-colors');
    expect(a.players.map((p) => [p.id, p.color])).toEqual(b.players.map((p) => [p.id, p.color]));
  });

  it('第七人仍被拒绝：人数安全门从 >4 改为 >6，而不是删除', () => {
    expect(() => makeSixPlayerGame(7)).toThrow(/2-6/);
    expect(() => makeSixPlayerGame(1)).toThrow(/2-6/);
  });
});

describe('六人保存恢复', () => {
  it('初始六人局 JSON 往返后 hydrateGameState 还原一致', () => {
    const source = structuredClone(makeSixPlayerGame());
    const roundTrip = JSON.parse(JSON.stringify(source));
    const result = hydrateGameState(roundTrip, chinaMap);
    expect(result).toEqual({ ok: true, state: source });
  });

  it('六人中局（紫色/橙色持有地产、一人破产、轮转多回合）保存恢复一致', () => {
    let s = makeSixPlayerGame();
    // 模拟中局：轮转几回合
    for (let i = 0; i < 9; i++) {
      s = { ...s, currentPlayerId: s.players[i % 6].id, turnPhase: 'managing' as const };
      const r = applyIntent(s, s.currentPlayerId, { type: 'end_turn' });
      if (!r.ok) throw new Error('end_turn failed');
      s = r.state;
    }
    // 第 5 席（orange）破产，紫/橙座次曾持有地产
    const purple = s.players.find((p) => p.color === 'purple')!;
    const orange = s.players.find((p) => p.color === 'orange')!;
    s = {
      ...s,
      turnPhase: 'managing' as const,
      players: s.players.map((p) => (p.id === orange.id ? { ...p, bankrupt: true, bankruptTurn: 7 } : p)),
      properties: {
        ...s.properties,
        2: { ownerId: purple.id, level: 3, mortgaged: false },
        4: { ownerId: orange.id, level: 0, mortgaged: true },
      },
    };
    const source = structuredClone(s);
    const result = hydrateGameState(JSON.parse(JSON.stringify(source)), chinaMap);
    expect(result).toEqual({ ok: true, state: source });
  });

  it('七名玩家快照仍被 hydrate 拒绝', () => {
    const source = structuredClone(makeSixPlayerGame());
    const sevenPlayers = [...source.players, { ...source.players[0]!, id: 'p7' }];
    expect(hydrateGameState({ ...source, players: sevenPlayers }, chinaMap)).toMatchObject({ ok: false });
  });

  it('六人快照拒绝未知颜色（白名单扩展后仍有安全门）', () => {
    const source = structuredClone(makeSixPlayerGame());
    const withUnknownColor = source.players.map((player, index) => (
      index === 4 ? { ...player, color: 'pink' } : player
    ));
    expect(hydrateGameState({ ...source, players: withUnknownColor }, chinaMap)).toMatchObject({ ok: false });
  });
});

describe('六人轮转与破产边界', () => {
  it('连续 end_turn 依引擎座次轮转全部 6 人后回到起点，颜色保持不变', () => {
    let s = makeManaging(6);
    const ids = s.players.map((p) => p.id);
    const colorsBefore = s.players.map((p) => p.color);
    const visited: string[] = [];
    for (let i = 0; i < 6; i++) {
      visited.push(s.currentPlayerId);
      const r = applyIntent(s, s.currentPlayerId, { type: 'end_turn' });
      if (!r.ok) throw new Error('end_turn failed');
      s = { ...r.state, turnPhase: 'managing' as const };
    }
    expect(visited).toEqual(ids);
    expect(s.currentPlayerId).toBe(ids[0]);
    expect(s.players.map((p) => p.color)).toEqual(colorsBefore);
  });

  it('破产座次被跳过：六人中破产 2 人后只在其余 4 人间轮转', () => {
    let s = makeManaging(6);
    const ids = s.players.map((p) => p.id);
    s = {
      ...s,
      players: s.players.map((p, i) => (i === 1 || i === 4 ? { ...p, bankrupt: true } : p)),
    };
    const visited: string[] = [];
    for (let i = 0; i < 4; i++) {
      visited.push(s.currentPlayerId);
      const r = applyIntent(s, s.currentPlayerId, { type: 'end_turn' });
      if (!r.ok) throw new Error('end_turn failed');
      s = { ...r.state, turnPhase: 'managing' as const };
    }
    expect(visited).toEqual([ids[0], ids[2], ids[3], ids[5]]);
    expect(visited).not.toContain(ids[1]);
    expect(visited).not.toContain(ids[4]);
  });

  it('六人仅剩一人未破产时结束回合立即 last_standing 终局', () => {
    const s = makeManaging(6);
    const survivor = s.players[2]!;
    const terminal = {
      ...s,
      turnPhase: 'managing' as const,
      currentPlayerId: survivor.id,
      players: s.players.map((p) => (p.id === survivor.id ? p : { ...p, bankrupt: true })),
    };
    const r = applyIntent(terminal, survivor.id, { type: 'end_turn' });
    if (!r.ok) throw new Error('end_turn failed');
    expect(r.state.phase).toBe('game_over');
    expect(r.state.winnerId).toBe(survivor.id);
    expect(r.events.some((e) => e.type === 'game_over' && e.reason === 'last_standing')).toBe(true);
  });
});
