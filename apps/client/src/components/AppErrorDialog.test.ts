import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import AppErrorDialog from './AppErrorDialog.vue';

function renderCard(error: { source: 'vue'; message: string } | null): Promise<string> {
  return renderToString(createSSRApp({
    render: () => h(AppErrorDialog as never, { error, onDismiss: () => {}, onReload: () => {} } as never),
  }));
}

describe('AppErrorDialog（体验 E3）', () => {
  it('opens the shared modal shell only when there is an error', async () => {
    const open = await renderCard({ source: 'vue', message: 'render failed' });
    expect(open).toContain('data-variant="modal"');
    expect(open).toContain('出了点问题');

    const closed = await renderCard(null);
    expect(closed).not.toMatch(/<dialog[^>]*\sopen/);
  });

  it('gives two exits: reload (the real fix) and keep going', async () => {
    const html = await renderCard({ source: 'vue', message: 'render failed' });

    expect(html).toContain('重新加载');
    expect(html).toContain('继续使用');

    const buttons = html.match(/<button[^>]*class="error-(primary|secondary)"[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button).toContain('type="button"');
    }
  });

  it('shows the message so a player can quote it back', async () => {
    const html = await renderCard({ source: 'vue', message: 'Cannot read properties of undefined' });
    expect(html).toContain('Cannot read properties of undefined');
  });
});
