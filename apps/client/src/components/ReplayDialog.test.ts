import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ReplayDialog from './ReplayDialog.vue';
import { REPLAY_CODE_PREFIX } from '../session/replayCode';
import type { ReplayExportOutcome } from '../session/gameSession';

/**
 * 复盘弹窗（#115）的**渲染契约**。
 *
 * 这一层只管「什么情况下看到哪一页、看到哪段文案」；编解码与重放的正确性由
 * replayCode.test.ts 守着（那边是真推演），两边不重复。
 *
 * 测试环境是 node（无 DOM），所以一律走 SSR：`onMounted`、`showModal`、计时器都跑不到，
 * 能测的恰好是「首屏落在哪一页」——而这正是本组件最容易写错的地方：
 * 打开时该给玩家看**结果**还是**原因**，只有把 props 摆对了才不出错。
 */
function render(open: boolean, exportOutcome: ReplayExportOutcome | null): Promise<string> {
  return renderToString(createSSRApp({
    render: () => h(ReplayDialog as never, { open, exportOutcome } as never),
  }));
}

const EXPORT_PANEL = 'aria-label="导出本局复盘"';
const IMPORT_PANEL = 'aria-label="导入复盘"';

describe('ReplayDialog', () => {
  it('有码时停在导出页：把码原样摊出来，并说明已经自校验过多少步', async () => {
    const code = `${REPLAY_CODE_PREFIX}.YWJjZGVm.ZzE4NDNjOTY`;
    const html = await render(true, { code, steps: 42, reason: '' });

    expect(html).toContain(EXPORT_PANEL);
    expect(html).not.toContain(IMPORT_PANEL);
    expect(html).toContain('已自校验：整局 42 步都能重放。');
    // 码必须**原样**出现在只读输入框里：少一个字符就等于把这份复盘废掉。
    expect(html).toContain(code);
    expect(html).toMatch(/<textarea[^>]*readonly/);
    expect(html).toContain('复制码');
    expect(html).toContain('下载为文件');
  });

  it('导不出来时也停在导出页，并把原因说清楚（而不是默默切到导入页）', async () => {
    const reason = '这一局来自存档恢复，缺了开局的种子与座次，无法导出复盘。';
    const html = await render(true, { code: null, steps: 0, reason });

    expect(html).toContain(EXPORT_PANEL);
    expect(html).toContain(reason);
    // 没码就不该出现码框，否则玩家会对着一个空框怀疑自己没复制到。
    expect(html).not.toMatch(/<textarea[^>]*readonly/);
    expect(html).not.toContain('复制码');
  });

  it('连导出能力都没有（联机）时落到导入页', async () => {
    const html = await render(true, null);

    expect(html).toContain(IMPORT_PANEL);
    expect(html).not.toContain(EXPORT_PANEL);
    // 导入页必须给出「先校验再回看」的入口，否则这一页就是个空壳。
    expect(html).toContain('校验这段码');
    expect(html).toContain(`${REPLAY_CODE_PREFIX}.`);
  });

  it('两个页签始终并列，玩家可以自己换页', async () => {
    const html = await render(true, { code: `${REPLAY_CODE_PREFIX}.x.y`, steps: 1, reason: '' });

    expect(html).toContain('导出本局');
    expect(html).toContain('导入回看');
    expect(html).toContain('aria-label="复盘"');
  });

  it('两个页签都点明隐私取舍：码里没有账号数据，但会暴露昵称与全部走法', async () => {
    const exportHtml = await render(true, { code: `${REPLAY_CODE_PREFIX}.x.y`, steps: 1, reason: '' });
    expect(exportHtml).toContain('昵称');
    expect(exportHtml).toContain('不含账号数据');

    const importHtml = await render(true, null);
    expect(importHtml).toContain('整局重放一遍以确认没坏');
    expect(importHtml).toContain('不能操作棋子');
  });
});
