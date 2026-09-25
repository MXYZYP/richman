import {
  emptyPlayerStats,
  mergePlayerStats,
  subtractPlayerStats,
  type PlayerStats,
} from './playerStats';
import type { StorageLike } from './sessionStorage';

// 战绩上云的客户端（路线图 #123，第五批-3）。
//
// 与「战绩码」(#102) 的分工，界面上必须能一眼分清：
//   · **战绩码**：离线搬运。把战绩编成一段字符串交给你自己保管，不需要服务器，也没有账号。
//   · **恢复码**：在线账号。战绩存在服务器上，凭这段码在别的设备取回，之后可以反复同步。
//
// 三条自觉的规矩（沿用排行榜 #116 的做法）：
//  1. **不点不联网**。这里没有任何自动提交；界面把它挂在按钮上。
//  2. **上传什么，界面上写清楚**：昵称 + 一份完整战绩（局数 / 胜负 / 资产峰值 / 各地图次数
//      / 最后游玩时间）。没有对局内容、没有设备信息。
//  3. **服务端回来的东西不可信**：`parseCloudStats` 逐字段校验后才交给界面，
//     形状不对就当成「取不到」，绝不把半截数据写进本地战绩。
//
// ───────────────────── 为什么恢复码存在 localStorage ─────────────────────
// 恢复码是 bearer 凭据，存本机确实等于「这台设备已登录」。之所以接受：
// 它保护的只是一份战绩数字（没有邮箱、没有手机号、没有支付信息），而每次同步都要重新抄
// 一段 20 位码的体验是不可用的。玩家怀疑码泄露时，界面提供「换一段恢复码」——
// 旧码立即失效，这才是无密码账号真正的补救手段。
//
// 隐私边界：本机**不会**把恢复码发给除这三个接口以外的任何地方，也不会写进日志。

export const PLAYER_SYNC_ENDPOINT = '/api/player/sync';
export const PLAYER_RESTORE_ENDPOINT = '/api/player/restore';
export const PLAYER_ROTATE_ENDPOINT = '/api/player/rotate';

/** 本机绑定的云端账号（含基线与云端快照）。 */
export const CLOUD_ACCOUNT_KEY = 'richman_cloud_account_v1';
export const CLOUD_ACCOUNT_SCHEMA_VERSION = 1;

/** 与服务端 `PLAYER_NICKNAME_MAX_LENGTH` 一致。 */
export const CLOUD_NICKNAME_MAX_LENGTH = 12;
/** 与服务端同口径的单字段上限。 */
export const CLOUD_MAX_METRIC = 10_000_000;
/** 与服务端 `PLAYER_STATS_MAX_MAPS` 一致。 */
export const CLOUD_MAX_MAPS = 64;
const CLOUD_MAP_ID_MAX_LENGTH = 64;
/** 与服务端 `MAX_STATS_TIMESTAMP` 一致（2100 年）。 */
const MAX_STATS_TIMESTAMP = 4_102_444_800_000;
const FALLBACK_NICKNAME = '大富翁玩家';

// ───────────────────── 恢复码（服务端的镜像） ─────────────────────
//
// ★ 这是一份**刻意的镜像**：字母表与校验位算法必须与服务端 `playerAccountStore.ts` 完全一致。
// 作用不是安全，而是**在发请求之前**就把手抄错误拦下来（把 `5` 抄成 `S` 会当场指出），
// 省掉一次必然失败的往返。真正的校验永远在服务端 —— 客户端这一层被绕过了也无所谓。

const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_CODE_PREFIX = 'RM';
const RECOVERY_CODE_GROUP_SIZE = 4;
const RECOVERY_CODE_GROUPS = 5;
const RECOVERY_DATA_LENGTH = RECOVERY_CODE_GROUP_SIZE * RECOVERY_CODE_GROUPS - 1;
const RECOVERY_CODE_LENGTH = RECOVERY_DATA_LENGTH + 1;
const ACCOUNT_ID_RE = /^[0-9a-f]{16}$/;

function checkSymbol(data: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < data.length; index += 1) {
    hash ^= data.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return RECOVERY_ALPHABET.charAt((hash >>> 0) % RECOVERY_ALPHABET.length);
}

