import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertValidMapPack } from '../mapValidation';
import { worldTourMap } from '../worldTourMap';

const mapDirectory = new URL('../../maps/world-tour/v1/', import.meta.url);

const worldTourModule = { id: 'world-tour', version: 1 } as const;

function readMapJson(fileName: string): any {
  const fileUrl = new URL(fileName, mapDirectory);
  expect(existsSync(fileUrl), `world-tour/v1/${fileName} must exist`).toBe(true);
  return JSON.parse(readFileSync(fileUrl, 'utf8'));
}

const expectedTopology = [
  { id: 0, type: 'start', name: '北京首都机场' },
  { id: 1, type: 'property', name: '日本', subtitle: '东京' },
  { id: 2, type: 'property', name: '韩国', subtitle: '首尔' },
  { id: 3, type: 'chance', name: '机会' },
  { id: 4, type: 'property', name: '中国', subtitle: '北京' },
  { id: 5, type: 'property', name: '北冰洋' },
  { id: 6, type: 'destiny', name: '命运' },
  { id: 7, type: 'property', name: '俄罗斯', subtitle: '莫斯科' },
  {
    id: 8,
    type: 'special',
    name: '学习各种外语，增强语言能力',
    effect: { type: 'skip_turn', turns: 1 },
  },
  { id: 9, type: 'property', name: '越南', subtitle: '河内' },
  { id: 48, type: 'property', name: '泰国', subtitle: '曼谷' },
  { id: 49, type: 'property', name: '马来西亚', subtitle: '吉隆坡' },
  { id: 11, type: 'property', name: '新加坡', subtitle: '新加坡市' },
  {
    id: 10,
    type: 'module',
    name: '泰国曼谷机场',
    nextId: 12,
    module: worldTourModule,
    cellType: 'airport-branch',
    payload: { outerNextId: 12, branchEntryId: 40, branchCellIds: [40, 41, 42, 43, 44, 45, 46, 47], mergeCellId: 31 },
  },
  { id: 12, type: 'property', name: '印度尼西亚', subtitle: '雅加达' },
  { id: 13, type: 'chance', name: '机会' },
  { id: 14, type: 'property', name: '印度', subtitle: '新德里' },
  { id: 15, type: 'property', name: '巴基斯坦', subtitle: '伊斯兰堡' },
  {
    id: 16,
    type: 'special',
    name: '购买无线上网卡',
    effect: { type: 'pay_bank', amount: 1000 },
  },
  { id: 17, type: 'property', name: '土耳其', subtitle: '安卡拉' },
  { id: 57, type: 'property', name: '阿联酋', subtitle: '阿布扎比' },
  { id: 18, type: 'property', name: '伊拉克', subtitle: '巴格达' },
  { id: 60, type: 'property', name: '摩洛哥', subtitle: '拉巴特' },
  { id: 19, type: 'property', name: '埃及', subtitle: '开罗' },
  { id: 50, type: 'property', name: '苏伊士运河' },
  { id: 51, type: 'property', name: '南非', subtitle: '比勒陀利亚' },
  {
    id: 20,
    type: 'special',
    name: '罗马文化节',
    effect: { type: 'receive_bank', amount: 1000 },
  },
  { id: 21, type: 'property', name: '尼日利亚', subtitle: '阿布贾' },
  { id: 22, type: 'destiny', name: '命运' },
  { id: 23, type: 'property', name: '肯尼亚', subtitle: '内罗毕' },
  { id: 24, type: 'property', name: '印度洋' },
  { id: 25, type: 'property', name: '法国', subtitle: '巴黎' },
  { id: 26, type: 'property', name: '德国', subtitle: '柏林' },
  { id: 27, type: 'chance', name: '机会' },
  { id: 28, type: 'property', name: '意大利', subtitle: '罗马' },
  { id: 52, type: 'property', name: '西班牙', subtitle: '马德里' },
  { id: 53, type: 'property', name: '荷兰', subtitle: '阿姆斯特丹' },
  { id: 54, type: 'property', name: '瑞士', subtitle: '伯尔尼' },
  { id: 55, type: 'property', name: '瑞典', subtitle: '斯德哥尔摩' },
  {
    id: 30,
    type: 'special',
    name: '伦敦航班延误',
    effect: { type: 'pay_bank', amount: 1000 },
  },
  { id: 31, type: 'property', name: '挪威', subtitle: '奥斯陆' },
  { id: 32, type: 'property', name: '加拿大', subtitle: '温哥华' },
  { id: 33, type: 'property', name: '美国', subtitle: '华盛顿' },
  { id: 34, type: 'destiny', name: '命运' },
  { id: 35, type: 'property', name: '墨西哥', subtitle: '墨西哥城' },
  { id: 56, type: 'property', name: '巴拿马运河' },
  { id: 36, type: 'property', name: '危地马拉', subtitle: '危地马拉城' },
  { id: 37, type: 'property', name: '大西洋' },
  { id: 38, type: 'property', name: '巴西', subtitle: '巴西利亚' },
  { id: 58, type: 'property', name: '阿根廷', subtitle: '布宜诺斯艾利斯' },
  { id: 59, type: 'property', name: '智利', subtitle: '圣地亚哥' },
  { id: 39, type: 'property', name: '秘鲁', subtitle: '利马', nextId: 0 },
  { id: 40, type: 'property', name: '太平洋' },
  { id: 41, type: 'special', name: '班机延误', effect: { type: 'skip_turn', turns: 1 } },
  { id: 42, type: 'property', name: '澳大利亚', subtitle: '堪培拉' },
  { id: 43, type: 'chance', name: '机会' },
  { id: 44, type: 'property', name: '新西兰', subtitle: '惠灵顿' },
  { id: 45, type: 'destiny', name: '命运' },
  { id: 46, type: 'property', name: '南极洲' },
  {
    id: 47,
    type: 'special',
    name: '得奖金1000元',
    nextId: 31,
    effect: { type: 'receive_bank', amount: 1000 },
  },
] as const;

