import { computed, ref, shallowRef, watch } from 'vue';
import type { ComputedRef, Ref, ShallowRef } from 'vue';
import { createGamePresenter, getAvailableActions, type GamePresenterResult } from './gamePresenter';
import { paceMultiplier } from './playbackPace';
import { io, type Socket } from 'socket.io-client';
import type { BotDifficulty, GameEvent, Intent } from '@richman/engine';
import type {
  Ack,
  ChatMessage,
  ClientToServerEvents,
  CreateRoomAck,
  JoinRoomAck,
  PublicGameSnapshot,
  PublicRoomState,
  ResumeAck,
  RoomRole,
  RoomSettings,
  RoomSettingsPatch,
  ServerToClientEvents,
} from '@richman/protocol';
import { CHAT_TEXT_MAX_LENGTH } from '@richman/protocol';
import type { ClientAction, DisplayCard } from '../game/clientGame';
import { resolvePublicGameSnapshot } from '../game/mapResolver';
import type { CashNotice, ConnectionStatus, GameSession, RenderableGameState, TransientNotice } from './gameSession';
import {
  ACTIVE_ONLINE_SESSION_KEY,
  clearStoredOnlineSession,
  clearPendingRoomRequest,
  commitOnlineSession,
  PENDING_ROOM_REQUEST_KEY,
  readOnlineSession,
  readPendingRoomRequest,
  savePendingRoomRequest,
  type OnlineSession,
  type PendingRoomRequest,
  type StorageLike,
} from './sessionStorage';
import { classifyEntryFailure, type EntryFailureKind } from './appFlow';

type ProductionSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface OnlineSocket {
  readonly connected: boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener?: (...args: never[]) => void): unknown;
  emit(event: string, ...args: unknown[]): unknown;
  connect(): unknown;
  disconnect(): unknown;
}
interface CryptoLike {
  getRandomValues(bytes: Uint8Array): Uint8Array;
}

const browserGlobals = globalThis as typeof globalThis & {
  localStorage?: StorageLike;
  location?: { origin: string };
};
type Operation = 'create' | 'join' | 'resume' | 'start' | 'addBot' | 'removeBot' | 'renameBot' | 'updateSettings' | 'leave' | 'intent' | 'skip' | 'kick';
type LastErrorKind = 'derived' | 'operation' | 'blocking' | 'terminal';
type ReconciliationMarker = {
  readonly generation: number;
  readonly revision: number;
  readonly roomStatus: PublicRoomState['status'] | null;
  readonly botIdsAtEmit: ReadonlySet<string>;
  readonly removeTargetId: string | null;
  readonly renameTargetId: string | null;
  readonly renameExpectedNickname: string | null;
  readonly gameTurn: number | null;
  readonly actorId: string | null;
};
type LastErrorState =
  | { readonly kind: 'derived'; readonly message: string; readonly derivedSource: 'takeover'; readonly debtorId: string | undefined }
  | { readonly kind: 'derived'; readonly message: string; readonly derivedSource: 'offline-debt'; readonly debtorId: string }
  | {
    readonly kind: 'operation';
    readonly message: string;
    readonly code: string;
    readonly operation?: Operation;
    readonly marker?: ReconciliationMarker;
  }
  | { readonly kind: 'blocking'; readonly message: string; readonly code: string }
  | { readonly kind: 'terminal'; readonly message: string };
const MAP_COMPATIBILITY_ERROR = '当前客户端缺少房间所需地图，请刷新或更新后重试。';

/** A host-only lobby mutation. Exactly one may be in flight at a time (single-flight lock). */
export type LobbyCommand = 'start' | 'addBot' | 'removeBot' | 'renameBot' | 'updateSettings' | 'leave' | 'kick';

export interface CreateOnlineSessionOptions {
  url?: string;
  storage?: StorageLike;
  ackTimeoutMs?: number;
  crypto?: CryptoLike;
  socketFactory?: (url: string) => OnlineSocket;
}

export interface OnlineGameSession extends GameSession {
  readonly mode: 'online';
  /**
   * How the last create/join entry failed, or null while none is staged. `definitive`
   * means a same-id retry is futile and the user should abandon; `transient` retries.
   */
  readonly entryFailure: Ref<EntryFailureKind | null>;
  create(nickname: string, mapId: string, botDifficulty?: BotDifficulty): Promise<void>;
  retryPending(): Promise<void>;
  retryResume(): Promise<void>;
  /** Keep the stored session intact, but suppress automatic recovery until explicitly retried. */
  deferResume(): void;
  /**
   * Explicitly discard a staged (failed) create/join entry. Clears in-memory staging only
   * after the pending request leaves storage, so a rejected removal keeps the entry
   * retryable and refresh-consistent. Returns whether the abort committed.
   */
  abortEntry(): boolean;
  /**
   * Explicitly discard the stored active session (「放弃这局」). Clears in-memory state only
   * after the record leaves storage; a rejected removal keeps it and reports a safe error.
   */
  discardStoredSession(): boolean;
  /**
   * Give up an in-game session locally and return home, even when the socket is down and a
   * server `room:leave` can never be acknowledged. Storage-first: clears the stored record before
   * the in-memory room/state, so a rejected removal keeps everything intact and reports a safe
   * error. Returns whether the abandon committed. Used by the failed-connection banner.
   */
  abandon(): boolean;
  join(roomCode: string, nickname: string, role?: RoomRole): Promise<void>;
  /** True when the authenticated member id belongs to the room's spectator roster. */
  readonly isSpectator: ComputedRef<boolean>;
  /** True when the local player is the room host — the only role allowed to mutate the lobby. */
  readonly isHost: ComputedRef<boolean>;
  /**
   * True only when a live, recovered, owned session can accept a lobby mutation — connected,
   * active, and not mid-recovery. The UI disables every host control (add/remove/start/leave)
   * while this is false so a stale lobby never fires a doomed command.
   */
  readonly isLobbyCommandReady: ComputedRef<boolean>;
  /** The lobby command currently awaiting a server acknowledgement, or null while idle. */
  readonly pendingCommand: Ref<LobbyCommand | null>;
  /** A human reason the game cannot start yet, or null when the host may start. */
  readonly startBlockedReason: ComputedRef<string | null>;
  /**
   * 房间设置（#4 规则自定义 / #6 电脑难度）的权威副本，由服务端 `room:settings` 广播/单播驱动。
   * `null` = 尚未收到（刚进大厅的一瞬），UI 应等它到位再渲染设置面板，避免闪一帧默认值。
   */
  readonly roomSettings: Ref<RoomSettings | null>;
  /** 房主修改房间设置（仅大厅阶段生效；服务端会拒绝非房主与已开局房间）。 */
  updateRoomSettings(patch: RoomSettingsPatch): Promise<void>;
  start(): Promise<void>;
  addBot(): Promise<void>;
  removeBot(playerId: string): Promise<void>;
  renameBot(playerId: string, nickname: string): Promise<void>;
  kickPlayer(playerId: string): Promise<void>;
}

