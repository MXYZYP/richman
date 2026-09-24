import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeContentHash } from '../hash';
import { assertValidMapPack } from '../mapValidation';
import { greatWallMap } from '../greatWallMap';

const mapDirectory = new URL('../../maps/great-wall/v1/', import.meta.url);

const greatWallModule = { id: 'great-wall', version: 1 } as const;
const coreModule = { id: 'core', version: 1 } as const;

function readMapJson(fileName: string): any {
  const fileUrl = new URL(fileName, mapDirectory);
  expect(existsSync(fileUrl), `great-wall/v1/${fileName} must exist`).toBe(true);
  return JSON.parse(readFileSync(fileUrl, 'utf8'));
}

/** 蛇形网格几何：偶数段自西向东、奇数段折返，段与段之间换行。 */
function expectedPlacement(id: number) {
  const row = Math.floor(id / 8);
  const col = row % 2 === 0 ? id % 8 : 7 - (id % 8);
  return { x: 1 + col * 15, y: 1 + row * 20, width: 13, height: 18 };
}

const expectedBeacons = [
  { id: 5, name: '烽火台·肃州', claimCost: 600, toll: 300 },
  { id: 13, name: '烽火台·焉支', claimCost: 600, toll: 300 },
  { id: 21, name: '烽火台·索桥', claimCost: 800, toll: 400 },
  { id: 29, name: '烽火台·花马池', claimCost: 800, toll: 400 },
  { id: 36, name: '烽火台·府谷', claimCost: 1000, toll: 500 },
  { id: 44, name: '烽火台·居庸', claimCost: 1000, toll: 500 },
];

describe('great-wall@1 approved source data', () => {
  it('locks the 48-cell boustrophedon loop from 嘉峪关 to 山海关', () => {
    const board = readMapJson('board.json');

    expect(board.cells).toHaveLength(48);
    expect(board.cells.map((cell: { id: number }) => cell.id)).toEqual(
      Array.from({ length: 48 }, (_, index) => index),
    );
    expect(board.cells[0]).toMatchObject({ id: 0, type: 'start', name: '起点' });
    expect(board.cells[47]).toMatchObject({ id: 47, name: '山海关', nextId: 0 });
    expect(board.cells[board.cells.length - 1].nextId).toBe(0);
    // 除了末格显式折回起点，其余格沿数组顺序前进。
    expect(
      board.cells
        .filter((cell: { id: number }) => cell.id !== 47)
        .every((cell: { nextId?: number }) => cell.nextId === undefined),
    ).toBe(true);
    expect(board.boardName).toBe('大富翁·长城之旅');
  });

  it('carries exactly six beacons with their claim cost and toll', () => {
    const board = readMapJson('board.json');
    const beacons = board.cells.filter((cell: any) => cell.type === 'module');

    expect(
      beacons.map((cell: any) => ({
        id: cell.id,
        module: cell.module,
        cellType: cell.cellType,
        name: cell.name,
        claimCost: cell.payload.claimCost,
        toll: cell.payload.toll,
      })),
    ).toEqual(expectedBeacons.map((beacon) => ({
      ...beacon,
      module: greatWallModule,
      cellType: 'beacon',
    })));
    // 通行费必须严格小于占据费，否则占据行为无收益、规则失去意义。
    expect(beacons.every((cell: any) => cell.payload.toll < cell.payload.claimCost)).toBe(true);
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

    expect(normalProperties).toHaveLength(24);
    expect(stations).toHaveLength(4);
    expect(utilities).toHaveLength(2);
    expect(normalProperties.every((cell: any) => cell.rents.length === 6)).toBe(true);
    expect(stations.every((cell: any) => cell.rents.length === 4)).toBe(true);
    expect(utilities.every((cell: any) => cell.rents === undefined)).toBe(true);
    expect(normalProperties.every((cell: any) => cell.houseCost > 0)).toBe(true);
    expect(stations.every((cell: any) => cell.houseCost === undefined)).toBe(true);
  });

  it('requires price to equal exactly twice the mortgage for all 30 purchasable cells', () => {
    const board = readMapJson('board.json');
    const purchasable = board.cells.filter((cell: any) => cell.type === 'property');

    expect(purchasable).toHaveLength(30);
    expect(purchasable.every((cell: any) => cell.price === cell.mortgageValue * 2)).toBe(true);
  });

  it('declares 12 chance and 14 destiny cards, including one beacon-patrol', () => {
    const cards = readMapJson('cards.json');

    expect(cards.chance).toHaveLength(12);
    expect(cards.destiny).toHaveLength(14);
    expect(cards.chance.filter((card: any) => card.effect.type === 'module').map((card: any) => card)).toEqual([
      {
        id: 'gw-c03',
        text: '沿边墙巡视一圈：你名下每座烽火台带来 400 元',
        effect: {
          type: 'module',
          module: greatWallModule,
          effectType: 'beacon-patrol',
          payload: { perBeacon: 400 },
        },
      },
    ]);
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

  it('is the first map that enables a non-core rule module, and one presentation per cell', () => {
    const manifest = readMapJson('manifest.json');
    const board = readMapJson('board.json');

    expect(manifest.ref.id).toBe('great-wall');
    expect(manifest.ref.version).toBe(1);
    expect(manifest.ref.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.requiredRuleModules).toEqual([coreModule, greatWallModule]);
    expect(Object.keys(manifest.presentation.cells).map(Number).sort((a, b) => a - b)).toEqual(
      board.cells.map((cell: { id: number }) => cell.id).sort((a: number, b: number) => a - b),
    );
  });

  it('lays out an 8-column snake grid with two-unit gutters inside a square canvas', () => {
    const board = readMapJson('board.json');
    const manifest = readMapJson('manifest.json');

    expect(manifest.presentation.canvas).toEqual({ size: 120 });
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
          && placement.x + placement.width <= 120
          && placement.y + placement.height <= 120;
      }),
    ).toBe(true);
  });

  it('publishes a route polyline that threads every one of the six wall segments', () => {
    const manifest = readMapJson('manifest.json');
    const routes = manifest.presentation.routes;
    const route = routes.find((entry: any) => entry.role === 'route');

    expect(route.type).toBe('polyline');
    // 六段城墙 = 六个 y 高度，每段两个端点。
    expect(route.points).toHaveLength(12);
    expect([...new Set(route.points.map((point: any) => point.y))]).toEqual([10, 30, 50, 70, 90, 110]);
    expect(manifest.presentation.center).toEqual([]);
  });

  it('is a deeply frozen valid immutable map pack whose hash matches its own bytes', () => {
    expect(() => assertValidMapPack(greatWallMap, [coreModule, greatWallModule])).not.toThrow();
    expect(computeContentHash(greatWallMap)).toBe(greatWallMap.ref.contentHash);
    expect(Object.isFrozen(greatWallMap)).toBe(true);
    expect(Object.isFrozen(greatWallMap.game.board.cells)).toBe(true);
    expect(Object.isFrozen(greatWallMap.game.cards.chance[2]!.effect)).toBe(true);
    expect(Object.isFrozen(greatWallMap.presentation.cells[5]!)).toBe(true);
  });
});
