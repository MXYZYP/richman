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
    expect(html).toContain('cell-dialog-layer');
    expect(html).toContain('当前过路费');
    expect(html).toContain('¥3,000');
    expect(html.indexOf('当前过路费')).toBeLessThan(html.indexOf('租金表'));
  });
});
