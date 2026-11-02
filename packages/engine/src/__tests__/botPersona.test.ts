// 个性电脑玩家（#1 BotPersona）的回归测试。
//
// 三条契约：
//  1. balanced 必须与引入性格之前逐字节一致（存量测试、联机默认都依赖它）；
//  2. 性格与难度正交：同难度换性格必须真的改变决策，否则这个功能等于没做；
//  3. 性格只改阈值，不放宽合法性闸门——产出的意图仍必须被 applyIntent 接受。
import { describe, it, expect } from 'vitest';
import { applyIntent, createGame } from '../engine';
import { BOT_PERSONAS, chooseBotIntent, resolveBotProfile, type BotDifficulty, type BotPersona } from '../bot';
import { getActiveMapPack } from '@richman/board-data';
import type { GameState } from '../types';

const chinaMap = getActiveMapPack('china-tour');
const BOARD = chinaMap.game.board;

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
    seed: 'bot-persona-test',
  });
}

function setPlayer(state: GameState, playerId: string, patch: Partial<GameState['players'][number]>): GameState {
  return { ...state, players: state.players.map((p) => (p.id === playerId ? { ...p, ...patch } : p)) };
}

function withProp(state: GameState, cellId: number, ownerId: string): GameState {
  return { ...state, properties: { ...state.properties, [cellId]: { ownerId, level: 0, mortgaged: false } } };
}

const cellNumber = (id: number, key: 'price' | 'houseCost' | 'mortgageValue'): number => {
  const cell = BOARD.cells.find((candidate) => candidate.id === id);
  if (cell === undefined) throw new Error(`cell ${id} not found`);
  const value = (cell as unknown as Record<string, unknown>)[key];
  if (typeof value !== 'number') throw new Error(`cell ${id} has no numeric ${key}`);
  return value;
};

const DIFFICULTIES: BotDifficulty[] = ['easy', 'normal', 'hard'];

describe('resolveBotProfile：难度 × 性格 → 阈值', () => {
  it('balanced 三档与历史常量逐字段相同（零回归基线）', () => {
    expect(resolveBotProfile('easy', 'balanced')).toEqual({
      reserve: 4000,
      buildReserve: 4000,
      redeemReserve: 0,
      redeems: false,
      auctionMultiplier: 1.0,
      tradeMargin: 500,
    });
    expect(resolveBotProfile('normal', 'balanced')).toEqual({
      reserve: 2000,
      buildReserve: 2000,
      redeemReserve: 1000,
      redeems: true,
      auctionMultiplier: 1.2,
      tradeMargin: 1,
    });
    expect(resolveBotProfile('hard', 'balanced')).toEqual({
      reserve: 800,
      buildReserve: 800,
      redeemReserve: 600,
      redeems: true,
      auctionMultiplier: 1.5,
      tradeMargin: 1,
    });
  });

  it('省略 persona 等价于 balanced', () => {
    for (const difficulty of DIFFICULTIES) {
      expect(resolveBotProfile(difficulty)).toEqual(resolveBotProfile(difficulty, 'balanced'));
    }
  });

  it('四种性格的阈值互不相同（至少安全垫与盖房门槛要分开）', () => {
    const profiles = BOT_PERSONAS.map((persona) => resolveBotProfile('normal', persona));
    // 买地安全垫：aggressive < tycoon < balanced < conservative
    expect(profiles[1].reserve).toBeLessThan(profiles[3].reserve);
    expect(profiles[3].reserve).toBeLessThan(profiles[0].reserve);
    expect(profiles[0].reserve).toBeLessThan(profiles[2].reserve);
    // tycoon 的盖房门槛必须显著高于其买地门槛（囤地不盖房）
    expect(profiles[3].buildReserve).toBeGreaterThan(profiles[3].reserve * 2);
  });
});

