<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { PlayerColor, PlayerState } from '@richman/engine';
import { formatCashDelta, formatMoney } from '../ui/format';
import type { CashNotice } from '../session/gameSession';

// 玩家资产条：当前行动者占 2.75fr 宽位，其余玩家是 1fr 紧凑席位；
// 席位顺序恒等于引擎顺序，回合更替只改宽度分配、绝不重排（手机端席位因此固定）；
// 手机端主位在自身轨道就地加宽，桌面端用 CSS order 把主位提到首位，保持主位在前的旧布局。
// 身份用颜色 + 形状辨识（红● 蓝■ 黄▲ 绿★ 紫◆ 橙⬟），与棋盘棋子同源。
const props = defineProps<{
  players: PlayerState[];
  currentPlayerId: string;
  interactive: boolean;
  cashNotices: CashNotice[];
}>();

const visiblePlayers = computed(() => props.players.filter((player) => !player.bankrupt));

/** 主位是当前行动者；行动者已破产时退回第一个可见席位，避免宽列空着。*/
const heroId = computed(() => {
  const visible = visiblePlayers.value;
  return visible.some((player) => player.id === props.currentPlayerId)
    ? props.currentPlayerId
    : (visible[0]?.id ?? '');
});

/** 主位在可见席位里的下标：手机端加宽的就是这条轨道，和主位身份一一对应。*/
const heroIndex = computed(() =>
  visiblePlayers.value.findIndex((player) => player.id === heroId.value),
);

const HERO_TRACK = 'minmax(0, 2.75fr)';
const SEAT_TRACK = 'minmax(0, 1fr)';

/** 手机端：主位在自身轨道就地加宽、其余席位收窄；轨道数量不变时由 CSS 平滑插值。*/
const mobileSeatTemplate = computed(() => {
  const players = visiblePlayers.value;
  if (players.length === 0) return SEAT_TRACK;
  return players
    .map((_, index) => (index === heroIndex.value ? HERO_TRACK : SEAT_TRACK))
    .join(' ');
});

/** 桌面端：主位仍占第一宽列（配合同样只在桌面生效的 CSS order），其余按引擎顺序。*/
const desktopSeatTemplate = computed(() =>
  [HERO_TRACK, ...visiblePlayers.value.slice(1).map(() => SEAT_TRACK)].join(' '),
);

// 5-6 人：席位太挤，改用固定高度单行横滑（席位仍按引擎顺序、绝不重排），
// 当前行动者由脚本滚进可视区；≤4 人维持既有网格伸缩布局，完全不变。
const scrollMode = computed(() => visiblePlayers.value.length >= 5);

const railRef = ref<HTMLElement | null>(null);

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 只滚动横滑容器本身，绝不触碰页面滚动；主位已可见时不产生滚动。*/
function scrollHeroIntoView(behaviorOverride?: ScrollBehavior): void {
  const rail = railRef.value;
  const seats = rail?.querySelector<HTMLElement>('.player-seats');
  const hero = rail?.querySelector<HTMLElement>('.player-card.hero');
  if (!rail || !seats || !hero || seats.scrollWidth <= seats.clientWidth) return;
  const containerRect = seats.getBoundingClientRect();
  const heroRect = hero.getBoundingClientRect();
  const heroLeft = heroRect.left - containerRect.left + seats.scrollLeft;
  const heroRight = heroLeft + heroRect.width;
  const pad = 8;
  const behavior: ScrollBehavior = behaviorOverride
    ?? (prefersReducedMotion() ? 'auto' : 'smooth');
  if (heroLeft - pad < seats.scrollLeft) {
    seats.scrollTo({ left: Math.max(0, heroLeft - pad), behavior });
  } else if (heroRight + pad > seats.scrollLeft + seats.clientWidth) {
    seats.scrollTo({
      left: Math.min(seats.scrollWidth - seats.clientWidth, heroRight + pad - seats.clientWidth),
      behavior,
    });
  }
}

watch([heroId, scrollMode, () => visiblePlayers.value.length], () => {
  void nextTick(scrollHeroIntoView);
});

let seatsObserver: ResizeObserver | null = null;

