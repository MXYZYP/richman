// 现金目标（cash_goal）即时终局检查（01 §12 / E18）
// 在任何“现金增加”动作之后调用：现金达标且无债务 → 立即结束游戏，短路后续流程。
import type { GameState, GameEvent } from './types';

/**
 * 现金目标即时终局判定。
 *
 * 规则（E18）：
 * - cashGoal 为 null（未开启房规）→ 不触发
 * - 当前存在未清债务（state.debt !== null）→ 不触发
 *   （债务优先；卖产筹款使现金临时达标不算获胜，须先把债务清掉）
 * - 已 game_over → 不重复触发
 * - 否则取第一个 !bankrupt && cash >= cashGoal 的玩家作为胜者
 *
 * @returns null 表示未触发；非 null 表示已写入 game_over（state.phase/winnerId + 追加事件）。
 *          调用方拿到非 null 后应立即 return / 短路，不再继续落点链或创建债务。
 */
export function finishCashGoalIfReached(
  state: GameState,
  events: GameEvent[],
): { state: GameState; events: GameEvent[] } | null {
  if (state.cashGoal === null) return null;
  if (state.debt !== null) return null;
  if (state.phase === 'game_over') return null;

  const winner = state.players.find((p) => !p.bankrupt && p.cash >= state.cashGoal!);
  if (!winner) return null;

  const event: GameEvent = { type: 'game_over', winnerId: winner.id, reason: 'cash_goal' };
  return {
    state: { ...state, phase: 'game_over', winnerId: winner.id },
    events: [...events, event],
  };
}
