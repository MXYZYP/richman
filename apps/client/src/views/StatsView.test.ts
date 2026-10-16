import { describe, expect, it } from 'vitest';
import StatsView from './StatsView.vue';
import { PLAYER_STATS_KEY, renderView, statsJson, withStorageValues } from './viewTestSupport';

/**
 * 「战绩」详情页（《UI 改造方案》§四）。
 *
 * 战绩码的导入 / 导出跟着战绩一起落到这一页 —— 它们本来就是同一份数据的两种搬法。
 *
 * 与原来首页那版最大的行为差别：**这一页总是可达**。以前战绩区块挂在 `v-if="playerStats"` 上，
 * 浏览器不给 localStorage 时连区块带入口一起消失；现在它是一张独立的页面，
 * 没有战绩也要能进来，并说清「还没有战绩」该怎么办。
 */
function renderStats(): Promise<string> {
  return renderView(StatsView, { open: true });
}

describe('StatsView 战绩与战绩码', () => {
  it('有本机存储时给出导出 / 导入战绩码的入口与说明', async () => {
    const html = await withStorageValues({ [PLAYER_STATS_KEY]: statsJson() }, renderStats);

    expect(html).toContain('导出战绩码');
    expect(html).toContain('导入战绩码');
    // 说明必须点明「不需要账号密码」与「导入是合并」，否则玩家不敢用。
    expect(html).toContain('不需要账号密码');
    expect(html).toContain('导入是合并');
  });

  it('把三个数字摆出来：胜负、资产峰值、常用地图（无常用地图时不占一格）', async () => {
    const html = await withStorageValues(
      {
        [PLAYER_STATS_KEY]: statsJson({
          gamesPlayed: 19,
          wins: 12,
          losses: 7,
          bestAsset: 486_000,
          favoriteMaps: { 'china-tour': 5 },
        }),
      },
      renderStats,
    );

    expect(html).toContain('胜 / 负');
    expect(html).toContain('12 / 7');
    expect(html).toContain('总资产峰值');
    expect(html).toContain('常用地图');
    expect(html).toContain('中国之旅');
  });

  it('没有本机存储时落在「还没有战绩」的空态上，而不是留半截 UI', async () => {
    // node 环境本来就没有 localStorage：这里读到的就是「无存储」。
    const html = await renderStats();

    expect(html).toContain('这台设备上还没有战绩');
    expect(html).not.toContain('导出战绩码');
    expect(html).not.toContain('导入战绩码');
    // 弹窗外壳还在：它是一个可达的弹窗，不是「没有数据就整块消失」。
    expect(html).toContain('data-variant="modal"');
  });
});
