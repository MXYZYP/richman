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
// 新手引导（#109）同样走异步：它整个靠 MobileSheet 撑着，而 MobileSheet 正是上面那批
// 懒加载视图的独占依赖之一——静态引进来会把弹层基建重新塞回首屏包，白费掉这次分包。
// 代价只是首次进站时引导晚一个微任务出现，肉眼看不出来。
const FirstRunGuide = defineAsyncComponent(() => import('./components/FirstRunGuide.vue'));
// 复盘弹窗（#115）同理走异步：它也只靠 MobileSheet 撑着，静态引进来等于把弹层基建塞回首屏包。
// 首页那一份**只用来导入**（exportOutcome 恒为 null）：别人发来一段复盘码时，
// 不该逼玩家先随便开一局才能粘进去。
const ReplayDialogShell = defineAsyncComponent(() => import('./components/ReplayDialog.vue'));
// 地图工坊（#117）同理：它同样只靠 MobileSheet 撑着。工坊的地图**只能单机玩**，
// 所以它不进首页「创建房间」的地图表（那张表仍是生产注册表的十张图），只服务单机设置页。
const MapWorkshopDialogShell = defineAsyncComponent(() => import('./components/MapWorkshopDialog.vue'));
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
import {
  createDefaultGameSetup,
  gameSetupToCreateOptions,
  updateGameSetupMapId,
  type GameSetupDependencies,
  type GameSetupForm,
} from './game/gameSetup';
import { markFirstRunGuideSeen, shouldAutoOpenGuideHere } from './session/firstRunGuide';
import { getMapPack, listActiveMaps, type MapRef } from '@richman/board-data';
import type { RoomRole, RoomSettingsPatch } from '@richman/protocol';
import {
  createCustomMapResolver,
  customMapSummaries,
  describeCustomMapImportFailure,
  exportCustomMapBundle,
  loadCustomMaps,
  mergeMapCatalog,
  parseCustomMapImport,
  persistCustomMaps,
  removeCustomMap,
  upsertCustomMap,
  type CustomMapRecord,
} from './session/customMaps';
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
import type { PublicRoomSummary } from '@richman/protocol';
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

// ---- 地图工坊（#117）：本机自定义地图 ----
// 自定义地图**只服务单机**：联机建房走服务端，而服务端只认内置的那十张图，本机装的图会被直接拒。
// 所以首页「创建房间」的地图表仍是 `activeMaps`（生产注册表的十张），只有单机设置页吃下面这份
// 「生产 + 本机」的合并目录。读回一律容错（坏条目丢弃、坏 JSON 回退空表），此处不需要 try/catch。
const customMapRecords = shallowRef<CustomMapRecord[]>(
  storage === undefined ? [] : loadCustomMaps(storage),
);
const customMapEntries = computed(() => customMapSummaries(customMapRecords.value));
const customMapResolver = computed(() => createCustomMapResolver(customMapRecords.value));
const workshopOpen = ref(false);
const workshopNotice = shallowRef<{ kind: 'ok' | 'error'; message: string; detail?: string | null } | null>(null);
// 工坊只要 localStorage，不像本机存档那样还依赖 Web Locks，所以单独判一次。
const workshopStorageAvailable = computed(() => browserStorage() !== undefined);

const localSetupDependencies = computed<GameSetupDependencies>(() => ({
  catalog: mergeMapCatalog(activeMaps, customMapEntries.value),
  resolveActive: (mapId: string) => {
    // 内置地图优先。目录顺序（mergeMapCatalog 把生产排在前）与这里保持一致：
    // 万一本机存了一张与正式地图同名的图，单机也不该用它顶掉正式地图。
    const production = activeMaps.find((entry) => entry.ref.id === mapId);
    if (production !== undefined) return getMapPack(production.ref);
    const custom = customMapResolver.value(mapId);
    if (custom === null) throw new Error(`Unknown map id: ${mapId}`);
    return custom;
  },
}));

/**
 * 恢复本机存档时按存档里的 `mapRef` 找回地图包：先内置，再本机装的。
 *
 * 必须按**精确 ref**（id + version + contentHash）取——同一 id 换过内容就是另一张图，
 * 用错版本会把存档解到一张对不上的棋盘上。这跟生产 `getMapPack` 的三重比对是同一套标准。
 */
function resolveLocalMapPack(mapRef: MapRef) {
  try {
    return getMapPack(mapRef);
  } catch {
    // 不是内置地图，往下看本机装的。
  }
  const custom = customMapResolver.value(mapRef.id);
  if (custom === null) return null;
  return custom.ref.version === mapRef.version && custom.ref.contentHash === mapRef.contentHash
    ? custom
    : null;
}

function openWorkshop(): void {
  workshopNotice.value = null;
  workshopOpen.value = true;
}

/**
 * 导入一张地图：解析 → 入库 → 落盘 → 回灌提示。
 *
 * 落盘在前、改内存在后：写不进去就什么都不改，宁可让玩家看到「没保存成功」，
 * 也不要造出「界面上有了、刷新就没了」的假象。
 */
