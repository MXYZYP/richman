import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 匿名埋点落盘（运营 O0）。
 *
 * 为什么要有它：改版/优化之前必须能回答「有多少人玩、玩哪一关、卡在哪、有没有崩」，
 * 而现状是**全黑的** —— 没有 nginx、没有 access log，`console.log` 里只有启动信息，
 * `.runtime` 下只有 491 B 的榜单和 361 B 的账号。所以自建一条最小通道。
 *
 * 存储格式：`.runtime/telemetry-YYYY-MM-DD.ndjson`，一行一个事件（JSON）。
 * 选 ndjson 而不是单个 JSON 数组：写入只是 `appendFileSync`，不需要「读-改-写」整个文件，
 * 进程被 pm2 重启也不会丢已落盘的行；分析脚本按行读即可，坏了只坏一行。
 *
 * ★ 隐私边界（改动前先读）：
 *   - **不写 IP**：限流用 IP，但落盘事件里没有 IP、没有 UA。clientId 是客户端自己生成的
 *     随机串，与昵称/账号无关，只能拿来算「同一个人」，不能反查是谁。
 *   - 事件名与属性名走白名单正则，属性值只能是标量且截断 —— 即客户端被改坏了
 *     （或有人手工 POST），也塞不进任意结构。
 */

export const TELEMETRY_MAX_EVENTS_PER_BATCH = 100;
export const TELEMETRY_MAX_NAME_LENGTH = 64;
export const TELEMETRY_MAX_PROP_KEYS = 10;
export const TELEMETRY_MAX_PROP_KEY_LENGTH = 32;
export const TELEMETRY_MAX_STRING_VALUE = 200;

const NAME_PATTERN = /^[a-z0-9][a-z0-9_.]{0,63}$/;
const PROP_KEY_PATTERN = /^[a-z0-9][a-z0-9_]{0,31}$/;

export interface TelemetryEvent {
  /** 事件名，`app_open` / `game_end` 这类小写蛇形。 */
  readonly name: string;
  /** 客户端发生时间（毫秒）。允许离谱值吗？不允许 —— 见 sanitizeTimestamp。 */
  readonly t: number;
  readonly props?: Readonly<Record<string, string | number | boolean>>;
}

export interface TelemetryBatch {
  /** 客户端生成的匿名 id。只用于「是不是同一个人」，不含任何身份信息。 */
  readonly clientId: string;
  readonly events: readonly TelemetryEvent[];
}

export interface TelemetryStore {
  /** 追加落盘，返回真正写入的事件条数。抛错 = 磁盘/权限不可用，调用方应回 503。 */
  append(batch: TelemetryBatch, at?: Date): number;
  /** 某一天的文件路径（测试与分析脚本用）。 */
  filePathFor(date: Date): string;
}

export interface TelemetryStoreOptions {
  directory: string;
  /** 事件里客户端给的时间戳与服务器时间的最大允许偏差（毫秒）。 */
  maxClockSkewMs?: number;
  now?: () => number;
}

interface SanitizedEvent {
  name: string;
  t: number;
  props?: Record<string, string | number | boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeString(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function sanitizeProps(raw: unknown): Record<string, string | number | boolean> | undefined {
  if (!isRecord(raw)) return undefined;
  const result: Record<string, string | number | boolean> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= TELEMETRY_MAX_PROP_KEYS) break;
    if (!PROP_KEY_PATTERN.test(key)) continue;
    if (typeof value === 'boolean') {
      result[key] = value;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue;
      result[key] = value;
    } else if (typeof value === 'string') {
      result[key] = sanitizeString(value, TELEMETRY_MAX_STRING_VALUE);
    } else {
      continue;
    }
    count += 1;
  }
  return count === 0 ? undefined : result;
}

function sanitizeEvent(raw: unknown, serverNow: number, maxSkewMs: number): SanitizedEvent | null {
  if (!isRecord(raw)) return null;
  const { name, t, props } = raw;
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) return null;
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;

  // 客户端时钟可以不准，但不能离谱到污染按天聚合：超出 ±maxSkewMs 就用服务器时间。
  // 「用服务器时间」而不是丢弃，是因为这类偏差几乎全是手机没对时，丢掉等于丢数据。
  const timestamp = Math.abs(t - serverNow) > maxSkewMs ? serverNow : Math.round(t);

  const sanitizedProps = sanitizeProps(props);
  return sanitizedProps === undefined ? { name, t: timestamp } : { name, t: timestamp, props: sanitizedProps };
}

/** 取 `YYYY-MM-DD`（本地时区，与服务器 cron 的「每天 4:17 备份」同一时基）。 */
function dayKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 解析并清洗一次上报。返回 `null` 表示这批数据不可用（结构不对 / 一条合法事件都没有）。
 * 绝不抛错：这是任何人都能 POST 的公网接口。
 */
export function parseTelemetryBatch(input: unknown, options: { now?: () => number; maxClockSkewMs?: number } = {}): TelemetryBatch | null {
  if (!isRecord(input)) return null;

  const { clientId, events } = input;
  if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > 64) return null;
  // clientId 只做字符集约束，不给它任何语义：它就是个随机串。
  if (!/^[A-Za-z0-9_-]+$/.test(clientId)) return null;
  if (!Array.isArray(events) || events.length === 0) return null;

  const now = options.now ?? Date.now;
  const serverNow = now();
  const maxSkewMs = options.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;

  const sanitized: SanitizedEvent[] = [];
  for (const raw of events.slice(0, TELEMETRY_MAX_EVENTS_PER_BATCH)) {
    const event = sanitizeEvent(raw, serverNow, maxSkewMs);
    if (event !== null) sanitized.push(event);
  }
  if (sanitized.length === 0) return null;

  return { clientId, events: sanitized };
}

/** 默认允许的最大时钟偏差：24 小时。 */
export const DEFAULT_MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

export function createTelemetryStore(options: TelemetryStoreOptions): TelemetryStore {
  const { directory } = options;
  const now = options.now ?? Date.now;
  const maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;

  return {
    filePathFor(date) {
      return join(directory, `telemetry-${dayKey(date)}.ndjson`);
    },

    append(batch, at) {
      const target = at ?? new Date(now());
      const file = join(directory, `telemetry-${dayKey(target)}.ndjson`);
      const lines = batch.events
        .map((event) => JSON.stringify({ id: batch.clientId, ...event }))
        .join('\n');
      if (lines === '') return 0;

      // 目录可能还不存在（全新部署 / 清过 .runtime）：第一次写时建，不必在启动时建空目录。
      mkdirSync(directory, { recursive: true });
      appendFileSync(file, `${lines}\n`, 'utf8');
      return batch.events.length;
    },
  };
}
