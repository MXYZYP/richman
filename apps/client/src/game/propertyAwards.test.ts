import { describe, expect, it } from 'vitest';
import { getActiveMapPack } from '@richman/board-data';
import { createGame, type GameState } from '@richman/engine';
import type { RenderableGameState } from '../session/gameSession';
import { resolveLocalGameState } from './mapResolver';
import { getPropertyAwards } from './propertyAwards';

const chinaMap = getActiveMapPack('china-tour');

function makeState(overrides: Partial<GameState> = {}): RenderableGameState {
  const state = createGame({
    mapRef: chinaMap.ref,
    ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: chinaMap.game.config,
    players: [
      { id: 'p1', nickname: '玩家一', isBot: false },
      { id: 'p2', nickname: '电脑A', isBot: true },
      { id: 'p3', nickname: '电脑B', isBot: true },
    ],
    seed: 'property-awards-test',
    cashGoal: null,
  });
  return resolveLocalGameState({ ...state, ...overrides });
}

const rent = (cellId: number, amount: number, to = 'p2') => ({
  type: 'rent_paid' as const,
  from: 'p1',
  to,
  cellId,
  amount,
});

describe('getPropertyAwards', () => {
  it('returns no awards before any rent is collected', () => {
    expect(getPropertyAwards(makeState()).awards).toEqual([]);
  });

  it('picks the highest-rent property as MVP regardless of current ownership', () => {
    const state = makeState({
      recentLog: [
        rent(2, 2000), // 福建省
        rent(20, 200), // 山东省
      ],
    });
    const mvp = getPropertyAwards(state).awards.find((a) => a.kind === 'mvp')!;
    expect(mvp.cellId).toBe(2);
    expect(mvp.metric).toContain('2,000');
  });

  it('picks the biggest investment-minus-rent gap as the worst owned property', () => {
    const empty = makeState();
    const state = makeState({
      properties: {
        ...empty.properties,
        // 福建 level 0：投入 2400，gap = 2400 - 2000 = 400
        2: { ownerId: 'p2', level: 0, mortgaged: false },
        // 山东 level 2：投入 3000 + 2×2000 = 7000，gap = 7000 - 200 = 6800
        20: { ownerId: 'p2', level: 2, mortgaged: false },
      },
      recentLog: [rent(2, 2000), rent(20, 200)],
    });
    const worst = getPropertyAwards(state).awards.find((a) => a.kind === 'worst')!;
    expect(worst.cellId).toBe(20);
  });

  it('picks the highest rent-to-investment ratio as best value', () => {
    const empty = makeState();
    const state = makeState({
      properties: {
        ...empty.properties,
        // 福建：2000 / 2400 ≈ 0.83
        2: { ownerId: 'p2', level: 0, mortgaged: false },
        // 山东：200 / 7000 ≈ 0.029
        20: { ownerId: 'p2', level: 2, mortgaged: false },
      },
      recentLog: [rent(2, 2000), rent(20, 200)],
    });
    const best = getPropertyAwards(state).awards.find((a) => a.kind === 'bestValue')!;
    expect(best.cellId).toBe(2);
  });

  it('only awards MVP when rent was collected but nothing is currently owned', () => {
    const state = makeState({
      recentLog: [rent(2, 500)],
    });
    const kinds = getPropertyAwards(state).awards.map((a) => a.kind);
    expect(kinds).toEqual(['mvp']);
  });

  it('excludes zero-rent owned properties from best value but allows them as worst', () => {
    const empty = makeState();
    const state = makeState({
      properties: {
        ...empty.properties,
        // 山东收过租 200；福建持有但没收过租
        2: { ownerId: 'p2', level: 0, mortgaged: false },
        20: { ownerId: 'p2', level: 2, mortgaged: false },
      },
      recentLog: [rent(20, 200)],
    });
    const awards = getPropertyAwards(state).awards;
    const best = awards.find((a) => a.kind === 'bestValue');
    // 山东是唯一收过租的持有地块 → 性价比归山东
    expect(best?.cellId).toBe(20);
    // 福建投入 2400、收租 0，gap=2400 大于山东 gap=6800？不——山东 gap=7000-200=6800 更大 → worst 仍是山东
    const worst = awards.find((a) => a.kind === 'worst')!;
    expect(worst.cellId).toBe(20);
  });
});
