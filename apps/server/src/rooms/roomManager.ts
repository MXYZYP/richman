import { getActiveMapPack, getMapPack } from '@richman/board-data';
import type { MapRef } from '@richman/board-data';
import type { GameState } from '@richman/engine';
import { applyGameIntent as applyRuntimeGameIntent, chooseTakeoverIntent, createInitialGame, defaultGameGateway, skipOfflineTakeoverTurn } from '../game/gameRuntime';
import type { GameRuntimeGateway } from '../game/gameRuntime';
import type { PublicRoomState, RoomRole } from '@richman/protocol';
import { gameFailure, roomFailure } from './roomErrors';
import type { RoomFailure, WireFailure } from './roomErrors';
import type { AutomationSource, CreateRoomValue, GameActionResult, Intent, JoinRoomValue, Room, RoomAutomation, RoomDomainEvent, RoomManagerDependencies, RoomMapResolver, RoomPlayer, RoomSpectator, RoomResult, RoomSuccess } from './roomTypes';

const MAX_PLAYERS = 6;
const MAX_SPECTATORS = 3;
const BOT_NICKNAMES = ['电脑 A', '电脑 B', '电脑 C', '电脑 D', '电脑 E', '电脑 F', '电脑 G', '电脑 H', '电脑 I'] as const;
const MAX_NICKNAME_CODE_POINTS = 20;
const RANDOM_ROOM_CODE_RETRIES = 100;
const ROOM_CODE_COUNT = 10_000;
const LOBBY_DISCONNECT_GRACE_MS = 300_000;
const DEFAULT_MAP_RESOLVER: RoomMapResolver = { getActiveMapPack, getMapPack };

function copyMapRef(ref: MapRef): MapRef {
  return Object.freeze({ id: ref.id, version: ref.version, contentHash: ref.contentHash });
}

type JoinRequestRecord = {
  roomCode: string;
  playerId: string;
  token: string;
  nickname: string;
  role: RoomRole;
};

export class RoomManager<TTimerHandle = unknown> {
  readonly #dependencies: RoomManagerDependencies<TTimerHandle>;
  readonly #rooms = new Map<string, Room>();
  readonly #createRequestIndex = new Map<string, string>();
  readonly #joinRequestIndex = new Map<string, JoinRequestRecord>();
  readonly #lobbyDisconnectTimers = new Map<string, TTimerHandle>();
  readonly #spectatorDisconnectTimers = new Map<string, TTimerHandle>();
  readonly #gameAutomationTimers = new Map<string, TTimerHandle>();
  readonly #automation = new Map<string, RoomAutomation>();
  readonly #automationGeneration = new Map<string, number>();
  readonly #gateway: GameRuntimeGateway;
  readonly #mapResolver: RoomMapResolver;

  constructor(dependencies: RoomManagerDependencies<TTimerHandle>) {
    this.#dependencies = dependencies;
    this.#gateway = dependencies.gameGateway ?? defaultGameGateway;
    this.#mapResolver = dependencies.mapResolver ?? DEFAULT_MAP_RESOLVER;
  }

  createRoom(nickname: string, mapId: string, requestId?: string): RoomResult<CreateRoomValue> {
    if (requestId !== undefined) {
      const replay = this.#replayCreate(requestId, nickname, mapId);
      if (replay !== undefined) {
        return replay;
      }
    }

    const normalizedNickname = normalizeNickname(nickname);
    if (normalizedNickname === null) {
      return roomFailure('INVALID_NICKNAME', 'Nickname must be 1-20 Unicode code points after trimming.');
    }

    let activeMap;
    try {
      activeMap = this.#mapResolver.getActiveMapPack(mapId);
    } catch {
      return roomFailure('INVALID_ROOM_ACTION', 'Requested map is unavailable.');
    }

    const roomCode = this.#allocateRoomCode();
    if (roomCode === null) {
      return roomFailure('INVALID_ROOM_ACTION', 'No room codes are currently available.');
    }

    const playerId = this.#dependencies.generatePlayerId();
    const token = this.#dependencies.generateToken();
    const room: Room = {
      code: roomCode,
      mapRef: copyMapRef(activeMap.ref),
      mapTitle: activeMap.metadata.title,
      status: 'lobby',
      hostId: playerId,
      players: [
        {
          id: playerId,
          nickname: normalizedNickname,
          token,
          isBot: false,
          online: true,
          joinRequestId: null,
          joinRequestNickname: null,
        },
      ],
      spectators: [],
      gameState: null,
      createRequestId: requestId ?? null,
      createRequestNickname: requestId === undefined ? null : normalizedNickname,
      createRequestPlayerId: requestId === undefined ? null : playerId,
      createRequestToken: requestId === undefined ? null : token,
    };
    this.#rooms.set(roomCode, room);
    if (requestId !== undefined) {
      this.#createRequestIndex.set(requestId, roomCode);
    }

    const publicRoom = this.#projectPublicRoom(room);
    const result: RoomSuccess<CreateRoomValue> = {
      ok: true,
      value: {
        roomCode,
        playerId,
        token,
        room: publicRoom,
      },
      events: [{ type: 'room_state', roomCode, room: publicRoom }],
    };

    return result;
  }

