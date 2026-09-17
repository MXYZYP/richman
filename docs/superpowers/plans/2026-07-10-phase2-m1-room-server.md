# Phase 2 M1 Room Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Phase 2 M1 Node.js + Socket.IO single-port server, deterministic lobby room system, disconnect/resume contract, static client hosting, and `pnpm party` LAN launcher without introducing game-state behavior.

**Architecture:** A pure `RoomManager` owns all room transitions and returns explicit domain events. A typed Socket.IO adapter binds sockets to room identities and translates domain results into acknowledgements and broadcasts. A testable HTTP server factory combines Socket.IO with static client hosting; production bootstrap and the party launcher are thin side-effect layers.

**Tech Stack:** TypeScript 5, Node.js 20, Socket.IO 4, Vitest, `socket.io-client`, `sirv`, `tsx`, `qrcode`, pnpm workspaces.

**Authoritative design:** `docs/superpowers/specs/2026-07-10-phase2-m1-room-server-design.md`

**Execution rule:** Every behavior task follows RED → GREEN. Test files MUST be authored by a `Tester` agent before production code is edited. Implementation agents do not write their own tests. Skip project-wide formatters and test suites during tasks; run only the listed targeted command. Full verification happens in Task 12.

**Worktree:** `/Users/admin/Documents/Richman/.worktrees/phase2-m1-room-server`

---

## File responsibility map

### Root and client configuration

- Modify `package.json`: run client + server in development, build both packages, expose `start` and `party`, declare root `tsx`, `qrcode`, and QR types.
- Modify `pnpm-lock.yaml`: generated only by pnpm after dependency declarations change.
- Modify `apps/client/vite.config.ts`: proxy `/socket.io` to `http://localhost:3000` with WebSocket upgrades.
- Create `scripts/party.ts`: start the already-built production server, select LAN address, print URLs and a terminal QR.
- Create `scripts/tsconfig.json`: typecheck the root party launcher with Node and QR types; existing recursive package typecheck does not include root scripts.

### Server package

- Modify `apps/server/package.json`: real `dev`, `start`, `build` scripts and Socket.IO/static/test dependencies.
- Keep `apps/server/tsconfig.json`: current `ES2022` + root `noEmit` convention; do not introduce a second compiler/bundler pipeline.
- Replace `apps/server/src/index.ts`: process entry only.
- Create `apps/server/src/production.ts`: production dependency wiring and reusable server start function shared by normal start and party mode.
- Create `apps/server/src/server.ts`: HTTP + static + Socket.IO factory and deterministic close path.
- Create `apps/server/src/protocol.ts`: typed Socket.IO events and public payloads.
- Create `apps/server/src/socket/roomSocketAdapter.ts`: socket/session bindings and protocol handlers only.
- Create `apps/server/src/rooms/roomTypes.ts`: private room model, manager dependencies, domain-event/result types.
- Create `apps/server/src/rooms/roomErrors.ts`: error catalog and safe Chinese messages.
- Create `apps/server/src/rooms/roomManager.ts`: all room rules, timers, room code allocation, projection, lifecycle, and disposal.
- Create `apps/server/src/party/networkAddress.ts`: pure address selection and URL construction.

### Tests

- Create `apps/server/src/__tests__/roomManager.test.ts`: deterministic room-domain tests.
- Create `apps/server/src/__tests__/socketRooms.test.ts`: real ephemeral Socket.IO integration and static-host tests.
- Create `apps/server/src/__tests__/networkAddress.test.ts`: pure network address tests.

### Documentation, last

- Modify `plan/03-架构与联机协议.md`: sync implemented ack, errors, lifecycle, and close reasons.
- Modify `plan/05-阶段2-联机版.md`: record `room:skip_offline_turn` as M2 work; retain playing-room reclaim as M4 work.
- Modify `README.md`: mark Phase 2 M1 complete only after Task 12 passes.

---

### Task 1: Install the M1 server toolchain and wire package scripts

**Files:**
- Modify: `package.json`
- Modify: `apps/server/package.json`
- Modify: `apps/client/vite.config.ts`
- Modify: `pnpm-lock.yaml` via pnpm

- [ ] **Step 1: Add package declarations with the existing package manager**

Run from the worktree root:

