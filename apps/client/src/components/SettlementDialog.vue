<script setup lang="ts">
/**
 * 结算弹窗。
 *
 * 11-17 统一版：与「我的资产 / 玩家资产 / 格子详情」同一套长相 —— 520px 宽、
 * `--radius-dialog` 圆角、标题居中 + 右侧「关闭」、正文按 13/12/11 三档字号、
 * 排名块 10px 圆角。改造前它自带一个 56px 的「胜利旗」头图、标题 clamp(1.4rem,5vw,1.7rem)、
 * 圆角 14px、没有任何关闭控件，遮罩也不带模糊 —— 同一局里它和另外三个浮层一眼就不是一套。
 *
 * 为什么这里仍是 `<div>` 遮罩 + `<section>`，而不是像另外三个那样换成 `MobileSheet`：
 * 这层遮罩必须**压在离开房间的二次确认之下**（`GameView` 的 `.confirm-backdrop` 是普通
 * 定位层，z-index 高于本层）。一旦本弹窗进 native dialog 的 top layer，普通定位层的确认框
 * 就会被压在它后面 —— 玩家点「离开房间」看起来毫无反应。这条层级契约由
 * `game/settlementExitWiring.test.ts` 守着，所以外壳保持不动，只把**壳里的东西**统一。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { RenderableGameState } from '../session/gameSession';
import { getSettlementSummary } from '../game/settlement';
import { buildBattleReport } from '../game/battleReport';
import { formatCash } from '../ui/format';
import { getActiveMapPack } from '@richman/board-data';

const props = withDefaults(defineProps<{
  state: RenderableGameState;
  primaryLabel?: string;
  /** 是否给「关闭（回棋盘看一眼）」这条路。false 时整颗按钮都不渲染。 */
  canInspectBoard?: boolean;
}>(), {
  primaryLabel: '返回首页',
  canInspectBoard: true,
});

const emit = defineEmits<{
  restart: [];
  close: [];
}>();

const summary = computed(() => getSettlementSummary(props.state));
const primaryAction = ref<HTMLButtonElement | null>(null);

function formatPropertySummary(propertyNames: string[]): string {
  if (propertyNames.length === 0) return '无地产';
  const visibleNames = propertyNames.slice(0, 6).join('、');
  return propertyNames.length > 6 ? `${visibleNames} 等 ${propertyNames.length} 处` : visibleNames;
}

function handleKeydown(event: KeyboardEvent) {
  // Escape may only dismiss when there is something to fall back to; otherwise the
  // dialog would close onto a board-less screen with no way out.
  if (event.key === 'Escape' && props.canInspectBoard) emit('close');
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
  void nextTick(() => primaryAction.value?.focus());
});
/**
 * 一局战报：结算表是给自己看的，战报是给聊天窗口看的。
 * 复盘码（ReplayDialog 里那段）动辄几千字符、一粘就截断，所以这里只给结论：
 * 谁赢了、打到第几回合、各家终局资产。要复盘再去设置里导出复盘码。
 */
const mapTitle = computed(() => {
  try {
    return getActiveMapPack(props.state.mapRef.id).metadata.title;
  } catch {
    // 工坊自定义图不在「已发布地图」里：拿不到标题就用一句中性的话，不要猜。
    return '自定义地图';
  }
});

const battleReport = computed(() => buildBattleReport({
  mapTitle: mapTitle.value,
  players: summary.value.rows.map((row) => ({
    name: row.name,
    cash: row.cash,
    isWinner: row.isWinner,
    isBankrupt: row.isBankrupt,
    isBot: row.isBot,
    survivedTurns: row.survivedTurns,
    propertyCount: row.propertyCount,
  })),
  reason: summary.value.reason,
  formatAsset: formatCash,
}));

const reportNotice = ref<string | null>(null);
let reportTimer: number | null = null;

function flashReport(message: string): void {
  reportNotice.value = message;
  if (reportTimer !== null) window.clearTimeout(reportTimer);
  reportTimer = window.setTimeout(() => { reportNotice.value = null; }, 2400);
}