const DEFAULT_ACK_TIMEOUT_MS = 8_000;
const ERROR_MESSAGES: Record<string, string> = {
  INVALID_TOKEN: '会话已失效，请重新加入房间',
  ROOM_NOT_FOUND: '房间不存在或已关闭',
  ROOM_FULL: '房间人数已满',
  GAME_ALREADY_STARTED: '游戏已开始，无法加入（仅可切换为观战）',
  NICKNAME_TAKEN: '昵称已被使用，请换一个',
  NOT_HOST: '只有房主可以执行此操作',
  INVALID_NICKNAME: '昵称需为 1 至 20 个字符',
  NOT_ENOUGH_PLAYERS: '至少需要 2 名玩家才能开始',
  INVALID_ROOM_ACTION: '当前房间状态无法执行此操作',
  CREATE_RATE_LIMITED: '创建房间过于频繁，请稍后再试',
  REQUEST_TIMEOUT: '请求超时，请重试',
  OPERATION_IN_PROGRESS: '请求正在处理中',
  DISCONNECTED: '连接已断开，请重试',
  SESSION_NOT_RECOVERED: '会话尚未恢复，请重试',
  STORAGE_UNAVAILABLE: '无法更新本地存档，请稍后重试',
  CONNECT_ERROR: '无法连接服务器，请重试',
};
const INTENT_REJECTION_MESSAGES: Readonly<Record<string, string>> = {
  OPERATION_IN_PROGRESS: '操作过快，请稍候重试',
  INSUFFICIENT_FUNDS: '现金不足',
  WRONG_PHASE: '当前阶段不能执行这个操作',
  NOT_YOUR_TURN: '还没轮到你行动',
  ILLEGAL_INTENT: '这个操作现在不可用',
};
const TRANSIENT_NOTICE_MS = 2_500;
const ERROR_PRIORITY: Readonly<Record<LastErrorKind, number>> = {
  derived: 1,
  operation: 2,
  blocking: 3,
  terminal: 4,
};
const BLOCKING_ERROR_CODES = new Set([
  'INVALID_TOKEN',
  'ROOM_NOT_FOUND',
  'DISCONNECTED',
  'SESSION_NOT_RECOVERED',
  'STORAGE_UNAVAILABLE',
  'CONNECT_ERROR',
]);

function browserStorage(): StorageLike {
  if (browserGlobals.localStorage === undefined) throw new Error('Online session storage is required outside a browser');
  return browserGlobals.localStorage;
}

function publicError(code: string): string {
  return ERROR_MESSAGES[code] ?? '操作未完成，请重试';
}

function requestId(crypto: CryptoLike): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

/** A shared empty id set for reconciliation markers of non-add-bot commands (never mutated). */
const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

/** Recover a remove-bot's target player id from its emit arguments, or null when absent. */
function removeTargetOf(args: readonly unknown[]): string | null {
  const payload = args[0];
  if (payload !== null && typeof payload === 'object' && 'playerId' in payload) {
    const { playerId } = payload;
    if (typeof playerId === 'string') return playerId;
  }
  return null;
}

function renamePayloadOf(args: readonly unknown[]): { playerId: string; nickname: string } | null {
  const payload = args[0];
  if (payload !== null && typeof payload === 'object' && 'playerId' in payload && 'nickname' in payload) {
    const { playerId, nickname } = payload;
    if (typeof playerId === 'string' && typeof nickname === 'string') {
      return { playerId, nickname };
    }
  }
  return null;
}

