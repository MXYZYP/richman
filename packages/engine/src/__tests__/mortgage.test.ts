import { describe, it, expect } from 'vitest';
import { createGame, applyIntent } from '../engine';
import { getActiveMapPack, type PropertyCell } from '@richman/board-data';
import type { GameState, PropertyState } from '../types';

const chinaMap = getActiveMapPack('china-tour');

function makeManagingWithProperty(
  cellId: number,
  ownerId = 'p1',
  opts: { level?: number; mortgaged?: boolean } = {},
): GameState {
  const s = createGame({
    mapRef: chinaMap.ref,
    ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: chinaMap.game.config,
    players: [{ id: 'p1', nickname: '甲' }, { id: 'p2', nickname: '乙' }],
    seed: 'mortgage-test',
  });
  const prop: PropertyState = {
    ownerId,
    level: opts.level ?? 0,
    mortgaged: opts.mortgaged ?? false,
  };
  return {
    ...s,
    currentPlayerId: 'p1',
    turnPhase: 'managing',
    properties: { ...s.properties, [cellId]: prop },
  };
}

const currentPlayer = (s: GameState) => s.players.find((p) => p.id === s.currentPlayerId)!;

function propertyCell(cellId: number): PropertyCell {
  const cell = chinaMap.game.board.cells.find(
    (candidate): candidate is PropertyCell => candidate.id === cellId && candidate.type === 'property',
  );
  if (!cell) throw new Error(`cell ${cellId} is not a property`);
  return cell;
}

function mortgageProperty(cellId: number) {
  return { type: 'mortgage_property' as const, cellId };
}

function redeemProperty(cellId: number) {
  return { type: 'redeem_property' as const, cellId };
}

function setCurrentPlayerCash(s: GameState, cash: number): GameState {
  return {
    ...s,
    players: s.players.map((p) => (p.id === s.currentPlayerId ? { ...p, cash } : p)),
  };
}

function redeemCost(cellId: number) {
  const { mortgageValue } = propertyCell(cellId);
  return Math.round(mortgageValue * (1 + chinaMap.game.config.mortgageInterestRate));
}

function expectLegalRedeemIntentIsRecognized() {
  const legal = makeManagingWithProperty(2, 'p1', { level: 0, mortgaged: true });
  const r = applyIntent(legal, legal.currentPlayerId, redeemProperty(2));
  if (!r.ok) {
    throw new Error(`redeem_property intent is not implemented for legal mortgaged properties, got ${r.code}`);
  }
}

function expectLegalMortgageIntentIsRecognized() {
  const legal = makeManagingWithProperty(2, 'p1', { level: 0 });
  const r = applyIntent(legal, legal.currentPlayerId, mortgageProperty(2));
  if (!r.ok) {
    throw new Error(`mortgage_property intent is not implemented for legal properties, got ${r.code}`);
  }
}

