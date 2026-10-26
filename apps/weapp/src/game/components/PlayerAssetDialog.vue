<script setup lang="ts">
/**
 * 玩家资产弹窗（点棋盘旁某位玩家打开）。
 *
 * 11-17 统一版：与「我的资产 / 结算 / 格子详情」共用同一个 `MobileSheet layout="modal"`
 * 外壳。改造前它是自持一套 `<dialog>`：720px 宽、圆角 14px、标题 clamp(1.25rem,4vw,1.55rem)
 * 左对齐、右上角「×」、遮罩还多一层模糊 —— 同一局里四个浮层四种长相。
 * 现在宽度 / 圆角 / 标题字号 / 关闭按钮 / 遮罩全部来自 MobileSheet 那一条规则。
 *
 * 文案也跟着对齐（此前两个弹窗各用一套叫法）：
 *   房产 → 地产、「N 项」→「N 处」、「房产详情」→「地产明细」。
 */
import MobileSheet from './MobileSheet.vue';
import type { PlayerColor, PlayerState } from '@richman/engine';
import type { AssetRow } from '../game/clientGame';
import { formatCash } from '../ui/format';

const props = defineProps<{
  player: PlayerState;
  currentPlayerId: string;
  positionName: string;
  debtAmount: number | null;
  assets: AssetRow[];
  /** 房主且处于联机对局、且当前查看的并非自己时为真，显示「踢出对局」按钮。 */
  canKick: boolean;
}>();

const emit = defineEmits<{
  close: [];
  kick: [];
}>();

const marks: Record<PlayerColor, string> = { red: '●', blue: '■', yellow: '▲', green: '★', purple: '◆', orange: '⬟' };

/** 与「我的资产」同一个写法：裸地 / N 级房屋 / 旅馆 / 车站 / 公用事业。 */
function kindLabel(asset: AssetRow): string {
  if (asset.subtype === 'normal') {
    if (asset.level === 5) return '旅馆';
    return asset.level > 0 ? `${asset.level} 级房屋` : '裸地';
  }
  return asset.subtype === 'station' ? '车站' : '公用事业';
}
</script>

<template>
  <view to="body">
    <MobileSheet
      layout="modal"
      :open="true"
      :title="props.player.nickname"
      aside="玩家资产"
      @close="emit('close')"
    >
      <view class="player-identity">
        <view class="dialog-avatar" :class="`avatar-${props.player.color}`" aria-hidden="true">
          {{ marks[props.player.color] }}
        </view>
        <view class="status-badges" aria-label="玩家状态">
          <text v-if="props.player.isBot">电脑</text>
          <text v-if="props.player.id === props.currentPlayerId">当前回合</text>
          <text v-if="!props.player.online">离线</text>
          <text v-if="props.player.bankrupt" class="danger">破产</text>
        </view>
      </view>

      <view class="summary-strip">
        <view class="summary-cell cash-summary">
          <view>可用现金</view>
          <view class="cash-value">{{ formatCash(props.player.cash) }}</view>
        </view>
        <view class="summary-cell">
          <view>当前位置</view>
          <view>{{ props.positionName }}</view>
        </view>
        <view v-if="props.debtAmount !== null" class="summary-cell debt-summary">
          <view>待偿欠款</view>
          <view>{{ formatCash(props.debtAmount) }}</view>
        </view>
      </view>

      <view class="asset-section" aria-labelledby="player-property-title">
        <view class="section-head">
          <view id="player-property-title" class="section-title">地产明细</view>
          <text class="section-count">{{ props.assets.length }} 处</text>
        </view>
        <view v-if="props.assets.length === 0" class="empty-assets">暂无地产</view>
        <view v-else class="asset-grid">
          <view
            v-for="asset in props.assets"
            :key="asset.cellId"
            class="asset-card"
            :title="asset.name"
          >
            <text>{{ asset.displayName }}</text>
            <text class="asset-kind">{{ kindLabel(asset) }}</text>
            <text v-if="asset.mortgaged" class="mortgaged">已抵押</text>
          </view>
        </view>
      </view>

      <button v-if="props.canKick" type="button" class="dialog-kick" @click="emit('kick')">
        踢出对局
      </button>
    </MobileSheet>
  </view>
</template>

