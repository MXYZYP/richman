<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import HomeView from './views/HomeView.vue';
import RestoreView from './views/RestoreView.vue';
// 首屏分包（待-10）：首页只做「创建/加入/本机同乐」这一层，不需要对局 UI 与音频。
// 三个页面级视图改为异步组件后，它们各自的代码与独占依赖（棋盘/资产面板/结算弹层/
// 音效与 BGM/MobileSheet…）会切到独立 chunk，进入对应流程时才加载。
const GameSetup = defineAsyncComponent(() => import('./components/GameSetup.vue'));
const LobbyView = defineAsyncComponent(() => import('./views/LobbyView.vue'));
const GameView = defineAsyncComponent(() => import('./views/GameView.vue'));
import {
  createInitialLocalGameState,
  createLocalSession,
  type CreateLocalSessionOptions,
  type LocalSession,
} from './session/localSession';
import { createOnlineSession, type OnlineGameSession } from './session/onlineSession';
import type { GameSession } from './session/gameSession';
import { resolvePage, type AppFlowSnapshot, type AppShellStage } from './session/appFlow';
import { createLocalStartGuard } from './session/localStartGuard';
import { createInvitationUrlString, parseInvitationRoom } from './session/invitation';
import {
  readOnlineSession,
  readPendingRoomRequest,
  type PendingRoomRequest,
  type StorageLike,
} from './session/sessionStorage';
import { createDefaultGameSetup, gameSetupToCreateOptions, updateGameSetupMapId, type GameSetupForm } from './game/gameSetup';
import { getMapPack, listActiveMaps } from '@richman/board-data';
import type { RoomRole, RoomSettingsPatch } from '@richman/protocol';
import {
  LOCAL_GAME_SAVE_KEYS,
  createBrowserLocalSaveMutationLock,
  createLocalSaveLocked,
  createLocalSavePersistence,
  hasLocalSaveChanged,
  isStorageAvailable,
  readAllLocalSaveSlots,
  readLocalSaveSlot,
  removeLocalSaveLocked,
  replaceLocalSaveLocked,
  toLocalSaveCards,
  type LocalGamePersistence,
  type LocalSaveCard,
  type LocalSaveIdentity,
  type LocalSaveObservedRecord,
  type LocalSaveReadResult,
  type LocalSaveSlot,
  type LocalSaveSummary,
} from './session/localGameSave';
import type { GameState } from '@richman/engine';
import { applyAppearancePreferences } from './ui/themeManager';

// Exactly one OnlineSession for the app's lifetime — constructed before any operation.
const onlineSession: OnlineGameSession = createOnlineSession();

// 应用已保存的深色模式与对局皮肤（#11 / P2-9）：模块顶层设置 <html data-appearance> 与
// <html data-theme>，避免首屏闪烁。深浅两轴一起算，因为 'auto' 皮肤要按深色模式解析。
applyAppearancePreferences();
const activeMaps = listActiveMaps();
function browserStorage(): StorageLike | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}
let storage: StorageLike | undefined = browserStorage();
let localSaveMutationLock = createBrowserLocalSaveMutationLock();

// Invite links prefill the room code only; the user still submits deliberately.
const inviteRoomCode = ((): string => {
  try {
    return parseInvitationRoom(new URL(globalThis.location.href)) ?? '';
  } catch {
    return '';
  }
})();

const stage = ref<AppShellStage>('online');
const storedActive = ref(false);
const pending = ref<PendingRoomRequest | null>(null);
const submitting = ref(false);
const leaving = ref(false);
// 「暂不恢复」 latch: route to home this session without discarding the stored session.
const restoreDeferred = ref(false);

const setup = ref(createDefaultGameSetup());
const homeMapId = ref(setup.value.mapId);
const localGame = shallowRef<LocalSession | null>(null);
const localStartGuard = createLocalStartGuard();
const localSaveResults = shallowRef<LocalSaveReadResult[]>([]);
const localSaveError = ref<string | null>(null);
const storageAvailable = ref(isStorageAvailable(storage, localSaveMutationLock));
const storagePrompt = ref(false);
const replacementSummary = ref<LocalSaveSummary | null>(null);
const pendingLocalStart = shallowRef<{
  setup: GameSetupForm;
  options: CreateLocalSessionOptions;
  state: GameState;
} | null>(null);
const localSaveCards = computed<LocalSaveCard[]>(() => toLocalSaveCards(localSaveResults.value));

