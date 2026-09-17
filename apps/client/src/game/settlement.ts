import type { PlayerState } from '@richman/engine';
import type { RenderableGameState } from '../session/gameSession';
import { formatMoney } from '../ui/format';

export interface SettlementRow {
  id: string;
  rank: number;
  name: string;
  status: string;
  cash: number;
  isWinner: boolean;
  isBankrupt: boolean;
  isBot: boolean;
  propertyNames: string[];
  propertyCount: number;
  survivedTurns: number;
}

export interface SettlementSummary {
  title: string;
  reason: string;
  rows: SettlementRow[];
}

function compareSettlementPlayers(state: RenderableGameState, originalIndex: Map<string, number>) {
  return (left: PlayerState, right: PlayerState): number => {
    if (left.id === state.winnerId) return -1;
    if (right.id === state.winnerId) return 1;
    if (left.bankrupt !== right.bankrupt) return left.bankrupt ? 1 : -1;
    if (!left.bankrupt && !right.bankrupt && left.cash !== right.cash) return right.cash - left.cash;
    return (originalIndex.get(left.id) ?? 0) - (originalIndex.get(right.id) ?? 0);
  };
}

function settlementReason(state: RenderableGameState, winner: PlayerState | null): string {
  const gameOver = [...state.recentLog].reverse().find((event) => event.type === 'game_over');
  if (gameOver?.type === 'game_over' && gameOver.reason === 'cash_goal') {
    return winner ? `${winner.nickname} 率先达到现金目标，本局结束` : '达到现金目标，本局结束';
  }
  return '所有对手已破产，本局结束';
}

function playerPropertyNames(state: RenderableGameState, playerId: string): string[] {
  return state.board.cells.flatMap((cell) => {
    if (cell.type !== 'property') return [];
    return state.properties[cell.id]?.ownerId === playerId ? [cell.name] : [];
  });
}

function survivedTurns(state: RenderableGameState, player: PlayerState): number {
  return player.bankrupt ? (player.bankruptTurn ?? state.turn) : state.turn;
}

export function getSettlementSummary(state: RenderableGameState): SettlementSummary {
  const winner = state.players.find((player) => player.id === state.winnerId) ?? null;
  const originalIndex = new Map(state.players.map((player, index) => [player.id, index]));
  const sortedPlayers = [...state.players].sort(compareSettlementPlayers(state, originalIndex));

  return {
    title: winner ? `${winner.nickname} 获胜` : '本局结束',
    reason: settlementReason(state, winner),
    rows: sortedPlayers.map((player, index) => {
      const propertyNames = playerPropertyNames(state, player.id);
      return {
        id: player.id,
        rank: index + 1,
        name: player.nickname,
        status: player.bankrupt ? '破产' : `¥${formatMoney(player.cash)}`,
        cash: player.cash,
        isWinner: player.id === state.winnerId,
        isBankrupt: player.bankrupt,
        isBot: player.isBot,
        propertyNames,
        propertyCount: propertyNames.length,
        survivedTurns: survivedTurns(state, player),
      };
    }),
  };
}