function importCustomMap(text: string): void {
  const target = browserStorage();
  if (target === undefined) {
    workshopNotice.value = { kind: 'error', message: describeCustomMapImportFailure('storage'), detail: null };
    return;
  }
  // 只把**内置地图**的 id 列为保留：同一张图改完重导应当是「升级」，不该被判重名。
  const parsed = parseCustomMapImport(text, { reservedIds: activeMaps.map((entry) => entry.ref.id) });
  if (!parsed.ok) {
    workshopNotice.value = {
      kind: 'error',
      message: describeCustomMapImportFailure(parsed.reason),
      detail: parsed.detail,
    };
    return;
  }
  const next = upsertCustomMap(customMapRecords.value, parsed.pack, Date.now());
  if (next === null) {
    workshopNotice.value = { kind: 'error', message: describeCustomMapImportFailure('full'), detail: null };
    return;
  }
  if (!persistCustomMaps(target, next)) {
    workshopNotice.value = { kind: 'error', message: describeCustomMapImportFailure('storage'), detail: null };
    return;
  }
  const title = parsed.pack.metadata.title;
  const existed = customMapRecords.value.some((record) => record.pack.ref.id === parsed.pack.ref.id);
  customMapRecords.value = next;
  // 包内声明的 contentHash 与本机重算不一致时说一句：入库的哈希始终以本机重算为准，
  // 这种不一致通常意味着导出物被手改过，值得让玩家知道。
  const hashNote = parsed.declaredHashMatched ? '' : '（包内声明的哈希与本机重算不一致，已按重算结果登记）';
  workshopNotice.value = {
    kind: 'ok',
    message: `${existed ? '已更新' : '已装好'}「${title}」。${hashNote}`,
    detail: null,
  };
}

function deleteCustomMap(mapId: string): void {
  const target = browserStorage();
  const before = customMapRecords.value;
  const next = removeCustomMap(before, mapId);
  if (next.length === before.length) return;
  if (target === undefined || !persistCustomMaps(target, next)) {
    workshopNotice.value = { kind: 'error', message: describeCustomMapImportFailure('storage'), detail: null };
    return;
  }
  const title = before.find((record) => record.pack.ref.id === mapId)?.pack.metadata.title ?? mapId;
  customMapRecords.value = next;
  workshopNotice.value = { kind: 'ok', message: `已删掉「${title}」。`, detail: null };
}

/** 工坊里点「单机试玩」：关掉弹层，直接进单机设置页并把这张图选好。 */
function playCustomMap(mapId: string): void {
  workshopOpen.value = false;
  chooseLocal(mapId);
}

function customMapBundle(mapId: string): string | null {
  const record = customMapRecords.value.find((entry) => entry.pack.ref.id === mapId);
  return record === undefined ? null : exportCustomMapBundle(record.pack);
}

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

// ---- 新手引导（#109） ----
// 自动弹的条件是「没看过 + 此刻确实在首页」。
// 为什么非要等首页：引导是给第一次进来的人看的，而本版之前的老玩家同样没有「已看过」
// 标记，却可能正落在恢复页或对局里 —— 一进来就盖住棋盘的弹窗，比「没看到引导」糟得多。
// `autoOpened` 只放行一次：即便标记写不进存储（配额已满 / 无痕），也不会每次回首页都弹。
//
// 「已看过」只在**关闭弹层时**落盘：Esc、点背景板、点「知道了」都算明确表态，
// 而首页主动打开**不算**（主动 ≠ 第一次）。与 `session/firstRunGuide.ts` 里
// 「值被写坏宁可再弹一次」是同一条原则 —— 宁可多弹一次，也不要用一个含糊的状态
// 把说明永久关掉，让新玩家再也找不到它。
const guideOpen = ref(false);
let guideAutoOpened = false;
watch(pageKind, (kind) => {
  if (guideAutoOpened) return;
  // 先看一眼再落闩：`guideAutoOpened` 只在真的弹过之后才置真，
  // 否则「首屏落在恢复页」的老玩家会白白消耗掉这次机会。
  if (!shouldAutoOpenGuideHere(browserStorage(), kind, false)) return;
  guideAutoOpened = true;
  guideOpen.value = true;
}, { immediate: true });

function openGuide(): void {
  guideOpen.value = true;
}

function closeGuide(): void {
  guideOpen.value = false;
  markFirstRunGuideSeen(browserStorage());
}

// 首页的「导入复盘」（#115）：与引导同级的常驻弹层，只负责导入。
const replayImportOpen = ref(false);

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

// ---- 公开房间列表（#108） ----

const publicRooms = ref<PublicRoomSummary[]>([]);
const roomListLoading = ref(false);
const roomListError = ref<string | null>(null);

/**
 * 拉取公开房间列表。
 *
 * 失败**不写 `onlineError`**（那是持久错误位，会挡住首页的正常操作）：列表刷不出来只影响
 * 「从列表里挑一局」这条可选路径，用户照样能手输房间码。所以错误单独存在 `roomListError` 里，
 * 由区块内部呈现成一句「刷新失败」。
 *
 * 并发保护用 `roomListLoading`：刷新按钮点两下不该发两个请求（服务端那边也有按 IP 的限流）。
 */