async function syncLocalSaves(): Promise<void> {
  if (storage === undefined) {
    localSaveResults.value = [];
    storageAvailable.value = false;
    return;
  }
  const currentStorage = storage;
  const currentLock = localSaveMutationLock;
  let results = readAllLocalSaveSlots(currentStorage);
  if (currentLock === undefined) {
    localSaveResults.value = results;
    storageAvailable.value = false;
    return;
  }
  let removedCompleted = false;
  for (const result of results) {
    if (result.kind !== 'completed') continue;
    const removed = await removeLocalSaveLocked(currentStorage, currentLock, result);
    if (removed.ok) removedCompleted = true;
    else localSaveError.value = '本局已结束，但存档清理失败，请重试删除';
  }
  if (removedCompleted) results = readAllLocalSaveSlots(currentStorage);
  localSaveResults.value = results;
}

function syncStorage() {
  storedActive.value = storage !== undefined && readOnlineSession(storage) !== null;
  pending.value = storage === undefined ? null : readPendingRoomRequest(storage);
}
syncStorage();
void syncLocalSaves();

// Resume outcomes and room lifecycle rewrite storage; keep the reducer inputs fresh.
watch([onlineSession.connectionStatus, onlineSession.room], syncStorage);

const gameOver = computed(() => (
  stage.value === 'local_game'
    ? localGame.value?.state.value.phase === 'game_over'
    : onlineSession.state.value?.phase === 'game_over'
));
watch(gameOver, (completed) => {
  if (completed && stage.value === 'local_game') void syncLocalSaves();
});

const snapshot = computed<AppFlowSnapshot>(() => ({
  stage: stage.value,
  storedActive: storedActive.value,
  pending: pending.value,
  connection: onlineSession.connectionStatus.value,
  room: onlineSession.room.value?.status ?? null,
  gameOver: gameOver.value,
  restoreDeferred: restoreDeferred.value,
}));

const page = computed(() => resolvePage(snapshot.value));
const pageKind = computed(() => page.value.kind);
const restoreFailure = computed(() => (page.value.kind === 'restoring' ? page.value.failure : null));
const resumeOffer = computed(() => (page.value.kind === 'home' ? page.value.resume : null));
const canResumeActive = computed(() => (page.value.kind === 'home' ? page.value.canResumeActive : false));
const pendingRetryable = computed(() => onlineSession.entryFailure.value !== 'definitive');

const onlineRoom = computed(() => onlineSession.room.value);
const onlineError = computed(() => onlineSession.lastError.value);
const connectionLabel = computed(() => {
  switch (onlineSession.connectionStatus.value) {
    case 'connected': return '已连接';
    case 'reconnecting': return '重新连接中';
    case 'failed': return '连接已断开';
    default: return '连接中';
  }
});

// The active game session handed to the shared view: the local hot-seat game while it runs,
// otherwise the app-lifetime online session once a room exists. Null outside any live game.
const activeSession = computed<GameSession | null>(() => {
  if (stage.value === 'local_game') return localGame.value;
  return onlineRoom.value !== null ? onlineSession : null;
});

// The canonical invite string for the current room — one source shared by the lobby's copy
// affordance and its QR encoder. Built from the live location so it survives deep links.
const inviteUrl = computed(() => {
  const room = onlineRoom.value;
  if (room === null) return '';
  try {
    return createInvitationUrlString(new URL(globalThis.location.href), room.roomCode);
  } catch {
    return '';
  }
});

// ---- Online entry flow ----
async function handleCreate(nickname: string, mapId: string) {
  if (submitting.value) return;
  homeMapId.value = mapId;
  submitting.value = true;
  try {
    // 电脑难度不再随建房一次性传走：房间是「先建房、后加电脑」，难度由房主在大厅里设
    // （room:update_settings），所以建房只发昵称与地图。
    await onlineSession.create(nickname, mapId);
  } finally {
    submitting.value = false;
    syncStorage();
  }
}

async function handleJoin(payload: { roomCode: string; nickname: string; role: RoomRole }) {
  if (submitting.value) return;
  submitting.value = true;
  try {
    await onlineSession.join(payload.roomCode, payload.nickname, payload.role);
  } finally {
    submitting.value = false;
    syncStorage();
  }
}

async function handleResumePending() {
  if (submitting.value) return;
  submitting.value = true;
  try {
    await onlineSession.retryPending();
  } finally {
    submitting.value = false;
    syncStorage();
  }
}

async function handleRestoreRetry() {
  restoreDeferred.value = false;
  await onlineSession.retryResume();
  syncStorage();
}

