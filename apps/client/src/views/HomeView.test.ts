import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import releaseNotes from '../../../../release-notes.json';
import HomeView from './HomeView.vue';

async function renderHome(): Promise<string> {
  return renderToString(createSSRApp({
    render: () => h(HomeView),
  }));
}

describe('HomeView release notes entry', () => {
  it('shows the current player version and an update-history button', async () => {
    const html = await renderHome();

    const entry = `v${releaseNotes.releases[0].version} · 更新说明`;
    expect(html.split(entry)).toHaveLength(2);
    expect(html).toContain('class="home-version"');
  });
});

describe('HomeView join role', () => {
  it('shows an explicit spectator join choice without auto-submitting', async () => {
    const html = await renderHome();
    expect(html).toContain('aria-label="加入身份"');
    expect(html).toContain('参赛');
    expect(html).toContain('观战');
    expect(html).toContain('加入房间');
    expect(html).toContain('输入好友分享的 4 位房间码');
  });
});
