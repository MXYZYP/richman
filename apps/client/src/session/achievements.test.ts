import { describe, expect, it } from 'vitest';
import { deriveAchievements, describeNextAchievement, exploredMapCount } from './achievements';
import type { Achievement, AchievementSummary } from './achievements';
import type { PlayerStats } from './playerStats';

/**
 * 成就（路线图 #116）：全部由**已有战绩**派生，所以这里的每一条断言都等价于
 * 「战绩到哪个数，界面就该亮哪一盏灯」。盯住三件事：
 *  1. 阈值边界（差一点不算、恰好算），避免出现「打了 5 局但五胜没亮」这种信任崩塌；
 *  2. 「地图收集」只认**在架**地图，下架的地图不该永远挂着一个完不成的目标；
 *  3. 纯函数：不改入参，也不读任何存储。
 */

const EMPTY: PlayerStats = {
  schemaVersion: 1,
  gamesPlayed: 0,
  wins: 0,
  losses: 0,
  bestAsset: 0,
  favoriteMaps: {},
  lastPlayedAt: 0,
};

const MAPS = ['china-tour', 'world-tour', 'silk-road', 'great-wall', 'yellow-river'] as const;

function stats(overrides: Partial<PlayerStats> = {}): PlayerStats {
  return { ...EMPTY, ...overrides };
}

function summary(overrides: Partial<PlayerStats> = {}, mapIds: readonly string[] = MAPS): AchievementSummary {
  return deriveAchievements(stats(overrides), { mapIds });
}

function byId(result: AchievementSummary, id: string): Achievement {
  const found = result.achievements.find((achievement) => achievement.id === id);
  if (found === undefined) throw new Error(`没有这项成就：${id}`);
  return found;
}

