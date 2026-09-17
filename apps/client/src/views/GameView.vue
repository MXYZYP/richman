<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue';
import GameBoard from '../components/GameBoard.vue';
import PlayerRail from '../components/PlayerRail.vue';
import ActionPanel from '../components/ActionPanel.vue';
import AssetPanel from '../components/AssetPanel.vue';
import CellDetailPanel from '../components/CellDetailPanel.vue';
import PlayerAssetDialog from '../components/PlayerAssetDialog.vue';
import SettlementDialog from '../components/SettlementDialog.vue';
import PropertyAwards from '../components/PropertyAwards.vue';
import MobileSheet from '../components/MobileSheet.vue';
import { formatRecentLogEvent, getAssetRows, getCellDetail, getPendingCardChoice, getPendingPurchaseOffer, getPlayerAssetDialogModel, type ClientAction } from '../game/clientGame';
import { formatCashAnnouncement, formatMoney } from '../ui/format';
import type { CashNotice, GameSession } from '../session/gameSession';
import { getPlaybackSpeedRef, setPlaybackSpeed, paceMultiplier, PLAYBACK_SPEED_OPTIONS } from '../session/playbackPace';
import { getGameInteractionState } from '../session/gameInteraction';
import '../ui/gameTheme.css';

// One shared board for both local hot-seat and online play. Every mode difference is resolved
// by the pure interaction selector below — this view never branches on game rules or transport.
const props = defineProps<{ session: GameSession }>();
const emit = defineEmits<{ exit: [] }>();

// View-local presentation state only. It is reset whenever the session identity changes so a
// new game (or a resumed room) never inherits a stale selection or open dialog.
const selectedCellId = ref<number | null>(null);
const isSettlementDismissed = ref(false);
const isConfirmingLeave = ref(false);
const isSubmittingIntent = ref(false);
const selectedPlayerId = ref<string | null>(null);
let playerDialogTrigger: HTMLElement | null = null;
let cellDialogTrigger: HTMLElement | null = null;

// Armed once per debt occurrence (debtor:amount); the watcher below consumes it when the
// debt becomes locally actionable. Declared here so the session reset below can clear it.
const armedDebtAutoOpen = ref<string | null>(null);

// ---- Mobile shell state ----
// One media query drives the shell (dock + sheets) so CSS and JS agree on what "mobile" means.
// Switching back to desktop closes any open sheet — a native modal left open would keep locking
// the page behind the desktop layout.
type MobileSheetId = 'assets' | 'log' | 'settings';
const mobileSheet = ref<MobileSheetId | null>(null);
const mobileLayoutQuery = typeof window === 'undefined' ? null : window.matchMedia('(max-width: 1024px)');
const isMobileLayout = ref(mobileLayoutQuery?.matches ?? false);

function handleLayoutChange(event: MediaQueryListEvent): void {
  isMobileLayout.value = event.matches;
  if (!event.matches) mobileSheet.value = null;
}

mobileLayoutQuery?.addEventListener('change', handleLayoutChange);

function openMobileSheet(id: MobileSheetId): void {
  if (!isMobileLayout.value || isConfirmingLeave.value) return;
  mobileSheet.value = id;
}

function toggleMobileSheet(id: MobileSheetId): void {
  if (mobileSheet.value === id) {
    mobileSheet.value = null;
    return;
  }
  openMobileSheet(id);
}

function closeMobileSheet(): void {
  mobileSheet.value = null;
}

watch(() => props.session, () => {
  selectedCellId.value = null;
  selectedPlayerId.value = null;
  playerDialogTrigger = null;
  cellDialogTrigger = null;
  isSettlementDismissed.value = false;
  isConfirmingLeave.value = false;
  isLogExpanded.value = false;
  mobileSheet.value = null;
  armedDebtAutoOpen.value = null;
});

// Session refs surfaced as local computeds so the template auto-unwraps them and stays clean.
const playbackSpeed = getPlaybackSpeedRef();
const paceOptions = PLAYBACK_SPEED_OPTIONS;
const state = computed(() => props.session.state.value);
const displayPositions = computed(() => props.session.displayPositions.value);
const dice = computed(() => props.session.dice.value);
const activeCard = computed(() => props.session.activeCard.value);
const eventMessage = computed(() => props.session.eventMessage.value);
const lastError = computed(() => props.session.lastError.value);
const transientNotice = computed(() => props.session.transientNotice.value);
const cashNotices = computed(() => props.session.cashNotices.value);
const displayPlayers = computed(() => {
  const current = state.value;
  if (current === null) return [];
  const cash = props.session.displayCash.value;
  return current.players.map((player) => (
    cash[player.id] === undefined ? player : { ...player, cash: cash[player.id] }
  ));
});
const cashAnnouncement = computed(() => state.value === null ? '' : formatCashAnnouncement(state.value.players, cashNotices.value));
const cashAnnouncementKey = computed(() => {
  let latest: CashNotice | undefined;
  for (const notice of cashNotices.value) {
    if (
      latest === undefined
      || notice.generation > latest.generation
      || (notice.generation === latest.generation && notice.transitionId > latest.transitionId)
      || (notice.generation === latest.generation && notice.transitionId === latest.transitionId && notice.seq > latest.seq)
    ) {
      latest = notice;
    }
  }
  return latest === undefined ? '' : `${latest.generation}-${latest.transitionId}-${latest.seq}`;
});
const isBusy = computed(() => props.session.isAnimating.value || props.session.isBotThinking.value || isSubmittingIntent.value);
const playerAssetDialog = computed(() => {
  const current = state.value;
  if (current === null || current.phase !== 'playing' || selectedPlayerId.value === null) return null;
  return getPlayerAssetDialogModel(current, selectedPlayerId.value);
});

