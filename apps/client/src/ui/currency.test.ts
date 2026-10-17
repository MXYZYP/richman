// 守卫：局内货币单位**跟着地图走**，且全站不再出现现金符号。
//
// 用户的决定（11-17）：
//   「那就中国城市用方案a，世界地图用方案b」
//   —— 方案 a = 「两」，方案 b = 「金币」。
//
// 为什么必须换掉 ¥
//   TapTap《小游戏内容规范》明文禁止「出现涉及现金符号（如 ¥、$）或暗示真实货币交易的玩法」。
//   大富翁的核心循环是买地收租，本来就是最容易被审成「模拟真实金钱」的玩法，
//   再挂一个 ¥ 等于自己把证据递上去。「元」也不行 —— 它仍是人民币单位。
//
// 为什么单位不能是一个全局常量
//   同一局里「1,600 两」和「1,600 金币」都对，取决于棋盘是世界图还是中国图。
//   所以唯一事实源是 CASH_UNIT_BY_MAP；未收录的地图一律回落「两」，绝不抛错。
//
// 本项目没有组件挂载环境，所以这里钉的是**数据与格式化函数**（真断言），
// 以及「源码里不许再出现 ¥」这条静态契约（接线守卫，不是渲染验证）。
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CASH_UNIT_BY_MAP,
  cashUnitForMap,
  currentCashUnit,
  formatCash,
  formatCashDelta,
  setCashUnitForMap,
} from './format';
import { describeMapRulesById } from './mapRules';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..');

describe('货币单位跟地图走', () => {
  it('世界之旅用「金币」，中国城市图用「两」', () => {
    expect(cashUnitForMap('world-tour')).toBe('金币');
    for (const chinaMap of [
      'china-tour',
      'classic-tour',
      'yuncheng-tour',
      'shanxi-tour',
      'silk-road',
      'great-wall',
      'yangtze-tour',
      'pearl-tour',
    ]) {
      expect(cashUnitForMap(chinaMap), chinaMap).toBe('两');
    }
  });

  it('未知 / 空地图回落到「两」，不抛错', () => {
    expect(cashUnitForMap(null)).toBe('两');
    expect(cashUnitForMap(undefined)).toBe('两');
    expect(cashUnitForMap('')).toBe('两');
    expect(cashUnitForMap('a-map-that-does-not-exist')).toBe('两');
  });

  it('映射表只登记世界图 —— 新增外国地图时补一行，别把中国图写进去', () => {
    expect(Object.keys(CASH_UNIT_BY_MAP)).toEqual(['world-tour']);
  });

  it('formatCash 是「数字 + 空格 + 单位」，不出现任何货币符号', () => {
    expect(formatCash(1600, '两')).toBe('1,600 两');
    expect(formatCash(15000, '金币')).toBe('15,000 金币');
    expect(formatCash(0, '两')).toBe('0 两');
    expect(formatCash(1600, '两')).not.toMatch(/[¥$￥]/);
  });

  it('setCashUnitForMap 切换后，默认单位跟着变', () => {
    setCashUnitForMap('world-tour');
    expect(currentCashUnit()).toBe('金币');
    expect(formatCash(2000)).toBe('2,000 金币');

    setCashUnitForMap('yuncheng-tour');
    expect(currentCashUnit()).toBe('两');
    expect(formatCash(2000)).toBe('2,000 两');

    setCashUnitForMap(null);
    expect(currentCashUnit()).toBe('两');
  });

  it('现金增减提示也带单位', () => {
    setCashUnitForMap(null);
    expect(formatCashDelta(1000)).toBe('+1,000 两');
    expect(formatCashDelta(-1000)).toBe('−1,000 两');
  });
});

