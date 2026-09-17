import { describe, expect, it } from 'vitest';
import {
  getActiveMapPack,
  type BoardData,
  type CardsData,
  type GameConfig,
  type MapPack,
} from '@richman/board-data';
import testBoardJson from '../../../board-data/maps/__test__/test-map-v1/board.json';
import testCardsJson from '../../../board-data/maps/__test__/test-map-v1/cards.json';
import testConfigJson from '../../../board-data/maps/__test__/test-map-v1/game-config.json';
import testManifestJson from '../../../board-data/maps/__test__/test-map-v1/manifest.json';
import { applyIntent, createGame } from '../engine';
import type { GameState } from '../types';

const chinaTourMap = getActiveMapPack('china-tour');
const players = [
  { id: 'p1', nickname: '甲' },
  { id: 'p2', nickname: '乙' },
  { id: 'p3', nickname: '丙' },
];

const testManifest = testManifestJson as unknown as Pick<MapPack, 'ref'> & {
  readonly requiredRuleModules: MapPack['game']['requiredRuleModules'];
};

const testMap = {
  ref: testManifest.ref,
  game: {
    board: testBoardJson as BoardData,
    cards: testCardsJson as CardsData,
    config: testConfigJson as GameConfig,
    requiredRuleModules: testManifest.requiredRuleModules,
  },
};

function makeChinaGame(cashGoal: number | null = null): GameState {
  return createGame({
    mapRef: chinaTourMap.ref,
    ruleModules: chinaTourMap.game.requiredRuleModules,
    board: chinaTourMap.game.board,
    cards: chinaTourMap.game.cards,
    config: chinaTourMap.game.config,
    players,
    seed: 'deterministic-42',
    cashGoal,
  });
}

function currentPlayer(state: GameState) {
  return state.players.find((player) => player.id === state.currentPlayerId)!;
}

