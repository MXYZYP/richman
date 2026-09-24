import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import ReleaseNotesDialog from './ReleaseNotesDialog.vue';
import releaseNotes from '../../../../release-notes.json';

async function renderDialog(): Promise<string> {
  return renderToString(createSSRApp({
    render: () => h(ReleaseNotesDialog),
  }));
}

describe('ReleaseNotesDialog', () => {
  it('renders the current player version and every historical release', async () => {
    const html = await renderDialog();

    expect(html).toContain('aria-labelledby="release-notes-title"');
    expect(html).toContain(`当前版本 v${releaseNotes.releases[0].version}`);
    expect(html).toContain('role="region" aria-label="更新说明列表" tabindex="0"');
    for (const release of releaseNotes.releases) {
      expect(html).toContain(`v${release.version}`);
      expect(html).toContain(release.title);
      for (const change of release.changes) expect(html).toContain(change);
    }
  });

  it('provides an explicit close control', async () => {
    const html = await renderDialog();
    expect(html).toContain('aria-label="关闭更新说明"');
    expect(html).toContain('关闭');
  });

  it('defer 时只渲染入口，正文等玩家点开再出', async () => {
    const html = await renderToString(createSSRApp({
      render: () => h(ReleaseNotesDialog as never, { defer: true } as never),
    }));

    expect(html).toContain('更新说明');
    expect(html).toContain(`v${releaseNotes.releases[0].version}`);
    expect(html).toContain('aria-labelledby="release-notes-title"');
    expect(html).not.toContain('role="region" aria-label="更新说明列表"');
    for (const release of releaseNotes.releases) {
      for (const change of release.changes) expect(html).not.toContain(change);
    }
  });
});