```bash
pnpm --filter @richman/server add socket.io@^4.8.1 sirv@^2.0.4 tsx@^4.7.0
pnpm --filter @richman/server add -D socket.io-client@^4.8.1 @types/node@^20.11.0 typescript@^5.4.0 vitest@^1.6.0
pnpm add -w qrcode@^1.5.4
pnpm add -Dw tsx@^4.7.0 @types/node@^20.11.0 @types/qrcode@^1.5.5
```

`tsx` is a server runtime dependency because `pnpm start` executes server TypeScript directly. Do not add a server bundler or an Express dependency.

- [ ] **Step 2: Replace placeholder scripts**

Set root scripts to preserve the existing commands while adding server orchestration:

```json
{
  "scripts": {
    "dev": "pnpm --parallel --filter @richman/client --filter @richman/server dev",
    "build": "pnpm --filter @richman/client build && pnpm --filter @richman/server build",
    "start": "pnpm --filter @richman/server start",
    "party": "pnpm build && tsx scripts/party.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "e2e": "echo '[阶段2起启用] Playwright 联机端到端测试'",
    "validate-data": "pnpm -C packages/board-data run validate",
    "typecheck": "pnpm -r exec tsc --noEmit"
  }
}
```

Set `apps/server/package.json` scripts to:

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "build": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

- [ ] **Step 3: Enable the Vite Socket.IO proxy**

Update `apps/client/vite.config.ts`:

```ts
server: {
  host: true,
  port: 5173,
  proxy: {
    '/socket.io': {
      target: 'http://localhost:3000',
      ws: true,
    },
  },
},
```

- [ ] **Step 4: Verify the toolchain**

Run:

```bash
pnpm --filter @richman/server build
pnpm --filter @richman/client build
```

Expected: both commands exit 0; the server build is a meaningful TypeScript check under the repository's existing `noEmit` convention.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml apps/server/package.json apps/client/vite.config.ts
git commit -m "Set up Phase 2 server toolchain"
```

---

### Task 2: Define protocol-safe types and create rooms deterministically

**Files:**
- Create: `apps/server/src/protocol.ts`
- Create: `apps/server/src/rooms/roomTypes.ts`
- Create: `apps/server/src/rooms/roomErrors.ts`
- Create: `apps/server/src/rooms/roomManager.ts`
- Create: `apps/server/src/__tests__/roomManager.test.ts`

- [ ] **Step 1: Ask the Tester agent to write failing create/code/public-state tests**

The tests must establish this wished-for API:

```ts
const manager = new RoomManager(dependencies);
const result = manager.createRoom('  玩家一  ');

expect(result.ok).toBe(true);
if (result.ok) {
  expect(result.value.roomCode).toBe('0007');
  expect(result.value.room.hostId).toBe(result.value.playerId);
  expect(result.value.room.players[0]).toEqual({
    id: result.value.playerId,
    nickname: '玩家一',
    isBot: false,
    online: true,
  });
  expect(JSON.stringify(result.value.room)).not.toContain(result.value.token);
}
```

The same RED batch must cover:

- room code is a zero-padded string;
- random collisions retry 100 times, then scan `0000`–`9999`;
- true 10000-code exhaustion returns safe `INVALID_ROOM_ACTION` rather than looping;
- nickname trim, empty rejection, and 20-code-point maximum;
- create result contains private token but `PublicRoomState` does not;
- room status is `lobby`, first player is host, players are ordered.

- [ ] **Step 2: Run RED**

```bash
pnpm exec vitest run apps/server/src/__tests__/roomManager.test.ts
```

Expected: FAIL because `RoomManager` and its types do not exist.

- [ ] **Step 3: Implement the minimum domain contracts**

`protocol.ts` must expose public shapes only:

```ts
export interface PublicRoomPlayer {
  id: string;
  nickname: string;
  isBot: boolean;
  online: boolean;
}

export interface PublicRoomState {
  roomCode: string;
  status: 'lobby' | 'playing';
  hostId: string;
  players: PublicRoomPlayer[];
}
```

`roomTypes.ts` must keep private data private and inject nondeterminism:

```ts
export interface RoomPlayer extends PublicRoomPlayer {
  token: string | null;
}