const expectedNormalProperties = [
  [1, '日本', '东京', 2600, 1500, [200, 1000, 3000, 7500, 11000], 1300],
  [2, '韩国', '首尔', 2600, 1500, [200, 1000, 3000, 7500, 11000], 1300],
  [4, '中国', '北京', 4000, 2000, [500, 2000, 6000, 14000, 20000], 2000],
  [7, '俄罗斯', '莫斯科', 3500, 2000, [350, 1750, 5000, 11000, 15000], 1750],
  [9, '越南', '河内', 1400, 1000, [100, 500, 1500, 4500, 7500], 700],
  [48, '泰国', '曼谷', 1800, 1000, [140, 700, 2000, 5500, 9500], 900],
  [49, '马来西亚', '吉隆坡', 1600, 1000, [120, 600, 1800, 5000, 9000], 800],
  [11, '新加坡', '新加坡市', 1200, 500, [80, 400, 1000, 3000, 6000], 600],
  [12, '印度尼西亚', '雅加达', 2800, 1500, [220, 1100, 3300, 8000, 11500], 1400],
  [14, '印度', '新德里', 3000, 2000, [260, 1300, 3900, 9000, 13000], 1500],
  [15, '巴基斯坦', '伊斯兰堡', 2200, 1000, [160, 800, 2200, 6000, 10000], 1100],
  [17, '土耳其', '安卡拉', 1200, 500, [80, 400, 1000, 3000, 6000], 600],
  [57, '阿联酋', '阿布扎比', 2600, 1500, [200, 1000, 3000, 7500, 11000], 1300],
  [18, '伊拉克', '巴格达', 1000, 500, [60, 300, 900, 2700, 5500], 500],
  [60, '摩洛哥', '拉巴特', 1200, 500, [80, 400, 1000, 3000, 6000], 600],
  [19, '埃及', '开罗', 1400, 1000, [100, 500, 1500, 4500, 7500], 700],
  [51, '南非', '比勒陀利亚', 2000, 1000, [150, 750, 2100, 5800, 9800], 1000],
  [21, '尼日利亚', '阿布贾', 2200, 1000, [160, 800, 2200, 6000, 10000], 1100],
  [23, '肯尼亚', '内罗毕', 600, 500, [20, 100, 300, 900, 2500], 300],
  [25, '法国', '巴黎', 3200, 2000, [280, 1500, 4500, 10000, 14000], 1600],
  [26, '德国', '柏林', 3200, 2000, [280, 1500, 4500, 10000, 14000], 1600],
  [28, '意大利', '罗马', 1800, 1000, [140, 700, 2000, 5500, 9500], 900],
  [52, '西班牙', '马德里', 2800, 1500, [220, 1100, 3300, 8000, 11500], 1400],
  [53, '荷兰', '阿姆斯特丹', 2400, 1500, [180, 900, 2500, 7000, 10500], 1200],
  [54, '瑞士', '伯尔尼', 3200, 2000, [280, 1500, 4500, 10000, 14000], 1600],
  [55, '瑞典', '斯德哥尔摩', 2000, 1000, [150, 750, 2100, 5800, 9800], 1000],
  [31, '挪威', '奥斯陆', 1600, 1000, [120, 600, 1800, 5000, 9000], 800],
  [32, '加拿大', '温哥华', 2400, 1500, [180, 900, 2500, 7000, 10500], 1200],
  [33, '美国', '华盛顿', 3000, 2000, [260, 1300, 3900, 9000, 13000], 1500],
  [35, '墨西哥', '墨西哥城', 2400, 1500, [180, 900, 2500, 7000, 10500], 1200],
  [36, '危地马拉', '危地马拉城', 800, 500, [40, 200, 600, 1800, 4000], 400],
  [38, '巴西', '巴西利亚', 2800, 1500, [220, 1100, 3300, 8000, 11500], 1400],
  [58, '阿根廷', '布宜诺斯艾利斯', 2200, 1000, [160, 800, 2200, 6000, 10000], 1100],
  [59, '智利', '圣地亚哥', 1600, 1000, [120, 600, 1800, 5000, 9000], 800],
  [39, '秘鲁', '利马', 1000, 500, [60, 300, 900, 2700, 5500], 500],
  [42, '澳大利亚', '堪培拉', 1600, 1000, [120, 600, 1800, 5000, 9000], 800],
  [44, '新西兰', '惠灵顿', 800, 500, [40, 200, 600, 1800, 4000], 400],
  [46, '南极洲', undefined, 600, 500, [20, 100, 300, 900, 2500], 300],
] as const;

