import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import FirstRunGuide from './FirstRunGuide.vue';

function renderGuide(open = true): Promise<string> {
  return renderToString(createSSRApp({
    render: () => h(FirstRunGuide as never, { open, onClose: () => {} } as never),
  }));
}

describe('FirstRunGuide（#109）', () => {
  it('和设置面板共用同一套居中弹窗，不另造一层弹层', async () => {
    const html = await renderGuide();

    expect(html).toContain('data-variant="modal"');
    expect(html).toContain('玩法说明');
    expect(html).toContain('aria-label="关闭玩法说明"');
  });

  it('四件事按顺序讲全：开局 / 回合 / 胜利条件 / 联机小贴士', async () => {
    const html = await renderGuide();

    for (const section of ['怎么开局', '回合怎么走', '怎么算赢', '联机小贴士']) {
      expect(html).toContain(section);
    }
  });

  it('联机三件套都点到：每步限时（#107）、公开房间（#108）、快捷短语（#109）', async () => {
    const html = await renderGuide();

    expect(html).toContain('每步限时');
    expect(html).toContain('公开房间');
    expect(html).toContain('快捷短语');
    // 掉线与托管是最容易让人以为「这局坏了」的一件事，必须写清楚。
    expect(html).toContain('断线');
    expect(html).toContain('托管');
  });

  it('刻意不写任何具体数值：那些按地图与房间设置各不相同', async () => {
    const html = await renderGuide();
    // 先摘掉 scoped CSS 的 data-v-<hash> 标记：里面本来就带 8 位十六进制数字，
    // 不摘掉的话「没有三位以上数字」这种断言会被 Vue 自己的产物误伤。
    const content = html.replace(/data-v-[0-9a-f]+/g, '');

    // 金额、档位、限时秒数都由设置面板里的「规则说明」按当前地图渲染；这里再抄一份必然过期。
    expect(content).not.toContain('¥');
    expect(content).not.toMatch(/\d{3,}/);
  });

  it('给出明确的关闭动作，且不是提交按钮', async () => {
    const html = await renderGuide();

    expect(html).toContain('知道了');
    const dismiss = html.match(/<button[^>]*class="guide-dismiss"[^>]*>/g) ?? [];
    expect(dismiss).toHaveLength(1);
    expect(dismiss[0]).toContain('type="button"');
  });

  it('未打开时不会自己盖住首页（native dialog 只靠 showModal 现身）', async () => {
    const html = await renderGuide(false);
    expect(html).not.toMatch(/<dialog[^>]*\sopen/);
  });
});
