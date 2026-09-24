import type { IncomingMessage, ServerResponse } from 'node:http';
import { createSlidingWindowRateLimiter, type RateLimitRule } from '../http/slidingWindowRateLimiter';
import { parseLeaderboardSubmission, type LeaderboardStore } from './leaderboardStore';

/**
 * 成就排行榜的 HTTP 接口（路线图 #116）。
 *
 * 两条路由，都挂在 `/api/leaderboard`：
 *   - `GET  /api/leaderboard[?playerId=...]` → 榜单；带了 `playerId` 就顺带回自己的名次；
 *   - `POST /api/leaderboard`                → 提交本机战绩，写入并回自己的名次。
 *
 * **必须在静态托管之前挂载**：`server.ts` 里 `/api/*` 一旦落到 `sirv({ single: true })`，
 * 就会被当成「找不到的前端路由」返回 index.html（HTTP 200 + 一坨 HTML），
 * 客户端 `response.json()` 会以一个很难查的解析错误收场。
 *
 * 限流与体积上限都是必需品：这是一条**任何人都能 POST** 的公网写接口。
 */

export const LEADERBOARD_PATH = '/api/leaderboard';

/** 提交限流：60 秒内 20 次。正常使用就是「打完一局点一下」，永远碰不到。 */
export const DEFAULT_LEADERBOARD_RATE_LIMIT: RateLimitRule = { windowMs: 60_000, maxPerWindow: 20 };

/** 请求体上限 2 KiB。一条提交只有五个字段，正常不到 200 字节。 */
export const DEFAULT_LEADERBOARD_MAX_BODY_BYTES = 2 * 1024;

export interface LeaderboardApiLogger {
  error?(message: string, error?: unknown): void;
}

export interface LeaderboardApiOptions {
  store: LeaderboardStore;
  /** 限流规则；`false` 关闭（测试）。 */
  rateLimit?: RateLimitRule | false;
  maxBodyBytes?: number;
  now?: () => number;
  logger?: LeaderboardApiLogger;
}

/** 返回 `true` = 这个请求已被本模块处理完毕；`false` = 交给后续处理器。 */
export type LeaderboardApiHandler = (request: IncomingMessage, response: ServerResponse) => boolean;

export function createLeaderboardApi(options: LeaderboardApiOptions): LeaderboardApiHandler {
  const { store } = options;
  const maxBodyBytes = Math.max(1, options.maxBodyBytes ?? DEFAULT_LEADERBOARD_MAX_BODY_BYTES);
  const limiter = options.rateLimit === false
    ? null
    : createSlidingWindowRateLimiter(options.rateLimit ?? DEFAULT_LEADERBOARD_RATE_LIMIT, options.now);

  return (request, response) => {
    const url = parseUrl(request.url);
    if (url === null || url.pathname !== LEADERBOARD_PATH) return false;

    const method = (request.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
      respondJson(response, 405, { ok: false, error: 'method_not_allowed' });
      return true;
    }

    if (limiter !== null && !limiter.allow(clientKey(request))) {
      respondJson(response, 429, { ok: false, error: 'rate_limited' });
      return true;
    }

    if (method === 'GET') {
      const playerId = url.searchParams.get('playerId');
      respondJson(response, 200, {
        ok: true,
        entries: store.entries(),
        rank: playerId === null ? null : store.rankOf(playerId),
      });
      return true;
    }

    void handleSubmit(request, response, { store, maxBodyBytes, logger: options.logger });
    return true;
  };
}

interface SubmitContext {
  store: LeaderboardStore;
  maxBodyBytes: number;
  logger?: LeaderboardApiLogger;
}

async function handleSubmit(
  request: IncomingMessage,
  response: ServerResponse,
  context: SubmitContext,
): Promise<void> {
  // 先看 `Content-Length`：绝大多数客户端（含 fetch）都会带上它，于是超限请求
  // 可以在**读之前**就被干净地回掉，不必先把几个 GB 收进内存再后悔。
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
      // 响应已经发出，再把剩下的请求体排掉（`readBody` 已不再累积，只是丢弃）。
      // 刻意**不** `request.destroy()`：那会把连接直接掐断，客户端看到的是
      // 「socket 被对端关闭」而不是 413 —— 一个只有真发过大包才会发现的坑。
      request.resume();
      return;
    }
    body = read.text;
  } catch (error) {
    context.logger?.error?.('leaderboard: 读取请求体失败', error);
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

  const submission = parseLeaderboardSubmission(parsedBody);
  if (submission === null) {
    respondJson(response, 400, { ok: false, error: 'invalid_entry' });
    return;
  }

  try {
    context.store.upsert(submission);
  } catch (error) {
    // 榜单写不进去（磁盘满 / 权限）时如实报 503 —— 假装成功会让玩家以为已经上榜。
    context.logger?.error?.('leaderboard: 写入失败', error);
    respondJson(response, 503, { ok: false, error: 'storage_unavailable' });
    return;
  }

  respondJson(response, 200, {
    ok: true,
    entries: context.store.entries(),
    rank: context.store.rankOf(submission.playerId),
  });
}

interface ParsedUrl {
  pathname: string;
  searchParams: URLSearchParams;
}

function parseUrl(rawUrl: string | undefined): ParsedUrl | null {
  if (rawUrl === undefined) return null;
  // `request.url` 是「路径 + 查询串」，没有 host，因此给一个固定 base 再解析。
  try {
    const parsed = new URL(rawUrl, 'http://localhost');
    return { pathname: parsed.pathname, searchParams: parsed.searchParams };
  } catch {
    return null;
  }
}

/**
 * 限流用的客户端标识。
 *
 * 取 `x-forwarded-for` 的**最后一跳**，而不是第一跳：本服务固定部署在单层可信反代
 * （Caddy → `127.0.0.1:3000`）之后，Caddy 会把自己看到的对端**追加**在末尾，这一跳伪造不了；
 * 而第一跳完全是请求方自己写的，谁都能编一个来绕过限流。
 * 没有该头（直连 / 本机测试）时退回套接字对端地址。
 */
function clientKey(request: IncomingMessage): string {
  const forwarded = request.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  if (typeof raw === 'string' && raw.length > 0) {
    const hops = raw.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
    const last = hops.at(-1);
    if (last !== undefined) return last;
  }
  return request.socket.remoteAddress ?? 'unknown';
}

function readBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        // 超限就停止累积（否则「上限」形同虚设）。这里**不**掐连接：
        // 交给调用方回 413，再由它 `resume()` 把余下的字节丢弃。
        settled = true;
        resolve({ ok: false });
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      if (settled) return;
      settled = true;
      resolve({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    });

    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function respondJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.writableEnded) return;
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  // 榜单每次提交都会变，任何中间层缓存都不该把它留住。
  response.setHeader('Cache-Control', 'no-store');
  response.end(body);
}
