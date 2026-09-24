import type { BotDifficulty, GameEvent, GameState, Intent, PendingAuction, PendingTrade } from '@richman/engine';

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
  /**
   * 进行中的交易报价（#105）与拍卖（#106）；`null` = 此刻没有议价。
   *
   * 必须进快照：这两个阶段的合法行动者不是 `currentPlayerId`（交易要由报价目标答复、
   * 拍卖要由轮到的叫价者出价），客户端只能靠这两份数据渲染「谁来出价 / 谁能同意」。
   * 也正因为它们是**公开信息**（报价内容本来就摆在台面上），不涉及任何隐藏信息。
   */
  pendingTrade: PendingTrade | null;
  pendingAuction: PendingAuction | null;
  /** 房规「放弃购买即拍卖」（#106）：客户端据此决定 skip_buy 的按钮文案。 */
  auctionOnDecline: boolean;
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

/** 房间级的可调设置（#4 / #6 / #101 / #106）：房主在大厅里设定，随房间存在，开局时生效。 */
export interface RoomSettings {
  botDifficulty: BotDifficulty;
  /** null = 用地图默认规则（房主没有自定义任何一项）。 */
  ruleConfig: RoomRuleConfig | null;
  /**
   * 联机最小悔棋（#101）：开启后，对局中「上一手行动者」可发起悔棋，
   * **须经在场对手逐一确认**才真正回退一步（不是单方面回退）。默认关闭。
   */
  minimalUndoEnabled: boolean;
  /**
   * 房规「放弃购买即拍卖」（#106）：开启后，落到无主地产并选择「不买」时，
   * 该地产由**其他**玩家按座次轮流叫价（放弃者自己不参与），无人出价即流拍。默认关闭。
   */
  auctionOnDecline: boolean;
}

/** 增量更新房间设置；`ruleConfig: null` 明确表示「回到地图默认」。 */
export interface RoomSettingsPatch {
  botDifficulty?: BotDifficulty;
  ruleConfig?: RoomRuleConfig | null;
  minimalUndoEnabled?: boolean;
  auctionOnDecline?: boolean;
}

/**
 * 一次「悔棋」请求（#101）。
 *
 * 由服务端在「上一手行动者」发起时创建并广播给全房间：发起者显示等待态，
 * `voterIds` 里的对手看到「同意 / 拒绝」。**全部同意**才真正回退，任一拒绝即作废；
 * 超时同样作废。这样悔棋永远是「双方同意的一步回退」，而不是某一方单方面改历史。
 */
export interface UndoRequestInfo {
  requestId: string;
  requesterId: string;
  requesterNickname: string;
  /** 需要确认的对手（发起那一刻的「在场人类对手」快照，离线者不计入）。 */
  voterIds: string[];
  /** 已同意的对手 id（用于显示「1/2 已确认」）。 */
  approvals: string[];
  /** 投票截止时间戳（ms）；到点未集齐即视为拒绝。 */
  expiresAt: number;
}

/** 悔棋请求的终态（#101）——四种结果都会广播一次，客户端据此给出发起者反馈。 */
export type UndoOutcome = 'applied' | 'rejected' | 'cancelled' | 'expired';

export interface UndoResultInfo {
  requestId: string;
  outcome: UndoOutcome;
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
  /**
   * 发起悔棋（#101）：只有「上一手行动者」本人能发起，且必须房间开了悔棋、当前无未清债务、
   * 还存在至少一名在场人类对手（否则「需对手确认」无从谈起）。ack 回本次请求详情。
   */
  'room:undo_request': (ack: (response: Ack<UndoRequestInfo>) => void) => void;
  /** 对手对悔棋请求投票（#101）：全部同意才回退，任一人拒绝即作废。 */
  'room:undo_vote': (payload: { requestId: string; approve: boolean }, ack: (response: Ack<Record<string, never>>) => void) => void;
  /** 发起者撤回自己尚未有结果的悔棋请求（#101）。 */
  'room:undo_cancel': (ack: (response: Ack<Record<string, never>>) => void) => void;
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
  /**
   * 悔棋请求广播（#101）：发起时、以及每收到一个「同意」时各广播一次
   * （携带最新的 `approvals`），让所有人在同一时刻看到同一份进度。
   */
  'room:undo_request': (payload: UndoRequestInfo) => void;
  /**
   * 悔棋结果广播（#101）。`applied` 时服务端会紧接着推一份回退后的 `game:snapshot`；
   * 客户端应把那份快照当作**硬重置**处理（对局时间线倒退了，不能按增量播放）。
   */
  'room:undo_result': (payload: UndoResultInfo) => void;
  /**
   * 「此刻谁可以发起悔棋」（#101）：`playerId` 为该玩家 id，`null` 表示没人可悔
   * （房间未开启、无上一手、上一手是电脑、有未清债务、或没有在场对手可确认）。
   *
   * 单独一条事件而不塞进 `PublicRoomState`：后者是房间成员的投影，改它的形状会让
   * 所有既有全等断言与落盘快照一起变红（同 `room:settings` 的理由）。
   */
  'room:undo_available': (payload: { playerId: string | null }) => void;
}

export interface InterServerEvents {}

export interface SocketData {
  roomCode?: string;
  playerId?: string;
}
