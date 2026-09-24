import { getActiveMapPack, getMapPack } from '@richman/board-data';
import type { MapPack, MapRef } from '@richman/board-data';
import { hydrateGameState } from '@richman/engine';
import { currentPendingAuction, currentPendingTrade } from '@richman/engine';
import type { BotDifficulty, GameState } from '@richman/engine';
import { applyGameIntent as applyRuntimeGameIntent, chooseTakeoverIntent, createInitialGame, defaultGameGateway, skipOfflineTakeoverTurn } from '../game/gameRuntime';
import type { GameRuntimeGateway } from '../game/gameRuntime';
import type { PublicRoomState, PublicRoomSummary, RoomRole, RoomRuleConfig, RoomSettings, RoomSettingsPatch, TurnDeadlineInfo, UndoOutcome, UndoRequestInfo } from '@richman/protocol';
import { TURN_TIME_LIMIT_MAX_SEC } from '@richman/protocol';
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
/**
 * 悔棋投票窗口（#101）：到点还没集齐「全部同意」就按拒绝处理。
 * 有它才不会出现「一个对手不表态 → 请求永远挂着」的僵局。
 */
const UNDO_REQUEST_TTL_MS = 20_000;
const DEFAULT_MAP_RESOLVER: RoomMapResolver = { getActiveMapPack, getMapPack };

/**
 * 一步「可悔的棋」（#101）：悔棋就是把 `state` 装回去。
 *
 * 持的是**旧状态对象的引用**而非深拷贝——引擎的状态是不可变的（`applyIntent` 返回新对象），
 * 因此旧引用天然是一份可靠的历史快照，不需要额外复制。
 */
type UndoPoint = {
  /** 这一步**之前**的权威状态。 */
  state: GameState;
  /** 走出这一步的玩家：只有他能发起悔棋（「我悔我自己的棋」）。 */
  actorId: string;
  /** 走这一步时所在回合，仅作自检与排查用的标记。 */
  turn: number;
};

/** 悬而未决的悔棋投票（#101）。 */
type PendingUndo = {
  requestId: string;
  requesterId: string;
  requesterNickname: string;
  /** 发起那一刻的「在场人类对手」快照；全部同意才真正回退。 */
  voterIds: string[];
  approvals: Set<string>;
  point: UndoPoint;
};

/**
 * 正在走的回合钟（#107）。
 *
 * 三个字段全是**自检用**的：计时器到点时必须回头核对「还是不是同一个行动者在同一个回合」，
 * 否则一次迟到（比如悔棋回退把 turn 调回去又推进回来）就会把别人的回合代走一步。
 */
