import { describe, expect, it } from 'vitest';
import { getActiveMapPack, type MapPack, type RouteDecoration } from '@richman/board-data';
import testBoard from '../../../../packages/board-data/maps/__test__/test-map-v1/board.json';
import testCards from '../../../../packages/board-data/maps/__test__/test-map-v1/cards.json';
import testConfig from '../../../../packages/board-data/maps/__test__/test-map-v1/game-config.json';
import testManifest from '../../../../packages/board-data/maps/__test__/test-map-v1/manifest.json';
import {
  getBuiltInIconGlyph,
  getCellPresentationModel,
  getCenterDecorationModel,
  getMapThemeStyle,
  getRouteDecorationModel,
  getRouteDecorationModels,
} from './boardLayout';

const china = getActiveMapPack('china-tour');
const harbor = {
  ref: testManifest.ref,
  metadata: testManifest.metadata,
  game: {
    board: testBoard,
    cards: testCards,
    config: testConfig,
    requiredRuleModules: testManifest.requiredRuleModules,
  },
  presentation: testManifest.presentation,
} as unknown as MapPack;

describe('data-driven board presentation helpers', () => {
  it('reads exact China labels, icons, bands and absolute geometry from presentation data', () => {
    expect(getCellPresentationModel(china, 13)).toMatchObject({
      shortLabel: '机场',
      compactLabel: '机场',
      accessibilityLabel: '北京首都国际机场',
      iconGlyph: '✈',
      bandColor: null,
      compact: false,
      style: {
        left: '0%',
        top: '88.961039%',
        width: '11.038961%',
        height: '11.038961%',
      },
    });
    expect(getCellPresentationModel(china, 10)).toMatchObject({
      shortLabel: '运河',
      bandColor: '#8e7cc3',
    });
    expect(getCellPresentationModel(china, 52)).toMatchObject({
      shortLabel: '首尔',
      iconGlyph: '🌐',
      compact: true,
      style: {
        left: '9.8%',
        top: '81.8%',
        width: '8.4%',
        height: '8.4%',
        zIndex: '5',
      },
    });

    for (const cell of china.game.board.cells) {
      const placement = china.presentation.cells[cell.id]!;
      const model = getCellPresentationModel(china, cell.id);
      expect(model.shortLabel).toBe(placement.shortLabel);
      expect(model.compactLabel).toBe(placement.compactLabel ?? placement.shortLabel);
      expect(model.accessibilityLabel).toBe(placement.accessibilityLabel ?? cell.name);
      expect(model.bandColor).toBe(
        placement.propertyBand === undefined
          ? null
          : china.presentation.theme.propertyBands[placement.propertyBand],
      );
    }
  });

  it('preserves controlled line and path geometry plus every optional route style', () => {
    const line: RouteDecoration = {
      type: 'line', role: 'decoration', from: { x: 1, y: 2 }, to: { x: 3, y: 4 },
      strokeWidth: 1.5, dashPattern: [2, 3], lineCap: 'square', opacity: 0.4, zIndex: 7,
    };
    const path: RouteDecoration = {
      type: 'path', role: 'title', d: 'M 1 2 L 3 4 Z', strokeWidth: 2, zIndex: -1,
    };

    expect(getRouteDecorationModel(line, harbor.presentation)).toEqual({
      type: 'line', points: null, path: null, line: { x1: 1, y1: 2, x2: 3, y2: 4 }, zIndex: 7,
      style: {
        fill: 'none', stroke: '#f59e0b', strokeWidth: '1.5', strokeDasharray: '2 3',
        strokeLinecap: 'square', opacity: '0.4',
      },
    });
    expect(getRouteDecorationModel(path, harbor.presentation)).toEqual({
      type: 'path', points: null, path: 'M 1 2 L 3 4 Z', line: null, zIndex: -1,
      style: { fill: 'none', stroke: '#134e4a', strokeWidth: '2' },
    });
  });

  it('renders all eight non-contiguous Harbor cells without a map-specific branch', () => {
    const models = harbor.game.board.cells.map((cell) => getCellPresentationModel(harbor, cell.id));

    expect(models.map((model) => model.cellId)).toEqual([0, 10, 20, 30, 40, 50, 60, 70]);
    expect(models.map((model) => model.shortLabel)).toEqual([
      'Launch', 'Cedar', 'Signal', 'Fee', 'Market', 'Current', 'Tide', 'Lantern',
    ]);
    expect(models[1]).toMatchObject({ bandColor: '#12a594', style: { left: '25%', top: '0%' } });
    expect(models[7]).toMatchObject({ bandColor: '#12a594', style: { left: '0%', top: '25%' } });
  });

  it('converts controlled theme, route and center declarations without accepting executable style', () => {
    expect(getMapThemeStyle(harbor.presentation)).toEqual({
      '--map-board-color': '#e8fffb',
      '--map-cell-color': '#ffffff',
      '--map-border-color': '#164e63',
      '--map-route-color': '#0891b2',
      '--map-title-color': '#134e4a',
      '--map-decoration-color': '#f59e0b',
      '--map-center-color': '#ccfbf1',
    });
    expect(getRouteDecorationModel(harbor.presentation.routes[0]!, harbor.presentation)).toEqual({
      type: 'polyline',
      points: '8,8 48,8 48,48 8,48 8,8',
      path: null,
      line: null,
      style: {
        fill: 'none',
        stroke: '#0891b2',
        strokeWidth: '2',
        strokeLinecap: 'round',
      },
      zIndex: 0,
    });
    expect(getRouteDecorationModels(china.presentation).map((route) => route.zIndex)).toEqual([4]);
    expect(getCenterDecorationModel(harbor, harbor.presentation.center[0]!)).toMatchObject({
      type: 'text',
      text: 'HARBOR',
      color: '#ccfbf1',
      assetUrl: null,
      style: { left: '22.5%', top: '22.5%', width: '25%', height: '25%' },
    });
  });

  it('resolves package-local cell artwork and center images only through an exact app-owned resolver', () => {
    const withImage = {
      ...harbor,
      presentation: {
        ...harbor.presentation,
        center: [{
          type: 'image',
          x: 18,
          y: 18,
          width: 20,
          height: 20,
          role: 'center',
          asset: { type: 'local-asset', path: 'assets/harbor.webp' },
        }],
      },
    } as MapPack;

    const withCellAsset = {
      ...withImage,
      presentation: {
        ...withImage.presentation,
        cells: {
          ...withImage.presentation.cells,
          0: { ...withImage.presentation.cells[0]!, artwork: { type: 'local-asset', path: 'assets/launch.webp' } },
        },
      },
    } as MapPack;
    const resolver = (_ref: MapPack['ref'], path: string) => `/bundled/${path}`;

    expect(getCellPresentationModel(withCellAsset, 0, resolver)).toMatchObject({
      iconGlyph: '', assetUrl: '/bundled/assets/launch.webp',
    });
    expect(getCenterDecorationModel(withImage, withImage.presentation.center[0]!, resolver)).toMatchObject({
      type: 'image', assetUrl: '/bundled/assets/harbor.webp', accessibilityLabel: null,
    });
  });

  it('derives legacy mobile edge tracks and center scale from controlled responsive metadata', () => {
    const start = getCellPresentationModel(china, 0);
    const bottomEdge = getCellPresentationModel(china, 1);
    const panel = getCenterDecorationModel(china, china.presentation.center[0]!);

    expect(start.style).toMatchObject({
      '--mobile-left': '89.73509933774835%',
      '--mobile-top': '89.73509933774835%',
      '--mobile-width': '10.264900662251655%',
      '--mobile-height': '10.264900662251655%',
    });
    expect(bottomEdge.style).toMatchObject({
      '--mobile-width': '6.622516556291391%',
      '--mobile-height': '10.264900662251655%',
    });
    expect(panel.style).toMatchObject({
      '--mobile-left': '23.509933774834437%',
      '--mobile-top': '23.509933774834437%',
      '--mobile-width': '52.980132450331126%',
      '--mobile-height': '52.980132450331126%',
    });
    const title = getCenterDecorationModel(china, china.presentation.center[1]!);
    expect(title.style).toMatchObject({
      width: undefined,
      height: undefined,
      maxWidth: '22%',
      maxHeight: '8%',
      '--mobile-max-width': '22%',
      '--mobile-max-height': '8%',
    });
  });

  it('maps only allowlisted built-in icon IDs to app-owned glyphs', () => {
    expect(getBuiltInIconGlyph('start')).toBe('←');
    expect(getBuiltInIconGlyph('special-food')).toBe('🍜');
    expect(getBuiltInIconGlyph('special-moon')).toBe('☾');
    expect(getBuiltInIconGlyph('world')).toBe('🌐');
  });
});
