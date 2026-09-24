import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RoomManager as RoomManagerInstance } from '../rooms/roomManager';
import type { RoomDomainEvent, RoomManagerDependencies } from '../rooms/roomTypes';

type AsyncEventsHandler = (events: RoomDomainEvent[]) => void;

type TestServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

type TimerHandle = {
  id: string;
};

type RoomManagerConstructor = new (deps: RoomManagerDependencies<TimerHandle>) => RoomManagerInstance<TimerHandle>;

type SocketLike = {
  connected: boolean;
  connect: () => void;
  disconnect: () => void;
  emit: (event: string, payload: unknown, ack: (response: unknown) => void) => void;
  once: (event: string, listener: (...args: unknown[]) => void) => void;
};

const indexHtml = '<!doctype html><div id="app">fixture app</div><script type="module" src="/assets/app.js"></script>';
const appJs = 'window.__STATIC_FIXTURE__ = "served from temp dist";\n';

let activeServer: TestServer | undefined;
let tempRoot: string | undefined;
const activeSockets: SocketLike[] = [];

afterEach(async () => {
  for (const socket of activeSockets.splice(0)) {
    socket.disconnect();
  }

  const server = activeServer;
  activeServer = undefined;

  try {
    if (server) {
      await server.close();
    }
  } finally {
    if (tempRoot) {
      const root = tempRoot;
      tempRoot = undefined;
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe('same-port client static hosting', () => {
  it('serves the root index and JavaScript asset exactly from the configured client dist', async () => {
    const { baseUrl } = await startServerWithFixtureDist();

    const indexResponse = await fetch(`${baseUrl}/`);
    expect(indexResponse.status).toBe(200);
    expect(indexResponse.headers.get('content-type')).toMatch(/^text\/html\b/);
    expect(await indexResponse.text()).toBe(indexHtml);

    const assetResponse = await fetch(`${baseUrl}/assets/app.js`);
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get('content-type')).toMatch(/^text\/javascript\b/);
    expect(await assetResponse.text()).toBe(appJs);
  });

  it('falls back to index.html for extensionless SPA routes', async () => {
    const { baseUrl } = await startServerWithFixtureDist();

    const response = await fetch(`${baseUrl}/rooms/0007`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/html\b/);
    expect(await response.text()).toBe(indexHtml);
  });

  it('does not convert missing extension assets or traversal attempts into the SPA fallback', async () => {
    const { baseUrl } = await startServerWithFixtureDist();

    const missingAssetResponse = await fetch(`${baseUrl}/assets/missing.js`);
    expect(missingAssetResponse.status).toBe(404);
    expect(await missingAssetResponse.text()).not.toBe(indexHtml);

    const traversalResponse = await fetch(`${baseUrl}/%2e%2e/secret.txt`);
    expect(traversalResponse.status).toBe(404);
    expect(await traversalResponse.text()).not.toContain('outside static root');
  });

  it('keeps Socket.IO room creation working on the same port as static hosting', async () => {
    const { baseUrl } = await startServerWithFixtureDist();
    const socket = await connectSocket(baseUrl);

    const ack = await emitWithAck(socket, 'room:create', {
      mapId: 'china-tour', nickname: '主机',
      requestId: '00112233445566778899aabbccddeeff',
    });

    expect(ack).toMatchObject({
      ok: true,
      roomCode: '000007',
      playerId: 'p1',
      token: 'token-1',
      room: {
        roomCode: '000007',
        status: 'lobby',
        hostId: 'p1',
        players: [{ id: 'p1', nickname: '主机', isBot: false, online: true }],
      },
    });

    expect(JSON.stringify(ack)).not.toContain('token-2');
    const staticResponse = await fetch(`${baseUrl}/assets/app.js`);
    expect(staticResponse.status).toBe(200);
    expect(await staticResponse.text()).toBe(appJs);
  });
});

async function startServerWithFixtureDist(): Promise<TestServer> {
  tempRoot = await mkdtemp(join(tmpdir(), 'richman-static-'));
  const distPath = join(tempRoot, 'client-dist');
  await writeFile(join(tempRoot, 'secret.txt'), 'outside static root');
  await mkdir(join(distPath, 'assets'), { recursive: true });
  await writeFile(join(distPath, 'index.html'), indexHtml, { flag: 'wx' });
  await writeFile(join(distPath, 'assets', 'app.js'), appJs, { flag: 'wx' });

  // RED compatibility: these future modules do not exist in the current baseline;
  // importing them inside the helper lets Vitest collect this static-hosting contract first.
  const [{ createRoomServer }, { RoomManager }] = await Promise.all([
    import('../server'),
    import('../rooms/roomManager'),
  ]);
  const serverOptions = {
    clientDistPath: distPath,
    rateLimit: false as const,
    roomManagerFactory: (onAsyncEvents: AsyncEventsHandler) =>
      createDeterministicRoomManager(RoomManager, onAsyncEvents),
  };
  const server = createRoomServer(serverOptions);

  try {
    await listenOnEphemeralLocalhost(server.httpServer);

    const address = server.httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected the test HTTP server to listen on an ephemeral TCP port');
    }
    const { port } = address as AddressInfo;

    activeServer = {
      baseUrl: `http://127.0.0.1:${port}`,
      close: () => server.close(),
    };

    return activeServer;
  } catch (error) {
    await server.close();
    throw error;
  }
}

async function listenOnEphemeralLocalhost(httpServer: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      httpServer.off('error', onError);
      reject(error);
    };
    httpServer.once('error', onError);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', onError);
      resolve();
    });
  });
}

function createDeterministicRoomManager(
  RoomManager: RoomManagerConstructor,
  onAsyncEvents: AsyncEventsHandler,
): RoomManagerInstance<TimerHandle> {
  let player = 0;
  let token = 0;
  const roomNumbers = [7, 7, 8];

  return new RoomManager({
    generatePlayerId: () => `p${++player}`,
    generateToken: () => `token-${++token}`,
    nextRoomNumber: () => roomNumbers.shift() ?? 9,
    setTimer: () => ({ id: 'unused-static-test-timer' }),
    clearTimer: () => undefined,
    compareTokens: (actual: string, expected: string) => actual === expected,
    onAsyncEvents,
    generateGameSeed: () => 'static-game-seed',
    nextAutomationDelayMs: () => 1000,
  });
}

async function connectSocket(baseUrl: string): Promise<SocketLike> {
  // RED compatibility: socket.io-client is a future test dependency for this package;
  // load it only in the same-port Socket.IO test so static cases still collect.
  const { io } = await import('socket.io-client');
  const socket = io(baseUrl, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  }) as SocketLike;
  activeSockets.push(socket);

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
    socket.connect();
  });

  return socket;
}

async function emitWithAck(socket: SocketLike, event: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}
