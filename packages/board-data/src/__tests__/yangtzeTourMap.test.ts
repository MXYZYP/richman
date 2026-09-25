import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeContentHash } from '../hash';
import { assertValidMapPack } from '../mapValidation';
import { yangtzeTourMap } from '../yangtzeTourMap';

const mapDirectory = new URL('../../maps/yangtze-tour/v1/', import.meta.url);

const coreModule = { id: 'core', version: 1 } as const;
const yangtzeFerryModule = { id: 'yangtze-ferry', version: 1 } as const;

function readMapJson(fileName: string): any {
  const fileUrl = new URL(fileName, mapDirectory);
  expect(existsSync(fileUrl), `yangtze-tour/v1/${fileName} must exist`).toBe(true);
  return JSON.parse(readFileSync(fileUrl, 'utf8'));
}

const COLS = 6;
const ROWS = 9;
const CELL = 12;
const CELL_HEIGHT = 8;
const STEP_X = 16;
const STEP_Y = 11;
const ORIGIN_X = 4;
const ORIGIN_Y = 2;
const CANVAS = 100;

/**
 * 纵向蛇形走位：沿一列自上而下走满，再在下一列自下而上折回，共 6×9 格。
 * 与横向蛇行（great-wall）的区别在于「行内横移、列间折返」，因此整张图是竖向铺开的。
 */
function columnSnake(path: [number, number][] = [], rows = ROWS): [number, number][] {
  for (let col = 0; col < COLS; col += 1) {
    for (let step = 0; step < rows; step += 1) {
      path.push([col % 2 === 0 ? step : rows - 1 - step, col]);
    }
  }
  return path;
}

const snakePath = columnSnake();

/** 蛇形几何：沿走位取行列，再乘步长铺开。 */
function expectedPlacement(id: number) {
  const [row, col] = snakePath[id]!;
  return {
    x: ORIGIN_X + col * STEP_X,
    y: ORIGIN_Y + row * STEP_Y,
    width: CELL,
    height: CELL_HEIGHT,
  };
}

