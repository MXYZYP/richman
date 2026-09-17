<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ClientAction, DisplayCard, PendingCardChoiceDisplay, PendingPurchaseOffer } from '../game/clientGame';
import { formatMoney } from '../ui/format';

const props = withDefaults(defineProps<{
  actions: ClientAction[];
  dice: number[] | null;
  activeCard: DisplayCard | null;
  eventMessage: string;
  isAnimating: boolean;
  lastError: string | null;
  turnTitle: string;
  purchaseOffer: PendingPurchaseOffer | null;
  /** 地点 HUD 已完整呈现买地信息时，不再重复地价卡。 */
  compactPurchase?: boolean;
  /** 单机真人作弊：等待玩家选择的卡牌；存在时按钮区只有重新抽取/接受并执行。 */
  pendingCard?: PendingCardChoiceDisplay | null;
  /** 观战者：主操作行占位明确只读，不引导去资产面板执行操作。 */
  isSpectator?: boolean;
}>(), { compactPurchase: false, pendingCard: null, isSpectator: false });

const emit = defineEmits<{
  action: [action: ClientAction];
}>();

const diceTotal = computed(() => (
  props.dice === null ? null : props.dice.reduce((sum, value) => sum + value, 0)
));

/** 每次真实掷骰（数组引用变化）重放一次落定动画；其余重渲染不重放，也不用计时器。*/
const diceRevision = ref(0);
watch(() => props.dice, (next, previous) => {
  if (next !== previous) diceRevision.value += 1;
});

/**
 * `gameInteraction` 的回合播报只有 `轮到你` / `轮到 <昵称>`，其余都是等待、电脑、离线、
 * 托管、债务或连接状态。主位玩家座已经写着“行动中”，只有后者需要可见的文字。
 * 观战状态由按钮行的只读占位完整表达，这里不再重复一行「观战中」。
 */
const statusText = computed(() => {
  const text = props.turnTitle.trim();
  if (props.isSpectator) return '';
  return text === '' || text.startsWith('轮到') ? '' : text;
});

/** 回合播报（`轮到 …`）：文字留给读屏，不占视觉高度。*/
const announcement = computed(() => (
  !props.isSpectator && statusText.value === '' && props.turnTitle.trim() !== ''
));

const showEvent = computed(() => {
  if (props.lastError !== null) return true;
  if (props.eventMessage === '') return false;
  if (props.eventMessage === props.turnTitle) return false;
  return true;
});

const showOffer = computed(() => props.purchaseOffer !== null && !props.compactPurchase);

/** 卡面内容优先取正在播放的动画卡（重抽时它总是最新的一张），否则用待确认卡兜底。 */
const cardPreview = computed(() => props.activeCard ?? props.pendingCard);

const showFeedback = computed(() => (
  showEvent.value || cardPreview.value !== null || showOffer.value
));

function handleAction(action: ClientAction) {
  if (props.isAnimating || props.isSpectator) return;
  emit('action', action);
}

function diePips(value: number): number[] {
  return Array.from({ length: value }, (_, index) => index);
}
</script>

