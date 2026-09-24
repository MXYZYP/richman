import type { ComputedRef, Ref, ShallowRef } from 'vue';
import type { GameState, Intent } from '@richman/engine';
import type { MapPresentation } from '@richman/board-data';
import type { ChatMessage, PublicRoomState } from '@richman/protocol';
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
}
