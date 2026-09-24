import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import { applyIntent, chooseBotIntent } from '@richman/engine';
import type { Intent } from '@richman/engine';
import { getActiveMapPack, listActiveMaps } from '@richman/board-data';
import { createDefaultGameSetup, updateGameSetupMapId } from '../game/gameSetup';
import { createInitialLocalGameState, createLocalSession } from '../session/localSession';
import { buildReplayPayload, prepareReplayPlayback, type ReplayPayload } from '../session/replayCode';
import { toLocalSaveCards, type LocalSaveSummary } from '../session/localGameSave';
import GameSetup from '../components/GameSetup.vue';
import GameView from './GameView.vue';
import HomeView from './HomeView.vue';

const newer: LocalSaveSummary = {
  slot: 2,
  gameId: 'newer',
  revision: 2,
  recordToken: 'newer-record',
  title: '中国之旅',
  players: [{ nickname: '小明', isBot: false }, { nickname: '电脑A', isBot: true }],
  turn: 12,
  updatedAt: Date.UTC(2026, 6, 16, 8, 30),
};
const older: LocalSaveSummary = {
  slot: 1,
  gameId: 'older',
  revision: 1,
  recordToken: 'older-record',
  title: '海港环线',
  players: [{ nickname: '小红', isBot: false }, { nickname: '小蓝', isBot: false }],
  turn: 4,
  updatedAt: Date.UTC(2026, 6, 15, 8, 30),
};

/**
 * 造一份「真推演出来」的复盘载荷（#115）：用引擎自己的 bot 策略推进一局，收下每一步真实
 * 执行过的意图。这里只需要载荷本身，正确性由 replayCode.test.ts 的往返用例守着。
 */
function buildDeterministicReplay(seed: string, steps: number): { payload: ReplayPayload; steps: number } {
  const players = [
    { id: 'p1', nickname: '玩家一' },
    { id: 'p2', nickname: '电脑A', isBot: true },
    { id: 'p3', nickname: '电脑B', isBot: true },
  ];
  const initial = createInitialLocalGameState({
    mapPack: getActiveMapPack('china-tour'),
    players,
    seed,
    cashGoal: null,
  });

  let state = initial;
  const intents: Intent[] = [];
  for (let index = 0; index < steps && state.phase !== 'game_over'; index += 1) {
    const actorId = state.debt?.debtorId ?? state.currentPlayerId;
    const intent = chooseBotIntent(state, actorId);
    const result = applyIntent(state, actorId, intent);
    if (!result.ok) throw new Error(`engine rejected its own bot intent (${result.code})`);
    state = result.state;
    intents.push(intent);
  }

  return {
    payload: buildReplayPayload({ initialState: initial, recipe: { seed, players }, intents, createdAt: 0 }),
    steps: intents.length,
  };
}

