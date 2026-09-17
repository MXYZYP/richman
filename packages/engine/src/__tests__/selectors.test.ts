import { describe, expect, it } from 'vitest';
import { getActiveMapPack } from '@richman/board-data';
import { createGame } from '../engine';
import { canBuild, canBuyProperty, getSellableAssets } from '../selectors';
import type { GameState, PropertyState } from '../types';

const chinaMap = getActiveMapPack('china-tour');

function baseGame(): GameState {
  return createGame({
    mapRef: chinaMap.ref,
    ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: chinaMap.game.config,
    players: [{ id: 'p1', nickname: '甲' }, { id: 'p2', nickname: '乙' }],
    seed: 'selectors-test',
  });
}

function withCurrentAt(state: GameState, cellId: number): GameState {
  return {
    ...state,
    players: state.players.map((p) =>
      p.id === state.currentPlayerId ? { ...p, position: cellId } : p,
    ),
  };
}

function setPlayerCash(state: GameState, playerId: string, cash: number): GameState {
  return {
    ...state,
    players: state.players.map((p) => (p.id === playerId ? { ...p, cash } : p)),
  };
}

function withProperty(
  state: GameState,
  cellId: number,
  prop: PropertyState,
): GameState {
  return { ...state, properties: { ...state.properties, [cellId]: prop } };
}

const cellPrice = (id: number) =>
  (chinaMap.game.board.cells.find((c) => c.id === id)! as { price: number }).price;
const houseCost = (id: number) =>
  (chinaMap.game.board.cells.find((c) => c.id === id)! as { houseCost: number }).houseCost;

describe('selectors（03 §4）// M2 step11', () => {
  it('canBuyProperty: 当前玩家在可买阶段，落在现金足够的无主地产时返回 true', () => {
    const atDecision = withCurrentAt({ ...baseGame(), turnPhase: 'awaiting_buy_decision' }, 2);
    const s = setPlayerCash(atDecision, atDecision.currentPlayerId, cellPrice(2));

    expect(canBuyProperty(s)).toBe(true);
  });

  it('canBuyProperty: 阶段不对、现金不足、或已有主时返回 false', () => {
    const ready = withCurrentAt({ ...baseGame(), turnPhase: 'awaiting_buy_decision' }, 2);
    const otherPlayerId = ready.players.find((p) => p.id !== ready.currentPlayerId)!.id;

    expect(canBuyProperty({ ...ready, turnPhase: 'managing' })).toBe(false);
    expect(canBuyProperty(setPlayerCash(ready, ready.currentPlayerId, cellPrice(2) - 1))).toBe(false);
    expect(canBuyProperty(withProperty(ready, 2, { ownerId: otherPlayerId, level: 0, mortgaged: false }))).toBe(false);
  });

  it('canBuild: 当前玩家在可盖阶段，停在自己的普通未抵押地产且现金足够时返回 true', () => {
    const atDecision = withCurrentAt({ ...baseGame(), turnPhase: 'awaiting_build_decision' }, 2);
    const s = setPlayerCash(
      withProperty(
        atDecision,
        2,
        { ownerId: atDecision.currentPlayerId, level: 4, mortgaged: false },
      ),
      atDecision.currentPlayerId,
      houseCost(2),
    );

    expect(canBuild(s)).toBe(true);
  });

  it('canBuild: 阶段不对、满级、抵押、现金不足、或非普通地产时返回 false', () => {
    const atDecision = withCurrentAt({ ...baseGame(), turnPhase: 'awaiting_build_decision' }, 2);
    const ready = withProperty(
      atDecision,
      2,
      { ownerId: atDecision.currentPlayerId, level: 0, mortgaged: false },
    );

    expect(canBuild({ ...ready, turnPhase: 'managing' })).toBe(false);
    expect(canBuild(withProperty(ready, 2, { ownerId: ready.currentPlayerId, level: 5, mortgaged: false }))).toBe(false);
    expect(canBuild(withProperty(ready, 2, { ownerId: ready.currentPlayerId, level: 0, mortgaged: true }))).toBe(false);
    expect(canBuild(setPlayerCash(ready, ready.currentPlayerId, houseCost(2) - 1))).toBe(false);
    expect(canBuild(withProperty(withCurrentAt({ ...ready, turnPhase: 'awaiting_build_decision' }, 6), 6, { ownerId: ready.currentPlayerId, level: 0, mortgaged: false }))).toBe(false);
  });

  it('getSellableAssets: 返回指定玩家可卖房与可卖地列表', () => {
    let s = baseGame();
    s = withProperty(s, 2, { ownerId: 'p1', level: 2, mortgaged: false }); // 有房：只能卖房
    s = withProperty(s, 4, { ownerId: 'p1', level: 0, mortgaged: false }); // 无房未抵押：可卖地
    s = withProperty(s, 6, { ownerId: 'p1', level: 0, mortgaged: false }); // 车站：可卖地
    s = withProperty(s, 8, { ownerId: 'p1', level: 0, mortgaged: true }); // 抵押：不可卖地
    s = withProperty(s, 10, { ownerId: 'p2', level: 3, mortgaged: false }); // 别人的：不可卖

    expect(getSellableAssets(s, 'p1')).toEqual({
      sellableHouses: [2],
      sellableProperties: [4, 6],
    });
  });
});