const interaction = computed(() => getGameInteractionState({
  mode: props.session.mode,
  state: props.session.state.value,
  room: props.session.room.value,
  localPlayerId: props.session.localPlayerId.value,
  connectionStatus: props.session.connectionStatus.value,
  isAnimating: isBusy.value,
  compatibilityError: props.session.compatibilityError.value,
}));

// Only reconnecting/failed surface a banner; failed additionally offers retry + home.
const connectionBanner = computed(() => {
  switch (interaction.value.kind) {
    case 'incompatible': return { tone: 'error', message: interaction.value.message, canRetry: true };
    case 'reconnecting': return { tone: 'warning', message: interaction.value.message, canRetry: false };
    case 'failed': return { tone: 'error', message: lastError.value ?? interaction.value.message, canRetry: true };
    default: return null;
  }
});

// The interaction selector owns the spectator decision (room.spectators + local member id);
// the view only forwards it so read-only affordances never re-derive membership themselves.
const isSpectator = computed(() => interaction.value.kind === 'spectating');
const actionPanelError = computed(() => (connectionBanner.value !== null ? null : lastError.value));
const availableActions = computed(() => (
  isSpectator.value ? [] : props.session.availableActions.value
));

const activeActorId = computed(() => {
  const current = state.value;
  return current === null ? '' : (current.debt?.debtorId ?? current.currentPlayerId);
});
const activeActor = computed(() => state.value?.players.find((player) => player.id === activeActorId.value));
const activeActorName = computed(() => activeActor.value?.nickname ?? activeActorId.value);
const activeDebtAmount = computed(() => state.value?.debt?.amount ?? null);
const assetRows = computed(() => (state.value === null ? [] : getAssetRows(state.value, activeActorId.value)));
const pendingPurchaseOffer = computed(() => (state.value === null ? null : getPendingPurchaseOffer(state.value)));
// 单机真人作弊：待确认卡牌来自权威快照（刷新/恢复后依然存在），与动画中的 activeCard 互补。
const pendingCardChoice = computed(() => (state.value === null ? null : getPendingCardChoice(state.value)));
const selectedCellDetail = computed(() => (
  state.value === null || selectedCellId.value === null ? null : getCellDetail(state.value, selectedCellId.value)
));
const currentCellDetail = computed(() => {
  const current = state.value;
  const actor = activeActor.value;
  if (current === null || !actor) return null;
  // 棋子动画期间 displayPositions 逐格变化。若位置卡跟着每格重算，下部区域会一格一换内容
  // → 视觉上来回切换、闪烁。动画期间改用权威位置（起点）把卡片冻结住；
  // 动画结束后 state 与 displayPositions 同步到终点，整段只切换一次。
  const position = props.session.isAnimating.value
    ? actor.position
    : (displayPositions.value[actor.id] ?? actor.position);
  return getCellDetail(current, position);
});
const locationRent = computed(() => {
  const detail = currentCellDetail.value;
  if (!detail) return null;
  const base = detail.ownerName === null ? detail.rentRows[0] : undefined;
  if (base) return { label: '基础租金', amount: base.amount };
  const amount = detail.currentRent?.amount;
  return amount === null || amount === undefined ? null : { label: '当前租金', amount };
});
const actionPanelEventMessage = computed(() => {
  const current = state.value;
  const message = eventMessage.value;
  if (!current) return message;
  const playerId = activeActorId.value;
  // Dice and destination already have dedicated visible regions; keep other events intact.
  if (dice.value && message === formatRecentLogEvent(current, { type: 'dice_rolled', playerId, dice: dice.value })) return '';
  // 逐格推进时 presenter 会把提示语改写成「移动到 X」。按“正在走的那一格”比对后隐藏，
  // 否则下部文字会随每格刷新而一格一跳（闪烁）；落定后仍由终点继续隐藏（原逻辑）。
  const movingCellId = displayPositions.value[playerId] ?? activeActor.value?.position;
  const settledCellId = currentCellDetail.value?.cellId;
  for (const cellId of [movingCellId, settledCellId]) {
    if (cellId === undefined || cellId === null) continue;
    if (message === formatRecentLogEvent(current, { type: 'token_moved', playerId, path: [cellId] })) return '';
  }
  return message;
});
const activeActorCash = computed(() => displayPlayers.value.find((player) => player.id === activeActorId.value)?.cash ?? null);
const COLLAPSED_LOG_COUNT = 3;
const EXPANDED_LOG_COUNT = 30;
const isLogExpanded = ref(false);
const recentLogMessages = computed(() => {
  const current = state.value;
  if (current === null) return [];
  return current.recentLog.slice(-EXPANDED_LOG_COUNT).map((event) => formatRecentLogEvent(current, event));
});
const recentLogs = computed(() => (
  isLogExpanded.value ? recentLogMessages.value : recentLogMessages.value.slice(-COLLAPSED_LOG_COUNT)
));
const canToggleLog = computed(() => recentLogMessages.value.length > COLLAPSED_LOG_COUNT);
const shouldShowSettlement = computed(() => state.value?.phase === 'game_over' && !isSettlementDismissed.value);

