import { describe, it, expect } from 'vitest';
import { applyIntent, createGame } from '../engine';
import { chooseBotIntent } from '../bot';
import { getActiveMapPack } from '@richman/board-data';
import type { GameState, PropertyState } from '../types';

const BOT_RESERVE = 2000; // 03 §4.4
const chinaMap = getActiveMapPack('china-tour');

function makeBotGame(playerCount = 3): GameState {
  const players = Array.from({ length: playerCount }, (_, i) => ({
    id: `b${i + 1}`,
    nickname: `电脑${i + 1}`,
    isBot: true,
  }));
  return createGame({
    mapRef: chinaMap.ref,
    ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: chinaMap.game.config,
    players,
    seed: 'bot-test',
  });
}

function setCurrent(state: GameState, overrides: Partial<GameState> = {}): GameState {
  return { ...state, ...overrides };
}

function setPlayer(state: GameState, playerId: string, patch: Partial<GameState['players'][number]>): GameState {
  return {
    ...state,
    players: state.players.map((p) => (p.id === playerId ? { ...p, ...patch } : p)),
  };
}

function withProp(state: GameState, cellId: number, prop: PropertyState): GameState {
  return { ...state, properties: { ...state.properties, [cellId]: prop } };
}

function withoutMortgageValue(state: GameState, cellId: number): GameState {
  return {
    ...state,
    board: {
      ...state.board,
      cells: state.board.cells.map((cell) => {
        if (cell.id !== cellId || cell.type !== 'property') return cell;
        const { mortgageValue: _mortgageValue, ...rest } = cell;
        return rest as typeof cell;
      }),
    },
  };
}

function withPropertyCell(
  state: GameState,
  cellId: number,
  patch: { mortgageValue?: number; rents?: number[] },
): GameState {
  return {
    ...state,
    board: {
      ...state.board,
      cells: state.board.cells.map((cell) =>
        cell.id === cellId && cell.type === 'property' ? { ...cell, ...patch } : cell,
      ),
    },
  };
}

function redeemCost(state: GameState, cellId: number): number {
  const cell = state.board.cells.find((candidate) => candidate.id === cellId);
  if (!cell || cell.type !== 'property') throw new Error(`cell ${cellId} not property`);
  return Math.round(cell.mortgageValue * (1 + state.config.mortgageInterestRate));
}

const cellPrice = (id: number) =>
  (chinaMap.game.board.cells.find((c) => c.id === id)! as { price: number }).price;
const cellHouseCost = (id: number) =>
  (chinaMap.game.board.cells.find((c) => c.id === id)! as { houseCost: number }).houseCost;

