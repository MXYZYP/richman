import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeContentHash } from '../hash';
import { assertValidMapPack } from '../mapValidation';
import { xinjiangTourMap } from '../xinjiangTourMap';

const mapDirectory = new URL('../../maps/xinjiang-tour/v1/', import.meta.url);

const coreModule = { id: 'core', version: 1 } as const;

function readMapJson(fileName: string): any {
  const fileUrl = new URL(fileName, mapDirectory);
  expect(existsSync(fileUrl), `xinjiang-tour/v1/${fileName} must exist`).toBe(true);
  return JSON.parse(readFileSync(fileUrl, 'utf8'));
}

const CANVAS = 100;
const CELL_WIDTH = 7;
const CELL_HEIGHT = 8;

const round = (value: number): number => Math.round(value * 1e6) / 1e6;
const colX = (index: number): number => round(1.4 + 8.2 * index);
const rowY = (index: number): number => round(4.6 + 9.2 * index);

/** 主环：12 列 × 10 行的矩形环，顺时针一圈 40 格。 */
function ringLadder(): { col: number; row: number }[] {
  const ladder: { col: number; row: number }[] = [];
  for (let col = 0; col < 12; col += 1) ladder.push({ col, row: 0 });
  for (let row = 1; row < 10; row += 1) ladder.push({ col: 11, row });
  for (let col = 10; col >= 0; col -= 1) ladder.push({ col, row: 9 });
  for (let row = 8; row >= 1; row -= 1) ladder.push({ col: 0, row });
  return ladder;
}

/** 支线：《独库公路》六个景点嵌在环内的空心处。 */
const branchLadder = [
  { col: 5, row: 2 },
  { col: 5, row: 3 },
  { col: 5, row: 4 },
  { col: 5, row: 5 },
  { col: 5, row: 6 },
  { col: 6, row: 6 },
];

const ladder = [...ringLadder(), ...branchLadder];

function expectedPlacement(id: number) {
  const point = ladder[id]!;
  return { x: colX(point.col), y: rowY(point.row), width: CELL_WIDTH, height: CELL_HEIGHT };
}

