import { describe, it, expect } from 'vitest';
import { createGame, applyIntent } from '../engine';
import { rollDice } from '../rng';
import { getActiveMapPack } from '@richman/board-data';
import type { GameState } from '../types';

const chinaMap = getActiveMapPack('china-tour');

function makeStarted(): GameState {
  return createGame({
    mapRef: chinaMap.ref,
    ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: chinaMap.game.config,
    players: [
      { id: 'p1', nickname: '甲' },
      { id: 'p2', nickname: '乙' },
    ],
    seed: 'tax-test',
  });
}

const currentPlayer = (s: GameState) => s.players.find((p) => p.id === s.currentPlayerId)!;

function makeStateForRoll(targetSum: number, startPos = 0): GameState {
  for (let i = 1; i < 100000; i++) {
    const [dice] = rollDice(i);
    if (dice[0] + dice[1] === targetSum) {
      const s = makeStarted();
      return {
        ...s,
        seed: String(i),
        players: s.players.map((p) =>
          p.id === s.currentPlayerId ? { ...p, position: startPos } : p,
        ),
      };
    }
  }
  throw new Error('not found');
}

describe('tax (01 §5) // 步7', () => {
  it('落税格(id 23 所得税) → 扣 1000 + tax_paid 事件 + 转 managing', () => {
    // 玩家 cell 21，掷骰 2 → 21→22→23
    const s = makeStateForRoll(2, 21);
    const before = currentPlayer(s).cash;
    const r = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
    if (!r.ok) throw new Error('fail');
    expect(currentPlayer(r.state).position).toBe(23);
    expect(currentPlayer(r.state).cash).toBe(before - 1000);
    const tax = r.events.find((e) => e.type === 'tax_paid');
    expect(tax).toBeDefined();
    expect((tax as { amount: number }).amount).toBe(1000);
    expect(r.state.turnPhase).toBe('managing');
  });

  it('现金不足付税 → 债务（creditorId=null，对银行）', () => {
    const base = makeStateForRoll(2, 21);
    const s = {
      ...base,
      players: base.players.map((p) =>
        p.id === base.currentPlayerId ? { ...p, cash: 500 } : p,
      ),
      properties: {
        ...base.properties,
        2: { ownerId: base.currentPlayerId, level: 0, mortgaged: false },
      },
    };
    const r = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
    if (!r.ok) throw new Error('fail');
    expect(currentPlayer(r.state).cash).toBe(0); // 扣光
    expect(r.state.debt).not.toBeNull();
    expect(r.state.debt?.creditorId).toBeNull(); // 对银行
    expect(r.state.debt?.amount).toBe(500); // 1000 - 500
    expect(r.events.some((e) => e.type === 'debt_entered')).toBe(true);
    // tax_paid 记实付（500）
    const tax = r.events.find((e) => e.type === 'tax_paid') as { amount: number };
    expect(tax.amount).toBe(500);
  });
});
