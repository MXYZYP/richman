// 守卫：局内四个浮层（我的资产 / 玩家资产 / 结算 / 格子详情）必须是同一套长相。
//
// 用户原话（11-17）：「局内所有弹窗（资产、结算、格详情）的文案与视觉风格保持一致」
//           「修正玩法说明、成就等可滚动弹窗的圆角问题…左右圆角不一致」。
//
// 改造前的四张脸：
//   我的资产    MobileSheet 抽屉（宽 560 / 顶角 18px / 标题居中 + 「关闭」）
//   玩家资产    自持 <dialog>（宽 720 / 圆角 14px / 标题 1.25–1.55rem 左对齐 / 「×」/ 遮罩多一层 blur）
//   格子详情    自持 <dialog>（宽 540 / 圆角 14px / 标题 1.24rem 左对齐 / 「×」/ 遮罩多一层 blur）
//   结算        div 遮罩（宽 520 / 圆角 14px / 标题 1.4–1.7rem 居中 + 56px 旗帜头图 / 无关闭控件）
// 同一个对局里点三个地方，三套尺寸、三套标题对齐、两种关闭符号 —— 这就是「不一致」。
//
// 现在的契约：
//   1. 浮层的**壳**只能有一个来源：MobileSheet 的 modal 变体（宽高、圆角、标题、关闭都在那儿写一次）。
//      结算因「必须压在离开房间的二次确认之下」保留自己的 div 遮罩，但壳里每一项数值都与之一致。
//   2. 圆角一律 `var(--radius-dialog)`；谁再写 `border-radius: 14px` 就会在这里变红。
//   3. 术语统一「地产」（不再一处「房产」一处「地产」）。
//
// 本项目没有组件挂载环境，这条契约靠读源码钉住 —— 它是接线，不是渲染验证。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..');

const read = (rel: string) => readFileSync(resolve(srcRoot, rel), 'utf8')
  // 注释里引用旧值会被自己的检测先读到（本项目踩过）⇒ 先剥注释。
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

const SHEET_BACKED = ['components/CellDetailPanel.vue', 'components/PlayerAssetDialog.vue'];
const ALL_DIALOGS = [...SHEET_BACKED, 'components/SettlementDialog.vue', 'components/AssetPanel.vue'];

describe('局内浮层：一套壳、一个圆角、一套叫法', () => {
  it.each(SHEET_BACKED)('%s 的外壳交给 MobileSheet 的 modal 变体', (rel) => {
    const text = read(rel);
    expect(text).toContain("import MobileSheet from './MobileSheet.vue';");
    expect(text).toContain('layout="modal"');
    // 不许再自己开一层 <dialog> / 画一层遮罩：两套壳就是两套尺寸。
    expect(text).not.toContain('<dialog');
    expect(text).not.toContain('::backdrop');
    // 也不许自己拍宽度 / 最大高度（数值只能出现在 MobileSheet 的 modal 规则里）。
    expect(text).not.toMatch(/width:\s*min\(\d+px/);
    expect(text).not.toMatch(/max-height:\s*min\(/);
  });

  it('结算弹窗保留自己的遮罩（层级契约），但壳的规格与 MobileSheet 一致', () => {
    const text = read('components/SettlementDialog.vue');

    // 层级：这层遮罩必须压在离开房间的二次确认之下，所以它不能进 native dialog 的 top layer。
    expect(text).toMatch(/\.settlement-backdrop\s*\{[\s\S]*?z-index:\s*\d+;/);

    // 规格：圆角走全局档位、标题走弹窗标题档、滚动区由父级裁进圆角。
    expect(text).toMatch(/\.settlement-dialog\s*\{[\s\S]*?border-radius:\s*var\(--radius-dialog\)/);
    expect(text).toMatch(/\.settlement-dialog\s*\{[\s\S]*?overflow:\s*hidden;/);
    expect(text).toMatch(/\.settlement-head h2\s*\{[\s\S]*?font-size:\s*var\(--text-sheet-title\)/);
    expect(text).toMatch(/\.settlement-body\s*\{[\s\S]*?overflow-y:\s*auto;/);

    // 头部的关闭控件与 MobileSheet 同文案（「关闭」而不是「×」）。
    expect(text).toMatch(/class="settlement-close"[\s\S]{0,200}>关闭</);

    // 旧版那颗 56px 的旗帜头图 + clamp 标题已经退场。
    expect(text).not.toContain('settlement-mark');
    expect(text).not.toContain('clamp(1.4rem');
    expect(text).not.toContain('border-radius: 14px');
  });

  it('圆角只认 --radius-dialog，四个浮层里没有 14px 的自持圆角', () => {
    for (const rel of ALL_DIALOGS) {
      expect(read(rel), rel).not.toContain('border-radius: 14px');
    }
    // 全局档位本身必须是 16px —— 改这里等于改所有弹窗，得先过这一关。
    const css = read('style.css');
    expect(css).toMatch(/--radius-dialog:\s*16px;/);
  });

  it('术语统一成「地产」：不再出现「房产」', () => {
    for (const rel of ALL_DIALOGS) {
      expect(read(rel), rel).not.toContain('房产');
    }
  });
});

// 用户原话（11-17）：「右下角四个按键分开吧，每个是单独的按钮。」
// 改造前：四颗入口被一整条白底 + 上圆角的长条框在一起（.mobile-dock-bar 自带 border/background），
// 四颗按钮本身 border/background 全 transparent —— 看着是一条工具栏，不像四个按钮。
describe('底部操作坞：四颗入口各自是一张卡', () => {
  const GAME = read('views/GameView.vue');

  it('长条只负责定位，不许再有底色 / 描边 / 圆角', () => {
    // 取带 grid-template-columns 的那条规则（文件里 .mobile-dock-bar 还出现在 display:none 与 margin-top 两处）。
    const bar = /\.mobile-dock-bar\s*\{([^}]*grid-template-columns[^}]*)\}/.exec(GAME);
    if (bar === null) throw new Error('GameView 应当有一条把操作坞排成 4 列的规则');
    expect(bar[1]).toContain('background: transparent');
    expect(bar[1]).toContain('border: 0');
    expect(bar[1]).not.toContain('border-radius');
  });

  it('每颗按钮自带描边 / 底色 / 圆角 / 底边', () => {
    const entry = /\.dock-entry\s*\{([^}]*)\}/.exec(GAME);
    if (entry === null) throw new Error('GameView 应当有 .dock-entry 规则');
    expect(entry[1]).toContain('border: 1px solid var(--color-border)');
    expect(entry[1]).toContain('background: var(--game-panel)');
    expect(entry[1]).toContain('border-radius: var(--game-radius-panel');
    expect(entry[1]).toContain('box-shadow: 0 2px 0');
  });
});
