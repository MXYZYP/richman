<script setup lang="ts">
import { ref } from 'vue';
import { formatMoney } from '../ui/format';
import type { AssetRow, ClientAction } from '../game/clientGame';

const props = withDefaults(defineProps<{
  actorName: string;
  debtAmount: number | null;
  assets: AssetRow[];
  isAnimating: boolean;
  actorCash?: number | null;
  /** 观战只读：标题不冒充我的资产，并且不渲染任何写操作控件。 */
  readOnly?: boolean;
}>(), {
  actorCash: null,
  readOnly: false,
});

const emit = defineEmits<{
  action: [action: ClientAction];
}>();

const isCollapsed = ref(false);
const assetContentId = 'asset-panel-content';
const isBankruptcyConfirming = ref(false);


function toggleCollapsed() {
  isCollapsed.value = !isCollapsed.value;
}

function send(action: ClientAction) {
  if (props.isAnimating || props.readOnly) return;
  isBankruptcyConfirming.value = false;
  emit('action', action);
}


function actionAriaLabel(action: string, propertyName: string, reason: string | null): string {
  return reason ? `${action} ${propertyName}（${reason}）` : `${action} ${propertyName}`;
}

function assetStatus(row: AssetRow): string {
  if (row.mortgaged) return '已抵押';
  if (row.level >= 5) return '旅馆';
  if (row.level > 0) return `${row.level} 级房屋`;
  return '裸地';
}

function sellHouseAction(row: AssetRow): ClientAction {
  return { label: '卖房', intent: { type: 'sell_house', cellId: row.cellId } };
}
function sellPropertyAction(row: AssetRow): ClientAction {
  return { label: '卖地', intent: { type: 'sell_property', cellId: row.cellId } };
}


function mortgageAction(row: AssetRow): ClientAction {
  return { label: '抵押', intent: { type: 'mortgage_property', cellId: row.cellId } };
}

function redeemAction(row: AssetRow): ClientAction {
  return { label: '赎回', intent: { type: 'redeem_property', cellId: row.cellId } };
}

function declareBankruptcyAction(): ClientAction {
  return { label: '宣告破产', intent: { type: 'declare_bankrupt' } };
}

function requestBankruptcyConfirmation() {
  isBankruptcyConfirming.value = true;
}

function cancelBankruptcyConfirmation() {
  isBankruptcyConfirming.value = false;
}

function confirmBankruptcy() {
  send(declareBankruptcyAction());
}
</script>