<template>
  <section class="action-panel" aria-label="操作面板">
    <!-- 独立骰子台：真实点数与总和；未掷骰时是空白骰面与等待文字，绝不画假点数。-->
    <div
      class="rack"
      role="group"
      :aria-label="dice && diceTotal !== null
        ? `骰子结果 ${dice.join(' 与 ')}，总和 ${diceTotal}`
        : '骰子：等待掷骰'"
    >
      <div class="rack-stage" :key="diceRevision">
        <div class="dice">
          <template v-if="dice">
            <span v-for="(value, index) in dice" :key="index" class="die" :class="`die-${value}`" aria-hidden="true">
              <i v-for="pip in diePips(value)" :key="pip"></i>
            </span>
          </template>
          <template v-else>
            <span class="die idle" aria-hidden="true"></span>
            <span class="die idle" aria-hidden="true"></span>
          </template>
        </div>
        <span class="roll-total" :class="{ live: dice !== null }" aria-hidden="true">
          <b>{{ diceTotal ?? '—' }}</b>
          <small>{{ dice ? '步' : '待命' }}</small>
        </span>
      </div>
    </div>

    <!-- 主操作行紧跟固定高度的骰子台：固定 44px 高，1/2 个操作与忙碌占位共用同一几何。
         等待/债务状态、战报、卡牌与地价排在按钮下方，只向下生长。-->
    <div class="button-row">
      <template v-if="isSpectator || actions.length === 0">
        <p class="no-actions" role="status">
          {{ isSpectator ? '观战中 · 仅可查看对局' : (isAnimating ? '正在执行当前操作…' : '暂无主操作，请在资产面板处理可用资产') }}
        </p>
      </template>
      <template v-else>
        <button
          v-for="action in actions"
          :key="action.label"
          type="button"
          :class="action.primary ? 'btn-enabled' : 'btn-secondary'"
          :disabled="isAnimating"
          @click="handleAction(action)"
        >
          <span class="btn-label">{{ action.label }}<template v-if="compactPurchase && action.intent.type === 'buy_property' && purchaseOffer"> · ¥{{ formatMoney(purchaseOffer.price) }}</template></span>
        </button>
      </template>
    </div>

    <!-- 可变信息区：主位玩家座负责“轮到谁”，这里只保留等待/异常状态；回合播报仍留给读屏。-->
    <Transition name="console">
      <p v-if="statusText !== ''" class="turn-line" role="status">{{ statusText }}</p>
    </Transition>
    <p v-if="announcement" class="sr-only">{{ turnTitle }}</p>

    <!-- 当前决定：卡牌、地价与战报属于同一块反馈，排在按钮下方，出现时只向下生长。-->
    <Transition name="console">
      <div v-if="showFeedback" class="feedback-row">
        <div v-if="showEvent" class="event-ribbon" :class="{ error: lastError }">
          <span>战报</span>
          <strong>{{ lastError ?? eventMessage }}</strong>
        </div>
        <article
          v-if="cardPreview"
          class="card-preview"
          :class="[`card-${cardPreview.deck}`, { 'card-pending': pendingCard !== null }]"
          :aria-label="pendingCard !== null ? '等待选择的卡牌' : '抽到的卡牌'"
        >
          <div class="card-kicker">
            <span>{{ cardPreview.deck === 'chance' ? '机会' : '命运' }}</span>
            <span v-if="pendingCard !== null" class="card-cheat">单机作弊</span>
          </div>
          <strong v-if="pendingCard !== null" class="card-owner">{{ pendingCard.playerName }} · 等待选择</strong>
          <strong v-if="cardPreview.title" class="card-title">{{ cardPreview.title }}</strong>
          <p class="card-rule">{{ cardPreview.text }}</p>
          <p v-if="pendingCard !== null" class="card-note">重新抽取不限次数，放弃的卡回到牌堆底部；接受后立即结算。</p>
        </article>
        <article v-if="showOffer && purchaseOffer" class="purchase-offer" aria-label="当前地价">
          <span>可购买地块</span>
          <strong>{{ purchaseOffer.name }}</strong>
          <em>¥{{ formatMoney(purchaseOffer.price) }}</em>
        </article>
      </div>
    </Transition>

  </section>
</template>

<style scoped>
/* 控制台整块：不是圆角纸卡，而是一条与棋盘同宽的浅色机身条。
   面板自身不可被 flex 压缩：操作区几何只由内容决定，不被容器挤压。*/
.action-panel {
  display: grid;
  gap: 10px;
  padding: 8px 12px 11px;
  flex: none;
  background: linear-gradient(180deg, var(--game-panel-quiet), var(--game-board-base));
  border-bottom: 1px solid var(--color-border);
}

.turn-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  min-width: 0;
  color: var(--color-text);
  font-size: 12px;
  font-weight: 800;
  line-height: 16px;
  overflow-wrap: anywhere;
}

