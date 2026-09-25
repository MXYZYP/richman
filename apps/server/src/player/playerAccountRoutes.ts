import type { IncomingMessage, ServerResponse } from 'node:http';
import { clientKey, parseRequestUrl, readBody, respondJson } from '../http/httpJson';
import { createSlidingWindowRateLimiter, type RateLimitRule } from '../http/slidingWindowRateLimiter';
import {
  formatRecoveryCode,
  normalizeNickname,
  normalizeRecoveryCode,
  parseStatsPayload,
  type PlayerAccountStore,
} from './playerAccountStore';

/**
 * 战绩上云的 HTTP 接口（路线图 #123，第五批-3）。
 *
 * 三条路由都挂在 `/api/player` 下，**都是 POST**：
 *   - `POST /api/player/sync`    建号或累加同步。不带 `code` = 建号（**响应里给一次明文恢复码**）；
 *                                带 `code` = 校验后把增量累加进云端。
 *   - `POST /api/player/restore` 凭恢复码把云端战绩读回来（**只读**，不写盘）。
 *   - `POST /api/player/rotate`  换一段新恢复码，旧码立即失效（这是「怀疑码泄露」的唯一补救）。
 *
 * 为什么全是 POST：三条都带凭据或写数据。用 GET 传恢复码会把它留在各级访问日志与
 * `Referer` 里 —— 一段 bearer 凭据不该出现在 URL 上。
 *
 * **必须在静态托管之前挂载**：`server.ts` 里 `/api/*` 一旦落到 `sirv({ single: true })`，
 * 就会被当成「找不到的前端路由」返回 index.html（HTTP 200 + 一坨 HTML），
 * 客户端的 `response.json()` 会以一个很难查的解析错误收场。
 *
 * 限流是必需品而不是优化：`sync` 不带码就是**一条任何人都能调用的建号接口**，
 * 没有窗口限制就能被用来把落盘文件刷爆。
 */

export const PLAYER_API_BASE = '/api/player';
export const PLAYER_SYNC_PATH = `${PLAYER_API_BASE}/sync`;
export const PLAYER_RESTORE_PATH = `${PLAYER_API_BASE}/restore`;
export const PLAYER_ROTATE_PATH = `${PLAYER_API_BASE}/rotate`;

/**
 * 限流：60 秒内 30 次。
 *
 * 比排行榜（20 次）宽松一点，因为一次「同步」在客户端最多触发一次请求，
 * 而恢复码手抄错误会带来几次重试 —— 正常玩家碰不到，但它仍然把批量建号按在每秒半次以下。
 */
export const DEFAULT_PLAYER_RATE_LIMIT: RateLimitRule = { windowMs: 60_000, maxPerWindow: 30 };

/**
 * 请求体上限 8 KiB。一份满配战绩（64 张地图的 `favoriteMaps`）不到 2 KiB，
 * 留够余量的同时仍然把「往接口里灌大包」这条路堵死。
 */
export const DEFAULT_PLAYER_MAX_BODY_BYTES = 8 * 1024;

export interface PlayerAccountApiLogger {
  error?(message: string, error?: unknown): void;
}

export interface PlayerAccountApiOptions {
  store: PlayerAccountStore;
  /** 限流规则；`false` 关闭（测试）。 */
  rateLimit?: RateLimitRule | false;
  maxBodyBytes?: number;
  now?: () => number;
  logger?: PlayerAccountApiLogger;
}

/** 返回 `true` = 这个请求已被本模块处理完毕；`false` = 交给后续处理器。 */
export type PlayerAccountApiHandler = (request: IncomingMessage, response: ServerResponse) => boolean;

type PlayerRoute = 'sync' | 'restore' | 'rotate';

export function createPlayerAccountApi(options: PlayerAccountApiOptions): PlayerAccountApiHandler {
  const { store } = options;
  const maxBodyBytes = Math.max(1, options.maxBodyBytes ?? DEFAULT_PLAYER_MAX_BODY_BYTES);
  const limiter = options.rateLimit === false
    ? null
    : createSlidingWindowRateLimiter(options.rateLimit ?? DEFAULT_PLAYER_RATE_LIMIT, options.now);

  return (request, response) => {
    const url = parseRequestUrl(request.url);
    if (url === null) return false;
    const route = resolveRoute(url.pathname);
    if (route === null) return false;

    // 405 排在限流之前：一个用错方法的请求不该消耗限流额度，否则调错一次方法
    // 就可能在 60 秒内把自己的正常同步也一起锁掉。
    const method = (request.method ?? 'GET').toUpperCase();
    if (method !== 'POST') {
      respondJson(response, 405, { ok: false, error: 'method_not_allowed' });
      return true;
    }

    if (limiter !== null && !limiter.allow(clientKey(request))) {
      respondJson(response, 429, { ok: false, error: 'rate_limited' });
      return true;
    }

    void handleRoute(route, request, response, { store, maxBodyBytes, logger: options.logger });
    return true;
  };
}

