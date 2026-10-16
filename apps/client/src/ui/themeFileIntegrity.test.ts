// Guards gameTheme.css against the defect class that, on 2026-10-16, silently disabled
// three of the five play skins AND the dialog entrance animation.
//
// THE BUG
//   The four skin blocks (ocean / midnight / forest / sand) were each missing their closing
//   brace. The file had 16 `{` and only 12 `}`. postcss refuses to parse it outright:
//
//     CssSyntaxError: .../ui/gameTheme.css:262:1: Unclosed block
//
//   Each later block therefore became a *nested* rule of the previous one, so its selector
//   was prefixed with the parent's. Midnight's block ended up requiring <html> to carry
//   data-theme="ocean" AND data-theme="midnight" at once — the same unmatchable shape
//   globalStyleBoundary.test.ts already documents ("36,608 unmatchable selectors").
//   Net effect: only `ocean` ever applied; `midnight` / `forest` / `sand` were dead, and
//   the trailing `@media (prefers-reduced-motion: no-preference)` block was swallowed with
//   them, taking the 260ms dialog entrance and `@starting-style` along.
//
// THE RULE
//   gameTheme.css is hand-maintained and structurally flat: five parallel blocks that must
//   each declare the SAME variable set. So keep it flat — braces balanced, every
//   `:root[data-theme=…]` at top level, and no skin drifting from the classic baseline.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, 'gameTheme.css');
const raw = readFileSync(cssPath, 'utf8');

// Comment bodies are blanked out but newlines are preserved, so reported line numbers stay
// accurate. The prose in this file quotes selectors and declarations, and a naive scan
// would read that prose as structure.
const code = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const lines = code.split(/\r?\n/);

/** How many blocks are open *before* each line starts. */
function lineDepths(): number[] {
  const depths: number[] = [];
  let depth = 0;
  for (const line of lines) {
    depths.push(depth);
    depth += (line.match(/\{/g) ?? []).length;
    depth -= (line.match(/\}/g) ?? []).length;
  }
  return depths;
}

interface Block {
  selector: string;
  body: string;
}

/** Every depth-0 rule, i.e. blocks that are NOT nested inside another rule. */
function topLevelBlocks(): Block[] {
  const blocks: Block[] = [];
  let depth = 0;
  let selectorStart = 0;
  let bodyStart = -1;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '{') {
      depth += 1;
      if (depth === 1) bodyStart = i + 1;
      continue;
    }
    if (ch === '}') {
      if (depth === 1) {
        blocks.push({
          selector: code.slice(selectorStart, bodyStart - 1).trim(),
          body: code.slice(bodyStart, i),
        });
        selectorStart = i + 1;
      }
      depth -= 1;
    }
  }
  return blocks;
}

/** Custom property names declared in a block body (not those merely referenced via var()). */
function declaredVars(body: string): Set<string> {
  return new Set([...body.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)].map((m) => m[1]));
}