// ---- Debt surfacing on mobile ----
// A locally actionable debt (human debtor, calm state, this client may send intents) auto-opens
// the assets sheet once per debt so liquidation is never a hunt. Observers, bot turns, and
// mid-animation states never steal focus; once the user closes the sheet the debt strip in the
// dock keeps the debt visible until it is resolved.
const debtDebtorIsHuman = computed(() => {
  const current = state.value;
  const debtorId = current?.debt?.debtorId;
  if (current === null || debtorId === undefined || debtorId === null) return false;
  const debtor = current.players.find((player) => player.id === debtorId);
  return debtor !== undefined && !debtor.isBot;
});
const localDebtSignature = computed(() => {
  const debt = state.value?.debt;
  return debt === null || debt === undefined ? null : `${debt.debtorId}:${debt.amount}`;
});
watch([() => props.session, localDebtSignature], ([, signature], [, previous]) => {
  armedDebtAutoOpen.value = signature;
  if (previous && signature === null && mobileSheet.value === 'assets') closeMobileSheet();
}, { immediate: true });
const debtSheetAutoOpenReady = computed(() => (
  armedDebtAutoOpen.value !== null
  && localDebtSignature.value === armedDebtAutoOpen.value
  && state.value?.phase === 'playing'
  && isMobileLayout.value
  && debtDebtorIsHuman.value
  && !isBusy.value
  && interaction.value.canSendIntent
));
watch(debtSheetAutoOpenReady, (ready) => {
  if (!ready) return;
  armedDebtAutoOpen.value = null;
  openMobileSheet('assets');
}, { immediate: true, flush: 'post' });

// Every online exit is confirmed first (leaving or abandoning a shared room is destructive);
// a local hot-seat restart never is. The pure interaction selector owns that rule so the view
// never re-derives it. The confirm copy adapts to whether we can still notify the room.
const needsLeaveConfirm = computed(() => interaction.value.requiresLeaveConfirm);
const exitLabel = computed(() => (props.session.mode === 'local' ? '保存并返回首页' : '离开房间'));
const settlementPrimaryLabel = computed(() => (props.session.mode === 'local' ? '再开一局' : '离开房间'));
// A connected exit leaves gracefully over the socket (progress stays in the room); a severed
// connection can only abandon locally, discarding the stored session — the dialog says so.
const canNotifyRoom = computed(() => props.session.connectionStatus.value === 'connected');
const leaveConfirmTitle = computed(() => (canNotifyRoom.value ? '离开房间？' : '放弃这局？'));
const leaveConfirmBody = computed(() => (canNotifyRoom.value
  ? '离开后本局进度会保留在房间，你之后可以从首页回到上一局继续。'
  : '当前连接已断开，无法通知房间。放弃后会清除本地存档并返回首页。'));
const leaveConfirmLabel = computed(() => (canNotifyRoom.value ? '确认离开' : '放弃这局'));

function openPlayerAssets(playerId: string, trigger: HTMLButtonElement): void {
  const current = state.value;
  if (current === null || current.phase !== 'playing') return;
  if (!current.players.some((player) => player.id === playerId)) return;
  playerDialogTrigger = trigger;
  selectedPlayerId.value = playerId;
}

function closePlayerAssets(): void {
  const trigger = playerDialogTrigger;
  selectedPlayerId.value = null;
  playerDialogTrigger = null;
  void nextTick(() => trigger?.focus());
}

watch(state, (current, previous) => {
  if (previous?.phase === 'playing' && current?.phase !== 'playing') {
    selectedCellId.value = null;
    cellDialogTrigger = null;
    // Leaving play (settlement above all) closes any open mobile sheet so the next layer —
    // the settlement dialog — is visible and nothing stays locked behind it.
    mobileSheet.value = null;
  }

  if (selectedPlayerId.value === null) return;
  const selectionIsValid = current?.phase === 'playing'
    && current.players.some((player) => player.id === selectedPlayerId.value);
  if (selectionIsValid) return;
  selectedPlayerId.value = null;
  playerDialogTrigger = null;
});

function requestExit() {
  if (isConfirmingLeave.value) return;
  if (needsLeaveConfirm.value) {
    isConfirmingLeave.value = true;
    return;
  }
  emit('exit');
}

// Exit lives inside the settings sheet: close the native sheet first so the leave-confirm
// dialog (and its focus trap) is never fighting a top-layer sheet for the screen.
function requestExitFromSheet(): void {
  if (needsLeaveConfirm.value) leaveTrigger = settingsTrigger.value;
  closeMobileSheet();
  requestExit();
}

function confirmLeave() {
  isConfirmingLeave.value = false;
  emit('exit');
}

function cancelLeave() {
  isConfirmingLeave.value = false;
}

async function handleAction(action: ClientAction) {
  if (isConfirmingLeave.value || isSubmittingIntent.value) return;
  if (!interaction.value.canSendIntent) return;
  isSubmittingIntent.value = true;
  try {
    await props.session.sendIntent(action.intent);
  } finally {
    isSubmittingIntent.value = false;
  }
}

function handleSkipOfflineTurn() {
  if (isConfirmingLeave.value) return;
  if (!interaction.value.canSkipOfflineTurn) return;
  void props.session.skipOfflineTurn();
}

function handleRetry() {
  if (isConfirmingLeave.value) return;
  void props.session.retryResume?.();
}

// ---- Leave-confirm modal focus containment ----
// The dialog traps Tab focus, closes on Escape, and inerts the background board so keyboard
// and pointer never reach a control behind it; focus returns to the trigger when it closes.
const confirmDialog = ref<HTMLElement | null>(null);
const settingsTrigger = ref<HTMLButtonElement | null>(null);
let leaveTrigger: HTMLElement | null = null;

function focusablesWithin(root: HTMLElement): HTMLElement[] {
  const selector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  return [...root.querySelectorAll<HTMLElement>(selector)].filter((element) => (
    !element.hasAttribute('disabled') && element.tabIndex !== -1
  ));
}

function onModalKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    cancelLeave();
    return;
  }
  if (event.key !== 'Tab') return;
  const root = confirmDialog.value;
  if (root === null) return;
  const focusables = focusablesWithin(root);
  if (focusables.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  const withinDialog = active instanceof HTMLElement && root.contains(active);
  if (event.shiftKey && (active === first || !withinDialog)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !withinDialog)) {
    event.preventDefault();
    first.focus();
  }
}

