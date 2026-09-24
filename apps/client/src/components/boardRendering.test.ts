import { computed, createSSRApp, h, ref, shallowRef } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import { createGame } from '@richman/engine';
import type { MapPack } from '@richman/board-data';
import testBoard from '../../../../packages/board-data/maps/__test__/test-map-v1/board.json';
import testCards from '../../../../packages/board-data/maps/__test__/test-map-v1/cards.json';
import testConfig from '../../../../packages/board-data/maps/__test__/test-map-v1/game-config.json';
import testManifest from '../../../../packages/board-data/maps/__test__/test-map-v1/manifest.json';
import { resolveLocalGameState } from '../game/mapResolver';
import GameBoard from './GameBoard.vue';
import GameSetup from './GameSetup.vue';
import { createDefaultGameSetup } from '../game/gameSetup';
import GameView from '../views/GameView.vue';
import type { GameSession } from '../session/gameSession';
import type { ChatMessage } from '@richman/protocol';

const harbor = {
  ref: testManifest.ref,
  metadata: testManifest.metadata,
  game: {
    board: testBoard,
    cards: testCards,
    config: testConfig,
    requiredRuleModules: testManifest.requiredRuleModules,
  },
  presentation: testManifest.presentation,
} as unknown as MapPack;

function harborState() {
  return resolveLocalGameState(createGame({
    mapRef: harbor.ref,
    ruleModules: harbor.game.requiredRuleModules,
    board: harbor.game.board,
    cards: harbor.game.cards,
    config: harbor.game.config,
    seed: 'harbor-component-render',
    players: [
      { id: 'p1', nickname: 'A' },
      { id: 'p2', nickname: 'B' },
    ],
  }), () => harbor);
}

describe('generic map Vue rendering', () => {
  it('让 8 格非连续 ID 的 test-only map 真实经过 GameBoard renderer', async () => {
    const html = await renderToString(createSSRApp({
      render: () => h(GameBoard, { state: harborState() }),
    }));

    expect((html.match(/查看格子详情：/gu) ?? [])).toHaveLength(8);
    for (const label of ['Launch', 'Cedar', 'Signal', 'Fee', 'Market', 'Current', 'Tide', 'Lantern']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('HARBOR');
  });

  it('通过 exact app resolver 渲染 cell artwork 与 center image', async () => {
    const state = harborState();
    const stateWithAssets = {
      ...state,
      presentation: {
        ...state.presentation,
        cells: {
          ...state.presentation.cells,
          0: {
            ...state.presentation.cells[0]!,
            artwork: { type: 'local-asset' as const, path: 'assets/launch.webp' as const },
          },
        },
        center: [{
          type: 'image' as const,
          x: 20, y: 20, width: 20, height: 20, role: 'center' as const,
          asset: { type: 'local-asset' as const, path: 'assets/harbor.webp' as const },
          accessibilityLabel: 'Harbor artwork',
        }],
      },
    };
    const assetResolver = (_ref: MapPack['ref'], path: string) => `/bundled/${path}`;
    const html = await renderToString(createSSRApp({
      render: () => h(GameBoard, { state: stateWithAssets, assetResolver }),
    }));

    expect(html).toContain('src="/bundled/assets/launch.webp"');
    expect(html).toContain('src="/bundled/assets/harbor.webp"');
    expect(html).toContain('alt="Harbor artwork"');
  });

  it('empty/stale map catalog 经过 GameSetup renderer 时显示不可用而不崩溃', async () => {
    const emptyDependencies = {
      catalog: [],
      resolveActive: () => { throw new Error('unavailable'); },
    };
    const emptyHtml = await renderToString(createSSRApp({
      render: () => h(GameSetup, {
        initialSetup: createDefaultGameSetup(emptyDependencies),
        dependencies: emptyDependencies,
      }),
    }));

    expect(emptyHtml).toContain('所选地图当前不可用');
    expect(emptyHtml).toContain('disabled');

    const staleSetup = { ...createDefaultGameSetup(), mapId: 'retired-map' };
    const staleHtml = await renderToString(createSSRApp({
      render: () => h(GameSetup, { initialSetup: staleSetup }),
    }));
    expect(staleHtml).toContain('所选地图当前不可用');
  });

  it('state 被清除后仍把 exact-map compatibility error 持续显示给用户', async () => {
    const session: GameSession = {
      mode: 'online',
      state: shallowRef(null),
      room: shallowRef(null),
      localPlayerId: ref('p1'),
      connectionStatus: ref('connected'),
      displayPositions: ref({}),
      dice: ref(null),
      activeCard: ref(null),
      eventMessage: ref(''),
      isAnimating: ref(false),
      isBotThinking: ref(false),
      lastError: ref(null),
      compatibilityError: ref('当前客户端缺少房间所需地图，请刷新或更新后重试。'),
      cashNotices: ref([]),
      displayCash: ref({}),
      transientNotice: ref(null),
      availableActions: computed(() => []),
      async sendIntent() {},
      async skipOfflineTurn() {},
      async leave() {},
      dispose() {},
      chatLog: ref<ChatMessage[]>([]),
      sendChat() {},
      async retryResume() {},
    };
    const html = await renderToString(createSSRApp({
      render: () => h(GameView, { session }),
    }));

    expect(html).toContain('当前客户端缺少房间所需地图，请刷新或更新后重试。');
    expect(html).toContain('返回首页');
  });

  it('对局内提供统一设置入口：桌面侧栏按钮 + modal 变体弹窗（#13）', async () => {
    const session: GameSession = {
      mode: 'local',
      state: shallowRef(harborState()),
      room: shallowRef(null),
      localPlayerId: ref('p1'),
      connectionStatus: ref('connected'),
      displayPositions: ref({}),
      dice: ref(null),
      activeCard: ref(null),
      eventMessage: ref(''),
      isAnimating: ref(false),
      isBotThinking: ref(false),
      lastError: ref(null),
      compatibilityError: ref(null),
      cashNotices: ref([]),
      displayCash: ref({}),
      transientNotice: ref(null),
      availableActions: computed(() => []),
      canUndo: ref(true),
      canReplay: ref(true),
      async sendIntent() {},
      async skipOfflineTurn() {},
      async undo() {},
      async replay() {},
      async leave() {},
      dispose() {},
      chatLog: ref<ChatMessage[]>([]),
      sendChat() {},
      async retryResume() {},
    };
    const html = await renderToString(createSSRApp({
      render: () => h(GameView, { session }),
    }));

    // 桌面侧栏的设置按钮（此前桌面完全没有设置入口，设置行直接摊在侧栏里）。
    expect(html).toContain('settings-open-button');
    // 设置弹窗用 modal 变体，桌面保持居中弹窗而不是摊平进侧栏。
    expect(html).toContain('data-variant="modal"');
    for (const group of ['外观', '声音', '对局操作', '规则说明', '应用']) {
      expect(html).toContain(group);
    }
    // 资产/战报/聊天这几个抽屉仍是 inline 变体，行为不变。
    expect(html).toContain('data-variant="inline"');
  });
});
