<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import MobileSheet from './MobileSheet.vue';
import { REPLAY_CODE_PREFIX, inspectReplayCode, type ReplayPayload } from '../session/replayCode';
import type { ReplayExportOutcome } from '../session/gameSession';
import type { CreateLocalSessionOptions } from '../session/localSession';

/**
 * 复盘（#115）。
 *
 * 两个页签：
 *   导出 —— 把当前这局的「开局配方 + 有序意图」编成一段可复制的码。码在**生成时就已经自校验过**
 *          （见 localSession.buildReplayExport → exportReplay），所以这里只会显示「能重放」或
 *          明确的原因，不存在「导出了但跑不通」。
 *   导入 —— 粘贴一段码，本地重放一遍以证明它没坏，然后交给上层起一个**回看会话**。
 *
 * 码里装的是种子与意图，不含任何账号信息；但它会暴露双方的昵称与整局操作，分享前请自行判断。
 *
 * 注意 `exportOutcome` 只收「码 / 步数 / 原因」这个浅形状（见 gameSession.ts 的注释）：
 * 视图不需要知道载荷结构与失败码联合，那属于 replayCode 的实现细节。
 */

const props = defineProps<{
  open: boolean;
  /** 本局复盘导出结果；`null` = 连「为什么导不出来」都拿不到（非本地对局 / 联机）。 */
  exportOutcome: ReplayExportOutcome | null;
}>();

const emit = defineEmits<{
  'update:open': [open: boolean];
  /** 用一份已校验的复盘起回看会话（由上层负责换会话，本组件不碰会话生命周期）。 */
  play: [options: CreateLocalSessionOptions];
}>();

type Tab = 'export' | 'import';

/**
 * 打开时落在哪一页。
 *
 * 有 `exportOutcome` 就停在导出页 —— 包括「有码」与「有原因」两种：从存档恢复、回看会话
 * 这类情况下，玩家最该看到的就是**为什么导不出来**，默默切到导入页等于把答案藏起来。
 * 只有连能力都没有（联机）时才落到导入页：那种局面下确实没什么可说的。
 */
function initialTab(): Tab {
  return props.exportOutcome === null ? 'import' : 'export';
}

const tab = ref<Tab>(initialTab());

watch(() => props.open, (open) => {
  if (!open) return;
  tab.value = initialTab();
  copyNotice.value = null;
  importError.value = null;
  importReady.value = null;
});

const code = computed(() => props.exportOutcome?.code ?? '');
const exportMessage = computed(() => {
  const outcome = props.exportOutcome;
  if (outcome === null) return '';
  return outcome.code === null
    ? outcome.reason
    : `已自校验：整局 ${outcome.steps} 步都能重放。`;
});

const copyNotice = ref<string | null>(null);
let copyNoticeTimer: number | null = null;
function flashCopy(message: string): void {
  copyNotice.value = message;
  if (copyNoticeTimer !== null) window.clearTimeout(copyNoticeTimer);
  copyNoticeTimer = window.setTimeout(() => { copyNotice.value = null; }, 2400);
}

async function copyCode(): Promise<void> {
  if (code.value.length === 0) return;
  try {
    await navigator.clipboard.writeText(code.value);
    flashCopy('已复制到剪贴板');
  } catch {
    // 剪贴板权限被拒 / 非安全上下文：退化成「手动全选复制」，而不是静默失败。
    flashCopy('复制失败，请手动选中整段文本复制');
  }
}

