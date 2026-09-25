import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 战绩上云的服务端账号存储（路线图 #123，第五批-3）。
 *
 * 这里做的事只有一件：把**一整份战绩**存到服务器上，并让玩家在别的设备上凭一段
 * 「恢复码」把它取回来。**没有邮箱、没有密码、没有第三方登录** —— 恢复码本身就是凭据。
 *
 * 工程约定与 `leaderboardStore` / `roomSnapshotStore` 完全一致，因为面对的是同一类问题：
 *  1. **原子写**：先写 `<file>.tmp` 再 `rename`，进程被杀只留下一个没人读的 `.tmp`。
 *  2. **带版本号**：`schemaVersion` 不匹配整份丢弃，改结构抬版本即可。
 *  3. **损坏容错**：坏文件挪成 `.corrupt` 隔离，服务端照常启动。
 *  4. **保留期**：久未同步的账号在读取时清理（默认 365 天）。
 *
 * 与榜单存储的两处**刻意不同**：
 *  - 榜单只存四个聚合数字（公开可看，越少越好）；账号存**完整战绩**（就是「上云」的本体），
 *    包含每张地图的游玩次数。它**只有拿着恢复码的人能读到**，接口从不列出账号。
 *  - 恢复码**只存哈希**（sha256），服务端自己也读不回明文。因此「忘了恢复码」没有找回途径，
 *    只能靠 `rotate` 换一段新的 —— 这是无密码账号必须接受的取舍，而不是实现偷懒。
 *
 * 隐私边界：账号里只有昵称与战绩数字。**没有对局内容、没有 IP、没有设备指纹**，
 * 也没有与房间 token / 榜单 playerId 的任何关联 —— 三套标识互不相通。
 */

export const PLAYER_ACCOUNT_SCHEMA_VERSION = 1;

/** 战绩自身的结构版本，与客户端 `PLAYER_STATS_SCHEMA_VERSION` 一致（客户端会拒收不匹配的）。 */
export const PLAYER_STATS_SCHEMA_VERSION = 1;

/** 昵称上限，与首页昵称输入框、榜单一致（`maxlength="12"`）。 */
export const PLAYER_NICKNAME_MAX_LENGTH = 12;

/**
 * 战绩里最多记住多少张地图。客户端 `favoriteMaps` 只会随地图总数增长（当前 12 张地图），
 * 这里给一个远高于现状的上限，既挡住「塞一万个键撑爆文件」，也不会误伤正常数据。
 */
export const PLAYER_STATS_MAX_MAPS = 64;

/** 单字段上限。与榜单同口径（正常玩不到），只为挡住「伪造一个天文数字」。 */
export const MAX_METRIC = 10_000_000;

/** `lastPlayedAt` 是毫秒时间戳，量级远超 `MAX_METRIC`，因此单独给一个上界（2100 年）。 */
export const MAX_STATS_TIMESTAMP = 4_102_444_800_000;

/** 最多保留多少账号。超出后按「最久未同步」淘汰 —— 防止一份 JSON 无限膨胀。 */
export const PLAYER_ACCOUNT_MAX_ENTRIES = 5_000;

/** 默认保留期 365 天。战绩是玩家真正在意的东西，所以远比榜单的 90 天宽松。 */
export const DEFAULT_PLAYER_ACCOUNT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

export const PLAYER_ACCOUNT_ID_RE = /^[0-9a-f]{16}$/;
const MAP_ID_MAX_LENGTH = 64;

// ───────────────────────────── 恢复码 ─────────────────────────────
//
// 恢复码要**手抄得下来**：玩家会在「客厅的电视」上看到它，然后走进书房敲进另一台电脑。
// 因此刻意不用 base64（大小写混排 + 容易看错的 `l/1`、`O/0`），而用去掉歧义字母的
// Crockford 式大写字母表，并且按每 4 位一组连字符分开 —— 抄错一组时肉眼能立刻定位。
//
// 长度 20 位 = 19 位随机 + 1 位校验。19 × 5 = 95 位熵：暴力猜的代价远超「一份战绩」的价值。
// 校验位的作用是**在发出请求之前**就拦住手抄错误（把 `5` 抄成 `S` 会当场被指出来），
// 而不是省一次网络往返 —— 它只做格式校验，不做任何安全判断。