/** 规范化玩家抄来的恢复码（大写化、丢弃一切非字母表字符）；长度或校验位不对返回 `null`。 */
export function normalizeRecoveryCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let compact = '';
  for (const char of raw.toUpperCase()) {
    if (RECOVERY_ALPHABET.includes(char)) compact += char;
  }
  if (compact.length === RECOVERY_CODE_LENGTH + RECOVERY_CODE_PREFIX.length
    && compact.startsWith(RECOVERY_CODE_PREFIX)) {
    compact = compact.slice(RECOVERY_CODE_PREFIX.length);
  }
  if (compact.length !== RECOVERY_CODE_LENGTH) return null;
  if (checkSymbol(compact.slice(0, RECOVERY_DATA_LENGTH)) !== compact.charAt(RECOVERY_DATA_LENGTH)) return null;
  return compact;
}

/** 展示用格式 `RM-XXXX-XXXX-XXXX-XXXX-XXXX`；无法规范化时返回 `''`。 */
export function formatRecoveryCode(raw: string): string {
  const normalized = normalizeRecoveryCode(raw);
  if (normalized === null) return '';
  const groups: string[] = [];
  for (let index = 0; index < normalized.length; index += RECOVERY_CODE_GROUP_SIZE) {
    groups.push(normalized.slice(index, index + RECOVERY_CODE_GROUP_SIZE));
  }
  return [RECOVERY_CODE_PREFIX, ...groups].join('-');
}

/** 昵称清理：空则用兜底名，超长截断（服务端也会校验，这里是让玩家不必因为 13 个字被拒）。 */
export function sanitizeCloudNickname(raw: string): string {
  const trimmed = raw.trim().slice(0, CLOUD_NICKNAME_MAX_LENGTH);
  return trimmed === '' ? FALLBACK_NICKNAME : trimmed;
}

// ───────────────────── 严格校验 ─────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMetric(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= CLOUD_MAX_METRIC;
}

/** 与服务端 `parseStatsPayload` 同一套规则。不符就整份丢弃，绝不部分采用。 */
export function parseCloudStats(value: unknown): PlayerStats | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  const { gamesPlayed, wins, losses, bestAsset, lastPlayedAt } = value;
  if (!isMetric(gamesPlayed) || !isMetric(wins) || !isMetric(losses) || !isMetric(bestAsset)) return null;
  if (typeof lastPlayedAt !== 'number' || !Number.isSafeInteger(lastPlayedAt)
    || lastPlayedAt < 0 || lastPlayedAt > MAX_STATS_TIMESTAMP) return null;
  if (wins > gamesPlayed || losses > gamesPlayed) return null;

  const favoriteMaps: Record<string, number> = {};
  if (value.favoriteMaps !== undefined) {
    if (!isRecord(value.favoriteMaps)) return null;
    const entries = Object.entries(value.favoriteMaps);
    if (entries.length > CLOUD_MAX_MAPS) return null;
    for (const [mapId, count] of entries) {
      if (mapId.length === 0 || mapId.length > CLOUD_MAP_ID_MAX_LENGTH) return null;
      if (!isMetric(count) || count === 0) return null;
      favoriteMaps[mapId] = count;
    }
  }
  return { schemaVersion: 1, gamesPlayed, wins, losses, bestAsset, favoriteMaps, lastPlayedAt };
}

// ───────────────────── 本机绑定关系 ─────────────────────

export interface CloudAccountLink {
  readonly schemaVersion: 1;
  readonly accountId: string;
  readonly nickname: string;
  /** 本机保存的恢复码（已规范化）。等价于「这台设备已登录」，见文件头的取舍说明。 */
  readonly code: string;
  /** 已经记入云端的本机战绩基线 —— 增量由它算出，防止重复同步把数字翻倍。 */
  readonly baseline: PlayerStats;
  /** 最近一次拿到的云端快照，只用于展示（不参与任何计算）。 */
  readonly cloud: PlayerStats;
  readonly lastSyncedAt: number;
}

