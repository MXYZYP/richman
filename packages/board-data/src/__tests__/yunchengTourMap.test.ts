import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeContentHash } from '../hash';
import { assertValidMapPack } from '../mapValidation';
import { yunchengTourMap } from '../yunchengTourMap';

const mapDirectory = new URL('../../maps/yuncheng-tour/v1/', import.meta.url);

const coreModule = { id: 'core', version: 1 } as const;
const piaohaoModule = { id: 'piaohao', version: 1 } as const;

function readMapJson(fileName: string): any {
  const fileUrl = new URL(fileName, mapDirectory);
  expect(existsSync(fileUrl), `yuncheng-tour/v1/${fileName} must exist`).toBe(true);
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

describe('yuncheng-tour@1 approved source data', () => {
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
    expect(board.cells[47]).toMatchObject({ id: 47, type: 'property', name: '运城盐湖', nextId: 0 });
    expect(ladder[47]).toEqual({ col: 0, row: 7 });
    // 纯蛇形网格没有支线，因此不需要机场格。
    expect(board.cells.filter((cell: any) => cell.type === 'airport')).toHaveLength(0);
    // 只有末格显式写 nextId；其余 47 格靠「id + 1 即后继」的隐式约定，
    // 多写一处就会在两处形成分叉的路径定义。
    expect(
      board.cells
        .filter((cell: { nextId?: number }) => cell.nextId !== undefined)
        .map((cell: { id: number }) => cell.id),
    ).toEqual([47]);
    expect(board.boardName).toBe('大富翁·运城之旅');
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

  it('keeps six rent tiers for every normal property and five for every crossing', () => {
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

    expect(normalProperties).toHaveLength(24);
    expect(stations).toHaveLength(5);
    expect(utilities).toHaveLength(2);
    expect(normalProperties.every((cell: any) => cell.rents.length === 6)).toBe(true);
    // 仓库硬约束：车站的租金档数必须等于全图车站总数（5），不是固定值。
    expect(stations.every((cell: any) => cell.rents.length === stations.length)).toBe(true);
    expect(utilities.every((cell: any) => cell.rents === undefined)).toBe(true);
    expect(normalProperties.every((cell: any) => cell.houseCost > 0)).toBe(true);
    expect(stations.every((cell: any) => cell.houseCost === undefined)).toBe(true);
    expect(utilities.every((cell: any) => cell.houseCost === undefined)).toBe(true);
    // 租金必须单调不降，否则引擎的「按等级取租金」会在某一档出现倒挂。
    for (const cell of [...normalProperties, ...stations]) {
      const rents: number[] = cell.rents;
      expect(rents.every((rent, index) => index === 0 || rent >= rents[index - 1]!), `${cell.name} 租金倒挂`).toBe(true);
    }
  });

  it('names five crossings and both utilities after real Yuncheng landmarks', () => {
    const board = readMapJson('board.json');
    const stations = board.cells.filter((cell: any) => cell.subtype === 'station');
    const utilities = board.cells.filter((cell: any) => cell.subtype === 'utility');

    expect(stations.map((cell: any) => ({ id: cell.id, name: cell.name, price: cell.price }))).toEqual([
      { id: 5, name: '运城站', price: 2000 },
      { id: 8, name: '河东市场', price: 2000 },
      { id: 15, name: '蒲津渡', price: 2000 },
      { id: 31, name: '永济站', price: 2000 },
      { id: 44, name: '解州关帝', price: 2000 },
    ]);
    expect(utilities.map((cell: any) => ({ id: cell.id, name: cell.name, price: cell.price }))).toEqual([
      { id: 16, name: '运城盐池', price: 1500 },
      { id: 24, name: '黄河金三角', price: 1500 },
    ]);
  });

  it('requires price to equal exactly twice the mortgage for all 31 purchasable cells', () => {
    const board = readMapJson('board.json');
    const purchasable = board.cells.filter((cell: any) => cell.type === 'property');

    expect(purchasable).toHaveLength(31);
    expect(purchasable.every((cell: any) => cell.price === cell.mortgageValue * 2)).toBe(true);
  });

  it('escalates land value from the salt district up to Stork Tower by the Yellow River', () => {
    const board = readMapJson('board.json');
    const normal = board.cells.filter(
      (cell: any) => cell.type === 'property' && cell.subtype === 'normal',
    );

    expect(board.cells[1]).toMatchObject({ name: '盐湖区', price: 1400, houseCost: 800, mortgageValue: 700 });
    expect(board.cells[17]).toMatchObject({ name: '永济', price: 2000 });
    expect(board.cells[19]).toMatchObject({ name: '鹳雀楼', price: 2600, houseCost: 1500 });
    expect(board.cells[21]).toMatchObject({ name: '芮城永乐宫', price: 2400 });
    expect(board.cells[47]).toMatchObject({
      name: '运城盐湖',
      price: 2400,
      houseCost: 1400,
      mortgageValue: 1200,
      rents: [200, 1000, 2800, 6500, 8800, 11000],
    });
    // 地价自 1400 起、最高 2600；顶格 2600 只留给鹳雀楼一处 —— 全图唯一的最贵地，
    // 保证「登上鹳雀楼」这件小事在整局里都有辨识度。
    // 显式标注数组类型：board 来自 JSON.parse（any），否则 prices 会退化成 any。
    const prices: number[] = normal.map((cell: any) => cell.price as number);
    expect(Math.min(...prices)).toBe(1400);
    expect(Math.max(...prices)).toBe(2600);
    expect(prices.filter((price) => price === 2600)).toHaveLength(1);
    expect(normal.filter((cell: any) => cell.price === 2600).map((cell: any) => cell.id)).toEqual([19]);
    // 七档地价：1400 / 1600 / 1800 / 2000 / 2200 / 2400 / 2600。
    expect([...new Set(prices)].sort((left, right) => left - right)).toEqual([
      1400, 1600, 1800, 2000, 2200, 2400, 2600,
    ]);
  });

  it('spreads 4 chance / 4 destiny / 3 tax / 3 票号 cells and never lets two card cells touch', () => {
    const board = readMapJson('board.json');
    const byType = (type: string) => board.cells.filter((cell: any) => cell.type === type);

    expect(byType('start')).toHaveLength(1);
    expect(byType('chance')).toHaveLength(4);
    expect(byType('destiny')).toHaveLength(4);
    expect(byType('tax')).toHaveLength(3);
    expect(byType('special')).toHaveLength(2);
    expect(byType('module')).toHaveLength(3);
    expect(byType('airport')).toHaveLength(0);

    // board 来自 JSON.parse（any），这里显式标注数组类型，否则下面 map 的回调参数会退化成隐式 any。
    const eventIds: number[] = board.cells
      .filter((cell: any) => cell.type !== 'property' && cell.type !== 'start')
      .map((cell: any) => cell.id as number);
    expect(eventIds).toEqual([2, 4, 6, 10, 12, 18, 20, 22, 25, 28, 32, 34, 36, 39, 45, 46]);

    // 机会 / 命运绝不贴连：连着抽两张卡会让一整回合只剩运气（环首尾也一并检查）。
    const cardIds: number[] = board.cells
      .filter((cell: any) => cell.type === 'chance' || cell.type === 'destiny')
      .map((cell: any) => cell.id as number);
    const gaps = cardIds.slice(1).map((id, index) => id - cardIds[index]!);
    gaps.push(board.cells.length - cardIds.at(-1)! + cardIds[0]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(2);

    expect(byType('tax').map((cell: any) => cell.amount)).toEqual([1200, 1000, 1500]);
    expect(byType('module').map((cell: any) => ({
      id: cell.id,
      name: cell.name,
      module: cell.module,
      cellType: cell.cellType,
      payload: cell.payload,
    }))).toEqual([
      // 晋商票号是运城（河东金融重镇）最贴题的特化玩法：三处票号分列棋盘三段，
      // 玩家能攒出「绕远路过票号」与「就地取现周转」两种真实取舍。
      { id: 6, name: '河东票号', module: piaohaoModule, cellType: 'piaohao', payload: {} },
      { id: 20, name: '普救寺戏台', module: piaohaoModule, cellType: 'piaohao', payload: {} },
      { id: 34, name: '禹门渡', module: piaohaoModule, cellType: 'piaohao', payload: {} },
    ]);
    expect(byType('special').map((cell: any) => ({ name: cell.name, effect: cell.effect }))).toEqual([
      { name: '关卡盘查', effect: { type: 'pay_bank', amount: 800 } },
      { name: '汾河秋汛', effect: { type: 'receive_bank', amount: 1000 } },
    ]);
  });

  it('declares 12 chance and 14 destiny cards, with a post-horse warp that targets a real cell', () => {
    const cards = readMapJson('cards.json');
    const board = readMapJson('board.json');

    expect(cards.chance).toHaveLength(12);
    expect(cards.destiny).toHaveLength(14);
    expect(cards.chance.map((card: any) => card.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `yc-c${String(index + 1).padStart(2, '0')}`),
    );
    expect(cards.destiny.map((card: any) => card.id)).toEqual(
      Array.from({ length: 14 }, (_, index) => `yc-d${String(index + 1).padStart(2, '0')}`),
    );
    // 命运卡里的传送目标必须真的是蒲津渡，否则「驿马传讯」会把玩家丢到空地上。
    expect(cards.destiny.find((card: any) => card.id === 'yc-d03').effect).toEqual({
      type: 'move_to',
      cellId: 15,
      collectSalary: true,
    });
    expect(board.cells[15]).toMatchObject({ name: '蒲津渡', subtype: 'station' });
    // 所有 move_to 目标都必须落在真实格上（校验器只查格式、不查存在性）。
    const cellIds = new Set(board.cells.map((cell: { id: number }) => cell.id));
    for (const card of [...cards.chance, ...cards.destiny]) {
      if (card.effect?.type === 'move_to') {
        expect(cellIds.has(card.effect.cellId), `${card.id} 的传送目标 ${card.effect.cellId} 不存在`).toBe(true);
      }
    }
  });

  it('locks the owner-approved game config with maxHouseLevel 5', () => {
    expect(readMapJson('game-config.json')).toEqual({
      initialCash: 15000,
      // 2500：比山西（2600）略薄一档。运城初始现金同为 15000，但地价档位整体低 200，
      // 工资再给到 2600 会让现金目标形同虚设（实测 fullGameSmoke 的终局率判据）。
      passStartSalary: 2500,
      maxHouseLevel: 5,
      sellHouseRefundRate: 0.5,
      sellLandRate: 0.5,
      mortgageInterestRate: 0.1,
      utilityMultipliers: [10, 100],
      jailExitMinRoll: 10,
      jailMaxAttempts: 3,
      // 两档都高于 initialCash 且互不重复（校验器硬规则）。
      cashGoalPresets: [31000, 49000],
      diceMode: 'two_dice',
      airportBranchDice: 1,
      jailEnabled: false,
    });
  });

  it('stays on core@1 + piaohao@1, with one presentation per cell and a single 48-point snake route', () => {
    const manifest = readMapJson('manifest.json');
    const board = readMapJson('board.json');
    const routes = manifest.presentation.routes;

    expect(manifest.ref.id).toBe('yuncheng-tour');
    expect(manifest.ref.version).toBe(1);
    expect(manifest.ref.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.metadata.title).toBe('运城之旅');
    expect(manifest.metadata.description).toContain('蛇形');
    // 三处票号由 piaohao@1 结算；蛇形网格本身仍没有机场与支线。
    expect(manifest.requiredRuleModules).toEqual([coreModule, piaohaoModule]);
    expect(Object.keys(manifest.presentation.cells).map(Number).sort((a, b) => a - b)).toEqual(
      board.cells.map((cell: { id: number }) => cell.id).sort((a: number, b: number) => a - b),
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ type: 'polyline', role: 'route' });
    // 折线一格一个点，共 48 点；首点落在起点格中心，末点落在末格中心。
    // 故意不闭合（不追加回起点的第 49 点）：47 → 0 是一次横跨 7 行的长跳接，连出来会纵穿棋盘，
    // 与《山西之旅》48 点蛇形折线保持同一约定。
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
      'band:yuncheng',
      'band:yongji',
      'band:yuejin',
      'band:hetao',
      'band:fenhe',
      'band:luyinchuan',
      'band:utility',
    ]);
  });

  it('gives every declared band a cell and never reuses one hex across two bands', () => {
    const manifest = readMapJson('manifest.json');
    const bands = manifest.presentation.theme.propertyBands as Record<string, string>;
    const placements = Object.values(manifest.presentation.cells) as { propertyBand?: string }[];

    // 声明了却零引用的色带是死配置：改它不会有任何视觉反馈，容易被误当成「已生效」。
    const used = new Set(placements.map((cell) => cell.propertyBand).filter(Boolean));
    expect([...Object.keys(bands)].filter((token) => !used.has(token))).toEqual([]);
    // 两个地区共用同一个色值 = 棋盘上分不出边界，直接违背「配色辨识度」。
    expect([...new Set(Object.values(bands))]).toHaveLength(Object.keys(bands).length);
    // 每个引用到的色带都必须已声明（否则渲染时静默回落默认色）。
    for (const cell of placements) {
      if (cell.propertyBand !== undefined) {
        expect(Object.hasOwn(bands, cell.propertyBand), `${cell.propertyBand} 未声明`).toBe(true);
      }
    }
    // 五个车站 / 渡口统一挂金色带，与黄河沿岸的石青带区分开。
    const stationCells = [5, 8, 15, 31, 44];
    expect(stationCells.map((id) => manifest.presentation.cells[id].propertyBand)).toEqual(
      stationCells.map(() => 'band:yuejin'),
    );
  });

  it('is a deeply frozen valid immutable map pack whose hash matches its own bytes', () => {
    expect(() => assertValidMapPack(yunchengTourMap, [coreModule, piaohaoModule])).not.toThrow();
    expect(computeContentHash(yunchengTourMap)).toBe(yunchengTourMap.ref.contentHash);
    expect(yunchengTourMap.ref.contentHash)
      .toBe('24aec483a20c2f8d93dd38bff4ed867e8b64c94388f2371c2b5dd8f5dd4fcd25');
    expect(Object.isFrozen(yunchengTourMap)).toBe(true);
    expect(Object.isFrozen(yunchengTourMap.game.board.cells)).toBe(true);
    expect(Object.isFrozen(yunchengTourMap.game.cards.destiny[2]!.effect)).toBe(true);
    expect(Object.isFrozen(yunchengTourMap.presentation.cells[0]!)).toBe(true);
  });
});
