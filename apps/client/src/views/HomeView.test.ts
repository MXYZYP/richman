import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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
    // 锚点原先是 .home-copy（「用 6 位房间码…」那句）—— 10-16 第三版按用户要求删掉了它，
    // 改钉标题下的角标：两端都还在首页内，断言照样有判别力。
    expect(html.indexOf('class="home-entry-row"')).toBeGreaterThan(html.indexOf('class="home-sticker__sub"'));
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

  it('三条入口等宽铺满一行，不再退回折行的 2+1', () => {
    // 读样式源码而非渲染结果：SSR 拿不到计算后的布局，这里只能守规则本身。
    // 守的是一次真实返工 —— 原先折行排成 2+1，第二行孤零一条、行距对不齐（10-16 用户截图指出）。
    const source = readFileSync(resolve(here, 'HomeView.vue'), 'utf8')
      // 先剥注释：注释里写了 "flex" 会被自己的检测先读到（谎话守卫比没守卫更糟）。
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\.home-entry-row\s*\{([^}]*)\}/.exec(source);
    if (rule === null) throw new Error('首页应当有 .home-entry-row 规则');
    expect(rule[1]).toContain('repeat(3');
    expect(rule[1]).not.toContain('flex');
  });
});

/**
 * 成果图标区（《UI 改造方案》§四）。
 *
 * 这一段替掉了原先摊在首页的「我的战绩」一整块 + 成就折叠块 + 云同步一整块 + 排行榜列表。
 * 三条要害：
 *  1. 四个图标**不依赖本机存储** —— 它们是导航，不是数据。原先那排图标带 `v-if="playerStats"`，
 *     浏览器不给 localStorage 时整排消失，等于把入口一起藏了。
 *  2. 明细字符不许再出现在首页：那正是这次改造要拿掉的东西。
 *  3. 图标是**纯图标**（10-16 用户拍板）：没有可见文字，名字只能落在 aria-label / title 上。
 *     这条必须钉死 —— 去掉文字时很容易顺手把名字也去掉，那就真成了四个看不懂的图形。
 */