  joinRoom(roomCode: string, nickname: string, requestId?: string, role: RoomRole = 'player'): RoomResult<JoinRoomValue> {
    if (role !== 'player' && role !== 'spectator') {
      return roomFailure('INVALID_ROOM_ACTION', 'Invalid room role.');
    }
    if (requestId !== undefined) {
      const replay = this.#replayJoin(requestId, roomCode, nickname, role);
      if (replay !== undefined) return replay;
    }
    const room = this.#rooms.get(roomCode);
    if (room === undefined) return roomFailure('ROOM_NOT_FOUND', 'Room was not found.');
    if (role === 'player' && room.status !== 'lobby') {
      return roomFailure('GAME_ALREADY_STARTED', 'Game has already started.');
    }
    if (role === 'player' ? room.players.length >= MAX_PLAYERS : room.spectators.length >= MAX_SPECTATORS) {
      return roomFailure('ROOM_FULL', role === 'player' ? 'Player seats are full.' : 'Spectator seats are full.');
    }
    const normalizedNickname = normalizeNickname(nickname);
    if (normalizedNickname === null) {
      return roomFailure('INVALID_NICKNAME', 'Nickname must be 1-20 Unicode code points after trimming.');
    }
    if (room.players.some((member) => member.nickname === normalizedNickname)
      || room.spectators.some((member) => member.nickname === normalizedNickname)) {
      return roomFailure('NICKNAME_TAKEN', 'Nickname is already taken.');
    }
    const playerId = this.#dependencies.generatePlayerId();
    const token = this.#dependencies.generateToken();
    const member = {
      id: playerId, nickname: normalizedNickname, token, online: true,
      joinRequestId: requestId ?? null,
      joinRequestNickname: requestId === undefined ? null : normalizedNickname,
    };
    if (role === 'spectator') room.spectators.push(member);
    else room.players.push({ ...member, isBot: false });
    if (requestId !== undefined) {
      this.#joinRequestIndex.set(requestId, { roomCode: room.code, playerId, token, nickname: normalizedNickname, role });
    }
    const publicRoom = this.#projectPublicRoom(room);
    return {
      ok: true,
      value: { playerId, token, room: publicRoom },
      events: [{ type: 'room_state', roomCode: room.code, room: publicRoom }],
    };
  }

