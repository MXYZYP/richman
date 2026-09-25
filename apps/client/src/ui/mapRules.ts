// 规则说明数据源（路线图 #13 设置面板扩展）。
//
// 背景：设置弹窗里的「规则说明」原先是一段写死的通用要点 —— 换到《长城之旅》这类带特化
// 规则模块的图，玩家在设置里看到的仍是「落在无主地产可购买」这种任何图都成立的话，
// 规则模块、渡口/烽火台、地价档位、房屋上限等真正的差异一处都看不到。
//
// 这里把「本局规则」做成纯函数：输入一个 MapPack，输出可直接渲染的事实清单。
// 全部数字都从 pack 里读，不写死任何一张图的数值 —— 新增地图无需改本模块就能自动跟上。
import { getActiveMapPack, listActiveMaps, type MapPack } from '@richman/board-data';
import { formatMoney } from './format';

/**
 * 规则模块的中文名。引擎侧没有统一的展示名注册表，这里只登记会出现在「规则说明」里的模块；
 * 未登记的模块回落到 id 本身，宁可显示 `foo@1` 也不要显示空白。
 */
const MODULE_LABELS: Readonly<Record<string, string>> = {
  'world-tour': '世界巡游',
  'great-wall': '烽火台',
  'prison': '监狱',
  // 路线图 #23：八张纯 core 地图各补一个模块，中文名与引擎侧的 cellType 一一对应。
  'rail-hub': '高铁枢纽',
  'landmark-passport': '地标护照',
  'port-trade': '湾区口岸',
  'piaohao': '晋商票号',
  'caravan-market': '丝路商队',
  'oasis-camp': '绿洲营地',
  'yangtze-ferry': '长江渡轮',
  'river-tide': '黄河汛期',
};

/** 只有这些模块需要一句额外的玩法提示；纯 core 的地图不该多出任何一句话。 */
const MODULE_NOTES: Readonly<Record<string, string>> = {
  'world-tour': '落在机场格会进入世界巡游支线：下一回合不掷骰，先在待选动作里挑一座城市再继续。',
  'great-wall': '落在无主烽火台可以花钱占据；他人落到你已占据的烽火台，要向你支付通行费。',
  'prison': '停在进牢格或被「进牢」卡送进监狱后，轮到自己时可以在待选动作里挑一种方式出狱：'
    + '掷骰达标（出狱后按点数继续走）、用出狱许可证，或缴纳保释金立刻出狱。',
  'rail-hub': '落在高铁枢纽可候车休息：身上带着停赛就一次性全部清空，否则领 300 元候车补贴；'
    + '也可付 500 元换乘直达下一个枢纽（跳跃，不领过起点工资，一回合只能换乘一次）。',
  'landmark-passport': '落在地标可免费盖一枚纪念章，第 n 枚得 n × 1000 元（越集越值钱）；'
    + '集满全部地标后，此后每次经过起点再领 1000 元环球旅行家津贴。地标人人可盖、互不冲突。',
  'port-trade': '落在口岸可押 600 元赌一把：掷两颗骰子点数之和 ≥ 8，就连本带利拿回 1500 元（净赚 900），'
    + '否则押金没收。期望略正但波动不小，领先时未必该赌。',
  'piaohao': '落在票号可存入 1000 元吃利息（每回合 8%，余额上限 5000），也可随时取现本息；'
    + '回合开始时若现金不足 1000 而票号里有余，票号会自动划 550 元、送你 500 现金垫付。',
  'caravan-market': '落在集市可花 500 元进货（最多囤 3 件）或按当前市价出货；'
    + '市价是全场共享的行情、每回合随机涨落，趁低价囤货、趁高价抛售。',
  'oasis-camp': '落在绿洲可花 600 元扎营（每人一处，在别处再扎营等于迁移，旧营地作废）；'
    + '此后每次经过自己的营地（含停留）都领 500 元补给，也可撤营退回 300 元。',
  'yangtze-ferry': '落在渡口可付 400 元顺流直达下一个渡口（跳跃，不领过起点工资），'
    + '或免费逆流回到上一个渡口；一回合只能换乘一次，抵达的渡口不再结算落点。',
  'river-tide': '黄河水位全场共享、每回合随机涨落：水位 ≥ 8 时全场过路费 ×1.5，≤ 2 时 ×0.6；'
    + '落在河工段可付 1000 元修堤把水位压低 2 格。修堤的人自己掏钱、受益的是所有地主。',
};

