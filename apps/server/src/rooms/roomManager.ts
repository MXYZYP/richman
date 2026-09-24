import { getActiveMapPack, getMapPack } from '@richman/board-data';
import type { MapPack, MapRef } from '@richman/board-data';
import { hydrateGameState } from '@richman/engine';
import type { BotDifficulty, GameState } from '@richman/engine';
import { applyGameIntent as applyRuntimeGameIntent, chooseTakeoverIntent, createInitialGame, defaultGameGateway, skipOfflineTakeoverTurn } from '../game/gameRuntime';
import type { GameRuntimeGateway } from '../game/gameRuntime';
import type { PublicRoomState, RoomRole, RoomRuleConfig, RoomSettings, RoomSettingsPatch } from '@richman/protocol';
import { gameFailure, roomFailure } from './roomErrors';
import type { RoomFailure, WireFailure } from './roomErrors';
import { ROOM_SNAPSHOT_SCHEMA_VERSION } from './roomSnapshotStore';
import type { RoomSnapshotRecord, RoomSnapshotStore } from './roomSnapshotStore';
import type { AutomationSource, CreateRoomValue, GameActionResult, Intent, JoinRoomValue, Room, RoomAutomation, RoomDomainEvent, RoomManagerDependencies, RoomMapResolver, RoomPlayer, RoomSpectator, RoomResult, RoomSuccess } from './roomTypes';

