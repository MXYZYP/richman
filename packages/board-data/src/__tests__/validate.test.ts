import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertChinaTourMapDataParity,
  assertChinaTourSourceReconciliation,
  type ChinaTourSourceTexts,
} from '../chinaTourValidation';
import { chinaTourMap } from '../chinaTourMap';
import { computeContentHash } from '../hash';
import { assertValidMapPack } from '../mapValidation';
import type { MapPack } from '../mapTypes';
import mapBoard from '../../maps/china-tour/v1/board.json';
import mapCards from '../../maps/china-tour/v1/cards.json';
import mapConfig from '../../maps/china-tour/v1/game-config.json';

const sources: ChinaTourSourceTexts = {
  normalProperties: readFileSync(new URL('../../../../raw/大富翁-普通地皮.md', import.meta.url), 'utf8'),
  nonNormalProperties: readFileSync(new URL('../../../../raw/大富翁-非普通地皮.md', import.meta.url), 'utf8'),
  chanceCards: readFileSync(new URL('../../../../raw/机会卡.md', import.meta.url), 'utf8'),
  destinyCards: readFileSync(new URL('../../../../raw/命运卡.md', import.meta.url), 'utf8'),
};

type EditableSourceTexts = {
  -readonly [Key in keyof ChinaTourSourceTexts]: ChinaTourSourceTexts[Key];
};

function editableChinaTour(): any {
  return structuredClone(chinaTourMap);
}

