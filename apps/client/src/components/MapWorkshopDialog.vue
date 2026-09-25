<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import MobileSheet from './MobileSheet.vue';
import { CUSTOM_MAP_MAX_ENTRIES, type CustomMapSummary } from '../session/customMaps';

/**
 * 地图工坊（#117）。
 *
 * 职责边界：本组件只负责「粘贴 / 列表 / 复制下载」这些界面动作，**不碰存储**。
 * 解析与落盘都由上层（App → customMaps.ts）完成，结果通过 `notice` 回灌。
 * 这样做的原因很实在：导入是否成功要同时决定「列表内容」和「提示文案」，
 * 两处各存一份状态必然会不一致；让上层做唯一的事实来源，这里只负责显示。
 *
 * 必须说清的一件事：**工坊装的地图只能单机玩**。联机房间用的是服务端的生产地图表，
 * 客户端多装一张图，服务端一无所知，建房会被直接拒。这条话要写在最显眼处，
 * 而不是等玩家点了「创建房间」才用一句报错告诉他。
 */

const props = withDefaults(defineProps<{
  open: boolean;
  /** 本机已装的自定义地图。 */
  maps?: readonly CustomMapSummary[];
  /** 上一次导入 / 删除的结果；`detail` 是校验器给出的字段级定位信息。 */
  notice?: { kind: 'ok' | 'error'; message: string; detail?: string | null } | null;
  busy?: boolean;
  /** 浏览器存储不可用（隐私模式等）：导入了也存不住，提前说明。 */
  storageAvailable?: boolean;
  /** 取某张地图的导出文本；返回 null 表示导不出来。 */
  bundleFor?: (mapId: string) => string | null;
}>(), {
  maps: () => [],
  notice: null,
  busy: false,
  storageAvailable: true,
  bundleFor: () => () => null,
});

const emit = defineEmits<{
  'update:open': [open: boolean];
  /** 把一段文本交给上层解析并保存。 */
  import: [text: string];
  remove: [mapId: string];
  /** 用这张自定义地图开一局单机。 */
  play: [mapId: string];
}>();

const draft = ref('');
const copyNotice = ref<string | null>(null);
let copyNoticeTimer: number | null = null;

const canImport = computed(() => !props.busy && draft.value.trim().length > 0);
const full = computed(() => props.maps.length >= CUSTOM_MAP_MAX_ENTRIES);

watch(() => props.open, (open) => {
  if (!open) return;
  draft.value = '';
  copyNotice.value = null;
});

function submitImport(): void {
  if (!canImport.value) return;
  emit('import', draft.value);
}

// 导入成功后清空输入框：留着原文只会让人以为没生效，再点一次又变成「重复导入同一张图」。
watch(() => props.notice, (notice) => {
  if (notice?.kind === 'ok') draft.value = '';
});

function flashCopy(message: string): void {
  copyNotice.value = message;
  if (copyNoticeTimer !== null) window.clearTimeout(copyNoticeTimer);
  copyNoticeTimer = window.setTimeout(() => { copyNotice.value = null; }, 2400);
}

async function copyBundle(mapId: string): Promise<void> {
  const text = props.bundleFor(mapId);
  if (text === null) {
    flashCopy('这张地图暂时导不出来');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    flashCopy('已复制到剪贴板');
  } catch {
    // 剪贴板权限被拒 / 非安全上下文：退化成「下载文件」，而不是静默失败。
    flashCopy('复制失败，可改用「下载」');
  }
}

