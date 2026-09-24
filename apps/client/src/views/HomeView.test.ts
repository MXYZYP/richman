import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { getActiveMapPack } from '@richman/board-data';
import type { PublicRoomSummary } from '@richman/protocol';
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
describe('HomeView 玩法说明入口（#109）', () => {
  it('标题下方就给出入口，不必滚到页脚才找得到', async () => {
    const html = await renderHome();

    expect(html).toContain('class="home-guide"');
    expect(html).toContain('看玩法说明');
    // 首次进站会自动弹一次；这个按钮是「没看到那次弹窗」或「想重看」的兜底，
    // 所以位置在标题文案之后、创建/加入表单之前。
    expect(html.indexOf('class="home-guide"')).toBeGreaterThan(html.indexOf('class="home-copy"'));
    expect(html.indexOf('class="home-guide"')).toBeLessThan(html.indexOf('class="home-form"'));
  });
});

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

/**
 * 公开房间列表与「一键旁观」（路线图 #108）。
 *
 * 列表是一条**只读投影**：能不能加入 / 能不能旁观由服务端算好的
 * `joinable` / `spectatable` 决定，客户端只负责把这两个布尔如实画成按钮状态。
 * 所以这里断言的重点是「服务端说不行的，按钮必须真的是灰的」——
 * 灰按钮比点下去才报错的按钮好得多，也比偷偷把按钮藏起来好（用户会以为是空的）。
 */
describe('HomeView public room list', () => {
  const chinaMapPack = getActiveMapPack('china-tour');

  const joinableRoom: PublicRoomSummary = {
    roomCode: '000007',
    hostNickname: '房主甲',
    mapTitle: chinaMapPack.metadata.title,
    status: 'lobby',
    playerCount: 2,
    spectatorCount: 0,
    playerLimit: 6,
    spectatorLimit: 3,
    joinable: true,
    spectatable: true,
    turnTimeLimitSec: 60,
    botDifficulty: 'normal',
  };

  async function renderWithProps(props: Record<string, unknown>): Promise<string> {
    return renderToString(createSSRApp({ render: () => h(HomeView, props) }));
  }

  it('lists a discoverable room with its code, status, seats and the join / spectate actions', async () => {
    const html = await renderWithProps({ publicRooms: [joinableRoom] });

    expect(html).toContain('公开房间');
    expect(html).toContain('000007');
    expect(html).toContain('大厅等待中');
    expect(html).toContain(chinaMapPack.metadata.title);
    expect(html).toContain('2/6 人');
    // 限时（#107）顺手标在列表上：不限时的房间不该显示这一截。
    expect(html).toContain('每步 60 秒');
    expect(html).toContain('加入');
    expect(html).toContain('旁观');
  });

  it('greys out the seats the server already ruled out instead of hiding the room', async () => {
    const html = await renderWithProps({
      publicRooms: [
        { ...joinableRoom, status: 'playing', spectatorCount: 3, joinable: false, spectatable: false },
      ],
    });

    expect(html).toContain('对局进行中');
    expect(html).toContain('这局已经开局或人数已满，只能旁观');
    expect(html).toContain('观战位已满');
    expect(html).toContain('2/6 人 · 观战 3');
  });

  it('shows the refresh failure rather than pretending the list is empty', async () => {
    const html = await renderWithProps({ publicRooms: [], roomListError: '房间列表加载失败，请重试' });

    expect(html).toContain('房间列表加载失败，请重试');
    // 空态文案是给「确实没人公开」用的；加载失败时说出来会让玩家以为房间里真的没人。
    expect(html).not.toContain('现在没有公开的房间');
  });

  it('falls back to an empty-state hint when nothing is published', async () => {
    const html = await renderWithProps({ publicRooms: [] });

    expect(html).toContain('现在没有公开的房间');
    // 空态也要把「房间码仍可用」说清楚，否则玩家会以为只能从列表进房。
    expect(html).toContain('输入房间码可以直接加入好友的房');
  });
});
