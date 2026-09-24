import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { io as connectSocket, type Socket as ClientSocket } from 'socket.io-client';
import { createRoomServer } from '../server';
import type { Ack, ChatMessage, ClientToServerEvents, CreateRoomAck, JoinRoomAck, PublicRoomState, RoomSettings, RoomSettingsPatch, ServerToClientEvents } from '@richman/protocol';
import { CHAT_HISTORY_LIMIT } from '@richman/protocol';
import { RoomManager } from '../rooms/roomManager';
import type { CreateRoomRateLimit } from '../socket/roomSocketAdapter';
import type { RoomDomainEvent, RoomManagerDependencies } from '../rooms/roomTypes';
import { getActiveMapPack } from '@richman/board-data';
import type { BotDifficulty } from '@richman/engine';

type TimerHandle = {
  callback: () => void;
  delayMs: number;
  active: boolean;
};

type CreateRoomPayload = { nickname: string; mapId: string; requestId?: string; botDifficulty?: BotDifficulty };
type JoinRoomPayload = { roomCode: string; nickname: string; requestId?: string; role?: "player" | "spectator" };
type RemoveBotPayload = { playerId: string };
type RenameBotPayload = { playerId: string; nickname: string };
type ResumePayload = { roomCode: string; playerId: string; token: string };
type EmptyAckResponse = Ack<Record<string, never>>;
type CreateRoomResponse = Ack<CreateRoomAck>;
type JoinRoomResponse = Ack<JoinRoomAck>;
type ResumeResponse = Ack<{ room: PublicRoomState }>;
type PlayerConnectionChange = { playerId: string; online: boolean };
type RoomClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;
type RoomManagerFactory = (onAsyncEvents: (events: RoomDomainEvent[]) => void) => RoomManager<TimerHandle>;

type RunningRoomServer = {
  httpServer: HttpServer;
  roomManager: RoomManager<TimerHandle>;
  close(): Promise<void>;
};

type StartedTestServer = {
  url: string;
  server: RunningRoomServer;
};

type DeterministicManagerOptions = {
  roomNumbers?: number[];
  playerIds?: string[];
  tokens?: string[];
  serverErrors?: string[];
  timers?: TimerHandle[];
  /** 覆盖创建房间限流配置；默认（不传）走 `false`，即既有用例的「不限流」老行为。 */
  rateLimit?: CreateRoomRateLimit | false;
  /** 注入限流窗口用的时钟，避免为了跨过 60s 窗口去 mock 全局 Date.now。 */
  now?: () => number;
};

const clients: RoomClient[] = [];
const servers: RunningRoomServer[] = [];

const EVENT_TIMEOUT_MS = 200;
let generatedRequestId = 0;
const chinaMapPack = getActiveMapPack('china-tour');
const CHINA_MAP_SUMMARY = { ref: chinaMapPack.ref, title: chinaMapPack.metadata.title };

afterEach(async () => {
  const clientsToClose = clients.splice(0).reverse();
  for (const client of clientsToClose) {
    client.disconnect();
  }

  const serversToClose = servers.splice(0).reverse();
  for (const server of serversToClose) {
    await server.close();
    server.roomManager.dispose();
  }
});