describe('规则说明按地图包自己的单位渲染', () => {
  it('中国城市图的事实清单用「两」', () => {
    const summary = describeMapRulesById('yuncheng-tour');
    if (summary === null) throw new Error('运城之旅应当有规则说明');
    const money = summary.facts.filter((fact) => /\d/.test(fact.value) && /(资金|收入|地价|目标|保释)/.test(fact.label));
    expect(money.length).toBeGreaterThan(0);
    for (const fact of money) {
      expect(fact.value, fact.label).not.toMatch(/[¥$￥]/);
    }
    const initial = summary.facts.find((fact) => fact.label === '初始资金');
    expect(initial?.value).toMatch(/^\d[\d,]* 两$/);
  });

  it('世界之旅的事实清单用「金币」', () => {
    const summary = describeMapRulesById('world-tour');
    if (summary === null) throw new Error('世界之旅应当有规则说明');
    const initial = summary.facts.find((fact) => fact.label === '初始资金');
    expect(initial?.value).toMatch(/^\d[\d,]* 金币$/);
  });
});

describe('源码里不再出现现金符号', () => {
  /** 剥掉三类注释：注释里提到 ¥ 是解释原因，不算违规。 */
  const strip = (text: string) => text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full, out);
      } else if (['.ts', '.vue'].includes(extname(entry.name)) && !entry.name.includes('.test.')) {
        out.push(full);
      }
    }
    return out;
  };

  it('产品代码（.ts / .vue，不含测试）没有 ¥ / ￥', () => {
    const offenders: string[] = [];
    for (const file of walk(srcRoot)) {
      const text = strip(readFileSync(file, 'utf8'));
      if (/[¥￥]/.test(text)) offenders.push(file.slice(srcRoot.length + 1));
    }
    expect(offenders).toEqual([]);
  });

  // 跨地图聚合的统计卡：bestAsset 是「所有地图里的历史最高资产」，
  // 一局中国图 + 一局世界图混在一起时，挂「两」或「金币」都会说错，所以只给数字不给单位。
  // 加这个文件必须在下面这行里登记，并写清为什么它不该有单位。
  const AGGREGATE_VIEWS = new Set([
    'views/StatsView.vue',
    'views/LeaderboardView.vue',
    'views/CloudSyncView.vue',
  ]);

  /** 统一成 POSIX 分隔符：Windows 下 slice 出来是反斜杠，白名单会对不上。 */
  const relOf = (file: string) => file.slice(srcRoot.length + 1).split(sep).join('/');

  it('局内金额都经由 formatCash 输出（跨地图聚合的统计卡只给数字）', () => {
    const offenders: string[] = [];
    for (const file of walk(srcRoot)) {
      const rel = relOf(file);
      if (AGGREGATE_VIEWS.has(rel)) continue;
      const text = strip(readFileSync(file, 'utf8'));
      // 模板里出现「{{ formatMoney(...) }}」＝这一处金额没有单位。
      const templateHits = text.match(/\{\{\s*formatMoney\([^}]*\)\s*\}\}/g) ?? [];
      if (templateHits.length > 0) offenders.push(`${rel}: ${templateHits[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('发布说明正文也不出现现金符号（它整段渲染进「更新说明」弹窗）', () => {
    // release-notes.json 不在 src 下，但它的正文会被原样显示给玩家，
    // 上一轮就漏了一句「花 ¥1500 保释」—— 构建产物里能搜到，评审也能看到。
    const releases = readFileSync(resolve(srcRoot, '../../../release-notes.json'), 'utf8');
    expect(releases).not.toMatch(/[¥￥]/);
  });

  it('白名单里的三个统计视图确实只用纯数字（别把局内金额塞进去）', () => {
    const hits: string[] = [];
    for (const rel of AGGREGATE_VIEWS) {
      const text = strip(readFileSync(join(srcRoot, rel), 'utf8'));
      for (const match of text.match(/\{\{\s*formatMoney\([^}]*\)\s*\}\}/g) ?? []) {
        if (!/bestAsset/.test(match)) hits.push(`${rel}: ${match}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
