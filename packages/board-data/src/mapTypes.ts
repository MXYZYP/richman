import type { BoardData, CardsData, GameConfig } from './types';

export interface MapRef {
  readonly id: string;
  readonly version: number;
  readonly contentHash: string;
}

export interface RuleModuleRef {
  readonly id: string;
  readonly version: number;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type DeepReadonly<T> =
  T extends (...args: never[]) => unknown
    ? T
    : T extends readonly unknown[]
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T extends object
        ? { readonly [K in keyof T]: K extends 'payload' ? T[K] : DeepReadonly<T[K]> }
        : T;

export interface ModuleCellData {
  readonly type: 'module';
  readonly module: RuleModuleRef;
  readonly cellType: string;
  readonly payload: JsonValue;
}

export interface ModuleEffect {
  readonly type: 'module';
  readonly module: RuleModuleRef;
  readonly effectType: string;
  readonly payload: JsonValue;
}

export interface ModuleIntent {
  readonly type: 'module';
  readonly module: RuleModuleRef;
  readonly action: string;
  readonly payload: JsonValue;
}

export interface ModuleEvent {
  readonly type: 'module';
  readonly module: RuleModuleRef;
  readonly eventType: string;
  readonly payload: JsonValue;
}

export type BuiltInIconId =
  | 'start'
  | 'airport'
  | 'chance'
  | 'destiny'
  | 'tax'
  | 'special-food'
  | 'special-moon'
  | 'world';

export type PropertyBandToken = `band:${string}`;

export type MapThemeRole =
  | 'board'
  | 'cell'
  | 'border'
  | 'route'
  | 'title'
  | 'decoration'
  | 'center';

export interface MapThemeTokens {
  readonly colors: Readonly<Record<MapThemeRole, string>>;
  readonly propertyBands: Readonly<Record<PropertyBandToken, string>>;
}

export interface BuiltInIconArtwork {
  readonly type: 'built-in-icon';
  readonly icon: BuiltInIconId;
}

export type PackageLocalAssetPath = `assets/${string}`;

export interface PackageLocalAsset {
  readonly type: 'local-asset';
  readonly path: PackageLocalAssetPath;
}

export type CellArtwork = BuiltInIconArtwork | PackageLocalAsset;

export interface ResponsiveRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CellPresentation {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotation?: number;
  readonly zIndex?: number;
  readonly overlapWith?: readonly number[];
  readonly shortLabel: string;
  readonly compactLabel?: string;
  readonly artwork?: CellArtwork;
  readonly propertyBand?: PropertyBandToken;
  readonly accessibilityLabel?: string;
  /** 受控的小屏几何覆盖；未提供时继续使用同一组设计坐标。 */
  readonly mobile?: ResponsiveRectangle;
}

export interface PresentationPoint {
  readonly x: number;
  readonly y: number;
}

interface RouteDecorationBase {
  readonly role: MapThemeRole;
  readonly strokeWidth: number;
  readonly dashPattern?: readonly number[];
  readonly lineCap?: 'butt' | 'round' | 'square';
  readonly opacity?: number;
  readonly zIndex?: number;
}

interface LineRouteDecoration extends RouteDecorationBase {
  readonly type: 'line';
  readonly from: PresentationPoint;
  readonly to: PresentationPoint;
}

interface PolylineRouteDecoration extends RouteDecorationBase {
  readonly type: 'polyline';
  readonly points: readonly PresentationPoint[];
}

interface PathRouteDecoration extends RouteDecorationBase {
  readonly type: 'path';
  readonly d: string;
}

export type RouteDecoration =
  | LineRouteDecoration
  | PolylineRouteDecoration
  | PathRouteDecoration;

interface CenterDecorationBase {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotation?: number;
  readonly role: MapThemeRole;
  readonly zIndex?: number;
  readonly mobile?: ResponsiveRectangle;
}

interface PanelCenterDecoration extends CenterDecorationBase {
  readonly type: 'panel';
}

interface TextCenterDecoration extends CenterDecorationBase {
  readonly type: 'text';
  readonly text: string;
  readonly fitContent?: boolean;
}

interface ImageCenterDecoration extends CenterDecorationBase {
  readonly type: 'image';
  readonly asset: PackageLocalAsset;
  readonly accessibilityLabel?: string;
}

export type CenterDecoration =
  | PanelCenterDecoration
  | TextCenterDecoration
  | ImageCenterDecoration;

export interface MapPresentation {
  readonly canvas: {
    readonly size: number;
  };
  readonly cells: Readonly<Record<number, CellPresentation>>;
  readonly routes: readonly RouteDecoration[];
  readonly center: readonly CenterDecoration[];
  readonly theme: MapThemeTokens;
}

export interface MapPack {
  readonly ref: MapRef;
  readonly metadata: {
    readonly title: string;
    readonly description: string;
  };
  readonly game: {
    readonly board: DeepReadonly<BoardData>;
    readonly cards: DeepReadonly<CardsData>;
    readonly config: DeepReadonly<GameConfig>;
    readonly requiredRuleModules: readonly RuleModuleRef[];
  };
  readonly presentation: MapPresentation;
}

export interface MapCatalogEntry {
  readonly ref: MapRef;
  readonly title: string;
  readonly description: string;
}
