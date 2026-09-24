import { computed, ref, shallowRef } from 'vue';
import type { ComputedRef, Ref, ShallowRef } from 'vue';
import { applyIntent, chooseBotIntent, createGame } from '@richman/engine';
import type { BotDifficulty, GameEvent, GameState, Intent, PlayerState } from '@richman/engine';
import { getActiveMapPack, listActiveMaps, type GameConfig, type MapPack, type MapRef } from '@richman/board-data';
import type { ChatMessage, PublicRoomState } from '@richman/protocol';
import { resolveLocalGameState } from '../game/mapResolver';
import { getPendingCardChoice, type ClientAction, type DisplayCard } from '../game/clientGame';
import type { ConnectionStatus, GameSession, RenderableGameState, ReplayExportOutcome, TransientNotice } from './gameSession';
import { createGamePresenter } from './gamePresenter';
import { paceMultiplier } from './playbackPace';
import { describeReplayExport, exportReplay } from './replayCode';
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
  /**
   * 复盘回看（#115）：把一份已校验的复盘条目预填进 actionLog，于是「回放」按钮能整局重演。
   * 一旦传入，这个会话就进入**回看模式**（`isPlayback`）：不自动走电脑、不接受任何操作 ——
   * 回看会话里的「对局」是死的，只是给 `replay()` 提供素材。
   */
  replayLog?: readonly LocalActionLogEntry[];
}

