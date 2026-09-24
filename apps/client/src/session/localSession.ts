import { computed, ref, shallowRef } from 'vue';
import type { ComputedRef, Ref, ShallowRef } from 'vue';
import { applyIntent, chooseBotIntent, createGame } from '@richman/engine';
import type { BotDifficulty, GameEvent, GameState, Intent, PlayerState } from '@richman/engine';
import { getActiveMapPack, listActiveMaps, type GameConfig, type MapPack, type MapRef } from '@richman/board-data';
import type { ChatMessage, PublicRoomState } from '@richman/protocol';
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
  /** 电脑玩家难度（P1-6）；本地对局可选，不传按 normal。 */
  botDifficulty?: BotDifficulty;
  /** 规则自定义（P2-10）：覆盖地图默认的部分 GameConfig 字段（初始资金/最高房级/抵押利率等）。 */
  config?: Partial<GameConfig>;
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
  // 悔棋/回放（P1-5）：本地热座对局恒提供这四个成员（联机会话才需要可选，见 GameSession）。
  // 在这里重申为必需，是为了让调用方不必到处写 `?.`，也避免测试里出现「可能是 undefined」的类型噪音。
  readonly canUndo: Ref<boolean>;
  readonly canReplay: Ref<boolean>;
  undo(): Promise<void>;
  replay(): Promise<void>;
}

const ERROR_MESSAGES: Record<string, string> = {
  NOT_YOUR_TURN: '还没轮到这位玩家',
  WRONG_PHASE: '当前阶段不能执行这个操作',
  INSUFFICIENT_FUNDS: '现金不足',
  ILLEGAL_INTENT: '这个操作现在不可用',
};

function canSendDuringDebt(intent: Intent): boolean {
  return intent.type === 'sell_house' || intent.type === 'sell_property' || intent.type === 'mortgage_property' || intent.type === 'declare_bankrupt' || intent.type === 'surrender';
}

/** 悔棋历史上限：超出后丢弃最旧的一步。回放日志不设上限（整局回放需要全部动作）。 */
const HISTORY_LIMIT = 200;

