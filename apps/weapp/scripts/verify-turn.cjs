const { chromium } = require('playwright');

const URL = 'http://127.0.0.1:8099/';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({
    viewport: { width: 412, height: 760 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });

  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message.slice(0, 200)));

  const clickIfAny = async (text, wait = 600) => {
    const target = page.getByText(text).filter({ visible: true });
    if (await target.count()) {
      await target.first().click();
      await page.waitForTimeout(wait);
      return true;
    }
    return false;
  };

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(900);
  await clickIfAny('同意并继续', 800);
  await clickIfAny('关闭', 500);
  await clickIfAny('单机模式', 900);
  await clickIfAny('开始新对局', 1200);

  // 开局是 3 人（2 电脑 + 1 玩家）：等电脑走完，掷骰按钮才会出现。
  let rolled = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const dice = page.getByText('掷骰子').filter({ visible: true });
    if (await dice.count()) {
      await page.screenshot({ path: 'shot-b-01-my-turn.png' });
      console.log('[step] 轮到玩家，掷骰按钮可见');
      await dice.first().click({ force: true });
      await page.waitForTimeout(2200);
      await page.screenshot({ path: 'shot-b-02-after-roll.png' });
      rolled = true;
      break;
    }
    await page.waitForTimeout(1000);
  }

  console.log(`[result] 是否完成掷骰: ${rolled}`);
  const text = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 300));
  console.log('=== 当前界面文本 ===');
  console.log(text);
  console.log('=== 运行时错误 ===');
  console.log(errors.length ? errors.slice(0, 5).join('\n') : '（无）');

  await browser.close();
})();
