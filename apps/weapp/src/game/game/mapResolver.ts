import { getMapPack, type MapPack, type MapRef } from '@richman/board-data';
import type { GameState } from '@richman/engine';
import type { PublicGameSnapshot } from '@richman/protocol';
import type { RenderableGameState } from '../session/gameSession';
import { hasAllClientMapAssets, resolveClientMapAsset, type ClientMapAssetResolver } from './mapAssets';

export class MapCompatibilityError extends Error {}

function resolveExactMapPack(
  mapRef: MapRef,
  resolveExact: (mapRef: MapRef) => MapPack,
  resolveAsset: ClientMapAssetResolver,
): MapPack {
  let pack: MapPack;
  try {
    pack = resolveExact(mapRef);
  } catch {
    throw new MapCompatibilityError('Exact map pack is unavailable.');
  }

  if (
    pack.ref.id !== mapRef.id
    || pack.ref.version !== mapRef.version
    || pack.ref.contentHash !== mapRef.contentHash
  ) {
    throw new MapCompatibilityError('Exact map pack identity does not match the room.');
  }
  if (!hasAllClientMapAssets(pack, resolveAsset)) {
    throw new MapCompatibilityError('A required map asset is unavailable.');
  }
  return pack;
}

export function resolvePublicGameSnapshot(
  snapshot: PublicGameSnapshot,
  resolveExact: (mapRef: MapRef) => MapPack = getMapPack,
  resolveAsset: ClientMapAssetResolver = resolveClientMapAsset,
): RenderableGameState {
  const pack = resolveExactMapPack(snapshot.mapRef, resolveExact, resolveAsset);

  return {
    mapRef: snapshot.mapRef,
    turn: snapshot.turn,
    phase: snapshot.phase,
    turnPhase: snapshot.turnPhase,
    currentPlayerId: snapshot.currentPlayerId,
    players: snapshot.players,
    properties: snapshot.properties,
    publicRuleState: snapshot.publicRuleState ?? { modules: {}, pendingActions: [] },
    debt: snapshot.debt,
    lastDice: snapshot.lastDice,
    recentLog: snapshot.recentLog,
    winnerId: snapshot.winnerId,
    cashGoal: snapshot.cashGoal,
    presentation: pack.presentation,
    deckCounts: snapshot.deckCounts,
    ruleModules: pack.game.requiredRuleModules,
    board: pack.game.board,
    cards: pack.game.cards,
    config: pack.game.config,
  };
}

export function resolveLocalGameState(
  state: GameState,
  resolveExact: (mapRef: MapRef) => MapPack = getMapPack,
  resolveAsset: ClientMapAssetResolver = resolveClientMapAsset,
): RenderableGameState {
  const pack = resolveExactMapPack(state.mapRef, resolveExact, resolveAsset);
  return {
    mapRef: state.mapRef,
    turn: state.turn,
    phase: state.phase,
    turnPhase: state.turnPhase,
    currentPlayerId: state.currentPlayerId,
    players: structuredClone(state.players),
    properties: structuredClone(state.properties),
    publicRuleState: structuredClone(state.publicRuleState),
    debt: structuredClone(state.debt),
    ...(state.cardChoice === undefined ? {} : { cardChoice: structuredClone(state.cardChoice) }),
    lastDice: structuredClone(state.lastDice),
    recentLog: structuredClone(state.recentLog),
    winnerId: state.winnerId,
    cashGoal: state.cashGoal,
    presentation: pack.presentation,
    deckCounts: {
      chance: state.decks.chance.length,
      destiny: state.decks.destiny.length,
    },
    ruleModules: pack.game.requiredRuleModules,
    board: pack.game.board,
    cards: pack.game.cards,
    config: pack.game.config,
  };
}
