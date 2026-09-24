<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { AUCTION_MIN_INCREMENT, type Intent } from '@richman/engine';
import type {
  AuctionDisplay,
  TradeDisplay,
  TradeProposalOption,
} from '../game/clientGame';
import { formatMoney } from '../ui/format';

/**
 * 议价面板（#105 交易 / #106 拍卖）共用一块控制台区域。
 *
 * 三态互斥，优先级固定：
 *   1. 有进行中的报价 → 交易确认（答复方 / 发起方 / 旁观三种视角）
 *   2. 有进行中的拍卖 → 出价界面
 *   3. 轮到我且可以发起 → 交易报价表单（默认折叠，避免常驻占位）
 *
 * 面板只负责收集玩家的意图并原样抛出；合法性一律由引擎裁决，这里不做第二套判断。
 */
const props = withDefaults(defineProps<{
  trade: TradeDisplay | null;
  auction: AuctionDisplay | null;
  /** 可发起的对手列表；null / 空数组表示此刻不能发起（不是我的回合、或已有人在议价）。 */
  proposalOptions: TradeProposalOption[] | null;
  /** 发起人自己这边可进入报价的地皮。 */
  ownCells: Array<{ cellId: number; name: string }>;
  ownCash: number;
  isBusy?: boolean;
  isSpectator?: boolean;
}>(), { isBusy: false, isSpectator: false });

const emit = defineEmits<{ intent: [intent: Intent] }>();

/* ---- 交易确认 ---- */

const tradeRows = computed(() => {
  const trade = props.trade;
  if (trade === null) return null;
  return [
    { label: `${trade.proposerName} 给出`, side: trade.offer },
    { label: `${trade.targetName} 给出`, side: trade.request },
  ];
});

/** 报价双方都空手只可能是数据异常；这里退化成一行「无内容」而不是渲染空栏。 */
function sideText(side: { cash: number; cellNames: string[] }): string {
  const parts: string[] = [];
  if (side.cash > 0) parts.push(`现金 ¥${formatMoney(side.cash)}`);
  if (side.cellNames.length > 0) parts.push(side.cellNames.join('、'));
  return parts.length === 0 ? '无' : parts.join(' + ');
}

const tradeWaitingText = computed(() => {
  const trade = props.trade;
  if (trade === null) return '';
  return `等待 ${trade.targetName} 答复；他拒绝或撤回后回合继续。`;
});

/* ---- 拍卖出价 ---- */

/** 输入框里的金额；随「下一次出价下限」变化重设，避免上次的残留值低于下限。 */
const bidAmount = ref(0);
watch(
  () => props.auction?.minBid ?? 0,
  (minBid) => {
    bidAmount.value = minBid;
  },
  { immediate: true },
);

const bidTooLow = computed(() => {
  const auction = props.auction;
  if (auction === null) return true;
  return bidAmount.value < auction.minBid;
});

const bidTooHigh = computed(() => {
  const auction = props.auction;
  if (auction === null) return true;
  return bidAmount.value > auction.myMaxBid;
});

const bidBlockedReason = computed(() => {
  const auction = props.auction;
  if (auction === null) return '';
  if (bidAmount.value < auction.minBid) return `出价不能低于 ¥${formatMoney(auction.minBid)}`;
  if (bidAmount.value > auction.myMaxBid) return `最多只能出到 ¥${formatMoney(auction.myMaxBid)}（你的现金）`;
  return '';
});

const canSubmitBid = computed(() => (
  props.auction !== null && !props.isBusy && bidBlockedReason.value === ''
));

const auctionLeaderText = computed(() => {
  const auction = props.auction;
  if (auction === null) return '';
  if (auction.leaderName === null) return '尚无出价';
  return `${auction.leaderName} 以 ¥${formatMoney(auction.leaderBid)} 领先`;
});

/* ---- 发起交易 ---- */

const proposeOpen = ref(false);
const targetId = ref('');
const offerCash = ref(0);
const requestCash = ref(0);
const offerCellIds = ref<number[]>([]);
const requestCellIds = ref<number[]>([]);

/** 换对手时清空「我要」一栏：上一家的地皮清单与勾选在这家没有意义。 */
watch(() => props.proposalOptions, (options) => {
  if (options === null || options.length === 0) {
    proposeOpen.value = false;
    targetId.value = '';
    return;
  }
  if (!options.some((option) => option.playerId === targetId.value)) {
    targetId.value = options[0]!.playerId;
  }
  requestCash.value = 0;
  requestCellIds.value = [];
}, { immediate: true });

const selectedTarget = computed(() => (
  props.proposalOptions?.find((option) => option.playerId === targetId.value) ?? null
));