/**
 * 规则模块的「格子行」：模块的 cellType → 显示名 + 玩法摘要。
 *
 * 与 MODULE_LABELS 分开，因为一张图上同一个模块可能改造出不同数量的格子，这一行要带格数；
 * 也不能与 MODULE_NOTES 合并，后者按模块 id 输出一句完整提示，而这里要逐类列格。
 * 烽火台与进牢格不在此表内：它们各自早有一行（进牢格还要带上保释金，属配置项而非常量）。
 */
const MODULE_CELL_TYPE_FACTS: Readonly<Record<string, { readonly label: string; readonly summary: string }>> = {
  'rail-hub': { label: '高铁枢纽', summary: '可候车休息（清停赛或领补贴），或付费换乘直达下一枢纽' },
  'landmark': { label: '地标', summary: '免费盖章，集章越多单枚奖励越高；集满后过起点再领津贴' },
  'port': { label: '口岸', summary: '押注掷骰，点数达标即可连本带利拿回' },
  'piaohao': { label: '票号', summary: '存入生息、取现周转；现金告急时票号会自动垫付' },
  'caravan': { label: '集市', summary: '低价囤货、高价出货，市价全场共享' },
  'oasis': { label: '绿洲营地', summary: '扎营后每次经过自己的营地都能领补给' },
  'ferry': { label: '渡轮停靠点', summary: '付费顺流直达下一渡口，或免费逆流回到上一渡口' },
  'river-works': { label: '河工段', summary: '出钱修堤压低水位，水位高低改变全场过路费' },
};

export interface MapRuleFact {
  readonly label: string;
  readonly value: string;
}

export interface MapRulesSummary {
  readonly mapId: string;
  readonly title: string;
  readonly cellCount: number;
  /** 按棋盘数据算出的规则事实，顺序固定，供列表逐行渲染。 */
  readonly facts: readonly MapRuleFact[];
  /** 特化规则模块的一句话提示；纯 core 地图为空数组。 */
  readonly moduleNotes: readonly string[];
}

/**
 * 棋盘格数组的只读类型。
 * 直接用 `readonly Cell[]` 会失败：地图包里的格子是 `DeepReadonly<Cell>`，
 * 其 `rents: readonly number[]` 无法赋给可变类型的 `number[]`。这里从 MapPack 上取类型，
 * 天然与数据同源。
 */
type BoardCells = MapPack['game']['board']['cells'];

/** 地产地价的档位摘要：`13 档（¥1,000 ~ ¥4,500）`；没有正常型地产时返回 null。 */
function summarizePrices(cells: BoardCells): string | null {
  const prices: number[] = [];
  for (const cell of cells) {
    if (cell.type === 'property' && cell.subtype === 'normal') prices.push(cell.price);
  }
  if (prices.length === 0) return null;
  const tiers = [...new Set(prices)].sort((left, right) => left - right);
  const min = Math.min(...tiers);
  const max = Math.max(...tiers);
  return min === max
    ? `${tiers.length} 档（均 ¥${formatMoney(min)}）`
    : `${tiers.length} 档（¥${formatMoney(min)} ~ ¥${formatMoney(max)}）`;
}

function collectModuleNotes(pack: MapPack): string[] {
  const notes: string[] = [];
  for (const ref of pack.game.requiredRuleModules) {
    const note = MODULE_NOTES[ref.id];
    if (note === undefined) continue;
    const label = MODULE_LABELS[ref.id] ?? ref.id;
    notes.push(`【${label}】${note}`);
  }
  return notes;
}

function collectModuleNames(pack: MapPack): string {
  const names: string[] = [];
  for (const ref of pack.game.requiredRuleModules) {
    if (ref.id === 'core') continue;
    names.push(MODULE_LABELS[ref.id] ?? ref.id);
  }
  // 「仅核心规则」是有效信息：它告诉玩家这张图没有额外特化规则，而不是漏写了。
  return names.length === 0 ? '仅核心规则' : names.join(' · ');
}

