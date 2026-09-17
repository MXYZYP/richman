import { computed, ref, shallowRef } from 'vue';
import type { ComputedRef, Ref, ShallowRef } from 'vue';
import { applyIntent, chooseBotIntent, createGame } from '@richman/engine';
import type { GameState, Intent, PlayerState } from '@richman/engine';
import { getActiveMapPack, listActiveMaps, type MapPack, type MapRef } from '@richman/board-data';
import type { PublicRoomState } from '@richman/protocol';
import { resolveLocalGameState } from '../game/mapResolver';
import { getPendingCardChoice, type ClientAction, type DisplayCard } from '../game/clientGame';
import type { ConnectionStatus, GameSession, RenderableGameState, TransientNotice } from './gameSession';
import { createGamePresenter } from './gamePresenter';
import { paceMultiplier } from './playbackPace';
import type { LocalGamePersistence, LocalSaveIdentity } from './localGameSave';

export type { LocalGamePersistence } from './localGameSave';

export interface CreateLocalSessionOptions {
  mapPack?: MapPack;
  wait?: (ms: number) => Promise<void>;
  players?: { id: string; nickname: string; isBot?: boolean }[];
  seed?: string;
  cashGoal?: number | null;
  autoPlayBots?: boolean;
  botDelay?: () => number;
  restoreState?: GameState;
  persistence?: LocalGamePersistence;
}

export interface LocalSession extends GameSession {
  readonly mode: 'local';
  readonly state: ShallowRef<RenderableGameState>;
  readonly room: ShallowRef<PublicRoomState | null>;
  readonly localPlayerId: Ref<string | null>;
  readonly connectionStatus: Ref<ConnectionStatus>;
  readonly displayPositions: Ref<Record<string, number>>;
  readonly dice: Ref<number[] | null>;
  readonly activeCard: Ref<DisplayCard | null>;
  readonly eventMessage: Ref<string>;
  readonly isAnimating: Ref<boolean>;
  readonly isBotThinking: Ref<boolean>;
  readonly lastError: Ref<string | null>;
  readonly staleSession: Ref<boolean>;
  readonly saveIdentity: LocalSaveIdentity | null;
  readonly availableActions: ComputedRef<ClientAction[]>;
  runBotTurnIfNeeded(): Promise<void>;
  markStale(): void;
}

const ERROR_MESSAGES: Record<string, string> = {
  NOT_YOUR_TURN: '还没轮到这位玩家',
  WRONG_PHASE: '当前阶段不能执行这个操作',
  INSUFFICIENT_FUNDS: '现金不足',
  ILLEGAL_INTENT: '这个操作现在不可用',
};

function canSendDuringDebt(intent: Intent): boolean {
  return intent.type === 'sell_house' || intent.type === 'sell_property' || intent.type === 'mortgage_property' || intent.type === 'declare_bankrupt';
}

function createInitialGameState(options: CreateLocalSessionOptions, mapPack: MapPack): GameState {
  const isDefaultDemo = options.players === undefined;
  return createGame({
    mapRef: mapPack.ref,
    ruleModules: mapPack.game.requiredRuleModules,
    board: mapPack.game.board,
    cards: mapPack.game.cards,
    config: mapPack.game.config,
    players: options.players ?? [
      { id: 'p1', nickname: '玩家一' },
      { id: 'p2', nickname: '电脑A', isBot: true },
      { id: 'p3', nickname: '电脑B', isBot: true },
    ],
    seed: options.seed ?? (isDefaultDemo ? 'm3-static-board-demo' : createLocalSessionSeed()),
    cashGoal: isDefaultDemo ? 30000 : options.cashGoal ?? null,
    // 单机真人作弊：本地对局的非电脑玩家抽卡前暂停，等待接受/重抽。联机与电脑玩家不经过这里。
    cardChoiceMode: 'local-human',
  });
}

export function createInitialLocalGameState(options: CreateLocalSessionOptions = {}): GameState {
  const mapPack = options.mapPack ?? defaultMapPack();
  return createInitialGameState(options, mapPack);
}

