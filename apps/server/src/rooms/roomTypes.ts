import type { GameEvent, GameState } from '@richman/engine';
import type { MapPack, MapRef } from '@richman/board-data';
import type { PublicRoomPlayer, PublicRoomSpectator, PublicRoomState, RoomStatus } from '@richman/protocol';
import type { GameRuntimeGateway } from '../game/gameRuntime';
import type { RoomFailure, WireFailure } from './roomErrors';

export type { GameEvent, GameState, Intent } from '@richman/engine';
export type { GameRuntimeGateway } from '../game/gameRuntime';
export type { GameErrorCode, GameFailure, RoomErrorCode, RoomFailure, WireFailure } from './roomErrors';

export type RoomDomainEvent =
  | { type: 'room_state'; roomCode: string; room: PublicRoomState }
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
  players: RoomPlayer[];
  spectators: RoomSpectator[];
  gameState: GameState | null;
  createRequestId: string | null;
  createRequestNickname: string | null;
  createRequestPlayerId: string | null;
  createRequestToken: string | null;
}
