// 电脑玩家难度分级（P1-6）的回归测试。
// 契约：难度只改「出手的现金安全垫」与「是否主动赎回」，不改任何决策分支结构；
// normal 必须与既有策略 v1 完全一致（存量测试与联机默认都依赖这一点）。
import { describe, it, expect } from 'vitest';
import { applyIntent, createGame } from '../engine';
import { chooseBotIntent, type BotDifficulty } from '../bot';
import { getActiveMapPack } from '@richman/board-data';
import type { GameState } from '../types';

const chinaMap = getActiveMapPack('china-tour');
const BOARD = chinaMap.game.board;
const RESERVE = { easy: 4000, normal: 2000, hard: 800 } as const;
const DIFFICULTIES: BotDifficulty[] = ['easy', 'normal', 'hard'];

function makeBotGame(): GameState {
  return createGame({
    mapRef: chinaMap.ref,
    ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: chinaMap.game.config,
    players: [
      { id: 'b1', nickname: '电脑1', isBot: true },
      { id: 'b2', nickname: '电脑2', isBot: true },
      { id: 'b3', nickname: '电脑3', isBot: true },
    ],
    seed: 'bot-difficulty-test',
  });
}

function setPlayer(state: GameState, playerId: string, patch: Partial<GameState['players'][number]>): GameState {
  return { ...state, players: state.players.map((p) => (p.id === playerId ? { ...p, ...patch } : p)) };
}

function withProp(state: GameState, cellId: number, ownerId: string, mortgaged: boolean): GameState {
  return { ...state, properties: { ...state.properties, [cellId]: { ownerId, level: 0, mortgaged } } };
}

const cellNumber = (id: number, key: 'price' | 'houseCost' | 'mortgageValue'): number => {
  const cell = BOARD.cells.find((candidate) => candidate.id === id);
  if (cell === undefined) throw new Error(`cell ${id} not found`);
  const value = (cell as unknown as Record<string, unknown>)[key];
  if (typeof value !== 'number') throw new Error(`cell ${id} has no numeric ${key}`);
  return value;
};

/** 同一局面、同一格子下，三档难度分别产出的意图。 */
function intentsByDifficulty(state: GameState, playerId: string): Record<BotDifficulty, string> {
  return {
    easy: JSON.stringify(chooseBotIntent(state, playerId, undefined, 'easy')),
    normal: JSON.stringify(chooseBotIntent(state, playerId, undefined, 'normal')),
    hard: JSON.stringify(chooseBotIntent(state, playerId, undefined, 'hard')),
  };
}

