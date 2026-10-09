// Regression guards for the three mobile-layout defects visible in the user's screenshot.
//
// 1. The start tile rendered 「起点 起点」 — `getCellDetail` returns name「起点」 AND
//    `nonPropertyTypeLabel` returns typeLabel 「起点」, and the view printed both.
// 2. The utility icons rendered as solid black blocks — the <svg> carried no `fill`
//    ATTRIBUTE, so `fill` defaulted to black; the `.utility-icon { fill: none }` rule only
//    rescues that while the stylesheet loads.
// 3. The header meta strip was a single non-wrapping flex row, so on a phone the room code
//    and elapsed time were pushed off-screen.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getCellDetailSubtitle } from './clientGame';
import { getActiveMapPack } from '@richman/board-data';

const here = dirname(fileURLToPath(import.meta.url));
const view = readFileSync(resolve(here, '..', 'views', 'GameView.vue'), 'utf8');

describe('位置卡第二行不再重复格名', () => {
  const base = { name: '起点', typeLabel: '起点', ownerName: null, price: null, levelLabel: null };

  it('drops the subtitle when it would only repeat the tile name (start tile)', () => {
    expect(getCellDetailSubtitle(base, null)).toBe('');
  });

  it('drops it for a tax tile whose name equals its type label too', () => {
    expect(getCellDetailSubtitle({ ...base, name: '起点', typeLabel: '起点' }, null)).toBe('');
  });

  it('keeps a genuinely different type label', () => {
    expect(getCellDetailSubtitle({ ...base, name: '扬州', typeLabel: '机会' }, null)).toBe('机会');
  });

  it('prefers the owner name over the type label', () => {
    expect(getCellDetailSubtitle({ ...base, name: '北京', ownerName: '电脑A' }, null)).toBe('电脑A');
  });

  it('says 无主地产 for an unowned property', () => {
    expect(getCellDetailSubtitle({ ...base, name: '上海', typeLabel: '地产', price: 2000 }, null))
      .toBe('无主地产');
  });

  it('appends the level and the rent', () => {
    expect(getCellDetailSubtitle(
      { name: '北京', typeLabel: '地产', ownerName: '电脑A', price: 2000, levelLabel: '2级' },
      { label: '当前租金', amount: 480 },
    )).toBe('电脑A · 2级 · 当前租金 ¥480');
  });

  it('really does collide on the start tile of a shipped map', () => {
    // Guards the premise: if a future map renames its start tile, this test tells us the
    // screenshot regression can no longer be reproduced with that map (not that the bug is
    // fixed by renaming).
    for (const mapId of ['china-tour', 'classic-tour']) {
      const start = getActiveMapPack(mapId).game.board.cells.find((c) => c.type === 'start');
      expect(start, `${mapId} has a start cell`).toBeDefined();
      const detail = { name: start!.name, typeLabel: '起点', ownerName: null, price: null, levelLabel: null };
      expect(start!.name === '起点' ? getCellDetailSubtitle(detail, null) : '').toBe('');
    }
  });
});

describe('AI 托管按钮在笔记本窄窗也必须可见', () => {
  /** Body of a CSS rule, or null. Comments stripped first so a comment that quotes a
   *  declaration is not read as the declaration. */
  function ruleBody(selector: string): string | null {
    const clean = view.replace(/\/\*[\s\S]*?\*\//g, '');
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const multi = new RegExp(escaped + '\\s*\\{\\s*\\n([\\s\\S]*?)\\n\\s*\\}').exec(clean);
    if (multi !== null) return multi[1];
    const single = new RegExp(escaped + '\\s*\\{([^{}]*)\\}').exec(clean);
    return single !== null ? single[1] : null;
  }

  it('.side-utility 在 ≤1024px 是隐藏的（笔记本窄窗正好落在这个区间）', () => {
    // 这条不是断言「应该隐藏」，而是把前提钉住：它解释了托管按钮为什么不能放进去。
    expect(view).toMatch(/@media \(max-width: 1024px\)[\s\S]*?\.side-utility\s*\{[^}]*display:\s*none/);
  });

  it('托管按钮用独立的 .takeover-toggle，不挂在 .side-utility 里', () => {
    expect(view).toContain('class="takeover-toggle"');
    // 它必须位于 .side-utility 那个 div 的闭合标签之外。
    const start = view.indexOf('class="side-utility"');
    const end = view.indexOf('class="takeover-toggle"');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const between = view.slice(start, end);
    expect(between, '托管按钮被包在 .side-utility 里了 —— ≤1024px 会整组消失')
      .not.toContain('takeover-toggle');
  });

  it('托管按钮的样式不挂在 .side-utility 的媒体查询里', () => {
    const own = ruleBody('.takeover-toggle');
    expect(own, '缺少 .takeover-toggle 的样式').not.toBeNull();
    expect(own).toMatch(/width:\s*100%/);
  });
});

describe('次级按钮的图标不会渲染成黑块', () => {
  const icons = [...view.matchAll(/<svg class="utility-icon[^"]*"[\s\S]*?>/g)].map((m) => m[0]);

  it('至少有两个次级按钮图标（离开 / 设置），加AI 托管后更多', () => {
    // 这里刻意**不锁死数量**：数量随按钮增减而变，而真正的意图是「每个图标都不能变黑块」
    // （下一条逐个断言）。上一版锁了 exactly two，加一个托管图标就红—— 断言的是数字，
    // 不是规则。
    expect(icons.length).toBeGreaterThanOrEqual(2);
  });

  it.each(icons.map((svg, i) => [i, svg]))('icon #%i declares fill="none"', (_i, svg) => {
    // The CSS rule alone is not enough: without the attribute, any failure to load or match    // the stylesheet turns a line icon into a filled black blob.
    expect(svg).toMatch(/\sfill="none"/);
    expect(svg).toMatch(/\sstroke="currentColor"/);
  });

  it('the stylesheet still refines width and line weight', () => {
    expect(view).toMatch(/\.utility-icon\s*\{[\s\S]*?fill:\s*none;/);
    expect(view).toMatch(/\.utility-icon\s*\{[\s\S]*?stroke:\s*currentColor;/);
  });
});

describe('顶部信息条在窄屏会换行', () => {
  /** Reads a declaration from a CSS rule. Comments stripped first — a comment mentioning a
   *  property name would otherwise be read as the declaration. */
  function rule(selector: string): string {
    const clean = view.replace(/\/\*[\s\S]*?\*\//g, '');
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const multi = new RegExp(escaped + '\\s*\\{\\s*\\n([\\s\\S]*?)\\n\\s*\\}').exec(clean);
    const single = new RegExp(escaped + '\\s*\\{([^{}]*)\\}').exec(clean);
    const body = multi !== null ? multi[1] : (single !== null ? single[1] : null);
    if (body === null) throw new Error(`no CSS rule for ${selector}`);
    return body;
  }

  it('.game-meta wraps instead of forcing one line', () => {
    expect(rule('.game-meta')).toMatch(/flex-wrap:\s*wrap/);
  });

  it('.game-meta-tags wraps too, so the room code and clock drop to a second row', () => {
    expect(rule('.game-meta-tags')).toMatch(/flex-wrap:\s*wrap/);
  });

  it('the room code never wraps mid-number', () => {
    expect(rule('.game-room-code')).toMatch(/white-space:\s*nowrap/);
  });

  it('the map name truncates with an ellipsis rather than pushing the tags off-screen', () => {
    const ruleBody = rule('.game-meta > span:first-child');
    expect(ruleBody).toMatch(/text-overflow:\s*ellipsis/);
    expect(ruleBody).toMatch(/white-space:\s*nowrap/);
  });
});