export const RECOVERY_CODE_PREFIX = 'RM';
export const RECOVERY_CODE_GROUP_SIZE = 4;
export const RECOVERY_CODE_GROUPS = 5;
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_DATA_LENGTH = RECOVERY_CODE_GROUP_SIZE * RECOVERY_CODE_GROUPS - 1;
const RECOVERY_CODE_LENGTH = RECOVERY_DATA_LENGTH + 1;

export type RandomBytes = (size: number) => Uint8Array;
const defaultRandomBytes: RandomBytes = (size) => randomBytes(size);

/** 32 位 FNV-1a 取模字母表长度 —— 只做「抄错了一位」的兜底，不承担安全职责。 */
function checkSymbol(data: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < data.length; index += 1) {
    hash ^= data.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return RECOVERY_ALPHABET.charAt((hash >>> 0) % RECOVERY_ALPHABET.length);
}

/** 生成一段新恢复码。256 恰好是字母表长度的整数倍，因此 `byte % 32` 是均匀的。 */
export function createRecoveryCode(random: RandomBytes = defaultRandomBytes): string {
  const bytes = random(RECOVERY_DATA_LENGTH);
  let data = '';
  for (let index = 0; index < RECOVERY_DATA_LENGTH; index += 1) {
    // `charAt` 而不是 `[index]`：后者在 `noUncheckedIndexedAccess` 下是 `string | undefined`。
    data += RECOVERY_ALPHABET.charAt((bytes[index] ?? 0) % RECOVERY_ALPHABET.length);
  }
  return data + checkSymbol(data);
}

/**
 * 把玩家抄来的东西规范化成 20 位码：大写化、并丢掉一切不属于字母表的字符
 * （连字符、空格、从聊天窗口粘来的换行都会被抹掉）。接受带 `RM-` 前缀与不带两种写法。
 * 长度或校验位不对返回 `null`。
 */
export function normalizeRecoveryCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let compact = '';
  for (const char of raw.toUpperCase()) {
    if (RECOVERY_ALPHABET.includes(char)) compact += char;
  }
  // 带前缀时多出 `RM` 两个字符；不带前缀的 20 位码不可能因为长度与它混淆。
  if (compact.length === RECOVERY_CODE_LENGTH + RECOVERY_CODE_PREFIX.length
    && compact.startsWith(RECOVERY_CODE_PREFIX)) {
    compact = compact.slice(RECOVERY_CODE_PREFIX.length);
  }
  if (compact.length !== RECOVERY_CODE_LENGTH) return null;
  const data = compact.slice(0, RECOVERY_DATA_LENGTH);
  if (checkSymbol(data) !== compact.charAt(RECOVERY_DATA_LENGTH)) return null;
  return compact;
}

/** 展示用格式：`RM-XXXX-XXXX-XXXX-XXXX-XXXX`。只用于给人看，落库一律用规范化后的裸码。 */
export function formatRecoveryCode(code: string): string {
  const normalized = normalizeRecoveryCode(code);
  if (normalized === null) return '';
  const groups: string[] = [];
  for (let index = 0; index < normalized.length; index += RECOVERY_CODE_GROUP_SIZE) {
    groups.push(normalized.slice(index, index + RECOVERY_CODE_GROUP_SIZE));
  }
  return [RECOVERY_CODE_PREFIX, ...groups].join('-');
}

/** 恢复码的哈希。规范化之后再哈希，因此展示格式的差异不影响校验。 */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

// ───────────────────────────── 战绩 ─────────────────────────────

export interface StatsPayload {
  readonly schemaVersion: 1;
  readonly gamesPlayed: number;
  readonly wins: number;
  readonly losses: number;
  readonly bestAsset: number;
  readonly favoriteMaps: Record<string, number>;
  readonly lastPlayedAt: number;
}