async function copyBattleReport(): Promise<void> {
  try {
    await navigator.clipboard.writeText(battleReport.value);
    flashReport('战报已复制，可直接粘贴到聊天窗口');
  } catch {
    // 剪贴板权限被拒 / 非安全上下文：退化成提示手动复制，而不是静默失败。
    flashReport('复制失败，请长按选中战报文本手动复制');
  }
}

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown);
  if (reportTimer !== null) window.clearTimeout(reportTimer);
});
</script>

<template>
  <div class="settlement-backdrop" role="presentation">
    <section class="settlement-dialog" role="dialog" aria-modal="true" aria-labelledby="settlement-title">
      <!-- 头部与 MobileSheet 的 `.mobile-sheet-head` 同构：三列等分栅格，标题恒在水平中轴，
           关闭贴右上。左右两格等宽，标题不会因为右边多了一颗按钮而整体左偏。 -->
      <header class="settlement-head">
        <h2 id="settlement-title">{{ summary.title }}</h2>
        <button
          v-if="props.canInspectBoard"
          type="button"
          class="settlement-close"
          aria-label="关闭结算，查看棋盘"
          @click="emit('close')"
        >关闭</button>
      </header>

      <!-- 正文区自己滚：弹窗这一层 overflow:hidden 把滚动条裁进圆角，
           否则内容一长，右边又会出现那条盖掉圆角的直角滚动条。 -->
      <div class="settlement-body">
        <p class="settlement-reason">{{ summary.reason }}</p>

        <h3 class="section-title">结算排名</h3>
        <ol class="settlement-list" aria-label="结算排名">
          <li
            v-for="row in summary.rows"
            :key="row.id"
            class="settlement-row"
            :class="{ winner: row.isWinner, bankrupt: row.isBankrupt }"
          >
            <span class="rank">{{ row.rank }}</span>
            <div class="row-main">
              <span class="name">
                {{ row.name }}
                <em v-if="row.isBot">电脑</em>
                <span v-if="row.isWinner" class="winner-tag">冠军</span>
              </span>
              <small>存活 {{ row.survivedTurns }} 回合 · 地产：{{ formatPropertySummary(row.propertyNames) }}</small>
            </div>
            <span class="row-money">
              <small>现金</small>
              <strong>{{ formatCash(row.cash) }}</strong>
              <em v-if="row.isBankrupt">{{ row.status }}</em>
            </span>
          </li>
        </ol>

        <div class="settlement-actions">
          <button type="button" @click="copyBattleReport">复制战报</button>
          <button ref="primaryAction" type="button" class="primary" @click="emit('restart')">{{ props.primaryLabel }}</button>
        </div>
        <p v-if="reportNotice" class="settlement-report-notice" role="status">{{ reportNotice }}</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settlement-backdrop {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: grid;
  place-items: center;
  padding: 16px;
  background: var(--overlay-scrim);
}

/* 尺寸、圆角、边框、落影与 MobileSheet 的 modal 变体逐项对齐 —— 四个浮层共用一套规格。 */
.settlement-dialog {
  --settle-tile: var(--game-panel-raised);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  width: min(520px, 100%);
  max-height: calc(100dvh - 32px);
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-dialog);
  background: var(--game-panel);
  box-shadow: var(--game-shadow-dialog);
}

.settlement-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--game-line-soft);
}

.settlement-head h2 {
  grid-column: 2;
  margin: 0;
  color: var(--title-color);
  font-size: var(--text-sheet-title);
  font-weight: 800;
  text-align: center;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

/* 关闭控件与 MobileSheet 的同款同形：44px 高、描边胶囊、灰字。 */
.settlement-close {
  grid-column: 3;
  justify-self: end;
  min-height: 44px;
  padding: 0 14px;
  border: 1px solid var(--color-border);
  border-radius: 9px;
  background: transparent;
  color: var(--color-muted);
  font-size: var(--text-meta-size);
  font-weight: 700;
  cursor: pointer;
}

.settlement-close:hover {
  color: var(--color-text);
}

.settlement-close:focus-visible {
  outline: 3px solid var(--game-focus);
  outline-offset: 2px;
}

.settlement-body {
  display: grid;
  align-content: start;
  gap: 8px;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 12px 14px max(14px, env(safe-area-inset-bottom));
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--color-muted) 40%, transparent) transparent;
}

