#!/usr/bin/env node
/**
 * 源站 → 小程序端的源码同步管线（幂等，可反复执行）。
 *
 * 为什么要这层：小程序不支持 HTML 标签，`<div>` / `<span>` / `<img>` 在 WXML 里
 * 不是合法组件；`cqw`、`:root`、`html/body` 也都不认。手工改一遍不可维护，
 * 所以这里做机械转换 + 定点补丁：
 *
 *   模板：div/section/p/ul/li/dialog… → view，span/small/strong/em → text，img → image
 *   样式：:root → page，html/body/#app → page，cqw → calc(var(--board-size) * X)
 *   补丁：见 scripts/patches.mjs（每条必须命中指定次数）
 *
 * 只处理 `<template>` 块与 `.css` 文件。`<script>` 一律原样保留 ——
 * 在脚本里按标签名替换会静默改坏字符串与正则（本项目踩过同类坑）。
 *
 * 源站文件一律只读，绝不回写。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATCHES } from './patches.mjs';

const HERE = import.meta.dirname;
const WEAPP = path.resolve(HERE, '..');
const ROOT = path.resolve(WEAPP, '../..');
const SRC = path.join(ROOT, 'apps/client/src');
const DEST = path.join(WEAPP, 'src/game');
const STYLES = path.join(WEAPP, 'src/styles');

/** 不移植的文件：测试、Web 专属入口、依赖浏览器 AudioContext / socket.io 的模块。 */
const EXCLUDE = [
  /\.test\.ts$/,
  /^main\.ts$/,
  /^pwaInstall\.ts$/,
  /^App\.vue$/,
  /^env\.d\.ts$/,
  /^vite-env\.d\.ts$/,
  /^audio\/(bgm|sfx)\.ts$/,
];

/** HTML 标签 → 小程序组件。dialog → view：小程序没有原生 dialog，改由 MobileSheet 自控显隐。 */
const TAG_MAP = {
  div: 'view',
  section: 'view',
  header: 'view',
  footer: 'view',
  main: 'view',
  nav: 'view',
  article: 'view',
  aside: 'view',
  figure: 'view',
  figcaption: 'view',
  ul: 'view',
  ol: 'view',
  li: 'view',
  dl: 'view',
  dt: 'view',
  dd: 'view',
  p: 'view',
  h1: 'view',
  h2: 'view',
  h3: 'view',
  h4: 'view',
  h5: 'view',
  h6: 'view',
  dialog: 'view',
  fieldset: 'view',
  details: 'view',
  /* 小程序没有这些语义元素 / 内联标记，统一降级为容器或文本。
     details/summary 的折叠交互会丢失（设置页/成就页用），但内容仍然可读。 */
  legend: 'text',
  summary: 'text',
  code: 'text',
  pre: 'text',
  output: 'text',
  time: 'text',
  a: 'text',
  /* Vue 内置组件在小程序没有对应实现：
     Teleport 原位渲染（MobileSheet 靠 fixed 定位，仍在最上层）；
     Transition 退化成普通容器，动画丢失但状态切换正常。 */
  Teleport: 'view',
  Transition: 'view',
  TransitionGroup: 'view',
  span: 'text',
  small: 'text',
  strong: 'text',
  em: 'text',
  b: 'text',
  i: 'text',
  /* label 必须转 view 而不是 text：源站 label 是**容器**，里面还装着 input/select。
     小程序 <text> 内不允许放可交互组件，转 text 会直接把表单拆坏。 */
  label: 'view',
  img: 'image',
};

const TAG_PATTERN = new RegExp(`<(/?)(${Object.keys(TAG_MAP).join('|')})(?=[\\s/>])`, 'g');

/** 只转换 template 块内部（用最后一个 </template> 兜住嵌套 template）。 */
function convertTemplateBlock(content) {
  const open = content.indexOf('<template>');
  if (open < 0) return { content, replaced: 0 };
  const close = content.lastIndexOf('</template>');
  if (close < open) return { content, replaced: 0 };

  const head = content.slice(0, open + '<template>'.length);
  const body = content.slice(open + '<template>'.length, close);
  const tail = content.slice(close);

  let replaced = 0;
  const converted = body.replace(TAG_PATTERN, (_m, slash, tag) => {
    replaced += 1;
    return `<${slash}${TAG_MAP[tag]}`;
  });
  return { content: head + converted + tail, replaced };
}

