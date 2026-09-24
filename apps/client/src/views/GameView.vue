<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue';
import GameBoard from '../components/GameBoard.vue';
import PlayerRail from '../components/PlayerRail.vue';
import ActionPanel from '../components/ActionPanel.vue';
import BargainPanel from '../components/BargainPanel.vue';
import AssetPanel from '../components/AssetPanel.vue';
import CellDetailPanel from '../components/CellDetailPanel.vue';
import PlayerAssetDialog from '../components/PlayerAssetDialog.vue';
import SettlementDialog from '../components/SettlementDialog.vue';
import PropertyAwards from '../components/PropertyAwards.vue';
import MobileSheet from '../components/MobileSheet.vue';
import ChatPanel from '../components/ChatPanel.vue';
import TurnCountdown from '../components/TurnCountdown.vue';
import SettingsDialog from '../components/SettingsDialog.vue';
import { formatRecentLogEvent, canProposeTrade, getAssetRows, getAuctionDisplay, getCellDetail, getOwnTradableCells, getPendingCardChoice, getPendingPurchaseOffer, getPlayerAssetDialogModel, getTradeDisplay, getTradeProposalOptions, type ClientAction } from '../game/clientGame';
import { formatCashAnnouncement, formatMoney } from '../ui/format';
import type { CashNotice, GameSession } from '../session/gameSession';
import { paceMultiplier } from '../session/playbackPace';
import { shouldShowTurnCountdown } from '../session/turnTimer';
import { getGameInteractionState } from '../session/gameInteraction';
import { browserStorage, recordGameResult } from '../session/playerStats';
import type { Intent } from '@richman/engine';
import { playSfx } from '../audio/sfx';
import { isBgmEnabled, startBgm, stopBgm, armBgmAutoStart } from '../audio/bgm';
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
type MobileSheetId = 'assets' | 'log' | 'chat';
const mobileSheet = ref<MobileSheetId | null>(null);
const mobileLayoutQuery = typeof window === 'undefined' ? null : window.matchMedia('(max-width: 1024px)');
const isMobileLayout = ref(mobileLayoutQuery?.matches ?? false);

// 设置弹窗独立于 mobileSheet：它两端共用（桌面侧栏按钮 / 移动底部操作坞标签），
// 不再被 isMobileLayout 拦在门外——这正是 #13 要补的"桌面没有设置入口"。
const settingsOpen = ref(false);
const dockSettingsTrigger = ref<HTMLButtonElement | null>(null);

function toggleSettings(): void {
  settingsOpen.value = !settingsOpen.value;
}

// 房间聊天（联机有效；本地热座 chatLog 恒为空）。
// 布局契约（#50）：聊天不再使用固定定位的浮动按钮——它曾与侧栏内容、底部操作坞互相遮挡。
//   桌面：内联在侧栏流内的可折叠区块（.chat-desktop），永不遮挡其它区域。
//   移动：由底部操作坞的「聊天」标签驱动同一套 MobileSheet 抽屉（mobileSheet === 'chat'）。
// isChatOpen 只服务桌面折叠态；移动端展开态由 mobileSheet 统一表达。
// 可见性（本轮）：单机热座没有聊天通道（localSession.sendChat 是空实现），
// 因此**本地对局完全不渲染聊天入口**——此前会渲染一个"能打字但发不出去"的死入口。
const isChatAvailable = computed(() => props.session.mode === 'online');
const isChatOpen = ref(false);
const chatMessages = computed(() => props.session.chatLog.value);
const chatLocalId = computed(() => props.session.localPlayerId.value);
function handleSendChat(text: string): void {
  props.session.sendChat(text);
}
// 可发现性：桌面端聊天此前默认折叠、藏在侧栏里，玩家常常找不到。
// 首次收到他人消息时自动展开一次（只自动展开一次，之后完全尊重用户的收起动作）。
let chatAutoOpened = false;
watch(chatMessages, (messages) => {
  if (chatAutoOpened || !isChatAvailable.value || isMobileLayout.value) return;
  if (messages.length === 0) return;
  chatAutoOpened = true;
  isChatOpen.value = true;
});

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
  settingsOpen.value = false;
  armedDebtAutoOpen.value = null;
});

// Session refs surfaced as local computeds so the template auto-unwraps them and stays clean.
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

