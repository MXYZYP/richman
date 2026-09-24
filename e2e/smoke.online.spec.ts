import { expect, test, type Page } from '@playwright/test';

/**
 * 联机冒烟：验证两个真实浏览器（各自独立的 localStorage）能走通「建房 → 加入 → 开局」，
 * 以及「刷新后自动回到原房间」。
 *
 * 两条用例各建一个房间。服务端对创建房间有「按 IP 每分钟 5 次」的限流，而 e2e 里所有请求
 * 都来自 127.0.0.1 同一个 IP——**新增用例时请把创建房间的总次数控制在这个额度内**，
 * 否则会撞上 CREATE_RATE_LIMITED 而不是被测功能本身。
 */

async function createRoom(page: Page, nickname: string): Promise<string> {
  await page.goto('/');
  await page.getByPlaceholder('例如：小明').fill(nickname);
  await page.getByRole('button', { name: '创建房间' }).click();

  const title = page.getByRole('heading', { name: /^房间 \d{6}$/ });
  await expect(title).toBeVisible();
  const roomCode = (await title.innerText()).replace(/\D/g, '');
  expect(roomCode).toMatch(/^\d{6}$/);
  return roomCode;
}

async function joinRoom(page: Page, nickname: string, roomCode: string): Promise<void> {
  await page.goto('/');
  await page.getByPlaceholder('例如：小明').fill(nickname);
  await page.getByPlaceholder('6 位数字').fill(roomCode);
  await page.getByRole('button', { name: '加入房间' }).click();
}

test.describe('联机对战冒烟', () => {
  test('建房 → 好友凭码加入 → 房主开局，双方进入棋盘', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const guestContext = await browser.newContext();

    try {
      const host = await hostContext.newPage();
      const guest = await guestContext.newPage();

      const roomCode = await createRoom(host, '房主A');

      await joinRoom(guest, '客人B', roomCode);
      await expect(guest.getByRole('heading', { name: `房间 ${roomCode}` })).toBeVisible();

      // 房主侧的名册由服务端 room:state 广播驱动，看到 B 才算真的加入成功。
      await expect(host.locator('.lobby-player').filter({ hasText: '客人B' })).toBeVisible();

      await host.getByRole('button', { name: '开始游戏' }).click();

      // 双方都进入棋盘；先手是哪一方由服务端决定，所以只断言「有人真的可以掷骰」。
      // 注意不能用 `locator.or()` 跨页面组合：它只接受同一 frame 内的 locator。
      await expect(host.locator('.action-panel')).toBeVisible();
      await expect(guest.locator('.action-panel')).toBeVisible();
      await expect
        .poll(async () => {
          const [hostRolls, guestRolls] = await Promise.all([
            host.getByRole('button', { name: '掷骰子' }).count(),
            guest.getByRole('button', { name: '掷骰子' }).count(),
          ]);
          return hostRolls + guestRolls;
        }, { message: '开局后先手方应出现「掷骰子」主操作' })
        .toBeGreaterThan(0);
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test('房主刷新页面后自动回到同一个房间，房间码不变', async ({ page }) => {
    const roomCode = await createRoom(page, '房主A');

    await page.reload();

    // 活跃会话存在 localStorage：刷新应当自动恢复回原房间，而不是把人丢回首页。
    await expect(page.getByRole('heading', { name: `房间 ${roomCode}` })).toBeVisible();
  });
});
