const { chromium } = require('playwright');

const URL = process.env.SHOT_URL || 'http://127.0.0.1:8099/';
const OUT = process.env.SHOT_OUT || 'shot-home.png';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({
    viewport: { width: 412, height: 760 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });

  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1200);

  await page.screenshot({ path: OUT, fullPage: false });

  const text = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 600));
  console.log('=== 可见文本 ===');
  console.log(text);
  console.log('=== 错误 ===');
  console.log(errors.length ? errors.slice(0, 10).join('\n') : '（无）');

  await browser.close();
})();