// 「暂不恢复」: non-destructive. Storage is untouched, so the stored session survives and
// home offers an independent 回到上一局; only an explicit abandon clears it.
function handleRestoreDefer() {
  onlineSession.deferResume();
  restoreDeferred.value = true;
}

// 「放弃这局」: explicit discard of the stored active session. discardStoredSession is
// storage-first — a rejected removal keeps the session and surfaces a safe error.
function handleAbandonActive() {
  if (onlineSession.discardStoredSession()) restoreDeferred.value = false;
  syncStorage();
}

// 「放弃上次操作」: explicit abort of a staged pending entry (storage-first).
function handleAbandonPending() {
  onlineSession.abortEntry();
  syncStorage();
}

async function handleLeaveRoom() {
  if (leaving.value) return;
  leaving.value = true;
  try {
    await onlineSession.leave();
  } finally {
    leaving.value = false;
    syncStorage();
  }
}

// Lobby controls delegate straight to the session — it owns single-flight and never mutates
// the roster locally; the authoritative room:state broadcast drives every UI change.
function handleAddBot() {
  void onlineSession.addBot();
}

function handleRemoveBot(playerId: string) {
  void onlineSession.removeBot(playerId);
}

function handleRenameBot(playerId: string, nickname: string) {
  void onlineSession.renameBot(playerId, nickname);
}

function handleKick(playerId: string) {
  void onlineSession.kickPlayer(playerId);
}

function handleUpdateRoomSettings(patch: RoomSettingsPatch) {
  void onlineSession.updateRoomSettings(patch);
}

function handleStartRoom() {
  void onlineSession.start();
}

// ---- Local hot-seat flow ----
function resetPageScroll() {
  void nextTick(() => globalThis.scrollTo?.({ top: 0, left: 0 }));
}

function chooseLocal(mapId: string) {
  homeMapId.value = mapId;
  void syncLocalSaves();
  localSaveError.value = null;
  storagePrompt.value = false;
  replacementSummary.value = null;
  setup.value = updateGameSetupMapId(setup.value, mapId);
  stage.value = 'local_setup';
  resetPageScroll();
}

function launchLocalGame(
  pendingStart: NonNullable<typeof pendingLocalStart.value>,
  persistence?: LocalGamePersistence,
): void {
  localStartGuard.cancel();
  localGame.value?.dispose();
  localGame.value = createLocalSession({
    ...pendingStart.options,
    restoreState: pendingStart.state,
    persistence,
    autoPlayBots: true,
  });
  pendingLocalStart.value = null;
  replacementSummary.value = null;
  storagePrompt.value = false;
  localSaveError.value = null;
  stage.value = 'local_game';
  resetPageScroll();
  void localGame.value.runBotTurnIfNeeded();
}

async function attemptDurableLocalStart(pendingStart: NonNullable<typeof pendingLocalStart.value>): Promise<void> {
  const ticket = localStartGuard.begin();
  const isCurrent = () => (
    localStartGuard.isCurrent(ticket) && pendingLocalStart.value === pendingStart
  );
  storageAvailable.value = isStorageAvailable(storage, localSaveMutationLock);
  if (storage === undefined || localSaveMutationLock === undefined || !storageAvailable.value) {
    storagePrompt.value = true;
    return;
  }
  const created = await createLocalSaveLocked(
    storage,
    localSaveMutationLock,
    pendingStart.state,
    Date.now(),
    isCurrent,
  );
  if (!isCurrent()) return;
  if (created.ok) {
    launchLocalGame(
      pendingStart,
      createLocalSavePersistence(storage, localSaveMutationLock, created),
    );
    void syncLocalSaves();
    return;
  }
  if (created.reason === 'no_empty_slot') {
    const oldest = localSaveResults.value.find((result): result is Extract<LocalSaveReadResult, { kind: 'valid' }> => (
      result.kind === 'valid'
      && result.slot === created.oldestSlot
      && result.save.gameId === created.oldestGameId
    ));
    if (oldest === undefined) {
      await syncLocalSaves();
      if (!isCurrent()) return;
      localSaveError.value = '存档列表已变化，请检查后重试';
      return;
    }
    replacementSummary.value = oldest.summary;
    return;
  }
  if (created.reason === 'no_replaceable_slot') {
    localSaveError.value = '两个存档都无法恢复，请先删除一个存档';
    return;
  }
  storagePrompt.value = true;
  localSaveError.value = '浏览器无法保存本次操作，请检查存储权限后重试';
}

