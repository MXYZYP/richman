import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor 配置：把 Vue 构建产物（apps/client/dist）封装为原生外壳。
 *
 * - webDir: 必须指向 `pnpm build` 产出的客户端静态目录（与 server/production.ts 里的
 *   CLIENT_DIST_PATH 同源，二者共用同一份 dist）。
 * - server.url: 默认留空 = 把 dist 打进 APK 离线运行（推荐，玩家无需联网也能打开首页）。
 *   若希望 App 永远加载云端最新版（server 端更新即生效、不必发版），把下面 url 改成你的
 *   云地址，例如 'https://richman.example.com'，并删除 webDir 这一行注释差异（保留 url 即可）。
 * - appId: 改成你自己的反向域名（上架 Google Play / 应用宝需要唯一 ID）。
 */
const config: CapacitorConfig = {
  appId: 'com.richman.game',
  appName: '大富翁联机',
  webDir: 'dist',
  server: {
    // androidScheme: 'https', // 如需在 WebView 内使用安全上下文可开启
  },
  // 联机游戏依赖 WebSocket：Capacitor 的 WebView 原生支持，无需额外插件。
  // 若使用「云端 URL」模式，请确保该域名已备案 / 支持 HTTPS。
};

export default config;
