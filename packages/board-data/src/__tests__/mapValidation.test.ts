import { describe, expect, it } from 'vitest';
import { chinaTourMap } from '../chinaTourMap';
import { computeContentHash } from '../hash';
import { assertValidMapPack } from '../mapValidation';
import type { MapPack } from '../mapTypes';
import type { BoardData } from '../types';

const directionlessBoard = {
  boardName: 'Directionless board',
  cells: [{ id: 0, type: 'start', name: 'Launch', nextId: 0 }],
} satisfies BoardData;

function editableChinaTour(): any {
  return structuredClone(chinaTourMap);
}

// #23 之后 china-tour 声明了 rail-hub@1；凡是以 china-tour 为底稿的用例都必须带上它，
// 否则会在「未知规则模块」这一步提前失败，掩盖掉真正想断言的校验分支。
const CHINA_TOUR_MODULES = [
  { id: 'core', version: 1 },
  { id: 'rail-hub', version: 1 },
] as const;

function rehash(pack: any): MapPack {
  pack.ref.contentHash = computeContentHash(pack as MapPack);
  return pack as MapPack;
}

function makeMinimalMap(): MapPack {
  const pack: any = {
    ref: { id: 'island-loop', version: 1, contentHash: '0'.repeat(64) },
    metadata: { title: 'Island Loop', description: 'A compact test map' },
    game: {
      board: {
        boardName: 'Island Loop',
        cells: [
          { id: 0, type: 'start', name: 'Launch' },
          {
            id: 10,
            type: 'property',
            subtype: 'normal',
            name: 'Cedar Bay',
            price: 100,
            mortgageValue: 50,
            houseCost: 25,
            rents: [5, 10, 20],
          },
          { id: 42, type: 'chance', name: 'Signal', nextId: 0 },
        ],
      },
      cards: {
        chance: [{ id: 'signal-1', text: 'Wait here', effect: { type: 'none' } }],
        destiny: [],
      },
      config: {
        initialCash: 1_000,
        passStartSalary: 100,
        maxHouseLevel: 2,
        sellHouseRefundRate: 0.5,
        sellLandRate: 0.5,
        mortgageInterestRate: 0.1,
        utilityMultipliers: [4, 10],
        jailExitMinRoll: 4,
        jailMaxAttempts: 3,
        cashGoalPresets: [2_000, 3_000],
        diceMode: 'two_dice',
        airportBranchDice: 1,
        jailEnabled: false,
      },
      requiredRuleModules: [{ id: 'core', version: 1 }],
    },
    presentation: {
      canvas: { size: 40 },
      cells: {
        0: { x: 0, y: 0, width: 8, height: 8, shortLabel: 'Go' },
        10: {
          x: 8,
          y: 0,
          width: 8,
          height: 8,
          shortLabel: 'Cedar',
          propertyBand: 'band:cedar',
        },
        42: { x: 16, y: 0, width: 8, height: 8, shortLabel: 'Signal' },
      },
      routes: [],
      center: [],
      theme: {
        colors: {
          board: '#ffffff', cell: '#eeeeee', border: '#111111', route: '#222222',
          title: '#333333', decoration: '#444444', center: '#dddddd',
        },
        propertyBands: { 'band:cedar': '#008866' },
      },
    },
  };
  return rehash(pack);
}

const worldTourModules = [
  { id: 'core', version: 1 },
  { id: 'world-tour', version: 1 },
] as const;

