// 守卫：弹窗与首页四个图标详情页的正文，只允许用 style.css 里那几档命名字号。
//
// 用户原话（10-16 第五版）：「弹窗样式大小统一，字体大小统一。」
// 第四版只把**尺寸**统一了（都走 MobileSheet 的 modal 规则），字号还是散的：
// 同一个「小标题」在更新说明里 17px、在设置面板里 14px、在战绩页里 15px；
// 「当前版本」徽标 10px、「版本号」14px、正文 12/13/14px 混着来。
// 一眼看过去不是一套东西 —— 这就是这一版要收的那一半。
//
// 允许的取值（只有这四类）：
//   1. var(--text-*)   —— style.css 里的命名档位，**首选**。新增弹窗请用它。
//   2. inherit         —— 让外壳决定，不算自己拍一个数。
//   3. 1rem            —— 弹窗主按钮（与 .entry-primary 同一档）。
//   4. 11 / 12 / 13 / 14px 四个字面值 —— 徽标 / 元信息 / 正文 / 小标题。
// 任何其它值（15px、17px、22px、clamp(24px,5vw,34px)…）都说明有人又自己拍了一个数。
//
// 本项目没有组件挂载测试环境，所以这条契约靠读源码钉住 —— 它是接线，不是渲染验证。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..');

/** 所有走 MobileSheet modal 的弹窗 + 四个图标详情页。局内弹窗（资产 / 结算 / 格详情）不在此列。 */
const GUARDED = [
  'components/MobileSheet.vue',
  'components/FirstRunGuide.vue',
  'components/ReplayDialog.vue',
  'components/MapWorkshopDialog.vue',
  'components/SettingsDialog.vue',
  'components/ReleaseNotesDialog.vue',
  // 隐私合规（TapTap 上架）新增的两层：首启同意门 + 政策正文。
  'components/PrivacyConsentGate.vue',
  'components/PrivacyPolicyDialog.vue',
  'views/StatsView.vue',
  'views/AchievementsView.vue',
  'views/CloudSyncView.vue',
  'views/LeaderboardView.vue',
];

const LITERAL_PX = new Set(['11px', '12px', '13px', '14px']);
const ALLOWED_EXACT = new Set(['inherit', '1rem']);

function isAllowed(value: string): boolean {
  const v = value.trim();
  if (ALLOWED_EXACT.has(v)) return true;
  if (/^var\(--text-[a-z0-9-]+\)$/.test(v)) return true;
  return LITERAL_PX.has(v);
}

/** 注释里引用旧值会被自己的检测先读到（本项目踩过）⇒ 先剥注释。 */
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');

function fontSizesOf(rel: string): string[] {
  const text = stripComments(readFileSync(resolve(srcRoot, rel), 'utf8'));
  return [...text.matchAll(/font-size:\s*([^;{}]+);/g)].map((m) => m[1].trim());
}

describe('弹窗 / 详情页的字号只走命名档位', () => {
  it('扫描本身有效（每个受管文件都能读到，且至少读出几处字号）', () => {
    for (const rel of GUARDED) {
      expect(fontSizesOf(rel).length, rel).toBeGreaterThan(0);
    }
  });

  it.each(GUARDED)('%s 没有越阶的字号', (rel) => {
    const offenders = fontSizesOf(rel).filter((v) => !isAllowed(v));
    expect(
      offenders,
      `请改用 var(--text-sheet-title | section-size | body-size | meta-size | badge-size)，`
      + `或 {11,12,13,14}px 这四档：\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});

describe('弹窗标题与二级页标题同号', () => {
  it('MobileSheet 的标题用 --text-sheet-title', () => {
    const sheet = stripComments(readFileSync(resolve(srcRoot, 'components', 'MobileSheet.vue'), 'utf8'));
    const title = /\.mobile-sheet-head h2\s*\{([^}]*)\}/.exec(sheet);
    if (title === null) throw new Error('MobileSheet 应当有 .mobile-sheet-head h2 规则');
    expect(title[1]).toContain('font-size: var(--text-sheet-title)');
  });

  it('ViewShell（在线 / 单机两个二级页的壳）用同一个变量', () => {
    const shell = stripComments(readFileSync(resolve(srcRoot, 'views', 'ViewShell.vue'), 'utf8'));
    const title = /\.view-bar__title\s*\{([^}]*)\}/.exec(shell);
    if (title === null) throw new Error('ViewShell 应当有 .view-bar__title 规则');
    expect(title[1]).toContain('font-size: var(--text-sheet-title)');
  });

  it('style.css 里这几档确实存在（不然上面全都在引用空气）', () => {
    const css = readFileSync(resolve(srcRoot, 'style.css'), 'utf8');
    for (const name of [
      '--text-sheet-title',
      '--text-section-size',
      '--text-body-size',
      '--text-meta-size',
      '--text-badge-size',
    ]) {
      expect(css, `${name} 应当在 style.css 里定义`).toMatch(new RegExp(`${name}:`));
    }
  });
});