/**
 * 静态资源路径改写。
 *
 * 源站图片放在 apps/client/public/，引用形如 url('/home-bg.webp')。
 * 小程序只有 /static 下的文件能被打进包，必须改写成 /static/xxx。
 * 只改「确实存在于 src/static」的文件，其余原样保留（避免误伤外链）。
 */
const STATIC_DIR = path.join(WEAPP, 'src/static');
function rewriteStaticUrls(content) {
  return content.replace(/url\((['"]?)\/([A-Za-z0-9._-]+\.(?:webp|png|jpe?g|svg|gif))\1\)/g, (match, quote, name) => {
    if (!fs.existsSync(path.join(STATIC_DIR, name))) return match;
    return `url(/static/${name})`;
  });
}

/**
 * 内联 SVG 图标兜底。
 *
 * 小程序没有 SVG，`<svg>` 会被编译成不存在的自定义组件、静默渲染为空。
 * 小图标分两类处理：
 *   - 旁边已有文字标签（对局页工具栏、底部操作坞）→ 直接删掉，不影响识别；
 *   - 纯图标按钮（首页四个入口）→ 换成 emoji，否则按钮会变成一个看不见的空框。
 */
const SVG_RE = /<svg[\s\S]*?<\/svg>/g;
const SVG_ICON_GLYPHS = {
  'views/HomeView.vue': ['📊', '🏆', '☁️', '📋'],
  // 对局页工具栏/操作坞的 svg 旁边都有文字标签，直接删除不留空壳。
  'views/GameView.vue': [],
  // MapThumbnail 的 svg 处在 v-if / v-else 链上（`<svg v-if="model">` ↔ `<text v-else>`），
  // 整块删除会让 v-else 悬空、编译直接报错。保留原位：缩略图渲染为空，但地图名与选中态正常。
};

function replaceInlineSvg(rel, content) {
  if (!SVG_RE.test(content)) {
    SVG_RE.lastIndex = 0;
    return content;
  }
  SVG_RE.lastIndex = 0;

  const glyphs = SVG_ICON_GLYPHS[rel];
  if (glyphs === undefined) {
    // 未登记的文件不擅自处理：新的 svg 出现时应当在表里显式决策。
    return content;
  }

  let cursor = 0;
  return content.replace(SVG_RE, () => {
    const glyph = glyphs[cursor];
    cursor += 1;
    if (glyph === undefined) return '';
    return `<text class="icon-glyph">${glyph}</text>`;
  });
}

/**
 * 样式适配。
 * cqw：棋盘的 1cqw === 容器宽的 1%，而 --board-size 就是容器像素边长，
 *      因此 `N cqw` ⇔ `calc(var(--board-size) * N/100)`，数值完全等价。
 */
function adaptCss(css) {
  let out = css;

  out = out.replace(/^:root\s*\{/gm, 'page {');
  out = out.replace(/^html,\s*body,\s*#app\s*\{/gm, 'page {');
  out = out.replace(/^html\s*\{/gm, 'page {');
  out = out.replace(/^body\.game-view-active\s*\{/gm, 'page.game-view-active {');
  out = out.replace(/^body\s*\{\s*overflow-x:\s*hidden;\s*\}/gm, '');
  out = out.replace(/^#app\s*\{/gm, '.app-root {');

  // 小程序没有 select 组件，标签选择器既匹配不到也会让编译器报警。
  out = out.replace(/button,\s*input,\s*select,\s*textarea/g, 'button, input, textarea');
  // 下拉框已经换成 <picker>（外观容器是 .setup-picker），把针对 select 的规则指向新容器，
  // 既消掉编译警告，也让那几条外观规则继续生效。
  out = out.replace(/\.entry-body select/g, '.entry-body .setup-picker');
  // strong/em/span 在模板里已转成 <text>，纯标签选择器同样匹配不到（还会触发编译器警告）。
  // 只替换「紧跟 { 的裸标签名」，不碰 .class 里的同名片段。
  out = out.replace(/\b(div|section|header|footer|main|nav|article|aside|p|ul|ol|li|dl|dt|dd)\b(?=\s*\{)/g, 'view');
  out = out.replace(/\b(span|small|strong|em|b|i|label|code|pre|output|time|summary|legend)\b(?=\s*\{)/g, 'text');
  out = out.replace(/\bimg\b(?=\s*\{)/g, 'image');

  // cqw → calc()。保留 6 位小数足以对齐像素。
  out = out.replace(/(\d+(?:\.\d+)?)cqw/g, (_m, n) => {
    const ratio = (Number(n) / 100).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    return `calc(var(--board-size) * ${ratio})`;
  });

  return out;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const relOf = (base, file) => path.relative(base, file).replaceAll('\\', '/');

/* ---------------- 1. 清场 ---------------- */
fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });
fs.mkdirSync(STYLES, { recursive: true });

const stats = { copied: 0, converted: 0, tags: 0, css: 0, skipped: [], patched: 0 };

/* ---------------- 2. 复制 + 模板转换 ---------------- */
for (const file of walk(SRC)) {
  const rel = relOf(SRC, file);
  if (!/\.(vue|ts)$/.test(rel)) continue;
  if (EXCLUDE.some((re) => re.test(rel))) {
    stats.skipped.push(rel);
    continue;
  }

  const target = path.join(DEST, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const source = fs.readFileSync(file, 'utf8');
  if (rel.endsWith('.vue')) {
    const { content, replaced } = convertTemplateBlock(source);
    const withAssets = rewriteStaticUrls(content);
    const withIcons = replaceInlineSvg(rel, withAssets);
    fs.writeFileSync(target, withIcons, 'utf8');
    if (replaced > 0) {
      stats.converted += 1;
      stats.tags += replaced;
    }
  } else {
    fs.writeFileSync(target, source, 'utf8');
  }
  stats.copied += 1;
}

/* ---------------- 3. 入口 App.vue（单独处理：包一层单根） ---------------- */
{
  const source = fs.readFileSync(path.join(SRC, 'App.vue'), 'utf8');
  let { content } = convertTemplateBlock(source);

  // 小程序页面只允许一个根节点；源站 App.vue 是 v-if / v-else-if 兄弟链。
  // 包一层 .app-root（style.css 里 #app 的背景规则已改指向它）。
  const open = content.indexOf('<template>') + '<template>'.length;
  const close = content.lastIndexOf('</template>');
  content = `${content.slice(0, open)}\n  <view class="app-root">${content.slice(open, close)}  </view>\n${content.slice(close)}`;

  fs.writeFileSync(path.join(DEST, 'App.vue'), content, 'utf8');
  stats.copied += 1;
}

/* ---------------- 4. 定点补丁 ---------------- */
for (const rule of PATCHES) {
  const target = path.join(DEST, rule.file);
  if (!fs.existsSync(target)) {
    if (rule.optional) continue;
    throw new Error(`[patch] 目标文件不存在：${rule.file}`);
  }

  const before = fs.readFileSync(target, 'utf8');
  const hits = before.split(rule.from).length - 1;
  if (rule.optional && hits === 0) continue;
  if (hits !== 1) {
    throw new Error(
      `[patch] ${rule.file} 命中 ${hits} 次，期望 1 次。\n` +
      `源站可能已改动，补丁失效。待查找片段：\n${rule.from.slice(0, 200)}`,
    );
  }

  fs.writeFileSync(target, before.split(rule.from).join(rule.to), 'utf8');
  stats.patched += 1;
}

/* ---------------- 5. 打桩：小程序暂不支持的能力 ---------------- */
const STUBS = {
  'audio/bgm.ts': `/**
 * 小程序端 BGM 桩。
 *
 * 源站用 WebAudio（window.AudioContext）合成背景音乐；小程序没有 WebAudio，
 * 只有 uni.createInnerAudioContext（需要真实音频文件）。第一版先静音，
 * 但**保留开关的持久化语义**，避免设置页读到一个不存在的值而反复弹提示。
 */
const BGM_KEY = 'richman-bgm-enabled';
const BGM_VOLUME_KEY = 'richman-bgm-volume';

export const BGM_DEFAULT_VOLUME = 0.7;

export function isBgmEnabled(): boolean {
  return localStorage.getItem(BGM_KEY) !== '0';
}

export function getBgmVolume(): number {
  const raw = Number(localStorage.getItem(BGM_VOLUME_KEY));
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 1) : BGM_DEFAULT_VOLUME;
}

export function setBgmVolume(value: number): void {
  localStorage.setItem(BGM_VOLUME_KEY, String(Math.max(0, Math.min(value, 1))));
}

export function setBgmEnabled(value: boolean): void {
  localStorage.setItem(BGM_KEY, value ? '1' : '0');
}

export function startBgm(): void {}
export function stopBgm(): void {}
export function armBgmAutoStart(): void {}
`,

  'audio/sfx.ts': `/**
 * 小程序端音效桩。
 *
 * 源站用 WebAudio 振荡器合成音效；小程序端第一版不发声，
 * 但保留开关与音量的持久化接口，供设置页读写。
 */
const SFX_KEY = 'richman-sfx-enabled';
const SFX_VOLUME_KEY = 'richman-sfx-volume';

export type SfxName = 'dice' | 'pay' | 'coin' | 'bankrupt' | 'win' | 'lose';

export const SFX_DEFAULT_VOLUME = 0.7;

export function isSfxEnabled(): boolean {
  return localStorage.getItem(SFX_KEY) !== '0';
}

export function setSfxEnabled(value: boolean): void {
  localStorage.setItem(SFX_KEY, value ? '1' : '0');
}

export function getSfxVolume(): number {
  const raw = Number(localStorage.getItem(SFX_VOLUME_KEY));
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 1) : SFX_DEFAULT_VOLUME;
}

export function setSfxVolume(value: number): void {
  localStorage.setItem(SFX_VOLUME_KEY, String(Math.max(0, Math.min(value, 1))));
}

export function playSfx(_name: SfxName): void {}
`,

};

for (const [rel, body] of Object.entries(STUBS)) {
  const target = path.join(DEST, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, 'utf8');
}

/* PWA 安装入口在小程序里没有意义（小程序本身就是「装进微信」），渲染空节点即可。 */
fs.writeFileSync(
  path.join(DEST, 'components/PwaInstallRow.vue'),
  [
    '<template>',
    '  <!-- 小程序端不展示 PWA 安装入口 -->',
    '  <view v-if="false" />',
    '</template>',
    '',
    '<script setup lang="ts"></script>',
    '',
  ].join('\n'),
  'utf8',
);

/* ---------------- 6. 全局样式 ---------------- */
for (const name of ['style.css', 'ui/entryPage.css']) {
  const from = path.join(SRC, name);
  if (!fs.existsSync(from)) continue;
  const out = name === 'style.css' ? 'base.css' : 'entry.css';
  fs.writeFileSync(path.join(STYLES, out), adaptCss(fs.readFileSync(from, 'utf8')), 'utf8');
  stats.css += 1;
}

/* ---------------- 6. 移植版组件覆盖 ---------------- */
/**
 * 有些组件改不动（例如整块 SVG 渲染），差异太大，用补丁做会变成一堆碎替换。
 * 这类组件在 src/overrides 下维护一份完整移植版，同步最后覆盖同名文件。
 * 源站依旧只读；覆盖关系在这里显式登记，跑一次 sync 就能看出哪些组件分叉了。
 */
const OVERRIDES = path.join(WEAPP, 'src/overrides');
if (fs.existsSync(OVERRIDES)) {
  for (const file of walk(OVERRIDES)) {
    const rel = relOf(OVERRIDES, file);
    const target = path.join(DEST, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
    console.log(`[sync] 覆盖 ${rel}`);
  }
}

console.log(`[sync] 复制 ${stats.copied} 个文件 → ${relOf(ROOT, DEST)}`);
console.log(`[sync] 转换 ${stats.converted} 个 .vue，共替换 ${stats.tags} 个标签`);
console.log(`[sync] 应用 ${stats.patched} 条补丁，${Object.keys(STUBS).length} 个桩`);
console.log(`[sync] 适配 ${stats.css} 个全局样式 → ${relOf(ROOT, STYLES)}`);