function makeWorldTourModuleMap(): MapPack {
  const pack: any = {
    ref: { id: 'world-tour-fixture', version: 1, contentHash: '0'.repeat(64) },
    metadata: { title: 'World Tour fixture', description: 'Airport module validation fixture' },
    game: {
      board: {
        boardName: 'World Tour fixture',
        cells: [
          { id: 0, type: 'start', name: 'Start' },
          {
            id: 10,
            type: 'module',
            name: 'Bangkok airport',
            nextId: 11,
            module: { id: 'world-tour', version: 1 },
            cellType: 'airport-branch',
            payload: {
              outerNextId: 11,
              branchEntryId: 40,
              branchCellIds: [40, 41],
              mergeCellId: 11,
            },
          },
          {
            id: 11,
            type: 'property',
            subtype: 'normal',
            name: 'Oslo',
            price: 100,
            mortgageValue: 50,
            houseCost: 25,
            rents: [5, 10, 20],
            nextId: 0,
          },
          { id: 40, type: 'special', name: 'Pacific', effect: { type: 'none' } },
          { id: 41, type: 'special', name: 'Delay', effect: { type: 'none' }, nextId: 11 },
        ],
      },
      cards: {
        chance: [{
          id: 'C22',
          text: 'Short flight',
          effect: {
            type: 'module',
            module: { id: 'world-tour', version: 1 },
            effectType: 'short-flight',
            payload: { cost: 3500, maxForwardSteps: 6 },
          },
        }],
        destiny: [],
      },
      config: {
        initialCash: 1_000,
        passStartSalary: 100,
        maxHouseLevel: 2,
        sellHouseRefundRate: 0.5,
        sellLandRate: 0.5,
        mortgageInterestRate: 0.1,
        utilityMultipliers: [4, 10],
        jailExitMinRoll: 4,
        jailMaxAttempts: 3,
        cashGoalPresets: [2_000, 3_000],
        diceMode: 'two_dice',
        airportBranchDice: 1,
        jailEnabled: false,
      },
      requiredRuleModules: worldTourModules,
    },
    presentation: {
      canvas: { size: 50 },
      cells: {
        0: { x: 0, y: 0, width: 8, height: 8, shortLabel: 'Start' },
        10: { x: 8, y: 0, width: 8, height: 8, shortLabel: 'Bangkok' },
        11: { x: 16, y: 0, width: 8, height: 8, shortLabel: 'Oslo' },
        40: { x: 8, y: 12, width: 8, height: 8, shortLabel: 'Pacific' },
        41: { x: 16, y: 12, width: 8, height: 8, shortLabel: 'Delay' },
      },
      routes: [],
      center: [],
      theme: {
        colors: {
          board: '#ffffff', cell: '#eeeeee', border: '#111111', route: '#222222',
          title: '#333333', decoration: '#444444', center: '#dddddd',
        },
        propertyBands: {},
      },
    },
  };
  return rehash(pack);
}