describe('xinjiang-tour@1 approved source data', () => {
  it('locks the 40-cell Tianshan ring plus a 6-cell 独库公路 branch', () => {
    const board = readMapJson('board.json');

    expect(ladder).toHaveLength(46);
    expect(new Set(ladder.map((entry) => `${entry.col},${entry.row}`)).size).toBe(46);
    expect(board.cells).toHaveLength(46);
    expect(board.cells.map((cell: { id: number }) => cell.id)).toEqual(
      Array.from({ length: 46 }, (_, index) => index),
    );
    expect(board.cells[0]).toMatchObject({ id: 0, type: 'start', name: '起点' });
    expect(board.cells[34]).toMatchObject({ id: 34, type: 'airport', name: '阿克苏', branchEntryId: 40 });
    // 环末格显式折回起点；支线末格显式汇回主环上的「阿瓦提」（机场格的数组后继）。
    expect(board.cells[39]).toMatchObject({ id: 39, name: '库尔勒', nextId: 0 });
    expect(board.cells[45]).toMatchObject({ id: 45, name: '巴音布鲁克', nextId: 35 });
    expect(
      board.cells
        .filter((cell: { nextId?: number }) => cell.nextId !== undefined)
        .map((cell: { id: number }) => cell.id),
    ).toEqual([39, 45]);
    expect(board.boardName).toBe('大富翁·新疆之旅');
  });

  it('lays out a rectangular ring with the branch nested inside its hollow', () => {
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

    const placements = board.cells.map((cell: { id: number }) => manifest.presentation.cells[cell.id]);
    // 环形签名：首格与末格都在左上角，上边 12 格同高、下边 11 格同高。
    expect(placements[0]).toMatchObject({ x: colX(0), y: rowY(0) });
    expect(new Set(placements.slice(0, 12).map((entry: { y: number }) => entry.y)).size).toBe(1);
    expect(new Set(placements.slice(21, 32).map((entry: { y: number }) => entry.y)).size).toBe(1);
    // 支线六格整体落在环内空心处：四边都被环格包住，没有一格贴到环的外沿。
    const ringCells = placements.slice(0, 40);
    const branchCells = placements.slice(40);
    const ringLeft = Math.min(...ringCells.map((entry: { x: number }) => entry.x));
    const ringRight = Math.max(...ringCells.map((entry: { x: number; width: number }) => entry.x + entry.width));
    const ringTop = Math.min(...ringCells.map((entry: { y: number }) => entry.y));
    const ringBottom = Math.max(...ringCells.map((entry: { y: number; height: number }) => entry.y + entry.height));
    expect(
      branchCells.every((entry: { x: number; y: number }) => (
        entry.x > ringLeft
        && entry.x + CELL_WIDTH < ringRight
        && entry.y > ringTop
        && entry.y + CELL_HEIGHT < ringBottom
      )),
    ).toBe(true);
    expect(placements[45]).toMatchObject({ x: colX(6), y: rowY(6) });
  });

  it('keeps six rent tiers for every normal property and three for every port', () => {
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

    expect(normalProperties).toHaveLength(28);
    expect(stations).toHaveLength(3);
    expect(utilities).toHaveLength(2);
    expect(normalProperties.every((cell: any) => cell.rents.length === 6)).toBe(true);
    // 仓库硬约束：口岸的租金档数必须等于全图口岸总数（3），不是固定值。
    expect(stations.every((cell: any) => cell.rents.length === stations.length)).toBe(true);
    expect(utilities.every((cell: any) => cell.rents === undefined)).toBe(true);
    expect(normalProperties.every((cell: any) => cell.houseCost > 0)).toBe(true);
    expect(stations.every((cell: any) => cell.houseCost === undefined)).toBe(true);
    expect(utilities.every((cell: any) => cell.houseCost === undefined)).toBe(true);
  });

  it('names all three border ports and both energy utilities after real Xinjiang landmarks', () => {
    const board = readMapJson('board.json');
    const stations = board.cells.filter((cell: any) => cell.subtype === 'station');
    const utilities = board.cells.filter((cell: any) => cell.subtype === 'utility');

    expect(stations.map((cell: any) => ({ id: cell.id, name: cell.name }))).toEqual([
      { id: 14, name: '伊尔克什坦口岸' },
      { id: 23, name: '卡拉苏口岸' },
      { id: 31, name: '红其拉甫口岸' },
    ]);
    expect(utilities.map((cell: any) => ({ id: cell.id, name: cell.name, price: cell.price }))).toEqual([
      { id: 15, name: '塔中油气田', price: 1500 },
      { id: 28, name: '乌鲁瓦提水利枢纽', price: 1500 },
    ]);
  });

  it('requires price to equal exactly twice the mortgage for all 33 purchasable cells', () => {
    const board = readMapJson('board.json');
    const purchasable = board.cells.filter((cell: any) => cell.type === 'property');

    expect(purchasable).toHaveLength(33);
    expect(purchasable.every((cell: any) => cell.price === cell.mortgageValue * 2)).toBe(true);
  });

  it('escalates land value from the northern corridor down into the Tianshan branch', () => {
    const board = readMapJson('board.json');
    const normal = board.cells.filter(
      (cell: any) => cell.type === 'property' && cell.subtype === 'normal',
    );

    expect(board.cells[1]).toMatchObject({ name: '阜康', price: 1400, houseCost: 800, mortgageValue: 700 });
    expect(board.cells[10]).toMatchObject({ name: '吐鲁番', price: 2400 });
    expect(board.cells[30]).toMatchObject({ name: '喀什', price: 3000 });
    expect(board.cells[39]).toMatchObject({ name: '库尔勒', price: 3200 });
    // 支线是「高价值机会」：全程地价不低于主环任何一个普通格的地价下限。
    expect(board.cells[45]).toMatchObject({
      name: '巴音布鲁克',
      price: 4000,
      houseCost: 2000,
      mortgageValue: 2000,
      rents: [400, 2000, 5500, 13000, 16000, 19000],
    });
    const branchPrices = [40, 41, 42, 43, 44, 45].map((id) => board.cells[id].price as number);
    expect(branchPrices).toEqual([2800, 3000, 3200, 3500, 3500, 4000]);
    expect(branchPrices).toEqual([...branchPrices].sort((left, right) => left - right));
    expect(new Set(normal.map((cell: any) => cell.price as number)).size).toBeGreaterThanOrEqual(8);
  });

  it('spreads 3 chance / 4 destiny / 2 tax / 2 special cells and never lets two card cells touch', () => {
    const board = readMapJson('board.json');
    const byType = (type: string) => board.cells.filter((cell: any) => cell.type === type);

    expect(byType('start')).toHaveLength(1);
    expect(byType('chance')).toHaveLength(3);
    expect(byType('destiny')).toHaveLength(4);
    expect(byType('tax')).toHaveLength(2);
    expect(byType('special')).toHaveLength(2);
    expect(byType('airport')).toHaveLength(1);

    // board 来自 JSON.parse（any），这里显式标注数组类型，否则下面 map 的回调参数会退化成隐式 any。
    const eventIds: number[] = board.cells
      .filter((cell: any) => cell.type !== 'property' && cell.type !== 'start')
      .map((cell: any) => cell.id as number);
    expect(eventIds).toEqual([3, 5, 8, 12, 16, 19, 24, 26, 29, 34, 36, 38]);

    // 机会 / 命运绝不贴连：连着抽两张卡会让一整回合只剩运气（环首尾也一并检查）。
    const cardIds: number[] = board.cells
      .filter((cell: any) => cell.type === 'chance' || cell.type === 'destiny')
      .map((cell: any) => cell.id as number);
    const gaps = cardIds.slice(1).map((id, index) => id - cardIds[index]!);
    gaps.push(40 - cardIds.at(-1)! + cardIds[0]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(2);

    expect(byType('tax').map((cell: any) => cell.amount)).toEqual([1000, 1200]);
    expect(byType('special').map((cell: any) => cell.effect)).toEqual([
      { type: 'skip_turn', turns: 1 },
      { type: 'pay_bank', amount: 1200 },
    ]);
  });

  it('declares 12 chance and 14 destiny cards, with a detour warp that targets a real cell', () => {
    const cards = readMapJson('cards.json');
    const board = readMapJson('board.json');

    expect(cards.chance).toHaveLength(12);
    expect(cards.destiny).toHaveLength(14);
    expect(cards.chance.map((card: any) => card.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `xj-c${String(index + 1).padStart(2, '0')}`),
    );
    expect(cards.destiny.map((card: any) => card.id)).toEqual(
      Array.from({ length: 14 }, (_, index) => `xj-d${String(index + 1).padStart(2, '0')}`),
    );
    // 命运卡里的传送目标必须真的是库车，否则「独库公路巡查车」会把玩家丢到空地上。
    expect(cards.destiny.find((card: any) => card.id === 'xj-d03').effect).toEqual({
      type: 'move_to',
      cellId: 37,
      collectSalary: true,
    });
    expect(board.cells[37]).toMatchObject({ name: '库车', type: 'property' });
  });

  it('locks the owner-approved game config with maxHouseLevel 5', () => {
    expect(readMapJson('game-config.json')).toEqual({
      initialCash: 16000,
      passStartSalary: 2000,
      maxHouseLevel: 5,
      sellHouseRefundRate: 0.5,
      sellLandRate: 0.5,
      mortgageInterestRate: 0.1,
      utilityMultipliers: [10, 100],
      jailExitMinRoll: 10,
      jailMaxAttempts: 3,
      cashGoalPresets: [35000, 55000],
      diceMode: 'two_dice',
      airportBranchDice: 1,
      jailEnabled: false,
    });
  });

  it('stays on core@1 only, with one presentation per cell and ring + branch routes', () => {
    const manifest = readMapJson('manifest.json');
    const board = readMapJson('board.json');
    const routes = manifest.presentation.routes;

    expect(manifest.ref.id).toBe('xinjiang-tour');
    expect(manifest.ref.version).toBe(1);
    expect(manifest.ref.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.metadata.title).toBe('新疆之旅');
    expect(manifest.metadata.description).toContain('独库公路');
    // 环形图只依赖核心规则：机场等待与支线掷骰都由 core 处理，玩家换图不必先装模块。
    expect(manifest.requiredRuleModules).toEqual([coreModule]);
    expect(Object.keys(manifest.presentation.cells).map(Number).sort((a, b) => a - b)).toEqual(
      board.cells.map((cell: { id: number }) => cell.id).sort((a: number, b: number) => a - b),
    );
    expect(routes).toHaveLength(2);
    expect(routes.every((route: any) => route.type === 'polyline' && route.role === 'route')).toBe(true);
    // 主环折线首尾都落在起点格中心，证明它是闭合的一圈；支线折线从机场贯穿六格汇回主环。
    expect(routes[0].points).toHaveLength(41);
    expect(routes[0].points[0]).toEqual(routes[0].points[40]);
    expect(routes[1].points).toHaveLength(8);
    expect(routes[1].points[0]).toEqual(routes[0].points[34]);
    expect(manifest.presentation.center).toHaveLength(0);
    expect(Object.keys(manifest.presentation.theme.propertyBands)).toEqual([
      'band:north',
      'band:turpan',
      'band:kashgar',
      'band:transhan',
      'band:gate',
      'band:utility',
    ]);
  });

  it('is a deeply frozen valid immutable map pack whose hash matches its own bytes', () => {
    expect(() => assertValidMapPack(xinjiangTourMap, [coreModule])).not.toThrow();
    expect(computeContentHash(xinjiangTourMap)).toBe(xinjiangTourMap.ref.contentHash);
    expect(xinjiangTourMap.ref.contentHash)
      .toBe('08a39b81e3534d6c24664b4a2d218de732c2e2577e5442fcb26384c09759a169');
    expect(Object.isFrozen(xinjiangTourMap)).toBe(true);
    expect(Object.isFrozen(xinjiangTourMap.game.board.cells)).toBe(true);
    expect(Object.isFrozen(xinjiangTourMap.game.cards.destiny[2]!.effect)).toBe(true);
    expect(Object.isFrozen(xinjiangTourMap.presentation.cells[40]!)).toBe(true);
  });
});
