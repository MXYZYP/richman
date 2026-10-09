// Guards the AI-takeover rules.
//
// These are pure functions on purpose: the client has no component-mount harness, and the
// interesting behaviour is all in the guards (when NOT to fire) — the firing path is one
// `await setTakeover(true)`.
import { describe, expect, it } from 'vitest';

import {
  IDLE_TAKEOVER_MS,
  IDLE_WARNING_MS,
  formatIdleCountdown,
  getIdleTakeoverReason,
  getIdleTakeoverRemainingMs,
  shouldWarnIdleTakeover,
  type IdleTakeoverInput,
} from './idleTakeover';

const NOW = 1_000_000;
const base: IdleTakeoverInput = {
  lastActionAt: NOW,
  now: NOW,
  takeoverOn: false,
  isTheirTurn: true,
  isPlaying: true,
  canAct: true,
};

describe('AI 托管的触发条件', () => {
  it('什么都不挡时判定为 idle', () => {
    expect(getIdleTakeoverReason(base)).toBe('idle');
  });

  it('玩家已手动开启托管时不再计时（开关优先于一切）', () => {
    expect(getIdleTakeoverReason({ ...base, takeoverOn: true })).toBe('manual');
    expect(getIdleTakeoverRemainingMs({ ...base, takeoverOn: true })).toBeNull();
  });

  it('不是我的回合时不开', () => {
    // 关键：轮不到我时静默计时，等轮到我那一刻才从 30 秒重新算，
    // 否则别人思考的 20 秒会被算成我「不操作」。
    expect(getIdleTakeoverReason({ ...base, isTheirTurn: false })).toBe('not-your-turn');
    expect(getIdleTakeoverRemainingMs({ ...base, isTheirTurn: false })).toBeNull();
  });

  it('对局已结束时不开', () => {
    expect(getIdleTakeoverReason({ ...base, isPlaying: false })).toBe('not-playing');
  });

  it('正在动画 / 债务阶段「不能操作」时不算我发呆', () => {
    // 这是最容易误开托管的一格：游戏自己在推进（掷骰动画、债务清偿演出），
    // 此时玩家没有可点的按钮，不该被判定为不操作。
    expect(getIdleTakeoverReason({ ...base, canAct: false })).toBe('cannot-act');
    expect(getIdleTakeoverRemainingMs({ ...base, canAct: false })).toBeNull();
  });
});

describe('空闲倒计时', () => {
  it('刚轮到时是满的 30 秒', () => {
    expect(getIdleTakeoverRemainingMs(base)).toBe(IDLE_TAKEOVER_MS);
  });

  it('过了 10 秒还剩 20', () => {
    expect(getIdleTakeoverRemainingMs({ ...base, now: NOW + 10_000 })).toBe(20_000);
  });

  it('到点归零，且不再为负', () => {
    expect(getIdleTakeoverRemainingMs({ ...base, now: NOW + 30_000 })).toBe(0);
    expect(getIdleTakeoverRemainingMs({ ...base, now: NOW + 99_000 })).toBe(0);
  });

  it('系统时钟往回跳时不产生荒谬的等待', () => {
    // 时钟回拨是真实故障：now < lastActionAt 会算出 >30 秒的剩余，
    // 玩家会看着倒计时卡住。视作「刚刚开始」。
    expect(getIdleTakeoverRemainingMs({ ...base, now: NOW - 5_000 })).toBe(IDLE_TAKEOVER_MS);
    expect(getIdleTakeoverRemainingMs({ ...base, now: Number.NaN })).toBe(IDLE_TAKEOVER_MS);
  });

  it('只在最后 10 秒才警告', () => {
    expect(shouldWarnIdleTakeover({ ...base, now: NOW + 19_000 })).toBe(false);
    expect(shouldWarnIdleTakeover({ ...base, now: NOW + 20_000 })).toBe(true);
    expect(shouldWarnIdleTakeover({ ...base, now: NOW + 29_000 })).toBe(true);
  });

  it('警告阈值就是 10 秒', () => {
    expect(IDLE_WARNING_MS).toBe(10_000);
    expect(IDLE_TAKEOVER_MS).toBe(30_000);
  });

  it('被任何条件挡住时都不警告', () => {
    expect(shouldWarnIdleTakeover({ ...base, takeoverOn: true, now: NOW + 29_000 })).toBe(false);
    expect(shouldWarnIdleTakeover({ ...base, isTheirTurn: false, now: NOW + 29_000 })).toBe(false);
    expect(shouldWarnIdleTakeover({ ...base, canAct: false, now: NOW + 29_000 })).toBe(false);
  });
});

describe('倒计时文案', () => {
  it('不计时的时候是空串（模板里据此隐藏警告条）', () => {
    expect(formatIdleCountdown(null)).toBe('');
  });

  it('向上取整，避免 0 秒时还在闪', () => {
    expect(formatIdleCountdown(30_000)).toBe('30 秒后自动托管');
    expect(formatIdleCountdown(29_100)).toBe('30 秒后自动托管');
    expect(formatIdleCountdown(9_001)).toBe('10 秒后自动托管');
  });

  it('不会显示负数', () => {
    expect(formatIdleCountdown(-500)).toBe('0 秒后自动托管');
  });
});