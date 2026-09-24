import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MapRef } from '@richman/board-data';
import type { BotDifficulty } from '@richman/engine';
import type { RoomRuleConfig, RoomStatus } from '@richman/protocol';

/**
 * 房间落盘快照（C-③ / #22 / #34）。
 *
 * 目标：`pm2 restart richman`（或进程被 OOM/部署脚本杀掉）之后，进行中的对局不再从内存里消失——
 * 服务端重启时读回快照，把房间（含 `gameState`）原样恢复，客户端用各自 localStorage 里的 token
 * 走既有 `session:resume` 通道自动重连即可继续玩。
 *
 * 三条硬约束（都在本模块内自闭环，不依赖调用方）：
 *  1. **原子写**：先写 `<file>.tmp` 再 `rename`，rename 在同一文件系统上是原子的。
 *     这样「写到一半进程被杀」只会留下一个没人读的 `.tmp`，绝不会把好快照截断成半个 JSON。
 *  2. **带版本号**：`schemaVersion` 不匹配就丢弃。以后改 `Room` 形状时只需抬高版本号，
 *     旧快照会被静默忽略，而不是把服务端带进一个半新半旧的状态。
 *  3. **损坏容错**：任何一条快照解析/校验失败都只影响它自己——文件被挪成 `.corrupt` 隔离，
 *     其余房间照常恢复。恢复流程绝不会因为一条坏快照而整体失败。
 *
 * 关于 token：快照里**会**写入玩家的 token。这是恢复重连能力的必要条件（重启后服务端必须能
 * 校验客户端手里的 token）。快照目录属于服务端私有运行数据，不应对外暴露或纳入版本库。
 */

/** 当前快照结构版本。改动 Room/GameState 的持久化形状时必须 +1。 */
export const ROOM_SNAPSHOT_SCHEMA_VERSION = 1;

/** 默认保留期：超过这个时长没被更新过的快照视为陈旧，启动时清理（12 小时）。 */
export const DEFAULT_ROOM_SNAPSHOT_RETENTION_MS = 12 * 60 * 60 * 1000;

export interface RoomSnapshotPlayerRecord {
  id: string;
  nickname: string;
  token: string | null;
  isBot: boolean;
  online: boolean;
  joinRequestId: string | null;
  joinRequestNickname: string | null;
}

export interface RoomSnapshotSpectatorRecord {
  id: string;
  nickname: string;
  token: string;
  online: boolean;
  joinRequestId: string | null;
  joinRequestNickname: string | null;
}

/** 一条房间快照：房间元信息 + 未校验的 `gameState`（恢复时再交给 hydrateGameState 严格校验）。 */
export interface RoomSnapshotRecord {
  schemaVersion: number;
  savedAt: number;
  code: string;
  mapRef: MapRef;
  mapTitle: string;
  status: RoomStatus;
  hostId: string;
  botDifficulty: BotDifficulty;
  /**
   * 房主自定义规则（#4）；`null`/缺省 = 全部使用地图 game-config 默认值。
   *
   * 刻意**可选**（而不是像其它字段那样必需）：schemaVersion 保持 1，这样部署重启后
   * 那些「在本字段引入之前写下」的快照仍能恢复，不会把进行中的对局整间丢掉。
   * 具体字段的范围校验放在 `RoomManager.#restoreRoom`，那里才能拿到地图的 maxHouseLevel。
   */
  ruleConfig?: RoomRuleConfig | null;
  /**
   * 联机最小悔棋开关（#101）；**缺省即 `false`**。
   *
   * 与 `ruleConfig` 同样的理由保持**可选**：`schemaVersion` 因此可以继续停在 1，
   * 那些「在本字段引入之前写下」的快照在部署重启后仍能恢复 —— 抬版本号会把所有
   * 进行中的对局整间丢掉，而这个字段缺省时语义明确（没开 = 关），没有抬版本的必要。
   */
  minimalUndoEnabled?: boolean;
  /**
   * 房规「放弃购买即拍卖」（#106）；**缺省即 `false`**。
   *
   * 与上两个字段同样的理由保持**可选**（`schemaVersion` 继续停在 1）：缺省语义明确
   * （没开 = 关），而抬版本号会连带把「在本字段引入之前写下」的进行中对局整间丢掉。
   */
  auctionOnDecline?: boolean;
  /**
   * 每回合限时（#107，秒）；**缺省即 `0` = 不限时**。
   *
   * 与上三个字段同样的理由保持**可选**（`schemaVersion` 继续停在 1）：缺省语义明确
   * （没设 = 不限时），而抬版本号会连带把「在本字段引入之前写下」的进行中对局整间丢掉。
   * 范围校验（上限 TURN_TIME_LIMIT_MAX_SEC）放在 `RoomManager.updateRoomSettings` 入口，
   * 这里只保证结构可读。
   */
  turnTimeLimitSec?: number;
  /**
   * 是否允许被公开房间列表发现（#108）。同上：**可选**，老快照缺这个字段一律按
   * 「不公开」处理（隐私优先——升级不能让原本私密的房间突然出现在全网列表里）。
   */
  isPublic?: boolean;
  players: RoomSnapshotPlayerRecord[];
  spectators: RoomSnapshotSpectatorRecord[];
  createRequestId: string | null;
  createRequestNickname: string | null;
  createRequestPlayerId: string | null;
  createRequestToken: string | null;
  /**
   * 进行中的引擎状态；大厅房间为 `null`。
   * 这里刻意用 `unknown`：快照只负责搬运字节，权威校验在 `hydrateGameState`（按地图精确比对
   * board/cards/config/ruleModules），避免两处各写一套校验而互相漂移。
   */
  gameState: unknown;
}

