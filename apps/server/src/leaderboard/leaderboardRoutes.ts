import type { IncomingMessage, ServerResponse } from 'node:http';
import { clientKey, parseRequestUrl, readBody, respondJson } from '../http/httpJson';
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
    const url = parseRequestUrl(request.url);
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