/** 一条已执行的动作记录：意图 + 它产生的事件 + 结果态。悔棋/回放/复盘回看共用这一个形状。 */
export interface LocalActionLogEntry {
  readonly intent: Intent;
  readonly events: GameEvent[];
  readonly resultingState: GameState;
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
  // 复盘导出（#115）：起始态 + 有序意图 + 地图包 + 开局配方。联机以服务端为权威态、
  // 没有逐房意图日志，因此这些只在本地会话提供（不做成可选，避免调用方到处写 `?.`）。
  readonly initialState: GameState;
  readonly intents: ComputedRef<readonly Intent[]>;
  readonly mapPack: MapPack;
  /** 开局配方；从存档恢复的对局拿不到（存档只存局面），此时为 null → 无法导出复盘。 */
  readonly createRecipe: LocalGameRecipe | null;
  /** 回看会话（#115）：整局只用于重演，不接受操作、不自动走电脑。 */
  readonly isPlayback: boolean;
  /** 回看会话总步数（横幅文案用）。 */
  readonly replaySteps: ComputedRef<number>;
  /** 导出本局复盘码（#115）；导不出来时 `reason` 说明原因。 */
  buildReplayExport(): ReplayExportOutcome;
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

/**
 * 开局配方（#115 复盘导出）：`createGame` 的「随机性入参」——种子与**原始输入顺序**的玩家表。
 *
 * 为什么不能只存 `initialState.seed`（踩过的坑，务必记住）：
 *   `GameState.seed` 是**创建之后**的 RNG 状态 —— `createGame` 会先 `hashSeed(seed)`，
 *   再用它消耗掉「定序掷骰」与「两副牌洗乱」，最后把剩余状态写进 `state.seed`。
 *   把 `state.seed` 当输入种子回喂，会先被再哈希一次，得到的完全是另一局
 *   （实测：重建后 currentPlayerId 从 p3 变成 p2、RNG 状态也不同）。
 *
 * 为什么玩家表要存**输入顺序**而不是 `initialState.players`（落座后的顺序）：
 *   定序掷骰是按输入下标发点数的，喂进落座后的顺序会让同一串点数落到不同玩家头上，
 *   座次被重新排列。两者都必须是「创建时的原样」才谈得上复现。
 *
 * `restoreState` 恢复的对局拿不到配方（存档里只有局面，没有开局入参），因此 recipe 为 null。
 */
export interface LocalGameRecipe {
  readonly seed: string;
  readonly players: readonly { id: string; nickname: string; isBot?: boolean }[];
}

/** 本地热座默认阵容（`players` 未传时）；提出来是为了让 recipe 能如实记录「当时到底用了谁」。 */
function resolveInputPlayers(options: CreateLocalSessionOptions): { id: string; nickname: string; isBot?: boolean }[] {
  return options.players ?? [
    { id: 'p1', nickname: '玩家一' },
    { id: 'p2', nickname: '电脑A', isBot: true },
    { id: 'p3', nickname: '电脑B', isBot: true },
  ];
}

/**
 * 算出一局的「开局配方」。种子与玩家表必须**一次算好再复用**：
 * 默认种子带 `Date.now()` + 随机后缀，算两次就是两局不同的牌。
 */
export function resolveLocalGameRecipe(options: CreateLocalSessionOptions): LocalGameRecipe {
  const isDefaultDemo = options.players === undefined;
  return {
    seed: options.seed ?? (isDefaultDemo ? 'm3-static-board-demo' : createLocalSessionSeed()),
    players: resolveInputPlayers(options).map((player) => ({ ...player })),
  };
}

function createInitialGameState(
  options: CreateLocalSessionOptions,
  mapPack: MapPack,
  recipe: LocalGameRecipe = resolveLocalGameRecipe(options),
): GameState {
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
    players: recipe.players,
    seed: recipe.seed,
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
  // 开局配方先算好再传给 createInitialGameState：默认种子带时间戳与随机后缀，
  // 各算一次就会得到两个不同的种子 —— 那正是「导出的复盘复现不出来」的经典成因。
  const createRecipe = options.restoreState === undefined ? resolveLocalGameRecipe(options) : null;
  let engineState = options.restoreState ?? createInitialGameState(options, mapPack, createRecipe ?? undefined);
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
  const actionLog = shallowRef<LocalActionLogEntry[]>([]);
  const replaying = ref(false);
  // 回看模式（#115）：由 replayLog 预填动作日志，整局只用于重演。
  const isPlayback = options.replayLog !== undefined;
  if (options.replayLog !== undefined) actionLog.value = [...options.replayLog];
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
    if (isPlayback) {
      // 回看会话不是活的：允许落子会让棋盘与刚刚重演的历史脱节。
      lastError.value = '这是复盘回看，不能操作';
      return;
    }
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
    if (isPlayback) return; // 回看模式：电脑不自动行动，整局由「回放」驱动。
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

  // 复盘导出（#115）：只暴露「够重建整局」的三样东西 —— 起始态、有序意图、地图包。
  // 刻意不暴露 actionLog 本身：events / resultingState 体积大且对复盘无用（引擎是确定性的，
  // 重放意图即可复现），导出路径拿不到它们就不会误存。
  const intents = computed<readonly Intent[]>(() => actionLog.value.map((entry) => entry.intent));
  const replaySteps = computed(() => actionLog.value.length);

  /**
   * 导出本局复盘码（#115）。
   *
   * 导出前**先本地整局重放一遍做自校验**（`exportReplay` 内部完成）：宁可当场告诉玩家「导不出来」，
   * 也不能给出一份到了别人机器上才发现跑不通的码 —— 那会变成最难排查的一类反馈。
   *
   * 因此这个函数是 O(步数) 的，**只能按需调用**（打开弹窗时一次），绝不能挂进 computed：
   * 那样每走一步都会整局重算，几百步的对局直接把主线程算死。
   */
  function buildReplayExport(): ReplayExportOutcome {
    if (isPlayback) {
      return { code: null, steps: 0, reason: '这是正在回看的复盘，本身不再导出；要看原局请让对方再发一次码。' };
    }
    if (createRecipe === null) {
      return { code: null, steps: 0, reason: '这一局来自存档恢复，缺了开局的种子与座次，无法导出复盘。' };
    }
    const result = exportReplay({
      initialState,
      createRecipe,
      intents: intents.value,
      mapPack,
    }, Date.now());
    if (!result.ok) return { code: null, steps: 0, reason: describeReplayExport(result) };
    return { code: result.code, steps: result.steps, reason: '' };
  }

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
    initialState,
    intents,
    mapPack,
    createRecipe,
    isPlayback,
    replaySteps,
    buildReplayExport,
  };
}