function observeSeatsSize(): void {
  seatsObserver?.disconnect();
  seatsObserver = null;
  const seats = railRef.value?.querySelector<HTMLElement>('.player-seats');
  if (seats === undefined || seats === null || typeof ResizeObserver === 'undefined') return;
  seatsObserver = new ResizeObserver(() => {
    scrollHeroIntoView('auto');
  });
  seatsObserver.observe(seats);
}

onMounted(() => {
  scrollHeroIntoView();
  observeSeatsSize();
});
onBeforeUnmount(() => {
  seatsObserver?.disconnect();
  seatsObserver = null;
});

const playerShape: Record<PlayerColor, string> = {
  red: '●',
  blue: '■',
  yellow: '▲',
  green: '★',
  purple: '◆',
  orange: '⬟',
};

const emit = defineEmits<{
  selectPlayer: [playerId: string, trigger: HTMLButtonElement];
}>();

function selectPlayer(playerId: string, event: MouseEvent): void {
  if (!(event.currentTarget instanceof HTMLButtonElement)) return;
  emit('selectPlayer', playerId, event.currentTarget);
}

/** 现金永远完整呈现：位数多的金额降一档字级，席位不会被撑破。*/
function isLongCash(amount: number): boolean {
  return formatMoney(amount).length > 8;
}

function noticeForPlayer(playerId: string): CashNotice | undefined {
  return props.cashNotices?.find((notice) => notice.playerId === playerId);
}

function pillKey(notice: CashNotice): string {
  return `${notice.generation}-${notice.transitionId}-${notice.seq}-${notice.playerId}`;
}
</script>

<template>
  <aside ref="railRef" class="player-rail" aria-label="玩家资产条">
    <TransitionGroup
      :name="scrollMode ? 'seat-static' : 'seat'"
      tag="div"
      class="player-seats"
      :class="{ 'seat-scroll': scrollMode }"
      :style="{ '--seat-cols-mobile': mobileSeatTemplate, '--seat-cols-desktop': desktopSeatTemplate }"
    >
      <div
        v-for="player in visiblePlayers"
        :key="player.id"
        class="player-slot"
        :class="[`seat-${player.color}`, { hero: player.id === heroId }]"
      >
        <button
          type="button"
          class="player-card"
          :class="{ hero: player.id === heroId }"
          :aria-label="`查看${player.nickname}的资产${player.isBot ? '（电脑）' : player.online ? '' : '（离线）'}`"
          :disabled="!interactive"
          @click="selectPlayer(player.id, $event)"
        >
          <span v-if="player.id === heroId" class="hero-badge" aria-hidden="true">{{ playerShape[player.color] }}</span>
          <span class="seat-copy">
            <span class="seat-head">
              <span v-if="player.id !== heroId" class="seat-shape" aria-hidden="true">{{ playerShape[player.color] }}</span>
              <span class="player-nickname" :title="player.nickname">{{ player.nickname }}</span>
              <span v-if="player.id === heroId" class="seat-state">行动中</span>
              <span v-else-if="!player.isBot && !player.online" class="seat-state offline">离线</span>
            </span>
            <strong class="player-cash" :class="{ 'cash-long': isLongCash(player.cash) }">¥{{ formatMoney(player.cash) }}</strong>
          </span>
          <!-- 主位更替时的一次性高亮，不循环、不改变布局。-->
          <span v-if="player.id === heroId" :key="heroId" class="hero-pulse" aria-hidden="true"></span>
        </button>
        <div class="cash-notice-track">
          <span
            v-if="noticeForPlayer(player.id)"
            :key="pillKey(noticeForPlayer(player.id)!)"
            class="cash-pill"
            :class="noticeForPlayer(player.id)!.delta < 0 ? 'cash-loss' : 'cash-gain'"
          >{{ formatCashDelta(noticeForPlayer(player.id)!.delta) }}</span>
        </div>
      </div>
    </TransitionGroup>
  </aside>
</template>

<style scoped>
/* 50px 玩家栏：固定高度（含 5px 底部留白），席位恒为 45px；昵称/现金再长也不会撑高。*/
.player-rail {
  display: block;
  box-sizing: border-box;
  height: 50px;
  min-height: 50px;
  max-height: 50px;
  padding-bottom: 5px;
  width: 100%;
  min-width: 0;
  overflow: hidden;
}

