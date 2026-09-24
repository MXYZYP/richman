// 背景音乐模块（P1-4 BGM）回归测试。
// 与音效不同：BGM 默认**关闭**（不打扰），并依赖「首次用户手势」才能起播（浏览器自动播放策略）。
// 这两条语义都靠模块级状态与事件监听实现，所以每条用例都重新装载模块 + 自带最小 window 替身。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BGM_KEY = 'richman_bgm_enabled';
const BGM_VOLUME_KEY = 'richman_bgm_volume';
const STEP_MS = 380;
const MELODY_HEAD = [261.63, 329.63, 392.0, 329.63];

type IntervalRecord = {
  ms: number;
  run: () => void;
  cleared: boolean;
};

interface FakeAudioEnvironment {
  freqs: number[];
  /** 每次指数斜坡的目标增益（含收尾用的 0.0001），用于断言音量真的作用在增益上。 */
  rampTargets: number[];
  stored: Map<string, string>;
  intervals: IntervalRecord[];
  listeners: Map<string, Array<(event: unknown) => void>>;
  contextCount: number;
  restore(): void;
}

function installFakeAudioEnvironment(): FakeAudioEnvironment {
  const store = new Map<string, string>();
  const freqs: number[] = [];
  const rampTargets: number[] = [];
  const intervals: IntervalRecord[] = [];
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const env = {
    freqs,
    rampTargets,
    stored: store,
    intervals,
    listeners,
    contextCount: 0,
  } as FakeAudioEnvironment;

  class FakeAudioContext {
    readonly state = 'running';
    readonly currentTime = 0;
    readonly destination = {};

    constructor() {
      env.contextCount += 1;
    }

    resume(): void {}

    createOscillator(): unknown {
      let freq = 0;
      return {
        type: 'sine',
        frequency: {
          set value(value: number) {
            freq = value;
          },
          get value() {
            return freq;
          },
        },
        connect() {},
        start() {
          freqs.push(freq);
        },
        stop() {},
      };
    }

    createGain(): unknown {
      return {
        gain: {
          setValueAtTime() {},
          exponentialRampToValueAtTime(value: number) {
            rampTargets.push(value);
          },
        },
        connect() {},
      };
    }
  }

  const fakeWindow = {
    AudioContext: FakeAudioContext,
    localStorage: {
      getItem(key: string) {
        return store.has(key) ? (store.get(key) as string) : null;
      },
      setItem(key: string, value: string) {
        store.set(key, String(value));
      },
    },
    setInterval(run: () => void, ms: number) {
      intervals.push({ ms, run, cleared: false });
      return intervals.length;
    },
    clearInterval(handle: number) {
      const record = intervals[handle - 1];
      if (record !== undefined) record.cleared = true;
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      const bucket = listeners.get(type) ?? [];
      bucket.push(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type: string, listener: (event: unknown) => void) {
      const bucket = listeners.get(type) ?? [];
      listeners.set(type, bucket.filter((candidate) => candidate !== listener));
    },
  };

  const globalRef = globalThis as unknown as Record<string, unknown>;
  const previousWindow = globalRef.window;
  globalRef.window = fakeWindow;
  env.restore = () => {
    if (previousWindow === undefined) delete globalRef.window;
    else globalRef.window = previousWindow;
  };
  return env;
}

/** 按需装载模块：`enabled` 在模块加载时读存储，所以必须先把存储摆好。 */
async function loadBgm(stored?: string): Promise<typeof import('./bgm')> {
  if (stored !== undefined) window.localStorage.setItem(BGM_KEY, stored);
  vi.resetModules();
  return await import('./bgm');
}

const activeIntervals = (): IntervalRecord[] => env.intervals.filter((record) => !record.cleared);
const dispatch = (type: string): void => {
  for (const listener of [...(env.listeners.get(type) ?? [])]) listener({ type });
};
const listenerCount = (type: string): number => (env.listeners.get(type) ?? []).length;

let env: FakeAudioEnvironment;

beforeEach(() => {
  env = installFakeAudioEnvironment();
});

afterEach(() => {
  env.restore();
  vi.restoreAllMocks();
});

describe('BGM 默认与持久化', () => {
  it('默认关闭：存储为空时不自动放音乐', async () => {
    const bgm = await loadBgm();

    expect(bgm.isBgmEnabled()).toBe(false);
    expect(env.intervals).toEqual([]);
    expect(env.freqs).toEqual([]);
  });

  it('开关会持久化：开启后重新加载模块即为开启态', async () => {
    const first = await loadBgm();
    first.setBgmEnabled(true);
    expect(env.stored.get(BGM_KEY)).toBe('1');

    const second = await loadBgm();
    expect(second.isBgmEnabled()).toBe(true);
  });
});

// #13 设置面板扩展：音量与开关是两件事（开关管响不响、音量管多响），各自独立持久化。
describe('BGM 音量（#13）', () => {
  const peaks = (): number[] => env.rampTargets.filter((value) => value > 0.001);

  it('默认音量 0.7，设置后持久化并在重新加载模块后读回', async () => {
    const first = await loadBgm();
    expect(first.getBgmVolume()).toBe(0.7);

    first.setBgmVolume(0.4);
    expect(env.stored.get(BGM_VOLUME_KEY)).toBe('0.4');

    const second = await loadBgm();
    expect(second.getBgmVolume()).toBe(0.4);
  });

  it('非法音量被夹回 0~1；存储里的坏值回落到默认', async () => {
    const bgm = await loadBgm();
    expect(bgm.getBgmVolume()).toBe(0.7);

    bgm.setBgmVolume(5);
    expect(bgm.getBgmVolume()).toBe(1);
    bgm.setBgmVolume(-3);
    expect(bgm.getBgmVolume()).toBe(0);
    bgm.setBgmVolume(Number.NaN);
    expect(bgm.getBgmVolume()).toBe(0.7);

    window.localStorage.setItem(BGM_VOLUME_KEY, 'not-a-number');
    const reloaded = await loadBgm();
    expect(reloaded.getBgmVolume()).toBe(0.7);
  });

  it('音量直接作用在音符峰值增益上，改动在下一个音符生效', async () => {
    const bgm = await loadBgm();
    bgm.setBgmVolume(1);
    bgm.setBgmEnabled(true);

    expect(peaks()).toHaveLength(1);
    const full = peaks()[0] as number;

    bgm.setBgmVolume(0.5);
    // 已经排期的音符不动（避免正在响的音突然变调），下一个音符才按新音量发声。
    expect(peaks()).toHaveLength(1);
    activeIntervals()[0]?.run();
    expect(peaks()).toHaveLength(2);
    expect(peaks()[1]).toBeCloseTo(full / 2, 10);
  });

  it('音量归零等同静音：不再排期发声，但开关与计时器状态不被音量悄悄改掉', async () => {
    const bgm = await loadBgm();
    bgm.setBgmVolume(0);
    bgm.setBgmEnabled(true);

    expect(bgm.isBgmEnabled()).toBe(true);
    expect(activeIntervals()).toHaveLength(1);
    expect(env.freqs).toEqual([]);
    expect(peaks()).toEqual([]);

    // 调回可听音量后立刻恢复发声，无需重新开关。
    bgm.setBgmVolume(0.7);
    activeIntervals()[0]?.run();
    expect(env.freqs).toHaveLength(1);
    expect(peaks()).toHaveLength(1);
  });
});

describe('播放生命周期', () => {
  it('开启立即起播：先出一声，再按固定步长循环', async () => {
    const bgm = await loadBgm();

    bgm.setBgmEnabled(true);

    expect(env.freqs).toEqual([MELODY_HEAD[0]]);
    expect(activeIntervals()).toHaveLength(1);
    expect(activeIntervals()[0]?.ms).toBe(STEP_MS);

    // 手动推进 3 步：旋律按谱依次前进，而不是停在同一个音上。
    for (let index = 0; index < 3; index += 1) activeIntervals()[0]?.run();
    expect(env.freqs).toEqual([...MELODY_HEAD]);
  });

  it('旋律循环：走完一轮后回到第一个音，不会越界静音', async () => {
    const bgm = await loadBgm();
    bgm.setBgmEnabled(true);

    for (let index = 0; index < 16; index += 1) activeIntervals()[0]?.run();

    expect(env.freqs).toHaveLength(17);
    expect(env.freqs[16]).toBe(MELODY_HEAD[0]);
    expect(env.freqs.every((freq) => Number.isFinite(freq) && freq > 0)).toBe(true);
  });

  it('重复开启不会叠加出第二路计时器；关闭会真正清掉计时器', async () => {
    const bgm = await loadBgm();
    bgm.setBgmEnabled(true);
    const started = activeIntervals().length;

    // 幂等：再开一次不该再多一路循环（否则关掉开关仍会有一路在响）。
    bgm.startBgm();
    expect(activeIntervals()).toHaveLength(started);
    expect(started).toBe(1);

    bgm.setBgmEnabled(false);
    expect(activeIntervals()).toEqual([]);
    expect(env.stored.get(BGM_KEY)).toBe('0');

    // 关闭后没有任何活跃计时器：把「还活着的」全推一遍也不会再出声。
    const playedBefore = env.freqs.length;
    const stillActive = activeIntervals();
    for (const record of stillActive) record.run();
    expect(stillActive).toEqual([]);
    expect(env.freqs).toHaveLength(playedBefore);
  });
});

describe('首次用户手势续播', () => {
  it('未开启时不布防：不给页面挂多余监听', async () => {
    const bgm = await loadBgm();

    bgm.armBgmAutoStart();

    expect(listenerCount('pointerdown')).toBe(0);
    expect(listenerCount('keydown')).toBe(0);
  });

  it('上次开启过则布防，首个手势起播并撤掉监听', async () => {
    const bgm = await loadBgm('1');

    bgm.armBgmAutoStart();

    expect(listenerCount('pointerdown')).toBe(1);
    expect(listenerCount('keydown')).toBe(1);
    // 布防本身不该起播：自动播放策略下没有手势的 AudioContext 是无效的。
    expect(env.intervals).toEqual([]);

    dispatch('pointerdown');

    expect(activeIntervals()).toHaveLength(1);
    expect(env.freqs).toHaveLength(1);
    expect(listenerCount('pointerdown')).toBe(0);
    expect(listenerCount('keydown')).toBe(0);
  });

  it('重复布防只挂一次监听，键盘手势同样能起播', async () => {
    const bgm = await loadBgm('1');

    bgm.armBgmAutoStart();
    bgm.armBgmAutoStart();
    expect(listenerCount('pointerdown')).toBe(1);

    dispatch('keydown');

    expect(activeIntervals()).toHaveLength(1);
    expect(listenerCount('pointerdown')).toBe(0);
    expect(listenerCount('keydown')).toBe(0);
  });
});
