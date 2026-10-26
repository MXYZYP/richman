import type { PublicRoomState } from '@richman/protocol';
import type { ConnectionStatus, RenderableGameState } from './gameSession';

/**
 * The dominant interaction state for the shared game view. One kind drives both the
 * status banner and every enable/disable decision, so the view never branches on
 * local-vs-online rules itself — all of that collapses into this pure selector.
 */
export type GameInteractionKind =
  | 'local'
  | 'your_turn'
  | 'other_turn'
  | 'bot_turn'
  | 'offline_turn'
  | 'debt'
  | 'takeover'
  | 'spectating'
  | 'reconnecting'
  | 'failed'
  | 'incompatible';

/** The unwrapped subset of a GameSession the interaction selector reads. */
export interface GameInteractionInput {
  mode: 'local' | 'online';
  state: RenderableGameState | null;
  room: PublicRoomState | null;
  localPlayerId: string | null;
  connectionStatus: ConnectionStatus;
  isAnimating: boolean;
  compatibilityError: string | null;
}

export interface GameInteractionState {
  kind: GameInteractionKind;
  /** The human status/banner line for this interaction, or null when there is nothing to say. */
  message: string | null;
  /** Whether the local player may push an intent (roll, buy, liquidate, end turn) right now. */
  canSendIntent: boolean;
  /** Whether the local player (host) may skip an offline player's stalled turn right now. */
  canSkipOfflineTurn: boolean;
  /**
   * Whether exiting this game must be confirmed first. Local hot-seat restarts never confirm
   * (there is no room to notify and nothing to lose); every online exit confirms regardless of
   * connection state, since the player is abandoning or leaving a live/finished shared room.
   */
  requiresLeaveConfirm: boolean;
}

/** The player whose decision the game is waiting on — the debtor while a debt is open. */
function activeActorId(state: RenderableGameState): string | null {
  return state.debt?.debtorId ?? state.currentPlayerId ?? null;
}

function actorName(input: GameInteractionInput, actorId: string | null): string {
  if (actorId === null) return '';
  const fromRoom = input.room?.players.find((player) => player.id === actorId);
  if (fromRoom !== undefined) return fromRoom.nickname;
  const fromState = input.state?.players.find((player) => player.id === actorId);
  return fromState?.nickname ?? actorId;
}

/**
 * Whether the local player controls the active actor — i.e. it is genuinely their move on a
 * live connection. Mirrors the online session's own command guard so the view and the session
 * agree, and stays true during the local player's own debt so they can liquidate.
 */
function controlsActor(input: GameInteractionInput): boolean {
  const { state, room, localPlayerId } = input;
  if (state === null) return false;
  const actorId = activeActorId(state);
  const actor = room?.players.find((player) => player.id === actorId);
  return actorId !== null
    && localPlayerId === actorId
    && actor !== undefined
    && actor.online
    && !actor.isBot
    && room?.takeoverPlayerId !== localPlayerId
    && input.connectionStatus === 'connected'
    && !input.isAnimating;
}

function computeSkipOfflineTurn(input: GameInteractionInput): boolean {
  const { state, room, localPlayerId } = input;
  if (state === null) return false;
  if (state.phase !== 'playing') return false;
  if (state.debt !== null) return false;
  if (room === null || room.takeoverPlayerId !== null) return false;
  if (room.hostId !== localPlayerId) return false;
  const actor = room.players.find((player) => player.id === activeActorId(state));
  return actor !== undefined && !actor.isBot && !actor.online;
}

/** Whether the authenticated member id belongs to the room's spectator roster. */
function isSpectatorMember(input: GameInteractionInput): boolean {
  const memberId = input.localPlayerId;
  return memberId !== null && (input.room?.spectators.some((member) => member.id === memberId) ?? false);
}
type InteractionCore = Omit<GameInteractionState, 'requiresLeaveConfirm'>;

