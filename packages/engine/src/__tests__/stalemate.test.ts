import { describe, it, expect } from 'vitest';
import { createGame, applyIntent } from '../engine';
import { chooseBotIntent } from '../bot';
import { defaultRuleModuleRegistry } from '../moduleRegistry';
import { chinaTourMap } from '@richman/board-data';

// D1 收敛性保证：现金目标关闭（cashGoal=null）的对局过去可能永不终局。
// 引入回合上限 maxTurns：到达上限且债务已清时，按净资产排名以 stalemate 终局，
// 保证「每一局都必然结束」。

function makeGame(maxTurns: number | null | undefined) {
  return createGame({
    board: chinaTourMap.game.board,
    cards: chinaTourMap.game.cards,
    config: chinaTourMap.game.config,
    mapRef: chinaTourMap.ref,
    ruleModules: chinaTourMap.game.requiredRuleModules,
    players: [
      { id: 'p1', nickname: 'P1', isBot: true },
      { id: 'p2', nickname: 'P2', isBot: true },
    ],
    seed: 'stalemate-seed',
    cashGoal: null,
    ...(maxTurns === undefined ? {} : { maxTurns }),
  });
}

describe('僵局终局（D1 收敛性保证）', () => {
  it('到达回合上限后按净资产排名以 stalemate 终局，保证每局必结束', () => {
    let state = makeGame(1);
    expect(state.phase).toBe('playing');
    expect(state.maxTurns).toBe(1);

    let guard = 0;
    while (state.phase !== 'game_over' && guard < 200) {
      const intent = chooseBotIntent(state, state.currentPlayerId, defaultRuleModuleRegistry);
      const r = applyIntent(state, state.currentPlayerId, intent, defaultRuleModuleRegistry);
      if (!r.ok) throw new Error('bot intent rejected: ' + JSON.stringify(r));
      state = r.state;
      guard += 1;
    }

    expect(state.phase).toBe('game_over');
    expect(state.winnerId).not.toBeNull();
    const over = state.recentLog.find((e) => e.type === 'game_over') as
      | { type: 'game_over'; winnerId: string; reason: string }
      | undefined;
    expect(over?.reason).toBe('stalemate');
  });

  it('默认上限为有限值（createGame 不传 maxTurns 也收敛）', () => {
    const s = makeGame(undefined);
    expect(s.maxTurns).toBeGreaterThan(0);
    expect(Number.isInteger(s.maxTurns)).toBe(true);
  });

  it('maxTurns 为 null 时关闭上限（向后兼容无限制行为）', () => {
    const s = makeGame(null);
    expect(s.maxTurns).toBeNull();
  });

  it('非法 maxTurns（0 / 负数 / 小数）被 createGame 拒绝', () => {
    expect(() => makeGame(0)).toThrow();
    expect(() => makeGame(-5)).toThrow();
    expect(() => makeGame(1.5)).toThrow();
  });
});