const MAX_PLAYERS = 6;
const MAX_SPECTATORS = 3;
const BOT_NICKNAMES = ['电脑 A', '电脑 B', '电脑 C', '电脑 D', '电脑 E', '电脑 F', '电脑 G', '电脑 H', '电脑 I'] as const;
const MAX_NICKNAME_CODE_POINTS = 20;
const RANDOM_ROOM_CODE_RETRIES = 100;
const ROOM_CODE_COUNT = 1_000_000;
const LOBBY_DISCONNECT_GRACE_MS = 300_000;
/** 自动化连续失败自愈上限：超过后放弃并永久清空，避免无限空转（详见 #runAutomationCallback）。 */
const MAX_AUTOMATION_SELF_HEAL_RETRIES = 3;
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
  /** 掉线后自动托管的宽限计时器：宽限内玩家重连则取消托管，避免短暂断网即被托管走步。 */
  readonly #autoTakeoverGrace = new Map<string, { timer: TTimerHandle; actorId: string }>();
  readonly #automation = new Map<string, RoomAutomation>();
  readonly #automationGeneration = new Map<string, number>();
  /** 自动化连续提交/决策失败计数：用于「有界自愈」——失败后下一拍重新计算意图，
   *  避免一次 WRONG_PHASE 就把电脑玩家/托管永久冻结在「行动中」（联网电脑 B 卡死的根因之一）。 */
  readonly #automationFailures = new Map<string, number>();
  readonly #gateway: GameRuntimeGateway;
  readonly #mapResolver: RoomMapResolver;
  /** 房间落盘快照（C-③）：为 null 时纯内存运行，行为与引入前完全一致。 */
  readonly #snapshotStore: RoomSnapshotStore | null;

  constructor(dependencies: RoomManagerDependencies<TTimerHandle>) {
    this.#dependencies = dependencies;
    this.#gateway = dependencies.gameGateway ?? defaultGameGateway;
    this.#mapResolver = dependencies.mapResolver ?? DEFAULT_MAP_RESOLVER;
    this.#snapshotStore = dependencies.snapshotStore ?? null;
    this.#restoreRoomsFromSnapshots();
  }

  createRoom(nickname: string, mapId: string, requestId?: string, botDifficulty: BotDifficulty = 'normal'): RoomResult<CreateRoomValue> {
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
      botDifficulty,
      // 建房时先不覆盖任何规则：房主进大厅后再按需改（#4）。
      ruleConfig: null,
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
    this.#persistRoom(room);

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
    this.#persistRoom(room);
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

  /**
   * 房主调整房间设置（#4 规则自定义 / #6 电脑难度）。
   *
   * 三条约束：
   *  - 只认房主（与加/删/改名电脑同一套 `validateHostLobbyRoom`）；
   *  - 只在开局前（`status === 'lobby'`）——开局后再改会让已经在跑的 `GameState.config`
   *    与房间设置不一致，属于典型的「两边都以为自己是对的」；
   *  - 最高房级不得高于该地图自己的 `maxHouseLevel`（过路费按 rents[level] 取档，
   *    rents 长度恒为 maxHouseLevel + 1，超出即收 0 元；快照恢复时 hydrate 也会拒绝）。
   *
   * 改动以 `room_settings` 领域事件广播，不写进 PublicRoomState（见 protocol 里的说明）。
   */
  updateRoomSettings(roomCode: string, requesterId: string, patch: RoomSettingsPatch): RoomResult<RoomSettings> {
    const validation = validateHostLobbyRoom(this.#rooms.get(roomCode), requesterId);
    if (!validation.ok) {
      return validation;
    }
    const room = validation.room;

    if (patch.botDifficulty !== undefined) {
      if (!isBotDifficulty(patch.botDifficulty)) {
        return roomFailure('INVALID_ROOM_ACTION', 'Unknown bot difficulty.');
      }
      room.botDifficulty = patch.botDifficulty;
    }

    if (patch.ruleConfig !== undefined) {
      if (patch.ruleConfig === null) {
        room.ruleConfig = null;
      } else {
        let mapMaxHouseLevel: number;
        try {
          mapMaxHouseLevel = this.#mapResolver.getActiveMapPack(room.mapRef.id).game.config.maxHouseLevel;
        } catch {
          return roomFailure('INVALID_ROOM_ACTION', 'Requested map is unavailable.');
        }
        const cleaned = normalizeRoomRuleConfig(patch.ruleConfig, mapMaxHouseLevel);
        if (cleaned === null) {
          return roomFailure(
            'INVALID_ROOM_ACTION',
            `Rule config must use a positive initialCash, an integer maxHouseLevel within 1-${mapMaxHouseLevel}, and a mortgageInterestRate within 0-1.`,
          );
        }
        room.ruleConfig = cleaned;
      }
    }

    // 先把设置本身落盘，再产出广播事件：这样即便广播失败，重启后读到的也是最新设置。
    this.#persistRoom(room);
    const settings = projectRoomSettings(room);
    return {
      ok: true,
      value: settings,
      events: [{ type: 'room_settings', roomCode: room.code, settings }],
    };
  }

  /** 单播用：把当前房间设置投影成对外的形状（加入 / 重连 / 建房时各发一次）。 */
  getRoomSettings(roomCode: string): RoomSettings | null {
    const room = this.#rooms.get(roomCode);
    return room === undefined ? null : projectRoomSettings(room);
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

    // 房主自定义规则（#4）：只覆盖 initialCash / maxHouseLevel / mortgageInterestRate，
    // 其余字段严格沿用地图 game-config——`utilityMultipliers`、`diceMode`、`jail*` 等
    // 都受地图校验器与 hydrateGameState 的双向硬约束，放开了只会造出恢复不回来的对局。
    // `room.ruleConfig` 进入本类时已被 normalizeRoomRuleConfig 清洗过，此处可安全展开。
    const effectiveConfig = applyRoomRuleConfig(mapPack.game.config, room.ruleConfig);

    const created = createInitialGame(
      this.#gateway,
      room.players.map((player) => ({ id: player.id, nickname: player.nickname, isBot: player.isBot })),
      this.#dependencies.generateGameSeed(),
      mapPack.game.board,
      mapPack.game.cards,
      effectiveConfig,
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
    this.#persistRoom(room);

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

  /** 房主将指定玩家（或观众）移出房间。
   *  - 大厅中：直接移除玩家（房主被踢则转让房主，仅剩电脑则解散房间）；观众随时移除。
   *  - 对局中：强制该玩家「出局」——复用引擎的投降结算（现金清零、名下地产释放、债务结清、
   *    回合推进），与玩家主动投降走同一套规则，保证结算一致；若仅剩一名存活玩家则直接终局。
   *    这区别于旧语义「标记离线 + 自动托管」，被踢者立即退出本局，不再由电脑代为行动。
   *  房主不能踢自己。 */
  kickPlayer(roomCode: string, requesterId: string, targetPlayerId: string): RoomResult<PublicRoomState | null> {
    const room = this.#rooms.get(roomCode);
    if (room === undefined) {
      return roomFailure('ROOM_NOT_FOUND', 'Room was not found.');
    }
    if (room.hostId !== requesterId) {
      return roomFailure('NOT_HOST', 'Only the host can kick players.');
    }
    if (requesterId === targetPlayerId) {
      return roomFailure('INVALID_ROOM_ACTION', 'You cannot kick yourself.');
    }
    const inPlayers = room.players.some((player) => player.id === targetPlayerId);
    const inSpectators = room.spectators.some((spectator) => spectator.id === targetPlayerId);
    if (!inPlayers && !inSpectators) {
      return roomFailure('INVALID_ROOM_ACTION', 'The player is not in this room.');
    }

    // 观众任何时候直接移出房间（大厅/对局中一致）。
    if (inSpectators && !inPlayers) {
      return this.#removeSpectator(room, room.spectators.find((member) => member.id === targetPlayerId)!);
    }
    // 对局中踢真人玩家 = 强制其出局（投降结算）。
    if (room.status === 'playing') {
      return this.#kickEliminateInGame(room, targetPlayerId);
    }
    // 大厅中移出玩家。
    return this.leaveRoom(roomCode, targetPlayerId);
  }

  /** 对局中将目标玩家强制出局：复用引擎的 surrender 结算，与玩家主动投降完全一致，
   *  使房间内「房主踢人」与「自己投降」在现金/地产处置、债务结清、回合推进上保持同一套规则。
   *  被踢者立即从存活名单移除；若其正占用自动化（离线托管/电脑）则先清掉待执行定时器，
   *  避免出局后定时器仍试图接管一个已出局的玩家。 */
  #kickEliminateInGame(room: Room, targetPlayerId: string): RoomResult<PublicRoomState | null> {
    const playerIndex = room.players.findIndex((player) => player.id === targetPlayerId);
    if (playerIndex === -1) {
      return this.#roomStateSuccess(room);
    }

    // 若被踢者正占用自动化，先清掉其待执行定时器，避免出局后定时器仍试图接管。
    const automation = this.#automation.get(room.code);
    if (automation !== undefined && automation.playerId === targetPlayerId) {
      this.#clearAutomation(room.code);
    }

    const committed = this.#commitTransition(room, targetPlayerId, { type: 'surrender' }, 'manual');
    if (!committed.ok) {
      // 引擎拒绝出局（如已被淘汰、或仅剩该玩家）：回退为旧语义「标记离线 + 自动托管」兜底。
      return this.#markPlayerOffline(room, playerIndex, true);
    }

    const publicRoom = this.#projectPublicRoom(room);
    return {
      ok: true,
      value: publicRoom,
      events: [...committed.events, { type: 'room_state', roomCode: room.code, room: publicRoom }],
    };
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
      // 重连即取消待起的自动托管：控制权交还本人，而非被托管走步。
      this.#cancelAutoTakeoverGrace(room.code, playerId);
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
    // 大厅类变更（加/删/改名电脑、踢人、重连、观众进出）都汇聚到这里，统一在这里落盘。
    this.#persistRoom(room);
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
    for (const pending of this.#autoTakeoverGrace.values()) this.#dependencies.clearTimer(pending.timer);
    this.#autoTakeoverGrace.clear();

    const roomCodes = new Set([...this.#gameAutomationTimers.keys(), ...this.#automation.keys()]);
    for (const roomCode of roomCodes) {
      this.#clearAutomation(roomCode);
    }
    this.#gameAutomationTimers.clear();
    this.#automation.clear();
    this.#createRequestIndex.clear();
    this.#joinRequestIndex.clear();
  }

  // ───────────────────────── 落盘快照（C-③ / #22 / #34） ─────────────────────────

  /**
   * 进程启动时读回快照并重建房间。
   *
   * 刻意是**全量事件驱动**而非「定时快照」：房间每次实质变更（回合推进、玩家进出、改名电脑…）
   * 都同步写一次盘，所以恢复出来的状态总是最后一次成功提交的回合——比每 N 秒采样更不容易丢步，
   * 也无需额外的定时器与「快照间隔内崩溃」的取舍。
   *
   * 单条快照的任何问题（JSON 损坏、版本不符、地图对不上、gameState 校验失败）都只丢弃它自己，
   * 绝不阻断启动——恢复失败的对局顶多回到「房间不存在」，而服务端必须起得来。
   */
  #restoreRoomsFromSnapshots(): void {
    const store = this.#snapshotStore;
    if (store === null) {
      return;
    }

    let records: RoomSnapshotRecord[];
    try {
      records = store.loadAll();
    } catch (error) {
      this.#dependencies.onServerError?.('room snapshot load failed', error);
      return;
    }

    let restored = 0;
    for (const record of records) {
      try {
        if (this.#restoreRoom(record)) {
          restored += 1;
        }
      } catch (error) {
        this.#dependencies.onServerError?.(`room snapshot restore failed for ${record.code}`, error);
        this.#forgetRoom(record.code);
      }
    }

    if (records.length > 0) {
      const skipped = records.length - restored;
      console.log(`[richman] 房间快照恢复完成：成功 ${restored} 个${skipped > 0 ? `，跳过 ${skipped} 个` : ''}。`);
    }
  }

  /** 恢复单个房间；成功返回 true，快照不可用时删除并返回 false。 */
  #restoreRoom(record: RoomSnapshotRecord): boolean {
    let pack;
    try {
      pack = this.#mapResolver.getMapPack(record.mapRef);
    } catch {
      // 地图已下线/未注册：该房间无法重建，直接丢弃快照。
      this.#forgetRoom(record.code);
      return false;
    }

    // 自定义规则（#4）也要跟着快照一起回来：磁盘文件可能被外部改动，所以先重新清洗一遍，
    // 再把「叠加后的 config」作为 hydrate 的权威 config——否则任何改过初始资金/房级的房间
    // 在重启后都会被 hydrate 判为「快照不可恢复」而整间丢掉。
    const ruleConfig = record.ruleConfig == null
      ? null
      : normalizeRoomRuleConfig(record.ruleConfig, pack.game.config.maxHouseLevel);
    if (record.ruleConfig != null && ruleConfig === null) {
      this.#dependencies.onServerError?.(
        `room snapshot rule config is invalid for ${record.code}`,
        new Error('Invalid rule config in snapshot.'),
      );
      this.#forgetRoom(record.code);
      return false;
    }

    let gameState: GameState | null = null;
    if (record.gameState !== null) {
      const hydrated = hydrateGameState(record.gameState, pack, applyRoomRuleConfig(pack.game.config, ruleConfig));
      if (!hydrated.ok) {
        this.#dependencies.onServerError?.(`room snapshot is not restorable for ${record.code}: ${hydrated.reason}`, hydrated.reason);
        this.#forgetRoom(record.code);
        return false;
      }
      gameState = hydrated.state;
    }

    // 重启后没有任何 socket 连着：所有真人一律先置离线，等客户端用本地 token 走 session:resume
    // 回来再把 online 打开。否则房间会「以为玩家还在线」，既不排自动化也等不到重连。
    const players: RoomPlayer[] = record.players.map((player) => ({ ...player, online: false }));
    const spectators: RoomSpectator[] = record.spectators.map((spectator) => ({ ...spectator, online: false }));
    const status = gameState === null ? 'lobby' : record.status;

    const room: Room = {
      code: record.code,
      mapRef: copyMapRef(pack.ref),
      mapTitle: pack.metadata.title,
      status,
      hostId: record.hostId,
      botDifficulty: record.botDifficulty,
      ruleConfig,
      players,
      spectators,
      gameState: gameState === null
        ? null
        : { ...gameState, players: gameState.players.map((player) => (player.isBot ? player : { ...player, online: false })) },
      createRequestId: record.createRequestId,
      createRequestNickname: record.createRequestNickname,
      createRequestPlayerId: record.createRequestPlayerId,
      createRequestToken: record.createRequestToken,
    };

    this.#rooms.set(room.code, room);
    if (room.createRequestId !== null) {
      this.#createRequestIndex.set(room.createRequestId, room.code);
    }
    for (const player of room.players) {
      if (player.joinRequestId !== null) {
        this.#joinRequestIndex.set(player.joinRequestId, {
          roomCode: room.code,
          playerId: player.id,
          token: player.token ?? '',
          nickname: player.nickname,
          role: 'player',
        });
      }
    }
    for (const spectator of room.spectators) {
      if (spectator.joinRequestId !== null) {
        this.#joinRequestIndex.set(spectator.joinRequestId, {
          roomCode: room.code,
          playerId: spectator.id,
          token: spectator.token,
          nickname: spectator.nickname,
          role: 'spectator',
        });
      }
    }

    // 重建自动化：行动者是电脑就立刻排期；是「离线真人」则由 #maybeAutoTakeover 起宽限计时器,
    // 给客户端重连留出机会（与运行期掉线托管同一套语义）。
    if (room.status === 'playing' && room.gameState !== null && room.gameState.phase !== 'game_over') {
      const actorId = this.#engineActor(room.gameState);
      this.#startBotIfActorIsBot(room, room.gameState, actorId);
      this.#maybeAutoTakeover(room, room.gameState, actorId);
    }

    return true;
  }

  /** 把房间当前状态同步写盘；失败只记录，不影响对局继续。 */
  #persistRoom(room: Room): void {
    const store = this.#snapshotStore;
    if (store === null) {
      return;
    }
    try {
      store.save(this.#toSnapshotRecord(room));
    } catch (error) {
      this.#dependencies.onServerError?.(`room snapshot save failed for ${room.code}`, error);
    }
  }

  /** 房间解散：删掉它的快照，避免重启后又把一个已解散的房间复活。 */
  #forgetRoom(roomCode: string): void {
    const store = this.#snapshotStore;
    if (store === null) {
      return;
    }
    try {
      store.remove(roomCode);
    } catch (error) {
      this.#dependencies.onServerError?.(`room snapshot remove failed for ${roomCode}`, error);
    }
  }

  #toSnapshotRecord(room: Room): RoomSnapshotRecord {
    return {
      schemaVersion: ROOM_SNAPSHOT_SCHEMA_VERSION,
      savedAt: Date.now(),
      code: room.code,
      mapRef: room.mapRef,
      mapTitle: room.mapTitle,
      status: room.status,
      hostId: room.hostId,
      botDifficulty: room.botDifficulty,
      // 自定义规则随快照落盘（#4）：不写它，重启后房间会退回地图默认值，
      // 而 gameState 里已经是按自定义值跑出来的状态，两边立刻对不上。
      ruleConfig: room.ruleConfig === null ? null : { ...room.ruleConfig },
      players: room.players.map((player) => ({ ...player })),
      spectators: room.spectators.map((spectator) => ({ ...spectator })),
      createRequestId: room.createRequestId,
      createRequestNickname: room.createRequestNickname,
      createRequestPlayerId: room.createRequestPlayerId,
      createRequestToken: room.createRequestToken,
      // JSON 往返一次：既确认状态确实可序列化（不可序列化会在此抛错并被 #persistRoom 记下），
      // 也让内存里的快照与真正落到磁盘的字节完全一致（顺带丢掉值为 undefined 的键）。
      gameState: room.gameState === null ? null : (JSON.parse(JSON.stringify(room.gameState)) as unknown),
    };
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
    this.#forgetRoom(roomCode);
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

    // 游戏中当前行动者刚掉线：立即自动托管，免去房主每回合手动点击「托管」。
    const autoEvents = (room.status === 'playing' && room.gameState !== null)
      ? this.#maybeAutoTakeover(room, room.gameState, this.#engineActor(room.gameState))
      : [];

    this.#persistRoom(room);
    return {
      ok: true,
      value: this.#projectPublicRoom(room),
      events: [...events, ...autoEvents],
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

    // 每次回合推进后落盘：这是对局状态唯一的实质变更点，写在这里等于「每步都不丢」。
    this.#persistRoom(room);

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
      // 交接给下一个行动者后必须重建自动化：新行动者若不是电脑（例如多名真人同时掉线、
      // 或托管的同一玩家连续两回合），只清空旧记录会让房间再也排不出计时器 → 静默硬冻结。
      const events: RoomDomainEvent[] = clearEvent === null ? [] : [clearEvent];
      events.push(...this.#maybeAutoTakeover(room, state, actorId));
      return events;
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
    return this.#maybeAutoTakeover(room, state, actorId);
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

  /**
   * 玩家退出/断线后自动托管：当当前行动者是离线真人（非电脑、非在线）且债务已清时，
   * 自动开启 offline_takeover 自动化，免去房主每回合手动点击「托管」。
   * 复用与 requestSkipOfflineTurn 相同的触发条件（仅由服务器自动发起，不再要求房主点击）。
   */
  #maybeAutoTakeover(room: Room, state: GameState, actorId: string): RoomDomainEvent[] {
    const actor = state.players.find((p) => p.id === actorId);
    if (actor === undefined || actor.isBot || actor.online) return [];
    if (state.debt !== null) return [];
    if (this.#automation.has(room.code) || this.#gameAutomationTimers.has(room.code)) return [];
    if (this.#autoTakeoverGrace.has(room.code)) return [];
    // 宽限期内不立即托管：给掉线玩家重连机会，避免短暂网络抖动即被托管替玩家走完一回合。
    // 宽限结束且玩家仍未在线、未破产、无未清债务，才真正起离线托管。
    const GRACE_MS = 15_000;
    const timer = this.#dependencies.setTimer(() => {
      this.#autoTakeoverGrace.delete(room.code);
      if (room.status !== 'playing' || room.gameState === null) return;
      const current = room.gameState.players.find((candidate) => candidate.id === actorId);
      if (current === undefined || current.online || current.bankrupt || room.gameState.debt !== null) return;
      if (this.#automation.has(room.code) || this.#gameAutomationTimers.has(room.code)) return;
      const events = this.#startAutoTakeover(room, room.gameState, actorId);
      this.#dependencies.onAsyncEvents(events);
    }, GRACE_MS);
    this.#autoTakeoverGrace.set(room.code, { timer, actorId });
    return [{ type: 'room_state', roomCode: room.code, room: this.#projectPublicRoom(room) }];
  }

  #cancelAutoTakeoverGrace(roomCode: string, actorId: string): void {
    const pending = this.#autoTakeoverGrace.get(roomCode);
    if (pending === undefined || pending.actorId !== actorId) return;
    this.#dependencies.clearTimer(pending.timer);
    this.#autoTakeoverGrace.delete(roomCode);
  }

  #startAutoTakeover(room: Room, state: GameState, actorId: string): RoomDomainEvent[] {
    this.#cancelAutoTakeoverGrace(room.code, actorId);
    const record = this.#createAutomation(room, state, 'offline_takeover', actorId);
    this.#scheduleAutomation(room, record);
    return [{ type: 'room_state', roomCode: room.code, room: this.#projectPublicRoom(room) }];
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
      const events: RoomDomainEvent[] = clearEvent === null ? [] : [clearEvent];
      if (liveState !== null && liveState.phase === 'playing') {
        const liveActor = this.#engineActor(liveState);
        this.#startBotIfActorIsBot(room, liveState, liveActor);
        // 清空陈旧自动化后必须为当前行动者重建：电脑立即排期，离线真人则重新起托管宽限。
        // 否则房间会停在「零活跃计时器、零服务端错误」的静默冻结状态——线上表现为
        // 「一直显示某人行动中、谁都无法掷骰子」。
        events.push(...this.#maybeAutoTakeover(room, liveState, liveActor));
      }
      if (events.length > 0) this.#dependencies.onAsyncEvents(events);
      return;
    }

    let intent: Intent | null;
    try {
      intent = record.mode === 'bot' ? this.#gateway.chooseBotIntent(state, actorId, room.botDifficulty) : chooseTakeoverIntent(state, room.botDifficulty);
    } catch (error) {
      // 有界自愈：一次决策异常不应永久冻结对局，下一拍重新计算（bot 修复后会产出合法意图）。
      if (!this.#recordAutomationFailureAndMaybeGiveUp(roomCode)) {
        this.#scheduleAutomation(room, record);
        return;
      }
      this.#dependencies.onServerError?.(`automation choose intent threw in room ${room.code}`, error);
      const clearEvent = this.#clearAutomation(roomCode);
      if (clearEvent !== null) this.#dependencies.onAsyncEvents([clearEvent]);
      return;
    }
    const outcome = this.#commitTransition(room, actorId, intent, record.mode);
    if (!outcome.ok) {
      // 有界自愈：提交失败（如 WRONG_PHASE）不再永久清空自动化，下一拍用（已修复的）bot 重新决策，
      // 同状态重算应得到被引擎接受的意图；连续超过上限才放弃，避免无限空转。
      if (!this.#recordAutomationFailureAndMaybeGiveUp(roomCode)) {
        this.#scheduleAutomation(room, record);
        return;
      }
      this.#dependencies.onServerError?.(`automation commit failed in room ${room.code}: ${outcome.code}`, outcome);
      const clearEvent = this.#clearAutomation(roomCode);
      if (clearEvent !== null) this.#dependencies.onAsyncEvents([clearEvent]);
      return;
    }
    // 提交成功：清零失败计数，正常推进。
    this.#automationFailures.delete(roomCode);
    this.#dependencies.onAsyncEvents(outcome.events);
  }

  /** 记录一次自动化失败；返回 true 表示已超过自愈上限、应放弃并永久清空。 */
  #recordAutomationFailureAndMaybeGiveUp(roomCode: string): boolean {
    const next = (this.#automationFailures.get(roomCode) ?? 0) + 1;
    this.#automationFailures.set(roomCode, next);
    return next > MAX_AUTOMATION_SELF_HEAL_RETRIES;
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
    this.#automationFailures.delete(roomCode);
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

function isBotDifficulty(value: unknown): value is BotDifficulty {
  return value === 'easy' || value === 'normal' || value === 'hard';
}

/**
 * 校验并规整房主提交的规则覆盖（#4）；不可用时返回 null。
 *
 * 与引擎侧 `resolveOverriddenGameConfig` 同一套判据（这里做「入口」清洗，那里做「恢复」放行）：
 *  - `initialCash` 必须为正有限数——0 或负数会让引擎在第一回合就把所有人判破产；
 *  - `maxHouseLevel` 必须是 1..地图档位 的整数，超出即 `rents[level]` 越界、顶层房屋收 0 元租金，
 *    且 hydrate 恢复时会因 `level > maxHouseLevel` 直接拒绝该快照；
 *  - `mortgageInterestRate` 必须落在 0..1，否则赎回价会出现负数或爆炸增长。
 */
function normalizeRoomRuleConfig(rule: RoomRuleConfig, mapMaxHouseLevel: number): RoomRuleConfig | null {
  const { initialCash, maxHouseLevel, mortgageInterestRate } = rule;
  if (typeof initialCash !== 'number' || !Number.isFinite(initialCash) || initialCash <= 0) return null;
  if (!Number.isSafeInteger(maxHouseLevel) || maxHouseLevel < 1 || maxHouseLevel > mapMaxHouseLevel) return null;
  if (typeof mortgageInterestRate !== 'number' || !Number.isFinite(mortgageInterestRate)
    || mortgageInterestRate < 0 || mortgageInterestRate > 1) return null;
  return { initialCash, maxHouseLevel, mortgageInterestRate };
}

/** 房间设置投影：拷一份出去，避免外部拿到内部可变引用（ruleConfig 是唯一可变嵌套对象）。 */
function projectRoomSettings(room: Room): RoomSettings {
  return {
    botDifficulty: room.botDifficulty,
    ruleConfig: room.ruleConfig === null ? null : { ...room.ruleConfig },
  };
}

/**
 * 把房间的自定义规则叠加到地图默认 config 上（#4）。
 * `room.ruleConfig` 已在 `updateRoomSettings` 中被清洗，这里只做合并。
 */
function applyRoomRuleConfig(
  baseConfig: MapPack['game']['config'],
  ruleConfig: RoomRuleConfig | null,
): MapPack['game']['config'] {
  if (ruleConfig === null) return baseConfig;
  // 展开后会丢掉 DeepReadonly 只读标记，但结构完全等价；引擎侧只读消费该对象。
  return { ...baseConfig, ...ruleConfig };
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

  return roomNumber.toString().padStart(6, '0');
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
