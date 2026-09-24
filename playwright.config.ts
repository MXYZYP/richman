import { defineConfig, devices } from '@playwright/test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 端到端浏览器冒烟（路线图：E2E 冒烟测试）。
 *
 * 跑的是**生产形态**：先 build 客户端，再由服务端静态托管 `client/dist`，
 * 所以被测的是玩家真正打开的那一份产物，而不是 vite dev server 的即时编译结果。
 *
 * 浏览器默认用系统已装的 Chrome（`channel: 'chrome'`），省掉约 150MB 的浏览器二进制下载。
 * 想改用 Playwright 自带内核时先 `pnpm exec playwright install chromium`，再
 * `E2E_CHANNEL=bundled pnpm e2e`；用系统 Edge 则 `E2E_CHANNEL=msedge`。
 *
 * 注意：根 package.json 没有 `"type": "module"`，Playwright 会把这个配置当 CJS 加载，
 * 所以这里**不能用 `import.meta`**（会抛 "Cannot use 'import.meta' outside a module"）。
 * 需要目录定位时一律走 `process.cwd()`。
 */
const E2E_PORT = Number(process.env.E2E_PORT ?? 3311);
const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
/** 房间快照目录指到 e2e 自己的临时区：冒烟造出来的房间没有保留价值，不该落在仓库里。 */
const E2E_SNAPSHOT_DIR = join(process.cwd(), 'e2e', '.runtime', 'room-snapshots');
// 每轮 e2e 都从「没有任何历史房间」开始。留着上一轮的快照会让服务端启动时把它们恢复出来，
// 于是随机房间码空间和断言都带着上一轮的痕迹，失败信息也会变得难以解释。
rmSync(E2E_SNAPSHOT_DIR, { recursive: true, force: true });
/** `bundled` 表示不指定 channel，交给 Playwright 自带内核。 */
const E2E_CHANNEL = process.env.E2E_CHANNEL ?? 'chrome';

export default defineConfig({
  testDir: './e2e',
  // 联机用例共享同一个服务端进程和同一份房间号空间，也共享「按 IP 每分钟 5 次创建房间」
  // 的限流额度，串行跑才能给出确定的失败信息。新增用例时请留意这条额度。
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  outputDir: './e2e/.artifacts',
  use: {
    baseURL: E2E_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    ...(E2E_CHANNEL === 'bundled' ? {} : { channel: E2E_CHANNEL }),
  },
  projects: [
    {
      name: 'desktop-chrome',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'corepack pnpm run e2e:serve',
    url: E2E_BASE_URL,
    // 不复用已有服务：宁可每次多等一次 build，也不要让「测的是上一次的产物」这种
    // 结果无法解释的假绿。若 3311 已被占用，Playwright 会直接报端口冲突。
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PORT: String(E2E_PORT),
      RICHMAN_SNAPSHOT_DIR: E2E_SNAPSHOT_DIR,
    },
  },
});