describe('yangtze-tour@1 approved source data', () => {
  it('locks the 54-cell column snake from 入海口 to 江源', () => {
    const board = readMapJson('board.json');

    expect(snakePath).toHaveLength(54);
    expect(new Set(snakePath.map((entry) => entry.join(','))).size).toBe(54);
    expect(board.cells).toHaveLength(54);
    expect(board.cells.map((cell: { id: number }) => cell.id)).toEqual(
      Array.from({ length: 54 }, (_, index) => index),
    );
    expect(board.cells[0]).toMatchObject({ id: 0, type: 'start', name: '起点' });
    expect(board.cells[53]).toMatchObject({ id: 53, name: '各拉丹冬', nextId: 0 });
    expect(board.cells[board.cells.length - 1].nextId).toBe(0);
    // 除了末格显式折回起点，其余格沿数组顺序前进。
    expect(
      board.cells
        .filter((cell: { id: number }) => cell.id !== 53)
        .every((cell: { nextId?: number }) => cell.nextId === undefined),
    ).toBe(true);
    expect(board.boardName).toBe('大富翁·长江之旅');
  });

  it('lays out a 6×9 column snake that stays inside the canvas', () => {
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

    // 蛇形签名：同一列 x 恒定，列号越大 x 越大；列内 y 逐格走满 9 行后才折返。
    const placements = board.cells.map((cell: { id: number }) => manifest.presentation.cells[cell.id]);
    expect(new Set(placements.map((placement: { x: number }) => placement.x))).toEqual(
      new Set([4, 20, 36, 52, 68, 84]),
    );
    const columnOf = (id: number) => Math.floor(id / ROWS);
    expect(placements.every((placement: { x: number }, id: number) => placement.x === 4 + columnOf(id) * STEP_X))
      .toBe(true);
    // 首尾两列方向相反（偶数列下行、奇数列上行），这是「蛇行」而不是「逐列复读」的证据。
    expect(placements[0].y).toBeLessThan(placements[1].y);
    expect(placements[ROWS]!.y).toBeGreaterThan(placements[ROWS + 1]!.y);
    expect(new Set(placements.map((placement: { y: number }) => placement.y)).size).toBe(ROWS);
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

    expect(normalProperties).toHaveLength(35);
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

  it('names all four ferries and both hydro utilities after real Yangtze crossings', () => {
    const board = readMapJson('board.json');
    const stations = board.cells.filter((cell: any) => cell.subtype === 'station');
    const utilities = board.cells.filter((cell: any) => cell.subtype === 'utility');

    expect(stations.map((cell: any) => ({ id: cell.id, name: cell.name }))).toEqual([
      { id: 7, name: '江阴渡' },
      { id: 21, name: '湖口渡' },
      { id: 31, name: '城陵矶渡' },
      { id: 48, name: '金沙江渡' },
    ]);
    expect(utilities.map((cell: any) => ({ id: cell.id, name: cell.name, price: cell.price }))).toEqual([
      { id: 12, name: '江都水利枢纽', price: 1500 },
      { id: 40, name: '三峡电站', price: 1500 },
    ]);
  });

  it('requires price to equal exactly twice the mortgage for all 41 purchasable cells', () => {
    const board = readMapJson('board.json');
    const purchasable = board.cells.filter((cell: any) => cell.type === 'property');

    expect(purchasable).toHaveLength(41);
    expect(purchasable.every((cell: any) => cell.price === cell.mortgageValue * 2)).toBe(true);
  });

  it('escalates land value from the estuary upstream to the source', () => {
    const board = readMapJson('board.json');
    const normal = board.cells.filter(
      (cell: any) => cell.type === 'property' && cell.subtype === 'normal',
    );

    // 入海口最便宜、江源最贵：越往上走地价越高，蛇行的「溯源」才有经济含义。
    expect(normal[0]).toMatchObject({ name: '上海', price: 1800, houseCost: 1000 });
    expect(board.cells[53]).toMatchObject({
      name: '各拉丹冬',
      price: 4500,
      houseCost: 2500,
      mortgageValue: 2250,
      rents: [600, 2400, 7000, 16000, 19000, 22500],
    });
    const prices = normal.map((cell: any) => cell.price as number);
    expect(prices).toEqual([...prices].sort((left, right) => left - right));
    expect(new Set(prices).size).toBe(11);
  });

  it('spreads 3 chance / 4 destiny / 2 tax / 3 special cells and never lets two events touch', () => {
    const board = readMapJson('board.json');
    const byType = (type: string) => board.cells.filter((cell: any) => cell.type === type);

    expect(byType('start')).toHaveLength(1);
    expect(byType('chance')).toHaveLength(3);
    expect(byType('destiny')).toHaveLength(4);
    expect(byType('tax')).toHaveLength(2);
    // #23：15 皖江洪峰 / 33 三峡船闸检修 / 50 虎跳峡险滩原地改造成 yangtze-ferry@1 的渡口格。
    expect(byType('special')).toHaveLength(0);
    expect(byType('module')).toHaveLength(3);

    // board 来自 JSON.parse（any），这里显式标注数组类型，否则下面 map 的回调参数会退化成隐式 any。
    const eventIds: number[] = board.cells
      .filter((cell: any) => cell.type !== 'property' && cell.type !== 'start')
      .map((cell: any) => cell.id as number);
    expect(eventIds).toEqual([4, 10, 15, 19, 24, 27, 33, 36, 41, 46, 50, 52]);
    // 事件格不贴在一起，保证走一格就有事发生、不会连续空转。
    const gaps = eventIds.slice(1).map((id, index) => id - eventIds[index]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(2);

    expect(byType('tax').every((cell: any) => cell.amount === 1000)).toBe(true);
    expect(byType('module').map((cell: any) => ({
      id: cell.id,
      name: cell.name,
      module: cell.module,
      cellType: cell.cellType,
      payload: cell.payload,
    }))).toEqual([
      { id: 15, name: '皖江洪峰', module: yangtzeFerryModule, cellType: 'ferry', payload: {} },
      { id: 33, name: '三峡船闸检修', module: yangtzeFerryModule, cellType: 'ferry', payload: {} },
      { id: 50, name: '虎跳峡险滩', module: yangtzeFerryModule, cellType: 'ferry', payload: {} },
    ]);
  });

  it('declares 12 chance and 14 destiny cards, with a ferry warp that targets a real station', () => {
    const cards = readMapJson('cards.json');
    const board = readMapJson('board.json');

    expect(cards.chance).toHaveLength(12);
    expect(cards.destiny).toHaveLength(14);
    expect(cards.chance.map((card: any) => card.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `yz-c${String(index + 1).padStart(2, '0')}`),
    );
    expect(cards.destiny.map((card: any) => card.id)).toEqual(
      Array.from({ length: 14 }, (_, index) => `yz-d${String(index + 1).padStart(2, '0')}`),
    );
    // 命运卡里的传送目标必须真的是一格渡口，否则「快马传讯」会把玩家丢到空地上。
    expect(cards.destiny.find((card: any) => card.id === 'yz-d03').effect).toEqual({
      type: 'move_to',
      cellId: 31,
      collectSalary: true,
    });
    expect(board.cells[31]).toMatchObject({ subtype: 'station', name: '城陵矶渡' });
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

  it('stays on core@1 + yangtze-ferry@1, with one presentation per cell and a 54-point snake route', () => {
    const manifest = readMapJson('manifest.json');
    const board = readMapJson('board.json');
    const route = manifest.presentation.routes.find((entry: any) => entry.role === 'route');

    expect(manifest.ref.id).toBe('yangtze-tour');
    expect(manifest.ref.version).toBe(1);
    expect(manifest.ref.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.metadata.title).toBe('长江之旅');
    // #23：三处渡口由 yangtze-ferry@1 结算，地图声明依赖 core@1 + yangtze-ferry@1。
    expect(manifest.requiredRuleModules).toEqual([coreModule, yangtzeFerryModule]);
    expect(Object.keys(manifest.presentation.cells).map(Number).sort((a, b) => a - b)).toEqual(
      board.cells.map((cell: { id: number }) => cell.id).sort((a: number, b: number) => a - b),
    );
    expect(route.type).toBe('polyline');
    expect(route.points).toHaveLength(54);
    expect(manifest.presentation.center).toEqual([]);
    // 十色带 = 长江干流自上而下经过的十个省区 + 渡口 + 水利，各自一色。
    expect(Object.keys(manifest.presentation.theme.propertyBands)).toEqual([
      'band:shanghai',
      'band:jiangsu',
      'band:anhui',
      'band:jiangxi',
      'band:hubei',
      'band:hunan',
      'band:chongqing',
      'band:sichuan',
      'band:yunnan',
      'band:qinghai',
      'band:ferry',
      'band:utility',
    ]);
  });

  it('is a deeply frozen valid immutable map pack whose hash matches its own bytes', () => {
    expect(() => assertValidMapPack(yangtzeTourMap, [coreModule, yangtzeFerryModule])).not.toThrow();
    expect(computeContentHash(yangtzeTourMap)).toBe(yangtzeTourMap.ref.contentHash);
    expect(yangtzeTourMap.ref.contentHash)
      .toBe('fd44de6931fb54f7367ccb2f14fbfe7e9df00280b4d045bbe59087fa6f8443f5');
    expect(Object.isFrozen(yangtzeTourMap)).toBe(true);
    expect(Object.isFrozen(yangtzeTourMap.game.board.cells)).toBe(true);
    expect(Object.isFrozen(yangtzeTourMap.game.cards.destiny[2]!.effect)).toBe(true);
    expect(Object.isFrozen(yangtzeTourMap.presentation.cells[31]!)).toBe(true);
  });
});
