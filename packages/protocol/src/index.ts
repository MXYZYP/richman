import type { BotDifficulty, GameEvent, GameState, Intent } from '@richman/engine';

export interface PublicGameSnapshot {
  mapRef: GameState['mapRef'];
  turn: GameState['turn'];
  phase: GameState['phase'];
  turnPhase: GameState['turnPhase'];
  currentPlayerId: GameState['currentPlayerId'];
  players: GameState['players'];
  properties: GameState['properties'];
  publicRuleState?: GameState['publicRuleState'];
  debt: GameState['debt'];
  lastDice: GameState['lastDice'];
  recentLog: GameState['recentLog'];
  winnerId: GameState['winnerId'];
  cashGoal: GameState['cashGoal'];
  deckCounts: {
    chance: number;
    destiny: number;
  };
}

export type RoomStatus = 'lobby' | 'playing' | 'ended';

export interface PublicRoomPlayer {
  id: string;
  nickname: string;
  isBot: boolean;
  online: boolean;
}

export type RoomRole = 'player' | 'spectator';

export interface PublicRoomSpectator {
  id: string;
  nickname: string;
  online: boolean;
}

export interface PublicRoomState {
  roomCode: string;
  status: RoomStatus;
  hostId: string;
  players: PublicRoomPlayer[];
  spectators: PublicRoomSpectator[];
  takeoverPlayerId: string | null;
  map: {
    ref: GameState['mapRef'];
    title: string;
  };
}

export interface ResumeAck {
  room: PublicRoomState;
  snapshot?: PublicGameSnapshot;
}

export type RoomClosedReason = 'empty_lobby' | 'lobby_idle_timeout';

export type ChatRole = 'player' | 'spectator';

export interface ChatMessage {
  playerId: string;
  nickname: string;
  text: string;
  ts: number;
  role: ChatRole;
}

export const CHAT_TEXT_MAX_LENGTH = 200;

/**
 * 服务端为每个房间保留的最近聊天条数（内存态，随房间存在）。
 * 新加入 / 掉线重连的成员会收到这段历史，避免"刷新一下聊天记录就空了"。
 */
export const CHAT_HISTORY_LIMIT = 50;

export type Ack<TSuccess extends object> =
  | (string extends keyof TSuccess ? { ok: true } : { ok: true } & TSuccess)
  | {
      ok: false;
      code: string;
      message: string;
    };

export interface CreateRoomPayload {
  nickname: string;
  requestId: string;
  mapId: string;
  /** 电脑玩家难度（P1-6）；不传时服务器按 normal 处理。 */
  botDifficulty?: BotDifficulty;
}

/**
 * 房主自定义的规则（#4）：与单机的「规则自定义」同名同义，覆盖地图 game-config 里的对应字段。
 * 只允许覆盖这三项 —— 其它字段（过路费表、渡口倍率、现金目标预设…）改动会破坏地图校验器的
 * 硬约束（如 rents.length === maxHouseLevel + 1），必须跟着地图包走。
 */
export interface RoomRuleConfig {
  initialCash: number;
  /** 必须 ≤ 该地图自己的 maxHouseLevel：过路费按 rents[level] 取档，超出即收 0 元。 */
  maxHouseLevel: number;
  mortgageInterestRate: number;
}

/** 房间级的可调设置（#4 / #6）：房主在大厅里设定，随房间存在，开局时生效。 */
export interface RoomSettings {
  botDifficulty: BotDifficulty;
  /** null = 用地图默认规则（房主没有自定义任何一项）。 */
  ruleConfig: RoomRuleConfig | null;
}

/** 增量更新房间设置；`ruleConfig: null` 明确表示「回到地图默认」。 */
export interface RoomSettingsPatch {
  botDifficulty?: BotDifficulty;
  ruleConfig?: RoomRuleConfig | null;
}

export interface JoinRoomPayload {
  roomCode: string;
  nickname: string;
  requestId: string;
  role: RoomRole;
}

export interface CreateRoomAck {
  roomCode: string;
  playerId: string;
  token: string;
  room: PublicRoomState;
}

export interface JoinRoomAck {
  playerId: string;
  token: string;
  room: PublicRoomState;
  snapshot?: PublicGameSnapshot;
}

export interface ClientToServerEvents {
  'session:resume': (
    payload: { roomCode: string; playerId: string; token: string },
    ack: (response: Ack<ResumeAck>) => void,
  ) => void;
  'room:create': (payload: CreateRoomPayload, ack: (response: Ack<CreateRoomAck>) => void) => void;
  'room:join': (payload: JoinRoomPayload, ack: (response: Ack<JoinRoomAck>) => void) => void;
  'room:add_bot': (ack: (response: Ack<Record<string, never>>) => void) => void;
  'room:remove_bot': (payload: { playerId: string }, ack: (response: Ack<Record<string, never>>) => void) => void;
  'room:rename_bot': (payload: { playerId: string; nickname: string }, ack: (response: Ack<Record<string, never>>) => void) => void;
  'room:start': (ack: (response: Ack<Record<string, never>>) => void) => void;
  'room:leave': (ack: (response: Ack<Record<string, never>>) => void) => void;
  'game:intent': (payload: { intent: Intent }, ack: (response: Ack<Record<string, never>>) => void) => void;
  'room:skip_offline_turn': (ack: (response: Ack<Record<string, never>>) => void) => void;
  'room:kick_player': (payload: { playerId: string }, ack: (response: Ack<Record<string, never>>) => void) => void;
  'room:chat_message': (payload: { text: string }, ack: (response: Ack<Record<string, never>>) => void) => void;
  /** 房主设定房间规则（#4 / #6）：仅房主、仅开局前；成功后 ack 回最新设置。 */
  'room:update_settings': (payload: RoomSettingsPatch, ack: (response: Ack<RoomSettings>) => void) => void;
}

export interface ServerToClientEvents {
  'room:state': (room: PublicRoomState) => void;
  'player:connection': (change: { playerId: string; online: boolean }) => void;
  'room:closed': (payload: { reason: RoomClosedReason }) => void;
  'game:events': (payload: { events: GameEvent[] }) => void;
  'game:snapshot': (payload: { state: PublicGameSnapshot }) => void;
  'room:chat_broadcast': (payload: ChatMessage) => void;
  /**
   * 单播给刚进入房间的连接：该房间最近 `CHAT_HISTORY_LIMIT` 条聊天（按时间升序）。
   * 在 create / join / resume 的 ack 之后发出，客户端可直接覆盖本地 chatLog。
   */
  'room:chat_history': (payload: { messages: ChatMessage[] }) => void;
  /**
   * 房间规则设置（#4 / #6）：建房 / 加入 / 重连时单播一次当前值，房主改动后广播给全房间。
   * 刻意不塞进 PublicRoomState —— 那样会改动房间状态的对外形状，让所有既有断言一起变红；
   * 房间设置是「独立的旁路信息」，用一条独立事件承载更稳。
   */
  'room:settings': (settings: RoomSettings) => void;
}

export interface InterServerEvents {}

export interface SocketData {
  roomCode?: string;
  playerId?: string;
}