export interface Room {
  code: string;
  status: 'lobby' | 'playing';
  hostId: string;
  players: RoomPlayer[];
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

export type RoomClosedReason = 'empty_lobby' | 'lobby_idle_timeout';

export type RoomDomainEvent =
  | { type: 'room_state'; roomCode: string; room: PublicRoomState }
  | {
      type: 'player_connection';
      roomCode: string;
      playerId: string;
      online: boolean;
    }
  | { type: 'room_closed'; roomCode: string; reason: RoomClosedReason };

export interface RoomManagerDependencies {
  generatePlayerId(): string;
  generateToken(): string;
  nextRoomNumber(): number;
  compareTokens(actual: string, supplied: string): boolean;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
  onAsyncEvents(events: RoomDomainEvent[]): void;
}
```

Use explicit results, never expected-control-flow exceptions:

```ts
export type RoomFailure = {
  ok: false;
  code: RoomErrorCode;
  message: string;
};

export type RoomSuccess<T> = {
  ok: true;
  value: T;
  events: RoomDomainEvent[];
};

export type RoomResult<T> = RoomSuccess<T> | RoomFailure;
```

`roomErrors.ts` must define exactly the M1 catalog:

```ts
export type RoomErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'GAME_ALREADY_STARTED'
  | 'NICKNAME_TAKEN'
  | 'INVALID_TOKEN'
  | 'NOT_HOST'
  | 'INVALID_NICKNAME'
  | 'NOT_ENOUGH_PLAYERS'
  | 'INVALID_ROOM_ACTION';
```

Implement only code allocation, nickname normalization/validation, `createRoom`, `getPublicRoom`, and `dispose`. Count nickname code points with `[...nickname].length`.

- [ ] **Step 4: Run GREEN**

```bash
pnpm exec vitest run apps/server/src/__tests__/roomManager.test.ts
```

Expected: all create/code/public-state tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/protocol.ts apps/server/src/rooms apps/server/src/__tests__/roomManager.test.ts
git commit -m "Add deterministic room creation"
```

---

### Task 3: Add join, bot management, and lobby start rules

**Files:**
- Modify: `apps/server/src/rooms/roomManager.ts`
- Modify: `apps/server/src/__tests__/roomManager.test.ts`

- [ ] **Step 1: Ask the Tester agent to add failing membership tests**

Add RED tests for the exact validation order and outputs:

```ts
expect(manager.joinRoom('9999', '玩家二')).toMatchObject({
  ok: false,
  code: 'ROOM_NOT_FOUND',
});
```

Cover:

- join checks room existence → lobby status → capacity → nickname;
- joining a playing room returns `GAME_ALREADY_STARTED`;
- fifth total player returns `ROOM_FULL`;
- duplicate trimmed nickname returns `NICKNAME_TAKEN`;
- join preserves insertion order and returns a private token;
- non-host add/remove bot returns `NOT_HOST`;
- playing add/remove bot returns `GAME_ALREADY_STARTED`;
- bot names are `电脑 A`, `电脑 B`, `电脑 C` and skip occupied names;
- full room returns `ROOM_FULL`;
- all three bot names occupied with one free seat returns `INVALID_ROOM_ACTION`;
- removing a human or unknown ID returns `INVALID_ROOM_ACTION`;
- bots have `token:null`, `online:true`;
- start requires host and at least two total players;
- host + one bot can start;
- insufficient total returns `NOT_ENOUGH_PLAYERS`;
- repeat start returns `GAME_ALREADY_STARTED`;
- start only flips `status` to `playing`; no `GameState` appears.

- [ ] **Step 2: Run RED**

```bash
pnpm exec vitest run apps/server/src/__tests__/roomManager.test.ts
```

Expected: FAIL on missing `joinRoom`, `addBot`, `removeBot`, and `startRoom`.

- [ ] **Step 3: Implement minimal membership methods**

Add these methods without Socket.IO dependencies:

```ts
joinRoom(roomCode: string, nickname: string): RoomResult<JoinRoomValue>;
addBot(roomCode: string, requesterId: string): RoomResult<PublicRoomState>;
removeBot(roomCode: string, requesterId: string, playerId: string): RoomResult<PublicRoomState>;
startRoom(roomCode: string, requesterId: string): RoomResult<PublicRoomState>;
```

Every successful room mutation returns a `room_state` domain event containing the authoritative public room snapshot. Apply specific errors before `INVALID_ROOM_ACTION`.

- [ ] **Step 4: Run GREEN**

```bash
pnpm exec vitest run apps/server/src/__tests__/roomManager.test.ts
```

Expected: all room creation and membership tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/rooms/roomManager.ts apps/server/src/__tests__/roomManager.test.ts
git commit -m "Add room membership and start rules"
```

---

### Task 4: Implement leave, disconnect, resume, and host transfer

**Files:**
- Modify: `apps/server/src/rooms/roomManager.ts`
- Modify: `apps/server/src/__tests__/roomManager.test.ts`

- [ ] **Step 1: Ask the Tester agent to add failing lifecycle tests**

The RED tests must cover:

- `leaveRoom` on an unknown/unbound identity succeeds as a no-op;
- lobby leave removes the human immediately;
- lobby host leave transfers to the next human without reordering `players`;
- lobby with zero humans is deleted with `room_closed:'empty_lobby'`;
- playing leave keeps the seat, marks offline, and emits `player_connection:false`;
- playing host offline transfers to the next online human;
- original host resume does not reclaim host;
- when all humans are offline, `hostId` remains; the first resume becomes host;
- resume checks room, player, bot status, and token;
- unequal token lengths safely return `INVALID_TOKEN`;
- successful resume preserves player ID and returns the room;
- expected failures use safe catalog messages, never thrown internal text.

Use the domain-event expectations explicitly:

```ts
expect(result).toMatchObject({
  ok: true,
  events: [
    { type: 'player_connection', playerId, online: false },
    { type: 'room_state', room: { hostId: nextPlayerId } },
  ],
});
```

- [ ] **Step 2: Run RED**

```bash
pnpm exec vitest run apps/server/src/__tests__/roomManager.test.ts
```

Expected: FAIL because lifecycle methods are missing.

- [ ] **Step 3: Implement lifecycle methods**

Add:

```ts
leaveRoom(roomCode: string, playerId: string): RoomSuccess<null>;
markDisconnected(roomCode: string, playerId: string): RoomResult<PublicRoomState>;
resumeRoom(roomCode: string, playerId: string, token: string): RoomResult<PublicRoomState>;
```

Use one helper to find the next online human in stable circular order. Never remove a playing seat. Do not add playing-room reclaim timers.

- [ ] **Step 4: Run GREEN**

```bash
pnpm exec vitest run apps/server/src/__tests__/roomManager.test.ts
```

Expected: lifecycle tests pass with prior room tests still green.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/rooms/roomManager.ts apps/server/src/__tests__/roomManager.test.ts
git commit -m "Add room leave and resume lifecycle"
```

---

### Task 5: Add the five-minute lobby grace period and disposal

**Files:**
- Modify: `apps/server/src/rooms/roomManager.ts`
- Modify: `apps/server/src/__tests__/roomManager.test.ts`

- [ ] **Step 1: Ask the Tester agent to add failing fake-timer tests**

Use Vitest fake timers through the injected timer functions. Cover:

```ts
vi.useFakeTimers();
manager.markDisconnected(roomCode, playerId);
await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
expect(manager.getPublicRoom(roomCode)?.players).toHaveLength(2);
await vi.advanceTimersByTimeAsync(1);
expect(manager.getPublicRoom(roomCode)?.players).toHaveLength(1);
```

Also assert:

- resume before five minutes cancels cleanup;
- timeout removes only the still-offline lobby player;
- timed-out host transfers without player reordering;
- no humans after timeout closes with `lobby_idle_timeout`;
- bot-only lobby is deleted with the room;
- `dispose()` clears every pending timer;
- no timer is scheduled for playing disconnect;
- each M1 error code now has at least one test;
- no public state or domain event contains token text.

- [ ] **Step 2: Run RED**

```bash
pnpm exec vitest run apps/server/src/__tests__/roomManager.test.ts
```

Expected: FAIL because cleanup scheduling and cancellation are missing.

- [ ] **Step 3: Implement the timer registry**

Use a per-room/player timer key:

```ts
private readonly lobbyCleanupTimers = new Map<string, unknown>();

private cleanupKey(roomCode: string, playerId: string): string {
  return `${roomCode}:${playerId}`;
}
```

Only passive lobby disconnect schedules `300_000` ms. Resume and explicit leave cancel the matching timer. Timeout code rechecks that the room is still lobby and the player is still offline before mutation. `dispose()` cancels and clears all timers.

- [ ] **Step 4: Run GREEN**

```bash
pnpm exec vitest run apps/server/src/__tests__/roomManager.test.ts
```

Expected: the full RoomManager suite passes without real waiting or open timers.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/rooms/roomManager.ts apps/server/src/__tests__/roomManager.test.ts
git commit -m "Add lobby disconnect grace period"
```

---

### Task 6: Build the typed Socket.IO adapter and create/join integration

**Files:**
- Modify: `apps/server/src/protocol.ts`
- Create: `apps/server/src/socket/roomSocketAdapter.ts`
- Create: `apps/server/src/server.ts`
- Create: `apps/server/src/__tests__/socketRooms.test.ts`

- [ ] **Step 1: Ask the Tester agent to write failing real-socket tests**

Start a real ephemeral HTTP server and connect two clients:

```ts
const running = await startTestServer();
const a = await connectClient(running.url);
const create = await emitAck(a, 'room:create', { nickname: '玩家一' });
const b = await connectClient(running.url);
const join = await emitAck(b, 'room:join', {
  roomCode: create.roomCode,
  nickname: '玩家二',
});

expect(join.ok).toBe(true);
expect(await nextRoomState(a)).toEqual(join.room);
```

Required RED assertions:

- create ack is `{ok,roomCode,playerId,token,room}`;
- join ack is `{ok,playerId,token,room}`;
- both clients receive the same authoritative `room:state` after join;
- bad payload receives `{ok:false,code:'INVALID_ROOM_ACTION',message}` without crashing;
- no `room`, broadcast, or failure ack includes another token;
- teardown disconnects clients, calls `roomManager.dispose()`, and awaits Socket.IO/HTTP close with no open handle.

- [ ] **Step 2: Run RED**

```bash
pnpm exec vitest run apps/server/src/__tests__/socketRooms.test.ts
```

Expected: FAIL because server factory and handlers do not exist.

- [ ] **Step 3: Define typed Socket.IO maps**

In `protocol.ts`, define acknowledgements and event maps such as:

```ts
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
}

