import type { BotDifficulty, GameEvent, GameState } from '@richman/engine';
import type { MapPack, MapRef } from '@richman/board-data';
import type { PublicRoomPlayer, PublicRoomSpectator, PublicRoomState, RoomRuleConfig, RoomSettings, RoomStatus, TurnDeadlineInfo, UndoRequestInfo, UndoResultInfo } from '@richman/protocol';
import type { GameRuntimeGateway } from '../game/gameRuntime';
import type { RoomFailure, WireFailure } from './roomErrors';
import type { RoomSnapshotStore } from './roomSnapshotStore';

export type { GameEvent, GameState, Intent } from '@richman/engine';
export type { GameRuntimeGateway } from '../game/gameRuntime';
export type { GameErrorCode, GameFailure, RoomErrorCode, RoomFailure, WireFailure } from './roomErrors';

export type RoomDomainEvent =
  | { type: 'room_state'; roomCode: string; room: PublicRoomState }
  /**
   * 房间设置变更（#4 / #6）：走独立领域事件而不塞进 `PublicRoomState`——
   * 后者是房间成员的投影，改它的形状会让所有既有全等断言与快照一起变红；
   * 设置是低频、独立的一类数据，单独一条事件更诚实。
   */
  | { type: 'room_settings'; roomCode: string; settings: RoomSettings }
  /**
   * 悔棋请求 / 结果 / 可悔权（#101）。三条都走独立事件，理由同上：
   * 它们是围绕「某一步」的旁路信息，不属于房间成员投影，也不该动 PublicRoomState 的形状。
   */
  | { type: 'undo_request'; roomCode: string; request: UndoRequestInfo }
  | { type: 'undo_result'; roomCode: string; result: UndoResultInfo }
  | { type: 'undo_available'; roomCode: string; playerId: string | null }
  /**
   * 回合限时（#107）两条：谁的钟在走、以及谁超时被代走了一步。
   * 同样走独立事件，理由与 `room_settings` / `undo_*` 一致——它们都是围绕「当前这一步」
   * 的旁路信息，不属于房间成员投影，也不该动 PublicRoomState 的形状。
   */
  | { type: 'turn_deadline'; roomCode: string; info: TurnDeadlineInfo }
  | { type: 'turn_timeout'; roomCode: string; playerId: string; nickname: string }
  | { type: 'player_connection'; roomCode: string; playerId: string; online: boolean }
  | { type: 'room_closed'; roomCode: string; reason: 'empty_lobby' | 'lobby_idle_timeout' }
  | { type: 'game_events'; roomCode: string; events: GameEvent[] }
  | { type: 'game_snapshot'; roomCode: string; state: GameState };

export type RoomSuccess<T> = {
  ok: true;
  value: T;
  events: RoomDomainEvent[];
};

export type RoomResult<T> = RoomSuccess<T> | RoomFailure;
export type GameActionResult<T> = RoomSuccess<T> | WireFailure;

/**
 * 一次状态推进的来源。
 *  - `manual`：真人手动提交的意图（socket 层）；
 *  - `bot`：电脑玩家的自动化；
 *  - `offline_takeover`：离线真人由托管代走；
 *  - `turn_timeout`：**在线**真人的回合限时（#107）到点，由服务端按电脑策略替其走一步。
 *
 * 四者在 `#commitTransition` 里走同一条提交路径（都清除可悔点），差别只在「谁决定了这一步」。
 */
export type AutomationSource = 'manual' | 'bot' | 'offline_takeover' | 'turn_timeout';

export interface RoomAutomation {
  generation: number;
  mode: 'bot' | 'offline_takeover';
  playerId: string;
  startedTurn: number;
}

export interface CreateRoomValue {
  roomCode: string;
  playerId: string;
  token: string;
  room: PublicRoomState;
}

export interface JoinRoomValue {
  playerId: string;
  token: string;
  room: PublicRoomState;
}

export interface RoomManagerDependencies<TTimerHandle = unknown> {
  generatePlayerId(): string;
  generateToken(): string;
  nextRoomNumber(): number;
  compareTokens(actual: string, supplied: string): boolean;
  setTimer(callback: () => void, delayMs: number): TTimerHandle;
  clearTimer(handle: TTimerHandle): void;
  onAsyncEvents(events: RoomDomainEvent[]): void;
  generateGameSeed(): string;
  nextAutomationDelayMs(): number;
  /**
   * 房间落盘快照（C-③ / #22 / #34）：传入后，房间每一次实质状态变更都会同步写盘，
   * 进程重启（`pm2 restart`）时由构造器读回并恢复进行中的对局。
   * 不传 = 纯内存模式（单测与既有行为完全不变）。
   */
  snapshotStore?: RoomSnapshotStore;
  mapResolver?: RoomMapResolver;
  gameGateway?: GameRuntimeGateway;
  onServerError?(message: string, error: unknown): void;
}

export interface RoomMapResolver {
  getActiveMapPack(mapId: string): MapPack;
  getMapPack(mapRef: MapRef): MapPack;
}

export interface RoomPlayer extends PublicRoomPlayer {
  token: string | null;
  joinRequestId: string | null;
  joinRequestNickname: string | null;
}

export interface RoomSpectator extends PublicRoomSpectator {
  token: string;
  joinRequestId: string | null;
  joinRequestNickname: string | null;
}

export interface Room {
  code: string;
  readonly mapRef: MapRef;
  readonly mapTitle: string;
  status: RoomStatus;
  hostId: string;
  /** 电脑玩家难度（P1-6）：房主可在大厅改（#6），驱动 chooseBotIntent 的决策激进度。 */
  botDifficulty: BotDifficulty;
  /** 房主自定义规则（#4）：只覆盖 initialCash / maxHouseLevel / mortgageInterestRate；
   *  null = 完全使用地图 game-config 的默认值。 */
  ruleConfig: RoomRuleConfig | null;
  /** 联机最小悔棋开关（#101）：房主在大厅设定，开局后生效。 */
  minimalUndoEnabled: boolean;
  /** 房规「放弃购买即拍卖」（#106）：房主在大厅设定，开局时写进 createGame 的 auctionOnDecline。 */
  auctionOnDecline: boolean;
  /**
   * 每回合限时（#107，秒）：`0` = 不限时（默认）。
   *
   * 刻意**不**进 `GameConfig`：那份 config 受地图 `contentHash` 硬约束（校验器逐字段比对），
   * 塞进去等于给每一张地图加一个字段、且会改变对局可恢复性的判据。限时是**房间层**的节奏设置，
   * 与 `auctionOnDecline` 同类，因此同样只挂在 `Room` 上、由服务端自己的计时器消费。
   */
  turnTimeLimitSec: number;
  /**
   * 是否允许被「公开房间列表」发现（#108）。默认 `false`（隐私优先：房间码本就是准入凭据，
   * 公开与否必须是房主显式做的决定，而不是升级带来的副作用）。
   *
   * 与 `turnTimeLimitSec` 同层：这是**房间层**的可发现性开关，不进 `GameConfig`
   * （那份 config 受地图 contentHash 约束），也不需要进对局状态。
   */
  isPublic: boolean;
  players: RoomPlayer[];
  spectators: RoomSpectator[];
  gameState: GameState | null;
  createRequestId: string | null;
  createRequestNickname: string | null;
  createRequestPlayerId: string | null;
  createRequestToken: string | null;
}
