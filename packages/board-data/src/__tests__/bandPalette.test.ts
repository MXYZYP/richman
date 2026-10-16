// 地图色板守卫（2026-10-16）。
//
// 缺陷类：**同一张图里两个地区共用同一个色值**。棋盘上相邻两块地产变成同色，边界直接消失，
// 而功能上没有任何东西会报错 —— mapValidation 只查 token 格式与「被引用的 token 必须已声明」，
// 对「两个 token 指向同一个 hex」完全沉默。这类问题只能靠眼睛在棋盘上发现，所以值得钉。
//
// 为什么不用「声明了就必须被引用」当第二条守卫：pearl-tour 有 band:ferry / band:utility
// 两个已声明、零引用的色带（历史遗留，本次不动），那条规则一写出来就是一条注定失败的测试。
// 谎话守卫比没守卫更糟，所以这里只钉 13 张图当下都守得住的那一条。
import { describe, expect, it } from 'vitest';
import { chinaTourMap } from '../chinaTourMap';
import { classicTourMap } from '../classicTourMap';
import { getActiveMapPack, listActiveMaps } from '../registry';

const HEX = /^#[0-9A-Fa-f]{6}$/;

const activeMapIds = listActiveMaps().map((entry) => [entry.ref.id] as const);

/** 只取地区色带（band:feishu-*），不含 station / utility —— 后两者是全图共用的语义色。 */
function propertyBandValues(bands: Readonly<Record<string, string>>): string[] {
  return Object.entries(bands)
    .filter(([token]) => token.startsWith('band:feishu-'))
    .map(([, value]) => value.toUpperCase());
}

describe('地图色板：同一张图里不许两个色带同色', () => {
  it.each(activeMapIds)('%s 的色带取值互不重复', (mapId) => {
    const values = Object.values(getActiveMapPack(mapId).presentation.theme.propertyBands)
      .map((value) => value.toUpperCase());

    const seen = new Set<string>();
    const duplicates = values.filter((value) => {
      if (seen.has(value)) return true;
      seen.add(value);
      return false;
    });

    expect(duplicates).toEqual([]);
  });

  it.each(activeMapIds)('%s 的每个色带都是 6 位 hex', (mapId) => {
    const bands = getActiveMapPack(mapId).presentation.theme.propertyBands;
    expect(Object.entries(bands).filter(([, value]) => !HEX.test(value))).toEqual([]);
  });
});

describe('classic-tour（世界名城）不复用 china-tour 的地区色板', () => {
  it('两张图的地区色没有交集', () => {
    const china = propertyBandValues(chinaTourMap.presentation.theme.propertyBands);
    const classic = propertyBandValues(classicTourMap.presentation.theme.propertyBands);

    expect(china).toHaveLength(8);
    expect(classic).toHaveLength(8);

    // 世界名城自带冰蓝棋盘（board #cfe3ec / route #1f6f8b / title #0b3d5c），地区色因此是
    // 另一套冷色板；china-tour 那套是暖色纸面。两套一旦被合并回去，两张图在选图界面
    // 与对局里就再难分开 —— 那正是这条断言要拦住的事。
    const shared = classic.filter((value) => china.includes(value));
    expect(shared).toEqual([]);
  });
});
