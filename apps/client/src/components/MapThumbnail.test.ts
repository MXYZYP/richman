import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import { getActiveMapPack, listActiveMaps, type MapCatalogEntry } from '@richman/board-data';
import MapThumbnail from './MapThumbnail.vue';
import MapPicker from './MapPicker.vue';

// `h()` 的 props 形参要的是组件 props 的精确结构（`Record<string, unknown>` 会因
// 缺少 $ / $data / $props 等内部属性而报 TS2769），所以这里显式声明两个 props 类型。
interface ThumbnailProps {
  mapId: string;
  title?: string;
  size?: number;
  showLayoutLabel?: boolean;
}

interface PickerProps {
  modelValue: string;
  maps: readonly MapCatalogEntry[];
  label?: string;
  disabled?: boolean;
}

function renderThumbnail(props: ThumbnailProps): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(MapThumbnail, props) }));
}

function renderPicker(props: PickerProps): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(MapPicker, props) }));
}

describe('MapThumbnail', () => {
  it('按地图 presentation 画出背景 + 每格一个矩形，并带上可读名称', async () => {
    const pack = getActiveMapPack('silk-road');
    const html = await renderThumbnail({
      mapId: 'silk-road',
      title: pack.metadata.title,
      size: 72,
    });

    expect(html).toContain('viewBox="0 0 100 100"');
    expect(html).toContain(`aria-label="${pack.metadata.title} 地图缩略图"`);
    // 背景 1 个 + 每格 1 个。
    expect(html.match(/<rect/g)).toHaveLength(pack.game.board.cells.length + 1);
    expect(html).toContain(pack.presentation.theme.colors.board);
  });

  it('每个正式地图都能渲染出缩略图，不会落到占位符', async () => {
    for (const entry of listActiveMaps()) {
      const html = await renderThumbnail({ mapId: entry.ref.id, title: entry.title });
      expect(html).not.toContain('map-thumb-empty');
      expect(html).toContain('<svg');
    }
  });

  it('未知地图退化成占位符而不是抛错', async () => {
    const html = await renderThumbnail({ mapId: 'not-a-map' });
    expect(html).toContain('map-thumb-empty');
    expect(html).not.toContain('<svg');
  });

  it('showLayoutLabel 才输出几何描述', async () => {
    const withLabel = await renderThumbnail({ mapId: 'silk-road', showLayoutLabel: true });
    expect(withLabel).toContain('回字双环 · 60 格');

    const withoutLabel = await renderThumbnail({ mapId: 'silk-road' });
    expect(withoutLabel).not.toContain('回字双环');
  });

  it('螺旋地图也走真实盘面缩略图，并标出自己的几何描述', async () => {
    const html = await renderThumbnail({
      mapId: 'yellow-river',
      title: getActiveMapPack('yellow-river').metadata.title,
      showLayoutLabel: true,
    });

    expect(html).not.toContain('map-thumb-empty');
    expect(html).toContain('螺旋盘绕 · 64 格');
  });
});

describe('MapPicker', () => {
  it('触发器带当前地图缩略图，且十个正式地图仍按目录顺序可选', async () => {
    const maps = listActiveMaps();
    const html = await renderPicker({ modelValue: 'silk-road', maps });

    expect(html).toContain('map-picker-value');
    expect(html).toContain('丝路之旅');
    // 触发器里的缩略图（菜单未展开，所以整个 HTML 里只有这一张 SVG）。
    expect(html.match(/<svg/g)).toHaveLength(1);
    expect(html).toContain('aria-label="丝路之旅 地图缩略图"');
    expect(maps.map((entry) => entry.ref.id)).toEqual([
      'china-tour', 'world-tour', 'classic-tour', 'silk-road', 'great-wall', 'yellow-river', 'yangtze-tour', 'pearl-tour', 'xinjiang-tour', 'shanxi-tour',
    ]);
  });

  it('选中的地图在下拉里可被精确定位（缩略图与标题都跟着当前值走）', async () => {
    const maps = listActiveMaps();
    const classic = getActiveMapPack('classic-tour').metadata.title;
    const html = await renderPicker({ modelValue: 'classic-tour', maps });
    expect(html).toContain(classic);
    expect(html).toContain(`aria-label="${classic} 地图缩略图"`);
  });
});