const expectedOceans = [
  [5, '北冰洋', 2000, [2000, 4000, 6000, 8000], 1000],
  [24, '印度洋', 2000, [2000, 4000, 6000, 8000], 1000],
  [37, '大西洋', 2000, [2000, 4000, 6000, 8000], 1000],
  [40, '太平洋', 2000, [2000, 4000, 6000, 8000], 1000],
] as const;

function moduleEffect(effectType: string, payload: Record<string, unknown> = {}): any {
  return { type: 'module', module: worldTourModule, effectType, payload };
}

const expectedChanceTitles = {
  C01: '罗马斗兽场涂写罚款',
  C02: '参观大英博物馆',
  C03: '吴哥窟导游服务',
  C04: '东非大裂谷考古发现',
  C05: '伊斯坦布尔冰淇淋体验',
  C06: '东京动漫授权收益',
  C07: '首尔演唱会门票',
  C08: '上海国际贸易订单',
  C09: '俄罗斯寒潮造成房产维修',
  C10: '胡志明市咖啡出口',
  C11: '印度尼西亚救援航班',
  C12: '班加罗尔软件项目',
  C13: '尼罗河游船费用',
  C14: '巴黎艺术沙龙收益',
  C15: '德国高速公路维修',
  C16: '加拿大暴风雪',
  C17: '纽约百老汇庆典',
  C18: '墨西哥城快速列车',
  C19: '加拿大机票',
  C20: '北京国际转机',
  C21: '新加坡观光巴士',
  C22: '欧洲短途航班',
  C23: '北京环球航线',
} as const;