.turn-line::before {
  content: '';
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-accent);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* 凹槽骰子台：40px 高、全宽、内嵌阴影，两边各一条短刻线。*/
.rack {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: 40px;
  border-radius: 7px;
  background: var(--game-dice-tray);
  box-shadow:
    inset 0 2px 5px color-mix(in srgb, var(--color-muted) 24%, transparent),
    0 1px 0 rgb(255 255 255 / 75%);
}

.rack::before,
.rack::after {
  content: '';
  flex: none;
  width: 22px;
  height: 3px;
  border-top: 1px solid color-mix(in srgb, var(--color-muted) 45%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--color-muted) 45%, transparent);
}

.rack-stage {
  display: flex;
  align-items: center;
  gap: 12px;
}

.dice {
  display: flex;
  gap: 5px;
}

.die {
  --die-tilt: -5deg;
  width: 34px;
  height: 34px;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(3, 1fr);
  gap: 2px;
  padding: 6px;
  border: 1px solid color-mix(in srgb, var(--color-border) 62%, #fff);
  border-radius: 6px;
  background: var(--game-panel-raised);
  box-shadow:
    0 3px 0 var(--game-line-soft),
    0 4px 5px color-mix(in srgb, var(--color-muted) 26%, transparent);
  transform: rotate(var(--die-tilt));
  animation: die-land calc(450ms * var(--game-motion-pace, 1)) cubic-bezier(.22, 1, .36, 1) both;
}

.dice .die:last-child {
  --die-tilt: 5deg;
  animation-delay: calc(60ms * var(--game-motion-pace, 1));
}

.die i {
  width: 5px;
  height: 5px;
  place-self: center;
  border-radius: 50%;
  background: var(--color-text);
}

/* 未掷骰：空白骰面摆平，配“待命”文字，不显示任何虚构点数。*/
.dice .die.idle {
  --die-tilt: 0deg;
  border-color: color-mix(in srgb, var(--color-border) 78%, #fff);
  background: var(--game-panel-quiet);
  box-shadow: inset 0 1px 4px color-mix(in srgb, var(--color-muted) 24%, transparent);
  animation: none;
}

.die-1 i:nth-child(1) { grid-area: 2 / 2; }
.die-2 i:nth-child(1) { grid-area: 1 / 1; }
.die-2 i:nth-child(2) { grid-area: 3 / 3; }
.die-3 i:nth-child(1) { grid-area: 1 / 1; }
.die-3 i:nth-child(2) { grid-area: 2 / 2; }
.die-3 i:nth-child(3) { grid-area: 3 / 3; }
.die-4 i:nth-child(1) { grid-area: 1 / 1; }
.die-4 i:nth-child(2) { grid-area: 1 / 3; }
.die-4 i:nth-child(3) { grid-area: 3 / 1; }
.die-4 i:nth-child(4) { grid-area: 3 / 3; }
.die-5 i:nth-child(1) { grid-area: 1 / 1; }
.die-5 i:nth-child(2) { grid-area: 1 / 3; }
.die-5 i:nth-child(3) { grid-area: 2 / 2; }
.die-5 i:nth-child(4) { grid-area: 3 / 1; }
.die-5 i:nth-child(5) { grid-area: 3 / 3; }
.die-6 i:nth-child(1) { grid-area: 1 / 1; }
.die-6 i:nth-child(2) { grid-area: 2 / 1; }
.die-6 i:nth-child(3) { grid-area: 3 / 1; }
.die-6 i:nth-child(4) { grid-area: 1 / 3; }
.die-6 i:nth-child(5) { grid-area: 2 / 3; }
.die-6 i:nth-child(6) { grid-area: 3 / 3; }

.roll-total {
  display: grid;
  justify-items: center;
  gap: 2px;
  min-width: 34px;
  color: var(--color-muted);
  font-family: var(--game-mono);
}

.roll-total b {
  font-size: 26px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.04em;
  font-variant-numeric: tabular-nums;
}

/* 总和与骰子同时落定：只在真实结果出现时播一次。*/
.roll-total.live b {
  animation: total-settle calc(300ms * var(--game-motion-pace, 1)) cubic-bezier(.22, 1, .36, 1) calc(150ms * var(--game-motion-pace, 1)) both;
}

.roll-total small {
  font-size: 8px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.1em;
}

@keyframes die-land {
  0% { transform: rotate(calc(var(--die-tilt) - 14deg)) translateY(-4px); }
  55% { transform: rotate(calc(var(--die-tilt) + 3deg)) translateY(0); }
  100% { transform: rotate(var(--die-tilt)); }
}

@keyframes total-settle {
  0% { opacity: 0; transform: translateY(4px); }
  100% { opacity: 1; transform: none; }
}

.feedback-row {
  display: grid;
  gap: 6px;
}

.event-ribbon {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 8px;
  padding: 5px 9px;
  border-radius: 8px;
  background: var(--event-bg);
  color: var(--event-text);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--event-text) 16%, transparent);
}

