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
    // 缺省归一：旧快照（在本字段引入之前写下）hydrate 回来时可能根本没这几个键，
    // 但公开快照必须给出稳定形状 —— 客户端不该为「没有这个键」和「值为 null」写两套分支。
    pendingTrade: state.pendingTrade ?? null,
    pendingAuction: state.pendingAuction ?? null,
    auctionOnDecline: state.auctionOnDecline === true,
    deckCounts: {
      chance: state.decks.chance.length,
      destiny: state.decks.destiny.length,
    },
  };
}