function localState(input: GameInteractionInput): InteractionCore {
  const actorId = input.state === null ? null : activeActorId(input.state);
  return {
    kind: 'local',
    message: actorId === null ? null : `轮到 ${actorName(input, actorId)}`,
    canSendIntent: !input.isAnimating,
    canSkipOfflineTurn: false,
  };
}

function takeoverMessage(input: GameInteractionInput): string {
  // A takeover the local host is running speaks to them directly; everyone else gets the
  // neutral banner. A debtor-blocked takeover asks the offline debtor to come back.
  if (input.room?.takeoverPlayerId !== input.localPlayerId) return '房主正在托管本回合';
  const debtorId = input.state?.debt?.debtorId;
  const debtor = input.room?.players.find((player) => player.id === debtorId);
  return debtor === undefined ? '房主托管正在执行' : `需要 ${debtor.nickname} 回来处理债务`;
}

function onlineState(input: GameInteractionInput): InteractionCore {
  const canSendIntent = controlsActor(input);
  const canSkipOfflineTurn = computeSkipOfflineTurn(input);

  if (input.compatibilityError !== null) {
    return {
      kind: 'incompatible',
      message: input.compatibilityError,
      canSendIntent: false,
      canSkipOfflineTurn: false,
    };
  }

  // Connection recovery outranks every gameplay state: a stale board must not look actionable.
  if (input.connectionStatus === 'failed') {
    return { kind: 'failed', message: '连接已断开', canSendIntent: false, canSkipOfflineTurn: false };
  }
  if (input.connectionStatus !== 'connected') {
    return { kind: 'reconnecting', message: '正在重新连接…', canSendIntent: false, canSkipOfflineTurn: false };
  }

  // A spectator never owns a turn: every write path is closed and the status says so plainly
  // instead of 「轮到你」/「等待你」. Connection problems above still reach spectators.
  if (isSpectatorMember(input)) {
    return { kind: 'spectating', message: '观战中', canSendIntent: false, canSkipOfflineTurn: false };
  }

  const { state, room } = input;
  if (state === null) {
    return { kind: 'other_turn', message: '正在与房间同步…', canSendIntent, canSkipOfflineTurn };
  }

  // Message priority: takeover > debt > turn ownership.
  if (room !== null && room.takeoverPlayerId !== null) {
    return { kind: 'takeover', message: takeoverMessage(input), canSendIntent, canSkipOfflineTurn };
  }

  const actorId = activeActorId(state);
  const name = actorName(input, actorId);

  if (state.debt !== null) {
    const mine = state.debt.debtorId === input.localPlayerId;
    return {
      kind: 'debt',
      message: mine ? '请处理你的债务' : `等待 ${name} 处理债务`,
      canSendIntent,
      canSkipOfflineTurn,
    };
  }

  const actor = room?.players.find((player) => player.id === actorId);
  if (actorId !== null && actorId === input.localPlayerId && actor?.online && !actor.isBot) {
    return { kind: 'your_turn', message: '轮到你', canSendIntent, canSkipOfflineTurn };
  }
  if (actor?.isBot) {
    return { kind: 'bot_turn', message: `电脑 ${name} 行动中`, canSendIntent, canSkipOfflineTurn };
  }
  if (actor !== undefined && !actor.online) {
    return { kind: 'offline_turn', message: `${name} 已离线，等待重连`, canSendIntent, canSkipOfflineTurn };
  }
  return { kind: 'other_turn', message: `等待 ${name} 行动`, canSendIntent, canSkipOfflineTurn };
}

/**
 * Reduce a session's live refs to the single interaction state the shared view renders from.
 * Pure and total: given the same snapshot it always returns the same decision, and it reads
 * nothing but the fields above — no engine, no network, no side effects.
 */
export function getGameInteractionState(input: GameInteractionInput): GameInteractionState {
  const core = input.mode === 'local' ? localState(input) : onlineState(input);
  return { ...core, requiresLeaveConfirm: input.mode === 'online' };
}
