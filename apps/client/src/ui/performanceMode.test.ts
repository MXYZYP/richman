import { describe, expect, it } from 'vitest';
import {
  LOW_END_CORES,
  LOW_END_MEMORY_GB,
  PERF_MODE_KEY,
  applyPerformanceMode,
  detectLowEndDevice,
  installPerformanceMode,
  readDeviceSignals,
  readPerformancePreference,
  resolvePerformanceMode,
  writePerformancePreference,
  type StorageLike,
} from './performanceMode';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function fakeNavigator(overrides: Record<string, unknown>): Navigator {
  return overrides as unknown as Navigator;
}

function fakeRoot(): HTMLElement {
  const element = {
    attributes: new Map<string, string>(),
    setAttribute(key: string, value: string) {
      element.attributes.set(key, value);
    },
    removeAttribute(key: string) {
      element.attributes.delete(key);
    },
    getAttribute(key: string) {
      return element.attributes.get(key) ?? null;
    },
  };
  return element as unknown as HTMLElement;
}

/** 测试环境（node）没有 localStorage，硬摸全局会让「写了读不回」变成假失败 —— 注入一个。 */
function fakeStorage(seed: Record<string, string> = {}): StorageLike {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

describe('performanceMode — 低端机判定', () => {
  it('核数少 / 内存小 / 省流量，各算各的低端', () => {
    expect(detectLowEndDevice({ cores: 2 })).toBe(true);
    expect(detectLowEndDevice({ cores: LOW_END_CORES })).toBe(true);
    expect(detectLowEndDevice({ deviceMemoryGb: 2 })).toBe(true);
    expect(detectLowEndDevice({ deviceMemoryGb: LOW_END_MEMORY_GB })).toBe(true);
    expect(detectLowEndDevice({ saveData: true })).toBe(true);
  });

  it('高配不降级；省流量被显式关掉也不降级', () => {
    expect(detectLowEndDevice({ cores: 8, deviceMemoryGb: 8, saveData: false })).toBe(false);
    expect(detectLowEndDevice({ cores: 12 })).toBe(false);
    expect(detectLowEndDevice({ deviceMemoryGb: 16 })).toBe(false);
  });

  it('★ 一条信号都没有时不降级 —— 宁可不降，也不误降', () => {
    expect(detectLowEndDevice({})).toBe(false);
    expect(readDeviceSignals(undefined)).toEqual({});
  });

  it('0 核 / 0 内存是「没探测到」不是「极低端」，不当低端处理', () => {
    expect(detectLowEndDevice({ cores: 0 })).toBe(false);
    expect(detectLowEndDevice({ deviceMemoryGb: 0 })).toBe(false);
  });

  it('信号只读：navigator 缺字段时字段整体缺失，不补默认值', () => {
    expect(readDeviceSignals(fakeNavigator({}))).toEqual({});
    expect(readDeviceSignals(fakeNavigator({ hardwareConcurrency: 4 }))).toEqual({ cores: 4 });
    expect(readDeviceSignals(fakeNavigator({ deviceMemory: 2 }))).toEqual({ deviceMemoryGb: 2 });
    expect(readDeviceSignals(fakeNavigator({ connection: { saveData: true } }))).toEqual({ saveData: true });
  });
});

describe('performanceMode — 手动开关压过自动判定', () => {
  it('auto 跟随判定，on/off 直接定死', () => {
    expect(resolvePerformanceMode(true, 'auto')).toBe(true);
    expect(resolvePerformanceMode(false, 'auto')).toBe(false);
    // 老旗舰核数少但不卡 —— 玩家手动关掉就是关掉，不再拿设备信号推翻他
    expect(resolvePerformanceMode(true, 'off')).toBe(false);
    // 反过来：机器判定不低端，玩家自己嫌卡也能开
    expect(resolvePerformanceMode(false, 'on')).toBe(true);
  });

  it('偏好读写往返一致，没存过或存了非法值一律按 auto', () => {
    const storage = fakeStorage();
    // 没存过
    expect(readPerformancePreference(storage)).toBe('auto');
    writePerformancePreference('on', storage);
    expect(readPerformancePreference(storage)).toBe('on');
    writePerformancePreference('off', storage);
    expect(readPerformancePreference(storage)).toBe('off');
    // auto 是「清掉偏好」，不是存一个 auto 字符串
    writePerformancePreference('auto', storage);
    expect(readPerformancePreference(storage)).toBe('auto');
    expect(storage.getItem(PERF_MODE_KEY)).toBe(null);
    // 手改过 localStorage / 旧版本留下的脏值
    expect(readPerformancePreference(fakeStorage({ [PERF_MODE_KEY]: 'yes' }))).toBe('auto');
  });

  it('存储整个不可用时（隐私模式）不抛，退回 auto', () => {
    expect(readPerformancePreference(undefined)).toBe('auto');
    expect(() => writePerformancePreference('on', undefined)).not.toThrow();
  });
});

describe('performanceMode — 落到 DOM 上', () => {
  it('开启打 data-perf="low"，关闭把属性摘掉（不是留个空值）', () => {
    const root = fakeRoot();
    applyPerformanceMode(root, true);
    expect(root.getAttribute('data-perf')).toBe('low');
    applyPerformanceMode(root, false);
    expect(root.getAttribute('data-perf')).toBe(null);
  });

  it('root 缺失时不抛（SSR / 测试环境）', () => {
    expect(() => applyPerformanceMode(undefined, true)).not.toThrow();
  });

  it('installPerformanceMode 串起「探测 → 偏好 → 打属性」', () => {
    const root = fakeRoot();
    const enabled = installPerformanceMode({
      navigator: fakeNavigator({ hardwareConcurrency: 2 }),
      root,
      preference: 'auto',
    });
    expect(enabled).toBe(true);
    expect(root.getAttribute('data-perf')).toBe('low');
  });

  it('installPerformanceMode 里 off 偏好能压过「探测到低端」', () => {
    const root = fakeRoot();
    const enabled = installPerformanceMode({
      navigator: fakeNavigator({ hardwareConcurrency: 2 }),
      root,
      preference: 'off',
    });
    expect(enabled).toBe(false);
    expect(root.getAttribute('data-perf')).toBe(null);
  });
});

describe('E5 接线守卫（这是接线、不是渲染验证）', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));

  it('全局样式里必须有 [data-perf=\'low\'] 的降级规则，否则打了属性也没用', () => {
    const css = readFileSync(`${root}src/style.css`, 'utf8');
    expect(css).toContain("[data-perf='low']");
    // 只关动画不够：毛玻璃（backdrop-filter）才是低端机上最贵的一笔合成开销
    expect(css).toContain('backdrop-filter');
    expect(css).toContain('animation-duration');
    expect(css).toContain('transition-duration');
  });

  it('设置弹窗里必须有性能模式开关', () => {
    const vue = readFileSync(`${root}src/components/SettingsDialog.vue`, 'utf8');
    expect(vue).toContain('perf-mode-toggle');
  });

  it('入口必须在挂载前装好，否则首屏会先闪一下完整动画', () => {
    const main = readFileSync(`${root}src/main.ts`, 'utf8');
    expect(main).toContain('installPerformanceMode');
  });
});