export interface ResumeAck {
  room: PublicRoomState;
}

export type Ack<T extends object = Record<string, never>> =
  | ({ ok: true } & T)
  | RoomFailure;

export interface ClientToServerEvents {
  'room:create': (
    payload: { nickname: string },
    ack: (response: Ack<CreateRoomAck>) => void,
  ) => void;
  'room:join': (
    payload: { roomCode: string; nickname: string },
    ack: (response: Ack<JoinRoomAck>) => void,
  ) => void;
}

export interface ServerToClientEvents {
  'room:state': (room: PublicRoomState) => void;
  'player:connection': (change: { playerId: string; online: boolean }) => void;
  'room:closed': (payload: { reason: RoomClosedReason }) => void;
}
```

- [ ] **Step 4: Implement the server seam and create/join handlers**

`createRoomServer` accepts injected manager/client directory/logger and returns:

```ts
interface RunningRoomServer {
  httpServer: HttpServer;
  io: SocketIOServer<ClientToServerEvents, ServerToClientEvents>;
  roomManager: RoomManager;
  close(): Promise<void>;
}
```

The adapter must maintain:

```ts
Map<socketId, { roomCode: string; playerId: string }>;
Map<`${roomCode}:${playerId}`, socketId>;
```

On successful create/join, bind the socket and call `socket.join(roomCode)`. Ack first, then dispatch returned domain events. Expected manager failures map directly to safe failure ack; unknown exceptions map to `INVALID_ROOM_ACTION` with a fixed safe message.

- [ ] **Step 5: Run GREEN**

```bash
pnpm exec vitest run apps/server/src/__tests__/socketRooms.test.ts
```

Expected: create/join/broadcast/secrecy tests pass and Vitest exits cleanly.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/protocol.ts apps/server/src/socket apps/server/src/server.ts apps/server/src/__tests__/socketRooms.test.ts
git commit -m "Add typed Socket.IO room create and join"
```

