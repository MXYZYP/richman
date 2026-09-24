/**
 * 滑动窗口限流器（路线图 #15 / #108 / #116）。
 *
 * 这套逻辑原本在 `roomSocketAdapter` 里以「两个 `Map<string, number[]>` + 四行过滤」
 * 的形式内联了两次（建房、房间列表）。排行榜接口需要第三份，于是把它抽出来：
 * 同一个语义只实现一次，阈值与窗口各自给，行为不再靠「抄得对不对」保持一致。
 *
 * 语义（与内联版本逐字一致，改动会同时影响建房与列表，务必跑 socketRooms 用例）：
 *  - 只保留窗口内的尝试记录，窗口外的自动丢弃；
 *  - 窗口内已达上限 → **拒绝，且本次不计入**（否则连续猛刷会把窗口一直顶住，
 *    形成「越刷越封」的效果，与「限速」的本意相反）；
 *  - 未达上限 → 记一次并放行。
 *
 * 时钟从外部注入（默认 `Date.now`）：「窗口滑过 60s」在测试里必须是一个确定事件，
 * 去 mock 全局 `Date.now` 会连带影响同进程的其它组件（历史上就这么把用例挂死在等 ack 上）。
 */

export interface RateLimitRule {
  /** 滑动窗口长度（毫秒）。 */
  readonly windowMs: number;
  /** 窗口内允许的最大次数。 */
  readonly maxPerWindow: number;
}

export interface SlidingWindowRateLimiter {
  /** 记一次尝试：`true` = 放行，`false` = 超过阈值（本次不计入）。 */
  allow(key: string): boolean;
  /** 当前仍在计数的键数量，供测试断言「表不会无限增长」。 */
  size(): number;
  /** 清空全部记录。 */
  reset(): void;
}

export function createSlidingWindowRateLimiter(
  rule: RateLimitRule,
  now: () => number = Date.now,
): SlidingWindowRateLimiter {
  const windowMs = Math.max(1, rule.windowMs);
  const maxPerWindow = Math.max(1, rule.maxPerWindow);
  const attempts = new Map<string, number[]>();

  return {
    allow(key) {
      const attemptedAt = now();
      const recent = (attempts.get(key) ?? []).filter((timestamp) => attemptedAt - timestamp < windowMs);
      if (recent.length >= maxPerWindow) {
        // 刻意**不写回**：被拒的这一笔不占用窗口配额，见文件头注释。
        return false;
      }
      recent.push(attemptedAt);
      attempts.set(key, recent);
      return true;
    },

    size() {
      return attempts.size;
    },

    reset() {
      attempts.clear();
    },
  };
}
