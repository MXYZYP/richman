import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const assetPanelSource = readFileSync(new URL('../components/AssetPanel.vue', import.meta.url), 'utf8');

describe('debt pill layout', () => {
  it('centers the label and keeps the full amount together when the pill wraps', () => {
    expect(assetPanelSource).toContain('<span class="debt-label">欠款</span>');
    expect(assetPanelSource).toContain('<span class="debt-amount">¥{{ formatMoney(debtAmount) }}</span>');

    expect(assetPanelSource).toMatch(/\.debt-pill\s*{[^}]*display:\s*inline-flex;/s);
    expect(assetPanelSource).toMatch(/\.debt-pill\s*{[^}]*flex-wrap:\s*wrap;/s);
    expect(assetPanelSource).toMatch(/\.debt-pill\s*{[^}]*justify-content:\s*center;/s);
    expect(assetPanelSource).toMatch(/\.debt-pill\s*{[^}]*align-items:\s*center;/s);
    expect(assetPanelSource).toMatch(/\.debt-pill\s*{[^}]*align-content:\s*center;/s);
    expect(assetPanelSource).toMatch(/\.debt-pill\s*{[^}]*text-align:\s*center;/s);
    expect(assetPanelSource).toMatch(/\.debt-pill\s*{[^}]*max-width:\s*min\(100%,\s*8em\);/s);
    expect(assetPanelSource).toMatch(/\.debt-amount\s*{[^}]*white-space:\s*nowrap;/s);
  });
});
