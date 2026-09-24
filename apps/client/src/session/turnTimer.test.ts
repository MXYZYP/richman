import { describe, expect, it } from 'vitest';
import { TURN_TIME_LIMIT_MAX_SEC } from '@richman/protocol';
import {
  deadlineRatio,
  normalizeTurnDeadline,
  normalizeTurnTimeLimitSec,
  remainingSeconds,
  shouldShowTurnCountdown,
} from './turnTimer';

/**
 * 客户端限时纯函数层（#107）。
 *
 * 这一层的存在意义只有一条：**把服务端可能发来的任何东西翻译成一个「能安全画出来」的形状**。
 * 所以断言的重点全在畸形输入上——线上一旦出现 `limitSec: "30"` 或者
 * 「有 playerId 却没有 deadlineAt」这种自相矛盾的包，宁可退化成「不显示倒计时」，
 * 也绝不能让进度条除以 0 或者画出负数。
 */

describe('turnTimer', () => {
  describe('normalizeTurnTimeLimitSec', () => {
    it('keeps a legitimate whole number of seconds', () => {
      expect(normalizeTurnTimeLimitSec(0)).toBe(0);
      expect(normalizeTurnTimeLimitSec(30)).toBe(30);
      expect(normalizeTurnTimeLimitSec(TURN_TIME_LIMIT_MAX_SEC)).toBe(TURN_TIME_LIMIT_MAX_SEC);
    });

    it('is not fooled by 0 being falsy — 0 means "no limit" and must survive as 0', () => {
      expect(normalizeTurnTimeLimitSec(0)).toBe(0);
    });

    it('falls back to "no limit" for anything malformed or out of range', () => {
      for (const bad of ['30', 30.5, -1, TURN_TIME_LIMIT_MAX_SEC + 1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}, []]) {
        expect(normalizeTurnTimeLimitSec(bad)).toBe(0);
      }
    });
  });

  describe('normalizeTurnDeadline', () => {
    it('passes a well-formed payload through unchanged', () => {
      const info = { playerId: 'p1', deadlineAt: 1_700_000_000_000, limitSec: 60 };
      expect(normalizeTurnDeadline(info)).toEqual(info);
    });

    it('returns null for a non-object payload', () => {
      for (const bad of [null, undefined, 42, 'nope']) {
        expect(normalizeTurnDeadline(bad)).toBeNull();
      }
    });

    it('degrades a self-contradictory payload (playerId without a deadline) to "no countdown"', () => {
      // 少了截止时刻却还指着某个人：画出来就是一根永远不动的条，比不画更糟。
      expect(normalizeTurnDeadline({ playerId: 'p1', deadlineAt: null, limitSec: 60 }))
        .toEqual({ playerId: null, deadlineAt: null, limitSec: 60 });
      expect(normalizeTurnDeadline({ playerId: null, deadlineAt: 1_700_000_000_000, limitSec: 60 }))
        .toEqual({ playerId: null, deadlineAt: null, limitSec: 60 });
    });

    it('drops a non-finite deadlineAt instead of trusting it', () => {
      expect(normalizeTurnDeadline({ playerId: 'p1', deadlineAt: Number.NaN, limitSec: 60 }))
        .toEqual({ playerId: null, deadlineAt: null, limitSec: 60 });
      expect(normalizeTurnDeadline({ playerId: 'p1', deadlineAt: Number.POSITIVE_INFINITY, limitSec: 60 }))
        .toEqual({ playerId: null, deadlineAt: null, limitSec: 60 });
    });

    it('keeps the limit even when the clock is idle, so the lobby can still show the choice', () => {
      expect(normalizeTurnDeadline({ playerId: null, deadlineAt: null, limitSec: 120 }))
        .toEqual({ playerId: null, deadlineAt: null, limitSec: 120 });
    });
  });

  describe('remainingSeconds', () => {
    it('rounds up so the reading never looks like it is jumping around', () => {
      expect(remainingSeconds(1_000_000 + 12_000, 1_000_000)).toBe(12);
      expect(remainingSeconds(1_000_000 + 11_400, 1_000_000)).toBe(12);
      expect(remainingSeconds(1_000_000 + 11_000, 1_000_000)).toBe(11);
    });

    it('never goes negative once the deadline has passed', () => {
      expect(remainingSeconds(1_000_000, 1_000_000)).toBe(0);
      expect(remainingSeconds(1_000_000, 1_000_000 + 5_000)).toBe(0);
    });

    it('returns 0 when there is no deadline at all', () => {
      expect(remainingSeconds(null, 1_000_000)).toBe(0);
    });
  });

  describe('deadlineRatio', () => {
    it('spans 1 → 0 across the turn', () => {
      expect(deadlineRatio(1_000_000 + 30_000, 30, 1_000_000)).toBe(1);
      expect(deadlineRatio(1_000_000 + 15_000, 30, 1_000_000)).toBe(0.5);
      expect(deadlineRatio(1_000_000, 30, 1_000_000)).toBe(0);
    });

    it('clamps a deadline further out than the stated limit (clock skew between hosts)', () => {
      expect(deadlineRatio(1_000_000 + 90_000, 30, 1_000_000)).toBe(1);
    });

    it('returns 0 rather than dividing by zero when the limit is unknown', () => {
      expect(deadlineRatio(1_000_000 + 15_000, 0, 1_000_000)).toBe(0);
      expect(deadlineRatio(null, 30, 1_000_000)).toBe(0);
    });
  });

  describe('shouldShowTurnCountdown', () => {
    const info = { playerId: 'p1', deadlineAt: 1_700_000_000_000, limitSec: 30 };

    it('shows only to the player whose turn it is', () => {
      expect(shouldShowTurnCountdown(info, 'p1')).toBe(true);
      // 给别人画一根「你的回合快到了」比不画更让人困惑，观众尤其不该看到它。
      expect(shouldShowTurnCountdown(info, 'p2')).toBe(false);
      expect(shouldShowTurnCountdown(info, null)).toBe(false);
    });

    it('hides itself when there is no clock running', () => {
      expect(shouldShowTurnCountdown(null, 'p1')).toBe(false);
      expect(shouldShowTurnCountdown({ playerId: null, deadlineAt: null, limitSec: 30 }, 'p1')).toBe(false);
    });
  });
});
