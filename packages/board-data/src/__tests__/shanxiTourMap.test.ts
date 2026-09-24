import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeContentHash } from '../hash';
import { assertValidMapPack } from '../mapValidation';
import { shanxiTourMap } from '../shanxiTourMap';

const mapDirectory = new URL('../../maps/shanxi-tour/v1/', import.meta.url);

const coreModule = { id: 'core', version: 1 } as const;

function readMapJson(fileName: string): any {
  const fileUrl = new URL(fileName, mapDirectory);
  expect(existsSync(fileUrl), `shanxi-tour/v1/${fileName} must exist`).toBe(true);
  return JSON.parse(readFileSync(fileUrl, 'utf8'));
}

const CANVAS = 100;
const CELL_WIDTH = 13;
const CELL_HEIGHT = 10;

const round = (value: number): number => Math.round(value * 1e6) / 1e6;
const colX = (index: number): number => round(4.75 + 15.5 * index);
const rowY = (index: number): number => round(1.25 + 12.5 * index);

/** 蛇形网格：8 行 × 6 列，偶数行自左向右、奇数行自右向左，逐行铺满画布。 */
function snakeLadder(): { col: number; row: number }[] {
  const ladder: { col: number; row: number }[] = [];
  for (let row = 0; row < 8; row += 1) {
    for (let step = 0; step < 6; step += 1) {
      ladder.push({ col: row % 2 === 0 ? step : 5 - step, row });
    }
  }
  return ladder;
}

const ladder = snakeLadder();

function expectedPlacement(id: number) {
  const point = ladder[id]!;
  return { x: colX(point.col), y: rowY(point.row), width: CELL_WIDTH, height: CELL_HEIGHT };
}