export function createOnlineSession(options: CreateOnlineSessionOptions = {}): OnlineGameSession {
  const storage = options.storage ?? browserStorage();
  const crypto = options.crypto ?? globalThis.crypto;
  const socket = (options.socketFactory ?? ((url: string): OnlineSocket => {
    const productionSocket: ProductionSocket = io(url);
    return productionSocket as unknown as OnlineSocket;
  })) (options.url ?? browserGlobals.location?.origin ?? '');
  const ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  const state = shallowRef<RenderableGameState | null>(null);
  const room = shallowRef<PublicRoomState | null>(null);
  const localPlayerId = ref<string | null>(null);
  const connectionStatus = ref<ConnectionStatus>(socket.connected ? 'connected' : 'connecting');
  const displayPositions = ref<Record<string, number>>({});
  const dice = ref<number[] | null>(null);
  const activeCard = ref<DisplayCard | null>(null);
  const eventMessage = ref('');
  const isAnimating = ref(false);
  const isBotThinking = ref(false);
  const connectionReady = deferred<void>();
  if (socket.connected) connectionReady.resolve();
  const lastError = ref<string | null>(null);
  let lastErrorState: LastErrorState | null = null;
  const setLastError = (next: LastErrorState): void => {
    if (lastErrorState !== null && ERROR_PRIORITY[next.kind] < ERROR_PRIORITY[lastErrorState.kind]) return;
    lastErrorState = next;
    lastError.value = next.message;
  };
  const clearLastError = (matches: (current: LastErrorState) => boolean = () => true): void => {
    if (lastErrorState === null || !matches(lastErrorState)) return;
    lastErrorState = null;
    lastError.value = null;
  };
  const clearOperationError = (operation: Operation, marker?: ReconciliationMarker): void => {
    clearLastError((current) => (
      current.kind === 'operation'
      && current.operation === operation
      && (marker === undefined || current.marker === marker)
    ));
  };
  const compatibilityError = ref<string | null>(null);
  const entryFailure = ref<EntryFailureKind | null>(null);
  const pendingCommand = ref<LobbyCommand | null>(null);
  const cashNotices = ref<CashNotice[]>([]);
  const displayCash = ref<Record<string, number>>({});
  const transientNotice = ref<TransientNotice | null>(null);
  let transientNoticeId = 0;
  const chatLog = ref<ChatMessage[]>([]);
  /** 房间设置（#4 / #6）：服务端广播的权威副本，仅大厅期间有意义。 */
  const roomSettings = ref<RoomSettings | null>(null);
  let transientNoticeTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  type Attempt<T extends object> = {
    settled: boolean;
    timer: Parameters<typeof globalThis.clearTimeout>[0];
    resolve: (response: Ack<T>) => void;
    finish: (response: Ack<T>) => void;
    readonly marker: ReconciliationMarker;
  };
  type ConnectionWaiter = {
    timer: Parameters<typeof globalThis.clearTimeout>[0];
    resolve: () => void;
  };
  type EntryAttempt = {
    readonly request: PendingRoomRequest;
    room: PublicRoomState | null;
    roomFromBroadcast: boolean;
    snapshot: PublicGameSnapshot | null;
    eventBatches: GameEvent[][];
    transitions: Array<{ events: GameEvent[]; snapshot: PublicGameSnapshot }>;
  };
  const inFlight = new Map<Operation, Attempt<object>>();
  const timedOutMarkers = new Map<Operation, ReconciliationMarker[]>();
  const preconnectWaiters = new Set<ConnectionWaiter>();
  let entryAttempt: EntryAttempt | null = null;
  let activeSession: OnlineSession | null = null;
  let hasActiveSession = false;
  let disposed = false;
  const clearTransientNotice = (id: number): void => {
    if (transientNotice.value?.id !== id) return;
    transientNotice.value = null;
    if (transientNoticeTimer !== undefined) {
      globalThis.clearTimeout(transientNoticeTimer);
      transientNoticeTimer = undefined;
    }
  };
  const clearTransientFeedback = (): void => {
    if (transientNoticeTimer !== undefined) {
      globalThis.clearTimeout(transientNoticeTimer);
      transientNoticeTimer = undefined;
    }
    transientNotice.value = null;
  };
  const showTransientNotice = (code: string): boolean => {
    const message = INTENT_REJECTION_MESSAGES[code];
    if (message === undefined || disposed) return false;
    clearLastError((current) => current.kind === 'operation' || current.kind === 'derived');
    clearTransientFeedback();
    const id = ++transientNoticeId;
    transientNotice.value = { id, message };
    transientNoticeTimer = globalThis.setTimeout(() => clearTransientNotice(id), TRANSIENT_NOTICE_MS);
    return true;
  };
  const handleFailure = (operation: Operation, code: string, marker?: ReconciliationMarker): void => {
    if (operation === 'intent' && showTransientNotice(code)) return;
    fail(code, operation, marker);
  };
  let generation = 0;
  let authoritativeRevision = 0;
  const pendingTransitionRevisions: number[] = [];
  let stagedEntry: EntryAttempt | null = null;
  let resumeGeneration = 0;
  let resumePromise: Promise<void> | null = null;
  let resumeDeferred = false;
  let connectedHandled = false;
  // True between an explicit retry that re-opens a dead transport and the next connect/disconnect,
  // so a second retry never fires a duplicate socket.connect() while one is already in flight.
  let reconnectPending = false;
  let presenter: GamePresenterResult | null = null;
  let stopPresenterSync: Array<() => void> = [];
  const clearRenderedState = (): void => {
    presenter?.dispose();
    for (const stop of stopPresenterSync) stop();
    stopPresenterSync = [];
    presenter = null;
    pendingTransitionRevisions.length = 0;
    state.value = null;
    displayPositions.value = {};
    displayCash.value = {};
    dice.value = null;
    activeCard.value = null;
    eventMessage.value = '';
    isAnimating.value = false;
    cashNotices.value = [];
  };
  const rejectIncompatibleSnapshot = (): void => {
    clearRenderedState();
    compatibilityError.value = MAP_COMPATIBILITY_ERROR;
  };
  const resetAuthoritativeRecovery = (): void => {
    generation += 1;
    pendingTransitionRevisions.length = 0;
    timedOutMarkers.clear();
    for (const [operation, attempt] of inFlight) {
      if (operation === 'resume' || attempt.settled) continue;
      attempt.settled = true;
      globalThis.clearTimeout(attempt.timer);
      inFlight.delete(operation);
      attempt.resolve({ ok: false, code: 'DISCONNECTED', message: '' });
    }
  };


  const clearSession = (): void => {
    try { storage.removeItem(ACTIVE_ONLINE_SESSION_KEY); } catch { /* storage is optional */ }
    activeSession = null;
    hasActiveSession = false;
    localPlayerId.value = null;
  };
  const clearPending = (): void => {
    try { storage.removeItem(PENDING_ROOM_REQUEST_KEY); } catch { /* storage is optional */ }
  };
  const resetSession = (): void => {
    resumeGeneration += 1;
    cancelResume();
    resetAuthoritativeRecovery();
    clearPending();
    clearSession();
    entryAttempt = null;
    stagedEntry = null;
    clearRenderedState();
    compatibilityError.value = null;
    room.value = null;
    roomSettings.value = null;
    chatLog.value = [];
    clearTransientFeedback();
  };
  const withCurrentPresence = (snapshot: RenderableGameState): RenderableGameState => {
    const currentRoom = room.value;
    if (currentRoom === null) return snapshot;
    if (!Array.isArray(snapshot.players)) return snapshot;
    const onlineById = new Map(currentRoom.players.map((player) => [player.id, player.online]));
    return {
      ...snapshot,
      players: snapshot.players.map((player) => ({
        ...player,
        online: onlineById.get(player.id) ?? player.online,
      })),
    };

  };
  const refreshTakeoverStatus = (currentState: RenderableGameState | null = state.value): void => {
    if (room.value?.takeoverPlayerId === localPlayerId.value) {
      const debtorId = currentState?.debt?.debtorId;
      const debtor = room.value.players.find((player) => player.id === debtorId);
      setLastError({
        kind: 'derived',
        message: debtor === undefined ? '房主托管正在执行' : `需要 ${debtor.nickname} 回来处理债务`,
        derivedSource: 'takeover',
        debtorId,
      });
      return;
    }
    if (lastErrorState?.kind === 'derived' && lastErrorState.derivedSource === 'offline-debt') {
      const debtorId = currentState?.debt?.debtorId;
      const debtor = room.value?.players.find((player) => player.id === debtorId);
      if (debtorId === lastErrorState.debtorId && debtor !== undefined && !debtor.online) {
        setLastError({
          kind: 'derived',
          message: `需要 ${debtor.nickname} 回来处理债务`,
          derivedSource: 'offline-debt',
          debtorId: debtor.id,
        });
        return;
      }
    }
    clearLastError((current) => current.kind === 'derived');
  };
  const applyRoom = (nextRoom: PublicRoomState): void => {
    if (disposed) return;
    room.value = nextRoom;
    if (state.value !== null) state.value = withCurrentPresence(state.value);
    refreshTakeoverStatus();
  };
  const resolveSnapshot = (snapshot: PublicGameSnapshot): RenderableGameState | null => {
    try {
      const renderable = resolvePublicGameSnapshot(snapshot);
      compatibilityError.value = null;
      return renderable;
    } catch {
      rejectIncompatibleSnapshot();
      return null;
    }
  };
  const ensurePresenter = (snapshot: RenderableGameState): GamePresenterResult => {
    if (presenter !== null) return presenter;
    presenter = createGamePresenter(snapshot, undefined, paceMultiplier);
    stopPresenterSync = [
      watch(presenter.state, (next) => { state.value = withCurrentPresence(next); }, { flush: 'sync' }),
      watch(presenter.displayPositions, (next) => { displayPositions.value = next; }, { flush: 'sync' }),
      watch(presenter.dice, (next) => { dice.value = next; }, { flush: 'sync' }),
      watch(presenter.activeCard, (next) => { activeCard.value = next; }, { flush: 'sync' }),
      watch(presenter.eventMessage, (next) => { eventMessage.value = next; }, { flush: 'sync' }),
      watch(presenter.isAnimating, (next) => { isAnimating.value = next; }, { flush: 'sync' }),
      watch(presenter.cashNotices, (next) => { cashNotices.value = next; }, { flush: 'sync' }),
      watch(presenter.displayCash, (next) => { displayCash.value = next; }, { flush: 'sync' }),
    ];
    state.value = withCurrentPresence(snapshot);
    displayPositions.value = presenter.displayPositions.value;
    dice.value = presenter.dice.value;
    activeCard.value = presenter.activeCard.value;
    eventMessage.value = presenter.eventMessage.value;
    isAnimating.value = presenter.isAnimating.value;
    cashNotices.value = presenter.cashNotices.value;
    displayCash.value = presenter.displayCash.value;
    return presenter;
  };
  const applySnapshot = (snapshot: PublicGameSnapshot, reset = false): boolean => {
    if (disposed) return false;
    if (!Array.isArray(snapshot.players)) {
      rejectIncompatibleSnapshot();
      return false;
    }
    const renderable = resolveSnapshot(snapshot);
    if (renderable === null) return false;
    const currentPresenter = ensurePresenter(renderable);
    if (reset) currentPresenter.reset(renderable);
    else void currentPresenter.receiveSnapshot(renderable).catch(() => undefined);
    refreshTakeoverStatus(renderable);
    return true;
  };
  const fail = (code: string, operation?: Operation, marker?: ReconciliationMarker): void => {
    if (disposed) return;
    if (BLOCKING_ERROR_CODES.has(code)) {
      setLastError({ kind: 'blocking', message: publicError(code), code });
      return;
    }
    setLastError({ kind: 'operation', message: publicError(code), code, operation, marker });
  };
  const canIssueActiveCommands = (): boolean => {
    const stored = readOnlineSession(storage);
    const entryRecoveryLocked = readPendingRoomRequest(storage) !== null && activeSession === null;
    return stored !== null
      && activeSession !== null
      && stored.roomCode === activeSession.roomCode
      && stored.playerId === activeSession.playerId
      && stored.token === activeSession.token
      && socket.connected
      && connectionStatus.value === 'connected'
      && resumePromise === null
      && !entryRecoveryLocked;
  };
  const isHost = computed(() => room.value !== null && room.value.hostId === localPlayerId.value);
  // Real command authority for the UI: a live, recovered, owned session — connected, active, and
  // not mid-recovery. Derived from connectionStatus (which flips to 'reconnecting' on disconnect
  // and during resume) so a stale lobby left on screen disables every mutation until resume lands.
  const isLobbyCommandReady = computed(() =>
    room.value !== null
    && localPlayerId.value !== null
    && socket.connected
    && connectionStatus.value === 'connected',
  );
  // Spectator identity is derived, never stored: the authenticated member id (playerId) is
  // looked up in the room's spectator roster, so a resume restores the same role and a
  // spectator id is never mistaken for an engine player.
  const isSpectator = computed(() => {
    const currentRoom = room.value;
    const memberId = localPlayerId.value;
    return currentRoom !== null && memberId !== null && currentRoom.spectators.some((member) => member.id === memberId);
  });
  const startBlockedReason = computed<string | null>(() => {
    const currentRoom = room.value;
    // Ordering mirrors the lobby's control hierarchy: only the host acts, single-flight beats
    // everything, an unsynced socket beats a stale roster, then the server's own start rule.
    if (currentRoom === null) return '正在与房间同步，请稍候';
    if (currentRoom.hostId !== localPlayerId.value) return '只有房主可以开始游戏';
    if (pendingCommand.value !== null) return '正在处理上一步操作';
    if (!socket.connected || connectionStatus.value !== 'connected') return '正在与房间同步，请稍候';
    if (currentRoom.players.length < 2) return '至少需要 2 位玩家';
    if (currentRoom.players.every((player) => player.isBot)) return '至少需要 1 位真人玩家';
    return null;
  });
  const activeActorId = computed(() => state.value?.debt?.debtorId ?? state.value?.currentPlayerId ?? null);
  const canControlActiveActor = computed(() => {
    const current = state.value;
    const currentRoom = room.value;
    const actorId = activeActorId.value;
    const actor = currentRoom?.players.find((player) => player.id === actorId);
    return current !== null
      && actorId !== null
      && localPlayerId.value === actorId
      && actor !== undefined
      && actor.online
      && !actor.isBot
      && currentRoom?.takeoverPlayerId !== localPlayerId.value
      && socket.connected
      && connectionStatus.value === 'connected'
      && !isAnimating.value;
  });
  const canSkipOfflineTurn = computed(() => {
    const current = state.value;
    const currentRoom = room.value;
    const actorId = activeActorId.value;
    const actor = currentRoom?.players.find((player) => player.id === actorId);
    return current !== null
      && current.debt === null
      && currentRoom?.hostId === localPlayerId.value
      && currentRoom.takeoverPlayerId === null
      && actor !== undefined
      && !actor.isBot
      && !actor.online;
  });
  const emitAck = async <T extends object>(operation: Operation, event: keyof ClientToServerEvents, ...args: unknown[]): Promise<Ack<T>> => {
    const commandGeneration = generation;
    const noticeIdAtStart = transientNotice.value?.id;
    if (operation !== 'create' && operation !== 'join' && operation !== 'resume' && !canIssueActiveCommands()) {
      handleFailure(operation, 'SESSION_NOT_RECOVERED');
      return { ok: false, code: 'SESSION_NOT_RECOVERED', message: '' };
    }
    if (!socket.connected && !disposed) {
      const connectionTimeout = deferred<void>();
      const waiter: ConnectionWaiter = {
        timer: globalThis.setTimeout(connectionTimeout.resolve, ackTimeoutMs),
        resolve: connectionTimeout.resolve,
      };
      preconnectWaiters.add(waiter);
      await Promise.race([connectionReady.promise, connectionTimeout.promise]);
      globalThis.clearTimeout(waiter.timer);
      preconnectWaiters.delete(waiter);
    }
    if (disposed || commandGeneration !== generation || !socket.connected) {
      handleFailure(operation, 'DISCONNECTED');
      return { ok: false, code: 'DISCONNECTED', message: '' };
    }
    if (inFlight.has(operation)) {
      handleFailure(operation, 'OPERATION_IN_PROGRESS', inFlight.get(operation)?.marker);
      return { ok: false, code: 'OPERATION_IN_PROGRESS', message: '' };
    }

    const pending = deferred<Ack<T>>();
    const marker: ReconciliationMarker = {
      generation: commandGeneration,
      revision: authoritativeRevision,
      roomStatus: room.value?.status ?? null,
      botIdsAtEmit: operation === 'addBot'
        ? new Set((room.value?.players ?? []).filter((player) => player.isBot).map((player) => player.id))
        : EMPTY_ID_SET,
      removeTargetId: operation === 'removeBot' ? removeTargetOf(args) : null,
      renameTargetId: operation === 'renameBot' ? renamePayloadOf(args)?.playerId ?? null : null,
      renameExpectedNickname: operation === 'renameBot'
        ? (renamePayloadOf(args)?.nickname.trim() ?? null)
        : null,
      gameTurn: state.value?.turn ?? null,
      actorId: activeActorId.value,
    };
    const attempt: Attempt<T> = {
      settled: false,
      timer: undefined,
      resolve: pending.resolve,
      finish: () => undefined,
      marker,
    };
    const owner = attempt as unknown as Attempt<object>;
    const finish = (response: Ack<T>): void => {
      if (attempt.settled) return;
      attempt.settled = true;
      globalThis.clearTimeout(attempt.timer);
      if (operation === 'resume') resumePromise = null;
      if (inFlight.get(operation) === owner) inFlight.delete(operation);
      attempt.resolve(response);
    };
    attempt.finish = finish;
    attempt.timer = globalThis.setTimeout(() => finish({ ok: false, code: 'REQUEST_TIMEOUT', message: '' }), ackTimeoutMs);
    inFlight.set(operation, owner);
    socket.emit(event, ...args, finish);
    const response = await pending.promise;
    if (!disposed && commandGeneration === generation) {
      if (!response.ok && response.code === 'REQUEST_TIMEOUT' && (
        operation === 'start'
        || operation === 'addBot'
        || operation === 'removeBot'
        || operation === 'renameBot'
        || operation === 'intent'
        || operation === 'skip'
      )) {
        const markers = timedOutMarkers.get(operation) ?? [];
        markers.push(attempt.marker);
        timedOutMarkers.set(operation, markers);
      }
      if (!response.ok && !(operation === 'resume' && resumeDeferred)) handleFailure(operation, response.code, attempt.marker);
      if (response.ok) {
        clearOperationError(operation);
      }
      if (response.ok && noticeIdAtStart !== undefined) clearTransientNotice(noticeIdAtStart);
    }
    return response;
  };

  const reconcileRoom = (nextRoom: PublicRoomState): void => {
    reconcileStart(nextRoom);
    reconcileAddBot(nextRoom);
    reconcileRemoveBot(nextRoom);
    reconcileRenameBot(nextRoom);
  };
  // A newer authoritative room within the same recovery generation is proof a lost-ack command
  // landed: the status progressed to playing, an unseen bot joined, or the target bot left. Each
  // matches only its own kind of change, so an unrelated broadcast never falsely settles a command.
  const reconcileOperation = (
    operation: Operation,
    revision: number | undefined,
    matches: (marker: ReconciliationMarker) => boolean,
  ): void => {
    if (revision === undefined) return;
    const attempt = inFlight.get(operation);
    const markers = timedOutMarkers.get(operation);
    const markerIndex = markers?.findIndex((marker) => (
      marker.generation === generation
      && revision > marker.revision
      && matches(marker)
    )) ?? -1;
    if (markers !== undefined && markerIndex >= 0) {
      const [timedOutMarker] = markers.splice(markerIndex, 1);
      if (markers.length === 0) timedOutMarkers.delete(operation);
      clearOperationError(operation, timedOutMarker);
      return;
    }
    if (attempt === undefined) return;
    const marker = attempt.marker;
    if (marker?.generation !== generation || revision <= marker.revision || !matches(marker)) return;
    attempt.finish({ ok: true });
  };
  const reconcileStart = (nextRoom: PublicRoomState): void => {
    reconcileOperation('start', authoritativeRevision, (marker) => (
      marker.roomStatus !== 'playing' && nextRoom.status === 'playing'
    ));
  };
  const reconcileAddBot = (nextRoom: PublicRoomState): void => {
    reconcileOperation('addBot', authoritativeRevision, (marker) => (
      nextRoom.players.some((player) => player.isBot && !marker.botIdsAtEmit.has(player.id))
    ));
  };
  const reconcileRemoveBot = (nextRoom: PublicRoomState): void => {
    reconcileOperation('removeBot', authoritativeRevision, (marker) => (
      marker.removeTargetId !== null
      && !nextRoom.players.some((player) => player.id === marker.removeTargetId)
    ));
  };
  const reconcileRenameBot = (nextRoom: PublicRoomState): void => {
    reconcileOperation('renameBot', authoritativeRevision, (marker) => {
      if (marker.renameTargetId === null || marker.renameExpectedNickname === null) return false;
      const target = nextRoom.players.find((player) => player.id === marker.renameTargetId);
      return target !== undefined && target.nickname === marker.renameExpectedNickname;
    });
  };
  const reconcileTransition = (eventRevision: number | undefined, snapshot: PublicGameSnapshot): void => {
    reconcileOperation('intent', eventRevision, () => true);
    reconcileOperation('skip', eventRevision, (marker) => (
      marker.gameTurn !== snapshot.turn
      || marker.actorId !== (snapshot.debt?.debtorId ?? snapshot.currentPlayerId)
    ));
  };
  const onRoomState = (nextRoom: PublicRoomState): void => {
    authoritativeRevision += 1;
    const entryOwner = entryAttempt ?? stagedEntry;
    if (entryOwner !== null) {
      entryOwner.room = nextRoom;
      entryOwner.roomFromBroadcast = true;
      return;
    }
    if (!hasActiveSession) return;
    applyRoom(nextRoom);
    reconcileRoom(nextRoom);
    refreshTakeoverStatus();
  };
  const onConnection = (change: { playerId: string; online: boolean }): void => {
    if (disposed || !hasActiveSession || !room.value) return;
    // The server reuses this broadcast for spectator presence: the id matches exactly one of
    // the two rosters, so both are mapped and the other is left untouched.
    applyRoom({
      ...room.value,
      players: room.value.players.map((player) => player.id === change.playerId ? { ...player, online: change.online } : player),
      spectators: room.value.spectators.map((member) => member.id === change.playerId ? { ...member, online: change.online } : member),
    });
  };
  const onClosed = (payload: { reason?: string }): void => {
    if (disposed || entryAttempt !== null) return;
    resetSession();
    const messages: Record<string, string> = {
      empty_lobby: '房间因无人而关闭',
      lobby_idle_timeout: '房间等待超时已关闭',
      game_over: '本局游戏已结束',
    };
    setLastError({ kind: 'terminal', message: messages[payload.reason ?? ''] ?? '房间已关闭' });
    connectionStatus.value = 'failed';
  };
  const onEvents = (payload: { events: GameEvent[] }): void => {
    if (disposed) return;
    authoritativeRevision += 1;
    const entryOwner = entryAttempt ?? stagedEntry;
    if (entryOwner !== null) {
      entryOwner.eventBatches.push(payload.events);
      return;
    }
    pendingTransitionRevisions.push(authoritativeRevision);
    if (hasActiveSession) presenter?.receiveEvents(payload.events);
  };
  const onSnapshot = (payload: { state: PublicGameSnapshot }): void => {
    if (disposed) return;
    authoritativeRevision += 1;
    const entryOwner = entryAttempt ?? stagedEntry;
    if (entryOwner !== null) {
      const events = entryOwner.eventBatches.shift();
      if (events === undefined) entryOwner.snapshot = payload.state;
      else entryOwner.transitions.push({ events, snapshot: payload.state });
      return;
    }
    const eventRevision = pendingTransitionRevisions.shift();
    reconcileTransition(eventRevision, payload.state);
    if (hasActiveSession) applySnapshot(payload.state);
  };
  const resumeStoredSession = (): Promise<void> => {
    if (resumePromise !== null) return resumePromise;
    const active = readOnlineSession(storage);
    if (resumeDeferred || !active || disposed || !socket.connected) return Promise.resolve();
    const owner = ++resumeGeneration;
    const resume = async (): Promise<void> => {
      connectionStatus.value = 'reconnecting';
      const ack = await emitAck<ResumeAck>('resume', 'session:resume', active);
      if (disposed || owner !== resumeGeneration) return;
      if (!ack.ok) {
        if (ack.code === 'INVALID_TOKEN' || ack.code === 'ROOM_NOT_FOUND') {
          resetSession();
        }
        connectionStatus.value = 'failed';
        return;
      }
      resetAuthoritativeRecovery();
      activeSession = active;
      hasActiveSession = true;
      localPlayerId.value = active.playerId;
      applyRoom(ack.room);
      const snapshotCompatible = ack.snapshot === undefined || applySnapshot(ack.snapshot, true);
      if (snapshotCompatible) {
        clearLastError();
        refreshTakeoverStatus();
      }
      connectionStatus.value = 'connected';
    };
    const promise = resume();
    resumePromise = promise;
    return promise;
  };
  const cancelResume = (): void => {
    const attempt = inFlight.get('resume');
    if (attempt === undefined || attempt.settled) return;
    attempt.settled = true;
    globalThis.clearTimeout(attempt.timer);
    inFlight.delete('resume');
    attempt.resolve({ ok: false, code: 'DISCONNECTED', message: '' });
    resumePromise = null;
  };
  const onChat = (message: ChatMessage): void => {
    if (disposed) return;
    chatLog.value.push(message);
    if (chatLog.value.length > 200) chatLog.value.splice(0, chatLog.value.length - 200);
  };
  // 服务端单播的“最近聊天”快照（进入房间 / 重连时）：以服务端为准整体覆盖，
  // 这样刷新页面、换设备重连后仍然看得到之前的聊天记录。
  const onChatHistory = (payload: { messages: ChatMessage[] }): void => {
    if (disposed) return;
    if (!Array.isArray(payload?.messages)) return;
    chatLog.value = payload.messages.slice(-200);
  };
  // 房间设置（#4 / #6）由服务端广播/单播，整间共用一份：直接整体覆盖即可（低频、幂等）。
  const onRoomSettings = (settings: RoomSettings): void => {
    if (disposed) return;
    roomSettings.value = {
      botDifficulty: settings.botDifficulty,
      ruleConfig: settings.ruleConfig ?? null,
    };
  };
  const onConnect = (): void => {
    connectionReady.resolve();
    reconnectPending = false;
    if (disposed || connectedHandled) return;
    connectedHandled = true;
    if (resumeDeferred || readOnlineSession(storage) === null) {
      clearLastError((current) => current.kind === 'blocking' && (current.code === 'CONNECT_ERROR' || current.code === 'DISCONNECTED'));
      connectionStatus.value = 'connected';
      return;
    }
    void resumeStoredSession();
  };
  const onDisconnect = (): void => {
    connectedHandled = false;
    reconnectPending = false;
    resumeGeneration += 1;
    cancelResume();
    if (!disposed) connectionStatus.value = 'reconnecting';
  };
  const onConnectError = (): void => {
    // A failed transport attempt is terminal for this retry cycle. Release the latch so a
    // subsequent explicit retry can open a fresh transport; dispose makes late errors inert.
    reconnectPending = false;
    if (disposed) return;
    connectionStatus.value = 'failed';
    fail('CONNECT_ERROR');
  };

  socket.on('room:state', onRoomState);
  socket.on('player:connection', onConnection);
  socket.on('room:closed', onClosed);
  socket.on('game:events', onEvents);
  socket.on('game:snapshot', onSnapshot);
  socket.on('room:chat_broadcast', onChat);
  socket.on('room:chat_history', onChatHistory);
  socket.on('room:settings', onRoomSettings);
  socket.on('connect', onConnect);
  socket.on('disconnect', onDisconnect);
  socket.on('connect_error', onConnectError);
  if (socket.connected) onConnect();

  const submit = async (request: PendingRoomRequest): Promise<void> => {
    if (entryAttempt !== null || (stagedEntry !== null && stagedEntry.request.requestId !== request.requestId)) {
      fail('OPERATION_IN_PROGRESS', request.operation);
      return;
    }
    clearLastError((current) => current.kind === 'terminal' || current.kind === 'blocking');
    // 持久化待恢复请求仅用于断线重连，属"尽力而为"：localStorage 不可用/写满/隐私模式时不应阻断
    // 建房/进房，更不应误报成"请求超时"（会让用户误判为网络问题）。保存失败仅意味着失去自动恢复能力。
    savePendingRoomRequest(storage, request);
    const owner = stagedEntry?.request.requestId === request.requestId
      ? stagedEntry
      : { request, room: null, roomFromBroadcast: false, snapshot: null, eventBatches: [], transitions: [] };
    stagedEntry = null;
    entryAttempt = owner;
    try {
      const ack = request.operation === 'create'
        ? await emitAck<CreateRoomAck>('create', 'room:create', {
          nickname: request.nickname,
          requestId: request.requestId,
          mapId: request.mapId,
          ...(request.botDifficulty !== undefined && request.botDifficulty !== 'normal' ? { botDifficulty: request.botDifficulty } : {}),
        })
        : await emitAck<JoinRoomAck>('join', 'room:join', {
          roomCode: request.roomCode,
          nickname: request.nickname,
          requestId: request.requestId,
          role: request.role,
        });
      if (!ack.ok || disposed || entryAttempt !== owner) {
        if (!disposed && entryAttempt === owner) {
          stagedEntry = owner;
          if (!ack.ok) {
            entryFailure.value = classifyEntryFailure(ack.code);
            // 失败原因必须落到界面上：只有「上次操作未完成」这一句话，玩家既不知道
            // 为什么失败，也不知道该等还是该改输入（例如限流该等、昵称重复该换）。
            // 服务端 message 不直接用（可能是内部英文串），统一走本地文案表。
            setLastError({ kind: 'operation', message: publicError(ack.code), code: ack.code });
          }
        }
        return;
      }
      if (!owner.roomFromBroadcast) owner.room = ack.room;
      const active: OnlineSession = { roomCode: ack.room.roomCode, playerId: ack.playerId, token: ack.token };
      // 持久化活跃会话仅用于断线自动恢复，属尽力而为：保存失败不阻断已成功的建房/进房，
      // 也不应误报成"请求超时"。
      commitOnlineSession(storage, active);
      activeSession = active;
      hasActiveSession = true;
      localPlayerId.value = ack.playerId;
      applyRoom(owner.room ?? ack.room);
      let snapshotCompatible = true;
      if (owner.transitions.length > 0) {
        for (const transition of owner.transitions) {
          const renderable = resolveSnapshot(transition.snapshot);
          if (renderable === null) {
            snapshotCompatible = false;
            break;
          }
          const currentPresenter = ensurePresenter(renderable);
          currentPresenter.receiveEvents(transition.events);
          void currentPresenter.receiveSnapshot(renderable).catch(() => undefined);
          refreshTakeoverStatus(renderable);
        }
      } else if (owner.snapshot !== null) {
        snapshotCompatible = applySnapshot(owner.snapshot);
      } else if ('snapshot' in ack && ack.snapshot !== undefined) {
        // A mid-game spectator joins straight into the live board: the ack carries the same
        // public snapshot a resume would, so applying it here mirrors the resume path.
        snapshotCompatible = applySnapshot(ack.snapshot);
      }
      stagedEntry = null;
      entryFailure.value = null;
      connectionStatus.value = 'connected';
      if (snapshotCompatible) {
        clearLastError();
        refreshTakeoverStatus();
      }
    } finally {
      if (entryAttempt === owner) entryAttempt = null;
    }
  };
  const create = async (nickname: string, mapId: string, botDifficulty: BotDifficulty = 'normal'): Promise<void> => submit({
    operation: 'create',
    nickname,
    requestId: requestId(crypto),
    mapId,
    botDifficulty,
  });
  const join = async (roomCode: string, nickname: string, role: RoomRole = 'player'): Promise<void> => submit({
    operation: 'join',
    roomCode,
    nickname,
    role,
    requestId: requestId(crypto),
  });
  const abortEntry = (): boolean => {
    if (entryAttempt !== null) {
      fail('OPERATION_IN_PROGRESS');
      return false;
    }
    // Storage-first: only drop in-memory staging once the pending record is gone, so a
    // rejected removal keeps the entry retryable and consistent with a page refresh.
    if (!clearPendingRoomRequest(storage)) {
      fail('STORAGE_UNAVAILABLE');
      return false;
    }
    stagedEntry = null;
    entryFailure.value = null;
    clearLastError();
    return true;
  };
  const discardStoredSession = (): boolean => {
    if (!clearStoredOnlineSession(storage)) {
      fail('STORAGE_UNAVAILABLE');
      return false;
    }
    activeSession = null;
    hasActiveSession = false;
    localPlayerId.value = null;
    clearLastError();
    return true;
  };
  const retryPending = async (): Promise<void> => {
    const pending = readPendingRoomRequest(storage);
    if (!pending) return;
    await submit(pending);
  };
  const retryResume = async (): Promise<void> => {
    resumeDeferred = false;
    // A live socket resumes straight away; a dead one must first re-open the transport, so the
    // subsequent `connect` drives exactly one resume. Guard against a double open while connecting.
    if (socket.connected) {
      await resumeStoredSession();
      return;
    }
    if (disposed || reconnectPending) return;
    reconnectPending = true;
    connectionStatus.value = 'reconnecting';
    clearLastError((current) => current.kind === 'blocking' && (current.code === 'CONNECT_ERROR' || current.code === 'DISCONNECTED'));
    socket.connect();
  };
  const deferResume = (): void => {
    resumeDeferred = true;
    resumeGeneration += 1;
    cancelResume();
    if (!disposed && socket.connected) {
      clearLastError((current) => current.kind === 'blocking' && (current.code === 'CONNECT_ERROR' || current.code === 'DISCONNECTED'));
      connectionStatus.value = 'connected';
    }
  };
  // Spectators are read-only members: every mutating command is refused locally before any
  // emit (the server re-checks the role, but a doomed command should never leave the client).
  // `leave` is deliberately NOT guarded — leaving the spectator seat is always allowed.
  const guardSpectatorCommand = (command: LobbyCommand): boolean => {
    if (!isSpectator.value) return false;
    fail('NOT_HOST', command);
    return true;
  };
  // A single reactive lock across every host lobby mutation: while one command awaits its
  // server acknowledgement, the rest are rejected safely (no duplicate emit, no local mutation).
  // The recovery gate wins over this lock — an un-recovered session lets emitAck reject each
  // command independently (SESSION_NOT_RECOVERED / DISCONNECTED) rather than a stale in-progress.
  const runLobbyCommand = async (command: LobbyCommand, run: () => Promise<Ack<Record<string, never>>>): Promise<void> => {
    if (!canIssueActiveCommands()) {
      await run();
      return;
    }
    if (pendingCommand.value !== null) {
      fail('OPERATION_IN_PROGRESS', pendingCommand.value);
      return;
    }
    pendingCommand.value = command;
    try {
      await run();
    } finally {
      if (!disposed) pendingCommand.value = null;
    }
  };
  const start = async (): Promise<void> => {
    if (guardSpectatorCommand('start')) return;
    await runLobbyCommand('start', () => emitAck<Record<string, never>>('start', 'room:start'));
  };
  const addBot = async (): Promise<void> => {
    if (guardSpectatorCommand('addBot')) return;
    await runLobbyCommand('addBot', () => emitAck<Record<string, never>>('addBot', 'room:add_bot'));
  };
  const removeBot = async (playerId: string): Promise<void> => {
    if (guardSpectatorCommand('removeBot')) return;
    await runLobbyCommand('removeBot', () => emitAck<Record<string, never>>('removeBot', 'room:remove_bot', { playerId }));
  };
  const renameBot = async (playerId: string, nickname: string): Promise<void> => {
    if (guardSpectatorCommand('renameBot')) return;
    await runLobbyCommand('renameBot', () => emitAck<Record<string, never>>('renameBot', 'room:rename_bot', { playerId, nickname }));
  };
  /**
   * 房主调整房间设置（#4 / #6）。走 `runLobbyCommand` 复用「同一时刻只允许一条大厅变更」
   * 的互斥锁与待确认态；结果既用 ack 立即收敛、也接受随后的 `room:settings` 广播覆盖。
   */
  const updateRoomSettings = async (patch: RoomSettingsPatch): Promise<void> => {
    if (guardSpectatorCommand('updateSettings')) return;
    await runLobbyCommand('updateSettings', async () => {
      const response = await emitAck<RoomSettings>('updateSettings', 'room:update_settings', patch);
      if (!response.ok) return response;
      roomSettings.value = {
        botDifficulty: response.botDifficulty,
        ruleConfig: response.ruleConfig ?? null,
      };
      return { ok: true };
    });
  };
  const kickPlayer = async (playerId: string): Promise<void> => {
    if (guardSpectatorCommand('kick')) return;
    await runLobbyCommand('kick', () => emitAck<Record<string, never>>('kick', 'room:kick_player', { playerId }));
  };
  const sendChat = (text: string): void => {
    if (disposed || !socket.connected || !hasActiveSession) return;
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > CHAT_TEXT_MAX_LENGTH) return;
    socket.emit('room:chat_message', { text: trimmed });
  };
  const sendIntent = async (intent: Intent): Promise<void> => {
    if (isSpectator.value) return;
    // 投降不受“是否轮到该玩家 / 是否处于接管态”限制：任何在局真人都能随时认输退出房间。
    if (intent.type !== 'surrender' && !canControlActiveActor.value) {
      if (room.value?.takeoverPlayerId === localPlayerId.value) refreshTakeoverStatus();
      return;
    }
    await emitAck<Record<string, never>>('intent', 'game:intent', { intent });
  };
  const skipOfflineTurn = async (): Promise<void> => {
    if (isSpectator.value) return;
    if (!canSkipOfflineTurn.value) {
      const debtorId = state.value?.debt?.debtorId;
      const debtor = room.value?.players.find((player) => player.id === debtorId);
      if (debtor !== undefined && !debtor.online) {
        setLastError({
          kind: 'derived',
          message: `需要 ${debtor.nickname} 回来处理债务`,
          derivedSource: 'offline-debt',
          debtorId: debtor.id,
        });
      }
      return;
    }
    await emitAck<Record<string, never>>('skip', 'room:skip_offline_turn');
  };
  const leave = async (): Promise<void> => runLobbyCommand('leave', async () => {
    const ack = await emitAck<Record<string, never>>('leave', 'room:leave');
    if (ack.ok && !disposed) resetSession();
    return ack;
  });
  // A local give-up for an unreachable game: no server round-trip. Storage-first — the stored
  // active session and pending request must leave storage before any in-memory teardown, so a
  // rejected removal keeps the room/state/local record intact, reports a safe error, and stays
  // retryable. Distinct from leave(), which notifies the room over a live socket. Returns whether
  // the abandon committed.
  const abandon = (): boolean => {
    if (!clearStoredOnlineSession(storage)) {
      fail('STORAGE_UNAVAILABLE');
      return false;
    }
    resetSession();
    return true;
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    generation += 1;
    entryAttempt = null;
    stagedEntry = null;
    pendingTransitionRevisions.length = 0;
    timedOutMarkers.clear();
    cashNotices.value = [];
    clearTransientFeedback();
    presenter?.dispose();
    for (const stop of stopPresenterSync) stop();
    stopPresenterSync = [];
    for (const waiter of preconnectWaiters) {
      globalThis.clearTimeout(waiter.timer);
      waiter.resolve();
    }
    preconnectWaiters.clear();
    for (const attempt of inFlight.values()) {
      if (attempt.settled) continue;
      attempt.settled = true;
      globalThis.clearTimeout(attempt.timer);
      attempt.resolve({ ok: false, code: 'DISCONNECTED', message: '' });
    }
    inFlight.clear();
    socket.off('room:state', onRoomState);
    socket.off('player:connection', onConnection);
    socket.off('room:closed', onClosed);
    socket.off('game:events', onEvents);
    socket.off('game:snapshot', onSnapshot);
    socket.off('room:chat_broadcast', onChat);
    socket.off('room:chat_history', onChatHistory);
    socket.off('room:settings', onRoomSettings);
    socket.off('connect', onConnect);
    socket.off('disconnect', onDisconnect);
    socket.off('connect_error', onConnectError);
    socket.disconnect();
  };

  return {
    mode: 'online', state, room, localPlayerId, connectionStatus, displayPositions, dice, activeCard, eventMessage,
    isAnimating, isBotThinking, lastError, compatibilityError, cashNotices, displayCash, transientNotice, entryFailure, availableActions: computed<ClientAction[]>(() => (
      canControlActiveActor.value && state.value !== null ? getAvailableActions(state.value) : []
    )),
    chatLog, sendChat, create, retryPending, retryResume, deferResume, join, start, addBot, removeBot, renameBot, roomSettings, updateRoomSettings, kickPlayer, sendIntent, skipOfflineTurn, leave, dispose,
    abortEntry, discardStoredSession, abandon, isHost, isSpectator, isLobbyCommandReady, pendingCommand, startBlockedReason,
  };
}
