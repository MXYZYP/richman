import { describe, expect, it } from 'vitest';
import { getActiveMapPack, listActiveMaps } from '../production';
import { PRODUCTION_CATALOG } from '../mapCatalog';
import {
  DEFAULT_MAP_ID,
  getActiveMapPack as lazyGetActiveMapPack,
  getMapPack as lazyGetMapPack,
  isProductionMapsLoaded,
  listActiveMaps as lazyListActiveMaps,
  loadProductionMapPacks,
} from '../lazy';

/**
 * 两份实现（主入口 / 客户端懒加载入口）的一致性守卫。
 *
 * 为什么必须盯：`mapCatalog.ts` 是**生成物**，地图改了（标题、描述、contentHash）
 * 却忘了重新生成，首页显示的就是过期的目录信息，而这类错误在 UI 上几乎看不出来。
 */
describe('PRODUCTION_CATALOG 与真实地图包一致', () => {
  it('条目数量与顺序都与生产注册表相同', () => {
    expect(PRODUCTION_CATALOG).toHaveLength(listActiveMaps().length);
    expect(PRODUCTION_CATALOG.map((entry) => entry.ref.id))
      .toEqual(listActiveMaps().map((entry) => entry.ref.id));
  });

  it('逐字段一致：ref / title / description', () => {
    const real = listActiveMaps();
    expect(PRODUCTION_CATALOG).toEqual(real.map((entry) => ({
      ref: entry.ref,
      title: entry.title,
      description: entry.description,
    })));
  });

  it('contentHash 与真实地图包相同（改了棋盘没重新生成目录会被这条抓住）', () => {
    for (const entry of PRODUCTION_CATALOG) {
      const pack = getActiveMapPack(entry.ref.id);
      expect(pack.ref.contentHash).toBe(entry.ref.contentHash);
      expect(pack.metadata.title).toBe(entry.title);
    }
  });
});

describe('懒加载入口', () => {
  it('listActiveMaps 不触发任何地图包加载（首屏靠它）', () => {
    expect(lazyListActiveMaps()).toEqual(PRODUCTION_CATALOG);
  });

  it('默认地图随首屏可用（默认开局表单与演示棋盘都在加载期就要用）', () => {
    expect(DEFAULT_MAP_ID).toBe(PRODUCTION_CATALOG[0]!.ref.id);
    expect(lazyGetActiveMapPack(DEFAULT_MAP_ID).ref.id).toBe(DEFAULT_MAP_ID);
    expect(lazyGetMapPack(PRODUCTION_CATALOG[0]!.ref).ref.id).toBe(DEFAULT_MAP_ID);
  });

  it('未加载时取非默认地图会抛出指名道姓的错误，而不是静默返回 undefined', () => {
    // 这条是给「忘了 await loadProductionMapPacks()」兜底的：静默失败会变成
    // 「棋盘空白但没有报错」这种最难查的故障。
    expect(isProductionMapsLoaded()).toBe(false);
    expect(() => lazyGetActiveMapPack('yuncheng-tour')).toThrow(/loadProductionMapPacks/);
  });

  it('未知地图报的是「没有这张图」，不会被误诊成「忘了加载」', async () => {
    await loadProductionMapPacks();
    // 已全部加载之后再要一张不存在的图：错误必须是「未知 id」，
    // 否则真正的地图缺失会被一律归因为加载时序，越查越偏。
    expect(() => lazyGetActiveMapPack('no-such-map')).toThrow(/Inactive map id/);
  });

  it('加载后与主入口给出完全相同的地图包', async () => {
    await loadProductionMapPacks();

    expect(isProductionMapsLoaded()).toBe(true);
    for (const entry of PRODUCTION_CATALOG) {
      expect(lazyGetActiveMapPack(entry.ref.id)).toEqual(getActiveMapPack(entry.ref.id));
      expect(lazyGetMapPack(entry.ref)).toEqual(getActiveMapPack(entry.ref.id));
    }
  });

  it('重复调用只加载一次（幂等）', async () => {
    const first = loadProductionMapPacks();
    const second = loadProductionMapPacks();

    // 同一个 Promise = 并发调用共享一次加载，不会重复下载十三张图。
    expect(second).toBe(first);
    await first;
  });
});