  addBot(roomCode: string, requesterId: string): RoomResult<PublicRoomState> {
    const validation = validateHostLobbyRoom(this.#rooms.get(roomCode), requesterId);
    if (!validation.ok) {
      return validation;
    }
    const room = validation.room;
    if (room.players.length >= MAX_PLAYERS) {
      return roomFailure('ROOM_FULL', 'Room is full.');
    }

    const botNickname = getSmallestUnusedBotNickname(room);
    if (botNickname === null) {
      return roomFailure('INVALID_ROOM_ACTION', 'No bot nickname is available.');
    }

    room.players.push({
      id: this.#dependencies.generatePlayerId(),
      nickname: botNickname,
      token: null,
      isBot: true,
      online: true,
      joinRequestId: null,
      joinRequestNickname: null,
    });

    return this.#roomStateSuccess(room);
  }

  removeBot(roomCode: string, requesterId: string, playerId: string): RoomResult<PublicRoomState> {
    const validation = validateHostLobbyRoom(this.#rooms.get(roomCode), requesterId);
    if (!validation.ok) {
      return validation;
    }
    const room = validation.room;

    const botIndex = room.players.findIndex((player) => player.id === playerId && player.isBot);
    if (botIndex === -1) {
      return roomFailure('INVALID_ROOM_ACTION', 'Only bot players can be removed.');
    }

    room.players.splice(botIndex, 1);

    return this.#roomStateSuccess(room);
  }

  renameBot(
    roomCode: string,
    requesterId: string,
    playerId: string,
    nickname: string,
  ): RoomResult<PublicRoomState> {
    const validation = validateHostLobbyRoom(this.#rooms.get(roomCode), requesterId);
    if (!validation.ok) {
      return validation;
    }
    const room = validation.room;

    const bot = room.players.find((player) => player.id === playerId);
    if (bot === undefined || !bot.isBot) {
      return roomFailure('INVALID_ROOM_ACTION', 'Only bot players can be renamed.');
    }

    const normalizedNickname = normalizeNickname(nickname);
    if (normalizedNickname === null) {
      return roomFailure('INVALID_NICKNAME', 'Nickname must be 1-20 Unicode code points after trimming.');
    }

    if (bot.nickname !== normalizedNickname) {
      if (room.players.some((player) => player.id !== playerId && player.nickname === normalizedNickname)
        || room.spectators.some((spectator) => spectator.nickname === normalizedNickname)) {
        return roomFailure('NICKNAME_TAKEN', 'Nickname is already taken.');
      }

      bot.nickname = normalizedNickname;
    }

    return this.#roomStateSuccess(room);
  }

  startRoom(roomCode: string, requesterId: string): RoomResult<PublicRoomState> {
    const existingRoom = this.#rooms.get(roomCode);
    if (existingRoom?.status === 'ended') {
      return roomFailure('INVALID_ROOM_ACTION', 'The ended room cannot be started again.');
    }
    const validation = validateHostLobbyRoom(existingRoom, requesterId);
    if (!validation.ok) {
      return validation;
    }
    const room = validation.room;
    if (room.players.length < 2 || room.players.every((player) => player.isBot)) {
      return roomFailure('NOT_ENOUGH_PLAYERS', 'At least two players including one human are required.');
    }

    let mapPack;
    try {
      mapPack = this.#mapResolver.getMapPack(room.mapRef);
    } catch (error) {
      this.#dependencies.onServerError?.('startRoom exact map resolution failed', error);
      return roomFailure('INVALID_ROOM_ACTION', 'Unable to start the game.');
    }
    if (
      mapPack.ref.id !== room.mapRef.id
      || mapPack.ref.version !== room.mapRef.version
      || mapPack.ref.contentHash !== room.mapRef.contentHash
    ) {
      this.#dependencies.onServerError?.(
        'startRoom exact map resolution returned a mismatched ref',
        new Error('Resolved map ref does not match the room map lock.'),
      );
      return roomFailure('INVALID_ROOM_ACTION', 'Unable to start the game.');
    }

    const created = createInitialGame(
      this.#gateway,
      room.players.map((player) => ({ id: player.id, nickname: player.nickname, isBot: player.isBot })),
      this.#dependencies.generateGameSeed(),
      mapPack.game.board,
      mapPack.game.cards,
      mapPack.game.config,
      room.mapRef,
      mapPack.game.requiredRuleModules,
    );
    if (!created.ok) {
      this.#dependencies.onServerError?.('startRoom createGame failed', created.error);
      return roomFailure('INVALID_ROOM_ACTION', 'Unable to start the game.');
    }

    const state: GameState = {
      ...created.state,
      players: created.state.players.map((gamePlayer) => {
        const roomPlayer = room.players.find((player) => player.id === gamePlayer.id);
        return roomPlayer !== undefined && !gamePlayer.isBot && gamePlayer.online !== roomPlayer.online
          ? { ...gamePlayer, online: roomPlayer.online }
          : gamePlayer;
      }),
    };

    this.#cancelLobbyDisconnectTimersForRoom(room.code);
    room.gameState = state;
    room.status = 'playing';
    this.#reconcileAfterStart(room, state);

    const publicRoom = this.#projectPublicRoom(room);
    return {
      ok: true,
      value: publicRoom,
      events: [
        { type: 'room_state', roomCode: room.code, room: publicRoom },
        { type: 'game_snapshot', roomCode: room.code, state },
      ],
    };
  }

  applyGameIntent(roomCode: string, playerId: string, intent: Intent): GameActionResult<Record<string, never>> {
    const room = this.#rooms.get(roomCode);
    if (room === undefined || room.status !== 'playing' || room.gameState === null) {
      return roomFailure('INVALID_ROOM_ACTION', 'The room is not accepting game actions.');
    }
    if (!room.players.some((player) => player.id === playerId)) {
      return roomFailure('INVALID_ROOM_ACTION', 'Spectators cannot perform game actions.');
    }

    const automation = this.#automation.get(roomCode);
    if (automation?.mode === 'offline_takeover' && automation.playerId === playerId) {
      return roomFailure('INVALID_ROOM_ACTION', 'The offline takeover is already committing this turn.');
    }

    return this.#commitTransition(room, playerId, intent, 'manual');
  }
  requestSkipOfflineTurn(roomCode: string, requesterId: string): GameActionResult<Record<string, never>> {
    const room = this.#rooms.get(roomCode);
    if (room === undefined || room.status !== 'playing' || room.gameState === null) {
      return roomFailure('INVALID_ROOM_ACTION', 'No active game for that action.');
    }
    if (room.hostId !== requesterId) {
      return roomFailure('NOT_HOST', 'Only the host can complete an offline turn.');
    }

    const state = room.gameState;
    if (state.debt !== null) {
      return roomFailure('INVALID_ROOM_ACTION', 'Cannot skip while a debt is unresolved.');
    }
    const actorId = this.#engineActor(state);
    const actor = room.players.find((player) => player.id === actorId);
    if (actor === undefined || actor.isBot) {
      return roomFailure('INVALID_ROOM_ACTION', 'The current player is not a human.');
    }
    if (actor.online) {
      return roomFailure('INVALID_ROOM_ACTION', 'The current player is online.');
    }
    if (this.#automation.has(roomCode) || this.#gameAutomationTimers.has(roomCode)) {
      return roomFailure('INVALID_ROOM_ACTION', 'Automation is already active for this turn.');
    }

    const record = this.#createAutomation(room, state, 'offline_takeover', actorId);
    this.#scheduleAutomation(room, record);
    const publicRoom = this.#projectPublicRoom(room);
    return {
      ok: true,
      value: {},
      events: [{ type: 'room_state', roomCode, room: publicRoom }],
    };
  }

  leaveRoom(roomCode: string, playerId: string): RoomResult<PublicRoomState | null> {
    const room = this.#rooms.get(roomCode);
    if (room === undefined) {
      return {
        ok: true,
        value: null,
        events: [],
      };
    }
    const spectator = room.spectators.find((member) => member.id === playerId);
    if (spectator !== undefined) {
      return this.#removeSpectator(room, spectator);
    }

    const playerIndex = room.players.findIndex((player) => player.id === playerId);
    if (playerIndex === -1) {
      return {
        ok: true,
        value: null,
        events: [],
      };
    }

    if (room.status === 'lobby') {
      this.#cancelLobbyDisconnectTimer(roomCode, playerId);
      if (room.hostId === playerId) {
        transferLobbyHostToNextHuman(room, playerIndex);
      }

      this.#releaseJoinRequest(room.code, room.players[playerIndex]);
      room.players.splice(playerIndex, 1);
      if (!room.players.some((player) => !player.isBot)) {
        this.#cancelLobbyDisconnectTimersForRoom(roomCode);
        this.#deleteRoom(roomCode);
        return {
          ok: true,
          value: null,
          events: [{ type: 'room_closed', roomCode, reason: 'empty_lobby' }],
        };
      }

      return this.#roomStateSuccess(room);
    }

    return this.#markPlayerOffline(room, playerIndex, true);
  }

  markDisconnected(roomCode: string, playerId: string): RoomResult<PublicRoomState | null> {
    const room = this.#rooms.get(roomCode);
    if (room === undefined) {
      return {
        ok: true,
        value: null,
        events: [],
      };
    }
    const spectator = room.spectators.find((member) => member.id === playerId);
    if (spectator !== undefined) {
      spectator.online = false;
      this.#cancelSpectatorDisconnectTimer(roomCode, playerId);
      const key = getLobbyDisconnectTimerKey(roomCode, playerId);
      const handle = this.#dependencies.setTimer(() => {
        this.#spectatorDisconnectTimers.delete(key);
        const current = this.#rooms.get(roomCode);
        const member = current?.spectators.find((candidate) => candidate.id === playerId);
        if (current !== undefined && member !== undefined && !member.online) {
          this.#dependencies.onAsyncEvents(this.#removeSpectator(current, member).events);
        }
      }, LOBBY_DISCONNECT_GRACE_MS);
      this.#spectatorDisconnectTimers.set(key, handle);
      return this.#roomStateSuccess(room);
    }

    const playerIndex = room.players.findIndex((player) => player.id === playerId);
    if (playerIndex === -1) {
      return {
        ok: true,
        value: null,
        events: [],
      };
    }

    if (room.status === 'lobby') {
      const result = this.#markPlayerOffline(room, playerIndex, false);
      this.#scheduleLobbyDisconnectTimer(roomCode, playerId);
      return result;
    }

    return this.#markPlayerOffline(room, playerIndex, true);
  }