watch(isConfirmingLeave, (confirming) => {
  if (confirming) {
    leaveTrigger ??= document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.addEventListener('keydown', onModalKeydown, true);
    void nextTick(() => {
      const root = confirmDialog.value;
      if (root === null) return;
      const primary = root.querySelector<HTMLElement>('.confirm-leave');
      (primary ?? focusablesWithin(root)[0] ?? root).focus();
    });
  } else {
    document.removeEventListener('keydown', onModalKeydown, true);
    // Restore focus after the flush: the background only sheds its `inert` on re-render, and a
    // focus() into a still-inert subtree is ignored, so the trigger must be refocused post-DOM.
    const trigger = leaveTrigger;
    leaveTrigger = null;
    void nextTick(() => trigger?.focus());
  }
});

// ---- 折叠屏 / 旋转屏的视口重算 ----
// 折叠屏展开↔折叠、或旋转屏幕时，部分 WebView 不会及时重算视口尺寸，
// 棋盘可能停留在折叠前的旧尺寸（极端情况高度被算成 0 → 地图不显示）。
// 监听 resize / orientationchange / visualViewport 三类变化，触发一次重渲染 + 强制重排。
const layoutEpoch = ref(0);
function bumpLayout(): void {
  layoutEpoch.value += 1;
  void document.body?.offsetHeight; // 读一次布局属性，强制同步重排
  // 顺带重测棋盘容器：折叠/旋转后宽高比会变，必须重新取 min(宽,高)。
  measureBoardStage();
}

// ---- 棋盘尺寸：实测容器，而不是猜视口 ----
// vh/dvh/svh 都以“视口”为基准，而棋盘真正能用的是“棋盘容器”的大小；
// 折叠屏内屏、平板这类近正方形视口下二者差异极大，正方形棋盘会被算得比可视区还高而被裁掉。
// 这里用 ResizeObserver 实测容器像素尺寸，取 min(宽, 高) 写进 --board-size。
// 容器高度由布局固定（棋盘 56% / 栅格 1fr），不随内容变化，因此不存在“改尺寸→再触发”的回环。
const boardStageRef = ref<HTMLElement | null>(null);
const boardSize = ref(0);
let stageObserver: ResizeObserver | null = null;

function measureBoardStage(): void {
  const el = boardStageRef.value;
  if (!el) return;
  const width = el.clientWidth;
  const height = el.clientHeight;
  if (width <= 0 || height <= 0) return;
  const size = Math.floor(Math.min(width, height));
  if (size > 0 && size !== boardSize.value) boardSize.value = size;
}

const boardStageStyle = computed<CSSProperties | undefined>(() => (
  boardSize.value > 0 ? { '--board-size': `${boardSize.value}px` } : undefined
));

// 棋盘容器是在 state 就绪后才挂载的（v-if="state"），所以要在元素出现时再挂 observer，
// 否则首屏对局数据还没到、观察的是 null，之后再也不会重测。
watch(boardStageRef, (element) => {
  stageObserver?.disconnect();
  stageObserver = null;
  if (!element || typeof ResizeObserver === 'undefined') return;
  measureBoardStage();
  stageObserver = new ResizeObserver(() => measureBoardStage());
  stageObserver.observe(element);
});

// 对局期间给 body 打标记：移动端据此只锁对局页的文档滚动（见 style.css），
// 首页/大厅等页面不受影响、可正常滚动；离开对局时移除标记。
onMounted(() => {
  document.body.classList.add('game-view-active');
  window.addEventListener('resize', bumpLayout);
  window.addEventListener('orientationchange', bumpLayout);
  window.visualViewport?.addEventListener('resize', bumpLayout);
  // 首帧先测一次；随后容器任何尺寸变化（折叠、旋转、分屏、地址栏）都由 observer 兜住。
  measureBoardStage();
  void nextTick(measureBoardStage);
  if (typeof ResizeObserver !== 'undefined' && boardStageRef.value !== null) {
    stageObserver = new ResizeObserver(() => measureBoardStage());
    stageObserver.observe(boardStageRef.value);
  }
});

onBeforeUnmount(() => {
  document.body.classList.remove('game-view-active');
  stageObserver?.disconnect();
  stageObserver = null;
  window.removeEventListener('resize', bumpLayout);
  window.removeEventListener('orientationchange', bumpLayout);
  window.visualViewport?.removeEventListener('resize', bumpLayout);
  document.removeEventListener('keydown', onModalKeydown, true);
  mobileLayoutQuery?.removeEventListener('change', handleLayoutChange);
  selectedPlayerId.value = null;
  playerDialogTrigger = null;
  cellDialogTrigger = null;
});

function handleSelectCell(cellId: number) {
  cellDialogTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  selectedCellId.value = cellId;
}

function clearSelectedCell() {
  const trigger = cellDialogTrigger;
  selectedCellId.value = null;
  cellDialogTrigger = null;
  void nextTick(() => trigger?.focus());
}

function inspectFinalBoard() {
  isSettlementDismissed.value = true;
}
</script>