function downloadBundle(mapId: string): void {
  const text = props.bundleFor(mapId);
  if (text === null) {
    flashCopy('这张地图暂时导不出来');
    return;
  }
  try {
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${mapId}-bundle.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch {
    flashCopy('下载失败，请改用复制');
  }
}

function formatImportedAt(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString('zh-CN', { hour12: false });
}

const title = '地图工坊';
</script>

<template>
  <MobileSheet
    class="sheet-workshop"
    layout="modal"
    :open="open"
    :title="title"
    @close="emit('update:open', false)"
  >
    <section class="workshop-panel" aria-label="地图工坊">
      <p class="workshop-scope" role="note">
        <strong>工坊里的地图只能单机游玩。</strong>
        联机房间仍只用内置的那十一张图——服务端不认识你自己装的图，建房会被拒。
        想和朋友玩自定义地图，只能由主机先按仓库里的说明把它正式接入。
      </p>
      <p class="workshop-hint">
        用 <code>tools/map-editor.html</code> 做好地图后点「导出 bundle.json」，
        把整份 JSON 粘到下面。自定义地图只能用内置图标（不能引用包内图片）。
        导入前会先过一遍和正式地图完全相同的校验，不合格会指出具体字段。
        <template v-if="storageAvailable">地图只存在这台设备的浏览器里，不上传、不同步。</template>
        <template v-else>当前浏览器无法保存本地数据，导入后刷新就会丢。</template>
      </p>

      <label class="workshop-field">
        <span>粘贴地图 JSON</span>
        <textarea
          v-model="draft"
          class="workshop-input"
          rows="5"
          :placeholder="'{ &quot;manifest.json&quot;: { … }, &quot;board.json&quot;: { … }, … }'"
          :disabled="busy"
          aria-label="粘贴地图 JSON"
        />
      </label>
      <div class="workshop-actions">
        <button type="button" class="workshop-button primary" :disabled="!canImport" @click="submitImport">
          导入地图
        </button>
        <button
          type="button"
          class="workshop-button"
          :disabled="busy || draft.trim().length === 0"
          @click="draft = ''"
        >清空</button>
        <span class="workshop-count">{{ maps.length }} / {{ CUSTOM_MAP_MAX_ENTRIES }}</span>
      </div>

      <p v-if="notice" class="workshop-notice" :class="notice.kind" role="status">
        {{ notice.message }}
      </p>
      <pre v-if="notice?.kind === 'error' && notice.detail" class="workshop-detail">{{ notice.detail }}</pre>
      <p v-if="full" class="workshop-notice error" role="status">
        已装满 {{ CUSTOM_MAP_MAX_ENTRIES }} 张，导入前请先删掉一张。
      </p>

      <h3 class="workshop-subtitle">已装地图</h3>
      <p v-if="maps.length === 0" class="workshop-empty">还没有装过自定义地图。</p>
      <ul v-else class="workshop-list">
        <li v-for="map in maps" :key="map.ref.id" class="workshop-row">
          <div class="workshop-row-head">
            <strong>{{ map.title }}</strong>
            <span class="workshop-id">{{ map.ref.id }}@{{ map.ref.version }}</span>
          </div>
          <p class="workshop-row-desc">{{ map.description }}</p>
          <p class="workshop-row-meta">导入于 {{ formatImportedAt(map.importedAt) }}</p>
          <div class="workshop-actions">
            <button type="button" class="workshop-button primary" :disabled="busy" @click="emit('play', map.ref.id)">
              单机试玩
            </button>
            <button type="button" class="workshop-button" @click="copyBundle(map.ref.id)">复制 JSON</button>
            <button type="button" class="workshop-button" @click="downloadBundle(map.ref.id)">下载</button>
            <button type="button" class="workshop-button danger" :disabled="busy" @click="emit('remove', map.ref.id)">
              删除
            </button>
          </div>
        </li>
      </ul>
      <p v-if="copyNotice" class="workshop-notice" role="status">{{ copyNotice }}</p>
    </section>
  </MobileSheet>
</template>

<style scoped>
.workshop-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.workshop-scope {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--color-border, #b9c3ad);
  border-left: 4px solid var(--color-accent, #b98634);
  border-radius: 9px;
  background: var(--event-bg, rgb(185 134 52 / 10%));
  font-size: 13px;
  line-height: 1.6;
}

.workshop-hint {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  opacity: 0.78;
}

.workshop-hint code {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--color-cell, #fafbf5);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.workshop-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}

.workshop-input {
  width: 100%;
  padding: 10px;
  border: 1px solid var(--color-border, #b9c3ad);
  border-radius: 9px;
  background: var(--color-cell, #fafbf5);
  color: inherit;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
  word-break: break-all;
}

.workshop-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.workshop-button {
  padding: 8px 14px;
  border: 1px solid var(--color-border, #b9c3ad);
  border-radius: 9px;
  background: transparent;
  font: inherit;
  color: inherit;
  cursor: pointer;
}

.workshop-button.primary {
  border-color: transparent;
  background: var(--button-enabled-bg, #eec264);
  color: var(--button-enabled-text, #493616);
  font-weight: 600;
}

.workshop-button.danger {
  color: var(--color-danger, #a33a26);
}

.workshop-button:disabled {
  cursor: not-allowed;
  background: var(--button-disabled-bg, #e3e7d8);
  color: var(--button-disabled-text, #6a7460);
}

.workshop-count {
  margin-left: auto;
  font-size: 12px;
  opacity: 0.7;
}

.workshop-notice {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
}

.workshop-notice.ok {
  color: var(--color-primary, #88551f);
}

.workshop-notice.error {
  color: var(--color-danger, #a33a26);
}

.workshop-detail {
  margin: 0;
  padding: 8px 10px;
  max-height: 9em;
  overflow: auto;
  border-radius: 8px;
  background: var(--color-cell, #fafbf5);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}

.workshop-subtitle {
  margin: 4px 0 0;
  font-size: 14px;
}

.workshop-empty {
  margin: 0;
  font-size: 13px;
  opacity: 0.7;
}

.workshop-list {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.workshop-row {
  display: grid;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--color-border, #b9c3ad);
  border-radius: 10px;
}

.workshop-row-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.workshop-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  opacity: 0.7;
}

.workshop-row-desc,
.workshop-row-meta {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  opacity: 0.8;
}
</style>
