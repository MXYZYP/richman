import { describe, expect, it } from 'vitest';
import type { LocalSaveCard, LocalSaveSummary } from '../session/localGameSave';
import { requestLocalDelete } from './localDeleteConfirmation';

function validCard(
  gameId: string,
  revision: number,
  recordToken: string,
  slot: 1 | 2 = 1,
): LocalSaveCard {
  const summary: LocalSaveSummary = {
    slot,
    gameId,
    revision,
    recordToken,
    title: '中国之旅',
    players: [{ nickname: '玩家一', isBot: false }, { nickname: '电脑A', isBot: true }],
    turn: revision,
    updatedAt: revision,
  };
  return { kind: 'valid', summary };
}

describe('local delete confirmation', () => {
  it('同一局刷新 revision 后仍提交第一次点击观察到的 record', () => {
    const armed = requestLocalDelete(null, validCard('game-1', 1, 'revision-1-raw'));
    const confirmed = requestLocalDelete(armed.confirmation, validCard('game-1', 2, 'revision-2-raw'));

    expect(confirmed).toEqual({
      confirmation: null,
      observed: { slot: 1, recordToken: 'revision-1-raw' },
    });
  });

  it('损坏存档刷新 raw 后仍提交第一次点击观察到的 record', () => {
    const armed = requestLocalDelete(null, {
      kind: 'invalid', slot: 2, reason: '存档内容已损坏，无法恢复', recordToken: 'broken-1',
    });
    const confirmed = requestLocalDelete(armed.confirmation, {
      kind: 'invalid', slot: 2, reason: '存档内容已损坏，无法恢复', recordToken: 'broken-2',
    });

    expect(confirmed.observed).toEqual({ slot: 2, recordToken: 'broken-1' });
  });

  it('同槽换成另一局时重新确认且没有沿用旧授权', () => {
    const armed = requestLocalDelete(null, validCard('game-1', 1, 'game-1-raw'));
    const changed = requestLocalDelete(armed.confirmation, validCard('game-2', 1, 'game-2-raw'));

    expect(changed.observed).toBeNull();
    expect(changed.confirmation).toMatchObject({
      key: 'slot-1-game-game-2',
      observed: { slot: 1, recordToken: 'game-2-raw' },
    });
  });

  it('另一槽出现相同 gameId 时重新确认且没有沿用旧槽授权', () => {
    const armed = requestLocalDelete(null, validCard('copied-game', 1, 'slot-1-raw', 1));
    const changed = requestLocalDelete(armed.confirmation, validCard('copied-game', 1, 'slot-2-raw', 2));

    expect(changed.observed).toBeNull();
    expect(changed.confirmation).toMatchObject({
      key: 'slot-2-game-copied-game',
      observed: { slot: 2, recordToken: 'slot-2-raw' },
    });
  });

  it('无法读取 raw 的错误卡不会进入确认态', () => {
    expect(requestLocalDelete(null, {
      kind: 'invalid', slot: 1, reason: '浏览器无法读取存档',
    })).toEqual({ confirmation: null, observed: null });
  });
});