function resolveRoute(pathname: string): PlayerRoute | null {
  if (pathname === PLAYER_SYNC_PATH) return 'sync';
  if (pathname === PLAYER_RESTORE_PATH) return 'restore';
  if (pathname === PLAYER_ROTATE_PATH) return 'rotate';
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface RouteContext {
  store: PlayerAccountStore;
  maxBodyBytes: number;
  logger?: PlayerAccountApiLogger;
}

async function handleRoute(
  route: PlayerRoute,
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
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
      request.resume();
      return;
    }
    body = read.text;
  } catch (error) {
    context.logger?.error?.('player: 读取请求体失败', error);
    if (!response.writableEnded) respondJson(response, 400, { ok: false, error: 'invalid_request' });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    respondJson(response, 400, { ok: false, error: 'invalid_json' });
    return;
  }
  if (!isRecord(parsed)) {
    respondJson(response, 400, { ok: false, error: 'invalid_payload' });
    return;
  }

  try {
    if (route === 'sync') handleSync(parsed, response, context);
    else if (route === 'restore') handleRestore(parsed, response, context);
    else handleRotate(parsed, response, context);
  } catch (error) {
    // 落盘失败（磁盘满 / 权限）时如实报 503。**绝不能假装成功**：玩家看到「已同步」之后
    // 就会放心地去清浏览器数据，而那时云端其实什么都没存下。
    context.logger?.error?.('player: 写入失败', error);
    respondJson(response, 503, { ok: false, error: 'storage_unavailable' });
  }
}

function handleSync(body: Record<string, unknown>, response: ServerResponse, context: RouteContext): void {
  const nickname = normalizeNickname(body.nickname);
  if (nickname === null) {
    respondJson(response, 400, { ok: false, error: 'invalid_nickname' });
    return;
  }
  const stats = parseStatsPayload(body.stats);
  if (stats === null) {
    respondJson(response, 400, { ok: false, error: 'invalid_stats' });
    return;
  }

  // 「没有码」= 建号。刻意把 `''` 也算作没有码：客户端在输入框为空时会直接发空串，
  // 那显然不是「我有码但是空的」，而应该是「我还没有账号」。
  const rawCode = body.code;
  if (rawCode === undefined || rawCode === null || rawCode === '') {
    const created = context.store.create(nickname, stats);
    respondJson(response, 200, {
      ok: true,
      created: true,
      accountId: created.account.accountId,
      nickname: created.account.nickname,
      // ★ 明文恢复码**只在这个响应里出现过一次**（以及换码时）。服务端只留哈希。
      recoveryCode: formatRecoveryCode(created.recoveryCode),
      stats: created.account.stats,
      updatedAt: created.account.updatedAt,
    });
    return;
  }

  const account = authenticateWithCode(rawCode, context);
  if (account === null) {
    respondJson(response, 401, { ok: false, error: 'code_invalid' });
    return;
  }

  const updated = context.store.accumulate(account.accountId, stats, nickname);
  if (updated === null) {
    // 认证通过却查不到账号：只可能发生在「并发换码 + 淘汰」的窄缝里。
    // 如实报 401 让客户端重新走一次，而不是伪造一份看起来成功的响应。
    respondJson(response, 401, { ok: false, error: 'code_invalid' });
    return;
  }
  respondJson(response, 200, {
    ok: true,
    created: false,
    accountId: updated.accountId,
    nickname: updated.nickname,
    stats: updated.stats,
    updatedAt: updated.updatedAt,
  });
}

function handleRestore(body: Record<string, unknown>, response: ServerResponse, context: RouteContext): void {
  const account = authenticateWithCode(body.code, context);
  if (account === null) {
    respondJson(response, 401, { ok: false, error: 'code_invalid' });
    return;
  }
  // 只读：恢复不清空云端、也不改动 `updatedAt`，因此「在新设备上试一下恢复码对不对」
  // 不会延长保留期，也不会让账号看起来像刚同步过。
  respondJson(response, 200, {
    ok: true,
    accountId: account.accountId,
    nickname: account.nickname,
    stats: account.stats,
    updatedAt: account.updatedAt,
  });
}

function handleRotate(body: Record<string, unknown>, response: ServerResponse, context: RouteContext): void {
  const account = authenticateWithCode(body.code, context);
  if (account === null) {
    respondJson(response, 401, { ok: false, error: 'code_invalid' });
    return;
  }
  const rotated = context.store.rotate(account.accountId);
  if (rotated === null) {
    respondJson(response, 401, { ok: false, error: 'code_invalid' });
    return;
  }
  respondJson(response, 200, {
    ok: true,
    accountId: rotated.account.accountId,
    nickname: rotated.account.nickname,
    recoveryCode: formatRecoveryCode(rotated.recoveryCode),
    stats: rotated.account.stats,
    updatedAt: rotated.account.updatedAt,
  });
}

/** 规范化 + 认证。码本身有问题（抄错 / 校验位不符）与「码不存在」返回同一个 `null`。 */
function authenticateWithCode(rawCode: unknown, context: RouteContext) {
  const code = normalizeRecoveryCode(rawCode);
  if (code === null) return null;
  return context.store.authenticate(code);
}
