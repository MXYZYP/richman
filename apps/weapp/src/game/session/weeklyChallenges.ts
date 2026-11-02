/**
 * 每周挑战：给玩家一个「这周为什么再来一局」的理由。
 *
 * 为什么不是再加一堆成就：成就是**一次性**的，做完就再无目标；而战绩页只有累计数字，
 * 赢一局之后没有「下一局该干嘛」。每周挑战用极低的成本补上周期性目标。
 *
 * 两个刻意的设计约束：
 *
 *  1. **纯本机、不发网络请求**：与成就同源（都由 `PlayerStats` 派生），没有服务端也能用，
 *     单机玩家与联机玩家看到的是同一套挑战。
 *  2. **进度按「本周增量」算，不是累计值**：`PlayerStats` 里的 `gamesPlayed / wins` 是
 *     历史累计，直接当进度会让老玩家一进页就全完成。所以这里额外记一份「本周开始时的
 *     基线快照」——只存三个数字、不带任何对局内容，周 key 一变就重置。
 *
 * 周次与三条挑战的目标都由**周序号**推导（不是随机），因此同一周里所有人看到的是同一组
 * 挑战，跨周自然轮换，且可测（给定 now，结果确定）。
 */

import type { PlayerStats } from './playerStats';
import type { StorageLike } from './sessionStorage';

export const WEEKLY_BASELINE_KEY = 'richman_weekly_baseline_v1';
export const WEEKLY_BASELINE_SCHEMA_VERSION = 1;

/** 一周开始时记下的三个累计值快照。 */
export interface WeeklyBaseline {
  readonly schemaVersion: 1;
  /** ISO 周标识，如 `2026-W44`。周 key 变了就说明跨周了，基线作废重记。 */
  readonly weekKey: string;
  readonly gamesPlayed: number;
  readonly wins: number;
  readonly bestAsset: number;
}

export type WeeklyChallengeId = 'games' | 'wins' | 'record';

export interface WeeklyChallenge {
  readonly id: WeeklyChallengeId;
  readonly title: string;
  /** 未完成时的说明（含当前进度）；完成后换成一句「已完成」。 */
  readonly description: string;
  readonly progress: { readonly current: number; readonly target: number };
  readonly done: boolean;
}

export interface WeeklyChallengeSet {
  readonly weekKey: string;
  readonly challenges: readonly WeeklyChallenge[];
  readonly doneCount: number;
}

