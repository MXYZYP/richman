import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import type { PlayerState } from '@richman/engine';
import { createDemoGameState } from '../game/demoState';
import PlayerRail from './PlayerRail.vue';

function makePlayers(): PlayerState[] {
  const players = createDemoGameState().players.map((player) => ({ ...player }));
  const fourth = {
    ...players[2]!,
    id: 'p4',
    nickname: '电脑C',
    color: 'green' as const,
  };
  return [...players, fourth];
}

async function renderRail(players: PlayerState[], currentPlayerId: string): Promise<string> {
  const app = createSSRApp({
    render: () => h(PlayerRail, {
      players,
      currentPlayerId,
      interactive: true,
      cashNotices: [],
    }),
  });
  return renderToString(app);
}

/** 按 DOM 顺序读出每个席位：昵称，以及是否渲染出“行动中”（主位标记）。*/
function seatsOf(html: string): { nickname: string; acting: boolean }[] {
  const marks = [...html.matchAll(/class="([^"]*\bplayer-slot\b[^"]*)"/g)];
  return marks.map((mark, index) => {
    const seat = html.slice(mark.index, marks[index + 1]?.index ?? html.length);
    const nickname = seat.match(/查看(.+?)的资产/)?.[1];
    if (nickname === undefined) throw new Error('Expected a seat aria-label');
    return { nickname, acting: seat.includes('行动中') };
  });
}

describe('PlayerRail visible players', () => {
  it('removes bankrupt players and derives the layout from the remaining players', async () => {
    const players = makePlayers();
    players[3] = {
      ...players[3]!,
      bankrupt: true,
      bankruptTurn: 8,
    };

    const html = await renderRail(players, players[0]!.id);

    expect(html).not.toContain('电脑C');
    expect(html).not.toContain('破产');
  });

  it('keeps all four active players in one four-player rail', async () => {
    const players = makePlayers();
    const html = await renderRail(players, players[0]!.id);

    for (const player of players) {
      expect(html).toContain(`查看${player.nickname}的资产`);
    }
    expect(html).toContain('电脑C');
  });
});

describe('PlayerRail seat order', () => {
  it.each([
    { count: 2, actorIndex: 1 },
    { count: 3, actorIndex: 1 },
    { count: 4, actorIndex: 0 },
    { count: 4, actorIndex: 2 },
    { count: 4, actorIndex: 3 },
  ])(
    'keeps every seat in its engine slot with $count players and actor index $actorIndex',
    async ({ count, actorIndex }) => {
      const players = makePlayers().slice(0, count);
      const html = await renderRail(players, players[actorIndex]!.id);
      const seats = seatsOf(html);

      expect(seats.map((seat) => seat.nickname)).toEqual(
        players.map((player) => player.nickname),
      );
      expect(seats.map((seat) => seat.acting)).toEqual(
        players.map((_, index) => index === actorIndex),
      );
    },
  );

  it('falls back to the first visible seat when the acting player is bankrupt', async () => {
    const players = makePlayers();
    players[1] = { ...players[1]!, bankrupt: true, bankruptTurn: 8 };
    const html = await renderRail(players, players[1]!.id);

    const seats = seatsOf(html);
    expect(seats.map((seat) => seat.nickname)).toEqual([
      players[0]!.nickname,
      players[2]!.nickname,
      players[3]!.nickname,
    ]);
    expect(seats.map((seat) => seat.acting)).toEqual([true, false, false]);
  });
});

// #94：5-6 人不再横滑，改成压缩网格 —— 一屏之内看得到全部席位，主位靠徽章 +「行动中」区分。
describe('PlayerRail 5-6 人压缩模式（#94）', () => {
  it('六个席位全部同屏渲染，主位仍只有一个', async () => {
    const players = makePlayers();
    const six = [
      ...players,
      { ...players[2]!, id: 'p5', nickname: '电脑D', color: 'purple' as const },
      { ...players[2]!, id: 'p6', nickname: '电脑E', color: 'orange' as const },
    ];

    const html = await renderRail(six, six[4]!.id);

    const seats = seatsOf(html);
    expect(seats.map((seat) => seat.nickname)).toEqual(six.map((player) => player.nickname));
    expect(seats.map((seat) => seat.acting)).toEqual([false, false, false, false, true, false]);
    expect(html).toContain('player-seats compact');
    // 横滑类必须消失：「轮到谁」不该需要左右滑动去找。
    expect(html).not.toContain('seat-scroll');
  });

  it('5 人起启用压缩模式，4 人仍走常规网格', async () => {
    const players = makePlayers();
    const five = [...players, { ...players[2]!, id: 'p5', nickname: '电脑D', color: 'purple' as const }];

    expect(await renderRail(five, five[0]!.id)).toContain('player-seats compact');
    expect(await renderRail(players, players[0]!.id)).not.toContain('player-seats compact');
  });
});