/** 房主且处于联机对局时，可对资产面板中选中的「其他存活玩家」使用踢出对局（出局）。 */
const canKickSelectedPlayer = computed(() => {
  if (props.session.mode === 'local' || !props.session.isHost?.value) return false;
  const current = state.value;
  const id = selectedPlayerId.value;
  if (current === null || current.phase !== 'playing' || id === null) return false;
  const target = current.players.find((player) => player.id === id);
  if (target === undefined || target.bankrupt || target.id === props.session.localPlayerId.value) return false;
  return true;
});

async function onKickSelectedPlayer(): Promise<void> {
  const id = selectedPlayerId.value;
  if (id === null || props.session.kickPlayer === undefined) return;
  await props.session.kickPlayer(id);
  closePlayerAssets();
}

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
// 本局游戏时长：对局进入 playing 时启动计时，game_over 时冻结。格式随跨度自适应
// （秒 → 分秒 → 时分秒），起始只显示秒，符合「从秒开始」的要求。
const gameStartedAt = ref<number | null>(null);
const elapsedSeconds = ref(0);
let durationTimer: number | null = null;

const gameDurationLabel = computed(() => formatDuration(elapsedSeconds.value));

function formatDuration(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  if (total < 60) return `${total}秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}分${seconds}秒`;
  const hours = Math.floor(minutes / 60);
  const displayMinutes = minutes % 60;
  return `${hours}时${displayMinutes}分${seconds}秒`;
}

function startDurationTimer() {
  if (durationTimer !== null) return;
  if (gameStartedAt.value === null) gameStartedAt.value = Date.now();
  // 组件按浏览器环境编写，但也必须能被 SSR / 单元测试渲染：没有 window 时直接跳过计时器。
  if (typeof window === 'undefined') return;
  durationTimer = window.setInterval(() => {
    if (gameStartedAt.value !== null) {
      elapsedSeconds.value = Math.floor((Date.now() - gameStartedAt.value) / 1000);
    }
  }, 1000);
}

function stopDurationTimer() {
  if (durationTimer !== null) {
    if (typeof window !== 'undefined') window.clearInterval(durationTimer);
    durationTimer = null;
  }
}

watch(
  () => state.value?.phase,
  (phase) => {
    if (phase === 'playing' && gameStartedAt.value === null) startDurationTimer();
    else if (phase === 'game_over') {
      stopDurationTimer();
      recordLocalPlayerStats();
      const localId = props.session.localPlayerId.value;
      playSfx(state.value?.winnerId === localId ? 'win' : 'lose');
    }
  },
  { immediate: true },
);

// 对局结束（game_over）时把本地参赛者的本局结果写入战绩统计。
// 观战者不在 players 列表中，自然被跳过；任何异常都不影响结算流程。
function recordLocalPlayerStats(): void {
  const current = state.value;
  if (current === null) return;
  const storage = browserStorage();
  if (storage === undefined) return;
  const localId = props.session.localPlayerId.value;
  const localPlayer = current.players.find((player) => player.id === localId);
  if (localPlayer === undefined) return;
  const won = current.winnerId === localId;
  recordGameResult(storage, {
    won,
    finalAsset: localPlayer.cash,
    mapId: current.mapRef.id,
    at: Date.now(),
  });
}

// 音效 / 背景音乐 / 皮肤 / 动画速度的开关都搬进了 SettingsDialog（#13 统一设置入口），
// 它们各自直接读写自己的偏好模块，本视图不再持有这些状态。
// 悔棋/回放（P1-5，仅本地热座对局提供）。联机对局无此能力（服务器为权威态，不可本地回退）。
const canUndo = computed(() => props.session.canUndo?.value ?? false);
const canReplay = computed(() => props.session.canReplay?.value ?? false);
async function undoMove(): Promise<void> {
  await props.session.undo?.();
}
async function replayGame(): Promise<void> {
  await props.session.replay?.();
}