<template>
  <div class="game-view" :style="{ '--game-motion-pace': paceMultiplier() }">
    <div v-if="connectionBanner" class="connection-banner" :class="connectionBanner.tone" role="status" aria-live="polite" :inert="isConfirmingLeave">
      <span class="banner-text">{{ connectionBanner.message }}</span>
      <div v-if="connectionBanner.canRetry" class="banner-actions">
        <button type="button" class="banner-retry" @click="handleRetry">重试</button>
        <button type="button" class="banner-home" @click="requestExit">返回首页</button>
      </div>
    </div>

    <div
      v-if="transientNotice"
      :key="transientNotice.id"
      class="transient-toast"
      :class="{ 'transient-toast--standalone': !connectionBanner }"
      role="status"
      aria-live="polite"
    >{{ transientNotice.message }}</div>

    <div
      v-if="state && cashAnnouncement"
      :key="cashAnnouncementKey"
      class="sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >{{ cashAnnouncement }}</div>

    <main v-if="state" class="game-shell" :data-layout-epoch="layoutEpoch" :inert="isConfirmingLeave">
      <header class="players">
        <div class="game-meta">
          <span>{{ state.board.boardName }} / {{ state.players.length }} 人对局</span>
          <span>{{ session.mode === 'local' ? '本地游戏' : '联机游戏' }}</span>
        </div>
        <PlayerRail
          :players="displayPlayers"
          :current-player-id="activeActorId"
          :interactive="state.phase === 'playing'"
          :cash-notices="cashNotices"
          @select-player="openPlayerAssets"
        />
      </header>
      <div ref="boardStageRef" class="board-stage" :style="boardStageStyle">
        <GameBoard
          class="board full-board"
          :state="state"
          :display-positions="displayPositions"
          :selected-cell-id="selectedCellId"
          @select-cell="handleSelectCell"
        />
      </div>
      <aside class="side-panel">
        <button type="button" class="restart-button restart-desktop" @click="requestExit">{{ exitLabel }}</button>
        <Teleport to="body" :disabled="!isMobileLayout">
          <MobileSheet
            class="sheet sheet-settings"
            :open="isMobileLayout && mobileSheet === 'settings'"
            title="设置"
            @close="closeMobileSheet"
          >
            <div class="pace-control" role="group" aria-label="动画速度">
              <span class="pace-label">动画</span>
              <button
                v-for="option in paceOptions"
                :key="option.value"
                type="button"
                class="pace-option"
                :class="{ 'pace-active': option.value === playbackSpeed }"
                :aria-pressed="option.value === playbackSpeed"
                @click="setPlaybackSpeed(option.value)"
              >{{ option.label }}</button>
            </div>
            <button type="button" class="restart-button restart-mobile" @click="requestExitFromSheet">{{ exitLabel }}</button>
          </MobileSheet>
        </Teleport>
        <ActionPanel
          compact-purchase
          :actions="availableActions"
          :dice="dice"
          :active-card="activeCard"
          :event-message="actionPanelEventMessage"
          :is-animating="isBusy"
          :last-error="actionPanelError"
          :turn-title="interaction.message ?? ''"
          :is-spectator="isSpectator"
          :purchase-offer="pendingPurchaseOffer"
          :pending-card="pendingCardChoice"
          @action="handleAction"
        />
        <!-- 位置/欠款属于可变信息：一律排在操作面板下方，永不挤动按钮行。-->
        <button
          v-if="currentCellDetail"
          type="button"
          class="location-card"
          aria-haspopup="dialog"
          :aria-label="`查看当前位置详情：${currentCellDetail.name}`"
          @click="handleSelectCell(currentCellDetail.cellId)"
        >
          <span class="location-title">
            <strong>{{ currentCellDetail.name }}</strong>
            <b v-if="currentCellDetail.price !== null" class="location-price">¥{{ formatMoney(currentCellDetail.price) }}</b>
          </span>
          <span class="location-details">
            <span>
              {{ currentCellDetail.ownerName ?? (currentCellDetail.price !== null ? '无主地产' : currentCellDetail.typeLabel) }}
              <template v-if="currentCellDetail.levelLabel !== null">
                · {{ currentCellDetail.levelLabel }}
              </template>
              <template v-if="locationRent">
                · {{ locationRent.label }} ¥{{ formatMoney(locationRent.amount) }}
              </template>
            </span>
            <b v-if="activeActorCash !== null">可用现金 ¥{{ formatMoney(activeActorCash) }}</b>
          </span>
        </button>
        <div v-if="activeDebtAmount !== null" class="mobile-debt-strip" role="status">
          <span>{{ activeActorName }} 欠款 ¥{{ formatMoney(activeDebtAmount) }}</span>
          <button type="button" class="debt-strip-action" @click="openMobileSheet('assets')">{{ isSpectator ? '查看资产' : '处理资产' }}</button>
        </div>
        <button
          v-if="interaction.canSkipOfflineTurn"
          type="button"
          class="takeover-button"
          @click="handleSkipOfflineTurn"
        >
          托管本回合
        </button>
        <Teleport to="body" :disabled="!isMobileLayout">
          <MobileSheet
            class="sheet sheet-assets"
            :open="isMobileLayout && mobileSheet === 'assets'"
            :title="isSpectator ? '资产详情' : '我的资产'"
            @close="closeMobileSheet"
          >
            <AssetPanel
              :actor-name="activeActorName"
              :actor-cash="activeActorCash"
              :debt-amount="activeDebtAmount"
              :assets="assetRows"
              :is-animating="isBusy || !interaction.canSendIntent"
              :read-only="isSpectator"
              @action="handleAction"
            />
          </MobileSheet>
        </Teleport>
        <Teleport to="body" :disabled="!isMobileLayout">
          <MobileSheet
            class="sheet sheet-log"
            :open="isMobileLayout && mobileSheet === 'log'"
            title="战报记录"
            @close="closeMobileSheet"
          >
            <section class="log-card" aria-label="战报记录">
              <header>
                <span>战报记录</span>
                <strong>最近 {{ recentLogs.length }} 条</strong>
              </header>
              <p v-if="recentLogs.length === 0" class="log-empty">旅程刚刚开始，行动记录会显示在这里。</p>
              <ol>
                <li v-for="(message, index) in recentLogs" :key="index">
                  <span class="log-dot" aria-hidden="true"></span>
                  <p>{{ message }}</p>
                </li>
              </ol>
              <button v-if="canToggleLog" type="button" class="log-toggle" @click="isLogExpanded = !isLogExpanded">
                {{ isLogExpanded ? '收起战报' : `展开全部（共 ${recentLogMessages.length} 条）` }}
              </button>
            </section>
            <PropertyAwards v-if="state?.phase === 'playing'" :state="state" />
          </MobileSheet>
        </Teleport>
        <nav class="mobile-dock-bar" aria-label="游戏工具">
          <button
            type="button"
            class="dock-entry"
            aria-haspopup="dialog"
            :aria-expanded="mobileSheet === 'assets'"
            @click="toggleMobileSheet('assets')"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h18v12H3zM7 8V4h10v4M3 13h18M10 12v3h4v-3" /></svg>
            资产<span v-if="activeDebtAmount !== null" class="dock-debt-dot" aria-hidden="true"></span>
          </button>
          <button
            type="button"
            class="dock-entry"
            aria-haspopup="dialog"
            :aria-expanded="mobileSheet === 'log'"
            @click="toggleMobileSheet('log')"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h14v18H5zM8 7h8M8 11h8M8 15h5" /></svg>
            战报
          </button>
          <button
            ref="settingsTrigger"
            type="button"
            class="dock-entry"
            aria-haspopup="dialog"
            :aria-expanded="mobileSheet === 'settings'"
            @click="toggleMobileSheet('settings')"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" /></svg>
            设置
          </button>
        </nav>
      </aside>
    </main>

    <CellDetailPanel
      v-if="selectedCellDetail"
      :detail="selectedCellDetail"
      @close="clearSelectedCell"
    />

    <PlayerAssetDialog
      v-if="playerAssetDialog && state"
      :player="playerAssetDialog.player"
      :current-player-id="state.currentPlayerId"
      :position-name="playerAssetDialog.positionName"
      :debt-amount="playerAssetDialog.debtAmount"
      :assets="playerAssetDialog.assets"
      @close="closePlayerAssets"
    />

    <SettlementDialog
      v-if="shouldShowSettlement && state"
      :state="state"
      :primary-label="settlementPrimaryLabel"
      :inert="isConfirmingLeave"
      @restart="requestExit"
      @close="inspectFinalBoard"
    />

    <div v-if="isConfirmingLeave" class="confirm-backdrop" role="presentation">
      <section
        ref="confirmDialog"
        class="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="leave-confirm-title"
        aria-describedby="leave-confirm-body"
      >
        <h2 id="leave-confirm-title">{{ leaveConfirmTitle }}</h2>
        <p id="leave-confirm-body">{{ leaveConfirmBody }}</p>
        <div class="confirm-actions">
          <button type="button" class="confirm-cancel" @click="cancelLeave">继续游戏</button>
          <button type="button" class="confirm-leave" @click="confirmLeave">{{ leaveConfirmLabel }}</button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.game-view {
  /* 对局页恒定铺满视口：整页钉死，不用 vh/dvh/svh，也不让文档参与滚动。
     此前只在 ≤767px 生效，导致折叠屏内屏/平板（宽度 ≥768px 但形态仍是移动设备）
     走的是桌面分支：文档可滚动 → 内容一变就顶高 → 地址栏显隐 → 视口单位重算 →
     整页“放大缩小、位移”。改为无条件钉死后，任何设备的页面尺寸都只由视口决定。*/
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  overscroll-behavior: none;
  /* 大富翁氛围底：牌桌暖绿 + 顶部柔光 + 细点阵（骰子点/地契纸感）+ 边缘微暗角。
     四层全是背景绘制，不参与布局、不触发重排，也不额外增加绘制层。 */
  background-color: var(--game-page);
  background-image:
    radial-gradient(circle, rgb(87 107 71 / 9%) 1.1px, transparent 1.3px),
    radial-gradient(105% 68% at 50% 0%, rgb(255 255 255 / 72%), transparent 58%),
    radial-gradient(78% 58% at 50% 38%, rgb(193 219 170 / 32%), transparent 72%),
    linear-gradient(180deg, rgb(255 255 255 / 22%), rgb(94 114 76 / 10%));
  background-size: 26px 26px, auto, auto, auto;
  background-repeat: repeat, no-repeat, no-repeat, no-repeat;
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

.transient-toast {
  padding: 10px 16px;
  background: var(--banner-warning-bg);
  color: var(--color-warning);
  font-weight: 900;
}

.transient-toast--standalone {
  padding-top: max(10px, env(safe-area-inset-top));
}

.connection-banner {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  font-weight: 900;
}

.connection-banner.warning {
  background: var(--banner-warning-bg);
  color: var(--color-warning);
}

.connection-banner.error {
  background: var(--banner-error-bg);
  color: var(--color-pay);
}

.banner-actions {
  display: flex;
  gap: 8px;
}

.banner-retry,
.banner-home {
  min-height: 40px;
  padding: 0 16px;
  border-radius: 12px;
  border: 1px solid currentcolor;
  font-weight: 900;
  cursor: pointer;
}

.banner-retry {
  background: var(--game-action-bg);
  color: var(--button-enabled-text);
  border-color: var(--color-primary);
}

.banner-home {
  background: transparent;
  color: inherit;
}

.game-shell {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  /* 侧栏宽度随视口在 280–360px 间流动：窄屏更紧凑、宽屏更舒展，避免固定 340px 在平板上过挤 */
  grid-template-columns: minmax(0, 1fr) clamp(280px, 26vw, 360px);
  grid-template-rows: auto minmax(0, 1fr);
  gap: clamp(10px, 1.4vw, 14px);
  padding: clamp(10px, 1.6vw, 16px);
  max-width: 1500px;
  margin-inline: auto;
}

.players {
  grid-column: 1 / -1;
}

.game-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  min-height: 18px;
  align-items: center;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--color-muted);
}

