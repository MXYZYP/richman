import type { GameEvent, GameState } from './types';

export function advanceToNextPlayableTurn(
  state: GameState,
  fromPlayerId: string,
  events: GameEvent[],
): { state: GameState; events: GameEvent[] } {
  const currentIdx = state.players.findIndex((player) => player.id === fromPlayerId);
  const newPlayers = state.players.slice();
  const evts: GameEvent[] = [...events, { type: 'turn_ended', playerId: fromPlayerId }];
  let skippedCount = 0;

  // 覆盖所有暂停次数和破产座次，最终一定落到首个可行动玩家。
  const totalSkipTurns = newPlayers.reduce(
    (sum, player) => sum + (player.bankrupt ? 0 : player.skipTurns),
    0,
  );
  const maxAttempts = newPlayers.length + totalSkipTurns + 1;

  let nextIdx = (currentIdx + 1) % newPlayers.length;
  let attempts = 0;
  while (attempts < maxAttempts) {
    const candidate = newPlayers[nextIdx];
    if (candidate.bankrupt) {
      // 破产玩家直接跳过。
    } else if (candidate.skipTurns > 0) {
      newPlayers[nextIdx] = { ...candidate, skipTurns: candidate.skipTurns - 1 };
      evts.push({ type: 'turn_started', playerId: candidate.id });
      evts.push({ type: 'turn_ended', playerId: candidate.id });
      skippedCount += 1;
    } else {
      break;
    }
    nextIdx = (nextIdx + 1) % newPlayers.length;
    attempts += 1;
  }

  evts.push({ type: 'turn_started', playerId: newPlayers[nextIdx].id });
  return {
    state: {
      ...state,
      players: newPlayers,
      currentPlayerId: newPlayers[nextIdx].id,
      turn: state.turn + 1 + skippedCount,
      turnPhase: 'awaiting_roll',
      lastDice: null,
    },
    events: evts,
  };
}