function parseLink(value: unknown): CloudAccountLink | null {
  if (!isRecord(value) || value.schemaVersion !== CLOUD_ACCOUNT_SCHEMA_VERSION) return null;
  if (typeof value.accountId !== 'string' || !ACCOUNT_ID_RE.test(value.accountId)) return null;
  if (typeof value.nickname !== 'string' || value.nickname.length === 0
    || value.nickname.length > CLOUD_NICKNAME_MAX_LENGTH) return null;
  const code = normalizeRecoveryCode(value.code);
  // 恢复码读坏了 = 这个绑定已经不可用（同步必然被拒）。整份丢弃，让玩家重新输入一段码，
  // 而不是留着一个「看起来已登录、点同步就报错」的状态。
  if (code === null) return null;
  const baseline = parseCloudStats(value.baseline);
  const cloud = parseCloudStats(value.cloud);
  if (baseline === null || cloud === null) return null;
  if (typeof value.lastSyncedAt !== 'number' || !Number.isFinite(value.lastSyncedAt) || value.lastSyncedAt < 0) return null;
  return {
    schemaVersion: CLOUD_ACCOUNT_SCHEMA_VERSION,
    accountId: value.accountId,
    nickname: value.nickname,
    code,
    baseline,
    cloud,
    lastSyncedAt: Math.floor(value.lastSyncedAt),
  };
}

