import type { PlayerStats } from './playerStats';
import type { StorageLike } from './sessionStorage';

// 成就排行榜的客户端（路线图 #116）。
//
// 「成就」全部在本地从战绩派生（见 `achievements.ts`），**不需要网络**；这一份只负责
// 那件必须联网的事：把本机战绩里的四个聚合数字发到服务端，换回一张榜单。
//
// 三条自觉的规矩：
//  1. **不点不上传**。这里没有任何自动提交逻辑，只提供「上传一次」的方法；
//     `HomeView` 也只把它挂在按钮上。
//  2. **上传什么，界面上写清楚**：昵称 + 胜场 + 总局数 + 资产峰值 + 玩过的地图数。
//     没有账号、没有 token、没有对局内容、没有时间戳（时间由服务端盖章）。
//  3. **服务端回来的东西不可信**：`parseLeaderboardPayload` 逐字段校验后才交给界面，
//     形状不对就当成「取不到」，绝不把半截数据渲染出去。

/** 与服务端同源的接口路径（同源部署，不需要配置 base）。 */
export const LEADERBOARD_ENDPOINT = '/api/leaderboard';

/** 本机随机玩家标识的存储键。它只用来把「同一个人重复提交」认成同一条记录。 */
export const PLAYER_ID_KEY = 'richman_player_id_v1';

/** 与服务端 `MAX_METRIC` 一致的单字段上限；超了就先截断，免得整次提交被判非法。 */
export const LEADERBOARD_MAX_METRIC = 10_000_000;
const NICKNAME_MAX_LENGTH = 12;
const FALLBACK_NICKNAME = '大富翁玩家';
const PLAYER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export interface LeaderboardEntry {
  readonly playerId: string;
  readonly nickname: string;
  readonly wins: number;
  readonly gamesPlayed: number;
  readonly bestAsset: number;
  readonly mapCount: number;
  readonly updatedAt: number;
}

export interface LeaderboardSubmission {
  readonly playerId: string;
  readonly nickname: string;
  readonly wins: number;
  readonly gamesPlayed: number;
  readonly bestAsset: number;
  readonly mapCount: number;
}

export type LeaderboardFailure = 'network' | 'server' | 'rate_limited' | 'storage';

export type LeaderboardResult =
  | { ok: true; entries: readonly LeaderboardEntry[]; rank: number | null }
  | { ok: false; reason: LeaderboardFailure };

/** 与 `fetch` 同形的传输函数，便于测试注入（node 测试里没有真实网络）。 */
export type LeaderboardRequest = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;

export interface LeaderboardCallOptions {
  /** 省略则用全局 `fetch`。 */
  request?: LeaderboardRequest;
  /** 本机玩家标识；传 `null` 表示「只读榜单，不带我的名次」。 */
  playerId?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMetric(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * 生成一个本机玩家标识。16 位十六进制已经远够用了——它只用来去重，
 * 不是凭据，也不承担任何安全职责（谁都能伪造一个，代价只是榜上多一行）。
 */
export function randomPlayerId(random: () => number = Math.random): string {
  let id = '';
  for (let index = 0; index < 4; index += 1) {
    id += Math.floor(random() * 0x1_0000_0000).toString(16).padStart(8, '0');
  }
  return id;
}

/** 读取本机玩家标识；没存过、存坏了、格式不对都返回 `null`。 */
export function loadPlayerId(storage: StorageLike): string | null {
  let raw: string | null;
  try {
    raw = storage.getItem(PLAYER_ID_KEY);
  } catch {
    return null;
  }
  return raw !== null && PLAYER_ID_RE.test(raw) ? raw : null;
}

/**
 * 拿到（必要时生成并落盘）本机玩家标识。
 *
 * 存储不可用时返回 `null` 而**不是**一个临时 id：否则每次提交都会生成一个新身份，
 * 榜上就会不断冒出同一个人的多行记录——那比「这次不传」糟得多。
 */
export function ensurePlayerId(storage: StorageLike): string | null {
  const existing = loadPlayerId(storage);
  if (existing !== null) return existing;
  const created = randomPlayerId();
  try {
    storage.setItem(PLAYER_ID_KEY, created);
  } catch {
    return null;
  }
  return created;
}

/**
 * 把本机战绩收拾成一份可提交的记录。**纯函数**。
 *
 * 两处刻意的容错：`gamesPlayed` 会被抬到不小于 `wins`（导入来的战绩码不保证这条不变式，
 * 而服务端会直接拒收），各字段按上限截断。宁可传一个保守的数字，也不要整次提交被驳回。
 */
export function buildLeaderboardSubmission(
  stats: PlayerStats,
  nickname: string,
  playerId: string,
): LeaderboardSubmission {
  const trimmed = nickname.trim().slice(0, NICKNAME_MAX_LENGTH);
  const wins = clampMetric(stats.wins);
  const playedMaps = Object.values(stats.favoriteMaps).filter((games) => games > 0).length;
  return {
    playerId,
    nickname: trimmed === '' ? FALLBACK_NICKNAME : trimmed,
    wins,
    gamesPlayed: Math.max(wins, clampMetric(stats.gamesPlayed)),
    bestAsset: clampMetric(stats.bestAsset),
    mapCount: clampMetric(playedMaps),
  };
}

function clampMetric(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), LEADERBOARD_MAX_METRIC);
}

