import { describe, it, expect } from 'vitest';
import { createGame, applyIntent } from '../engine';
import { getActiveMapPack } from '@richman/board-data';
import type { GameState, PropertyState } from '../types';

const chinaMap = getActiveMapPack('china-tour');

function makeAtManaging(cellId: number, ownerId: string, opts: { level?: number; mortgaged?: boolean } = {}): GameState {
  const s = createGame({
    mapRef: chinaMap.ref, ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board, cards: chinaMap.game.cards, config: chinaMap.game.config,
    players: [{ id: 'p1', nickname: '甲' }, { id: 'p2', nickname: '乙' }],
    seed: 'sell-test',
  });
  const prop: PropertyState = { ownerId, level: opts.level ?? 0, mortgaged: opts.mortgaged ?? false };
  return {
    ...s,
    currentPlayerId: 'p1', // 测试便利：强制当前玩家为 p1（与 ownerId 默认对齐）
    turnPhase: 'managing',
    properties: { ...s.properties, [cellId]: prop },
  };
}

const currentPlayer = (s: GameState) => s.players.find((p) => p.id === s.currentPlayerId)!;
const cellHouseCost = (id: number) =>
  (chinaMap.game.board.cells.find((c) => c.id === id)! as { houseCost: number }).houseCost;
const cellPrice = (id: number) =>
  (chinaMap.game.board.cells.find((c) => c.id === id)! as { price: number }).price;

describe('sell_house (01 §6.4) // 步6', () => {
  it('卖一幢房：level-1、返还 houseCost×0.5、house_sold 事件', () => {
    const s = makeAtManaging(2, 'p1', { level: 3 });
    const refund = Math.round(cellHouseCost(2) * 0.5);
    const before = currentPlayer(s).cash;
    const r = applyIntent(s, s.currentPlayerId, { type: 'sell_house', cellId: 2 });
    if (!r.ok) throw new Error('fail');
    expect(r.state.properties[2].level).toBe(2);
    expect(currentPlayer(r.state).cash).toBe(before + refund);
    expect(r.events.some((e) => e.type === 'house_sold')).toBe(true);
  });

  it('E10: 旅馆逐级卖（level 5→4 返还一幢半价）', () => {
    const s = makeAtManaging(2, 'p1', { level: 5 });
    const refund = Math.round(cellHouseCost(2) * 0.5);
    const before = currentPlayer(s).cash;
    const r = applyIntent(s, s.currentPlayerId, { type: 'sell_house', cellId: 2 });
    if (!r.ok) throw new Error('fail');
    expect(r.state.properties[2].level).toBe(4);
    expect(currentPlayer(r.state).cash).toBe(before + refund);
  });

  it('E10: 连续卖到 0（旅馆 5→4→3→2→1→0）', () => {
    let s = makeAtManaging(2, 'p1', { level: 5 });
    for (let expected = 4; expected >= 0; expected--) {
      const r = applyIntent(s, s.currentPlayerId, { type: 'sell_house', cellId: 2 });
      if (!r.ok) throw new Error(`level ${expected} 失败`);
      s = r.state;
      expect(s.properties[2].level).toBe(expected);
    }
    // level=0 时再卖 → ILLEGAL
    const r = applyIntent(s, s.currentPlayerId, { type: 'sell_house', cellId: 2 });
    expect(r.ok).toBe(false);
  });

  it('无房（level=0）不可卖 → ILLEGAL', () => {
    const s = makeAtManaging(2, 'p1', { level: 0 });
    const r = applyIntent(s, s.currentPlayerId, { type: 'sell_house', cellId: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ILLEGAL_INTENT');
  });

  it('非自己的地不可卖 → ILLEGAL', () => {
    const s = makeAtManaging(2, 'p2', { level: 3 }); // owner=p2
    const r = applyIntent(s, s.currentPlayerId, { type: 'sell_house', cellId: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ILLEGAL_INTENT');
  });
});

describe('sell_property (01 §6.5) // 步6', () => {
  it('卖地：返还 price×0.5、变无主、property_sold 事件', () => {
    const s = makeAtManaging(2, 'p1', { level: 0 });
    const refund = Math.round(cellPrice(2) * 0.5);
    const before = currentPlayer(s).cash;
    const r = applyIntent(s, s.currentPlayerId, { type: 'sell_property', cellId: 2 });
    if (!r.ok) throw new Error('fail');
    expect(currentPlayer(r.state).cash).toBe(before + refund);
    expect(r.state.properties[2].ownerId).toBeNull();
    expect(r.events.some((e) => e.type === 'property_sold')).toBe(true);
  });

  it('E11: 卖地变无主可再购买', () => {
    let s = makeAtManaging(2, 'p1', { level: 0 });
    s = applyIntent(s, s.currentPlayerId, { type: 'sell_property', cellId: 2 }).ok
      ? ((applyIntent(s, s.currentPlayerId, { type: 'sell_property', cellId: 2 }) as { state: GameState }).state)
      : s;
    expect(s.properties[2].ownerId).toBeNull();
    // 再购买（需要 turnPhase=awaiting_buy_decision）
    const s2 = { ...s, turnPhase: 'awaiting_buy_decision' as const, players: s.players.map((p) => p.id === s.currentPlayerId ? { ...p, position: 2 } : p) };
    const r = applyIntent(s2, s2.currentPlayerId, { type: 'buy_property' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.properties[2].ownerId).toBe(s2.currentPlayerId);
  });

  it('有房的地产不可直接卖地 → ILLEGAL', () => {
    const s = makeAtManaging(2, 'p1', { level: 2 });
    const r = applyIntent(s, s.currentPlayerId, { type: 'sell_property', cellId: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ILLEGAL_INTENT');
  });

  it('抵押中的地产不可卖 → ILLEGAL（阶段3）', () => {
    const s = makeAtManaging(2, 'p1', { level: 0, mortgaged: true });
    const r = applyIntent(s, s.currentPlayerId, { type: 'sell_property', cellId: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ILLEGAL_INTENT');
  });

  it('车站也可卖回银行', () => {
    const s = makeAtManaging(6, 'p1', { level: 0 }); // 广州站
    const r = applyIntent(s, s.currentPlayerId, { type: 'sell_property', cellId: 6 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.properties[6].ownerId).toBeNull();
  });
});

describe('债务状态下的卖房卖地 // 步6/步9 准备', () => {
  it('债务状态可卖房（筹款）', () => {
    const s = makeAtManaging(2, 'p1', { level: 3 });
    const s2 = { ...s, debt: { debtorId: s.currentPlayerId, creditorId: 'p2', amount: 1000 } };
    const r = applyIntent(s2, s2.currentPlayerId, { type: 'sell_house', cellId: 2 });
    expect(r.ok).toBe(true);
  });

  it('债务状态不可掷骰/买地/盖房（仅卖房卖地/破产）', () => {
    const s = makeAtManaging(2, 'p1', { level: 0 });
    const s2 = { ...s, debt: { debtorId: s.currentPlayerId, creditorId: 'p2', amount: 1000 } };
    expect(applyIntent(s2, s2.currentPlayerId, { type: 'roll_dice' }).ok).toBe(false);
    expect(applyIntent(s2, s2.currentPlayerId, { type: 'buy_property' }).ok).toBe(false);
    expect(applyIntent(s2, s2.currentPlayerId, { type: 'build_house' }).ok).toBe(false);
  });
});
