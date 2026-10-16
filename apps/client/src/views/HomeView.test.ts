import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import releaseNotes from '../../../../release-notes.json';
import HomeView from './HomeView.vue';
import { renderView } from './viewTestSupport';

const here = dirname(fileURLToPath(import.meta.url));

function renderHome(): Promise<string> {
  return renderView(HomeView);
}

describe('HomeView release notes entry', () => {
  it('shows the current player version and an update-history button', async () => {
    const html = await renderHome();

    const entry = `v${releaseNotes.releases[0].version} · 更新说明`;
    expect(html.split(entry)).toHaveLength(2);
    expect(html).toContain('class="release-notes-trigger"');
  });
});

/**
 * 三条「次要入口」（#109 玩法说明 / #115 导入回看 / #117 地图工坊）。
 *
 * 位置是一条既有的承诺：想重看说明、收到了别人发来的复盘码、自己画了图想装进来 ——
 * 这三种人都不该被迫先进一局。所以三条都在 hero 正下方、成果图标之前。
 *
 * 锚点变过：原来这条钉在 `class="home-form"`（联机表单）之前，而那张表单已经搬去
 * 「在线对战页」，现在改钉在成果图标行之前 —— 断言的两端都在首页内，才有判别力。
 */
describe('HomeView 三条次要入口（#109 / #115 / #117）', () => {
  it('并列在 hero 正下方，排在成果图标区之前', async () => {
    const html = await renderHome();

    expect(html).toContain('class="home-entry-row"');
    expect(html).toContain('看玩法说明');
    expect(html).toContain('收到复盘码？导入回看');
    expect(html).toContain('自己画了图？地图工坊');
    expect(html.indexOf('class="home-entry-row"')).toBeGreaterThan(html.indexOf('class="home-copy"'));
    expect(html.indexOf('class="home-entry-row"')).toBeLessThan(html.indexOf('class="home-icon-row"'));
  });

  it('三条入口在同一行里，一个不多一个不少', async () => {
    const html = await renderHome();
    const row = html.slice(
      html.indexOf('class="home-entry-row"'),
      html.indexOf('class="home-icon-row"'),
    );

    expect(row.match(/class="home-guide"/g)?.length).toBe(3);
  });
});

/**
 * 成果图标区（《UI 改造方案》§四）。
 *
 * 这一段替掉了原先摊在首页的「我的战绩」一整块 + 成就折叠块 + 云同步一整块 + 排行榜列表。
 * 两条要害：
 *  1. 四个图标**不依赖本机存储** —— 它们是导航，不是数据。原先那排图标带 `v-if="playerStats"`，
 *     浏览器不给 localStorage 时整排消失，等于把入口一起藏了。
 *  2. 明细字符不许再出现在首页：那正是这次改造要拿掉的东西。
 */
describe('HomeView 成果图标区（《UI 改造方案》§四）', () => {
  it('一排四个图标，各有可读的名字，排在三条次要入口之后', async () => {
    const html = await renderHome();
    const start = html.indexOf('class="home-icon-row"');
    expect(start).toBeGreaterThan(-1);

    const row = html.slice(start, html.indexOf('class="home-icon-hint"'));
    expect(row.match(/class="home-icon"/g)?.length).toBe(4);
    for (const label of ['战绩', '成就', '云同步', '排行榜']) {
      // <em> 会被 scoped CSS 追加 data-v-xxx 属性，精确串匹配抓不到，只能按标签体断言。
      expect(row).toMatch(new RegExp(`<em[^>]*>${label}</em>`));
    }
    expect(start).toBeGreaterThan(html.indexOf('class="home-entry-row"'));
  });

  it('不读本机存储：浏览器不给 localStorage 时四个图标照样在', async () => {
    // node 环境里本来就没有 localStorage —— 这里刻意什么都不桩，读到的就是「无存储」。
    const html = await renderHome();

    expect(html).toContain('class="home-icon-row"');
    expect(html.match(/class="home-icon"/g)?.length).toBe(4);
  });

  it('明细不再出现在首页：战绩码 / 云同步 / 上榜这些只该在详情页里', async () => {
    const html = await renderHome();

    for (const detail of [
      '导出战绩码',
      'class="cloud-sync"',
      'class="leaderboard"',
      'id="leaderboard-title"',
      'class="achievements"',
      'class="stats-transfer"',
      'class="home-rooms"',
      'id="home-form"',
    ]) {
      expect(html).not.toContain(detail);
    }
  });
});

