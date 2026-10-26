const { chromium } = require('playwright');

const URL = process.env.SHOT_URL || 'http://127.0.0.1:8099/';
const TAG = process.env.SHOT_TAG || 'a';

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
    if (msg.type() === 'error') errors.push(`[console.error] ${msg.text().slice(0, 160)}`);
  });
  page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message.slice(0, 240)}`));

  const shot = async (name) => {
    await page.screenshot({ path: `shot-${TAG}-${name}.png` });
    console.log(`[shot] shot-${TAG}-${name}.png`);
  };

  const clickIfAny = async (text, wait = 600) => {
    // 弹窗用 v-show 隐藏（与原 dialog 一致，DOM 常驻），所以必须过滤掉不可见的同名按钮。
    // 用非精确匹配：入口按钮里往往还有副标题（「单机模式 / 无需联网」），exact 会匹配不到。
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
  // 首次进入会自动弹玩法说明
  await clickIfAny('关闭', 600);

  await shot('01-home');

  // 首页 → 单机模式
  const entered = await clickIfAny('单机模式', 900);
  console.log(`[step] 进入单机设置页: ${entered}`);
  if (entered) await shot('02-setup');

  // 设置页 → 开局
  for (const label of ['开始新对局', '开始临时游戏', '确认替换并开始']) {
    if (await clickIfAny(label, 1500)) {
      console.log(`[step] 已点击「${label}」`);
      break;
    }
  }
  await shot('03-game');

  const probe = await page.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        display: cs.display,
        flexDirection: cs.flexDirection,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        left: Math.round(rect.left),
        top: Math.round(rect.top),
      };
    };
    return {
      homeShell: pick('.home-shell'),
      homeCard: pick('.home-card'),
      gameView: pick('.game-view'),
      gameShell: pick('.game-shell'),
      boardWrap: pick('.board-wrap'),
      gameView: pick('.game-view'),
      gameShell: pick('.game-shell'),
      boardWrap: pick('.board-wrap'),
      boardStage: pick('.board-stage'),
      boardCanvas: pick('.board-canvas'),
      firstCell: pick('.board-cell'),
      cellLabel: pick('.cell-label'),
      dock: pick('.mobile-dock-bar'),
    };
  });
  console.log('=== 布局探针 ===');
  console.log(JSON.stringify(probe, null, 2));

  const text = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 400));
  console.log('=== 可见文本 ===');
  console.log(text);

  console.log('=== 错误 ===');
  console.log(errors.length ? errors.slice(0, 6).join('\n') : '（无）');

  await browser.close();
})();