// ---- 联机最小悔棋（#101）----
// 只在「联机 + 房主开了悔棋」时出现这条面板。它与上面那套本地悔棋是两回事：
// 本地没有别人，回退就是本地回退；联机的回退必须经在场对手逐一确认，由服务端裁决，
// 客户端不自己判定「你能不能悔」——那由服务端算好、通过 room:undo_available 广播下来。
const undoEnabled = computed(() =>
  props.session.mode !== 'local' && props.session.roomSettings?.value?.minimalUndoEnabled === true,
);
const undoRequest = computed(() => props.session.undoRequest?.value ?? null);
const canRequestUndo = computed(() => props.session.canRequestUndo?.value ?? false);
const canVoteUndo = computed(() => props.session.canVoteUndo?.value ?? false);
const isUndoRequester = computed(() => props.session.isUndoRequester?.value ?? false);
/** 「2/3 已确认」：进度条文案，发起者与对手都看这一份。 */
const undoApprovalLabel = computed(() => {
  const pending = undoRequest.value;
  return pending === null ? '' : `${pending.approvals.length}/${pending.voterIds.length} 已确认`;
});
/** 还没表态的对手昵称（发起者最关心这个：在等谁）。 */
const undoWaitingNames = computed(() => {
  const pending = undoRequest.value;
  if (pending === null) return '';
  const room = props.session.room.value;
  return pending.voterIds
    .filter((id) => !pending.approvals.includes(id))
    .map((id) => room?.players.find((player) => player.id === id)?.nickname ?? '对手')
    .join('、');
});
function requestUndo(): void {
  void props.session.requestUndo?.();
}
function voteUndo(approve: boolean): void {
  const pending = undoRequest.value;
  if (pending === null) return;
  void props.session.voteUndo?.(pending.requestId, approve);
}
function cancelUndo(): void {
  void props.session.cancelUndo?.();
}

// 骰子落下（dice ref 由 null 变非 null）时播声音。
watch(
  () => dice.value,
  (value) => {
    if (value !== null) playSfx('dice');
  },
);

// 本地玩家现金变动：减少=付款声，增加=收款声。
watch(
  () => {
    const current = state.value;
    if (current === null) return undefined;
    const local = current.players.find((player) => player.id === props.session.localPlayerId.value);
    return local?.cash;
  },
  (next, prev) => {
    if (prev === undefined || next === undefined || next === prev) return;
    playSfx(next < prev ? 'pay' : 'coin');
  },
);

// 任一玩家破产（bankrupt 由 false 变 true）时播破产音。
watch(
  () => state.value?.players.some((player) => player.bankrupt) ?? false,
  (bankruptNow, wasBankrupt) => {
    if (bankruptNow && !wasBankrupt) playSfx('bankrupt');
  },
);

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

/* ---- 议价（#105 交易 / #106 拍卖） ----
   议价阶段的合法行动者不是 currentPlayerId：交易看报价目标、拍卖看轮到的叫价者。
   联机有 localPlayerId；单机热座没有，就用这一阶段的合法行动者代表「当前这台设备上的人」。 */
const bargainViewerId = computed(() => {
  const local = props.session.localPlayerId.value;
  if (local !== null) return local;
  const current = state.value;
  if (current === null) return '';
  return current.pendingTrade?.targetId ?? current.pendingAuction?.bidderId ?? current.currentPlayerId;
});
const tradeDisplay = computed(() => (
  state.value === null ? null : getTradeDisplay(state.value, bargainViewerId.value)
));
const auctionDisplay = computed(() => (
  state.value === null ? null : getAuctionDisplay(state.value, bargainViewerId.value)
));
// 观战者不参与议价：面板对它只读。发起入口也只对合法发起人出现。
const tradeProposalOptions = computed(() => {
  const current = state.value;
  if (current === null || isSpectator.value) return null;
  if (props.session.localPlayerId.value !== null
    && props.session.localPlayerId.value !== current.currentPlayerId) return null;
  if (!canProposeTrade(current, current.currentPlayerId)) return null;
  return getTradeProposalOptions(current, current.currentPlayerId);
});
const ownTradableCells = computed(() => (
  state.value === null ? [] : getOwnTradableCells(state.value, state.value.currentPlayerId)
));
const ownCash = computed(() => (
  state.value?.players.find((player) => player.id === state.value?.currentPlayerId)?.cash ?? 0
));
const showBargainPanel = computed(() => (
  tradeDisplay.value !== null
  || auctionDisplay.value !== null
  || (tradeProposalOptions.value !== null && tradeProposalOptions.value.length > 0)
));

/* ---- 回合限时（#107） ----
   服务端只给出「此刻谁的钟在走」（`room:turn_deadline`），本地一秒钟也不自行判超时。
   只为**本机玩家自己**画倒计时：给旁观者或别人画一根「你的回合快到了」比不画更让人困惑。 */