  resumeRoom(roomCode: string, playerId: string, token: string): RoomResult<PublicRoomState> {
    const room = this.#rooms.get(roomCode);
    if (room === undefined) {
      return roomFailure('ROOM_NOT_FOUND', 'Room was not found.');
    }
    const spectator = room.spectators.find((member) => member.id === playerId);
    if (spectator !== undefined) {
      if (!this.#dependencies.compareTokens(spectator.token, token)) {
        return roomFailure('INVALID_TOKEN', 'Spectator token is invalid.');
      }
      this.#cancelSpectatorDisconnectTimer(roomCode, playerId);
      spectator.online = true;
      return this.#roomStateSuccess(room);
    }

    const player = room.players.find((candidate) => candidate.id === playerId);
    if (player === undefined || player.isBot || player.token === null || !this.#dependencies.compareTokens(player.token, token)) {
      return roomFailure('INVALID_TOKEN', 'Player token is invalid.');
    }
    this.#cancelLobbyDisconnectTimer(roomCode, playerId);

    const hadOnlineHuman = room.players.some((candidate) => !candidate.isBot && candidate.online);
    const events: RoomDomainEvent[] = [];
    if (!player.online) {
      player.online = true;
      this.#mirrorOnlineIntoGame(room, playerId, true);
      events.push({ type: 'player_connection', roomCode, playerId, online: true });
    }
    if (!hadOnlineHuman) {
      room.hostId = playerId;
      events.push({ type: 'room_state', roomCode, room: this.#projectPublicRoom(room) });
    }

    return {
      ok: true,
      value: this.#projectPublicRoom(room),
      events,
    };
  }

  getPublicRoom(roomCode: string): PublicRoomState | null {
    const room = this.#rooms.get(roomCode);
    if (room === undefined) {
      return null;
    }

    return this.#projectPublicRoom(room);
  }

  getGameSnapshot(roomCode: string): GameState | null {
    const room = this.#rooms.get(roomCode);
    if (room === undefined || room.gameState === null) {
      return null;
    }

    return {
      ...room.gameState,
      players: [...room.gameState.players],
    };
  }

  #projectPublicRoom(room: Room): PublicRoomState {
    const record = this.#automation.get(room.code);
    return {
      roomCode: room.code,
      status: room.status,
      hostId: room.hostId,
      players: room.players.map((player) => ({
        id: player.id,
        nickname: player.nickname,
        isBot: player.isBot,
        online: player.online,
      })),
      spectators: room.spectators.map(({ id, nickname, online }) => ({ id, nickname, online })),
      takeoverPlayerId: record?.mode === 'offline_takeover' ? record.playerId : null,
      map: {
        ref: room.mapRef,
        title: room.mapTitle,
      },
    };
  }

  #roomStateSuccess(room: Room): RoomSuccess<PublicRoomState> {
    const publicRoom = this.#projectPublicRoom(room);
    return {
      ok: true,
      value: publicRoom,
      events: [{ type: 'room_state', roomCode: room.code, room: publicRoom }],
    };
  }

