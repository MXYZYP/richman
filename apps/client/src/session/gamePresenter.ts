import { computed, ref, shallowRef } from 'vue';
import type { ComputedRef, Ref, ShallowRef } from 'vue';
import type { GameEvent } from '@richman/engine';
import type { CashNotice, RenderableGameState } from './gameSession';
import {
  formatRecentLogEvent,
  getAvailableActions,
  getTurnTitle,
  type ClientAction,
  type DisplayCard,
} from '../game/clientGame';

// ── Re-export display-only helpers ──
// Signatures now accept RenderableGameState directly via union type.

export { formatRecentLogEvent, getAvailableActions, getTurnTitle };

export interface GamePresenterResult {
  /** Display-safe game state ref. */
  state: ShallowRef<RenderableGameState>;
  /** Animated token positions per player. */
  displayPositions: Ref<Record<string, number>>;
  /** Cash displayed per player, ticking with each cash event during playback. */
  displayCash: Ref<Record<string, number>>;
  /** Last dice values shown during animation. */
  dice: Ref<number[] | null>;
  /** Currently displayed card (shown during card_drawn, cleared on turn_started). */
  activeCard: Ref<DisplayCard | null>;
  /** Text message describing the current event. */
  eventMessage: Ref<string>;
  /** Whether a playback sequence is in progress. */
  isAnimating: Ref<boolean>;
  /** Latest cash change notice keyed by player. */
  cashNotices: Ref<CashNotice[]>;
  /** Computed available actions from the current state. */
  availableActions: ComputedRef<ClientAction[]>;
  /**
   * Reset all display state from a new snapshot synchronously.
   * Increments the generation counter so any in-flight playback
   * cannot overwrite display state after the reset.
   */
  reset: (snapshot: RenderableGameState) => void;
  /**
   * Play a sequence of game events with animation steps.
   * Each await checks the generation counter; if reset/dispose
   * was called meanwhile, the sequence aborts without side effects.
   * `isAnimating` is true during playback and false after.
   */
  playEvents: (events: GameEvent[], snapshot: RenderableGameState) => Promise<void>;
  /** Queue one server transition until its immediately following snapshot arrives. */
  receiveEvents: (events: GameEvent[]) => void;
  /** Pair a snapshot with the oldest queued transition, or synchronously reset on a standalone snapshot. */
  receiveSnapshot: (snapshot: RenderableGameState) => Promise<void>;
  /**
   * Increment the generation counter to cancel any in-flight playback,
   * and synchronously set isAnimating to false.
   * Safe to call multiple times.
   */
  dispose: () => void;
}

const CARD_DWELL_MS = 3_000;
/** 现金提示的存活时长，与 .cash-pill 的 CSS 动画（cash-pill-float / cash-pill-fade）等长：动画结束即移除节点，残留节点不得再被重排重放。 */
const CASH_NOTICE_MS = 2_400;

/** 标准档（1x）每类事件的停留时长：支付/筹款给足阅读时间，回合之间留出“换气口”。 */
const STEP_DURATIONS_MS: Record<string, number> = {
  game_started: 800,
  turn_started: 600,
  dice_rolled: 600,
  token_moved: 150,
  salary_collected: 700,
  property_bought: 700,
  buy_declined: 400,
  house_built: 700,
  house_sold: 700,
  property_sold: 700,
  property_mortgaged: 700,
  property_redeemed: 700,
  rent_paid: 700,
  tax_paid: 700,
  bank_paid: 700,
  bank_received: 700,
  payment_made: 700,
  debt_entered: 900,
  debt_resolved: 700,
  player_bankrupt: 1_500,
  turn_ended: 300,
  game_over: 1_200,
};
const DEFAULT_EVENT_MS = 500;
const MIN_STEP_MS = 30;
/** 排队待播的 transition 达到这个数量时快进追赶，避免机器人连动时观众越落越远。 */
const CATCH_UP_PENDING = 2;
const CATCH_UP_FACTOR = 0.25;

