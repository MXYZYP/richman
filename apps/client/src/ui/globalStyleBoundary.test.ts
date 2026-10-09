// Guards against the scoped-CSS blow-up that silently collapsed the desktop layout.
//
// THE BUG
//   GameView.vue (a <style scoped> component) used to `import '../ui/gameTheme.css';`.
//   @vitejs/plugin-vue treats that file as component-scoped and cross-products its 16
//   theme selectors with every scoped rule in the component. Measured on a real build:
//
//     before: GameView css 8,222,245 bytes, 146,660 theme-qualifier occurrences,
//             36,608 unmatchable selectors (requiring <html> to be ocean AND midnight
//             AND forest AND sand at the same time), 38,699 selectors total.
//             The .game-shell{display:grid} rule was among the dead ones, so the browser
//             fell back to display:block -> the desktop layout collapsed into a vertical
//             stack (sidebar dropped below the board at full width, page would not scroll).
//     after:  GameView css 69,947 bytes, 0 theme qualifiers, .game-shell rule intact.
//
//   Rewriting the anchor (:root -> html, or unanchored) does NOT help — the cross product
//   is driven by the import site, not by the selector text. Verified by A/B build.
//
// THE RULE
//   A .vue file that declares <style scoped> must not import a global stylesheet.
//   Global stylesheets (style.css, darkMode.css, gameTheme.css) belong in main.ts.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..');

interface VueCssFacts {
  /** Path relative to src/, with forward slashes. */
  file: string;
  /** The component declares a <style scoped> block. */
  hasScoped: boolean;
  /** `import './x.css'` at the top of the SFC script. */
  cssImports: string[];
  /** `@import '...'` inside a <style> block. */
  styleCssImports: string[];
}

/** Every .vue file under src/, paired with whether it declares a scoped style block. */
function vueFiles(dir = srcRoot, acc: VueCssFacts[] = []): VueCssFacts[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { vueFiles(p, acc); continue; }
    if (!entry.name.endsWith('.vue')) continue;
    const text = readFileSync(p, 'utf8');
    acc.push({
      file: p.slice(srcRoot.length + 1).replace(/\\/g, '/'),
      hasScoped: /<style[^>]*\bscoped\b/.test(text),
      // CSS imports inside a .vue file: `import './x.css'` or `@import '...'`.
      cssImports: [...text.matchAll(/import\s+['"]([^'"]+\.css)['"]/g)].map((m) => m[1]),
      styleCssImports: [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
        .flatMap((m) => [...m[1].matchAll(/@import\s+['"]([^'"]+)['"]/g)].map((x) => x[1])),
    });
  }
  return acc;
}

const ALL = vueFiles();

describe('全局样式表不得被组件的scoped 样式带进来', () => {
  it('找到了 .vue 文件（守卫本身有效）', () => {
    expect(ALL.length).toBeGreaterThan(5);
  });

  it.each(ALL.filter((f) => f.hasScoped && f.cssImports.length > 0).map((f) => [f.file, f.cssImports]))(
    '%s 不在 <style scoped> 组件里 import CSS',
    (_file, imports) => {
      expect(
        imports,
        `把这些全局样式表改到 main.ts 引入：在 scoped 组件里 import 会让 plugin-vue `
        + `把选择器做笛卡尔积（曾产出 8.2 MB / 36,608 条永不匹配的规则，`
        + `连带 .game-shell{display:grid} 失效、桌面布局塌成竖排）:\n  ${imports.join('\n  ')}`,
      ).toEqual([]);
    },
  );

  it.each(ALL.filter((f) => f.hasScoped && f.styleCssImports.length > 0).map((f) => [f.file, f.styleCssImports]))(
    '%s 不在 <style scoped> 里用 @import 引CSS',
    (_file, imports) => {
      expect(imports).toEqual([]);
    },
  );
});

describe('全局样式表都在 main.ts 里按顺序引入', () => {
  const mainTs = readFileSync(join(srcRoot, 'main.ts'), 'utf8');
  const imported = [...mainTs.matchAll(/import\s+['"](\.\/[^'"]+\.css)['"]/g)].map((m) => m[1]);

  it('main.ts 引入了 style.css / darkMode.css / gameTheme.css', () => {
    expect(imported).toContain('./style.css');
    expect(imported).toContain('./ui/darkMode.css');
    expect(imported).toContain('./ui/gameTheme.css');
  });

  it('没有任何 CSS 只在组件里 import 而没进 main.ts', () => {
    const inComponents: { file: string; css: string }[] = ALL.flatMap(
      (f) => f.cssImports.map((c) => ({ file: f.file, css: c })),
    );
    // All three are global by design; anything else imported from a .vue is suspect.
    const allowed = new Set(['./style.css', './ui/darkMode.css', './ui/gameTheme.css']);
    const strays = inComponents.filter((i) => !allowed.has(i.css));
    expect(strays, JSON.stringify(strays)).toEqual([]);
  });
});

/**
 * The laptop-landscape branch must not hand half the window to the sidebar.
 *
 * Measured in the user's browser at a 974px viewport (a normal laptop window, which lands
 * in `@media (max-width: 1024px) and (orientation: landscape)`):
 *   getComputedStyle(.game-shell).gridTemplateColumns = "486.8px 486.8px"
 * The board is the main event; an even split squeezed it to 487px while the sidebar — whose
 * content is at most ~320px wide — got the same 487px and left a large gap below itself.
 */
describe('笔记本横屏（≤1024px）的两列比例', () => {
  const view = readFileSync(join(srcRoot, 'views', 'GameView.vue'), 'utf8');
  const clean = view.replace(/\/\*[\s\S]*?\*\//g, '');

  /** Body of the `@media (max-width:1024px) and (orientation:landscape)` block. */
  const landscapeBlock = (() => {
    const at = clean.indexOf('@media (max-width: 1024px) and (orientation: landscape) {');
    if (at < 0) throw new Error('landscape branch not found');
    // The branch is flat, so the next top-level `}` closes it.
    const end = clean.indexOf('\n}', at);
    return clean.slice(at, end < 0 ? undefined : end);
  })();

  it('侧栏不是等分，而是 clamp 上限封顶的窄列', () => {
    const cols = /grid-template-columns:\s*([^;]+);/.exec(landscapeBlock);
    expect(cols).not.toBeNull();
    expect(cols![1]).not.toMatch(/minmax\(0,\s*1fr\)\s*minmax\([^,]+,\s*1fr\)/);
    // Must stay bounded: the sidebar never grows with the window.
    expect(cols![1]).toMatch(/clamp\(/);
  });

  it('横屏分支恢复左右留白（竖屏为刘海清零的 padding 不该被照抄）', () => {
    const shell = /\.game-shell\s*\{([^}]*)\}/.exec(landscapeBlock);
    expect(shell).not.toBeNull();
    expect(shell![1]).toMatch(/padding:\s*(?!env\()/);
    expect(shell![1]).not.toMatch(/padding:\s*env\([^)]*\)\s*0\s+0/);
  });

  it('底部操作坞紧跟内容，不再被 margin-top:auto 推到最底', () => {
    // Strip comments first: the rule that replaced `margin-top: auto` explains itself in a
    // comment, and a naive regex reads that prose as the declaration it just removed.
    const decls = view.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(decls).not.toMatch(/\.mobile-dock-bar\s*\{[^}]*margin-top:\s*auto/);
    expect(decls).toMatch(/\.mobile-dock-bar\s*\{[^}]*margin-top:\s*4px/);
  });
});