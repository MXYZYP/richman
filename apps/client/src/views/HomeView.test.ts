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

/**
 * 复盘导入入口（#115）与地图工坊入口（#117）。别人把复盘码发过来时，玩家大概率**不在对局里**——
 * 如果首页没有入口，他只能先随便开一局才能找到粘贴的地方，那这条链路等于断了。
 * 工坊是同一个道理：图是玩家在地图编辑器里画好的，不该逼他先开一局才能把图装进来。
 */
describe('HomeView 复盘导入入口（#115）', () => {
  it('首页就给出「导入回看」，与玩法说明并列在标题下方', async () => {
    const html = await renderHome();

    expect(html).toContain('收到复盘码？导入回看');
    expect(html).toContain('class="home-entry-row"');
    // 与玩法说明同一行、同一层级，都在表单之前。
    expect(html.indexOf('class="home-entry-row"')).toBeGreaterThan(html.indexOf('class="home-copy"'));
    expect(html.indexOf('class="home-entry-row"')).toBeLessThan(html.indexOf('class="home-form"'));
    // 说明 / 复盘 / 工坊三条入口都在这一行里。
    const row = html.slice(html.indexOf('class="home-entry-row"'), html.indexOf('class="home-form"'));
    expect(row.match(/class="home-guide"/g)?.length).toBe(3);
  });

  it('地图工坊入口（#117）与另两条入口同级，且说清这是「自己画了图」的场景', async () => {
    const html = await renderHome();
    const row = html.slice(html.indexOf('class="home-entry-row"'), html.indexOf('class="home-form"'));

    expect(row).toContain('自己画了图？地图工坊');
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
 * 战绩上云 / 恢复码账号（路线图 #123，第五批-3）。
 *
 * 认这块 UI 一律用**结构标记**（class / placeholder），不用中文文案 —— 理由与下面排行榜那条相同：
 * 首页会内联渲染整份更新说明，而更新说明正文本来就会写到「云同步」「恢复码」。
 * 拿文案当标记，区块真被删掉时「该出现」那条照样绿，两条方向相反的断言会同时失去判别力。
 */
describe('HomeView 云同步（#123）', () => {
  async function withStorage<T>(run: () => Promise<T>): Promise<T> {
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

  it('给出恢复码账号的入口，并把「恢复码长什么样」写在输入框上', async () => {
    const html = await withStorage(() => renderHome());

    expect(html).toContain('class="cloud-sync"');
    expect(html).toContain('class="cloud-sync-title"');
    // placeholder 是玩家唯一能看到「恢复码格式」的地方：没有它，手抄来的码该不该带横线只能靠猜，
    // 而猜错的代价是一次必然失败的往返。
    expect(html).toContain('placeholder="RM-XXXX-XXXX-XXXX-XXXX-XXXX"');
    expect(html).toContain('class="cloud-sync-input"');
    // 未绑定时不该出现「换一段恢复码」「退出云同步」——它们只对已绑定的账号有意义。
    expect(html).not.toContain('cloud-sync-button-ghost');
  });

  it('落在战绩 section 内部（跟着战绩一起出现 / 一起隐藏），未绑定时不渲染空的恢复码元素', async () => {
    const html = await withStorage(() => renderHome());
    const section = html.slice(
      html.indexOf('class="player-stats"'),
      html.indexOf('class="leaderboard"'),
    );

    // 必须落在战绩 section **内部**：没有本地存储时整段会隐藏，云同步要是漏在外面，
    // 就变成「本机没有战绩可同步，却还在劝你绑定云端账号」。
    expect(section).toContain('class="cloud-sync"');
    expect(section).toContain('class="stats-transfer"');
    expect(section.indexOf('class="cloud-sync"')).toBeGreaterThan(section.indexOf('class="stats-transfer"'));
    // `cloudNewCode` 初值是空串：恢复码展示区与提示条必须整段不渲染，
    // 否则页面上会挂一个空的 <code> 和一个空的提示条。
    expect(html).not.toContain('class="cloud-sync-code"');
    expect(html).not.toContain('class="cloud-sync-notice"');
  });

  it('把隐私取舍与保留期写在伸手可及的地方', async () => {
    const html = await withStorage(() => renderHome());

    // 这两句是玩家敢不敢按下去的根据：不自动联网、以及云端到底会留多久。
    expect(html).toContain('只有你按下按钮时才会发请求');
    expect(html).toContain('云端的账号一年没有同步过会被清理');
  });

  it('浏览器不给本地存储时随战绩区块一起隐藏，不留半截 UI', async () => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    const html = await renderHome();

    expect(html).not.toContain('class="cloud-sync"');
    expect(html).not.toContain('placeholder="RM-XXXX-XXXX-XXXX-XXXX-XXXX"');
  });
});

/**
 * 成就与成就排行榜（路线图 #116）。
 *
 * 两者是同一份战绩的两种读法：成就**只在本机算**，排行榜才把四个聚合数字发出去。
 * 因为这样，界面必须自己把隐私取舍讲清楚——「点一下才上传」这句话要是消失了，
 * 这个功能就从「顺手的加分项」变成了「偷偷上传玩家数据」。所以下面专门盯这句文案。
 */
describe('HomeView 成就与排行榜（#116）', () => {
  const STATS_KEY = 'richman_player_stats_v1';

  function statsJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      schemaVersion: 1,
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      bestAsset: 0,
      favoriteMaps: {},
      lastPlayedAt: 0,
      ...overrides,
    });
  }

  async function withStats<T>(raw: string | null, run: () => Promise<T>): Promise<T> {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const values = new Map<string, string>();
    if (raw !== null) values.set(STATS_KEY, raw);
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

  it('成就按分组铺开，一项都没达成时全是「未解锁」并给出下一个目标', async () => {
    const html = await withStats(statsJson(), () => renderHome());

    expect(html).toContain('成就 0 / ');
    expect(html).toContain('class="achievements"');
    // 三个分组都在（界面按组渲染，缺一组就会让人以为那类成就不存在）。
    expect(html).toContain('里程碑');
    expect(html).toContain('财富');
    expect(html).toContain('地图');
    expect(html).toContain('未解锁');
    expect(html).not.toContain('achievement-unlocked');
    // 空战绩时下一个目标必然是「开局」。
    expect(html).toContain('下一个：开局');
  });

  it('成就收成下拉块：默认收起，明细仍然留在 DOM 里', async () => {
    const html = await withStats(statsJson(), () => renderHome());

    // 认「是不是下拉块」一律用**结构标记**：`<details>` + `<summary>`。
    // 不整段匹配 `<details class="achievements">`：scoped 样式会给元素额外挂 `data-v-*`。
    expect(html).toMatch(/<details[^>]*class="achievements"/);
    expect(html).toMatch(/<summary[^>]*class="achievements-summary"/);
    // 默认收起 —— 没有 open 属性，所以收起时只占 summary 那一行，不占主屏。
    expect(html).not.toMatch(/<details[^>]*class="achievements"[^>]*\sopen/);
    // 收起只是视觉收起：三组明细与「下一个目标」必须仍在 DOM 里，否则展开会是空的。
    expect(html).toContain('achievement-group-label');
    expect(html).toContain('下一个：开局');
  });

  it('战绩上来之后解锁项真的点亮（不是永远停在未解锁）', async () => {
    const html = await withStats(
      statsJson({
        gamesPlayed: 50,
        wins: 20,
        losses: 30,
        bestAsset: 150_000,
        favoriteMaps: { 'china-tour': 3, 'world-tour': 1, 'silk-road': 1, 'great-wall': 1, 'yellow-river': 1 },
      }),
      () => renderHome(),
    );

    expect(html).toContain('achievement-unlocked');
    expect(html).toContain('已解锁');
    expect(html).not.toContain('成就 0 / ');
    expect(html).toContain('五胜');
    expect(html).toContain('富甲一方');
  });

  it('排行榜区块说清「点了才上传、只传四个数字」，且不自动取数时不假装已有榜单', async () => {
    const html = await withStats(statsJson(), () => renderHome());

    // 认这块 UI 一律用**结构标记**（id / class），不要用「成就排行榜」这类中文文案：
    // 首页同时内联渲染了整份更新说明（ReleaseNotesDialog，非 defer），而更新说明正文里
    // 本来就会写到「成就排行榜」。拿文案当标记，两条方向相反的断言会**同时**变得没有判别力
    // —— 区块真被删掉了，「该出现」那条也照样绿（2026-09-24 发版 v2.14.0 时实测踩到）。
    expect(html).toContain('id="leaderboard-title"');
    expect(html).toContain('上榜 / 更新我的成绩');
    expect(html).toContain('刷新榜单');
    // 隐私取舍必须写在伸手可及的地方。
    expect(html).toContain('只有点「上榜 / 更新我的成绩」才会把数据发到服务器');
    expect(html).toContain('没有账号、没有密码、没有对局内容');
    expect(html).toContain('成就本身完全在本机计算，不会上传');
    // SSR 下 `onMounted` 不执行（也就不会有网络请求），如实显示加载中。
    expect(html).toContain('正在加载榜单…');
  });

  it('没有本地存储时，成就与排行榜随战绩区块一起隐藏，不留半截 UI', async () => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    const html = await renderHome();

    expect(html).not.toContain('id="leaderboard-title"');
    expect(html).not.toContain('class="achievements"');
    expect(html).not.toContain('上榜 / 更新我的成绩');
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
    hasPassword: false,
    allowSpectators: true,
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