.player-seats {
  display: grid;
  /* 只有一行席位：行高锁死为容器高度，内容再多也只能横向溢出，不会把卡片撑高。*/
  grid-template-rows: minmax(0, 1fr);
  gap: 4px;
  height: 100%;
  min-height: 0;
  max-height: 100%;
  min-width: 0;
  /* 轨道数量不变时（回合更替）宽度平滑插值，手机端席位就地重新分配宽度。*/
  transition: grid-template-columns 280ms cubic-bezier(.22, 1, .36, 1);
  grid-template-columns: var(--seat-cols-mobile);
}

.player-slot {
  position: relative;
  min-width: 0;
  min-height: 0;
}

.player-card {
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 100%;
  height: 45px;
  min-height: 45px;
  max-height: 45px;
  min-width: 0;
  padding: 4px 2px;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-top: 2px solid var(--seat-color);
  border-radius: 5px;
  background: var(--game-panel);
  color: inherit;
  font: inherit;
  text-align: center;
  cursor: pointer;
  appearance: none;
}

.player-card:disabled {
  cursor: default;
}

.player-card:focus-visible {
  outline: 3px solid var(--game-focus);
  outline-offset: 2px;
}

.seat-red { --seat-color: var(--player-red); }
.seat-blue { --seat-color: var(--player-blue); }
.seat-yellow { --seat-color: var(--player-yellow); }
.seat-green { --seat-color: var(--player-green); }
.seat-purple { --seat-color: var(--player-purple); }
.seat-orange { --seat-color: var(--player-orange); }

/* 主位：琥珀内嵌条 + 25×28 身份徽章，昵称与 18px 等宽现金。*/
.player-card.hero {
  justify-content: flex-start;
  gap: 8px;
  padding: 4px 7px;
  overflow: visible;
  border: 1px solid color-mix(in srgb, var(--color-accent) 55%, var(--color-border));
  border-radius: 6px;
  background: linear-gradient(100deg, var(--game-panel-raised), var(--game-panel-quiet));
  box-shadow:
    inset 3px 0 0 var(--color-accent),
    0 2px 0 var(--game-line-soft);
  text-align: left;
}

