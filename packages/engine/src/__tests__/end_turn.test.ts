import { describe, it, expect } from 'vitest';
import { createGame, applyIntent } from '../engine';
import { getActiveMapPack } from '@richman/board-data';
import type { GameState } from '../types';

const chinaMap = getActiveMapPack('china-tour');

function makeManaging(playerCount = 3): GameState {
  const players = [
    { id: 'p1', nickname: '甲' },
    { id: 'p2', nickname: '乙' },
    { id: 'p3', nickname: '丙' },
    { id: 'p4', nickname: '丁' },
  ].slice(0, playerCount);
  const s = createGame({
    mapRef: chinaMap.ref, ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board, cards: chinaMap.game.cards, config: chinaMap.game.config,
    players, seed: 'end-turn-test',
  });
  // 强制当前玩家为 players[0]（测试便利）
  return { ...s, currentPlayerId: s.players[0].id, turnPhase: 'managing' as const };
}

describe('end_turn (01 §4) // 基础', () => {
  it('managing 阶段结束 → 下一位玩家、turn+1、awaiting_roll、lastDice 清空', () => {
    const s = makeManaging(3);
    const beforeTurn = s.turn;
    const beforeCurrent = s.currentPlayerId;
    const r = applyIntent(s, s.currentPlayerId, { type: 'end_turn' });
    if (!r.ok) throw new Error('fail');
    expect(r.state.turn).toBe(beforeTurn + 1);
    expect(r.state.currentPlayerId).not.toBe(beforeCurrent);
    expect(r.state.turnPhase).toBe('awaiting_roll');
    expect(r.state.lastDice).toBeNull();
  });

  it('事件含 turn_ended（旧玩家）+ turn_started（新玩家）', () => {
    const s = makeManaging();
    const r = applyIntent(s, s.currentPlayerId, { type: 'end_turn' });
    if (!r.ok) throw new Error('fail');
    const types = r.events.map((e) => e.type);
    expect(types).toContain('turn_ended');
    expect(types).toContain('turn_started');
    const ended = r.events.find((e) => e.type === 'turn_ended') as { playerId: string };
    const started = r.events.find((e) => e.type === 'turn_started') as { playerId: string };
    expect(ended.playerId).toBe(s.currentPlayerId);
    expect(started.playerId).not.toBe(s.currentPlayerId);
  });

  it('非 managing 阶段 → WRONG_PHASE', () => {
    const s = { ...makeManaging(), turnPhase: 'awaiting_roll' as const };
    const r = applyIntent(s, s.currentPlayerId, { type: 'end_turn' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('WRONG_PHASE');
  });

  it('债务状态不可 end_turn → WRONG_PHASE（须先清算）', () => {
    const base = makeManaging();
    const creditorId = base.players.find((p) => p.id !== base.currentPlayerId)!.id;
    const s = {
      ...base,
      debt: { debtorId: base.currentPlayerId, creditorId, amount: 1000 },
    };
    const r = applyIntent(s, s.currentPlayerId, { type: 'end_turn' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('WRONG_PHASE');
  });

  it('跳过破产玩家（p1→p2 破产→跳到 p3）', () => {
    const s = makeManaging(3);
    const p1Id = s.players[0].id;
    const p2Id = s.players[1].id;
    const p3Id = s.players[2].id;
    const s2 = {
      ...s,
      players: s.players.map((p) => (p.id === p2Id ? { ...p, bankrupt: true } : p)),
    };
    const r = applyIntent(s2, p1Id, { type: 'end_turn' });
    if (!r.ok) throw new Error('fail');
    expect(r.state.currentPlayerId).toBe(p3Id);
  });

  it('连续 end_turn 在 3 人间循环', () => {
    let s = makeManaging(3);
    const ids = s.players.map((p) => p.id);
    // p0 → p1 → p2 → p0
    for (let i = 0; i < 3; i++) {
      const r = applyIntent(s, s.currentPlayerId, { type: 'end_turn' });
      if (!r.ok) throw new Error('fail');
      s = { ...r.state, turnPhase: 'managing' as const }; // 重置为 managing 便于下次 end_turn
    }
    // 3 次后回到 p0
    expect(s.currentPlayerId).toBe(ids[0]);
    expect(s.turn).toBe(4); // 初始 turn=1，+3 = 4
  });

  it('回合计数随轮转递增：每次 end_turn turn+1，skipTurns 跳过的玩家也计入', () => {
    const s = makeManaging(3);
    const ids = s.players.map((p) => p.id);
    const s2 = {
      ...s,
      players: s.players.map((p, i) => (i === 1 ? { ...p, skipTurns: 1 } : p)),
    };
    // p0 end_turn → 跳过 p1(skipTurns 1→0) → 轮到 p2
    // turn 应 +2（p0 结束 + p1 空回合被跳过）
    const r = applyIntent(s2, ids[0], { type: 'end_turn' });
    if (!r.ok) throw new Error('fail');
    expect(r.state.turn).toBe(s.turn + 2);
    expect(r.state.currentPlayerId).toBe(ids[2]);
  });

  it('E24: skipTurns 玩家被自动跳过 + 消耗（河内 turns=2 连续跳两轮）', () => {
    const s = makeManaging(3);
    const ids = s.players.map((p) => p.id);
    // 设 players[1] skipTurns=2
    const s2 = {
      ...s,
      players: s.players.map((p, i) => (i === 1 ? { ...p, skipTurns: 2 } : p)),
    };
    // p0 end_turn → 跳过 p1（skipTurns 2→1）→ 轮到 p2
    const r1 = applyIntent(s2, ids[0], { type: 'end_turn' });
    if (!r1.ok) throw new Error('fail');
    expect(r1.state.currentPlayerId).toBe(ids[2]); // 跳过 p1 到 p2
    const skippedPlayer = r1.state.players.find((p) => p.id === ids[1])!;
    expect(skippedPlayer.skipTurns).toBe(1); // 消耗一次
    // 事件含 p1 的 turn_started + turn_ended（空回合）
    const p1Events = r1.events.filter((e) => (e.type === 'turn_started' || e.type === 'turn_ended') && (e as { playerId: string }).playerId === ids[1]);
    expect(p1Events.length).toBeGreaterThanOrEqual(2);
  });

  it('E24: skipTurns=2 连续两轮后恢复行动（3 人局，p1 需被 p0 发起的两轮跳过）', () => {
    const s = makeManaging(3);
    const ids = s.players.map((p) => p.id);
    let s2: GameState = {
      ...s,
      players: s.players.map((p, i) => (i === 1 ? { ...p, skipTurns: 2 } : p)),
    };
    // 第一轮：p0 end_turn → 跳过 p1(2→1) → 轮到 p2
    let r = applyIntent(s2, ids[0], { type: 'end_turn' });
    if (!r.ok) throw new Error('fail');
    s2 = r.state;
    expect(s2.currentPlayerId).toBe(ids[2]);
    expect(s2.players.find((p) => p.id === ids[1])!.skipTurns).toBe(1);
    // p2 end_turn → 轮到 p0（不经过 p1）
    r = applyIntent({ ...s2, turnPhase: 'managing' as const }, ids[2], { type: 'end_turn' });
    if (!r.ok) throw new Error('fail');
    s2 = r.state;
    expect(s2.currentPlayerId).toBe(ids[0]);
    // 第二轮：p0 end_turn → 跳过 p1(1→0) → 轮到 p2
    r = applyIntent({ ...s2, turnPhase: 'managing' as const }, ids[0], { type: 'end_turn' });
    if (!r.ok) throw new Error('fail');
    s2 = r.state;
    expect(s2.currentPlayerId).toBe(ids[2]);
    expect(s2.players.find((p) => p.id === ids[1])!.skipTurns).toBe(0);
    // p2 end_turn → p0
    r = applyIntent({ ...s2, turnPhase: 'managing' as const }, ids[2], { type: 'end_turn' });
    if (!r.ok) throw new Error('fail');
    s2 = r.state;
    // 第三轮：p0 end_turn → p1 恢复行动（skipTurns=0 不再跳过）
    r = applyIntent({ ...s2, turnPhase: 'managing' as const }, ids[0], { type: 'end_turn' });
    if (!r.ok) throw new Error('fail');
    expect(r.state.currentPlayerId).toBe(ids[1]);
  });
});
