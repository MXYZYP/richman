import { CHAT_TEXT_MAX_LENGTH } from '@richman/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  QUICK_PHRASE_SEND_INTERVAL_MS,
  QUICK_PHRASES,
  createQuickPhraseGate,
  isSendableQuickPhrase,
} from './quickPhrases';

describe('快捷短语清单（#109）', () => {
  it('每条都能直接作为聊天内容发出去', () => {
    expect(QUICK_PHRASES.length).toBeGreaterThanOrEqual(4);
    for (const phrase of QUICK_PHRASES) {
      expect(isSendableQuickPhrase(phrase)).toBe(true);
      // 首尾空白会被服务端 trim 掉再广播：留着只是让按钮和气泡看起来不一致。
      expect(phrase).toBe(phrase.trim());
      // 换行会把聊天气泡的排版撑开，短语里不该有。
      expect(phrase).not.toMatch(/\s/);
    }
  });

  it('够短，窄面板里一排放得下', () => {
    for (const phrase of QUICK_PHRASES) expect([...phrase].length).toBeLessThanOrEqual(8);
  });

  it('没有重复项', () => {
    expect(new Set(QUICK_PHRASES).size).toBe(QUICK_PHRASES.length);
  });

  it('本地冷却与服务端的丢消息窗口对齐（700ms）', () => {
    // 服务端 `roomSocketAdapter.ts` 的 CHAT_MIN_INTERVAL_MS 就是 700：两边不一致的话，
    // 要么白等（本地更长），要么又变回「悄悄丢消息」（本地更短）。
    // 这个数字是刻意的锚点，改任何一边都必须同时改另一边。
    expect(QUICK_PHRASE_SEND_INTERVAL_MS).toBe(700);
  });
});

describe('isSendableQuickPhrase', () => {
  it('空白与超长一律不发', () => {
    expect(isSendableQuickPhrase('')).toBe(false);
    expect(isSendableQuickPhrase('   ')).toBe(false);
    expect(isSendableQuickPhrase('轮到我啦')).toBe(true);
    expect(isSendableQuickPhrase('a'.repeat(CHAT_TEXT_MAX_LENGTH))).toBe(true);
    expect(isSendableQuickPhrase('a'.repeat(CHAT_TEXT_MAX_LENGTH + 1))).toBe(false);
  });
});

/**
 * 手动可控的定时器：把回调扣在手里，由测试决定什么时候「到期」。
 *
 * 句柄类型必须跟着项目里 `setTimeout` 的**真实**返回类型走（这里装了 @types/node，
 * 于是是 `Timeout` 而不是浏览器里的 `number`）。所以对外给的是不透明令牌，
 * 内部仍用自增 id 记账 —— 测试真正要断言的只是「第几个定时器被取消了」。
 */
function fakeTimers() {
  const pending = new Map<number, () => void>();
  const delays: number[] = [];
  const cancelled: number[] = [];
  let nextId = 1;
  const tokenOf = (id: number): ReturnType<typeof setTimeout> => (
    { id } as unknown as ReturnType<typeof setTimeout>
  );
  const idOf = (handle: ReturnType<typeof setTimeout>): number => (handle as unknown as { id: number }).id;
  return {
    delays,
    cancelled,
    schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
      const id = nextId;
      nextId += 1;
      pending.set(id, callback);
      delays.push(delayMs);
      return tokenOf(id);
    },
    cancel(handle: ReturnType<typeof setTimeout>): void {
      const id = idOf(handle);
      cancelled.push(id);
      pending.delete(id);
    },
    pendingCount: (): number => pending.size,
    /** 触发所有仍挂着的回调（已被 cancel 的不会响）。 */
    fire(): void {
      const queued = [...pending.values()];
      pending.clear();
      for (const callback of queued) callback();
    },
  };
}

describe('快捷短语闸门（#109）', () => {
  it('放行第一条，冷却期内一律拦下，到期后恢复', () => {
    const timers = fakeTimers();
    let releases = 0;
    const gate = createQuickPhraseGate(() => { releases += 1; }, timers.schedule, timers.cancel);

    expect(gate.isCooling()).toBe(false);
    expect(gate.trySend()).toBe(true);
    expect(timers.delays).toEqual([QUICK_PHRASE_SEND_INTERVAL_MS]);
    expect(gate.isCooling()).toBe(true);

    // 连点两下：第二下必须被本地拦住，否则它会撞上服务端的静默丢弃。
    expect(gate.trySend()).toBe(false);
    expect(gate.trySend()).toBe(false);
    expect(timers.delays).toHaveLength(1);
    expect(releases).toBe(0);

    timers.fire();
    expect(gate.isCooling()).toBe(false);
    expect(releases).toBe(1);
    expect(gate.trySend()).toBe(true);
  });

  it('被拦下时不重新计时（连点不会把冷却越推越远）', () => {
    const timers = fakeTimers();
    const gate = createQuickPhraseGate(() => {}, timers.schedule, timers.cancel);

    gate.trySend();
    gate.trySend();
    gate.trySend();

    expect(timers.delays).toEqual([QUICK_PHRASE_SEND_INTERVAL_MS]);
    expect(timers.cancelled).toEqual([]);
  });

  it('dispose 撤掉挂起的定时器，此后不再回调', () => {
    const timers = fakeTimers();
    let releases = 0;
    const gate = createQuickPhraseGate(() => { releases += 1; }, timers.schedule, timers.cancel);

    gate.trySend();
    gate.dispose();

    expect(timers.cancelled).toEqual([1]);
    expect(timers.pendingCount()).toBe(0);
    expect(gate.isCooling()).toBe(false);
    timers.fire();
    expect(releases).toBe(0);
  });

  it('没发出去过的冷却不需要 dispose（空手 dispose 不炸）', () => {
    const timers = fakeTimers();
    const gate = createQuickPhraseGate(() => {}, timers.schedule, timers.cancel);
    gate.dispose();
    expect(timers.cancelled).toEqual([]);
  });

  it('默认计时器就是真的 setTimeout：700ms 前一毫秒都还关着', () => {
    vi.useFakeTimers();
    try {
      let released = 0;
      const gate = createQuickPhraseGate(() => { released += 1; });

      expect(gate.trySend()).toBe(true);
      expect(gate.isCooling()).toBe(true);
      vi.advanceTimersByTime(QUICK_PHRASE_SEND_INTERVAL_MS - 1);
      expect(gate.isCooling()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(gate.isCooling()).toBe(false);
      expect(released).toBe(1);
      gate.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
});
