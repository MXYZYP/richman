import { describe, expect, it } from 'vitest';
import { getActiveMapPack } from '@richman/board-data';
import { createGame, type GameState, type PlayerState } from '@richman/engine';
import type { RenderableGameState } from '../session/gameSession';
import { resolveLocalGameState } from './mapResolver';
import { getSettlementSummary } from './settlement';

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
    seed: 'settlement-summary-test',
    cashGoal: null,
  });
  const playerById = new Map(state.players.map((player) => [player.id, player]));
  const player = (id: string, updates: Partial<PlayerState>): PlayerState => {
    const found = playerById.get(id);
    if (!found) throw new Error(`missing test player ${id}`);
    return { ...found, ...updates };
  };

  return resolveLocalGameState({
    ...state,
    phase: 'game_over',
    winnerId: 'p1',
    players: [
      player('p1', { cash: 42000, bankrupt: false, bankruptTurn: null }),
      player('p2', { cash: 0, bankrupt: true, bankruptTurn: 9 }),
      player('p3', { cash: 1500, bankrupt: true, bankruptTurn: 8 }),
    ],
    ...overrides,
  });
}

describe('getSettlementSummary', () => {
  it('returns the winning player title and bankruptcy game-over reason', () => {
    const summary = getSettlementSummary(makeState());

    expect(summary.title).toBe('玩家一 获胜');
    expect(summary.reason).toBe('所有对手已破产，本局结束');
  });

  it('orders the winner first and marks bankrupt opponents with bankruptcy status', () => {
    const summary = getSettlementSummary(makeState());

    expect(summary.rows.map((row) => row.name)).toEqual(['玩家一', '电脑A', '电脑B']);
    expect(summary.rows[0]).toMatchObject({
      rank: 1,
      id: 'p1',
      name: '玩家一',
      status: '¥42,000',
      isWinner: true,
      isBankrupt: false,
      isBot: false,
    });
    expect(summary.rows[1]).toMatchObject({
      rank: 2,
      id: 'p2',
      name: '电脑A',
      status: '破产',
      isWinner: false,
      isBankrupt: true,
      isBot: true,
    });
    expect(summary.rows[2]).toMatchObject({
      rank: 3,
      id: 'p3',
      name: '电脑B',
      status: '破产',
      isWinner: false,
      isBankrupt: true,
      isBot: true,
    });
  });

  it('includes owned property names and survived turns for active and bankrupt rows', () => {
    const base = makeState();
    const playerById = new Map(base.players.map((player) => [player.id, player]));
    const player = (id: string, updates: Partial<PlayerState>): PlayerState => {
      const found = playerById.get(id);
      if (!found) throw new Error(`missing test player ${id}`);
      return { ...found, ...updates };
    };
    const state = makeState({
      turn: 14,
      players: [
        player('p1', { cash: 42000, bankrupt: false, bankruptTurn: null }),
        player('p2', { cash: 0, bankrupt: true, bankruptTurn: 9 }),
        player('p3', { cash: 1500, bankrupt: false, bankruptTurn: null }),
      ],
      properties: {
        ...base.properties,
        2: { ownerId: 'p1', level: 0, mortgaged: false },
        11: { ownerId: 'p1', level: 1, mortgaged: false },
        6: { ownerId: 'p2', level: 0, mortgaged: false },
      },
    });

    const summary = getSettlementSummary(state);
    const row = (id: string) => {
      const found = summary.rows.find((candidate) => candidate.id === id);
      if (!found) throw new Error(`missing settlement row ${id}`);
      return found;
    };

    expect(row('p1')).toMatchObject({
      propertyNames: ['福建省', '浙江省'],
      propertyCount: 2,
      survivedTurns: 14,
    });
    expect(row('p2')).toMatchObject({
      propertyNames: ['广州站'],
      propertyCount: 1,
      survivedTurns: 9,
    });
    expect(row('p3')).toMatchObject({
      propertyNames: [],
      propertyCount: 0,
      survivedTurns: 14,
    });
  });

  it('sorts non-bankrupt non-winners by cash before bankrupt players', () => {
    const base = makeState();
    const playerById = new Map(base.players.map((player) => [player.id, player]));
    const player = (id: string, updates: Partial<PlayerState>): PlayerState => {
      const found = playerById.get(id);
      if (!found) throw new Error(`missing test player ${id}`);
      return { ...found, ...updates };
    };
    const state = makeState({
      winnerId: 'p3',
      players: [
        player('p1', { cash: 3000, bankrupt: false, bankruptTurn: null }),
        player('p2', { cash: 9000, bankrupt: false, bankruptTurn: null }),
        player('p3', { cash: 12000, bankrupt: false, bankruptTurn: null }),
      ],
    });

    const summary = getSettlementSummary(state);

    expect(summary.rows.map((row) => row.id)).toEqual(['p3', 'p2', 'p1']);
    expect(summary.rows.map((row) => row.status)).toEqual(['¥12,000', '¥9,000', '¥3,000']);
  });

  it('uses the cash goal reason when the game-over event says cash_goal', () => {
    const state = makeState({
      recentLog: [
        ...makeState().recentLog,
        { type: 'game_over', winnerId: 'p1', reason: 'cash_goal' },
      ],
    });

    const summary = getSettlementSummary(state);

    expect(summary.reason).toBe('玩家一 率先达到现金目标，本局结束');
  });

  it('falls back to a neutral title when the winner is missing', () => {
    const summary = getSettlementSummary(makeState({ winnerId: null }));

    expect(summary.title).toBe('本局结束');
  });
});
