import { describe, expect, it } from 'vitest';
import LeaderboardView from './LeaderboardView.vue';
import { renderView, withLocalStorage } from './viewTestSupport';

/**
 * 「成就排行榜」详情页（《UI 改造方案》§四）。
 *
 * 这是唯一会把数据发出去的页面（昵称 + 四个聚合数字），所以此处的重点全在
 * 「点了才上传」这句话有没有写在伸手可及的地方 —— 它要是消失了，这个功能就从
 * 「顺手的加分项」变成了「偷偷上传玩家数据」。
 *
 * 认这块 UI 一律用**结构标记**（id / class），不要用「成就排行榜」这类中文文案：
 * 更新说明正文里本来就会写到「成就排行榜」（2026-09-24 发版 v2.14.0 时实测踩到），
 * 拿文案当标记，两条方向相反的断言会**同时**变得没有判别力。
 */
function renderLeaderboard(): Promise<string> {
  return renderView(LeaderboardView, { open: true });
}

describe('LeaderboardView 排行榜（#116）', () => {
  it('说清「点了才上传、只传四个数字」，且不自动取数时不假装已有榜单', async () => {
    const html = await withLocalStorage(renderLeaderboard);

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

  it('落榜 / 未上榜时不渲染「你目前第 N 名」这行', async () => {
    const html = await withLocalStorage(renderLeaderboard);

    // `leaderboardRank` 初值是 null：名次行必须整段不渲染。
    expect(html).not.toContain('你目前第');
  });

  it('没有本机存储时弹窗照样可达 —— 只是没法上榜，榜单本身仍要能拉', async () => {
    // node 环境本来就没有 localStorage：这里读到的就是「无存储」。
    const html = await renderLeaderboard();

    expect(html).toContain('data-variant="modal"');
    expect(html).toContain('id="leaderboard-title"');
    expect(html).toContain('正在加载榜单…');
  });
});