<template>
  <section class="asset-panel" :aria-label="readOnly ? '资产详情' : '我的资产'">
    <header class="asset-head">
      <div class="asset-heading">
        <span class="asset-eyebrow">{{ readOnly ? '当前玩家' : '资产总览' }}</span>
        <h2>{{ readOnly ? '资产详情' : '我的资产' }}</h2>
        <p><strong>{{ actorName }}</strong> · {{ assets.length }} 项资产</p>
      </div>
      <button
        type="button"
        class="asset-toggle"
        :aria-expanded="!isCollapsed"
        :aria-controls="assetContentId"
        @click="toggleCollapsed"
      >
        {{ isCollapsed ? '展开资产' : '收起资产' }}
      </button>
    </header>

    <div v-if="debtAmount !== null" class="debt-banner">
      <div class="debt-copy">
        <strong class="debt-pill">
          <span class="debt-label">欠款</span>
          <span class="debt-amount">¥{{ formatMoney(debtAmount) }}</span>
        </strong>
        <p v-if="!readOnly">出售房屋或抵押地产筹集现金，无法偿还时可宣告破产。</p>
      </div>
      <button
        v-if="!readOnly"
        type="button"
        class="bankruptcy-request"
        :disabled="isAnimating"
        @click="requestBankruptcyConfirmation"
      >
        宣告破产
      </button>
    </div>

    <div v-if="!readOnly && debtAmount !== null && isBankruptcyConfirming" class="bankruptcy-confirm" role="alertdialog" aria-label="宣告破产确认">
      <p>确认宣告破产？现金会交给债主或银行，名下地产变为无主，本玩家出局。</p>
      <div class="bankruptcy-confirm-actions">
        <button type="button" class="danger" :disabled="isAnimating" @click="confirmBankruptcy">确认破产</button>
        <button type="button" class="cancel" @click="cancelBankruptcyConfirmation">取消</button>
      </div>
    </div>

    <dl v-if="actorCash !== null" class="cash-strip">
      <div class="cash-cell">
        <dt>可用现金</dt>
        <dd class="cash-value">¥{{ formatMoney(actorCash) }}</dd>
      </div>
      <div class="cash-cell">
        <dt>持有地产</dt>
        <dd>{{ assets.length }} 处</dd>
      </div>
    </dl>

    <div :id="assetContentId" v-show="!isCollapsed" class="asset-content">
      <p v-if="assets.length === 0" class="empty-assets">暂无地产资产</p>

      <div v-else class="asset-list">
        <article v-for="row in assets" :key="row.cellId" class="asset-row" :class="{ mortgaged: row.mortgaged }">
          <header class="asset-row-head">
            <div class="asset-title">
              <strong>{{ row.displayName }}</strong>
              <span>{{ row.name }}</span>
            </div>
            <em class="asset-status" :class="{ mortgaged: row.mortgaged }">{{ assetStatus(row) }}</em>
          </header>

          <dl class="asset-money">
            <div v-if="row.sellHouseRefund !== null && row.level > 0">
              <dt>卖房可得</dt>
              <dd>¥{{ formatMoney(row.sellHouseRefund) }}</dd>
            </div>
            <div v-if="row.level === 0 && row.mortgageValue !== null && !row.mortgaged">
              <dt>抵押可得</dt>
              <dd>¥{{ formatMoney(row.mortgageValue) }}</dd>
            </div>
            <div v-if="row.sellPropertyValue !== null && row.level === 0 && !row.mortgaged">
              <dt>卖地可得</dt>
              <dd>¥{{ formatMoney(row.sellPropertyValue) }}</dd>
            </div>
            <div v-if="row.redeemCost !== null && row.mortgaged">
              <dt>赎回费用</dt>
              <dd>¥{{ formatMoney(row.redeemCost) }}</dd>
            </div>
          </dl>

          <div v-if="!readOnly" class="asset-actions">
            <div class="asset-action">
              <button
                type="button"
                :disabled="isAnimating || !row.canSellHouse"
                :title="row.sellHouseReason ?? '卖出一级房屋'"
                :aria-label="actionAriaLabel('卖房', row.name, row.canSellHouse ? null : row.sellHouseReason)"
                @click="send(sellHouseAction(row))"
              >
                卖房
              </button>
              <small v-if="!row.canSellHouse && row.sellHouseReason">{{ row.sellHouseReason }}</small>
            </div>
            <div class="asset-action">
              <button
                type="button"
                :disabled="isAnimating || !row.canMortgage"
                :title="row.mortgageReason ?? '抵押地产'"
                :aria-label="actionAriaLabel('抵押', row.name, row.canMortgage ? null : row.mortgageReason)"
                @click="send(mortgageAction(row))"
              >
                抵押
              </button>
              <small v-if="!row.canMortgage && row.mortgageReason">{{ row.mortgageReason }}</small>
            </div>
            <div class="asset-action">
              <button
                type="button"
                :disabled="isAnimating || !row.canSellProperty"
                :title="row.sellPropertyReason ?? '卖出地产'"
                :aria-label="actionAriaLabel('卖地', row.name, row.canSellProperty ? null : row.sellPropertyReason)"
                @click="send(sellPropertyAction(row))"
              >
                卖地
              </button>
              <small v-if="!row.canSellProperty && row.sellPropertyReason">{{ row.sellPropertyReason }}</small>
            </div>
            <div class="asset-action">
              <button
                type="button"
                :disabled="isAnimating || !row.canRedeem"
                :title="row.redeemReason ?? '赎回地产'"
                :aria-label="actionAriaLabel('赎回', row.name, row.canRedeem ? null : row.redeemReason)"
                @click="send(redeemAction(row))"
              >
                赎回
              </button>
              <small v-if="!row.canRedeem && row.redeemReason">{{ row.redeemReason }}</small>
            </div>
          </div>
        </article>
      </div>
    </div>
  </section>