const depths = lineDepths();
const blocks = topLevelBlocks();
const themeLines = lines
  .map((text, index) => ({ text, index }))
  .filter(({ text }) => /\[data-theme=/.test(text));
const skinBlocks = blocks.filter((b) => /\[data-theme=/.test(b.selector));

describe('gameTheme.css 结构完整性', () => {
  it('找到了文件和五套主题块（守卫本身有效）', () => {
    expect(raw.length).toBeGreaterThan(1000);
    // classic 基线 1 块 + ocean / midnight / forest / sand 4 块。
    expect(themeLines.length).toBeGreaterThanOrEqual(4);
    expect(skinBlocks.length).toBeGreaterThanOrEqual(4);
  });

  it('花括号配对平衡', () => {
    const opens = (code.match(/\{/g) ?? []).length;
    const closes = (code.match(/\}/g) ?? []).length;
    expect(
      { opens, closes },
      '漏一个 `}` 就会让后面所有块变成嵌套规则，选择器被父级前缀串联后永不匹配'
        + '（2026-10-16：漏了 4 个，ocean 之外的 3 套皮肤与文件末尾的弹层动效全部失效）',
    ).toEqual({ opens: closes, closes });
    expect(depths[depths.length - 1]).toBe(0);
  });

  it('每个 :root[data-theme=…] 选择器都在顶层，没有被包进别的块', () => {
    for (const { text, index } of themeLines) {
      const at = depths[index];
      expect(at, `第 ${index + 1} 行处在 ${at} 层嵌套里，它前面有块没闭合：${text.trim()}`).toBe(0);
      expect(text, `第 ${index + 1} 行被缩进了，说明它在另一个块内部：${text}`).not.toMatch(/^\s/);
    }
  });

  it('文件末尾的弹层动效 @media 块仍在顶层', () => {
    const media = blocks.find((b) => /prefers-reduced-motion/.test(b.selector));
    expect(
      media,
      '沙丘块漏 `}` 时，这个 @media 会被吞进沙丘的声明里，dialog 的 260ms 进场'
        + '与 @starting-style 一并失效',
    ).toBeDefined();
  });
});

describe('五套皮肤声明的变量集合一致', () => {
  const baseline = blocks[0];
  const baseVars = declaredVars(baseline.body);

  it('classic 基线声明了完整的一组变量', () => {
    // 文件头注释写的是 44 条；留一点余量，只防止基线被整体误删。
    expect(baseVars.size).toBeGreaterThanOrEqual(40);
  });

  it.each(skinBlocks.map((b) => [b.selector.split('\n')[0].trim(), b] as const))(
    '%s 与 classic 基线的变量清单完全相同',
    (_label, block) => {
      const vars = declaredVars(block.body);
      const missing = [...baseVars].filter((v) => !vars.has(v));
      const extra = [...vars].filter((v) => !baseVars.has(v));
      expect(
        { missing, extra },
        '漏声明会「漏出上一套皮肤的颜色」，多声明则是没人用的死变量',
      ).toEqual({ missing: [], extra: [] });
    },
  );
});

/** Reads one declaration's raw value out of a (comment-stripped) block body. */
function declaredValue(body: string, name: string): string | null {
  const match = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+);`).exec(body);
  return match === null ? null : match[1].trim();
}

/** WCAG 2.x relative luminance of a plain `#rgb` / `#rrggbb` value. */
function luminance(hex: string): number {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (match === null) throw new Error(`not a plain hex colour: ${hex}`);
  const digits = match[1].length === 3 ? [...match[1]].map((c) => c + c).join('') : match[1];
  const [r, g, b] = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(digits.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, always ≥ 1. */
function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 主按钮的可读性。2026-10-16 之前 ocean / forest / sand 三套皮肤把
 * `--button-enabled-text` 写成 `#ffffff`，压在中等明度的彩色面上只有约 3.3:1，
 * 低于 WCAG AA 要求的 4.5:1 —— 而这在浅色皮肤（classic / midnight 用的是深墨字）上
 * 看不出来，只有真机切换皮肤才刺眼。所以在这里把它算成数字钉住。
 */
describe('五套皮肤的主按钮都满足对比度下限', () => {
  const allSkins = [
    { label: 'classic（基线）', body: blocks[0].body },
    ...skinBlocks.map((block) => ({
      label: block.selector.split('\n')[0].replace(/^:root\[data-theme='/u, '').replace(/'\].*$/su, ''),
      body: block.body,
    })),
  ];

  it.each(allSkins)('$label 的主按钮对比度 ≥ 4.5:1', ({ label, body }) => {
    const background = declaredValue(body, '--button-enabled-bg');
    const text = declaredValue(body, '--button-enabled-text');
    expect(background, `${label} 没有声明 --button-enabled-bg`).not.toBeNull();
    expect(text, `${label} 没有声明 --button-enabled-text`).not.toBeNull();
    expect(
      contrastRatio(background as string, text as string),
      `${label}: ${text} 压在 ${background} 上对比度不足（WCAG AA 正文要 4.5:1）`,
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('主按钮一律是「浅面 + 深字」，不是「深面 + 白字」', () => {
    for (const { label, body } of allSkins) {
      const background = declaredValue(body, '--button-enabled-bg') as string;
      expect(luminance(background), `${label} 的按钮底过暗，深字压不住`).toBeGreaterThanOrEqual(0.22);
    }
  });
});