  dispose(): void {
    for (const handle of this.#lobbyDisconnectTimers.values()) {
      this.#dependencies.clearTimer(handle);
    }
    this.#lobbyDisconnectTimers.clear();
    for (const handle of this.#spectatorDisconnectTimers.values()) this.#dependencies.clearTimer(handle);
    this.#spectatorDisconnectTimers.clear();

    const roomCodes = new Set([...this.#gameAutomationTimers.keys(), ...this.#automation.keys()]);
    for (const roomCode of roomCodes) {
      this.#clearAutomation(roomCode);
    }
    this.#gameAutomationTimers.clear();
    this.#automation.clear();
    this.#createRequestIndex.clear();
    this.#joinRequestIndex.clear();
  }

  #replayCreate(requestId: string, nickname: string, mapId: string): RoomResult<CreateRoomValue> | undefined {
    const roomCode = this.#createRequestIndex.get(requestId);
    if (roomCode === undefined) {
      return undefined;
    }

    const room = this.#rooms.get(roomCode);
    const normalizedNickname = normalizeNickname(nickname);
    if (
      room === undefined ||
      normalizedNickname === null ||
      room.createRequestNickname !== normalizedNickname ||
      room.mapRef.id !== mapId ||
      room.createRequestPlayerId === null ||
      room.createRequestToken === null
    ) {
      if (room === undefined && this.#createRequestIndex.get(requestId) === roomCode) {
        this.#createRequestIndex.delete(requestId);
      }
      return roomFailure('INVALID_ROOM_ACTION', 'Request ID does not match the original room entry.');
    }

    const creator = room.players.find((player) => player.id === room.createRequestPlayerId);
    if (creator === undefined || creator.token !== room.createRequestToken) {
      if (this.#createRequestIndex.get(requestId) === roomCode) {
        this.#createRequestIndex.delete(requestId);
      }
      return roomFailure('INVALID_ROOM_ACTION', 'Request ID does not match an active room entry.');
    }

    const publicRoom = this.#projectPublicRoom(room);
    return {
      ok: true,
      value: {
        roomCode,
        playerId: room.createRequestPlayerId,
        token: room.createRequestToken,
        room: publicRoom,
      },
      events: [{ type: 'room_state', roomCode, room: publicRoom }],
    };
  }

  #replayJoin(requestId: string, roomCode: string, nickname: string, role: RoomRole): RoomResult<JoinRoomValue> | undefined {
    const record = this.#joinRequestIndex.get(requestId);
    if (record === undefined) {
      return undefined;
    }

    const normalizedNickname = normalizeNickname(nickname);
    if (roomCode !== record.roomCode || normalizedNickname === null || normalizedNickname !== record.nickname || role !== record.role) {
      return roomFailure('INVALID_ROOM_ACTION', 'Request ID does not match the original room entry.');
    }

    const room = this.#rooms.get(record.roomCode);
    const player = (role === 'spectator' ? room?.spectators : room?.players)?.find((candidate) => candidate.id === record.playerId);
    if (room === undefined || player === undefined || player.token !== record.token) {
      if (this.#joinRequestIndex.get(requestId) === record) {
        this.#joinRequestIndex.delete(requestId);
      }
      return roomFailure('INVALID_ROOM_ACTION', 'Request ID does not match an active room entry.');
    }

    const publicRoom = this.#projectPublicRoom(room);
    return {
      ok: true,
      value: {
        playerId: record.playerId,
        token: record.token,
        room: publicRoom,
      },
      events: [{ type: 'room_state', roomCode: room.code, room: publicRoom }],
    };
  }

  #releaseJoinRequest(roomCode: string, player: RoomPlayer | RoomSpectator): void {
    if (player.joinRequestId === null) {
      return;
    }

    const record = this.#joinRequestIndex.get(player.joinRequestId);
    if (record?.roomCode === roomCode && record.playerId === player.id && record.token === player.token) {
      this.#joinRequestIndex.delete(player.joinRequestId);
    }
  }

