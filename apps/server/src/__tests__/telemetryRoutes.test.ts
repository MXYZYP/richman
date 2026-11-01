import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTelemetryApi, DEFAULT_TELEMETRY_RATE_LIMIT, TELEMETRY_PATH } from '../telemetry/telemetryRoutes';
import { createTelemetryStore } from '../telemetry/telemetryStore';

let active: { server: HttpServer; directory: string } | undefined;

afterEach(async () => {
  const current = active;
  active = undefined;
  if (current === undefined) return;
  await new Promise<void>((resolve) => current.server.close(() => resolve()));
  await rm(current.directory, { recursive: true, force: true });
});

async function startTelemetryServer(options: { rateLimit?: false | typeof DEFAULT_TELEMETRY_RATE_LIMIT; maxBodyBytes?: number } = {}): Promise<{ baseUrl: string; file: (day: Date) => string }> {
  const root = await mkdtemp(join(tmpdir(), 'richman-telemetry-api-'));
  const directory = join(root, 'runtime');
  const fixedNow = () => Date.UTC(2026, 9, 31, 12);
  const store = createTelemetryStore({ directory, now: fixedNow });
  const api = createTelemetryApi({
    store,
    // 时钟也要注入：客户端时间戳偏离服务器 24h 以上时会被替换成服务器时间，
    // 用例里用 t=1 就是专门验证这条规则的，不注入就会拿到真实的 Date.now()。
    now: fixedNow,
    rateLimit: options.rateLimit === undefined ? false : options.rateLimit,
    maxBodyBytes: options.maxBodyBytes,
  });
  const server = createServer((request, response) => {
    if (api(request, response)) return;
    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  active = { server, directory: root };
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    file: (day: Date) => store.filePathFor(day),
  };
}

function post(baseUrl: string, body: unknown, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${TELEMETRY_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
}

describe('POST /api/telemetry', () => {
  const day = new Date(Date.UTC(2026, 9, 31, 12));

  it('accepts a batch and lands it on disk', async () => {
    const { baseUrl, file } = await startTelemetryServer();

    const serverNow = Date.UTC(2026, 9, 31, 12);
    const response = await post(baseUrl, { clientId: 'client-a', events: [{ name: 'app_open', t: serverNow + 5 }] });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const raw = await readFile(file(day), 'utf8');
    // 时间戳取「接近服务器时间」的值：离谱值（如 t=1）会被替换成服务器时间，
    // 那条规则已在 telemetryStore 用例里单独验证，这里只验证端到端落盘。
    expect(JSON.parse(raw.trim())).toEqual({ id: 'client-a', name: 'app_open', t: serverNow + 5 });
  });

  it('rejects non-POST methods', async () => {
    const { baseUrl } = await startTelemetryServer();

    const response = await fetch(`${baseUrl}${TELEMETRY_PATH}`, { method: 'GET' });

    expect(response.status).toBe(405);
  });

  it('rejects malformed and unusable payloads with 400', async () => {
    const { baseUrl } = await startTelemetryServer();

    expect((await post(baseUrl, 'not json')).status).toBe(400);
    expect((await post(baseUrl, { clientId: 'a' })).status).toBe(400);
    expect((await post(baseUrl, { clientId: 'a', events: [{ nope: 1 }] })).status).toBe(400);
  });

  it('rejects oversized bodies before buffering them', async () => {
    const { baseUrl } = await startTelemetryServer({ maxBodyBytes: 512 });

    const huge = { clientId: 'a', events: [{ name: 'app_open', t: 1, props: { blob: 'x'.repeat(5000) } }] };
    const response = await post(baseUrl, JSON.stringify(huge));

    expect(response.status).toBe(413);
  });

  it('rate limits per client IP without counting rejected attempts', async () => {
    const rule = { windowMs: 60_000, maxPerWindow: 2 };
    const { baseUrl } = await startTelemetryServer({ rateLimit: rule });

    const first = await post(baseUrl, { clientId: 'a', events: [{ name: 'tick', t: 1 }] });
    const second = await post(baseUrl, { clientId: 'a', events: [{ name: 'tick', t: 2 }] });
    const third = await post(baseUrl, { clientId: 'a', events: [{ name: 'tick', t: 3 }] });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
  });

  it('reports 503 when the store cannot write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'richman-telemetry-broken-'));
    const store = createTelemetryStore({ directory: join(root, 'runtime') });
    const broken = {
      filePathFor: store.filePathFor,
      append: () => {
        throw new Error('disk full');
      },
    };
    const api = createTelemetryApi({ store: broken, rateLimit: false });
    const server = createServer((request, response) => {
      if (api(request, response)) return;
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;
    active = { server, directory: root };

    const response = await post(`http://127.0.0.1:${address.port}`, { clientId: 'a', events: [{ name: 'tick', t: 1 }] });

    expect(response.status).toBe(503);
    expect((await response.json() as { error: string }).error).toBe('storage_unavailable');
  });
});
