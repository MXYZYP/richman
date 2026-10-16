import { describe, expect, it } from 'vitest';
import AchievementsView from './AchievementsView.vue';
import { PLAYER_STATS_KEY, renderView, statsJson, withStorageValues } from './viewTestSupport';

/**
 * 「成就」详情页（《UI 改造方案》§四）。
 *
 * 成就**只在本机算**，不发任何网络请求。原来它是首页里一个默认收起的 `<details>`，
 * 明细一铺开就把首页顶得很长；独立成页之后默认 `open` ——
 * 「一进来就看到几项」才是这一页存在的意义，折叠只是顺手留着的收纳。
 */
function renderAchievements(): Promise<string> {
  return renderView(AchievementsView, { open: true });
}

function withStats(raw: string): Promise<string> {
  return withStorageValues({ [PLAYER_STATS_KEY]: raw }, renderAchievements);
}

describe('AchievementsView 成就明细（#116）', () => {
  it('成就按分组铺开，一项都没达成时全是「未解锁」并给出下一个目标', async () => {
    const html = await withStats(statsJson());

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

  it('独立成页后默认展开：`<details open>`，明细与「下一个目标」都在', async () => {
    const html = await withStats(statsJson());

    // 认「是不是下拉块」一律用**结构标记**：`<details>` + `<summary>`。
    // 不整段匹配 `<details class="achievements">`：scoped 样式会给元素额外挂 `data-v-*`。
    expect(html).toMatch(/<details[^>]*class="achievements"/);
    expect(html).toMatch(/<summary[^>]*class="achievements-summary"/);
    // 默认**展开** —— 这一页就是来看明细的，收起只作为收纳留着。
    expect(html).toMatch(/<details[^>]*class="achievements"[^>]*\sopen/);
    expect(html).toContain('achievement-group-label');
    expect(html).toContain('下一个：开局');
  });

  it('战绩上来之后解锁项真的点亮（不是永远停在未解锁）', async () => {
    const html = await withStats(statsJson({
      gamesPlayed: 50,
      wins: 20,
      losses: 30,
      bestAsset: 150_000,
      favoriteMaps: { 'china-tour': 3, 'world-tour': 1, 'silk-road': 1, 'great-wall': 1, 'yellow-river': 1 },
    }));

    expect(html).toContain('achievement-unlocked');
    expect(html).toContain('已解锁');
    expect(html).not.toContain('成就 0 / ');
    expect(html).toContain('五胜');
    expect(html).toContain('富甲一方');
  });

  it('没有本机存储时落在「还没有战绩」的空态上，弹窗外壳仍在', async () => {
    // node 环境本来就没有 localStorage：这里读到的就是「无存储」。
    const html = await renderAchievements();

    expect(html).toContain('这台设备上还没有战绩');
    expect(html).not.toContain('class="achievements"');
    expect(html).toContain('data-variant="modal"');
  });
});
