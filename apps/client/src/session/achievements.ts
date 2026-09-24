import type { PlayerStats } from './playerStats';

// 成就（路线图 #116）：全部由**已有的本机战绩**派生，不新增任何采集、不发任何网络请求。
//
// 为什么不新增埋点：战绩（#12）已经记下了「打了多少局、赢了多少、资产峰值、用过哪些地图」，
// 恰好就是成就需要的全部原料。再为成就单独埋一套计数，只会带来两个真相来源，
// 日后再出现「战绩说 10 局、成就说 9 局」这种谁都不信的场面。
//
// 因此这个模块是**纯函数**：给一份 `PlayerStats` + 当前已发布的地图 id 列表，就得到成就清单。
// 既能在 node 环境里完整跑测试，也能随手在别处复算。

/** 成就分组：只用于界面归类，不参与任何计算。 */
export type AchievementGroup = 'milestone' | 'wealth' | 'explorer';

/** 成就的进度。`current` 已按 `target` 截断，可以直接当进度条用（不会超过 100%）。 */
export interface AchievementProgress {
  readonly current: number;
  readonly target: number;
}

export interface Achievement {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly group: AchievementGroup;
  /** 是否已达成。 */
  readonly unlocked: boolean;
  readonly progress: AchievementProgress;
}

export interface AchievementSummary {
  readonly achievements: readonly Achievement[];
  readonly unlockedCount: number;
  readonly total: number;
  /**
   * 离达成最近的那个未解锁成就（按完成度取最大者，同分取清单顺序靠前者）。
   * 全部达成时为 `null` —— 界面据此显示「全部达成」而不是硬塞一个假目标。
   */
  readonly next: Achievement | null;
}

export interface DeriveAchievementsOptions {
  /** 当前**已发布**的地图 id。用于「地图收集」类成就：下架的地图不该继续被要求去玩。 */
  readonly mapIds: readonly string[];
}

interface AchievementSpec {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly group: AchievementGroup;
  /** 从战绩里取「当前值」与「目标值」；目标值固定写死，不随地图变化。 */
  readonly measure: (stats: PlayerStats, mapIds: readonly string[]) => AchievementProgress;
}

function progress(current: number, target: number): AchievementProgress {
  // 负值不该出现（战绩解析已经把负数归零），但这里是公共入口，兜一下更省事。
  const safeCurrent = Number.isFinite(current) ? Math.max(0, Math.floor(current)) : 0;
  const safeTarget = Math.max(1, Math.floor(target));
  return { current: Math.min(safeCurrent, safeTarget), target: safeTarget };
}

/** 玩过的地图数：只统计「至少完成过一局」且**当前仍在架**的地图。 */
export function exploredMapCount(stats: PlayerStats, mapIds: readonly string[]): number {
  const known = new Set(mapIds);
  let count = 0;
  for (const [mapId, games] of Object.entries(stats.favoriteMaps)) {
    if (games > 0 && known.has(mapId)) count += 1;
  }
  return count;
}

// 成就清单。顺序 = 界面顺序（从「刚开始玩」到「很能玩」）。
// 阈值全部写成字面量，方便日后调整时一处改完、测试同步。
const SPECS: readonly AchievementSpec[] = [
  {
    id: 'first-game',
    title: '开局',
    description: '完成第一局对局。',
    group: 'milestone',
    measure: (stats) => progress(stats.gamesPlayed, 1),
  },
  {
    id: 'first-win',
    title: '首胜',
    description: '赢下第一局。',
    group: 'milestone',
    measure: (stats) => progress(stats.wins, 1),
  },
  {
    id: 'wins-5',
    title: '五胜',
    description: '累计获胜 5 局。',
    group: 'milestone',
    measure: (stats) => progress(stats.wins, 5),
  },
  {
    id: 'wins-20',
    title: '二十胜',
    description: '累计获胜 20 局。',
    group: 'milestone',
    measure: (stats) => progress(stats.wins, 20),
  },
  {
    id: 'games-10',
    title: '常客',
    description: '完成 10 局对局（输赢都算）。',
    group: 'milestone',
    measure: (stats) => progress(stats.gamesPlayed, 10),
  },
  {
    id: 'games-50',
    title: '老手',
    description: '完成 50 局对局（输赢都算）。',
    group: 'milestone',
    measure: (stats) => progress(stats.gamesPlayed, 50),
  },
  {
    // 阈值贴着地图默认初始资金（约 1.5 万）取整倍数，玩家能直观感到「翻了几倍」。
    id: 'asset-30000',
    title: '小有积蓄',
    description: '单局结束时资产达到 3 万。',
    group: 'wealth',
    measure: (stats) => progress(stats.bestAsset, 30_000),
  },
  {
    id: 'asset-60000',
    title: '家底殷实',
    description: '单局结束时资产达到 6 万。',
    group: 'wealth',
    measure: (stats) => progress(stats.bestAsset, 60_000),
  },
  {
    id: 'asset-150000',
    title: '富甲一方',
    description: '单局结束时资产达到 15 万。',
    group: 'wealth',
    measure: (stats) => progress(stats.bestAsset, 150_000),
  },
  {
    id: 'maps-3',
    title: '到处走走',
    description: '在 3 张不同地图上各完成至少一局。',
    group: 'explorer',
    measure: (stats, mapIds) => progress(exploredMapCount(stats, mapIds), 3),
  },
  {
    id: 'maps-5',
    title: '旅行家',
    description: '在 5 张不同地图上各完成至少一局。',
    group: 'explorer',
    measure: (stats, mapIds) => progress(exploredMapCount(stats, mapIds), 5),
  },
  {
    id: 'maps-all',
    title: '地图全通',
    description: '在每一张已发布的地图上都完成过一局。',
    group: 'explorer',
    // 目标值随在架地图数浮动：新地图上线后，这条成就自动变难（而不是白送）。
    measure: (stats, mapIds) => progress(exploredMapCount(stats, mapIds), Math.max(1, mapIds.length)),
  },
];

/**
 * 由本机战绩派生成就清单。**纯函数**：不改 `stats`，也不读存储。
 *
 * 注意：这里不做任何「已解锁」状态的持久化——解锁与否完全由战绩重算得出。
 * 好处是导入战绩码之后成就自动跟着变，坏处是「曾经解锁、后来战绩被清空」会一起丢，
 * 而那本来也是同一件事（成就就是战绩的一种读法）。
 */
export function deriveAchievements(stats: PlayerStats, options: DeriveAchievementsOptions): AchievementSummary {
  const mapIds = options.mapIds;
  const achievements = SPECS.map((spec): Achievement => {
    const value = spec.measure(stats, mapIds);
    return {
      id: spec.id,
      title: spec.title,
      description: spec.description,
      group: spec.group,
      unlocked: value.current >= value.target,
      progress: value,
    };
  });

  let unlockedCount = 0;
  let next: Achievement | null = null;
  let nextRatio = -1;
  for (const achievement of achievements) {
    if (achievement.unlocked) {
      unlockedCount += 1;
      continue;
    }
    const ratio = achievement.progress.current / achievement.progress.target;
    if (ratio > nextRatio) {
      nextRatio = ratio;
      next = achievement;
    }
  }

  return { achievements, unlockedCount, total: achievements.length, next };
}

/** 界面用的「下一个目标」一句话；全部达成时给一句收尾文案。 */
export function describeNextAchievement(summary: AchievementSummary): string {
  const next = summary.next;
  if (next === null) {
    return `已解锁全部 ${summary.total} 项成就。`;
  }
  return `下一个：${next.title}（${next.progress.current} / ${next.progress.target}）—— ${next.description}`;
}