async function startLocalGame(nextSetup: GameSetupForm) {
  setup.value = nextSetup;
  const options = gameSetupToCreateOptions(nextSetup);
  const state = createInitialLocalGameState(options);
  const pendingStart = { setup: nextSetup, options, state };
  pendingLocalStart.value = pendingStart;
  replacementSummary.value = null;
  storagePrompt.value = false;
  localSaveError.value = null;
  await syncLocalSaves();
  if (pendingLocalStart.value !== pendingStart) return;
  await attemptDurableLocalStart(pendingStart);
}

async function confirmReplacement(): Promise<void> {
  const pendingStart = pendingLocalStart.value;
  const summary = replacementSummary.value;
  if (pendingStart === null || summary === null || storage === undefined || localSaveMutationLock === undefined) return;
  const ticket = localStartGuard.begin();
  const isCurrent = () => (
    localStartGuard.isCurrent(ticket) && pendingLocalStart.value === pendingStart
  );
  const replaced = await replaceLocalSaveLocked(
    storage,
    localSaveMutationLock,
    summary,
    pendingStart.state,
    Date.now(),
    isCurrent,
  );
  if (!isCurrent()) return;
  if (!replaced.ok) {
    await syncLocalSaves();
    if (!isCurrent()) return;
    replacementSummary.value = null;
    localSaveError.value = replaced.reason === 'storage_error'
      ? '浏览器无法保存本次操作，请检查存储权限后重试'
      : '存档列表已变化，请检查后重试';
    return;
  }
  launchLocalGame(
    pendingStart,
    createLocalSavePersistence(storage, localSaveMutationLock, replaced),
  );
  void syncLocalSaves();
}

function cancelReplacement(): void {
  localStartGuard.cancel();
  replacementSummary.value = null;
}

async function retryLocalStorage(): Promise<void> {
  const pendingStart = pendingLocalStart.value;
  if (pendingStart === null) return;
  storage = browserStorage();
  localSaveMutationLock = createBrowserLocalSaveMutationLock();
  storagePrompt.value = false;
  localSaveError.value = null;
  await syncLocalSaves();
  if (pendingLocalStart.value !== pendingStart) return;
  await attemptDurableLocalStart(pendingStart);
}

function startTemporaryLocalGame(): void {
  const pendingStart = pendingLocalStart.value;
  localStartGuard.cancel();
  if (pendingStart !== null) launchLocalGame(pendingStart);
}

function resumeLocalGame(observed: LocalSaveIdentity): void {
  if (storage === undefined || localSaveMutationLock === undefined) {
    localSaveError.value = '本浏览器无法安全更新存档，请改用支持 Web Locks 的浏览器';
    return;
  }
  const listed = localSaveResults.value.find((result): result is Extract<LocalSaveReadResult, { kind: 'valid' }> => (
    result.kind === 'valid' && result.slot === observed.slot && result.save.gameId === observed.gameId
  ));
  if (listed === undefined) {
    void syncLocalSaves();
    localSaveError.value = '存档列表已变化，请检查后重试';
    return;
  }
  const current = readLocalSaveSlot(storage, listed.slot);
  if (current.kind !== 'valid'
    || current.save.gameId !== observed.gameId
    || current.save.revision !== observed.revision
    || current.recordToken !== observed.recordToken) {
    void syncLocalSaves();
    localSaveError.value = current.kind === 'incompatible' ? current.reason : '存档内容已损坏，无法恢复';
    return;
  }
  let mapPack;
  try { mapPack = getMapPack(current.save.state.mapRef); } catch {
    void syncLocalSaves();
    localSaveError.value = '找不到这局使用的地图版本';
    return;
  }
  const pendingStart = {
    setup: setup.value,
    options: { mapPack },
    state: current.save.state,
  };
  pendingLocalStart.value = pendingStart;
  launchLocalGame(
    pendingStart,
    createLocalSavePersistence(storage, localSaveMutationLock, {
      slot: current.slot,
      gameId: current.save.gameId,
      revision: current.save.revision,
      recordToken: current.recordToken,
    }),
  );
}

async function deleteLocalGame(observed: LocalSaveObservedRecord): Promise<void> {
  if (storage === undefined || localSaveMutationLock === undefined) {
    localSaveError.value = '删除存档失败：当前浏览器不支持安全存档锁';
    return;
  }
  const removed = await removeLocalSaveLocked(storage, localSaveMutationLock, observed);
  if (!removed.ok) {
    localSaveError.value = removed.reason === 'storage_error'
      ? '删除存档失败，请检查存储权限后重试'
      : '存档列表已变化，请检查后重试';
  } else {
    localSaveError.value = null;
  }
  await syncLocalSaves();
}