export function loadCloudLink(storage: StorageLike): CloudAccountLink | null {
  let raw: string | null;
  try {
    raw = storage.getItem(CLOUD_ACCOUNT_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    return parseLink(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 写入绑定关系；存储不可用时返回 `false`（调用方据此如实提示，而不是假装已同步）。 */
export function saveCloudLink(storage: StorageLike, link: CloudAccountLink): boolean {
  try {
    storage.setItem(CLOUD_ACCOUNT_KEY, JSON.stringify(link));
    return true;
  } catch {
    return false;
  }
}

/** 解除绑定。**只删本机的关联**，云端那份战绩照旧（重新输入恢复码即可再取回）。 */
export function clearCloudLink(storage: StorageLike): void {
  try {
    storage.removeItem(CLOUD_ACCOUNT_KEY);
  } catch {
    // 删不掉也不影响本次会话：内存里的状态已经清空，下次读取仍会看到旧值。
  }
}

// ───────────────────── 增量与合并（纯函数） ─────────────────────

/**
 * 组装要提交给服务端的增量。
 *
 * 除了差值，还要做一件事：把 `gamesPlayed` 抬到不小于 `wins`/`losses`。
 * 服务端会以「字段间不自洽」为由 400 拒收，而这份数据是要拿去存起来的 ——
 * 宁可多记一局（数字偏保守），也不要整次同步被驳回。这与 `buildLeaderboardSubmission`
 * 的处理是同一个理由。
 */
export function buildSyncDelta(local: PlayerStats, baseline: PlayerStats): PlayerStats {
  const delta = subtractPlayerStats(local, baseline);
  return {
    ...delta,
    gamesPlayed: Math.max(delta.gamesPlayed, delta.wins, delta.losses),
  };
}

/**
 * 把云端战绩并回本机：只吸收「云端有、而本机已上传部分里没有」的那一份
 * （即 `cloud - baseline`），因此**不会**把本机已经上传过的数字再加一遍。
 *
 * 新设备上 `baseline` 是空的，于是整份云端战绩都被吸收 —— 这正是「换设备恢复」的语义。
 */
export function applyCloudToLocal(local: PlayerStats, baseline: PlayerStats, cloud: PlayerStats): PlayerStats {
  return mergePlayerStats(local, subtractPlayerStats(cloud, baseline));
}

export interface CloudSyncOutcome {
  readonly created: boolean;
  readonly accountId: string;
  readonly nickname: string;
  readonly cloud: PlayerStats;
  /** 只在**建号**与**换码**时才有明文；其余一律为 `null`（服务端也不会回）。 */
  readonly recoveryCode: string | null;
  readonly updatedAt: number;
}

export interface CloudRestoreOutcome {
  readonly accountId: string;
  readonly nickname: string;
  readonly cloud: PlayerStats;
  readonly updatedAt: number;
}

/** 同步成功后的新绑定关系：本机战绩已全部记入云端，基线因此就是当前本机战绩。 */
export function linkAfterSync(
  previous: CloudAccountLink | null,
  outcome: CloudSyncOutcome,
  local: PlayerStats,
  at: number,
): CloudAccountLink {
  return {
    schemaVersion: CLOUD_ACCOUNT_SCHEMA_VERSION,
    accountId: outcome.accountId,
    nickname: outcome.nickname,
    // 建号 / 换码时用服务端新给的那段；平时沿用本机已有的（服务端不回明文）。
    code: normalizeRecoveryCode(outcome.recoveryCode ?? '') ?? previous?.code ?? '',
    baseline: local,
    cloud: outcome.cloud,
    lastSyncedAt: at,
  };
}

export interface CloudRestorePlan {
  readonly merged: PlayerStats;
  readonly link: CloudAccountLink;
}

/**
 * 换码成功后的新绑定关系。
 *
 * 只替换恢复码，**不动 `baseline`**：换码不改变任何战绩数字，而基线记的是「本机已上传到哪一份」，
 * 顺手把它抬到当前本机战绩会白白漏掉「还没上传的那部分」（下次同步就送不上去）。
 */
export function linkAfterRotate(
  previous: CloudAccountLink,
  outcome: CloudSyncOutcome,
  at: number,
): CloudAccountLink {
  const rotated = normalizeRecoveryCode(outcome.recoveryCode ?? '');
  return {
    ...previous,
    nickname: outcome.nickname,
    code: rotated ?? previous.code,
    cloud: outcome.cloud,
    lastSyncedAt: at,
  };
}/**
 * 恢复的完整计划（纯函数，便于把最容易算错的一步单独测掉）：
 * 把云端盈余并进本机，并把基线重置为云端快照 —— 因为本机此刻已经包含了云端的一切，
 * 之后再上传就只会送「云端还没有的那部分」，不会翻倍。
 *
 * `code` 由调用方给出（新设备上是玩家刚输入的那段），因为此时本机还没有绑定关系可沿用。
 */
export function planCloudRestore(
  local: PlayerStats,
  previous: CloudAccountLink | null,
  code: string,
  outcome: CloudRestoreOutcome,
  at: number,
): CloudRestorePlan {
  const normalized = normalizeRecoveryCode(code) ?? '';
  const merged = applyCloudToLocal(local, previous?.baseline ?? emptyPlayerStats(), outcome.cloud);
  return {
    merged,
    link: {
      schemaVersion: CLOUD_ACCOUNT_SCHEMA_VERSION,
      accountId: outcome.accountId,
      nickname: outcome.nickname,
      code: normalized,
      baseline: outcome.cloud,
      cloud: outcome.cloud,
      lastSyncedAt: at,
    },
  };
}

// ───────────────────── 网络 ─────────────────────

export type CloudFailure = 'network' | 'server' | 'rate_limited' | 'code_invalid' | 'too_large' | 'storage';

export type CloudSyncResult =
  | { ok: true; outcome: CloudSyncOutcome }
  | { ok: false; reason: CloudFailure };

export type CloudRestoreResult =
  | { ok: true; outcome: CloudRestoreOutcome }
  | { ok: false; reason: CloudFailure };

/** 与 `fetch` 同形的传输函数，便于测试注入（node 测试里没有真实网络）。 */
export type CloudRequest = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

export interface CloudCallOptions {
  /** 省略则用全局 `fetch`。 */
  request?: CloudRequest;
}

export interface CloudSyncInput {
  readonly local: PlayerStats;
  readonly nickname: string;
  /** 已绑定的账号；`null` = 要新建一个。 */
  readonly link: CloudAccountLink | null;
}

function resolveRequest(options: CloudCallOptions): CloudRequest | null {
  if (options.request !== undefined) return options.request;
  const globalFetch = (globalThis as { fetch?: CloudRequest }).fetch;
  return typeof globalFetch === 'function' ? globalFetch : null;
}

function failureOfStatus(status: number): CloudFailure {
  if (status === 401) return 'code_invalid';
  if (status === 413) return 'too_large';
  if (status === 429) return 'rate_limited';
  return 'server';
}

async function postJson(
  url: string,
  body: unknown,
  options: CloudCallOptions,
): Promise<{ ok: true; payload: unknown } | { ok: false; reason: CloudFailure }> {
  const request = resolveRequest(options);
  if (request === null) return { ok: false, reason: 'network' };
  let response: Response;
  try {
    response = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, reason: 'network' };
  }
  if (!response.ok) return { ok: false, reason: failureOfStatus(response.status) };
  try {
    return { ok: true, payload: await response.json() };
  } catch {
    return { ok: false, reason: 'server' };
  }
}

/** 建号或同步。**只有显式调用才会发出请求**。 */
export async function syncToCloud(
  input: CloudSyncInput,
  options: CloudCallOptions = {},
): Promise<CloudSyncResult> {
  const baseline = input.link?.baseline ?? emptyPlayerStats();
  const body: Record<string, unknown> = {
    nickname: sanitizeCloudNickname(input.nickname),
    stats: buildSyncDelta(input.local, baseline),
  };
  if (input.link !== null) body.code = input.link.code;

  const posted = await postJson(PLAYER_SYNC_ENDPOINT, body, options);
  if (!posted.ok) return posted;
  const outcome = parseSyncPayload(posted.payload);
  return outcome === null ? { ok: false, reason: 'server' } : { ok: true, outcome };
}

/** 凭恢复码把云端战绩读回来（只读，不改云端）。 */
export async function restoreFromCloud(
  code: string,
  options: CloudCallOptions = {},
): Promise<CloudRestoreResult> {
  const posted = await postJson(PLAYER_RESTORE_ENDPOINT, { code }, options);
  if (!posted.ok) return posted;
  const outcome = parseRestorePayload(posted.payload);
  return outcome === null ? { ok: false, reason: 'server' } : { ok: true, outcome };
}

/** 换一段新恢复码（旧码立即失效）。返回的 `recoveryCode` 是新的那段。 */
export async function rotateRecoveryCode(
  code: string,
  options: CloudCallOptions = {},
): Promise<CloudSyncResult> {
  const posted = await postJson(PLAYER_ROTATE_ENDPOINT, { code }, options);
  if (!posted.ok) return posted;
  const outcome = parseSyncPayload(posted.payload);
  return outcome === null ? { ok: false, reason: 'server' } : { ok: true, outcome };
}

function parseSyncPayload(value: unknown): CloudSyncOutcome | null {
  if (!isRecord(value) || value.ok !== true) return null;
  if (typeof value.accountId !== 'string' || !ACCOUNT_ID_RE.test(value.accountId)) return null;
  if (typeof value.nickname !== 'string' || value.nickname.length === 0
    || value.nickname.length > CLOUD_NICKNAME_MAX_LENGTH) return null;
  const cloud = parseCloudStats(value.stats);
  if (cloud === null) return null;
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return null;
  // `recoveryCode` 可能缺席（平时同步就不回）。在的时候必须是一段合法码，否则宁可当作没有 ——
  // 把一段抄错/半截的码存进本机，会让这台设备之后每一次同步都失败。
  const recoveryCode = value.recoveryCode === undefined ? null : formatRecoveryCode(String(value.recoveryCode));
  return {
    created: value.created === true,
    accountId: value.accountId,
    nickname: value.nickname,
    cloud,
    recoveryCode: recoveryCode === '' ? null : recoveryCode,
    updatedAt: Math.floor(value.updatedAt),
  };
}

function parseRestorePayload(value: unknown): CloudRestoreOutcome | null {
  if (!isRecord(value) || value.ok !== true) return null;
  if (typeof value.accountId !== 'string' || !ACCOUNT_ID_RE.test(value.accountId)) return null;
  if (typeof value.nickname !== 'string' || value.nickname.length === 0
    || value.nickname.length > CLOUD_NICKNAME_MAX_LENGTH) return null;
  const cloud = parseCloudStats(value.stats);
  if (cloud === null) return null;
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return null;
  return {
    accountId: value.accountId,
    nickname: value.nickname,
    cloud,
    updatedAt: Math.floor(value.updatedAt),
  };
}

/** 把失败原因翻成一句人话。界面不再自己判断该说什么。 */
export function describeCloudFailure(reason: CloudFailure): string {
  if (reason === 'network') return '连不上服务器，稍后再试（不影响本机战绩）。';
  if (reason === 'rate_limited') return '操作太频繁，等一会儿再试。';
  if (reason === 'code_invalid') return '这段恢复码不对（可能抄错了一位，或者已经换过码）。';
  if (reason === 'too_large') return '本机战绩数据太大，服务器拒收了。';
  if (reason === 'storage') return '当前浏览器不允许本地存储，没法记住这个账号。';
  return '服务器没能处理这次请求，稍后再试。';
}
