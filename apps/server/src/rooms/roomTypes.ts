import type { BotDifficulty, GameEvent, GameState } from '@richman/engine';
import type { MapPack, MapRef } from '@richman/board-data';
import type { PublicRoomPlayer, PublicRoomSpectator, PublicRoomState, RoomRuleConfig, RoomSettings, RoomStatus } from '@richman/protocol';
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

export type AutomationSource = 'manual' | 'bot' | 'offline_takeover';

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
  players: RoomPlayer[];
  spectators: RoomSpectator[];
  gameState: GameState | null;
  createRequestId: string | null;
  createRequestNickname: string | null;
  createRequestPlayerId: string | null;
  createRequestToken: string | null;
}