export function emptyStatsPayload(): StatsPayload {
  return { schemaVersion: 1, gamesPlayed: 0, wins: 0, losses: 0, bestAsset: 0, favoriteMaps: {}, lastPlayedAt: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMetric(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_METRIC;
}

/**
 * 严格校验一份客户端交上来的战绩。**只保留白名单字段**，多余键一律丢弃。
 *
 * 这是一条**任何人都能 POST** 的公网写接口（哪怕拿不到别人的账号，也能凭空建号刷文件空间），
 * 所以这里宁可严格：结构不符直接 400，而不是「尽量猜玩家的意思」。
 * 唯一一条业务不变式是 `wins ≤ gamesPlayed` 与 `losses ≤ gamesPlayed` ——
 * 客户端 `recordGameResult` 天然满足，累加也保持它。
 */
export function parseStatsPayload(value: unknown): StatsPayload | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== PLAYER_STATS_SCHEMA_VERSION) return null;

  const { gamesPlayed, wins, losses, bestAsset, lastPlayedAt } = value;
  if (!isMetric(gamesPlayed) || !isMetric(wins) || !isMetric(losses) || !isMetric(bestAsset)) return null;
  if (typeof lastPlayedAt !== 'number' || !Number.isSafeInteger(lastPlayedAt)
    || lastPlayedAt < 0 || lastPlayedAt > MAX_STATS_TIMESTAMP) return null;
  if (wins > gamesPlayed || losses > gamesPlayed) return null;

  const favoriteMaps: Record<string, number> = {};
  if (value.favoriteMaps !== undefined) {
    if (!isRecord(value.favoriteMaps)) return null;
    const entries = Object.entries(value.favoriteMaps);
    if (entries.length > PLAYER_STATS_MAX_MAPS) return null;
    for (const [mapId, count] of entries) {
      if (mapId.length === 0 || mapId.length > MAP_ID_MAX_LENGTH) return null;
      if (!isMetric(count) || count === 0) return null;
      favoriteMaps[mapId] = count;
    }
  }

  return { schemaVersion: PLAYER_STATS_SCHEMA_VERSION, gamesPlayed, wins, losses, bestAsset, favoriteMaps, lastPlayedAt };
}

/**
 * 把一份**增量**累加进云端战绩。
 *
 * 两种字段语义刻意不同，因为它们的物理含义本就不同：
 *  - `gamesPlayed / wins / losses / favoriteMaps` 是**计数器** → 相加；
 *  - `bestAsset / lastPlayedAt` 是**峰值/时间点** → 取较大者。
 *
 * 后者取 max 带来一个很有用的性质：**重复提交同一份数据是幂等的**。
 * 否则「这台设备又点了一次同步」就会把资产峰值翻倍，玩家立刻会发现数字不对。
 *
 * 计数器相加后统一按 `gamesPlayed` 与 `MAX_METRIC` 夹紧，保证 `wins/losses ≤ gamesPlayed`
 * 这条不变式在累加后依然成立 —— 宁可少记一次胜场，也不要让云端存下一份自相矛盾的数据。
 */
export function accumulateStats(base: StatsPayload, delta: StatsPayload): StatsPayload {
  const favoriteMaps: Record<string, number> = { ...base.favoriteMaps };
  const knownMaps = Object.keys(favoriteMaps).length;
  let newMaps = 0;
  for (const [mapId, count] of Object.entries(delta.favoriteMaps)) {
    if (favoriteMaps[mapId] === undefined) {
      // 已经记满就不再接纳新地图（按计数排序淘汰会更「公平」，但会让同一次同步的结果
      // 依赖历史分布；简单跳过至少是可预测的）。
      if (knownMaps + newMaps >= PLAYER_STATS_MAX_MAPS) continue;
      newMaps += 1;
    }
    favoriteMaps[mapId] = Math.min(MAX_METRIC, (favoriteMaps[mapId] ?? 0) + count);
  }

  const gamesPlayed = Math.min(MAX_METRIC, base.gamesPlayed + delta.gamesPlayed);
  return {
    schemaVersion: PLAYER_STATS_SCHEMA_VERSION,
    gamesPlayed,
    wins: Math.min(gamesPlayed, Math.min(MAX_METRIC, base.wins + delta.wins)),
    losses: Math.min(gamesPlayed, Math.min(MAX_METRIC, base.losses + delta.losses)),
    bestAsset: Math.max(base.bestAsset, delta.bestAsset),
    favoriteMaps,
    lastPlayedAt: Math.max(base.lastPlayedAt, delta.lastPlayedAt),
  };
}

// ───────────────────────────── 账号 ─────────────────────────────

