import { describe, expect, it } from 'vitest';
import { getActiveMapPack } from '../index';
import type {
  CenterDecoration,
  CellPresentation,
  JsonValue,
  MapCatalogEntry,
  MapPack,
  MapRef,
  MapThemeTokens,
  ModuleCellData,
  ModuleEffect,
  ModuleEvent,
  ModuleIntent,
  PackageLocalAsset,
  RouteDecoration,
  RuleModuleRef,
} from '../index';

type AssertFalse<T extends false> = T;
type BoardDataRuntimeExports = typeof import('../index');
type _NoLegacyBoardDataExport = AssertFalse<'boardData' extends keyof BoardDataRuntimeExports ? true : false>;
type _NoLegacyCardsDataExport = AssertFalse<'cardsData' extends keyof BoardDataRuntimeExports ? true : false>;
type _NoLegacyGameConfigExport = AssertFalse<'gameConfig' extends keyof BoardDataRuntimeExports ? true : false>;

const chinaMap = getActiveMapPack('china-tour');

const mapRef = {
  id: 'test-map',
  version: 1,
  contentHash: 'test-content-hash',
} satisfies MapRef;

const coreModule = {
  id: 'core',
  version: 1,
} satisfies RuleModuleRef;

const theme = {
  colors: {
    board: '#f5ead8',
    cell: '#fffdf8',
    border: '#7b2417',
    route: '#d9a441',
    title: '#7b2417',
    decoration: '#c0392b',
    center: '#eadfcb',
  },
  propertyBands: {
    'band:china-red-1': '#d73a49',
    'band:station': '#546e7a',
    'band:function': '#d9a441',
  },
} satisfies MapThemeTokens;

const cells = {
  0: {
    x: 0,
    y: 0,
    width: 12,
    height: 12,
    rotation: 0,
    zIndex: 2,
    overlapWith: [1],
    shortLabel: '起点',
    compactLabel: '起',
    artwork: { type: 'built-in-icon', icon: 'start' },
    propertyBand: 'band:function',
    accessibilityLabel: '起点格',
  },
  1: {
    x: 12,
    y: 0,
    width: 12,
    height: 12,
    shortLabel: '测试地块',
    artwork: { type: 'local-asset', path: 'assets/test-landmark.svg' },
    propertyBand: 'band:china-red-1',
  },
} satisfies Readonly<Record<number, CellPresentation>>;

const routes = [
  {
    type: 'line',
    from: { x: 6, y: 6 },
    to: { x: 18, y: 6 },
    role: 'route',
    strokeWidth: 1,
    zIndex: 0,
  },
  {
    type: 'polyline',
    points: [{ x: 6, y: 6 }, { x: 12, y: 12 }, { x: 18, y: 6 }],
    role: 'decoration',
    strokeWidth: 1.1,
    dashPattern: [2.6, 2.2],
    lineCap: 'round',
    opacity: 0.8,
  },
  {
    type: 'path',
    d: 'M 6 6 C 10 2, 14 2, 18 6',
    role: 'route',
    strokeWidth: 1,
  },
] satisfies readonly RouteDecoration[];

const center = [
  {
    type: 'panel',
    x: 24,
    y: 24,
    width: 52,
    height: 52,
    role: 'center',
    zIndex: 0,
  },
  {
    type: 'text',
    x: 32,
    y: 32,
    width: 36,
    height: 8,
    rotation: -8,
    role: 'title',
    text: '测试地图',
    zIndex: 1,
  },
  {
    type: 'image',
    x: 36,
    y: 44,
    width: 28,
    height: 28,
    role: 'decoration',
    asset: { type: 'local-asset', path: 'assets/test-center.svg' },
    accessibilityLabel: '测试地图中心图案',
    zIndex: 1,
  },
] satisfies readonly CenterDecoration[];

const mapPack = {
  ref: mapRef,
  metadata: {
    title: '测试地图',
    description: '用于锁定地图包类型契约',
  },
  game: {
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: chinaMap.game.config,
    requiredRuleModules: [coreModule],
  },
  presentation: {
    canvas: { size: 100 },
    cells,
    routes,
    center,
    theme,
  },
} satisfies MapPack;

const catalogEntry = {
  ref: mapRef,
  title: '测试地图',
  description: '目录携带完整地图身份',
} satisfies MapCatalogEntry;

const modulePayload = {
  enabled: true,
  destinations: [0, 1],
  metadata: { label: '测试模块数据', value: null },
} satisfies JsonValue;

const moduleCellData = {
  type: 'module',
  module: coreModule,
  cellType: 'test-cell',
  payload: modulePayload,
} satisfies ModuleCellData;

const moduleEffect = {
  type: 'module',
  module: coreModule,
  effectType: 'test-effect',
  payload: modulePayload,
} satisfies ModuleEffect;

const moduleIntent = {
  type: 'module',
  module: coreModule,
  action: 'test-action',
  payload: modulePayload,
} satisfies ModuleIntent;

const moduleEvent = {
  type: 'module',
  module: coreModule,
  eventType: 'test-event',
  payload: modulePayload,
} satisfies ModuleEvent;

const invalidMapRef = {
  // @ts-expect-error MapRef 只接受 id，不接受 mapId 别名
  mapId: 'test-map',
  version: 1,
  contentHash: 'test-content-hash',
} satisfies MapRef;