<style scoped>
/* ---- 抬头：棋子色圆片 + 状态徽标。昵称已经升格成弹窗标题，这里不再重复一遍。 ---- */
.player-identity {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.dialog-avatar {
  display: grid;
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  place-items: center;
  border-radius: var(--radius-chip);
  color: #fff;
  font-size: 18px;
  font-weight: 900;
  box-shadow: 0 2px 6px rgb(44 56 36 / 18%);
}

.avatar-red { background: var(--player-red); }
.avatar-blue { background: var(--player-blue); }
.avatar-yellow { background: var(--player-yellow); }
.avatar-green { background: var(--player-green); }
.avatar-purple { background: var(--player-purple); }
.avatar-orange { background: var(--player-orange); }

/* 徽标与「我的资产」里的状态徽标同号同圆角（11px / 8px）。 */
.status-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.status-badges span {
  padding: 2px 7px;
  border-radius: 8px;
  background: var(--game-panel-sunken);
  color: var(--color-muted);
  font-size: var(--text-badge-size);
  font-weight: 900;
}

.status-badges span.danger {
  background: color-mix(in srgb, var(--color-pay) 10%, var(--game-panel-raised));
  color: var(--color-pay);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-pay) 38%, transparent);
}

/* ---- 数值条：与「我的资产」的 .cash-strip 同一张脸（12px 圆角 / 细边 / 浅底）。 ---- */
.summary-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));
  gap: 6px;
  margin: 0;
  padding: 9px 10px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--game-panel-raised);
}

.summary-cell {
  min-width: 0;
}

.summary-strip dt {
  color: var(--color-muted);
  font-size: var(--text-badge-size);
  font-weight: 800;
}

.summary-strip dd {
  margin: 2px 0 0;
  color: var(--color-text);
  font-size: var(--text-body-size);
  font-weight: 900;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.cash-summary dd.cash-value {
  font-family: var(--game-mono);
  font-size: 1rem;
}

.summary-strip .debt-summary dd {
  color: var(--color-pay);
  font-family: var(--game-mono);
}

/* ---- 地产明细 ---- */
.asset-section {
  display: grid;
  gap: 8px;
}

.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

/* 分组小标题：与格子详情的「完整租金表」、结算的「结算排名」同一档。 */
.section-title {
  margin: 0;
  color: var(--color-text);
  font-size: var(--text-section-size);
  font-weight: 800;
}

.section-count {
  color: var(--color-muted);
  font-size: var(--text-meta-size);
  font-weight: 800;
}

.asset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(136px, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 与「我的资产」的 .asset-row 同档：10px 圆角、细边、浅底。 */
.asset-card {
  display: grid;
  min-width: 0;
  align-content: start;
  gap: 3px;
  padding: 9px 10px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--game-panel-raised);
}

.asset-card strong {
  color: var(--color-text);
  font-size: var(--text-body-size);
  font-weight: 900;
  overflow-wrap: anywhere;
}

.asset-kind {
  color: var(--color-muted);
  font-size: var(--text-meta-size);
  font-weight: 800;
}

.mortgaged {
  justify-self: start;
  padding: 2px 7px;
  border-radius: 8px;
  background: var(--button-disabled-bg);
  color: var(--button-disabled-text);
  font-size: var(--text-badge-size);
  font-weight: 900;
}

.empty-assets {
  margin: 0;
  padding: 12px;
  border: 1px dashed var(--color-border);
  border-radius: 10px;
  color: var(--color-muted);
  font-size: var(--text-body-size);
  font-weight: 700;
  text-align: center;
}

/* 破坏性操作收在正文末尾，样式与「我的资产」里的「宣告破产」同一类：
   描边红、透明底 —— 不再是抬头里那颗孤零零的胶囊。 */
.dialog-kick {
  min-height: var(--control-height-md);
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--color-pay) 55%, transparent);
  border-radius: var(--game-radius-control);
  background: transparent;
  color: var(--color-pay);
  font-size: var(--text-body-size);
  font-weight: 900;
  cursor: pointer;
}

.dialog-kick:hover {
  background: color-mix(in srgb, var(--color-pay) 8%, transparent);
}

.dialog-kick:focus-visible {
  outline: 3px solid var(--game-focus);
  outline-offset: 2px;
}
</style>