const expectedDestinyTitles = {
  D01: '招待亲友入住八星级酋长国宫殿酒店',
  D02: '投资香榭丽舍大道精品连锁店',
  D03: '获得日本新干线世界之旅联票',
  D04: '中国深圳科技项目成功转化',
  D05: '北冰洋科考设备损坏',
  D06: '搭乘俄罗斯西伯利亚铁路',
  D07: '租用新加坡滨海湾会展场地',
  D08: '参加印度新德里国际文化节',
  D09: '使用土耳其安卡拉航空里程',
  D10: '埃及考古项目获得研究补助',
  D11: '印度洋风暴造成房产损坏',
  D12: '法国航空交通罢工',
  D13: '与德国企业达成工业合作',
  D14: '前往挪威领取国际和平奖',
  D15: '美国跨国企业反垄断和解',
  D16: '借助大西洋顺风航线',
  D17: '巴西农产品出口行情上涨',
  D18: '国际航班改降泰国曼谷机场',
  D19: '南极洲科考队紧急救援',
  D20: '完成环球旅行',
  D21: '拉斯维加斯骰子赛',
  D22: '华盛顿银行援助',
} as const;

const expectedChance = [
  ['C01', '向银行支付1500元', { type: 'pay_bank', amount: 1500 }],
  ['C02', '抵消下一次正数过路费（不可叠加，0元不消耗）', moduleEffect('toll-immunity')],
  ['C03', '其他每位未破产玩家向你支付200元', { type: 'receive_from_each_player', amount: 200 }],
  ['C04', '从银行获得2000元', { type: 'receive_bank', amount: 2000 }],
  ['C05', '向银行支付600元', { type: 'pay_bank', amount: 600 }],
  ['C06', '从银行获得800元', { type: 'receive_bank', amount: 800 }],
  ['C07', '向银行支付500元', { type: 'pay_bank', amount: 500 }],
  ['C08', '从银行获得1200元', { type: 'receive_bank', amount: 1200 }],
  ['C09', '维修资产：每栋房屋支付300元，每座旅馆支付900元', { type: 'repairs', perHouse: 300, perHotel: 900 }],
  ['C10', '从银行获得1000元', { type: 'receive_bank', amount: 1000 }],
  ['C11', '向前移动2格并正常结算', { type: 'move_steps', steps: 2 }],
  ['C12', '从银行获得1500元', { type: 'receive_bank', amount: 1500 }],
  ['C13', '向银行支付800元', { type: 'pay_bank', amount: 800 }],
  ['C14', '其他每位未破产玩家向你支付300元', { type: 'receive_from_each_player', amount: 300 }],
  ['C15', '向银行支付1000元', { type: 'pay_bank', amount: 1000 }],
  ['C16', '暂停一次', { type: 'skip_turn', turns: 1 }],
  ['C17', '向其他每位未破产玩家支付800元', { type: 'pay_each_player', amount: 800 }],
  ['C18', '向前移动3格并正常结算', { type: 'move_steps', steps: 3 }],
  ['C19', '前往加拿大温哥华；经过起点可领取工资并正常结算', { type: 'move_to', cellId: 32, collectSalary: true }],
  ['C20', '再抽一张命运卡并立即执行', { type: 'draw_card', deck: 'destiny' }],
  ['C21', '掷两颗骰子，选择其中一颗或两颗之和前进；不触发额外回合', moduleEffect('bus-choice')],
  ['C22', '可支付3500元，前往主环前方1至6步内任意普通地产或海洋；不领取工资', moduleEffect('short-flight', { cost: 3500, maxForwardSteps: 6 })],
  ['C23', '可支付8000元，前往主环任意普通地产或海洋；不领取工资', moduleEffect('long-flight', { cost: 8000 })],
] as const;