/** 对外可见的账号快照：**不含 `codeHash`**，任何返回给客户端的路径都用它。 */
export interface PlayerAccountSnapshot {
  readonly accountId: string;
  readonly nickname: string;
  readonly stats: StatsPayload;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface PlayerAccountRecord extends PlayerAccountSnapshot {
  readonly codeHash: string;
}

export interface PlayerAccountStore {
  /** 建号。返回的快照与**只此一次**的明文恢复码（服务端只留哈希，之后再也读不回）。 */
  create(nickname: string, stats: StatsPayload): { account: PlayerAccountSnapshot; recoveryCode: string };
  /** 凭恢复码取回账号；码不对（或已过期）返回 `null`。 */
  authenticate(recoveryCode: string): PlayerAccountSnapshot | null;
  /** 按账号 id 把增量累加进去（可顺带改名），返回累加后的快照；账号不存在返回 `null`。 */
  accumulate(accountId: string, delta: StatsPayload, nickname?: string): PlayerAccountSnapshot | null;
  /** 换一段新恢复码（旧码立即失效），返回新码；账号不存在返回 `null`。 */
  rotate(accountId: string): { account: PlayerAccountSnapshot; recoveryCode: string } | null;
  size(): number;
}

export interface CreatePlayerAccountStoreOptions {
  /** 账号 JSON 文件路径；父目录不存在会自动创建。 */
  file: string;
  retentionMs?: number;
  now?: () => number;
  randomBytes?: RandomBytes;
}

interface PlayerAccountFile {
  schemaVersion: number;
  accounts: PlayerAccountRecord[];
}

const TEMP_FILE_SUFFIX = '.tmp';
const CORRUPT_FILE_SUFFIX = '.corrupt';

function isAccountRecord(value: unknown): value is PlayerAccountRecord {
  if (!isRecord(value)) return false;
  if (typeof value.accountId !== 'string' || !PLAYER_ACCOUNT_ID_RE.test(value.accountId)) return false;
  if (typeof value.nickname !== 'string' || value.nickname.length === 0
    || value.nickname.length > PLAYER_NICKNAME_MAX_LENGTH) return false;
  if (typeof value.codeHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.codeHash)) return false;
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || value.createdAt < 0) return false;
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || value.updatedAt < 0) return false;
  return parseStatsPayload(value.stats) !== null;
}

export function parsePlayerAccountFile(value: unknown): PlayerAccountFile | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== PLAYER_ACCOUNT_SCHEMA_VERSION) return null;
  if (!Array.isArray(value.accounts)) return null;
  return { schemaVersion: PLAYER_ACCOUNT_SCHEMA_VERSION, accounts: value.accounts.filter(isAccountRecord) };
}

/** 昵称规范化：去空白，落空或超长返回 `null`（调用方据此回 400，而不是悄悄改玩家的名字）。 */
export function normalizeNickname(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > PLAYER_NICKNAME_MAX_LENGTH) return null;
  return trimmed;
}

