import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeContentHash } from '../hash';
import { assertValidMapPack } from '../mapValidation';
import { northeastTourMap } from '../northeastTourMap';

const mapDirectory = new URL('../../maps/northeast-tour/v1/', import.meta.url);

const CORE_MODULE = { id: 'core', version: 1 } as const;
const PRISON_MODULE = { id: 'prison', version: 1 } as const;

function readMapJson(fileName: string): any {
  const fileUrl = new URL(fileName, mapDirectory);
  expect(existsSync(fileUrl), `northeast-tour/v1/${fileName} must exist`).toBe(true);
  return JSON.parse(readFileSync(fileUrl, 'utf8'));
}

const COLS = 6;
const ROWS = 8;
const W = 13;
const H = 10;
const CANVAS = 100;
const COL_X = [4.75, 20.25, 35.75, 51.25, 66.75, 82.25];
const ROW_Y = [1.25, 13.75, 26.25, 38.75, 51.25, 63.75, 76.25, 88.75];

/** 蛇形走位：偶数行自西向东，奇数行折返（boustrophedon）。 */
function expectedPlacement(id: number) {
  const row = Math.floor(id / COLS);
  const within = id % COLS;
  const col = row % 2 === 0 ? within : COLS - 1 - within;
  return { x: COL_X[col], y: ROW_Y[row], width: W, height: H };
}

const GOTO_JAIL_IDS = [5, 17, 33];
const JAIL_ID = 42;

