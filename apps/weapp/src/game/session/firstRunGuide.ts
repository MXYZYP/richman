import type { AppPage } from './appFlow';
import type { StorageLike } from './sessionStorage';

/**
 * 新手引导的「已看过」标记（路线图 #109）。
 *
 * 纯逻辑 + 显式传入 storage，便于单测；UI 只负责在打开/关闭时调这里。
 */
export const FIRST_RUN_GUIDE_KEY = 'richman_first_run_guide_v1';

/**
 * 是否**不该**再自动弹出引导。
 *
 * 三条都是刻意的：
 *  1. 标记写了「1」才算看过（而不是「键存在就算」）—— 值被写坏时宁可再弹一次，
 *     也不要让一个坏值把引导永久关掉（新玩家再也找不到说明）。
 *  2. **读不到值**（键不存在）= 没看过 = 该弹。
 *  3. **完全拿不到 storage**（SSR / 无痕模式 / 隐私设置禁用）= 视为「已看过」。
 *     因为我们无法记住这次的选择，而每次刷新都弹一遍是这套机制里最烦人的失败模式。
 *     代价只是这些环境里的新玩家要自己点一下首页的「玩法说明」。
 */
export function hasSeenFirstRunGuide(storage: StorageLike | undefined): boolean {
  if (storage === undefined) return true;
  try {
    return storage.getItem(FIRST_RUN_GUIDE_KEY) === '1';
  } catch {
    return true;
  }
}

/** 记下「已看过」。写不进去也不算失败：最多下次再弹一遍。 */
export function markFirstRunGuideSeen(storage: StorageLike | undefined): void {
  if (storage === undefined) return;
  try {
    storage.setItem(FIRST_RUN_GUIDE_KEY, '1');
  } catch {
    /* 存不下就存不下 —— 引导本身仍然可用，只是下次还会自动弹。 */
  }
}

/** 首页「玩法说明」入口：主动打开不算「第一次」，因此不改标记，只负责把它弹出来。 */
export function shouldAutoOpenFirstRunGuide(storage: StorageLike | undefined): boolean {
  return !hasSeenFirstRunGuide(storage);
}

/**
 * 「此刻该不该自动弹」。三个条件缺一不可：
 *  1. **在首页** —— 引导是给第一次进来的人看的，而本版之前的老玩家同样没有「已看过」
 *     标记，却可能正落在恢复页或对局里；一进来就盖住棋盘的弹窗，比「没看到引导」糟得多。
 *  2. **没看过**；
 *  3. **本次会话还没弹过** —— 标记写不进存储时（配额已满 / 无痕）也不会每次回首页都弹。
 *
 * 抽成纯函数是为了能真的验证第 1 条：App.vue 本身没法在测试里渲染（模块顶层就建 socket），
 * 判定逻辑留在那里就等于没测。
 */
export function shouldAutoOpenGuideHere(
  storage: StorageLike | undefined,
  pageKind: AppPage['kind'],
  sessionAlreadyAutoOpened: boolean,
): boolean {
  if (sessionAlreadyAutoOpened) return false;
  if (pageKind !== 'home') return false;
  return shouldAutoOpenFirstRunGuide(storage);
}
