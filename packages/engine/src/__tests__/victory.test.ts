import { describe, it, expect } from 'vitest';
import { createGame, applyIntent } from '../engine';
import { rollDice } from '../rng';
import { getActiveMapPack } from '@richman/board-data';
import type { GameState, PropertyState } from '../types';

const chinaMap = getActiveMapPack('china-tour');

function makeStarted(cashGoal: number | null = null): GameState {
  return createGame({
    mapRef: chinaMap.ref,
    ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: chinaMap.game.config,
    players: [{ id: 'p1', nickname: '甲' }, { id: 'p2', nickname: '乙' }],
    seed: 'victory-test',
    cashGoal,
  });
}

function player(s: GameState, id: string) {
  return s.players.find((p) => p.id === id)!;
}

function makeStateForRoll(targetSum: number, startPos: number, cashGoal: number | null): GameState {
  for (let i = 1; i < 100000; i++) {
    const [dice] = rollDice(i);
    if (dice[0] + dice[1] === targetSum) {
      const s = makeStarted(cashGoal);
      return {
        ...s,
        seed: String(i),
        players: s.players.map((p) => (p.id === s.currentPlayerId ? { ...p, position: startPos } : p)),
      };
    }
  }
  throw new Error(`找不到首次掷骰=${targetSum}`);
}

function withOwner(s: GameState, cellId: number, ownerId: string, level = 0): GameState {
  const prop: PropertyState = { ownerId, level, mortgaged: false };
  return { ...s, properties: { ...s.properties, [cellId]: prop } };
}