function createLocalSessionSeed(): string {
  return `local-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createBotActionDelay(): number {
  return 800 + Math.floor(Math.random() * 801);
}

function getActorId(state: GameState): string {
  return state.debt?.debtorId ?? state.currentPlayerId;
}

function getActor(state: GameState): PlayerState | undefined {
  return state.players.find((player) => player.id === getActorId(state));
}

function sameMapRef(left: MapRef, right: MapRef): boolean {
  return left.id === right.id && left.version === right.version && left.contentHash === right.contentHash;
}

function defaultMapPack(): MapPack {
  const mapId = listActiveMaps()[0]?.ref.id;
  if (mapId === undefined) throw new Error('没有可用地图');
  return getActiveMapPack(mapId);
}

export function toRenderableGameState(state: GameState, mapPack?: MapPack): RenderableGameState {
  if (mapPack === undefined) return resolveLocalGameState(state);
  return resolveLocalGameState(state, (mapRef) => {
    if (!sameMapRef(mapRef, mapPack.ref)) throw new Error('Exact map pack is unavailable.');
    return mapPack;
  });
}

export function createLocalSession(options: CreateLocalSessionOptions = {}): LocalSession {
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms)));
  const autoPlayBots = options.autoPlayBots ?? false;
  const botDelay = options.botDelay ?? createBotActionDelay;
  const mapPack = options.mapPack ?? defaultMapPack();
  const persistence = options.persistence;
  let engineState = options.restoreState ?? createInitialGameState(options, mapPack);
  if (options.restoreState !== undefined && options.restoreState.cardChoice === undefined) {
    // 旧存档（本功能之前创建）没有 cardChoice 字段：本地会话统一升级为单机真人确认模式。
    engineState = { ...engineState, cardChoice: { mode: 'local-human', pending: null } };
  }
  const presenter = createGamePresenter(toRenderableGameState(engineState, mapPack), wait, paceMultiplier);
  const restoredPendingCard = getPendingCardChoice(presenter.state.value);
  if (restoredPendingCard !== null) {
    // 刷新/恢复存档时无需等动画重放：卡面立即出现在操作面板。
    presenter.activeCard.value = restoredPendingCard;
  }
  const room = shallowRef<PublicRoomState | null>(null);
  const localPlayerId = ref<string | null>(null);
  const connectionStatus = ref<ConnectionStatus>('local');
  const isBotThinking = ref(false);
  const isPersisting = ref(false);
  const lastError = ref<string | null>(null);
  const staleSession = ref(false);
  const compatibilityError = ref<string | null>(null);
  const transientNotice = ref<TransientNotice | null>(null);
  let disposed = false;
  let botGeneration = 0;

  const saveIdentity = persistence === undefined
    ? null
    : {
        slot: persistence.slot,
        gameId: persistence.gameId,
        get revision() { return persistence.revision; },
        get recordToken() { return persistence.recordToken; },
      };

  function recordError(error: unknown): void {
    lastError.value = error instanceof Error ? error.message : '动画播放失败，请重试';
  }

  function scheduleBotTurnIfNeeded(): void {
    void runBotTurnIfNeeded();
  }

  async function applyLocalIntent(intent: Intent, automated: boolean): Promise<boolean> {
    if (disposed) return false;
    if (staleSession.value) {
      lastError.value = '这局已在另一个页面更新，请返回首页重新载入';
      return false;
    }
    if (isPersisting.value) {
      lastError.value = '正在保存进度，请稍候';
      return false;
    }
    if (presenter.isAnimating.value || (isBotThinking.value && !automated)) {
      lastError.value = isBotThinking.value ? '电脑玩家正在自动行动' : '动画播放中，请稍候';
      return false;
    }
    const actor = getActor(engineState);
    if (autoPlayBots && actor?.isBot && !automated) {
      lastError.value = '电脑玩家正在自动行动';
      return false;
    }
    if (engineState.debt && !canSendDuringDebt(intent)) {
      lastError.value = intent.type === 'redeem_property' ? '债务中不可赎回' : '债务中只能卖房或抵押筹款';
      return false;
    }

    const result = applyIntent(engineState, getActorId(engineState), intent);
    if (!result.ok) {
      lastError.value = ERROR_MESSAGES[result.code] ?? '这个操作现在不可用';
      return false;
    }

    let completionError: string | null = null;
    if (persistence !== undefined) {
      isPersisting.value = true;
      try {
        const commitResult = await persistence.commit(result.state);
        if (disposed) return false;
        if (!commitResult.ok) {
          if (
            commitResult.reason === 'revision_mismatch'
            || commitResult.reason === 'game_id_mismatch'
            || commitResult.reason === 'not_found'
          ) {
            markStale();
          } else {
            lastError.value = '保存失败，本次操作未执行';
          }
          return false;
        }
        if (result.state.phase === 'game_over') {
          const completeResult = await persistence.complete(result.state);
          if (!completeResult.ok) {
            completionError = '本局已结束，但存档清理失败，请返回首页后重试删除';
          }
        }
      } finally {
        isPersisting.value = false;
      }
    }

    engineState = result.state;
    if (!automated) lastError.value = null;
    try {
      await presenter.playEvents(result.events, toRenderableGameState(result.state, mapPack));
      if (!disposed) lastError.value = completionError;
    } catch (error) {
      if (!disposed) recordError(error);
    } finally {
      if (!disposed) scheduleBotTurnIfNeeded();
    }
    return true;
  }

  async function sendIntent(intent: Intent): Promise<void> {
    await applyLocalIntent(intent, false);
  }

  async function runBotTurnIfNeeded(): Promise<void> {
    if (disposed || staleSession.value || isPersisting.value || !autoPlayBots || presenter.isAnimating.value || isBotThinking.value || engineState.phase === 'game_over') return;
    const actor = getActor(engineState);
    if (!actor?.isBot) return;

    const generation = ++botGeneration;
    isBotThinking.value = true;
    presenter.eventMessage.value = `电脑思考中：${actor.nickname}`;
    let appliedBotIntent = false;
    try {
      await wait(botDelay());
      if (disposed || generation !== botGeneration) return;

      const latestActor = getActor(engineState);
      if (!latestActor?.isBot || presenter.isAnimating.value) return;
      appliedBotIntent = await applyLocalIntent(chooseBotIntent(engineState, latestActor.id), true);
    } catch (error) {
      if (!disposed && generation === botGeneration) recordError(error);
    } finally {
      if (disposed || generation !== botGeneration) return;
      isBotThinking.value = false;
      if (appliedBotIntent) scheduleBotTurnIfNeeded();
    }
  }

  async function skipOfflineTurn(): Promise<void> {
    if (!disposed) lastError.value = '本地游戏不能跳过回合';
  }

  async function leave(): Promise<void> {
    dispose();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    botGeneration++;
    isBotThinking.value = false;
    presenter.dispose();
  }

  function markStale(): void {
    if (disposed || staleSession.value) return;
    staleSession.value = true;
    botGeneration++;
    isBotThinking.value = false;
    lastError.value = '这局已在另一个页面更新，请返回首页重新载入';
  }

  const availableActions = computed(() => (
    presenter.isAnimating.value || isBotThinking.value || isPersisting.value || staleSession.value ? [] : presenter.availableActions.value
  ));

  return {
    mode: 'local',
    state: presenter.state,
    room,
    localPlayerId,
    connectionStatus,
    displayPositions: presenter.displayPositions,
    dice: presenter.dice,
    activeCard: presenter.activeCard,
    eventMessage: presenter.eventMessage,
    isAnimating: presenter.isAnimating,
    isBotThinking,
    lastError,
    staleSession,
    saveIdentity,
    compatibilityError,
    cashNotices: presenter.cashNotices,
    displayCash: presenter.displayCash,
    transientNotice,
    availableActions,
    sendIntent,
    skipOfflineTurn,
    leave,
    dispose,
    runBotTurnIfNeeded,
    markStale,
  };
}
