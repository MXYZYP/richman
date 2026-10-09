// Guards the settings dialog's two shapes on a laptop-width window.
//
// Symptom (user's laptop, 974px viewport, settings open): the dialog was pinned to the
// bottom of the screen with square top corners — the bottom-drawer shape. Two causes:
//   1. the centred-modal rules sat behind `@media (min-width: 1025px)` while GameView's
//      compact layout ends at 1024px, so 974px fell through to the drawer shape;
//   2. the slide-in animation (`translate: 0 24px`) also covered the modal variant and
//      would have knocked it out of centre on any width <= 1024px.
//
// This file has no component-mount harness, so the shape contract is pinned by reading
// the stylesheet. Comments are stripped before every value lookup — a comment that quotes
// the old declaration would otherwise be read as the declaration itself.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sheet = readFileSync(resolve(here, '..', 'components', 'MobileSheet.vue'), 'utf8');
const gameView = readFileSync(resolve(here, '..', 'views', 'GameView.vue'), 'utf8');
const clean = sheet.slice(sheet.lastIndexOf('<style')).replace(/\/\*[\s\S]*?\*\//g, '');

/** Scans line by line with an explicit media stack; returns "@media <q>" or '(top level)'. */
function mediaOwning(marker: RegExp): string {
  const stack: { q: string; indent: number }[] = [];
  const lines = clean.split('\n');
  let flat = 0;
  for (const line of lines) {
    const open = /^\s*@media([^{]+)\{/.exec(line);
    if (open !== null) { stack.push({ q: open[1].trim(), indent: line.search(/\S/) }); continue; }
    if (marker.test(line)) {
      const q = stack.map((s) => s.q).join(' AND ');
      if (q !== '' || stack.length === 0) return q === '' ? '(top level)' : q;
    }
    if (/^\s*\}\s*$/.test(line)) {
      const indent = line.search(/\S/);
      if (stack.length > 0 && stack[stack.length - 1].indent === indent) { stack.pop(); flat += 1; }
    }
  }
  return '(not found)';
}

describe('设置弹窗在笔记本宽度下也是居中弹窗', () => {
  it('居中样式的断点不高于外壳的紧凑布局上限（否则笔记本会漏过）', () => {
    // GameView treats <=1024px as compact; the dialog must already be centred there.
    const compactCeiling = /@media \(max-width: 1024px\)/.test(gameView);
    expect(compactCeiling).toBe(true);

    const owner = mediaOwning(/top:\s*50%;/);
    const width = /min-width:\s*(\d+)px/.exec(owner);
    expect(width).not.toBeNull();
    expect(Number(width![1])).toBeLessThanOrEqual(1024);
  });

  it('居中样式的断点不低于手机起点（768px），否则手机上会弹居中窗', () => {
    const owner = mediaOwning(/top:\s*50%;/);
    const width = /min-width:\s*(\d+)px/.exec(owner);
    expect(Number(width![1])).toBeGreaterThanOrEqual(768);
  });

  it('弹窗四角都圆（底部抽屉才是上圆下直角）', () => {
    expect(clean).toMatch(/data-variant='modal'\][\s\S]{0,400}border-radius:\s*16px/);
    // The drawer keeps its flat bottom edge; that rule is fine, but the modal must not
    // inherit the `border-bottom: none` that the drawer needs.
    expect(clean).toMatch(/data-variant='modal'\][\s\S]{0,400}border-bottom:\s*1px solid/);
  });

  it('抽屉上滑动画不覆盖 modal 变体（它的 translate 承担居中职责）', () => {
    expect(clean).toMatch(/\.mobile-sheet:not\(\[data-variant='modal'\]\)\s*\{\s*translate:\s*0 24px;/);
    expect(clean).not.toMatch(/\.mobile-sheet\s*\{\s*translate:\s*0 24px;/);
  });

  it('遮罩淡入淡出也只作用于抽屉', () => {
    expect(clean).toMatch(/\.mobile-sheet:not\(\[data-variant='modal'\]\)::backdrop/);
    expect(clean).toMatch(/\.mobile-sheet:not\(\[data-variant='modal'\]\)\[open\]::backdrop/);
  });

  it('@starting-style 的入场位移也只作用于抽屉', () => {
    expect(clean).toMatch(/@starting-style\s*\{\s*\.mobile-sheet:not\(\[data-variant='modal'\]\)\[open\]/);
  });

  it('inline 变体在桌面仍然摊平（资产/战报抽屉靠这个进入侧栏）', () => {
    const owner = mediaOwning(/display:\s*contents;/);
    expect(owner).toMatch(/min-width:\s*1025px/);
  });

  it('花括号平衡（删改 media 块时最容易破的地方）', () => {
    let depth = 0;
    let min = 0;
    for (const c of clean) {
      if (c === '{') depth += 1;
      if (c === '}') { depth -= 1; if (depth < min) min = depth; }
    }
    expect({ depth, min }).toEqual({ depth: 0, min: 0 });
  });
});