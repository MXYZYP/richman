<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { deadlineRatio, remainingSeconds } from '../session/turnTimer';

/**
 * 回合限时倒计时（#107）。
 *
 * 纯展示组件：**只认服务端给的 `deadlineAt`**，本地不判超时（到点由服务端代走一步并广播）。
 * 内部那根 250ms 的时钟只用来把「剩余多少」重算成界面上的数字与条宽——
 * 250ms 而 不是 1000ms，是因为进度条要连续收缩；1000ms 会跳成一段一段的阶梯。
 */
const props = defineProps<{
  /** 服务端给的截止时间戳（ms）。 */
  deadlineAt: number;
  /** 本房间的限时档位（秒），用于算剩余比例。 */
  limitSec: number;
  /** 等待中的操作：倒计时照走，只把样式压暗（它反映的是服务端的钟，不因本地忙碌而暂停）。 */
  busy?: boolean;
}>();

const now = ref(Date.now());
let ticker: ReturnType<typeof globalThis.setInterval> | undefined;

function stopTicker(): void {
  if (ticker !== undefined) {
    globalThis.clearInterval(ticker);
    ticker = undefined;
  }
}

function startTicker(): void {
  stopTicker();
  now.value = Date.now();
  ticker = globalThis.setInterval(() => {
    now.value = Date.now();
  }, 250);
}

watch(() => props.deadlineAt, startTicker, { immediate: true });
onBeforeUnmount(stopTicker);

const secondsLeft = computed(() => remainingSeconds(props.deadlineAt, now.value));
const ratio = computed(() => deadlineRatio(props.deadlineAt, props.limitSec, now.value));
/** 紧迫度分档：正常 / 10 秒内告警 / 5 秒内紧急。样式与无障碍播报都用它。 */
const urgency = computed(() => {
  if (secondsLeft.value <= 5) return 'critical';
  if (secondsLeft.value <= 10) return 'warning';
  return 'normal';
});
const label = computed(() => `剩余 ${secondsLeft.value} 秒`);
</script>

<template>
  <section class="turn-timer" :data-urgency="urgency" aria-label="回合限时">
    <p class="turn-timer__row">
      <span class="turn-timer__title">轮到你了</span>
      <span class="turn-timer__seconds">{{ secondsLeft }}s</span>
    </p>
    <div class="turn-timer__track" role="progressbar" :aria-valuenow="secondsLeft" aria-valuemin="0" :aria-valuemax="limitSec">
      <div class="turn-timer__fill" :style="{ transform: `scaleX(${ratio})` }"></div>
    </div>
    <p class="turn-timer__hint" :class="{ 'turn-timer__hint--dim': busy }">
      <span class="sr-only" aria-live="polite">{{ label }}</span>
      超时将自动代走一步
    </p>
  </section>
</template>

<style scoped>
.turn-timer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--game-radius-control, 9px);
  background: var(--board-surface, var(--game-panel));
  color: var(--color-text);
}

.turn-timer__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin: 0;
}

.turn-timer__title {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-muted);
}

.turn-timer__seconds {
  font-family: var(--game-mono);
  font-size: 18px;
  font-weight: 700;
  color: var(--color-primary);
  font-variant-numeric: tabular-nums;
}

.turn-timer__track {
  height: 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-text) 12%, transparent);
  overflow: hidden;
}

.turn-timer__fill {
  height: 100%;
  transform-origin: left center;
  border-radius: 999px;
  background: var(--color-accent);
  transition: transform 250ms linear, background-color 200ms ease;
}

/* 10 秒内转暖色提醒、5 秒内转红——只改颜色与字号，不做任何跳动动画：
   一个每秒都在闪的界面比没有倒计时更让人焦虑，也会让「还在不在加载」变得难以判断。 */
.turn-timer[data-urgency='warning'] .turn-timer__fill {
  background: #d98a2b;
}

.turn-timer[data-urgency='critical'] .turn-timer__fill {
  background: #c0483a;
}

.turn-timer[data-urgency='critical'] .turn-timer__seconds {
  color: #c0483a;
}

.turn-timer__hint {
  margin: 0;
  font-size: 11px;
  color: var(--color-muted);
}

.turn-timer__hint--dim {
  opacity: 0.6;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
</style>
