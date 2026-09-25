import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * `/api/*` 这一类**同源 JSON 写接口**共用的 HTTP 杂务（排行榜 #116 与战绩上云 #123）。
 *
 * 抽出来的理由很实际：这些东西原本在 `leaderboardRoutes` 里，而第二个接口一旦出现，
 * 复制粘贴就会变成两份会各自漂移的实现 —— 而它们处理的全是「容易只在一个分支上踩坑」的
 * 细节（`Content-Length` 预检、超限后不掐连接、限流取哪一跳 IP）。
 *
 * 这里没有任何业务语义，只有「把请求安全地读成一个 JSON 对象」「把结果写成 JSON 响应」
 * 以及「这个请求算谁头上」。
 */

export interface ParsedRequestUrl {
  pathname: string;
  searchParams: URLSearchParams;
}

/** `request.url` 是「路径 + 查询串」，没有 host，因此给一个固定 base 再解析。 */
export function parseRequestUrl(rawUrl: string | undefined): ParsedRequestUrl | null {
  if (rawUrl === undefined) return null;
  try {
    const parsed = new URL(rawUrl, 'http://localhost');
    return { pathname: parsed.pathname, searchParams: parsed.searchParams };
  } catch {
    return null;
  }
}

/**
 * 限流用的客户端标识。
 *
 * 取 `x-forwarded-for` 的**最后一跳**，而不是第一跳：本服务固定部署在单层可信反代
 * （Caddy → `127.0.0.1:3000`）之后，Caddy 会把自己看到的对端**追加**在末尾，这一跳伪造不了；
 * 而第一跳完全是请求方自己写的，谁都能编一个来绕过限流。
 * 没有该头（直连 / 本机测试）时退回套接字对端地址。
 */
export function clientKey(request: IncomingMessage): string {
  const forwarded = request.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  if (typeof raw === 'string' && raw.length > 0) {
    const hops = raw.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
    const last = hops.at(-1);
    if (last !== undefined) return last;
  }
  return request.socket.remoteAddress ?? 'unknown';
}

/**
 * 读请求体，超过 `maxBytes` 就停止累积并返回 `{ ok: false }`。
 *
 * 刻意**不**在这里 `destroy()`：那会把连接直接掐断，客户端看到的是「socket 被对端关闭」
 * 而不是 413 —— 一个只有真发过大包才会发现的坑。交给调用方回 413 后 `resume()` 丢弃余下字节。
 */
export function readBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        resolve({ ok: false });
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      if (settled) return;
      settled = true;
      resolve({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    });

    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/** 统一的 JSON 响应。`Cache-Control: no-store` —— 这些接口的结果任何时候都可能刚变过。 */
export function respondJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.writableEnded) return;
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(body);
}
