import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeContentHash } from '../hash';
import { assertValidMapPack } from '../mapValidation';
import { yellowRiverMap } from '../yellowRiverMap';

const mapDirectory = new URL('../../maps/yellow-river/v1/', import.meta.url);

const coreModule = { id: 'core', version: 1 } as const;
const riverTideModule = { id: 'river-tide', version: 1 } as const;

function readMapJson(fileName: string): any {
  const fileUrl = new URL(fileName, mapDirectory);
  expect(existsSync(fileUrl), `yellow-river/v1/${fileName} must exist`).toBe(true);
  return JSON.parse(readFileSync(fileUrl, 'utf8'));
}

const SIZE = 8;
const CELL = 10;
const STEP = 12;
const ORIGIN = 3;
const CANVAS = 100;

/** 螺旋走位：外圈顺时针绕满一圈再向内进一格，共 8×8 格，最后一格落在棋盘中心。 */
function spiralRing(size: number): [number, number][] {
  const result: [number, number][] = [];
  let top = 0;
  let bottom = size - 1;
  let left = 0;
  let right = size - 1;
  while (top <= bottom && left <= right) {
    for (let col = left; col <= right; col += 1) result.push([top, col]);
    top += 1;
    for (let row = top; row <= bottom; row += 1) result.push([row, right]);
    right -= 1;
    if (top <= bottom) {
      for (let col = right; col >= left; col -= 1) result.push([bottom, col]);
      bottom -= 1;
    }
    if (left <= right) {
      for (let row = bottom; row >= top; row -= 1) result.push([row, left]);
      left += 1;
    }
  }
  return result;
}

const spiralPath = spiralRing(SIZE);

/** 螺旋几何：沿螺旋走位取行列，再乘步长铺开。 */
function expectedPlacement(id: number) {
  const [row, col] = spiralPath[id]!;
  return { x: ORIGIN + col * STEP, y: ORIGIN + row * STEP, width: CELL, height: CELL };
}

