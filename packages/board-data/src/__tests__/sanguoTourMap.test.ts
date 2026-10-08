import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeContentHash } from '../hash';
import { assertValidMapPack } from '../mapValidation';
import { sanguoTourMap } from '../sanguoTourMap';

const mapDirectory = new URL('../../maps/sanguo-tour/v1/', import.meta.url);

const coreModule = { id: 'core', version: 1 } as const;
const sanguoModule = { id: 'sanguo', version: 1 } as const;

function readMapJson(fileName: string): any {
  const fileUrl = new URL(fileName, mapDirectory);
  expect(existsSync(fileUrl), `sanguo-tour/v1/${fileName} must exist`).toBe(true);
  return JSON.parse(readFileSync(fileUrl, 'utf8'));
}

const CANVAS = 100;
const MARGIN = 2;
/**
 * 四角大格 15×15、每边 6 枚 11×11 小格，首尾相接正好填满 96 的棋路：
 * 15×2 + 11×6 = 96。**不留间隙**——留了就会与 margin 抢空间，实测会挤到相邻格上。
 */
const CORNER = 15;
const SMALL = 11;

const round = (value: number): number => Math.round(value * 1e6) / 1e6;
const LO = MARGIN;
const HI = CANVAS - MARGIN;

/**
 * 环行序：0 起兵（左下角）→ 底边左到右 → 右下角 → 右边下到上 → 右上角 →
 * 顶边右到左 → 左上角 → 左边上到下。四个角落在 id 0/7/14/21，即每 7 格一个角。
 */
function ringLayout(): { x: number; y: number; w: number; h: number }[] {
  const layout: { x: number; y: number; w: number; h: number }[] = [];
  layout.push({ x: LO, y: HI - CORNER, w: CORNER, h: CORNER });
  for (let i = 0; i < 6; i += 1) {
    layout.push({ x: LO + CORNER + i * SMALL, y: HI - SMALL, w: SMALL, h: SMALL });
  }
  layout.push({ x: HI - CORNER, y: HI - CORNER, w: CORNER, h: CORNER });
  for (let i = 0; i < 6; i += 1) {
    layout.push({ x: HI - SMALL, y: HI - CORNER - SMALL * (6 - i), w: SMALL, h: SMALL });
  }
  layout.push({ x: HI - CORNER, y: LO, w: CORNER, h: CORNER });
  for (let i = 0; i < 6; i += 1) {
    layout.push({ x: HI - CORNER - SMALL * (6 - i), y: LO, w: SMALL, h: SMALL });
  }
  layout.push({ x: LO, y: LO, w: CORNER, h: CORNER });
  for (let i = 0; i < 6; i += 1) {
    layout.push({ x: LO, y: LO + CORNER + i * SMALL, w: SMALL, h: SMALL });
  }
  return layout;
}

const layout = ringLayout();