const expectedDestiny = [
  ['D01', '向银行支付1800元', { type: 'pay_bank', amount: 1800 }],
  ['D02', '选择任意一块符合条件的普通地产免费升级一级；所有权不变，三栋房屋可升级为旅馆', moduleEffect('free-upgrade')],
  ['D03', '前往日本东京；经过起点可领取工资并正常结算', { type: 'move_to', cellId: 1, collectSalary: true }],
  ['D04', '从银行获得1800元', { type: 'receive_bank', amount: 1800 }],
  ['D05', '向银行支付1000元', { type: 'pay_bank', amount: 1000 }],
  ['D06', '向前移动4格并正常结算', { type: 'move_steps', steps: 4 }],
  ['D07', '向银行支付1200元', { type: 'pay_bank', amount: 1200 }],
  ['D08', '向银行支付700元', { type: 'pay_bank', amount: 700 }],
  ['D09', '向前移动2格并正常结算', { type: 'move_steps', steps: 2 }],
  ['D10', '从银行获得1500元', { type: 'receive_bank', amount: 1500 }],
  ['D11', '维修资产：每栋房屋支付400元，每座旅馆支付1200元', { type: 'repairs', perHouse: 400, perHotel: 1200 }],
  ['D12', '暂停一次', { type: 'skip_turn', turns: 1 }],
  ['D13', '其他每位未破产玩家向你支付300元', { type: 'receive_from_each_player', amount: 300 }],
  ['D14', '从银行获得2500元，不移动', { type: 'receive_bank', amount: 2500 }],
  ['D15', '向其他每位未破产玩家支付500元', { type: 'pay_each_player', amount: 500 }],
  ['D16', '向前移动3格并正常结算', { type: 'move_steps', steps: 3 }],
  ['D17', '从银行获得1800元', { type: 'receive_bank', amount: 1800 }],
  ['D18', '前往泰国曼谷机场；经过起点可领取工资，下个个人回合掷一颗骰子进入支线', { type: 'move_to', cellId: 10, collectSalary: true }],
  ['D19', '向银行支付1200元', { type: 'pay_bank', amount: 1200 }],
  ['D20', '前往北京首都机场（起点）并领取一次工资', { type: 'move_to', cellId: 0, collectSalary: true }],
  ['D21', '选择一位其他未破产玩家，各掷一颗骰子；平局重掷，点数低者向高者支付1200元', moduleEffect('dice-duel', { amount: 1200 })],
  ['D22', '现金最少的未破产玩家从银行获得2000元；并列时按抽卡者起顺时针顺序决定', moduleEffect('lowest-cash-aid', { amount: 2000 })],
] as const;

function projectTopology(cell: any): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    id: cell.id,
    type: cell.type,
    name: cell.name,
  };
  for (const key of ['subtitle', 'nextId', 'module', 'cellType', 'payload', 'effect']) {
    if (cell[key] !== undefined) projected[key] = cell[key];
  }
  return projected;
}

function projectNormalProperty(cell: any): readonly unknown[] {
  return [
    cell.id,
    cell.name,
    cell.subtitle,
    cell.price,
    cell.houseCost,
    cell.rents,
    cell.mortgageValue,
  ];
}

function projectOcean(cell: any): readonly unknown[] {
  return [cell.id, cell.name, cell.price, cell.rents, cell.mortgageValue];
}

function successorOf(cells: any[], id: number): number {
  const index = cells.findIndex((cell) => cell.id === id);
  return cells[index].nextId ?? cells[index + 1].id;
}