describe('chooseBotIntent：性格改变决策', () => {
  it('同一笔现金下 aggressive 敢买、balanced 与 conservative 不出手', () => {
    const base = { ...makeBotGame(), turnPhase: 'awaiting_buy_decision' as const };
    const playerId = base.currentPlayerId;
    // 比地价多 1000：过得了 aggressive 的 800，过不了 balanced 的 2000。
    const state = setPlayer(base, playerId, { position: 2, cash: cellNumber(2, 'price') + 1000 });

    expect(chooseBotIntent(state, playerId, undefined, 'normal', 'aggressive')).toEqual({ type: 'buy_property' });
    expect(chooseBotIntent(state, playerId, undefined, 'normal', 'balanced')).toEqual({ type: 'skip_buy' });
    expect(chooseBotIntent(state, playerId, undefined, 'normal', 'conservative')).toEqual({ type: 'skip_buy' });
  });

  it('tycoon 把钱留给买地：同样的现金下不盖房，balanced 会盖', () => {
    const base = { ...makeBotGame(), turnPhase: 'awaiting_build_decision' as const };
    const playerId = base.currentPlayerId;
    const houseCost = cellNumber(2, 'houseCost');
    // 比建筑费多 5000：过得了 balanced 的 2000，过不了 tycoon 的 6000。
    const state = withProp(setPlayer(base, playerId, { position: 2, cash: houseCost + 5000 }), 2, playerId);

    expect(chooseBotIntent(state, playerId, undefined, 'normal', 'tycoon')).toEqual({ type: 'skip_build' });
    expect(chooseBotIntent(state, playerId, undefined, 'normal', 'balanced')).toEqual({ type: 'build_house' });
  });

  it('conservative 的安全垫更厚：余额只够 balanced 时它选择不出手', () => {
    const base = { ...makeBotGame(), turnPhase: 'awaiting_buy_decision' as const };
    const playerId = base.currentPlayerId;
    // 比地价多 2500：balanced(2000) 买，conservative(3600) 不买。
    const state = setPlayer(base, playerId, { position: 2, cash: cellNumber(2, 'price') + 2500 });

    expect(chooseBotIntent(state, playerId, undefined, 'normal', 'balanced')).toEqual({ type: 'buy_property' });
    expect(chooseBotIntent(state, playerId, undefined, 'normal', 'conservative')).toEqual({ type: 'skip_buy' });
  });

  it('拍卖叫价：aggressive 出价、conservative 弃权（同一现金）', () => {
    const base = makeBotGame();
    const bidderId = base.players[0].id;
    // 现金 3699：conservative 的保留金 = 2000×1.8 = 3600，只剩 99 < 最小加价 100 → 弃权；
    // aggressive 的保留金 = 800，远有余量 → 出价。
    const state: GameState = {
      ...base,
      turnPhase: 'awaiting_auction_bid',
      currentPlayerId: bidderId,
      pendingAuction: { cellId: 2, bidderId, leaderId: null, leaderBid: 0, passedIds: [] },
      players: base.players.map((p) => (p.id === bidderId ? { ...p, cash: 3699 } : p)),
    };

    const aggressive = chooseBotIntent(state, bidderId, undefined, 'normal', 'aggressive');
    expect(aggressive.type).toBe('place_bid');
    expect(chooseBotIntent(state, bidderId, undefined, 'normal', 'conservative')).toEqual({ type: 'pass_bid' });
  });

  it('性格不放宽合法性闸门：aggressive 的买地意图仍被引擎接受', () => {
    const base = { ...makeBotGame(), turnPhase: 'awaiting_buy_decision' as const };
    const playerId = base.currentPlayerId;
    const state = setPlayer(base, playerId, { position: 2, cash: cellNumber(2, 'price') + 900 });

    const intent = chooseBotIntent(state, playerId, undefined, 'normal', 'aggressive' as BotPersona);
    const result = applyIntent(state, playerId, intent);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`aggressive buy rejected: ${result.code}`);
    expect(result.state.properties[2]?.ownerId).toBe(playerId);
  });

  it('persona 是纯参数：同一 state 反复取用互不污染', () => {
    const base = { ...makeBotGame(), turnPhase: 'awaiting_buy_decision' as const };
    const playerId = base.currentPlayerId;
    const cash = cellNumber(2, 'price') + 900;
    const state = setPlayer(base, playerId, { position: 2, cash });

    for (const persona of BOT_PERSONAS) {
      const first = chooseBotIntent(state, playerId, undefined, 'normal', persona);
      expect(chooseBotIntent(state, playerId, undefined, 'normal', persona)).toEqual(first);
    }
    expect(state.players.find((p) => p.id === playerId)?.cash).toBe(cash);
  });
});
