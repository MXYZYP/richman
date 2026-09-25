import { describe, it, expect } from 'vitest';
import { runGame, runSimulation, randomConfigs } from '../simulate';
import {
  PRODUCTION_RULE_MODULES,
  getActiveMapPack,
  listActiveMaps,
  worldTourMap,
} from '@richman/board-data';

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

// #23 之后每张正式地图都挂了自己的规则模块。原先把仿真固定在 china-tour + world-tour，
// 于是 great-wall / prison 的记账缺口能长期潜伏 —— 实测被漏掉的「只扣现金、不留银行流水」共 7 处：
// 认领烽火台 600、保释金 1500、换乘车费 500、票号存入 1000、集市进货 500、扎营费 600、顺流船费 400。
// 这类缺口一旦发生，守恒差额会永久留在账上，之后每一步都被判为违例（china-tour 单局曾累计 902 步）。
// 改成「所有正式地图 × 3 局」后，新增地图 / 新增模块自动纳入，不再依赖手工补测。
describe('全部正式地图都跑同一套不变量（#23 每张地图各带一个规则模块）', () => {
  const perMap = listActiveMaps().map((entry) => {
    const pack = getActiveMapPack(entry.ref.id);
    return {
      mapId: pack.ref.id,
      moduleKeys: pack.game.requiredRuleModules.map((ref) => `${ref.id}@${ref.version}`),
      results: randomConfigs(3, 4242).map((config) => runGame(config, CI_CAP, pack)),
    };
  });

  it('每张正式地图都挂了模块，且与 registry 声明一一对应（无孤儿模块、无漏挂）', () => {
    const mapsWithoutModule = perMap
      .filter((entry) => entry.moduleKeys.every((key) => key.startsWith('core@')))
      .map((entry) => entry.mapId);
    expect(mapsWithoutModule).toEqual([]);

    const boundIds = [...new Set(perMap.flatMap((entry) => entry.moduleKeys))]
      .map((key) => key.split('@')[0])
      .filter((id) => id !== 'core')
      .sort();
    const declaredIds = PRODUCTION_RULE_MODULES
      .map((ref) => ref.id)
      .filter((id) => id !== 'core')
      .sort();
    expect(boundIds).toEqual(declaredIds);
  });

  it('所有地图的 bot 决策都合法（illegalIntents === 0）', () => {
    const illegal = perMap
      .filter((entry) => entry.results.some((result) => result.illegalIntents > 0))
      .map((entry) => entry.mapId);
    expect(illegal).toEqual([]);
  });

  it('所有地图现金守恒不变量成立（conservationViolations === 0）', () => {
    const violated = perMap
      .filter((entry) => entry.results.some((result) => result.conservationViolations > 0))
      .map((entry) => `${entry.mapId}:${entry.results
        .map((result) => result.conservationViolations)
        .join('/')}`);
    expect(violated).toEqual([]);
  });

  it('所有地图无异常抛出', () => {
    const crashed = perMap
      .filter((entry) => entry.results.some((result) => result.exception !== null))
      .map((entry) => entry.mapId);
    expect(crashed).toEqual([]);
  });
});