  #deleteRoom(roomCode: string): void {
    const room = this.#rooms.get(roomCode);
    if (room !== undefined) {
      if (room.createRequestId !== null && this.#createRequestIndex.get(room.createRequestId) === roomCode) {
        this.#createRequestIndex.delete(room.createRequestId);
      }
      for (const player of room.players) {
        this.#releaseJoinRequest(roomCode, player);
      }
      for (const spectator of room.spectators) {
        this.#cancelSpectatorDisconnectTimer(roomCode, spectator.id);
        this.#releaseJoinRequest(roomCode, spectator);
      }
    }
    this.#rooms.delete(roomCode);
  }

  #cancelSpectatorDisconnectTimer(roomCode: string, playerId: string): void {
    const key = getLobbyDisconnectTimerKey(roomCode, playerId);
    const handle = this.#spectatorDisconnectTimers.get(key);
    if (handle !== undefined) this.#dependencies.clearTimer(handle);
    this.#spectatorDisconnectTimers.delete(key);
  }

  #removeSpectator(room: Room, spectator: RoomSpectator): RoomSuccess<PublicRoomState> {
    this.#cancelSpectatorDisconnectTimer(room.code, spectator.id);
    this.#releaseJoinRequest(room.code, spectator);
    room.spectators.splice(room.spectators.indexOf(spectator), 1);
    return this.#roomStateSuccess(room);
  }

  #markPlayerOffline(room: Room, playerIndex: number, transferHost: boolean): RoomSuccess<PublicRoomState | null> {
    const player = room.players[playerIndex];
    const events: RoomDomainEvent[] = [];
    if (player.online) {
      player.online = false;
      events.push({ type: 'player_connection', roomCode: room.code, playerId: player.id, online: false });
      this.#mirrorOnlineIntoGame(room, player.id, false);
    }

    if (transferHost && room.hostId === player.id && transferHostToNextHuman(room, playerIndex)) {
      events.push({ type: 'room_state', roomCode: room.code, room: this.#projectPublicRoom(room) });
    }

    return {
      ok: true,
      value: this.#projectPublicRoom(room),
      events,
    };
  }

  #engineActor(state: GameState): string {
    return state.debt?.debtorId ?? state.currentPlayerId;
  }

  #commitTransition(
    room: Room,
    playerId: string,
    intent: Intent | null,
    source: AutomationSource,
  ): GameActionResult<Record<string, never>> {
    const state = room.gameState;
    if (room.status !== 'playing' || state === null) {
      return roomFailure('INVALID_ROOM_ACTION', 'The room is not accepting game actions.');
    }

    const outcome = intent === null && source === 'offline_takeover'
      ? skipOfflineTakeoverTurn(state, playerId)
      : intent === null
        ? { ok: false as const, code: 'ILLEGAL_INTENT' as const }
        : applyRuntimeGameIntent(this.#gateway, state, playerId, intent);
    if (!outcome.ok) {
      if (outcome.error !== undefined) {
        this.#dependencies.onServerError?.(`applyGameIntent failed for room ${room.code}`, outcome.error);
      }
      const failure: WireFailure = gameFailure(outcome.code);
      return failure;
    }

    room.gameState = outcome.state;
    const events: RoomDomainEvent[] = [
      { type: 'game_events', roomCode: room.code, events: outcome.events },
      { type: 'game_snapshot', roomCode: room.code, state: outcome.state },
    ];
    const ended = outcome.state.phase === 'game_over';

    if (ended) {
      room.status = 'ended';
      const clearEvent = this.#clearAutomation(room.code);
      if (clearEvent !== null) events.push(clearEvent);
    } else {
      events.push(...this.#reconcileAfterTransition(room, source));
    }

    return {
      ok: true,
      value: {},
      events,
    };
  }

  #reconcileAfterTransition(room: Room, source: AutomationSource): RoomDomainEvent[] {
    const state = room.gameState;
    if (state === null || state.phase === 'game_over') {
      const clearEvent = this.#clearAutomation(room.code);
      return clearEvent === null ? [] : [clearEvent];
    }
    const actorId = this.#engineActor(state);
    const record = this.#automation.get(room.code);

    if (source === 'offline_takeover' && record !== undefined && record.mode === 'offline_takeover') {
      const keep = state.debt === null && record.playerId === actorId && record.startedTurn === state.turn;
      if (keep) {
        this.#scheduleAutomation(room, record);
        return [];
      }
      const clearEvent = this.#clearAutomation(room.code);
      this.#startBotIfActorIsBot(room, state, actorId);
      return clearEvent === null ? [] : [clearEvent];
    }
    if (source === 'bot' && record !== undefined && record.mode === 'bot') {
      const keep =
        record.playerId === actorId && record.startedTurn === state.turn && this.#modeEligible(record, state, actorId);
      if (keep) {
        this.#scheduleAutomation(room, record);
        return [];
      }
      this.#clearAutomation(room.code);
    }

    this.#startBotIfActorIsBot(room, state, actorId);
    return [];
  }

  #reconcileAfterStart(room: Room, state: GameState): void {
    this.#startBotIfActorIsBot(room, state, this.#engineActor(state));
  }

  #startBotIfActorIsBot(room: Room, state: GameState, actorId: string): void {
    const actor = state.players.find((p) => p.id === actorId);
    if (actor === undefined || !actor.isBot || actor.bankrupt) return;
    const existing = this.#automation.get(room.code);
    if (
      existing !== undefined &&
      existing.mode === 'bot' &&
      existing.playerId === actorId &&
      existing.startedTurn === state.turn &&
      this.#gameAutomationTimers.has(room.code)
    ) {
      return;
    }
    const record = this.#createAutomation(room, state, 'bot', actorId);
    this.#scheduleAutomation(room, record);
  }

  #createAutomation(
    room: Room,
    state: GameState,
    mode: 'bot' | 'offline_takeover',
    actorId: string,
  ): RoomAutomation {
    this.#clearAutomation(room.code);
    const record: RoomAutomation = {
      generation: this.#currentGeneration(room.code),
      mode,
      playerId: actorId,
      startedTurn: state.turn,
    };
    this.#automation.set(room.code, record);
    return record;
  }

  #scheduleAutomation(room: Room, record: RoomAutomation): void {
    const delayMs = this.#dependencies.nextAutomationDelayMs();
    let handle: TTimerHandle;
    handle = this.#dependencies.setTimer(() => {
      if (this.#gameAutomationTimers.get(room.code) !== handle) {
        return;
      }
      this.#gameAutomationTimers.delete(room.code);
      this.#runAutomationCallback(room.code, record.generation);
    }, delayMs);
    this.#gameAutomationTimers.set(room.code, handle);
  }

  #modeEligible(record: RoomAutomation, state: GameState, actorId: string): boolean {
    const actor = state.players.find((p) => p.id === actorId);
    if (actor === undefined || actor.bankrupt) return false;
    if (record.mode === 'bot') return actor.isBot;
    return !actor.isBot && state.debt === null;
  }

  #runAutomationCallback(roomCode: string, generation: number): void {
    const room = this.#rooms.get(roomCode);
    if (room === undefined || room.status !== 'playing') return;
    const state = room.gameState;
    if (state === null || state.phase === 'game_over') return;
    if (generation !== this.#currentGeneration(roomCode)) return;
    const record = this.#automation.get(roomCode);
    if (record === undefined || record.generation !== generation) return;

    const actorId = this.#engineActor(state);
    const stillCurrent =
      record.playerId === actorId && record.startedTurn === state.turn && this.#modeEligible(record, state, actorId);
    if (!stillCurrent) {
      const clearEvent = this.#clearAutomation(roomCode);
      const liveState = room.gameState;
      if (liveState !== null && liveState.phase === 'playing') {
        this.#startBotIfActorIsBot(room, liveState, this.#engineActor(liveState));
      }
      if (clearEvent !== null) this.#dependencies.onAsyncEvents([clearEvent]);
      return;
    }

    let intent: Intent | null;
    try {
      intent = record.mode === 'bot' ? this.#gateway.chooseBotIntent(state, actorId) : chooseTakeoverIntent(state);
    } catch (error) {
      this.#dependencies.onServerError?.(`automation choose intent threw in room ${room.code}`, error);
      const clearEvent = this.#clearAutomation(roomCode);
      if (clearEvent !== null) this.#dependencies.onAsyncEvents([clearEvent]);
      return;
    }
    const outcome = this.#commitTransition(room, actorId, intent, record.mode);
    if (!outcome.ok) {
      const clearEvent = this.#clearAutomation(roomCode);
      if (clearEvent !== null) this.#dependencies.onAsyncEvents([clearEvent]);
      return;
    }
    this.#dependencies.onAsyncEvents(outcome.events);
  }

  #mirrorOnlineIntoGame(room: Room, playerId: string, online: boolean): void {
    const state = room.gameState;
    if (state === null) {
      return;
    }
    const gamePlayer = state.players.find((player) => player.id === playerId);
    if (gamePlayer === undefined || gamePlayer.isBot || gamePlayer.online === online) {
      return;
    }

    room.gameState = {
      ...state,
      players: state.players.map((player) => (player.id === playerId ? { ...player, online } : player)),
    };
  }
  #currentGeneration(roomCode: string): number {
    return this.#automationGeneration.get(roomCode) ?? 0;
  }

  #clearAutomation(roomCode: string): RoomDomainEvent | null {
    const record = this.#automation.get(roomCode);
    const handle = this.#gameAutomationTimers.get(roomCode);
    if (handle !== undefined) {
      this.#dependencies.clearTimer(handle);
      this.#gameAutomationTimers.delete(roomCode);
    }
    this.#automation.delete(roomCode);
    this.#automationGeneration.set(roomCode, this.#currentGeneration(roomCode) + 1);

    const room = this.#rooms.get(roomCode);
    return record?.mode === 'offline_takeover' && room !== undefined
      ? { type: 'room_state', roomCode, room: this.#projectPublicRoom(room) }
      : null;
  }

  #scheduleLobbyDisconnectTimer(roomCode: string, playerId: string): void {
    const timerKey = getLobbyDisconnectTimerKey(roomCode, playerId);
    this.#cancelLobbyDisconnectTimerByKey(timerKey);

    const handle = this.#dependencies.setTimer(() => {
      this.#lobbyDisconnectTimers.delete(timerKey);
      this.#removeTimedOutLobbyPlayer(roomCode, playerId);
    }, LOBBY_DISCONNECT_GRACE_MS);
    this.#lobbyDisconnectTimers.set(timerKey, handle);
  }

  #cancelLobbyDisconnectTimer(roomCode: string, playerId: string): void {
    this.#cancelLobbyDisconnectTimerByKey(getLobbyDisconnectTimerKey(roomCode, playerId));
  }

  #cancelLobbyDisconnectTimerByKey(timerKey: string): void {
    const handle = this.#lobbyDisconnectTimers.get(timerKey);
    if (handle === undefined) {
      return;
    }

    this.#dependencies.clearTimer(handle);
    this.#lobbyDisconnectTimers.delete(timerKey);
  }

  #cancelLobbyDisconnectTimersForRoom(roomCode: string): void {
    const roomKeyPrefix = `${roomCode}:`;
    for (const timerKey of this.#lobbyDisconnectTimers.keys()) {
      if (timerKey.startsWith(roomKeyPrefix)) {
        this.#cancelLobbyDisconnectTimerByKey(timerKey);
      }
    }
  }

  #removeTimedOutLobbyPlayer(roomCode: string, playerId: string): void {
    const room = this.#rooms.get(roomCode);
    if (room === undefined || room.status !== 'lobby') {
      return;
    }

    const playerIndex = room.players.findIndex((player) => player.id === playerId);
    if (playerIndex === -1) {
      return;
    }

    const player = room.players[playerIndex];
    if (player.isBot || player.online) {
      return;
    }

    if (room.hostId === playerId) {
      transferLobbyHostToNextHuman(room, playerIndex);
    }

    this.#releaseJoinRequest(room.code, player);
    room.players.splice(playerIndex, 1);
    if (!room.players.some((candidate) => !candidate.isBot)) {
      this.#cancelLobbyDisconnectTimersForRoom(roomCode);
      this.#deleteRoom(roomCode);
      this.#dependencies.onAsyncEvents([{ type: 'room_closed', roomCode, reason: 'lobby_idle_timeout' }]);
      return;
    }

    this.#dependencies.onAsyncEvents([{ type: 'room_state', roomCode, room: this.#projectPublicRoom(room) }]);
  }

  #allocateRoomCode(): string | null {
    for (let attempt = 0; attempt < RANDOM_ROOM_CODE_RETRIES; attempt += 1) {
      const candidate = formatRoomCode(this.#dependencies.nextRoomNumber());
      if (candidate !== null && !this.#rooms.has(candidate)) {
        return candidate;
      }
    }

    for (let roomNumber = 0; roomNumber < ROOM_CODE_COUNT; roomNumber += 1) {
      const candidate = formatRoomCode(roomNumber);
      if (candidate !== null && !this.#rooms.has(candidate)) {
        return candidate;
      }
    }

    return null;
  }
}

