// 守卫：在线联网对战与单机模式是「同一个壳 + 同一套控件」的两个页面。
//
// 用户原话（10-16 第五版）：
//   「弹窗样式大小统一，字体大小统一。」
//   「在线联网 单机模式先不改弹窗，但是返回首页位置要一致，在线在左上角，单机跑到最下面，不合适。」
//   「在线联网、单机模式里面的样式也统一，操作逻辑要符合人类直觉，布局要好看规整。」
//
// 这三条靠下面四件事成立，任何一件被改回去都会在这里变红：
//   1. 两页都 import 同一个 ViewShell —— 返回条（返回首页在左 / 标题居中 / 状态字在右）
//      与卡片尺寸只由它决定。页面里再出现一次卡片宽高，就是「两页各一份」又回来了。
//   2. 两页都不再有**自己画的返回首页按钮**。原来单机页把它放在页面最下面
//      （与「开始新对局」挤在一行），在线页放在左上角 —— 同一个动作两个位置。
//   3. 两页共用的控件 / 按钮 / 分区小标题来自 ui/entryPage.css（写一次、全局引入），
//      页面自己的 <style scoped> 只留各自独有的内容排版。
//   4. 两页的操作顺位一致：续玩 → 主行动 → 表单 →（在线多一段）列表。
//
// 11-17 第六版补一页：**联机大厅（房间等待页）**原本是第三个自己画壳的整页
//   （.lobby-shell / .lobby-card / 一个 46px 的「房间 789230」大标题 / 「离开房间」压在页面最底部），
//   于是「返回」这一件事在三个二级页里又出现了第三种位置。用户原话：
//   「联机对战创建房间页面布局还是未统一？」。现在它也走 ViewShell，并纳入下面第 5 条。
//
// 本仓没有组件挂载测试环境，所以这些契约只能靠读源码钉住 —— 它们是**接线**，不是渲染验证。
// 视觉仍然要靠人在真机上看（见 .workbuddy/memory 里的「要用户量 computed style」那条）。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..');
const read = (...parts: string[]) => readFileSync(resolve(srcRoot, ...parts), 'utf8');

const SHELL = read('views', 'ViewShell.vue');
const ONLINE = read('views', 'OnlineEntryView.vue');
const LOCAL = read('components', 'GameSetup.vue');
const LOBBY = read('views', 'LobbyView.vue');
const ENTRY_CSS = read('ui', 'entryPage.css');
const MAIN = read('main.ts');

/** 去掉注释再看声明：注释里引用旧值会被自己的检测先读到（本项目踩过）。 */
const decls = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
/** 只取 <style> 段。模板里的 class 名不该参与样式断言。 */
const styleOf = (text: string) => {
  const at = text.lastIndexOf('<style');
  return decls(text.slice(at));
};

describe('整页壳：返回首页固定在左上角，卡片尺寸只有一处', () => {
  it('ViewShell 的返回条是「返回首页 | 标题 | 状态字」三列，返回在左', () => {
    const bar = /\.view-bar\s*\{([^}]*)\}/.exec(decls(SHELL));
    if (bar === null) throw new Error('ViewShell 应当有 .view-bar 规则');
    expect(bar[1]).toContain('grid-template-columns: auto minmax(0, 1fr) auto');

    const body = SHELL.slice(SHELL.indexOf('<template>'), SHELL.indexOf('</template>'));
    const back = body.indexOf('view-bar__back');
    const title = body.indexOf('view-bar__title');
    const slot = body.indexOf('<slot');
    expect(back).toBeGreaterThanOrEqual(0);
    expect(back).toBeLessThan(title);
    expect(title).toBeLessThan(slot);
    // 按钮文字是 backLabel，默认值写在 script 里 —— 两处都要在，才叫「默认就是返回首页」。
    expect(body).toContain('{{ backLabel }}');
    expect(SHELL).toContain("backLabel: '返回首页'");
  });

  it('卡片宽度 / 圆角 / 内边距只写在 ViewShell 里', () => {
    const card = /\.view-card\s*\{([^}]*)\}/.exec(decls(SHELL));
    if (card === null) throw new Error('ViewShell 应当有 .view-card 规则');
    expect(card[1]).toContain('width: min(560px, 100%)');
    expect(card[1]).toContain('border-radius: var(--radius-card)');
    expect(card[1]).toContain('padding: clamp(20px, 4vw, 34px)');

    // 两个页面都不许再画一次壳 / 卡片。
    for (const text of [ONLINE, LOCAL]) {
      expect(text).not.toContain('min(560px');
      expect(text).not.toContain('min(720px');
      expect(text).not.toContain('radius-card');
      expect(text).not.toContain('100dvh');
    }
  });

  it('两页都用 ViewShell，且都不自己渲染「返回首页」按钮', () => {
    for (const text of [ONLINE, LOCAL]) {
      expect(text).toContain("import ViewShell from");
      expect(text).toContain('<ViewShell');
      expect(text).toContain('</ViewShell>');
      // 「返回首页」这颗按钮只由壳给出；页面里再出现一个就是又有了第二个返回位置。
      // （注释里提到这四个字不算 —— 断言的是按钮，不是这个词。）
      expect(text).not.toMatch(/>\s*返回首页\s*</);
      expect(text).not.toContain('view-bar');
    }
  });
});