describe('local resume UI', () => {
  it('把 valid cards 按 updatedAt 倒序，并保留 invalid/incompatible slot 可见', () => {
    const cards = toLocalSaveCards([
      { kind: 'valid', slot: 1, save: {} as any, summary: older, recordToken: 'older' },
      { kind: 'incompatible', slot: 2, reason: '该存档来自不兼容的游戏版本', recordToken: 'invalid' },
    ]);
    expect(cards).toEqual([
      { kind: 'valid', summary: older },
      { kind: 'invalid', slot: 2, reason: '该存档来自不兼容的游戏版本', recordToken: 'invalid' },
    ]);

    expect(toLocalSaveCards([
      { kind: 'valid', slot: 1, save: {} as any, summary: older, recordToken: 'older' },
      { kind: 'valid', slot: 2, save: {} as any, summary: newer, recordToken: 'newer' },
    ])).toEqual([
      { kind: 'valid', summary: newer },
      { kind: 'valid', summary: older },
    ]);
  });

  it('HomeView 渲染最多两张继续单机卡、玩家 bot 标记、回合、时间和二次删除动作', async () => {
    const html = await renderToString(createSSRApp({
      render: () => h(HomeView, {
        localSaveCards: [
          { kind: 'valid', summary: newer },
          { kind: 'invalid', slot: 1, reason: '存档内容已损坏，无法恢复', recordToken: 'broken' },
        ],
      }),
    }));

    expect(html).toContain('继续单机');
    expect(html).toContain('中国之旅');
    expect(html).toContain('小明');
    expect(html).toContain('电脑A（电脑）');
    expect(html).toContain('第 12 回合');
    expect(html).toContain('继续游戏');
    expect(html).toContain('删除存档');
    expect(html).toContain('无法恢复的本机存档');
    expect(html).toContain('存档内容已损坏，无法恢复');
  });


  it('GameSetup 可重新选择地图，并以首页所选地图作为初始值', async () => {
    const worldSetup = updateGameSetupMapId(createDefaultGameSetup(), 'world-tour');
    const worldHtml = await renderToString(createSSRApp({
      render: () => h(GameSetup, { initialSetup: worldSetup }),
    }));
    expect(worldHtml).toContain('aria-label="地图"');
    expect(worldHtml).toContain('世界之旅');
    // 地图选择已从原生 <select> 换成自定义 MapPicker（跨平台观感一致）；
    // 这里只剩「真人数量」「电脑数量」两个 <select>。
    expect(worldHtml.match(/<select/g)).toHaveLength(2);
    // MapPicker 的 span 会被 scoped CSS 追加 data-v-xxx 属性，故分两段断言。
    expect(worldHtml).toContain('map-picker-value');
    expect(worldHtml).toContain('世界之旅');

    const chinaSetup = createDefaultGameSetup();
    const chinaHtml = await renderToString(createSSRApp({
      render: () => h(GameSetup, { initialSetup: chinaSetup }),
    }));
    expect(chinaHtml).toContain(getActiveMapPack('china-tour').metadata.title);
    expect(chinaHtml.match(/<select/g)).toHaveLength(2);
  });

  it('HomeView 保留创建房间地图入口，并恢复首页原本选择的地图', async () => {
    const html = await renderToString(createSSRApp({
      render: () => h(HomeView, {
        activeMaps: listActiveMaps(),
        initialMapId: 'world-tour',
      }),
    }));
    // 首页本身不再使用原生 <select>（地图入口是 MapPicker），因此一个 <select> 都不应有。
    expect(html.match(/<select/g)).toBeNull();
    expect(html).toContain('世界之旅');
    expect(html).toContain('map-picker-value');
    expect(html).toContain('创建房间');
  });

  it('GameSetup 提供返回首页操作', async () => {
    const html = await renderToString(createSSRApp({
      render: () => h(GameSetup),
    }));
    expect(html).toContain('返回首页</button>');
  });

  it('GameSetup 显示 oldest replacement 确认且保留自定义 setup，并显示 storage 临时游戏选择', async () => {
    const initialSetup = createDefaultGameSetup();
    initialSetup.players[0]!.nickname = '保留的昵称';
    const html = await renderToString(createSSRApp({
      render: () => h(GameSetup, {
        initialSetup,
        replacementSummary: older,
        storageUnavailable: true,
        storagePrompt: true,
      }),
    }));

    expect(html).toContain('保留的昵称');
    expect(html).toContain('将替换最旧存档');
    expect(html).toContain('海港环线');
    expect(html).toContain('确认替换并开始');
    expect(html).toContain('取消');
    expect(html).toContain('aria-modal="true"');
    expect(html).toMatch(/<fieldset[^>]*disabled/);
    expect(html).toContain('开始游戏</button>');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>开始游戏<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>返回首页<\/button>/);
    expect(html).toContain('本浏览器无法保存进度，关闭页面后这局无法恢复');
    expect(html).toContain('重试保存');
    expect(html).toContain('开始临时游戏');
  });

  it('local GameView 的退出文案为保存并返回首页，online 文案不变', async () => {
    const session = createLocalSession({ wait: async () => undefined, seed: 'exit-label' });
    const localHtml = await renderToString(createSSRApp({ render: () => h(GameView, { session }) }));
    expect(localHtml).toContain('保存并返回首页');
    expect(localHtml).not.toContain('重新开局');
    session.dispose();
  });

  it('回看会话渲染出「复盘回看」横幅与退出路径，退出文案换成退出复盘（#115）', async () => {
    // 真造一份复盘再来回看：这一条守的是「回看会话在视图里长得像什么」，
    // 而不是「重放对不对」（那个在 replayCode.test.ts 里真推演过）。
    const played = buildDeterministicReplay('gameview-playback-banner', 20);
    const prepared = prepareReplayPlayback(played.payload);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const playback = createLocalSession({ ...prepared.options, autoPlayBots: false });
    const html = await renderToString(createSSRApp({ render: () => h(GameView, { session: playback }) }));

    expect(playback.isPlayback).toBe(true);
    expect(html).toContain('复盘回看');
    expect(html).toContain(`共 ${played.steps} 步`);
    expect(html).toContain('只能观看，不能操作');
    expect(html).toContain('重新播放');
    expect(html).toContain('退出复盘');
    // 回看不是「保存并返回首页」：它没有任何进度可保存。
    expect(html).not.toContain('保存并返回首页');
    playback.dispose();
  });
});