</template>

<style scoped>
.asset-panel {
  --asset-tile: var(--game-panel-raised);
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--game-radius-panel);
  background: var(--game-panel);
  box-shadow: var(--game-shadow-panel);
}

.asset-head {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 10px;
}

.asset-heading {
  min-width: 0;
}

.asset-eyebrow {
  color: var(--color-muted);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.12em;
}

.asset-head h2 {
  margin: 2px 0 0;
  color: var(--color-text);
  font-size: 1.06rem;
  font-weight: 900;
}

.asset-head p {
  margin: 3px 0 0;
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 700;
  overflow-wrap: anywhere;
}

.asset-head p strong {
  color: var(--color-text);
  font-weight: 900;
}

.asset-toggle {
  flex: 0 0 auto;
  min-width: 44px;
  min-height: 44px;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--game-radius-control);
  background: var(--asset-tile);
  color: var(--color-primary);
  font-size: 12px;
  font-weight: 900;
  white-space: nowrap;
  cursor: pointer;
  box-shadow: 0 2px 0 var(--game-line-soft);
}

.asset-toggle:hover {
  background: var(--game-panel-quiet);
}

.asset-toggle:focus-visible {
  outline: 3px solid var(--game-focus);
  outline-offset: 2px;
}

.debt-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 10px;
  border: 1px solid color-mix(in srgb, var(--color-pay) 34%, var(--color-border));
  border-radius: 10px;
  background: color-mix(in srgb, var(--color-pay) 7%, var(--game-panel));
}

.debt-copy {
  display: grid;
  gap: 5px;
  min-width: 0;
}

.debt-copy p {
  margin: 0;
  color: color-mix(in srgb, var(--color-pay) 46%, var(--color-text));
  font-size: 11px;
  font-weight: 700;
  line-height: 1.45;
}

.debt-pill {
  display: inline-flex;
  flex-wrap: wrap;
  align-content: center;
  align-items: center;
  justify-content: center;
  gap: 0 4px;
  width: fit-content;
  max-width: min(100%, 8em);
  box-sizing: border-box;
  padding: 3px 8px;
  border-radius: 9px;
  background: var(--color-pay);
  color: #fff;
  font-size: 12px;
  line-height: 1.2;
  text-align: center;
}

.debt-label,
.debt-amount {
  flex: 0 0 auto;
}

.debt-amount {
  font-family: var(--game-mono);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.bankruptcy-request {
  flex: 0 0 auto;
  min-height: 44px;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--color-pay) 55%, transparent);
  border-radius: var(--game-radius-control);
  background: transparent;
  color: var(--color-pay);
  font-size: 12px;
  font-weight: 900;
  cursor: pointer;
}

.bankruptcy-request:hover {
  background: color-mix(in srgb, var(--color-pay) 8%, transparent);
}

.bankruptcy-request:focus-visible {
  outline: 3px solid var(--game-focus);
  outline-offset: 2px;
}

.bankruptcy-request:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.bankruptcy-confirm {
  display: grid;
  gap: 8px;
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--color-pay) 32%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--color-pay) 6%, var(--game-panel));
}

.bankruptcy-confirm p {
  margin: 0;
  color: var(--color-text);
  font-size: 12px;
  font-weight: 800;
  line-height: 1.45;
}

.bankruptcy-confirm-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.bankruptcy-confirm button {
  min-height: 44px;
  padding: 7px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--game-radius-control);
  background: var(--asset-tile);
  color: var(--color-text);
  font-weight: 900;
  cursor: pointer;
}

.bankruptcy-confirm button:focus-visible {
  outline: 3px solid var(--game-focus);
  outline-offset: 2px;
}

.bankruptcy-confirm .danger {
  border-color: var(--color-pay);
  background: var(--color-pay);
  color: #fff;
}

.cash-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));
  gap: 6px;
  margin: 0;
  padding: 9px 10px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--asset-tile);
}

.cash-cell {
  min-width: 0;
}

.cash-cell dt {
  color: var(--color-muted);
  font-size: 11px;
  font-weight: 800;
}

