import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import sirv from 'sirv';
import { Server as SocketIoServer } from 'socket.io';
import type { ClientToServerEvents, InterServerEvents, ServerToClientEvents, SocketData } from '@richman/protocol';
import type { RateLimitRule } from './http/slidingWindowRateLimiter';
import { createLeaderboardApi, type LeaderboardApiHandler } from './leaderboard/leaderboardRoutes';
import { createLeaderboardStore, type LeaderboardStore } from './leaderboard/leaderboardStore';
import { createPlayerAccountApi, type PlayerAccountApiHandler } from './player/playerAccountRoutes';
import { createPlayerAccountStore, type PlayerAccountStore } from './player/playerAccountStore';
import { RoomManager } from './rooms/roomManager';
import type { RoomDomainEvent } from './rooms/roomTypes';
import { createRoomSocketAdapter, type CreateRoomRateLimit, type RoomSocketAdapterLogger } from './socket/roomSocketAdapter';

export interface CreateRoomServerOptions<TTimerHandle = unknown> {
  roomManagerFactory(onAsyncEvents: (events: RoomDomainEvent[]) => void): RoomManager<TTimerHandle>;
  logger?: RoomSocketAdapterLogger;
  clientDistPath?: string;
  /** Create-room rate limit. Omit to use the production default (5 per 60s); tests may pass `false`. */
  rateLimit?: CreateRoomRateLimit | false;
  /** Read-only clock used only for the create-room rate-limit window. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * 成就排行榜（#116）。省略 = 挂载默认的**落盘**榜单（`.runtime/leaderboard.json`，
   * 可用环境变量 `RICHMAN_LEADERBOARD_FILE` 覆盖）；`false` = 完全不挂这条路由；
   * 也可以注入一个现成的存储 —— 测试用临时目录，避免读到开发机上留下的真榜单。
   */
  leaderboard?: LeaderboardStore | false;
  /** 排行榜提交限流（按客户端 IP 滑动窗口）；`false` 关闭（测试）。 */
  leaderboardRateLimit?: RateLimitRule | false;
  /** 排行榜请求体上限（字节）；默认 2 KiB。 */
  leaderboardMaxBodyBytes?: number;
  /**
   * 战绩上云（#123）。省略 = 挂载默认的**落盘**账号存储
   * （`.runtime/player-accounts.json`，可用环境变量 `RICHMAN_PLAYER_FILE` 覆盖）；
   * `false` = 完全不挂这条路由；也可以注入现成的存储 —— 测试用临时目录，
   * 避免读到开发机上留下的真账号。
   */
  playerAccounts?: PlayerAccountStore | false;
  /** 账号接口限流（按客户端 IP 滑动窗口）；`false` 关闭（测试）。 */
  playerRateLimit?: RateLimitRule | false;
  /** 账号接口请求体上限（字节）；默认 8 KiB。 */
  playerMaxBodyBytes?: number;
}

export interface RunningRoomServer<TTimerHandle = unknown> {
  httpServer: HttpServer;
  io: SocketIoServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
  roomManager: RoomManager<TTimerHandle>;
  close(): Promise<void>;
}

export function createRoomServer<TTimerHandle = unknown>({
  roomManagerFactory,
  logger,
  clientDistPath,
  rateLimit,
  now,
  leaderboard,
  leaderboardRateLimit,
  leaderboardMaxBodyBytes,
  playerAccounts,
  playerRateLimit,
  playerMaxBodyBytes,
}: CreateRoomServerOptions<TTimerHandle>): RunningRoomServer<TTimerHandle> {
  const leaderboardApi = resolveLeaderboardApi({ leaderboard, leaderboardRateLimit, leaderboardMaxBodyBytes, logger });
  const playerAccountApi = resolvePlayerAccountApi({ playerAccounts, playerRateLimit, playerMaxBodyBytes, logger });
  const requestHandler = createRequestHandler(clientDistPath, leaderboardApi, playerAccountApi);
  const httpServer = createServer(requestHandler);
  const io = new SocketIoServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(httpServer, {
    serveClient: false,
    // 跨域：H5 包体挂在 TapTap 创意工坊这类第三方域名下时，socket.io 的 HTTP 长轮询握手
    // 属于跨域请求，不放行就会被浏览器拦掉（WebSocket 直连本身不受 CORS 限制，
    // 但 socket.io 会先用 /socket.io/?EIO=4 探一次）。
    //
    // 用 `*` 而不是白名单：这个服务不持有任何凭据（无 cookie、无 token 鉴权，
    // 房间靠 6 位码 + 房主令牌），放行任意来源不增加实质风险；而第三方平台给游戏分配的
    // 托管域名不可预知，写死白名单必然漏。
    cors: { origin: '*' },
  });

  let dispatchAsyncEvents = (_events: RoomDomainEvent[]): void => undefined;
  const roomManager = roomManagerFactory((events) => dispatchAsyncEvents(events));
  const adapter = createRoomSocketAdapter({ io, roomManager, logger, rateLimit, now });
  dispatchAsyncEvents = adapter.dispatchDomainEvents;
  adapter.bind();

  let closePromise: Promise<void> | null = null;

  return {
    httpServer,
    io,
    roomManager,
    close() {
      if (closePromise !== null) {
        return closePromise;
      }

      closePromise = closeServer(httpServer, io, roomManager);
      return closePromise;
    },
  };
}

/** 排行榜落盘位置：默认与房间快照同在 server 包的 `.runtime/`，可用环境变量覆盖。 */
const DEFAULT_LEADERBOARD_FILE = fileURLToPath(new URL('../.runtime/leaderboard.json', import.meta.url));

