import type { StorageLike } from './sessionStorage';

// 本地玩家战绩统计：纯 localStorage 实现，无需账号。
// 对应路线图 #12（P1 玩家战绩/统计）：胜场、总资产峰值、最常用地图。

export const PLAYER_STATS_KEY = 'richman_player_stats_v1';
export const PLAYER_STATS_SCHEMA_VERSION = 1;

export interface PlayerStats {
  schemaVersion: 1;
  /** 完成的对局数（含胜与负） */
  gamesPlayed: number;
  /** 作为参赛者获胜的对局数 */
  wins: number;
  /** 作为参赛者失败的对局数 */
  losses: number;
  /** 历史总资产（现金）峰值 */
  bestAsset: number;
  /** mapId -> 使用该地图完成的对局数 */
  favoriteMaps: Record<string, number>;
  /** 最近一次完成对局的时间戳（ms） */
  lastPlayedAt: number;
}

export interface GameResultInput {
  /** 本地参赛者是否获胜（winnerId === 本地玩家 id） */
  won: boolean;
  /** 本地参赛者终局现金资产 */
  finalAsset: number;
  /** 本局地图 id（来自 state.mapRef.id） */
  mapId: string;
  /** 记录时间戳（ms） */
  at: number;
}

const EMPTY_STATS: PlayerStats = {
  schemaVersion: 1,
  gamesPlayed: 0,
  wins: 0,
  losses: 0,
  bestAsset: 0,
  favoriteMaps: {},
  lastPlayedAt: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseStats(value: unknown): PlayerStats | null {
  if (!isRecord(value) || value.schemaVersion !== PLAYER_STATS_SCHEMA_VERSION) return null;
  const favoriteMaps = isRecord(value.favoriteMaps)
    ? Object.fromEntries(
      Object.entries(value.favoriteMaps)
        .filter(([key, count]) => typeof key === 'string' && isFiniteNumber(count) && count >= 0)
        .map(([key, count]) => [key, Math.floor(count as number)]),
    )
    : {};
  if (
    !isFiniteNumber(value.gamesPlayed) || !isFiniteNumber(value.wins)
    || !isFiniteNumber(value.losses) || !isFiniteNumber(value.bestAsset)
    || !isFiniteNumber(value.lastPlayedAt)
  ) return null;
  return {
    schemaVersion: 1,
    gamesPlayed: Math.max(0, Math.floor(value.gamesPlayed)),
    wins: Math.max(0, Math.floor(value.wins)),
    losses: Math.max(0, Math.floor(value.losses)),
    bestAsset: Math.max(0, Math.floor(value.bestAsset)),
    favoriteMaps,
    lastPlayedAt: Math.max(0, Math.floor(value.lastPlayedAt)),
  };
}

/** 读取战绩；任何异常（无存储 / 损坏）都回退到空战绩，绝不抛错。 */
export function loadPlayerStats(storage: StorageLike): PlayerStats {
  let raw: string | null;
  try {
    raw = storage.getItem(PLAYER_STATS_KEY);
  } catch {
    return { ...EMPTY_STATS };
  }
  if (raw === null) return { ...EMPTY_STATS };
  try {
    const parsed = parseStats(JSON.parse(raw));
    return parsed ?? { ...EMPTY_STATS };
  } catch {
    return { ...EMPTY_STATS };
  }
}

/** 记录一局结果并返回更新后的战绩。存储不可用时仍返回内存中的最新值，不抛错。 */
export function recordGameResult(storage: StorageLike, input: GameResultInput): PlayerStats {
  const prev = loadPlayerStats(storage);
  const favoriteMaps: Record<string, number> = { ...prev.favoriteMaps };
  favoriteMaps[input.mapId] = (favoriteMaps[input.mapId] ?? 0) + 1;
  const next: PlayerStats = {
    schemaVersion: 1,
    gamesPlayed: prev.gamesPlayed + 1,
    wins: prev.wins + (input.won ? 1 : 0),
    losses: prev.losses + (input.won ? 0 : 1),
    bestAsset: Math.max(prev.bestAsset, Math.floor(input.finalAsset)),
    favoriteMaps,
    lastPlayedAt: input.at,
  };
  try {
    storage.setItem(PLAYER_STATS_KEY, JSON.stringify(next));
  } catch {
    // 存储不可用时保留内存结果，不影响对局流程。
  }
  return next;
}

/** 安全获取浏览器 localStorage（SSR / 隐私模式 / 禁用存储时返回 undefined）。 */
export function browserStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
