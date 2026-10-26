/**
 * 服务端根地址的唯一事实源。
 *
 * 为什么要这一层：本作有两种部署形态，两者的接口地址算法不同。
 *
 *  1. **同源部署**（现状）：服务器自己托管 `apps/client/dist`，页面和接口同域，
 *     `/api/leaderboard` 和 `io(location.origin)` 都天然正确 ⇒ 返回 `''`。
 *  2. **跨域部署**（H5 包体挂在 TapTap 创意工坊等第三方域名下）：页面来自 A 域，
 *     接口在 B 域。此时相对路径会打到 A 域上，必然 404 ⇒ 由构建期
 *     `VITE_SERVER_ORIGIN` 注入 B 域（例如 `https://game.mxyzyp.xyz`）。
 *
 * 抽成纯函数是为了能单独测：模块顶层读 `import.meta.env` 的那行没法在测试里换环境。
 */
export interface ServerOriginEnv {
  readonly VITE_SERVER_ORIGIN?: string;
}

/**
 * 解析出协议 + 主机部分，**不带结尾斜杠**（避免拼出 `https://x.com//api`）。
 * 空串表示「与页面同源」。
 */
export function resolveServerOrigin(env: ServerOriginEnv | undefined): string {
  const raw = env?.VITE_SERVER_ORIGIN;
  if (typeof raw !== 'string') return '';

  const trimmed = raw.trim();
  if (trimmed === '') return '';

  // 只接受 http(s) 绝对地址。写错了（比如只写了域名没有协议）宁可当没配，
  // 也不要把 `game.mxyzyp.xyz/api/leaderboard` 这种相对串塞进 fetch —— 那会被
  // 当成站内路径，报出来的错误与真实原因完全无关。
  if (!/^https?:\/\/[^\s/]+/i.test(trimmed)) return '';

  return trimmed.replace(/\/+$/, '');
}
