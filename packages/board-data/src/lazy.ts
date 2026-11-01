/**
 * 客户端专用入口（体验 E2：地图数据按需加载）。
 *
 * 背景：`@richman/board-data` 的主入口在模块加载期就把十三张地图全部注册好 —— 那是
 * 258 KB（brotli 后 39 KB）的棋盘格 / 卡牌 / 规则模块数据，**首页一条都用不到**，
 * 却因为 `App.vue` 顶层 `listActiveMaps()` 被一起拉进首屏。
 *
 * 这里提供同一套 API 的**懒加载版本**：
 *   - `listActiveMaps()` 走 `PRODUCTION_CATALOG`（轻量目录，不碰任何地图包）；
 *   - **默认地图（目录第一张）随首屏同步可用** —— 首页的默认开局表单、演示棋盘都用它，
 *     于是「忘了先加载」不会立刻炸在最常见的那条路径上；
 *   - `loadProductionMapPacks()` 补齐其余十二张（幂等，重复调用只加载一次）；
 *   - `getActiveMapPack()` / `getMapPack()` 保持**同步**语义，取未加载的地图时抛一条
 *     指名道姓的错误，而不是静默返回 undefined。
 *
 * ★ 谁该调 `loadProductionMapPacks()`：**任何要让玩家挑地图 / 看棋盘 / 读存档的地方**
 * （单机设置页、在线建房页、还原存档、回放）。首页与「用默认图直接开局」不需要。
 *
 * ★ 为什么是「另一个入口」而不是改主入口：主入口被 26 个测试文件与服务端直接依赖，
 * 把同步注册改成异步会一次性打破它们。这里靠构建期 alias 只换**浏览器产物**那一份，
 * 类型与行为契约完全一致，两份实现的一致性由 `mapCatalog.test.ts` 盯着。
 */

import { createMapRegistry, PRODUCTION_RULE_MODULES } from './registry';
import { PRODUCTION_CATALOG } from './mapCatalog';
// 默认地图**静态**引入：首页的默认开局表单与演示棋盘都在模块加载期就用它，
// 让它随首屏可用，是「按需加载」与「不炸默认路径」之间最划算的那一刀（一张图，不是十三张）。
import { chinaTourMap } from './chinaTourMap';
import type { MapCatalogEntry, MapPack, MapRef, RuleModuleRef } from './mapTypes';

export type {
  BoardData, CardsData, GameConfig,
  Cell, CellType, CoreCellType, PropertySubtype, PropertyCell, ModuleCell,
  StartCell, ChanceCell, DestinyCell, TaxCell, AirportCell,
  SpecialCell, WorldCell, CellEffect, CoreCellEffect, Card,
} from './types';

export type {
  MapRef, RuleModuleRef, MapPack, MapCatalogEntry,
  MapPresentation, CellPresentation, RouteDecoration, CenterDecoration,
  MapThemeTokens, MapThemeRole, PresentationPoint,
  BuiltInIconId, BuiltInIconArtwork, PackageLocalAssetPath, PackageLocalAsset, CellArtwork,
  ResponsiveRectangle,
  PropertyBandToken, JsonValue, DeepReadonly,
  ModuleCellData, ModuleEffect, ModuleIntent, ModuleEvent,
} from './mapTypes';

export { createMapRegistry, PRODUCTION_RULE_MODULES } from './registry';
export type { MapRegistry, MapRegistryOptions } from './registry';
export { assertValidMapPack } from './mapValidation';
export { computeContentHash, canonicalStringify } from './hash';
export { PRODUCTION_CATALOG } from './mapCatalog';

/** 动态导入表：除默认地图外，每张地图一个独立 chunk，按需下载。 */
const MAP_LOADERS: readonly (() => Promise<{ [key: string]: MapPack }>)[] = [
  () => import('./worldTourMap'),
  () => import('./classicTourMap'),
  () => import('./silkRoadMap'),
  () => import('./greatWallMap'),
  () => import('./yellowRiverMap'),
  () => import('./yangtzeTourMap'),
  () => import('./pearlTourMap'),
  () => import('./xinjiangTourMap'),
  () => import('./shanxiTourMap'),
  () => import('./northeastTourMap'),
  () => import('./yunchengTourMap'),
  () => import('./sanguoTourMap'),
];

