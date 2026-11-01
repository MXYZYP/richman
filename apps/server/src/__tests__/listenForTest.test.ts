import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { BAD_PORTS, isBadPort, listenForTest } from './listenForTest';

/**
 * 假 server：按预设队列依次「分配」端口，用来**确定性地**制造撞黑名单的场景。
 * 真实 listen(0) 撞黑名单只有千分之一概率，靠运气永远测不到重试逻辑 —— 必须能手动造。
 */
function fakeServer(ports: readonly number[]): { server: Server; closeCount: () => number } {
  let index = 0;
  let current = 0;
  let closed = 0;
  const stub = {
    once: () => stub,
    off: () => stub,
    listen(_port: number, _host: string, callback: () => void) {
      current = ports[Math.min(index, ports.length - 1)] ?? 0;
      index += 1;
      callback();
    },
    address(): AddressInfo {
      return { port: current, address: '127.0.0.1', family: 'IPv4' };
    },
    close(callback?: () => void) {
      closed += 1;
      callback?.();
    },
  };
  return { server: stub as unknown as Server, closeCount: () => closed };
}

describe('listenForTest — 测试起服务的端口硬化', () => {
  it('黑名单端口认得出，普通端口放得过', () => {
    expect(isBadPort(6000)).toBe(true);
    expect(isBadPort(6666)).toBe(true);
    expect(isBadPort(10080)).toBe(true);
    expect(isBadPort(5061)).toBe(true);
    expect(isBadPort(12345)).toBe(false);
    expect(isBadPort(8080)).toBe(false);
    expect(BAD_PORTS.size).toBeGreaterThan(50);
  });

  it('★ 拿到黑名单端口会 close 掉重来，直到拿到能用的', async () => {
    const { server, closeCount } = fakeServer([6000, 6666, 10080, 12345]);
    const port = await listenForTest(server);
    expect(port).toBe(12345);
    // 前三次都撞黑名单 ⇒ 必须各 close 一次再重 listen，否则端口泄漏
    expect(closeCount()).toBe(3);
  });

  it('一直撞黑名单时不静默卡死，抛错并把最后一次端口说出来', async () => {
    const { server } = fakeServer([6000]);
    await expect(listenForTest(server)).rejects.toThrow(/6000/);
  });

  it('真实起服务：拿到的端口不在黑名单，且 fetch 真的通', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });
    try {
      const port = await listenForTest(server);
      expect(port).toBeGreaterThan(0);
      expect(isBadPort(port)).toBe(false);
      const response = await fetch(`http://127.0.0.1:${port}/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('ok');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