.event-ribbon span {
  flex: none;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.16em;
}

.event-ribbon strong {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

/* 错误保持真实危险红，与主题主色区分。*/
.event-ribbon.error {
  background: color-mix(in srgb, var(--color-pay) 12%, var(--game-panel));
  color: var(--color-pay);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-pay) 42%, transparent);
}

.card-preview,
.purchase-offer {
  padding: 7px 9px;
  border: 1px solid var(--color-border);
  border-radius: var(--game-radius-control);
  background: var(--game-panel-raised);
  color: var(--color-text);
}

.card-chance {
  border-color: color-mix(in srgb, var(--color-primary) 45%, var(--color-border));
}

.card-destiny {
  border-color: color-mix(in srgb, var(--color-accent) 55%, var(--color-border));
}

.card-kicker {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 3px;
  color: var(--color-primary);
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 0.12em;
}

.card-cheat {
  padding: 1px 6px;
  border: 1px dashed color-mix(in srgb, var(--color-accent) 70%, var(--color-border));
  border-radius: 999px;
  color: color-mix(in srgb, var(--color-warning) 75%, var(--color-text));
  font-size: 10px;
  letter-spacing: 0.04em;
}

.card-pending {
  border-style: dashed;
}

.card-owner {
  display: block;
  margin: 0 0 3px;
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 900;
  overflow-wrap: anywhere;
}

.card-note {
  margin: 4px 0 0;
  color: var(--color-muted);
  font-size: 11px;
  font-weight: 700;
  line-height: 1.4;
}

.card-destiny .card-kicker {
  color: color-mix(in srgb, var(--color-accent) 45%, var(--color-text));
}