const offerEmpty = computed(() => offerCash.value <= 0 && offerCellIds.value.length === 0);
const requestEmpty = computed(() => requestCash.value <= 0 && requestCellIds.value.length === 0);

const offerCashTooHigh = computed(() => offerCash.value > props.ownCash);
const requestCashTooHigh = computed(() => (
  selectedTarget.value !== null && requestCash.value > selectedTarget.value.cash
));

const proposeBlockedReason = computed(() => {
  if (selectedTarget.value === null) return '请选择一位对手';
  if (offerCashTooHigh.value) return `「我给」的现金超过你手上的 ¥${formatMoney(props.ownCash)}`;
  if (requestCashTooHigh.value) return `「我要」的现金超过对方手上的 ¥${formatMoney(selectedTarget.value.cash)}`;
  if (offerEmpty.value && requestEmpty.value) return '双方都空手的报价没有意义：至少给出一项或索要一项';
  return '';
});

const canSubmitProposal = computed(() => !props.isBusy && proposeBlockedReason.value === '');

const proposeSummary = computed(() => {
  const target = selectedTarget.value;
  if (target === null) return '';
  return `你要和 ${target.nickname} 换：` + [
    offerEmpty.value ? null : `给出 ${sideText({ cash: offerCash.value, cellNames: cellNamesOf(props.ownCells, offerCellIds.value) })}`,
    requestEmpty.value ? null : `索要 ${sideText({ cash: requestCash.value, cellNames: cellNamesOf(target.cells, requestCellIds.value) })}`,
  ].filter((part): part is string => part !== null).join('，');
});

function cellNamesOf(
  cells: Array<{ cellId: number; name: string }>,
  cellIds: number[],
): string[] {
  return cells.filter((cell) => cellIds.includes(cell.cellId)).map((cell) => cell.name);
}

/** 勾选/取消一块地。模板里 ref 会被自动解包成数组，所以这里用名字而不是 ref 本体做参数。 */
function toggleCell(kind: 'offer' | 'request', cellId: number, checked: boolean): void {
  const list = kind === 'offer' ? offerCellIds : requestCellIds;
  list.value = checked
    ? [...new Set([...list.value, cellId])]
    : list.value.filter((candidate) => candidate !== cellId);
}

function submit(intent: Intent): void {
  if (props.isBusy || props.isSpectator) return;
  emit('intent', intent);
}

function submitProposal(): void {
  if (!canSubmitProposal.value || selectedTarget.value === null) return;
  submit({
    type: 'propose_trade',
    targetId: selectedTarget.value.playerId,
    offer: { cash: offerCash.value, cellIds: [...offerCellIds.value] },
    request: { cash: requestCash.value, cellIds: [...requestCellIds.value] },
  });
  // 报价已发出，收起表单：下一步由对手答复，留在展开态只会挡住战报。
  proposeOpen.value = false;
  offerCash.value = 0;
  offerCellIds.value = [];
  requestCash.value = 0;
  requestCellIds.value = [];
}

function submitBid(): void {
  if (!canSubmitBid.value) return;
  submit({ type: 'place_bid', amount: bidAmount.value });
}
</script>

