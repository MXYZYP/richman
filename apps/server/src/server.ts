import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { Stats } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sirv from 'sirv';
import { Server as SocketIoServer } from 'socket.io';
import type { ClientToServerEvents, InterServerEvents, ServerToClientEvents, SocketData } from '@richman/protocol';
import type { RateLimitRule } from './http/slidingWindowRateLimiter';
import { createLeaderboardApi, type LeaderboardApiHandler } from './leaderboard/leaderboardRoutes';
import { createLeaderboardStore, type LeaderboardStore } from './leaderboard/leaderboardStore';
import { createPlayerAccountApi, type PlayerAccountApiHandler } from './player/playerAccountRoutes';
import { createPlayerAccountStore, type PlayerAccountStore } from './player/playerAccountStore';
import { createMetricsApi, type MetricsApiHandler } from './metrics/metricsRoutes';
import { createServerMetrics, type MetricsCollector, type RoomStats } from './metrics/serverMetrics';
import { createTelemetryApi, type TelemetryApiHandler } from './telemetry/telemetryRoutes';
import { createTelemetryStore, type TelemetryStore } from './telemetry/telemetryStore';
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
  /**
   * 匿名埋点（运营 O0）。省略 = 挂载默认的**落盘**存储
   * （`.runtime/telemetry-YYYY-MM-DD.ndjson`，目录可用环境变量 `RICHMAN_TELEMETRY_DIR` 覆盖）；
   * `false` = 完全不挂这条路由。
   */
  telemetry?: TelemetryStore | false;
  /** 埋点上报限流（按客户端 IP 滑动窗口）；`false` 关闭（测试）。 */
  telemetryRateLimit?: RateLimitRule | false;
  /** 埋点请求体上限（字节）；默认 32 KiB。 */
  telemetryMaxBodyBytes?: number;
  /**
   * 实时指标端点 `GET /api/metrics`（运营 O2）。`false` = 不挂这条路由。
   * 挂载它**不**需要额外配置：它只读内存计数，不写任何数据。
   */
  metrics?: false;
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
  telemetry,
  telemetryRateLimit,
  telemetryMaxBodyBytes,
  metrics,
}: CreateRoomServerOptions<TTimerHandle>): RunningRoomServer<TTimerHandle> {
  // 指标收集器要先建出来（adapter 与路由都要用），但它依赖的房间表要等 roomManager 建好
  // 才有 ⇒ 用一个可替换的 provider 延后绑定，避免把整个初始化顺序倒过来。
  let roomStats: () => RoomStats = () => ({ rooms: 0, players: 0, playing: 0 });
  const metricsCollector: MetricsCollector | null = metrics === false
    ? null
    : createServerMetrics({ rooms: () => roomStats(), now });
  const leaderboardApi = resolveLeaderboardApi({ leaderboard, leaderboardRateLimit, leaderboardMaxBodyBytes, logger });
  const playerAccountApi = resolvePlayerAccountApi({ playerAccounts, playerRateLimit, playerMaxBodyBytes, logger });
  const telemetryApi = resolveTelemetryApi({ telemetry, telemetryRateLimit, telemetryMaxBodyBytes, logger, now });
  const metricsApi = metricsCollector === null ? null : createMetricsApi({ collector: metricsCollector });
  const requestHandler = createRequestHandler(clientDistPath, leaderboardApi, playerAccountApi, telemetryApi, metricsApi);
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
  roomStats = () => roomManager.stats();
  const adapter = createRoomSocketAdapter({ io, roomManager, logger, rateLimit, now, metrics: metricsCollector ?? undefined });
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
const DEFAULT_TELEMETRY_DIR = fileURLToPath(new URL('../.runtime', import.meta.url));
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

/** `null` = 不挂载埋点路由（`telemetry: false`）。 */
function resolveTelemetryApi(options: {
  telemetry?: TelemetryStore | false;
  telemetryRateLimit?: RateLimitRule | false;
  telemetryMaxBodyBytes?: number;
  logger?: RoomSocketAdapterLogger;
  now?: () => number;
}): TelemetryApiHandler | null {
  if (options.telemetry === false) return null;
  const store = options.telemetry
    ?? createTelemetryStore({ directory: process.env.RICHMAN_TELEMETRY_DIR ?? DEFAULT_TELEMETRY_DIR });
  return createTelemetryApi({
    store,
    rateLimit: options.telemetryRateLimit,
    maxBodyBytes: options.telemetryMaxBodyBytes,
    logger: options.logger,
    now: options.now,
  });
}

function createRequestHandler(
  clientDistPath: string | undefined,
  leaderboardApi: LeaderboardApiHandler | null,
  playerAccountApi: PlayerAccountApiHandler | null,
  telemetryApi: TelemetryApiHandler | null,
  metricsApi: MetricsApiHandler | null,
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
    // 匿名埋点 API（运营 O0）同理。
    if (telemetryApi !== null && telemetryApi(request, response)) return;
    // 实时指标（运营 O2）同理，而且刻意放在埋点之后：它是被 CI 高频打的那个端点。
    if (metricsApi !== null && metricsApi(request, response)) return;
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

/**
 * 静态资源缓存头（E1）。
 *
 * - `/assets/*`：vite 产物文件名带内容 hash，内容一变文件名就变 ⇒ 可以放心 immutable
 *   长缓存，玩家二次访问这些 chunk 全部走本地缓存。
 * - HTML 与 Service Worker：**必须** no-cache。index.html 引用的是当前版本 chunk 的文件名，
 *   一旦被长缓存，发布新版后浏览器仍拿旧 HTML、去请求已被清掉的旧 chunk ⇒ 白屏；
 *   sw.js 同理（它自己决定是否接管，长缓存会让「新版本可用」提示永远不出现）。
 * - 其余（图标 / 首页 webp）：一天，够用且留了纠错的余地。
 */
function applyStaticCacheHeaders(_response: ServerResponse, pathname: string, _stats: Stats): void {
  if (pathname.startsWith('/assets/')) {
    _response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return;
  }
  // 注意 pathname 是**请求的**路径：SPA 兜底时它形如 `/rooms/0007`，sirv 不会改写成
  // `/index.html`。所以判断要覆盖两类：
  //   1) 显式列出的入口文件（index.html / sw.js / manifest）；
  //   2) 不带扩展名的路径 —— 它们都会被 single:true 兜底成 index.html。
  // 这两类一旦被长缓存，玩家手里就是「旧 HTML + 已被清掉的旧 chunk」⇒ 白屏。
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  const hasExtension = lastSegment.includes('.');
  const isEntryDocument = pathname === '/sw.js'
    || pathname === '/manifest.webmanifest'
    || pathname.endsWith('.html');

  if (!hasExtension || isEntryDocument) {
    _response.setHeader('Cache-Control', 'no-cache');
    return;
  }
  _response.setHeader('Cache-Control', 'public, max-age=86400');
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
    // E1：压缩 + 缓存头。
    // - `brotli` / `gzip` 是「查同名 .br/.gz 文件」的开关，不是即时压缩：配套文件由
    //   `scripts/compress-dist.mjs` 在 client build 末尾生成（实测未压缩时首屏约 700 KB
    //   明文传输，请求 8 KB chunk 只有 Content-Length 没有 content-encoding）。
    //   脚本没跑也只是退回原文件，不会 404。
    // - `setHeaders`：sirv 在发送前会保留**已经设置过的**响应头（send() 里
    //   `if (tmp = res.getHeader(key)) headers[key] = tmp`），所以这里设的 Cache-Control 生效。
    //   `/assets/*` 文件名带内容 hash ⇒ immutable 长缓存；HTML/SW/manifest 必须每次校验
    //   （否则新版本发布后浏览器还拿旧的 index.html，引用的旧 chunk 已被清理 ⇒ 白屏）。
    return sirv(clientDistPath, {
      single: true,
      brotli: true,
      gzip: true,
      setHeaders: applyStaticCacheHeaders,
    });
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
