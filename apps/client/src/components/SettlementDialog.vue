<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { RenderableGameState } from '../session/gameSession';
import { getSettlementSummary } from '../game/settlement';
import { formatMoney } from '../ui/format';

const props = withDefaults(defineProps<{
  state: RenderableGameState;
  primaryLabel?: string;
}>(), {
  primaryLabel: '再开一局',
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
  if (event.key === 'Escape') emit('close');
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
  void nextTick(() => primaryAction.value?.focus());
});
onBeforeUnmount(() => window.removeEventListener('keydown', handleKeydown));
</script>

<template>
  <div class="settlement-backdrop" role="presentation">
    <section class="settlement-dialog" role="dialog" aria-modal="true" aria-labelledby="settlement-title">
      <div class="settlement-mark" aria-hidden="true">
        <svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" focusable="false">
          <circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" stroke-width="1.6" stroke-opacity="0.28" />
          <path d="M18.5 35.5V13.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" />
          <path d="M18.5 15h13.2l-3 5.2 3 5.2H18.5z" fill="currentColor" />
          <path d="M14 35.5h9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" />
        </svg>
      </div>
      <h2 id="settlement-title">{{ summary.title }}</h2>
      <p class="settlement-reason">{{ summary.reason }}</p>

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
            <strong>¥{{ formatMoney(row.cash) }}</strong>
            <em v-if="row.isBankrupt">{{ row.status }}</em>
          </span>
        </li>
      </ol>

      <div class="settlement-actions">
        <button ref="primaryAction" type="button" class="primary" @click="emit('restart')">{{ props.primaryLabel }}</button>
        <button type="button" class="secondary" @click="emit('close')">查看棋盘</button>
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

.settlement-dialog {
  --settle-tile: var(--game-panel-raised);
  width: min(520px, 100%);
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 22px 20px;
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: var(--game-panel);
  box-shadow: var(--game-shadow-dialog);
  text-align: center;
}

.settlement-mark {
  display: grid;
  width: 56px;
  height: 56px;
  margin: 0 auto 10px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--color-accent) 50%, var(--color-border));
  border-radius: 999px;
  background: var(--game-panel-quiet);
  color: var(--color-primary);
}

.settlement-mark svg {
  display: block;
  width: 34px;
  height: 34px;
}

.settlement-dialog h2 {
  margin: 0;
  color: var(--color-text);
  font-size: clamp(1.4rem, 5vw, 1.7rem);
  font-weight: 900;
  line-height: 1.25;
  overflow-wrap: anywhere;
}

.settlement-reason {
  margin: 6px 0 16px;
  color: var(--color-muted);
  font-size: 13px;
  line-height: 1.5;
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
  background: var(--game-panel-quiet);
  color: var(--color-muted);
  font-size: 13px;
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
  font-size: 13.5px;
  font-weight: 800;
  overflow-wrap: anywhere;
}

.name em {
  padding: 1px 5px;
  border-radius: 7px;
  background: var(--game-panel-quiet);
  color: var(--color-muted);
  font-size: 10px;
  font-style: normal;
  font-weight: 900;
}

.winner-tag {
  padding: 1px 6px;
  border-radius: 7px;
  background: var(--color-primary);
  color: #fff;
  font-size: 10px;
  font-weight: 900;
}

.row-main small {
  display: block;
  margin-top: 3px;
  color: var(--color-muted);
  font-size: 11px;
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
  font-size: 10px;
  font-weight: 800;
}

.row-money strong {
  color: var(--color-text);
  font-family: var(--game-mono);
  font-size: 14px;
  font-weight: 900;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.row-money em {
  color: var(--color-pay);
  font-size: 10px;
  font-style: normal;
  font-weight: 900;
}

.settlement-actions {
  display: flex;
  justify-content: center;
  gap: 10px;
  margin-top: 16px;
}

.settlement-actions button {
  min-height: 44px;
  padding: 10px 18px;
  border-radius: var(--game-radius-control);
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

.settlement-actions .secondary {
  border: 1px solid var(--color-border);
  background: var(--settle-tile);
  color: var(--color-text);
  box-shadow: 0 4px 0 var(--game-line-soft);
}

@media (max-width: 767px) {
  .settlement-backdrop {
    padding: 12px;
  }

  .settlement-dialog {
    max-height: calc(100dvh - 24px);
    padding: 18px 16px;
  }

  .settlement-actions {
    flex-direction: column;
  }

  .settlement-actions button {
    width: 100%;
  }
}
</style>
