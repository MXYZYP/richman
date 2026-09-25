import { describe, expect, it } from 'vitest';
import mapBoard from '../../maps/china-tour/v1/board.json';
import mapCards from '../../maps/china-tour/v1/cards.json';
import mapConfig from '../../maps/china-tour/v1/game-config.json';
import { chinaTourMap } from '../chinaTourMap';
import { computeContentHash } from '../hash';
import type { BuiltInIconId, PropertyBandToken } from '../mapTypes';

type ChinaTourCell = (typeof chinaTourMap.game.board.cells)[number];

const shortNameOverrides: Readonly<Record<number, string>> = {
  10: '运河',
  13: '机场',
  26: '兰州',
  39: '维港',
  40: '黑龙江',
  41: '故宫',
  52: '首尔',
  53: '东京',
  55: '纽约',
  56: '伦敦',
  57: '巴黎',
  59: '曼谷',
  60: '河内',
};

const normalPropertyBands: Readonly<Record<string, PropertyBandToken>> = {
  台湾省: 'band:feishu-d73a49',
  福建省: 'band:feishu-d73a49',
  广东省: 'band:feishu-1677ff',
  广西壮族自治区: 'band:feishu-1677ff',
  贵州省: 'band:feishu-1677ff',
  云南省: 'band:feishu-1677ff',
  江苏省: 'band:feishu-1677ff',
  浙江省: 'band:feishu-8e44ad',
  安徽省: 'band:feishu-8e44ad',
  江西省: 'band:feishu-8e44ad',
  湖南省: 'band:feishu-8e44ad',
  湖北省: 'band:feishu-8e44ad',
  四川省: 'band:feishu-1f5fbf',
  山东省: 'band:feishu-1f5fbf',
  河北省: 'band:feishu-1f5fbf',
  河南省: 'band:feishu-1f5fbf',
  山西省: 'band:feishu-e66a95',
  陕西省: 'band:feishu-e66a95',
  甘肃省: 'band:feishu-e66a95',
  辽宁省: 'band:feishu-e66a95',
  内蒙古自治区: 'band:feishu-2ea44f',
  宁夏回族自治区: 'band:feishu-2ea44f',
  吉林省: 'band:feishu-2ea44f',
  西藏自治区: 'band:feishu-c2185b',
  海南省: 'band:feishu-c2185b',
  武夷山: 'band:feishu-c2185b',
  黑龙江省: 'band:feishu-c2185b',
  北京故宫博物院: 'band:feishu-c2185b',
  万里长城: 'band:feishu-c2185b',
  澳门大三巴牌坊: 'band:feishu-757575',
  敦煌莫高窟: 'band:feishu-757575',
  丽江古城: 'band:feishu-757575',
  青海省: 'band:feishu-d73a49',
  高昌故城: 'band:feishu-d73a49',
  新疆维吾尔自治区: 'band:feishu-d73a49',
};

function expectedShortLabel(cell: ChinaTourCell): string {
  const override = shortNameOverrides[cell.id];
  if (override) return override;
  if (cell.type === 'property') {
    const cleaned = cell.name.replace(/(省|市)$/u, '');
    return cleaned.length <= 3 ? cleaned : cleaned.slice(0, 2);
  }
  return cell.name.length <= 3 ? cell.name : cell.name.slice(0, 2);
}

function expectedIcon(cell: ChinaTourCell): BuiltInIconId | undefined {
  switch (cell.type) {
    case 'start': return 'start';
    case 'airport': return 'airport';
    case 'chance': return 'chance';
    case 'destiny': return 'destiny';
    case 'tax': return 'tax';
    case 'special':
    case 'module':
      // #23：26 / 39 已原地改造成 rail-hub@1 模块格，presentation 的图标保持不变。
      return cell.id === 26 ? 'special-food' : 'special-moon';
    case 'world': return 'world';
    default: return undefined;
  }
}