describe('mortgage_property (M3-4) // engine-only mortgage rules', () => {
  it('mortgages owned normal property cell 2: marks mortgaged, pays mortgageValue, emits property_mortgaged', () => {
    const s = makeManagingWithProperty(2, 'p1', { level: 0 });
    const beforeCash = currentPlayer(s).cash;
    const mortgageValue = propertyCell(2).mortgageValue;

    const r = applyIntent(s, s.currentPlayerId, mortgageProperty(2));

    if (!r.ok) throw new Error(`expected mortgage_property to succeed, got ${r.code}`);
    expect(r.state.properties[2]).toEqual({ ownerId: 'p1', level: 0, mortgaged: true });
    expect(currentPlayer(r.state).cash).toBe(beforeCash + mortgageValue);
    expect(r.state.turnPhase).toBe('managing');
    expect(r.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'property_mortgaged',
        playerId: 'p1',
        cellId: 2,
        amount: mortgageValue,
      }),
    ]));
  });

  it('allows mortgage_property during debt and immediately settles once cash covers the debt', () => {
    const mortgageValue = propertyCell(2).mortgageValue;
    const debtAmount = mortgageValue - 100;
    const s = {
      ...setCurrentPlayerCash(makeManagingWithProperty(2, 'p1', { level: 0 }), 0),
      debt: { debtorId: 'p1', creditorId: 'p2', amount: debtAmount },
    };
    const creditorBefore = s.players.find((p) => p.id === 'p2')!.cash;

    const r = applyIntent(s, 'p1', mortgageProperty(2));

    if (!r.ok) throw new Error(`expected mortgage_property to settle debt, got ${r.code}`);
    expect(r.state.properties[2]).toEqual({ ownerId: 'p1', level: 0, mortgaged: true });
    expect(currentPlayer(r.state).cash).toBe(mortgageValue - debtAmount);
    expect(r.state.players.find((p) => p.id === 'p2')!.cash).toBe(creditorBefore + debtAmount);
    expect(r.state.debt).toBeNull();
    expect(r.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'property_mortgaged', playerId: 'p1', cellId: 2, amount: mortgageValue }),
      expect.objectContaining({ type: 'debt_resolved', amount: debtAmount, creditorId: 'p2' }),
    ]));
    expect(r.state.turnPhase).toBe('managing');
  });

  it('mortgages owned station cell 6 with level 0', () => {
    const s = makeManagingWithProperty(6, 'p1', { level: 0 });
    const beforeCash = currentPlayer(s).cash;
    const mortgageValue = propertyCell(6).mortgageValue;

    const r = applyIntent(s, s.currentPlayerId, mortgageProperty(6));

    if (!r.ok) throw new Error(`expected mortgage_property to succeed, got ${r.code}`);
    expect(r.state.properties[6]).toEqual({ ownerId: 'p1', level: 0, mortgaged: true });
    expect(currentPlayer(r.state).cash).toBe(beforeCash + mortgageValue);
    expect(r.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'property_mortgaged', playerId: 'p1', cellId: 6, amount: mortgageValue }),
    ]));
  });

  it('mortgages owned utility cell 10 with level 0', () => {
    const s = makeManagingWithProperty(10, 'p1', { level: 0 });
    const beforeCash = currentPlayer(s).cash;
    const mortgageValue = propertyCell(10).mortgageValue;

    const r = applyIntent(s, s.currentPlayerId, mortgageProperty(10));

    if (!r.ok) throw new Error(`expected mortgage_property to succeed, got ${r.code}`);
    expect(r.state.properties[10]).toEqual({ ownerId: 'p1', level: 0, mortgaged: true });
    expect(currentPlayer(r.state).cash).toBe(beforeCash + mortgageValue);
    expect(r.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'property_mortgaged', playerId: 'p1', cellId: 10, amount: mortgageValue }),
    ]));
  });

  it('rejects mortgaging property with houses', () => {
    expectLegalMortgageIntentIsRecognized();
    const s = makeManagingWithProperty(2, 'p1', { level: 1 });

    const r = applyIntent(s, s.currentPlayerId, mortgageProperty(2));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ILLEGAL_INTENT');
  });

  it('rejects already mortgaged property', () => {
    expectLegalMortgageIntentIsRecognized();
    const s = makeManagingWithProperty(2, 'p1', { level: 0, mortgaged: true });

    const r = applyIntent(s, s.currentPlayerId, mortgageProperty(2));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ILLEGAL_INTENT');
  });

  it('rejects mortgaging property owned by another player', () => {
    expectLegalMortgageIntentIsRecognized();
    const s = makeManagingWithProperty(2, 'p2', { level: 0 });

    const r = applyIntent(s, s.currentPlayerId, mortgageProperty(2));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ILLEGAL_INTENT');
  });

  it('rejects mortgage_property outside managing phase', () => {
    expectLegalMortgageIntentIsRecognized();
    const s = { ...makeManagingWithProperty(2, 'p1', { level: 0 }), turnPhase: 'awaiting_roll' as const };

    const r = applyIntent(s, s.currentPlayerId, mortgageProperty(2));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('WRONG_PHASE');
  });
});

describe('redeem_property (M3-4) // engine-only redeem rules', () => {
  it('redeems owned mortgaged normal property cell 2: clears mortgage, pays rounded cost, emits property_redeemed', () => {
    const s = makeManagingWithProperty(2, 'p1', { level: 0, mortgaged: true });
    const beforeCash = currentPlayer(s).cash;
    const cost = redeemCost(2);

    const r = applyIntent(s, s.currentPlayerId, redeemProperty(2));

    if (!r.ok) throw new Error(`expected redeem_property to succeed, got ${r.code}`);
    expect(r.state.properties[2]).toEqual({ ownerId: 'p1', level: 0, mortgaged: false });
    expect(currentPlayer(r.state).cash).toBe(beforeCash - cost);
    expect(r.state.turnPhase).toBe('managing');
    expect(r.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'property_redeemed',
        playerId: 'p1',
        cellId: 2,
        amount: cost,
      }),
    ]));
  });

  it('rejects redeeming property that is not mortgaged', () => {
    expectLegalRedeemIntentIsRecognized();
    const s = makeManagingWithProperty(2, 'p1', { level: 0, mortgaged: false });

    const r = applyIntent(s, s.currentPlayerId, redeemProperty(2));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ILLEGAL_INTENT');
  });

  it('rejects redeeming property owned by another player', () => {
    expectLegalRedeemIntentIsRecognized();
    const s = makeManagingWithProperty(2, 'p2', { level: 0, mortgaged: true });

    const r = applyIntent(s, s.currentPlayerId, redeemProperty(2));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ILLEGAL_INTENT');
  });

  it('rejects redeem_property when current player cannot pay rounded redeem cost', () => {
    expectLegalRedeemIntentIsRecognized();
    const s = setCurrentPlayerCash(
      makeManagingWithProperty(2, 'p1', { level: 0, mortgaged: true }),
      redeemCost(2) - 1,
    );

    const r = applyIntent(s, s.currentPlayerId, redeemProperty(2));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('rejects redeem_property outside managing phase', () => {
    expectLegalRedeemIntentIsRecognized();
    const s = { ...makeManagingWithProperty(2, 'p1', { level: 0, mortgaged: true }), turnPhase: 'awaiting_roll' as const };

    const r = applyIntent(s, s.currentPlayerId, redeemProperty(2));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('WRONG_PHASE');
  });

  it('rejects redeem_property while the player has active debt', () => {
    expectLegalRedeemIntentIsRecognized();
    const s = {
      ...makeManagingWithProperty(2, 'p1', { level: 0, mortgaged: true }),
      debt: { debtorId: 'p1', creditorId: 'p2', amount: 1000 },
    };

    const r = applyIntent(s, s.currentPlayerId, redeemProperty(2));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('WRONG_PHASE');
  });
});
