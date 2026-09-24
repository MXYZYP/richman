import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 成就排行榜的服务端存储（路线图 #116）。
 *
 * 与房间快照（`roomSnapshotStore`）同一套工程约定，因为它们面对的是同一类问题：
 *  1. **原子写**：先写 `<file>.tmp` 再 `rename`，进程被杀只会留下一个没人读的 `.tmp`，
 *     绝不会把好榜单截断成半个 JSON。
 *  2. **带版本号**：`schemaVersion` 不匹配就整份丢弃。改结构时抬版本号即可，
 *     不会把服务端带进半新半旧的状态。
 *  3. **损坏容错**：坏文件挪成 `.corrupt` 隔离，服务端照常启动（榜单是锦上添花的功能，
 *     绝不能因为它坏了就让整个游戏起不来）。
 *  4. **保留期**：久未更新的条目在读取时清掉，否则榜单会被「打过一局就再没出现」的名字占满。
 *
 * 关于隐私：榜单只存**昵称 + 四个聚合数字**（胜场、总局数、资产峰值、玩过的地图数）
 * 与一个客户端自己生成、与本机战绩码无关的随机 `playerId`。**不存 token、不存账号、
 * 不存对局内容**。提交是玩家在界面上主动点的那一下，不点就永远不会上传。
 */

export const LEADERBOARD_SCHEMA_VERSION = 1;

/** 榜单最多保留多少条。超出部分按排名截断 —— 排名之外的人如实回 `rank: null`。 */
export const LEADERBOARD_MAX_ENTRIES = 100;

/** 昵称长度上限，与首页昵称输入框一致（`maxlength="12"`）。 */
export const LEADERBOARD_NICKNAME_MAX_LENGTH = 12;

/** 默认保留期：90 天没更新过的条目视为不再活跃，读取时清理。 */
export const DEFAULT_LEADERBOARD_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * `playerId` 是客户端生成并存在本机的一段随机串，只用来把「同一个人重复提交」认成同一条记录。
 * 它由客户端自己产生，与战绩码、房间 token 都没有关系。
 */
export const LEADERBOARD_PLAYER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** 单字段上限。刻意宽松（正常玩不到），只为挡住「伪造一个天文数字霸榜」。 */
const MAX_METRIC = 10_000_000;

export interface LeaderboardEntry {
  readonly playerId: string;
  readonly nickname: string;
  readonly wins: number;
  readonly gamesPlayed: number;
  readonly bestAsset: number;
  readonly mapCount: number;
  /** 服务端写入时间（毫秒）；**由服务端决定**，不采信客户端传来的时间。 */
  readonly updatedAt: number;
}

/** 客户端提交上来的部分（没有 `updatedAt` —— 那是服务端的事）。 */
export interface LeaderboardSubmission {
  readonly playerId: string;
  readonly nickname: string;
  readonly wins: number;
  readonly gamesPlayed: number;
  readonly bestAsset: number;
  readonly mapCount: number;
}

export interface LeaderboardStore {
  /**
   * 写入 / 更新一条记录并立刻落盘。返回写入后的记录（排序、截断都已完成）。
   * 落盘失败会抛错，由调用方决定怎么报 —— 但内存里的榜单仍然是新的。
   */
  upsert(submission: LeaderboardSubmission): LeaderboardEntry;
  /** 当前榜单（已排序、已截断到上限）。 */
  entries(): readonly LeaderboardEntry[];
  /** 1-based 名次；没进榜返回 `null`（而不是 0 —— 调用方不必猜 `0` 是什么意思）。 */
  rankOf(playerId: string): number | null;
  size(): number;
}

export interface CreateLeaderboardStoreOptions {
  /** 榜单 JSON 文件路径；父目录不存在会自动创建。 */
  file: string;
  maxEntries?: number;
  retentionMs?: number;
  /** 便于测试注入时钟。 */
  now?: () => number;
}

export interface LeaderboardFile {
  schemaVersion: number;
  entries: LeaderboardEntry[];
}

const TEMP_FILE_SUFFIX = '.tmp';
const CORRUPT_FILE_SUFFIX = '.corrupt';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMetric(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_METRIC;
}

function isEntry(value: unknown): value is LeaderboardEntry {
  if (!isRecord(value)) return false;
  if (typeof value.playerId !== 'string' || !LEADERBOARD_PLAYER_ID_RE.test(value.playerId)) return false;
  if (typeof value.nickname !== 'string' || value.nickname.length === 0
    || value.nickname.length > LEADERBOARD_NICKNAME_MAX_LENGTH) return false;
  if (!isMetric(value.wins) || !isMetric(value.gamesPlayed) || !isMetric(value.bestAsset) || !isMetric(value.mapCount)) {
    return false;
  }
  // 胜场不可能多于总场次。这一条同时挡掉「wins=9999 / gamesPlayed=1」的伪造。
  if (value.wins > value.gamesPlayed) return false;
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || value.updatedAt < 0) return false;
  return true;
}

