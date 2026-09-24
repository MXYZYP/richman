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

// ───────────────────── 战绩码：导入 / 导出（路线图 #102） ─────────────────────
//
// 「战绩上云」的最小版本：不引入账号与密码，战绩通过一段可复制/可粘贴的**战绩码**搬运。
// 码里只装两样东西——**昵称**与**战绩**——恰好就是「上云」真正需要的东西，
// 顺带让换设备、清缓存、分享给好友都变得可能。
//
// 为什么是「合并」而不是「覆盖」：覆盖会让刚在新设备上打的那几局凭空消失，
// 那是比丢战绩更糟的体验（玩家会认为导入把数据弄坏了）。合并的唯一风险是
// 「一份码被重复导入导致重复计数」，所以每份码都留指纹、记住最近导入过的那些。

export const STATS_CODE_PREFIX = 'RMSTATS1';
/** 记住最近导入过的码指纹，避免同一份码重复粘贴把局数翻倍。 */
export const PLAYER_STATS_IMPORTS_KEY = 'richman_player_stats_imports_v1';
const STATS_CODE_PAYLOAD_VERSION = 1;
const MAX_REMEMBERED_IMPORTS = 20;
const MAX_CODE_NICKNAME_LENGTH = 24;

export interface StatsCodePayload {
  nickname: string;
  stats: PlayerStats;
}

/** 解码失败的原因：格式不对（含版本不符）还是校验和不对（多半是复制时掉字符）。 */
export type StatsCodeFailure = 'format' | 'checksum';

export type StatsCodeDecodeResult =
  | { ok: true; payload: StatsCodePayload }
  | { ok: false; reason: StatsCodeFailure };

export type ImportStatsOutcome =
  | { ok: true; applied: boolean; nickname: string; stats: PlayerStats }
  | { ok: false; reason: StatsCodeFailure | 'storage' };

/** 32 位 FNV-1a：只为「复制时掉了几个字符」这种错误兜底，不承担任何安全职责。 */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** 把「昵称 + 战绩」编成一段可复制、可粘贴的码（中文昵称走 UTF-8，不会因编码坏掉）。 */
export function encodeStatsCode(payload: StatsCodePayload): string {
  const json = JSON.stringify({
    v: STATS_CODE_PAYLOAD_VERSION,
    nickname: payload.nickname,
    stats: payload.stats,
  });
  const body = bytesToBase64Url(new TextEncoder().encode(json));
  return `${STATS_CODE_PREFIX}.${body}.${fingerprint(body)}`;
}

/**
 * 解析一段战绩码。校验顺序刻意「先便宜的后贵的」：先看前缀与段数，再看校验和，
 * 最后才解码 + 逐字段校验——粘贴来的垃圾字符串不该让 JSON.parse 白跑一趟。
 * 粘贴过程中产生的空白（换行、空格）一律先抹掉，否则从聊天窗口复制过来必然失败。
 */
export function decodeStatsCode(code: string): StatsCodeDecodeResult {
  const trimmed = typeof code === 'string' ? code.replace(/\s+/g, '') : '';
  const parts = trimmed.split('.');
  if (parts.length !== 3 || parts[0] !== STATS_CODE_PREFIX) return { ok: false, reason: 'format' };

  const body = parts[1] ?? '';
  const checksum = parts[2] ?? '';
  if (fingerprint(body) !== checksum) return { ok: false, reason: 'checksum' };

  const bytes = base64UrlToBytes(body);
  if (bytes === null) return { ok: false, reason: 'format' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, reason: 'format' };
  }
  if (!isRecord(parsed) || parsed.v !== STATS_CODE_PAYLOAD_VERSION) return { ok: false, reason: 'format' };

  // 复用同一套严格校验：码里的战绩与本地写盘的战绩必须过同一个门。
  const stats = parseStats(parsed.stats);
  if (stats === null) return { ok: false, reason: 'format' };

  const nickname = typeof parsed.nickname === 'string' ? parsed.nickname.trim().slice(0, MAX_CODE_NICKNAME_LENGTH) : '';
  return { ok: true, payload: { nickname, stats } };
}

/** 合并两份战绩：局数/胜负/地图使用次数相加，峰值与时间取较大者。 */
export function mergePlayerStats(base: PlayerStats, incoming: PlayerStats): PlayerStats {
  const favoriteMaps: Record<string, number> = { ...base.favoriteMaps };
  for (const [mapId, count] of Object.entries(incoming.favoriteMaps)) {
    favoriteMaps[mapId] = (favoriteMaps[mapId] ?? 0) + count;
  }
  return {
    schemaVersion: 1,
    gamesPlayed: base.gamesPlayed + incoming.gamesPlayed,
    wins: base.wins + incoming.wins,
    losses: base.losses + incoming.losses,
    bestAsset: Math.max(base.bestAsset, incoming.bestAsset),
    favoriteMaps,
    lastPlayedAt: Math.max(base.lastPlayedAt, incoming.lastPlayedAt),
  };
}

function loadAppliedImports(storage: StorageLike): string[] {
  let raw: string | null;
  try {
    raw = storage.getItem(PLAYER_STATS_IMPORTS_KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function writeJson(storage: StorageLike, key: string, value: unknown): boolean {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * 导入一段战绩码（路线图 #102）。同一份码重复导入只算一次（指纹去重），
 * 不同码则相加合并。存储不可用时如实报 `storage` 失败，而不是假装成功。
 */
export function importStatsCode(storage: StorageLike, code: string): ImportStatsOutcome {
  const decoded = decodeStatsCode(code);
  if (!decoded.ok) return { ok: false, reason: decoded.reason };

  const fingerprintOfCode = fingerprint(typeof code === 'string' ? code.replace(/\s+/g, '') : '');
  const appliedImports = loadAppliedImports(storage);
  const current = loadPlayerStats(storage);
  if (appliedImports.includes(fingerprintOfCode)) {
    return { ok: true, applied: false, nickname: decoded.payload.nickname, stats: current };
  }

  const merged = mergePlayerStats(current, decoded.payload.stats);
  if (!writeJson(storage, PLAYER_STATS_KEY, merged)) return { ok: false, reason: 'storage' };
  // 指纹记不上不影响这次合并的正确性，只影响「下次重复粘贴会不会重复计数」，因此失败不报错。
  writeJson(storage, PLAYER_STATS_IMPORTS_KEY, [...appliedImports, fingerprintOfCode].slice(-MAX_REMEMBERED_IMPORTS));
  return { ok: true, applied: true, nickname: decoded.payload.nickname, stats: merged };
}
