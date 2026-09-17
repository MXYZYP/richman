import { canonicalStringify } from './hash';
import type { MapPack } from './mapTypes';
import type { CoreCellEffect } from './types';

export interface ChinaTourSourceTexts {
  readonly normalProperties: string;
  readonly nonNormalProperties: string;
  readonly chanceCards: string;
  readonly destinyCards: string;
}

export interface ChinaTourMapData {
  readonly board: unknown;
  readonly cards: unknown;
  readonly config: unknown;
}

interface ChinaTourApprovedExpectations {
  readonly mapId: 'china-tour';
  readonly cellCount: number;
  readonly normalPropertyCount: number;
  readonly stationCount: number;
  readonly utilityCount: number;
  readonly chanceCardCount: number;
  readonly destinyCardCount: number;
  readonly config: Readonly<Record<string, unknown>>;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((nested) => deepFreeze(nested, seen));
  return Object.freeze(value);
}

const APPROVED_EXPECTATIONS = deepFreeze<ChinaTourApprovedExpectations>({
  mapId: 'china-tour',
  cellCount: 61,
  normalPropertyCount: 35,
  stationCount: 4,
  utilityCount: 2,
  chanceCardCount: 15,
  destinyCardCount: 15,
  config: {
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
  },
});

const NORMAL_HEADERS = [
  '地皮名称', '裸地皮价格', '单栋房屋/旅馆价格', '过路费（空地）', '过路费（一栋房屋）',
  '过路费（两栋房屋）', '过路费（三栋房屋）', '过路费（四栋房屋）', '过路费（一栋旅馆）', '抵押价格',
] as const;
const NON_NORMAL_HEADERS = ['名称', '类型', '裸地皮价格', '规则1', '规则2', '规则3', '规则4', '抵押价格'] as const;
const CHANCE_HEADERS = ['卡片编号', '卡片类型', '卡片正文', '效果分类', '金额/数值', '是否影响他人', '补充备注', ''] as const;
const DESTINY_HEADERS = ['卡片编号', '卡片类型', '卡片正文', '效果分类', '金额/数值', '方向/地点', '是否影响他人', '补充备注'] as const;
const SIMPLE_CURRENCY_PATTERN = /^\d+(?:[，,]\d{3})*\s*元$/;
const JAIL_TEXT_PATTERN = /进牢|入狱|出狱/;

function sourceError(errors: string[], path: string, source: string, reason: string): void {
  errors.push(`${path} (${source}): ${reason}`);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalStringify(left) === canonicalStringify(right);
}