.settlement-body::-webkit-scrollbar {
  width: 8px;
}

.settlement-body::-webkit-scrollbar-track {
  background: transparent;
}

.settlement-body::-webkit-scrollbar-thumb {
  border-radius: var(--radius-chip);
  background: color-mix(in srgb, var(--color-muted) 40%, transparent);
}

.settlement-reason {
  margin: 0;
  color: var(--color-muted);
  font-size: var(--text-body-size);
  line-height: 1.55;
  text-align: center;
}

/* 分组小标题：与格子详情的「完整租金表」、玩家资产的「地产明细」同档。 */
.section-title {
  margin: 4px 0 0;
  color: var(--color-text);
  font-size: var(--text-section-size);
  font-weight: 800;
}

.settlement-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.settlement-row {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) auto;
  gap: 9px;
  align-items: center;
  padding: 9px 10px;
  border: 1px solid var(--game-line-soft);
  border-radius: 10px;
  background: var(--settle-tile);
  text-align: left;
}

.settlement-row.winner {
  border-color: color-mix(in srgb, var(--color-accent) 60%, var(--color-border));
  background: color-mix(in srgb, var(--color-accent) 14%, var(--settle-tile));
}

.settlement-row.bankrupt {
  opacity: 0.7;
}

.rank {
  display: grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border-radius: 8px;
  background: var(--game-panel-sunken);
  color: var(--color-muted);
  font-size: var(--text-body-size);
  font-weight: 900;
}

.settlement-row.winner .rank {
  background: var(--color-primary);
  color: #fff;
}

.row-main {
  min-width: 0;
}

.name {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-width: 0;
  color: var(--color-text);
  font-size: var(--text-body-size);
  font-weight: 800;
  overflow-wrap: anywhere;
}

.name em {
  padding: 1px 5px;
  border-radius: 7px;
  background: var(--game-panel-sunken);
  color: var(--color-muted);
  font-size: var(--text-badge-size);
  font-style: normal;
  font-weight: 900;
}

.winner-tag {
  padding: 1px 6px;
  border-radius: 7px;
  background: var(--color-primary);
  color: #fff;
  font-size: var(--text-badge-size);
  font-weight: 900;
}

.row-main small {
  display: block;
  margin-top: 3px;
  color: var(--color-muted);
  font-size: var(--text-meta-size);
  font-weight: 700;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.row-money {
  display: grid;
  justify-items: end;
  gap: 1px;
  min-width: 0;
}

.row-money small {
  color: var(--color-muted);
  font-size: var(--text-badge-size);
  font-weight: 800;
}

.row-money strong {
  color: var(--color-text);
  font-family: var(--game-mono);
  font-size: var(--text-section-size);
  font-weight: 900;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.row-money em {
  color: var(--color-pay);
  font-size: var(--text-badge-size);
  font-style: normal;
  font-weight: 900;
}

.settlement-report-notice {
  margin: 8px 0 0;
  color: var(--color-muted);
  font-size: var(--text-meta-size);
  text-align: right;
}

.settlement-actions {
  display: flex;
  justify-content: center;
  gap: 10px;
  margin-top: 6px;
}

.settlement-actions button {
  min-height: var(--control-height-md);
  padding: 10px 18px;
  border-radius: var(--game-radius-control);
  font-size: 1rem;
  font-weight: 900;
  cursor: pointer;
}

.settlement-actions button:focus-visible {
  outline: 3px solid var(--game-focus);
  outline-offset: 2px;
}

.settlement-actions .primary {
  border: 1px solid #bc9037;
  background: var(--game-action-bg);
  color: var(--game-action-text);
  box-shadow: 0 4px 0 var(--game-action-shadow);
}

@media (max-width: 1024px) {
  .settlement-backdrop {
    padding: 12px;
  }

  .settlement-dialog {
    max-height: calc(100dvh - 24px);
  }

  .settlement-actions button {
    width: 100%;
  }
}
</style>