describe('world-tour@1 approved source data', () => {
  it('locks the corrected 52-cell outer loop, eight-cell Bangkok branch, and two utilities', () => {
    const board = readMapJson('board.json');

    expect(board.cells.map(projectTopology)).toEqual(expectedTopology);
    expect(board.cells).toHaveLength(60);
    expect(successorOf(board.cells, 10)).toBe(12);
    expect(board.cells.find((cell: { id: number; payload?: { branchEntryId: number } }) => cell.id === 10)!.payload!.branchEntryId).toBe(40);
    expect(successorOf(board.cells, 47)).toBe(31);
    expect(successorOf(board.cells, 39)).toBe(0);
    expect(board.cells.slice(34, 36).map((cell: { name: string }) => cell.name)).toEqual(['意大利', '西班牙']);
    expect(board.cells.filter((cell: { type: string; subtype: string }) => cell.type === 'property' && cell.subtype === 'utility').map((cell: { id: number }) => cell.id)).toEqual([50, 56]);
  });

  it('locks all 38 normal properties and four oceans', () => {
    const board = readMapJson('board.json');
    const normalProperties = board.cells.filter(
      (cell: any) => cell.type === 'property' && cell.subtype === 'normal',
    );
    const oceans = board.cells.filter(
      (cell: any) => cell.type === 'property' && cell.subtype === 'station',
    );

    expect(normalProperties.map(projectNormalProperty)).toEqual(expectedNormalProperties);
    expect(oceans.map(projectOcean)).toEqual(expectedOceans);
    expect(normalProperties.every((cell: any) => cell.rents.length === 5)).toBe(true);
    expect(oceans.every((cell: any) => cell.rents.length === 4)).toBe(true);
  });

  it('requires price to equal exactly twice the mortgage for all 44 purchasable cells', () => {
    const board = readMapJson('board.json');
    const purchasableCells = board.cells.filter((cell: any) => cell.type === 'property');

    expect(purchasableCells).toHaveLength(44);
    expect(
      purchasableCells.map((cell: any) => ({
        id: cell.id,
        price: cell.price,
        mortgageValue: cell.mortgageValue,
        matches: cell.price === cell.mortgageValue * 2,
      })),
    ).toEqual(
      purchasableCells.map((cell: any) => ({
        id: cell.id,
        price: cell.price,
        mortgageValue: cell.mortgageValue,
        matches: true,
      })),
    );
  });

  it('locks the owner-approved 23 chance and 22 destiny titles and rules', () => {
    const cards = readMapJson('cards.json');

    expect(cards.chance.map((card: any) => [card.id, card.title, card.text, card.effect])).toEqual(
      expectedChance.map(([id, text, effect]) => [id, expectedChanceTitles[id], text, effect]),
    );
    expect(cards.destiny.map((card: any) => [card.id, card.title, card.text, card.effect])).toEqual(
      expectedDestiny.map(([id, text, effect]) => [id, expectedDestinyTitles[id], text, effect]),
    );
    expect(cards.chance).toHaveLength(23);
    expect(cards.destiny).toHaveLength(22);
  });

  it('locks the owner-approved World Tour game config', () => {
    expect(readMapJson('game-config.json')).toEqual({
      initialCash: 15000,
      passStartSalary: 2000,
      maxHouseLevel: 4,
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

  it('requires both core@1 and world-tour@1 plus one presentation per cell', () => {
    const manifest = readMapJson('manifest.json');
    const board = readMapJson('board.json');

    expect(manifest.ref.id).toBe('world-tour');
    expect(manifest.ref.version).toBe(1);
    expect(manifest.ref.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.requiredRuleModules).toEqual([
      { id: 'core', version: 1 },
      worldTourModule,
    ]);
    expect(Object.keys(manifest.presentation.cells).map(Number).sort((a, b) => a - b)).toEqual(
      board.cells.map((cell: { id: number }) => cell.id).sort((a: number, b: number) => a - b),
    );
  });

  it('lays out a 52-cell outer loop with fourteen cells on every side', () => {
    const board = readMapJson('board.json');
    const manifest = readMapJson('manifest.json');
    const airport = board.cells.find((cell: { id: number }) => cell.id === 10);
    const branchIds = new Set<number>(airport.payload.branchCellIds);
    const outerPlacements = board.cells
      .filter((cell: { id: number }) => !branchIds.has(cell.id))
      .map((cell: { id: number }) => manifest.presentation.cells[cell.id]);

    expect(outerPlacements).toHaveLength(52);
    expect({
      top: outerPlacements.filter((cell: any) => cell.y === 0).length,
      right: outerPlacements.filter((cell: any) => cell.x + cell.width === 100).length,
      bottom: outerPlacements.filter((cell: any) => cell.y + cell.height === 100).length,
      left: outerPlacements.filter((cell: any) => cell.x === 0).length,
    }).toEqual({ top: 14, right: 14, bottom: 14, left: 14 });
  });

  it('is a deeply frozen valid immutable map pack', () => {
    expect(() => assertValidMapPack(worldTourMap, [
      { id: 'core', version: 1 },
      worldTourModule,
    ])).not.toThrow();
    expect(Object.isFrozen(worldTourMap)).toBe(true);
    expect(Object.isFrozen(worldTourMap.game.board.cells)).toBe(true);
    expect(Object.isFrozen(worldTourMap.game.cards.chance[0]!.effect)).toBe(true);
    expect(Object.isFrozen(worldTourMap.presentation.cells[40]!)).toBe(true);
  });
});
