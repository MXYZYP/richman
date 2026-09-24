import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
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
          if (path.includes('/packages/board-data/')) return 'board-data';
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
});