---

### Task 7: Complete Socket.IO room actions and safe socket replacement

**Files:**
- Modify: `apps/server/src/protocol.ts`
- Modify: `apps/server/src/socket/roomSocketAdapter.ts`
- Modify: `apps/server/src/__tests__/socketRooms.test.ts`

- [ ] **Step 1: Ask the Tester agent to add failing full-lifecycle socket tests**

Add RED scenarios for:

- non-host `room:add_bot`, `room:remove_bot`, `room:start` returns `NOT_HOST`;
- host add bot broadcasts updated `room:state`;
- start broadcasts exactly one `room:state` with `status:'playing'`;
- `room:leave` without binding always acks `{ok:true}`;
- current socket disconnect broadcasts `player:connection {online:false}`;
- valid resume returns same player ID/room and broadcasts `{online:true}`;
- resume on a new socket replaces the old reverse binding;
- later disconnect of the replaced old socket does not emit offline or alter public state;
- playing host disconnect emits connection change and, when host changes, a room state carrying the new `hostId`;
- every failure ack contains `message`;
- no ack or event leaks token.

- [ ] **Step 2: Run RED**

```bash
pnpm exec vitest run apps/server/src/__tests__/socketRooms.test.ts
```

Expected: FAIL on missing events/handlers.

- [ ] **Step 3: Implement the remaining typed protocol handlers**