describe('multi-map deterministic migration', () => {
  it('锁住 China Tour 固定 seed 的座次、RNG 与牌堆 golden', () => {
    const explicit = makeChinaGame();

    expect({
      seed: explicit.seed,
      currentPlayerId: explicit.currentPlayerId,
      players: explicit.players.map(({ id, color }) => ({ id, color })),
      decks: explicit.decks,
    }).toEqual({
      seed: '-772093164',
      currentPlayerId: 'p3',
      players: [
        { id: 'p3', color: 'red' },
        { id: 'p2', color: 'blue' },
        { id: 'p1', color: 'yellow' },
      ],
      decks: {
        chance: [
          '71-13', '71-08', '71-07', '71-04', '71-15',
          '71-10', '71-03', '71-01', '71-02', '71-14',
          '71-06', '71-09', '71-12', '71-05', '71-11',
        ],
        destiny: [
          '71-22', '71-27', '71-28', '71-23', '71-18',
          '71-17', '71-29', '71-16', '71-25', '71-21',
          '71-20', '71-24', '71-26', '71-19', '71-30',
        ],
      },
    });
  });

  it('显式 exact identity 锁住骰子、移动、抽牌和关键状态', () => {
    const explicit = { ...makeChinaGame(), seed: '12' };
    const explicitResult = applyIntent(explicit, explicit.currentPlayerId, { type: 'roll_dice' });

    expect(explicitResult.ok).toBe(true);
    if (!explicitResult.ok) throw new Error(`golden trace failed: ${explicitResult.code}`);
    expect(explicitResult.events).toEqual([
      { type: 'dice_rolled', playerId: 'p3', dice: [2, 1] },
      { type: 'token_moved', playerId: 'p3', path: [1, 2, 3] },
      { type: 'card_drawn', playerId: 'p3', deck: 'chance', cardId: '71-13' },
      { type: 'bank_received', playerId: 'p3', amount: 900 },
    ]);
    expect({
      seed: explicitResult.state.seed,
      lastDice: explicitResult.state.lastDice,
      turnPhase: explicitResult.state.turnPhase,
      player: currentPlayer(explicitResult.state),
      chanceHead: explicitResult.state.decks.chance.slice(0, 4),
      chanceTail: explicitResult.state.decks.chance.at(-1),
    }).toEqual({
      seed: '-631835658',
      lastDice: [2, 1],
      turnPhase: 'managing',
      player: {
        id: 'p3',
        nickname: '丙',
        color: 'red',
        isBot: false,
        cash: 15900,
        position: 3,
        skipTurns: 0,
        bankrupt: false,
        bankruptTurn: null,
        online: true,
      },
      chanceHead: ['71-08', '71-07', '71-04', '71-15'],
      chanceTail: '71-13',
    });
  });

  it('registry handler 不能绕过全局 debt guard', () => {
    const base = makeChinaGame();
    const debtorId = base.players.find((player) => player.id !== base.currentPlayerId)!.id;
    const state = {
      ...base,
      turnPhase: 'managing' as const,
      ruleModules: [],
      debt: { debtorId, creditorId: null, amount: 500 },
    };

    expect(applyIntent(state, base.currentPlayerId, { type: 'end_turn' })).toEqual({
      ok: false,
      code: 'NOT_YOUR_TURN',
    });
    expect(applyIntent(state, debtorId, { type: 'end_turn' })).toEqual({
      ok: false,
      code: 'WRONG_PHASE',
    });
  });

  it('registry handler 返回后仍统一执行 cash-goal win 收尾', () => {
    const base = makeChinaGame(16000);
    const state = {
      ...base,
      turnPhase: 'managing' as const,
      players: base.players.map((player) => (
        player.id === base.currentPlayerId ? { ...player, cash: 16000 } : player
      )),
    };
    const result = applyIntent(state, state.currentPlayerId, { type: 'end_turn' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`cash-goal trace failed: ${result.code}`);
    expect(result.events).toEqual([
      { type: 'turn_ended', playerId: 'p3' },
      { type: 'turn_started', playerId: 'p2' },
      { type: 'game_over', winnerId: 'p3', reason: 'cash_goal' },
    ]);
    expect(result.state.phase).toBe('game_over');
    expect(result.state.winnerId).toBe('p3');
    expect(result.state.currentPlayerId).toBe('p2');
    expect(result.state.players.find((player) => player.id === 'p3')).toMatchObject({ cash: 16000 });
  });

  it('永久 test-only map 以 exact identity 走过非连续 ID、结算并结束一回合', () => {
    const base = createGame({
      board: testMap.game.board,
      cards: testMap.game.cards,
      config: testMap.game.config,
      mapRef: testMap.ref,
      ruleModules: testMap.game.requiredRuleModules,
      players: [
        { id: 'harbor-a', nickname: 'A' },
        { id: 'harbor-b', nickname: 'B' },
      ],
      seed: 'test-only-map-engine',
    });
    const state = { ...base, seed: '12' };
    const actorId = state.currentPlayerId;
    const rolled = applyIntent(state, actorId, { type: 'roll_dice' });

    expect(state.board.cells).toHaveLength(8);
    expect(state.board.cells.map((cell) => cell.id)).toEqual([0, 10, 20, 30, 40, 50, 60, 70]);
    expect(state.mapRef).toEqual(testMap.ref);
    expect(state.ruleModules).toEqual([{ id: 'core', version: 1 }]);
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) throw new Error(`test-only map roll failed: ${rolled.code}`);
    expect(rolled.events).toEqual([
      { type: 'dice_rolled', playerId: actorId, dice: [2, 1] },
      { type: 'token_moved', playerId: actorId, path: [10, 20, 30] },
      { type: 'tax_paid', playerId: actorId, amount: 15 },
    ]);
    expect(currentPlayer(rolled.state)).toMatchObject({ position: 30, cash: 485 });
    expect(rolled.state.turnPhase).toBe('managing');

    const ended = applyIntent(rolled.state, actorId, { type: 'end_turn' });
    expect(ended.ok).toBe(true);
    if (!ended.ok) throw new Error(`test-only map end turn failed: ${ended.code}`);
    expect(ended.events).toEqual([
      { type: 'turn_ended', playerId: actorId },
      { type: 'turn_started', playerId: ended.state.currentPlayerId },
    ]);
    expect(ended.state).toMatchObject({
      mapRef: testMap.ref,
      ruleModules: [{ id: 'core', version: 1 }],
      turn: 2,
      turnPhase: 'awaiting_roll',
      lastDice: null,
    });
    expect(ended.state.currentPlayerId).not.toBe(actorId);
  });
});