function initialPositions(snapshot: RenderableGameState): Record<string, number> {
  return Object.fromEntries(snapshot.players.map((p) => [p.id, p.position]));
}

function initialCash(snapshot: RenderableGameState): Record<string, number> {
  return Object.fromEntries(snapshot.players.map((p) => [p.id, p.cash]));
}

/** 事件直接携带的现金变化；house_sold 等不带金额的事件由过渡末尾的对账补发提示。house_built 现自带 amount 但无 playerId，仍由对账补发。 */
function cashDeltasOf(event: GameEvent): Array<{ playerId: string; delta: number }> {
  switch (event.type) {
    case 'salary_collected':
    case 'bank_received':
      return [{ playerId: event.playerId, delta: event.amount }];
    case 'property_bought':
      return [{ playerId: event.playerId, delta: -event.price }];
    case 'property_sold':
    case 'property_mortgaged':
      return [{ playerId: event.playerId, delta: event.amount }];
    case 'property_redeemed':
      return [{ playerId: event.playerId, delta: -event.amount }];
    case 'tax_paid':
    case 'bank_paid':
      return [{ playerId: event.playerId, delta: -event.amount }];
    case 'rent_paid':
      return [
        { playerId: event.from, delta: -event.amount },
        { playerId: event.to, delta: event.amount },
      ];
    case 'payment_made':
      return event.to === null
        ? [{ playerId: event.from, delta: -event.amount }]
        : [
            { playerId: event.from, delta: -event.amount },
            { playerId: event.to, delta: event.amount },
          ];
    case 'player_bankrupt':
      return event.creditorId !== null && event.transferredCash > 0
        ? [
            { playerId: event.playerId, delta: -event.transferredCash },
            { playerId: event.creditorId, delta: event.transferredCash },
          ]
        : [];
    default:
      return [];
  }
}

/**
 * Create a pure game presenter with no engine mutation, BOT, or network dependencies.
 *
 * @param initialSnapshot - The initial display-safe snapshot.
 * @param wait - Optional async delay function (defaults to setTimeout).
 * @param pace - Optional live speed multiplier getter (defaults to standard 1x).
 */
