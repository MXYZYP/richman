import { describe, it, expect } from 'vitest';
import { createGame, applyIntent } from '../engine';
import { getActiveMapPack } from '@richman/board-data';
import type { GameState, PropertyState } from '../types';

const chinaMap = getActiveMapPack('china-tour');

function makeStarted(players = ['p1', 'p2', 'p3']): GameState {
  return createGame({
    mapRef: chinaMap.ref,
    ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: chinaMap.game.config,
    players: players.map((id) => ({ id, nickname: id })),
    seed: 'surrender-test',
  });
}

function withProperty(s: GameState, cellId: number, ownerId: string, level = 0): GameState {
  const prop: PropertyState = { ownerId, level, mortgaged: false };
  return { ...s, properties: { ...s.properties, [cellId]: prop } };
}

/**
 * `applyIntent` 返回的是成功/失败联合类型，而 `expect(r.ok).toBe(true)` 只是运行期断言，
 * TypeScript 不会据此收窄。这里用一个显式的收窄函数，既保留断言语义，又让后续的 `r.state` / `r.events`
 * 有类型可依（否则整个文件在 `pnpm typecheck` 下报 TS2339）。
 */
function expectApplied(result: ReturnType<typeof applyIntent>) {
  if (!result.ok) throw new Error(`期望意图执行成功，实际被拒绝：${result.code}`);
  return result;
}

describe('投降（设置面板「投降」按钮）', () => {
  it('两人对局：投降 = 破产结算，对手按 last_standing 获胜', () => {
    let s = makeStarted(['p1', 'p2']);
    s = withProperty(s, 2, 'p1', 3);
    const r = expectApplied(applyIntent(s, 'p1', { type: 'surrender' }));
    const next = r.state;
    expect(next.players.find((p) => p.id === 'p1')?.bankrupt).toBe(true);
    expect(next.players.find((p) => p.id === 'p1')?.cash).toBe(0);
    // 名下房屋转为无主可售
    expect(next.properties[2].ownerId).toBeNull();
    expect(next.properties[2].level).toBe(0);
    // 两人局立即终局，对手获胜
    expect(next.phase).toBe('game_over');
    expect(next.winnerId).toBe('p2');
    expect(r.events.some((e) => e.type === 'player_surrendered')).toBe(true);
  });

  it('多人对局：非本人回合投降也立即出局，现金与资产清零，对局继续', () => {
    let s = makeStarted(['p1', 'p2', 'p3']);
    s = withProperty(s, 2, 'p2', 4); // p2 有 4 级房屋
    // 开局座次由每人先掷一次骰决定（点数大者先行），当前行动者不保证是 p1：
    // 动态挑一个非当前玩家投降，覆盖"非本人回合投降"的分支。
    const current = s.currentPlayerId;
    const other = ['p1', 'p2', 'p3'].find((id) => id !== current)!;
    s = withProperty(s, 2, other, 4); // other 有 4 级房屋
    const r = expectApplied(applyIntent(s, other, { type: 'surrender' }));
    const next = r.state;
    expect(next.players.find((p) => p.id === other)?.bankrupt).toBe(true);
    expect(next.players.find((p) => p.id === other)?.cash).toBe(0);
    expect(next.properties[2].ownerId).toBeNull();
    expect(next.properties[2].level).toBe(0);
    // 仍有两个存活玩家，对局继续，回合不因非当前玩家投降而改变行动者
    expect(next.phase).toBe('playing');
    expect(next.currentPlayerId).toBe(current);
  });

  it('多人对局：投降者是当前玩家则正确推进到下一个存活玩家', () => {
    const s = makeStarted(['p1', 'p2', 'p3']);
    const current = s.currentPlayerId;
    const r = expectApplied(applyIntent(s, current, { type: 'surrender' }));
    expect(r.state.currentPlayerId).not.toBe(current);
    expect(r.state.players.find((p) => p.id === current)?.bankrupt).toBe(true);
    expect(r.state.phase).toBe('playing');
  });

  it('已出局玩家不能再投降', () => {
    let s = makeStarted(['p1', 'p2', 'p3']);
    s = { ...s, players: s.players.map((p) => (p.id === 'p2' ? { ...p, bankrupt: true } : p)) };
    const r = applyIntent(s, 'p2', { type: 'surrender' });
    expect(r.ok).toBe(false);
  });
});