describe('联机大厅：第三个二级整页，也必须是同一个壳', () => {
  it('大厅 import 并使用了 ViewShell', () => {
    expect(LOBBY).toContain("import ViewShell from './ViewShell.vue';");
    expect(LOBBY).toContain('<ViewShell');
    expect(LOBBY).toContain('</ViewShell>');
    expect(LOBBY).toContain('class="entry-body"');
  });

  it('大厅不再自己画壳 / 卡片，也不再自带一套按钮', () => {
    expect(LOBBY).not.toContain('min(560px');
    expect(LOBBY).not.toContain('radius-card');
    expect(LOBBY).not.toContain('100dvh');
    // 卡片的宽高、内边距、圆角、底色、阴影只允许出现在 ViewShell 里。
    expect(LOBBY).not.toMatch(/\.lobby-(shell|card)\s*\{/);
    // 按钮统一走 entryPage.css：再出现 .lobby-btn 就是又有了第二套按钮。
    // 断言前先剥注释 —— 说明文字里点了这个名字，不能算「又写了一套」。
    expect(decls(LOBBY)).not.toContain('lobby-btn');
    expect(LOBBY).toContain('entry-primary');
    expect(LOBBY).toContain('entry-secondary');
  });

  it('「离开房间」在返回条上，不再压在页面最底部', () => {
    const body = LOBBY.slice(LOBBY.indexOf('<template>'), LOBBY.lastIndexOf('</template>'));
    expect(body).toContain('离开房间');
    expect(body.indexOf('离开房间')).toBeLessThan(body.indexOf('class="entry-body"'));
    // 页面里不许再出现一颗写着自己文案的「离开房间」按钮。
    expect(body).not.toMatch(/>\s*\{\{ pendingCommand === 'leave'[\s\S]{0,40}\}\}\s*</);
  });
});

describe('两页共用同一套控件样式（ui/entryPage.css）', () => {
  it('main.ts 全局引入了它（scoped 组件里 import 会炸产物，见 globalStyleBoundary.test.ts）', () => {
    expect(MAIN).toContain("import './ui/entryPage.css';");
    expect(ENTRY_CSS).toContain('.entry-body input:where(:not([type=\'checkbox\'], [type=\'radio\']))');
    expect(ENTRY_CSS).toContain('.entry-body select');
    expect(ENTRY_CSS).toContain('min-height: 44px');
    expect(ENTRY_CSS).toContain('min-height: 48px');
    expect(ENTRY_CSS).toContain('border-radius: 12px');
    expect(ENTRY_CSS).toContain('border-radius: 16px');
  });

  it('两页都用了同一组 entry-* 类（分段、字段、按钮、续玩块）', () => {
    for (const text of [ONLINE, LOCAL]) {
      for (const cls of [
        'entry-body',
        'entry-section',
        'entry-section-title',
        'entry-field',
        'entry-primary',
        'entry-resume',
      ]) {
        expect(text, `${cls} 应当出现在两页里`).toContain(cls);
      }
    }
  });

  it('两页都不在自己的 scoped 样式里重写输入框 / 按钮的基础外观', () => {
    for (const text of [ONLINE, LOCAL]) {
      const css = styleOf(text);
      // 圆角 12px 与 16px 是输入框 / 按钮的共用外观，交给 entryPage.css。
      // （allowed: .home-role-field 的 12px 属于这一页独有的「参赛 / 观战」分段控件。）
      expect(css).not.toMatch(/\.(home-card|setup-card)\s*\{/);
      expect(css).not.toMatch(/\binput,\s*\n?\s*select\b/);
    }
  });
});

describe('操作顺位：续玩在前，表单在后', () => {
  it('两页都把「接着上一局」放在主行动与表单之前', () => {
    const onlineResume = ONLINE.indexOf('entry-resume');
    expect(onlineResume).toBeGreaterThanOrEqual(0);
    expect(onlineResume).toBeLessThan(ONLINE.indexOf('class="home-main-actions"'));
    expect(onlineResume).toBeLessThan(ONLINE.indexOf('id="home-form"'));

    const localSaves = LOCAL.indexOf('local-saves-title');
    expect(localSaves).toBeGreaterThanOrEqual(0);
    expect(localSaves).toBeLessThan(LOCAL.indexOf('id="setup-new-title"'));
    expect(localSaves).toBeLessThan(LOCAL.indexOf('ref="startButton"'));
  });

  it('单机页的「开始新对局」在表单之后，返回首页不再挤在它旁边', () => {
    const start = LOCAL.indexOf('ref="startButton"');
    expect(start).toBeGreaterThan(LOCAL.indexOf('class="setup-fields"'));
    const actions = /<div class="entry-actions">([\s\S]*?)<\/div>/.exec(LOCAL);
    if (actions === null) throw new Error('单机页应当有一个 .entry-actions 容器');
    expect(actions[1]).toContain('开始新对局');
    expect(actions[1]).not.toContain('返回首页');
  });
});
