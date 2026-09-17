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
export { worldTourMap } from './worldTourMap';