async function refreshPublicRooms(): Promise<void> {
  if (roomListLoading.value) return;
  roomListLoading.value = true;
  try {
    const response = await onlineSession.listRooms();
    if (response.ok) {
      publicRooms.value = response.rooms;
      roomListError.value = null;
    } else {
      roomListError.value = response.message || '房间列表加载失败，请重试';
    }
  } finally {
    roomListLoading.value = false;
  }
}

// 回到首页就刷新一次：刚打完的那局若已结束会从列表里消失，别人新开的房也该出现。
// 只在真正切到 home 时触发，避免在对局中反复请求（服务端有按 IP 的限流）。
// `immediate` 是必需的：没有存档时首屏直接就是 home，那次「切换」根本不会发生。
watch(pageKind, (kind) => {
  if (kind === 'home') void refreshPublicRooms();
}, { immediate: true });

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
  // 依赖里含本机装的自定义地图（#117）：换图时的最高房级夹取（updateGameSetupMapId）
  // 必须按**新图自己的**档位算，所以这里也要用合并目录，不能回落到生产默认依赖。
  setup.value = updateGameSetupMapId(setup.value, mapId, localSetupDependencies.value);
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

/**
 * 复盘回看（#115）：用一份已校验的复盘码换掉当前单机对局，进一个只读的回看会话。
 *
 * 刻意不传 persistence —— 回看不是对局：不该占存档位，更不该覆盖玩家正在进行的存档。
 * 电脑也不自动走（prepareReplayPlayback 已设 autoPlayBots:false）：整局由「回放」驱动，
 * 回看期间任何一方都不会自己行动（localSession 的 runBotTurnIfNeeded 对回看会话直接返回）。
 */
function handleReplayPlay(options: CreateLocalSessionOptions): void {
  localStartGuard.cancel();
  localGame.value?.dispose();
  localGame.value = createLocalSession({ ...options, autoPlayBots: false });
  pendingLocalStart.value = null;
  storagePrompt.value = false;
  replacementSummary.value = null;
  localSaveError.value = null;
  // 复盘可能来自另一张地图：首页那张卡跟着切过去，退出后不会停在上一局的图上。
  if (options.mapPack !== undefined) homeMapId.value = options.mapPack.ref.id;
  stage.value = 'local_game';
  resetPageScroll();
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
  // 必须用与设置页**同一份**依赖：否则玩家在单机设置页选了本机装的自定义地图（#117），
  // 这里却拿生产注册表去解析，会在 `gameSetupToCreateOptions` 里抛「所选地图当前不可用」——
  // 正好造出「设置页让你选、点开始又说没有」的自相矛盾。
  const options = gameSetupToCreateOptions(nextSetup, localSetupDependencies.value);
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
  // 先内置、再本机装的（#117）：单机存档可能用的是一张自定义地图，只查生产注册表会让
  // 「用自定义地图开的局」永远恢复不了。仍按精确 ref 比对——同一 id 换过内容就是另一张图。
  const mapPack = resolveLocalMapPack(current.save.state.mapRef);
  if (mapPack === null) {
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
    :public-rooms="publicRooms"
    :room-list-loading="roomListLoading"
    :room-list-error="roomListError"
    @create="handleCreate"
    @join="handleJoin"
    @refresh-rooms="refreshPublicRooms"
    @open-guide="openGuide"
    @open-replay="replayImportOpen = true"
    @open-workshop="openWorkshop"
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
    :dependencies="localSetupDependencies"
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
    @replay-play="handleReplayPlay"
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

  <!-- 新手引导（#109）：与页面同级的常驻弹层，只在 open 时由 MobileSheet 真正 showModal()。 -->
  <FirstRunGuide :open="guideOpen" @close="closeGuide" />

  <!-- 复盘导入（#115）：首页这一份只给「粘码回看」用，所以 exportOutcome 恒为 null
       （弹窗据此直接落在导入页）。回看会整局换成单机会话，交给同一个 handleReplayPlay。 -->
  <ReplayDialogShell
    :open="replayImportOpen"
    :export-outcome="null"
    @update:open="replayImportOpen = $event"
    @play="handleReplayPlay"
  />

  <!-- 地图工坊（#117）：本机装自定义地图的地方。存储读写全在 App 里（customMaps.ts），
       弹层只管界面，导入/删除结果由 `workshopNotice` 回灌 —— 唯一的事实来源在上一层，
       避免「列表已更新、提示还说失败」这类两处状态打架。 -->
  <MapWorkshopDialogShell
    :open="workshopOpen"
    :maps="customMapEntries"
    :notice="workshopNotice"
    :storage-available="workshopStorageAvailable"
    :bundle-for="customMapBundle"
    @update:open="workshopOpen = $event"
    @import="importCustomMap"
    @remove="deleteCustomMap"
    @play="playCustomMap"
  />
</template>