function createInitialGameState(options: CreateLocalSessionOptions, mapPack: MapPack): GameState {
  const isDefaultDemo = options.players === undefined;
  // 规则自定义（P2-10）：以地图默认 config 为基，叠加玩家覆盖项；覆盖不改变地图 contentHash，
  // 因为本地建局直接把 config 传给 createGame，不经地图校验（与经典 cashGoal 逻辑一致）。
  const baseConfig = mapPack.game.config;
  // 不标注为可变 GameConfig：mapPack.game.config 本身是 DeepReadonly<GameConfig>，
  // 展开合并后仍为 readonly，恰好满足 createGame 的 config: DeepReadonly<GameConfig> 入参。
  const config = options.config === undefined
    ? baseConfig
    : { ...baseConfig, ...options.config };
  return createGame({
    mapRef: mapPack.ref,
    ruleModules: mapPack.game.requiredRuleModules,
    board: mapPack.game.board,
    cards: mapPack.game.cards,
    config,
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
  // 本地热座无聊天；保留空记录以满足 GameSession 契约。
  const chatLog = ref<ChatMessage[]>([]);
  let disposed = false;
  let botGeneration = 0;
  // 电脑玩家难度（P1-6）：本地对局从建房选项透传，不传按 normal；与引擎 chooseBotIntent 默认一致不回归。
  const botDifficulty: BotDifficulty = options.botDifficulty ?? 'normal';

  // ── 悔棋/回放（P1-5）：本地对局记录每一步前的快照与动作日志，支持撤回上一步、本局回放 ──
  // history 存「每一步执行前的 engineState」；actionLog 存「已成功执行的意图 + 事件 + 结果态」。
  // 二者同序增长，undo 各弹一个即回退一步；replay 用 initialState 从头动画推演 actionLog。
  // 用 shallowRef 避免 GameState 递归类型触发 vue-tsc 的深层展开上限；以不可变重赋值保持响应性。
  const history = shallowRef<GameState[]>([]);
  const actionLog = shallowRef<{ intent: Intent; events: GameEvent[]; resultingState: GameState }[]>([]);
  const replaying = ref(false);
  // 本局起始状态（会话创建时的 engineState 引用），不会被后续 reassin 影响；回放从此重新推演。
  const initialState = engineState;
  // 注意两个坑，踩过：
  // ① history / actionLog 必须**不可变重赋值**（下面对应的 `[...]` 写法）。它们是 shallowRef，
  //    原地 `push()` 只改数组内容不触发依赖，读到的会是永远的旧值。
  // ② 忙标志要**先算出来**再判断，别写成一长串 `&&`。短路会让 `history.value.length > 0` 为假时
  //    后面的 isAnimating / isBotThinking 等依赖完全不被 track —— 于是 computed 永久卡在 false，
  //    表现就是「撤回上一步」按钮在真实对局里永远不亮。
  const canUndo = computed(() => {
    const busy = isBotThinking.value || presenter.isAnimating.value || isPersisting.value
      || staleSession.value || replaying.value;
    return history.value.length > 0 && !busy;
  });
  const canReplay = computed(() => {
    const busy = isBotThinking.value || presenter.isAnimating.value || isPersisting.value
      || staleSession.value || replaying.value;
    return actionLog.value.length > 0 && !replaying.value && !busy;
  });

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

    const preState = engineState;
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
    // 不可变重赋值：见 canUndo 处的注释 ①，原地 push 不会触发 shallowRef 依赖。
    history.value = [...history.value, preState].slice(-HISTORY_LIMIT);
    actionLog.value = [...actionLog.value, { intent, events: result.events, resultingState: result.state }];
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

  // 悔棋（P1-5）：撤回上一步已执行的操作（含电脑玩家步骤）。恢复前一步快照并同步本地存档。
  //
  // 「先改内存再写存档」必须做成原子操作：如果存档提交失败却已经把内存在回退了，玩家会看到
  // 棋盘退回去、刷新页面那一步又回来了 —— 这种「撤回了个寂寞」比直接失败更难解释。
  // 所以非致命失败时把 history / actionLog / engineState / 展示态一起还原回撤前。
  async function undo(): Promise<void> {
    if (disposed || staleSession.value || isPersisting.value || isBotThinking.value || presenter.isAnimating.value || replaying.value) return;
    const preState = history.value[history.value.length - 1];
    if (preState === undefined) return;
    const previousHistory = history.value;
    const previousActionLog = actionLog.value;
    const previousEngineState = engineState;
    function publish(state: GameState): void {
      const renderable = toRenderableGameState(state, mapPack);
      presenter.reset(renderable);
      presenter.activeCard.value = getPendingCardChoice(renderable);
    }
    history.value = history.value.slice(0, -1);
    actionLog.value = actionLog.value.slice(0, -1);
    engineState = preState;
    publish(preState);
    if (persistence !== undefined) {
      isPersisting.value = true;
      try {
        const commitResult = await persistence.commit(preState);
        if (disposed) return;
        if (!commitResult.ok) {
          if (commitResult.reason === 'revision_mismatch' || commitResult.reason === 'game_id_mismatch' || commitResult.reason === 'not_found') {
            markStale();
            return;
          }
          history.value = previousHistory;
          actionLog.value = previousActionLog;
          engineState = previousEngineState;
          publish(previousEngineState);
          lastError.value = '撤回失败，进度未改变';
          return;
        }
      } catch (error) {
        // 存档层抛异常与「返回 ok:false」等价：同样回滚，不能留下内存/存档不一致。
        history.value = previousHistory;
        actionLog.value = previousActionLog;
        engineState = previousEngineState;
        publish(previousEngineState);
        if (!disposed) recordError(error);
        return;
      } finally {
        isPersisting.value = false;
      }
    }
    lastError.value = null;
    if (autoPlayBots) scheduleBotTurnIfNeeded();
  }

  // 回放（P1-5）：从本局起始态重新动画推演所有已记录的动作；结束后恢复真实对局，不改动引擎状态。
  async function replay(): Promise<void> {
    if (disposed || staleSession.value || isPersisting.value || isBotThinking.value || presenter.isAnimating.value || replaying.value) return;
    if (actionLog.value.length === 0) return;
    replaying.value = true;
    const live = engineState;
    try {
      let cursor = JSON.parse(JSON.stringify(initialState)) as GameState;
      engineState = cursor;
      presenter.reset(toRenderableGameState(cursor, mapPack));
      for (const entry of actionLog.value) {
        if (disposed || !replaying.value) break;
        cursor = entry.resultingState;
        engineState = cursor;
        await presenter.playEvents(entry.events, toRenderableGameState(cursor, mapPack));
      }
    } finally {
      engineState = live;
      if (!disposed) {
        const restored = toRenderableGameState(live, mapPack);
        presenter.reset(restored);
        // 回放期间 presenter 可能被动画推着走过卡牌格；结束后必须把「待确认卡牌」重新对齐到真实对局，
        // 否则面板会停在回放途中的卡面上。
        presenter.activeCard.value = getPendingCardChoice(restored);
      }
      replaying.value = false;
    }
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
      appliedBotIntent = await applyLocalIntent(chooseBotIntent(engineState, latestActor.id, undefined, botDifficulty), true);
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

  function sendChat(_text: string): void {
    // 本地热座无聊天通道。
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
    chatLog,
    sendChat,
    sendIntent,
    skipOfflineTurn,
    leave,
    dispose,
    runBotTurnIfNeeded,
    markStale,
    canUndo,
    canReplay,
    undo,
    replay,
  };
}
