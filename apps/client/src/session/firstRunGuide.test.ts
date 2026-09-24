import { describe, expect, it } from 'vitest';
import {
  FIRST_RUN_GUIDE_KEY,
  hasSeenFirstRunGuide,
  markFirstRunGuideSeen,
  shouldAutoOpenFirstRunGuide,
  shouldAutoOpenGuideHere,
} from './firstRunGuide';
import type { StorageLike } from './sessionStorage';

/** 只有 getItem / setItem / removeItem 三件套的最小存储。 */
function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => { values.set(key, value); },
    removeItem: (key: string): void => { values.delete(key); },
    keys: (): string[] => [...values.keys()],
    raw: (key: string): string | undefined => values.get(key),
  };
}

describe('新手引导「已看过」标记（#109）', () => {
  it('没有标记 = 没看过 = 该自动弹一次', () => {
    const storage = memoryStorage();
    expect(hasSeenFirstRunGuide(storage)).toBe(false);
    expect(shouldAutoOpenFirstRunGuide(storage)).toBe(true);
  });

  it('写下标记之后就不再自动弹', () => {
    const storage = memoryStorage();
    markFirstRunGuideSeen(storage);

    expect(storage.raw(FIRST_RUN_GUIDE_KEY)).toBe('1');
    expect(storage.keys()).toEqual([FIRST_RUN_GUIDE_KEY]);
    expect(hasSeenFirstRunGuide(storage)).toBe(true);
    expect(shouldAutoOpenFirstRunGuide(storage)).toBe(false);
  });

  it('只有值严格等于 1 才算看过：坏值宁可再弹一次，也不要把引导永久关掉', () => {
    for (const broken of ['', '0', 'true', 'yes', ' 1', 'seen', '{}']) {
      const storage = memoryStorage({ [FIRST_RUN_GUIDE_KEY]: broken });
      expect(hasSeenFirstRunGuide(storage), `坏值 ${JSON.stringify(broken)}`).toBe(false);
      expect(shouldAutoOpenFirstRunGuide(storage)).toBe(true);
    }
  });

  it('完全拿不到 storage 时视为已看过：每次刷新都弹是最烦人的失败模式', () => {
    expect(hasSeenFirstRunGuide(undefined)).toBe(true);
    expect(shouldAutoOpenFirstRunGuide(undefined)).toBe(false);
    expect(() => markFirstRunGuideSeen(undefined)).not.toThrow();
  });

  it('storage 抛错（无痕 / 禁用本地存储）不让首页崩掉', () => {
    const throwing: StorageLike = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => { throw new Error('SecurityError'); },
    };

    expect(hasSeenFirstRunGuide(throwing)).toBe(true);
    expect(() => markFirstRunGuideSeen(throwing)).not.toThrow();
  });

  it('键名是版本化的：换键会让所有老玩家的「已看过」状态一起重置', () => {
    // 值本身不重要，写死它是为了让「改名」变成一次显式决定，而不是顺手改掉。
    expect(FIRST_RUN_GUIDE_KEY).toBe('richman_first_run_guide_v1');
  });
});

describe('该不该自动弹（#109）', () => {
  it('新手 + 首页 = 弹', () => {
    const storage = memoryStorage();
    expect(shouldAutoOpenGuideHere(storage, 'home', false)).toBe(true);
  });

  it('不在首页一律不弹：老玩家升级到本版时也没有标记，但可能正落在恢复页或对局里', () => {
    const storage = memoryStorage();
    for (const kind of ['restoring', 'lobby', 'game', 'settlement', 'local_setup'] as const) {
      expect(shouldAutoOpenGuideHere(storage, kind, false), kind).toBe(false);
    }
    // 一个盖住棋盘的弹窗，比「没看到引导」糟得多 —— 这条就是为此存在的。
  });

  it('本次会话已经弹过就不再弹（标记写不进存储时也不会每次回首页都弹）', () => {
    const storage = memoryStorage();
    expect(shouldAutoOpenGuideHere(storage, 'home', true)).toBe(false);
  });

  it('看过之后不弹，主动打开过也仍然不弹（标记只在关闭时写）', () => {
    const storage = memoryStorage();
    expect(shouldAutoOpenGuideHere(storage, 'home', false)).toBe(true);
    markFirstRunGuideSeen(storage);
    expect(shouldAutoOpenGuideHere(storage, 'home', false)).toBe(false);
  });
});