function snapshotOf(record: PlayerAccountRecord): PlayerAccountSnapshot {
  return {
    accountId: record.accountId,
    nickname: record.nickname,
    stats: record.stats,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function createPlayerAccountStore(options: CreatePlayerAccountStoreOptions): PlayerAccountStore {
  const file = options.file;
  const retentionMs = options.retentionMs ?? DEFAULT_PLAYER_ACCOUNT_RETENTION_MS;
  const now = options.now ?? Date.now;
  const random = options.randomBytes ?? defaultRandomBytes;

  /** accountId -> 记录。 */
  const byId = new Map<string, PlayerAccountRecord>();
  /** codeHash -> accountId。独立索引而不是把码哈希当主键：换码时才不用搬记录。 */
  const codeIndex = new Map<string, string>();

  const remember = (record: PlayerAccountRecord): void => {
    byId.set(record.accountId, record);
    codeIndex.set(record.codeHash, record.accountId);
  };

  /**
   * 淘汰。先按保留期清掉久未同步的账号，再在仍然超量时按「最久未同步」继续淘汰
   * —— 两者都只影响自己，绝不抛错（账号存储坏了不该让整个游戏起不来）。
   */
  const prune = (): void => {
    const deadline = now() - retentionMs;
    if (retentionMs > 0) {
      for (const [accountId, record] of byId) {
        if (record.updatedAt < deadline) {
          byId.delete(accountId);
          codeIndex.delete(record.codeHash);
        }
      }
    }
    if (byId.size <= PLAYER_ACCOUNT_MAX_ENTRIES) return;
    const oldest = [...byId.values()].sort((left, right) => left.updatedAt - right.updatedAt);
    for (const record of oldest.slice(0, byId.size - PLAYER_ACCOUNT_MAX_ENTRIES)) {
      byId.delete(record.accountId);
      codeIndex.delete(record.codeHash);
    }
  };

  const load = (): void => {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      // 文件不存在 = 还没有账号，不是错误。
      return;
    }
    let parsed: PlayerAccountFile | null = null;
    try {
      parsed = parsePlayerAccountFile(JSON.parse(raw));
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      quarantine(file);
      return;
    }
    for (const record of parsed.accounts) remember(record);
    prune();
    // 读取时清理过，落盘一次让磁盘与内存一致；写不进去也不影响本次运行。
    try {
      persist();
    } catch {
      // 忽略：下一次成功写入时自然会带上清理结果。
    }
  };

  const persist = (): void => {
    const payload: PlayerAccountFile = {
      schemaVersion: PLAYER_ACCOUNT_SCHEMA_VERSION,
      accounts: [...byId.values()].sort((left, right) => left.accountId.localeCompare(right.accountId)),
    };
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}${TEMP_FILE_SUFFIX}`;
    writeFileSync(temp, JSON.stringify(payload), 'utf8');
    renameSync(temp, file);
  };

  /** 生成一个未被占用的账号 id 与恢复码。碰撞概率可忽略，但**不忽略**：撞了就重来。 */
  const mintIdentity = (): { accountId: string; recoveryCode: string; codeHash: string } => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const raw = random(8);
      let accountId = '';
      for (const byte of raw) accountId += byte.toString(16).padStart(2, '0');
      accountId = accountId.slice(0, 16);
      if (!PLAYER_ACCOUNT_ID_RE.test(accountId) || byId.has(accountId)) continue;
      const recoveryCode = createRecoveryCode(random);
      const codeHash = hashRecoveryCode(recoveryCode);
      if (codeIndex.has(codeHash)) continue;
      return { accountId, recoveryCode, codeHash };
    }
    // 拿到 8 次都撞上，说明注入的随机源是坏的（例如测试里给了常量）—— 如实抛错，
    // 而不是返回一个必然重复的身份把两个玩家的战绩搅在一起。
    throw new Error('playerAccountStore: 无法生成唯一的账号标识或恢复码');
  };

  load();

  return {
    create(nickname, stats) {
      const { accountId, recoveryCode, codeHash } = mintIdentity();
      const at = Math.floor(now());
      const record: PlayerAccountRecord = {
        accountId,
        nickname,
        codeHash,
        stats,
        createdAt: at,
        updatedAt: at,
      };
      remember(record);
      prune();
      persist();
      return { account: snapshotOf(record), recoveryCode };
    },

    authenticate(recoveryCode) {
      const normalized = normalizeRecoveryCode(recoveryCode);
      if (normalized === null) return null;
      const accountId = codeIndex.get(hashRecoveryCode(normalized));
      if (accountId === undefined) return null;
      const record = byId.get(accountId);
      return record === undefined ? null : snapshotOf(record);
    },

    accumulate(accountId, delta, nickname) {
      const record = byId.get(accountId);
      if (record === undefined) return null;
      const next: PlayerAccountRecord = {
        ...record,
        nickname: nickname ?? record.nickname,
        stats: accumulateStats(record.stats, delta),
        updatedAt: Math.floor(now()),
      };
      byId.set(accountId, next);
      persist();
      return snapshotOf(next);
    },

    rotate(accountId) {
      const record = byId.get(accountId);
      if (record === undefined) return null;
      const recoveryCode = createRecoveryCode(random);
      const codeHash = hashRecoveryCode(recoveryCode);
      const next: PlayerAccountRecord = { ...record, codeHash, updatedAt: Math.floor(now()) };
      codeIndex.delete(record.codeHash);
      remember(next);
      persist();
      return { account: snapshotOf(next), recoveryCode };
    },

    size() {
      return byId.size;
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
