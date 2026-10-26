<script setup lang="ts">
/**
 * 格子详情弹窗。
 *
 * 11-17 统一版：外壳整个交给 `MobileSheet layout="modal"`，不再自己开 `<dialog>`。
 * 此前它是一套独立弹窗：540px 宽、圆角 14px、标题 1.24rem 左对齐、右上角一个「×」，
 * 而同一局里的「我的资产 / 结算」各有各的宽度、圆角与关闭方式 —— 用户的原话是
 * 「局内所有弹窗的文案与视觉风格保持一致」。
 * 现在尺寸/圆角/标题位置/关闭按钮全部来自 MobileSheet 那一条 modal 规则（唯一事实源），
 * 这里只负责正文：格子名当标题、类型当标题右侧的状态字，正文按「过路费 → 租金表 →
 * 说明 → 数值 → 备注」的同一顺序排。
 *
 * 关窗细节仍归调用方：MobileSheet 负责锁 body、Esc、焦点归还；`close` 事件抛给 GameView，
 * 由它清空选中格子并把焦点还给触发它的那一格。
 */
import MobileSheet from './MobileSheet.vue';
import type { CellDetail } from '../game/clientGame';
import { formatCash } from '../ui/format';

const props = defineProps<{
  detail: CellDetail;
}>();

const emit = defineEmits<{
  close: [];
}>();
</script>

<template>
  <!-- 仍 Teleport 到 body：弹窗挂在对局页里时，任何将来给 .game-view 加的变换/裁剪
       都不会把 fixed 浮层带偏；这条与改造前保持一致。 -->
  <view to="body">
    <MobileSheet
      layout="modal"
      :open="true"
      :title="props.detail.name"
      :aside="props.detail.typeLabel"
      @close="emit('close')"
    >
      <view v-if="props.detail.currentRent" class="rent-highlight" aria-label="当前过路费">
        <text class="rent-label">当前过路费</text>
        <text v-if="props.detail.currentRent.amount !== null" class="rent-amount">
          {{ formatCash(props.detail.currentRent.amount) }}
        </text>
        <text v-else class="rent-amount pending">待本次掷骰</text>
        <text class="rent-note">{{ props.detail.currentRent.note }}</text>
      </view>

      <view v-if="props.detail.rentRows.length > 0" class="rent-section">
        <view class="section-title">完整租金表</view>
        <view class="rent-list">
          <view v-for="row in props.detail.rentRows" :key="row.label">
            <view>{{ row.label }}</view>
            <view>{{ formatCash(row.amount) }}</view>
          </view>
        </view>
      </view>

      <view class="description">{{ props.detail.description }}</view>

      <view class="facts">
        <view v-if="props.detail.price !== null">
          <view>价格</view>
          <view>{{ formatCash(props.detail.price) }}</view>
        </view>
        <view v-if="props.detail.ownerName !== null">
          <view>拥有者</view>
          <view>{{ props.detail.ownerName }}</view>
        </view>
        <view v-if="props.detail.levelLabel !== null">
          <view>状态</view>
          <view>{{ props.detail.levelLabel }}</view>
        </view>
        <view v-if="props.detail.mortgagedLabel !== null">
          <view>抵押</view>
          <view>{{ props.detail.mortgagedLabel }}</view>
        </view>
        <view v-if="props.detail.mortgageValue !== null">
          <view>抵押额</view>
          <view>{{ formatCash(props.detail.mortgageValue) }}</view>
        </view>
        <view v-if="props.detail.houseCost !== null">
          <view>单栋建筑费</view>
          <view>{{ formatCash(props.detail.houseCost) }}</view>
        </view>
      </view>

      <view v-if="props.detail.notes.length > 0" class="notes">
        <view v-for="(note, index) in props.detail.notes" :key="`${index}:${note}`">{{ note }}</view>
      </view>
    </MobileSheet>
  </view>
</template>

<style scoped>
/* 正文分区沿用与「资产 / 结算」同一套节奏：
   高亮块（当前值）→ 分组小标题 → 明细行 → 注释。
   块内圆角 12 / 内层 10，与资产面板、结算排名行同档，不再各自 8/9/12 混着来。 */
.rent-highlight {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 12px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--color-accent) 45%, var(--color-border));
  border-inline-start: 4px solid var(--color-accent);
  border-radius: 12px;
  background: var(--game-panel-raised);
}

.rent-label {
  align-self: center;
  color: var(--color-muted);
  font-size: var(--text-body-size);
  font-weight: 800;
}

.rent-amount {
  color: var(--color-primary);
  font-family: var(--game-mono);
  font-size: 1.35rem;
  font-weight: 900;
  font-variant-numeric: tabular-nums;
  text-align: right;
  overflow-wrap: anywhere;
}

.rent-amount.pending {
  font-family: inherit;
  font-size: var(--text-section-size);
}

.rent-note {
  grid-column: 1 / -1;
  color: var(--color-muted);
  font-size: var(--text-meta-size);
  line-height: 1.45;
}

/* 弹窗内的分组小标题：与资产面板的「资产总览」「可用现金」、结算的「结算排名」同号同重。 */
.section-title {
  margin: 0 0 6px;
  color: var(--color-text);
  font-size: var(--text-section-size);
  font-weight: 800;
}

.rent-list,
.facts {
  display: grid;
  gap: 5px;
  margin: 0;
}

.rent-list div,
.facts div {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px dashed var(--game-line-soft);
  padding-bottom: 4px;
}

.rent-list dt,
.facts dt {
  color: var(--color-muted);
  font-size: var(--text-body-size);
}

.rent-list dd,
.facts dd {
  margin: 0;
  color: var(--color-text);
  font-size: var(--text-body-size);
  font-variant-numeric: tabular-nums;
  font-weight: 800;
  text-align: right;
  overflow-wrap: anywhere;
}

.rent-list dd {
  font-family: var(--game-mono);
}

.facts {
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
}

/* 数值块与资产面板的「卖房可得 / 抵押可得」同一张脸：浅底、细边、10px 圆角。 */
.facts div {
  align-items: center;
  border: 1px solid var(--game-line-soft);
  border-bottom: 1px solid var(--game-line-soft);
  border-radius: 10px;
  padding: 6px 8px;
  background: var(--game-panel-raised);
}

.description {
  margin: 0;
  color: var(--color-muted);
  font-size: var(--text-body-size);
  line-height: 1.6;
}

.notes {
  margin: 0;
  padding-left: 18px;
  color: var(--color-muted);
  font-size: var(--text-body-size);
  line-height: 1.6;
}
</style>
