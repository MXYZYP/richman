/**
 * 小程序构建前门禁：扫描同步产物（src/game）里的「非法标签」。
 *
 * 为什么需要：小程序（mp-weixin 等）没有 HTML/SVG，`<svg>`/`line`/`polyline`/`path`/`rect`
 * 等会被编译成不存在的自定义组件、静默渲染为空。sync-sources.mjs 已把 div/span/img 等
 * 机械转成 view/text/image，但 SVG 是「故意不渲染」或「需在 overrides 里整体移植」的，
 * 不会自动转换。若源站某次改动新引入了 SVG 而没人处理，构建不会报错，只会悄悄丢一块 UI。
 *
 * 本脚本作为 `build:mp` 的前置门禁：发现非法标签直接 exit(1)，阻断构建。
 *
 * 判定规则：
 *   - OK 列表里的原生组件（view/text/image/picker/canvas…）→ 合法，忽略；
 *   - 首字母大写的标签（ChatPanel/MapThumbnail…）→ Vue 自定义组件，合法，忽略；
 *   - 含点的标签（Foo.Bar）→ 命名空间组件，合法，忽略；
 *   - 其余裸 HTML/SVG 标签 → 与「不支持标签」清单比对，命中即视为非法。
 *
 * 例外（白名单）：components/MapThumbnail.vue 的 SVG 是已知且接受的缺陷——
 * 该 `<svg v-if="model">` 与 `<text v-else>` 在同一 v-if/v-else 链上，整块删除会让
 * v-else 悬空、编译直接报错；保留原位则缩略图渲染为空，但地图名与选中态正常。
 * 仅此一处豁免，且含义明确，新增 SVG 不应再走这条豁免。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] || 'src/game';

const OK = new Set([
  'view', 'text', 'image', 'button', 'input', 'textarea', 'picker', 'picker-view',
  'picker-view-column', 'checkbox', 'checkbox-group', 'radio', 'radio-group', 'switch',
  'slider', 'swiper', 'swiper-item', 'scroll-view', 'navigator', 'block', 'template',
  'slot', 'form', 'label', 'rich-text', 'progress', 'icon', 'video', 'audio', 'canvas',
  'map', 'web-view', 'editor', 'movable-area', 'movable-view', 'cover-view', 'cover-image',
  'camera', 'open-data', 'ad', 'page-meta', 'navigation-bar', 'root-portal', 'match-media',
  'page-container', 'share-element',
]);

/** 小程序不支持、又未被 sync 自动转换的裸标签。命中即视为非法。 */
const DENY = new Set([
  'svg', 'line', 'polyline', 'path', 'rect', 'circle', 'ellipse', 'g', 'use', 'defs',
  'tspan', 'textpath', 'clippath', 'mask',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  'iframe', 'object', 'embed', 'math', 'mathml',
]);

/** 已知且接受的非法标签豁免（按 src/game 下的相对路径）。仅 MapThumbnail 一处。 */
const EXEMPT = {
  'components/MapThumbnail.vue': new Set(['svg', 'line', 'polyline', 'path', 'rect']),
};

const illegal = []; // { tag, file }
const componentTags = new Map(); // 仅用于信息性报告：PascalCase 组件名 -> 计数

if (!fs.existsSync(ROOT)) {
  console.error(`[scan-tags] 扫描根目录不存在：${ROOT}（请先运行 sync-sources.mjs）`);
  process.exit(1);
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!full.endsWith('.vue')) continue;

    const rel = path.relative(ROOT, full).replaceAll('\\', '/');
    const source = fs.readFileSync(full, 'utf8');
    const start = source.indexOf('<template>');
    const end = source.lastIndexOf('</template>');
    if (start < 0 || end < 0) continue;
    const body = source.slice(start, end);

    for (const m of body.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)/g)) {
      const tag = m[1];
      if (OK.has(tag) || tag.includes('.')) continue;
      if (/^[A-Z]/.test(tag)) {
        componentTags.set(tag, (componentTags.get(tag) ?? 0) + 1);
        continue;
      }
      if (!DENY.has(tag)) continue; // 其余裸标签若不在 DENY 里，暂且放过（可随清单扩充）
      const exempt = EXEMPT[rel];
      if (exempt && exempt.has(tag)) continue;
      illegal.push({ tag, file: rel });
    }
  }
}

walk(ROOT);

// ---- 报告 ----
if (componentTags.size > 0) {
  const rows = [...componentTags.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`[scan-tags] 自定义组件标签（合法）：${rows.length} 种，例如 ${
    rows.slice(0, 6).map(([t, n]) => `${t}×${n}`).join(', ')}`);
}
console.log(`[scan-tags] 扫描 ${ROOT} 完成，非法标签 ${illegal.length} 处`);

if (illegal.length > 0) {
  console.error('\n❌ 发现小程序不支持的裸标签（会被编译成空组件，静默丢 UI）：');
  for (const { tag, file } of illegal) {
    console.error(`   <${tag}>  →  ${file}`);
  }
  console.error('\n处理建议：');
  console.error('  1) 纯装饰 SVG（图标）→ 在 sync-sources.mjs 的 SVG_ICON_GLYPHS 登记为 emoji/text；');
  console.error('  2) 结构性 SVG（棋盘/缩略图）→ 在 src/overrides 下放整份移植版覆盖，或加补丁换成 view+CSS；');
  console.error('  3) 若确属已知接受的例外，按 MapThumbnail 的方式在 EXEMPT 中显式登记并写明原因。');
  process.exit(1);
}

console.log('[scan-tags] ✅ 未发现非法标签，门禁通过');
process.exit(0);
