<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { PlayerColor, PlayerState } from '@richman/engine';
import type { AssetRow } from '../game/clientGame';
import { formatMoney } from '../ui/format';

const props = defineProps<{
  player: PlayerState;
  currentPlayerId: string;
  positionName: string;
  debtAmount: number | null;
  assets: AssetRow[];
}>();

const emit = defineEmits<{
  close: [];
}>();

const marks: Record<PlayerColor, string> = { red: '●', blue: '■', yellow: '▲', green: '★', purple: '◆', orange: '⬟' };
const dialog = ref<HTMLDialogElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
let previousBodyOverflow = '';
let closing = false;
let disposed = false;

onMounted(() => {
  previousBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  dialog.value?.showModal();
  closeButton.value?.focus();
});

onBeforeUnmount(() => {
  disposed = true;
  document.body.style.overflow = previousBodyOverflow;
  if (dialog.value?.open) dialog.value.close();
});

async function requestClose(): Promise<void> {
  if (closing) return;
  closing = true;
  dialog.value?.close();
  const animations = dialog.value?.getAnimations() ?? [];
  await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
  if (!disposed) emit('close');
}

function closeFromBackdrop(event: MouseEvent): void {
  if (event.target === dialog.value) void requestClose();
}
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="player-dialog-layer"
      :aria-labelledby="`player-dialog-${props.player.id}`"
      @cancel.prevent="requestClose"
      @click="closeFromBackdrop"
    >
      <section class="player-dialog">
        <header class="dialog-header">
          <div class="player-identity">
            <div class="dialog-avatar" :class="`avatar-${props.player.color}`">
              {{ marks[props.player.color] }}
            </div>
            <div class="identity-copy">
              <span class="eyebrow">玩家资产</span>
              <h2 :id="`player-dialog-${props.player.id}`">{{ props.player.nickname }}</h2>
              <div class="status-badges" aria-label="玩家状态">
                <span v-if="props.player.isBot">电脑</span>
                <span v-if="props.player.id === props.currentPlayerId">当前回合</span>
                <span v-if="!props.player.online">离线</span>
                <span v-if="props.player.bankrupt" class="danger">破产</span>
              </div>
            </div>
          </div>
          <button
            ref="closeButton"
            type="button"
            class="dialog-close"
            aria-label="关闭玩家资产"
            @click="requestClose"
          >
            ×
          </button>
        </header>

        <dl class="player-summary">
          <div class="summary-cell cash-summary">
            <dt>现金</dt>
            <dd class="cash-value">¥{{ formatMoney(props.player.cash) }}</dd>
          </div>
          <div class="summary-cell">
            <dt>当前位置</dt>
            <dd>{{ props.positionName }}</dd>
          </div>
          <div v-if="props.debtAmount !== null" class="summary-cell debt-summary">
            <dt>待偿欠款</dt>
            <dd>¥{{ formatMoney(props.debtAmount) }}</dd>
          </div>
        </dl>

        <section class="asset-section" aria-labelledby="player-property-title">
          <div class="asset-heading">
            <h3 id="player-property-title">房产详情</h3>
            <span>{{ props.assets.length }} 项</span>
          </div>
          <div class="asset-scroll">
            <p v-if="props.assets.length === 0" class="empty-assets">暂无房产</p>
            <ul v-else class="asset-grid">
              <li
                v-for="asset in props.assets"
                :key="asset.cellId"
                class="asset-card"
                :title="asset.name"
              >
                <strong>{{ asset.displayName }}</strong>
                <span class="asset-kind">
                  {{ asset.subtype === 'normal'
                    ? (asset.level === 5 ? '旅馆' : asset.level > 0 ? `${asset.level} 级房屋` : '裸地')
                    : asset.subtype === 'station' ? '车站' : '公用事业' }}
                </span>
                <span v-if="asset.mortgaged" class="mortgaged">已抵押</span>
              </li>
            </ul>
          </div>
        </section>
      </section>
    </dialog>
  </Teleport>
</template>

<style scoped>
.player-dialog-layer {
  width: min(720px, calc(100vw - 32px));
  max-width: none;
  max-height: none;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-text);
  overflow: visible;
}

.player-dialog-layer::backdrop {
  background: var(--overlay-scrim);
  backdrop-filter: blur(3px);
}

.player-dialog {
  --player-tile: var(--game-panel-raised);
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  width: 100%;
  max-height: calc(100dvh - 32px);
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: var(--game-panel);
  box-shadow: var(--game-shadow-dialog);
}

.dialog-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding: 16px 18px 13px;
  border-bottom: 1px solid var(--game-line-soft);
}

.player-identity {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 12px;
}

