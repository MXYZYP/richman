import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import uniModule from '@dcloudio/vite-plugin-uni';

// @dcloudio/vite-plugin-uni 是 CJS 产物，在纯 ESM 的 vite.config.ts 里
// 默认导入有时会拿到模块命名空间而不是函数本身（报 "uni is not a function"）。
const uni = (uniModule as unknown as { default?: typeof uniModule }).default ?? uniModule;

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [uni()],
  resolve: {
    alias: {
      // 规则引擎 / 协议 / 地图数据是纯 TS、零 DOM 依赖（已扫描确认），
      // 直接引用工作区源码而不是复制副本，避免两边规则漂移。
      '@richman/engine': here('../../packages/engine/src/index.ts'),
      '@richman/protocol': here('../../packages/protocol/src/index.ts'),
      '@richman/board-data': here('../../packages/board-data/src/index.ts'),
      '@': here('./src'),
    },
  },
});
