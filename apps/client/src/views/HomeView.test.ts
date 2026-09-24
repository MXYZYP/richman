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
    expect(html).toContain('class="release-notes-trigger"');
  });
});

describe('HomeView join role', () => {
  it('shows an explicit spectator join choice without auto-submitting', async () => {
    const html = await renderHome();
    expect(html).toContain('aria-label="加入身份"');
    expect(html).toContain('参赛');
    expect(html).toContain('观战');
    expect(html).toContain('加入房间');
    expect(html).toContain('输入好友分享的 6 位房间码');
  });
});

/**
 * 战绩码入口（路线图 #102）。SSR 下没有 localStorage，战绩区块整体隐藏——
 * 所以两个方向都要测：有存储时入口必须出现，没有存储时不该留半截 UI。
 */
describe('HomeView stats transfer', () => {
  async function withLocalStorage<T>(run: () => Promise<T>): Promise<T> {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
      },
    });
    try {
      return await run();
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
      else Object.defineProperty(globalThis, 'localStorage', previous);
    }
  }

  it('有本地存储时给出导出 / 导入战绩码的入口与说明', async () => {
    const html = await withLocalStorage(() => renderHome());

    expect(html).toContain('我的战绩');
    expect(html).toContain('导出战绩码');
    expect(html).toContain('导入战绩码');
    // 说明必须点明「不需要账号密码」与「导入是合并」，否则玩家不敢用。
    expect(html).toContain('不需要账号密码');
    expect(html).toContain('导入是合并');
  });

  it('浏览器不给本地存储时，整个战绩区块连同战绩码入口一起隐藏', async () => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    const html = await renderHome();

    expect(html).not.toContain('我的战绩');
    expect(html).not.toContain('导出战绩码');
  });
});
