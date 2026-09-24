import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import MapWorkshopDialog from './MapWorkshopDialog.vue';
import { CUSTOM_MAP_MAX_ENTRIES, type CustomMapSummary } from '../session/customMaps';

/**
 * 地图工坊（#117）的**渲染契约**。
 *
 * 这一层只管「看到了什么、被明确告知了什么」；导入解析、哈希复核、落盘与注册表装载的正确性
 * 由 customMaps.test.ts 守着（那边全是真数据），两边不重复。
 *
 * 测试环境是 node（无 DOM），所以一律走 SSR：`onMounted`、`showModal`、剪贴板与计时器都跑不到。
 * 这里最值得钉死的一条是**范围声明**——工坊装的地图只能单机玩，这句话必须在弹层里，
 * 不能只存在于「点了创建房间之后的那句报错」里。
 */
function render(props: Record<string, unknown>): Promise<string> {
  return renderToString(createSSRApp({
    render: () => h(MapWorkshopDialog as never, { open: true, ...props } as never),
  }));
}

function summary(id: string, title = `${id} 测试图`): CustomMapSummary {
  return {
    ref: { id, version: 1, contentHash: 'a'.repeat(64) },
    title,
    description: '来自地图编辑器的测试图',
    importedAt: '2026-09-23T02:00:00.000Z',
  };
}

describe('MapWorkshopDialog', () => {
  it('一进门就说清范围：工坊的地图只能单机，联机房间仍只用内置图', async () => {
    const html = await render({});

    expect(html).toContain('地图工坊');
    expect(html).toContain('工坊里的地图只能单机游玩');
    expect(html).toContain('联机房间仍只用内置的那十张图');
    // 必须给出「怎么造图」的入口，否则这一页只是个收件箱，玩家不知道该往里放什么。
    expect(html).toContain('tools/map-editor.html');
    expect(html).toContain('导出 bundle.json');
    // 以及「不能用图片素材」这条硬约束：它会在导入时变成一条校验错误。
    expect(html).toContain('只能用内置图标');
  });

  it('粘贴框初始为空时导入按钮是禁用的，并给出容量计数', async () => {
    const html = await render({ maps: [summary('workshop-a')] });

    // 模板里按钮文字两侧有换行缩进，会渲染成 `> 导入地图 <`，所以这里必须容许空白。
    expect(html).toMatch(/<button[^>]*disabled[^>]*>\s*导入地图\s*<\/button>/);
    expect(html).toContain(`1 / ${CUSTOM_MAP_MAX_ENTRIES}`);
  });

  it('没有装过地图时给出空态文案，而不是一片空白', async () => {
    const html = await render({ maps: [] });
    expect(html).toContain('还没有装过自定义地图。');
    expect(html).not.toContain('单机试玩');
  });

  it('已装地图逐行列出标题、id@version、导入时间与四个操作', async () => {
    const html = await render({ maps: [summary('workshop-a', '丝路小环线')] });

    expect(html).toContain('丝路小环线');
    expect(html).toContain('workshop-a@1');
    expect(html).toContain('导入于');
    expect(html).toContain('单机试玩');
    expect(html).toContain('复制 JSON');
    expect(html).toContain('下载');
    expect(html).toContain('删除');
  });

  it('导入成功与失败各显示对应提示；失败时把字段级定位原样摊出来', async () => {
    const ok = await render({ maps: [summary('workshop-a')], notice: { kind: 'ok', message: '已装好「丝路小环线」。' } });
    expect(ok).toContain('已装好「丝路小环线」。');

    const failed = await render({
      maps: [],
      notice: {
        kind: 'error',
        message: '没通过地图校验。下面的定位信息会指出具体是哪个字段不合格。',
        detail: 'game.config.initialCash: must be a non-negative finite number',
      },
    });
    expect(failed).toContain('没通过地图校验');
    expect(failed).toContain('game.config.initialCash: must be a non-negative finite number');
  });

  it('装满了就提示先删一张', async () => {
    const maps = Array.from({ length: CUSTOM_MAP_MAX_ENTRIES }, (_, index) => summary(`workshop-${index}`));
    const html = await render({ maps });

    expect(html).toContain(`已装满 ${CUSTOM_MAP_MAX_ENTRIES} 张，导入前请先删掉一张。`);
    expect(html).toContain(`${CUSTOM_MAP_MAX_ENTRIES} / ${CUSTOM_MAP_MAX_ENTRIES}`);
  });

  it('存储不可用时把「保存不了」提前说清楚，而不是让玩家白导一次', async () => {
    const html = await render({ storageAvailable: false });
    expect(html).toContain('当前浏览器无法保存本地数据');
    expect(html).not.toContain('不上传、不同步');
  });

  it('存储可用时说明地图只在本机', async () => {
    const html = await render({ storageAvailable: true });
    expect(html).toContain('只存在这台设备的浏览器里');
    expect(html).toContain('不上传、不同步');
  });
});