describe('胜利条件（01 §12）// M2 step10', () => {
  it('E18: 经过起点领工资使现金达到现金目标，立即 game_over', () => {
    const s = makeStateForRoll(2, 51, 16000); // 51→0→1，领 2000
    const currentId = s.currentPlayerId;
    const r = applyIntent(s, currentId, { type: 'roll_dice' });
    if (!r.ok) throw new Error('fail');
    expect(player(r.state, currentId).cash).toBe(17000);
    expect(r.state.phase).toBe('game_over');
    expect(r.state.winnerId).toBe(currentId);
    expect(r.events).toContainEqual({ type: 'game_over', winnerId: currentId, reason: 'cash_goal' });
  });

  it('E18: 收租使地产主人达到现金目标，立即由收租者获胜', () => {
    const s0 = makeStateForRoll(2, 0, 15001); // 当前玩家落 2 福建
    const payerId = s0.currentPlayerId;
    const ownerId = s0.players.find((p) => p.id !== payerId)!.id;
    let s = withOwner(s0, 2, ownerId, 0); // 福建空地租 200
    s = {
      ...s,
      players: s.players.map((p) => {
        if (p.id === ownerId) return { ...p, cash: 14900 };
        if (p.id === payerId) return { ...p, cash: 15000 };
        return p;
      }),
    };
    const r = applyIntent(s, payerId, { type: 'roll_dice' });
    if (!r.ok) throw new Error('fail');
    expect(player(r.state, ownerId).cash).toBe(15100);
    expect(r.state.phase).toBe('game_over');
    expect(r.state.winnerId).toBe(ownerId);
    expect(r.events).toContainEqual({ type: 'game_over', winnerId: ownerId, reason: 'cash_goal' });
  });

  it('E18: 领工资即时终局——经过起点领工资达标后不再继续落点扣租', () => {
    // p1 从 51 出发，掷 3（路径 0,1,2），经过起点领 2000 后现金恰好 17000 达 cashGoal
    // cell 2 福建被 p2 拥有；若不短路，会扣租 200 并发 rent_paid，这是错的
    const s0 = makeStateForRoll(3, 51, 17000);
    const currentId = s0.currentPlayerId;
    const otherId = s0.players.find((p) => p.id !== currentId)!.id;
    const s = withOwner(s0, 2, otherId, 0); // 福建空地租 200
    const r = applyIntent(s, currentId, { type: 'roll_dice' });
    if (!r.ok) throw new Error('fail');
    expect(player(r.state, currentId).cash).toBe(17000); // 领工资后不再扣租
    expect(r.state.phase).toBe('game_over');
    expect(r.state.winnerId).toBe(currentId);
    expect(r.events).toContainEqual({ type: 'game_over', winnerId: currentId, reason: 'cash_goal' });
    expect(r.events.some((e) => e.type === 'rent_paid')).toBe(false);
  });

  it('E18: 债务未清时卖产使现金临时达 cashGoal，不应 cash_goal 获胜', () => {
    // debt=17000、cash=15250，卖一幢房返 750 → cash=16000 >= cashGoal 16000，但债务仍未清
    let s = makeStarted(16000);
    s = withOwner(s, 2, 'p1', 1); // 福建一幢房，卖返 750
    s = {
      ...s,
      currentPlayerId: 'p1',
      turnPhase: 'managing',
      debt: { debtorId: 'p1', creditorId: 'p2', amount: 17000 },
      players: s.players.map((p) => (p.id === 'p1' ? { ...p, cash: 15250 } : p)),
    };
    const r = applyIntent(s, 'p1', { type: 'sell_house', cellId: 2 });
    if (!r.ok) throw new Error('fail');
    expect(player(r.state, 'p1').cash).toBe(16000); // 15250 + 750
    expect(r.state.debt).not.toBeNull(); // 债务仍在
    expect(r.state.phase).toBe('playing');
    expect(r.events.some((e) => e.type === 'game_over')).toBe(false);
  });

  it('E18: 破产现金转给债主使其达标时，应立即 cash_goal，不继续 resume 队列', () => {
    const base = createGame({
      mapRef: chinaMap.ref,
      ruleModules: chinaMap.game.requiredRuleModules,
      board: chinaMap.game.board,
      cards: chinaMap.game.cards,
      config: chinaMap.game.config,
      players: [{ id: 'p1', nickname: '甲' }, { id: 'p2', nickname: '乙' }, { id: 'p3', nickname: '丙' }],
      seed: 'victory-bankrupt-transfer',
      cashGoal: 15001,
    });
    const s: GameState = {
      ...base,
      currentPlayerId: 'p1',
      turnPhase: 'managing',
      debt: {
        debtorId: 'p2',
        creditorId: 'p1',
        amount: 500,
        resume: { payments: [{ debtorId: 'p3', creditorId: 'p1', amount: 500 }] },
      },
      players: base.players.map((p) => {
        if (p.id === 'p1') return { ...p, cash: 14950 };
        if (p.id === 'p2') return { ...p, cash: 200 };
        if (p.id === 'p3') return { ...p, cash: 1000 };
        return p;
      }),
    };
    const r = applyIntent(s, 'p2', { type: 'declare_bankrupt' });
    if (!r.ok) throw new Error('fail');
    expect(r.state.phase).toBe('game_over');
    expect(r.state.winnerId).toBe('p1');
    expect(r.events).toContainEqual({ type: 'game_over', winnerId: 'p1', reason: 'cash_goal' });
    expect(player(r.state, 'p1').cash).toBe(15150); // 14950 + p2 剩余现金 200
    expect(player(r.state, 'p3').cash).toBe(1000); // 不再继续 p3→p1 的 resume 付款
  });

  it('未开启现金目标时，现金超过预设也不会因 cash_goal 结束', () => {
    const s = makeStateForRoll(2, 51, null);
    const currentId = s.currentPlayerId;
    const r = applyIntent({ ...s, cashGoal: null }, currentId, { type: 'roll_dice' });
    if (!r.ok) throw new Error('fail');
    expect(player(r.state, currentId).cash).toBe(17000);
    expect(r.state.phase).toBe('playing');
    expect(r.events.some((e) => e.type === 'game_over')).toBe(false);
  });
});
