import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createMetricsApi, METRICS_PATH } from '../metrics/metricsRoutes';
import { createServerMetrics, type RoomStats } from '../metrics/serverMetrics';

let active: HttpServer | undefined;

afterEach(async () => {
  const server = active;
  active = undefined;
  if (server === undefined) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function metricsServer(stats: RoomStats, startedAt = 1_700_000_000_000): Promise<string> {
  let clock = startedAt;
  const collector = createServerMetrics({ rooms: () => stats, now: () => clock });
  const api = createMetricsApi({ collector });
  const server = createServer((request, response) => {
    if (api(request, response)) return;
    response.statusCode = 404;
    response.end('not found');
  });
  active = server;
  return new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe('createServerMetrics', () => {
  it('merges live room stats with uptime', () => {
    let clock = 1_700_000_000_000;
    const collector = createServerMetrics({
      rooms: () => ({ rooms: 3, players: 7, playing: 2 }),
      now: () => clock,
    });

    clock += 45_000;
    expect(collector.snapshot()).toEqual({
      rooms: 3,
      players: 7,
      playing: 2,
      uptimeSeconds: 45,
      startedAt: new Date(1_700_000_000_000).toISOString(),
      disconnects: 0,
      reconnects: 0,
    });
  });

  it('counts disconnects and reconnects monotonically', () => {
    const collector = createServerMetrics({ rooms: () => ({ rooms: 0, players: 0, playing: 0 }) });

    collector.recordDisconnect();
    collector.recordDisconnect();
    collector.recordReconnect();

    const snapshot = collector.snapshot();
    expect(snapshot.disconnects).toBe(2);
    expect(snapshot.reconnects).toBe(1);
  });

  it('never reports negative uptime when the clock jumps backwards', () => {
    let clock = 1_000_000;
    const collector = createServerMetrics({ rooms: () => ({ rooms: 0, players: 0, playing: 0 }), now: () => clock });
    clock -= 5_000;
    expect(collector.snapshot().uptimeSeconds).toBe(0);
  });
});

describe('GET /api/metrics', () => {
  it('answers with the aggregate numbers and nothing identifiable', async () => {
    const baseUrl = await metricsServer({ rooms: 2, players: 5, playing: 1 });

    const response = await fetch(`${baseUrl}${METRICS_PATH}`);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.rooms).toBe(2);
    expect(body.players).toBe(5);
    expect(body.playing).toBe(1);
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(typeof body.startedAt).toBe('string');
    // 绝不能带房间码 / 昵称 / IP：这个端点会被 CI 与运维反复打，必须是纯聚合数字。
    expect(JSON.stringify(body)).not.toContain('roomCode');
    expect(JSON.stringify(body)).not.toContain('nickname');
    expect(JSON.stringify(body)).not.toContain('token');
  });

  it('is not cacheable (a probe reading a stale value is worse than no probe)', async () => {
    const baseUrl = await metricsServer({ rooms: 0, players: 0, playing: 0 });

    const response = await fetch(`${baseUrl}${METRICS_PATH}`);

    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('rejects anything but GET', async () => {
    const baseUrl = await metricsServer({ rooms: 0, players: 0, playing: 0 });

    const response = await fetch(`${baseUrl}${METRICS_PATH}`, { method: 'POST' });

    expect(response.status).toBe(405);
  });
});