/** ISO 8601 周标识与本年第几周（周一为一周之始）。 */
export function isoWeekOf(now: number): { weekKey: string; weekNumber: number } {
  const date = new Date(now);
  // 全部换算到 UTC 再算：本机时区再怎么变，同一时刻算出的周次必须一致。
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = utc.getUTCDay() === 0 ? 7 : utc.getUTCDay();
  // 移到本周周四：ISO 周的定义锚点，跨年也靠它归属。
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { weekKey: `${utc.getUTCFullYear()}-W${String(weekNumber).padStart(2, '0')}`, weekNumber };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseBaseline(value: unknown): WeeklyBaseline | null {
  if (!isRecord(value) || value.schemaVersion !== WEEKLY_BASELINE_SCHEMA_VERSION) return null;
  if (typeof value.weekKey !== 'string' || value.weekKey.length === 0) return null;
  if (!isCount(value.gamesPlayed) || !isCount(value.wins) || !isCount(value.bestAsset)) return null;
  return {
    schemaVersion: 1,
    weekKey: value.weekKey,
    gamesPlayed: Math.floor(value.gamesPlayed),
    wins: Math.floor(value.wins),
    bestAsset: Math.floor(value.bestAsset),
  };
}

export function loadWeeklyBaseline(storage: StorageLike): WeeklyBaseline | null {
  try {
    return parseBaseline(JSON.parse(storage.getItem(WEEKLY_BASELINE_KEY) ?? 'null'));
  } catch {
    return null;
  }
}

function saveWeeklyBaseline(storage: StorageLike, baseline: WeeklyBaseline): void {
  try {
    storage.setItem(WEEKLY_BASELINE_KEY, JSON.stringify(baseline));
  } catch {
    // 隐私模式下写不进去：本周进度会一直显示 0，但绝不能因此让整页崩掉。
  }
}

/**
 * 取本周基线；跨周则**用当前累计值重置**（于是本周进度从 0 开始）。
 *
 * 注意这里只对 `storage` 有副作用（写基线）。`stats` 只读。
 */
export function ensureWeeklyBaseline(
  storage: StorageLike,
  stats: PlayerStats,
  now: number,
): WeeklyBaseline {
  const { weekKey } = isoWeekOf(now);
  const existing = loadWeeklyBaseline(storage);
  if (existing !== null && existing.weekKey === weekKey) return existing;
  const next: WeeklyBaseline = {
    schemaVersion: 1,
    weekKey,
    gamesPlayed: stats.gamesPlayed,
    wins: stats.wins,
    bestAsset: stats.bestAsset,
  };
  saveWeeklyBaseline(storage, next);
  return next;
}

function clampDelta(current: number, base: number): number {
  return Math.max(0, Math.floor(current) - Math.floor(base));
}

function progressOf(current: number, target: number): { current: number; target: number } {
  const safeCurrent = Number.isFinite(current) ? Math.max(0, Math.floor(current)) : 0;
  const safeTarget = Math.max(1, Math.floor(target));
  return { current: Math.min(safeCurrent, safeTarget), target: safeTarget };
}

/**
 * 本周挑战（三条）。目标由周序号推导，因此同一周内固定、跨周轮换。
 *
 * 无可用的 storage 时返回 `null`：没有基线就谈不出「本周增量」，硬显示一堆 0/3
 * 只会让人以为挑战坏了（与成就页「读不到战绩就不显示」的处理保持一致）。
 */
export function deriveWeeklyChallenges(
  storage: StorageLike | undefined,
  stats: PlayerStats,
  options: { readonly now: number },
): WeeklyChallengeSet | null {
  if (storage === undefined) return null;
  const { weekKey, weekNumber } = isoWeekOf(options.now);
  const baseline = ensureWeeklyBaseline(storage, stats, options.now);

  const gamesTarget = 2 + (weekNumber % 3); // 2 / 3 / 4 局
  const winsTarget = 1 + (weekNumber % 2); // 1 / 2 胜

  const gamesDone = clampDelta(stats.gamesPlayed, baseline.gamesPlayed);
  const winsDone = clampDelta(stats.wins, baseline.wins);
  // 「刷新个人资产纪录」：历史峰值是累计值，只能按「是否超过本周开始时」来判定。
  const recordDone = stats.bestAsset > baseline.bestAsset ? 1 : 0;

  const challenges: readonly WeeklyChallenge[] = [
    {
      id: 'games',
      title: `本周打完 ${gamesTarget} 局`,
      description: gamesDone >= gamesTarget ? '已完成，本周份打够了。' : `还差 ${gamesTarget - gamesDone} 局。`,
      progress: progressOf(gamesDone, gamesTarget),
      done: gamesDone >= gamesTarget,
    },
    {
      id: 'wins',
      title: `本周赢下 ${winsTarget} 局`,
      description: winsDone >= winsTarget ? '已完成，手气不错。' : `还差 ${winsTarget - winsDone} 胜。`,
      progress: progressOf(winsDone, winsTarget),
      done: winsDone >= winsTarget,
    },
    {
      id: 'record',
      title: '本周刷新个人资产纪录',
      description: recordDone === 1 ? '已完成，破了自己的纪录。' : '超过自己历史最高总资产即可。',
      progress: progressOf(recordDone, 1),
      done: recordDone === 1,
    },
  ];

  return { weekKey, challenges, doneCount: challenges.filter((item) => item.done).length };
}
