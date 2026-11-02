<script setup lang="ts">
// 道具面板（#1）：三种道具的持有一览 + 买入 + 遥控骰子点数选择。
//
// 设计取舍：
//  · 只在自己回合出现（getItemPanel 在别人的回合返回的 canBuy 全为 false，但面板仍会画），
//    所以模板把「买不到」做成禁用态而不是整块隐藏——玩家得能看见自己攒了什么。
//  · 遥控骰子的 2-12 直接摆成一排按钮，不做滑块：手机上一排 11 个 40px 按钮正好一行半，
//    比滑块更容易点中确定的点数（这个道具的全部价值就是「精确」）。
import type { Intent, ItemId } from '@richman/engine';
import { formatCash } from '../ui/format';
import type { ItemPanelModel } from '../game/clientGame';

const props = defineProps<{
  panel: ItemPanelModel | null;
  disabled: boolean;
  isSpectator: boolean;
}>();

const emit = defineEmits<{ intent: [Intent] }>();

function buy(itemId: ItemId): void {
  if (props.disabled || props.isSpectator) return;
  emit('intent', { type: 'buy_item', itemId });
}

function useRemoteDie(total: number): void {
  if (props.disabled || props.isSpectator) return;
  emit('intent', { type: 'use_remote_die', total });
}
</script>

<template>
  <view v-if="panel !== null" class="item-panel" aria-label="道具">
    <view class="item-panel__head">
      <text class="item-panel__title">道具</text>
      <text class="item-panel__cash">现金 {{ formatCash(panel.cash) }}</text>
    </view>

    <view class="item-panel__grid">
      <view
        v-for="entry in panel.entries"
        :key="entry.id"
        class="item-card"
        :class="{ 'item-card--owned': entry.count > 0 }"
      >
        <view class="item-card__title">
          {{ entry.label }}
          <text class="item-card__count">×{{ entry.count }}/{{ entry.limit }}</text>
        </view>
        <view class="item-card__desc">{{ entry.description }}</view>
        <button
          type="button"
          class="item-card__buy"
          :disabled="disabled || isSpectator || !entry.canBuy"
          @click="buy(entry.id)"
        >买入 {{ formatCash(entry.price) }}</button>
      </view>
    </view>

    <view v-if="panel.remoteDieOptions.length > 0" class="item-panel__remote">
      <view class="item-panel__remote-label">遥控骰子：选一个点数和，直接走过去</view>
      <view class="item-panel__remote-options">
        <button
          v-for="total in panel.remoteDieOptions"
          :key="total"
          type="button"
          class="item-panel__remote-btn"
          :disabled="disabled || isSpectator"
          @click="useRemoteDie(total)"
        >{{ total }}</button>
      </view>
    </view>
  </view>
</template>

<style scoped>
.item-panel {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-panel, 14px);
  background: var(--surface-raised, var(--color-cell));
}

.item-panel__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.item-panel__title {
  color: var(--color-text);
  font-size: var(--text-body-size);
  font-weight: 800;
}

.item-panel__cash {
  color: var(--color-muted);
  font-size: var(--text-meta-size);
  font-weight: 700;
}

.item-panel__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

@media (max-width: 640px) {
  .item-panel__grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.item-card {
  display: grid;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--board-surface, var(--color-cell));
}

.item-card--owned {
  border-color: var(--color-accent);
}

.item-card__title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  margin: 0;
  color: var(--color-text);
  font-size: var(--text-body-size);
  font-weight: 800;
}

.item-card__count {
  color: var(--color-muted);
  font-size: var(--text-meta-size);
  font-weight: 700;
}

.item-card__desc {
  margin: 0;
  color: var(--color-muted);
  font-size: var(--text-meta-size);
  line-height: 1.5;
}

.item-card__buy,
.item-panel__remote-btn {
  min-height: 40px;
  padding: 4px 10px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-cell);
  color: var(--color-text);
  font-family: inherit;
  font-size: var(--text-meta-size);
  font-weight: 800;
  cursor: pointer;
}

.item-card__buy:disabled,
.item-panel__remote-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.item-panel__remote {
  display: grid;
  gap: 6px;
}

.item-panel__remote-label {
  margin: 0;
  color: var(--color-muted);
  font-size: var(--text-meta-size);
  font-weight: 700;
}

.item-panel__remote-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.item-panel__remote-btn {
  min-width: 44px;
  border-color: var(--color-accent);
  color: var(--color-primary);
}
</style>
