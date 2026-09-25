import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import SettingsDialog from './SettingsDialog.vue';
import { currentRelease } from '../releaseCatalog';
import releaseNotes from '../../../../release-notes.json';

function renderSettings(props: Record<string, unknown> = {}): Promise<string> {
  return renderToString(createSSRApp({
    render: () => h(SettingsDialog as never, { open: true, ...props } as never),
  }));
}

describe('SettingsDialog', () => {
  it('桌面端是居中弹窗变体（不是摊平进侧栏的 inline 分组）', async () => {
    const html = await renderSettings();

    expect(html).toContain('data-variant="modal"');
    expect(html).toContain('设置');
    expect(html).toContain('aria-label="关闭设置"');
  });

  it('把散落各处的本机偏好收成四个分区', async () => {
    const html = await renderSettings();

    for (const group of ['外观', '声音', '规则说明', '应用']) {
      expect(html).toContain(group);
    }
    // 外观：三套皮肤 + 三档动画速度。
    for (const label of ['经典', '海洋', '暗夜', '慢速', '标准', '快速']) {
      expect(html).toContain(label);
    }
    // 声音：音效 / 背景音乐两个开关。
    expect(html).toContain('id="sfx-toggle"');
    expect(html).toContain('id="bgm-toggle"');
  });

  it('本机偏好语义要写清楚：只影响自己、不同步、不改对局状态', async () => {
    const html = await renderSettings();
    expect(html).toContain('不同步给他人');
    expect(html).toContain('不改变任何对局状态');
  });

  it('只有单机对局才显示悔棋/回放', async () => {
    const local = await renderSettings({ isLocalGame: true, canUndo: true });
    expect(local).toContain('对局操作');
    expect(local).toContain('撤回上一步');
    expect(local).toContain('观看本局回放');

    const online = await renderSettings({ isLocalGame: false });
    expect(online).not.toContain('对局操作');
    expect(online).not.toContain('撤回上一步');
  });

  it('悔棋/回放按钮跟随可用性禁用', async () => {
    const disabled = await renderSettings({ isLocalGame: true, canUndo: false, canReplay: false });
    expect(disabled.match(/disabled/g)?.length ?? 0).toBeGreaterThanOrEqual(2);

    const enabled = await renderSettings({ isLocalGame: true, canUndo: true, canReplay: true });
    const undoButton = enabled.slice(enabled.indexOf('撤回上一步') - 200, enabled.indexOf('撤回上一步'));
    expect(undoButton).not.toContain('disabled');
  });

  it('复盘入口与悔棋/回放同组，且只在单机出现（#115）', async () => {
    const local = await renderSettings({ isLocalGame: true });
    expect(local).toContain('复盘');
    expect(local).toContain('导出 / 导入复盘码');
    // 「复盘只导得出单机」这件事必须写在面板里：否则联机玩家会满处找这个按钮。
    expect(local).toContain('复盘码也只导得出单机对局');

    const online = await renderSettings({ isLocalGame: false });
    expect(online).not.toContain('导出 / 导入复盘码');
  });

  it('胜利条件只在有现金目标时出现', async () => {
    const withGoal = await renderSettings({ cashGoal: 50000 });
    expect(withGoal).toContain('胜利条件：现金达到 50,000。');

    const withoutGoal = await renderSettings({ cashGoal: null });
    expect(withoutGoal).not.toContain('胜利条件');
  });

  it('会话级操作（退出/投降）只移动端抽屉里给出', async () => {
    const mobile = await renderSettings({
      showSessionActions: true,
      canSurrender: true,
      exitLabel: '离开房间',
    });
    expect(mobile).toContain('离开房间');
    expect(mobile).toContain('投降');

    const desktop = await renderSettings({ showSessionActions: false, canSurrender: true });
    expect(desktop).not.toContain('投降');
  });
});