function compareValue(
  errors: string[],
  path: string,
  source: string,
  actual: unknown,
  expected: unknown,
): void {
  if (!deepEqual(actual, expected)) {
    sourceError(errors, path, source, `expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function splitMdRow(line: string): string[] {
  const cells = line.split('|');
  return cells.slice(1, cells.length - 1).map((cell) => cell.trim());
}

function parseMdTable(
  text: string,
  source: string,
  headers: readonly string[],
  errors: string[],
): string[][] {
  const tableLines = text.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('|'));
  const actualHeaders = tableLines[0] === undefined ? [] : splitMdRow(tableLines[0]);
  if (!deepEqual(actualHeaders, headers)) {
    sourceError(errors, `${source} header`, source, `expected ${JSON.stringify(headers)}, received ${JSON.stringify(actualHeaders)}`);
  }
  const separator = tableLines[1] === undefined ? [] : splitMdRow(tableLines[1]);
  const expectedSeparator = headers.map(() => '---');
  if (!deepEqual(separator, expectedSeparator)) {
    sourceError(errors, `${source} separator`, source, `expected ${JSON.stringify(expectedSeparator)}, received ${JSON.stringify(separator)}`);
  }

  return tableLines.slice(2).map((line, index) => {
    const row = splitMdRow(line);
    if (row.length !== headers.length) {
      sourceError(
        errors,
        `${source} row ${index + 1}`,
        source,
        `column count must be ${headers.length}, received ${row.length}`,
      );
    }
    return row;
  });
}

function assertRequiredCells(
  rows: readonly string[][],
  source: string,
  headers: readonly string[],
  requiredColumns: (row: readonly string[]) => readonly number[],
  errors: string[],
): void {
  rows.forEach((row, rowIndex) => {
    requiredColumns(row).forEach((columnIndex) => {
      if ((row[columnIndex] ?? '').trim() === '') {
        sourceError(
          errors,
          `${source} row ${rowIndex + 1}.${headers[columnIndex] ?? `column[${columnIndex}]`}`,
          source,
          'is required',
        );
      }
    });
  });
}

function parseSimpleCurrency(
  raw: string | undefined,
  errors: string[],
  path: string,
  source: string,
): number | undefined {
  if (raw === undefined || !SIMPLE_CURRENCY_PATTERN.test(raw)) {
    sourceError(errors, path, source, `must use strict currency grammar "<amount> 元", received ${JSON.stringify(raw)}`);
    return undefined;
  }
  return Number.parseInt(raw.replace(/[，,\s元]/g, ''), 10);
}

function extractCurrencyAmounts(raw: string): number[] {
  return [...raw.matchAll(/(\d+(?:[，,]\d{3})*)\s*元/g)]
    .map((match) => Number.parseInt(match[1]!.replace(/[，,]/g, ''), 10));
}

function extractSingleEmbeddedCurrency(
  raw: string | undefined,
  errors: string[],
  path: string,
  source: string,
): number | undefined {
  const amounts = extractCurrencyAmounts(raw ?? '');
  if (amounts.length !== 1) {
    sourceError(errors, path, source, `must contain exactly one currency amount, received ${JSON.stringify(raw)}`);
    return undefined;
  }
  return amounts[0];
}

function reportDuplicates(
  values: readonly string[],
  path: string,
  source: string,
  label: string,
  errors: string[],
): void {
  const seen = new Set<string>();
  const reported = new Set<string>();
  values.forEach((value) => {
    if (seen.has(value) && !reported.has(value)) {
      sourceError(errors, path, source, `duplicate ${label}: ${value}`);
      reported.add(value);
    }
    seen.add(value);
  });
}

function setDifference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((value) => !right.has(value));
}

function reconcilePropertyNames(
  errors: string[],
  cells: MapPack['game']['board']['cells'],
  subtype: 'normal' | 'station' | 'utility',
  rawNames: ReadonlySet<string>,
  source: string,
): void {
  const propertyEntries = cells
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell }) => cell.type === 'property' && cell.subtype === subtype);
  const packNames = new Set(propertyEntries.map(({ cell }) => cell.name));
  propertyEntries.forEach(({ cell, index }) => {
    if (!rawNames.has(cell.name)) {
      sourceError(errors, `game.board.cells[${index}].name`, source, `unknown ${subtype} property ${JSON.stringify(cell.name)}`);
    }
  });
  const missingNames = setDifference(rawNames, packNames);
  if (missingNames.length > 0) {
    sourceError(errors, 'game.board.cells', source, `missing ${subtype} properties: ${missingNames.join(', ')}`);
  }
}

function reconcileProperties(
  errors: string[],
  pack: MapPack,
  normalRows: string[][],
  nonNormalRows: string[][],
): void {
  const normalSource = 'raw/大富翁-普通地皮.md';
  const nonNormalSource = 'raw/大富翁-非普通地皮.md';
  reportDuplicates(normalRows.map((row) => row[0] ?? ''), normalSource, normalSource, 'property name', errors);
  reportDuplicates(nonNormalRows.map((row) => row[0] ?? ''), nonNormalSource, nonNormalSource, 'property name', errors);

  const normalMap = new Map(normalRows.map((row) => [row[0]!, row]));
  const stationRows = nonNormalRows.filter((row) => row[1] === '火车站');
  const utilityRows = nonNormalRows.filter((row) => row[1] === '特殊地皮');
  const stationMap = new Map(stationRows.map((row) => [row[0]!, row]));
  const utilityMap = new Map(utilityRows.map((row) => [row[0]!, row]));
  const cells = pack.game.board.cells;

  reconcilePropertyNames(errors, cells, 'normal', new Set(normalMap.keys()), normalSource);
  reconcilePropertyNames(errors, cells, 'station', new Set(stationMap.keys()), nonNormalSource);
  reconcilePropertyNames(errors, cells, 'utility', new Set(utilityMap.keys()), nonNormalSource);

  cells.forEach((cell, index) => {
    if (cell.type !== 'property') return;
    const path = `game.board.cells[${index}]`;
    if (cell.subtype === 'normal') {
      const row = normalMap.get(cell.name);
      if (row === undefined) return;
      compareValue(errors, `${path}.price`, normalSource, cell.price, parseSimpleCurrency(row[1], errors, `${normalSource} row.${NORMAL_HEADERS[1]}`, normalSource));
      compareValue(errors, `${path}.houseCost`, normalSource, cell.houseCost, parseSimpleCurrency(row[2], errors, `${normalSource} row.${NORMAL_HEADERS[2]}`, normalSource));
      row.slice(3, 9).forEach((rawRent, rentIndex) => {
        const expected = parseSimpleCurrency(rawRent, errors, `${normalSource} row.${NORMAL_HEADERS[rentIndex + 3]}`, normalSource);
        compareValue(errors, `${path}.rents[${rentIndex}]`, normalSource, cell.rents?.[rentIndex], expected);
      });
      compareValue(errors, `${path}.mortgageValue`, normalSource, cell.mortgageValue, parseSimpleCurrency(row[9], errors, `${normalSource} row.${NORMAL_HEADERS[9]}`, normalSource));
      return;
    }

    const row = (cell.subtype === 'station' ? stationMap : utilityMap).get(cell.name);
    if (row === undefined) return;
    compareValue(errors, `${path}.price`, nonNormalSource, cell.price, parseSimpleCurrency(row[2], errors, `${nonNormalSource} row.${NON_NORMAL_HEADERS[2]}`, nonNormalSource));
    if (cell.subtype === 'station') {
      row.slice(3, 7).forEach((rawRent, rentIndex) => {
        const expected = extractSingleEmbeddedCurrency(rawRent, errors, `${nonNormalSource} row.${NON_NORMAL_HEADERS[rentIndex + 3]}`, nonNormalSource);
        compareValue(errors, `${path}.rents[${rentIndex}]`, nonNormalSource, cell.rents?.[rentIndex], expected);
      });
    }
    compareValue(errors, `${path}.mortgageValue`, nonNormalSource, cell.mortgageValue, parseSimpleCurrency(row[7], errors, `${nonNormalSource} row.${NON_NORMAL_HEADERS[7]}`, nonNormalSource));
  });
}

function normalizeCardId(rawId: string): string {
  return rawId.replace(/^中国/, '').trim();
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, '');
}

function parseChineseNumber(raw: string): number | undefined {
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  const digits: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (raw.includes('百')) {
    const [hundredsRaw, remainder = ''] = raw.split('百');
    const hundreds = hundredsRaw === '' ? 1 : digits[hundredsRaw!];
    const remainderValue = remainder === '' ? 0 : parseChineseNumber(remainder);
    return hundreds === undefined || remainderValue === undefined ? undefined : hundreds * 100 + remainderValue;
  }
  if (raw === '十') return 10;
  if (raw.startsWith('十')) return 10 + (digits[raw[1]!] ?? 0);
  if (raw.endsWith('十')) return (digits[raw[0]!] ?? 0) * 10;
  if (raw.includes('十')) return (digits[raw[0]!] ?? 0) * 10 + (digits[raw[2]!] ?? 0);
  return digits[raw];
}

function extractUtilityMultiplier(raw: string): number | undefined {
  const match = raw.match(/之([一二三四五六七八九十百]+)倍/);
  return match === null ? undefined : parseChineseNumber(match[1]!);
}

function reconcileUtilityRules(
  errors: string[],
  pack: MapPack,
  utilityRows: readonly string[][],
  source: string,
): void {
  const utilityNames = utilityRows.map((row) => row[0] ?? '');
  utilityRows.forEach((row) => {
    const utilityName = row[0] ?? '';
    const rules = [row[3] ?? '', row[4] ?? ''];
    rules.forEach((rule, index) => {
      const path = `${source} utility ${utilityName}.规则${index + 1}`;
      const multiplier = extractUtilityMultiplier(rule);
      if (multiplier === undefined) {
        sourceError(errors, path, source, 'must contain a parseable Chinese multiplier');
      } else {
        compareValue(
          errors,
          `${path} utilityMultipliers[${index}]`,
          source,
          multiplier,
          pack.game.config.utilityMultipliers[index],
        );
      }
      const requiredNames = index === 0 ? [utilityName] : utilityNames;
      requiredNames.forEach((requiredName) => {
        if (!rule.includes(requiredName)) {
          sourceError(errors, path, source, `must name ${requiredName} for the ${index === 0 ? 'own utility' : 'combined utility'} rule`);
        }
      });
    });
  });
}

function extractCount(raw: string, suffix: '步' | '次'): number | undefined {
  const match = raw.match(new RegExp(`([一二三四五六七八九十]+|\\d+)\\s*${suffix}`));
  return match === null ? undefined : parseChineseNumber(match[1]!);
}

function deriveEffectType(category: string, value: string): CoreCellEffect['type'] | undefined {
  switch (category) {
    case '收益': return 'receive_bank';
    case '支出': return 'pay_bank';
    case '房屋维护': return 'repairs';
    case '暂停': return 'skip_turn';
    case '移动/条件奖励': return 'move_to';
    case '移动': return value.includes('步') ? 'move_steps' : 'move_to';
    case '向他人收取': return 'receive_from_each_player';
    case '抽卡联动': return 'draw_card';
    case '互动': return extractCurrencyAmounts(value).length > 0 ? 'receive_from_each_player' : 'none';
    default: return undefined;
  }
}

function compareCardEffect(
  errors: string[],
  pack: MapPack,
  card: MapPack['game']['cards']['chance'][number],
  row: string[],
  path: string,
  source: string,
): void {
  const category = row[3] ?? '';
  const rawValue = row[4] ?? '';
  const expectedType = deriveEffectType(category, rawValue);
  if (expectedType === undefined) {
    sourceError(errors, `${source} effect category`, source, `unsupported category ${JSON.stringify(category)}`);
    return;
  }
  compareValue(errors, `${path}.effect.type`, source, card.effect.type, expectedType);
  const effect = card.effect as CoreCellEffect;

  if (['receive_bank', 'pay_bank', 'receive_from_each_player'].includes(expectedType)) {
    const amounts = extractCurrencyAmounts(rawValue);
    if (amounts.length !== 1) {
      sourceError(errors, `${source} card value`, source, `must contain exactly one currency amount for ${expectedType}`);
    } else {
      compareValue(errors, `${path}.effect.amount`, source, effect.amount, amounts[0]);
    }
  } else if (expectedType === 'repairs') {
    const amounts = extractCurrencyAmounts(rawValue);
    if (amounts.length !== 2) {
      sourceError(errors, `${source} card value`, source, 'must contain house and hotel currency amounts');
    } else {
      compareValue(errors, `${path}.effect.perHouse`, source, effect.perHouse, amounts[0]);
      compareValue(errors, `${path}.effect.perHotel`, source, effect.perHotel, amounts[1]);
    }
  } else if (expectedType === 'skip_turn') {
    const turns = extractCount(rawValue, '次');
    if (turns === undefined) sourceError(errors, `${source} card value`, source, 'must contain a parseable pause count');
    else compareValue(errors, `${path}.effect.turns`, source, effect.turns, turns);
  } else if (expectedType === 'move_steps') {
    const steps = extractCount(rawValue, '步');
    if (steps === undefined) sourceError(errors, `${source} card value`, source, 'must contain a parseable step count');
    else compareValue(errors, `${path}.effect.steps`, source, effect.steps, steps);
  } else if (expectedType === 'move_to') {
    const direction = row[5] ?? '';
    const target = direction.includes('上海站')
      ? pack.game.board.cells.find((cell) => cell.name === '上海站')
      : direction.includes('起点') || rawValue.includes('起点')
        ? pack.game.board.cells.find((cell) => cell.type === 'start')
        : undefined;
    if (target === undefined) sourceError(errors, `${source} card direction`, source, 'must resolve a move target');
    else compareValue(errors, `${path}.effect.cellId`, source, effect.cellId, target.id);
    compareValue(errors, `${path}.effect.collectSalary`, source, effect.collectSalary, !rawValue.includes('不可领取'));
    if (rawValue.includes('起点')) {
      const bonusAmounts = extractCurrencyAmounts(rawValue);
      const bonusPath = `${source} card ${card.id} 起点奖金`;
      if (bonusAmounts.length !== 1) {
        sourceError(errors, bonusPath, source, 'must contain exactly one start salary amount');
      } else if (bonusAmounts[0] !== pack.game.config.passStartSalary) {
        sourceError(
          errors,
          bonusPath,
          source,
          `must equal game.config.passStartSalary ${pack.game.config.passStartSalary}, received ${bonusAmounts[0]}`,
        );
      }
    }
  } else if (expectedType === 'draw_card') {
    const expectedDeck = rawValue.includes('命运') ? 'destiny' : rawValue.includes('机会') ? 'chance' : undefined;
    if (expectedDeck === undefined) sourceError(errors, `${source} card value`, source, 'must name a card deck');
    else compareValue(errors, `${path}.effect.deck`, source, effect.deck, expectedDeck);
  }
}

function reconcileCardDeck(
  errors: string[],
  pack: MapPack,
  deckName: 'chance' | 'destiny',
  rawRows: string[][],
  expectedCount: number,
  source: string,
): void {
  const cards = pack.game.cards[deckName];
  compareValue(errors, `game.cards.${deckName} card count`, 'approved China Tour counts', cards.length, expectedCount);
  compareValue(errors, `${source} row count`, source, rawRows.length, expectedCount);
  const normalizedIds = rawRows.map((row) => normalizeCardId(row[0] ?? ''));
  reportDuplicates(normalizedIds, source, source, 'normalized card id', errors);
  const rawById = new Map(rawRows.map((row) => [normalizeCardId(row[0]!), row]));
  const cardIds = new Set(cards.map((card) => card.id));

  cards.forEach((card, index) => {
    const path = `game.cards.${deckName}[${index}]`;
    const rawRow = rawById.get(card.id);
    if (rawRow === undefined) {
      sourceError(errors, `${path}.id`, source, `unknown card id ${JSON.stringify(card.id)}`);
      return;
    }
    const expectedRawType = deckName === 'chance' ? '机会' : '命运';
    compareValue(errors, `${source} card type`, source, rawRow[1], expectedRawType);
    const rawText = rawRow[2] ?? '';
    if (!normalizeText(card.text).includes(normalizeText(rawText))) {
      sourceError(errors, `${path}.text`, source, `must contain source text ${JSON.stringify(rawText)}`);
    }
    if (JAIL_TEXT_PATTERN.test(card.text)) {
      sourceError(errors, `${path}.text`, 'approved jail-free China Tour config', 'must not contain jail text');
    }
    compareCardEffect(errors, pack, card, rawRow, path, source);
    const expectedType = deriveEffectType(rawRow[3] ?? '', rawRow[4] ?? '');
    const affectsColumn = deckName === 'chance' ? 5 : 6;
    const affectsOthers = rawRow[affectsColumn];
    const flowPath = `${source} card ${card.id}.是否影响他人`;
    if (affectsOthers !== '是' && affectsOthers !== '否') {
      sourceError(errors, flowPath, source, `must be 是 or 否, received ${JSON.stringify(affectsOthers)}`);
    } else if (expectedType !== undefined) {
      const category = rawRow[3] ?? '';
      const expectedFlag = category === '互动'
        || category === '向他人收取'
        || expectedType === 'receive_from_each_player'
        || expectedType === 'pay_each_player'
        ? '是'
        : '否';
      if (affectsOthers !== expectedFlag) {
        sourceError(errors, flowPath, source, `${expectedType} requires ${expectedFlag}, received ${affectsOthers}`);
      }
    }
  });

  const missingIds = [...rawById.keys()].filter((id) => !cardIds.has(id));
  if (missingIds.length > 0) sourceError(errors, `game.cards.${deckName}`, source, `missing cards: ${missingIds.join(', ')}`);
}

function reconcileApprovedConfig(errors: string[], pack: MapPack): void {
  Object.entries(APPROVED_EXPECTATIONS.config).forEach(([key, expected]) => {
    compareValue(errors, `game.config.${key}`, 'approved China Tour config', pack.game.config[key as keyof typeof pack.game.config], expected);
  });
}

export function assertChinaTourMapDataParity(pack: MapPack, mapData: ChinaTourMapData): void {
  const errors: string[] = [];
  if (!deepEqual(pack.game.board, mapData.board)) {
    sourceError(errors, 'mapData.board', 'packages/board-data/maps/china-tour/v1/board.json', 'does not match china-tour@1 game.board');
  }
  if (!deepEqual(pack.game.cards, mapData.cards)) {
    sourceError(errors, 'mapData.cards', 'packages/board-data/maps/china-tour/v1/cards.json', 'does not match china-tour@1 game.cards');
  }
  if (!deepEqual(pack.game.config, mapData.config)) {
    sourceError(errors, 'mapData.config', 'packages/board-data/maps/china-tour/v1/game-config.json', 'does not match china-tour@1 game.config');
  }
  if (errors.length > 0) throw new Error(`China Tour map data parity failed:\n- ${errors.join('\n- ')}`);
}

export function assertChinaTourSourceReconciliation(pack: MapPack, sources: ChinaTourSourceTexts): void {
  if (pack.ref.id !== APPROVED_EXPECTATIONS.mapId) {
    throw new Error(`ref.id (China Tour validator): reconciliation requires china-tour, received ${pack.ref.id}`);
  }

  const errors: string[] = [];
  const normalSource = 'raw/大富翁-普通地皮.md';
  const nonNormalSource = 'raw/大富翁-非普通地皮.md';
  const chanceSource = 'raw/机会卡.md';
  const destinySource = 'raw/命运卡.md';
  const normalRows = parseMdTable(sources.normalProperties, normalSource, NORMAL_HEADERS, errors);
  const nonNormalRows = parseMdTable(sources.nonNormalProperties, nonNormalSource, NON_NORMAL_HEADERS, errors);
  const chanceRows = parseMdTable(sources.chanceCards, chanceSource, CHANCE_HEADERS, errors);
  const destinyRows = parseMdTable(sources.destinyCards, destinySource, DESTINY_HEADERS, errors);

  assertRequiredCells(normalRows, normalSource, NORMAL_HEADERS, () => NORMAL_HEADERS.map((_, index) => index), errors);
  assertRequiredCells(nonNormalRows, nonNormalSource, NON_NORMAL_HEADERS, (row) => (
    row[1] === '火车站' ? NON_NORMAL_HEADERS.map((_, index) => index) : [0, 1, 2, 3, 4, 7]
  ), errors);
  assertRequiredCells(chanceRows, chanceSource, CHANCE_HEADERS, () => [0, 1, 2, 3, 4, 5], errors);
  assertRequiredCells(destinyRows, destinySource, DESTINY_HEADERS, () => [0, 1, 2, 3, 4, 6, 7], errors);

  compareValue(errors, `${normalSource} row count`, normalSource, normalRows.length, APPROVED_EXPECTATIONS.normalPropertyCount);
  compareValue(errors, `${nonNormalSource} row count`, nonNormalSource, nonNormalRows.length, APPROVED_EXPECTATIONS.stationCount + APPROVED_EXPECTATIONS.utilityCount);
  compareValue(errors, `${nonNormalSource} station row count`, nonNormalSource, nonNormalRows.filter((row) => row[1] === '火车站').length, APPROVED_EXPECTATIONS.stationCount);
  compareValue(errors, `${nonNormalSource} utility row count`, nonNormalSource, nonNormalRows.filter((row) => row[1] === '特殊地皮').length, APPROVED_EXPECTATIONS.utilityCount);
  reconcileUtilityRules(
    errors,
    pack,
    nonNormalRows.filter((row) => row[1] === '特殊地皮'),
    nonNormalSource,
  );

  const normalCount = pack.game.board.cells.filter((cell) => cell.type === 'property' && cell.subtype === 'normal').length;
  const stationCount = pack.game.board.cells.filter((cell) => cell.type === 'property' && cell.subtype === 'station').length;
  const utilityCount = pack.game.board.cells.filter((cell) => cell.type === 'property' && cell.subtype === 'utility').length;
  compareValue(errors, 'game.board.cells', 'approved China Tour counts', pack.game.board.cells.length, APPROVED_EXPECTATIONS.cellCount);
  compareValue(errors, 'game.board.cells normal property count', 'approved China Tour counts', normalCount, APPROVED_EXPECTATIONS.normalPropertyCount);
  compareValue(errors, 'game.board.cells station count', 'approved China Tour counts', stationCount, APPROVED_EXPECTATIONS.stationCount);
  compareValue(errors, 'game.board.cells utility count', 'approved China Tour counts', utilityCount, APPROVED_EXPECTATIONS.utilityCount);

  reconcileProperties(errors, pack, normalRows, nonNormalRows);
  reconcileCardDeck(errors, pack, 'chance', chanceRows, APPROVED_EXPECTATIONS.chanceCardCount, chanceSource);
  reconcileCardDeck(errors, pack, 'destiny', destinyRows, APPROVED_EXPECTATIONS.destinyCardCount, destinySource);
  reconcileApprovedConfig(errors, pack);

  if (errors.length > 0) throw new Error(`China Tour source reconciliation failed:\n- ${errors.join('\n- ')}`);
}
