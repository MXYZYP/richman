<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { CellDetail } from '../game/clientGame';
import { formatMoney } from '../ui/format';

const props = defineProps<{
  detail: CellDetail;
}>();

const emit = defineEmits<{
  close: [];
}>();

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
      class="cell-dialog-layer"
      aria-labelledby="cell-dialog-title"
      @cancel.prevent="requestClose"
      @click="closeFromBackdrop"
    >
      <section class="cell-dialog">
        <header class="dialog-header">
          <div class="cell-heading">
            <span class="eyebrow">格子详情</span>
            <div class="title-row">
              <h2 id="cell-dialog-title">{{ props.detail.name }}</h2>
              <span class="type-chip">{{ props.detail.typeLabel }}</span>
            </div>
          </div>
          <button
            ref="closeButton"
            type="button"
            class="dialog-close"
            aria-label="关闭格子详情"
            @click="requestClose"
          >×</button>
        </header>

        <div class="cell-body">
          <div v-if="props.detail.currentRent" class="current-rent" aria-label="当前过路费">
            <span class="rent-label">当前过路费</span>
            <strong v-if="props.detail.currentRent.amount !== null" class="rent-amount">
              ¥{{ formatMoney(props.detail.currentRent.amount) }}
            </strong>
            <strong v-else class="rent-amount pending">待本次掷骰</strong>
            <small class="rent-note">{{ props.detail.currentRent.note }}</small>
          </div>

          <div v-if="props.detail.rentRows.length > 0" class="rent-section">
            <h3>完整租金表</h3>
            <dl class="rent-list">
              <div v-for="row in props.detail.rentRows" :key="row.label">
                <dt>{{ row.label }}</dt>
                <dd>¥{{ formatMoney(row.amount) }}</dd>
              </div>
            </dl>
          </div>

          <p class="description">{{ props.detail.description }}</p>

          <dl class="facts">
            <div v-if="props.detail.price !== null">
              <dt>价格</dt>
              <dd>¥{{ formatMoney(props.detail.price) }}</dd>
            </div>
            <div v-if="props.detail.ownerName !== null">
              <dt>拥有者</dt>
              <dd>{{ props.detail.ownerName }}</dd>
            </div>
            <div v-if="props.detail.levelLabel !== null">
              <dt>状态</dt>
              <dd>{{ props.detail.levelLabel }}</dd>
            </div>
            <div v-if="props.detail.mortgagedLabel !== null">
              <dt>抵押</dt>
              <dd>{{ props.detail.mortgagedLabel }}</dd>
            </div>
            <div v-if="props.detail.mortgageValue !== null">
              <dt>抵押额</dt>
              <dd>¥{{ formatMoney(props.detail.mortgageValue) }}</dd>
            </div>
            <div v-if="props.detail.houseCost !== null">
              <dt>单栋建筑费</dt>
              <dd>¥{{ formatMoney(props.detail.houseCost) }}</dd>
            </div>
          </dl>

          <ul v-if="props.detail.notes.length > 0" class="notes">
            <li v-for="(note, index) in props.detail.notes" :key="`${index}:${note}`">{{ note }}</li>
          </ul>
        </div>
      </section>
    </dialog>
  </Teleport>
</template>

<style scoped>
.cell-dialog-layer {
  width: min(540px, calc(100vw - 32px));
  max-width: none;
  max-height: none;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-text);
  overflow: visible;
}

.cell-dialog-layer::backdrop {
  background: var(--overlay-scrim);
  backdrop-filter: blur(3px);
}

.cell-dialog {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
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

.cell-heading {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.eyebrow {
  color: var(--color-muted);
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 0.14em;
}

.title-row {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.title-row h2 {
  margin: 0;
  color: var(--color-text);
  font-size: 1.24rem;
  font-weight: 900;
  line-height: 1.25;
  overflow-wrap: anywhere;
}

.type-chip {
  flex: 0 0 auto;
  border: 1px solid var(--game-line-soft);
  border-radius: 8px;
  padding: 3px 8px;
  background: var(--game-panel-quiet);
  color: var(--color-muted);
  font-size: 0.74rem;
  font-weight: 800;
  white-space: nowrap;
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
  background: var(--game-panel-raised);
  color: var(--color-primary);
  font-size: 1.4rem;
  font-weight: 700;
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

.cell-body {
  display: grid;
  gap: 12px;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 14px 18px 18px;
}

.current-rent {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px 14px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--color-accent) 45%, var(--color-border));
  border-inline-start: 4px solid var(--color-accent);
  border-radius: 12px;
  background: var(--game-panel-raised);
}

.rent-label {
  align-self: center;
  color: var(--color-muted);
  font-size: 0.82rem;
  font-weight: 800;
}

.rent-amount {
  color: var(--color-primary);
  font-family: var(--game-mono);
  font-size: 1.5rem;
  font-weight: 900;
  font-variant-numeric: tabular-nums;
  text-align: right;
  overflow-wrap: anywhere;
}

.rent-amount.pending {
  font-family: inherit;
  font-size: 1.05rem;
}

.rent-note {
  grid-column: 1 / -1;
  color: var(--color-muted);
  font-size: 0.78rem;
  line-height: 1.45;
}

.rent-section h3 {
  margin: 0 0 8px;
  color: var(--color-text);
  font-size: 0.92rem;
  letter-spacing: 0.02em;
}

.rent-list,
.facts {
  display: grid;
  gap: 6px;
  margin: 0;
}

.rent-list div,
.facts div {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px dashed var(--game-line-soft);
  padding-bottom: 5px;
}

.rent-list dt,
.facts dt {
  color: var(--color-muted);
  font-size: 0.82rem;
}

.rent-list dd,
.facts dd {
  margin: 0;
  font-size: 0.86rem;
  font-variant-numeric: tabular-nums;
  font-weight: 800;
  text-align: right;
  overflow-wrap: anywhere;
}

.rent-list dd {
  font-family: var(--game-mono);
}

.facts {
  grid-template-columns: repeat(auto-fit, minmax(148px, 1fr));
  gap: 6px;
}

.facts div {
  align-items: center;
  border: 1px solid var(--game-line-soft);
  border-radius: 9px;
  padding: 7px 9px;
  background: var(--game-panel-raised);
}

.description {
  margin: 0;
  color: var(--color-muted);
  font-size: 0.86rem;
  line-height: 1.5;
}

.notes {
  margin: 0;
  padding-left: 18px;
  color: var(--color-muted);
  font-size: 0.86rem;
  line-height: 1.5;
}

@media (max-width: 767px) {
  .cell-dialog-layer {
    width: 100%;
    margin: auto 0 0;
  }

  .cell-dialog {
    max-height: 80dvh;
    border-right: 0;
    border-bottom: 0;
    border-left: 0;
    border-radius: 16px 16px 0 0;
  }

  .dialog-header {
    padding: 14px 16px 11px;
  }

  .cell-body {
    padding: 12px 16px 16px;
  }
}
</style>
