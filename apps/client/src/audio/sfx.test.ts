// 音效模块（P1-4 / #2）回归测试。
// 环境是 node（见根 vitest.config.ts），没有 window/AudioContext，所以这里自带一个最小替身：
// 既能在「有声」场景断言真的发出了正确的音，也能在「静音 / 音频不可用」场景断言完全不碰音频设备。
//
// 两类发声要分别记录：
//   - tones ：振荡器单音（pay / coin / bankrupt / win / lose，以及骰子收尾的停稳闷响）；
//   - noises：走 AudioBufferSourceNode 的噪声源 —— 骰子的滚落摩擦 bed 与九次撞击 knock。
// 噪声由「噪声源 + 带通滤波 + 增益包络」三个节点组成，替身按创建顺序把参数填进同一条记录：
// 创建噪声源时建记录，创建滤波器/增益时补齐参数；一旦开始 createOscillator 就说明进入单音路径，
// 因此借此切断「上一条噪声」的关联，避免单音的包络被误记进噪声。
//
// 骰子的撞击频率与时间都带随机抖动（人耳对等间隔同音高的连击极其敏感），
// 所以凡是要断言精确数值的用例都先把 Math.random 钉成 0.5 —— 此时抖动项恰好为 0、倍率恰好为 1，
// 排期与参数完全可预测；不钉的话只能断言"大约"，反而测不出实现是否走样。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SFX_KEY = 'richman_sfx_enabled';

type ToneRecord = {
  type: string;
  freq: number;
  /** 振荡器频率的排期轨迹；走 `frequency.value` 单点赋值的音为空数组。 */
  freqTrack: number[];
  startedAt: number;
  stoppedAt: number;
};

type NoiseRecord = {
  /** 'bed' = 整段滚落摩擦声；'knock' = 单次撞击脉冲。 */
  kind: 'bed' | 'knock';
  filterType: string;
  /** 撞击的固定中心频率；摩擦声不写这里（走 filterHzTrack）。 */
  filterHz: number;
  /** 滤波器中心频率的排期轨迹：摩擦声先升后降，撞击为空。 */
  filterHzTrack: number[];
  filterQ: number;
  /** 起音斜坡的目标增益与到达时刻；未被记录到则为 0 / -1。 */
  attackTarget: number;
  attackAt: number;
  startedAt: number;
  stoppedAt: number;
};

type ScheduledTimeout = {
  ms: number;
  run: () => void;
};

interface FakeAudioEnvironment {
  tones: ToneRecord[];
  noises: NoiseRecord[];
  rampTargets: number[];
  stored: Map<string, string>;
  timeouts: ScheduledTimeout[];
  contextCount: number;
  resumeCount: number;
  restore(): void;
}

