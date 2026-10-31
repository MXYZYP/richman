import { describe, expect, it } from 'vitest';
import {
  WEEKLY_BASELINE_KEY,
  deriveWeeklyChallenges,
  ensureWeeklyBaseline,
  isoWeekOf,
  loadWeeklyBaseline,
  type WeeklyChallengeId,
} from './weeklyChallenges';
import type { PlayerStats } from './playerStats';
import type { StorageLike } from './sessionStorage';

function memStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function statsOf(partial: Partial<PlayerStats> = {}): PlayerStats {
  return {
    schemaVersion: 1,
    gamesPlayed: 10,
    wins: 4,
    losses: 6,
    bestAsset: 50_000,
    favoriteMaps: {},
    lastPlayedAt: 0,
    ...partial,
  };
}

/** 取某个固定时刻：2026-10-30（周五）。 */
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
/** 下一周的同一时刻。 */
const NEXT_WEEK = NOW + 7 * 86_400_000;

function byId(set: NonNullable<ReturnType<typeof deriveWeeklyChallenges>>, id: WeeklyChallengeId) {
  const found = set.challenges.find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing challenge ${id}`);
  return found;
}

describe('ISO 周次', () => {
  it('同一时刻算出同一个周 key（可测、全端一致）', () => {
    expect(isoWeekOf(NOW).weekKey).toBe(isoWeekOf(NOW).weekKey);
    expect(isoWeekOf(NOW).weekNumber).toBeGreaterThanOrEqual(1);
    expect(isoWeekOf(NOW).weekNumber).toBeLessThanOrEqual(53);
  });

  it('周 key 形如 YYYY-Wnn', () => {
    expect(isoWeekOf(NOW).weekKey).toMatch(/^\d{4}-W\d{2}$/);
  });
});

describe('每周挑战：确定性', () => {
  it('同一周内重复派生，结果完全一致（不随机）', () => {
    const storage = memStorage();
    const stats = statsOf();
    const first = deriveWeeklyChallenges(storage, stats, { now: NOW });
    const second = deriveWeeklyChallenges(storage, stats, { now: NOW });
    expect(first).toEqual(second);
  });

  it('三条挑战与周次一起给出', () => {
    const set = deriveWeeklyChallenges(memStorage(), statsOf(), { now: NOW });
    expect(set).not.toBeNull();
    expect(set!.challenges.map((item) => item.id)).toEqual(['games', 'wins', 'record']);
    expect(set!.weekKey).toBe(isoWeekOf(NOW).weekKey);
  });
});

describe('每周挑战：进度按本周增量算', () => {
  it('刚记基线时进度为 0（累计 10 局不算数）', () => {
    const storage = memStorage();
    const set = deriveWeeklyChallenges(storage, statsOf({ gamesPlayed: 10, wins: 4 }), { now: NOW });
    expect(byId(set!, 'games').progress.current).toBe(0);
    expect(byId(set!, 'wins').progress.current).toBe(0);
    expect(set!.doneCount).toBe(0);
  });

  it('本周新打的局数与胜场计入进度', () => {
    const storage = memStorage();
    const before = statsOf({ gamesPlayed: 10, wins: 4, bestAsset: 50_000 });
    deriveWeeklyChallenges(storage, before, { now: NOW }); // 记基线
    const after = statsOf({ gamesPlayed: 12, wins: 5, bestAsset: 50_000 });
    const set = deriveWeeklyChallenges(storage, after, { now: NOW });

    expect(byId(set!, 'games').progress.current).toBe(2);
    expect(byId(set!, 'wins').progress.current).toBe(1);
  });

  it('资产纪录挑战：超过本周开始时的峰值才算完成', () => {
    const storage = memStorage();
    deriveWeeklyChallenges(storage, statsOf({ bestAsset: 50_000 }), { now: NOW });
    expect(byId(deriveWeeklyChallenges(storage, statsOf({ bestAsset: 50_000 }), { now: NOW })!, 'record').done).toBe(false);
    expect(byId(deriveWeeklyChallenges(storage, statsOf({ bestAsset: 50_001 }), { now: NOW })!, 'record').done).toBe(true);
  });

  it('反向：进度被 target 截断，不会出现 5/3 这种超百比分', () => {
    const storage = memStorage();
    deriveWeeklyChallenges(storage, statsOf({ gamesPlayed: 0, wins: 0, bestAsset: 50_000 }), { now: NOW });
    // 一次性把三项全推过线（纪录项也要真的超过基线峰值才算）。
    const set = deriveWeeklyChallenges(
      storage,
      statsOf({ gamesPlayed: 99, wins: 99, bestAsset: 50_001 }),
      { now: NOW },
    );
    for (const item of set!.challenges) {
      expect(item.progress.current).toBeLessThanOrEqual(item.progress.target);
    }
    expect(set!.doneCount).toBe(3);
  });
});

describe('跨周重置', () => {
  it('进入新的一周：基线重记，进度归零', () => {
    const storage = memStorage();
    // 周初：以「已打 10 局」为基线（第一次派生即记账，所以此刻进度是 0）。
    deriveWeeklyChallenges(storage, statsOf({ gamesPlayed: 10, wins: 4 }), { now: NOW });
    // 周中：打到 12 局。
    const midweek = statsOf({ gamesPlayed: 12, wins: 5 });
    const thisWeek = deriveWeeklyChallenges(storage, midweek, { now: NOW });
    expect(byId(thisWeek!, 'games').progress.current).toBe(2);

    // 跨到下一周：战绩没变，但基线重记成「12 局」，进度自然归零。
    const nextWeek = deriveWeeklyChallenges(storage, midweek, { now: NEXT_WEEK });
    expect(nextWeek!.weekKey).not.toBe(thisWeek!.weekKey);
    expect(byId(nextWeek!, 'games').progress.current).toBe(0);
    expect(nextWeek!.doneCount).toBe(0);
  });

  it('基线只存三个数字 + 周 key，不落任何对局内容', () => {
    const storage = memStorage();
    ensureWeeklyBaseline(storage, statsOf(), NOW);
    const raw = JSON.parse(storage.getItem(WEEKLY_BASELINE_KEY) ?? '{}');
    expect(Object.keys(raw).sort()).toEqual([
      'bestAsset',
      'gamesPlayed',
      'schemaVersion',
      'weekKey',
      'wins',
    ]);
  });

  it('坏数据不会让整页崩：解析失败就当没基线', () => {
    const storage = memStorage();
    storage.setItem(WEEKLY_BASELINE_KEY, '{not json');
    expect(loadWeeklyBaseline(storage)).toBeNull();
  });
});

describe('无可用存储', () => {
  it('storage 不可用时返回 null（宁可不显示，也不显示一堆 0/3）', () => {
    expect(deriveWeeklyChallenges(undefined, statsOf(), { now: NOW })).toBeNull();
  });
});
