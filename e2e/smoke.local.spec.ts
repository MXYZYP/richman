import { expect, test, type Page } from '@playwright/test';

/**
 * 单机冒烟：不碰服务端对局，只验证「首页 → 开局 → 掷骰 → 刷新续玩」这条最核心的链路。
 * 单机全程在本机跑，因此这里挂掉基本等于前端产物本身坏了。
 */

/** 首页填昵称 → 单机游玩 → 进到人数设置页。 */
async function enterLocalSetup(page: Page, nickname: string): Promise<void> {
  await page.goto('/');
  await page.getByPlaceholder('例如：小明').fill(nickname);
  await page.getByRole('button', { name: /单机游玩/ }).click();
  await expect(page.getByRole('heading', { name: '开始一局大富翁' })).toBeVisible();
}

/**
 * 默认单机会配两台电脑，而先手未必是真人——必须等电脑把各自的动画走完才轮到玩家。
 * 冒烟只关心真人这一环，所以改成「两个真人、零电脑」的热座局：进棋盘立刻就能操作，
 * 用例耗时和成败都不再取决于电脑的决策与动画节奏。
 */
async function useTwoHumanSeats(page: Page): Promise<void> {
  await page.getByLabel('真人玩家').selectOption('2');
  await page.getByLabel('电脑玩家').selectOption('0');
}

test.describe('单机游玩冒烟', () => {
  test('首页到开局：填昵称 → 单机游玩 → 开始游戏 → 掷骰子', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '进入大富翁' })).toBeVisible();

    // 昵称为空时建房不可点：按钮可用性就是「玩家能不能开局」的第一道闸。
    const createButton = page.getByRole('button', { name: '创建房间' });
    await expect(createButton).toBeDisabled();
    await page.getByPlaceholder('例如：小明').fill('马哥');
    await expect(createButton).toBeEnabled();

    await page.getByRole('button', { name: /单机游玩/ }).click();
    await expect(page.getByRole('heading', { name: '开始一局大富翁' })).toBeVisible();
    await useTwoHumanSeats(page);
    await page.getByRole('button', { name: '开始游戏' }).click();

    // 进棋盘时还没有人掷过骰子，骰子台必须停在「待命」——不掷骰就绝不显示点数。
    await expect(page.locator('.action-panel')).toBeVisible();
    await expect(page.locator('.roll-total small')).toHaveText('待命');

    const rollButton = page.getByRole('button', { name: '掷骰子' });
    await expect(rollButton).toBeVisible();
    await rollButton.click();

    // 掷完骰子：骰子台从「待命」变成步数，主操作也从「掷骰子」换成后续决策
    // （买地 / 放弃 / 结束回合，取决于落点）。这两条一起才算真的走完一步。
    await expect(page.locator('.roll-total small')).toHaveText('步');
    await expect(rollButton).toBeHidden();
    await expect(page.locator('.button-row button').first()).toBeVisible();
  });

  test('单机开局后刷新页面，首页提供「继续单机」入口', async ({ page }) => {
    await enterLocalSetup(page, '马哥');
    await useTwoHumanSeats(page);
    await page.getByRole('button', { name: '开始游戏' }).click();
    await expect(page.locator('.action-panel')).toBeVisible();

    await page.reload();

    // 存档写在 localStorage，刷新后应回到首页并把这局作为可续玩的存档列出来。
    await expect(page.getByRole('heading', { name: '继续单机' })).toBeVisible();
    await expect(page.getByRole('button', { name: '继续游戏' })).toBeVisible();
  });
});