function expectedBand(cell: ChinaTourCell): PropertyBandToken | undefined {
  if (cell.type !== 'property') return undefined;
  if (cell.subtype === 'station') return 'band:station';
  if (cell.subtype === 'utility') return 'band:utility';
  return normalPropertyBands[cell.name];
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

describe('china-tour@1 map pack', () => {
  it('暴露 exact identity、metadata 与 core@1 + rail-hub@1', () => {
    expect(chinaTourMap.ref).toEqual({
      id: 'china-tour',
      version: 1,
      contentHash: '26a6f9529d6a4374fb64ef43113fe60e06fd71d91185f186b1eee73d8fd7e0d6',
    });
    expect(chinaTourMap.metadata).toEqual({
      title: '中国之旅',
      description: '环游中国并经营地产的经典地图',
    });
    // #23：26 兰州（牛肉面）/ 39 维港（夜景）原地改造成高铁枢纽，地图开始依赖 rail-hub@1。
    expect(chinaTourMap.game.requiredRuleModules).toEqual([
      { id: 'core', version: 1 },
      { id: 'rail-hub', version: 1 },
    ]);
    // metadata.title（公开名称）与 board.boardName（棋盘中央标题）的双标题边界
    expect(chinaTourMap.game.board.boardName).toBe('大富翁·中国之旅');
  });

  it('game data 精确来自地图版本目录', () => {
    expect(chinaTourMap.game.board).toEqual(mapBoard);
    expect(chinaTourMap.game.cards).toEqual(mapCards);
    expect(chinaTourMap.game.config).toEqual(mapConfig);
  });

  it('61 格 presentation 一一覆盖当前短名、图标和地产色带', () => {
    const boardCells = chinaTourMap.game.board.cells;
    const presentationIds = Object.keys(chinaTourMap.presentation.cells).map(Number).sort((a, b) => a - b);
    expect(presentationIds).toEqual(boardCells.map((cell) => cell.id).sort((a, b) => a - b));
    expect(presentationIds).toHaveLength(61);

    for (const cell of boardCells) {
      const presentation = chinaTourMap.presentation.cells[cell.id]!;
      expect(presentation.shortLabel, `cell ${cell.id} shortLabel`).toBe(expectedShortLabel(cell));
      expect(presentation.artwork?.type === 'built-in-icon' ? presentation.artwork.icon : undefined,
        `cell ${cell.id} icon`).toBe(expectedIcon(cell));
      expect(presentation.propertyBand, `cell ${cell.id} propertyBand`).toBe(expectedBand(cell));
    }
  });

  it('保留 14×14 非均匀外环与 9 格支线坐标', () => {
    expect(chinaTourMap.presentation.canvas).toEqual({ size: 100 });
    expect(chinaTourMap.presentation.cells[0]).toMatchObject({
      x: 88.961039, y: 88.961039, width: 11.038961, height: 11.038961,
    });
    expect(chinaTourMap.presentation.cells[13]).toMatchObject({
      x: 0, y: 88.961039, width: 11.038961, height: 11.038961,
    });
    expect(chinaTourMap.presentation.cells[26]).toMatchObject({
      x: 0, y: 0, width: 11.038961, height: 11.038961,
    });
    expect(chinaTourMap.presentation.cells[39]).toMatchObject({
      x: 88.961039, y: 0, width: 11.038961, height: 11.038961,
    });
    expect(chinaTourMap.presentation.cells[52]).toMatchObject({ x: 9.8, y: 81.8, width: 8.4, height: 8.4 });
    expect(chinaTourMap.presentation.cells[60]).toMatchObject({ x: 80.2, y: 11.4, width: 8.4, height: 8.4 });
  });

  it('保留支线路径、中央面板、旋转题字与主题', () => {
    expect(chinaTourMap.presentation.routes).toEqual([{
      type: 'polyline',
      points: [
        { x: 14, y: 86 }, { x: 22.8, y: 77.2 }, { x: 31.6, y: 68.4 },
        { x: 40.4, y: 59.6 }, { x: 49.2, y: 50.8 }, { x: 58, y: 42 },
        { x: 66.8, y: 33.2 }, { x: 75.6, y: 24.4 }, { x: 84.4, y: 15.6 },
      ],
      role: 'route',
      strokeWidth: 1.1,
      dashPattern: [2.6, 2.2],
      lineCap: 'round',
      opacity: 0.8,
      zIndex: 4,
    }]);
    expect(chinaTourMap.presentation.center).toContainEqual(expect.objectContaining({
      type: 'panel', role: 'center', zIndex: 1,
    }));
    expect(chinaTourMap.presentation.center).toContainEqual(expect.objectContaining({
      type: 'text', role: 'title', text: '中国之旅', rotation: -8, zIndex: 6,
    }));
    expect(chinaTourMap.presentation.theme.colors).toMatchObject({
      board: '#dfd4c1', route: '#8a5b2d', title: '#7b2417', center: '#fff7ea',
    });
    expect(Object.keys(chinaTourMap.presentation.theme.propertyBands)).toHaveLength(10);
  });

  it('manifest contentHash 与完整 MapPack canonical 内容一致且可重复', () => {
    const first = computeContentHash(chinaTourMap);
    const second = computeContentHash(chinaTourMap);
    expect(first).toBe(chinaTourMap.ref.contentHash);
    expect(second).toBe(first);
  });

  it('loader 返回递归冻结且不会被 hash 过程修改的 MapPack', () => {
    const before = JSON.stringify(chinaTourMap);
    expectDeepFrozen(chinaTourMap);
    computeContentHash(chinaTourMap);
    expect(JSON.stringify(chinaTourMap)).toBe(before);
  });
});
