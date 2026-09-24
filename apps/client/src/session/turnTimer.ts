import { TURN_TIME_LIMIT_MAX_SEC } from '@richman/protocol';
import type { TurnDeadlineInfo } from '@richman/protocol';

/**
 * 每回合限时（#107）的客户端纯函数层：只做「把服务端给的两个数字翻译成 UI 要的形状」，
 * 不碰 socket、不碰计时器、不碰 Vue —— 因此可以独立单测，也不会在渲染里算错。
 *
 * 一条硬约定：**客户端永不自己决定「超时了」**。到点后由服务端按电脑策略代走一步并广播，
 * 客户端只负责把剩下的秒数画出来。本地自作主张地判超时会造成两个后果：
 *  - 网络一抖动（包晚到 300ms）就会先于服务端喊「超时」，随后又被真实事件打脸；
 *  - 不同客户端的本地时钟本来就不一致，谁都不该拿它当权威。
 */

/** 服务端给的限时秒数兜底：畸形值一律按「不限时」处理（与房主看到的设置保持一致）。 */
export function normalizeTurnTimeLimitSec(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return 0;
  return value >= 0 && value <= TURN_TIME_LIMIT_MAX_SEC ? value : 0;
}

/** 服务端给的截止信息兜底：只保留形状正确的那几项，缺一项就当作「此刻没有倒计时」。 */
export function normalizeTurnDeadline(value: unknown): TurnDeadlineInfo | null {
  if (value === null || typeof value !== 'object') return null;
  const info = value as Partial<TurnDeadlineInfo>;
  const limitSec = normalizeTurnTimeLimitSec(info.limitSec);
  const playerId = typeof info.playerId === 'string' ? info.playerId : null;
  const deadlineAt = typeof info.deadlineAt === 'number' && Number.isFinite(info.deadlineAt)
    ? info.deadlineAt
    : null;
  // 「有 playerId 却没有截止时刻」是自相矛盾的形状，宁可当成没有倒计时，也不要画一根永远不动的条。
  if (playerId === null || deadlineAt === null) return { playerId: null, deadlineAt: null, limitSec };
  return { playerId, deadlineAt, limitSec };
}

/** 剩余秒数（向上取整并夹到 ≥ 0）：显示成「12」而不是「11.4」，避免读数看起来在乱跳。 */
export function remainingSeconds(deadlineAt: number | null, now: number): number {
  if (deadlineAt === null || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.ceil((deadlineAt - now) / 1000));
}

/**
 * 剩余比例 1..0（1 = 刚轮到、0 = 到点），给进度条用。
 * `limitSec <= 0` 或没有截止时刻时返回 0 —— 调用方据此判断「不该画」。
 */
export function deadlineRatio(deadlineAt: number | null, limitSec: number, now: number): number {
  if (deadlineAt === null || limitSec <= 0 || !Number.isFinite(now)) return 0;
  const total = limitSec * 1000;
  const left = deadlineAt - now;
  if (left <= 0) return 0;
  if (left >= total) return 1;
  return left / total;
}

/**
 * 该不该把倒计时显示给这位玩家。
 *
 * `localPlayerId` 为 `null`（尚未确定身份）时不显示：宁可不显示，也不要给观众或不相关的人
 * 画一根「你的回合快到了」的条——那比没有更让人困惑。
 */
export function shouldShowTurnCountdown(
  info: TurnDeadlineInfo | null,
  localPlayerId: string | null,
): boolean {
  if (info === null || info.playerId === null || info.deadlineAt === null) return false;
  if (localPlayerId === null) return false;
  return info.playerId === localPlayerId;
}