/** 下载成 .json：码本身够长，聊天窗口容易截断，落成文件更稳。 */
function downloadCode(): void {
  if (code.value.length === 0) return;
  try {
    const blob = new Blob([code.value], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `richman-replay-${Date.now()}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch {
    flashCopy('下载失败，请改用复制');
  }
}

// ---- 导入 ----
const importInput = ref('');
const importError = ref<string | null>(null);
// shallowRef：整份 CreateLocalSessionOptions 里含引擎状态与地图包，深层的 ref 解包推导会
// 触发 TS 的「excessively deep instantiation」。这里只需要原样转交，不做深层响应式。
const importReady = shallowRef<{ payload: ReplayPayload; options: CreateLocalSessionOptions; steps: number } | null>(null);

const importSummary = computed(() => {
  const payload = importReady.value?.payload;
  if (payload === undefined || payload === null) return null;
  const players = payload.players.map((player) => player.nickname).join('、');
  return {
    mapId: payload.map.id,
    players,
    steps: importReady.value?.steps ?? payload.intents.length,
    turns: payload.summary?.turns ?? null,
    winner: payload.summary?.winnerId === null || payload.summary?.winnerId === undefined
      ? null
      : payload.players.find((player) => player.id === payload.summary?.winnerId)?.nickname ?? payload.summary.winnerId,
    exportedAt: payload.createdAt,
  };
});

function inspectImport(): void {
  importError.value = null;
  importReady.value = null;
  const outcome = inspectReplayCode(importInput.value);
  if (!outcome.ok) {
    importError.value = outcome.message;
    return;
  }
  importReady.value = { payload: outcome.payload, options: outcome.playback, steps: outcome.steps };
}

function startPlayback(): void {
  const ready = importReady.value;
  if (ready === null) return;
  emit('play', ready.options);
  emit('update:open', false);
}

const title = '复盘';
</script>

<template>
  <MobileSheet
    class="sheet-replay"
    layout="modal"
    :open="open"
    :title="title"
    @close="emit('update:open', false)"
  >
    <div class="replay-tabs" role="tablist" aria-label="复盘">
      <button
        type="button"
        class="replay-tab"
        role="tab"
        :class="{ active: tab === 'export' }"
        :aria-selected="tab === 'export'"
        @click="tab = 'export'"
      >导出本局</button>
      <button
        type="button"
        class="replay-tab"
        role="tab"
        :class="{ active: tab === 'import' }"
        :aria-selected="tab === 'import'"
        @click="tab = 'import'"
      >导入回看</button>
    </div>

    <section v-if="tab === 'export'" class="replay-panel" aria-label="导出本局复盘">
      <p class="replay-hint">
        复盘码记录的是这局的<strong>开局信息与每一步操作</strong>，别人粘进游戏就能原样看完整局。
        它不含账号数据，但会暴露双方的昵称与全部走法。
      </p>
      <template v-if="code.length > 0">
        <p class="replay-status ok">{{ exportMessage }}</p>
        <textarea class="replay-code" readonly :value="code" rows="6" aria-label="复盘码" />
        <div class="replay-actions">
          <button type="button" class="replay-button primary" @click="copyCode">复制码</button>
          <button type="button" class="replay-button" @click="downloadCode">下载为文件</button>
          <span v-if="copyNotice" class="replay-notice">{{ copyNotice }}</span>
        </div>
      </template>
      <p v-else class="replay-status error">{{ exportMessage || '这局还不能导出复盘。' }}</p>
    </section>

    <section v-else class="replay-panel" aria-label="导入复盘">
      <p class="replay-hint">
        粘贴别人给你的复盘码。本机会先把它整局重放一遍以确认没坏，
        通过后再进入回看（回看中不能操作棋子）。
      </p>
      <textarea
        v-model="importInput"
        class="replay-code"
        rows="6"
        :placeholder="`${REPLAY_CODE_PREFIX}.…`"
        aria-label="复盘码"
      />
      <div class="replay-actions">
        <button type="button" class="replay-button primary" :disabled="importInput.trim().length === 0" @click="inspectImport">
          校验这段码
        </button>
      </div>

      <p v-if="importError" class="replay-status error">{{ importError }}</p>

      <template v-if="importSummary">
        <p class="replay-status ok">校验通过：整局 {{ importSummary.steps }} 步都能重放。</p>
        <dl class="replay-summary">
          <div><dt>地图</dt><dd>{{ importSummary.mapId }}</dd></div>
          <div><dt>玩家</dt><dd>{{ importSummary.players }}</dd></div>
          <div v-if="importSummary.turns !== null"><dt>回合数</dt><dd>{{ importSummary.turns }}</dd></div>
          <div v-if="importSummary.winner"><dt>赢家</dt><dd>{{ importSummary.winner }}</dd></div>
        </dl>
        <div class="replay-actions">
          <button type="button" class="replay-button primary" @click="startPlayback">开始回看</button>
        </div>
      </template>
    </section>
  </MobileSheet>
</template>

<style scoped>
.replay-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}

.replay-tab {
  flex: 1;
  padding: 9px 12px;
  border: 1px solid var(--color-border, #b9c3ad);
  border-radius: 9px;
  background: transparent;
  font: inherit;
  color: inherit;
  cursor: pointer;
}

.replay-tab.active {
  border-color: var(--color-accent, #b98634);
  background: color-mix(in srgb, var(--color-accent, #b98634) 18%, transparent);
  font-weight: 600;
}

.replay-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.replay-hint {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  opacity: 0.78;
}

.replay-code {
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

.replay-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.replay-button {
  padding: 9px 16px;
  border: 1px solid var(--color-border, #b9c3ad);
  border-radius: 9px;
  background: transparent;
  font: inherit;
  color: inherit;
  cursor: pointer;
}

.replay-button.primary {
  border-color: transparent;
  background: var(--button-enabled-bg, #eec264);
  color: var(--button-enabled-text, #493616);
  font-weight: 600;
}

.replay-button:disabled {
  cursor: not-allowed;
  background: var(--button-disabled-bg, #e3e7d8);
  color: var(--button-disabled-text, #6a7460);
}

.replay-status {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
}

.replay-status.ok {
  color: var(--color-primary, #88551f);
}

.replay-status.error {
  color: var(--color-danger, #a33a26);
}

.replay-notice {
  font-size: 13px;
  opacity: 0.8;
}

.replay-summary {
  display: grid;
  gap: 6px;
  margin: 0;
}

.replay-summary div {
  display: flex;
  gap: 8px;
  font-size: 13px;
}

.replay-summary dt {
  min-width: 4.5em;
  opacity: 0.7;
}

.replay-summary dd {
  margin: 0;
}
</style>