/** 逐字段校验服务端返回的一条记录；任何一项不对就整条丢掉。 */
export function parseLeaderboardEntry(value: unknown): LeaderboardEntry | null {
  if (!isRecord(value)) return null;
  if (typeof value.playerId !== 'string' || !PLAYER_ID_RE.test(value.playerId)) return null;
  if (typeof value.nickname !== 'string' || value.nickname.length === 0
    || value.nickname.length > NICKNAME_MAX_LENGTH) return null;
  if (!isMetric(value.wins) || !isMetric(value.gamesPlayed)
    || !isMetric(value.bestAsset) || !isMetric(value.mapCount)) return null;
  if (value.wins > value.gamesPlayed) return null;
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return null;
  return {
    playerId: value.playerId,
    nickname: value.nickname,
    wins: value.wins,
    gamesPlayed: value.gamesPlayed,
    bestAsset: value.bestAsset,
    mapCount: value.mapCount,
    updatedAt: value.updatedAt,
  };
}

/** 校验整个响应体。`ok !== true` 或 `entries` 不是数组都算失败。 */
export function parseLeaderboardPayload(value: unknown): { entries: LeaderboardEntry[]; rank: number | null } | null {
  if (!isRecord(value) || value.ok !== true) return null;
  if (!Array.isArray(value.entries)) return null;
  const entries = value.entries.map(parseLeaderboardEntry).filter((entry): entry is LeaderboardEntry => entry !== null);
  const rank = typeof value.rank === 'number' && Number.isSafeInteger(value.rank) && value.rank > 0 ? value.rank : null;
  return { entries, rank };
}

function resolveRequest(options: LeaderboardCallOptions): LeaderboardRequest | null {
  if (options.request !== undefined) return options.request;
  const globalFetch = (globalThis as { fetch?: LeaderboardRequest }).fetch;
  return typeof globalFetch === 'function' ? globalFetch : null;
}

async function readResult(response: Response): Promise<LeaderboardResult> {
  if (response.status === 429) return { ok: false, reason: 'rate_limited' };
  if (!response.ok) return { ok: false, reason: 'server' };
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, reason: 'server' };
  }
  const parsed = parseLeaderboardPayload(payload);
  if (parsed === null) return { ok: false, reason: 'server' };
  return { ok: true, entries: parsed.entries, rank: parsed.rank };
}

/** 拉取榜单；带了 `playerId` 就顺带回自己的名次。网络异常一律归为 `'network'`。 */
export async function loadLeaderboard(options: LeaderboardCallOptions = {}): Promise<LeaderboardResult> {
  const request = resolveRequest(options);
  if (request === null) return { ok: false, reason: 'network' };
  const playerId = options.playerId ?? null;
  const url = playerId === null
    ? LEADERBOARD_ENDPOINT
    : `${LEADERBOARD_ENDPOINT}?playerId=${encodeURIComponent(playerId)}`;

  try {
    const response = await request(url, { headers: { accept: 'application/json' } });
    return await readResult(response);
  } catch {
    return { ok: false, reason: 'network' };
  }
}

/**
 * 提交本机战绩并回榜。**只有显式调用才会发出请求**——界面把它挂在「上榜 / 更新成绩」按钮上。
 */
export async function publishLeaderboard(
  submission: LeaderboardSubmission,
  options: LeaderboardCallOptions = {},
): Promise<LeaderboardResult> {
  const request = resolveRequest(options);
  if (request === null) return { ok: false, reason: 'network' };

  try {
    const response = await request(LEADERBOARD_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(submission),
    });
    return await readResult(response);
  } catch {
    return { ok: false, reason: 'network' };
  }
}

/** 把失败原因翻成一句人话。界面不再自己判断该说什么。 */
export function describeLeaderboardFailure(reason: LeaderboardFailure): string {
  if (reason === 'network') return '连不上服务器，稍后再试（不影响本机战绩与成就）。';
  if (reason === 'rate_limited') return '操作太频繁，等一会儿再试。';
  if (reason === 'storage') return '当前浏览器不允许本地存储，没法记住你的身份，暂时不能上榜。';
  return '服务器没能处理这次请求，稍后再试。';
}