/** 懒注册表：与主入口同一套校验（规则模块白名单 / 资产白名单 / 结构 / 哈希）。 */
const lazyRegistry = createMapRegistry({
  activeMapRefs: PRODUCTION_CATALOG.map((entry) => entry.ref),
  knownRuleModules: PRODUCTION_RULE_MODULES,
  assetAllowlist: PRODUCTION_CATALOG.map((entry) => ({ ref: entry.ref, paths: [] as const })),
});

lazyRegistry.registerMapPack(chinaTourMap);

let loading: Promise<void> | null = null;
/**
 * 「除默认地图外全部加载完」的标记。
 *
 * 刻意不用 `registry.listActiveMaps()` 去判：那个方法会遍历**全部** active ref，
 * 任何一张没注册就直接抛错 —— 拿「会不会抛」当「加载完了吗」的判据，会把一次状态查询
 * 变成一次崩溃（这个坑就在写这条注释前刚踩过）。
 */
let loadedAll = false;

/** 默认地图（目录第一张）：随首屏可用，不需要 await。 */
export const DEFAULT_MAP_ID: string = PRODUCTION_CATALOG[0]?.ref.id ?? 'china-tour';

/**
 * 补齐**默认地图以外**的全部生产地图（幂等：并发调用共享同一个 Promise）。
 *
 * 一次把剩下的都加载，是因为设置页的地图列表要给每一张画缩略图 —— 只加载选中的那张
 * 会让其它十一张变成空白卡片。首屏不受影响：首页不调它。
 */
export function loadProductionMapPacks(): Promise<void> {
  if (loading !== null) return loading;
  loading = (async () => {
    const modules = await Promise.all(MAP_LOADERS.map((load) => load()));
    for (const module of modules) {
      const pack = Object.values(module).find(
        (value): value is MapPack => typeof value === 'object' && value !== null && 'ref' in value,
      );
      if (pack !== undefined) lazyRegistry.registerMapPack(pack);
    }
    loadedAll = true;
  })();
  return loading;
}

/**
 * 除默认地图外的其它地图是否已加载完（供 UI 决定要不要显示加载态）。
 *
 * 注意语义是「**全部**加载完」而不是「开始加载过」：并发的第二次调用拿到的 Promise
 * 还没 resolve 时，取某张图仍会失败，所以不能只判 `loading !== null`。
 */
export function isProductionMapsLoaded(): boolean {
  return loadedAll;
}

/** 轻量目录：不触发任何地图包加载，首页可安全调用。 */
export function listActiveMaps(): readonly MapCatalogEntry[] {
  return PRODUCTION_CATALOG;
}

function notLoadedError(what: string): Error {
  return new Error(
    `${what} 需要先 await loadProductionMapPacks()：除默认地图外，地图包是按需加载的（首屏不加载）。`
    + '调用点应在让玩家挑地图 / 渲染棋盘 / 读存档之前完成加载。',
  );
}

export function getActiveMapPack(mapId: string): MapPack {
  try {
    return lazyRegistry.getActiveMapPack(mapId);
  } catch {
    // 只有「这张图还没加载」这一种原因会走到这里：注册表的其它错误（未知 id、哈希不符）
    // 必须原样抛出去，不能一律归成「忘了加载」，否则真正的地图缺失会被误诊。
    if (!isProductionMapsLoaded()) throw notLoadedError(`getActiveMapPack('${mapId}')`);
    throw new Error(`Inactive map id: ${mapId}`);
  }
}

export function getMapPack(mapRef: MapRef): MapPack {
  try {
    return lazyRegistry.getMapPack(mapRef);
  } catch {
    if (!isProductionMapsLoaded()) throw notLoadedError(`getMapPack('${mapRef.id}')`);
    throw new Error(`Unknown map id: ${mapRef.id}`);
  }
}

export const PRODUCTION_KNOWN_RULE_MODULES: readonly RuleModuleRef[] = PRODUCTION_RULE_MODULES;