function makeNonChinaMap(): MapPack {
  const pack: any = {
    ref: { id: 'island-loop', version: 1, contentHash: '0'.repeat(64) },
    metadata: { title: 'Island Loop', description: 'A compact non-China map' },
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
            price: 99,
            mortgageValue: 40,
            houseCost: 17,
            rents: [3, 8, 21],
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
        sellHouseRefundRate: 0.4,
        sellLandRate: 0.6,
        mortgageInterestRate: 0.2,
        utilityMultipliers: [4, 12],
        jailExitMinRoll: 4,
        jailMaxAttempts: 2,
        cashGoalPresets: [2_000],
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
  pack.ref.contentHash = computeContentHash(pack);
  return pack as MapPack;
}

function reconcile(pack: MapPack): void {
  assertChinaTourSourceReconciliation(pack, sources);
}

function editableSources(): EditableSourceTexts {
  return structuredClone(sources);
}

function appendDuplicateRow(text: string, marker: string): string {
  const row = text.split('\n').find((line) => line.includes(marker));
  if (row === undefined) throw new Error(`Missing fixture row: ${marker}`);
  return `${text.trimEnd()}\n${row}\n`;
}

function truncateRow(text: string, marker: string): string {
  return text.split('\n').map((line) => {
    if (!line.includes(marker)) return line;
    const cells = line.split('|');
    cells.splice(-2, 1);
    return cells.join('|');
  }).join('\n');
}

describe('China Tour source reconciliation', () => {
  it('真实 china-tour@1 与四份 raw source 和批准配置一致', () => {
    expect(() => reconcile(chinaTourMap)).not.toThrow();
  });

  it.each([
    ['board', (mapData: any) => { mapData.board.cells[1].name = 'Map data drift'; }],
    ['cards', (mapData: any) => { mapData.cards.chance[0].text = 'Map data drift'; }],
    ['config', (mapData: any) => { mapData.config.initialCash += 1; }],
  ])('build registration Gate 拒绝 map data %s 与 map pack 漂移', (part, mutate) => {
    const mapData = {
      board: structuredClone(mapBoard),
      cards: structuredClone(mapCards),
      config: structuredClone(mapConfig),
    };
    mutate(mapData);

    expect(() => assertChinaTourMapDataParity(chinaTourMap, mapData)).toThrow(
      new RegExp(`mapData\\.${part}.*does not match`, 'i'),
    );
  });

  it.each([
    ['普通地皮名称', (pack: any) => { pack.game.board.cells[1].name = 'Changed Province'; }, /cells\[1\]\.name.*普通地皮\.md/s],
    ['普通地皮 price', (pack: any) => { pack.game.board.cells[1].price += 1; }, /cells\[1\]\.price.*普通地皮\.md/s],
    ['普通地皮 houseCost', (pack: any) => { pack.game.board.cells[1].houseCost += 1; }, /cells\[1\]\.houseCost.*普通地皮\.md/s],
    ['普通地皮 rents', (pack: any) => { pack.game.board.cells[1].rents[0] += 1; }, /cells\[1\]\.rents\[0\].*普通地皮\.md/s],
    ['普通地皮 mortgageValue', (pack: any) => { pack.game.board.cells[1].mortgageValue += 1; }, /cells\[1\]\.mortgageValue.*普通地皮\.md/s],
    ['车站名称', (pack: any) => { pack.game.board.cells[6].name = 'Changed Station'; }, /cells\[6\]\.name.*非普通地皮\.md/s],
    ['车站 price', (pack: any) => { pack.game.board.cells[6].price += 1; }, /cells\[6\]\.price.*非普通地皮\.md/s],
    ['车站 rents', (pack: any) => { pack.game.board.cells[6].rents[0] += 1; }, /cells\[6\]\.rents\[0\].*非普通地皮\.md/s],
    ['车站 mortgageValue', (pack: any) => { pack.game.board.cells[6].mortgageValue += 1; }, /cells\[6\]\.mortgageValue.*非普通地皮\.md/s],
    ['utility 名称', (pack: any) => { pack.game.board.cells[10].name = 'Changed Utility'; }, /cells\[10\]\.name.*非普通地皮\.md/s],
    ['utility price', (pack: any) => { pack.game.board.cells[10].price += 1; }, /cells\[10\]\.price.*非普通地皮\.md/s],
    ['utility mortgageValue', (pack: any) => { pack.game.board.cells[10].mortgageValue += 1; }, /cells\[10\]\.mortgageValue.*非普通地皮\.md/s],
  ])('拒绝 %s 漂移，并报告 pack 路径和 source', (_label, mutate, expected) => {
    const pack = editableChinaTour();
    mutate(pack);

    expect(() => reconcile(pack)).toThrow(expected);
  });

  it('拒绝 China Tour 地产和卡牌精确数量漂移', () => {
    const missingProperty = editableChinaTour();
    missingProperty.game.board.cells.splice(1, 1);
    expect(() => reconcile(missingProperty)).toThrow(/game\.board\.cells.*normal property count.*35/i);

    const missingCard = editableChinaTour();
    missingCard.game.cards.chance.pop();
    expect(() => reconcile(missingCard)).toThrow(/game\.cards\.chance.*card count.*15/i);
  });

  it('拒绝卡牌正文和批准 config 漂移', () => {
    const cardText = editableChinaTour();
    cardText.game.cards.chance[0].text = 'Changed card text';
    expect(() => reconcile(cardText)).toThrow(/game\.cards\.chance\[0\]\.text.*机会卡\.md/s);

    const config = editableChinaTour();
    config.game.config.utilityMultipliers = [7, 70];
    expect(() => reconcile(config)).toThrow(/game\.config\.utilityMultipliers.*approved/i);
  });

  it('拒绝 raw header、截断行和必填 cell 漂移', () => {
    const header = editableSources();
    header.normalProperties = header.normalProperties.replace('地皮名称', '错误名称');
    expect(() => assertChinaTourSourceReconciliation(chinaTourMap, header)).toThrow(
      /raw\/大富翁-普通地皮\.md.*header/i,
    );

    const separator = editableSources();
    separator.nonNormalProperties = separator.nonNormalProperties.replace('| --- | --- |', '| --- | -- |');
    expect(() => assertChinaTourSourceReconciliation(chinaTourMap, separator)).toThrow(
      /raw\/大富翁-非普通地皮\.md.*separator/i,
    );

    const truncated = editableSources();
    truncated.chanceCards = truncateRow(truncated.chanceCards, '中国71-01');
    expect(() => assertChinaTourSourceReconciliation(chinaTourMap, truncated)).toThrow(
      /raw\/机会卡\.md.*row.*column count/i,
    );

    const emptyCategory = editableSources();
    emptyCategory.destinyCards = emptyCategory.destinyCards.replace('| 收益 | 银行发2000元 |', '|  | 银行发2000元 |');
    expect(() => assertChinaTourSourceReconciliation(chinaTourMap, emptyCategory)).toThrow(
      /raw\/命运卡\.md.*效果分类.*required/i,
    );
  });

  it('拒绝 raw property/card 重复键和错误精确数量', () => {
    const property = editableSources();
    property.normalProperties = appendDuplicateRow(property.normalProperties, '| 台湾省 |');
    expect(() => assertChinaTourSourceReconciliation(chinaTourMap, property)).toThrow(
      /raw\/大富翁-普通地皮\.md.*duplicate property name.*台湾省/i,
    );

    const card = editableSources();
    card.chanceCards = appendDuplicateRow(card.chanceCards, '| 中国71-01 |');
    expect(() => assertChinaTourSourceReconciliation(chinaTourMap, card)).toThrow(
      /raw\/机会卡\.md.*duplicate normalized card id.*71-01/i,
    );
  });

  it('简单金额列使用严格 currency grammar', () => {
    const raw = editableSources();
    raw.normalProperties = raw.normalProperties.replace('2200 元', '2200 CORRUPT');

    expect(() => assertChinaTourSourceReconciliation(chinaTourMap, raw)).toThrow(
      /raw\/大富翁-普通地皮\.md.*裸地皮价格.*currency/i,
    );

    const station = editableSources();
    station.nonNormalProperties = station.nonNormalProperties.replace('如购得一个车站：250元', '如购得一个车站：CORRUPT');
    expect(() => assertChinaTourSourceReconciliation(chinaTourMap, station)).toThrow(
      /raw\/大富翁-非普通地皮\.md.*规则1.*currency amount/i,
    );
  });

  it.each([
    [{ type: 'none' }, /effect\.type.*receive_bank/i],
    [{ type: 'pay_bank', amount: 500 }, /effect\.type.*receive_bank/i],
  ])('从 raw 分类推导 card effect type，不信任 pack 自报类型 %#', (effect, expected) => {
    const pack = editableChinaTour();
    pack.game.cards.chance[0].effect = effect;

    expect(() => reconcile(pack)).toThrow(
      new RegExp(`game\\.cards\\.chance\\[0\\]\\.${expected.source}`, expected.flags),
    );
  });

  it.each([
    ['chance repairs amount', 'chance', 5, (effect: any) => { effect.perHouse += 1; }, /chance\[5\]\.effect\.perHouse/i],
    ['chance skip count', 'chance', 7, (effect: any) => { effect.turns += 1; }, /chance\[7\]\.effect\.turns/i],
    ['chance move steps', 'chance', 8, (effect: any) => { effect.steps += 1; }, /chance\[8\]\.effect\.steps/i],
    ['destiny move target', 'destiny', 8, (effect: any) => { effect.cellId = 0; }, /destiny\[8\]\.effect\.cellId/i],
    ['destiny salary flag', 'destiny', 9, (effect: any) => { effect.collectSalary = true; }, /destiny\[9\]\.effect\.collectSalary/i],
    ['destiny draw deck', 'destiny', 14, (effect: any) => { effect.deck = 'destiny'; }, /destiny\[14\]\.effect\.deck/i],
  ])('从 raw value/direction 推导 %s', (_label, deck, index, mutate, expected) => {
    const pack = editableChinaTour();
    mutate(pack.game.cards[deck][index].effect);

    expect(() => reconcile(pack)).toThrow(expected);
  });

  it.each([
    ['经过起点可领取', '如经过起点，可得奖金2000元', '如经过起点，可得奖金9999元'],
    ['退回起点不可领取', '不可领取起点奖金2000元', '不可领取起点奖金9999元'],
  ])('move_to raw 起点奖金必须等于 passStartSalary：%s', (_label, original, drifted) => {
    const raw = editableSources();
    raw.destinyCards = raw.destinyCards.replaceAll(original, drifted);

    expect(() => assertChinaTourSourceReconciliation(chinaTourMap, raw)).toThrow(
      /raw\/命运卡\.md.*起点奖金.*game\.config\.passStartSalary.*2000/i,
    );
  });

  it('utility raw 十倍/一百倍规则必须与 config multiplier 和持有语义一致', () => {
    const multiplier = editableSources();
    multiplier.nonNormalProperties = multiplier.nonNormalProperties.replace('之十倍', '之二十倍');
    expect(() => assertChinaTourSourceReconciliation(chinaTourMap, multiplier)).toThrow(
      /raw\/大富翁-非普通地皮\.md.*utilityMultipliers\[0\].*10/i,
    );

    const ownership = editableSources();
    ownership.nonNormalProperties = ownership.nonNormalProperties.replace(
      '凡拥有中国大运河，其过路费',
      '凡拥有大唐托克托发电厂，其过路费',
    );
    expect(() => assertChinaTourSourceReconciliation(chinaTourMap, ownership)).toThrow(
      /raw\/大富翁-非普通地皮\.md.*中国大运河.*own utility/i,
    );
  });

  it('卡牌是否影响他人仅允许是/否，并与 player flow 一致', () => {
    const invalidFlag = editableSources();
    invalidFlag.chanceCards = invalidFlag.chanceCards.replace('| 否 | 银行向玩家支付 |', '| 或许 | 银行向玩家支付 |');
    expect(() => assertChinaTourSourceReconciliation(chinaTourMap, invalidFlag)).toThrow(
      /raw\/机会卡\.md.*是否影响他人.*是.*否/i,
    );

    const wrongFlow = editableSources();
    wrongFlow.chanceCards = wrongFlow.chanceCards.replace('| 中国71-02 | 机会 | 攀登珠穆朗玛峰遇到雪崩 | 互动 | 每人救济500元 | 是 |', '| 中国71-02 | 机会 | 攀登珠穆朗玛峰遇到雪崩 | 互动 | 每人救济500元 | 否 |');
    expect(() => assertChinaTourSourceReconciliation(chinaTourMap, wrongFlow)).toThrow(
      /raw\/机会卡\.md.*71-02.*是否影响他人.*receive_from_each_player.*是/i,
    );
  });

  it('保留 China Tour 无监狱文本的批准约束', () => {
    const pack = editableChinaTour();
    pack.game.cards.chance[0].text += '，然后进牢。';

    expect(() => reconcile(pack)).toThrow(/game\.cards\.chance\[0\]\.text.*jail-free China Tour config/i);
  });

  it('China-specific 入口明确拒绝其他 map id', () => {
    expect(() => reconcile(makeNonChinaMap())).toThrow(/ref\.id.*china-tour/i);
  });

  it('批准 baseline 不暴露为可变 public export', async () => {
    expect(await import('../chinaTourValidation')).not.toHaveProperty('CHINA_TOUR_APPROVED_EXPECTATIONS');
  });

  it('generic validator 接受非中国、非连续 ID、小规模和不同价格配置', () => {
    const pack = makeNonChinaMap();

    expect(() => assertValidMapPack(pack, [{ id: 'core', version: 1 }], [])).not.toThrow();
  });
});
