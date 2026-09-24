/**
 * 地图编辑器回归验证：`corepack pnpm verify:map-editor`
 *
 * 目的：证明 tools/map-editor.html 里内嵌的 contentHash 实现与 packages/board-data/src/hash.ts
 * 逐位一致 —— 判据是「把仓库真实的 silk-road 四件套灌进编辑器，导出后的 contentHash 必须
 * 等于 manifest.json 里那串既有值」。若算法有任何一位不同，这个断言就过不去。
 *
 * 编辑器为了做到「单文件、零构建、双击即用」，把 canonicalStringify + sha256 整段复制了一份，
 * 这就有了两份实现悄悄漂移的风险。改 hash.ts 之后务必跑一次本脚本。
 *
 * 同时顺带验证：真实地图在编辑器里零校验错误、导入→导出四份 JSON 与源文件结构一致、
 * 预览与格子表确实渲染出 60 格（证明 DOM 接线没断）、接入片段随 id 实时更新。
 *
 * 用系统 Chrome（`channel: 'chrome'`），不下载额外浏览器内核。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const mapDir = join(repoRoot, 'packages', 'board-data', 'maps', 'silk-road', 'v1');

const readJson = (name) => JSON.parse(readFileSync(join(mapDir, name), 'utf8'));

function deepEqual(a, b, path = '$') {
  if (a === b) return null;
  if (typeof a !== typeof b) return `${path}: 类型不同 ${typeof a} vs ${typeof b}`;
  if (a === null || b === null) return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${path}: 数组/非数组不一致`;
    if (a.length !== b.length) return `${path}: 长度 ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i += 1) {
      const diff = deepEqual(a[i], b[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.join(',') !== kb.join(',')) {
      return `${path}: 键集合不同 [${ka.join(',')}] vs [${kb.join(',')}]`;
    }
    for (const key of ka) {
      const diff = deepEqual(a[key], b[key], `${path}.${key}`);
      if (diff) return diff;
    }
    return null;
  }
  return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

// ---- 组装真实 MapPack（与 packages/board-data/src/silkRoadMap.ts 完全同构）----
const manifest = readJson('manifest.json');
const board = readJson('board.json');
const cards = readJson('cards.json');
const config = readJson('game-config.json');
const realPack = {
  ref: manifest.ref,
  metadata: manifest.metadata,
  game: { board, cards, config, requiredRuleModules: manifest.requiredRuleModules },
  presentation: manifest.presentation,
};
const EXPECTED_HASH = manifest.ref.contentHash;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();

const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});

const editorUrl = pathToFileURL(join(here, 'map-editor.html')).href;
await page.goto(editorUrl);

// 1) 页面脚本干净加载
check('页面无 JS 运行时错误', pageErrors.length === 0, pageErrors.join(' | '));
const hasApi = await page.evaluate(() => Boolean(window.MapEditor));
check('window.MapEditor 对外 API 存在', hasApi === true);

// 2) 灌入真实地图
await page.evaluate((pack) => { window.MapEditor.loadPack(pack); }, realPack);

// 3) contentHash 逐位一致（核心断言）
const hash = await page.evaluate(() => window.MapEditor.computeHash());
check('真实 silk-road 的 contentHash 与仓库逐位一致', hash === EXPECTED_HASH,
  hash === EXPECTED_HASH ? hash : `得到 ${hash} / 期望 ${EXPECTED_HASH}`);

// 4) 编辑器自身校验零错误
const issues = await page.evaluate(() => window.MapEditor.validate());
const issueErrors = issues.filter((issue) => issue.level === 'error');
check('真实地图在编辑器内 0 个校验错误', issueErrors.length === 0,
  issueErrors.map((i) => `${i.path}: ${i.message}`).join(' | '));

// 5) 导入 → 导出：四份 JSON 与源文件一致
const exported = await page.evaluate(() => window.MapEditor.exportFiles());
const pairs = [
  ['manifest.json', exported['manifest.json']],
  ['board.json', exported['board.json']],
  ['cards.json', exported['cards.json']],
  ['game-config.json', exported['game-config.json']],
];
const sources = { 'manifest.json': manifest, 'board.json': board, 'cards.json': cards, 'game-config.json': config };
for (const [name, value] of pairs) {
  const diff = deepEqual(value, sources[name]);
  check(`导出 ${name} 与源文件结构一致`, diff === null, diff ?? '');
}

// 6) 渲染接线：预览矩形数 / 格子表行数
// 预览图固定有 2 个背景矩形（棋盘底色 + 中心区），其余每格 1 个矩形、2 段文字（名称 + 序号）。
const renderInfo = await page.evaluate(() => ({
  rects: document.querySelectorAll('#preview svg rect').length,
  texts: document.querySelectorAll('#preview svg text').length,
  rows: document.querySelectorAll('#cell-rows tr').length,
}));
check('预览渲染 60 个格子矩形（+2 背景）', renderInfo.rects === 62, `实际 ${renderInfo.rects}`);
check('预览渲染 120 段格子文字（每格名称+序号）', renderInfo.texts === 120, `实际 ${renderInfo.texts}`);
check('格子表渲染出 60 行', renderInfo.rows === 60, `实际 ${renderInfo.rows}`);

// 7) 骨架流程：生成 → 校验 → 导出 → 哈希稳定
const skeleton = await page.evaluate(() => {
  const count = window.MapEditor.loadSkeleton(28, 'verify-map');
  const first = window.MapEditor.computeHash();
  const second = window.MapEditor.computeHash();
  const files = window.MapEditor.exportFiles();
  return {
    count,
    stable: first === second,
    hashLength: first.length,
    cellCount: files['board.json'].cells.length,
    hasNextId: 'nextId' in files['board.json'].cells[files['board.json'].cells.length - 1],
    bundleKeys: Object.keys(files).sort().join(','),
    errors: window.MapEditor.validate().filter((i) => i.level === 'error').length,
    snippet: document.getElementById('integration-out').textContent,
  };
});
check('骨架生成 28 格', skeleton.count === 28, `实际 ${skeleton.count}`);
check('骨架校验 0 错误', skeleton.errors === 0, `错误数 ${skeleton.errors}`);
check('骨架末格带 nextId', skeleton.hasNextId === true);
check('哈希计算稳定且为 64 位十六进制', skeleton.stable && skeleton.hashLength === 64,
  `stable=${skeleton.stable} len=${skeleton.hashLength}`);
// bundle.json 的键必须恰好是这四份 —— apply-map-pack 就按这四个文件名去取内容。
check('bundle 键恰好为四份 JSON', skeleton.bundleKeys === 'board.json,cards.json,game-config.json,manifest.json',
  `实际 ${skeleton.bundleKeys}`);

// 7b) 「接入仓库」片段随 id / version 实时更新
const snippet = await page.evaluate(() => document.getElementById('integration-out').textContent);
check('接入片段包含地图目录路径', snippet.includes('packages/board-data/maps/verify-map/v1/manifest.json'));
check('接入片段包含驼峰模块名 verifyMapMap', snippet.includes('verifyMapMap'));
check('接入片段包含部署清单四项', snippet.includes('"packages/board-data/maps/verify-map/v1/game-config.json",'));
// 一键落地是本轮新增的入口：片段必须以 apply-map-pack 命令打头，否则编辑器又退回纯手工流程。
check('接入片段指向一键落地命令', snippet.includes('node_modules/tsx/dist/cli.mjs tools/apply-map-pack.ts bundle.json'));
check('接入片段提示 index.ts 入口导出', snippet.includes("export { verifyMapMap } from './verifyMapMap';"));
// bundle 导出按钮必须存在：它把 exportFiles() 的四份内容打成一个文件，喂给 apply-map-pack。
const hasBundleButton = await page.evaluate(() => document.getElementById('btn-export-bundle') !== null);
check('存在「导出 bundle.json」按钮', hasBundleButton === true);

// 8) 结构示例地图（内置示例）也能通过校验
const sample = await page.evaluate(() => {
  const files = window.MapEditor.exportFiles();
  return { errors: window.MapEditor.validate().filter((i) => i.level === 'error').length };
});
check('内置结构示例通过校验', sample.errors === 0, `错误数 ${sample.errors}`);

check('页面无 console.error', consoleErrors.length === 0, consoleErrors.join(' | '));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length) {
  console.log('未通过项：');
  for (const f of failed) console.log(` - ${f.name}: ${f.detail}`);
  process.exitCode = 1;
}