/**
 * 排序规则：**先看胜场**（这是排行榜的本体），同胜场比资产峰值，再比总局数，
 * 最后用「谁先达到」与 `playerId` 收尾 —— 必须完全确定，否则同分两人的名次会在
 * 每次读取时来回跳，玩家会以为自己被吞了。
 */
export function sortLeaderboardEntries(entries: readonly LeaderboardEntry[]): LeaderboardEntry[] {
  return [...entries].sort((left, right) => (
    right.wins - left.wins
    || right.bestAsset - left.bestAsset
    || right.gamesPlayed - left.gamesPlayed
    || left.updatedAt - right.updatedAt
    || left.playerId.localeCompare(right.playerId)
  ));
}

/**
 * 校验一份客户端提交。**只保留白名单字段**，多余键一律忽略 —— 这样客户端将来加字段
 * 不会让服务端存下不认识的东西。
 */
export function parseLeaderboardSubmission(value: unknown): LeaderboardSubmission | null {
  if (!isRecord(value)) return null;
  if (typeof value.playerId !== 'string' || !LEADERBOARD_PLAYER_ID_RE.test(value.playerId)) return null;

  const nickname = typeof value.nickname === 'string' ? value.nickname.trim() : '';
  if (nickname.length === 0 || nickname.length > LEADERBOARD_NICKNAME_MAX_LENGTH) return null;

  const { wins, gamesPlayed, bestAsset, mapCount } = value;
  if (!isMetric(wins) || !isMetric(gamesPlayed) || !isMetric(bestAsset) || !isMetric(mapCount)) return null;
  if (wins > gamesPlayed) return null;

  return { playerId: value.playerId, nickname, wins, gamesPlayed, bestAsset, mapCount };
}

/** 结构校验整份榜单文件。版本不符一律视为不可用。 */
export function parseLeaderboardFile(value: unknown): LeaderboardFile | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== LEADERBOARD_SCHEMA_VERSION) return null;
  if (!Array.isArray(value.entries)) return null;
  const entries = value.entries.filter(isEntry);
  return { schemaVersion: LEADERBOARD_SCHEMA_VERSION, entries };
}

export function createLeaderboardStore(options: CreateLeaderboardStoreOptions): LeaderboardStore {
  const file = options.file;
  const maxEntries = Math.max(1, options.maxEntries ?? LEADERBOARD_MAX_ENTRIES);
  const retentionMs = options.retentionMs ?? DEFAULT_LEADERBOARD_RETENTION_MS;
  const now = options.now ?? Date.now;

  /** playerId -> entry。用 Map 保证重复提交是更新而不是新增。 */
  const byPlayer = new Map<string, LeaderboardEntry>();

  const prune = (): void => {
    if (retentionMs <= 0) return;
    const deadline = now() - retentionMs;
    for (const [playerId, entry] of byPlayer) {
      if (entry.updatedAt < deadline) byPlayer.delete(playerId);
    }
  };

  /**
   * 读取落盘榜单。坏文件隔离、版本不符丢弃、过期条目清理 —— 全部只影响自己，
   * 绝不抛错（榜单坏了不该让服务端起不来）。
   */
  const load = (): void => {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      // 文件不存在 = 还没有榜单，不是错误。
      return;
    }
    let parsed: LeaderboardFile | null = null;
    try {
      parsed = parseLeaderboardFile(JSON.parse(raw));
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      quarantine(file);
      return;
    }
    for (const entry of parsed.entries) byPlayer.set(entry.playerId, entry);
    prune();
  };

  /** 排序 + 截断后落盘。 */
  const persist = (): void => {
    const payload: LeaderboardFile = {
      schemaVersion: LEADERBOARD_SCHEMA_VERSION,
      entries: sortLeaderboardEntries([...byPlayer.values()]).slice(0, maxEntries),
    };
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}${TEMP_FILE_SUFFIX}`;
    writeFileSync(temp, JSON.stringify(payload), 'utf8');
    renameSync(temp, file);
  };

  load();

  /** 已排序并截断的当前榜单。 */
  const currentEntries = (): LeaderboardEntry[] =>
    sortLeaderboardEntries([...byPlayer.values()]).slice(0, maxEntries);

  return {
    upsert(submission) {
      const entry: LeaderboardEntry = {
        playerId: submission.playerId,
        nickname: submission.nickname,
        wins: submission.wins,
        gamesPlayed: submission.gamesPlayed,
        bestAsset: submission.bestAsset,
        mapCount: submission.mapCount,
        updatedAt: Math.floor(now()),
      };
      byPlayer.set(entry.playerId, entry);
      prune();
      persist();
      return entry;
    },

    entries: currentEntries,

    rankOf(playerId) {
      const index = currentEntries().findIndex((entry) => entry.playerId === playerId);
      return index === -1 ? null : index + 1;
    },

    size() {
      return byPlayer.size;
    },
  };
}

/** 坏文件改名隔离：既不参与读取，也不会每次启动被反复解析。 */
function quarantine(file: string): void {
  try {
    renameSync(file, `${file}${CORRUPT_FILE_SUFFIX}`);
  } catch {
    try {
      rmSync(file, { force: true });
    } catch {
      // 无能为力：保留原文件，下次启动再试。
    }
  }
}