Add event map entries and handlers for:

```text
session:resume
room:add_bot
room:remove_bot
room:start
room:leave
```

Before binding a socket to a new identity, explicitly leave and unbind its previous identity. When resume replaces an old socket, remove the old reverse binding and its Socket.IO room membership without marking the player offline. A disconnect mutates the manager only when the disconnecting socket ID still equals the current reverse binding. After a successful `room:leave` ack, call `socket.leave(roomCode)` and remove both forward and reverse bindings; the RoomManager result has already emitted the lobby removal or playing offline transition, so unbinding must not trigger a second disconnect mutation.

Do not add handlers for `game:*` or `room:skip_offline_turn`.

- [ ] **Step 4: Run GREEN**

```bash
pnpm exec vitest run apps/server/src/__tests__/socketRooms.test.ts
```

Expected: all Socket.IO room lifecycle tests pass with no open handles.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/protocol.ts apps/server/src/socket/roomSocketAdapter.ts apps/server/src/__tests__/socketRooms.test.ts
git commit -m "Complete Socket.IO room lifecycle"
```

---

### Task 8: Serve the built client from the same HTTP server

**Files:**
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/__tests__/socketRooms.test.ts`

- [ ] **Step 1: Ask the Tester agent to add failing HTTP/static tests**

Use a temporary fixture directory containing `index.html` and `asset.txt`. Start `createRoomServer({clientDist: fixturePath})`, then assert:

```ts
expect(await fetch(`${url}/asset.txt`).then((r) => r.text())).toBe('asset');
expect(await fetch(`${url}/invite/room`).then((r) => r.text()))
  .toContain('<main>fixture</main>');
```

Also verify that a missing `clientDist` does not prevent Socket.IO from starting and emits only a safe warning through the injected logger.

- [ ] **Step 2: Run RED**

```bash
pnpm exec vitest run apps/server/src/__tests__/socketRooms.test.ts
```

Expected: FAIL because static serving/fallback is absent.

- [ ] **Step 3: Add `sirv` static serving**

Use:

```ts
const staticHandler = clientDistExists
  ? sirv(clientDist, { single: true, dev: false })
  : (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 503;
      res.end('Client build is unavailable. Run pnpm build.');
    };

const httpServer = createServer(staticHandler);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer);
```

Default client path when running server source:

```ts
fileURLToPath(new URL('../../client/dist/', import.meta.url));
```

Do not hand-roll MIME types or path traversal handling.

- [ ] **Step 4: Run GREEN**

```bash
pnpm exec vitest run apps/server/src/__tests__/socketRooms.test.ts
```

Expected: static asset, SPA fallback, missing-dist, and Socket.IO tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/server.ts apps/server/src/__tests__/socketRooms.test.ts
git commit -m "Serve client from the room server"
```

---

### Task 9: Implement pure LAN address selection

**Files:**
- Create: `apps/server/src/party/networkAddress.ts`
- Create: `apps/server/src/__tests__/networkAddress.test.ts`

- [ ] **Step 1: Ask the Tester agent to write failing address tests**

Use fabricated `NetworkInterfaceInfo` maps; do not read the real machine in tests. Assert:

- internal and loopback entries are excluded;
- IPv6 is excluded;
- deterministic selection sorts by interface name, then address;
- RFC1918 IPv4 (`10/8`, `172.16/12`, `192.168/16`) is preferred over other non-internal IPv4;
- localhost URL is always present;
- LAN URL is absent when no usable IPv4 exists;
- configured port is preserved.

Wished-for API:

```ts
const result = getPartyAddresses(interfaces, 3000);
expect(result).toEqual({
  localUrl: 'http://127.0.0.1:3000',
  lanUrl: 'http://192.168.1.20:3000',
});
```

- [ ] **Step 2: Run RED**

```bash
pnpm exec vitest run apps/server/src/__tests__/networkAddress.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement pure helpers**