<template>
  <!-- 1. 交易确认 -->
  <section v-if="trade" class="bargain-panel" aria-label="交易报价">
    <p class="bargain-panel__title">
      <span>交易报价</span>
      <span class="bargain-panel__pair">{{ trade.proposerName }} → {{ trade.targetName }}</span>
    </p>
    <ul class="bargain-panel__sides">
      <li v-for="row in tradeRows ?? []" :key="row.label">
        <span class="bargain-panel__who">{{ row.label }}</span>
        <strong>{{ sideText(row.side) }}</strong>
      </li>
    </ul>
    <div v-if="trade.canRespond" class="bargain-panel__actions">
      <button
        type="button"
        class="bargain-btn bargain-btn--primary"
        :disabled="isBusy || isSpectator"
        @click="submit({ type: 'respond_trade', accept: true })"
      >接受报价</button>
      <button
        type="button"
        class="bargain-btn bargain-btn--ghost"
        :disabled="isBusy || isSpectator"
        @click="submit({ type: 'respond_trade', accept: false })"
      >拒绝</button>
    </div>
    <div v-else-if="trade.canCancel" class="bargain-panel__actions">
      <button
        type="button"
        class="bargain-btn bargain-btn--ghost"
        :disabled="isBusy || isSpectator"
        @click="submit({ type: 'cancel_trade' })"
      >撤回报价</button>
    </div>
    <p v-else class="bargain-panel__hint">{{ tradeWaitingText }}</p>
  </section>

  <!-- 2. 拍卖出价 -->
  <section v-else-if="auction" class="bargain-panel" aria-label="地产拍卖">
    <p class="bargain-panel__title">
      <span>地产拍卖</span>
      <span class="bargain-panel__pair">{{ auction.cellName }} · 底价 ¥{{ formatMoney(auction.cellPrice) }}</span>
    </p>
    <ul class="bargain-panel__sides">
      <li>
        <span class="bargain-panel__who">当前最高</span>
        <strong>{{ auctionLeaderText }}</strong>
      </li>
      <li v-if="auction.passedNames.length > 0">
        <span class="bargain-panel__who">已退出叫价</span>
        <strong>{{ auction.passedNames.join('、') }}</strong>
      </li>
    </ul>
    <template v-if="auction.isMyTurnToBid">
      <div class="bargain-panel__bid">
        <label :for="`bid-amount-${auction.cellId}`">你的出价</label>
        <input
          :id="`bid-amount-${auction.cellId}`"
          v-model.number="bidAmount"
          type="number"
          inputmode="numeric"
          :min="auction.minBid"
          :max="auction.myMaxBid"
          :step="AUCTION_MIN_INCREMENT"
        />
        <span class="bargain-panel__range">
          下限 ¥{{ formatMoney(auction.minBid) }} · 上限 ¥{{ formatMoney(auction.myMaxBid) }}
        </span>
      </div>
      <p v-if="bidBlockedReason !== ''" class="bargain-panel__warn">{{ bidBlockedReason }}</p>
      <div class="bargain-panel__actions">
        <button
          type="button"
          class="bargain-btn bargain-btn--primary"
          :disabled="!canSubmitBid || isSpectator"
          @click="submitBid()"
        >出价</button>
        <button
          type="button"
          class="bargain-btn bargain-btn--ghost"
          :disabled="isBusy || isSpectator"
          @click="submit({ type: 'pass_bid' })"
        >放弃叫价</button>
      </div>
      <p class="bargain-panel__hint">
        每次加价至少 ¥{{ formatMoney(AUCTION_MIN_INCREMENT) }}；放弃后本轮不再叫价。
        无人加价时，最高出价者按自己的出价买下这块地。
      </p>
    </template>
    <p v-else class="bargain-panel__hint">等待 {{ auction.bidderName }} 出价或放弃叫价。</p>
  </section>

  <!-- 3. 发起交易（默认折叠） -->
  <section
    v-else-if="proposalOptions && proposalOptions.length > 0"
    class="bargain-panel bargain-panel--propose"
    aria-label="发起交易"
  >
    <button
      type="button"
      class="bargain-panel__toggle"
      :aria-expanded="proposeOpen"
      @click="proposeOpen = !proposeOpen"
    >{{ proposeOpen ? '收起交易报价' : '发起交易' }}</button>

    <template v-if="proposeOpen">
      <div class="bargain-panel__target">
        <label for="trade-target">交易对手</label>
        <select id="trade-target" v-model="targetId">
          <option v-for="option in proposalOptions" :key="option.playerId" :value="option.playerId">
            {{ option.nickname }}（现金 ¥{{ formatMoney(option.cash) }}）
          </option>
        </select>
      </div>

      <div class="bargain-panel__columns">
        <fieldset class="bargain-panel__side">
          <legend>我给</legend>
          <label class="bargain-panel__cash">
            现金
            <input
              id="trade-offer-cash"
              v-model.number="offerCash"
              type="number"
              inputmode="numeric"
              min="0"
              :max="ownCash"
            />
          </label>
          <p v-if="ownCells.length === 0" class="bargain-panel__empty">没有可让渡的空地（带房屋的地不能交易）。</p>
          <label v-for="cell in ownCells" :key="`offer-${cell.cellId}`" class="bargain-panel__cell">
            <input
              type="checkbox"
              :checked="offerCellIds.includes(cell.cellId)"
              @change="toggleCell('offer', cell.cellId, ($event.target as HTMLInputElement).checked)"
            />
            <span>{{ cell.name }}</span>
          </label>
        </fieldset>

        <fieldset class="bargain-panel__side">
          <legend>我要</legend>
          <label class="bargain-panel__cash">
            现金
            <input
              id="trade-request-cash"
              v-model.number="requestCash"
              type="number"
              inputmode="numeric"
              min="0"
              :max="selectedTarget?.cash ?? 0"
            />
          </label>
          <p v-if="(selectedTarget?.cells.length ?? 0) === 0" class="bargain-panel__empty">
            这位对手没有可让渡的空地。
          </p>
          <label v-for="cell in selectedTarget?.cells ?? []" :key="`request-${cell.cellId}`" class="bargain-panel__cell">
            <input
              type="checkbox"
              :checked="requestCellIds.includes(cell.cellId)"
              @change="toggleCell('request', cell.cellId, ($event.target as HTMLInputElement).checked)"
            />
            <span>{{ cell.name }}</span>
          </label>
        </fieldset>
      </div>

      <p v-if="proposeBlockedReason !== ''" class="bargain-panel__warn">{{ proposeBlockedReason }}</p>
      <p v-else class="bargain-panel__hint">{{ proposeSummary }}</p>

      <div class="bargain-panel__actions">
        <button
          type="button"
          class="bargain-btn bargain-btn--primary"
          :disabled="!canSubmitProposal || isSpectator"
          @click="submitProposal()"
        >发出报价</button>
      </div>
      <p class="bargain-panel__hint">
        报价发出后回合暂停，等对手答复；对手拒绝或你撤回后回到本回合继续操作。
      </p>
    </template>
  </section>
