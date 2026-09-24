// @richman/board-data 入口：导出地图 registry + 类型

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

export { listActiveMaps, getActiveMapPack, getMapPack } from './registry';
// 地图工坊（#117）需要自己造一个**独立的**注册表来装载玩家导入的自定义地图：
// 生产注册表是模块私有单例（在模块加载期就注册好十张正式地图），运行时无法往里注入；
// 因此把工厂与选项类型导出，让客户端另建一个互不干扰的实例。
export { createMapRegistry, PRODUCTION_RULE_MODULES } from './registry';
export type { MapRegistry, MapRegistryOptions } from './registry';
// 自定义地图必须过与生产完全同一套校验（结构 / 哈希 / 规则模块白名单 / 资源白名单），
// 否则会出现「工坊放行、开局炸」。
export { assertValidMapPack } from './mapValidation';
// 工坊要在导入时把 contentHash 展示给玩家（并与包内声明值比对），沿用同一份哈希实现。
export { computeContentHash, canonicalStringify } from './hash';
export { chinaTourMap } from './chinaTourMap';
export { worldTourMap } from './worldTourMap';
export { classicTourMap } from './classicTourMap';
export { silkRoadMap } from './silkRoadMap';
export { greatWallMap } from './greatWallMap';
export { yellowRiverMap } from './yellowRiverMap';
export { yangtzeTourMap } from './yangtzeTourMap';
export { pearlTourMap } from './pearlTourMap';
export { xinjiangTourMap } from './xinjiangTourMap';
export { shanxiTourMap } from './shanxiTourMap';
