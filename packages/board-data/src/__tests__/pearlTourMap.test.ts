import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeContentHash } from '../hash';
import { assertValidMapPack } from '../mapValidation';
import { pearlTourMap } from '../pearlTourMap';

const mapDirectory = new URL('../../maps/pearl-tour/v1/', import.meta.url);

const coreModule = { id: 'core', version: 1 } as const;
const portTradeModule = { id: 'port-trade', version: 1 } as const;

function readMapJson(fileName: string): any {
  const fileUrl = new URL(fileName, mapDirectory);
  expect(existsSync(fileUrl), `pearl-tour/v1/${fileName} must exist`).toBe(true);
  return JSON.parse(readFileSync(fileUrl, 'utf8'));
}

const CANVAS = 100;
const CELL = 5;
const CELL_HEIGHT = 5;
/** 每条边各 17 格（含两端顶点）。 */
const PER_EDGE = 17;
/** 三角形三个顶点的格中心坐标。 */
const APEX = { x: 50, y: 6.5 };
const LEFT = { x: 5.5, y: 92 };
const RIGHT = { x: 94.5, y: 92 };

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

/**
 * 三角形环路走位：底边（左下→右下）→ 右边缘（右下→顶点）→ 左边缘（顶点→左下）。
 * 三条边首尾相接，共 17*3 - 3（三个顶点各被两条边共用）= 48 格。
 */
function trianglePath(): { x: number; y: number }[] {
  const path: { x: number; y: number }[] = [];
  for (let index = 0; index < PER_EDGE; index += 1) {
    const t = index / (PER_EDGE - 1);
    path.push({ x: round(LEFT.x + (RIGHT.x - LEFT.x) * t), y: round(LEFT.y) });
  }
  for (let step = 1; step <= PER_EDGE - 1; step += 1) {
    const t = step / (PER_EDGE - 1);
    path.push({
      x: round(RIGHT.x + (APEX.x - RIGHT.x) * t),
      y: round(RIGHT.y + (APEX.y - RIGHT.y) * t),
    });
  }
  for (let step = 1; step <= PER_EDGE - 2; step += 1) {
    const t = step / (PER_EDGE - 1);
    path.push({
      x: round(APEX.x + (LEFT.x - APEX.x) * t),
      y: round(APEX.y + (LEFT.y - APEX.y) * t),
    });
  }
  return path;
}

const path = trianglePath();

function expectedPlacement(id: number) {
  const point = path[id]!;
  return { x: point.x, y: point.y, width: CELL, height: CELL_HEIGHT };
}

