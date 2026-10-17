import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import type { CellDetail } from '../game/clientGame';
import CellDetailPanel from './CellDetailPanel.vue';

const detail: CellDetail = {
  cellId: 2,
  name: '福建省',
  typeLabel: '普通地产',
  description: '可购买、收租、盖房或旅馆的地产。',
  currentRent: {
    amount: 3000,
    note: '按当前 2 级房屋收费。',
  },
  price: 2400,
  ownerName: '玩家甲',
  levelLabel: '2 级房屋',
  mortgagedLabel: '未抵押',
  mortgageValue: 1200,
  rentRows: [
    { label: '裸地', amount: 200 },
    { label: '2 级房屋', amount: 3000 },
  ],
  houseCost: 1500,
  notes: [],
};

async function renderDialog(): Promise<string> {
  const app = createSSRApp({
    render: () => h(CellDetailPanel, { detail }),
  });
  const context: NonNullable<Parameters<typeof renderToString>[1]> = {};
  await renderToString(app, context);
  return context.teleports?.body ?? '';
}

describe('CellDetailPanel dialog', () => {
  it('teleports a modal dialog and places the current rent before the full rent table', async () => {
    const html = await renderDialog();

    expect(html).toContain('<dialog');
    expect(html).toContain('当前过路费');
    expect(html).toContain('¥3,000');
    expect(html.indexOf('当前过路费')).toBeLessThan(html.indexOf('租金表'));
  });

  // 11-17：外壳改由 MobileSheet 提供 —— 它才是弹窗尺寸/圆角/标题的唯一事实源。
  // 这里钉住「格子详情确实走的是那套 modal 壳」，而不是又长出一个自持 <dialog>。
  it('外壳是 MobileSheet 的 modal 变体：格子名当标题、类型当标题右侧状态字', async () => {
    const html = await renderDialog();

    expect(html).toContain('data-variant="modal"');
    expect(html).toContain('mobile-sheet-head');
    expect(html).toContain('mobile-sheet-close');
    expect(html).toContain('>福建省<');
    expect(html).toContain('普通地产');
    // 自己那套 540px / 圆角 14px / 「×」关闭 的痕迹必须彻底消失。
    expect(html).not.toContain('cell-dialog-layer');
    expect(html).not.toContain('>×<');
  });
});