describe('chooseBotIntent (03 §4.4 策略 v1) // M2 step12', () => {
  it('awaiting_roll → roll_dice', () => {
    const s = makeBotGame();
    const r = chooseBotIntent(s, s.currentPlayerId);
    expect(r).toEqual({ type: 'roll_dice' });
  });

  it('awaiting_airport_roll → roll_airport_branch', () => {
    const s = setCurrent(makeBotGame(), { turnPhase: 'awaiting_airport_roll' });
    const r = chooseBotIntent(s, s.currentPlayerId);
    expect(r).toEqual({ type: 'roll_airport_branch' });
  });

  it('awaiting_buy_decision: 现金 ≥ 地价+2000 → buy_property', () => {
    const s = setCurrent(makeBotGame(), { turnPhase: 'awaiting_buy_decision' });
    const s2 = setPlayer(s, s.currentPlayerId, { position: 2, cash: cellPrice(2) + BOT_RESERVE });
    expect(chooseBotIntent(s2, s2.currentPlayerId)).toEqual({ type: 'buy_property' });
  });

  it('awaiting_buy_decision: 现金介于 地价 与 地价+2000 → skip_buy（保守）', () => {
    const s = setCurrent(makeBotGame(), { turnPhase: 'awaiting_buy_decision' });
    const s2 = setPlayer(s, s.currentPlayerId, { position: 2, cash: cellPrice(2) + 500 });
    expect(chooseBotIntent(s2, s2.currentPlayerId)).toEqual({ type: 'skip_buy' });
  });

  it('awaiting_build_decision: 现金 ≥ 建筑费+2000 → build_house', () => {
    let s = setCurrent(makeBotGame(), { turnPhase: 'awaiting_build_decision' });
    s = setPlayer(s, s.currentPlayerId, { position: 2, cash: cellHouseCost(2) + BOT_RESERVE });
    s = withProp(s, 2, { ownerId: s.currentPlayerId, level: 0, mortgaged: false });
    expect(chooseBotIntent(s, s.currentPlayerId)).toEqual({ type: 'build_house' });
  });

  it('awaiting_build_decision: 现金不足 → skip_build', () => {
    let s = setCurrent(makeBotGame(), { turnPhase: 'awaiting_build_decision' });
    s = setPlayer(s, s.currentPlayerId, { position: 2, cash: cellHouseCost(2) });
    s = withProp(s, 2, { ownerId: s.currentPlayerId, level: 0, mortgaged: false });
    expect(chooseBotIntent(s, s.currentPlayerId)).toEqual({ type: 'skip_build' });
  });

  it('managing（无已抵押地、无债务）→ end_turn', () => {
    const s = setCurrent(makeBotGame(), { turnPhase: 'managing' });
    expect(chooseBotIntent(s, s.currentPlayerId)).toEqual({ type: 'end_turn' });
  });

  it('managing 按赎回后的预计租金从高到低选择', () => {
    let s = setCurrent(makeBotGame(), { turnPhase: 'managing' });
    const playerId = s.currentPlayerId;
    s = withProp(s, 16, { ownerId: playerId, level: 0, mortgaged: true });
    s = withProp(s, 42, { ownerId: playerId, level: 0, mortgaged: true });
    s = setPlayer(s, playerId, { cash: 99999 });

    expect(chooseBotIntent(s, playerId)).toEqual({ type: 'redeem_property', cellId: 42 });
  });

  it('managing 赎回后现金恰好 1000 时允许，并且产出的 intent 可被 applyIntent 接受', () => {
    let s = setCurrent(makeBotGame(), { turnPhase: 'managing' });
    const playerId = s.currentPlayerId;
    s = withPropertyCell(s, 2, { mortgageValue: 1005 });
    s = withProp(s, 2, { ownerId: playerId, level: 0, mortgaged: true });
    const cost = redeemCost(s, 2);
    expect(cost).toBe(1106);
    s = setPlayer(s, playerId, { cash: cost + 1000 });

    const intent = chooseBotIntent(s, playerId);
    expect(intent).toEqual({ type: 'redeem_property', cellId: 2 });

    const result = applyIntent(s, playerId, intent);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`redeem failed: ${result.code}`);
    expect(result.events).toContainEqual({ type: 'property_redeemed', playerId, cellId: 2, amount: cost });
    expect(result.state.players.find((player) => player.id === playerId)?.cash).toBe(1000);
    expect(result.state.properties[2].mortgaged).toBe(false);
  });

  it('managing 赎回后现金只剩 999 时忽略候选', () => {
    let s = setCurrent(makeBotGame(), { turnPhase: 'managing' });
    const playerId = s.currentPlayerId;
    s = withPropertyCell(s, 2, { mortgageValue: 1005 });
    s = withProp(s, 2, { ownerId: playerId, level: 0, mortgaged: true });
    s = setPlayer(s, playerId, { cash: redeemCost(s, 2) + 999 });

    expect(chooseBotIntent(s, playerId)).toEqual({ type: 'end_turn' });
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'managing 忽略非法 mortgageValue=%s，并继续选择下一块合法抵押地产',
    (mortgageValue) => {
      let s = setCurrent(makeBotGame(), { turnPhase: 'managing' });
      const playerId = s.currentPlayerId;
      s = withPropertyCell(s, 42, { rents: [9999], mortgageValue });
      s = withPropertyCell(s, 2, { rents: [1], mortgageValue: 900 });
      s = withProp(s, 42, { ownerId: playerId, level: 0, mortgaged: true });
      s = withProp(s, 2, { ownerId: playerId, level: 0, mortgaged: true });
      s = setPlayer(s, playerId, { cash: 99999 });

      expect(chooseBotIntent(s, playerId)).toEqual({ type: 'redeem_property', cellId: 2 });
    },
  );

  it('managing 只有缺失 mortgageValue 的抵押地产时结束回合，不产出非法 redeem', () => {
    let s = setCurrent(makeBotGame(), { turnPhase: 'managing' });
    const playerId = s.currentPlayerId;
    s = withoutMortgageValue(s, 42);
    s = withProp(s, 42, { ownerId: playerId, level: 0, mortgaged: true });
    s = setPlayer(s, playerId, { cash: 99999 });

    expect(chooseBotIntent(s, playerId)).toEqual({ type: 'end_turn' });
  });

  it('managing 忽略他人的已抵押地产和本人未抵押地产', () => {
    let s = setCurrent(makeBotGame(), { turnPhase: 'managing' });
    const playerId = s.currentPlayerId;
    const otherPlayerId = s.players.find((player) => player.id !== playerId)!.id;
    s = withProp(s, 42, { ownerId: otherPlayerId, level: 0, mortgaged: true });
    s = withProp(s, 4, { ownerId: playerId, level: 0, mortgaged: false });
    s = setPlayer(s, playerId, { cash: 99999 });

    expect(chooseBotIntent(s, playerId)).toEqual({ type: 'end_turn' });
  });

  it('managing 预计租金相同时按赎回价升序选择', () => {
    let s = setCurrent(makeBotGame(), { turnPhase: 'managing' });
    const playerId = s.currentPlayerId;
    s = withPropertyCell(s, 2, { rents: [500], mortgageValue: 1000 });
    s = withPropertyCell(s, 4, { rents: [500], mortgageValue: 900 });
    s = withProp(s, 2, { ownerId: playerId, level: 0, mortgaged: true });
    s = withProp(s, 4, { ownerId: playerId, level: 0, mortgaged: true });
    s = setPlayer(s, playerId, { cash: 99999 });

    expect(chooseBotIntent(s, playerId)).toEqual({ type: 'redeem_property', cellId: 4 });
  });

  it('managing 预计租金和赎回价都相同时按 cell ID 升序选择', () => {
    let s = setCurrent(makeBotGame(), { turnPhase: 'managing' });
    const playerId = s.currentPlayerId;
    s = withPropertyCell(s, 2, { rents: [500], mortgageValue: 900 });
    s = withPropertyCell(s, 4, { rents: [500], mortgageValue: 900 });
    const cell2 = s.board.cells.find((cell) => cell.id === 2)!;
    const cell4 = s.board.cells.find((cell) => cell.id === 4)!;
    s = {
      ...s,
      board: {
        ...s.board,
        cells: [...s.board.cells.filter((cell) => cell.id !== 2 && cell.id !== 4), cell4, cell2],
      },
    };
    s = withProp(s, 2, { ownerId: playerId, level: 0, mortgaged: true });
    s = withProp(s, 4, { ownerId: playerId, level: 0, mortgaged: true });
    s = setPlayer(s, playerId, { cash: 99999 });

    expect(chooseBotIntent(s, playerId)).toEqual({ type: 'redeem_property', cellId: 2 });
  });

  it('修正1：债务态 turnPhase===managing，必须先走清算分支而非 end_turn', () => {
    // 债务态 turnPhase 就是 managing；若照表顺序会发 end_turn 吃 WRONG_PHASE
    let s = setCurrent(makeBotGame(), { turnPhase: 'managing', debt: { debtorId: 'b1', creditorId: 'b2', amount: 999999 } });
    s = withProp(s, 2, { ownerId: 'b1', level: 0, mortgaged: false }); // 有可抵押地
    s = setPlayer(s, 'b1', { cash: 0 });
    expect(chooseBotIntent(s, 'b1')).toEqual({ type: 'mortgage_property', cellId: 2 });
  });

  it('全局存在他人债务时，non-debtor 不得主动赎回', () => {
    let s = setCurrent(makeBotGame(), {
      turnPhase: 'managing',
      debt: { debtorId: 'b2', creditorId: null, amount: 500 },
    });
    s = withProp(s, 42, { ownerId: 'b1', level: 0, mortgaged: true });
    s = setPlayer(s, 'b1', { cash: 99999 });

    expect(chooseBotIntent(s, 'b1')).toEqual({ type: 'end_turn' });
  });

  it('债务态有房 → sell_house（最便宜的先卖）', () => {
    // cell 2 福建 houseCost=1500；cell 4 浙江 houseCost=2000 → 应选 2
    let s = setCurrent(makeBotGame(), { turnPhase: 'managing', debt: { debtorId: 'b1', creditorId: 'b2', amount: 500 } });
    s = withProp(s, 2, { ownerId: 'b1', level: 2, mortgaged: false });
    s = withProp(s, 4, { ownerId: 'b1', level: 3, mortgaged: false });
    s = withProp(s, 6, { ownerId: 'b1', level: 0, mortgaged: false }); // 可抵押，但有房时仍先卖房
    s = setPlayer(s, 'b1', { cash: 0 });
    expect(chooseBotIntent(s, 'b1')).toEqual({ type: 'sell_house', cellId: 2 });
  });

  it('债务态无房有未抵押地 → mortgage_property（最便宜的地先抵押）', () => {
    // cell 6 广州站 price=2000/mortgageValue=1000；cell 2 福建 price=2400/mortgageValue=1200 → 应选 6
    let s = setCurrent(makeBotGame(), { turnPhase: 'managing', debt: { debtorId: 'b1', creditorId: 'b2', amount: 500 } });
    s = withProp(s, 2, { ownerId: 'b1', level: 0, mortgaged: false });
    s = withProp(s, 6, { ownerId: 'b1', level: 0, mortgaged: false });
    s = setPlayer(s, 'b1', { cash: 0 });
    expect(chooseBotIntent(s, 'b1')).toEqual({ type: 'mortgage_property', cellId: 6 });
  });

  it('债务态无房且无可抵押地时 → sell_property（最便宜的可卖地）', () => {
    let s = setCurrent(makeBotGame(), { turnPhase: 'managing', debt: { debtorId: 'b1', creditorId: 'b2', amount: 500 } });
    s = withProp(s, 2, { ownerId: 'b1', level: 0, mortgaged: false });
    s = withProp(s, 6, { ownerId: 'b1', level: 0, mortgaged: false });
    s = withoutMortgageValue(withoutMortgageValue(s, 2), 6);
    s = setPlayer(s, 'b1', { cash: 0 });
    expect(chooseBotIntent(s, 'b1')).toEqual({ type: 'sell_property', cellId: 6 });
  });

  it('债务态只剩已抵押资产 → declare_bankrupt', () => {
    let s = setCurrent(makeBotGame(), {
      turnPhase: 'managing',
      debt: { debtorId: 'b1', creditorId: 'b2', amount: 999999 },
    });
    s = withProp(s, 2, { ownerId: 'b1', level: 0, mortgaged: true });
    s = setPlayer(s, 'b1', { cash: 0 });
    expect(chooseBotIntent(s, 'b1')).toEqual({ type: 'declare_bankrupt' });
  });
});