function returnHome() {
  localStartGuard.cancel();
  localGame.value?.dispose();
  localGame.value = null;
  pendingLocalStart.value = null;
  storagePrompt.value = false;
  replacementSummary.value = null;
  localSaveError.value = null;
  stage.value = 'online';
  resetPageScroll();
  syncStorage();
  void syncLocalSaves();
}

// The shared view emits a single exit intent; the shell resolves it per session. A local game
// tears down and returns home; a live online room leaves over the socket (others see it and the
// room resets reactively); a dead online connection abandons locally so home stays reachable.
function handleGameExit() {
  if (stage.value === 'local_game') {
    returnHome();
    return;
  }
  if (onlineSession.connectionStatus.value === 'connected') {
    void handleLeaveRoom();
  } else {
    onlineSession.abandon();
    syncStorage();
  }
}

function handleStorageEvent(event: StorageEvent): void {
  const identity = localGame.value?.saveIdentity;
  if (identity !== null && identity !== undefined
    && event.key === LOCAL_GAME_SAVE_KEYS[identity.slot - 1]
    && (storage === undefined || hasLocalSaveChanged(storage, identity))) {
    localGame.value?.markStale();
  }
  if (stage.value === 'online') void syncLocalSaves();
}

onMounted(() => globalThis.addEventListener?.('storage', handleStorageEvent));

onBeforeUnmount(() => {
  globalThis.removeEventListener?.('storage', handleStorageEvent);
  localGame.value?.dispose();
  onlineSession.dispose();
});
</script>

<template>
  <RestoreView
    v-if="pageKind === 'restoring'"
    :failure="restoreFailure"
    :error="onlineError"
    @retry="handleRestoreRetry"
    @defer="handleRestoreDefer"
  />
  <HomeView
    v-else-if="pageKind === 'home'"
    :submitting="submitting"
    :resume="resumeOffer"
    :pending-retryable="pendingRetryable"
    :can-resume-active="canResumeActive"
    :initial-room-code="inviteRoomCode"
    :error="onlineError"
    :local-save-error="localSaveError"
    :local-save-cards="localSaveCards"
    :active-maps="activeMaps"
    :initial-map-id="homeMapId"
    @create="handleCreate"
    @join="handleJoin"
    @local="chooseLocal"
    @resume="handleResumePending"
    @abandon-pending="handleAbandonPending"
    @resume-active="handleRestoreRetry"
    @abandon-active="handleAbandonActive"
    @resume-local="resumeLocalGame"
    @delete-local="deleteLocalGame"
  />
  <GameSetup
    v-else-if="pageKind === 'local_setup'"
    :initial-setup="setup"
    :replacement-summary="replacementSummary"
    :storage-unavailable="!storageAvailable"
    :storage-prompt="storagePrompt"
    :save-error="localSaveError"
    @back="returnHome"
    @start="startLocalGame"
    @confirm-replacement="confirmReplacement"
    @cancel-replacement="cancelReplacement"
    @retry-storage="retryLocalStorage"
    @start-temporary="startTemporaryLocalGame"
  />
  <GameView
    v-else-if="(pageKind === 'game' || pageKind === 'settlement') && activeSession"
    :session="activeSession"
    @exit="handleGameExit"
  />
  <LobbyView
    v-else-if="pageKind === 'lobby' && onlineRoom"
    :room="onlineRoom"
    :local-player-id="onlineSession.localPlayerId.value"
    :is-host="onlineSession.isHost.value"
    :start-blocked-reason="onlineSession.startBlockedReason.value"
    :pending-command="onlineSession.pendingCommand.value"
    :is-command-ready="onlineSession.isLobbyCommandReady.value"
    :error="onlineError"
    :invite-url="inviteUrl"
    :connection-label="connectionLabel"
    :show-map-title="activeMaps.length > 1"
    :chat-log="onlineSession.chatLog.value"
    :chat-send="onlineSession.sendChat"
    :room-settings="onlineSession.roomSettings.value"
    @update-settings="handleUpdateRoomSettings"
    @add-bot="handleAddBot"
    @remove-bot="handleRemoveBot"
    @rename-bot="handleRenameBot"
    @kick="handleKick"
    @start="handleStartRoom"
    @leave="handleLeaveRoom"
  />
</template>