.dialog-avatar {
  display: grid;
  flex: 0 0 auto;
  width: 46px;
  height: 46px;
  place-items: center;
  border-radius: 999px;
  color: #fff;
  font-size: 20px;
  font-weight: 900;
  box-shadow: 0 2px 6px rgb(44 56 36 / 18%);
}

.avatar-red { background: var(--player-red); }
.avatar-blue { background: var(--player-blue); }
.avatar-yellow { background: var(--player-yellow); }
.avatar-green { background: var(--player-green); }
.avatar-purple { background: var(--player-purple); }
.avatar-orange { background: var(--player-orange); }

.identity-copy {
  min-width: 0;
}

.eyebrow {
  color: var(--color-muted);
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 0.12em;
}

.identity-copy h2 {
  margin: 2px 0 0;
  color: var(--color-text);
  font-size: clamp(1.25rem, 4vw, 1.55rem);
  font-weight: 900;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.status-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 7px;
}

.status-badges span {
  padding: 2px 7px;
  border-radius: 8px;
  background: var(--game-panel-quiet);
  color: var(--color-muted);
  font-size: 10px;
  font-weight: 900;
}

.status-badges span.danger {
  background: color-mix(in srgb, var(--color-pay) 10%, var(--player-tile));
  color: var(--color-pay);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-pay) 38%, transparent);
}

.dialog-close {
  display: grid;
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  padding: 0;
  place-items: center;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--player-tile);
  color: var(--color-primary);
  font: inherit;
  font-size: 24px;
  line-height: 1;
  cursor: pointer;
}

.dialog-close:hover {
  background: var(--game-panel-quiet);
}

.dialog-close:focus-visible {
  outline: 3px solid var(--game-focus);
  outline-offset: 2px;
}

.player-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px;
  margin: 0;
  padding: 12px 18px;
  border-bottom: 1px solid var(--game-line-soft);
}

.summary-cell {
  min-width: 0;
  padding: 9px 11px;
  border: 1px solid var(--game-line-soft);
  border-radius: 10px;
  background: var(--player-tile);
}

.player-summary dt {
  color: var(--color-muted);
  font-size: 11px;
  font-weight: 800;
}

.player-summary dd {
  margin: 3px 0 0;
  color: var(--color-text);
  font-weight: 900;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.cash-summary dd.cash-value {
  font-family: var(--game-mono);
  font-size: 1.2rem;
}

.player-summary .debt-summary {
  border-color: color-mix(in srgb, var(--color-pay) 34%, var(--color-border));
  background: color-mix(in srgb, var(--color-pay) 7%, var(--player-tile));
}

.player-summary .debt-summary dd {
  color: var(--color-pay);
  font-family: var(--game-mono);
}

.asset-section {
  display: grid;
  min-height: 0;
  grid-template-rows: auto minmax(0, 1fr);
  padding: 13px 18px 18px;
}

.asset-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 9px;
}

.asset-heading h3 {
  margin: 0;
  color: var(--color-text);
  font-size: 1rem;
  font-weight: 900;
}

.asset-heading span {
  color: var(--color-muted);
  font-size: 11px;
  font-weight: 800;
}

.asset-scroll {
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.asset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.asset-card {
  display: grid;
  min-width: 0;
  align-content: start;
  gap: 5px;
  padding: 11px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--player-tile);
}

.asset-card strong {
  color: var(--color-text);
  font-size: 13.5px;
  overflow-wrap: anywhere;
}

.asset-kind {
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 800;
}

.mortgaged {
  justify-self: start;
  padding: 2px 7px;
  border-radius: 8px;
  background: var(--button-disabled-bg);
  color: var(--button-disabled-text);
  font-size: 10px;
  font-weight: 900;
}

.empty-assets {
  display: grid;
  min-height: 120px;
  margin: 0;
  place-items: center;
  border: 1px dashed var(--color-border);
  border-radius: 12px;
  color: var(--color-muted);
  font-weight: 800;
}

@media (max-width: 767px) {
  .player-dialog-layer {
    width: 100%;
    margin: auto 0 0;
  }

  .player-dialog {
    max-height: 80dvh;
    border-right: 0;
    border-bottom: 0;
    border-left: 0;
    border-radius: 16px 16px 0 0;
    padding-bottom: env(safe-area-inset-bottom);
  }

  .dialog-header {
    padding: 13px 16px 11px;
  }

  .dialog-avatar {
    width: 40px;
    height: 40px;
    font-size: 17px;
  }

  .player-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    padding: 10px 16px;
  }

  .asset-section {
    padding: 11px 16px 14px;
  }

  .asset-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .asset-card {
    padding: 10px;
  }
}
</style>