type TurnDeadline = {
  playerId: string;
  turn: number;
  deadlineAt: number;
};

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
  /**
   * 悔棋点（#101）：每个房间只保留**最近一步**真人手动棋的前置状态——「最小悔棋」只退一步，
   * 退完即清，不支持连环回退（那会让复盘与自动化重建都变得难以收敛）。
   * 电脑 / 离线托管走步会把它清掉：可悔的必须是真人自己刚走的那一步。
   */
  readonly #undoPoints = new Map<string, UndoPoint>();
  readonly #undoRequests = new Map<string, PendingUndo>();
  readonly #undoTimers = new Map<string, TTimerHandle>();
  /**
   * 回合限时计时器（#107）：只对**在线真人**当前要走的这一步计时。
   *
   * 刻意与 `#automation` / `#gameAutomationTimers` 分开两张表：那个框架是「代理决策」
   * （电脑 / 离线真人，必然产出一个意图并推进），而这里是「催一个本来该自己走的人」。
   * 混在一张表里会让 `#clearAutomation` / `#modeEligible` 的既有判据全部需要重写，
   * 而两套计时器的生命周期并不一致（限时在每次行动者变化时重排，托管只在掉线时起）。
   */
  readonly #turnTimers = new Map<string, TTimerHandle>();
  readonly #turnDeadlines = new Map<string, TurnDeadline>();
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
      // 悔棋默认关闭（#101）：它会改变对局历史的可回退性，必须是房主显式选择加入的能力。
      minimalUndoEnabled: false,
      // 「放弃购买即拍卖」默认关闭（#106）：它就是既有语义（放弃 = 流拍），
      // 开启是房主显式选择的房规，与地图自带的规则无关。
      auctionOnDecline: false,
      // 回合限时默认关闭（#107）：不限时才是既有的默认节奏，房主显式选择才开启。
      turnTimeLimitSec: 0,
      // 公开房间列表默认关闭（#108）：房间码本就是准入凭据，可被全网列举必须是房主显式打开的。
      isPublic: false,
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

    // 悔棋开关（#101）：只认布尔值。关掉时顺手丢弃「可悔权」，避免 UI 上留一个按不动的按钮。
    if (patch.minimalUndoEnabled !== undefined) {
      if (typeof patch.minimalUndoEnabled !== 'boolean') {
        return roomFailure('INVALID_ROOM_ACTION', 'minimalUndoEnabled must be a boolean.');
      }
      room.minimalUndoEnabled = patch.minimalUndoEnabled;
      if (!room.minimalUndoEnabled) {
        this.#undoPoints.delete(room.code);
      }
    }

    // 房规「放弃购买即拍卖」（#106）：只认布尔值，且**仅开局前可改**
    // （开局后改它没有意义：对局中的每一条拍卖分支都读的是状态里的 auctionOnDecline，
    //  而那份状态在 createGame 时就已经定下来了）。
    if (patch.auctionOnDecline !== undefined) {
      if (typeof patch.auctionOnDecline !== 'boolean') {
        return roomFailure('INVALID_ROOM_ACTION', 'auctionOnDecline must be a boolean.');
      }
      room.auctionOnDecline = patch.auctionOnDecline;
    }

    // 回合限时（#107）：只认 0 或正整数，且不得超过 TURN_TIME_LIMIT_MAX_SEC。
    // 0 是合法值（= 不限时），所以不能写成 `if (!value)`——那会把「关掉限时」也判成非法。
    if (patch.turnTimeLimitSec !== undefined) {
      const limit = patch.turnTimeLimitSec;
      if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0 || limit > TURN_TIME_LIMIT_MAX_SEC) {
        return roomFailure(
          'INVALID_ROOM_ACTION',
          `turnTimeLimitSec must be an integer within 0-${TURN_TIME_LIMIT_MAX_SEC} (0 disables the limit).`,
        );
      }
      room.turnTimeLimitSec = limit;
    }

    // 可被公开房间列表发现（#108）：只认布尔值。
    // 沿用本方法的既有门禁（仅房主、仅大厅），没有为它单开一条「对局中也能改」的通道：
    // 一旦公开，房间从大厅到对局期间都留在列表里（对局中的房主正是「可被旁观」的那类），
    // 想收回只能等这一局结束——这比让列表里出现「刚还在、点进去却不存在」的房间更可预期。
    if (patch.isPublic !== undefined) {
      if (typeof patch.isPublic !== 'boolean') {
        return roomFailure('INVALID_ROOM_ACTION', 'isPublic must be a boolean.');
      }
      room.isPublic = patch.isPublic;
    }

    // 先把设置本身落盘，再产出广播事件：这样即便广播失败，重启后读到的也是最新设置。
    this.#persistRoom(room);
    const settings = projectRoomSettings(room);
    return {
      ok: true,
      value: settings,
      events: [
        { type: 'room_settings', roomCode: room.code, settings },
        { type: 'undo_available', roomCode: room.code, playerId: this.#undoAvailability(room) },
      ],
    };
  }

  /** 单播用：把当前房间设置投影成对外的形状（加入 / 重连 / 建房时各发一次）。 */
  getRoomSettings(roomCode: string): RoomSettings | null {
    const room = this.#rooms.get(roomCode);
    return room === undefined ? null : projectRoomSettings(room);
  }

  // ───────────────────────── 公开房间列表（#108） ─────────────────────────

  /**
   * 公开房间列表：只列**房主显式公开**且**尚未结束**的房间。
   *
   * 三条刻意为之的取舍：
   *  1. `isPublic` 是唯一准入条件——房间码本身仍可加入，列表只是「多一条发现途径」，
   *     不是把房间可见性改成「只能从列表进」。
   *  2. 已结束的房间不进列表（`status === 'ended'`）：那种房间连 `room:join` 都会被拒，
   *     列出来只会让人点进去吃一个错误。
   *  3. 排序**稳定且有意**：先「还能以玩家加入的大厅」，再「可旁观的对局」，最后其余。
   *     列表是用来「找一局能玩的」的，把点不进去的排在前面等于制造挫败感。
   *
   * 返回的是摘要：不含成员 id 名单、观战者 id、托管状态等只在房间里才该拿到的信息。
   */
  listPublicRooms(): PublicRoomSummary[] {
    const summaries: PublicRoomSummary[] = [];
    for (const room of this.#rooms.values()) {
      if (!room.isPublic || room.status === 'ended') continue;
      const playerCount = room.players.length;
      const spectatorCount = room.spectators.length;
      summaries.push({
        roomCode: room.code,
        hostNickname: room.players.find((player) => player.id === room.hostId)?.nickname ?? '房主',
        mapTitle: room.mapTitle,
        status: room.status,
        playerCount,
        spectatorCount,
        playerLimit: MAX_PLAYERS,
        spectatorLimit: MAX_SPECTATORS,
        joinable: room.status === 'lobby' && playerCount < MAX_PLAYERS,
        spectatable: spectatorCount < MAX_SPECTATORS,
        turnTimeLimitSec: room.turnTimeLimitSec,
        botDifficulty: room.botDifficulty,
      });
    }
    return summaries.sort(compareRoomSummaries);
  }

  // ───────────────────────── 联机最小悔棋（#101） ─────────────────────────

  /**
   * 此刻「谁可以发起悔棋」（单播 / 广播用）；没人可悔时返回 `null`。
   *
   * 判据（任一不满足即没人可悔）：房间开了悔棋、正在对局、没有未清债务、
   * 存在一个「真人刚手动走完」的可悔点、且这名真人还在房间里。
   *
   * 刻意**不**在这里检查「是否有在场对手可确认」：那是发起时的前置条件（见 `requestUndo`），
   * 放进这里就得在对手上下线的每个时刻重新广播可悔权，成本远大于收益——
   * 对手恰好不在线时，发起者点一下就会收到「没有对手可以确认」的明确提示。
   */
  getUndoAvailability(roomCode: string): string | null {
    const room = this.#rooms.get(roomCode);
    return room === undefined ? null : this.#undoAvailability(room);
  }

  /**
   * 发起悔棋（#101）。**只有上一手行动者本人**能发起——悔棋的语义就是「我刚走错了想退回来」，
   * 替别人的棋悔没有意义，也正是「不能单方面回退」的第一层约束。
   *
   * 三条前置（任一不满足即拒）：
   *  - 房主开了悔棋（`minimalUndoEnabled`）；
   *  - 当前无未清债务（债务态下状态机停在半路，回退会造出一个引擎不认的局面）；
   *  - 至少有一名「在场人类对手」——这是「需对手确认」的物理前提，没有确认方就无从确认。
   *
   * 创建后广播 `undo_request`，等对手逐一投票；20 秒内没集齐全部同意即视为拒绝。
   */
  requestUndo(roomCode: string, requesterId: string): RoomResult<UndoRequestInfo> {
    const room = this.#rooms.get(roomCode);
    if (room === undefined) {
      return roomFailure('ROOM_NOT_FOUND', '房间不存在或已关闭。');
    }
    if (!room.minimalUndoEnabled) {
      return roomFailure('UNDO_DISABLED', '本房间未开启悔棋。');
    }
    if (this.#undoAvailability(room) !== requesterId) {
      return roomFailure('UNDO_UNAVAILABLE', '当前没有你可以悔的一步。');
    }
    if (this.#undoRequests.has(roomCode)) {
      return roomFailure('UNDO_PENDING', '已经有一个悔棋请求在处理中。');
    }

    const point = this.#undoPoints.get(roomCode);
    const requester = room.players.find((player) => player.id === requesterId);
    if (point === undefined || requester === undefined) {
      return roomFailure('UNDO_UNAVAILABLE', '当前没有你可以悔的一步。');
    }
    const voterIds = this.#undoVoters(room, requesterId);
    if (voterIds.length === 0) {
      return roomFailure('UNDO_UNAVAILABLE', '现在没有在线对手可以确认这次悔棋。');
    }

    const pending: PendingUndo = {
      requestId: this.#dependencies.generateToken(),
      requesterId,
      requesterNickname: requester.nickname,
      voterIds,
      approvals: new Set(),
      point,
    };
    this.#undoRequests.set(roomCode, pending);
    this.#undoTimers.set(roomCode, this.#dependencies.setTimer(() => {
      this.#undoTimers.delete(roomCode);
      this.#dependencies.onAsyncEvents(this.#settleUndo(roomCode, 'expired'));
    }, UNDO_REQUEST_TTL_MS));

    return {
      ok: true,
      value: this.#undoRequestInfo(pending),
      events: [{ type: 'undo_request', roomCode, request: this.#undoRequestInfo(pending) }],
    };
  }

  /**
   * 对手对悔棋请求表决（#101）：**全部同意**才真正回退一步，任一人拒绝立刻作废。
   *
   * 只有请求创建时快照下来的 `voterIds` 能投票——发起之后才掉线/出局的人不再被要求表态，
   * 发起之后才上线的人也不追溯（否则请求会随着成员进出永远集不齐票）。
   * 重复同意是幂等的（不重复广播），因为网络重发不该让一次请求被算成两票。
   */
  voteUndo(roomCode: string, voterId: string, requestId: string, approve: boolean): GameActionResult<Record<string, never>> {
    const pending = this.#undoRequests.get(roomCode);
    if (pending === undefined || pending.requestId !== requestId) {
      return roomFailure('UNDO_UNAVAILABLE', '这个悔棋请求已经结束了。');
    }
    if (!pending.voterIds.includes(voterId)) {
      return roomFailure('UNDO_UNAVAILABLE', '你不需要对这一手悔棋表态。');
    }
    if (pending.approvals.has(voterId)) {
      return { ok: true, value: {}, events: [] };
    }
    if (!approve) {
      return { ok: true, value: {}, events: this.#settleUndo(roomCode, 'rejected') };
    }

    pending.approvals.add(voterId);
    if (pending.approvals.size < pending.voterIds.length) {
      // 还有人没表态：把最新进度广播出去（发起者能看到「1/2 已确认」），继续等。
      return { ok: true, value: {}, events: [{ type: 'undo_request', roomCode, request: this.#undoRequestInfo(pending) }] };
    }
    return { ok: true, value: {}, events: this.#settleUndo(roomCode, 'applied') };
  }

  /** 发起者撤回自己尚未有结果的悔棋请求（#101）。 */
  cancelUndo(roomCode: string, requesterId: string): GameActionResult<Record<string, never>> {
    const pending = this.#undoRequests.get(roomCode);
    if (pending === undefined) {
      return roomFailure('UNDO_UNAVAILABLE', '没有正在处理中的悔棋请求。');
    }
    if (pending.requesterId !== requesterId) {
      return roomFailure('UNDO_UNAVAILABLE', '只有发起者可以撤回悔棋请求。');
    }
    return { ok: true, value: {}, events: this.#settleUndo(roomCode, 'cancelled') };
  }

  /**
   * 结束一个悔棋请求并给出结果（#101）。四个终态共用这一条出口：
   *  - `applied`：真的把状态退回去，并重建自动化；
   *  - 其余三个：只是收尾（清计时器 + 清记录 + 广播结果），不动对局。
   *
   * `applied` 的事件顺序刻意是 **先 `undo_result` 再 `game_snapshot`**：客户端收到
   * 「已回退」之后再把快照当**硬重置**处理（时间线倒退不能用增量动画播），顺序反了就播歪。
   */
  #settleUndo(roomCode: string, outcome: UndoOutcome): RoomDomainEvent[] {
    const pending = this.#undoRequests.get(roomCode);
    if (pending === undefined) {
      return [];
    }
    this.#cancelUndoTimer(roomCode);
    this.#undoRequests.delete(roomCode);

    const room = this.#rooms.get(roomCode);
    const events: RoomDomainEvent[] = [
      { type: 'undo_result', roomCode, result: { requestId: pending.requestId, outcome } },
    ];
    if (outcome !== 'applied' || room === undefined) {
      return events;
    }

    room.gameState = pending.point.state;
    // 只退一步：退完就清掉可悔点，避免退成一条可以无限往回走的时间线。
    this.#undoPoints.delete(roomCode);

    // 回退后行动者可能变了（甚至回到某个玩家的回合）：先清空一切自动化再按新状态重建。
    // 少这一步就会留下一个指向「旧行动者」的计时器 —— 那正是线上「静默冻结」的成因。
    const clearEvent = this.#clearAutomation(roomCode);
    if (clearEvent !== null) events.push(clearEvent);

    const state = room.gameState;
    if (state.phase === 'game_over') {
      room.status = 'ended';
    } else {
      const actorId = this.#engineActor(state);
      this.#startBotIfActorIsBot(room, state, actorId);
      events.push(...this.#maybeAutoTakeover(room, state, actorId));
    }

    this.#persistRoom(room);
    events.push({ type: 'game_snapshot', roomCode, state });
    events.push({ type: 'undo_available', roomCode, playerId: this.#undoAvailability(room) });
    return events;
  }

  /** 可悔权判据（见 `getUndoAvailability` 的说明）。 */
  #undoAvailability(room: Room): string | null {
    if (!room.minimalUndoEnabled) return null;
    if (room.status !== 'playing' || room.gameState === null) return null;
    if (room.gameState.phase === 'game_over' || room.gameState.debt !== null) return null;
    const point = this.#undoPoints.get(room.code);
    if (point === undefined) return null;
    const actor = room.players.find((player) => player.id === point.actorId);
    if (actor === undefined || actor.isBot) return null;
    // 已破产的人不能悔棋：他的那一步已经结算完毕（房产释放、现金归零），
    // 退回去等于凭空复活一个已经出局的玩家。
    const seat = room.gameState.players.find((player) => player.id === point.actorId);
    return seat === undefined || seat.bankrupt ? null : actor.id;
  }

  /** 「在场人类对手」：确认悔棋的人。电脑与离线真人都不算——它们无法表态。 */
  #undoVoters(room: Room, requesterId: string): string[] {
    const state = room.gameState;
    return room.players
      .filter((player) => !player.isBot && player.online && player.id !== requesterId)
      .filter((player) => {
        const seat = state?.players.find((candidate) => candidate.id === player.id);
        return seat !== undefined && !seat.bankrupt;
      })
      .map((player) => player.id);
  }

  #undoRequestInfo(pending: PendingUndo): UndoRequestInfo {
    return {
      requestId: pending.requestId,
      requesterId: pending.requesterId,
      requesterNickname: pending.requesterNickname,
      voterIds: [...pending.voterIds],
      approvals: [...pending.approvals],
      expiresAt: Date.now() + UNDO_REQUEST_TTL_MS,
    };
  }

  #cancelUndoTimer(roomCode: string): void {
    const handle = this.#undoTimers.get(roomCode);
    if (handle === undefined) return;
    this.#dependencies.clearTimer(handle);
    this.#undoTimers.delete(roomCode);
  }

  /** 房间层面的悔棋收尾（房间解散 / 服务端销毁时调用）。 */
  #forgetUndo(roomCode: string): void {
    this.#cancelUndoTimer(roomCode);
    this.#undoRequests.delete(roomCode);
    this.#undoPoints.delete(roomCode);
  }

  // ───────────────────────── 每回合限时（#107） ─────────────────────────

  /** 单播用：把「此刻谁的钟在走」投影成对外的形状（进入房间时发一次，之后靠广播同步）。 */
  getTurnDeadline(roomCode: string): TurnDeadlineInfo | null {
    const room = this.#rooms.get(roomCode);
    return room === undefined ? null : this.#turnDeadlineInfo(room);
  }

  #turnDeadlineInfo(room: Room): TurnDeadlineInfo {
    const pending = this.#turnDeadlines.get(room.code);
    return {
      playerId: pending?.playerId ?? null,
      deadlineAt: pending?.deadlineAt ?? null,
      limitSec: room.turnTimeLimitSec,
    };
  }

  /** 取消回合钟；返回「原本确实有钟在走」（用于决定要不要为此多播一条 `turn_deadline`）。 */
  #cancelTurnTimer(roomCode: string): boolean {
    const handle = this.#turnTimers.get(roomCode);
    const had = handle !== undefined || this.#turnDeadlines.has(roomCode);
    if (handle !== undefined) {
      this.#dependencies.clearTimer(handle);
      this.#turnTimers.delete(roomCode);
    }
    this.#turnDeadlines.delete(roomCode);
    return had;
  }

  /**
   * 重排回合钟（#107）。**每个可能改变「当前行动者」的时刻都要调它**：
   * 开局、每次状态推进、有人掉线、有人重连、重启恢复。返回一条待广播的 `turn_deadline`
   * （没有钟在走、且原本也没有钟时返回 `null`，这样不限时的房间一个字节都不多发）。
   *
   * 只给「在线真人」计时，另外两类行动者各自已有推进机制，绝不能再叠一层：
   *  - 电脑玩家 → `#automation`（bot 模式）会立刻排一步；
   *  - 离线真人 → `#maybeAutoTakeover` 的 15s 宽限 + `offline_takeover`。
   * 若在这里也排钟，两套计时器会互相顶替：限时一到就把正在托管的局面夺过来重算一次。
   */
  #rescheduleTurnTimer(room: Room): RoomDomainEvent | null {
    const had = this.#cancelTurnTimer(room.code);
    const state = room.gameState;
    const inactive = room.status !== 'playing'
      || state === null
      || state.phase === 'game_over'
      || room.turnTimeLimitSec <= 0;
    if (inactive) {
      return had ? this.#turnDeadlineEvent(room) : null;
    }

    const actorId = this.#engineActor(state as GameState);
    const actor = (state as GameState).players.find((player) => player.id === actorId);
    if (actor === undefined || actor.isBot || !actor.online) {
      return had ? this.#turnDeadlineEvent(room) : null;
    }

    const turn = (state as GameState).turn;
    const limitMs = room.turnTimeLimitSec * 1000;
    const deadlineAt = Date.now() + limitMs;
    let handle: TTimerHandle;
    handle = this.#dependencies.setTimer(() => {
      if (this.#turnTimers.get(room.code) !== handle) return;
      this.#turnTimers.delete(room.code);
      this.#turnDeadlines.delete(room.code);
      // 已触发的钟要显式注销掉这个 handle：它此刻仍在依赖方的计时器表里，
      // 不注销就会留下一个「已经跑完、却仍被当成在走」的计时器（测试里表现为
      // 「同一档位有两根活跃钟」，真实实现里则是白占一个句柄）。
      this.#dependencies.clearTimer(handle);
      this.#runTurnTimeout(room.code, actorId, turn);
    }, limitMs);
    this.#turnTimers.set(room.code, handle);
    this.#turnDeadlines.set(room.code, { playerId: actorId, turn, deadlineAt });
    return this.#turnDeadlineEvent(room);
  }

  #turnDeadlineEvent(room: Room): RoomDomainEvent {
    return { type: 'turn_deadline', roomCode: room.code, info: this.#turnDeadlineInfo(room) };
  }

  /**
   * 回合钟到点（#107）：按电脑策略替这位**在线**玩家走一步。
   *
   * 三层核对缺一不可，任一不满足就直接放弃（而不是硬走一步）：
   *  1. 房间还在对局中、且没结束；
   *  2. 还是「同一个回合 + 同一个行动者」——悔棋回退会把 turn 调回去再推进，
   *     迟到的计时器绝不能把已经换人的回合再代走一步；
   *  3. 行动者仍是在线真人——中途他掉线了就该交给离线托管（那套有 15s 宽限），
   *     中途他操作了、回合已经推进过了由第 2 条拦住。
   *
   * 决策复用 `chooseTakeoverIntent`：它已经覆盖债务 / 交易 / 拍卖 / 规则模块待选动作四类
   * 特殊阶段，与离线托管同源，不会出现「限时把玩家卡在拍卖里」这种只有一条路径才会踩到的坑。
   */
  #runTurnTimeout(roomCode: string, actorId: string, turn: number): void {
    const room = this.#rooms.get(roomCode);
    if (room === undefined || room.status !== 'playing') return;
    const state = room.gameState;
    if (state === null || state.phase === 'game_over') return;
    if (state.turn !== turn) return;
    if (this.#engineActor(state) !== actorId) return;
    const actor = state.players.find((player) => player.id === actorId);
    if (actor === undefined || actor.isBot || !actor.online) return;

    let intent: Intent | null;
    try {
      intent = chooseTakeoverIntent(state, room.botDifficulty);
    } catch (error) {
      this.#dependencies.onServerError?.(`turn timeout choose intent threw in room ${roomCode}`, error);
      return;
    }
    // 与离线托管同样的理由：`chooseTakeoverIntent` 绝不能返回 null（null 会被当成
    // 「跳过这一回合」，玩家会永远停在世界巡游的机场格上）。留这道守卫只是防御性写法，
    // 真返回 null 时应重新排钟而不是把回合卡住。
    if (intent === null) {
      const retry = this.#rescheduleTurnTimer(room);
      this.#dependencies.onAsyncEvents(retry === null ? [] : [retry]);
      return;
    }

    const outcome = this.#commitTransition(room, actorId, intent, 'turn_timeout');
    if (!outcome.ok) {
      this.#dependencies.onServerError?.(`turn timeout commit failed in room ${roomCode}: ${outcome.code}`, outcome);
      // 提交失败（例如阶段已变）不永久停摆：重排一次钟，下一拍到点再试。
      const retry = this.#rescheduleTurnTimer(room);
      this.#dependencies.onAsyncEvents(retry === null ? [] : [retry]);
      return;
    }

    const notice: RoomDomainEvent = { type: 'turn_timeout', roomCode, playerId: actorId, nickname: actor.nickname };
    // 通报排在状态事件之前：客户端先弹「谁超时了」，再按增量播放这一步。
    this.#dependencies.onAsyncEvents([notice, ...outcome.events]);
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
      // 房规「放弃购买即拍卖」（#106）：写进 createGame，此后由状态里的 auctionOnDecline 驱动，
      // 中途改房间设置也不会影响这一局（避免「同一局两套规则」）。
      { auctionOnDecline: room.auctionOnDecline },
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
    const reconcileEvents = this.#reconcileAfterStart(room, state);
    this.#persistRoom(room);

    const publicRoom = this.#projectPublicRoom(room);
    return {
      ok: true,
      value: publicRoom,
      events: [
        { type: 'room_state', roomCode: room.code, room: publicRoom },
        { type: 'game_snapshot', roomCode: room.code, state },
        ...reconcileEvents,
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

    // 记下「这一步之前」的状态（#101）：悔棋就是把这份旧状态装回去。
    // 引擎状态不可变（`applyIntent` 返回新对象），所以这个引用天然是一份可靠快照，无需深拷贝。
    // 只有提交成功才留下可悔点——失败的意图没改变任何东西，凭空出现一个「可悔」按钮只会让人困惑。
    const before: UndoPoint = { state: room.gameState, actorId: playerId, turn: room.gameState.turn };
    const committed = this.#commitTransition(room, playerId, intent, 'manual');
    if (committed.ok) {
      this.#undoPoints.set(roomCode, before);
      // 只在这间房确实开了悔棋时才广播可悔权：否则每个房间的每一步都会多出一条
      // 恒为 null 的「没人可悔」，白白给全网所有对局加一路无用流量。
      if (room.minimalUndoEnabled) {
        committed.events.push({ type: 'undo_available', roomCode, playerId: this.#undoAvailability(room) });
      }
    }
    return committed;
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

    // 踢人结算走的是 'manual' 通道，但它并不是「玩家自己走的那一步」：
    // 必须连旧的可悔点一起作废，否则一次悔棋会把刚被踢出局的人原样复活。
    this.#undoPoints.delete(room.code);

    const committed = this.#commitTransition(room, targetPlayerId, { type: 'surrender' }, 'manual');
    if (!committed.ok) {
      // 引擎拒绝出局（如已被淘汰、或仅剩该玩家）：回退为旧语义「标记离线 + 自动托管」兜底。
      return this.#markPlayerOffline(room, playerIndex, true);
    }

    const publicRoom = this.#projectPublicRoom(room);
    return {
      ok: true,
      value: publicRoom,
      events: [
        ...committed.events,
        { type: 'room_state', roomCode: room.code, room: publicRoom },
        // 踢人也作废了可悔点：同步广播一次「现在没人可悔」，别让别人的面板留着旧的可悔权。
        ...(room.minimalUndoEnabled
          ? [{ type: 'undo_available' as const, roomCode: room.code, playerId: this.#undoAvailability(room) }]
          : []),
      ],
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
    // 重连后重新排钟（#107）：他掉线时那根钟已被停掉；人回来了就该重新开始计时，
    // 否则「掉线 → 重连」会变成免费获得无限思考时间的一条后门。
    const turnEvent = this.#rescheduleTurnTimer(room);
    if (turnEvent !== null) events.push(turnEvent);

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
    // 悔棋状态（#101）：先逐个清掉投票计时器，再丢掉两个 Map（迭代中删除要拷一份键）。
    for (const roomCode of [...this.#undoTimers.keys()]) {
      this.#cancelUndoTimer(roomCode);
    }
    this.#undoRequests.clear();
    this.#undoPoints.clear();
    // 回合限时（#107）：同样先逐个清计时器再清表，避免留下会去操作已销毁房间的回调。
    for (const roomCode of [...this.#turnTimers.keys()]) {
      this.#cancelTurnTimer(roomCode);
    }
    this.#turnTimers.clear();
    this.#turnDeadlines.clear();
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
      // 旧快照里没有这个字段（#101 之前写下的），缺省按「关闭」处理 —— 因此
      // ROOM_SNAPSHOT_SCHEMA_VERSION 不需要抬版本，进行中的对局不会因为这次改动被整间丢掉。
      minimalUndoEnabled: record.minimalUndoEnabled === true,
      // 同上（#106）：本字段引入之前的快照里没有它，缺省按「关闭」处理。
      auctionOnDecline: record.auctionOnDecline === true,
      // 同上（#107）：缺省按「不限时」处理（0）。负数 / NaN 这类畸形值一律归零，
      // 否则 `setTimer` 会收到一个负数延迟从而立刻触发，一重启就把所有人的回合代走一步。
      turnTimeLimitSec: normalizeTurnTimeLimit(record.turnTimeLimitSec),
      // 同上（#108）：缺省按「不公开」处理。用 `=== true` 而不是裸取值，
      // 于是任何非 true 的畸形值都退化成最保守的「不公开」。
      isPublic: record.isPublic === true,
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
      // 回合钟也一并重排（#107）：此刻所有真人都被标成离线，所以这一步实际只会「清掉钟」，
      // 真正的倒计时会等各自 `session:resume` 回来时才开始走（见 resumeRoom）。
      // 写在这里是为了让「重启后房间没有任何残留计时器」成为一条不变式。
      this.#rescheduleTurnTimer(room);
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
      // 悔棋开关也落盘（#101）：不写它，重启后房主开过的悔棋会悄悄变回关闭，
      // 而客户端在大厅里看到的仍是「已开启」的旧认知。
      minimalUndoEnabled: room.minimalUndoEnabled,
      // 房规「放弃购买即拍卖」也落盘（#106）：不写它，重启后房主开过的拍卖会悄悄变回关闭，
      // 于是「放弃购买」又回到「直接流拍」的旧语义，与客户端的认知对不上。
      auctionOnDecline: room.auctionOnDecline,
      // 回合限时也落盘（#107）：不写它，重启后房主设的限时会悄悄变回「不限时」，
      // 而客户端在大厅里看到的仍是「已开启」的旧认知。
      turnTimeLimitSec: room.turnTimeLimitSec,
      // 可被发现与否也落盘（#108）：不写它，重启后房主公开过的房间会从列表里消失，
      // 而对局本身仍在继续——「房间在跑但列表里找不到」是最难排查的一类不一致。
      isPublic: room.isPublic,
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
    // 房间解散：悔棋点 / 悬而未决的请求 / 投票计时器一并丢掉，
    // 不然那个 20 秒计时器到点后会去操作一个已经不存在的房间。
    this.#forgetUndo(roomCode);
    // 同理（#107）：回合钟也必须停，否则它到点时会去推进一个已解散的房间。
    this.#cancelTurnTimer(roomCode);
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
    // 掉线的若正是当前行动者，他这根回合钟必须停（#107）——人都不在了，还催他倒计时毫无意义，
    // 而且到点时代走一步会和 15s 后的离线托管撞在一起、把同一回合推进两次。
    const turnEvent = this.#rescheduleTurnTimer(room);

    this.#persistRoom(room);
    return {
      ok: true,
      value: this.#projectPublicRoom(room),
      events: [...events, ...autoEvents, ...(turnEvent === null ? [] : [turnEvent])],
    };
  }

  #engineActor(state: GameState): string {
    if (state.debt !== null) return state.debt.debtorId;
    // 议价阶段（#105 / #106）的合法行动者**不是** currentPlayerId：交易要由报价目标答复、
    // 拍卖要由轮到的叫价者出价。这里必须给出真实行动者，否则
    //  - 电脑玩家不会被排期 → 整局停在「等某人答复」；
    //  - 离线真人的 15s 宽限托管也不会被启动 → 静默冻结（本项目最熟悉的那类事故）。
    // 引擎侧同样的判断在 applyIntent 的 activePlayerId（两处必须同源，改一处就要改另一处）。
    const pendingTrade = currentPendingTrade(state);
    if (state.turnPhase === 'awaiting_trade_response' && pendingTrade !== null) return pendingTrade.targetId;
    const pendingAuction = currentPendingAuction(state);
    if (state.turnPhase === 'awaiting_auction_bid' && pendingAuction !== null) return pendingAuction.bidderId;
    return state.currentPlayerId;
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
    // 可悔点（#101）：电脑 / 离线托管推进的一步会作废上一步的可悔权——
    // 「可悔的永远是我自己刚走的那一步」，否则回退会把自动走的那步也一并抹掉，
    // 而玩家根本没「看见」过那一步。
    // （真人手动走棋的可悔点由 applyGameIntent 在提交成功后写入，因此 'manual' 不在此处清。）
    if (source !== 'manual') {
      this.#undoPoints.delete(room.code);
    }
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

    // 回合钟随状态一起重排（#107）：行动者可能换了人、回合可能推进了、对局可能结束了——
    // 三种情形都由 #rescheduleTurnTimer 自己识别（结束 / 轮到电脑时它会清掉钟并广播一次，
    // 让客户端把倒计时收起来）。放在 reconcile 之后：那一步可能刚给电脑排好自动化，
    // 这里才能正确地判定「现在是电脑在走、不该再叠一层限时」。
    const turnEvent = this.#rescheduleTurnTimer(room);
    if (turnEvent !== null) events.push(turnEvent);

    // 电脑 / 离线托管推进的一步会作废上一步的可悔权，这里把「现在没人可悔」显式广播出去。
    // 少了这一条，客户端会一直挂着一个「发起悔棋」按钮，直到玩家点下去被服务端拒绝才知道过期。
    if (room.minimalUndoEnabled && source !== 'manual') {
      events.push({ type: 'undo_available', roomCode: room.code, playerId: this.#undoAvailability(room) });
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
      // 债务清偿期间同样保持托管：这份债属于当前行动者时（或此刻无债），记录原样续期，
      // 而不是每清偿一步就清空重来——重来意味着重新等一轮 15s 宽限。
      const debtIsActors = state.debt === null || state.debt.debtorId === actorId;
      const keep = debtIsActors && record.playerId === actorId && record.startedTurn === state.turn;
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

  #reconcileAfterStart(room: Room, state: GameState): RoomDomainEvent[] {
    this.#startBotIfActorIsBot(room, state, this.#engineActor(state));
    // 开局就排上第一个回合钟（#107）：若开局行动者是真人，这就是本局的第一根倒计时；
    // 是电脑则返回「此刻不限时」，客户端不会画进度条。
    const turnEvent = this.#rescheduleTurnTimer(room);
    return turnEvent === null ? [] : [turnEvent];
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
    // 债务阶段不再一律拒托管。`#engineActor` 在欠债时返回的就是债务人本人，所以
    // 「此刻的行动者离线」恰好等价于「这笔债没人来还」。旧行为（debt !== null 直接返回）
    // 会让离线欠债玩家永久停摆：没有电脑排期、也没有托管宽限，房间进入
    // 「零活跃计时器、零服务端错误」的静默冻结（整局冒烟可复现：电脑在拍卖里把现金花光后欠租）。
    // 清偿本身由 chooseTakeoverIntent 的债务分支交给 bot 策略完成。
    if (this.#automation.has(room.code) || this.#gameAutomationTimers.has(room.code)) return [];
    if (this.#autoTakeoverGrace.has(room.code)) return [];
    // 宽限期内不立即托管：给掉线玩家重连机会，避免短暂网络抖动即被托管替玩家走完一回合。
    // 宽限结束且玩家仍未在线、未破产、无未清债务，才真正起离线托管。
    const GRACE_MS = 15_000;
    const timer = this.#dependencies.setTimer(() => {
      this.#autoTakeoverGrace.delete(room.code);
      if (room.status !== 'playing' || room.gameState === null) return;
      const current = room.gameState.players.find((candidate) => candidate.id === actorId);
      if (current === undefined || current.online || current.bankrupt) return;
      // 宽限期间可能出现了别人的债（真人重连后行动过）：只有「这份债就是他的」才代为清偿。
      const debt = room.gameState.debt;
      if (debt !== null && debt.debtorId !== actorId) return;
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
    // 离线托管允许「带着债务」继续：`#engineActor` 保证此时 actorId 就是债务人本人，
    // 而清偿是一连串步骤（卖房 → 抵押 → 卖地 → 宣告破产）。若在这里要求 debt === null，
    // 托管会在第一步之后就把自己判为失效，反复清空重建、每步都退回 15s 宽限。
    // 是否「该由他清偿」由 stillCurrent 里的 record.playerId === actorId 把关。
    return !actor.isBot;
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

/**
 * 把快照里的回合限时（#107）规整成一个可用的秒数；任何不可用值一律归零（= 不限时）。
 *
 * 快照文件落在磁盘上、可被外部改动，而 `turnTimeLimitSec` 会直接喂给 `setTimer`：
 * 负数或 `NaN` 会让计时器立刻触发，一重启就把当前行动者的这一步代走 —— 宁可当作没设。
 */
function normalizeTurnTimeLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return 0;
  return value >= 0 && value <= TURN_TIME_LIMIT_MAX_SEC ? value : 0;
}

/** 房间设置投影：拷一份出去，避免外部拿到内部可变引用（ruleConfig 是唯一可变嵌套对象）。 */function projectRoomSettings(room: Room): RoomSettings {
  return {
    botDifficulty: room.botDifficulty,
    ruleConfig: room.ruleConfig === null ? null : { ...room.ruleConfig },
    minimalUndoEnabled: room.minimalUndoEnabled,
    auctionOnDecline: room.auctionOnDecline,
    turnTimeLimitSec: room.turnTimeLimitSec,
    isPublic: room.isPublic,
  };
}

/**
 * 公开房间列表的排序（#108）：先能加入的大厅 → 可旁观的对局 → 其余，组内按房间码升序。
 *
 * 组内用房间码而不是「加入时间」：房间里没有创建时间戳，而房间码是 6 位数字，
 * 升序恰好接近「先开的排前面」。更重要的是它**确定性**——列表顺序每次刷新都一样，
 * 否则测试无法断言，用户也会觉得列表在乱跳。
 */
function compareRoomSummaries(a: PublicRoomSummary, b: PublicRoomSummary): number {
  const rank = (summary: PublicRoomSummary): number => {
    if (summary.joinable) return 0;
    if (summary.spectatable) return 1;
    return 2;
  };
  const byRank = rank(a) - rank(b);
  return byRank !== 0 ? byRank : a.roomCode.localeCompare(b.roomCode);
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