describe('Socket.IO room create and join integration', () => {
  test('room:create acknowledges the host identity and public room without leaking the host token into room state', async () => {
    const { url } = await startTestServer();
    const host = await connectClient(url);

    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '  玩家一  ' });

    expectCreateRoomSuccess(create);
    const expectedRoom: PublicRoomState = { roomCode: '000007', status: 'lobby', hostId: 'player-host', players: [
      {
        id: 'player-host',
        nickname: '玩家一',
        isBot: false,
        online: true,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(create).toEqual({
      ok: true,
      roomCode: '000007',
      playerId: 'player-host',
      token: 'token-host',
      room: expectedRoom,
    });
    expectPublicRoomHasNoToken(create.room, ['token-host']);
  });

  test('room:create without an acknowledgement callback does not create a room or disconnect the client', async () => {
    const serverErrors: string[] = [];
    const { url } = await startTestServer({
      roomNumbers: [7, 8],
      playerIds: ['player-host', 'player-after-no-ack'],
      tokens: ['token-host', 'token-after-no-ack'],
      serverErrors,
    });
    const host = await connectClient(url);
    const clientIssues = watchClientIssues(host);

    emitCreateWithoutAck(host, { mapId: 'china-tour', nickname: '玩家一' });
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '玩家一' });

    expectCreateRoomSuccess(create);
    expect(create).toEqual({
      ok: true,
      roomCode: '000007',
      playerId: 'player-host',
      token: 'token-host',
      room: { roomCode: '000007', status: 'lobby', hostId: 'player-host', players: [
        {
          id: 'player-host',
          nickname: '玩家一',
          isBot: false,
          online: true,
        },
      ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY },
    });
    expect(host.connected).toBe(true);
    expect(clientIssues.disconnects).toEqual([]);
    expect(clientIssues.errors).toEqual([]);
    expect(serverErrors).toEqual([]);
  });

  test('room:join acknowledges the joiner and broadcasts the same authoritative room state to host and joiner', async () => {
    const { url } = await startTestServer();
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '玩家一' });
    expectCreateRoomSuccess(create);
    const guest = await connectClient(url);
    const hostRoomState = nextRoomState(host);
    const guestRoomState = nextRoomState(guest);

    const join = await emitAck(guest, 'room:join', {
      roomCode: create.roomCode,
      nickname: '玩家二',
    });

    expectJoinRoomSuccess(join);
    const expectedRoom: PublicRoomState = { roomCode: '000007', status: 'lobby', hostId: 'player-host', players: [
      {
        id: 'player-host',
        nickname: '玩家一',
        isBot: false,
        online: true,
      },
      {
        id: 'player-guest',
        nickname: '玩家二',
        isBot: false,
        online: true,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(join).toEqual({
      ok: true,
      playerId: 'player-guest',
      token: 'token-guest',
      room: expectedRoom,
    });
    const [hostState, guestState] = await Promise.all([hostRoomState, guestRoomState]);
    expect(hostState).toEqual(expectedRoom);
    expect(guestState).toEqual(expectedRoom);
    expectPublicRoomHasNoToken(join.room, ['token-host', 'token-guest']);
    expectPublicRoomHasNoToken(hostState, ['token-host', 'token-guest']);
    expectPublicRoomHasNoToken(guestState, ['token-host', 'token-guest']);
  });

  test('room:create from an already-bound host socket removes the old host from its lobby before rebinding', async () => {
    const { url } = await startTestServer({
      roomNumbers: [7, 8],
      playerIds: ['player-host', 'player-guest', 'player-new-host'],
      tokens: ['token-host', 'token-guest', 'token-new-host'],
    });
    const host = await connectClient(url);
    const createA = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(createA);
    const guest = await connectClient(url);
    const hostJoinState = nextRoomStateWithin(host, 'host initial room A join room_state');
    const guestJoinState = nextRoomStateWithin(guest, 'guest initial room A join room_state');
    const join = await emitAck(guest, 'room:join', {
      roomCode: createA.roomCode,
      nickname: '玩家二',
    });
    expectJoinRoomSuccess(join);
    const roomAWithHostAndGuest: PublicRoomState = { roomCode: '000007', status: 'lobby', hostId: 'player-host', players: [
      { id: 'player-host', nickname: '房主', isBot: false, online: true },
      { id: 'player-guest', nickname: '玩家二', isBot: false, online: true },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(await hostJoinState).toEqual(roomAWithHostAndGuest);
    expect(await guestJoinState).toEqual(roomAWithHostAndGuest);

    const guestRoomAAfterRebind = nextRoomStateWithin(guest, 'guest room A after host creates room B');
    const createB = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '新房主' });

    expectCreateRoomSuccess(createB);
    const roomB: PublicRoomState = { roomCode: '000008', status: 'lobby', hostId: 'player-new-host', players: [{ id: 'player-new-host', nickname: '新房主', isBot: false, online: true }], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(createB).toEqual({
      ok: true,
      roomCode: '000008',
      playerId: 'player-new-host',
      token: 'token-new-host',
      room: roomB,
    });
    const roomAAfterRebind: PublicRoomState = { roomCode: '000007', status: 'lobby', hostId: 'player-guest', players: [{ id: 'player-guest', nickname: '玩家二', isBot: false, online: true }], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(await guestRoomAAfterRebind).toEqual(roomAAfterRebind);
    expectPublicRoomHasNoToken(roomAAfterRebind, [createA.token, join.token, createB.token]);
    expectPublicRoomHasNoToken(createB.room, [createA.token, join.token, createB.token]);
  });

  test('room:join without an acknowledgement callback does not add a player before the next acknowledged join', async () => {
    const serverErrors: string[] = [];
    const { url } = await startTestServer({
      playerIds: ['player-host', 'player-guest', 'player-third'],
      tokens: ['token-host', 'token-guest', 'token-third'],
      serverErrors,
    });
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '玩家一' });
    expectCreateRoomSuccess(create);
    const guest = await connectClient(url);
    const clientIssues = watchClientIssues(guest);
    const hostRoomState = nextRoomState(host);
    const guestRoomState = nextRoomState(guest);

    emitJoinWithoutAck(guest, {
      roomCode: create.roomCode,
      nickname: '玩家二',
    });
    const join = await emitAck(guest, 'room:join', {
      roomCode: create.roomCode,
      nickname: '玩家二',
    });

    expectJoinRoomSuccess(join);
    const expectedRoom: PublicRoomState = { roomCode: '000007', status: 'lobby', hostId: 'player-host', players: [
      {
        id: 'player-host',
        nickname: '玩家一',
        isBot: false,
        online: true,
      },
      {
        id: 'player-guest',
        nickname: '玩家二',
        isBot: false,
        online: true,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(join).toEqual({
      ok: true,
      playerId: 'player-guest',
      token: 'token-guest',
      room: expectedRoom,
    });
    const [hostState, guestState] = await Promise.all([hostRoomState, guestRoomState]);
    expect(hostState).toEqual(expectedRoom);
    expect(guestState).toEqual(expectedRoom);
    expect(guest.connected).toBe(true);
    expect(clientIssues.disconnects).toEqual([]);
    expect(clientIssues.errors).toEqual([]);
    expect(serverErrors).toEqual([]);
  });

  test('room:join rejects a malformed payload with a safe failure ack and leaves the client connected', async () => {
    const { url } = await startTestServer();
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '玩家一' });
    expectCreateRoomSuccess(create);

    const failure = await emitMalformedJoinPayload(host, { nickname: '玩家二' });

    expectRoomFailure(failure, 'INVALID_ROOM_ACTION');
    expect(failure.message).not.toHaveLength(0);
    expect(failure.message).not.toContain('token-host');
    expect(JSON.stringify(failure)).not.toContain('token-host');
    expect(host.connected).toBe(true);
  });

  test('non-host room actions return NOT_HOST with safe failure messages', async () => {
    const { url } = await startTestServer({
      playerIds: ['player-host', 'player-guest', 'bot-a'],
      tokens: ['token-host', 'token-guest'],
    });
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(create);
    const guest = await connectClient(url);
    const join = await emitAck(guest, 'room:join', {
      roomCode: create.roomCode,
      nickname: '玩家二',
    });
    expectJoinRoomSuccess(join);

    const addFailure = await emitAddBot(guest);
    expectRoomFailure(addFailure, 'NOT_HOST', [create.token, join.token]);
    const startFailure = await emitStart(guest);
    expectRoomFailure(startFailure, 'NOT_HOST', [create.token, join.token]);

    const hostBotState = nextRoomStateWithin(host, 'host add bot broadcast');
    const guestBotState = nextRoomStateWithin(guest, 'guest add bot broadcast');
    const add = await emitAddBot(host);
    expectRoomActionSuccess(add);
    const roomWithBot: PublicRoomState = { roomCode: '000007', status: 'lobby', hostId: 'player-host', players: [
      { id: 'player-host', nickname: '房主', isBot: false, online: true },
      { id: 'player-guest', nickname: '玩家二', isBot: false, online: true },
      { id: 'bot-a', nickname: '电脑 A', isBot: true, online: true },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(await hostBotState).toEqual(roomWithBot);
    expect(await guestBotState).toEqual(roomWithBot);

    const removeFailure = await emitRemoveBot(guest, { playerId: 'bot-a' });
    expectRoomFailure(removeFailure, 'NOT_HOST', [create.token, join.token]);

    const renameFailure = await emitRenameBot(guest, { playerId: 'bot-a', nickname: '新电脑' });
    expectRoomFailure(renameFailure, 'NOT_HOST', [create.token, join.token]);
  });

  test('host add and remove bot acknowledge only ok and broadcast the updated room to every room socket', async () => {
    const { url } = await startTestServer({
      playerIds: ['player-host', 'player-guest', 'bot-a'],
      tokens: ['token-host', 'token-guest'],
    });
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(create);
    const guest = await connectClient(url);
    const join = await emitAck(guest, 'room:join', {
      roomCode: create.roomCode,
      nickname: '玩家二',
    });
    expectJoinRoomSuccess(join);
    const tokenValues = [create.token, join.token];

    // 用「匹配条件」而非「第一条」捕获：更早的 create/join 广播可能晚到，抢在 addBot 广播之前被读到。
    const hasBot = (room: PublicRoomState): boolean => room.players.length === 3;
    const hostAddedState = nextRoomStateMatchingWithin(host, 'host add bot room_state', hasBot);
    const guestAddedState = nextRoomStateMatchingWithin(guest, 'guest add bot room_state', hasBot);
    const add = await emitAddBot(host);

    expectRoomActionSuccess(add);
    const roomWithBot: PublicRoomState = { roomCode: '000007', status: 'lobby', hostId: 'player-host', players: [
      { id: 'player-host', nickname: '房主', isBot: false, online: true },
      { id: 'player-guest', nickname: '玩家二', isBot: false, online: true },
      { id: 'bot-a', nickname: '电脑 A', isBot: true, online: true },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(await hostAddedState).toEqual(roomWithBot);
    expect(await guestAddedState).toEqual(roomWithBot);
    expectPublicRoomHasNoToken(roomWithBot, tokenValues);

    const hostRemovedState = nextRoomStateWithin(host, 'host remove bot room_state');
    const guestRemovedState = nextRoomStateWithin(guest, 'guest remove bot room_state');
    const remove = await emitRemoveBot(host, { playerId: 'bot-a' });

    expectRoomActionSuccess(remove);
    const roomWithoutBot: PublicRoomState = { roomCode: '000007', status: 'lobby', hostId: 'player-host', players: [
      { id: 'player-host', nickname: '房主', isBot: false, online: true },
      { id: 'player-guest', nickname: '玩家二', isBot: false, online: true },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(await hostRemovedState).toEqual(roomWithoutBot);
    expect(await guestRemovedState).toEqual(roomWithoutBot);
    expectPublicRoomHasNoToken(roomWithoutBot, tokenValues);
  });


  test('host rename bot acknowledges only ok and broadcasts the renamed bot to every room socket', async () => {
    const { url } = await startTestServer({
      playerIds: ['player-host', 'player-guest', 'bot-a'],
      tokens: ['token-host', 'token-guest'],
    });
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(create);
    const guest = await connectClient(url);
    const join = await emitAck(guest, 'room:join', {
      roomCode: create.roomCode,
      nickname: '玩家二',
    });
    expectJoinRoomSuccess(join);
    expectRoomActionSuccess(await emitAddBot(host));
    const tokenValues = [create.token, join.token];

    // 同上：addBot 的广播可能晚到并被误当成「改名结果」，用改名后昵称精确命中。
    const renamed = (room: PublicRoomState): boolean =>
      room.players.some((player) => player.id === 'bot-a' && player.nickname === '电脑甲');
    const hostRenamedState = nextRoomStateMatchingWithin(host, 'host rename bot room_state', renamed);
    const guestRenamedState = nextRoomStateMatchingWithin(guest, 'guest rename bot room_state', renamed);
    const rename = await emitRenameBot(host, { playerId: 'bot-a', nickname: '  电脑甲  ' });

    expectRoomActionSuccess(rename);
    const roomWithRenamedBot: PublicRoomState = { roomCode: '000007', status: 'lobby', hostId: 'player-host', players: [
      { id: 'player-host', nickname: '房主', isBot: false, online: true },
      { id: 'player-guest', nickname: '玩家二', isBot: false, online: true },
      { id: 'bot-a', nickname: '电脑甲', isBot: true, online: true },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(await hostRenamedState).toEqual(roomWithRenamedBot);
    expect(await guestRenamedState).toEqual(roomWithRenamedBot);
    expectPublicRoomHasNoToken(roomWithRenamedBot, tokenValues);

    const humanRename = await emitRenameBot(host, { playerId: 'player-guest', nickname: '冒充' });
    expectRoomFailure(humanRename, 'INVALID_ROOM_ACTION', tokenValues);
    const blankRename = await emitRenameBot(host, { playerId: 'bot-a', nickname: '   ' });
    expectRoomFailure(blankRename, 'INVALID_NICKNAME', tokenValues);
    const duplicateRename = await emitRenameBot(host, { playerId: 'bot-a', nickname: '玩家二' });
    expectRoomFailure(duplicateRename, 'NICKNAME_TAKEN', tokenValues);

    expectRoomActionSuccess(await emitStart(host));
    const startedRename = await emitRenameBot(host, { playerId: 'bot-a', nickname: '晚改名' });
    expectRoomFailure(startedRename, 'GAME_ALREADY_STARTED', tokenValues);
  });

  test('host start acknowledges only ok and broadcasts exactly one playing room state', async () => {
    const { url } = await startTestServer();
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(create);
    const guest = await connectClient(url);
    const join = await emitAck(guest, 'room:join', {
      roomCode: create.roomCode,
      nickname: '玩家二',
    });
    expectJoinRoomSuccess(join);

    const hostPlayingState = nextRoomStateWithin(host, 'host playing room_state');
    const guestPlayingState = nextRoomStateWithin(guest, 'guest playing room_state');
    const start = await emitStart(host);

    expectRoomActionSuccess(start);
    const expectedRoom: PublicRoomState = { roomCode: '000007', status: 'playing', hostId: 'player-host', players: [
      { id: 'player-host', nickname: '房主', isBot: false, online: true },
      { id: 'player-guest', nickname: '玩家二', isBot: false, online: true },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(await hostPlayingState).toEqual(expectedRoom);
    expect(await guestPlayingState).toEqual(expectedRoom);
    await Promise.all([
      expectNoRoomState(host, 'duplicate host playing room_state'),
      expectNoRoomState(guest, 'duplicate guest playing room_state'),
    ]);
    expectPublicRoomHasNoToken(expectedRoom, [create.token, join.token]);
  });

  test('room:leave from an unbound socket always acknowledges ok without disconnecting the client', async () => {
    const { url } = await startTestServer();
    const client = await connectClient(url);
    const clientIssues = watchClientIssues(client);

    const leave = await emitLeave(client);

    expectRoomActionSuccess(leave);
    expect(client.connected).toBe(true);
    expect(clientIssues.disconnects).toEqual([]);
    expect(clientIssues.errors).toEqual([]);
  });

  test('bound lobby leave broadcasts removal, unbinds the socket from room broadcasts, and ignores its later disconnect', async () => {
    const { url } = await startTestServer({
      playerIds: ['player-host', 'player-guest', 'bot-a'],
      tokens: ['token-host', 'token-guest'],
    });
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(create);
    const guest = await connectClient(url);
    const join = await emitAck(guest, 'room:join', {
      roomCode: create.roomCode,
      nickname: '玩家二',
    });
    expectJoinRoomSuccess(join);

    const hostLeaveState = nextRoomStateWithin(host, 'host lobby leave room_state');
    const leave = await emitLeave(guest);

    expectRoomActionSuccess(leave);
    const roomAfterLeave: PublicRoomState = { roomCode: '000007', status: 'lobby', hostId: 'player-host', players: [{ id: 'player-host', nickname: '房主', isBot: false, online: true }], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(await hostLeaveState).toEqual(roomAfterLeave);

    const hostBotState = nextRoomStateWithin(host, 'host room_state after left socket unbound');
    const guestNoLongerInRoom = expectNoRoomState(guest, 'left socket should not receive future room_state');
    const add = await emitAddBot(host);
    expectRoomActionSuccess(add);
    const roomAfterBot: PublicRoomState = { roomCode: '000007', status: 'lobby', hostId: 'player-host', players: [
      { id: 'player-host', nickname: '房主', isBot: false, online: true },
      { id: 'bot-a', nickname: '电脑 A', isBot: true, online: true },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(await hostBotState).toEqual(roomAfterBot);
    await guestNoLongerInRoom;

    const noDuplicateDisconnect = expectNoPlayerConnection(host, 'left socket disconnect should not emit offline');
    guest.disconnect();
    await noDuplicateDisconnect;
  });

  test('lobby disconnect broadcasts offline state and resume restores the same player identity online', async () => {
    const timers: TimerHandle[] = [];
    const { url } = await startTestServer({
      playerIds: ['player-host', 'player-guest'],
      tokens: ['token-host', 'token-guest'],
      timers,
    });
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(create);
    const guest = await connectClient(url);
    const join = await emitAck(guest, 'room:join', {
      roomCode: create.roomCode,
      nickname: '玩家二',
    });
    expectJoinRoomSuccess(join);

    const hostOfflineConnection = nextPlayerConnection(host, 'guest disconnect player:connection');
    const hostOfflineState = nextRoomStateWithin(host, 'guest disconnect lobby room_state');
    guest.disconnect();

    expect(await hostOfflineConnection).toEqual({ playerId: 'player-guest', online: false });
    const offlineRoom: PublicRoomState = { roomCode: '000007', status: 'lobby', hostId: 'player-host', players: [
      { id: 'player-host', nickname: '房主', isBot: false, online: true },
      { id: 'player-guest', nickname: '玩家二', isBot: false, online: false },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(await hostOfflineState).toEqual(offlineRoom);
    expect(timers).toHaveLength(1);
    expect(timers[0]).toMatchObject({ delayMs: 300_000, active: true });

    const replacement = await connectClient(url);
    const hostOnlineConnection = nextPlayerConnection(host, 'guest resume player:connection');
    const hostOnlineState = nextRoomStateWithin(host, 'guest resume host room_state');
    const replacementOnlineState = nextRoomStateWithin(replacement, 'guest resume replacement room_state');
    const resume = await emitResume(replacement, {
      roomCode: create.roomCode,
      playerId: join.playerId,
      token: join.token,
    });

    const onlineRoom: PublicRoomState = { roomCode: '000007', status: 'lobby', hostId: 'player-host', players: [
      { id: 'player-host', nickname: '房主', isBot: false, online: true },
      { id: 'player-guest', nickname: '玩家二', isBot: false, online: true },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expectResumeSuccess(resume, onlineRoom, [create.token, join.token]);
    expect(await hostOnlineConnection).toEqual({ playerId: 'player-guest', online: true });
    expect(await hostOnlineState).toEqual(onlineRoom);
    expect(await replacementOnlineState).toEqual(onlineRoom);
    expect(timers[0].active).toBe(false);
  });

  test('resuming on a replacement socket removes the old socket from the room and ignores the old disconnect', async () => {
    const { url } = await startTestServer({
      playerIds: ['player-host', 'player-guest', 'bot-a'],
      tokens: ['token-host', 'token-guest'],
    });
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(create);
    const guest = await connectClient(url);
    const join = await emitAck(guest, 'room:join', {
      roomCode: create.roomCode,
      nickname: '玩家二',
    });
    expectJoinRoomSuccess(join);
    const replacement = await connectClient(url);

    const resume = await emitResume(replacement, {
      roomCode: create.roomCode,
      playerId: join.playerId,
      token: join.token,
    });

    const lobbyRoom: PublicRoomState = { roomCode: '000007', status: 'lobby', hostId: 'player-host', players: [
      { id: 'player-host', nickname: '房主', isBot: false, online: true },
      { id: 'player-guest', nickname: '玩家二', isBot: false, online: true },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expectResumeSuccess(resume, lobbyRoom, [create.token, join.token]);

    const hostBotState = nextRoomStateWithin(host, 'host room_state after replacement');
    const replacementBotState = nextRoomStateWithin(replacement, 'replacement room_state after replacement');
    const oldSocketNoState = expectNoRoomState(guest, 'old replaced socket should leave the room');
    const add = await emitAddBot(host);
    expectRoomActionSuccess(add);
    const roomWithBot: PublicRoomState = { roomCode: '000007', status: 'lobby', hostId: 'player-host', players: [
      { id: 'player-host', nickname: '房主', isBot: false, online: true },
      { id: 'player-guest', nickname: '玩家二', isBot: false, online: true },
      { id: 'bot-a', nickname: '电脑 A', isBot: true, online: true },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(await hostBotState).toEqual(roomWithBot);
    expect(await replacementBotState).toEqual(roomWithBot);
    await oldSocketNoState;

    const oldDisconnectIgnored = expectNoPlayerConnection(host, 'old replaced socket disconnect should not emit offline');
    guest.disconnect();
    await oldDisconnectIgnored;

    const hostLeaveState = nextRoomStateWithin(host, 'replacement leave room_state');
    const leave = await emitLeave(replacement);
    expectRoomActionSuccess(leave);
    const roomAfterLeave: PublicRoomState = { roomCode: '000007', status: 'lobby', hostId: 'player-host', players: [
      { id: 'player-host', nickname: '房主', isBot: false, online: true },
      { id: 'bot-a', nickname: '电脑 A', isBot: true, online: true },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(await hostLeaveState).toEqual(roomAfterLeave);
  });

  test('playing host disconnect emits the offline change and transfers host in a room_state broadcast', async () => {
    const { url } = await startTestServer();
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(create);
    const guest = await connectClient(url);
    const join = await emitAck(guest, 'room:join', {
      roomCode: create.roomCode,
      nickname: '玩家二',
    });
    expectJoinRoomSuccess(join);
    const start = await emitStart(host);
    expectRoomActionSuccess(start);

    const guestHostOffline = nextPlayerConnection(guest, 'playing host disconnect player:connection');
    // 开局本身也会向房间广播一次 room_state（房主仍在线、房主未转让），它与本次掉线广播是
    // 两个独立的数据包，谁先到达取决于事件循环调度。这里等的必须是「房主已转让」的那一条，
    // 否则偶发地会拿到开局那条旧状态（历史 flaky 根因）。
    const guestHostTransfer = nextRoomStateMatchingWithin(
      guest,
      'playing host transfer room_state',
      (room) => room.hostId === 'player-guest',
    );
    host.disconnect();

    expect(await guestHostOffline).toEqual({ playerId: 'player-host', online: false });
    const expectedRoom: PublicRoomState = { roomCode: '000007', status: 'playing', hostId: 'player-guest', players: [
      { id: 'player-host', nickname: '房主', isBot: false, online: false },
      { id: 'player-guest', nickname: '玩家二', isBot: false, online: true },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(await guestHostTransfer).toEqual(expectedRoom);
    expectPublicRoomHasNoToken(expectedRoom, [create.token, join.token]);
  });

  test('new room action failure acks carry safe messages and never leak stored tokens', async () => {
    const { url } = await startTestServer({
      playerIds: ['player-host', 'bot-a'],
      tokens: ['token-host'],
    });
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(create);

    const malformedRemove = await emitMalformedRoomAction(host, 'room:remove_bot', { player: 'bot-a' });
    expectRoomFailure(malformedRemove, 'INVALID_ROOM_ACTION', [create.token]);

    const malformedRename = await emitMalformedRoomAction(host, 'room:rename_bot', { playerId: 'bot-a' });
    expectRoomFailure(malformedRename, 'INVALID_ROOM_ACTION', [create.token]);

    const malformedResume = await emitMalformedRoomAction(host, 'session:resume', { roomCode: create.roomCode });
    expectRoomFailure(malformedResume, 'INVALID_ROOM_ACTION', [create.token]);

    const badTokenResume = await emitResume(host, {
      roomCode: create.roomCode,
      playerId: create.playerId,
      token: 'wrong-token',
    });
    expectRoomFailure(badTokenResume, 'INVALID_TOKEN', [create.token]);
  });

  test('new payload and no-payload room actions without acknowledgement callbacks do not mutate the room', async () => {
    const { url } = await startTestServer({
      playerIds: ['player-host', 'player-guest', 'bot-a', 'bot-b'],
      tokens: ['token-host', 'token-guest'],
    });
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(create);
    const guest = await connectClient(url);
    const join = await emitAck(guest, 'room:join', {
      roomCode: create.roomCode,
      nickname: '玩家二',
    });
    expectJoinRoomSuccess(join);
    expectRoomActionSuccess(await emitAddBot(host));
    expectRoomActionSuccess(await emitAddBot(host));

    emitRemoveBotWithoutAck(host, { playerId: 'bot-a' });
    const hostRemoveState = nextRoomStateWithin(host, 'acknowledged remove after no-ack remove');
    const remove = await emitRemoveBot(host, { playerId: 'bot-a' });
    expectRoomActionSuccess(remove);
    const roomAfterSingleRemove: PublicRoomState = { roomCode: '000007', status: 'lobby', hostId: 'player-host', players: [
      { id: 'player-host', nickname: '房主', isBot: false, online: true },
      { id: 'player-guest', nickname: '玩家二', isBot: false, online: true },
      { id: 'bot-b', nickname: '电脑 B', isBot: true, online: true },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(await hostRemoveState).toEqual(roomAfterSingleRemove);

    emitStartWithoutAck(host);
    const hostStartState = nextRoomStateWithin(host, 'acknowledged start after no-ack start');
    const start = await emitStart(host);
    expectRoomActionSuccess(start);
    const playingRoom: PublicRoomState = {
      ...roomAfterSingleRemove,
      status: 'playing',
    };
    expect(await hostStartState).toEqual(playingRoom);
    expectPublicRoomHasNoToken(playingRoom, [create.token, join.token]);
  });

  test('server close clears lobby disconnect timers scheduled while closing connected sockets and remains idempotent', async () => {
    const timers: TimerHandle[] = [];
    const { server, url } = await startTestServer({ timers });
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(create);
    expect(host.connected).toBe(true);

    await withEventTimeout(server.close(), 'server close with connected lobby socket');
    await withEventTimeout(server.close(), 'second server close after shutdown');
    untrackServer(server);

    expect(timers.filter((timer) => timer.active)).toEqual([]);
  });

  test('lobby disconnect timeout dispatches asynchronous room_state events through Socket.IO', async () => {
    const timers: TimerHandle[] = [];
    const { url } = await startTestServer({
      playerIds: ['player-host', 'player-guest'],
      tokens: ['token-host', 'token-guest'],
      timers,
    });
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(create);
    const guest = await connectClient(url);
    const join = await emitAck(guest, 'room:join', {
      roomCode: create.roomCode,
      nickname: '玩家二',
    });
    expectJoinRoomSuccess(join);

    const guestOfflineConnection = nextPlayerConnection(guest, 'host disconnect player:connection');
    const guestOfflineState = nextRoomStateWithin(guest, 'host disconnect lobby room_state');
    host.disconnect();
    expect(await guestOfflineConnection).toEqual({ playerId: 'player-host', online: false });
    const offlineRoom: PublicRoomState = { roomCode: '000007', status: 'lobby', hostId: 'player-host', players: [
      { id: 'player-host', nickname: '房主', isBot: false, online: false },
      { id: 'player-guest', nickname: '玩家二', isBot: false, online: true },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(await guestOfflineState).toEqual(offlineRoom);
    expect(timers).toHaveLength(1);
    expect(timers[0]).toMatchObject({ delayMs: 300_000, active: true });

    const guestTimeoutState = nextRoomStateWithin(guest, 'lobby timeout async room_state');
    timers[0].callback();

    const roomAfterTimeout: PublicRoomState = { roomCode: '000007', status: 'lobby', hostId: 'player-guest', players: [{ id: 'player-guest', nickname: '玩家二', isBot: false, online: true }], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(await guestTimeoutState).toEqual(roomAfterTimeout);
    expectPublicRoomHasNoToken(roomAfterTimeout, [create.token, join.token]);
  });
  test('room:create replays a committed request after its first ack is dropped and the socket is replaced', async () => {
    const { url } = await startTestServer({
      roomNumbers: [7, 8],
      playerIds: ['player-host', 'player-observer', 'unexpected-player'],
      tokens: ['host-token', 'observer-token', 'unexpected-token'],
    });
    const original = await connectClient(url);
    const payload = { nickname: '房主', mapId: 'china-tour', requestId: '00112233445566778899aabbccddeeff' };
    const committedState = nextRoomStateWithin(original, 'dropped create committed room state');

    emitAckAndIgnore(original, 'room:create', payload);
    expect((await committedState).players).toHaveLength(1);
    const observer = await connectClient(url);
    const observerJoin = await emitAck(observer, 'room:join', { roomCode: '000007', nickname: '观察者' });
    expectJoinRoomSuccess(observerJoin);

    const offline = nextPlayerConnection(observer, 'dropped create original disconnect');
    original.disconnect();
    expect(await offline).toEqual({ playerId: 'player-host', online: false });

    const online = nextPlayerConnection(observer, 'dropped create replacement reconnect');
    const replacement = await connectClient(url);
    const replay = await emitAck(replacement, 'room:create', payload);

    expectCreateRoomSuccess(replay);
    expect(replay).toMatchObject({ roomCode: '000007', playerId: 'player-host', token: 'host-token' });
    expect(await online).toEqual({ playerId: 'player-host', online: true });
    expect(replay.room.players).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'player-host', online: true })]),
    );
    expect(replay.room.players).toHaveLength(2);
    expectPublicRoomHasNoToken(replay.room, [replay.token, payload.requestId]);
  });

  test('room:join replays a committed request after its first ack is dropped and the socket is replaced', async () => {
    const { url, server } = await startTestServer({
      playerIds: ['player-host', 'player-guest', 'unexpected-player'],
      tokens: ['host-token', 'guest-token', 'unexpected-token'],
    });
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(create);
    const original = await connectClient(url);
    const payload = {
      roomCode: create.roomCode,
      nickname: '玩家二',
      requestId: 'ffeeddccbbaa99887766554433221100',
    };
    const committedState = nextRoomStateWithin(host, 'dropped join committed room state');

    emitAckAndIgnore(original, 'room:join', payload);
    expect((await committedState).players).toHaveLength(2);
    await emitStart(host);

    const offline = nextPlayerConnection(host, 'dropped join original disconnect');
    original.disconnect();
    expect(await offline).toEqual({ playerId: 'player-guest', online: false });

    const online = nextPlayerConnection(host, 'dropped join replacement reconnect');
    const replacement = await connectClient(url);
    const replay = await emitAck(replacement, 'room:join', payload);

    expectJoinRoomSuccess(replay);
    expect(replay).toMatchObject({ playerId: 'player-guest', token: 'guest-token' });
    expect(await online).toEqual({ playerId: 'player-guest', online: true });
    expect(replay.room).toMatchObject({ status: 'playing' });
    expect(replay.room.players).toHaveLength(2);
    expect(server.roomManager.getGameSnapshot(create.roomCode)?.players).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'player-guest', online: true })]),
    );
    expectPublicRoomHasNoToken(replay.room, [replay.token, payload.requestId]);
  });
  test('playing join replay broadcasts one current online room state after replacement', async () => {
    const { url } = await startTestServer({
      playerIds: ['player-host', 'player-guest'],
      tokens: ['host-token', 'guest-token'],
    });
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(create);
    const original = await connectClient(url);
    const payload = {
      roomCode: create.roomCode,
      nickname: '玩家二',
      requestId: 'ffeeddccbbaa99887766554433221100',
    };
    emitAckAndIgnore(original, 'room:join', payload);
    await nextRoomStateWithin(host, 'committed playing join room state');
    await emitStart(host);
    const offline = nextPlayerConnection(host, 'playing join original disconnect');
    original.disconnect();
    expect(await offline).toEqual({ playerId: 'player-guest', online: false });

    const peerStates = collectRoomStates(host);
    const online = nextPlayerConnection(host, 'playing join replacement reconnect');
    const replacement = await connectClient(url);
    const replacementStates = collectRoomStates(replacement);
    const replay = await emitAck(replacement, 'room:join', payload);

    expectJoinRoomSuccess(replay);
    expect(await online).toEqual({ playerId: 'player-guest', online: true });
    await Promise.resolve();
    const onlineRoom = expect.objectContaining({
      status: 'playing',
      players: expect.arrayContaining([expect.objectContaining({ id: 'player-guest', online: true })]),
    });
    expect(replay.room).toEqual(onlineRoom);
    expect(peerStates.states).toEqual([onlineRoom]);
    expect(replacementStates.states).toEqual([onlineRoom]);
    peerStates.stop();
    replacementStates.stop();
  });

  test('lobby create replay broadcasts one current online room state after replacement', async () => {
    const { url } = await startTestServer({
      playerIds: ['player-host', 'player-observer'],
      tokens: ['host-token', 'observer-token'],
    });
    const original = await connectClient(url);
    const payload = { nickname: '房主', mapId: 'china-tour', requestId: '00112233445566778899aabbccddeeff' };
    emitAckAndIgnore(original, 'room:create', payload);
    await nextRoomStateWithin(original, 'committed lobby create room state');
    const observer = await connectClient(url);
    expectJoinRoomSuccess(await emitAck(observer, 'room:join', { roomCode: '000007', nickname: '观察者' }));
    const offline = nextPlayerConnection(observer, 'lobby create original disconnect');
    original.disconnect();
    expect(await offline).toEqual({ playerId: 'player-host', online: false });

    const peerStates = collectRoomStates(observer);
    const online = nextPlayerConnection(observer, 'lobby create replacement reconnect');
    const replacement = await connectClient(url);
    const replacementStates = collectRoomStates(replacement);
    const replay = await emitAck(replacement, 'room:create', payload);

    expectCreateRoomSuccess(replay);
    expect(await online).toEqual({ playerId: 'player-host', online: true });
    await Promise.resolve();
    const onlineRoom = expect.objectContaining({
      status: 'lobby',
      players: expect.arrayContaining([expect.objectContaining({ id: 'player-host', online: true })]),
    });
    expect(replay.room).toEqual(onlineRoom);
    expect(peerStates.states).toEqual([onlineRoom]);
    expect(replacementStates.states).toEqual([onlineRoom]);
    peerStates.stop();
    replacementStates.stop();
  });

  test('accepts exact 32-character hex request IDs and rejects every other boundary', async () => {
    const { url } = await startTestServer();
    const client = await connectClient(url);

    for (const requestId of ['', 'abc', '0'.repeat(31), '0'.repeat(33), 'G'.repeat(32)]) {
      const response = await emitAck(client, 'room:create', { mapId: 'china-tour', nickname: '房主', requestId });
      expect(response).toMatchObject({ ok: false, code: 'INVALID_ROOM_ACTION' });
    }

    const uppercase = await emitAck(client, 'room:create', { mapId: 'china-tour', nickname: '房主', requestId: 'A'.repeat(32) });
    expect(uppercase).toMatchObject({ ok: true });
  });

});


describe('Socket.IO spectator join and authorization', () => {
  test('room:join without role is rejected even when the rest of the payload is valid', async () => {
    const { url } = await startTestServer();
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(create);

    const failure = await emitMalformedJoinPayload(host, {
      roomCode: create.roomCode,
      nickname: '观众',
      requestId: 'ffeeddccbbaa99887766554433221100',
    });

    expectRoomFailure(failure, 'INVALID_ROOM_ACTION');
    expect(create.room.spectators).toEqual([]);
    expect(host.connected).toBe(true);
  });

  test('a spectator can join a playing room and receives a public snapshot without seed or decks', async () => {
    const { url } = await startTestServer({
      playerIds: ['player-host', 'player-guest', 'player-spec'],
      tokens: ['token-host', 'token-guest', 'token-spec'],
    });
    const host = await connectClient(url);
    const guest = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(create);
    const join = await emitAck(guest, 'room:join', { roomCode: create.roomCode, nickname: '玩家二', role: 'player' });
    expectJoinRoomSuccess(join);
    const hostPlaying = nextRoomStateWithin(host, 'host playing room_state');
    expectRoomActionSuccess(await emitStart(host));
    await hostPlaying;

    const spectator = await connectClient(url);
    const joined = await emitAck(spectator, 'room:join', {
      roomCode: create.roomCode,
      nickname: '观众',
      role: 'spectator',
    });

    expectJoinRoomSuccess(joined);
    expect(joined.room.spectators).toEqual([{ id: 'player-spec', nickname: '观众', online: true }]);
    expect(joined.room.players).toHaveLength(2);
    expect(joined.snapshot).toBeDefined();
    const serialized = JSON.stringify(joined.snapshot);
    expect(serialized).not.toContain('"seed"');
    expect(serialized).not.toContain('"decks"');
    expect(serialized).not.toContain('token-spec');
    expect(joined.snapshot?.deckCounts.chance).toEqual(expect.any(Number));
  });

  test('spectators cannot mutate the lobby or submit game intents', async () => {
    const { url } = await startTestServer({
      playerIds: ['player-host', 'player-spec', 'bot-a'],
      tokens: ['token-host', 'token-spec'],
    });
    const host = await connectClient(url);
    const spectator = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(create);
    const joined = await emitAck(spectator, 'room:join', {
      roomCode: create.roomCode,
      nickname: '观众',
      role: 'spectator',
    });
    expectJoinRoomSuccess(joined);

    expectRoomFailure(await emitAddBot(spectator), 'NOT_HOST', [create.token, joined.token]);
    expectRoomFailure(await emitStart(spectator), 'NOT_HOST', [create.token, joined.token]);

    expectRoomActionSuccess(await emitAddBot(host));
    expectRoomActionSuccess(await emitStart(host));

    const intentAck = await new Promise<{ ok: boolean; code?: string }>((resolve) => {
      (spectator as unknown as { emit: Function }).emit('game:intent', { intent: { type: 'roll_dice' } }, resolve);
    });
    expect(intentAck).toMatchObject({ ok: false, code: 'INVALID_ROOM_ACTION' });
  });

  test('last player leaving a lobby closes the room and unbinds the spectator socket', async () => {
    const { url } = await startTestServer({
      playerIds: ['player-host', 'player-spec'],
      tokens: ['token-host', 'token-spec'],
    });
    const host = await connectClient(url);
    const spectator = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(create);
    const joined = await emitAck(spectator, 'room:join', {
      roomCode: create.roomCode,
      nickname: '观众',
      role: 'spectator',
    });
    expectJoinRoomSuccess(joined);

    const closed = withEventTimeout(
      new Promise<{ reason: string }>((resolve) => {
        spectator.once('room:closed', resolve);
      }),
      'spectator room:closed',
    );
    expectRoomActionSuccess(await emitLeave(host));
    expect(await closed).toEqual({ reason: 'empty_lobby' });
    expectRoomFailure(await emitAddBot(spectator), 'INVALID_ROOM_ACTION');
    expect(spectator.connected).toBe(true);
  });
});

describe('Socket.IO room chat broadcast and history', () => {
  test('room:chat_message broadcasts the trimmed message to every room socket and never leaks the token', async () => {
    const { url } = await startTestServer();
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '玩家一' });
    expectCreateRoomSuccess(create);
    const guest = await connectClient(url);
    const guestJoinState = nextRoomStateWithin(guest, 'guest lobby join room_state');
    const join = await emitAck(guest, 'room:join', { roomCode: create.roomCode, nickname: '玩家二' });
    expectJoinRoomSuccess(join);
    await guestJoinState;

    const hostBroadcast = nextChatBroadcast(host, 'host chat broadcast');
    const guestBroadcast = nextChatBroadcast(guest, 'guest chat broadcast');
    const ack = await emitChat(host, '  大家好  ');

    expectRoomActionSuccess(ack);
    const [hostMessage, guestMessage] = await Promise.all([hostBroadcast, guestBroadcast]);
    // 前后空白被 trim；发送者本人也在房间广播里收到自己的消息。
    expect(hostMessage).toMatchObject({
      playerId: 'player-host',
      nickname: '玩家一',
      text: '大家好',
      role: 'player',
    });
    expect(typeof hostMessage.ts).toBe('number');
    expect(guestMessage).toEqual(hostMessage);
    expectNoTokenField(hostMessage);
    expect(JSON.stringify(hostMessage)).not.toContain(create.token);
  });

  test('a member joining later receives the room chat history in the original order', async () => {
    const { url } = await startTestServer();
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(create);
    const guest = await connectClient(url);
    const guestJoinState = nextRoomStateWithin(guest, 'guest lobby join room_state');
    expectJoinRoomSuccess(await emitAck(guest, 'room:join', { roomCode: create.roomCode, nickname: '玩家二' }));
    await guestJoinState;

    const hostSeesOwnMessage = nextChatBroadcast(host, 'host chat broadcast');
    expectRoomActionSuccess(await emitChat(host, '甲'));
    await hostSeesOwnMessage;
    const guestSeesOwnMessage = nextChatBroadcast(guest, 'guest chat broadcast');
    expectRoomActionSuccess(await emitChat(guest, '乙'));
    await guestSeesOwnMessage;

    // 第三名成员进入后才拿到历史：应当恰好是「甲、乙」，且顺序与发送顺序一致。
    const latecomer = await connectClient(url);
    const historyPromise = nextChatHistory(latecomer, 'latecomer chat history');
    const latecomerJoinState = nextRoomStateWithin(latecomer, 'latecomer join room_state');
    expectJoinRoomSuccess(await emitAck(latecomer, 'room:join', { roomCode: create.roomCode, nickname: '玩家三' }));
    await latecomerJoinState;

    const history = await historyPromise;
    expect(history.messages.map((message) => message.text)).toEqual(['甲', '乙']);
    expect(history.messages.map((message) => message.nickname)).toEqual(['房主', '玩家二']);
  });

  test('session:resume replays the room chat history to the reconnecting player', async () => {
    const { url } = await startTestServer();
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(create);
    const guest = await connectClient(url);
    const guestJoinState = nextRoomStateWithin(guest, 'guest lobby join room_state');
    expectJoinRoomSuccess(await emitAck(guest, 'room:join', { roomCode: create.roomCode, nickname: '玩家二' }));
    await guestJoinState;

    const hostSeesOwnMessage = nextChatBroadcast(host, 'host chat broadcast');
    expectRoomActionSuccess(await emitChat(host, '重连前说的话'));
    await hostSeesOwnMessage;

    const hostOffline = nextPlayerConnection(guest, 'guest sees host offline');
    host.disconnect();
    await hostOffline;

    // 换一条连接重连：历史随 ack 之后单播回来，避免「刷新一下记录就空了」。
    const reconnected = await connectClient(url);
    const historyPromise = nextChatHistory(reconnected, 'reconnected chat history');
    const resume = await emitResume(reconnected, {
      roomCode: create.roomCode,
      playerId: 'player-host',
      token: create.token,
    });
    expect(resume.ok).toBe(true);

    const history = await historyPromise;
    expect(history.messages.map((message) => message.text)).toEqual(['重连前说的话']);
  });

  test('chat history is discarded when the room closes, so a reused room code starts empty', async () => {
    // 同一个房间号复用两次：房间关闭后历史必须被清掉，不能漏进新房间。
    // 见证人必须是「旁观者」：主动离开的那个 socket 在 room:closed 广播前已被解绑，收不到该事件。
    const { url } = await startTestServer({
      roomNumbers: [7, 7],
      playerIds: ['player-host', 'player-witness', 'player-new-host', 'player-guest'],
      tokens: ['token-host', 'token-witness', 'token-new-host', 'token-guest'],
    });
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(create);
    const witness = await connectClient(url);
    const witnessJoinState = nextRoomStateWithin(witness, 'witness spectator join room_state');
    expectJoinRoomSuccess(await emitAck(witness, 'room:join', {
      roomCode: create.roomCode,
      nickname: '见证人',
      role: 'spectator',
    }));
    await witnessJoinState;

    const hostSeesOwnMessage = nextChatBroadcast(host, 'host chat broadcast before closing');
    expectRoomActionSuccess(await emitChat(host, '旧房间的消息'));
    await hostSeesOwnMessage;

    const closed = nextRoomClosed(witness, 'witness sees room:closed');
    expectRoomActionSuccess(await emitLeave(host));
    expect(await closed).toEqual({ reason: 'empty_lobby' });

    const nextHost = await connectClient(url);
    const recreated = await emitAck(nextHost, 'room:create', { mapId: 'china-tour', nickname: '新房主' });
    expectCreateRoomSuccess(recreated);
    expect(recreated.roomCode).toBe(create.roomCode);

    const guest = await connectClient(url);
    const noHistory = expectNoChatHistory(guest, 'chat history from the closed room');
    const guestJoinState = nextRoomStateWithin(guest, 'guest join room_state');
    expectJoinRoomSuccess(await emitAck(guest, 'room:join', { roomCode: recreated.roomCode, nickname: '玩家二' }));
    await guestJoinState;

    await noHistory;
  });

  test('room:chat_message drops messages sent faster than the minimum interval while still acking ok', async () => {
    const { url } = await startTestServer();
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(create);
    const broadcasts = collectChatBroadcasts(host);

    const firstBroadcast = nextChatBroadcast(host, 'first chat broadcast');
    expectRoomActionSuccess(await emitChat(host, '第一条'));
    await firstBroadcast;

    // 同一条连接紧接着再发一条：被静默丢弃（不给刷屏者任何错误反馈）。
    expectRoomActionSuccess(await emitChat(host, '第二条'));
    await expectNoChatBroadcast(host, 'rate limited chat broadcast');
    expect(broadcasts.messages.map((message) => message.text)).toEqual(['第一条']);
    broadcasts.stop();
  });

  test('a spectator chat message is broadcast with the spectator role and nickname', async () => {
    const { url } = await startTestServer();
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(create);
    const spectator = await connectClient(url);
    const spectatorJoinState = nextRoomStateWithin(host, 'host sees spectator join room_state');
    const join = await emitAck(spectator, 'room:join', {
      roomCode: create.roomCode,
      nickname: '围观者',
      role: 'spectator',
    });
    expectJoinRoomSuccess(join);
    await spectatorJoinState;

    const broadcast = nextChatBroadcast(host, 'host sees spectator chat');
    expectRoomActionSuccess(await emitChat(spectator, '我只看看'));
    expect(await broadcast).toMatchObject({
      playerId: 'player-guest',
      nickname: '围观者',
      text: '我只看看',
      role: 'spectator',
    });
  });

  test('room:chat_message rejects a malformed payload and the history stays bounded', async () => {
    const { url } = await startTestServer();
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(create);

    expectRoomFailure(await emitMalformedChat(host, { text: 42 }), 'INVALID_ROOM_ACTION');
    expectRoomFailure(await emitMalformedChat(host, 'not-an-object'), 'INVALID_ROOM_ACTION');

    // 三条连接轮流发言，凑出 > CHAT_HISTORY_LIMIT 条消息。
    const senders: RoomClient[] = [host];
    for (const nickname of ['玩家二', '玩家三']) {
      const sender = await connectClient(url);
      const joinState = nextRoomStateWithin(sender, `${nickname} join room_state`);
      expectJoinRoomSuccess(await emitAck(sender, 'room:join', { roomCode: create.roomCode, nickname }));
      await joinState;
      senders.push(sender);
    }

    // 只接管 Date.now：聊天频率限流按它计算，而 Socket.IO 的心跳走真实 setTimeout。
    // 每次只推进 250ms：同一连接的发言间隔是 750ms，刚好越过 700ms 限流线，
    // 而 51 条累计只推进 ~12.8s，远小于心跳窗口（pingInterval 25s），连接不会被判定失联。
    const baseTime = Date.now();
    let fakeNow = baseTime;
    let lastSentIndex = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);
    try {
      for (let index = 1; index <= CHAT_HISTORY_LIMIT + 1; index += 1) {
        fakeNow += 250;
        const sender = senders[(index - 1) % senders.length] as RoomClient;
        // 单条 ack 预算放宽：这里要连续跑真实往返，200ms 在并行 worker 下会偶发不够。
        try {
          expectRoomActionSuccess(await emitChat(sender, `消息${index}`, 2000));
        } catch (error) {
          throw new Error(`chat index ${index} failed: ${(error as Error).message}`);
        }
        lastSentIndex = index;
      }
    } finally {
      nowSpy.mockRestore();
    }
    expect(lastSentIndex).toBe(CHAT_HISTORY_LIMIT + 1);

    const latecomer = await connectClient(url);
    const historyPromise = nextChatHistory(latecomer, 'latecomer chat history');
    const latecomerJoinState = nextRoomStateWithin(latecomer, 'latecomer join room_state');
    const latecomerJoin = await emitAck(latecomer, 'room:join', {
      roomCode: create.roomCode,
      nickname: '围观者',
      role: 'spectator',
    });
    expectJoinRoomSuccess(latecomerJoin);
    await latecomerJoinState;

    const history = await historyPromise;
    expect(history.messages).toHaveLength(CHAT_HISTORY_LIMIT);
    // 最旧的那条被淘汰，留下的是最后 CHAT_HISTORY_LIMIT 条。
    expect(history.messages[0]?.text).toBe('消息2');
    expect(history.messages.at(-1)?.text).toBe(`消息${CHAT_HISTORY_LIMIT + 1}`);
  });
});

describe('Socket.IO room settings unicast on room entry (#4 / #6)', () => {
  // 回归（2026-09-24 线上实测）：建房后「房间规则」面板（含电脑难度）不显示，
  // 必须刷新页面才出现。根因是建房路径漏发 `room:settings` 单播 ——
  // `CreateRoomAck` 只带 roomCode/playerId/token/room，**不含 settings**，
  // 于是房主端 `roomSettings` 恒为 null，`LobbyView.rulesVisible` 为 false。
  // 刷新能救回来，是因为重连走 `session:resume`，那条路径本来就发。
  test('room:create hands the host the authoritative settings right after the ack', async () => {
    const { url } = await startTestServer();
    const host = await connectClient(url);
    const order: string[] = [];
    host.on('room:settings', () => order.push('settings'));
    const settingsPromise = nextRoomSettings(host, 'room:settings after room:create');

    const create = await emitAckRecordingOrder(host, 'room:create', { mapId: 'china-tour', nickname: '房主' }, order);
    expectCreateRoomSuccess(create);

    // 默认难度 normal；没自定义任何规则时 ruleConfig 为 null（客户端据此显示「地图默认」）。
    expect(await settingsPromise).toEqual({ botDifficulty: 'normal', ruleConfig: null });
    // 顺序是硬要求：ack 之后才发，才不会被客户端 ack 处理里的 resetSession() 清掉。
    expect(order).toEqual(['ack', 'settings']);
  });

  test('room:create carries the requested bot difficulty back to the host without a refresh', async () => {
    const { url } = await startTestServer();
    const host = await connectClient(url);
    const settingsPromise = nextRoomSettings(host, 'room:settings after room:create with difficulty');

    const create = await emitAck(host, 'room:create', {
      mapId: 'china-tour',
      nickname: '房主',
      botDifficulty: 'hard',
    });
    expectCreateRoomSuccess(create);

    expect(await settingsPromise).toEqual({ botDifficulty: 'hard', ruleConfig: null });
  });

  test('a joining member receives the room settings right after the join ack', async () => {
    const { url } = await startTestServer();
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectCreateRoomSuccess(create);
    // 房主把规则改成自定义值，后进来的成员必须立刻看到同一份设置（而不是地图默认）。
    const updated = await emitUpdateSettings(host, { ruleConfig: {
      initialCash: 25_000,
      maxHouseLevel: 3,
      mortgageInterestRate: 0.12,
    } });
    expect(updated.ok).toBe(true);

    const guest = await connectClient(url);
    const order: string[] = [];
    guest.on('room:settings', () => order.push('settings'));
    const settingsPromise = nextRoomSettings(guest, 'room:settings after room:join');
    const guestJoinState = nextRoomStateWithin(guest, 'guest lobby join room_state');
    const join = await emitAckRecordingOrder(guest, 'room:join', { roomCode: create.roomCode, nickname: '玩家二' }, order);
    expectJoinRoomSuccess(join);
    await guestJoinState;

    expect(await settingsPromise).toEqual({
      botDifficulty: 'normal',
      ruleConfig: { initialCash: 25_000, maxHouseLevel: 3, mortgageInterestRate: 0.12 },
    });
    expect(order).toEqual(['ack', 'settings']);
  });

  test('session:resume re-sends the room settings, which is why a refresh rebuilds the rules panel', async () => {
    const { url } = await startTestServer();
    const host = await connectClient(url);
    const settingsPromiseAfterCreate = nextRoomSettings(host, 'host settings after create');
    const create = await emitAck(host, 'room:create', {
      mapId: 'china-tour',
      nickname: '房主',
      botDifficulty: 'easy',
    });
    expectCreateRoomSuccess(create);
    await settingsPromiseAfterCreate;

    const reconnecting = await connectClient(url);
    const settingsPromise = nextRoomSettings(reconnecting, 'room:settings after session:resume');
    const resume = await emitResume(reconnecting, {
      roomCode: create.roomCode,
      playerId: 'player-host',
      token: create.token,
    });
    expect(resume.ok).toBe(true);

    expect(await settingsPromise).toEqual({ botDifficulty: 'easy', ruleConfig: null });
  });
});

describe('Socket.IO room:create rate limit', () => {
  test('a create past the per-window cap is rejected with a dedicated retryable code and never reaches the room manager', async () => {
    const { url, server } = await startTestServer({
      rateLimit: { windowMs: 60_000, maxPerWindow: 2 },
      roomNumbers: [7, 8, 9],
      playerIds: ['player-host', 'player-host-2', 'player-host-3'],
      tokens: ['token-host', 'token-host-2', 'token-host-3'],
    });
    const host = await connectClient(url);

    expectCreateRoomSuccess(await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' }));
    expectCreateRoomSuccess(await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' }));

    const limited = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });

    // 必须是独立错误码：INVALID_ROOM_ACTION 在客户端被归类为「放弃后重开」，
    // 而这条只要等一会儿就能继续，误判会把玩家赶出正确的操作路径。
    expect(limited).toEqual({
      ok: false,
      code: 'CREATE_RATE_LIMITED',
      message: '创建房间过于频繁，请稍后再试。',
    });
    // 被拒的请求在进入 roomManager 之前掉头：既不消耗房间号，也不留下半个房间。
    expect(server.roomManager.getPublicRoom('000008')).not.toBeNull();
    expect(server.roomManager.getPublicRoom('000009')).toBeNull();
    expect(host.connected).toBe(true);
  });

  test('the sliding window only counts attempts inside it, so the same client is allowed again once the window passes', async () => {
    // 时钟由服务端注入（而不是 mock 全局 Date.now）：同进程里 Socket.IO 客户端也读 Date.now，
    // 全局打桩会把等待 ack 的用例直接挂死。
    let fakeNow = 1_000_000;
    const { url } = await startTestServer({
      rateLimit: { windowMs: 60_000, maxPerWindow: 1 },
      now: () => fakeNow,
      roomNumbers: [7, 8],
      playerIds: ['player-host', 'player-host-2'],
      tokens: ['token-host', 'token-host-2'],
    });
    const host = await connectClient(url);

    expectCreateRoomSuccess(await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' }));

    fakeNow += 59_999;
    const insideWindow = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' });
    expectRoomFailure(insideWindow, 'CREATE_RATE_LIMITED');

    // 滑动窗口而非固定计数：刚过 windowMs，第一次尝试即过期，名额重新可用。
    fakeNow += 1;
    expectCreateRoomSuccess(await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '房主' }));
  });

  test('the cap is per client address, so a fresh socket from the same client does not reset it', async () => {
    const { url } = await startTestServer({
      rateLimit: { windowMs: 60_000, maxPerWindow: 1 },
      roomNumbers: [7, 8],
      playerIds: ['player-host', 'player-host-2'],
      tokens: ['token-host', 'token-host-2'],
    });
    const first = await connectClient(url);
    expectCreateRoomSuccess(await emitAck(first, 'room:create', { mapId: 'china-tour', nickname: '房主' }));

    // 换个连接（同一客户端地址）绕不过限流：否则「断开重连」就是免费的刷房外挂。
    const second = await connectClient(url);
    const limited = await emitAck(second, 'room:create', { mapId: 'china-tour', nickname: '房主二' });

    expectRoomFailure(limited, 'CREATE_RATE_LIMITED');
    expect(limited.message).toBe('创建房间过于频繁，请稍后再试。');
  });
});

async function startTestServer(options: DeterministicManagerOptions = {}): Promise<StartedTestServer> {
  const running = createRoomServer({
    rateLimit: options.rateLimit ?? false,
    now: options.now,
    roomManagerFactory: createDeterministicRoomManagerFactory(options),
    logger:
      options.serverErrors === undefined
        ? undefined
        : {
            error(message, error) {
              const suffix = error instanceof Error ? `: ${error.message}` : '';
              options.serverErrors?.push(`${message}${suffix}`);
            },
          },
  });
  servers.push(running);
  await listenOnEphemeralLocalhost(running.httpServer);
  const address = running.httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected the test HTTP server to listen on an ephemeral TCP port');
  }
  return {
    url: `http://127.0.0.1:${(address as AddressInfo).port}`,
    server: running,
  };
}

function untrackServer(server: RunningRoomServer): void {
  const index = servers.indexOf(server);
  if (index !== -1) {
    servers.splice(index, 1);
  }
}

function createDeterministicRoomManagerFactory(options: DeterministicManagerOptions): RoomManagerFactory {
  const roomNumbers = options.roomNumbers ?? [7];
  const playerIds = options.playerIds ?? ['player-host', 'player-guest', 'player-third'];
  const tokens = options.tokens ?? ['token-host', 'token-guest', 'token-third'];
  let roomNumberIndex = 0;
  let playerIdIndex = 0;
  let tokenIndex = 0;

  return (onAsyncEvents) => {
    const dependencies: RoomManagerDependencies<TimerHandle> = {
      generatePlayerId() {
        const nextIndex = playerIdIndex++;
        return playerIds[nextIndex] ?? `player-${nextIndex}`;
      },
      generateToken() {
        const nextIndex = tokenIndex++;
        return tokens[nextIndex] ?? `token-${nextIndex}`;
      },
      nextRoomNumber() {
        if (roomNumberIndex >= roomNumbers.length) {
          throw new Error('No more deterministic room numbers were provided');
        }
        return roomNumbers[roomNumberIndex++];
      },
      compareTokens(actual, supplied) {
        return actual === supplied;
      },
      setTimer(callback, delayMs) {
        const handle = { callback, delayMs, active: true };
        options.timers?.push(handle);
        return handle;
      },
      clearTimer(handle) {
        handle.active = false;
      },
      onAsyncEvents,
      generateGameSeed() {
        return 'socket-game-seed';
      },
      nextAutomationDelayMs() {
        return 1000;
      },
    };

    return new RoomManager(dependencies);
  };
}

async function listenOnEphemeralLocalhost(httpServer: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      httpServer.off('error', onError);
      reject(error);
    };
    httpServer.once('error', onError);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', onError);
      resolve();
    });
  });
}

async function connectClient(url: string): Promise<RoomClient> {
  const client: RoomClient = connectSocket(url, {
    forceNew: true,
    reconnection: false,
    transports: ['websocket'],
  });
  clients.push(client);

  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('connect_error', reject);
  });

  return client;
}

function emitAck(socket: RoomClient, event: 'room:create', payload: CreateRoomPayload): Promise<CreateRoomResponse>;
function emitAck(socket: RoomClient, event: 'room:join', payload: JoinRoomPayload): Promise<JoinRoomResponse>;
function emitAck(
  socket: RoomClient,
  event: 'room:create' | 'room:join',
  payload: CreateRoomPayload | JoinRoomPayload,
): Promise<CreateRoomResponse | JoinRoomResponse> {
  const untypedSocket: ClientSocket = socket;
  const payloadWithRequestId = withRequestId(payload);
  if (event === 'room:create') {
    return new Promise<CreateRoomResponse>((resolve) => {
      untypedSocket.emit('room:create', payloadWithRequestId, resolve);
    });
  }

  return new Promise<JoinRoomResponse>((resolve) => {
    untypedSocket.emit('room:join', payloadWithRequestId, resolve);
  });
}

/**
 * 与 `emitAck` 相同，但把 ack 的到达顺序记进 `order`。
 * 用于断言「进入房间的单播（聊天历史 / 房间设置）必须晚于 ack」——
 * 客户端的 ack 处理里可能 resetSession()，先到的单播会被那次清空吞掉。
 */
function emitAckRecordingOrder(
  socket: RoomClient,
  event: 'room:create',
  payload: CreateRoomPayload,
  order: string[],
): Promise<CreateRoomResponse>;
function emitAckRecordingOrder(
  socket: RoomClient,
  event: 'room:join',
  payload: JoinRoomPayload,
  order: string[],
): Promise<JoinRoomResponse>;
function emitAckRecordingOrder(
  socket: RoomClient,
  event: 'room:create' | 'room:join',
  payload: CreateRoomPayload | JoinRoomPayload,
  order: string[],
): Promise<CreateRoomResponse | JoinRoomResponse> {
  const untypedSocket: ClientSocket = socket;
  return withEventTimeout(
    new Promise<CreateRoomResponse | JoinRoomResponse>((resolve) => {
      untypedSocket.emit(event, withRequestId(payload), (response: CreateRoomResponse | JoinRoomResponse) => {
        order.push('ack');
        resolve(response);
      });
    }),
    `${event} ack with order`,
  );
}

function emitAckAndIgnore(
  socket: RoomClient,
  event: 'room:create' | 'room:join',
  payload: CreateRoomPayload | JoinRoomPayload,
): void {
  const untypedSocket: ClientSocket = socket;
  untypedSocket.emit(event, withRequestId(payload), () => undefined);
}

function withRequestId(payload: CreateRoomPayload | JoinRoomPayload): CreateRoomPayload | JoinRoomPayload {
  const withId = {
    ...payload,
    requestId: payload.requestId ?? (generatedRequestId++).toString(16).padStart(32, '0'),
  };
  if ('roomCode' in payload) {
    return { ...withId, role: payload.role ?? 'player' };
  }
  return withId;
}

function emitMalformedJoinPayload(socket: RoomClient, payload: unknown): Promise<JoinRoomResponse> {
  const untypedSocket: ClientSocket = socket;
  return new Promise<JoinRoomResponse>((resolve) => {
    untypedSocket.emit('room:join', payload, resolve);
  });
}

function emitAddBot(socket: RoomClient): Promise<EmptyAckResponse> {
  return emitNoPayloadRoomAction(socket, 'room:add_bot');
}

function emitUpdateSettings(socket: RoomClient, patch: RoomSettingsPatch): Promise<Ack<RoomSettings>> {
  const untypedSocket: ClientSocket = socket;
  return withEventTimeout(
    new Promise<Ack<RoomSettings>>((resolve) => {
      untypedSocket.emit('room:update_settings', patch, resolve);
    }),
    'room:update_settings ack',
  );
}

function emitRemoveBot(socket: RoomClient, payload: RemoveBotPayload): Promise<EmptyAckResponse> {
  const untypedSocket: ClientSocket = socket;
  return withEventTimeout(
    new Promise<EmptyAckResponse>((resolve) => {
      untypedSocket.emit('room:remove_bot', payload, resolve);
    }),
    'room:remove_bot ack',
  );
}

function emitRenameBot(socket: RoomClient, payload: RenameBotPayload): Promise<EmptyAckResponse> {
  const untypedSocket: ClientSocket = socket;
  return withEventTimeout(
    new Promise<EmptyAckResponse>((resolve) => {
      untypedSocket.emit('room:rename_bot', payload, resolve);
    }),
    'room:rename_bot ack',
  );
}

function emitStart(socket: RoomClient): Promise<EmptyAckResponse> {
  return emitNoPayloadRoomAction(socket, 'room:start');
}

function emitLeave(socket: RoomClient): Promise<EmptyAckResponse> {
  return emitNoPayloadRoomAction(socket, 'room:leave');
}

function emitResume(socket: RoomClient, payload: ResumePayload): Promise<ResumeResponse> {
  const untypedSocket: ClientSocket = socket;
  return withEventTimeout(
    new Promise<ResumeResponse>((resolve) => {
      untypedSocket.emit('session:resume', payload, resolve);
    }),
    'session:resume ack',
  );
}

function emitMalformedRoomAction(
  socket: RoomClient,
  event: 'room:remove_bot' | 'room:rename_bot' | 'session:resume',
  payload: unknown,
): Promise<EmptyAckResponse | ResumeResponse> {
  const untypedSocket: ClientSocket = socket;
  return withEventTimeout(
    new Promise<EmptyAckResponse | ResumeResponse>((resolve) => {
      untypedSocket.emit(event, payload, resolve);
    }),
    `${event} malformed ack`,
  );
}

function emitNoPayloadRoomAction(
  socket: RoomClient,
  event: 'room:add_bot' | 'room:start' | 'room:leave',
): Promise<EmptyAckResponse> {
  const untypedSocket: ClientSocket = socket;
  return withEventTimeout(
    new Promise<EmptyAckResponse>((resolve) => {
      untypedSocket.emit(event, resolve);
    }),
    `${event} ack`,
  );
}

function emitCreateWithoutAck(socket: RoomClient, payload: CreateRoomPayload): void {
  const untypedSocket: ClientSocket = socket;
  untypedSocket.emit('room:create', payload);
}

function emitJoinWithoutAck(socket: RoomClient, payload: JoinRoomPayload): void {
  const untypedSocket: ClientSocket = socket;
  untypedSocket.emit('room:join', payload);
}

function emitRemoveBotWithoutAck(socket: RoomClient, payload: RemoveBotPayload): void {
  const untypedSocket: ClientSocket = socket;
  untypedSocket.emit('room:remove_bot', payload);
}

function emitStartWithoutAck(socket: RoomClient): void {
  const untypedSocket: ClientSocket = socket;
  untypedSocket.emit('room:start');
}

type ClientIssueLog = {
  errors: string[];
  disconnects: string[];
};

function watchClientIssues(socket: RoomClient): ClientIssueLog {
  const issues: ClientIssueLog = {
    errors: [],
    disconnects: [],
  };
  socket.once('connect_error', (error) => {
    issues.errors.push(error.message);
  });
  socket.once('disconnect', (reason) => {
    issues.disconnects.push(reason);
  });
  const errorEventSocket = socket as unknown as {
    once(event: 'error', listener: (error: unknown) => void): void;
  };
  errorEventSocket.once('error', (error) => {
    issues.errors.push(error instanceof Error ? error.message : String(error));
  });
  return issues;
}

function nextRoomState(socket: RoomClient): Promise<PublicRoomState> {
  return new Promise<PublicRoomState>((resolve) => {
    socket.once('room:state', resolve);
  });
}

function nextRoomStateWithin(socket: RoomClient, label: string): Promise<PublicRoomState> {
  return withEventTimeout(nextRoomState(socket), label);
}

/** 等待第一条满足条件 room:state：用于避开「同一动作链里更早那条广播刚好晚到」造成的竞态。 */
function nextRoomStateMatchingWithin(
  socket: RoomClient,
  label: string,
  predicate: (room: PublicRoomState) => boolean,
): Promise<PublicRoomState> {
  return withEventTimeout(
    new Promise<PublicRoomState>((resolve) => {
      const listener = (room: PublicRoomState) => {
        if (!predicate(room)) return;
        socket.off('room:state', listener);
        resolve(room);
      };
      socket.on('room:state', listener);
    }),
    label,
  );
}
function collectRoomStates(socket: RoomClient): {
  states: PublicRoomState[];
  stop(): void;
} {
  const states: PublicRoomState[] = [];
  const listener = (room: PublicRoomState) => {
    states.push(room);
  };
  socket.on('room:state', listener);
  return {
    states,
    stop() {
      socket.off('room:state', listener);
    },
  };
}

function emitChat(socket: RoomClient, text: string, timeoutMs = EVENT_TIMEOUT_MS): Promise<EmptyAckResponse> {
  const untypedSocket: ClientSocket = socket;
  return withEventTimeout(
    new Promise<EmptyAckResponse>((resolve) => {
      untypedSocket.emit('room:chat_message', { text }, resolve);
    }),
    'room:chat_message ack',
    timeoutMs,
  );
}

function emitMalformedChat(socket: RoomClient, payload: unknown): Promise<EmptyAckResponse> {
  const untypedSocket: ClientSocket = socket;
  return withEventTimeout(
    new Promise<EmptyAckResponse>((resolve) => {
      untypedSocket.emit('room:chat_message', payload, resolve);
    }),
    'room:chat_message malformed ack',
  );
}

function nextChatBroadcast(socket: RoomClient, label: string): Promise<ChatMessage> {
  return withEventTimeout(
    new Promise<ChatMessage>((resolve) => {
      socket.once('room:chat_broadcast', resolve);
    }),
    label,
  );
}

function nextChatHistory(socket: RoomClient, label: string): Promise<{ messages: ChatMessage[] }> {
  return withEventTimeout(
    new Promise<{ messages: ChatMessage[] }>((resolve) => {
      socket.once('room:chat_history', resolve);
    }),
    label,
  );
}

function nextRoomSettings(socket: RoomClient, label: string): Promise<RoomSettings> {
  return withEventTimeout(
    new Promise<RoomSettings>((resolve) => {
      socket.once('room:settings', resolve);
    }),
    label,
  );
}

function nextRoomClosed(socket: RoomClient, label: string): Promise<{ reason: string }> {
  return withEventTimeout(
    new Promise<{ reason: string }>((resolve) => {
      socket.once('room:closed', resolve);
    }),
    label,
  );
}

function collectChatBroadcasts(socket: RoomClient): {
  messages: ChatMessage[];
  stop(): void;
} {
  const messages: ChatMessage[] = [];
  const listener = (message: ChatMessage) => {
    messages.push(message);
  };
  socket.on('room:chat_broadcast', listener);
  return {
    messages,
    stop() {
      socket.off('room:chat_broadcast', listener);
    },
  };
}

function nextPlayerConnection(socket: RoomClient, label: string): Promise<PlayerConnectionChange> {
  return withEventTimeout(
    new Promise<PlayerConnectionChange>((resolve) => {
      socket.once('player:connection', resolve);
    }),
    label,
  );
}

function expectNoRoomState(socket: RoomClient, label: string): Promise<void> {
  return expectNoSocketEvent(socket, 'room:state', label);
}

function expectNoPlayerConnection(socket: RoomClient, label: string): Promise<void> {
  return expectNoSocketEvent(socket, 'player:connection', label);
}

function expectNoChatHistory(socket: RoomClient, label: string): Promise<void> {
  return expectNoSocketEvent(socket, 'room:chat_history', label);
}

function expectNoChatBroadcast(socket: RoomClient, label: string): Promise<void> {
  return expectNoSocketEvent(socket, 'room:chat_broadcast', label);
}

function expectNoSocketEvent(
  socket: RoomClient,
  event: 'room:state' | 'player:connection' | 'room:closed' | 'room:chat_history' | 'room:chat_broadcast',
  label: string,
): Promise<void> {
  const untypedSocket: ClientSocket = socket;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeoutId: NodeJS.Timeout;
    let listener: (payload: unknown) => void = () => undefined;
    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      untypedSocket.off(event, listener);
    };
    listener = (payload: unknown) => {
      cleanup();
      reject(new Error(`Expected no ${label}, received ${JSON.stringify(payload)}`));
    };
    timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, EVENT_TIMEOUT_MS);
    untypedSocket.once(event, listener);
  });
}

function withEventTimeout<T>(promise: Promise<T>, label: string, timeoutMs = EVENT_TIMEOUT_MS): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);
  });
  const timedPromise = Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timeoutId);
  });
  timedPromise.catch(() => undefined);
  return timedPromise;
}