describe('yellow-river@1 approved source data', () => {
  it('locks the 64-cell inward spiral from 入海口 to 河源', () => {
    const board = readMapJson('board.json');

    expect(spiralPath).toHaveLength(64);
    expect(new Set(spiralPath.map((entry) => entry.join(','))).size).toBe(64);
    expect(board.cells).toHaveLength(64);
    expect(board.cells.map((cell: { id: number }) => cell.id)).toEqual(
      Array.from({ length: 64 }, (_, index) => index),
    );
    expect(board.cells[0]).toMatchObject({ id: 0, type: 'start', name: '起点' });
    expect(board.cells[63]).toMatchObject({ id: 63, name: '鄂陵湖', nextId: 0 });
    expect(board.cells[board.cells.length - 1].nextId).toBe(0);
    // 除了末格显式折回起点，其余格沿数组顺序前进。
    expect(
      board.cells
        .filter((cell: { id: number }) => cell.id !== 63)
        .every((cell: { nextId?: number }) => cell.nextId === undefined),
    ).toBe(true);
    expect(board.boardName).toBe('大富翁·黄河之旅');
  });

  it('lays out an 8×8 spiral that ends exactly on the board centre', () => {
    const board = readMapJson('board.json');
    const manifest = readMapJson('manifest.json');
    const centre = CANVAS / 2;

    expect(manifest.presentation.canvas).toEqual({ size: CANVAS });
    expect(
      board.cells.map((cell: { id: number }) => {
        const placement = manifest.presentation.cells[cell.id];
        return {
          id: cell.id,
          x: placement.x,
          y: placement.y,
          width: placement.width,
          height: placement.height,
        };
      }),
    ).toEqual(board.cells.map((cell: { id: number }) => ({ id: cell.id, ...expectedPlacement(cell.id) })));

    // 每格都必须落在画布内（含右边与下边）。
    expect(
      board.cells.every((cell: { id: number }) => {
        const placement = manifest.presentation.cells[cell.id];
        return placement.x >= 0
          && placement.y >= 0
          && placement.x + placement.width <= CANVAS
          && placement.y + placement.height <= CANVAS;
      }),
    ).toBe(true);

    // 螺旋的验收点：终点比任何其它格都更靠近棋盘中心。
    const radialDistance = (id: number) => {
      const placement = manifest.presentation.cells[id];
      return Math.max(
        Math.abs(placement.x + placement.width / 2 - centre),
        Math.abs(placement.y + placement.height / 2 - centre),
      );
    };
    const centreCell = 63;
    expect(board.cells.every(
      (cell: { id: number }) => radialDistance(cell.id) >= radialDistance(centreCell),
    )).toBe(true);
    // 外圈四角与入海口都贴在画布外沿，确认不是「缩在中间的一小团」。
    expect(board.cells.filter((cell: { id: number }) => radialDistance(cell.id) === CANVAS / 2 - ORIGIN - CELL / 2))
      .toHaveLength(28);
  });

  it('keeps six rent tiers for every normal property and four for every station', () => {
    const board = readMapJson('board.json');
    const normalProperties = board.cells.filter(
      (cell: any) => cell.type === 'property' && cell.subtype === 'normal',
    );
    const stations = board.cells.filter(
      (cell: any) => cell.type === 'property' && cell.subtype === 'station',
    );
    const utilities = board.cells.filter(
      (cell: any) => cell.type === 'property' && cell.subtype === 'utility',
    );

    expect(normalProperties).toHaveLength(43);
    expect(stations).toHaveLength(4);
    expect(utilities).toHaveLength(2);
    expect(normalProperties.every((cell: any) => cell.rents.length === 6)).toBe(true);
    // 仓库硬约束：渡口的租金档数必须等于全图渡口总数（4），不是固定值。
    expect(stations.every((cell: any) => cell.rents.length === stations.length)).toBe(true);
    expect(utilities.every((cell: any) => cell.rents === undefined)).toBe(true);
    expect(normalProperties.every((cell: any) => cell.houseCost > 0)).toBe(true);
    expect(stations.every((cell: any) => cell.houseCost === undefined)).toBe(true);
    expect(utilities.every((cell: any) => cell.houseCost === undefined)).toBe(true);
  });

  it('names all four ferries and both hydro utilities after real Yellow River crossings', () => {
    const board = readMapJson('board.json');
    const stations = board.cells.filter((cell: any) => cell.subtype === 'station');
    const utilities = board.cells.filter((cell: any) => cell.subtype === 'utility');

    expect(stations.map((cell: any) => ({ id: cell.id, name: cell.name }))).toEqual([
      { id: 2, name: '泺口渡' },
      { id: 13, name: '茅津渡' },
      { id: 15, name: '风陵渡' },
      { id: 44, name: '兰州渡' },
    ]);
    expect(utilities.map((cell: any) => ({ id: cell.id, name: cell.name, price: cell.price }))).toEqual([
      { id: 36, name: '羊皮筏子', price: 1500 },
      { id: 56, name: '龙羊峡电站', price: 1500 },
    ]);
  });

  it('requires price to equal exactly twice the mortgage for all 49 purchasable cells', () => {
    const board = readMapJson('board.json');
    const purchasable = board.cells.filter((cell: any) => cell.type === 'property');

    expect(purchasable).toHaveLength(49);
    expect(purchasable.every((cell: any) => cell.price === cell.mortgageValue * 2)).toBe(true);
  });

  it('escalates land value from the estuary upstream to the source', () => {
    const board = readMapJson('board.json');
    const normal = board.cells.filter(
      (cell: any) => cell.type === 'property' && cell.subtype === 'normal',
    );

    // 起点侧最便宜、源头侧最贵：越往里走地价越高，螺旋的「收束」才有经济含义。
    expect(normal[0]).toMatchObject({ name: '济南', price: 1800, houseCost: 1000 });
    expect(board.cells[63]).toMatchObject({
      name: '鄂陵湖',
      price: 4500,
      houseCost: 2500,
      mortgageValue: 2250,
      rents: [600, 2400, 7000, 16000, 19000, 22500],
    });
    const prices = normal.map((cell: any) => cell.price as number);
    expect(prices).toEqual([...prices].sort((left, right) => left - right));
    expect(new Set(prices).size).toBe(11);
  });

  it('spreads 4 chance / 4 destiny / 2 tax / 4 河工 cells and never doubles up', () => {
    const board = readMapJson('board.json');
    const byType = (type: string) => board.cells.filter((cell: any) => cell.type === type);

    expect(byType('start')).toHaveLength(1);
    expect(byType('chance')).toHaveLength(4);
    expect(byType('destiny')).toHaveLength(4);
    expect(byType('tax')).toHaveLength(2);
    // #23：8 凌汛封河 / 24 决口抢险 / 42 河道断流 / 57 引黄灌溉原地改造成 river-tide@1 的河工格。
    expect(byType('special')).toHaveLength(0);
    expect(byType('module')).toHaveLength(4);
    // 事件格之间不贴在一起，保证走一格就有事发生、不会连续空转。
    const eventIds = board.cells
      .filter((cell: any) => cell.type !== 'property' && cell.type !== 'start')
      .map((cell: any) => cell.id as number);
    expect(eventIds).toEqual([4, 8, 11, 16, 20, 24, 27, 38, 42, 45, 48, 54, 57, 60]);
    expect(byType('tax').every((cell: any) => cell.amount === 1000)).toBe(true);
    expect(byType('module').map((cell: any) => ({
      id: cell.id,
      name: cell.name,
      module: cell.module,
      cellType: cell.cellType,
      payload: cell.payload,
    }))).toEqual([
      { id: 8, name: '凌汛封河', module: riverTideModule, cellType: 'river-works', payload: {} },
      { id: 24, name: '决口抢险', module: riverTideModule, cellType: 'river-works', payload: {} },
      { id: 42, name: '河道断流', module: riverTideModule, cellType: 'river-works', payload: {} },
      { id: 57, name: '引黄灌溉', module: riverTideModule, cellType: 'river-works', payload: {} },
    ]);
  });

  it('declares 12 chance and 14 destiny cards, with a ferry warp that targets a real station', () => {
    const cards = readMapJson('cards.json');
    const board = readMapJson('board.json');

    expect(cards.chance).toHaveLength(12);
    expect(cards.destiny).toHaveLength(14);
    expect(cards.chance.map((card: any) => card.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `yr-c${String(index + 1).padStart(2, '0')}`),
    );
    expect(cards.destiny.map((card: any) => card.id)).toEqual(
      Array.from({ length: 14 }, (_, index) => `yr-d${String(index + 1).padStart(2, '0')}`),
    );
    // 命运卡里的传送目标必须真的是一格渡口，否则「快马传讯」会把玩家丢到空地上。
    expect(cards.destiny.find((card: any) => card.id === 'yr-d03').effect).toEqual({
      type: 'move_to',
      cellId: 44,
      collectSalary: true,
    });
    expect(board.cells[44]).toMatchObject({ subtype: 'station', name: '兰州渡' });
  });

  it('locks the owner-approved game config with maxHouseLevel 5', () => {
    expect(readMapJson('game-config.json')).toEqual({
      initialCash: 15000,
      passStartSalary: 2000,
      maxHouseLevel: 5,
      sellHouseRefundRate: 0.5,
      sellLandRate: 0.5,
      mortgageInterestRate: 0.1,
      utilityMultipliers: [10, 100],
      jailExitMinRoll: 10,
      jailMaxAttempts: 3,
      cashGoalPresets: [30000, 50000],
      diceMode: 'two_dice',
      airportBranchDice: 1,
      jailEnabled: false,
    });
  });

  it('stays on core@1 + river-tide@1, with one presentation per cell and a 64-point spiral route', () => {
    const manifest = readMapJson('manifest.json');
    const board = readMapJson('board.json');
    const route = manifest.presentation.routes.find((entry: any) => entry.role === 'route');

    expect(manifest.ref.id).toBe('yellow-river');
    expect(manifest.ref.version).toBe(1);
    expect(manifest.ref.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.metadata.title).toBe('黄河之旅');
    // #23：四格河工由 river-tide@1 结算，并靠 positiveRentHook 按水位改写地产租金。
    expect(manifest.requiredRuleModules).toEqual([coreModule, riverTideModule]);
    expect(Object.keys(manifest.presentation.cells).map(Number).sort((a, b) => a - b)).toEqual(
      board.cells.map((cell: { id: number }) => cell.id).sort((a: number, b: number) => a - b),
    );
    expect(route.type).toBe('polyline');
    expect(route.points).toHaveLength(64);
    expect(manifest.presentation.center).toEqual([]);
    // 八条带 = 黄河干流自上而下经过的八个省区，每个省区一色。
    expect(Object.keys(manifest.presentation.theme.propertyBands)).toEqual([
      'band:shandong',
      'band:henan',
      'band:shanxi',
      'band:shaanxi',
      'band:inner-mongolia',
      'band:ningxia',
      'band:gansu',
      'band:qinghai',
      'band:station',
      'band:utility',
    ]);
  });

  it('is a deeply frozen valid immutable map pack whose hash matches its own bytes', () => {
    expect(() => assertValidMapPack(yellowRiverMap, [coreModule, riverTideModule])).not.toThrow();
    expect(computeContentHash(yellowRiverMap)).toBe(yellowRiverMap.ref.contentHash);
    expect(yellowRiverMap.ref.contentHash)
      .toBe('21dcfca118da28c5882be3b7bf3a7ee6c365581414f67fa621657e0c59747fee');
    expect(Object.isFrozen(yellowRiverMap)).toBe(true);
    expect(Object.isFrozen(yellowRiverMap.game.board.cells)).toBe(true);
    expect(Object.isFrozen(yellowRiverMap.game.cards.destiny[2]!.effect)).toBe(true);
    expect(Object.isFrozen(yellowRiverMap.presentation.cells[13]!)).toBe(true);
  });
});
