// Guards the shared dialog shape for every modal in the app.
//
// Contract (10-16 第四版 —— 用户给了参考图 + 「所有弹窗大小显示方式都要保持一致」):
//   * every `layout="modal"` sheet is a **centred** dialog on **every** width, phone included.
//     It used to sit behind `@media (min-width: 768px)`: a phone got the bottom-drawer shape
//     while a laptop got the centred one — one component, two looks. That was the whole
//     "inconsistency" the user was pointing at.
//   * width / max-height are declared **once**, in that rule. Any other dialog that writes its
//     own width or max-height silently breaks "all dialogs are the same size", so this file
//     fails on it (see the repo-wide scan below).
//   * the slide-in animation belongs to the drawer only — its `translate` would knock the
//     centred modal off centre.
//   * the four home icon details live in `DetailSheet` (modal) rather than the old full-page
//     `ViewShell`; nobody may quietly move one of them back onto a second screen.
//
// This repo has no component-mount harness, so the shape contract is pinned by reading the
// stylesheet. Comments are stripped before every value lookup — a comment that quotes the old
// declaration would otherwise be read as the declaration itself.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..');
const MOBILE_SHEET = resolve(srcRoot, 'components', 'MobileSheet.vue');
const sheet = readFileSync(MOBILE_SHEET, 'utf8');
const clean = sheet.slice(sheet.lastIndexOf('<style')).replace(/\/\*[\s\S]*?\*\//g, '');

/** The one and only dialog size. Keep in sync with MobileSheet's modal rule. */
const MODAL_WIDTH = 'min(92vw, 520px)';
const MODAL_HEIGHT = 'min(86dvh, 720px)';

/** Scans line by line with an explicit media stack; returns "@media <q>" or '(top level)'. */
function mediaOwning(marker: RegExp): string {
  const stack: { q: string; indent: number }[] = [];
  const lines = clean.split('\n');
  for (const line of lines) {
    const open = /^\s*@media([^{]+)\{/.exec(line);
    if (open !== null) { stack.push({ q: open[1].trim(), indent: line.search(/\S/) }); continue; }
    if (marker.test(line)) {
      const q = stack.map((s) => s.q).join(' AND ');
      if (q !== '' || stack.length === 0) return q === '' ? '(top level)' : q;
    }
    if (/^\s*\}\s*$/.test(line)) {
      const indent = line.search(/\S/);
      if (stack.length > 0 && stack[stack.length - 1].indent === indent) stack.pop();
    }
  }
  return '(not found)';
}

function vueFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...vueFilesUnder(full));
    else if (entry.name.endsWith('.vue')) found.push(full);
  }
  return found;
}

const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('弹窗形态：任何屏宽都是居中弹窗，且尺寸只有一处', () => {
  it('居中样式在顶层，不再挂 @media —— 手机上也是居中弹窗', () => {
    expect(mediaOwning(/top:\s*50%;/)).toBe('(top level)');
  });

  it('统一的宽度与最大高度都落在那条 modal 规则里', () => {
    expect(clean).toMatch(
      new RegExp(`data-variant='modal'\\][\\s\\S]{0,700}width:\\s*${escapeRe(MODAL_WIDTH)}`),
    );
    expect(clean).toMatch(
      new RegExp(`data-variant='modal'\\][\\s\\S]{0,700}max-height:\\s*${escapeRe(MODAL_HEIGHT)}`),
    );
  });

  it('全仓只有 MobileSheet 写过这两个尺寸值（否则「所有弹窗一样大」当场作废）', () => {
    const owners = vueFilesUnder(srcRoot)
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return text.includes('92vw') || text.includes('86dvh');
      })
      .map((file) => file.slice(srcRoot.length + 1).replace(/\\/g, '/'));

    expect(owners).toEqual(['components/MobileSheet.vue']);
  });

  it('弹窗四角都圆（底部抽屉才是上圆下直角）', () => {
    expect(clean).toMatch(/data-variant='modal'\][\s\S]{0,700}border-radius:\s*16px/);
    // The drawer keeps its flat bottom edge; that rule is fine, but the modal must not
    // inherit the `border-bottom: none` that the drawer needs.
    expect(clean).toMatch(/data-variant='modal'\][\s\S]{0,700}border-bottom:\s*1px solid/);
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
    expect(mediaOwning(/display:\s*contents;/)).toMatch(/min-width:\s*1025px/);
  });

  it('标题居中、关闭按钮贴右上（三列等分栅格才不会让标题左偏）', () => {
    const head = /\.mobile-sheet-head\s*\{([^}]*)\}/.exec(clean);
    if (head === null) throw new Error('MobileSheet 应当有 .mobile-sheet-head 规则');
    expect(head[1]).toContain('grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr)');

    const title = /\.mobile-sheet-head h2\s*\{([^}]*)\}/.exec(clean);
    if (title === null) throw new Error('MobileSheet 应当有 .mobile-sheet-head h2 规则');
    expect(title[1]).toContain('grid-column: 2');

    const close = /\.mobile-sheet-close\s*\{([^}]*)\}/.exec(clean);
    if (close === null) throw new Error('MobileSheet 应当有 .mobile-sheet-close 规则');
    expect(close[1]).toContain('grid-column: 3');
  });

  it('四个图标详情都改走 DetailSheet 弹窗，没有一个还留在整页壳上', () => {
    for (const name of ['StatsView', 'AchievementsView', 'CloudSyncView', 'LeaderboardView']) {
      const text = readFileSync(resolve(srcRoot, 'views', `${name}.vue`), 'utf8');
      expect(text).toContain("import DetailSheet from '../components/DetailSheet.vue';");
      expect(text).not.toContain("from './ViewShell.vue'");
      // 详情页自己也不许写弹窗宽高。
      expect(text).not.toContain('92vw');
      expect(text).not.toContain('86dvh');
    }
  });

  it('DetailSheet 把形态整个交给 MobileSheet，自己不写宽高', () => {
    const detail = readFileSync(resolve(srcRoot, 'components', 'DetailSheet.vue'), 'utf8');
    expect(detail).toContain('layout="modal"');
    expect(detail).not.toContain('92vw');
    expect(detail).not.toContain('86dvh');
  });

  it('更新说明也走同一套 modal 弹窗（它此前是全项目唯一一个自带 <dialog> 的首页弹窗）', () => {
    // 先剥注释：本文件与那个组件的注释里都在引用旧值，照读会把说明文字当成声明。
    const notes = readFileSync(resolve(srcRoot, 'components', 'ReleaseNotesDialog.vue'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(notes).toContain("import MobileSheet from './MobileSheet.vue';");
    expect(notes).toContain('layout="modal"');
    // 原来它自持一套：min(720px, 100% - 24px) / min(760px, 100dvh - 24px) / 圆角 24px /
    // 遮罩 58% + backdrop-filter 模糊 / 标题 clamp(24px, 5vw, 34px)。同一屏里点「战绩」是
    // 520px 弹窗、点「更新说明」却换成另一套 —— 这就是用户说的「大小不统一」。
    expect(notes).not.toContain('760px');
    expect(notes).not.toContain('min(720px');
    expect(notes).not.toContain('border-radius: 24px');
    expect(notes).not.toContain('::backdrop');
    expect(notes).not.toContain('<dialog');
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