describe('deriveAchievements — 从战绩派生成就', () => {
  it('空战绩：一项都没解锁，且「下一个目标」指向开局', () => {
    const result = summary();
    expect(result.unlockedCount).toBe(0);
    expect(result.total).toBe(result.achievements.length);
    expect(result.achievements.every((achievement) => !achievement.unlocked)).toBe(true);
    expect(result.next?.id).toBe('first-game');
  });

  it('胜利类成就的阈值边界：差一点不算，恰好算', () => {
    expect(byId(summary({ wins: 0 }), 'first-win').unlocked).toBe(false);
    expect(byId(summary({ wins: 1 }), 'first-win').unlocked).toBe(true);

    expect(byId(summary({ wins: 4 }), 'wins-5').unlocked).toBe(false);
    expect(byId(summary({ wins: 5 }), 'wins-5').unlocked).toBe(true);

    expect(byId(summary({ wins: 19 }), 'wins-20').unlocked).toBe(false);
    expect(byId(summary({ wins: 20 }), 'wins-20').unlocked).toBe(true);
  });

  it('局数类成就只看「输赢都算」的总局数，与胜负无关', () => {
    expect(byId(summary({ gamesPlayed: 9, losses: 9 }), 'games-10').unlocked).toBe(false);
    expect(byId(summary({ gamesPlayed: 10, losses: 10 }), 'games-10').unlocked).toBe(true);
    expect(byId(summary({ gamesPlayed: 49, losses: 49 }), 'games-50').unlocked).toBe(false);
    expect(byId(summary({ gamesPlayed: 50, losses: 50 }), 'games-50').unlocked).toBe(true);
  });

  it('资产类成就按峰值判定，取 3 万 / 6 万 / 15 万三档', () => {
    expect(byId(summary({ bestAsset: 29_999 }), 'asset-30000').unlocked).toBe(false);
    expect(byId(summary({ bestAsset: 30_000 }), 'asset-30000').unlocked).toBe(true);

    expect(byId(summary({ bestAsset: 59_999 }), 'asset-60000').unlocked).toBe(false);
    expect(byId(summary({ bestAsset: 60_000 }), 'asset-60000').unlocked).toBe(true);

    expect(byId(summary({ bestAsset: 149_999 }), 'asset-150000').unlocked).toBe(false);
    expect(byId(summary({ bestAsset: 150_000 }), 'asset-150000').unlocked).toBe(true);
  });

  it('地图收集只数「至少完成一局」的地图，完成 0 局的地图不算', () => {
    expect(exploredMapCount(stats({ favoriteMaps: { 'china-tour': 0, 'world-tour': 0 } }), MAPS)).toBe(0);
    expect(exploredMapCount(stats({ favoriteMaps: { 'china-tour': 1, 'world-tour': 0 } }), MAPS)).toBe(1);
    expect(byId(summary({ favoriteMaps: { 'china-tour': 2, 'world-tour': 5, 'silk-road': 1 } }), 'maps-3').unlocked).toBe(true);
  });

  it('已下架的地图不计入收集度 —— 否则那条成就会永远差一格', () => {
    const favoriteMaps = { 'china-tour': 3, 'world-tour': 1, 'ghost-map': 9 };
    expect(exploredMapCount(stats({ favoriteMaps }), MAPS)).toBe(2);
    expect(byId(summary({ favoriteMaps }), 'maps-3').unlocked).toBe(false);
    // 同一条战绩，若那张地图还在架，就该解锁。
    expect(byId(summary({ favoriteMaps }, ['china-tour', 'world-tour', 'ghost-map']), 'maps-3').unlocked).toBe(true);
  });

  it('「地图全通」的目标随在架地图数浮动：新地图上线即变难', () => {
    const all = { 'china-tour': 1, 'world-tour': 1, 'silk-road': 1, 'great-wall': 1, 'yellow-river': 1 };
    expect(byId(summary({ favoriteMaps: all }, MAPS), 'maps-all').unlocked).toBe(true);
    // 又上线一张新地图，同样这五张就不够了。
    const withNewMap = [...MAPS, 'pearl-tour'];
    const shrunk = byId(summary({ favoriteMaps: all }, withNewMap), 'maps-all');
    expect(shrunk.unlocked).toBe(false);
    expect(shrunk.progress).toEqual({ current: 5, target: 6 });
  });

  it('进度按目标截断，不会出现 120% 这种进度条', () => {
    const rich = byId(summary({ bestAsset: 999_999 }), 'asset-30000');
    expect(rich.progress).toEqual({ current: 30_000, target: 30_000 });
    expect(rich.unlocked).toBe(true);
  });

  it('是纯函数：不改动传入的战绩', () => {
    const input = stats({ gamesPlayed: 3, wins: 2, favoriteMaps: { 'china-tour': 3 } });
    const snapshot = JSON.parse(JSON.stringify(input));
    deriveAchievements(input, { mapIds: MAPS });
    expect(input).toEqual(snapshot);
  });

  it('「下一个目标」挑完成度最高的未解锁项；全部达成后为 null 并给收尾文案', () => {
    // 局数 10 达成、胜场 1 达成；资产 3 万达成……留两项不同完成度。
    const partial = summary({ gamesPlayed: 10, wins: 1, bestAsset: 15_000 });
    expect(partial.next?.id).toBe('asset-30000');
    expect(partial.next?.progress).toEqual({ current: 15_000, target: 30_000 });

    const completed = summary({
      gamesPlayed: 50,
      wins: 20,
      losses: 30,
      bestAsset: 150_000,
      favoriteMaps: { 'china-tour': 1, 'world-tour': 1, 'silk-road': 1, 'great-wall': 1, 'yellow-river': 1 },
    });
    expect(completed.unlockedCount).toBe(completed.total);
    expect(completed.next).toBeNull();
    expect(describeNextAchievement(completed)).toContain('已解锁全部');
  });

  it('describeNextAchievement 带上标题、进度与说明，界面不必自己拼字符串', () => {
    const text = describeNextAchievement(summary({ wins: 3 }));
    expect(text).toContain('五胜');
    expect(text).toContain('3 / 5');
    expect(text).toContain('累计获胜 5 局');
  });

  it('成就 id 不重复，且三项分组齐全（界面按组渲染）', () => {
    const result = summary();
    const ids = result.achievements.map((achievement) => achievement.id);
    expect(new Set(ids).size).toBe(ids.length);
    const groups = new Set(result.achievements.map((achievement) => achievement.group));
    expect(groups).toEqual(new Set(['milestone', 'wealth', 'explorer']));
  });
});