/* Mobile sheets double as transparent grouping wrappers on desktop: the dialog box vanishes
   (display: contents) and its children keep flowing inside the side panel exactly as before. */
.sheet {
  display: contents;
}

/* Mobile-only affordances are hidden on the desktop sidebar. */
.mobile-debt-strip,
.mobile-dock-bar {
  display: none;
}

.side-panel {
  display: grid;
  align-content: start;
  gap: 14px;
  /* 底部信息区高度约束：抽到命运牌/事件卡时内容会变多，若任其撑高，整页会被顶高再缩回
     → 视觉“抽搐跳动”。这里把区域锁定在可用高度内、超出改为区域内滚动，页面尺寸恒定。
     min-height:0 是 grid/flex 子项能收缩到容器高度的前提。*/
  min-height: 0;
  max-height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  /* 关键：关掉滚动锚定（scroll anchoring）。内容增减时浏览器会自动补偿 scrollTop，
     配合任何滚动动画都会表现为整个面板“漂移”；关掉后滚动位置只由用户手势决定。*/
  overflow-anchor: none;
}

.location-card {
  display: grid;
  align-content: center;
  gap: 7px;
  min-width: 0;
  min-height: 72px;
  width: 100%;
  padding: 10px 13px 7px;
  border: 0;
  border-bottom: 1px solid var(--color-border);
  border-radius: 0;
  background: var(--game-panel);
  color: var(--color-text);
  text-align: left;
  cursor: pointer;
}