Export:

```ts
export interface PartyAddresses {
  localUrl: string;
  lanUrl: string | null;
}

export function getPartyAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  port: number,
): PartyAddresses;
```

No `console`, `process`, QR generation, or direct `os.networkInterfaces()` call belongs in this module.

- [ ] **Step 4: Run GREEN**

```bash
pnpm exec vitest run apps/server/src/__tests__/networkAddress.test.ts
```

Expected: all address cases pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/party/networkAddress.ts apps/server/src/__tests__/networkAddress.test.ts
git commit -m "Add deterministic party address selection"
```

---

### Task 10: Add production bootstrap and `pnpm party`

**Files:**
- Replace: `apps/server/src/index.ts`
- Create: `apps/server/src/production.ts`
- Create: `scripts/party.ts`
- Create: `scripts/tsconfig.json`

- [ ] **Step 1: Implement reusable production wiring**

`production.ts` exports one reusable entry:

```ts
export interface StartedProductionServer {
  port: number;
  close(): Promise<void>;
}

export async function startProductionServer(
  requestedPort = Number(process.env.PORT ?? 3000),
): Promise<StartedProductionServer>;
```

Production dependencies use:

```ts
randomUUID();
randomBytes(32).toString('hex');
randomInt(10_000);
timingSafeEqual();
setTimeout();
clearTimeout();
```

Guard unequal token byte lengths before `timingSafeEqual`.

- [ ] **Step 2: Keep `index.ts` process-only**

`index.ts` calls `startProductionServer`, logs the local URL, and installs `SIGINT`/`SIGTERM` handlers that await `close()` before setting a successful exit code. It contains no room rules.

- [ ] **Step 3: Implement the party launcher**

Create `scripts/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022"],
    "types": ["node"]
  },
  "include": ["./*.ts"]
}
```

`scripts/party.ts` must:

```ts
import { networkInterfaces } from 'node:os';
import QRCode from 'qrcode';
import { getPartyAddresses } from '../apps/server/src/party/networkAddress';
import { startProductionServer } from '../apps/server/src/production';

const port = Number(process.env.PORT ?? 3000);
const server = await startProductionServer(port);
const addresses = getPartyAddresses(networkInterfaces(), server.port);
console.log(`本机访问：${addresses.localUrl}`);