export interface RoomSnapshotStore {
  /** 写一条快照（同步、原子）。失败应抛错，由调用方记录并继续运行。 */
  save(record: RoomSnapshotRecord): void;
  /** 读取全部可用快照；损坏/版本不符/过期的条目已被跳过或清理。 */
  loadAll(): RoomSnapshotRecord[];
  /** 删除某个房间的快照（房间解散时调用）。 */
  remove(roomCode: string): void;
  /** 清理超过保留期的快照，返回被删条数。 */
  prune(): number;
}

export interface CreateRoomSnapshotStoreOptions {
  directory: string;
  retentionMs?: number;
  /** 便于测试注入时钟。 */
  now?: () => number;
}

const SNAPSHOT_FILE_PREFIX = 'room-';
const SNAPSHOT_FILE_SUFFIX = '.json';
const TEMP_FILE_SUFFIX = '.tmp';
const CORRUPT_FILE_SUFFIX = '.corrupt';

export function createRoomSnapshotStore(options: CreateRoomSnapshotStoreOptions): RoomSnapshotStore {
  const directory = options.directory;
  const retentionMs = options.retentionMs ?? DEFAULT_ROOM_SNAPSHOT_RETENTION_MS;
  const now = options.now ?? Date.now;

  const fileFor = (roomCode: string): string => join(directory, `${SNAPSHOT_FILE_PREFIX}${sanitize(roomCode)}${SNAPSHOT_FILE_SUFFIX}`);

  const ensureDirectory = (): void => {
    mkdirSync(directory, { recursive: true });
  };

  const listSnapshotFiles = (): string[] => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      // 目录还不存在 = 还没有任何快照，不是错误。
      return [];
    }
    return entries
      .filter((name) => name.startsWith(SNAPSHOT_FILE_PREFIX) && name.endsWith(SNAPSHOT_FILE_SUFFIX))
      .map((name) => join(directory, name));
  };

  /** 清掉上一次进程留下的 `.tmp` 残骸：它们一定是不完整的写入，留着只会占空间。 */
  const removeStaleTempFiles = (): void => {
    for (const file of listFilesWithSuffix(TEMP_FILE_SUFFIX)) {
      rmSync(file, { force: true });
    }
  };

  const listFilesWithSuffix = (suffix: string): string[] => {
    try {
      return readdirSync(directory)
        .filter((name) => name.startsWith(SNAPSHOT_FILE_PREFIX) && name.endsWith(suffix))
        .map((name) => join(directory, name));
    } catch {
      return [];
    }
  };

  const prune = (): number => {
    if (retentionMs <= 0) return 0;
    const deadline = now() - retentionMs;
    let removed = 0;
    for (const file of listSnapshotFiles()) {
      let modifiedAt: number;
      try {
        modifiedAt = statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (modifiedAt < deadline) {
        try {
          rmSync(file, { force: true });
          removed += 1;
        } catch {
          // 单个文件删不掉不应中断启动流程。
        }
      }
    }
    return removed;
  };

  return {
    save(record) {
      ensureDirectory();
      const target = fileFor(record.code);
      const temp = `${target}${TEMP_FILE_SUFFIX}`;
      // 先落临时文件，再原子 rename 顶替正式文件。
      writeFileSync(temp, JSON.stringify(record), 'utf8');
      renameSync(temp, target);
    },

    loadAll() {
      ensureDirectory();
      removeStaleTempFiles();
      prune();

      const records: RoomSnapshotRecord[] = [];
      for (const file of listSnapshotFiles()) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(file, 'utf8'));
        } catch {
          quarantine(file);
          continue;
        }
        if (!isRoomSnapshotRecord(parsed)) {
          quarantine(file);
          continue;
        }
        records.push(parsed);
      }
      return records;
    },

    remove(roomCode) {
      rmSync(fileFor(roomCode), { force: true });
    },

    prune,
  };
}

