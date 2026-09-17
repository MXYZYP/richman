import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// 根 Vitest 配置：扫描所有包的 __tests__，以及 client 中与源码并列的 co-located 测试
export default defineConfig({
  plugins: [vue()],
  test: {
    include: [
      'packages/**/__tests__/**/*.test.ts',
      'apps/**/__tests__/**/*.test.ts',
      'apps/client/src/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
    environment: 'node',
  },
});
