import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import ConnectionBanner from './ConnectionBanner.vue';

function render(status: 'connected' | 'connecting' | 'reconnecting' | 'failed'): Promise<string> {
  return renderToString(createSSRApp({
    render: () => h(ConnectionBanner as never, { status, onRetry: () => {}, onExit: () => {} } as never),
  }));
}

describe('ConnectionBanner（体验 E4）', () => {
  it('stays out of the way while everything is fine', async () => {
    // v-if 为真时才渲染时 Vue 的 SSR 注释占位是 `<!---->`（不是 `<!--v-if-->`）。
    expect(await render('connected')).toBe('<!---->');
    expect(await render('connecting')).toBe('<!---->');
  });

  it('shows a passive progress note while the client is retrying on its own', async () => {
    const html = await render('reconnecting');

    expect(html).toContain('正在重新连接');
    expect(html).toContain('稍等一下');
    // 重连窗口里**不给按钮**：让玩家在自动重试期间反复点，只会把重连越点越糟。
    expect(html).not.toContain('重新连接</button>');
  });

  it('offers two exits once the connection is really dead', async () => {
    const html = await render('failed');

    expect(html).toContain('连接已断开');
    expect(html).toContain('重新连接');
    expect(html).toContain('返回首页');

    const buttons = html.match(/<button[^>]*class="connection-(primary|secondary)"[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button).toContain('type="button"');
    }
  });

  it('tells the player the game is still recoverable (the old copy never said so)', async () => {
    const html = await render('failed');
    expect(html).toContain('继续刚才那局');
    expect(html).toContain('存档');
  });
});