</template>

<style scoped>
.bargain-panel {
  display: grid;
  gap: 7px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--color-accent) 38%, var(--color-border));
  border-radius: var(--game-radius-control, 10px);
  background: var(--game-panel-raised);
  color: var(--color-text);
}

.bargain-panel--propose {
  border-color: var(--color-border);
}

.bargain-panel__title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 8px;
  margin: 0;
  font-size: 13px;
  font-weight: 900;
}

.bargain-panel__pair {
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 700;
  overflow-wrap: anywhere;
}

.bargain-panel__sides {
  display: grid;
  gap: 3px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.bargain-panel__sides li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 8px;
}

.bargain-panel__who {
  flex: none;
  color: var(--color-muted);
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.08em;
}

.bargain-panel__sides strong {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 800;
  overflow-wrap: anywhere;
}

.bargain-panel__bid,
.bargain-panel__target {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  font-size: 12px;
  font-weight: 800;
}

.bargain-panel__bid input,
.bargain-panel__target select,
.bargain-panel__cash input {
  min-width: 0;
  padding: 4px 6px;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  background: var(--game-panel-quiet, var(--game-panel-raised));
  color: var(--color-text);
  font: inherit;
  font-variant-numeric: tabular-nums;
}

.bargain-panel__bid input {
  width: 110px;
}

.bargain-panel__range {
  color: var(--color-muted);
  font-size: 11px;
  font-weight: 700;
}

.bargain-panel__columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.bargain-panel__side {
  display: grid;
  gap: 3px;
  align-content: start;
  margin: 0;
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
}

.bargain-panel__side legend {
  padding: 0 4px;
  color: var(--color-muted);
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.12em;
}

.bargain-panel__cash,
.bargain-panel__cell {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  overflow-wrap: anywhere;
}

.bargain-panel__cash input {
  width: 96px;
}

.bargain-panel__empty {
  margin: 0;
  color: var(--color-muted);
  font-size: 11px;
  font-weight: 700;
  line-height: 1.4;
}

.bargain-panel__hint {
  margin: 0;
  color: var(--color-muted);
  font-size: 11px;
  font-weight: 700;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.bargain-panel__warn {
  margin: 0;
  color: var(--color-pay);
  font-size: 11px;
  font-weight: 800;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.bargain-panel__actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.bargain-panel__toggle {
  justify-self: start;
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--game-radius-control, 10px);
  background: var(--game-panel-raised);
  color: var(--color-text);
  font-size: 13px;
  font-weight: 800;
  cursor: pointer;
}

.bargain-btn {
  display: grid;
  place-items: center;
  height: 40px;
  padding: 4px 10px;
  border: 1px solid transparent;
  border-radius: var(--game-radius-control, 10px);
  font-size: 13px;
  font-weight: 800;
  line-height: 1.2;
  cursor: pointer;
}

.bargain-btn--primary {
  background: var(--game-action-bg, var(--color-primary));
  color: var(--game-action-text, #fff);
  box-shadow: 0 3px 0 var(--game-action-shadow, transparent);
}

.bargain-btn--ghost {
  background: var(--game-panel-raised);
  border-color: var(--color-border);
  color: var(--color-text);
  box-shadow: 0 3px 0 var(--game-line-soft, transparent);
}

.bargain-btn:disabled,
.bargain-panel__toggle:disabled {
  cursor: not-allowed;
  background: var(--game-panel-quiet, var(--game-panel-raised));
  border-color: transparent;
  color: var(--color-muted);
  box-shadow: none;
  filter: none;
}

.bargain-btn:focus-visible,
.bargain-panel__toggle:focus-visible,
.bargain-panel input:focus-visible,
.bargain-panel select:focus-visible {
  outline: 3px solid var(--game-focus, var(--color-accent));
  outline-offset: 2px;
}

@media (max-width: 720px) {
  .bargain-panel__columns {
    grid-template-columns: 1fr;
  }
}
</style>