const turnDeadlineInfo = computed(() => props.session.turnDeadline?.value ?? null);
const showTurnCountdown = computed(() => (
  !isSpectator.value
  && state.value?.phase === 'playing'
  && shouldShowTurnCountdown(turnDeadlineInfo.value, props.session.localPlayerId.value)
));
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

// 二次确认弹窗同时服务于「离开房间」与「投降」两种流程，用 confirmMode 区分文案与确认动作。
const confirmMode = ref<'leave' | 'surrender'>('leave');
const confirmTitle = computed(() => (
  confirmMode.value === 'surrender'
    ? '是否确认投降？'
    : (canNotifyRoom.value ? '离开房间？' : '放弃这局？')
));
const confirmBody = computed(() => {
  if (confirmMode.value === 'surrender') {
    return state.value?.players.length === 2
      ? '投降后你立即出局，本局按破产流程结算（对手获胜）。确认要继续吗？'
      : '投降后你立即出局，现金与名下地产全部清零，地产转为无主、可被其他玩家购买，其余玩家继续对局。';
  }
  return canNotifyRoom.value
    ? '离开后本局进度会保留在房间，你之后可以从首页回到上一局继续。'
    : '当前连接已断开，无法通知房间。放弃后会清除本地存档并返回首页。';
});
const confirmLabel = computed(() => (
  confirmMode.value === 'surrender' ? '是' : (canNotifyRoom.value ? '确认离开' : '放弃这局')
));
const cancelLabel = computed(() => (confirmMode.value === 'surrender' ? '否' : '继续游戏'));

// 投降按钮仅在联机对局、本玩家仍在局且连接正常时可用（本地热座无独立座位，不提供此按钮）。
const canSurrender = computed(() => {
  const current = state.value;
  if (current === null || current.phase !== 'playing') return false;
  const localId = props.session.localPlayerId.value;
  if (localId === null) return false;
  const seat = current.players.find((player) => player.id === localId);
  if (seat === undefined || seat.bankrupt) return false;
  if (interaction.value.kind === 'spectating') return false;
  if (props.session.connectionStatus.value !== 'connected') return false;
  return true;
});

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
    confirmMode.value = 'leave';
    isConfirmingLeave.value = true;
    return;
  }
  emit('exit');
}

// Exit lives inside the settings dialog: close the native dialog first so the leave-confirm
// dialog (and its focus trap) is never fighting a top-layer sheet for the screen.
// 设置入口有两个（桌面侧栏按钮 / 移动底部操作坞标签），焦点归还给当前那个可见的。
function settingsTriggerElement(): HTMLElement | null {
  return settingsTrigger.value ?? dockSettingsTrigger.value;
}

function requestExitFromSheet(): void {
  if (needsLeaveConfirm.value) { confirmMode.value = 'leave'; leaveTrigger = settingsTriggerElement(); }
  settingsOpen.value = false;
  requestExit();
}

// 投降：与离开房间共用同一套二次确认弹窗，仅切换 confirmMode 改变文案与确认动作。
function requestSurrender() {
  if (isConfirmingLeave.value || !canSurrender.value) return;
  confirmMode.value = 'surrender';
  isConfirmingLeave.value = true;
}

function requestSurrenderFromSheet(): void {
  if (!canSurrender.value) return;
  confirmMode.value = 'surrender';
  leaveTrigger = settingsTriggerElement();
  settingsOpen.value = false;
  requestSurrender();
}

async function confirmSurrender(): Promise<void> {
  if (isSubmittingIntent.value) return;
  isSubmittingIntent.value = true;
  const surrenderIntent: Intent = { type: 'surrender' };
  try {
    await props.session.sendIntent(surrenderIntent);
  } catch {
    // 投降指令未成功（如连接中断）：仍按用户意图退出房间；具体错误由 session 层提示。
  } finally {
    isSubmittingIntent.value = false;
  }
  isConfirmingLeave.value = false;
  emit('exit');
}

