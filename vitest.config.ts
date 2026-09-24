import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 根 Vitest 配置：扫描所有包的 __tests__，以及 client 中与源码并列的 co-located 测试
// root 显式固定为仓库根，否则通过 `pnpm --filter @richman/server test` 在 apps/server 目录下
// 运行时，include 的 monorepo 相对路径会解析失败，导致 "No test files found"。
export default defineConfig({
  root: __dirname,
  plugins: [vue()],
  test: {
    include: [
      'packages/**/__tests__/**/*.test.ts',
      'apps/**/__tests__/**/*.test.ts',
      'apps/client/src/**/*.test.ts',
      'scripts/**/*.test.ts',
      'tools/**/__tests__/**/*.test.ts',
    ],
    environment: 'node',
  },
});