export function createGamePresenter(
  initialSnapshot: RenderableGameState,
  wait?: (ms: number) => Promise<void>,
  pace: () => number = () => 1,
): GamePresenterResult {
  const _wait = wait ?? ((ms: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms)));

  const state = shallowRef(initialSnapshot);
  const displayPositions = ref<Record<string, number>>(initialPositions(initialSnapshot));
  const displayCash = ref<Record<string, number>>(initialCash(initialSnapshot));
  const dice = ref<number[] | null>(null);
  const activeCard = ref<DisplayCard | null>(null);
  const eventMessage = ref(getTurnTitle(initialSnapshot, initialSnapshot.currentPlayerId));
  const isAnimating = ref(false);
  const cashNotices = ref<CashNotice[]>([]);
  const availableActions = computed(() => getAvailableActions(state.value));

  /** Generation counter: every reset/dispose cancels stale or queued playback. */
  let generation = 0;
  let playbackTail: Promise<void> = Promise.resolve();
  let pendingEventBatches: GameEvent[][] = [];
  let transitionSequence = 0;
  let noticeSequence = 0;
  /** 每个玩家一条提示一个计时器：替换、重置、销毁都会清掉，旧计时器不可能误删新提示。 */
  const noticeTimers = new Map<string, ReturnType<typeof globalThis.setTimeout>>();
  /** 已调用 playEvents 但尚未播完的批次数量（含正在播放的）。 */
  let queuedBatches = 0;

  /** 普通事件停留时长 = 基础表 × 速度档 × 追赶系数，保底 MIN_STEP_MS。 */
  function stepMs(event: GameEvent, factor: number): number {
    const base = STEP_DURATIONS_MS[event.type] ?? DEFAULT_EVENT_MS;
    return Math.max(MIN_STEP_MS, Math.round(base * pace() * factor));
  }

  /** 卡牌是阅读时刻：速度档与追赶系数合并后仍保底 0.5x，避免积压时文字一闪而过。 */
  function cardDwellMs(factor: number): number {
    const clamped = Math.min(1.5, Math.max(0.5, pace() * factor));
    return Math.max(MIN_STEP_MS, Math.round(CARD_DWELL_MS * clamped));
  }

  function receiveEvents(events: GameEvent[]): void {
    pendingEventBatches.push(events);
  }

  function receiveSnapshot(snapshot: RenderableGameState): Promise<void> {
    const events = pendingEventBatches.shift();
    if (events === undefined) {
      reset(snapshot);
      return Promise.resolve();
    }
    return playEvents(events, snapshot);
  }


  function reset(snapshot: RenderableGameState): void {
    generation++;
    pendingEventBatches = [];
    playbackTail = Promise.resolve();
    transitionSequence = 0;
    queuedBatches = 0;
    state.value = snapshot;
    displayPositions.value = initialPositions(snapshot);
    displayCash.value = initialCash(snapshot);
    dice.value = null;
    activeCard.value = null;
    eventMessage.value = getTurnTitle(snapshot, snapshot.currentPlayerId);
    clearNoticeTimers();
    cashNotices.value = [];
    isAnimating.value = false;
  }

  function dispose(): void {
    generation++;
    pendingEventBatches = [];
    playbackTail = Promise.resolve();
    queuedBatches = 0;
    isAnimating.value = false;
    clearNoticeTimers();
    cashNotices.value = [];
  }

  function playEvents(events: GameEvent[], snapshot: RenderableGameState): Promise<void> {
    const myGeneration = generation;
    const transitionId = ++transitionSequence;
    isAnimating.value = true;
    queuedBatches++;

    const batch = playbackTail.then(async () => {
      try {
        if (generation !== myGeneration) return;
        // 除本批次外还有 CATCH_UP_PENDING 个批次排队时快进，追上服务器推送的机器人连动。
        const factor = queuedBatches - 1 >= CATCH_UP_PENDING ? CATCH_UP_FACTOR : 1;
        for (const event of events) {
          if (generation !== myGeneration) return;
          await playSingleEvent(event, snapshot, { myGeneration, transitionId, factor });
          if (generation !== myGeneration) return;
        }
      } finally {
        if (generation === myGeneration) {
          queuedBatches--;
          displayPositions.value = initialPositions(snapshot);
          // 对账：house_sold 等事件不带金额，逐事件跳动与最终快照的差额在这里补发提示并对齐。
          const nextCash = { ...displayCash.value };
          for (const player of snapshot.players) {
            const displayed = nextCash[player.id];
            if (displayed !== undefined && displayed !== player.cash) {
              publishCashNotice(player.id, player.cash - displayed, myGeneration, transitionId);
            }
            nextCash[player.id] = player.cash;
          }
          displayCash.value = nextCash;
          state.value = snapshot;
        }
      }
    });
    const continuation = batch.catch(() => undefined);
    playbackTail = continuation;

    return batch.finally(() => {
      if (generation === myGeneration && playbackTail === continuation) {
        isAnimating.value = false;
      }
    });
  }

  function clearNoticeTimers(): void {
    for (const timer of noticeTimers.values()) globalThis.clearTimeout(timer);
    noticeTimers.clear();
  }

  /** 到点即移除：CSS 动画已结束，残留节点一旦被重排会重放上一笔旧金额。 */
  function expireCashNotice(playerId: string, seq: number): void {
    const timer = noticeTimers.get(playerId);
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
      noticeTimers.delete(playerId);
    }
    cashNotices.value = cashNotices.value.filter(
      (notice) => notice.playerId !== playerId || notice.seq !== seq,
    );
  }

  /** 替换该玩家当前的现金提示（每个事件一条，互不叠加，观众看到的是“这一步发生了什么”）。 */
  function publishCashNotice(playerId: string, delta: number, noticeGeneration: number, transitionId: number): void {
    if (delta === 0) return;
    const notice: CashNotice = { generation: noticeGeneration, transitionId, seq: ++noticeSequence, playerId, delta };
    cashNotices.value = [...cashNotices.value.filter((existing) => existing.playerId !== playerId), notice];
    // 同玩家替换时重新计时：新提示拿满一整段动画时长，旧计时器绝不能提前收走它。
    const previous = noticeTimers.get(playerId);
    if (previous !== undefined) globalThis.clearTimeout(previous);
    noticeTimers.set(playerId, globalThis.setTimeout(() => expireCashNotice(playerId, notice.seq), CASH_NOTICE_MS));
  }

  interface PlaybackContext {
    readonly myGeneration: number;
    readonly transitionId: number;
    /** 积压追赶系数：排队批次多时缩短所有停留。 */
    readonly factor: number;
  }

  async function playSingleEvent(event: GameEvent, snapshot: RenderableGameState, context: PlaybackContext): Promise<void> {
    const { myGeneration, transitionId, factor } = context;
    // 现金先随事件跳动，再停留阅读：数字、药丸、文字同一时刻出现。
    const deltas = cashDeltasOf(event);
    if (deltas.length > 0) {
      const nextCash = { ...displayCash.value };
      for (const { playerId, delta } of deltas) {
        if (nextCash[playerId] === undefined) continue;
        nextCash[playerId] += delta;
        publishCashNotice(playerId, delta, myGeneration, transitionId);
      }
      displayCash.value = nextCash;
    }
    switch (event.type) {
      case 'dice_rolled': {
        dice.value = event.dice;
        eventMessage.value = formatRecentLogEvent(snapshot, event);
        await _wait(stepMs(event, factor));
        return;
      }
      case 'token_moved': {
        const stepDelay = stepMs(event, factor);
        for (const cellId of event.path) {
          if (generation !== myGeneration) return;
          displayPositions.value = { ...displayPositions.value, [event.playerId]: cellId };
          eventMessage.value = formatRecentLogEvent(snapshot, { ...event, path: [cellId] });
          await _wait(stepDelay);
        }
        return;
      }
      case 'card_drawn': {
        const card = snapshot.cards[event.deck].find((candidate) => candidate.id === event.cardId);
        const text = card?.text ?? event.cardId;
        activeCard.value = {
          deck: event.deck,
          cardId: event.cardId,
          ...(card?.title === undefined ? {} : { title: card.title }),
          text,
        };
        eventMessage.value = formatRecentLogEvent(snapshot, event);
        await _wait(cardDwellMs(factor));
        return;
      }
      case 'turn_started':
        activeCard.value = null;
        eventMessage.value = formatRecentLogEvent(snapshot, event);
        await _wait(stepMs(event, factor));
        return;
      case 'salary_collected':
      case 'property_bought':
      case 'buy_declined':
      case 'house_built':
      case 'house_sold':
      case 'property_sold':
      case 'property_mortgaged':
      case 'property_redeemed':
        eventMessage.value = formatRecentLogEvent(snapshot, event);
        await _wait(stepMs(event, factor));
        return;
      case 'rent_paid':
      case 'tax_paid':
      case 'bank_paid':
      case 'bank_received':
      case 'payment_made':
      case 'debt_entered':
      case 'debt_resolved':
        eventMessage.value = activeCard.value
          ? `${formatRecentLogEvent(snapshot, event)}｜卡牌：${activeCard.value.text}`
          : formatRecentLogEvent(snapshot, event);
        await _wait(stepMs(event, factor));
        return;
      case 'player_bankrupt':
      case 'turn_ended':
      case 'game_over':
      case 'game_started':
      default:
        eventMessage.value = formatRecentLogEvent(snapshot, event);
        await _wait(stepMs(event, factor));
        return;
    }
  }

  return {
    state,
    displayPositions,
    displayCash,
    dice,
    activeCard,
    eventMessage,
    isAnimating,
    cashNotices,
    availableActions,
    reset,
    playEvents,
    receiveEvents,
    receiveSnapshot,
    dispose,
  };
}
