import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { io as connectSocket, type Socket as ClientSocket } from 'socket.io-client';
import { createRoomServer } from '../server';
import type { Ack, ClientToServerEvents, CreateRoomAck, JoinRoomAck, PublicRoomState, ServerToClientEvents } from '@richman/protocol';
import { RoomManager } from '../rooms/roomManager';
import type { RoomDomainEvent, RoomManagerDependencies } from '../rooms/roomTypes';
import { getActiveMapPack } from '@richman/board-data';

type TimerHandle = {
  callback: () => void;
  delayMs: number;
  active: boolean;
};

type CreateRoomPayload = { nickname: string; mapId: string; requestId?: string };
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
    const expectedRoom: PublicRoomState = { roomCode: '0007', status: 'lobby', hostId: 'player-host', players: [
      {
        id: 'player-host',
        nickname: '玩家一',
        isBot: false,
        online: true,
      },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(create).toEqual({
      ok: true,
      roomCode: '0007',
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
      roomCode: '0007',
      playerId: 'player-host',
      token: 'token-host',
      room: { roomCode: '0007', status: 'lobby', hostId: 'player-host', players: [
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
    const expectedRoom: PublicRoomState = { roomCode: '0007', status: 'lobby', hostId: 'player-host', players: [
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
    const roomAWithHostAndGuest: PublicRoomState = { roomCode: '0007', status: 'lobby', hostId: 'player-host', players: [
      { id: 'player-host', nickname: '房主', isBot: false, online: true },
      { id: 'player-guest', nickname: '玩家二', isBot: false, online: true },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(await hostJoinState).toEqual(roomAWithHostAndGuest);
    expect(await guestJoinState).toEqual(roomAWithHostAndGuest);

    const guestRoomAAfterRebind = nextRoomStateWithin(guest, 'guest room A after host creates room B');
    const createB = await emitAck(host, 'room:create', { mapId: 'china-tour', nickname: '新房主' });

    expectCreateRoomSuccess(createB);
    const roomB: PublicRoomState = { roomCode: '0008', status: 'lobby', hostId: 'player-new-host', players: [{ id: 'player-new-host', nickname: '新房主', isBot: false, online: true }], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(createB).toEqual({
      ok: true,
      roomCode: '0008',
      playerId: 'player-new-host',
      token: 'token-new-host',
      room: roomB,
    });
    const roomAAfterRebind: PublicRoomState = { roomCode: '0007', status: 'lobby', hostId: 'player-guest', players: [{ id: 'player-guest', nickname: '玩家二', isBot: false, online: true }], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
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
    const expectedRoom: PublicRoomState = { roomCode: '0007', status: 'lobby', hostId: 'player-host', players: [
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
    const roomWithBot: PublicRoomState = { roomCode: '0007', status: 'lobby', hostId: 'player-host', players: [
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

    const hostAddedState = nextRoomStateWithin(host, 'host add bot room_state');
    const guestAddedState = nextRoomStateWithin(guest, 'guest add bot room_state');
    const add = await emitAddBot(host);

    expectRoomActionSuccess(add);
    const roomWithBot: PublicRoomState = { roomCode: '0007', status: 'lobby', hostId: 'player-host', players: [
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
    const roomWithoutBot: PublicRoomState = { roomCode: '0007', status: 'lobby', hostId: 'player-host', players: [
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

    const hostRenamedState = nextRoomStateWithin(host, 'host rename bot room_state');
    const guestRenamedState = nextRoomStateWithin(guest, 'guest rename bot room_state');
    const rename = await emitRenameBot(host, { playerId: 'bot-a', nickname: '  电脑甲  ' });

    expectRoomActionSuccess(rename);
    const roomWithRenamedBot: PublicRoomState = { roomCode: '0007', status: 'lobby', hostId: 'player-host', players: [
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
    const expectedRoom: PublicRoomState = { roomCode: '0007', status: 'playing', hostId: 'player-host', players: [
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
    const roomAfterLeave: PublicRoomState = { roomCode: '0007', status: 'lobby', hostId: 'player-host', players: [{ id: 'player-host', nickname: '房主', isBot: false, online: true }], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(await hostLeaveState).toEqual(roomAfterLeave);

    const hostBotState = nextRoomStateWithin(host, 'host room_state after left socket unbound');
    const guestNoLongerInRoom = expectNoRoomState(guest, 'left socket should not receive future room_state');
    const add = await emitAddBot(host);
    expectRoomActionSuccess(add);
    const roomAfterBot: PublicRoomState = { roomCode: '0007', status: 'lobby', hostId: 'player-host', players: [
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
    const offlineRoom: PublicRoomState = { roomCode: '0007', status: 'lobby', hostId: 'player-host', players: [
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

    const onlineRoom: PublicRoomState = { roomCode: '0007', status: 'lobby', hostId: 'player-host', players: [
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

    const lobbyRoom: PublicRoomState = { roomCode: '0007', status: 'lobby', hostId: 'player-host', players: [
      { id: 'player-host', nickname: '房主', isBot: false, online: true },
      { id: 'player-guest', nickname: '玩家二', isBot: false, online: true },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expectResumeSuccess(resume, lobbyRoom, [create.token, join.token]);

    const hostBotState = nextRoomStateWithin(host, 'host room_state after replacement');
    const replacementBotState = nextRoomStateWithin(replacement, 'replacement room_state after replacement');
    const oldSocketNoState = expectNoRoomState(guest, 'old replaced socket should leave the room');
    const add = await emitAddBot(host);
    expectRoomActionSuccess(add);
    const roomWithBot: PublicRoomState = { roomCode: '0007', status: 'lobby', hostId: 'player-host', players: [
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
    const roomAfterLeave: PublicRoomState = { roomCode: '0007', status: 'lobby', hostId: 'player-host', players: [
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
    const guestHostTransfer = nextRoomStateWithin(guest, 'playing host transfer room_state');
    host.disconnect();

    expect(await guestHostOffline).toEqual({ playerId: 'player-host', online: false });
    const expectedRoom: PublicRoomState = { roomCode: '0007', status: 'playing', hostId: 'player-guest', players: [
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
    const roomAfterSingleRemove: PublicRoomState = { roomCode: '0007', status: 'lobby', hostId: 'player-host', players: [
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
    const offlineRoom: PublicRoomState = { roomCode: '0007', status: 'lobby', hostId: 'player-host', players: [
      { id: 'player-host', nickname: '房主', isBot: false, online: false },
      { id: 'player-guest', nickname: '玩家二', isBot: false, online: true },
    ], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
    expect(await guestOfflineState).toEqual(offlineRoom);
    expect(timers).toHaveLength(1);
    expect(timers[0]).toMatchObject({ delayMs: 300_000, active: true });

    const guestTimeoutState = nextRoomStateWithin(guest, 'lobby timeout async room_state');
    timers[0].callback();

    const roomAfterTimeout: PublicRoomState = { roomCode: '0007', status: 'lobby', hostId: 'player-guest', players: [{ id: 'player-guest', nickname: '玩家二', isBot: false, online: true }], spectators: [], takeoverPlayerId: null, map: CHINA_MAP_SUMMARY };
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
    const observerJoin = await emitAck(observer, 'room:join', { roomCode: '0007', nickname: '观察者' });
    expectJoinRoomSuccess(observerJoin);

    const offline = nextPlayerConnection(observer, 'dropped create original disconnect');
    original.disconnect();
    expect(await offline).toEqual({ playerId: 'player-host', online: false });

    const online = nextPlayerConnection(observer, 'dropped create replacement reconnect');
    const replacement = await connectClient(url);
    const replay = await emitAck(replacement, 'room:create', payload);

    expectCreateRoomSuccess(replay);
    expect(replay).toMatchObject({ roomCode: '0007', playerId: 'player-host', token: 'host-token' });
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
    expectJoinRoomSuccess(await emitAck(observer, 'room:join', { roomCode: '0007', nickname: '观察者' }));
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

async function startTestServer(options: DeterministicManagerOptions = {}): Promise<StartedTestServer> {
  const running = createRoomServer({
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

function expectNoSocketEvent(
  socket: RoomClient,
  event: 'room:state' | 'player:connection' | 'room:closed',
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

function withEventTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${label}`));
    }, EVENT_TIMEOUT_MS);
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
