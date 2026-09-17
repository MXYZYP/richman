import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import { getActiveMapPack } from '@richman/board-data';
import type { PublicRoomState } from '@richman/protocol';
import type { LobbyCommand } from '../session/onlineSession';
import LobbyView from './LobbyView.vue';

const chinaMapPack = getActiveMapPack('china-tour');
const CHINA_ROOM_MAP = { ref: chinaMapPack.ref, title: chinaMapPack.metadata.title };

function buildRoom(overrides: Partial<PublicRoomState> = {}): PublicRoomState {
  return {
    roomCode: '0007',
    status: 'lobby',
    hostId: 'player-host',
    players: [
      { id: 'player-host', nickname: '房主', isBot: false, online: true },
      { id: 'bot-a', nickname: '电脑 A', isBot: true, online: true },
    ],
    spectators: [],
    takeoverPlayerId: null,
    map: CHINA_ROOM_MAP,
    ...overrides,
  };
}

async function renderLobby(options: {
  room?: PublicRoomState;
  localPlayerId?: string;
  isHost?: boolean;
  pendingCommand?: LobbyCommand | null;
  isCommandReady?: boolean;
} = {}): Promise<string> {
  return renderToString(createSSRApp({
    render: () => h(LobbyView, {
      room: options.room ?? buildRoom(),
      localPlayerId: options.localPlayerId ?? 'player-host',
      isHost: options.isHost ?? true,
      startBlockedReason: null,
      pendingCommand: options.pendingCommand ?? null,
      isCommandReady: options.isCommandReady ?? true,
      inviteUrl: 'http://example.test/room/0007',
      connectionLabel: '已连接',
    }),
  }));
}

describe('LobbyView bot nickname editor', () => {
  it('renders one host-only rename input for each bot on every viewport', async () => {
    const html = await renderLobby({ isHost: true });

    expect(html.match(/lobby-bot-name-input/g)).toHaveLength(1);
    expect(html).not.toContain('lobby-bot-name-mobile');
    expect(html).toContain('aria-label="重命名 电脑 A"');
    expect(html).toContain('value="电脑 A"');
  });

  it('renders bot nicknames as text only for guests and after the game starts', async () => {
    const guestHtml = await renderLobby({ isHost: false });
    expect(guestHtml).not.toContain('lobby-bot-name-input');
    expect(guestHtml).not.toContain('lobby-bot-name-mobile');
    expect(guestHtml).toContain('电脑 A');

    const playingHtml = await renderLobby({ room: buildRoom({ status: 'playing' }), isHost: true });
    expect(playingHtml).not.toContain('lobby-bot-name-input');
    expect(playingHtml).not.toContain('lobby-bot-name-mobile');
    expect(playingHtml).toContain('电脑 A');
  });

  it('disables rename inputs while a lobby command is pending', async () => {
    const html = await renderLobby({ pendingCommand: 'renameBot' });

    const renameInput = html.match(/<input[^>]*class="lobby-bot-name-input"[^>]*>/)?.[0];
    expect(renameInput).toContain(' disabled');
  });
});

describe('LobbyView spectator roster', () => {
  it('shows empty-spectator copy and the 3-seat counter for hosts', async () => {
    const html = await renderLobby({ isHost: true });
    expect(html).toContain('观众 0/3');
    expect(html).toContain('参赛 2/6');
    expect(html).toContain('还没有观众。好友可在首页选择「观战」加入。');
    expect(html).toContain('aria-label="观众名单"');
  });

  it('lists spectators independently and hides host writes for a spectator', async () => {
    const html = await renderLobby({
      isHost: false,
      localPlayerId: 'spec-1',
      room: buildRoom({
        spectators: [
          { id: 'spec-1', nickname: '观众甲', online: true },
          { id: 'spec-2', nickname: '观众乙', online: false },
        ],
      }),
    });
    expect(html).toContain('观众 2/3');
    expect(html).toContain('观众甲');
    expect(html).toContain('观众乙');
    expect(html).toContain('aria-label="等待房主"');
    expect(html).not.toContain('aria-label="房主操作"');
    expect(html).not.toContain('添加电脑玩家');
    expect(html).not.toContain('开始游戏');
  });
});
