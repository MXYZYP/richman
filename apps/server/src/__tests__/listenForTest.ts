/**
 * 测试里起 HTTP 服务的统一入口。
 *
 * ★ 为什么要这个 helper —— 「偶发红灯」的根因（2026-11-01 实测）：
 *   测试常见写法 `server.listen(0)` 让系统随机分配端口，但 **Windows 的动态端口范围
 *   在这台机器上是 1024–14999**（`netsh int ipv4 show dynamicport tcp`），而 Node 的 fetch
 *   （undici）内置了一份「浏览器阻塞端口」黑名单，两拨范围重叠：6000、6566、6665–6669、
 *   6697、10080、5060、5061…… 一旦随机端口落进黑名单，fetch 就直接抛
 *   `TypeError: fetch failed / caused by: Error: bad port`，跟被测代码毫无关系。
 *   按 14/13976 的概率算，一个起 29 次服务的测试文件约 2% 概率挂 —— 表现为「同一个提交
 *   时红时绿」，最容易浪费人的时间。
 *
 * ★ 修法不是「重跑一次」，而是**拿到端口先校验**：落在黑名单里就 close 掉重新 listen。
 *   这样红灯从概率事件变成确定事件（清单外的端口一定能用）。
 *
 * 用法：
 *   const port = await listenForTest(server);
 *   const baseUrl = `http://127.0.0.1:${port}`;
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * undici（Node 内置 fetch）拒绝连接的端口黑名单 —— 抄自 WHATWG fetch 规范的
 * 「bad port」清单，浏览器用它挡住 SMTP/X11/IRC 之类明文协议被网页拿来打内网。
 * 只列清单，不猜范围：猜范围会在 Windows 调整动态端口区间时漏掉。
 */
export const BAD_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161,
  179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
  587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

/** 重试次数上限：撞黑名单的概率约千分之一，12 次还撞上属于环境异常，直接抛错比静默卡死好。 */
const MAX_ATTEMPTS = 12;

export function isBadPort(port: number): boolean {
  return BAD_PORTS.has(port);
}

function listenOnce(server: Server, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('error', onError);
      reject(error);
    };
    server.once('error', onError);
    server.listen(0, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function closeOnce(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function readPort(server: Server): number {
  const address = server.address();
  if (address && typeof address === 'object') return (address as AddressInfo).port;
  return 0;
}

/**
 * 在随机端口上起服务，**保证返回的端口不在 fetch 的黑名单里**。
 * 返回端口号（不是 URL —— 有的调用方要 port，有的要拼 http，有的要拼 ws）。
 */
export async function listenForTest(server: Server, host = '127.0.0.1'): Promise<number> {
  let lastPort = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await listenOnce(server, host);
    const port = readPort(server);
    if (port > 0 && !isBadPort(port)) return port;
    lastPort = port;
    await closeOnce(server);
  }
  throw new Error(
    `listenForTest: 试了 ${MAX_ATTEMPTS} 次都没拿到可用端口（最后一次拿到 ${lastPort}）—— 端口黑名单命中率异常，别重跑，先看环境`,
  );
}