function confirmLeave() {
  if (confirmMode.value === 'surrender') {
    void confirmSurrender();
    return;
  }
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

async function handleBargainIntent(intent: Intent) {
  if (isConfirmingLeave.value || isSubmittingIntent.value) return;
  // 议价的合法行动者不是当前玩家（交易看目标、拍卖看叫价者），所以不能复用
  // `interaction.canSendIntent`（那条闸门认的是 currentPlayerId）；这里只挡观战与断线重连。
  if (isSpectator.value || !interaction.value.canSendIntent) return;
  isSubmittingIntent.value = true;
  try {
    await props.session.sendIntent(intent);
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
  // 恢复中的对局可能挂载时已是 playing：兜底启动计时（startDurationTimer 内部幂等）。
  if (state.value?.phase === 'playing') startDurationTimer();
  // 背景音乐（P1-4）：若用户上轮已开启，布防"首次手势续播"（浏览器自动播放策略要求手势）。
  if (isBgmEnabled()) armBgmAutoStart();
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
  stopDurationTimer();
  // 背景音乐（P1-4）：离开对局时停止，释放 AudioContext 计时器。
  stopBgm();
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
          <span class="game-meta-tags">
            <span>{{ session.mode === 'local' ? '本地游戏' : '联机游戏' }}</span>
            <span v-if="session.mode !== 'local' && session.room.value?.roomCode" class="game-room-code">房间号 {{ session.room.value?.roomCode }}</span>
            <span class="game-duration" :title="`本局游戏时长 ${gameDurationLabel}`">{{ gameDurationLabel }}</span>
          </span>
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
        <button
          v-if="canSurrender"
          type="button"
          class="restart-button restart-desktop surrender-button"
          @click="requestSurrender"
        >投降</button>
        <button
          ref="settingsTrigger"
          type="button"
          class="restart-button restart-desktop settings-open-button"
          aria-haspopup="dialog"
          :aria-expanded="settingsOpen"
          @click="settingsOpen = true"
        >设置</button>
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
        <!-- 回合限时（#107）：房主在大厅开启后才出现，且只在本机玩家自己该走时显示。
             排在操作面板正下方——玩家抬手就能看见「还剩几秒」，而不必满屏找。 -->
        <TurnCountdown
          v-if="showTurnCountdown"
          :deadline-at="turnDeadlineInfo!.deadlineAt!"
          :limit-sec="turnDeadlineInfo!.limitSec"
          :busy="isBusy || isSubmittingIntent"
        />
        <!-- 议价面板（#105 交易 / #106 拍卖）：三态互斥，与悔棋面板并列排在操作面板下方。
             没有进行中的议价、也不轮到我发起时整块不出现，不会给控制台留下常驻空白。 -->
        <BargainPanel
          v-if="showBargainPanel"
          :trade="tradeDisplay"
          :auction="auctionDisplay"
          :proposal-options="tradeProposalOptions"
          :own-cells="ownTradableCells"
          :own-cash="ownCash"
          :is-busy="isBusy || isSubmittingIntent"
          :is-spectator="isSpectator"
          @intent="handleBargainIntent"
        />
        <!-- 联机最小悔棋（#101）：房主在大厅开启后才出现。三态合一——
             我可发起 / 我已发起（等对手确认）/ 我需要表态。单机的本地悔棋不在这一块。 -->
        <section v-if="undoEnabled && (canRequestUndo || undoRequest !== null)" class="undo-panel" aria-label="悔棋">
          <template v-if="undoRequest">
            <p class="undo-panel__title">
              <span>悔棋请求 · {{ undoRequest.requesterNickname }}</span>
              <span class="undo-panel__progress">{{ undoApprovalLabel }}</span>
            </p>
            <p v-if="isUndoRequester" class="undo-panel__hint">
              等待 {{ undoWaitingNames }} 确认；20 秒内没集齐全部同意就作废。
            </p>
            <p v-else-if="canVoteUndo" class="undo-panel__hint">
              同意后，{{ undoRequest.requesterNickname }} 刚走的那一步会被退回。
            </p>
            <p v-else class="undo-panel__hint">你已确认，等待其他对手。</p>
            <div class="undo-panel__actions">
              <button v-if="canVoteUndo" type="button" class="undo-btn undo-btn--approve" @click="voteUndo(true)">
                同意悔棋
              </button>
              <button v-if="canVoteUndo" type="button" class="undo-btn undo-btn--reject" @click="voteUndo(false)">
                拒绝
              </button>
              <button v-if="isUndoRequester" type="button" class="undo-btn undo-btn--ghost" @click="cancelUndo()">
                撤回请求
              </button>
            </div>
          </template>
          <template v-else>
            <p class="undo-panel__hint">走错了？可以请在场对手允许你退回刚走的那一步。</p>
            <div class="undo-panel__actions">
              <button type="button" class="undo-btn" @click="requestUndo()">发起悔棋</button>
            </div>
          </template>
        </section>
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
        <!-- 桌面内联聊天（#50）：位于侧栏文档流内、可折叠，不再悬浮遮挡任何区域；
             移动端隐藏，改由底部操作坞的「聊天」标签驱动下方抽屉。
             仅联机对局渲染：单机热座没有聊天通道（#本轮）。 -->
        <section v-if="isChatAvailable" class="chat-desktop" aria-label="房间聊天">
          <button
            type="button"
            class="chat-desktop__toggle"
            :aria-expanded="isChatOpen"
            @click="isChatOpen = !isChatOpen"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4zM8 9h8M8 12h5" /></svg>
            房间聊天
            <span v-if="chatMessages.length > 0" class="chat-desktop__badge">{{ chatMessages.length }}</span>
          </button>
          <ChatPanel
            v-if="isChatOpen"
            class="chat-desktop__panel"
            :messages="chatMessages"
            :local-player-id="chatLocalId"
            @send="handleSendChat"
          />
        </section>

        <!-- 移动端聊天抽屉：与「资产 / 战报 / 设置」同一套 MobileSheet 语义。 -->
        <Teleport to="body" :disabled="!isMobileLayout">
          <MobileSheet
            v-if="isChatAvailable"
            class="sheet sheet-chat"
            :open="isMobileLayout && mobileSheet === 'chat'"
            title="房间聊天"
            @close="closeMobileSheet"
          >
            <ChatPanel
              class="chat-sheet-panel"
              :messages="chatMessages"
              :local-player-id="chatLocalId"
              @send="handleSendChat"
            />
          </MobileSheet>
        </Teleport>

        <!-- 统一设置入口（#13）：桌面/移动同一份内容，桌面居中弹窗、手机底部抽屉。
             入口两处：侧栏「设置」按钮（桌面）与底部操作坞「设置」标签（移动）。 -->
        <SettingsDialog
          :open="settingsOpen"
          :is-local-game="session.mode === 'local'"
          :can-undo="canUndo"
          :can-replay="canReplay"
          :cash-goal="state?.cashGoal ?? null"
          :map-id="state?.mapRef.id ?? null"
          :exit-label="exitLabel"
          :can-surrender="canSurrender"
          :show-session-actions="isMobileLayout"
          @update:open="settingsOpen = $event"
          @undo="undoMove"
          @replay="replayGame"
          @exit="requestExitFromSheet"
          @surrender="requestSurrenderFromSheet"
        />

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
            ref="dockSettingsTrigger"
            type="button"
            class="dock-entry"
            aria-haspopup="dialog"
            :aria-expanded="settingsOpen"
            @click="toggleSettings"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" /></svg>
            设置
          </button>
          <button
            v-if="isChatAvailable"
            type="button"
            class="dock-entry"
            :aria-expanded="mobileSheet === 'chat'"
            @click="toggleMobileSheet('chat')"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4zM8 9h8M8 12h5" /></svg>
            聊天<span v-if="chatMessages.length > 0" class="dock-chat-dot" aria-hidden="true"></span>
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
      :can-kick="canKickSelectedPlayer"
      @close="closePlayerAssets"
      @kick="onKickSelectedPlayer"
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
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
      >
        <h2 id="confirm-title">{{ confirmTitle }}</h2>
        <p id="confirm-body">{{ confirmBody }}</p>
        <div class="confirm-actions">
          <button type="button" class="confirm-cancel" @click="cancelLeave">{{ cancelLabel }}</button>
          <button type="button" class="confirm-leave" @click="confirmLeave">{{ confirmLabel }}</button>
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

.game-meta-tags {
  display: flex;
  align-items: center;
  gap: 10px;
}

.game-duration {
  font-variant-numeric: tabular-nums;
}

.game-room-code {
  padding: 1px 8px;
  border-radius: 999px;
  background: rgba(217, 164, 65, 0.16);
  color: var(--color-accent, #D9A441);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.08em;
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

/* 投降按钮：与离开/托管按钮同尺寸同位置，仅以危险色（红）区分语义。 */
.surrender-button {
  --surrender: #c0392b;
  border-color: color-mix(in srgb, var(--surrender) 42%, var(--color-border));
  color: var(--surrender);
}

.surrender-button:hover {
  background: color-mix(in srgb, var(--surrender) 10%, var(--board-surface));
}

@media (hover: none) {
  .surrender-button:active {
    background: color-mix(in srgb, var(--surrender) 14%, var(--board-surface));
  }
}

/* 联机悔棋面板（#101）：排在操作面板下方，与它同宽同层——不挤动上面那排按钮。 */
.undo-panel {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--board-surface);
}

.undo-panel__title {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: baseline;
  margin: 0;
  font-weight: 700;
  color: var(--color-text);
}

.undo-panel__progress {
  flex: none;
  font-size: 0.8em;
  font-weight: 600;
  color: var(--color-primary);
}

.undo-panel__hint {
  margin: 0;
  font-size: 0.85em;
  line-height: 1.5;
  color: color-mix(in srgb, var(--color-text) 74%, transparent);
}

.undo-panel__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.undo-btn {
  flex: 1 1 auto;
  min-height: 40px;
  padding: 0 12px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--board-surface);
  color: var(--color-primary);
  font-weight: 700;
  cursor: pointer;
}

/* 「同意悔棋」是这一组里唯一的前进动作，给它强调色；拒绝与撤回保持低调。 */
.undo-btn--approve {
  background: var(--color-accent);
  color: var(--color-text);
  border-color: var(--color-accent);
}

.undo-btn--reject,
.undo-btn--ghost {
  color: color-mix(in srgb, var(--color-text) 70%, transparent);
}

.undo-btn:hover {
  background: color-mix(in srgb, var(--color-primary) 10%, var(--board-surface));
}

@media (hover: none) {
  .undo-btn:active {
    background: color-mix(in srgb, var(--color-primary) 14%, var(--board-surface));
  }
}


/* 设置行的样式随设置内容一起搬进了 SettingsDialog.vue（#13 统一设置入口）。 */

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
.log-toggle:hover {
  background: rgb(255 255 255 / 62%);
}

.dock-entry:active {
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
  .log-toggle,
  .restart-button,
  .takeover-button,
  .location-card,
  .banner-retry,
  .banner-home {
    transition: none;
  }
}

/* 桌面分支（>1024px）棋盘容器：此前 .board-stage 仅在 ≤1024px 媒体查询内定义，
   桌面分支无基础样式 → 100% 缩放下棋盘塌缩/不显示（放大到 150% 触发 ≤1024px 断点才出现）。
   这里补齐：作为栅格项时居中棋盘、允许收缩、溢出裁剪，任何缩放下都完整可见。 */
.board-stage {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  place-items: center;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
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
    grid-template-columns: repeat(4, 1fr);
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

  .dock-chat-dot {
    position: absolute;
    top: 7px;
    right: 9px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-accent, #D9A441);
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

/* ---- 聊天（#50）----
   历史问题：聊天入口用 position:fixed 悬浮在四角，与侧栏内容、底部操作坞、房间卡片互相遮挡。
   现在：桌面 = 侧栏文档流内的可折叠区块；移动 = 底部操作坞驱动的 MobileSheet 抽屉。
   两处都不再脱离文档流，因此任何分辨率 / 缩放 / 安全区下都不会与其它元素重叠。 */
.chat-desktop {
  display: grid;
  gap: 8px;
}

.chat-desktop__toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 0 12px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--board-surface);
  color: var(--color-text);
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}

.chat-desktop__toggle svg {
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.chat-desktop__badge {
  margin-left: auto;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: #c0392b;
  color: #fff;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}

/* 面板铺满侧栏宽度、高度受控，绝不溢出到棋盘或其它区域。 */
.chat-desktop__panel {
  width: 100%;
  max-height: min(320px, 42vh);
}

.chat-sheet-panel {
  width: 100%;
  max-height: 60vh;
}

/* 动画速度说明（#55 语义）随设置一起搬到 SettingsDialog.vue。 */

/* 移动端：桌面聊天区块隐藏（聊天改由底部操作坞驱动抽屉）。 */
@media (max-width: 1024px) {
  .chat-desktop {
    display: none;
  }
}

/* 桌面端：移动聊天抽屉整块隐藏。否则 .sheet 的 display:contents 会让它的 ChatPanel
   重复内联到侧栏（同一份聊天出现两次）。 */
@media (min-width: 1025px) {
  .sheet-chat {
    display: none;
  }
}
</style>
