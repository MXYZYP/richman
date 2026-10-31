import { describe, expect, it } from 'vitest';
import { buildBattleReport, type BattleReportPlayer } from './battleReport';

/** 战报里的金额格式由调用方注入：这里用最简单的「值 + 单位」来观察它有没有被真的用上。 */
const formatAsset = (value: number): string => `${value} 两`;

function player(partial: Partial<BattleReportPlayer> = {}): BattleReportPlayer {
  return {
    name: '阿橘',
    cash: 12_000,
    isWinner: false,
    isBankrupt: false,
    isBot: false,
    survivedTurns: 30,
    propertyCount: 2,
    ...partial,
  };
}

describe('战报文案', () => {
  it('含地图名与冠军，冠军标注打到第几回合', () => {
    const text = buildBattleReport({
      mapTitle: '中国之旅',
      players: [
        player({ name: '阿橘', isWinner: true, survivedTurns: 42, cash: 33_000 }),
        player({ name: '小明', cash: 8_000 }),
      ],
      formatAsset,
    });

    expect(text).toContain('中国之旅');
    expect(text).toContain('冠军：阿橘');
    expect(text).toContain('第 42 回合');
  });

  it('名次按「冠军在前、其余现金降序」排，与结算表同一套观感', () => {
    const text = buildBattleReport({
      mapTitle: '运城',
      players: [
        player({ name: '穷鬼', cash: 1_000 }),
        player({ name: '冠军哥', cash: 5_000, isWinner: true }),
        player({ name: '富哥', cash: 9_000 }),
      ],
      formatAsset,
    });

    const order = ['冠军哥', '富哥', '穷鬼'].map((name) => text.indexOf(name));
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
  });

  it('破产者写「破产出局」而不是一个 0 元资产', () => {
    const text = buildBattleReport({
      mapTitle: '运城',
      players: [player({ name: '小明', isBankrupt: true, cash: 0 })],
      formatAsset,
    });
    expect(text).toContain('破产出局');
  });

  it('金额一律走注入的格式化函数（模块自己不拼单位）', () => {
    const text = buildBattleReport({
      mapTitle: '世界之旅',
      players: [player({ name: '阿橘', cash: 20_000 })],
      formatAsset: (value) => `${value} 金币`,
    });
    // 注入什么就显示什么：模块自己不补千分位、也不补单位。
    expect(text).toContain('20000 金币');
    expect(text).not.toContain('两');
  });

  it('有结束原因就带上，没有就不硬塞一行', () => {
    const withReason = buildBattleReport({
      mapTitle: '运城',
      players: [player({ isWinner: true })],
      reason: '所有对手已破产，本局结束',
      formatAsset,
    });
    expect(withReason).toContain('所有对手已破产');

    const without = buildBattleReport({ mapTitle: '运城', players: [player({ isWinner: true })], formatAsset });
    expect(without.split('\n').some((line) => line.startsWith('所有对手'))).toBe(false);
  });

  it('无人夺冠时也要有交代，不写「冠军：」后面空着', () => {
    const text = buildBattleReport({
      mapTitle: '运城',
      players: [player({ name: '甲' }), player({ name: '乙' })],
      formatAsset,
    });
    expect(text).toContain('无人夺冠');
    expect(text).not.toContain('冠军：');
  });

  it('纯文本、不含 HTML 标签（是要粘进聊天窗口的）', () => {
    const text = buildBattleReport({
      mapTitle: '运城',
      players: [player({ isWinner: true })],
      formatAsset,
    });
    expect(text).not.toMatch(/<[a-z/]/i);
    expect(text.split('\n').length).toBeGreaterThanOrEqual(3);
  });

  it('电脑玩家标注出来，别让人以为是真人', () => {
    const text = buildBattleReport({
      mapTitle: '运城',
      players: [player({ name: '电脑·稳健', isBot: true })],
      formatAsset,
    });
    expect(text).toContain('电脑·稳健（电脑）');
  });
});
