import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import sirv from 'sirv';
import { Server as SocketIoServer } from 'socket.io';
import type { ClientToServerEvents, InterServerEvents, ServerToClientEvents, SocketData } from '@richman/protocol';
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
}: CreateRoomServerOptions<TTimerHandle>): RunningRoomServer<TTimerHandle> {
  const requestHandler = createRequestHandler(clientDistPath);
  const httpServer = createServer(requestHandler);
  const io = new SocketIoServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(httpServer, {
    serveClient: false,
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

function createRequestHandler(clientDistPath: string | undefined): (request: IncomingMessage, response: ServerResponse) => void {
  const staticHandler = resolveStaticHandler(clientDistPath);

  // /healthz 供云平台/负载均衡探活（就绪探针）。返回 200 即代表进程存活。
  return (request, response) => {
    if (request.url === '/healthz') {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end('ok');
      return;
    }
    staticHandler(request, response);
  };
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