describe('HomeView 成果图标区（《UI 改造方案》§四）', () => {
  it('一排四个纯图标按钮，名字落在 aria-label / title 上，排在三条次要入口之后', async () => {
    const html = await renderHome();
    const start = html.indexOf('class="home-icon-row"');
    expect(start).toBeGreaterThan(-1);

    const row = html.slice(start, html.indexOf('</nav>'));
    expect(row.match(/class="home-icon"/g)?.length).toBe(4);
    for (const label of ['战绩', '成就', '云同步', '排行榜']) {
      expect(row).toMatch(new RegExp(`aria-label="${label}"`));
      expect(row).toMatch(new RegExp(`title="${label}"`));
    }
    // 反面：可见标签不许再出现 —— 又长回文字就是回退了本次改版。
    expect(row).not.toMatch(/<em[^>]*>(战绩|成就|云同步|排行榜)<\/em>/);
    expect(start).toBeGreaterThan(html.indexOf('class="home-entry-row"'));
  });

  it('图标列贴在左上角，且不再挂在卡片里（挂在卡片里只会绕卡片排）', () => {
    // 读样式源码而非渲染结果：SSR 给不出计算后的位置。
    // 守的是一次真实返工 —— 图标原来在卡片底部一排，第二版改成参考图那种左上角竖列。
    const source = readFileSync(resolve(here, 'HomeView.vue'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\.home-icon-row\s*\{([^}]*)\}/.exec(source);
    if (rule === null) throw new Error('首页应当有 .home-icon-row 规则');
    expect(rule[1]).toContain('position: absolute');
    expect(rule[1]).toContain('top:');
    expect(rule[1]).toContain('left:');

    // 卡片自带 position:relative —— 图标列留在卡片里就只会相对卡片定位，贴不到屏幕角上。
    const card = /<section class="home-card"[\s\S]*?\n    <\/section>/.exec(source);
    if (card === null) throw new Error('首页应当有 .home-card 区块');
    expect(card[0]).not.toContain('home-icon-row');
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
 * 视觉上标题是 AI 生成的贴纸字图（10-16 第三版起），「进入大富翁」五个字用视觉隐藏留在无障碍名里；
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

    // 场景底必须 aria-hidden：装饰不进无障碍树，也不该被读屏念出来。
    expect(html).toMatch(/<div class="home-scene" aria-hidden="true"/);

    // 10-16 第三版把场景从「内联 SVG 手绘」换成了外链位图。位图挂在 CSS 里，SSR 渲染看不见，
    // 只能读样式源码确认真的挂上了（这是**接线守卫**，不是渲染验证）——
    // 顺手钉住它没有退回 SVG 手绘：正反两条一起断言，才不会被「同名的旧规则还留着」蒙混过去。
    const sceneSource = readFileSync(resolve(here, 'HomeView.vue'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(sceneSource).toContain("url('/home-bg.webp')");
    expect(sceneSource).not.toContain('home-scene__art');
    expect(sceneSource).not.toContain('<svg class="home-scene');

    // 两个主按钮：在线 = 朱砂、单机 = 竹青，同宽同高（同一网格列）⇒ 地位对等。
    expect(html).toContain('class="home-main home-main--online"');
    expect(html).toContain('class="home-main home-main--local"');
    expect(html).toContain('在线联网对战');
    expect(html).toContain('单机模式');
    // 各带一行同样字数的副行 ⇒ 高度不参差（「等宽」这条承诺的等高半边）。
    expect(html).toContain('开房 / 加入');
    expect(html).toContain('无需联网');
  });

  it('标题下的角标不写死任何一张地图，也不许空着', async () => {
    const html = await renderHome();
    const sub = /<p class="home-sticker__sub"[^>]*>([\s\S]*?)<\/p>/.exec(html);
    if (sub === null) throw new Error('首页应当有标题下的角标');
    const text = sub[1].replace(/<[^>]+>/g, '').trim();

    expect(text.length).toBeGreaterThan(0);
    // 10-16 用户原话：「换个说法，我又不是只有这一个地图」——
    // 角标一旦等于某张地图的名字，就又在暗示「只有这一张」。
    for (const mapName of ['中国之旅', '世界名城', '丝路', '三国', '山西', '运城']) {
      expect(text).not.toContain(mapName);
    }
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

/**
 * 首页美工第三版（10-16 用户看过手机 / 电脑截图后的 4 项要求）。
 *
 * 这一版改的全是「一眼能看出好坏、但 SSR 渲染里根本看不见」的东西，所以下面四条基本
 * 都是读样式源码的**接线守卫**（注释里逐条写明它守的是哪次返工），只有标题那条能拿到 DOM。
 */
describe('HomeView 美工第三版（10-16）', () => {
  it('标题换成 AI 贴纸字图，不再退回 CSS 逐字描边；图是装饰性的', async () => {
    const html = await renderHome();
    // 贴纸是 aria-hidden 的空 span（靠背景图上色）：不带 aria-hidden 的话，
    // 读屏会把「进入大富翁」念两遍。
    expect(html).toMatch(/<span[^>]*home-sticker__logo[^>]*aria-hidden="true"/);
    // 也钉住它没有退回 img 标签：模板里的根绝对路径会被 transformAssetUrls 改写
    // （实测 /home-logo.webp 变成 /@fs/home-logo.webp，public/ 资源必须走 CSS 的 url()）。
    expect(html).not.toContain('<img');

    const source = readFileSync(resolve(here, 'HomeView.vue'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    // 位图挂在 CSS 里，且不许退回逐字换色 + text-stroke 的旧实现（留了就是两套标题叠在一起）。
    expect(source).toContain("url('/home-logo.webp')");
    expect(source).not.toContain('home-sticker__char');
    expect(source).not.toContain('-webkit-text-stroke');
  });

  it('已按用户要求删掉「用 6 位房间码…」那句', async () => {
    const html = await renderHome();
    expect(html).not.toContain('用 6 位房间码');
    expect(html).not.toContain('class="home-copy"');
  });

  it('整页内容顶部对齐、横向居中（是 align-content，不是 place-items）', () => {
    // 守的是一次真实返工：只把 place-items 的 align 改成 start，两行（卡片 / 页脚）的行高
    // 会被默认的 stretch 撑满整个视口，卡片与页脚被撕到上下两端 —— 必须是 align-content: start。
    const source = readFileSync(resolve(here, 'HomeView.vue'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    const shell = /\.home-shell\s*\{([^}]*)\}/.exec(source);
    if (shell === null) throw new Error('首页应当有 .home-shell 规则');
    expect(shell[1]).toContain('align-content: start');
    expect(shell[1]).not.toContain('place-items: center');

    // hero 从「左对齐」改成「居中」正是用户说的「上部居中」。
    const hero = /\.home-hero\s*\{([^}]*)\}/.exec(source);
    if (hero === null) throw new Error('首页应当有 .home-hero 规则');
    expect(hero[1]).toContain('justify-items: center');
  });

  it('两个模式按钮改成渐变 + 深色底边的厚贴纸按钮，且色值由主题变量推导', () => {
    const source = readFileSync(resolve(here, 'HomeView.vue'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    for (const mode of ['online', 'local']) {
      const rule = new RegExp('\\.home-main--' + mode + '\\s*\\{([^}]*)\\}').exec(source);
      if (rule === null) throw new Error('首页应当有 .home-main--' + mode + ' 规则');
      // 上亮下深的同色渐变，取代原来那句 background: var(--mode-*) 的平涂。
      expect(rule[1]).toContain('linear-gradient');
      expect(rule[1]).toContain('color-mix(in srgb, var(--mode-' + mode + ')');
      // 底边色也必须是推导出来的：深色模式下 --mode-* 会被提亮，硬编码就跟不上。
      expect(rule[1]).toContain('--mode-deep');
    }

    // 按下时下沉（贴纸被按下去的手感），且禁用态不许留底边（留着像「还能按」）。
    expect(source).toContain('translateY(3px)');
    const disabled = /\.home-main:disabled\s*\{([^}]*)\}/.exec(source);
    if (disabled === null) throw new Error('首页应当有 .home-main:disabled 规则');
    expect(disabled[1]).toContain('box-shadow: none');
  });

  it('竖屏换用竖版底图（横版 3:2 在手机上只剩中间一条）', () => {
    // 读样式源码而非渲染结果：SSR 拿不到媒体查询求值后的背景图。
    // 守的是一次真实返工 —— 只出横版时，390x844 上只露出约 31% 宽度，两侧的山全被裁掉。
    const source = readFileSync(resolve(here, 'HomeView.vue'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    // 两条一起断言：默认横版 + 竖屏覆盖成竖版，少任何一条都不成立。
    expect(source).toContain("--home-bg: url('/home-bg.webp')");
    expect(source).toMatch(/@media\s*\(max-aspect-ratio[^{]*\{[^}]*url\('\/home-bg-portrait\.webp'\)/);
  });

  it('三张首页位图都登记进了 sw.js 的 SHELL，文件也真的在 public/ 下', () => {
    // 这条守的是一个**只在离线首访才暴露**的坑：extractAssetUrls 只抽 .js / .css，
    // 图片不会自动进预缓存 —— 忘了登记，线上在线访问看不出任何异常，离线首访却只有空壳。
    const publicDir = resolve(here, '../../public');
    const sw = readFileSync(resolve(publicDir, 'sw.js'), 'utf8');
    const source = readFileSync(resolve(here, 'HomeView.vue'), 'utf8');

    for (const asset of ['/home-bg.webp', '/home-logo.webp', '/home-bg-portrait.webp']) {
      expect(source).toContain(asset);
      expect(sw).toContain("'" + asset + "'");
      expect(existsSync(resolve(publicDir, asset.slice(1)))).toBe(true);
    }
  });
});

/**
 * 隐私合规（TapTap 上架要求）：政策必须能从 App 内打开，不能只在商店页挂外链。
 *
 * 位置钉在页脚：版本入口 / 隐私政策 / 备案号 三者同一行。
 * 备案号在页脚是法定要求，隐私政策跟着它走，玩家要找合规信息时只需看一处。
 */
describe('HomeView 隐私政策入口', () => {
  it('页脚里有「隐私政策」按钮，且与版本入口、备案号同处一行', async () => {
    const html = await renderHome();

    expect(html).toContain('class="home-beian"');
    expect(html).toContain('>隐私政策</button>');

    const footer = html.slice(html.indexOf('class="home-beian"'), html.indexOf('</footer>'));
    expect(footer).toContain('class="release-notes-trigger"');
    expect(footer).toContain('新ICP备2026008728号');
    expect(footer).toContain('>隐私政策</button>');
  });

  it('按钮只发 openPrivacy 事件，正文由 App 层统一渲染（首页不背政策正文）', () => {
    const source = readFileSync(resolve(here, 'HomeView.vue'), 'utf8');

    expect(source).toContain("openPrivacy: [];");
    expect(source).toContain("@click=\"emit('openPrivacy')\"");
    // 首页自己不许内联政策正文：那会让 SSR 出来的首页 HTML 里多一整份政策。
    expect(source).not.toContain('我们处理哪些信息');
  });

  it('首启同意门不可关闭，且只在需要时才挂载', () => {
    const app = readFileSync(resolve(here, '../App.vue'), 'utf8');
    const gate = readFileSync(resolve(here, '../components/PrivacyConsentGate.vue'), 'utf8');

    // 门本身：dismissible=false + 只有一个「同意」出口。
    expect(gate).toContain(':dismissible="false"');
    expect(gate).toContain("emit('accept')");
    // 接线：拿不到 storage 时 hasAcceptedPrivacy 返回 true ⇒ SSR 与无痕模式都不会卡住首页。
    expect(app).toContain('v-if="consentOpen"');
    expect(app).toContain('hasAcceptedPrivacy(browserStorage())');
  });
});
