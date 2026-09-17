import type {
  BoardData,
  BuiltInIconId,
  CenterDecoration,
  CellPresentation,
  ResponsiveRectangle,
  MapPack,
  MapPresentation,
  MapThemeRole,
  RouteDecoration,
  DeepReadonly,
} from '@richman/board-data';
import type { RenderableGameState } from '../session/gameSession';
import { resolveClientMapAsset, type ClientMapAssetResolver } from '../game/mapAssets';

type StyleValue = string | undefined;
export type ControlledStyle = Readonly<Record<string, StyleValue>>;

const BUILT_IN_ICON_GLYPHS: Readonly<Record<BuiltInIconId, string>> = Object.freeze({
  start: '←',
  airport: '✈',
  chance: '?',
  destiny: '!',
  tax: '¥',
  'special-food': '🍜',
  'special-moon': '☾',
  world: '🌐',
});

const THEME_STYLE_KEYS: Readonly<Record<MapThemeRole, string>> = Object.freeze({
  board: '--map-board-color',
  cell: '--map-cell-color',
  border: '--map-border-color',
  route: '--map-route-color',
  title: '--map-title-color',
  decoration: '--map-decoration-color',
  center: '--map-center-color',
});

export interface CellPresentationModel {
  readonly cellId: number;
  readonly shortLabel: string;
  readonly compactLabel: string;
  readonly accessibilityLabel: string;
  readonly iconGlyph: string;
  readonly assetUrl: string | null;
  readonly bandColor: string | null;
  readonly compact: boolean;
  readonly style: ControlledStyle;
}

export interface RouteDecorationModel {
  readonly type: RouteDecoration['type'];
  readonly points: string | null;
  readonly path: string | null;
  readonly line: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number } | null;
  readonly style: ControlledStyle;
  readonly zIndex: number;
}

export interface CenterDecorationModel {
  readonly type: CenterDecoration['type'];
  readonly text: string | null;
  readonly color: string;
  readonly assetUrl: string | null;
  readonly accessibilityLabel: string | null;
  readonly style: ControlledStyle;
}

type PresentationSource = MapPack | Pick<RenderableGameState, 'mapRef' | 'board' | 'presentation'>;

function sourceBoard(source: PresentationSource): DeepReadonly<BoardData> {
  return 'game' in source ? source.game.board : source.board;
}

function sourceMapRef(source: PresentationSource) {
  return 'ref' in source ? source.ref : source.mapRef;
}

function percent(value: number, canvasSize: number): string {
  return `${(value / canvasSize) * 100}%`;
}

function rectangleStyle(
  rectangle: Pick<CellPresentation, 'x' | 'y' | 'width' | 'height' | 'rotation' | 'zIndex' | 'mobile'>,
  canvasSize: number,
  fitContent = false,
): ControlledStyle {
  const mobile: ResponsiveRectangle = rectangle.mobile ?? rectangle;
  return {
    left: percent(rectangle.x, canvasSize),
    top: percent(rectangle.y, canvasSize),
    width: fitContent ? undefined : percent(rectangle.width, canvasSize),
    height: fitContent ? undefined : percent(rectangle.height, canvasSize),
    maxWidth: fitContent ? percent(rectangle.width, canvasSize) : undefined,
    maxHeight: fitContent ? percent(rectangle.height, canvasSize) : undefined,
    '--mobile-left': percent(mobile.x, canvasSize),
    '--mobile-top': percent(mobile.y, canvasSize),
    '--mobile-width': fitContent ? undefined : percent(mobile.width, canvasSize),
    '--mobile-height': fitContent ? undefined : percent(mobile.height, canvasSize),
    '--mobile-max-width': fitContent ? percent(mobile.width, canvasSize) : undefined,
    '--mobile-max-height': fitContent ? percent(mobile.height, canvasSize) : undefined,
    ...(rectangle.rotation === undefined ? {} : { transform: `rotate(${rectangle.rotation}deg)` }),
    ...(rectangle.zIndex === undefined ? {} : { zIndex: String(rectangle.zIndex) }),
  };
}

export function getBuiltInIconGlyph(icon: BuiltInIconId): string {
  return BUILT_IN_ICON_GLYPHS[icon];
}

