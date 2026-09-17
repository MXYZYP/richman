import { describe, expect, it } from 'vitest';
import * as formatters from './format';

type CashNotice = {
  generation: number;
  transitionId: number;
  playerId: string;
  delta: number;
};

const cashFormatters = formatters as typeof formatters & {
  formatCashDelta?: (delta: number) => string;
  formatCashAnnouncement?: (
    players: Array<{ id: string; nickname: string }>,
    notices: CashNotice[],
  ) => string;
};

const players = [
  { id: 'p1', nickname: '玩家一' },
  { id: 'p2', nickname: '玩家二' },
];

describe('cash feedback formatting', () => {
  it('formats cash deltas with explicit signs and localized amounts', () => {
    expect(cashFormatters.formatCashDelta?.(1000)).toBe('+¥1,000');
    expect(cashFormatters.formatCashDelta?.(-1000)).toBe('−¥1,000');
  });

  it('announces known players from the latest transition in notice order', () => {
    expect(
      cashFormatters.formatCashAnnouncement?.(players, [
        { generation: 1, transitionId: 3, playerId: 'p1', delta: -500 },
        { generation: 1, transitionId: 3, playerId: 'p2', delta: 500 },
      ]),
    ).toBe('玩家一减少 ¥500；玩家二增加 ¥500');
  });

  it('ignores notices for unknown players', () => {
    expect(
      cashFormatters.formatCashAnnouncement?.(players, [
        { generation: 1, transitionId: 3, playerId: 'missing', delta: 1000 },
      ]),
    ).toBe('');
  });

  it('does not repeat retained notices from an older transition', () => {
    expect(
      cashFormatters.formatCashAnnouncement?.(players, [
        { generation: 1, transitionId: 1, playerId: 'p1', delta: -500 },
        { generation: 1, transitionId: 2, playerId: 'p2', delta: 500 },
      ]),
    ).toBe('玩家二增加 ¥500');
  });

  it('prioritizes the newest generation before transition id', () => {
    expect(
      cashFormatters.formatCashAnnouncement?.(players, [
        { generation: 1, transitionId: 99, playerId: 'p1', delta: -500 },
        { generation: 2, transitionId: 1, playerId: 'p2', delta: 500 },
      ]),
    ).toBe('玩家二增加 ¥500');
  });
});