describe('pearl-tour@1 approved source data', () => {
  it('locks the 48-cell delta triangle from 珠江口 round to 珠江源 and back', () => {
    const board = readMapJson('board.json');

    expect(path).toHaveLength(48);
    expect(new Set(path.map((entry) => `${entry.x},${entry.y}`)).size).toBe(48);
    expect(board.cells).toHaveLength(48);
    expect(board.cells.map((cell: { id: number }) => cell.id)).toEqual(
      Array.from({ length: 48 }, (_, index) => index),
    );
    expect(board.cells[0]).toMatchObject({ id: 0, type: 'start', name: '起点' });
    expect(board.cells[32]).toMatchObject({ id: 32, name: '珠江源' });
    expect(board.cells[47]).toMatchObject({ id: 47, name: '封开', nextId: 0 });
    expect(board.cells[board.cells.length - 1].nextId).toBe(0);
    // 除了末格显式折回起点，其余格沿数组顺序前进。
    expect(
      board.cells
        .filter((cell: { id: number }) => cell.id !== 47)
        .every((cell: { nextId?: number }) => cell.nextId === undefined),
    ).toBe(true);
    expect(board.boardName).toBe('大富翁·珠江之旅');
  });

  it('lays out a triangular loop whose three edges stay inside the canvas', () => {
    const board = readMapJson('board.json');
    const manifest = readMapJson('manifest.json');

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

    expect(
      board.cells.every((cell: { id: number }) => {
        const placement = manifest.presentation.cells[cell.id];
        return placement.x >= 0
          && placement.y >= 0
          && placement.x + placement.width <= CANVAS
          && placement.y + placement.height <= CANVAS;
      }),
    ).toBe(true);

    // 三角形签名：底边在最低行（y 恒定）、顶点在上方正中、左/右两条斜边逐格向顶点收拢。
    const placements = board.cells.map((cell: { id: number }) => manifest.presentation.cells[cell.id]);
    expect(new Set(placements.slice(0, PER_EDGE).map((placement: { y: number }) => placement.y)).size).toBe(1);
    expect(placements[16].x).toBeGreaterThan(placements[0].x);
    expect(placements[32]).toMatchObject({ x: APEX.x, y: APEX.y });
    // 右边缘自右下角向顶点收拢：顶点在最左（x 最小），左边缘再向下方折返。
    expect(placements[32].x).toBeLessThan(placements[17].x);
    expect(placements[32].x).toBeGreaterThan(placements[33].x);
    // 顶点是全图最高的一格，底边是最低的一格。
    expect(Math.min(...placements.map((placement: { y: number }) => placement.y))).toBe(APEX.y);
    expect(Math.max(...placements.map((placement: { y: number }) => placement.y))).toBe(LEFT.y);
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

    expect(normalProperties).toHaveLength(30);
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

  it('names all four ferries and both hydro utilities after real Pearl River crossings', () => {
    const board = readMapJson('board.json');
    const stations = board.cells.filter((cell: any) => cell.subtype === 'station');
    const utilities = board.cells.filter((cell: any) => cell.subtype === 'utility');

    expect(stations.map((cell: any) => ({ id: cell.id, name: cell.name }))).toEqual([
      { id: 8, name: '虎门渡' },
      { id: 22, name: '东江渡' },
      { id: 36, name: '大藤峡渡' },
      { id: 45, name: '梧州渡' },
    ]);
    expect(utilities.map((cell: any) => ({ id: cell.id, name: cell.name, price: cell.price }))).toEqual([
      { id: 12, name: '珠江船闸', price: 1500 },
      { id: 40, name: '右江电站', price: 1500 },
    ]);
  });

  it('requires price to equal exactly twice the mortgage for all 36 purchasable cells', () => {
    const board = readMapJson('board.json');
    const purchasable = board.cells.filter((cell: any) => cell.type === 'property');

    expect(purchasable).toHaveLength(36);
    expect(purchasable.every((cell: any) => cell.price === cell.mortgageValue * 2)).toBe(true);
  });

  it('escalates land value from the delta up to the source, then eases back down the west river', () => {
    const board = readMapJson('board.json');
    const normal = board.cells.filter(
      (cell: any) => cell.type === 'property' && cell.subtype === 'normal',
    );
    const priceOf = (id: number) => board.cells[id].price as number;

    // 珠江口最平、珠江源最贵：三角形「登源」路线才有经济含义。
    expect(board.cells[1]).toMatchObject({ name: '珠海', price: 1600, houseCost: 1000 });
    expect(board.cells[32]).toMatchObject({
      name: '珠江源',
      price: 4500,
      houseCost: 3000,
      mortgageValue: 2250,
      rents: [600, 2400, 7000, 16000, 19000, 22500],
    });
    // 右边缘（东江北上）地价单调不降。
    const eastClimb = [17, 19, 20, 21, 23, 25, 27, 28, 29, 30, 31, 32].map(priceOf);
    expect(eastClimb).toEqual([...eastClimb].sort((left, right) => left - right));
    // 左边缘（西江回落）地价单调不增。
    const westDescent = [33, 34, 37, 39, 42, 44, 47].map(priceOf);
    expect(westDescent).toEqual([...westDescent].sort((left, right) => right - left));
    expect(new Set(normal.map((cell: any) => cell.price as number)).size).toBe(13);
  });

  it('spreads 3 chance / 4 destiny / 2 tax / 2 port cells and never lets two events touch', () => {
    const board = readMapJson('board.json');
    const byType = (type: string) => board.cells.filter((cell: any) => cell.type === type);

    expect(byType('start')).toHaveLength(1);
    expect(byType('chance')).toHaveLength(3);
    expect(byType('destiny')).toHaveLength(4);
    expect(byType('tax')).toHaveLength(2);
    // #23：16 台风过境 / 35 天生桥险滩原地改造成 port-trade@1 的 port 格，special 归零。
    expect(byType('special')).toHaveLength(0);
    expect(byType('module')).toHaveLength(2);

    // board 来自 JSON.parse（any），这里显式标注数组类型，否则下面 map 的回调参数会退化成隐式 any。
    const eventIds: number[] = board.cells
      .filter((cell: any) => cell.type !== 'property' && cell.type !== 'start')
      .map((cell: any) => cell.id as number);
    expect(eventIds).toEqual([4, 14, 16, 18, 24, 26, 35, 38, 41, 43, 46]);
    // 事件格不贴在一起，保证走一格就有事发生、不会连续空转（环首尾也一并检查）。
    const gaps = eventIds.slice(1).map((id, index) => id - eventIds[index]!);
    gaps.push(48 - eventIds.at(-1)! + eventIds[0]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(2);

    expect(byType('tax').every((cell: any) => cell.amount === 1000)).toBe(true);
    expect(byType('module').map((cell: any) => ({
      id: cell.id,
      name: cell.name,
      module: cell.module,
      cellType: cell.cellType,
      payload: cell.payload,
    }))).toEqual([
      { id: 16, name: '台风过境', module: portTradeModule, cellType: 'port', payload: {} },
      { id: 35, name: '天生桥险滩', module: portTradeModule, cellType: 'port', payload: {} },
    ]);
  });

  it('declares 12 chance and 14 destiny cards, with a ferry warp that targets a real station', () => {
    const cards = readMapJson('cards.json');
    const board = readMapJson('board.json');

    expect(cards.chance).toHaveLength(12);
    expect(cards.destiny).toHaveLength(14);
    expect(cards.chance.map((card: any) => card.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `zj-c${String(index + 1).padStart(2, '0')}`),
    );
    expect(cards.destiny.map((card: any) => card.id)).toEqual(
      Array.from({ length: 14 }, (_, index) => `zj-d${String(index + 1).padStart(2, '0')}`),
    );
    // 命运卡里的传送目标必须真的是一格渡口，否则「快马传讯」会把玩家丢到空地上。
    expect(cards.destiny.find((card: any) => card.id === 'zj-d03').effect).toEqual({
      type: 'move_to',
      cellId: 8,
      collectSalary: true,
    });
    expect(board.cells[8]).toMatchObject({ subtype: 'station', name: '虎门渡' });
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

  it('stays on core@1 + port-trade@1, with one presentation per cell and a 48-point triangle route', () => {
    const manifest = readMapJson('manifest.json');
    const board = readMapJson('board.json');
    const route = manifest.presentation.routes.find((entry: any) => entry.role === 'route');

    expect(manifest.ref.id).toBe('pearl-tour');
    expect(manifest.ref.version).toBe(1);
    expect(manifest.ref.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.metadata.title).toBe('珠江之旅');
    // #23：两个口岸格由 port-trade@1 结算，地图声明依赖 core@1 + port-trade@1。
    expect(manifest.requiredRuleModules).toEqual([coreModule, portTradeModule]);
    expect(Object.keys(manifest.presentation.cells).map(Number).sort((a, b) => a - b)).toEqual(
      board.cells.map((cell: { id: number }) => cell.id).sort((a: number, b: number) => a - b),
    );
    expect(route.type).toBe('polyline');
    expect(route.points).toHaveLength(48);
    expect(manifest.presentation.center).toHaveLength(2);
    // 八色带 = 三角洲 + 中国香港 + 中国澳门 + 北江上游 + 珠江源 + 西江 + 渡口 + 水利，各自一色。
    expect(Object.keys(manifest.presentation.theme.propertyBands)).toEqual([
      'band:delta',
      'band:hongkong',
      'band:macao',
      'band:beijiang',
      'band:source',
      'band:xijiang',
      'band:ferry',
      'band:utility',
    ]);
  });

  it('is a deeply frozen valid immutable map pack whose hash matches its own bytes', () => {
    expect(() => assertValidMapPack(pearlTourMap, [coreModule, portTradeModule])).not.toThrow();
    expect(computeContentHash(pearlTourMap)).toBe(pearlTourMap.ref.contentHash);
    expect(pearlTourMap.ref.contentHash)
      .toBe('6fca0225a90fcdfa8f56459a9258177d6a5125d227a8231fbea9615a96373469');
    expect(Object.isFrozen(pearlTourMap)).toBe(true);
    expect(Object.isFrozen(pearlTourMap.game.board.cells)).toBe(true);
    expect(Object.isFrozen(pearlTourMap.game.cards.destiny[2]!.effect)).toBe(true);
    expect(Object.isFrozen(pearlTourMap.presentation.cells[32]!)).toBe(true);
  });
});