.location-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-left: 8px;
  border-left: 3px solid var(--color-accent);
}

.location-title strong {
  min-width: 0;
  font-size: 15px;
  line-height: 22px;
  overflow-wrap: anywhere;
}

.location-price {
  flex-shrink: 0;
  color: var(--price-color);
  font: 700 20px/1.1 var(--game-mono);
  letter-spacing: -0.6px;
  font-variant-numeric: tabular-nums;
}

/* 位置卡高度恒定：不同格子的文案长短不一时，wrap 会换行把下方区域顶高又缩回
   （高度跳动 = 闪动感来源之一）。改为单行 + 省略号，配合 min-height 保证盒子尺寸不变。 */
.location-details {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  font-size: 10px;
  line-height: 16px;
  color: var(--color-muted);
}

.location-details > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.location-details b {
  flex-shrink: 0;
  color: var(--color-text);
  font-weight: 500;
}

.location-card:active {
  background: var(--button-disabled-bg);
}

.restart-button,
.takeover-button {
  min-height: 44px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  font-weight: 700;
  cursor: pointer;
}

.restart-button {
  background: var(--board-surface);
  color: var(--color-primary);
}

.restart-mobile {
  display: none;
}


.pace-control {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--board-surface);
  font-size: 12px;
  font-weight: 700;
  color: var(--color-text);
}

.pace-label {
  color: var(--color-muted);
  margin-right: 2px;
}

.pace-option {
  flex: 1;
  min-height: 44px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.pace-option.pace-active {
  background: var(--color-primary);
  color: #fff;
}

.pace-option:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.takeover-button {
  background: var(--color-accent);
  color: var(--color-text);
  border-color: var(--color-accent);
}

.log-card {
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--board-surface);
  box-shadow: 0 2px 0 color-mix(in srgb, var(--center-border) 40%, transparent);
}

.log-card header {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: baseline;
  margin-bottom: 8px;
}

.log-card header span {
  color: var(--title-color);
  font-size: 1rem;
  font-weight: 800;
}

.log-card header strong {
  color: var(--color-muted);
  font-size: 11px;
}

