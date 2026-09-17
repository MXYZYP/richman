import type { GameState } from '@richman/engine';
import type { PublicGameSnapshot } from '@richman/protocol';

export function toPublicGameSnapshot(state: GameState): PublicGameSnapshot {
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
  };
}
