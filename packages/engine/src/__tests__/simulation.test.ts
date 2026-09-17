import { describe, it, expect } from 'vitest';
import { runGame, runSimulation, randomConfigs } from '../simulate';
import { worldTourMap } from '@richman/board-data';

// 属性测试（03 §4.4 合法性保证）+ 现金守恒（M2 收尾）
// 全 bot 自弈：每个决策点 chooseBotIntent 出招、applyIntent 结算。
// 三大硬不变量必须对所有局成立——与是否终局无关：
//   1. 合法性：bot 的每个 intent 都被 applyIntent 接受（illegalIntents === 0）
//   2. 现金守恒：sum(玩家现金) + bankBalance === initialCash × 人数（conservationViolations === 0）
//   3. 无异常（exception === null）
// 终局率：cashGoal != null 的局应在上限内终局；cashGoal = null 因 v1 保守策略 + 工资注水
//        可能撞上限（设计评审预登记的预期结果），不作为硬失败。

const CI_GAMES = 50;
const CI_CAP = 1500; // CI 单局意图上限（保证测试快速；正式 500 局脚本用 3000）

describe('随机自弈属性测试（03 §4.4 合法性 + 现金守恒）', () => {
  const results = randomConfigs(CI_GAMES).map((c) => runGame(c, CI_CAP));

  it('所有局的 bot 决策都合法（illegalIntents === 0）', () => {
    const illegal = results.filter((r) => r.illegalIntents > 0);
    expect(illegal).toEqual([]);
  });

  it('所有局现金守恒不变量成立（conservationViolations === 0）', () => {
    const violated = results.filter((r) => r.conservationViolations > 0);
    expect(violated).toEqual([]);
  });

  it('所有局无异常抛出', () => {
    const crashed = results.filter((r) => r.exception !== null);
    expect(crashed).toEqual([]);
  });

  it('终局可达：至少一局 cashGoal != null 终局（证明 game_over 路径未坏）', () => {
    // 注：设计评审预登记——v1 保守策略把现金持续投入买地/盖房，
    // 即便 cashGoal != null 也可能很久才有人凑足现金目标、甚至撞上限。
    // 终局率是产品行为问题（须 owner 定夺），此处只做"可达性" sanity。
    const withGoal = results.filter((r) => r.config.cashGoal !== null);
    expect(withGoal.length).toBeGreaterThan(0);
    const terminated = withGoal.filter((r) => r.terminated);
    expect(terminated.length).toBeGreaterThan(0);
  });
});

describe('runSimulation 汇总统计', () => {
  it('runSimulation 调用 runGame 时不能把数组下标误传为 maxTurns', () => {
    const config = { seed: 'map-index-regression', playerCount: 2, cashGoal: 30000 };
    const single = runGame(config);
    const stats = runSimulation([config]);
    expect(single.turns).toBeGreaterThan(0);
    expect(stats.maxTurns).toBe(single.turns);
  });

  it('统计字段结构正确且与单局结果一致', () => {
    const stats = runSimulation(randomConfigs(12));
    expect(stats.totalGames).toBe(12);
    expect(stats.terminated).toBeLessThanOrEqual(12);
    expect(stats.avgTurns).toBeGreaterThan(0);
    expect(typeof stats.medianTurns).toBe('number');
    expect(stats.failures.length).toBeGreaterThanOrEqual(0);
    // illegalIntents / conservationViolations / exceptions 汇总应与单局和一致
    expect(stats.illegalIntents).toBe(0);
    expect(stats.conservationViolations).toBe(0);
    expect(stats.exceptions).toBe(0);
  });

  it('可对指定的正式地图运行同一套 bot 合法性、现金守恒和异常检查', () => {
    const single = runGame(
      { seed: 'world-simulation-map', playerCount: 3, cashGoal: 30000 },
      CI_CAP,
      worldTourMap,
    );
    const stats = runSimulation(randomConfigs(12, 9000), worldTourMap);

    expect(single.mapRef).toEqual(worldTourMap.ref);
    expect(stats.totalGames).toBe(12);
    expect(stats.illegalIntents).toBe(0);
    expect(stats.conservationViolations).toBe(0);
    expect(stats.exceptions).toBe(0);
  });

  it('世界之旅的合法长局不会被 China Tour 的旧仿真上限误判为失败', () => {
    const result = runGame(
      { seed: 'sim-101', playerCount: 4, cashGoal: null },
      undefined,
      worldTourMap,
    );

    expect(result.terminated).toBe(true);
    expect(result.winReason).toBe('last_standing');
    expect(result.illegalIntents).toBe(0);
    expect(result.conservationViolations).toBe(0);
    expect(result.exception).toBeNull();
  });
});
