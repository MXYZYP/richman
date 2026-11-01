import { createMapRegistry, PRODUCTION_RULE_MODULES } from './registry';
/**
 * 生产注册表（十三张正式地图）。
 *
 * ★ 这个文件**必须**与 `registry.ts` 分开：registry 只提供工厂，不含任何地图数据；
 * 客户端的懒加载入口（`lazy.ts`）要用工厂自建注册表，一旦它引到「会静态 import
 * 十三张地图」的模块，那 258 KB 就又被拖回首屏 —— E2 的分包就白做了。
 */
import { chinaTourMap } from './chinaTourMap';
import { classicTourMap } from './classicTourMap';
import { greatWallMap } from './greatWallMap';
import { northeastTourMap } from './northeastTourMap';
import { pearlTourMap } from './pearlTourMap';
import { sanguoTourMap } from './sanguoTourMap';
import { shanxiTourMap } from './shanxiTourMap';
import { silkRoadMap } from './silkRoadMap';
import { worldTourMap } from './worldTourMap';
import { xinjiangTourMap } from './xinjiangTourMap';
import { yangtzeTourMap } from './yangtzeTourMap';
import { yellowRiverMap } from './yellowRiverMap';
import { yunchengTourMap } from './yunchengTourMap';
import type { MapCatalogEntry, MapPack, MapRef } from './mapTypes';

const productionRegistry = createMapRegistry({
  activeMapRefs: [
    chinaTourMap.ref,
    worldTourMap.ref,
    classicTourMap.ref,
    silkRoadMap.ref,
    greatWallMap.ref,
    yellowRiverMap.ref,
    yangtzeTourMap.ref,
    pearlTourMap.ref,
    xinjiangTourMap.ref,
    shanxiTourMap.ref,
    northeastTourMap.ref,
    yunchengTourMap.ref,
    sanguoTourMap.ref,
  ],
  knownRuleModules: PRODUCTION_RULE_MODULES,
  assetAllowlist: [
    { ref: chinaTourMap.ref, paths: [] },
    { ref: worldTourMap.ref, paths: [] },
    { ref: classicTourMap.ref, paths: [] },
    { ref: silkRoadMap.ref, paths: [] },
    { ref: greatWallMap.ref, paths: [] },
    { ref: yellowRiverMap.ref, paths: [] },
    { ref: yangtzeTourMap.ref, paths: [] },
    { ref: pearlTourMap.ref, paths: [] },
    { ref: xinjiangTourMap.ref, paths: [] },
    { ref: shanxiTourMap.ref, paths: [] },
    { ref: northeastTourMap.ref, paths: [] },
    { ref: yunchengTourMap.ref, paths: [] },
    { ref: sanguoTourMap.ref, paths: [] },
  ],
});

productionRegistry.registerMapPack(chinaTourMap);
productionRegistry.registerMapPack(worldTourMap);
productionRegistry.registerMapPack(classicTourMap);
productionRegistry.registerMapPack(silkRoadMap);
productionRegistry.registerMapPack(greatWallMap);
productionRegistry.registerMapPack(yellowRiverMap);
productionRegistry.registerMapPack(yangtzeTourMap);
productionRegistry.registerMapPack(pearlTourMap);
productionRegistry.registerMapPack(xinjiangTourMap);
productionRegistry.registerMapPack(shanxiTourMap);
productionRegistry.registerMapPack(northeastTourMap);
productionRegistry.registerMapPack(yunchengTourMap);
productionRegistry.registerMapPack(sanguoTourMap);

export function listActiveMaps(): readonly MapCatalogEntry[] {
  return productionRegistry.listActiveMaps();
}

export function getActiveMapPack(mapId: string): MapPack {
  return productionRegistry.getActiveMapPack(mapId);
}

export function getMapPack(mapRef: MapRef): MapPack {
  return productionRegistry.getMapPack(mapRef);
}

/**
 * 与主入口对齐的「按需加载」契约（体验 E2）。
 *
 * 主入口在**模块加载期**就把十三张地图全部注册好了，所以这两个函数什么都不用做 ——
 * 它们存在的唯一理由：客户端代码只写一份（同一句 `loadProductionMapPacks()`），
 * 生产构建走 `lazy.ts`（真按需），测试与 dev 走这里（已就绪）。
 * 缺了它们，26 个测试文件会因为「导出的符号不存在」一次性全红。
 */
export function loadProductionMapPacks(): Promise<void> {
  return Promise.resolve();
}

export function isProductionMapsLoaded(): boolean {
  return true;
}

/** 默认地图（目录第一张）；与 `lazy.ts` 的 `DEFAULT_MAP_ID` 同义。 */
export const DEFAULT_MAP_ID: string = productionRegistry.listActiveMaps()[0]?.ref.id ?? '';