function normalizeNickname(nickname: string): string | null {
  const trimmed = nickname.trim();
  if (trimmed.length === 0 || [...trimmed].length > MAX_NICKNAME_CODE_POINTS) {
    return null;
  }

  return trimmed;
}

function formatRoomCode(roomNumber: number): string | null {
  if (!Number.isInteger(roomNumber) || roomNumber < 0 || roomNumber >= ROOM_CODE_COUNT) {
    return null;
  }

  return roomNumber.toString().padStart(4, '0');
}

function getLobbyDisconnectTimerKey(roomCode: string, playerId: string): string {
  return `${roomCode}:${playerId}`;
}


type HostLobbyRoomValidation = { ok: true; room: Room } | RoomFailure;

function validateHostLobbyRoom(room: Room | undefined, requesterId: string): HostLobbyRoomValidation {
  if (room === undefined) {
    return roomFailure('ROOM_NOT_FOUND', 'Room was not found.');
  }
  if (room.hostId !== requesterId) {
    return roomFailure('NOT_HOST', 'Only the host can perform this action.');
  }
  if (room.status !== 'lobby') {
    return roomFailure('GAME_ALREADY_STARTED', 'Game has already started.');
  }

  return { ok: true, room };
}

function getSmallestUnusedBotNickname(room: Room): string | null {
  for (const nickname of BOT_NICKNAMES) {
    if (!room.players.some((player) => player.nickname === nickname)
      && !room.spectators.some((spectator) => spectator.nickname === nickname)) {
      return nickname;
    }
  }

  return null;
}


function transferHostToNextHuman(room: Room, startIndex: number): boolean {
  const nextHost = findNextOnlineHuman(room.players, startIndex);
  if (nextHost === null || room.hostId === nextHost.id) {
    return false;
  }

  room.hostId = nextHost.id;
  return true;
}

function transferLobbyHostToNextHuman(room: Room, startIndex: number): boolean {
  const nextHost = findNextHuman(room.players, startIndex);
  if (nextHost === null || room.hostId === nextHost.id) {
    return false;
  }

  room.hostId = nextHost.id;
  return true;
}

function findNextHuman(players: RoomPlayer[], startIndex: number): RoomPlayer | null {
  if (players.length === 0) {
    return null;
  }

  for (let offset = 1; offset <= players.length; offset += 1) {
    const player = players[(startIndex + offset) % players.length];
    if (!player.isBot) {
      return player;
    }
  }

  return null;
}

function findNextOnlineHuman(players: RoomPlayer[], startIndex: number): RoomPlayer | null {
  if (players.length === 0) {
    return null;
  }

  for (let offset = 1; offset <= players.length; offset += 1) {
    const player = players[(startIndex + offset) % players.length];
    if (!player.isBot && player.online) {
      return player;
    }
  }

  return null;
}
