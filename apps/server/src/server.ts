import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import sirv from 'sirv';
import { Server as SocketIoServer } from 'socket.io';
import type { ClientToServerEvents, InterServerEvents, ServerToClientEvents, SocketData } from '@richman/protocol';
import { RoomManager } from './rooms/roomManager';
import type { RoomDomainEvent } from './rooms/roomTypes';
import { createRoomSocketAdapter, type RoomSocketAdapterLogger } from './socket/roomSocketAdapter';

export interface CreateRoomServerOptions<TTimerHandle = unknown> {
  roomManagerFactory(onAsyncEvents: (events: RoomDomainEvent[]) => void): RoomManager<TTimerHandle>;
  logger?: RoomSocketAdapterLogger;
  clientDistPath?: string;
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
}: CreateRoomServerOptions<TTimerHandle>): RunningRoomServer<TTimerHandle> {
  const requestHandler = createRequestHandler(clientDistPath);
  const httpServer = createServer(requestHandler);
  const io = new SocketIoServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(httpServer, {
    serveClient: false,
  });

  let dispatchAsyncEvents = (_events: RoomDomainEvent[]): void => undefined;
  const roomManager = roomManagerFactory((events) => dispatchAsyncEvents(events));
  const adapter = createRoomSocketAdapter({ io, roomManager, logger });
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
  const staticHandler = clientDistPath === undefined
    ? (_request: IncomingMessage, response: ServerResponse) => {
        response.statusCode = 404;
        response.end('Not found');
      }
    : sirv(clientDistPath, { single: true });

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