describe('assertValidMapPack', () => {
  it('descriptor-safe preflight 不执行 accessor，并在读取任何地图字段前拒绝', () => {
    const pack: any = makeMinimalMap();
    let getterCalls = 0;
    Object.defineProperty(pack.metadata, 'title', {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'Accessor title';
      },
    });

    expect(() => assertValidMapPack(pack, [{ id: 'core', version: 1 }])).toThrow(/accessor/i);
    expect(getterCalls).toBe(0);
  });

  it('接受 china-tour@1', () => {
    expect(() => assertValidMapPack(chinaTourMap, CHINA_TOUR_MODULES)).not.toThrow();
  });

  it.each([
    ['ref.id', (pack: any) => { pack.ref.id = 'China Tour'; }, /ref\.id.*slug/i],
    ['ref.version', (pack: any) => { pack.ref.version = 0; }, /ref\.version.*positive integer/i],
    ['metadata.title', (pack: any) => { pack.metadata.title = '  '; }, /metadata\.title.*non-empty/i],
    ['metadata.description', (pack: any) => { pack.metadata.description = ''; }, /metadata\.description.*non-empty/i],
  ])('拒绝非法 %s', (_path, mutate, expected) => {
    const pack = editableChinaTour();
    mutate(pack);

    expect(() => assertValidMapPack(rehash(pack), CHINA_TOUR_MODULES)).toThrow(expected);
  });

  it('拒绝未知 core cell type，并允许相邻租金档相等', () => {
    const unknown: any = makeMinimalMap();
    unknown.game.board.cells[2].type = 'mystery';
    expect(() => assertValidMapPack(rehash(unknown), [{ id: 'core', version: 1 }])).toThrow(
      /board\.cells\[2\]\.type.*supported core cell/i,
    );

    const flatRent: any = makeMinimalMap();
    flatRent.game.board.cells[1].rents = [5, 5, 20];
    expect(() => assertValidMapPack(rehash(flatRent), [{ id: 'core', version: 1 }])).not.toThrow();
  });

  it('拒绝与 canonical 内容不一致的 hash', () => {
    const pack = editableChinaTour();
    pack.metadata.title = '被篡改的标题';

    expect(() => assertValidMapPack(pack, CHINA_TOUR_MODULES)).toThrow(
      /ref\.contentHash.*canonical/i,
    );
  });

  it('拒绝重复和未知规则模块', () => {
    const duplicate: any = makeMinimalMap();
    duplicate.game.requiredRuleModules.push({ id: 'core', version: 1 });
    expect(() => assertValidMapPack(rehash(duplicate), [{ id: 'core', version: 1 }])).toThrow(
      /game\.requiredRuleModules\[1\].*duplicate/i,
    );

    const unknown: any = makeMinimalMap();
    unknown.game.requiredRuleModules = [
      { id: 'core', version: 1 },
      { id: 'future', version: 1 },
    ];
    expect(() => assertValidMapPack(rehash(unknown), [{ id: 'core', version: 1 }])).toThrow(
      /game\.requiredRuleModules\[1\].*unknown/i,
    );

    const missingCore: any = makeMinimalMap();
    missingCore.game.requiredRuleModules = [];
    expect(() => assertValidMapPack(rehash(missingCore), [{ id: 'core', version: 1 }])).toThrow(
      /requiredRuleModules.*core@1/i,
    );
  });

  it('接受 required exact module 的 cell/effect envelope，并拒绝空 subtype 与未启用 ref', () => {
    const knownModules = [
      { id: 'core', version: 1 },
      { id: 'weather', version: 2 },
    ];
    const valid: any = makeMinimalMap();
    valid.game.requiredRuleModules.push({ id: 'weather', version: 2 });
    valid.game.board.cells[2] = {
      id: 42,
      type: 'module',
      name: 'Storm front',
      nextId: 0,
      module: { id: 'weather', version: 2 },
      cellType: 'storm',
      payload: { intensity: 3, tags: ['rain', null] },
    };
    valid.game.cards.chance[0].effect = {
      type: 'module',
      module: { id: 'weather', version: 2 },
      effectType: 'forecast',
      payload: { turns: 2 },
    };
    expect(() => assertValidMapPack(rehash(valid), knownModules)).not.toThrow();

    const emptySubtype = structuredClone(valid);
    emptySubtype.game.board.cells[2].cellType = '  ';
    expect(() => assertValidMapPack(rehash(emptySubtype), knownModules)).toThrow(/cellType.*non-empty/i);

    const notRequired = structuredClone(valid);
    notRequired.game.board.cells[2].module = { id: 'weather', version: 3 };
    expect(() => assertValidMapPack(rehash(notRequired), [
      ...knownModules,
      { id: 'weather', version: 3 },
    ])).toThrow(/module.*weather@3.*required/i);

    const emptyEffectType = structuredClone(valid);
    emptyEffectType.game.cards.chance[0].effect.effectType = '';
    expect(() => assertValidMapPack(rehash(emptyEffectType), knownModules)).toThrow(/effectType.*non-empty/i);

    const invalidPayload = structuredClone(valid);
    invalidPayload.game.board.cells[2].payload.invalid = undefined;
    expect(() => assertValidMapPack(rehash(invalidPayload), knownModules)).toThrow(/undefined|JSON/i);
  });

  it('接受由 world-tour@1 payload 声明并回到主环的机场支线', () => {
    expect(() => assertValidMapPack(makeWorldTourModuleMap(), worldTourModules)).not.toThrow();
  });

  it('要求 World Tour 地图同时声明 core@1 和 world-tour@1', () => {
    const missingCore: any = makeWorldTourModuleMap();
    missingCore.game.requiredRuleModules = [{ id: 'world-tour', version: 1 }];
    expect(() => assertValidMapPack(rehash(missingCore), worldTourModules)).toThrow(
      /requiredRuleModules.*core@1/i,
    );

    const missingWorldTour: any = makeWorldTourModuleMap();
    missingWorldTour.game.requiredRuleModules = [{ id: 'core', version: 1 }];
    expect(() => assertValidMapPack(rehash(missingWorldTour), worldTourModules)).toThrow(
      /module.*world-tour@1.*required/i,
    );
  });

  it.each([
    [
      'malformed entry',
      (pack: any) => { pack.game.board.cells[1].payload.branchEntryId = '40'; },
      /payload\.branchEntryId.*safe integer/i,
    ],
    [
      'wrong branch membership',
      (pack: any) => { pack.game.board.cells[1].payload.branchCellIds = [40]; },
      /payload\.branchCellIds.*branch route/i,
    ],
    [
      'wrong merge',
      (pack: any) => { pack.game.board.cells[1].payload.mergeCellId = 0; },
      /payload\.mergeCellId.*branch route/i,
    ],
  ])('拒绝非法 World Tour airport payload：%s', (_label, mutate, expected) => {
    const pack: any = makeWorldTourModuleMap();
    mutate(pack);
    expect(() => assertValidMapPack(rehash(pack), worldTourModules)).toThrow(expected);
  });

  it('拒绝非法 World Tour choice effect payload', () => {
    const pack: any = makeWorldTourModuleMap();
    pack.game.cards.chance[0].effect.payload.cost = -1;
    expect(() => assertValidMapPack(rehash(pack), worldTourModules)).toThrow(
      /payload\.cost.*non-negative/i,
    );
  });

  it('拒绝 World Tour 内容变动后的 stale hash', () => {
    const pack: any = makeWorldTourModuleMap();
    pack.metadata.description = 'Changed after hashing';
    expect(() => assertValidMapPack(pack, worldTourModules)).toThrow(
      /ref\.contentHash.*canonical/i,
    );
  });

  it.each([
    ['game.cards.chance', (pack: any) => { pack.game.cards.chance = null; }, /game\.cards\.chance.*array/i],
    ['requiredRuleModules', (pack: any) => { pack.game.requiredRuleModules = null; }, /requiredRuleModules.*array/i],
    ['presentation.cells', (pack: any) => { pack.presentation.cells = null; }, /presentation\.cells.*object/i],
    ['presentation.theme.colors', (pack: any) => { pack.presentation.theme.colors = null; }, /theme\.colors.*object/i],
  ])('对非法 runtime shape 抛出带路径错误：%s', (_label, mutate, expected) => {
    const pack: any = makeMinimalMap();
    mutate(pack);
    expect(() => assertValidMapPack(rehash(pack), [{ id: 'core', version: 1 }])).toThrow(expected);
  });

  it.each([
    ['pack', null, /mapPack.*object/i],
    ['ref', { ...makeMinimalMap(), ref: null }, /ref.*object/i],
    ['metadata', { ...makeMinimalMap(), metadata: null }, /metadata.*object/i],
    ['game', { ...makeMinimalMap(), game: null }, /game.*object/i],
    ['board', (() => { const pack: any = makeMinimalMap(); pack.game.board = null; return pack; })(), /game\.board.*object/i],
    ['config', (() => { const pack: any = makeMinimalMap(); pack.game.config = null; return pack; })(), /game\.config.*object/i],
    ['cards', (() => { const pack: any = makeMinimalMap(); pack.game.cards = null; return pack; })(), /game\.cards.*object/i],
    ['presentation', { ...makeMinimalMap(), presentation: null }, /presentation.*object/i],
    ['canvas', (() => { const pack: any = makeMinimalMap(); pack.presentation.canvas = null; return pack; })(), /presentation\.canvas.*object/i],
    ['theme', (() => { const pack: any = makeMinimalMap(); pack.presentation.theme = null; return pack; })(), /presentation\.theme.*object/i],
  ])('unknown boundary 拒绝 null container：%s', (_label, value, expected) => {
    expect(() => assertValidMapPack(value, [{ id: 'core', version: 1 }])).toThrow(expected);
  });

  it.each([
    ['cell', (pack: any) => { pack.game.board.cells[1] = null; }, /game\.board\.cells\[1\].*object/i],
    ['card', (pack: any) => { pack.game.cards.chance[0] = null; }, /game\.cards\.chance\[0\].*object/i],
    ['module', (pack: any) => { pack.game.requiredRuleModules[0] = null; }, /requiredRuleModules\[0\].*object/i],
    ['placement', (pack: any) => { pack.presentation.cells[10] = null; }, /presentation\.cells\.10.*object/i],
    ['route', (pack: any) => { pack.presentation.routes = [null]; }, /presentation\.routes\[0\].*object/i],
    ['center', (pack: any) => { pack.presentation.center = [null]; }, /presentation\.center\[0\].*object/i],
  ])('unknown boundary 拒绝 null element：%s', (_label, mutate, expected) => {
    const pack: any = makeMinimalMap();
    mutate(pack);
    expect(() => assertValidMapPack(pack, [{ id: 'core', version: 1 }])).toThrow(expected);
  });

  it('先报告结构/语义错误，再在最后校验 canonical hash', () => {
    const pack: any = makeMinimalMap();
    pack.game.config.jailEnabled = true;
    expect(() => assertValidMapPack(pack, [{ id: 'core', version: 1 }])).toThrow(
      /game\.config\.jailEnabled.*false/i,
    );
  });

  it('接受非中国标签、非连续非起点 ID、无机场支线的最小地图且不修改输入', () => {
    const pack = makeMinimalMap();
    const before = structuredClone(pack);

    expect(() => assertValidMapPack(pack, [{ id: 'core', version: 1 }])).not.toThrow();
    expect(pack).toEqual(before);
    expect(directionlessBoard).not.toHaveProperty('direction');
  });

  it('允许非 start 使用负 safe integer ID，并仅接受 legacy clockwise direction', () => {
    const negativeId: any = makeMinimalMap();
    negativeId.game.board.cells[1].id = -10;
    negativeId.presentation.cells[-10] = negativeId.presentation.cells[10];
    delete negativeId.presentation.cells[10];
    expect(() => assertValidMapPack(rehash(negativeId), [{ id: 'core', version: 1 }])).not.toThrow();

    const invalidDirection: any = makeMinimalMap();
    invalidDirection.game.board.direction = 'counterclockwise';
    expect(() => assertValidMapPack(rehash(invalidDirection), [{ id: 'core', version: 1 }])).toThrow(
      /game\.board\.direction.*clockwise/i,
    );
  });

  it.each([
    ['重复 cell ID', (pack: any) => { pack.game.board.cells[1].id = 0; }, /board\.cells\[1\]\.id.*unique/i],
    ['非 0 start', (pack: any) => { pack.game.board.cells[0].id = 5; }, /start.*id 0/i],
    ['多个 start', (pack: any) => { pack.game.board.cells[1].type = 'start'; }, /exactly one start/i],
    ['不存在的 nextId', (pack: any) => { pack.game.board.cells[0].nextId = 999; }, /nextId.*existing cell/i],
    ['末格无 nextId', (pack: any) => { delete pack.game.board.cells[2].nextId; }, /cells\[2\]\.nextId.*explicit/i],
    ['主路线不回到起点', (pack: any) => { pack.game.board.cells[2].nextId = 10; }, /main route.*start/i],
  ])('拒绝非法棋盘图：%s', (_label, mutate, expected) => {
    const pack: any = makeMinimalMap();
    mutate(pack);

    expect(() => assertValidMapPack(rehash(pack), [{ id: 'core', version: 1 }])).toThrow(expected);
  });

  it('校验每一个 airport 的 branchEntryId', () => {
    const pack = editableChinaTour();
    pack.game.board.cells[14] = {
      id: 14,
      type: 'airport',
      name: '第二机场',
      branchEntryId: 999,
    };

    expect(() => assertValidMapPack(rehash(pack), CHINA_TOUR_MODULES)).toThrow(
      /board\.cells\[14\]\.branchEntryId.*existing cell/i,
    );
  });

  it.each([
    ['move_to cellId', (effect: any) => { effect.cellId = 999; }, /cellId.*existing cell/i],
    ['move_to collectSalary', (effect: any) => { delete effect.collectSalary; }, /collectSalary.*boolean/i],
    ['cash amount', (effect: any) => { effect.type = 'pay_bank'; delete effect.cellId; delete effect.collectSalary; }, /amount.*finite/i],
    ['repairs perHotel', (effect: any) => { effect.type = 'repairs'; effect.perHouse = 10; delete effect.cellId; delete effect.collectSalary; }, /perHotel.*finite/i],
    ['draw_card deck', (effect: any) => { effect.type = 'draw_card'; effect.deck = 'mystery'; delete effect.cellId; delete effect.collectSalary; }, /deck.*chance.*destiny/i],
  ])('拒绝不完整或非法 effect：%s', (_label, mutate, expected) => {
    const pack = editableChinaTour();
    const cards = [...pack.game.cards.chance, ...pack.game.cards.destiny];
    const effect = cards.find((card: any) => card.effect.type === 'move_to').effect;
    mutate(effect);

    expect(() => assertValidMapPack(rehash(pack), CHINA_TOUR_MODULES)).toThrow(expected);
  });

  it.each([
    ['normal rents 档数', (pack: any) => { pack.game.board.cells[1].rents = [5, 10]; }, /rents.*maxHouseLevel/i],
    ['normal houseCost', (pack: any) => { delete pack.game.board.cells[1].houseCost; }, /houseCost.*non-negative/i],
    ['price', (pack: any) => { pack.game.board.cells[1].price = -1; }, /price.*non-negative finite/i],
    ['mortgageValue', (pack: any) => { pack.game.board.cells[1].mortgageValue = 101; }, /mortgageValue.*price/i],
    ['rents 不下降', (pack: any) => { pack.game.board.cells[1].rents = [5, 4, 20]; }, /rents.*non-decreasing/i],
  ])('拒绝不一致的 normal property：%s', (_label, mutate, expected) => {
    const pack: any = makeMinimalMap();
    mutate(pack);
    expect(() => assertValidMapPack(rehash(pack), [{ id: 'core', version: 1 }])).toThrow(expected);
  });

  it('允许经济数值为 0，但现金目标必须高于初始现金', () => {
    const zeroValues: any = makeMinimalMap();
    zeroValues.game.board.cells[1].price = 0;
    zeroValues.game.board.cells[1].mortgageValue = 0;
    zeroValues.game.board.cells[1].houseCost = 0;
    zeroValues.game.config.initialCash = 0;
    zeroValues.game.config.utilityMultipliers = [0, 0];
    expect(() => assertValidMapPack(rehash(zeroValues), [{ id: 'core', version: 1 }])).not.toThrow();

    const lowGoal: any = makeMinimalMap();
    lowGoal.game.config.cashGoalPresets = [1_000];
    expect(() => assertValidMapPack(rehash(lowGoal), [{ id: 'core', version: 1 }])).toThrow(
      /cashGoalPresets\[0\].*greater than initialCash/i,
    );
  });

  it('要求 station rents 覆盖地图上的全部车站，并禁止 utility 自带 rents', () => {
    const stationPack = editableChinaTour();
    stationPack.game.board.cells.find((cell: any) => cell.subtype === 'station').rents.pop();
    expect(() => assertValidMapPack(rehash(stationPack), CHINA_TOUR_MODULES)).toThrow(
      /rents.*station count/i,
    );

    const utilityPack = editableChinaTour();
    utilityPack.game.board.cells.find((cell: any) => cell.subtype === 'utility').rents = [1];
    expect(() => assertValidMapPack(rehash(utilityPack), CHINA_TOUR_MODULES)).toThrow(
      /utility.*must not define rents/i,
    );
  });

  it('要求卡牌 ID 全局唯一且正文非空', () => {
    const duplicate = editableChinaTour();
    duplicate.game.cards.destiny[0].id = duplicate.game.cards.chance[0].id;
    expect(() => assertValidMapPack(rehash(duplicate), CHINA_TOUR_MODULES)).toThrow(
      /game\.cards\.destiny\[0\]\.id.*unique/i,
    );

    const blank = editableChinaTour();
    blank.game.cards.chance[0].text = ' ';
    expect(() => assertValidMapPack(rehash(blank), CHINA_TOUR_MODULES)).toThrow(
      /game\.cards\.chance\[0\]\.text.*non-empty/i,
    );
  });

  it('接受可选的非空卡牌标题，并拒绝空白或非字符串标题', () => {
    const titled: any = makeMinimalMap();
    titled.game.cards.chance[0].title = 'Signal Boost';
    expect(() => assertValidMapPack(
      rehash(titled),
      [{ id: 'core', version: 1 }],
    )).not.toThrow();

    for (const invalidTitle of ['', '   ', 42]) {
      const invalid: any = makeMinimalMap();
      invalid.game.cards.chance[0].title = invalidTitle;
      expect(() => assertValidMapPack(
        rehash(invalid),
        [{ id: 'core', version: 1 }],
      )).toThrow(/game\.cards\.chance\[0\]\.title.*non-empty string/i);
    }
  });

  it.each([
    ['maxHouseLevel', (config: any) => { config.maxHouseLevel = 1.5; }, /maxHouseLevel.*non-negative integer/i],
    ['sellHouseRefundRate', (config: any) => { config.sellHouseRefundRate = 1.1; }, /sellHouseRefundRate.*between 0 and 1/i],
    ['utilityMultipliers', (config: any) => { config.utilityMultipliers = [10, 5]; }, /utilityMultipliers.*non-decreasing/i],
    ['cashGoalPresets', (config: any) => { config.cashGoalPresets = [2_000, 2_000]; }, /cashGoalPresets.*unique/i],
    ['airportBranchDice', (config: any) => { config.airportBranchDice = 2; }, /airportBranchDice.*exactly 1/i],
    ['jailEnabled', (config: any) => { config.jailEnabled = true; }, /jailEnabled.*false/i],
  ])('拒绝不一致的 config：%s', (_label, mutate, expected) => {
    const pack: any = makeMinimalMap();
    mutate(pack.game.config);
    expect(() => assertValidMapPack(rehash(pack), [{ id: 'core', version: 1 }])).toThrow(expected);
  });

  it('要求 presentation cells 与游戏格 ID 精确覆盖', () => {
    const missing: any = makeMinimalMap();
    delete missing.presentation.cells[10];
    expect(() => assertValidMapPack(rehash(missing), [{ id: 'core', version: 1 }])).toThrow(
      /presentation\.cells.*missing.*10/i,
    );

    const unknown: any = makeMinimalMap();
    unknown.presentation.cells[999] = { x: 24, y: 0, width: 8, height: 8, shortLabel: 'Ghost' };
    expect(() => assertValidMapPack(rehash(unknown), [{ id: 'core', version: 1 }])).toThrow(
      /presentation\.cells\.999.*unknown/i,
    );
  });

  it.each([
    ['非正方画布尺寸', (pack: any) => { pack.presentation.canvas.size = 0; }, /canvas\.size.*positive finite/i],
    ['非正矩形', (pack: any) => { pack.presentation.cells[10].width = 0; }, /cells\.10\.width.*positive finite/i],
    ['越界矩形', (pack: any) => { pack.presentation.cells[10].x = 35; }, /cells\.10.*within canvas/i],
    ['空 shortLabel', (pack: any) => { pack.presentation.cells[10].shortLabel = ' '; }, /shortLabel.*non-empty/i],
    ['非法 rotation', (pack: any) => { pack.presentation.cells[10].rotation = '90deg'; }, /rotation.*finite/i],
    ['非法 zIndex', (pack: any) => { pack.presentation.cells[10].zIndex = 1.5; }, /zIndex.*integer/i],
    ['任意 CSS 字段', (pack: any) => { pack.presentation.cells[10].css = 'position:fixed'; }, /cells\.10.*unexpected.*css/i],
  ])('拒绝非法 cell presentation：%s', (_label, mutate, expected) => {
    const pack: any = makeMinimalMap();
    mutate(pack);
    expect(() => assertValidMapPack(rehash(pack), [{ id: 'core', version: 1 }])).toThrow(expected);
  });

  it('重叠必须由不同 zIndex 且 overlapWith 显式声明', () => {
    const overlap: any = makeMinimalMap();
    overlap.presentation.cells[10].x = 7.99;
    expect(() => assertValidMapPack(rehash(overlap), [{ id: 'core', version: 1 }])).toThrow(
      /cells\.0.*cells\.10.*overlap/i,
    );

    const epsilon: any = makeMinimalMap();
    epsilon.presentation.cells[10].x = 7.9999995;
    expect(() => assertValidMapPack(rehash(epsilon), [{ id: 'core', version: 1 }])).not.toThrow();

    const layered: any = makeMinimalMap();
    layered.presentation.cells[10].x = 7.99;
    layered.presentation.cells[10].zIndex = 1;
    expect(() => assertValidMapPack(rehash(layered), [{ id: 'core', version: 1 }])).toThrow(
      /cells\.0.*cells\.10.*overlap/i,
    );

    layered.presentation.cells[10].overlapWith = [0];
    expect(() => assertValidMapPack(rehash(layered), [{ id: 'core', version: 1 }])).not.toThrow();

    const sameLayer: any = makeMinimalMap();
    sameLayer.presentation.cells[10].x = 7.99;
    sameLayer.presentation.cells[10].overlapWith = [0];
    expect(() => assertValidMapPack(rehash(sameLayer), [{ id: 'core', version: 1 }])).toThrow(
      /cells\.0.*cells\.10.*overlap/i,
    );
  });

  it.each([
    ['self', [10], /overlapWith.*self/i],
    ['duplicate', [0, 0], /overlapWith.*unique/i],
    ['unknown', [999], /overlapWith.*existing cell/i],
    ['non-integer', [0.5], /overlapWith.*safe integer/i],
    ['not overlapping', [0], /overlapWith.*does not overlap/i],
  ])('拒绝非法 overlapWith：%s', (_label, overlapWith, expected) => {
    const pack: any = makeMinimalMap();
    pack.presentation.cells[10].overlapWith = overlapWith;
    expect(() => assertValidMapPack(rehash(pack), [{ id: 'core', version: 1 }])).toThrow(expected);
  });

  it.each([
    ['缺 theme role', (pack: any) => { delete pack.presentation.theme.colors.route; }, /theme\.colors\.route.*required/i],
    ['未知 theme role', (pack: any) => { pack.presentation.theme.colors.button = '#ffffff'; }, /theme\.colors.*unexpected.*button/i],
    ['非 hex color', (pack: any) => { pack.presentation.theme.colors.board = 'red'; }, /theme\.colors\.board.*hex/i],
    ['非法 band token', (pack: any) => { pack.presentation.theme.propertyBands.cedar = '#008866'; }, /propertyBands\.cedar.*band token/i],
    ['未声明 band', (pack: any) => { pack.presentation.cells[10].propertyBand = 'band:missing'; }, /propertyBand.*declared/i],
  ])('拒绝不受控 theme：%s', (_label, mutate, expected) => {
    const pack: any = makeMinimalMap();
    mutate(pack);
    expect(() => assertValidMapPack(rehash(pack), [{ id: 'core', version: 1 }])).toThrow(expected);
  });

  it.each(['toString', 'constructor'])('propertyBand 不得借用 prototype key：%s', (propertyBand) => {
    const pack: any = makeMinimalMap();
    pack.presentation.cells[10].propertyBand = propertyBand;
    expect(() => assertValidMapPack(rehash(pack), [{ id: 'core', version: 1 }])).toThrow(
      /propertyBand.*declared band token/i,
    );
  });

  it('只接受 allowlisted semantic icon', () => {
    const pack: any = makeMinimalMap();
    pack.presentation.cells[0].artwork = { type: 'built-in-icon', icon: 'script' };
    expect(() => assertValidMapPack(rehash(pack), [{ id: 'core', version: 1 }])).toThrow(
      /artwork\.icon.*allowlisted/i,
    );
  });

  it.each([
    ['路径穿越', '../secret.png'],
    ['反斜杠', 'assets\\secret.png'],
    ['远程 URL', 'https://example.com/icon.png'],
    ['query', 'assets/icon.png?x=1'],
    ['hash', 'assets/icon.png#x'],
    ['SVG', 'assets/icon.svg'],
  ])('拒绝不安全 local asset：%s', (_label, path) => {
    const pack: any = makeMinimalMap();
    pack.presentation.cells[0].artwork = { type: 'local-asset', path };
    expect(() => assertValidMapPack(rehash(pack), [{ id: 'core', version: 1 }])).toThrow(
      /artwork\.path.*package-local image/i,
    );
  });

  it('仅接受 allowlist 中 assets/ 下的安全 raster asset，并允许 Unicode/空格路径段', () => {
    const pack: any = makeMinimalMap();
    pack.presentation.cells[0].artwork = { type: 'local-asset', path: 'assets/图 标/启动 图.webp' };
    pack.presentation.center.push({
      type: 'image', x: 10, y: 10, width: 8, height: 8, role: 'center',
      asset: { type: 'local-asset', path: 'assets/center/photo.jpg' },
    });
    expect(() => assertValidMapPack(
      rehash(pack),
      [{ id: 'core', version: 1 }],
      ['assets/图 标/启动 图.webp', 'assets/center/photo.jpg'],
    )).not.toThrow();

    const missing: any = makeMinimalMap();
    missing.presentation.cells[0].artwork = { type: 'local-asset', path: 'assets/icons/missing.png' };
    expect(() => assertValidMapPack(rehash(missing), [{ id: 'core', version: 1 }])).toThrow(
      /artwork\.path.*known package asset/i,
    );
  });

  it('校验 line/polyline/path 的受控 geometry 和 style', () => {
    const valid: any = makeMinimalMap();
    valid.presentation.routes = [
      { type: 'line', from: { x: 1, y: 1 }, to: { x: 8, y: 8 }, role: 'route', strokeWidth: 1 },
      { type: 'polyline', points: [{ x: 1, y: 2 }, { x: 4, y: 5 }], role: 'decoration', strokeWidth: 1 },
      { type: 'path', d: 'M 1 1 L 5 5 H 8 V 2 Z', role: 'route', strokeWidth: 1 },
    ];
    expect(() => assertValidMapPack(rehash(valid), [{ id: 'core', version: 1 }])).not.toThrow();

    const outOfBounds: any = makeMinimalMap();
    outOfBounds.presentation.routes = [
      { type: 'line', from: { x: 1, y: 1 }, to: { x: 41, y: 8 }, role: 'route', strokeWidth: 1 },
    ];
    expect(() => assertValidMapPack(rehash(outOfBounds), [{ id: 'core', version: 1 }])).toThrow(
      /routes\[0\]\.to.*within canvas/i,
    );

    const unsafePath: any = makeMinimalMap();
    unsafePath.presentation.routes = [
      { type: 'path', d: 'M 1 1 A 5 5 0 0 0 8 8', role: 'route', strokeWidth: 1 },
    ];
    expect(() => assertValidMapPack(rehash(unsafePath), [{ id: 'core', version: 1 }])).toThrow(
      /routes\[0\]\.d.*supported absolute commands/i,
    );

    const invalidStyle: any = makeMinimalMap();
    invalidStyle.presentation.routes = [
      { type: 'line', from: { x: 1, y: 1 }, to: { x: 8, y: 8 }, role: 'route', strokeWidth: 0 },
    ];
    expect(() => assertValidMapPack(rehash(invalidStyle), [{ id: 'core', version: 1 }])).toThrow(
      /routes\[0\]\.strokeWidth.*positive finite/i,
    );
  });

  it('校验 center decoration 的边界、文本和资产', () => {
    const outOfBounds: any = makeMinimalMap();
    outOfBounds.presentation.center = [
      { type: 'panel', x: 39, y: 1, width: 2, height: 2, role: 'center' },
    ];
    expect(() => assertValidMapPack(rehash(outOfBounds), [{ id: 'core', version: 1 }])).toThrow(
      /center\[0\].*within canvas/i,
    );

    const blankText: any = makeMinimalMap();
    blankText.presentation.center = [
      { type: 'text', x: 10, y: 10, width: 8, height: 8, role: 'title', text: ' ' },
    ];
    expect(() => assertValidMapPack(rehash(blankText), [{ id: 'core', version: 1 }])).toThrow(
      /center\[0\]\.text.*non-empty/i,
    );
  });

  it('校验受控 mobile 几何与 text fitContent', () => {
    const valid: any = makeMinimalMap();
    valid.presentation.cells[0].mobile = { x: 1, y: 1, width: 7, height: 7 };
    valid.presentation.center = [{
      type: 'text', x: 10, y: 10, width: 8, height: 8, role: 'title', text: 'MAP',
      mobile: { x: 12, y: 12, width: 6, height: 6 }, fitContent: true,
    }];
    expect(() => assertValidMapPack(rehash(valid), [{ id: 'core', version: 1 }])).not.toThrow();

    const outOfBounds: any = makeMinimalMap();
    outOfBounds.presentation.cells[0].mobile = { x: 39, y: 1, width: 2, height: 2 };
    expect(() => assertValidMapPack(rehash(outOfBounds), [{ id: 'core', version: 1 }])).toThrow(
      /cells\.0\.mobile.*within canvas/i,
    );

    const executableLike: any = makeMinimalMap();
    executableLike.presentation.center = [{
      type: 'text', x: 10, y: 10, width: 8, height: 8, role: 'title', text: 'MAP',
      fitContent: 'yes',
    }];
    expect(() => assertValidMapPack(rehash(executableLike), [{ id: 'core', version: 1 }])).toThrow(
      /fitContent.*boolean/i,
    );
  });
});