/** 从一张地图包算出可渲染的规则事实。纯函数，不读 localStorage、不看对局状态。 */
export function describeMapRules(pack: MapPack): MapRulesSummary {
  const cells = pack.game.board.cells;
  const config = pack.game.config;

  let stationCount = 0;
  let utilityCount = 0;
  let beaconCount = 0;
  let jailCount = 0;
  let chanceCount = 0;
  let destinyCount = 0;
  let taxCount = 0;
  // 模块格按 cellType 计数：既有模块（烽火台/进牢格）与新增模块共用这一张表，
  // 于是「某张图上有几处驿站/票号」这种问题不再需要逐个模块加一个局部变量。
  const moduleCellCounts = new Map<string, number>();
  for (const cell of cells) {
    if (cell.type === 'property') {
      if (cell.subtype === 'station') stationCount += 1;
      else if (cell.subtype === 'utility') utilityCount += 1;
    } else if (cell.type === 'chance') {
      chanceCount += 1;
    } else if (cell.type === 'destiny') {
      destinyCount += 1;
    } else if (cell.type === 'tax') {
      taxCount += 1;
    }
    // 烽火台是 great-wall@1 的模块格、进牢格是 prison@1 的模块格：都不在 property 里，
    // 故与上面的分支并列判断。
    if (cell.type === 'module') {
      moduleCellCounts.set(cell.cellType, (moduleCellCounts.get(cell.cellType) ?? 0) + 1);
      if (cell.cellType === 'beacon') beaconCount += 1;
      if (cell.cellType === 'goto-jail') jailCount += 1;
    }
  }

  const [utilityFirst, utilitySecond] = config.utilityMultipliers;
  const goals = config.cashGoalPresets.map((goal) => `¥${formatMoney(goal)}`).join(' 或 ');

  const facts: MapRuleFact[] = [
    { label: '地图', value: `${pack.metadata.title} · ${cells.length} 格` },
    { label: '规则模块', value: collectModuleNames(pack) },
    { label: '初始资金', value: `¥${formatMoney(config.initialCash)}` },
    { label: '过起点收入', value: `¥${formatMoney(config.passStartSalary)}` },
    { label: '房屋上限', value: `每块地产最多 ${config.maxHouseLevel} 级` },
    { label: '抵押利息', value: `每回合 ${Math.round(config.mortgageInterestRate * 100)}%` },
  ];

  const priceSummary = summarizePrices(cells);
  if (priceSummary !== null) facts.push({ label: '地产地价', value: priceSummary });
  if (stationCount > 0) {
    // 各图命名不同（中国之旅是「XX站」、珠江/长江之旅是「XX渡」），故用并列的通用名。
    facts.push({ label: '车站 / 渡口', value: `${stationCount} 处（租金随持有数递增）` });
  }
  if (utilityCount > 0) {
    facts.push({
      label: '水电 / 水利',
      value: `${utilityCount} 处（租金 = 点数 × ${utilityFirst} / × ${utilitySecond}）`,
    });
  }
  if (beaconCount > 0) {
    facts.push({ label: '烽火台', value: `${beaconCount} 座（可占据并向过客收通行费）` });
  }
  if (jailCount > 0) {
    // 保释金是可选配置（只有启用监狱的地图才配），所以只在确实配了的时候才写进这一行。
    const bailCost = config.jailBailCost;
    facts.push({
      label: '监狱',
      value: bailCost === undefined
        ? `${jailCount} 处进牢格`
        : `${jailCount} 处进牢格（保释金 ¥${formatMoney(bailCost)}）`,
    });
  }
  // 新增规则模块的格子行。表内顺序固定 → 同一张图的渲染顺序稳定，测试与截图都可复现。
  for (const [cellType, fact] of Object.entries(MODULE_CELL_TYPE_FACTS)) {
    const count = moduleCellCounts.get(cellType) ?? 0;
    if (count > 0) facts.push({ label: fact.label, value: `${count} 处（${fact.summary}）` });
  }
  if (chanceCount > 0 || destinyCount > 0) {
    facts.push({ label: '机会 / 命运', value: `${chanceCount} / ${destinyCount} 格` });
  }
  if (taxCount > 0) facts.push({ label: '税费格', value: `${taxCount} 处` });
  if (goals !== '') facts.push({ label: '可选胜利目标', value: goals });

  return {
    mapId: pack.ref.id,
    title: pack.metadata.title,
    cellCount: cells.length,
    facts,
    moduleNotes: collectModuleNotes(pack),
  };
}

/**
 * 按地图 id 取规则说明。id 为空或不在正式地图清单里时返回 null，
 * 由调用方回落到与地图无关的通用要点（大厅尚未选图、或历史 id 已下线时都会走到这里）。
 */
export function describeMapRulesById(mapId: string | null | undefined): MapRulesSummary | null {
  if (mapId === null || mapId === undefined || mapId === '') return null;
  if (!listActiveMaps().some((entry) => entry.ref.id === mapId)) return null;
  return describeMapRules(getActiveMapPack(mapId));
}
