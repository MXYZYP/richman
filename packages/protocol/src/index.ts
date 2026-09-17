import type { GameEvent, GameState, Intent } from '@richman/engine';

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
}

export interface ServerToClientEvents {
  'room:state': (room: PublicRoomState) => void;
  'player:connection': (change: { playerId: string; online: boolean }) => void;
  'room:closed': (payload: { reason: RoomClosedReason }) => void;
  'game:events': (payload: { events: GameEvent[] }) => void;
  'game:snapshot': (payload: { state: PublicGameSnapshot }) => void;
}

export interface InterServerEvents {}

export interface SocketData {
  roomCode?: string;
  playerId?: string;
}