.card-title {
  display: block;
  margin: 0 0 3px;
  font-size: 14px;
  font-weight: 900;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.card-rule {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.purchase-offer {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 8px;
}

.purchase-offer span {
  flex: none;
  color: var(--color-muted);
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.16em;
}

.purchase-offer strong {
  font-size: 15px;
  color: var(--color-text);
  overflow-wrap: anywhere;
}

.purchase-offer em {
  margin-left: auto;
  color: var(--color-primary);
  font-size: 15px;
  font-style: normal;
  font-weight: 900;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* 进场统一用同一条缓动，退场短促；两者都只作用于 console 内的直接子块。*/
.console-enter-active {
  transition: opacity 280ms cubic-bezier(.22, 1, .36, 1), transform 280ms cubic-bezier(.22, 1, .36, 1);
}

.console-leave-active {
  transition: opacity 160ms ease-in, transform 160ms ease-in;
}

.console-enter-from,
.console-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

/* 主操作行：紧跟骰子台，固定 44px 高、全宽两列（次操作 1fr 在左、主操作 2fr 常在右）。
   1 个操作时铺满整行；忙碌/等待占位与按钮同高。任何状态都不改变这一行的上下边界。*/
.button-row {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 8px;
}

.button-row > button:only-child {
  grid-column: 1 / -1;
}

button {
  display: grid;
  place-items: center;
  height: 44px;
  padding: 4px 10px;
  border: 1px solid transparent;
  border-radius: var(--game-radius-control);
  font-size: 14px;
  font-weight: 800;
  line-height: 1.2;
  cursor: pointer;
}

/* 标签居中；窄屏上的超长标签最多两行后省略——固定高度内换行，绝不撑高按钮。*/
.btn-label {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}

/* 主操作：琥珀实体按键，深色字，短机械底影。*/
.btn-enabled {
  order: 2;
  background: var(--game-action-bg);
  color: var(--game-action-text);
  border-color: color-mix(in srgb, var(--game-action-shadow) 75%, #fff);
  box-shadow:
    0 4px 0 var(--game-action-shadow),
    0 6px 9px color-mix(in srgb, var(--game-action-shadow) 32%, transparent);
}

.btn-enabled:hover:not(:disabled) {
  filter: brightness(0.97);
}

/* 次操作：浅色纸面，同一高度落在左侧。*/
.btn-secondary {
  order: 1;
  background: var(--game-panel-raised);
  border-color: var(--color-border);
  color: var(--color-text);
  box-shadow: 0 3px 0 var(--game-line-soft);
}

.btn-secondary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--game-panel-raised) 82%, #fff);
}

button:focus-visible {
  outline: 3px solid var(--game-focus);
  outline-offset: 2px;
}

/* 真实禁用态：按压到底的无光按键，区别于可点击的次要按钮。*/
button:disabled {
  cursor: wait;
  background: var(--game-panel-quiet);
  border-color: transparent;
  color: var(--color-muted);
  box-shadow: none;
  filter: none;
}

/* 实体按压：按下即时到底，松开 180ms 顺滑回弹；减少动态时不做位移。*/
@media (prefers-reduced-motion: no-preference) {
  button:not(:disabled) {
    transition:
      transform 180ms cubic-bezier(.22, 1, .36, 1),
      box-shadow 180ms cubic-bezier(.22, 1, .36, 1),
      background-color 180ms ease,
      filter 180ms ease;
  }

  button:not(:disabled):active {
    transition-duration: 0ms;
    transform: translateY(2px) scale(0.99);
  }

  .btn-enabled:not(:disabled):active {
    box-shadow: 0 1px 0 var(--game-action-shadow);
  }

  .btn-secondary:not(:disabled):active {
    box-shadow: 0 1px 0 var(--game-line-soft);
  }
}

@media (prefers-reduced-motion: reduce) {
  .die,
  .roll-total.live b {
    animation: none;
  }
}

.no-actions {
  grid-column: 1 / -1;
  display: grid;
  place-items: center;
  height: 44px;
  margin: 0;
  padding: 0 8px;
  overflow: hidden;
  color: var(--color-muted);
  font-size: 13px;
  font-weight: 700;
  line-height: 1.25;
  text-align: center;
}

@media (max-width: 767px) {
  /* 手机紧凑态：按钮行 44px 固定在面板顶部；买地/掷骰这类常规状态整块正好 114px。*/
  .action-panel {
    gap: 10px;
    padding: 8px 12px 11px;
  }

  /* 短屏策略：长战报/长卡面只在按钮下方的反馈区里独立滚动，整页至多增高到该上限；
     按钮行坐标不随信息长度变化，页面滚动也不会把操作区推离原位。*/
  .feedback-row {
    max-height: min(34dvh, 240px);
    overflow-y: auto;
  }

  .event-ribbon {
    padding: 4px 8px;
  }

  .event-ribbon strong {
    font-size: 12px;
    line-height: 1.35;
  }

  .card-preview,
  .purchase-offer {
    padding: 6px 8px;
    border-radius: 8px;
  }

  .card-kicker {
    margin-bottom: 2px;
    font-size: 10px;
  }

  .card-title {
    margin-bottom: 2px;
    font-size: 13px;
  }

  .card-rule {
    font-size: 12px;
    line-height: 1.4;
  }

  .purchase-offer strong,
  .purchase-offer em {
    font-size: 13px;
  }

  .button-row button {
    padding: 4px 8px;
    font-size: 13px;
  }
}
</style>
