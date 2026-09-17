import { describe, it, expect } from 'vitest';
import { createGame, applyIntent } from '../engine';
import { getActiveMapPack } from '@richman/board-data';
import type { GameState } from '../types';

const chinaMap = getActiveMapPack('china-tour');

/** 构造 state：当前玩家落在 cellId（无主 property），turnPhase=awaiting_buy_decision */
function makeAtBuyDecision(cellId: number, overrides: Partial<GameState> = {}): GameState {
  const s = createGame({
    mapRef: chinaMap.ref,
    ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: chinaMap.game.config,
    players: [
      { id: 'p1', nickname: '甲' },
      { id: 'p2', nickname: '乙' },
    ],
    seed: 'buy-test',
  });
  return {
    ...s,
    turnPhase: 'awaiting_buy_decision',
    players: s.players.map((p) =>
      p.id === s.currentPlayerId ? { ...p, position: cellId } : p,
    ),
    ...overrides,
  };
}

const currentPlayer = (s: GameState) => s.players.find((p) => p.id === s.currentPlayerId)!;
const cellPrice = (id: number) =>
  (chinaMap.game.board.cells.find((c) => c.id === id)! as { price: number }).price;

describe('buy_property / skip_buy (01 §6.2) // 步3', () => {
  it('buy_property: 扣地价、设所有者、转 managing、产生 property_bought 事件', () => {
    const s = makeAtBuyDecision(2); // 福建省
    const price = cellPrice(2);
    const before = currentPlayer(s).cash;
    const r = applyIntent(s, s.currentPlayerId, { type: 'buy_property' });
    if (!r.ok) throw new Error('fail');
    expect(currentPlayer(r.state).cash).toBe(before - price);
    expect(r.state.properties[2].ownerId).toBe(s.currentPlayerId);
    expect(r.state.turnPhase).toBe('managing');
    const evt = r.events.find((e) => e.type === 'property_bought');
    expect(evt).toBeDefined();
    expect((evt as { price: number }).price).toBe(price);
  });

  it('现金不足 → INSUFFICIENT_FUNDS，状态不变', () => {
    const price = cellPrice(2);
    const s = makeAtBuyDecision(2);
    const s2 = {
      ...s,
      players: s.players.map((p) =>
        p.id === s.currentPlayerId ? { ...p, cash: price - 1 } : p,
      ),
    };
    const r = applyIntent(s2, s2.currentPlayerId, { type: 'buy_property' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('INSUFFICIENT_FUNDS');
      expect(s2.properties[2].ownerId).toBeNull(); // 状态不变
    }
  });

  it('现金恰好等于地价 → 可买（边界）', () => {
    const price = cellPrice(2);
    const s = makeAtBuyDecision(2);
    const s2 = {
      ...s,
      players: s.players.map((p) =>
        p.id === s.currentPlayerId ? { ...p, cash: price } : p,
      ),
    };
    const r = applyIntent(s2, s2.currentPlayerId, { type: 'buy_property' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(currentPlayer(r.state).cash).toBe(0);
      expect(r.state.properties[2].ownerId).toBe(s2.currentPlayerId);
    }
  });

  it('skip_buy: 地产保持无主、转 managing、产生 buy_declined', () => {
    const s = makeAtBuyDecision(2);
    const before = currentPlayer(s).cash;
    const r = applyIntent(s, s.currentPlayerId, { type: 'skip_buy' });
    if (!r.ok) throw new Error('fail');
    expect(r.state.properties[2].ownerId).toBeNull();
    expect(currentPlayer(r.state).cash).toBe(before); // 现金不变
    expect(r.state.turnPhase).toBe('managing');
    expect(r.events.some((e) => e.type === 'buy_declined')).toBe(true);
  });

  it('非 awaiting_buy_decision 阶段 → WRONG_PHASE', () => {
    const s = { ...makeAtBuyDecision(2), turnPhase: 'managing' as const };
    const r = applyIntent(s, s.currentPlayerId, { type: 'buy_property' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('WRONG_PHASE');
  });

  it('非当前玩家 → NOT_YOUR_TURN', () => {
    const s = makeAtBuyDecision(2);
    const other = s.players.find((p) => p.id !== s.currentPlayerId)!;
    const r = applyIntent(s, other.id, { type: 'buy_property' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NOT_YOUR_TURN');
  });

  it('可买车站（subtype=station，price 2000）', () => {
    // cell 6 = 广州站
    const s = makeAtBuyDecision(6);
    const r = applyIntent(s, s.currentPlayerId, { type: 'buy_property' });
    if (!r.ok) throw new Error('fail');
    expect(r.state.properties[6].ownerId).toBe(s.currentPlayerId);
  });

  it('可买特殊地皮（subtype=utility，cell 10 中国大运河）', () => {
    const s = makeAtBuyDecision(10);
    const r = applyIntent(s, s.currentPlayerId, { type: 'buy_property' });
    if (!r.ok) throw new Error('fail');
    expect(r.state.properties[10].ownerId).toBe(s.currentPlayerId);
  });
});
