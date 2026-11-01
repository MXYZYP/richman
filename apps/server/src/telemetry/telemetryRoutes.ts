import type { IncomingMessage, ServerResponse } from 'node:http';
import { clientKey, parseRequestUrl, readBody, respondJson } from '../http/httpJson';
import { createSlidingWindowRateLimiter, type RateLimitRule } from '../http/slidingWindowRateLimiter';
import { parseTelemetryBatch, type TelemetryStore } from './telemetryStore';

/**
 * 匿名埋点上报接口（运营 O0）。
 *
 * `POST /api/telemetry`，接收一批事件落盘到 `.runtime/telemetry-YYYY-MM-DD.ndjson`。
 *
 * 与排行榜/账号接口一样**必须挂在静态托管之前**（否则被 `sirv({single:true})`
 * 兜底成 index.html，客户端只会收到一个无法定位的 JSON 解析错误）。
 *
 * 这是一条任何人都能 POST 的公网写接口，所以三道闸一个都不能少：
 *   1. 限流（按 IP 滑动窗口）；
 *   2. 请求体上限（先用 Content-Length 预检，再边读边卡）；
 *   3. 字段清洗（白名单正则 + 标量约束，见 `telemetryStore.parseTelemetryBatch`）。
 *
 * 刻意**不**返回任何业务数据：客户端不需要知道服务端记了几条，`{ok:true}` 足矣。
 */

export const TELEMETRY_PATH = '/api/telemetry';

/** 限流：60 秒 30 批。客户端按 20 条/批攒，正常一局也就上报两三批。 */
export const DEFAULT_TELEMETRY_RATE_LIMIT: RateLimitRule = { windowMs: 60_000, maxPerWindow: 30 };

/** 请求体上限 32 KiB。一批 100 条事件，每条连属性不超过几百字节。 */
export const DEFAULT_TELEMETRY_MAX_BODY_BYTES = 32 * 1024;

export interface TelemetryLogger {
  error?(message: string, error?: unknown): void;
}

export interface TelemetryApiOptions {
  store: TelemetryStore;
  /** 限流规则；`false` 关闭（测试）。 */
  rateLimit?: RateLimitRule | false;
  maxBodyBytes?: number;
  now?: () => number;
  logger?: TelemetryLogger;
}

/** 返回 `true` = 这个请求已被本模块处理完毕；`false` = 交给后续处理器。 */
export type TelemetryApiHandler = (request: IncomingMessage, response: ServerResponse) => boolean;

export function createTelemetryApi(options: TelemetryApiOptions): TelemetryApiHandler {
  const { store } = options;
  const maxBodyBytes = Math.max(1, options.maxBodyBytes ?? DEFAULT_TELEMETRY_MAX_BODY_BYTES);
  const limiter = options.rateLimit === false
    ? null
    : createSlidingWindowRateLimiter(options.rateLimit ?? DEFAULT_TELEMETRY_RATE_LIMIT, options.now);

  return (request, response) => {
    const url = parseRequestUrl(request.url);
    if (url === null || url.pathname !== TELEMETRY_PATH) return false;

    const method = (request.method ?? 'GET').toUpperCase();
    if (method !== 'POST') {
      respondJson(response, 405, { ok: false, error: 'method_not_allowed' });
      return true;
    }

    if (limiter !== null && !limiter.allow(clientKey(request))) {
      respondJson(response, 429, { ok: false, error: 'rate_limited' });
      return true;
    }

    void handleReport(request, response, { store, maxBodyBytes, logger: options.logger, now: options.now });
    return true;
  };
}

interface ReportContext {
  store: TelemetryStore;
  maxBodyBytes: number;
  logger?: TelemetryLogger;
  now?: () => number;
}

async function handleReport(
  request: IncomingMessage,
  response: ServerResponse,
  context: ReportContext,
): Promise<void> {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > context.maxBodyBytes) {
    respondJson(response, 413, { ok: false, error: 'payload_too_large' });
    request.resume();
    return;
  }

  let body: string;
  try {
    const read = await readBody(request, context.maxBodyBytes);
    if (!read.ok) {
      respondJson(response, 413, { ok: false, error: 'payload_too_large' });
      request.resume();
      return;
    }
    body = read.text;
  } catch (error) {
    context.logger?.error?.('telemetry: 读取请求体失败', error);
    if (!response.writableEnded) respondJson(response, 400, { ok: false, error: 'invalid_request' });
    return;
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    respondJson(response, 400, { ok: false, error: 'invalid_json' });
    return;
  }

  const batch = parseTelemetryBatch(parsedBody, { now: context.now });
  if (batch === null) {
    respondJson(response, 400, { ok: false, error: 'invalid_batch' });
    return;
  }

  try {
    context.store.append(batch);
  } catch (error) {
    // 落不了盘就如实报 503：埋点不是关键路径，假装成功只会让运营数据悄悄少一块。
    context.logger?.error?.('telemetry: 写入失败', error);
    respondJson(response, 503, { ok: false, error: 'storage_unavailable' });
    return;
  }

  respondJson(response, 200, { ok: true });
}
