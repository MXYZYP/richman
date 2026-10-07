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

  /**
   * 回归：更新说明文案会被渲染进 HTML，而 Vue 的 renderToString 会把
   * `& < > " '` 转义成实体。一旦某条 change 里出现这些字符，
   * 上面那个 `html.toContain(change)` 就会失配 —— 而且现象很奇怪：
   * 渲染出的页面完全正常，只有测试红。
   *
   * 之前就踩过一次：把「矮屏（不足 620px）」写成「矮屏（<620px）」，
   * `toContain` 当场失配。写成显式断言，任何人再写进去都会立刻看到原因。
   */
  it('keeps every change string free of HTML-sensitive characters', () => {
    const offenders: string[] = [];
    for (const release of releaseNotes.releases) {
      for (const change of release.changes) {
        // 这些字符会被 renderToString 转义成实体，原文就匹配不上了。
        if (/[<>&"']/.test(change)) offenders.push(`${release.version}: ${change}`);
      }
    }
    expect(
      offenders,
      `更新说明文案不要包含 < > & " ' —— 它们会被 HTML 转义：\n${offenders.join('\n')}`,
    ).toEqual([]);
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
