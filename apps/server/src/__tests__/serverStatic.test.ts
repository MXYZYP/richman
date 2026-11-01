import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
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
/** 没有预压缩伴生文件的资源：用来证明「脚本没跑过也不会 404 / 不会乱码」。 */
const plainJs = 'window.__PLAIN_FIXTURE__ = "no precompressed sibling";\n';

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

describe('E1 static compression and cache headers', () => {
  it('serves the brotli sibling when the client accepts br', async () => {
    const { baseUrl } = await startServerWithFixtureDist();

    const response = await fetch(`${baseUrl}/assets/app.js`, { headers: { 'accept-encoding': 'br' } });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBe('br');
    // 内容类型必须按**去掉 .br 后缀**的名字判定，否则浏览器会拒绝执行 JS。
    expect(response.headers.get('content-type')).toMatch(/^text\/javascript\b/);
    expect(response.headers.get('vary')).toContain('Accept-Encoding');
    // undici 会按 content-encoding 自动解回原文，所以这里拿到的一定是原文（头仍是 br）。
    expect(await response.text()).toBe(appJs);
  });

  it('serves the gzip sibling when the client only accepts gzip', async () => {
    const { baseUrl } = await startServerWithFixtureDist();

    const response = await fetch(`${baseUrl}/assets/app.js`, { headers: { 'accept-encoding': 'gzip' } });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(await response.text()).toBe(appJs);
  });

  it('falls back to the original file when no precompressed sibling exists', async () => {
    const { baseUrl } = await startServerWithFixtureDist();

    const response = await fetch(`${baseUrl}/assets/plain.js`, { headers: { 'accept-encoding': 'br' } });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(await response.text()).toBe(plainJs);
  });

  it('gives hashed assets an immutable long cache', async () => {
    const { baseUrl } = await startServerWithFixtureDist();

    const response = await fetch(`${baseUrl}/assets/app.js`, { headers: { 'accept-encoding': 'identity' } });

    expect(response.headers.get('cache-control')).toContain('max-age=31536000');
    expect(response.headers.get('cache-control')).toContain('immutable');
  });

  it('never long-caches index.html or the service worker', async () => {
    const { baseUrl } = await startServerWithFixtureDist();

    // index.html 被长缓存 = 发布新版后玩家仍请求已被清掉的旧 chunk ⇒ 白屏，这条必须硬。
    const index = await fetch(`${baseUrl}/index.html`, { headers: { 'accept-encoding': 'identity' } });
    expect(index.headers.get('cache-control')).toBe('no-cache');

    const sw = await fetch(`${baseUrl}/sw.js`, { headers: { 'accept-encoding': 'identity' } });
    expect(sw.headers.get('cache-control')).toBe('no-cache');

    // SPA 兜底返回的也是 index.html，同样不能长缓存。
    const fallback = await fetch(`${baseUrl}/rooms/0007`, { headers: { 'accept-encoding': 'identity' } });
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get('cache-control')).toBe('no-cache');
  });

  it('gives non-hashed binaries a short cache instead of immutable', async () => {
    const { baseUrl } = await startServerWithFixtureDist();

    const response = await fetch(`${baseUrl}/icon.png`, { headers: { 'accept-encoding': 'identity' } });

    expect(response.headers.get('cache-control')).toBe('public, max-age=86400');
  });
});

async function startServerWithFixtureDist(): Promise<TestServer> {
  tempRoot = await mkdtemp(join(tmpdir(), 'richman-static-'));
  const distPath = join(tempRoot, 'client-dist');
  await writeFile(join(tempRoot, 'secret.txt'), 'outside static root');
  await mkdir(join(distPath, 'assets'), { recursive: true });
  await writeFile(join(distPath, 'index.html'), indexHtml, { flag: 'wx' });
  await writeFile(join(distPath, 'assets', 'app.js'), appJs, { flag: 'wx' });
  await writeFile(join(distPath, 'assets', 'plain.js'), plainJs, { flag: 'wx' });
  await writeFile(join(distPath, 'sw.js'), 'const CACHE="fixture";\n', { flag: 'wx' });
  await writeFile(join(distPath, 'icon.png'), 'not-a-real-png', { flag: 'wx' });
  // E1：构建期预压缩产物（scripts/compress-dist.mjs 生成的就是这个形状）。
  await writeFile(join(distPath, 'assets', 'app.js.br'), brotliCompressSync(Buffer.from(appJs)), { flag: 'wx' });
  await writeFile(join(distPath, 'assets', 'app.js.gz'), gzipSync(Buffer.from(appJs)), { flag: 'wx' });

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
