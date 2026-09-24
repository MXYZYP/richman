import { describe, expect, test } from 'vitest';
import { createGame } from '@richman/engine';
import { getActiveMapPack, type MapPack, type MapRef } from '@richman/board-data';
import type { PublicGameSnapshot } from '@richman/protocol';
import { MapCompatibilityError, resolvePublicGameSnapshot } from './mapResolver';

function publicSnapshot(pack: MapPack): PublicGameSnapshot {
  const state = createGame({
    mapRef: pack.ref,
    ruleModules: pack.game.requiredRuleModules,
    board: pack.game.board,
    cards: pack.game.cards,
    config: pack.game.config,
    players: [
      { id: 'player-a', nickname: 'A' },
      { id: 'player-b', nickname: 'B' },
    ],
    seed: 'map-resolver-seed',
  });
  return {
    mapRef: state.mapRef,
    turn: state.turn,
    phase: state.phase,
    turnPhase: state.turnPhase,
    currentPlayerId: state.currentPlayerId,
    players: state.players,
    properties: state.properties,
    publicRuleState: state.publicRuleState,
    debt: state.debt,
    lastDice: state.lastDice,
    recentLog: state.recentLog,
    winnerId: state.winnerId,
    cashGoal: state.cashGoal,
    deckCounts: {
      chance: state.decks.chance.length,
      destiny: state.decks.destiny.length,
    },
    // 议价（#105/#106）三个新字段：`?? null` / `=== true` 归一，与 publicGameSnapshot 的服务端投影同源。
    pendingTrade: state.pendingTrade ?? null,
    pendingAuction: state.pendingAuction ?? null,
    auctionOnDecline: state.auctionOnDecline === true,
  };
}

describe('resolvePublicGameSnapshot', () => {
  test('composes public runtime with immutable data from the exact local map pack', () => {
    const pack = getActiveMapPack('china-tour');
    const snapshot = {
      ...publicSnapshot(pack),
      seed: 'must-not-survive',
      decks: { chance: ['private-card'], destiny: ['private-card'] },
      board: { cells: [] },
    } as unknown as PublicGameSnapshot;

    const renderable = resolvePublicGameSnapshot(snapshot, () => pack);

    expect(renderable.mapRef).toEqual(pack.ref);
    expect(renderable.board).toBe(pack.game.board);
    expect(renderable.cards).toBe(pack.game.cards);
    expect(renderable.config).toBe(pack.game.config);
    expect(renderable.ruleModules).toBe(pack.game.requiredRuleModules);
    expect(renderable.presentation).toBe(pack.presentation);
    expect(renderable.deckCounts).toEqual(snapshot.deckCounts);
    expect(renderable.players).toBe(snapshot.players);
    expect(renderable.publicRuleState).toBe(snapshot.publicRuleState);
    expect(renderable).not.toHaveProperty('seed');
    expect(renderable).not.toHaveProperty('decks');
  });

  test('hard-fails when the exact version/hash is unavailable or the resolver substitutes a pack', () => {
    const pack = getActiveMapPack('china-tour');
    const unavailableRef = {
      ...pack.ref,
      contentHash: 'f'.repeat(64),
    } satisfies MapRef;
    const snapshot = { ...publicSnapshot(pack), mapRef: unavailableRef };

    expect(() => resolvePublicGameSnapshot(snapshot, () => {
      throw new Error('Unknown exact map');
    })).toThrow(MapCompatibilityError);
    expect(() => resolvePublicGameSnapshot(snapshot, () => pack)).toThrow(MapCompatibilityError);
  });

  test('rejects an exact pack before render when a declared local asset has no exact client registration', () => {
    const pack = getActiveMapPack('china-tour');
    const unsupported = {
      ...pack,
      presentation: {
        ...pack.presentation,
        cells: {
          ...pack.presentation.cells,
          0: {
            ...pack.presentation.cells[0]!,
            artwork: { type: 'local-asset', path: 'assets/start.webp' },
          },
        },
      },
    } satisfies MapPack;

    expect(() => resolvePublicGameSnapshot(publicSnapshot(pack), () => unsupported, () => null))
      .toThrow(MapCompatibilityError);

    expect(resolvePublicGameSnapshot(
      publicSnapshot(pack),
      () => unsupported,
      (mapRef, path) => (
        mapRef.id === pack.ref.id && path === 'assets/start.webp' ? '/bundled/start.webp' : null
      ),
    ).presentation.cells[0]?.artwork).toEqual({ type: 'local-asset', path: 'assets/start.webp' });
  });
});