const invalidModuleRef = {
  // @ts-expect-error RuleModuleRef 只接受 id，不接受 moduleId 别名
  moduleId: 'core',
  version: 1,
} satisfies RuleModuleRef;

const flattenedMapPack = {
  ref: mapRef,
  metadata: { title: '错误地图', description: '不允许扁平结构' },
  // @ts-expect-error board/cards/config 必须嵌套在 game 下
  board: chinaMap.game.board,
  cards: chinaMap.game.cards,
  config: chinaMap.game.config,
  requiredRuleModules: [coreModule],
  presentation: mapPack.presentation,
} satisfies MapPack;

// @ts-expect-error MapPack 必须独立要求 game，不能只依赖 flattened 字段的 excess-property 错误
const missingGameMapPack: MapPack = {
  ref: mapRef,
  metadata: { title: '缺少 game', description: '不完整地图包' },
  presentation: mapPack.presentation,
};

const remoteArtworkCell = {
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  shortLabel: '远程资源',
  artwork: {
    // @ts-expect-error artwork 不接受 remote URL 类型
    type: 'remote',
    url: 'https://example.com/artwork.svg',
  },
} satisfies CellPresentation;

const remotePackageAsset = {
  type: 'local-asset',
  // @ts-expect-error package-local asset 不接受远程 URL
  path: 'https://example.com/artwork.svg',
} satisfies PackageLocalAsset;

const dataPackageAsset = {
  type: 'local-asset',
  // @ts-expect-error package-local asset 不接受 data URL
  path: 'data:image/svg+xml;base64,PHN2Zy8+',
} satisfies PackageLocalAsset;

const absolutePackageAsset = {
  type: 'local-asset',
  // @ts-expect-error package-local asset 不接受绝对路径
  path: '/tmp/artwork.svg',
} satisfies PackageLocalAsset;

// @ts-expect-error JsonValue 不接受 undefined
const invalidUndefinedJson = undefined satisfies JsonValue;

// @ts-expect-error JsonValue 不接受 function
const invalidFunctionJson = (() => undefined) satisfies JsonValue;

// @ts-expect-error JsonValue 不接受 bigint
const invalidBigIntJson = 1n satisfies JsonValue;

const routeWithArbitraryStyle = {
  type: 'line',
  from: { x: 0, y: 0 },
  to: { x: 10, y: 10 },
  role: 'route',
  strokeWidth: 1,
  // @ts-expect-error route 不接受任意 CSS style
  style: 'stroke: red',
} satisfies RouteDecoration & { strokeWidth: number };

function assertMapPackReadonly(pack: MapPack): void {
  // @ts-expect-error MapRef identity 不可修改
  pack.ref.id = 'changed-map';
  // @ts-expect-error metadata 不可修改
  pack.metadata.title = '已修改';
  // @ts-expect-error presentation cell geometry 不可修改
  pack.presentation.cells[0]!.x = 99;
  // @ts-expect-error game board cells 必须递归只读
  pack.game.board.cells.push(chinaMap.game.board.cells[0]!);
  // @ts-expect-error game config 必须递归只读
  pack.game.config.initialCash = 0;
}

describe('地图契约类型', () => {
  it('类型负例不会在 runtime 修改共享地图数据', () => {
    expect(mapPack.ref.id).toBe('test-map');
    expect(mapPack.metadata.title).toBe('测试地图');
    expect(mapPack.presentation.cells[0]?.x).toBe(0);
    expect(chinaMap.game.board.cells.length).toBe(61);
    expect(chinaMap.game.config.initialCash).toBe(15_000);
  });

  it('保留 MapPack 的身份、game 嵌套和 presentation shape', () => {
    expect(mapPack.ref).toEqual(mapRef);
    expect(mapPack.game.requiredRuleModules).toEqual([coreModule]);
    expect(mapPack.presentation.cells[0]?.shortLabel).toBe('起点');
    expect(mapPack.presentation.routes.map((route) => route.type)).toEqual([
      'line',
      'polyline',
      'path',
    ]);
    expect(mapPack.presentation.center[1]?.rotation).toBe(-8);
    expect(mapPack.presentation.center.map((decoration) => decoration.type)).toEqual([
      'panel',
      'text',
      'image',
    ]);
  });

  it('目录携带 exact map identity，模块 envelope 保留 namespace', () => {
    expect(catalogEntry.ref.contentHash).toBe('test-content-hash');
    expect([
      moduleCellData.cellType,
      moduleEffect.effectType,
      moduleIntent.action,
      moduleEvent.eventType,
    ]).toEqual(['test-cell', 'test-effect', 'test-action', 'test-event']);
    expect(moduleEvent.module).toEqual(coreModule);
  });

  it('mapTypes 模块只提供类型，不扩大 runtime API', async () => {
    expect(Object.keys(await import('../mapTypes'))).toEqual([]);
  });
});

void invalidMapRef;
void invalidModuleRef;
void flattenedMapPack;
void missingGameMapPack;
void remoteArtworkCell;
void remotePackageAsset;
void dataPackageAsset;
void absolutePackageAsset;
void invalidUndefinedJson;
void invalidFunctionJson;
void invalidBigIntJson;
void routeWithArbitraryStyle;