describe('sanguo-tour@1 approved source data', () => {
  it('locks a single 28-cell closed loop: four corners plus six small tiles per side', () => {
    const board = readMapJson('board.json');

    expect(board.cells).toHaveLength(28);
    expect(layout).toHaveLength(28);
    expect(board.cells.map((cell: { id: number }) => cell.id)).toEqual(
      Array.from({ length: 28 }, (_, index) => index),
    );
    // 实物棋盘：四角大格 + 每边 6 枚小格 = 4 + 24 = 28，从任一边看都是 8 格。
    // 角格落在 0/7/14/21，每 7 格一个 —— 这条断言就是「28 = 6×4 + 4」的结构锁。
    expect([0, 7, 14, 21].map((id) => layout[id]!.w)).toEqual([CORNER, CORNER, CORNER, CORNER]);
    for (let id = 0; id < 28; id += 1) {
      if ([0, 7, 14, 21].includes(id)) continue;
      expect(layout[id]!.w, `id ${id} 应是小格`).toBe(SMALL);
    }
    expect(board.cells[0]).toMatchObject({ id: 0, type: 'start', name: '起兵' });
    expect(board.cells[27]).toMatchObject({ id: 27, type: 'property', name: '新野', nextId: 0 });
    // 只有末格显式写 nextId；其余 27 格靠「数组下一项即后继」的隐式约定。
    expect(
      board.cells
        .filter((cell: { nextId?: number }) => cell.nextId !== undefined)
        .map((cell: { id: number }) => cell.id),
    ).toEqual([27]);
    // 纯闭环棋盘没有机场支线，因此不需要机场格。
    expect(board.cells.filter((cell: any) => cell.type === 'airport')).toHaveLength(0);
  });

  it('lays out four corner tiles and six-tile sides that exactly tile the 96-wide ring', () => {
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
    ).toEqual(layout.map((cell, id) => ({
      id,
      x: cell.x,
      y: cell.y,
      width: cell.w,
      height: cell.h,
    })));

    // 四边留白都是 2：格子贴到 2 / 98，不允许某一侧多留或��留。
    expect(Math.min(...layout.map((cell) => cell.x))).toBe(LO);
    expect(Math.min(...layout.map((cell) => cell.y))).toBe(LO);
    expect(Math.max(...layout.map((cell) => cell.x + cell.w))).toBe(HI);
    expect(Math.max(...layout.map((cell) => cell.y + cell.h))).toBe(HI);

    // 首尾相接的判据：同一边的格子按 x 排序后相邻两格**恰好**首尾相接（差值 = 前一格宽度），
    // 不是「间距为正」。留了缝就会在某一侧越界，贴死了又会在角上与角格重叠。
    const bottomRow = layout.slice(0, 8);
    for (let index = 1; index < bottomRow.length; index += 1) {
      expect(round(bottomRow[index]!.x - (bottomRow[index - 1]!.x + bottomRow[index - 1]!.w))).toBe(0);
    }
    expect(CORNER * 2 + SMALL * 6).toBe(HI - LO);
  });

  it('keeps four rent tiers for every property, matching the three house levels on the title deeds', () => {
    const board = readMapJson('board.json');
    const config = readMapJson('game-config.json');
    const properties = board.cells.filter((cell: any) => cell.type === 'property');

    expect(properties).toHaveLength(14);
    // 实物产权纸印四档：空地 / 一兵营 / 二兵营 / 一城池 ⇒ maxHouseLevel = 3，租金档数 = 4。
    expect(config.maxHouseLevel).toBe(3);
    expect(properties.every((cell: any) => cell.rents.length === config.maxHouseLevel + 1)).toBe(true);
    expect(properties.every((cell: any) => cell.houseCost > 0)).toBe(true);
    // 抵押价必须落在 [0, price] 内，否则引擎的抵押/赎回会凭空造钱。
    expect(properties.every((cell: any) => cell.mortgageValue >= 0 && cell.mortgageValue < cell.price)).toBe(true);
    for (const cell of properties) {
      const rents: number[] = cell.rents;
      expect(
        rents.every((rent, index) => index === 0 || rent >= rents[index - 1]!),
        `${cell.name} 租金倒挂`,
      ).toBe(true);
    }
  });

  it('takes land prices and rents from the printed title deeds', () => {
    const board = readMapJson('board.json');
    const at = (id: number) => board.cells.find((cell: any) => cell.id === id);

    // 地价与四档租金逐格锁定：数值一旦漂移，「登上某座城」的量级判断就失真了。
    expect(at(1)).toMatchObject({ name: '寿春', price: 1400, rents: [180, 900, 2500, 7000], houseCost: 1500, mortgageValue: 1100 });
    expect(at(6)).toMatchObject({ name: '陈留', price: 3200, rents: [300, 1500, 4400, 9800], houseCost: 2000, mortgageValue: 1500 });
    expect(at(13)).toMatchObject({ name: '长安', price: 2400, rents: [1500, 4500, 10000, 20000], houseCost: 2000, mortgageValue: 1600 });
    expect(at(23)).toMatchObject({ name: '吴', price: 1000, rents: [200, 300, 900, 2700], houseCost: 500, mortgageValue: 500 });

    // ⚠️ 刻意偏离实物两处，写在这里以免日后被当成「读错了」而「修正」：
    // ① 陈留的城池档 9800 与长安的 20000：产权纸「一座城池」栏印作「—」（未读到），
    //    按同价位相邻档插值 / 外推填的。
    // ② 义士的 houseCost 取 1500（兵营费）而非实物印的城池费 10500 ——
    //    PropertyCell.houseCost 是**单值**字段，无法同时表达兵营与城池两档，
    //    其余 13 张产权纸两列相等，故按多数派取兵营费。
    expect(at(18)).toMatchObject({ name: '义士', price: 2400, houseCost: 1500, mortgageValue: 1100 });

    const prices: number[] = board.cells
      .filter((cell: any) => cell.type === 'property')
      .map((cell: any) => cell.price as number);
    expect(Math.min(...prices)).toBe(1000);
    expect(Math.max(...prices)).toBe(3600);
    expect([...new Set(prices)].sort((left, right) => left - right)).toEqual([
      1000, 1400, 1600, 2000, 2200, 2400, 2600, 3000, 3200, 3600,
    ]);
  });

  it('places two battle cells, two shrines, two card cells, two taxes and three specials', () => {
    const board = readMapJson('board.json');
    const byType = (type: string) => board.cells.filter((cell: any) => cell.type === type);

    expect(byType('start')).toHaveLength(1);
    expect(byType('property')).toHaveLength(14);
    expect(byType('module')).toHaveLength(4);
    expect(byType('chance')).toHaveLength(2);
    expect(byType('destiny')).toHaveLength(2);
    expect(byType('tax')).toHaveLength(2);
    expect(byType('special')).toHaveLength(3);

    // 战场与功德祠各两处、分列棋盘两段，玩家能攒出「专攻一侧」与「两头兼顾」两种走法。
    expect(byType('module').map((cell: any) => ({
      id: cell.id,
      name: cell.name,
      module: cell.module,
      cellType: cell.cellType,
      payload: cell.payload,
    }))).toEqual([
      { id: 3, name: '官渡之战', module: sanguoModule, cellType: 'battle', payload: {} },
      { id: 9, name: '功德祠', module: sanguoModule, cellType: 'shrine', payload: {} },
      { id: 12, name: '赤壁之战', module: sanguoModule, cellType: 'battle', payload: {} },
      { id: 26, name: '功德祠', module: sanguoModule, cellType: 'shrine', payload: {} },
    ]);

    // 抽卡格绝不贴连：连着抽两张会让一整回合只剩运气（环首尾也一并检查）。
    const cardIds: number[] = board.cells
      .filter((cell: any) => cell.type === 'chance' || cell.type === 'destiny')
      .map((cell: any) => cell.id as number);
    expect(cardIds).toEqual([2, 10, 17, 24]);
    const gaps = cardIds.slice(1).map((id, index) => id - cardIds[index]!);
    gaps.push(board.cells.length - cardIds.at(-1)! + cardIds[0]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(2);

    expect(byType('tax').map((cell: any) => ({ name: cell.name, amount: cell.amount }))).toEqual([
      { name: '赋税', amount: 700 },
      { name: '赋税', amount: 700 },
    ]);
    // 实物棋盘上标蓝底的三个角格：隔岸观火（暂停一次）与开仓赈灾（缴银）都是四角大格。
    expect(byType('special').map((cell: any) => ({ id: cell.id, name: cell.name, effect: cell.effect }))).toEqual([
      { id: 7, name: '隔岸观火', effect: { type: 'skip_turn', turns: 1 } },
      { id: 14, name: '开仓赈灾', effect: { type: 'pay_bank', amount: 2000 } },
      { id: 21, name: '三国赤壁', effect: { type: 'receive_from_each_player', amount: 1000 } },
    ]);
  });

  it('declares 12 招兵买马 and 15 锦囊妙计 cards, all routed through core or sanguo effects', () => {
    const cards = readMapJson('cards.json');

    expect(cards.chance).toHaveLength(12);
    expect(cards.destiny).toHaveLength(15);
    expect(cards.chance.map((card: any) => card.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `sg-c${String(index + 1).padStart(2, '0')}`),
    );
    expect(cards.destiny.map((card: any) => card.id)).toEqual(
      Array.from({ length: 15 }, (_, index) => `sg-d${String(index + 1).padStart(2, '0')}`),
    );

    // 模块效果只允许 6 种，且必须由 sanguo@1 承接；其余一律走 core 效果。
    const MODULE_EFFECTS = [
      'sanguo-grant', 'sanguo-shield', 'sanguo-swap',
      'sanguo-fortify', 'sanguo-freeze', 'sanguo-supply',
    ];
    for (const card of [...cards.chance, ...cards.destiny]) {
      const effect = card.effect;
      if (effect?.type === 'module') {
        expect(MODULE_EFFECTS, `${card.id} 的效果 ${effect.effectType} 不受支持`).toContain(effect.effectType);
        expect(effect.module, `${card.id} 的模块效果必须由 sanguo@1 承接`).toEqual(sanguoModule);
      } else {
        expect(
          ['draw_card', 'receive_bank', 'pay_bank', 'move_steps', 'skip_turn',
            'receive_from_each_player', 'pay_each_player'],
          `${card.id} 的核心效果 ${effect?.type} 不在白名单内`,
        ).toContain(effect?.type);
      }
    }

    // 收支两类卡必须把方向写进 kind，否则「罚银」会被当成「赏银」。
    const grants = [...cards.chance, ...cards.destiny]
      .filter((card: any) => card.effect?.effectType === 'sanguo-grant');
    expect(grants.map((card: any) => [card.id, card.effect.payload.kind])).toEqual([
      ['sg-c01', 'reward'], ['sg-c02', 'reward'], ['sg-c06', 'reward'],
      ['sg-c09', 'penalty'], ['sg-c10', 'penalty'],
    ]);
    // 「再翻一张」（sg-d05）必须指定牌堆，否则会从空牌堆里抽。
    expect(cards.destiny.find((card: any) => card.id === 'sg-d05').effect).toMatchObject({
      type: 'draw_card',
      deck: 'chance',
    });
    expect(cards.chance.find((card: any) => card.id === 'sg-c03').effect).toMatchObject({
      type: 'draw_card',
      deck: 'destiny',
    });
  });

  it('locks the owner-approved game config with maxHouseLevel 3', () => {
    expect(readMapJson('game-config.json')).toEqual({
      initialCash: 2000,
      // 实物规则书：起兵 2000 两，每过一次起点领 2000 两。
      // 相对其他图（多为 15000）薄很多，但地价档位（1000~3600）也随之低一个量级，
      // 两档现金目标仍然保证约 4~8 圈可终局。
      passStartSalary: 2000,
      maxHouseLevel: 3,
      sellHouseRefundRate: 0.5,
      sellLandRate: 0.5,
      mortgageInterestRate: 0.1,
      utilityMultipliers: [10, 100],
      jailExitMinRoll: 10,
      jailMaxAttempts: 3,
      // 两档都高于 initialCash 且互不重复（校验器硬规则）。
      cashGoalPresets: [8000, 16000],
      diceMode: 'two_dice',
      airportBranchDice: 1,
      // 本图不声明 prison@1，因此 jailEnabled 必须为 false 且**完全不写** jailBailCost。
      jailEnabled: false,
    });
  });

  // An empty centre left the middle of the board bare, which is what made every board
  // read as loose tiles on a table. The centre now carries a panel plus the map name.
  it('fills the centre with a panel and the map name', () => {
    const manifest = readMapJson('manifest.json');
    const center = manifest.presentation.center;
    const panel = center.find((decoration: { type: string }) => decoration.type === 'panel');
    const titleNode = center.find((decoration: { type: string }) => decoration.type === 'text');
    expect(panel).toBeDefined();
    expect(titleNode).toBeDefined();
    expect(panel!.role).toBe('center');
    expect(titleNode!.role).toBe('title');
    expect(titleNode!.text).toBe('三国风云');
    // Both must sit inside the canvas, and the title must paint above the panel.
    expect(panel!.x).toBeGreaterThanOrEqual(0);
    expect(panel!.y).toBeGreaterThanOrEqual(0);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(100);
    expect(panel!.y + panel!.height).toBeLessThanOrEqual(100);
    expect(titleNode!.zIndex).toBeGreaterThan(panel!.zIndex);
    // The title is centred horizontally on the board.
    expect(titleNode!.x + titleNode!.width / 2).toBeCloseTo(50, 3);
  });

  it('reuses only built-in icons, because BUILT_IN_ICONS has no 三国-specific entry', () => {
    const manifest = readMapJson('manifest.json');
    const placements = Object.values(manifest.presentation.cells) as { artwork?: { icon?: string } }[];

    // 内建图标白名单只有 9 个：start / airport / chance / destiny / tax /
    // special-food / special-moon / world。三国没有专属图标，因此：
    // 战场与功德祠 → world；隔岸观火 → special-moon；开仓赈灾与三国赤壁 → special-food。
    const icons = [...new Set(placements.map((cell) => cell.artwork?.icon).filter(Boolean))];
    expect(icons.sort()).toEqual([
      'chance', 'destiny', 'special-food', 'special-moon', 'start', 'tax', 'world',
    ]);
    const iconOf = (id: number) => manifest.presentation.cells[id].artwork?.icon;
    expect(iconOf(0)).toBe('start');
    expect(iconOf(2)).toBe('destiny');
    expect(iconOf(3)).toBe('world');
    expect(iconOf(5)).toBe('tax');
    expect(iconOf(7)).toBe('special-moon');
    expect(iconOf(9)).toBe('world');
    expect(iconOf(10)).toBe('chance');
    expect(iconOf(14)).toBe('special-food');
    expect(iconOf(21)).toBe('special-food');
  });

  it('gives every declared band a cell and never reuses one hex across two bands', () => {
    const manifest = readMapJson('manifest.json');
    const bands = manifest.presentation.theme.propertyBands as Record<string, string>;
    const placements = Object.values(manifest.presentation.cells) as { propertyBand?: string }[];

    expect(Object.keys(bands)).toEqual([
      'band:zhongyuan', 'band:shu', 'band:jiangdong', 'band:jingzhou', 'band:shouchun',
    ]);
    // 声明了却零引用的色带是死配置：改它不会有任何视觉反馈，容易被误当成「已生效」。
    const used = new Set(placements.map((cell) => cell.propertyBand).filter(Boolean));
    expect([...Object.keys(bands)].filter((token) => !used.has(token))).toEqual([]);
    // 两个地区共用同一个色值 = 棋盘上分不出边界，直接违背「配色辨识度」。
    expect([...new Set(Object.values(bands))]).toHaveLength(Object.keys(bands).length);
    for (const cell of placements) {
      if (cell.propertyBand !== undefined) {
        expect(Object.hasOwn(bands, cell.propertyBand), `${cell.propertyBand} 未声明`).toBe(true);
      }
    }
    // 中原（陈留 / 洛阳 / 汝南）同色，是本图唯一的成组色带。
    expect([6, 8, 11].map((id) => manifest.presentation.cells[id].propertyBand)).toEqual([
      'band:zhongyuan', 'band:zhongyuan', 'band:zhongyuan',
    ]);
    // 寿春单独一条色带：它是全图地价最低（1400）的一城，不与中原混色。
    expect(manifest.presentation.cells[1].propertyBand).toBe('band:shouchun');
  });

  it('separates 赤壁之战 (battle) from 三国赤壁 (tribute)', () => {
    const placements = sanguoTourMap.presentation.cells;
    expect(placements[12]!.shortLabel).toBe('赤壁');
    expect(placements[21]!.shortLabel).toBe('大战');
    // board data keeps the historical names untouched.
    const nameOf = (id: number) => sanguoTourMap.game.board.cells
      .find((cell) => cell.id === id)?.name;
    expect(nameOf(12)).toBe('赤壁之战');
    expect(nameOf(21)).toBe('三国赤壁');
  });

  // Two distinct properties rendering the same text are indistinguishable on the board:
  // shortLabel overrides cell.name (clientGame.ts), so the collision is player-visible.
  // Repeating a non-property KIND (机会 / 命运 / 赋税 / 功德祠) is the design, so only
  // property cells must be unique.
  it('renders every property under a label no other property shares', () => {
    const placements = sanguoTourMap.presentation.cells;
    const seen = new Map<string, { id: number; name: string }>();
    for (const cell of sanguoTourMap.game.board.cells) {
      if (cell.type !== 'property') continue;
      const placement = placements[cell.id]!;
      const shown = placement.compactLabel ?? placement.shortLabel;
      const previous = seen.get(shown);
      expect(
        previous,
        `cells ${previous?.id} (${previous?.name}) and ${cell.id} (${cell.name}) both render "${shown}"`,
      ).toBeUndefined();
      seen.set(shown, { id: cell.id, name: cell.name });
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('is a deeply frozen valid immutable map pack whose hash matches its own bytes', () => {
    expect(() => assertValidMapPack(sanguoTourMap, [coreModule, sanguoModule])).not.toThrow();
    expect(computeContentHash(sanguoTourMap)).toBe(sanguoTourMap.ref.contentHash);
    expect(sanguoTourMap.ref.contentHash)
      .toBe('52974371912680b4759e146a797a035f72b191897156fd7f5410b29750596d1d');
    expect(Object.isFrozen(sanguoTourMap)).toBe(true);
    expect(Object.isFrozen(sanguoTourMap.game.board.cells)).toBe(true);
    expect(Object.isFrozen(sanguoTourMap.game.cards.chance[0]!.effect)).toBe(true);
    expect(Object.isFrozen(sanguoTourMap.presentation.cells[0]!)).toBe(true);
  });
});