/** 装上最小 window 替身：AudioContext 只记录「创建了什么音」，storage/定时器都是可断言的记录器。 */
function installFakeAudioEnvironment(options: { audioContextThrows?: boolean } = {}): FakeAudioEnvironment {
  const store = new Map<string, string>();
  const tones: ToneRecord[] = [];
  const noises: NoiseRecord[] = [];
  const rampTargets: number[] = [];
  const timeouts: ScheduledTimeout[] = [];
  const env = {
    tones,
    noises,
    rampTargets,
    stored: store,
    timeouts,
    contextCount: 0,
    resumeCount: 0,
  } as FakeAudioEnvironment;
  /** 正在拼装的噪声记录；createOscillator 会把它清空，表示已切换到单音路径。 */
  let pendingNoise: NoiseRecord | null = null;

  class FakeAudioContext {
    readonly state = 'running';
    readonly currentTime = 0;
    readonly sampleRate = 48000;
    readonly destination = {};

    constructor() {
      if (options.audioContextThrows === true) throw new Error('audio device unavailable');
      env.contextCount += 1;
    }

    resume(): void {
      env.resumeCount += 1;
    }

    createBuffer(_channels: number, length: number): unknown {
      return {
        length,
        getChannelData() {
          return new Float32Array(length);
        },
      };
    }

    createBufferSource(): unknown {
      const record: NoiseRecord = {
        kind: 'knock',
        filterType: '',
        filterHz: 0,
        filterHzTrack: [],
        filterQ: 0,
        attackTarget: 0,
        attackAt: -1,
        startedAt: -1,
        stoppedAt: -1,
      };
      noises.push(record);
      pendingNoise = record;
      return {
        buffer: null as unknown,
        connect() {},
        start(at: number) {
          record.startedAt = at;
        },
        stop(at: number) {
          record.stoppedAt = at;
        },
      };
    }

    createBiquadFilter(): unknown {
      const record = pendingNoise;
      return {
        set type(value: string) {
          if (record !== null) record.filterType = value;
        },
        get type() {
          return record === null ? '' : record.filterType;
        },
        frequency: {
          set value(value: number) {
            if (record !== null) record.filterHz = value;
          },
          get value() {
            return record === null ? 0 : record.filterHz;
          },
          // 摩擦 bed 用「排期 + 斜坡」扫频；一旦走到这里就说明这条噪声不是撞击。
          setValueAtTime(value: number) {
            if (record === null) return;
            record.kind = 'bed';
            record.filterHzTrack.push(value);
          },
          linearRampToValueAtTime(value: number) {
            if (record !== null) record.filterHzTrack.push(value);
          },
          exponentialRampToValueAtTime(value: number) {
            if (record !== null) record.filterHzTrack.push(value);
          },
        },
        Q: {
          set value(value: number) {
            if (record !== null) record.filterQ = value;
          },
          get value() {
            return record === null ? 0 : record.filterQ;
          },
        },
        connect() {},
      };
    }

    createOscillator(): unknown {
      pendingNoise = null;
      const record: ToneRecord = { type: 'sine', freq: 0, freqTrack: [], startedAt: -1, stoppedAt: -1 };
      tones.push(record);
      return {
        set type(value: string) {
          record.type = value;
        },
        get type() {
          return record.type;
        },
        frequency: {
          set value(value: number) {
            record.freq = value;
          },
          get value() {
            return record.freq;
          },
          // 停稳闷响会先定频再下滑；单音（tone）只走上面的 value 赋值。
          setValueAtTime(value: number) {
            record.freq = value;
            record.freqTrack.push(value);
          },
          linearRampToValueAtTime(value: number) {
            record.freqTrack.push(value);
          },
          exponentialRampToValueAtTime(value: number) {
            record.freqTrack.push(value);
          },
        },
        connect() {},
        start(at: number) {
          record.startedAt = at;
        },
        stop(at: number) {
          record.stoppedAt = at;
        },
      };
    }

    createGain(): unknown {
      const record = pendingNoise;
      return {
        gain: {
          setValueAtTime() {},
          linearRampToValueAtTime(value: number, at: number) {
            rampTargets.push(value);
            if (record !== null) {
              record.attackTarget = value;
              record.attackAt = at;
            }
          },
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
    setTimeout(run: () => void, ms: number) {
      timeouts.push({ ms, run });
      return timeouts.length;
    },
    clearTimeout() {},
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

/** 按需装载模块：音效开关在**模块加载时**读存储，所以必须先摆好存储再 import。 */
async function loadSfx(stored?: string): Promise<typeof import('./sfx')> {
  if (stored !== undefined) window.localStorage.setItem(SFX_KEY, stored);
  vi.resetModules();
  return await import('./sfx');
}

let env: FakeAudioEnvironment;

/** 骰子三层结构的分层取用：摩擦 bed / 撞击 knock / 停稳闷响。 */
const diceBed = (): NoiseRecord[] => env.noises.filter((noise) => noise.kind === 'bed');
const diceKnocks = (): NoiseRecord[] => env.noises.filter((noise) => noise.kind === 'knock');
/** 停稳闷响是骰子路径下唯一会建振荡器的地方，且都是 <300Hz 的正弦。 */
const diceSettle = (): ToneRecord[] => env.tones.filter((tone) => tone.type === 'sine' && tone.freq < 300);

beforeEach(() => {
  env = installFakeAudioEnvironment();
});

afterEach(() => {
  env.restore();
  vi.restoreAllMocks();
});

describe('音效开关与持久化', () => {
  it('默认开启：存储为空时音效可用', async () => {
    const sfx = await loadSfx();

    expect(sfx.isSfxEnabled()).toBe(true);
    sfx.playSfx('coin');
    expect(env.tones).toHaveLength(1);
  });

  it('写入开关会持久化，重新加载模块后仍然生效', async () => {
    const first = await loadSfx();
    first.setSfxEnabled(false);
    expect(env.stored.get(SFX_KEY)).toBe('0');

    // 同一份存储重新装载模块：静音状态被读回，而不是回落到默认开启。
    const second = await loadSfx();
    expect(second.isSfxEnabled()).toBe(false);
    second.playSfx('dice');
    expect(env.tones).toEqual([]);
    expect(env.noises).toEqual([]);

    second.setSfxEnabled(true);
    expect(env.stored.get(SFX_KEY)).toBe('1');
    const third = await loadSfx();
    expect(third.isSfxEnabled()).toBe(true);
    third.playSfx('dice');
    // 一次掷骰 = 1 段摩擦 + 9 次撞击；停稳闷响走振荡器路径，不计在噪声里。
    expect(diceBed()).toHaveLength(1);
    expect(diceKnocks()).toHaveLength(9);
  });

  it('存储里已经是 0 时模块一加载就是静音', async () => {
    const sfx = await loadSfx('0');

    expect(sfx.isSfxEnabled()).toBe(false);
  });

  it('静音时不创建 AudioContext：不该为了一记音效唤醒音频设备', async () => {
    const sfx = await loadSfx();
    sfx.setSfxEnabled(false);

    sfx.playSfx('dice');
    sfx.playSfx('win');

    expect(env.contextCount).toBe(0);
    expect(env.tones).toEqual([]);
    expect(env.noises).toEqual([]);
    expect(env.timeouts).toEqual([]);
  });
});

describe('音色参数与异常兜底', () => {
  it('每种单音音效发出约定的波形与频率，并复用同一个 AudioContext', async () => {
    const sfx = await loadSfx();

    sfx.playSfx('pay');
    sfx.playSfx('coin');
    sfx.playSfx('bankrupt');

    expect(env.tones.map((tone) => [tone.type, tone.freq])).toEqual([
      ['sawtooth', 220],
      ['triangle', 880],
      ['sawtooth', 140],
    ]);
    // 一记音效 90~260ms 后自然收尾，不能挂着不停。
    expect(env.tones.map((tone) => tone.stoppedAt > tone.startedAt)).toEqual([true, true, true]);
    // 多次播放只建一个上下文（避免每次音效都新开一路音频）。
    expect(env.contextCount).toBe(1);
  });

  it('胜利音是两段式：第二段按延迟排期，触发后才是完整音', async () => {
    const sfx = await loadSfx();

    sfx.playSfx('win');

    expect(env.tones.map((tone) => tone.freq)).toEqual([660]);
    expect(env.timeouts).toHaveLength(1);
    expect(env.timeouts[0]?.ms).toBe(120);

    env.timeouts[0]?.run();
    expect(env.tones.map((tone) => tone.freq)).toEqual([660, 990]);
  });

  it('失败音同样是两段下行', async () => {
    const sfx = await loadSfx();

    sfx.playSfx('lose');
    env.timeouts[0]?.run();

    expect(env.tones.map((tone) => tone.freq)).toEqual([330, 220]);
    expect(env.timeouts[0]?.ms).toBe(140);
  });

  it('构造 AudioContext 失败时静默降级，不把异常抛给对局界面', async () => {
    env.restore();
    env = installFakeAudioEnvironment({ audioContextThrows: true });
    const sfx = await loadSfx();

    expect(() => sfx.playSfx('dice')).not.toThrow();
    expect(env.tones).toEqual([]);
    expect(env.noises).toEqual([]);
  });

  it('未知音效名不产生任何声音（防御未知调用）', async () => {
    const sfx = await loadSfx();

    sfx.playSfx('not-a-real-sfx' as Parameters<typeof sfx.playSfx>[0]);

    expect(env.tones).toEqual([]);
    expect(env.noises).toEqual([]);
    expect(env.timeouts).toEqual([]);
  });
});

// #2：骰子音色由「四次等距点击」换成「真骰子滚落」。真人掷骰的声学结构是三层 ——
// 持续的滚落摩擦、疏密不均的多次磕碰、最后停稳的闷响；三层都仍是白噪声/正弦合成，不引入音频素材。
describe('骰子音色（#2 真骰子滚落）', () => {
  /** 钉死随机抖动，让频率/排期可精确断言（见文件头注释）。 */
  const freezeJitter = (): void => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  };

  it('由三层构成：1 段滚落摩擦 + 9 次撞击 + 2 记停稳闷响', async () => {
    freezeJitter();
    const sfx = await loadSfx();

    sfx.playSfx('dice');

    expect(diceBed()).toHaveLength(1);
    expect(diceKnocks()).toHaveLength(9);
    expect(diceSettle()).toHaveLength(2);
    // 三个层次之外不再有别的噪声源（旧版的方波蜂鸣已彻底移除）。
    expect(env.noises).toHaveLength(10);
  });

  it('每次撞击都是带通白噪声脉冲，中心频率高低交错且互不相同', async () => {
    freezeJitter();
    const sfx = await loadSfx();

    sfx.playSfx('dice');

    const knocks = diceKnocks();
    expect(knocks.map((click) => click.filterType)).toEqual(Array.from({ length: 9 }, () => 'bandpass'));
    // 9 个中心频率两两不同：等音高的连击一听就是电子音。
    expect(knocks.map((click) => click.filterHz)).toEqual([
      980, 1480, 2240, 1260, 2680, 1720, 3120, 1180, 2060,
    ]);
    expect(new Set(knocks.map((click) => click.filterHz)).size).toBe(9);
    expect(knocks.every((click) => click.filterQ > 0)).toBe(true);
  });

  it('撞击间隔逐次拉开（骰子减速）：每两击至少相隔 20ms，越到后面越疏', async () => {
    freezeJitter();
    const sfx = await loadSfx();

    sfx.playSfx('dice');

    const starts = diceKnocks().map((click) => click.startedAt);
    expect(starts).toEqual([0, 0.026, 0.052, 0.084, 0.118, 0.152, 0.196, 0.248, 0.318]);
    const gaps = starts.slice(1).map((start, index) => start - (starts[index] as number));
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(0.02);
    // 最后一击已经明显慢下来，不再像前段那样密集。
    expect(gaps.at(-1) as number).toBeGreaterThan(gaps[0] as number);
    // 整段约 0.5s（滚落 0.4s + 两记停稳闷响收尾），不会拖成一声持续音。
    const soundingEnds = [...env.noises, ...env.tones].map((item) => item.stoppedAt);
    expect(Math.max(...soundingEnds)).toBeLessThan(0.55);
  });

  it('每次撞击都有起音斜坡（这是消除爆音的关键）且增益远低于削波阈值', async () => {
    freezeJitter();
    const sfx = await loadSfx();

    sfx.playSfx('dice');

    for (const click of diceKnocks()) {
      // 起音时刻必须晚于发声起点、且很快到达峰值：既不留阶跃，也不拖慢听感。
      expect(click.attackAt).toBeGreaterThan(click.startedAt);
      expect(click.attackAt - click.startedAt).toBeLessThanOrEqual(0.01);
      // 九击峰值 0.11（音量 0.7 时为 0.077），叠加后也不会碰到 1.0 的削波阈值。
      expect(click.attackTarget).toBeGreaterThan(0);
      expect(click.attackTarget).toBeLessThan(0.2);
      // 每击都必须自然收尾，不能挂着不停。
      expect(click.stoppedAt).toBeGreaterThan(click.startedAt);
    }
  });

  it('滚落摩擦是一整段带通噪声，中心频率先升后降（骰子滚出去又滚回来）', async () => {
    freezeJitter();
    const sfx = await loadSfx();

    sfx.playSfx('dice');

    const bed = diceBed()[0] as NoiseRecord;
    expect(bed.filterType).toBe('bandpass');
    expect(bed.filterHzTrack).toEqual([700, 2400, 900]);
    // 摩擦声是宽频沙沙声，Q 值要比撞击低得多。
    expect(bed.filterQ).toBeLessThan(diceKnocks()[0]?.filterQ as number);
    // 覆盖整段滚落过程（约 400ms），而不是一闪而过。
    expect(bed.stoppedAt - bed.startedAt).toBeCloseTo(0.4, 5);
  });

  it('停稳是两记低频正弦闷响，第二记稍晚跟上', async () => {
    freezeJitter();
    const sfx = await loadSfx();

    sfx.playSfx('dice');

    const settle = diceSettle();
    expect(settle.map((tone) => tone.type)).toEqual(['sine', 'sine']);
    expect(settle.map((tone) => tone.freq)).toEqual([196, 147]);
    expect(settle.every((tone) => tone.freq < 300)).toBe(true);
    expect(settle[1]?.startedAt as number).toBeGreaterThan(settle[0]?.startedAt as number);
    expect(settle.every((tone) => tone.stoppedAt > tone.startedAt)).toBe(true);
  });

  it('连播两次各自排期，不共用同一条记录', async () => {
    freezeJitter();
    const sfx = await loadSfx();

    sfx.playSfx('dice');
    sfx.playSfx('dice');

    expect(diceBed()).toHaveLength(2);
    expect(diceKnocks()).toHaveLength(18);
    expect(env.contextCount).toBe(1);
  });
});

// #13 设置面板扩展：音量与开关是两件事 —— 开关管「响不响」，音量管「多响」，各自独立持久化。
describe('音效音量（#13）', () => {
  const SFX_VOLUME_KEY = 'richman_sfx_volume';
  /** 只取峰值斜坡：收尾用的 0.0001 不随音量变化，混进来会干扰「减半」的对比。 */
  const peaks = (): number[] => env.rampTargets.filter((value) => value > 0.001);

  it('默认音量 0.7；设置后持久化并在重新加载模块后读回', async () => {
    const first = await loadSfx();
    expect(first.getSfxVolume()).toBe(0.7);

    first.setSfxVolume(0.4);
    expect(env.stored.get(SFX_VOLUME_KEY)).toBe('0.4');

    // 同一份存储重新装载模块：音量被读回，而不是回落到默认值。
    const second = await loadSfx();
    expect(second.getSfxVolume()).toBe(0.4);
  });

  it('非法音量被夹回 0~1；存储里的坏值回落到默认', async () => {
    const sfx = await loadSfx();

    sfx.setSfxVolume(5);
    expect(sfx.getSfxVolume()).toBe(1);
    sfx.setSfxVolume(-3);
    expect(sfx.getSfxVolume()).toBe(0);
    sfx.setSfxVolume(Number.NaN);
    expect(sfx.getSfxVolume()).toBe(0.7);

    window.localStorage.setItem(SFX_VOLUME_KEY, 'not-a-number');
    const reloaded = await loadSfx();
    expect(reloaded.getSfxVolume()).toBe(0.7);
  });

  it('音量直接作用在增益上：减半后骰子各层与单音峰值都减半', async () => {
    // 撞击增益带随机抖动，先钉死才能逐值比较（否则两次掷骰的抖动不同，比值不等于 1/2）。
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const sfx = await loadSfx();

    sfx.setSfxVolume(1);
    sfx.playSfx('dice');
    sfx.playSfx('pay');
    // 一次掷骰 = 摩擦 1 + 撞击 9 + 停稳 2，加一记单音。
    const full = peaks();
    expect(full).toHaveLength(13);

    sfx.setSfxVolume(0.5);
    sfx.playSfx('dice');
    sfx.playSfx('pay');
    const half = peaks().slice(full.length);

    expect(half).toHaveLength(13);
    expect(half).toEqual(full.map((value) => value / 2));
  });

  it('音量归零等同静音：不建 AudioContext、不排定时器、完全不发声', async () => {
    const sfx = await loadSfx();
    sfx.setSfxVolume(0);

    sfx.playSfx('dice');
    sfx.playSfx('win');
    sfx.playSfx('pay');

    expect(env.contextCount).toBe(0);
    expect(env.tones).toEqual([]);
    expect(env.noises).toEqual([]);
    expect(env.timeouts).toEqual([]);
  });

  it('音量与开关互不干扰：音量归零不改开关，关掉开关也不改音量', async () => {
    const sfx = await loadSfx();

    sfx.setSfxVolume(0);
    expect(sfx.isSfxEnabled()).toBe(true);

    sfx.setSfxEnabled(false);
    expect(sfx.getSfxVolume()).toBe(0);

    // 重新打开开关后，音量按之前保存的数值生效（0.6），无需重设。
    sfx.setSfxEnabled(true);
    sfx.setSfxVolume(0.6);
    sfx.playSfx('pay');
    expect(env.tones).toHaveLength(1);
    expect(peaks()).toEqual([0.05 * 0.6]);
  });
});