interface ResolveLeaderboardApiOptions {
  leaderboard?: LeaderboardStore | false;
  leaderboardRateLimit?: RateLimitRule | false;
  leaderboardMaxBodyBytes?: number;
  logger?: RoomSocketAdapterLogger;
}

/** `null` = 不挂载排行榜路由（`leaderboard: false`，或调用方明确不要）。 */
function resolveLeaderboardApi(options: ResolveLeaderboardApiOptions): LeaderboardApiHandler | null {
  if (options.leaderboard === false) return null;
  const store = options.leaderboard
    ?? createLeaderboardStore({ file: process.env.RICHMAN_LEADERBOARD_FILE ?? DEFAULT_LEADERBOARD_FILE });
  return createLeaderboardApi({
    store,
    rateLimit: options.leaderboardRateLimit,
    maxBodyBytes: options.leaderboardMaxBodyBytes,
    logger: options.logger,
  });
}

/** 账号落盘位置：与榜单、房间快照同在 server 包的 `.runtime/`，可用环境变量覆盖。 */
const DEFAULT_PLAYER_ACCOUNT_FILE = fileURLToPath(new URL('../.runtime/player-accounts.json', import.meta.url));

interface ResolvePlayerAccountApiOptions {
  playerAccounts?: PlayerAccountStore | false;
  playerRateLimit?: RateLimitRule | false;
  playerMaxBodyBytes?: number;
  logger?: RoomSocketAdapterLogger;
}

/** `null` = 不挂载账号路由（`playerAccounts: false`）。 */
function resolvePlayerAccountApi(options: ResolvePlayerAccountApiOptions): PlayerAccountApiHandler | null {
  if (options.playerAccounts === false) return null;
  const store = options.playerAccounts
    ?? createPlayerAccountStore({ file: process.env.RICHMAN_PLAYER_FILE ?? DEFAULT_PLAYER_ACCOUNT_FILE });
  return createPlayerAccountApi({
    store,
    rateLimit: options.playerRateLimit,
    maxBodyBytes: options.playerMaxBodyBytes,
    logger: options.logger,
  });
}

function createRequestHandler(
  clientDistPath: string | undefined,
  leaderboardApi: LeaderboardApiHandler | null,
  playerAccountApi: PlayerAccountApiHandler | null,
): (request: IncomingMessage, response: ServerResponse) => void {
  const staticHandler = resolveStaticHandler(clientDistPath);

  // /healthz 供云平台/负载均衡探活（就绪探针）。返回 200 即代表进程存活。
  return (request, response) => {
    if (request.url === '/healthz') {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end('ok');
      return;
    }
    // 跨域预检与响应头：必须排在所有 /api 处理之前，否则预检 OPTIONS 会落到静态托管上
    // （sirv 对 OPTIONS 不返回允许头，浏览器直接判失败，真请求根本发不出去）。
    if (applyCorsHeaders(request, response)) return;
    // 排行榜 API（#116）**必须**排在静态托管之前：sirv 配了 `single: true`，
    // 任何落到它手里的未知路径都会被当成「前端路由」返回 index.html（200 + HTML），
    // 客户端 `response.json()` 于是抛出一个与真实原因毫不相干的解析错误。
    if (leaderboardApi !== null && leaderboardApi(request, response)) return;
    // 战绩上云 API（#123）同理，也必须排在静态托管之前。
    if (playerAccountApi !== null && playerAccountApi(request, response)) return;
    staticHandler(request, response);
  };
}

/**
 * 给 `/api/` 开跨域。
 *
 * 为什么需要：同源部署时浏览器不发预检、也不需要这些头；但 H5 包体挂在第三方域名
 * （TapTap 创意工坊）下时，页面与接口不同源，缺了 `Access-Control-Allow-Origin`
 * 浏览器会直接拦掉响应 —— 表现是「网络错误」，与接口本身是否正常无关，极易误判。
 *
 * 只覆盖 `/api/`，静态资源不需要（同源加载）。
 * 返回 true 表示这次请求已经处理完毕（OPTIONS 预检），调用方应直接 return。
 */
function applyCorsHeaders(request: IncomingMessage, response: ServerResponse): boolean {
  const path = request.url ?? '';
  if (!path.startsWith('/api/')) return false;

  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Max-Age', '600');

  if (request.method !== 'OPTIONS') return false;

  response.statusCode = 204;
  response.end();
  return true;
}

/** 客户端产物不可用时的兜底：直接 404，而不是让 sirv 在构造期抛 ENOENT 把进程带崩。
 *  这样即使 `apps/client/dist` 缺失（未构建 / 构建失败 / 只跑 API），服务端仍能启动，
 *  WebSocket 对局与 /healthz 保持可用，同时大声告警暴露问题。 */
function resolveStaticHandler(clientDistPath: string | undefined): (request: IncomingMessage, response: ServerResponse) => void {
  const notFound = (_request: IncomingMessage, response: ServerResponse): void => {
    response.statusCode = 404;
    response.end('Not found');
  };
  if (clientDistPath === undefined) return notFound;
  try {
    return sirv(clientDistPath, { single: true });
  } catch (error) {
    console.error(
      `[richman] 无法托管客户端产物（${clientDistPath}）：${error instanceof Error ? error.message : String(error)}。`
      + '请先执行 `pnpm --filter @richman/client build`；当前所有静态路由将返回 404。',
    );
    return notFound;
  }
}

async function closeServer<TTimerHandle>(
  httpServer: HttpServer,
  io: SocketIoServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>,
  roomManager: RoomManager<TTimerHandle>,
): Promise<void> {
  try {
    await new Promise<void>((resolve) => {
      io.close(() => resolve());
    });
  } finally {
    roomManager.dispose();
  }

  if (!httpServer.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
