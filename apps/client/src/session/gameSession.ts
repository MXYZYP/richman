import type { ComputedRef, Ref, ShallowRef } from 'vue';
import type { GameState, Intent } from '@richman/engine';
import type { MapPresentation } from '@richman/board-data';
import type { ChatMessage, PublicRoomState, RoomSettings, TurnDeadlineInfo, UndoRequestInfo } from '@richman/protocol';
import type { ClientAction, DisplayCard } from '../game/clientGame';

/** Display-safe game state: no engine seed or private deck queues. */
export type RenderableGameState = Omit<GameState, 'seed' | 'decks'> & {
  readonly presentation: MapPresentation;
  readonly deckCounts: {
    readonly chance: number;
    readonly destiny: number;
  };
};

export type ConnectionStatus = 'local' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface CashNotice {
  readonly generation: number;
  readonly transitionId: number;
  /** 同一 transition 内按事件递增，保证每个事件的现金提示可区分。 */
  readonly seq: number;
  readonly playerId: string;
  readonly delta: number;
}

export interface TransientNotice {
  readonly id: number;
  readonly message: string;
}

/**
 * 复盘导出结果（#115）。
 *
 * 刻意做成「码 + 原因」这种浅形状：视图只需要知道**能不能给码**、**给出来多长**、**不给是因为什么**。
 * 把 `ReplayExportResult` 整体搬到这里会把 replayCode 的实现细节（载荷结构、失败码联合）泄漏进
 * 两端共用的会话契约，也会让 `gameSession ↔ replayCode ↔ localSession` 绕成一圈类型依赖。
 */
export interface ReplayExportOutcome {
  /** 可分享的复盘码；`null` = 这一局导不出来，看 `reason`。 */
  readonly code: string | null;
  /** 已自校验的步数（`code` 非 null 时有效，否则为 0）。 */
  readonly steps: number;
  /** `code === null` 时的一句话原因。 */
  readonly reason: string;
}


/**
 * Display-safe session contract.
 * Exposes only what the UI layer needs — no engine mutation, no BOT, no network.
 */
export interface GameSession {
  readonly mode: 'local' | 'online';
  readonly state: ShallowRef<RenderableGameState | null>;
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
  readonly compatibilityError: Ref<string | null>;
  readonly cashNotices: Ref<CashNotice[]>;
  /** 随事件逐步跳动的展示现金（动画中途可读），过渡结束时与权威快照对齐。 */
  readonly displayCash: Ref<Record<string, number>>;
  readonly transientNotice: Ref<TransientNotice | null>;
  readonly availableActions: ComputedRef<ClientAction[]>;
  /** 房间聊天记录（联机有效，本地热座为空）。 */
  readonly chatLog: Ref<ChatMessage[]>;
  sendIntent(intent: Intent): Promise<void>;
  skipOfflineTurn(): Promise<void>;
  leave(): Promise<void>;
  /** 发送一条房间聊天消息（联机）。返回 void，发送结果不阻塞 UI。 */
  sendChat(text: string): void;
  dispose(): void;
  retryResume?(): Promise<void>;
  /** 本地玩家是否为房主（联机有效，本地热座恒为 false/不提供）。房主可在对局中踢人。 */
  readonly isHost?: Ref<boolean>;
  /** 房主将对局中指定玩家强制出局（联机有效；本地热座不提供）。 */
  kickPlayer?(playerId: string): Promise<void>;
  /** 是否可撤回上一步（仅本地热座对局提供）。 */
  readonly canUndo?: Ref<boolean>;
  /** 是否可回放本局（仅本地热座对局提供）。 */
  readonly canReplay?: Ref<boolean>;
  /** 撤回上一步操作（仅本地热座对局提供）。 */
  undo?(): Promise<void>;
  /** 重新动画播放本局（仅本地热座对局提供）。 */
  replay?(): Promise<void>;
  /**
   * 复盘回看会话（#115）：整局只用于重演，不接受操作、不自动走电脑。
   * `true` 时视图可以「进场即自动重演」，把导入的复盘直接演给人看。
   */
  readonly isPlayback?: boolean;
  /**
   * 复盘导出（#115）：把这一局编成一段可分享的复盘码。**仅本地热座对局提供**。
   *
   * 联机不给复盘不是省事：服务端没有逐房间的操作日志，客户端手里只有「事件流 + 自己发过的意图」，
   * 据此重演必然在中途跑偏 —— 那比没有复盘更糟。从存档恢复的对局也导不出来（存档只存局面，
   * 开局的种子与座次已丢失），此时返回 `code: null` 并在 `reason` 里说清楚。
   */
  buildReplayExport?(): ReplayExportOutcome;
  /** 复盘回看会话的总步数（仅 `isPlayback` 会话提供），供横幅显示「共 N 步」。 */
  readonly replaySteps?: ComputedRef<number>;
  /**
   * 房间设置（#4 / #6 / #101）：仅联机提供，由服务端 `room:settings` 广播驱动。
   * 本地热座没有房间概念，因此不提供这个字段。
   */
  readonly roomSettings?: Ref<RoomSettings | null>;
  /**
   * 联机最小悔棋（#101）——与上面的本地悔棋是**两套机制**，不要混：
   * 本地没有别人，回退就是本地回退；联机的回退要经在场对手逐一确认，由服务端裁决。
   */
  readonly undoRequest?: Ref<UndoRequestInfo | null>;
  /** 「此刻谁可以发起悔棋」的玩家 id（服务端算好广播的），`null` = 没人可悔。 */
  readonly undoAvailability?: Ref<string | null>;
  /** 本机玩家此刻能否发起联机悔棋。 */
  readonly canRequestUndo?: ComputedRef<boolean>;
  /** 本机玩家是否需要对当前这次联机悔棋表态。 */
  readonly canVoteUndo?: ComputedRef<boolean>;
  /** 当前联机悔棋请求是否由我发起。 */
  readonly isUndoRequester?: ComputedRef<boolean>;
  /** 发起联机悔棋（需房主开启；真正回退要全部对手同意）。 */
  requestUndo?(): Promise<void>;
  /** 对联机悔棋请求表决：同意 / 拒绝。 */
  voteUndo?(requestId: string, approve: boolean): Promise<void>;
  /** 撤回自己尚未有结果的联机悔棋请求。 */
  cancelUndo?(): Promise<void>;
  /**
   * 回合限时（#107）：服务端给出的「此刻谁的回合钟在走、走到几点」，仅联机提供。
   * `playerId === null` = 此刻没有倒计时（房间未开启 / 轮到电脑 / 行动者离线），UI 据此不画进度条。
   */
  readonly turnDeadline?: Ref<TurnDeadlineInfo | null>;
}