describe('northeast-tour@1 approved source data', () => {
  it('locks the 48-cell 6×8 serpentine from 起点 to 中央大街', () => {
    const board = readMapJson('board.json');

    expect(COLS * ROWS).toBe(board.cells.length);
    expect(board.cells.map((cell: { id: number }) => cell.id)).toEqual(
      Array.from({ length: 48 }, (_, index) => index),
    );
    expect(board.cells[0]).toMatchObject({ id: 0, type: 'start', name: '起点' });
    expect(board.cells[47]).toMatchObject({ id: 47, name: '中央大街', nextId: 0 });
    expect(board.cells[board.cells.length - 1].nextId).toBe(0);
    // 除末格显式折回起点，其余格沿数组顺序前进（校验器硬约束）。
    expect(
      board.cells
        .filter((cell: { id: number }) => cell.id !== 47)
        .every((cell: { nextId?: number }) => cell.nextId === undefined),
    ).toBe(true);
    expect(board.boardName).toBe('大富翁·东北之旅');
    expect(board.direction).toBe('clockwise');
  });

  it('lays out a 6×8 serpentine grid where every cell sits inside the canvas', () => {
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
    // 六列八行都是「整批」用到的坐标 —— 防止有人把某一行或某一列挪歪。
    const usedX = new Set<number>(board.cells.map((cell: { id: number }) => expectedPlacement(cell.id).x));
    const usedY = new Set<number>(board.cells.map((cell: { id: number }) => expectedPlacement(cell.id).y));
    expect([...usedX].sort((a, b) => a - b)).toEqual(COL_X);
    expect([...usedY].sort((a, b) => a - b)).toEqual(ROW_Y);
  });

  it('keeps six rent tiers for every normal property, three for every station, none for utilities', () => {
    const board = readMapJson('board.json');
    const ofSubtype = (subtype: string) => board.cells.filter(
      (cell: any) => cell.type === 'property' && cell.subtype === subtype,
    );
    const normalProperties = ofSubtype('normal');
    const stations = ofSubtype('station');
    const utilities = ofSubtype('utility');

    expect(normalProperties).toHaveLength(27);
    expect(stations).toHaveLength(3);
    expect(utilities).toHaveLength(2);
    expect(normalProperties.every((cell: any) => cell.rents.length === 6)).toBe(true);
    // 仓库硬约束：车站的租金档数必须等于全图车站总数，不是固定值。
    expect(stations.every((cell: any) => cell.rents.length === stations.length)).toBe(true);
    expect(normalProperties.every((cell: any) => cell.houseCost > 0)).toBe(true);
    expect(stations.every((cell: any) => cell.houseCost === undefined)).toBe(true);
    expect(utilities.every((cell: any) => cell.rents === undefined)).toBe(true);
    expect(utilities.every((cell: any) => cell.houseCost === undefined)).toBe(true);
  });

  it('names all three stations and both northeast utilities after real places', () => {
    const board = readMapJson('board.json');

    expect(
      board.cells
        .filter((cell: any) => cell.subtype === 'station')
        .map((cell: any) => ({ id: cell.id, name: cell.name })),
    ).toEqual([
      { id: 11, name: '沈阳北站' },
      { id: 27, name: '长春站' },
      { id: 44, name: '哈尔滨站' },
    ]);
    expect(
      board.cells
        .filter((cell: any) => cell.subtype === 'utility')
        .map((cell: any) => ({ id: cell.id, name: cell.name, price: cell.price })),
    ).toEqual([
      { id: 7, name: '丰满水电站', price: 1500 },
      { id: 22, name: '松花江航运', price: 1500 },
    ]);
  });

  it('requires price to equal exactly twice the mortgage for all 32 purchasable cells', () => {
    const board = readMapJson('board.json');
    const purchasable = board.cells.filter((cell: any) => cell.type === 'property');

    expect(purchasable).toHaveLength(32);
    expect(purchasable.every((cell: any) => cell.price === cell.mortgageValue * 2)).toBe(true);
  });

  it('escalates land value from 沈阳 in the south to 中央大街 in the far north', () => {
    const board = readMapJson('board.json');
    const normal = board.cells.filter(
      (cell: any) => cell.type === 'property' && cell.subtype === 'normal',
    );

    expect(normal[0]).toMatchObject({ name: '沈阳', price: 1800, houseCost: 1000 });
    expect(board.cells[47]).toMatchObject({
      name: '中央大街',
      price: 3000,
      houseCost: 2000,
      mortgageValue: 1500,
      rents: [260, 1300, 3900, 9000, 11000, 12750],
    });

    // 地价整体是「南端进场段最便宜、北端终点区最贵」，但**不是**沿格子 id 严格递增：
    // 棋盘按地理环线排布（沈阳出发 → 东部边境 → 长春 / 哈尔滨 → 最北端 → 折返大连湾），
    // 终点区（大连 2800 / 太阳岛 2200 / 中央大街 3000）刻意压轴，所以中途会回落。
    // 必须显式标注：readMapJson() 返回 any，`new Set(<any>)` 会推出 Set<unknown>。
    const prices: number[] = normal.map((cell: any) => cell.price as number);
    expect([...new Set(prices)].sort((left, right) => left - right)).toEqual([
      1400, 1600, 1800, 2000, 2200, 2400, 2600, 2800, 3000,
    ]);
    // 全场唯一最高价落在终点区，且必须是最后一格 —— 环线的「压轴」不能有并列。
    expect(prices.filter((price) => price === Math.max(...prices))).toHaveLength(1);
    expect(normal[normal.length - 1]).toMatchObject({ name: '中央大街', price: 3000 });
    // 南端进场段（沈阳 → 吉林，9 格）全部落在最低三档里，起步不会被高价卡死。
    expect(prices.slice(0, 9).every((price) => price <= 1800)).toBe(true);
  });

  it('spreads 3 chance / 4 destiny / 2 tax / 2 special cells and never doubles up', () => {
    const board = readMapJson('board.json');
    const idsOfType = (type: string) => board.cells
      .filter((cell: any) => cell.type === type)
      .map((cell: any) => cell.id as number);

    expect(idsOfType('start')).toEqual([0]);
    expect(idsOfType('chance')).toEqual([9, 25, 39]);
    expect(idsOfType('destiny')).toEqual([3, 20, 29, 45]);
    expect(idsOfType('tax')).toEqual([12, 30]);
    expect(idsOfType('special')).toEqual([16, 38]);
    // 事件格（非地产、非起点）按 id 列出：它们彼此不贴在一起，走一格就有事发生。
    expect(
      board.cells
        .filter((cell: any) => cell.type !== 'property' && cell.type !== 'start')
        .map((cell: any) => cell.id as number),
    ).toEqual([3, 5, 9, 12, 16, 17, 20, 25, 29, 30, 33, 38, 39, 42, 45]);
    expect(idsOfType('tax').every((id: number) => board.cells[id].amount > 0)).toBe(true);
    expect(
      board.cells
        .filter((cell: any) => cell.type === 'special')
        .map((cell: any) => cell.effect),
    ).toEqual([
      { type: 'receive_bank', amount: 1000 },
      { type: 'pay_bank', amount: 800 },
    ]);
  });

  it('declares exactly one jail corner plus three goto-jail cells for prison@1', () => {
    const board = readMapJson('board.json');
    const moduleCells = board.cells.filter((cell: any) => cell.type === 'module');

    expect(moduleCells).toHaveLength(4);
    expect(moduleCells.every((cell: any) => (
      cell.module.id === 'prison' && cell.module.version === 1
    ))).toBe(true);
    // 进牢格把棋子送去哪一格由引擎按「棋盘上唯一的 jail 角格」自定，因此两类格的 payload 都必须是空对象。
    expect(moduleCells.every((cell: any) => Object.keys(cell.payload).length === 0)).toBe(true);

    expect(
      board.cells
        .filter((cell: any) => cell.cellType === 'goto-jail')
        .map((cell: any) => ({ id: cell.id, name: cell.name })),
    ).toEqual([
      { id: 5, name: '哨卡盘查' },
      { id: 17, name: '越界被扣' },
      { id: 33, name: '偷渡查获' },
    ]);
    // 监狱角格恰好一个 —— 引擎的 prisonJailCellId 取「最小 id」，多出来一个就会让传送目标静默改变。
    const jails = board.cells.filter((cell: any) => cell.cellType === 'jail');
    expect(jails).toHaveLength(1);
    expect(jails[0]).toMatchObject({ id: JAIL_ID, name: '旅顺监狱' });
    expect(GOTO_JAIL_IDS.every((id) => board.cells[id].cellType === 'goto-jail')).toBe(true);
  });

  it('declares 12 chance and 14 destiny cards, including the prison warp and the jail permit', () => {
    const cards = readMapJson('cards.json');
    const board = readMapJson('board.json');

    expect(cards.chance).toHaveLength(12);
    expect(cards.destiny).toHaveLength(14);
    expect(cards.chance.map((card: any) => card.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `db-c${String(index + 1).padStart(2, '0')}`),
    );
    expect(cards.destiny.map((card: any) => card.id)).toEqual(
      Array.from({ length: 14 }, (_, index) => `db-d${String(index + 1).padStart(2, '0')}`),
    );
    // 命运卡里的传送目标必须真的是一格车站，否则「车站急电」会把玩家丢到空地上。
    expect(cards.destiny.find((card: any) => card.id === 'db-d03').effect).toEqual({
      type: 'move_to',
      cellId: 11,
      collectSalary: true,
    });
    expect(board.cells[11]).toMatchObject({ subtype: 'station', name: '沈阳北站' });

    // 监狱两张牌：进牢（prison-confine，空 payload）与出狱许可证（prison-card，payload 只声明来源牌堆）。
    expect(cards.chance.find((card: any) => card.id === 'db-c11').effect).toEqual({
      type: 'module',
      module: { id: 'prison', version: 1 },
      effectType: 'prison-confine',
      payload: {},
    });
    expect(cards.chance.find((card: any) => card.id === 'db-c12').effect).toEqual({
      type: 'module',
      module: { id: 'prison', version: 1 },
      effectType: 'prison-card',
      payload: { deck: 'chance' },
    });
    expect(cards.destiny.find((card: any) => card.id === 'db-d14').effect).toEqual({
      type: 'module',
      module: { id: 'prison', version: 1 },
      effectType: 'prison-card',
      payload: { deck: 'destiny' },
    });
  });

  it('locks the owner-approved game config with jailEnabled turned on', () => {
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
      // 保释金（owner 2026-09-23 追加）：prison@1 的第三个出狱方式，只有带监狱的图才有这个字段。
      jailBailCost: 1500,
      cashGoalPresets: [33000, 52000],
      diceMode: 'two_dice',
      airportBranchDice: 1,
      jailEnabled: true,
    });
  });

  it('declares core@1 + prison@1, one presentation per cell and a 48-point serpentine route', () => {
    const manifest = readMapJson('manifest.json');
    const board = readMapJson('board.json');
    const route = manifest.presentation.routes.find((entry: any) => entry.role === 'route');

    expect(manifest.ref.id).toBe('northeast-tour');
    expect(manifest.ref.version).toBe(1);
    expect(manifest.ref.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.metadata.title).toBe('东北之旅');
    // 全仓第二张 core@1 之外还依赖模块的地图（第一张是 great-wall）；jailEnabled 必须与 prison@1 同步打开。
    expect(manifest.requiredRuleModules).toEqual([CORE_MODULE, PRISON_MODULE]);
    expect(Object.keys(manifest.presentation.cells).map(Number).sort((a, b) => a - b)).toEqual(
      board.cells.map((cell: { id: number }) => cell.id).sort((a: number, b: number) => a - b),
    );
    expect(route.type).toBe('polyline');
    // 折线约定：一格一个点、不为「末格 → 起点」补第 49 个点。
    expect(route.points).toHaveLength(board.cells.length);
    expect(manifest.presentation.center).toEqual([]);
    expect(Object.keys(manifest.presentation.theme.propertyBands)).toEqual([
      'band:liaoning',
      'band:jilin',
      'band:heilongjiang',
      'band:inner-mongolia',
      'band:station',
      'band:utility',
      'band:jail',
    ]);
  });

  it('is a deeply frozen valid immutable map pack whose hash matches its own bytes', () => {
    expect(() => assertValidMapPack(northeastTourMap, [CORE_MODULE, PRISON_MODULE])).not.toThrow();
    expect(computeContentHash(northeastTourMap)).toBe(northeastTourMap.ref.contentHash);
    expect(northeastTourMap.ref.contentHash)
      .toBe('5a001524cbe4c9e42597b978500bb6157ad6e08f59b37e76fa6522ba0fb63f9a');
    expect(Object.isFrozen(northeastTourMap)).toBe(true);
    expect(Object.isFrozen(northeastTourMap.game.board.cells)).toBe(true);
    expect(Object.isFrozen(northeastTourMap.game.cards.chance[10]!.effect)).toBe(true);
    expect(Object.isFrozen(northeastTourMap.presentation.cells[JAIL_ID]!)).toBe(true);
  });
});