export function getCellPresentationModel(
  source: PresentationSource,
  cellId: number,
  resolveAsset: ClientMapAssetResolver = resolveClientMapAsset,
): CellPresentationModel {
  const cell = sourceBoard(source).cells.find((candidate) => candidate.id === cellId);
  const placement = source.presentation.cells[cellId];
  if (cell === undefined || placement === undefined) {
    throw new Error(`Missing presentation for cell ${cellId}`);
  }

  const relativeWidth = placement.width / source.presentation.canvas.size;
  const relativeHeight = placement.height / source.presentation.canvas.size;
  const compact = placement.compactLabel !== undefined
    || (Math.max(relativeWidth, relativeHeight) <= 0.09 && Math.abs(relativeWidth - relativeHeight) <= 0.02);
  const artwork = placement.artwork;

  return {
    cellId,
    shortLabel: placement.shortLabel,
    compactLabel: placement.compactLabel ?? placement.shortLabel,
    accessibilityLabel: placement.accessibilityLabel ?? cell.name,
    iconGlyph: artwork?.type === 'built-in-icon' ? getBuiltInIconGlyph(artwork.icon) : '',
    assetUrl: artwork?.type === 'local-asset' ? resolveAsset(sourceMapRef(source), artwork.path) : null,
    bandColor: placement.propertyBand === undefined
      ? null
      : source.presentation.theme.propertyBands[placement.propertyBand] ?? null,
    compact,
    style: rectangleStyle(placement, source.presentation.canvas.size),
  };
}

export function getMapThemeStyle(presentation: MapPresentation): ControlledStyle {
  return Object.fromEntries(
    Object.entries(THEME_STYLE_KEYS).map(([role, property]) => [
      property,
      presentation.theme.colors[role as MapThemeRole],
    ]),
  );
}

export function getRouteDecorationModel(
  route: RouteDecoration,
  presentation: MapPresentation,
): RouteDecorationModel {
  const style: ControlledStyle = {
    fill: 'none',
    stroke: presentation.theme.colors[route.role],
    strokeWidth: String(route.strokeWidth),
    ...(route.dashPattern === undefined ? {} : { strokeDasharray: route.dashPattern.join(' ') }),
    ...(route.lineCap === undefined ? {} : { strokeLinecap: route.lineCap }),
    ...(route.opacity === undefined ? {} : { opacity: String(route.opacity) }),
  };

  const zIndex = route.zIndex ?? 0;
  if (route.type === 'line') {
    return {
      type: route.type,
      points: null,
      path: null,
      line: { x1: route.from.x, y1: route.from.y, x2: route.to.x, y2: route.to.y },
      style,
      zIndex,
    };
  }
  if (route.type === 'polyline') {
    return {
      type: route.type,
      points: route.points.map((point) => `${point.x},${point.y}`).join(' '),
      path: null,
      line: null,
      style,
      zIndex,
    };
  }
  return { type: route.type, points: null, path: route.d, line: null, style, zIndex };
}

export function getRouteDecorationModels(presentation: MapPresentation): readonly RouteDecorationModel[] {
  return presentation.routes
    .map((route, index) => ({ model: getRouteDecorationModel(route, presentation), index }))
    .sort((left, right) => left.model.zIndex - right.model.zIndex || left.index - right.index)
    .map(({ model }) => model);
}

type CenterPresentationSource = Pick<MapPack, 'ref' | 'presentation'>
  | Pick<RenderableGameState, 'mapRef' | 'presentation'>;

export function getCenterDecorationModel(
  source: CenterPresentationSource,
  decoration: CenterDecoration,
  resolveAsset: ClientMapAssetResolver = resolveClientMapAsset,
): CenterDecorationModel {
  const mapRef = 'ref' in source ? source.ref : source.mapRef;
  return {
    type: decoration.type,
    text: decoration.type === 'text' ? decoration.text : null,
    color: source.presentation.theme.colors[decoration.role],
    assetUrl: decoration.type === 'image' ? resolveAsset(mapRef, decoration.asset.path) : null,
    accessibilityLabel: decoration.type === 'image' ? decoration.accessibilityLabel ?? null : null,
    style: rectangleStyle(
      decoration,
      source.presentation.canvas.size,
      decoration.type === 'text' && decoration.fitContent === true,
    ),
  };
}