if (addresses.lanUrl) {
  console.log(`手机访问：${addresses.lanUrl}`);
  console.log(await QRCode.toString(addresses.lanUrl, {
    type: 'terminal',
    small: true,
  }));
} else {
  console.warn('未检测到局域网 IPv4；请确认电脑已连接 Wi-Fi。');
}
```

Use these explicit relative imports from `scripts/party.ts`; do not import `@richman/server` by package name because the root package does not depend on that workspace package under pnpm's isolated linker.

It must use the already-built client from root `pnpm party`; it must not invoke pnpm recursively.

- [ ] **Step 4: Verify TypeScript and server startup**

Run:

```bash
pnpm --filter @richman/server build
pnpm exec tsc -p scripts/tsconfig.json --noEmit
pnpm typecheck
```

Expected: exit 0.

Then run a bounded manual smoke in another terminal/process:

```bash
pnpm start
```

Expected: logs `http://127.0.0.1:3000`; `curl -I http://127.0.0.1:3000` returns an HTTP response from the built client path after `pnpm build`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/index.ts apps/server/src/production.ts scripts/party.ts scripts/tsconfig.json
git commit -m "Add production and party server launchers"
```

---

### Task 11: Synchronize the protocol and milestone documentation

**Files:**
- Modify: `plan/03-架构与联机协议.md`
- Modify: `plan/05-阶段2-联机版.md`

- [ ] **Step 1: Update the protocol tables to match implemented types**

In `plan/03 §5.1`:

- change `room:create` success to `{ok, roomCode, playerId, token, room}`;
- change every room/session failure ack to `{ok:false, code, message}` or “同上” referring to that shape;
- leave `room:leave` as an always-successful `{ok}`;
- do not duplicate `room:remove_bot`, which already exists.

In `plan/03 §5.2`:

- retain the existing `room:closed` row;
- define M1 reasons as `empty_lobby | lobby_idle_timeout`;
- clarify start emits `room:state status:'playing'` and playing host changes may emit `room:state`;
- clarify `player:connection` is the playing connection-state increment.

In `plan/03 §5.3`, add:

```text
INVALID_NICKNAME · NOT_ENOUGH_PLAYERS · INVALID_ROOM_ACTION
```

- [ ] **Step 2: Record lifecycle deviations**

Append dated entries to `plan/03` for:

- create ack includes room;
- room/session failures include safe message;
- five-minute lobby disconnect grace;
- playing host-offline transfer;
- room-close reason enum;
- playing 24-hour reclaim remains M4 persistence work.

Append/retain in `plan/05`:

- `room:skip_offline_turn` is implemented in M2 with `GameState`;
- playing all-offline 24-hour reclaim belongs to M4; M1 only reclaims lobby rooms.

- [ ] **Step 3: Verify code and docs agree**

Run content checks with the repository search tool for:

```text
INVALID_NICKNAME
NOT_ENOUGH_PLAYERS
INVALID_ROOM_ACTION
lobby_idle_timeout
room:skip_offline_turn
```

Expected: protocol/runtime names match exactly; no second spelling exists.

- [ ] **Step 4: Commit**

```bash
git add plan/03-架构与联机协议.md plan/05-阶段2-联机版.md
git commit -m "Sync Phase 2 M1 room protocol"
```

---

### Task 12: Run final M1 verification, smoke the real launcher, and update README

**Files:**
- Modify after all checks pass: `README.md`
- Update ignored progress log: `.slim/deepwork/phase2-m1-room-server.md`

- [ ] **Step 1: Run the complete automated gate**

```bash
pnpm test && pnpm typecheck && pnpm exec tsc -p scripts/tsconfig.json --noEmit && pnpm validate-data && pnpm build && pnpm --filter @richman/server build
```

Expected:

- all existing 25 test files / 280 tests plus new server tests pass;
- no type errors;
- board data validation remains green;
- client build succeeds;
- server TypeScript build check succeeds.
- root party launcher typecheck succeeds.

- [ ] **Step 2: Run a production single-port smoke**

Start asynchronously:

```bash
pnpm start
```

Verify:

- `GET http://127.0.0.1:3000/` returns the built client;
- a real Socket.IO client can create a room, a second can join, host adds a bot, start broadcasts `playing`, disconnect broadcasts offline, and resume restores the same player;
- terminate the server gracefully; no process remains.

Record exact observed output in the deepwork log.

- [ ] **Step 3: Run the party launcher smoke**

```bash
pnpm party
```

Verify the terminal prints:

- localhost URL;
- LAN URL when a LAN IPv4 exists, otherwise the explicit Wi-Fi guidance;
- a terminal QR when LAN URL exists;
- the same single-port client page is reachable.

Stop the process gracefully.

- [ ] **Step 4: Request independent code review**

Ask a reviewer to inspect the complete M1 diff against:

```text
docs/superpowers/specs/2026-07-10-phase2-m1-room-server-design.md
plan/03-架构与联机协议.md
plan/05-阶段2-联机版.md M1
```

Fix every Critical and Important finding, then rerun Steps 1–3 if behavior changed.

- [ ] **Step 5: Update README only after evidence exists**

Change the Phase 2 line to state that M1 server/room/party infrastructure is complete and M2 engine integration is next. Do not claim the online game is playable yet.

- [ ] **Step 6: Commit final evidence state**

```bash
git add README.md
git commit -m "Mark Phase 2 M1 room server complete"
```

- [ ] **Step 7: Final status check**

```bash
git status --short
git log --oneline -12
```

Expected: clean worktree and an M1 commit sequence matching Tasks 1–12.

---

## Explicit non-goals

The implementation must stop before:

- creating `GameState` or calling `applyIntent`;
- registering `game:intent`, `game:events`, or `game:snapshot`;
- implementing `room:skip_offline_turn`;
- writing JSON saves or restoring playing rooms;
- adding client create/join/lobby UI;
- adding Playwright;
- adding playing-room 24-hour reclaim;
- updating README to claim Phase 2 as complete.
