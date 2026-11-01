import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

/**
 * 体验 E2：把 `@richman/board-data` 换成**懒加载入口**。
 *
 * 主入口在模块加载期同步注册十三张地图（258 KB），首页一条棋盘数据都用不到，却因为
 * `App.vue` 顶层 `listActiveMaps()` 被整包拉进首屏。懒入口只提供轻量目录，
 * 真正的地图包在玩家进设置 / 建房 / 开局时才 `loadProductionMapPacks()` 下载。
 *
 * ★ 只换**构建产物**这一份：测试（含 26 个依赖主入口的用例）与 dev 仍走主入口，
 * 行为完全一致 —— 否则一次性改 26 个测试文件，风险远大于收益。
 * 两份实现的一致性由 `packages/board-data/src/__tests__/mapCatalog.test.ts` 盯着。
 */
const LAZY_BOARD_DATA = fileURLToPath(
  new URL('../../packages/board-data/src/lazy.ts', import.meta.url),
);

export default defineConfig(({ mode }) => ({
  plugins: [vue()],
  resolve: {
    alias: mode === 'test'
      ? {}
      : [{ find: /^@richman\/board-data$/, replacement: LAZY_BOARD_DATA }],
  },
  // 首屏分包（待-10）：此前是单个 583 kB 的 index-*.js，把运行时不怎么变的大块
  // （Vue 运行时、规则引擎、全部地图数据）和每次发版都变的业务代码压在一起，
  // 既吃首屏流量，也让"改一行业务代码"导致整个大包缓存失效。
  // 这里按「变更频率 + 归属」切开，让浏览器分块缓存。
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          const path = id.replaceAll('\\', '/');
          if (path.includes('/node_modules/')) {
            if (path.includes('/@vue/') || path.includes('/vue/')) return 'vendor-vue';
            return 'vendor';
          }
          // pnpm workspace：包路径形如 <root>/packages/engine/src/...
          // ★ board-data 刻意**不再**合并成一个 chunk：体验 E2 起地图数据是按需加载的，
          //   合并成一个大包会让「只想要一张图」的请求被迫下载十三张（258 KB）。
          //   现在由动态 import 天然切成每张图一个 chunk。
          if (path.includes('/packages/engine/')) return 'engine';
          return undefined;
        },
      },
    },
  },
  server: {
    host: true, // 04 M1：允许局域网访问，供 owner 用手机试玩开发版
    port: 5173,
    allowedHosts: ['serrated-majority-anatomist.ngrok-free.dev'],
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
    },
  },
}));
