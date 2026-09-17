import { describe, it, expect } from 'vitest';
import { createGame, applyIntent } from '../engine';
import { rollDice } from '../rng';
import { getActiveMapPack } from '@richman/board-data';
import type { GameState, PropertyState } from '../types';

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
    seed: 'rent-pay-test',
  });
}

const currentPlayer = (s: GameState) => s.players.find((p) => p.id === s.currentPlayerId)!;
const otherPlayer = (s: GameState) => s.players.find((p) => p.id !== s.currentPlayerId)!;

/** 构造 state：seed 使首次掷骰= targetSum；玩家在 startPos */
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
  throw new Error(`找不到首次掷骰=${targetSum}`);
}

function setOwner(
  s: GameState,
  cellId: number,
  ownerId: string,
  opts: { level?: number; mortgaged?: boolean } = {},
): GameState {
  const cur: PropertyState = s.properties[cellId] ?? { ownerId: null, level: 0, mortgaged: false };
  return {
    ...s,
    properties: {
      ...s.properties,
      [cellId]: { ownerId, level: opts.level ?? 0, mortgaged: opts.mortgaged ?? false },
    },
  };
}

const cellRent = (id: number, level: number) =>
  (chinaMap.game.board.cells.find((c) => c.id === id)! as { readonly rents: readonly number[] }).rents[level];

describe('过路费扣款（roll_dice 落他人地）// 步4 集成', () => {
  it('落他人 normal 地产（现金足够）→ 扣费 + owner 收钱 + rent_paid 事件', () => {
    // 落 cell 2 福建（rents[0]=200），owner=对手
    const base = makeStateForRoll(2, 0);
    const otherId = otherPlayer(base).id;
    const s = setOwner(base, 2, otherId, { level: 0 });
    const playerBefore = currentPlayer(s).cash;
    const ownerBefore = otherPlayer(s).cash;
    const r = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
    if (!r.ok) throw new Error('fail');
    expect(currentPlayer(r.state).cash).toBe(playerBefore - 200);
    expect(otherPlayer(r.state).cash).toBe(ownerBefore + 200);
    const rent = r.events.find((e) => e.type === 'rent_paid')!;
    expect((rent as { amount: number }).amount).toBe(200);
  });

  it('E06: 他人抵押中的地产 → 不扣费、无 rent_paid', () => {
    const base = makeStateForRoll(2, 0);
    const otherId = otherPlayer(base).id;
    const s = setOwner(base, 2, otherId, { level: 0, mortgaged: true });
    const before = currentPlayer(s).cash;
    const r = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
    if (!r.ok) throw new Error('fail');
    expect(currentPlayer(r.state).cash).toBe(before);
    expect(r.events.some((e) => e.type === 'rent_paid')).toBe(false);
  });

  it('E07: 落他人 utility（持有 1 处）→ 骰点和 × 10', () => {
    // cell 10 中国大运河，owner=对手，持有 1 处
    const base = makeStateForRoll(10, 0);
    const otherId = otherPlayer(base).id;
    const s = setOwner(base, 10, otherId);
    const playerBefore = currentPlayer(s).cash;
    const r = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
    if (!r.ok) throw new Error('fail');
    const diceSum = r.state.lastDice![0] + r.state.lastDice![1];
    expect(currentPlayer(r.state).cash).toBe(playerBefore - diceSum * 10);
  });

  it('E09: 车站按持有数取档（对手持有 2 个站）', () => {
    // 落 cell 6 广州站，对手持有 cell 6 + cell 19（2 站 → 500）
    const base = makeStateForRoll(6, 0);
    const otherId = otherPlayer(base).id;
    let s = setOwner(base, 6, otherId);
    s = setOwner(s, 19, otherId);
    const playerBefore = currentPlayer(s).cash;
    const r = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
    if (!r.ok) throw new Error('fail');
    expect(currentPlayer(r.state).cash).toBe(playerBefore - 500);
  });

  it('现金不足 → 债务触发（debt_entered + cash 扣光 + debt.amount=差额）', () => {
    // cell 2 福建旅馆（rents[5]=11000），玩家现金 5000
    const base = makeStateForRoll(2, 0);
    const otherId = otherPlayer(base).id;
    let s = setOwner(base, 2, otherId, { level: 5 });
    s = setOwner(s, 6, base.currentPlayerId);
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === s.currentPlayerId ? { ...p, cash: 5000 } : p,
      ),
    };
    const ownerBefore = otherPlayer(s).cash;
    const r = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
    if (!r.ok) throw new Error('fail');
    expect(currentPlayer(r.state).cash).toBe(0); // 扣光
    expect(r.state.debt).not.toBeNull();
    expect(r.state.debt?.amount).toBe(11000 - 5000);
    expect(r.state.debt?.creditorId).toBe(otherId);
    // owner 只收到玩家现有现金 5000（差额待债务结算）
    expect(otherPlayer(r.state).cash).toBe(ownerBefore + 5000);
    expect(r.events.some((e) => e.type === 'debt_entered')).toBe(true);
    expect(r.state.turnPhase).toBe('managing'); // 债务中可卖产筹款
  });

  it('落自己地产 → 不扣费（转 build_decision）', () => {
    const base = makeStateForRoll(2, 0);
    const s = setOwner(base, 2, base.currentPlayerId, { level: 0 });
    const before = currentPlayer(s).cash;
    const r = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
    if (!r.ok) throw new Error('fail');
    expect(currentPlayer(r.state).cash).toBe(before); // 不扣
    expect(r.state.turnPhase).toBe('awaiting_build_decision');
  });
});
