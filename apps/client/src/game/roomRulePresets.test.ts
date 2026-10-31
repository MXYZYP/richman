import { describe, expect, it } from 'vitest';
import {
  RULE_PRESETS,
  matchRulePreset,
  rulePresetTarget,
  sprintCashGoal,
  type RulePresetDefaults,
  type RulePresetSnapshot,
} from './roomRulePresets';
import { TURN_TIME_LIMIT_OPTIONS } from '@richman/protocol';

const DEFAULTS: RulePresetDefaults = {
  initialCash: 15000,
  maxHouseLevel: 5,
  mortgageInterestRate: 0.1,
};

function snapshotOf(id: 'standard' | 'sprint' | 'auction'): RulePresetSnapshot {
  const target = rulePresetTarget(id, DEFAULTS);
  return {
    ruleConfig: target.ruleConfig,
    cashGoal: target.cashGoal,
    auctionOnDecline: target.auctionOnDecline,
    minimalUndoEnabled: target.minimalUndoEnabled,
    turnTimeLimitSec: target.turnTimeLimitSec,
  };
}

describe('房规预设：展开结果', () => {
  it('三档都有标题与说明，且 id 唯一', () => {
    expect(RULE_PRESETS.map((p) => p.id)).toEqual(['standard', 'sprint', 'auction']);
    for (const preset of RULE_PRESETS) {
      expect(preset.title.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
    }
  });

  it('三档都不改「初始资金 / 房级 / 利率」——那三项是难度基线，不是玩法档位', () => {
    for (const preset of RULE_PRESETS) {
      expect(rulePresetTarget(preset.id, DEFAULTS).ruleConfig).toBeNull();
    }
  });

  it('标准局 = 全地图默认：无目标、不拍卖、不限时', () => {
    const target = rulePresetTarget('standard', DEFAULTS);
    expect(target.cashGoal).toBeNull();
    expect(target.auctionOnDecline).toBe(false);
    expect(target.minimalUndoEnabled).toBe(false);
    expect(target.turnTimeLimitSec).toBe(0);
  });

  it('竞速局 = 3 倍现金目标 + 30 秒限时', () => {
    const target = rulePresetTarget('sprint', DEFAULTS);
    expect(target.cashGoal).toBe(45000);
    expect(target.turnTimeLimitSec).toBe(30);
    expect(target.auctionOnDecline).toBe(false);
  });

  it('拍卖局 = 放弃即拍卖 + 60 秒限时 + 不设现金目标', () => {
    const target = rulePresetTarget('auction', DEFAULTS);
    expect(target.auctionOnDecline).toBe(true);
    expect(target.turnTimeLimitSec).toBe(60);
    expect(target.cashGoal).toBeNull();
  });

  it('每档限时都必须是协议里的合法档位（防止随手写个 45 秒）', () => {
    for (const preset of RULE_PRESETS) {
      expect(TURN_TIME_LIMIT_OPTIONS).toContain(rulePresetTarget(preset.id, DEFAULTS).turnTimeLimitSec);
    }
  });
});

describe('竞速现金目标', () => {
  it('严格大于初始资金（引擎的硬约束）', () => {
    for (const initialCash of [1, 500, 1000, 1500, 15000, 99999]) {
      expect(sprintCashGoal(initialCash)).toBeGreaterThan(initialCash);
    }
  });

  it('按整千向上取整', () => {
    expect(sprintCashGoal(15000)).toBe(45000);
    expect(sprintCashGoal(12000)).toBe(36000);
    expect(sprintCashGoal(12345)).toBe(38000);
  });

  it('初始资金异常小也不会产出非法目标', () => {
    expect(sprintCashGoal(0)).toBe(1);
    expect(sprintCashGoal(-100)).toBe(1);
    expect(sprintCashGoal(Number.NaN)).toBe(1);
  });
});

describe('当前设置落在哪一档', () => {
  it('三档各自展开后都能被认回来', () => {
    expect(matchRulePreset(snapshotOf('standard'), DEFAULTS)).toBe('standard');
    expect(matchRulePreset(snapshotOf('sprint'), DEFAULTS)).toBe('sprint');
    expect(matchRulePreset(snapshotOf('auction'), DEFAULTS)).toBe('auction');
  });

  it('反向：任一项被玩家改动后就不再是那一档（返回 null = 自定义）', () => {
    // 竞速局被改成不限时
    expect(matchRulePreset({ ...snapshotOf('sprint'), turnTimeLimitSec: 0 }, DEFAULTS)).toBeNull();
    // 竞速局被改了现金目标
    expect(matchRulePreset({ ...snapshotOf('sprint'), cashGoal: 99999 }, DEFAULTS)).toBeNull();
    // 拍卖局被关掉拍卖
    expect(matchRulePreset({ ...snapshotOf('auction'), auctionOnDecline: false }, DEFAULTS)).toBeNull();
    // 标准局被开了悔棋
    expect(matchRulePreset({ ...snapshotOf('standard'), minimalUndoEnabled: true }, DEFAULTS)).toBeNull();
    // 自定义了数值（即便其他项像标准局）
    expect(matchRulePreset({
      ...snapshotOf('standard'),
      ruleConfig: { initialCash: 20000, maxHouseLevel: 5, mortgageInterestRate: 0.1 },
    }, DEFAULTS)).toBeNull();
  });
});