function expectCreateRoomSuccess(response: CreateRoomResponse): asserts response is { ok: true } & CreateRoomAck {
  expect(response.ok).toBe(true);
  if (!response.ok) {
    throw new Error(`Expected room:create to succeed, received ${response.code}: ${response.message}`);
  }
}

function expectJoinRoomSuccess(response: JoinRoomResponse): asserts response is { ok: true } & JoinRoomAck {
  expect(response.ok).toBe(true);
  if (!response.ok) {
    throw new Error(`Expected room:join to succeed, received ${response.code}: ${response.message}`);
  }
}

function expectRoomActionSuccess(response: EmptyAckResponse): asserts response is { ok: true } {
  expect(response).toEqual({ ok: true });
}

function expectResumeSuccess(
  response: ResumeResponse,
  expectedRoom: PublicRoomState,
  tokenValues: string[],
): asserts response is { ok: true; room: PublicRoomState } {
  expect(response.ok).toBe(true);
  if (!response.ok) {
    throw new Error(`Expected session:resume to succeed, received ${response.code}: ${response.message}`);
  }
  expect(response).toEqual({ ok: true, room: expectedRoom });
  expectPublicRoomHasNoToken(response.room, tokenValues);
}

function expectRoomFailure(
  response: CreateRoomResponse | JoinRoomResponse | EmptyAckResponse | ResumeResponse,
  code: string,
  tokenValues: string[] = [],
): asserts response is { ok: false; code: string; message: string } {
  expect(response.ok).toBe(false);
  if (response.ok) {
    throw new Error(`Expected room action to fail with ${code}, received success`);
  }
  expect(response.code).toBe(code);
  expect(response.message).not.toHaveLength(0);
  const serialized = JSON.stringify(response);
  for (const token of tokenValues) {
    expect(response.message).not.toContain(token);
    expect(serialized).not.toContain(token);
  }
}

function expectPublicRoomHasNoToken(room: PublicRoomState, tokenValues: string[]): void {
  expectNoTokenField(room);
  const serialized = JSON.stringify(room);
  for (const token of tokenValues) {
    expect(serialized).not.toContain(token);
  }
}

function expectNoTokenField(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      expectNoTokenField(item);
    }
    return;
  }

  if (value === null || typeof value !== 'object') {
    return;
  }

  expect(Object.prototype.hasOwnProperty.call(value, 'token')).toBe(false);
  for (const child of Object.values(value)) {
    expectNoTokenField(child);
  }
}
