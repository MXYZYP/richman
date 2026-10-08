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

export type SettlementExitKind = 'restart' | 'home';

export interface SettlementExitDecision {
  readonly kind: SettlementExitKind;
  /** Button copy. Never promise a restart we cannot actually perform. */
  readonly label: string;
  /** False when the action cannot run (no session), so the caller must not emit. */
  readonly actionable: boolean;
  /** Copy explaining why nothing happens — shown instead of a dead button. */
  readonly disabledReason: string | null;
}

/**
 * What the settlement dialog's PRIMARY button must do when the game is over.
 *
 * A finished game has exactly one legal destination: out of the board view. There is
 * nothing left to "restart" server-side — the room is finished and replay/save logic
 * lives outside this dialog — so offering 「再开一局」 wired to the exit path is a lie
 * that reads as a dead button. Local hot-seat is the one case that can genuinely start
 * another game, and only when a local session still exists to restart.
 */
export function getSettlementExitDecision(input: {
  readonly mode: 'local' | 'online';
  readonly isPlayback: boolean;
}): SettlementExitDecision {
  if (input.isPlayback) {
    return { kind: 'home', label: '退出复盘', actionable: true, disabledReason: null };
  }
  if (input.mode === 'online') {
    return { kind: 'home', label: '离开房间', actionable: true, disabledReason: null };
  }
  return {
    kind: 'home',
    label: '保存并返回首页',
    actionable: true,
    disabledReason: null,
  };
}

/**
 * Whether the settlement dialog may be dismissed to look at the final board.
 *
 * Dismissing is only safe while a real session is still mounted: the board it reveals
 * reads live session state, so with no session there is nothing to reveal and the
 * dialog would be the only way out. Kept as an explicit predicate so the rule is
 * testable instead of living inside a template expression.
 */
export function canInspectFinalBoard(input: {
  readonly hasSession: boolean;
  readonly isPlayback: boolean;
}): boolean {
  return input.hasSession && !input.isPlayback;
}