/** 坏快照改名隔离：既不参与恢复，也不会每轮启动被反复解析。 */
function quarantine(file: string): void {
  try {
    renameSync(file, `${file}${CORRUPT_FILE_SUFFIX}`);
  } catch {
    try {
      rmSync(file, { force: true });
    } catch {
      // 无能为力：保留原文件，下轮启动会再次尝试隔离。
    }
  }
}

function sanitize(roomCode: string): string {
  return roomCode.replace(/[^A-Za-z0-9_-]/g, '_');
}

const ROOM_STATUSES: ReadonlySet<string> = new Set(['lobby', 'playing', 'ended']);
const BOT_DIFFICULTIES: ReadonlySet<string> = new Set(['easy', 'normal', 'hard']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isMapRef(value: unknown): value is MapRef {
  return (
    isRecord(value)
    && typeof value.id === 'string'
    && typeof value.version === 'number'
    && typeof value.contentHash === 'string'
  );
}

function isPlayerRecord(value: unknown): value is RoomSnapshotPlayerRecord {
  return (
    isRecord(value)
    && typeof value.id === 'string'
    && typeof value.nickname === 'string'
    && isNullableString(value.token)
    && typeof value.isBot === 'boolean'
    && typeof value.online === 'boolean'
    && isNullableString(value.joinRequestId)
    && isNullableString(value.joinRequestNickname)
  );
}

/** 只保证结构可读；范围校验（房级上限等）由 RoomManager 结合地图配置完成。 */
function isRoomRuleConfig(value: unknown): value is RoomRuleConfig {
  return isRecord(value)
    && typeof value.initialCash === 'number'
    && typeof value.maxHouseLevel === 'number'
    && typeof value.mortgageInterestRate === 'number';
}

function isSpectatorRecord(value: unknown): value is RoomSnapshotSpectatorRecord {
  return (
    isRecord(value)
    && typeof value.id === 'string'
    && typeof value.nickname === 'string'
    && typeof value.token === 'string'
    && typeof value.online === 'boolean'
    && isNullableString(value.joinRequestId)
    && isNullableString(value.joinRequestNickname)
  );
}

/**
 * 结构校验：只保证「能安全地喂给恢复流程」，不校验 gameState 内部（那是 hydrateGameState 的职责）。
 * 版本号不符直接视为不可用——旧快照宁可丢弃，也不要恢复出半新半旧的房间。
 */
export function isRoomSnapshotRecord(value: unknown): value is RoomSnapshotRecord {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== ROOM_SNAPSHOT_SCHEMA_VERSION) return false;
  if (typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt)) return false;
  if (typeof value.code !== 'string' || value.code.length === 0) return false;
  if (!isMapRef(value.mapRef)) return false;
  if (typeof value.mapTitle !== 'string') return false;
  if (typeof value.status !== 'string' || !ROOM_STATUSES.has(value.status)) return false;
  if (typeof value.hostId !== 'string' || value.hostId.length === 0) return false;
  if (typeof value.botDifficulty !== 'string' || !BOT_DIFFICULTIES.has(value.botDifficulty)) return false;
  if (value.minimalUndoEnabled !== undefined && typeof value.minimalUndoEnabled !== 'boolean') return false;
  if (value.auctionOnDecline !== undefined && typeof value.auctionOnDecline !== 'boolean') return false;
  if (value.turnTimeLimitSec !== undefined
    && (typeof value.turnTimeLimitSec !== 'number' || !Number.isFinite(value.turnTimeLimitSec))) return false;
  if (value.isPublic !== undefined && typeof value.isPublic !== 'boolean') return false;
  if (!Array.isArray(value.players) || value.players.length === 0) return false;
  if (!value.players.every(isPlayerRecord)) return false;
  if (!Array.isArray(value.spectators) || !value.spectators.every(isSpectatorRecord)) return false;
  if (!isNullableString(value.createRequestId)) return false;
  if (!isNullableString(value.createRequestNickname)) return false;
  if (!isNullableString(value.createRequestPlayerId)) return false;
  if (!isNullableString(value.createRequestToken)) return false;
  if (value.gameState !== null && !isRecord(value.gameState)) return false;
  return true;
}