describe('shanxi-tour@1 approved source data', () => {
  it('locks a single 48-cell serpentine loop that folds back to the start', () => {
    const board = readMapJson('board.json');

    expect(ladder).toHaveLength(48);
    expect(new Set(ladder.map((entry) => `${entry.col},${entry.row}`)).size).toBe(48);
    expect(board.cells).toHaveLength(48);
    expect(board.cells.map((cell: { id: number }) => cell.id)).toEqual(
      Array.from({ length: 48 }, (_, index) => index),
    );
    expect(board.cells[0]).toMatchObject({ id: 0, type: 'start', name: '起点' });
    // 首尾在同一列（第 0 列）的上下两端，折回起点只需一次竖直跳接。
    expect(board.cells[47]).toMatchObject({ id: 47, type: 'property', name: '芮城永乐宫', nextId: 0 });
    expect(ladder[47]).toEqual({ col: 0, row: 7 });
    // 纯蛇形网格没有支线，因此不需要机场格。
    expect(board.cells.filter((cell: any) => cell.type === 'airport')).toHaveLength(0);
    expect(
      board.cells
        .filter((cell: { nextId?: number }) => cell.nextId !== undefined)
        .map((cell: { id: number }) => cell.id),
    ).toEqual([47]);
    expect(board.boardName).toBe('大富翁·山西之旅');
  });

  it('lays out eight serpentine rows of six tiles with alternating direction', () => {
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

    const placements = board.cells.map((cell: { id: number }) => manifest.presentation.cells[cell.id]);
    expect(placements.every((entry: { x: number; y: number; width: number; height: number }) => (
      entry.x >= 0
      && entry.y >= 0
      && entry.x + entry.width <= CANVAS
      && entry.y + entry.height <= CANVAS
    ))).toBe(true);

    // 网格签名：8 行 × 6 列，每行等高、每列等宽。
    expect(new Set(placements.map((entry: { y: number }) => entry.y)).size).toBe(8);
    expect(new Set(placements.map((entry: { x: number }) => entry.x)).size).toBe(6);
    for (let row = 0; row < 8; row += 1) {
      const rowCells = placements.slice(row * 6, row * 6 + 6);
      expect(new Set(rowCells.map((entry: { y: number }) => entry.y)).size).toBe(1);
      expect(new Set(rowCells.map((entry: { x: number }) => entry.x)).size).toBe(6);
    }
    // 偶数行自左向右、奇数行自右向左 —— 这正是「蛇形」而不是「逐行重排」的判据。
    expect(placements[0]).toMatchObject({ x: colX(0), y: rowY(0) });
    expect(placements[5]).toMatchObject({ x: colX(5), y: rowY(0) });
    expect(placements[6]).toMatchObject({ x: colX(5), y: rowY(1) });
    expect(placements[11]).toMatchObject({ x: colX(0), y: rowY(1) });
    expect(placements[47]).toMatchObject({ x: colX(0), y: rowY(7) });
    // 行列间距都大于格子尺寸，任何两格都不重叠（不需要 overlapWith 声明）。
    expect(round(colX(1) - colX(0))).toBeGreaterThan(CELL_WIDTH);
    expect(round(rowY(1) - rowY(0))).toBeGreaterThan(CELL_HEIGHT);
  });

  it('keeps six rent tiers for every normal property and three for every crossing', () => {
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

    expect(normalProperties).toHaveLength(31);
    expect(stations).toHaveLength(3);
    expect(utilities).toHaveLength(2);
    expect(normalProperties.every((cell: any) => cell.rents.length === 6)).toBe(true);
    // 仓库硬约束：渡口的租金档数必须等于全图渡口总数（3），不是固定值。
    expect(stations.every((cell: any) => cell.rents.length === stations.length)).toBe(true);
    expect(utilities.every((cell: any) => cell.rents === undefined)).toBe(true);
    expect(normalProperties.every((cell: any) => cell.houseCost > 0)).toBe(true);
    expect(stations.every((cell: any) => cell.houseCost === undefined)).toBe(true);
    expect(utilities.every((cell: any) => cell.houseCost === undefined)).toBe(true);
  });

  it('names three historic crossings and both energy utilities after real Shanxi landmarks', () => {
    const board = readMapJson('board.json');
    const stations = board.cells.filter((cell: any) => cell.subtype === 'station');
    const utilities = board.cells.filter((cell: any) => cell.subtype === 'utility');

    expect(stations.map((cell: any) => ({ id: cell.id, name: cell.name, price: cell.price }))).toEqual([
      { id: 5, name: '雁门关', price: 2000 },
      { id: 31, name: '孟门渡', price: 2000 },
      { id: 44, name: '蒲津渡', price: 2000 },
    ]);
    expect(utilities.map((cell: any) => ({ id: cell.id, name: cell.name, price: cell.price }))).toEqual([
      { id: 22, name: '万家寨水利枢纽', price: 1500 },
      { id: 30, name: '柳林煤层气田', price: 1500 },
    ]);
  });

  it('requires price to equal exactly twice the mortgage for all 36 purchasable cells', () => {
    const board = readMapJson('board.json');
    const purchasable = board.cells.filter((cell: any) => cell.type === 'property');

    expect(purchasable).toHaveLength(36);
    expect(purchasable.every((cell: any) => cell.price === cell.mortgageValue * 2)).toBe(true);
  });

  it('escalates land value from the Yanmen pass down into the Jin-nan plain', () => {
    const board = readMapJson('board.json');
    const normal = board.cells.filter(
      (cell: any) => cell.type === 'property' && cell.subtype === 'normal',
    );

    expect(board.cells[1]).toMatchObject({ name: '太原', price: 1800, houseCost: 1000, mortgageValue: 900 });
    expect(board.cells[9]).toMatchObject({ name: '大同', price: 2400 });
    expect(board.cells[37]).toMatchObject({ name: '吉县壶口', price: 2600, houseCost: 1500 });
    expect(board.cells[46]).toMatchObject({ name: '解州关帝庙', price: 2400 });
    expect(board.cells[47]).toMatchObject({
      name: '芮城永乐宫',
      price: 2200,
      houseCost: 1200,
      mortgageValue: 1100,
      rents: [180, 900, 2500, 6000, 8000, 10000],
    });
    // 全程地价自 1400 起、最高 2600；2600 这一档在晋北与晋南各出现一次。
    // 显式标注数组类型：board 来自 JSON.parse（any），否则 prices 会退化成 any。
    const prices: number[] = normal.map((cell: any) => cell.price as number);
    expect(Math.min(...prices)).toBe(1400);
    expect(Math.max(...prices)).toBe(2600);
    expect(prices.filter((price) => price === 2600)).toHaveLength(2);
    expect(normal.filter((cell: any) => cell.price === 2600).map((cell: any) => cell.id)).toEqual([10, 37]);
    // 七档地价：1400 / 1600 / 1800 / 2000 / 2200 / 2400 / 2600（比新疆之旅少两档，靠密度而非极端价撑起节奏）。
    expect([...new Set(prices)].sort((left, right) => left - right)).toEqual([
      1400, 1600, 1800, 2000, 2200, 2400, 2600,
    ]);
  });

  it('spreads 3 chance / 4 destiny / 2 tax / 2 special cells and never lets two card cells touch', () => {
    const board = readMapJson('board.json');
    const byType = (type: string) => board.cells.filter((cell: any) => cell.type === type);

    expect(byType('start')).toHaveLength(1);
    expect(byType('chance')).toHaveLength(3);
    expect(byType('destiny')).toHaveLength(4);
    expect(byType('tax')).toHaveLength(2);
    expect(byType('special')).toHaveLength(2);
    expect(byType('airport')).toHaveLength(0);

    // board 来自 JSON.parse（any），这里显式标注数组类型，否则下面 map 的回调参数会退化成隐式 any。
    const eventIds: number[] = board.cells
      .filter((cell: any) => cell.type !== 'property' && cell.type !== 'start')
      .map((cell: any) => cell.id as number);
    expect(eventIds).toEqual([3, 7, 11, 12, 20, 25, 26, 29, 38, 39, 45]);

    // 机会 / 命运绝不贴连：连着抽两张卡会让一整回合只剩运气（环首尾也一并检查）。
    const cardIds: number[] = board.cells
      .filter((cell: any) => cell.type === 'chance' || cell.type === 'destiny')
      .map((cell: any) => cell.id as number);
    const gaps = cardIds.slice(1).map((id, index) => id - cardIds[index]!);
    gaps.push(board.cells.length - cardIds.at(-1)! + cardIds[0]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(2);

    expect(byType('tax').map((cell: any) => cell.amount)).toEqual([1200, 1000]);
    expect(byType('special').map((cell: any) => cell.effect)).toEqual([
      { type: 'skip_turn', turns: 1 },
      { type: 'skip_turn', turns: 1 },
    ]);
  });

  it('declares 12 chance and 14 destiny cards, with a post-horse warp that targets a real cell', () => {
    const cards = readMapJson('cards.json');
    const board = readMapJson('board.json');

    expect(cards.chance).toHaveLength(12);
    expect(cards.destiny).toHaveLength(14);
    expect(cards.chance.map((card: any) => card.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `sx-c${String(index + 1).padStart(2, '0')}`),
    );
    expect(cards.destiny.map((card: any) => card.id)).toEqual(
      Array.from({ length: 14 }, (_, index) => `sx-d${String(index + 1).padStart(2, '0')}`),
    );
    // 命运卡里的传送目标必须真的是雁门关，否则「驿马传讯」会把玩家丢到空地上。
    expect(cards.destiny.find((card: any) => card.id === 'sx-d03').effect).toEqual({
      type: 'move_to',
      cellId: 5,
      collectSalary: true,
    });
    expect(board.cells[5]).toMatchObject({ name: '雁门关', subtype: 'station' });
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
      cashGoalPresets: [32000, 50000],
      diceMode: 'two_dice',
      airportBranchDice: 1,
      jailEnabled: false,
    });
  });

  it('stays on core@1 only, with one presentation per cell and a single 48-point snake route', () => {
    const manifest = readMapJson('manifest.json');
    const board = readMapJson('board.json');
    const routes = manifest.presentation.routes;

    expect(manifest.ref.id).toBe('shanxi-tour');
    expect(manifest.ref.version).toBe(1);
    expect(manifest.ref.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.metadata.title).toBe('山西之旅');
    expect(manifest.metadata.description).toContain('蛇形');
    // 纯蛇形网格只依赖核心规则：没有机场、没有支线，玩家换图不必先装模块。
    expect(manifest.requiredRuleModules).toEqual([coreModule]);
    expect(Object.keys(manifest.presentation.cells).map(Number).sort((a, b) => a - b)).toEqual(
      board.cells.map((cell: { id: number }) => cell.id).sort((a: number, b: number) => a - b),
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ type: 'polyline', role: 'route' });
    // 折线一格一个点，共 48 点；首点落在起点格中心，末点落在末格中心。
    // 故意不闭合（不追加回起点的第 49 点）：47 → 0 是一次横跨 7 行的长跳接，连出来会纵穿棋盘，
    // 与《长江之旅》54 点蛇形折线保持同一约定。
    expect(routes[0].points).toHaveLength(48);
    expect(routes[0].points[0]).toEqual({
      x: round(colX(0) + CELL_WIDTH / 2),
      y: round(rowY(0) + CELL_HEIGHT / 2),
    });
    expect(routes[0].points[47]).toEqual({
      x: round(colX(0) + CELL_WIDTH / 2),
      y: round(rowY(7) + CELL_HEIGHT / 2),
    });
    expect(routes[0].points[0]).not.toEqual(routes[0].points[47]);
    expect(manifest.presentation.center).toHaveLength(0);
    expect(Object.keys(manifest.presentation.theme.propertyBands)).toEqual([
      'band:north',
      'band:central',
      'band:lvliang',
      'band:linfen',
      'band:yuncheng',
      'band:gate',
      'band:utility',
    ]);
  });

  it('is a deeply frozen valid immutable map pack whose hash matches its own bytes', () => {
    expect(() => assertValidMapPack(shanxiTourMap, [coreModule])).not.toThrow();
    expect(computeContentHash(shanxiTourMap)).toBe(shanxiTourMap.ref.contentHash);
    expect(shanxiTourMap.ref.contentHash)
      .toBe('64ab61de86d5dd795c5e419e72226e2c45d8c504a7692839a47a2d06ef36b94b');
    expect(Object.isFrozen(shanxiTourMap)).toBe(true);
    expect(Object.isFrozen(shanxiTourMap.game.board.cells)).toBe(true);
    expect(Object.isFrozen(shanxiTourMap.game.cards.destiny[2]!.effect)).toBe(true);
    expect(Object.isFrozen(shanxiTourMap.presentation.cells[0]!)).toBe(true);
  });
});