.hero-badge {
  flex: none;
  display: grid;
  place-items: center;
  width: 25px;
  height: 28px;
  border: 1px solid color-mix(in srgb, var(--seat-color) 55%, #fff);
  border-radius: 8px 8px 4px 4px;
  background: var(--seat-color);
  color: #fff;
  font-size: 12px;
  line-height: 1;
  text-shadow: 0 1px 2px rgb(0 0 0 / 35%);
}

.hero-pulse {
  position: absolute;
  inset: 0;
  border: 2px solid var(--color-accent);
  border-radius: inherit;
  pointer-events: none;
  animation: hero-pulse 420ms cubic-bezier(.22, 1, .36, 1) both;
}

@keyframes hero-pulse {
  0% { opacity: 0.55; transform: scale(1); }
  100% { opacity: 0; transform: scale(1.04); }
}

.seat-copy {
  display: grid;
  justify-items: center;
  gap: 1px;
  min-width: 0;
}

.player-card.hero .seat-copy {
  justify-items: start;
}

.seat-head {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  min-width: 0;
  max-width: 100%;
}

.player-card.hero .seat-head {
  justify-content: flex-start;
  gap: 5px;
}

.seat-shape {
  flex: none;
  color: var(--seat-color);
  font-size: 8px;
  line-height: 14px;
}

.player-nickname {
  min-width: 0;
  overflow: hidden;
  color: var(--color-muted);
  font-size: 9px;
  font-weight: 600;
  line-height: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.player-card.hero .player-nickname {
  line-height: 12px;
}

.seat-state {
  flex: none;
  color: var(--color-primary);
  font-size: 8px;
  font-weight: 800;
  line-height: 12px;
}

.seat-state.offline {
  padding: 0 3px;
  border-radius: 999px;
  background: var(--game-panel-quiet);
  color: var(--color-muted);
}

/* 现金是完整数字：等宽字体、不换行、不用省略号；长昵称先被截断。*/
.player-cash {
  min-width: 0;
  color: var(--color-text);
  font-family: var(--game-mono);
  font-size: 9px;
  font-weight: 500;
  line-height: 13px;
  letter-spacing: -0.02em;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.player-card.hero .player-cash {
  font-size: 18px;
  font-weight: 700;
  line-height: 21px;
  letter-spacing: -0.5px;
}

.player-cash.cash-long {
  font-size: 8px;
  letter-spacing: -0.04em;
}

.player-card.hero .player-cash.cash-long {
  font-size: 15px;
}

.cash-notice-track {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  pointer-events: none;
}

.cash-pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 900;
  font-variant-numeric: tabular-nums;
  animation: cash-pill-float 2.4s cubic-bezier(.22, 1, .36, 1) both;
}

.cash-gain {
  background: var(--cash-profit-bg);
  color: var(--cash-profit-text);
}

.cash-loss {
  background: var(--cash-loss-bg);
  color: var(--cash-loss-text);
}

@keyframes cash-pill-float {
  0% { opacity: 0; transform: translateY(6px) scale(0.96); }
  14% { opacity: 1; transform: translateY(0) scale(1); }
  78% { opacity: 1; transform: translateY(-2px); }
  100% { opacity: 0; transform: translateY(-8px); }
}

@keyframes cash-pill-fade {
  0% { opacity: 1; }
  80% { opacity: 1; }
  100% { opacity: 0; }
}

.seat-enter-active {
  transition: opacity 280ms cubic-bezier(.22, 1, .36, 1), transform 280ms cubic-bezier(.22, 1, .36, 1);
}

.seat-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

/* 手机端：轨道补间期间现金会临时宽过收窄中的卡片，裁在卡片内，避免整页横向溢出。*/
@media (max-width: 767px) {
  .player-card.hero .seat-copy {
    overflow: hidden;
  }
}

/* 桌面端保持掌机比例：整条不拉成超宽面板。*/
@media (min-width: 768px) {
  /* 桌面改用主位在前的轨道模板，宽列跟着视觉上的主位走（与下面的 order 配套）。*/
  .player-seats {
    grid-template-columns: var(--seat-cols-desktop);
  }

  .player-rail {
    max-width: 640px;
  }

  /* 席位 DOM 顺序恒定，主位靠 order 提前到首列，仍占第一宽列。*/
  .player-slot.hero {
    order: -1;
  }

  /* 重排/补位用 FLIP 连续位移；手机端不参与 FLIP，改由上面的 grid 轨道过渡平滑。*/
  .seat-move {
    transition: transform 280ms cubic-bezier(.22, 1, .36, 1);
  }
}

/* 5-6 人横滑模式：栏高与卡片高度仍锁死 50px/45px，席位按引擎顺序单行排布，
   主位就地加宽，其余席位定宽；超宽部分只在容器内横向滑动，不撑破页面。*/
.player-seats.seat-scroll {
  display: flex;
  flex-flow: row nowrap;
  align-items: stretch;
  grid-template-columns: none;
  transition: none;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  overscroll-behavior-x: contain;
  touch-action: pan-x;
  height: 45px;
  max-height: 45px;
}

.player-seats.seat-scroll::-webkit-scrollbar {
  display: none;
}

.player-seats.seat-scroll .player-slot {
  flex: 0 0 88px;
  height: 45px;
  max-height: 45px;
}

.player-seats.seat-scroll .player-slot.hero {
  flex: 0 0 156px;
  /* 横滑模式不重排席位：覆盖桌面网格模式的主位提前 order。*/
  order: 0;
}

.player-seats.seat-scroll .player-card {
  height: 45px;
  min-height: 45px;
  max-height: 45px;
}

.player-seats.seat-scroll .seat-move,
.player-seats.seat-scroll .seat-enter-active {
  transition: none;
}

@media (prefers-reduced-motion: reduce) {
  .player-seats {
    transition: none;
  }

  .seat-move,
  .seat-enter-active {
    transition-duration: 1ms;
  }

  .hero-pulse {
    display: none;
  }

  .cash-pill {
    animation-name: cash-pill-fade;
  }
}
</style>