/**
 * 首页场景化（P1 视觉升级）。
 *
 * 这一块盯的是一条**对外契约**：首页 <h1> 的可访问名必须是「进入大富翁」。
 * 视觉上标题是逐字换色的贴纸「大富翁」，前导「进入」用视觉隐藏留在无障碍名里；
 * e2e（e2e/smoke.local.spec.ts）正是用 `getByRole('heading', { name: '进入大富翁' })` 找它。
 * 贴纸字之间多出一个**同一行内的空格**，可访问名就变成「进入大 富翁」，e2e 当场找不到标题
 * （实测：注入该空格后本用例报 `expected '进入大 富翁' to be '进入大富翁'`）。
 * 注意换行+缩进不算：Vue 的 whitespace:'condense' 会把含换行的纯空白节点整段删掉，
 * 只有同排空格才真的落进可访问名。这类失败在本地 vitest 里看不见，所以在这里钉住。
 */
describe('HomeView 首页场景化（P1）', () => {
  it('标题的可访问名是「进入大富翁」—— 贴纸字之间不能落进空白', async () => {
    const html = await renderHome();
    const match = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
    if (match === null) throw new Error('首页应当有一个 h1');
    expect(match[1].replace(/<[^>]+>/g, '')).toBe('进入大富翁');
  });

  it('给出场景底与两个等宽双色主按钮', async () => {
    const html = await renderHome();

    // 场景是纯 CSS + 内联 SVG，必须 aria-hidden：装饰不进无障碍树，也不该被读屏念出来。
    expect(html).toMatch(/<div class="home-scene" aria-hidden="true"/);
    expect(html).toContain('class="home-scene__art"');

    // 两个主按钮：在线 = 朱砂、单机 = 竹青，同宽同高（同一网格列）⇒ 地位对等。
    expect(html).toContain('class="home-main home-main--online"');
    expect(html).toContain('class="home-main home-main--local"');
    expect(html).toContain('在线联网对战');
    expect(html).toContain('单机模式');
    // 各带一行同样字数的副行 ⇒ 高度不参差（「等宽」这条承诺的等高半边）。
    expect(html).toContain('开房 / 加入');
    expect(html).toContain('无需联网');
  });

  /**
   * 六个落点的**接线**守卫。
   *
   * 为什么读源码而不是点一下：SSR 渲染里没有点击，本项目也没装 @vue/test-utils，
   * 所以「按钮绑了哪个 handler」在渲染结果里根本观察不到。判定**逻辑**归各自的视图与纯函数
   * （`session/appFlow.test.ts` 的 pane 路由、各视图自己的测试），这里只钉住
   * 「首页确实只发 navigate，且六个落点都在」。
   *
   * 这条值得钉：它走过一次倒退 —— 主按钮上写着「一键」，按下去只是把人送去填表。
   * 现在「一键开房」搬到了在线对战页的页顶（见 OnlineEntryView.test.ts 的同名守卫），
   * 首页这两个大按钮的职责就只是**导航**，一处也不许再自己发请求。
   */
  it('两个主按钮与四个成果图标只发 navigate，六个落点各就各位', () => {
    const source = readFileSync(resolve(here, 'HomeView.vue'), 'utf8');

    for (const target of ['online', 'local', 'stats', 'achievements', 'cloud', 'leaderboard']) {
      expect(source).toContain(`emit('navigate', '${target}')`);
    }

    const online = /<button[^>]*home-main--online[^>]*>/.exec(source);
    if (online === null) throw new Error('首页应当有一个 home-main--online 按钮');
    expect(online[0]).toContain("@click=\"emit('navigate', 'online')\"");
    expect(online[0]).not.toContain('quickCreate');

    // 首页从「什么都在一页上」瘦成一张导航图：既不该再自己建房，也不该再读本机存储。
    expect(source).not.toContain('quickCreate');
    expect(source).not.toContain('localStorage');
    expect(source).not.toContain('home-quick');
  });
});