describe('SettingsDialog：声音分区（#13 音量滑块）', () => {
  it('音效与背景音乐各自一条音量滑块，并显示百分比', async () => {
    const html = await renderSettings();

    expect(html).toContain('id="sfx-volume"');
    expect(html).toContain('id="bgm-volume"');
    expect(html).toContain('音效音量');
    expect(html).toContain('音乐音量');
    // 两条都是原生 range，范围固定 0~100、步进 5 —— 与组件里的百分比换算一致。
    expect(html.match(/type="range"/g)).toHaveLength(2);
    for (const input of html.match(/<input[^>]*id="(?:sfx|bgm)-volume"[^>]*>/g) ?? []) {
      expect(input).toContain('min="0"');
      expect(input).toContain('max="100"');
      expect(input).toContain('step="5"');
    }
    // 开关仍然在（滑块是补充，不是替换）。
    expect(html).toContain('id="sfx-toggle"');
    expect(html).toContain('id="bgm-toggle"');
  });

  it('音量语义写清楚：归零等同静音、与开关相互独立、只影响本机', async () => {
    const html = await renderSettings();
    expect(html).toContain('等同于静音');
    expect(html).toContain('只影响本机');
  });
});

describe('SettingsDialog：规则说明按当前地图渲染（#13）', () => {
  it('传入地图 id 时，渲染该地图的真实数值而不是通用要点', async () => {
    const html = await renderSettings({ mapId: 'pearl-tour' });

    expect(html).toContain('《珠江之旅》规则要点');
    expect(html).toContain('珠江之旅 · 48 格');
    expect(html).toContain('¥15,000');
    expect(html).toContain('每块地产最多 5 级');
    expect(html).toContain('每回合 10%');
    expect(html).toContain('13 档（¥1,600 ~ ¥4,500）');
    expect(html).toContain('4 处（租金随持有数递增）');
    // #23 起珠江之旅挂上了 port-trade：规则模块行不再是「仅核心规则」，而是模块中文名 + 玩法提示。
    expect(html).toContain('湾区口岸');
    expect(html).toContain('【湾区口岸】');
    expect(html).toContain('押注掷骰');
    expect(html).not.toContain('仅核心规则');
    expect(html).toContain('¥30,000 或 ¥50,000');
    // 有地图上下文时不再提示「选好地图进入对局后…」。
    expect(html).not.toContain('选好地图进入对局后');
  });

  it('带特化规则模块的地图会多出一句模块提示', async () => {
    const html = await renderSettings({ mapId: 'great-wall' });

    expect(html).toContain('《长城之旅》规则要点');
    expect(html).toContain('烽火台');
    expect(html).toContain('通行费');
    expect(html).toContain('6 座');
  });

  it('没有地图上下文时回落到通用要点，并说明进对局后会换成真实数值', async () => {
    const html = await renderSettings();

    expect(html).toContain('本局规则要点');
    expect(html).toContain('选好地图进入对局后');
    // 通用要点里不该出现任何具体格数 / 档位数字。
    expect(html).not.toContain('· 48 格');
    expect(html).not.toContain('档（');
  });

  it('未知地图 id 也回落到通用要点，不会抛错', async () => {
    const html = await renderSettings({ mapId: 'ghost-map' });
    expect(html).toContain('本局规则要点');
    expect(html).toContain('选好地图进入对局后');
  });
});

describe('SettingsDialog：应用分区（#13 版本与恢复默认）', () => {
  it('给出当前版本与更新说明入口', async () => {
    const html = await renderSettings();
    expect(html).toContain('更新说明');
    expect(html).toContain(`v${currentRelease.version}`);
  });

  it('给出恢复默认设置入口，并说明只重置本机偏好', async () => {
    const html = await renderSettings();
    expect(html).toContain('恢复默认设置');
    expect(html).toContain('不碰账号、存档与正在进行的对局');
  });

  it('更新说明正文在玩家点开之前不进入已渲染文本', async () => {
    const html = await renderSettings();

    // 触发按钮照常在（这就是「版本」那一行的入口）。
    expect(html).toContain('更新说明');
    expect(html).toContain(`v${currentRelease.version}`);
    // 但整份历史更新说明要等玩家真的点开才渲染：设置面板嵌在大厅与对局视图里，
    // 预先渲染会把「请重新开局」「添加电脑玩家」这类**历史条目文案**混进这两个视图的
    // 已渲染文本，误伤它们「观战者不该看到某某字样」的断言。
    expect(html).not.toContain('role="region" aria-label="更新说明列表"');
    for (const release of releaseNotes.releases) {
      for (const change of release.changes) expect(html).not.toContain(change);
    }
  });
});