.log-card ol {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.log-card li {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  padding: 8px 0;
  border-bottom: 1px solid var(--color-border);
}

.log-dot {
  width: 5px;
  height: 5px;
  margin-top: 7px;
  border-radius: 50%;
  background: var(--color-accent);
}

.log-card p {
  margin: 0;
  color: var(--color-text);
  font-size: 13px;
  font-weight: 400;
  line-height: 1.6;
}
.log-toggle {
  margin-top: 8px;
  width: 100%;
  min-height: 44px;
  border: 1px solid var(--color-border);
  border-radius: 9px;
  background: transparent;
  color: var(--color-primary);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}

.log-toggle:active {
  background: rgb(255 255 255 / 80%);
}

.confirm-backdrop {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 18px;
  background: var(--overlay-scrim);
  z-index: 20;
}

.confirm-dialog {
  width: min(400px, 100%);
  display: grid;
  gap: 14px;
  padding: clamp(20px, 4vw, 30px);
  border: 1px solid var(--color-border);
  border-radius: 16px;
  background: var(--board-surface);
  box-shadow: 0 16px 40px rgb(53 39 20 / 18%);
}

.confirm-dialog h2 {
  margin: 0;
  color: var(--color-primary);
  font-size: 1.4rem;
}

.confirm-dialog p {
  margin: 0;
  color: var(--color-muted);
  font-weight: 700;
  line-height: 1.45;
}

.confirm-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

.confirm-cancel,
.confirm-leave {
  min-height: 44px;
  padding: 0 18px;
  border-radius: 14px;
  font-weight: 900;
  cursor: pointer;
}

.confirm-cancel {
  border: 1px solid var(--color-border);
  background: rgb(255 255 255 / 72%);
  color: var(--color-text);
}

.confirm-leave {
  border: 1px solid var(--color-primary);
  background: var(--game-action-bg);
  color: var(--button-enabled-text);
}

/* ---- 交互反馈 ----
   统一 140ms 过渡：悬停微亮、按压下沉。只动 transform / 背景 / 阴影这类合成层属性，
   不触发重排重绘，动效灵动但几乎不影响性能。 */
.dock-entry,
.pace-option,
.log-toggle,
.restart-button,
.takeover-button,
.location-card,
.banner-retry,
.banner-home {
  transition:
    transform 140ms ease,
    background-color 140ms ease,
    box-shadow 140ms ease,
    color 140ms ease;
}

.dock-entry:hover,
.pace-option:hover,
.log-toggle:hover {
  background: rgb(255 255 255 / 62%);
}

.dock-entry:active,
.pace-option:active {
  transform: scale(0.96);
}

.restart-button:hover,
.takeover-button:hover {
  box-shadow: 0 2px 0 color-mix(in srgb, var(--center-border) 55%, transparent);
}

.restart-button:active,
.takeover-button:active,
.log-toggle:active {
  transform: translateY(1px);
}

.location-card:hover {
  background: color-mix(in srgb, var(--board-surface) 90%, #fff);
}

/* 尊重系统的“减弱动态效果”设置。 */
@media (prefers-reduced-motion: reduce) {
  .dock-entry,
  .pace-option,
  .log-toggle,
  .restart-button,
  .takeover-button,
  .location-card,
  .banner-retry,
  .banner-home {
    transition: none;
  }
}

/* 紧凑布局断点 1024px（原 767px）。
   折叠屏内屏、小平板的 CSS 宽度普遍在 768–1024 之间，用 767 会把它们误判成桌面，
   于是拿不到竖排布局、也拿不到底部操作坞——这正是“内屏展开态地图不完整”的来源。 */
@media (max-width: 1024px) {
  .game-shell {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: env(safe-area-inset-top) 0 0;
    gap: 0;
  }

  .players,
  .board-stage,
  .side-panel {
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }

  /* 三段高度全部按比例写死，绝不随内容变化：
     玩家条 auto（内部 50px 定高）+ 棋盘 56% + 侧栏吃掉剩余。
     内容再长也只让侧栏内部滚动，棋盘尺寸恒定 → 抽牌/切人都不再抽搐漂移。*/
  .players {
    flex: 0 0 auto;
    padding: 0 7px;
    background: #e5e7dc;
  }

  .board-stage {
    /* 0 0 56%：不吃内容高度、也不参与伸缩，高度恒定 = 棋盘可用高度。
       棋盘尺寸由脚本实测这个盒子后写入 --board-size（见 measureBoardStage）。*/
    flex: 0 0 56%;
    min-height: 0;
    padding: 0 6px;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    place-items: center;
    overflow: hidden;
  }

  .board-stage > .full-board {
    margin: 0 auto;
  }

  /* The viewport shell places this dock at the bottom without overlaying the board.
     On short screens or with enlarged text, both remain reachable in document flow. */
  /* 控制面板内部滚动：min-height:0 让 flex 子项可以收缩，overflow-y:auto 接管滚动，
     这样整页文档高度恒定，地址栏不会因内容增减而显隐（即消除“大小大小闪”）。*/
  .side-panel {
    /* 1 1 0：基准为 0，高度 = 剩余空间（恒定），内容超出就内部滚动，
       因此命运牌把内容变长时不会顶到棋盘。*/
    flex: 1 1 0;
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    width: 100%;
    position: relative;
    z-index: 10;
    display: flex;
    flex-direction: column;
    gap: 0;
    margin: 0;
    padding: 0 0 env(safe-area-inset-bottom);
    background: transparent;
  }

  .restart-desktop {
    display: none;
  }

  .restart-mobile {
    display: block;
    width: 100%;
  }

  /* Debt stays on screen even with every sheet closed: an always-visible strip in the dock
     names the debtor and jumps straight into liquidation. */
  .mobile-debt-strip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 6px 6px 12px;
    border: 1px solid var(--color-pay);
    border-radius: 12px;
    background: var(--banner-error-bg);
    color: var(--color-pay);
    font-size: 12px;
    font-weight: 900;
  }

  .debt-strip-action {
    min-height: 44px;
    padding: 0 12px;
    border: none;
    border-radius: 9px;
    background: var(--color-pay);
    color: #fff;
    font-size: 12px;
    font-weight: 900;
    cursor: pointer;
    flex-shrink: 0;
  }

  .mobile-dock-bar {
    /* 控制面板改为内部滚动后，让底部操作坞始终吸底可见，不被滚走。*/
    position: sticky;
    bottom: 0;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    min-height: 50px;
    padding: 2px 12px 3px;
    border-top: 1px solid var(--color-border);
    background: #e4e8d9;
  }

  .dock-entry {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-height: 44px;
    border: 1px solid transparent;
    border-radius: 9px;
    background: transparent;
    color: var(--color-muted);
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
  }

  .dock-entry svg {
    width: 17px;
    height: 17px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .location-card {
    min-height: 72px;
  }

  .dock-entry:active {
    background: #fff;
  }

  .dock-debt-dot {
    position: absolute;
    top: 7px;
    right: 9px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-pay);
  }

  /* Sheets exist only as open dialogs on mobile; a closed one must stay display:none so the
     dock does not grow its contents. */
  .sheet {
    display: none;
  }

  .sheet[open] {
    display: block;
  }
}

@media (max-width: 1024px) and (orientation: landscape) {
  .game-shell {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(260px, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }

  .players {
    grid-column: 2;
    grid-row: 1;
  }

  .board-stage {
    grid-column: 1;
    grid-row: 1 / -1;
    min-height: 0;
  }

  .side-panel {
    grid-column: 2;
    grid-row: 2;
    position: static;
    width: 100%;
    margin: 0;
    padding: 8px;
    border-radius: 16px;
  }

  /* 操作面板保持顶部锚定：底对齐会让按钮行随信息长度上下浮动。
     导航条改用自己的 auto 外边距留在侧栏底部。*/
  .mobile-dock-bar {
    margin-top: auto;
  }
}

/* 矮视口（折叠屏内屏横屏、平板横屏、分屏多窗口）：压缩留白与头部，把高度让给棋盘。 */
@media (max-height: 620px) {
  .game-shell {
    gap: 8px;
    padding: 8px;
  }

  .players {
    padding: 0 4px;
  }

  .game-meta {
    min-height: 14px;
    font-size: 10px;
  }

  .side-panel {
    gap: 10px;
  }
}
</style>