describe('chooseBotIntent 难度分级（P1-6）', () => {
  it('省略 difficulty 时等价于 normal，保持联机默认与既有策略不回归', () => {
    const base = makeBotGame();
    const buyState = setPlayer(
      { ...base, turnPhase: 'awaiting_buy_decision' },
      base.currentPlayerId,
      { position: 2, cash: cellNumber(2, 'price') + RESERVE.normal },
    );

    // 三处难度的默认值都必须落在 normal 上（而不是像 sfx/bgm 那样各有默认）。
    expect(chooseBotIntent(buyState, buyState.currentPlayerId))
      .toEqual(chooseBotIntent(buyState, buyState.currentPlayerId, undefined, 'normal'));

    const managing = setPlayer({ ...base, turnPhase: 'managing' }, base.currentPlayerId, { cash: 99_999 });
    expect(chooseBotIntent(managing, managing.currentPlayerId))
      .toEqual({ type: 'end_turn' });
  });

  it('awaiting_buy_decision：安全垫 4000 / 2000 / 800 决定同一笔现金是否出手', () => {
    const base = { ...makeBotGame(), turnPhase: 'awaiting_buy_decision' as const };
    const price = cellNumber(2, 'price');
    const playerId = base.currentPlayerId;
    const state = (cash: number) => setPlayer(base, playerId, { position: 2, cash });

    // 只够 hard 的安全垫：激进档出手，正常/保守档都不出手。
    expect(intentsByDifficulty(state(price + 900), playerId)).toEqual({
      easy: JSON.stringify({ type: 'skip_buy' }),
      normal: JSON.stringify({ type: 'skip_buy' }),
      hard: JSON.stringify({ type: 'buy_property' }),
    });

    // 只够 normal 与 hard 的安全垫。
    expect(intentsByDifficulty(state(price + 2500), playerId)).toEqual({
      easy: JSON.stringify({ type: 'skip_buy' }),
      normal: JSON.stringify({ type: 'buy_property' }),
      hard: JSON.stringify({ type: 'buy_property' }),
    });

    // 三档安全垫都满足。
    expect(intentsByDifficulty(state(price + 4100), playerId)).toEqual({
      easy: JSON.stringify({ type: 'buy_property' }),
      normal: JSON.stringify({ type: 'buy_property' }),
      hard: JSON.stringify({ type: 'buy_property' }),
    });
  });

  it('awaiting_build_decision：同一建筑费下三档给出的盖房结论按安全垫分档', () => {
    const base = { ...makeBotGame(), turnPhase: 'awaiting_build_decision' as const };
    const playerId = base.currentPlayerId;
    const houseCost = cellNumber(2, 'houseCost');
    const state = (cash: number) => withProp(setPlayer(base, playerId, { position: 2, cash }), 2, playerId, false);

    expect(intentsByDifficulty(state(houseCost + 900), playerId)).toEqual({
      easy: JSON.stringify({ type: 'skip_build' }),
      normal: JSON.stringify({ type: 'skip_build' }),
      hard: JSON.stringify({ type: 'build_house' }),
    });
    expect(intentsByDifficulty(state(houseCost + 2500), playerId)).toEqual({
      easy: JSON.stringify({ type: 'skip_build' }),
      normal: JSON.stringify({ type: 'build_house' }),
      hard: JSON.stringify({ type: 'build_house' }),
    });
  });

  it('managing：hard 保留 600、normal 保留 1000、easy 从不主动赎回抵押地产', () => {
    const base = { ...makeBotGame(), turnPhase: 'managing' as const };
    const playerId = base.currentPlayerId;
    const mortgageValue = cellNumber(2, 'mortgageValue');
    const cost = Math.round(mortgageValue * (1 + base.config.mortgageInterestRate));
    const state = (cash: number) => withProp(setPlayer(base, playerId, { cash }), 2, playerId, true);

    // 赎回后只剩 700：只有 hard 的 600 门槛过得去。
    expect(intentsByDifficulty(state(cost + 700), playerId)).toEqual({
      easy: JSON.stringify({ type: 'end_turn' }),
      normal: JSON.stringify({ type: 'end_turn' }),
      hard: JSON.stringify({ type: 'redeem_property', cellId: 2 }),
    });

    // 赎回后剩 1200：normal / hard 都会赎回，easy 依然不主动赎回。
    expect(intentsByDifficulty(state(cost + 1200), playerId)).toEqual({
      easy: JSON.stringify({ type: 'end_turn' }),
      normal: JSON.stringify({ type: 'redeem_property', cellId: 2 }),
      hard: JSON.stringify({ type: 'redeem_property', cellId: 2 }),
    });
  });

  it('hard 产出的买地意图仍被引擎接受（难度不得放宽合法性闸门）', () => {
    const base = { ...makeBotGame(), turnPhase: 'awaiting_buy_decision' as const };
    const playerId = base.currentPlayerId;
    const state = setPlayer(base, playerId, { position: 2, cash: cellNumber(2, 'price') + RESERVE.hard });

    const intent = chooseBotIntent(state, playerId, undefined, 'hard');
    expect(intent).toEqual({ type: 'buy_property' });

    const result = applyIntent(state, playerId, intent);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`hard buy rejected: ${result.code}`);
    expect(result.state.properties[2]?.ownerId).toBe(playerId);
  });

  it('难度是纯参数：同一 state 连续取三档不产生互相污染', () => {
    const base = { ...makeBotGame(), turnPhase: 'awaiting_buy_decision' as const };
    const playerId = base.currentPlayerId;
    const state = setPlayer(base, playerId, { position: 2, cash: cellNumber(2, 'price') + 2500 });

    for (const difficulty of DIFFICULTIES) {
      const first = chooseBotIntent(state, playerId, undefined, difficulty);
      const second = chooseBotIntent(state, playerId, undefined, difficulty);
      expect(second).toEqual(first);
    }
    // 反复取用后 original state 未被修改（chooseBotIntent 必须是纯函数）。
    expect(state.players.find((p) => p.id === playerId)?.cash).toBe(cellNumber(2, 'price') + 2500);
  });
});