.cash-cell dd {
  margin: 2px 0 0;
  color: var(--color-text);
  font-size: 14px;
  font-weight: 900;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.cash-cell dd.cash-value {
  font-family: var(--game-mono);
  font-size: 16px;
}

.asset-content {
  display: grid;
}

.empty-assets {
  margin: 0;
  padding: 12px;
  border: 1px dashed var(--color-border);
  border-radius: 10px;
  color: var(--color-muted);
  font-size: 13px;
  font-weight: 700;
  text-align: center;
}

.asset-list {
  display: grid;
  gap: 8px;
  max-height: min(46vh, 420px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-right: 2px;
}

.asset-row {
  padding: 10px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--asset-tile);
}

.asset-row.mortgaged {
  background: var(--game-panel-quiet);
}

.asset-row-head {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 8px;
}

.asset-title {
  min-width: 0;
}

.asset-title strong {
  display: block;
  color: var(--color-text);
  font-size: 14px;
  font-weight: 900;
  overflow-wrap: anywhere;
}

.asset-title span {
  display: block;
  margin-top: 1px;
  color: var(--color-muted);
  font-size: 11px;
  font-weight: 700;
  overflow-wrap: anywhere;
}

.asset-status {
  flex: 0 0 auto;
  padding: 3px 7px;
  border-radius: 8px;
  background: var(--game-panel-quiet);
  color: var(--color-muted);
  font-size: 11px;
  font-style: normal;
  font-weight: 900;
  white-space: nowrap;
}

.asset-status.mortgaged {
  background: var(--button-disabled-bg);
  color: var(--button-disabled-text);
}

.asset-money {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(76px, 1fr));
  gap: 5px;
  margin: 8px 0;
}

.asset-money div {
  min-width: 0;
  padding: 6px 7px;
  border: 1px solid var(--game-line-soft);
  border-radius: 8px;
  background: var(--game-panel);
}

.asset-money dt {
  color: var(--color-muted);
  font-size: 10.5px;
  font-weight: 800;
  line-height: 1.25;
}

.asset-money dd {
  margin: 2px 0 0;
  color: var(--color-text);
  font-family: var(--game-mono);
  font-size: 13px;
  font-weight: 900;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.asset-actions {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(72px, 1fr));
  gap: 6px;
}

.asset-action {
  display: grid;
  align-content: start;
  gap: 4px;
  min-width: 0;
}

.asset-action small {
  justify-self: center;
  max-width: 100%;
  padding: 2px 6px;
  border-radius: 7px;
  background: var(--game-panel-quiet);
  color: var(--color-muted);
  font-size: 10.5px;
  font-weight: 800;
  line-height: 1.3;
  text-align: center;
  overflow-wrap: anywhere;
}

.asset-action button {
  min-width: 0;
  min-height: 44px;
  padding: 8px 6px;
  border: 1px solid #bc9037;
  border-radius: var(--game-radius-control);
  background: var(--game-action-bg);
  color: var(--game-action-text);
  font-size: 12px;
  font-weight: 900;
  box-shadow: 0 3px 0 var(--game-action-shadow);
  cursor: pointer;
}

.asset-action button:hover:not(:disabled) {
  filter: brightness(1.04);
}

.asset-action button:active:not(:disabled) {
  transform: translateY(1px);
  box-shadow: 0 2px 0 var(--game-action-shadow);
}

.asset-action button:focus-visible {
  outline: 3px solid var(--game-focus);
  outline-offset: 2px;
}

.asset-action button:disabled {
  border: 1px dashed color-mix(in srgb, var(--color-muted) 34%, transparent);
  background: var(--button-disabled-bg);
  color: var(--button-disabled-text);
  box-shadow: none;
  cursor: not-allowed;
  opacity: 0.9;
}

/* 断点同步抬到 1024：折叠屏/平板上资产面板同样是底部抽屉里的一屏，
   走紧凑态（列表不再内层滚动）比桌面态更合适。*/
@media (max-width: 1024px) {
  .asset-panel {
    padding: 10px;
  }

  .asset-list {
    max-height: none;
    overflow: visible;
    padding-right: 0;
  }

  .asset-actions {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .asset-action button {
    font-size: 11.5px;
  }
}
</style>
