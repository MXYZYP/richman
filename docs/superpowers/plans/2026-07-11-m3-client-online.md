# M3 Client Online Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a production-tested Vue client with create/join/local entry points, a live room lobby, a shared local/online game screen, authoritative per-transition synchronization, and safe disconnect/resume behavior.

**Architecture:** Add a shared `@richman/protocol` package, then harden the server contract with idempotent create/join requests, per-transition public snapshots, and a resumable public takeover lock. Refactor the existing local `ClientGame` presentation logic behind `GameSession`, add one long-lived `OnlineSession` that owns the Socket.IO connection from the home screen onward, and drive simple explicit Vue page states without adding a router or second store.

**Tech Stack:** TypeScript 5.4, Vue 3.4 Composition API, Socket.IO 4.8, Vitest 1.6, pnpm workspaces, qrcode, existing `@richman/engine` and `@richman/board-data`.

**Source of truth:** `docs/superpowers/specs/2026-07-11-m3-client-online-design.md` and `plan/03-架构与联机协议.md` at commit `ba5bef2`.

---

## File map

### Shared protocol

- Create `packages/protocol/package.json` — workspace package metadata and `@richman/engine` type dependency.
- Create `packages/protocol/tsconfig.json` — TypeScript project settings.
- Create `packages/protocol/src/index.ts` — public room, ack, request payload, public snapshot, and Socket.IO event contracts.
- Create `apps/server/src/publicGameSnapshot.ts` — server-only secure `GameState` projection.
- Remove `apps/server/src/protocol.ts` after all imports move to the shared package; leave no compatibility re-export.

### Server behavior

- Modify `apps/server/src/rooms/roomTypes.ts` — private request IDs and public takeover projection inputs.
- Modify `apps/server/src/rooms/roomManager.ts` — create/join idempotency, takeover public state, per-transition snapshot events.
- Modify `apps/server/src/socket/roomSocketAdapter.ts` — typed new payloads and unchanged event-before-ack ordering.
- Modify focused tests under `apps/server/src/__tests__/` — real Socket.IO and RoomManager regression coverage.

### Client session layer

- Create `apps/client/src/session/gameSession.ts` — shared session/view contracts and permission selectors.
- Create `apps/client/src/session/sessionStorage.ts` — validated active/pending localStorage records.
- Create `apps/client/src/session/invitation.ts` — canonical invite URL and room query parsing.
- Create `apps/client/src/session/gamePresenter.ts` — event animation queue, snapshot reset, and presence overlay.
- Create `apps/client/src/session/localSession.ts` — browser engine host and local BOT behavior.
- Create `apps/client/src/session/onlineSession.ts` — single Socket.IO owner for create/join/lobby/game/reconnect/leave.
- Add co-located tests for each non-visual session module.

### Vue views

- Create `apps/client/src/views/RestoreView.vue` — startup/reconnect transition and retry/home controls.
- Create `apps/client/src/views/HomeView.vue` — create/join/local entry points and pending-session return.
- Create `apps/client/src/views/LobbyView.vue` — room code, invitation, player list, BOT/start/leave controls.
- Create `apps/client/src/views/GameView.vue` — existing board/panels composed around `GameSession`.
- Modify `apps/client/src/App.vue` — finite page-state orchestration only.
- Modify `apps/client/src/style.css` and focused existing components only where online states require visible controls/markers.

---

### Task 1: Extract one shared protocol package

**Files:**
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/protocol/src/index.ts`
- Create: `apps/server/src/publicGameSnapshot.ts`
- Modify: `apps/server/package.json`
- Modify: `apps/client/package.json`
- Modify: every server import currently targeting `apps/server/src/protocol.ts`
- Remove: `apps/server/src/protocol.ts`
- Test: existing server tests and workspace typecheck

- [ ] **Step 1: Record the current protocol consumers before editing**

Use LSP references on each exported symbol in `apps/server/src/protocol.ts`: `PublicGameSnapshot`, `PublicRoomState`, `Ack`, `ClientToServerEvents`, and `ServerToClientEvents`. The migration list must include server runtime, server tests, room types, and Socket.IO adapter; do not use a compatibility barrel as a shortcut.

- [ ] **Step 2: Create the workspace package**

`packages/protocol/package.json`:

```json
{
  "name": "@richman/protocol",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@richman/engine": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.4.0"
  }
}
```

`packages/protocol/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Move the current wire types without changing behavior**

Create `packages/protocol/src/index.ts` with the current M2 types. At this task boundary, keep the existing create/join payloads and current `PublicRoomState`; Tasks 2 and 4 extend them under focused RED tests. Include only wire contracts:

```ts
import type { GameEvent, GameState, Intent } from '@richman/engine';

export type PublicGameSnapshot = Omit<GameState, 'seed' | 'decks'> & {
  deckCounts: { chance: number; destiny: number };
};

export type RoomStatus = 'lobby' | 'playing' | 'ended';
export interface PublicRoomPlayer {
  id: string;
  nickname: string;
  isBot: boolean;
  online: boolean;
}
export interface PublicRoomState {
  roomCode: string;
  status: RoomStatus;
  hostId: string;
  players: PublicRoomPlayer[];
}
export type Ack<TSuccess extends object> =
  | (string extends keyof TSuccess ? { ok: true } : { ok: true } & TSuccess)
  | { ok: false; code: string; message: string };

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
  snapshot?: PublicGameSnapshot;
}

export interface ClientToServerEvents {
  'session:resume': (
    payload: { roomCode: string; playerId: string; token: string },
    ack: (response: Ack<ResumeAck>) => void,
  ) => void;
  'room:create': (payload: { nickname: string }, ack: (response: Ack<CreateRoomAck>) => void) => void;
  'room:join': (
    payload: { roomCode: string; nickname: string },
    ack: (response: Ack<JoinRoomAck>) => void,
  ) => void;
  'room:add_bot': (ack: (response: Ack<Record<string, never>>) => void) => void;
  'room:remove_bot': (
    payload: { playerId: string },
    ack: (response: Ack<Record<string, never>>) => void,
  ) => void;
  'room:start': (ack: (response: Ack<Record<string, never>>) => void) => void;
  'room:leave': (ack: (response: Ack<Record<string, never>>) => void) => void;
  'game:intent': (
    payload: { intent: Intent },
    ack: (response: Ack<Record<string, never>>) => void,
  ) => void;
  'room:skip_offline_turn': (ack: (response: Ack<Record<string, never>>) => void) => void;
}

export interface ServerToClientEvents {
  'room:state': (room: PublicRoomState) => void;
  'player:connection': (change: { playerId: string; online: boolean }) => void;
  'room:closed': (payload: { reason: 'empty_lobby' | 'lobby_idle_timeout' }) => void;
  'game:events': (payload: { events: GameEvent[] }) => void;
  'game:snapshot': (payload: { state: PublicGameSnapshot }) => void;
}

export interface InterServerEvents {}
export interface SocketData {
  roomCode?: string;
  playerId?: string;
}
```

- [ ] **Step 4: Keep secure projection server-only**

Create `apps/server/src/publicGameSnapshot.ts`:

```ts
import type { GameState } from '@richman/engine';
import type { PublicGameSnapshot } from '@richman/protocol';

export function toPublicGameSnapshot(state: GameState): PublicGameSnapshot {
  const { seed: _seed, decks, ...publicState } = state;
  return {
    ...publicState,
    deckCounts: {
      chance: decks.chance.length,
      destiny: decks.destiny.length,
    },
  };
}
```

- [ ] **Step 5: Migrate every consumer and delete the old file**

Add `@richman/protocol: "workspace:*"` to both app package manifests. Import wire types from `@richman/protocol`; import `toPublicGameSnapshot` only from `../publicGameSnapshot` or its correct relative path. Remove `apps/server/src/protocol.ts` after LSP references show no callers.

- [ ] **Step 6: Refresh workspace links and verify the refactor**

Run:

```text
pnpm install --frozen-lockfile
pnpm exec vitest run apps/server/src/__tests__/socketRooms.test.ts apps/server/src/__tests__/socketGame.test.ts apps/server/src/__tests__/socketGameReconnect.test.ts
pnpm typecheck
```

Expected: the focused Socket.IO files pass with their existing counts; workspace typecheck passes; lockfile changes only add the new workspace package edges.

- [ ] **Step 7: Commit**

```text
git add packages/protocol apps/server apps/client/package.json pnpm-lock.yaml
git commit -m "refactor(protocol): share Socket.IO contracts"
```

---

### Task 2: Make create and join idempotent

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `apps/server/src/rooms/roomTypes.ts`
- Modify: `apps/server/src/rooms/roomManager.ts`
- Modify: `apps/server/src/socket/roomSocketAdapter.ts`
- Test: `apps/server/src/__tests__/roomManager.test.ts`
- Test: `apps/server/src/__tests__/socketRooms.test.ts`

- [ ] **Step 1: Write RoomManager RED tests**

Add tests that call create/join twice with the same request ID and normalized payload, then assert the exact same room/player/token returns and player counts do not grow. Add a mismatch test:

```ts
const first = manager.createRoom('房主', '00112233445566778899aabbccddeeff');
const replay = manager.createRoom('房主', '00112233445566778899aabbccddeeff');
expect(replay).toEqual(first);
expect(manager.getPublicRoom('0007')?.players).toHaveLength(1);

const mismatch = manager.createRoom('另一个昵称', '00112233445566778899aabbccddeeff');
expect(mismatch).toMatchObject({ ok: false, code: 'INVALID_ROOM_ACTION' });
```

For join, replay after the room has advanced to `playing` and assert it still returns the original success instead of `GAME_ALREADY_STARTED`.

- [ ] **Step 2: Write real Socket.IO dropped-ack RED tests**

In `socketRooms.test.ts`, emit `room:create` or `room:join` with a fixed request ID, intentionally ignore the first callback, then retry from a replacement socket. Assert the retry returns the original token and no duplicate public player exists.

- [ ] **Step 3: Run RED tests**

Run:

```text
pnpm exec vitest run apps/server/src/__tests__/roomManager.test.ts apps/server/src/__tests__/socketRooms.test.ts
```

Expected: compile/test failure because payloads and RoomManager methods do not accept `requestId`, or because retries currently create duplicates/reject the nickname.

- [ ] **Step 4: Extend shared payloads and private room records**

Use explicit payload types:

```ts
export interface CreateRoomPayload {
  nickname: string;
  requestId: string;
}
export interface JoinRoomPayload {
  roomCode: string;
  nickname: string;
  requestId: string;
}
```

Add private request metadata to room/player records, never to `PublicRoomState`:

```ts
interface RoomPlayer extends PublicRoomPlayer {
  token: string | null;
  joinRequestId: string | null;
  joinRequestNickname: string | null;
}

interface Room {
  code: string;
  status: RoomStatus;
  hostId: string;
  players: RoomPlayer[];
  gameState: GameState | null;
  createRequestId: string;
  createRequestNickname: string;
}
```

Do not add request IDs to public projection or logs.

- [ ] **Step 5: Replay before normal create/join validation**

Create uses a manager-level request index pointing to the existing room code; join searches the target room's private players. Replay only when operation, request ID, normalized nickname, and room code match. Return `INVALID_ROOM_ACTION` on request-ID reuse with a different payload. Return the original stored token in the success ack. Remove the create request index entry on every room-deletion path and in `dispose()`; add a test that deleting a room releases the old request ID instead of replaying a dead room.

- [ ] **Step 6: Verify GREEN and token privacy**

Run:

```text
pnpm exec vitest run apps/server/src/__tests__/roomManager.test.ts apps/server/src/__tests__/socketRooms.test.ts
pnpm --filter @richman/server build
```

Expected: replay tests pass, public room JSON contains no request IDs or tokens, server typecheck passes.

- [ ] **Step 7: Commit**

```text
git add packages/protocol/src/index.ts apps/server/src/rooms apps/server/src/socket apps/server/src/__tests__/roomManager.test.ts apps/server/src/__tests__/socketRooms.test.ts
git commit -m "feat(server): make room entry idempotent"
```

---

### Task 3: Broadcast a public snapshot after every transition

**Files:**
- Modify: `apps/server/src/rooms/roomManager.ts`
- Test: `apps/server/src/__tests__/roomGame.test.ts`
- Test: `apps/server/src/__tests__/socketGame.test.ts`
- Test: `apps/server/src/__tests__/socketGameReconnect.test.ts`

- [ ] **Step 1: Write manager RED tests for intermediate phases**

Choose deterministic transitions that do not end a turn, such as `roll_dice` reaching `awaiting_buy_decision`, `buy_property`, and `build_house`. For each successful result assert exactly:

```ts
expect(result.events.map((event) => event.type)).toEqual([
  'game_events',
  'game_snapshot',
]);
expect(result.events[1]).toMatchObject({
  type: 'game_snapshot',
  state: expect.objectContaining({ turnPhase: expectedTurnPhase }),
});
```

Keep the domain event snapshot as complete internal `GameState`; projection remains at Socket.IO egress.

- [ ] **Step 2: Write real Socket.IO RED assertions**

For one normal human intent, one BOT timer transition, and one offline-takeover timer transition, collect ordered messages and assert:

```ts
expect(messages.map((message) => message.type)).toEqual(['events', 'snapshot', 'ack']);
expectPublicGameSnapshot(messages[1].state, authoritativeState);
```

For automated transitions there is no client ack, so assert `['events', 'snapshot']`. Preserve the existing assertion that the initial and resume snapshots do not leak `seed` or `decks`.

- [ ] **Step 3: Run RED tests**

```text
pnpm exec vitest run apps/server/src/__tests__/roomGame.test.ts apps/server/src/__tests__/socketGame.test.ts apps/server/src/__tests__/socketGameReconnect.test.ts
```

Expected: intermediate transitions have only `game_events`, so the new snapshot assertions fail.

- [ ] **Step 4: Change the transition boundary once**

In the single RoomManager transition assembly path, always append:

```ts
const domainEvents: RoomDomainEvent[] = [
  { type: 'game_events', roomCode: room.code, events: transition.events },
  { type: 'game_snapshot', roomCode: room.code, state: transition.state },
];
```

Do not special-case human/BOT/takeover callers. Remove the old `turn_ended`/game-over snapshot condition. Keep `room:skip_offline_turn` itself unchanged because it schedules automation without a game transition.

- [ ] **Step 5: Verify GREEN and serialization safety**

```text
pnpm exec vitest run apps/server/src/__tests__/roomGame.test.ts apps/server/src/__tests__/socketGame.test.ts apps/server/src/__tests__/socketGameReconnect.test.ts
pnpm --filter @richman/server build
```

Expected: every transition ordering assertion passes; public snapshot security assertions still reject `seed` and `decks`.

- [ ] **Step 6: Commit**

```text
git add apps/server/src/rooms/roomManager.ts apps/server/src/__tests__/roomGame.test.ts apps/server/src/__tests__/socketGame.test.ts apps/server/src/__tests__/socketGameReconnect.test.ts
git commit -m "feat(server): snapshot every game transition"
```

---

### Task 4: Publish and preserve the offline takeover lock

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `apps/server/src/rooms/roomManager.ts`
- Modify: `apps/server/src/rooms/roomTypes.ts` if projection needs a private helper input
- Test: `apps/server/src/__tests__/roomGame.test.ts`
- Test: `apps/server/src/__tests__/socketGameReconnect.test.ts`

- [ ] **Step 1: Write RED tests for the public lock lifecycle**

Cover all transitions:

```ts
expect(manager.getPublicRoom('0007')?.takeoverPlayerId).toBeNull();
const requested = manager.requestSkipOfflineTurn('0007', hostId);
expect(requested.events).toContainEqual(expect.objectContaining({
  type: 'room_state',
  room: expect.objectContaining({ takeoverPlayerId: actorId }),
}));
expect(manager.getPublicRoom('0007')?.takeoverPlayerId).toBe(actorId);
```

After the automated turn completes or enters debt, assert `takeoverPlayerId` returns to `null` and a `room_state` event announces the clear. Resume during the scheduled interval must include the same actor ID.

- [ ] **Step 2: Add the reconnect lock RED test over real sockets**

Disconnect the actor, request takeover, reconnect before firing the timer, and assert:

```ts
expect(resume.ok && resume.room.takeoverPlayerId).toBe(actorId);
expect(await emitGameIntent(resumed, { type: 'roll_dice' })).toMatchObject({
  ok: false,
  code: 'INVALID_ROOM_ACTION',
});
```

Then fire automation, receive the clearing `room:state`, and assert its field is `null`.

- [ ] **Step 3: Run RED tests**

```text
pnpm exec vitest run apps/server/src/__tests__/roomGame.test.ts apps/server/src/__tests__/socketGameReconnect.test.ts
```

Expected: shared/public room type lacks `takeoverPlayerId`, or no room-state events announce schedule/clear.

- [ ] **Step 4: Implement one public projection rule**

Extend the shared type:

```ts
export interface PublicRoomState {
  roomCode: string;
  status: RoomStatus;
  hostId: string;
  players: PublicRoomPlayer[];
  takeoverPlayerId: string | null;
}
```

Project the value from the manager's private automation record only when `mode === 'offline_takeover'`. BOT automation must remain `null`. Emit a `room_state` domain event immediately after scheduling and immediately after any path that clears an offline takeover.

- [ ] **Step 5: Keep debt ineligible**

Preserve and test the server guard:

```ts
if (state.debt !== null) {
  return roomFailure('INVALID_ROOM_ACTION', 'An offline debtor must reconnect to resolve debt.');
}
```

Do not let the public field make debt automation appear supported.

- [ ] **Step 6: Verify GREEN**

```text
pnpm exec vitest run apps/server/src/__tests__/roomGame.test.ts apps/server/src/__tests__/socketGameReconnect.test.ts apps/server/src/__tests__/socketRooms.test.ts
pnpm typecheck
```

Expected: lifecycle and resume tests pass; every public room fixture includes explicit `takeoverPlayerId: null` when idle.

- [ ] **Step 7: Commit**

```text
git add packages/protocol/src/index.ts apps/server/src/rooms apps/server/src/__tests__
git commit -m "feat(server): expose offline takeover state"
```

---

### Task 5: Add safe session storage and invitation utilities

**Files:**
- Modify: `apps/client/package.json`
- Create: `apps/client/src/session/sessionStorage.ts`
- Create: `apps/client/src/session/sessionStorage.test.ts`
- Create: `apps/client/src/session/invitation.ts`
- Create: `apps/client/src/session/invitation.test.ts`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Write session-storage RED tests with an in-memory Storage implementation**

Test validated active records, pending records, corrupt JSON cleanup, and ordering:

```ts
const storage = createMemoryStorage();
const pending = {
  operation: 'join' as const,
  requestId: '0123456789abcdef0123456789abcdef',
  nickname: '小王',
  roomCode: '1234',
};
writePendingRoomRequest(storage, pending);
expect(readPendingRoomRequest(storage)).toEqual(pending);
commitOnlineSession(storage, {
  roomCode: '1234',
  playerId: 'player-2',
  token: 'secret-token',
});
expect(readStoredOnlineSession(storage)).toEqual({
  roomCode: '1234',
  playerId: 'player-2',
  token: 'secret-token',
});
expect(readPendingRoomRequest(storage)).toBeNull();
```

A failed/absent ack never calls `commitOnlineSession`, so pending remains.

- [ ] **Step 2: Write invitation RED tests**

```ts
expect(createInvitationUrl(new URL('https://game.test/?room=9999'), '1234').href)
  .toBe('https://game.test/?room=1234');
expect(parseInvitedRoomCode(new URL('https://game.test/?room=12%2034'))).toBe('1234');
expect(createInvitationUrl(new URL('https://game.test/'), '1234').href)
  .not.toMatch(/token|playerId|requestId|nickname/i);
```

Also inject a QR encoder spy and assert the exact string passed to it equals the canonical invitation URL.

- [ ] **Step 3: Run RED tests**

```text
pnpm exec vitest run apps/client/src/session/sessionStorage.test.ts apps/client/src/session/invitation.test.ts
```

Expected: modules do not exist.

- [ ] **Step 4: Implement strict schemas without a new validation library**

Use narrow type guards and two keys:

```ts
export const ACTIVE_SESSION_KEY = 'richman_session';
export const PENDING_ROOM_REQUEST_KEY = 'richman_pending_room_request';

export interface StoredOnlineSession {
  roomCode: string;
  playerId: string;
  token: string;
}

export interface PendingRoomRequest {
  operation: 'create' | 'join';
  requestId: string;
  nickname: string;
  roomCode?: string;
}
```

Reject unknown shapes, non-four-digit room codes where required, empty IDs/tokens, and request IDs outside the chosen 32-hex-character format. On parse failure, remove only the corrupt key.

- [ ] **Step 5: Implement canonical invitation generation**

Construct from `URL`, clear unrelated query and fragment, then set only `room`:

```ts
export function createInvitationUrl(current: URL, roomCode: string): URL {
  const invited = new URL(current.origin + current.pathname);
  invited.searchParams.set('room', roomCode);
  return invited;
}
```

Keep QR generation behind a function receiving the exact URL string so its payload is testable.

- [ ] **Step 6: Add only required client dependencies and verify**

Add versions already present in the lockfile/repository:

```json
"socket.io-client": "^4.8.1",
"qrcode": "^1.5.4"
```

and dev dependency `@types/qrcode: "^1.5.5"`. Run:

```text
pnpm install
pnpm exec vitest run apps/client/src/session/sessionStorage.test.ts apps/client/src/session/invitation.test.ts
pnpm --filter @richman/client build
```

Expected: focused tests and client build pass; no unrelated upgrades in `pnpm-lock.yaml`.

- [ ] **Step 7: Commit**

```text
git add apps/client/package.json apps/client/src/session pnpm-lock.yaml
git commit -m "feat(client): persist online room sessions safely"
```

---

### Task 6: Extract the shared presenter and LocalSession

**Files:**
- Create: `apps/client/src/session/gameSession.ts`
- Create: `apps/client/src/session/gamePresenter.ts`
- Create: `apps/client/src/session/gamePresenter.test.ts`
- Create: `apps/client/src/session/localSession.ts`
- Modify: `apps/client/src/game/clientGame.ts`
- Modify: `apps/client/src/game/clientGame.test.ts`
- Modify: `apps/client/src/App.vue` only enough to keep the local app compiling

- [ ] **Step 1: Characterize current local behavior before refactoring**

Add/retain focused tests for one human turn, movement animation, card display, BOT continuation, debt actions, and game over. Add a contract assertion that the new local session exposes:

```ts
const session = createLocalSession({ wait: async () => undefined });
expect(session.mode).toBe('local');
expect(session.room.value).toBeNull();
expect(session.localPlayerId.value).toBeNull();
expect(session.connectionStatus.value).toBe('local');
```

- [ ] **Step 2: Run the new contract test RED**

```text
pnpm exec vitest run apps/client/src/game/clientGame.test.ts
```

Expected: `createLocalSession` and shared contract do not exist.

- [ ] **Step 3: Define display-safe types and permissions**

`gameSession.ts` exports:

```ts
export type RenderableGameState = Omit<GameState, 'seed' | 'decks'>;
export type ConnectionStatus = 'local' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface GameSession {
  readonly mode: 'local' | 'online';
  readonly state: ShallowRef<RenderableGameState | null>;
  readonly room: ShallowRef<PublicRoomState | null>;
  readonly localPlayerId: Ref<string | null>;
  readonly connectionStatus: Ref<ConnectionStatus>;
  readonly displayPositions: Ref<Record<string, number>>;
  readonly dice: Ref<number[] | null>;
  readonly activeCard: Ref<DisplayCard | null>;
  readonly eventMessage: Ref<string>;
  readonly isAnimating: Ref<boolean>;
  readonly isBotThinking: Ref<boolean>;
  readonly lastError: Ref<string | null>;
  readonly availableActions: ComputedRef<ClientAction[]>;
  sendIntent(intent: Intent): Promise<void>;
  skipOfflineTurn(): Promise<void>;
  leave(): Promise<void>;
  dispose(): void;
}
```

Move display-only helpers in `clientGame.ts` to accept `RenderableGameState`, not `GameState` casts.

- [ ] **Step 4: Extract one presenter**

`gamePresenter.ts` owns display positions, dice, active card, event message, animation state, queue cancellation generation, and `playEvents(events, finalState)`. It does not call `applyIntent`, emit sockets, or choose BOT intents.

Core reset invariant:

```ts
function reset(snapshot: RenderableGameState): void {
  generation += 1;
  state.value = snapshot;
  displayPositions.value = Object.fromEntries(
    snapshot.players.map((player) => [player.id, player.position]),
  );
  isAnimating.value = false;
  activeCard.value = null;
}
```

Every awaited animation step checks its captured generation before writing again.

- [ ] **Step 5: Build LocalSession around the existing engine host**

Move `applyIntent`, `chooseBotIntent`, local seed creation, and BOT timers into `localSession.ts`. After a successful engine transition, pass its events and full next state to the presenter. `skipOfflineTurn` returns a clear local-mode error; `leave` disposes without network effects.

- [ ] **Step 6: Verify no local regression**

```text
pnpm exec vitest run apps/client/src/game/clientGame.test.ts apps/client/src/session/gamePresenter.test.ts
pnpm --filter @richman/client build
```

Expected: all former local-game contracts pass through `LocalSession`; App still starts and plays local mode.

- [ ] **Step 7: Commit**

```text
git add apps/client/src/session apps/client/src/game apps/client/src/App.vue
git commit -m "refactor(client): separate game presentation from local rules"
```

---

### Task 7: Implement the long-lived OnlineSession room lifecycle

**Files:**
- Create: `apps/client/src/session/onlineSession.ts`
- Create: `apps/client/src/session/onlineSession.test.ts` — deterministic transport/state edge cases
- Create: `apps/server/src/__tests__/clientOnlineSession.test.ts` — real `createRoomServer` + real `socket.io-client` integration
- Modify: `apps/client/src/session/gameSession.ts`
- [ ] **Step 1: Write real-socket RED tests for listener ownership**

In `apps/server/src/__tests__/clientOnlineSession.test.ts`, construct `OnlineSession` before create/join, then assert:

```ts
const session = createOnlineSession({ url: running.url, storage });
await session.createRoom('房主');
expect(session.room.value).toMatchObject({ roomCode: '0007', status: 'lobby' });
expect(session.localPlayerId.value).toBe('player-host');
expect(readStoredOnlineSession(storage)?.token).toBe('token-host');
```

Start the room and assert an opening snapshot emitted before `room:start` ack is still captured:

```ts
await session.startRoom();
expect(session.state.value?.phase).toBe('playing');
```

Do not replace the real Socket.IO exchange with direct callback invocation.

- [ ] **Step 2: Add idempotent create/join client RED tests**

Use a test socket/server hook that drops the first ack after the server commits. Assert pending storage retains one request ID and retry returns the original token/player. Verify `crypto.getRandomValues`-backed request IDs are generated once per new form submission, not once per retry.

- [ ] **Step 3: Run RED tests**

```text
pnpm exec vitest run apps/client/src/session/onlineSession.test.ts apps/server/src/__tests__/clientOnlineSession.test.ts
```

Expected: module does not exist.

- [ ] **Step 4: Register every listener in the constructor/factory**

Before any command can emit, register:

```ts
socket.on('room:state', handleRoomState);
socket.on('player:connection', handlePlayerConnection);
socket.on('room:closed', handleRoomClosed);
socket.on('game:events', handleGameEvents);
socket.on('game:snapshot', handleGameSnapshot);
socket.on('connect', handleConnect);
socket.on('disconnect', handleDisconnect);
```

All handlers capture a session generation and no-op after `dispose()`.

- [ ] **Step 5: Implement typed ack timeout and one in-flight command per operation**

Use a single helper that always clears its timer:

```ts
function withAckTimeout<T>(register: (resolve: (value: T) => void) => void, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => reject(new Error('ACK_TIMEOUT')), timeoutMs);
    register((value) => {
      globalThis.clearTimeout(timeout);
      resolve(value);
    });
  });
}
```

Use operation flags for create/join/start/add/remove/leave/intent. Never include token or request ID in error messages.

- [ ] **Step 6: Implement create/join/resume storage ordering**

Write pending before emit. On success, write active session first, then remove pending. On timeout, retain pending. On permanent resume errors (`INVALID_TOKEN`, `ROOM_NOT_FOUND`), clear active credentials; on transport timeout retain them.

- [ ] **Step 7: Verify GREEN**

```text
pnpm exec vitest run apps/client/src/session/onlineSession.test.ts apps/server/src/__tests__/clientOnlineSession.test.ts apps/server/src/__tests__/socketRooms.test.ts
pnpm typecheck
```

Expected: real create/join/start and dropped-ack recovery pass; deterministic transport tests pass; no listener misses the opening snapshot.

- [ ] **Step 8: Commit**

```text
git add apps/client/src/session apps/server/src/__tests__/clientOnlineSession.test.ts
git commit -m "feat(client): add authoritative online room session"
```

---

### Task 8: Add online animation, presence, reconnect, takeover, and leave behavior

**Files:**
- Modify: `apps/client/src/session/gamePresenter.ts`
- Modify: `apps/client/src/session/onlineSession.ts`
- Modify: `apps/client/src/session/gameSession.ts`
- Test: `apps/client/src/session/gamePresenter.test.ts`
- Test: `apps/client/src/session/onlineSession.test.ts`
- Test: `apps/server/src/__tests__/clientOnlineSession.test.ts`

- [ ] **Step 1: Write event/snapshot pairing RED tests**

Deliver two transitions while the first animation wait is blocked. Assert each event batch pairs with the immediately following snapshot and the second waits behind the first. Deliver a standalone resume snapshot and assert it cancels both old batches.

```ts
transport.deliverEvents(firstEvents);
transport.deliverSnapshot(firstSnapshot);
transport.deliverEvents(secondEvents);
transport.deliverSnapshot(secondSnapshot);
expect(presenter.state.value).toEqual(firstSnapshot);
releaseFirstAnimation();
await flushPromises();
expect(presenter.state.value).toEqual(secondSnapshot);
```

Use controlled deferred waits, never real sleeps.

- [ ] **Step 2: Write presence-overlay RED test**

While an older snapshot waits in the animation queue, deliver `player:connection {online:false}`. After the snapshot applies, assert the rendered player remains offline:

```ts
expect(session.state.value?.players.find((player) => player.id === actorId)?.online).toBe(false);
```

- [ ] **Step 3: Write reconnect/takeover RED tests**

Disconnect and assert status becomes `reconnecting` and actions are empty. Reconnect and assert `session:resume` is emitted. Return a room with `takeoverPlayerId === localPlayerId`; assert manual actions stay empty and the message is “房主托管正在执行”. Clear the field via `room:state`; only then may normal permission return.

Also assert debt disables the host takeover command and exposes “需要 ×× 回来处理债务”.

- [ ] **Step 4: Write irreversible leave RED tests**

Use deterministic unit coverage for timeout/error storage ordering and real Socket.IO integration for the server-visible seat result. For lobby, playing, and ended states:

```ts
await expect(session.leave()).rejects.toThrow('ACK_TIMEOUT');
expect(readStoredOnlineSession(storage)).not.toBeNull();

server.replyToLeave({ ok: true });
await session.leave();
expect(readStoredOnlineSession(storage)).toBeNull();
```

On playing/ended success, the real integration test inspects server public room and asserts the seat still exists with `online:false`.

- [ ] **Step 5: Run RED tests**

```text
pnpm exec vitest run apps/client/src/session/gamePresenter.test.ts apps/client/src/session/onlineSession.test.ts apps/server/src/__tests__/clientOnlineSession.test.ts
```

Expected: queue pairing, presence overlay, reconnect lock, or leave ordering assertions fail.

- [ ] **Step 6: Implement one presence authority**

Keep the latest room state separately. Before exposing any snapshot, overlay online flags:

```ts
function withCurrentPresence(
  snapshot: RenderableGameState,
  room: PublicRoomState | null,
): RenderableGameState {
  if (room === null) return snapshot;
  const onlineById = new Map(room.players.map((player) => [player.id, player.online]));
  return {
    ...snapshot,
    players: snapshot.players.map((player) => ({
      ...player,
      online: onlineById.get(player.id) ?? player.online,
    })),
  };
}
```

Reapply this projection whenever room presence or game snapshot changes.

- [ ] **Step 7: Implement permission and takeover selectors**

The active actor is debtor or current player. Online actions require: connected, not animating, local player equals active actor, actor online, actor is not BOT, and `room.takeoverPlayerId !== localPlayerId`. `skipOfflineTurn` requires: local player is current host, active actor is an offline human, `debt === null`, and `takeoverPlayerId === null`.

- [ ] **Step 8: Implement reconnect reset, ack-loss reconciliation, and safe leave**

On disconnect, set `reconnecting` and clear actionable UI. On connect with stored credentials, call resume; on success call `presenter.reset(snapshot)` and retain takeover lock. For one in-flight intent, treat the authoritative snapshot received after its emit as successful state reconciliation even if the later ack times out; do not overwrite the updated board with a false “operation failed” message. Likewise, an opening room state plus snapshot remains authoritative if the start ack is lost. `leave()` clears storage only after success ack. Dispose removes every named handler and disconnects the socket.

- [ ] **Step 9: Verify GREEN**

```text
pnpm exec vitest run apps/client/src/session/gamePresenter.test.ts apps/client/src/session/onlineSession.test.ts apps/server/src/__tests__/clientOnlineSession.test.ts
pnpm --filter @richman/client build
```

Expected: all deterministic queue, presence, reconnect, takeover, debt, ack-loss, and leave tests pass, including real socket behavior.

- [ ] **Step 10: Commit**

```text
git add apps/client/src/session
git commit -m "feat(client): synchronize online game sessions"
```

---

### Task 9: Build the restore transition and three-entry home

**Files:**
- Create: `apps/client/src/views/RestoreView.vue`
- Create: `apps/client/src/views/HomeView.vue`
- Modify: `apps/client/src/App.vue`
- Modify: `apps/client/src/style.css`
- Test: add pure page-state tests in `apps/client/src/session/appFlow.test.ts`

- [ ] **Step 1: Extract and test the page-state reducer RED**

Create a pure transition function used by `App.vue`:

```ts
export type AppPage = 'restoring' | 'home' | 'local_setup' | 'lobby' | 'game' | 'settlement';

expect(resolvePage({ storedSession: true, room: null, game: null })).toBe('restoring');
expect(resolvePage({ storedSession: false, room: null, game: null })).toBe('home');
expect(resolvePage({ storedSession: true, room: lobbyRoom, game: null })).toBe('lobby');
expect(resolvePage({ storedSession: true, room: playingRoom, game: snapshot })).toBe('game');
expect(resolvePage({ storedSession: true, room: endedRoom, game: snapshot })).toBe('settlement');
```

Test temporary restore failure preserves storage and permanent failure clears it through the session owner.

- [ ] **Step 2: Run RED test**

```text
pnpm exec vitest run apps/client/src/session/appFlow.test.ts
```

Expected: reducer/module does not exist.

- [ ] **Step 3: Implement `RestoreView.vue`**

Props/events:

```ts
const props = defineProps<{
  message: string;
  canRetry: boolean;
}>();
const emit = defineEmits<{
  retry: [];
  home: [];
}>();
```

Render an accessible status heading, current message, retry button when allowed, and “暂不恢复” home action. Do not display room token or raw server error objects.

- [ ] **Step 4: Implement `HomeView.vue`**

Expose create nickname, join nickname/room code, local entry, and optional “回到上一局”. Normalize room code to four digits and disable duplicate submissions using parent-provided pending state. Events:

```ts
const emit = defineEmits<{
  create: [nickname: string];
  join: [roomCode: string, nickname: string];
  local: [];
  resume: [];
  abandon: [];
}>();
```

Use `parseInvitedRoomCode(new URL(window.location.href))` in App orchestration to prefill join without auto-submitting.

- [ ] **Step 5: Make `App.vue` orchestration-only**

Create one `OnlineSession` before any online operation. On startup: active credentials → restoring; pending create/join → offer/retry the same request; otherwise home. Local entry creates `LocalSession`. Session state determines lobby/game/settlement pages.

- [ ] **Step 6: Verify focused flow and build**

```text
pnpm exec vitest run apps/client/src/session/appFlow.test.ts apps/client/src/session/sessionStorage.test.ts apps/client/src/session/invitation.test.ts
pnpm --filter @richman/client build
```

Expected: reducer transitions pass and Vue typecheck/build succeeds.

- [ ] **Step 7: Commit**

```text
git add apps/client/src/App.vue apps/client/src/views apps/client/src/style.css apps/client/src/session/appFlow.test.ts
git commit -m "feat(client): add online entry and restore flow"
```

---

### Task 10: Build the live lobby and invitation controls

**Files:**
- Create: `apps/client/src/views/LobbyView.vue`
- Modify: `apps/client/src/App.vue`
- Modify: `apps/client/src/style.css`
- Modify: `apps/client/src/session/invitation.ts` — connect the tested canonical URL to the `qrcode` encoder
- Test: `apps/client/src/session/invitation.test.ts`
- Test: `apps/client/src/session/onlineSession.test.ts`
- Test: `apps/server/src/__tests__/clientOnlineSession.test.ts`
- [ ] **Step 1: Add lobby command RED tests**

In the real integration file, assert host can add/remove a BOT and start; guest cannot; both sessions receive identical `room:state`. In the unit file, assert the start-disabled reason derives from room player count, while server ack remains authoritative.

- [ ] **Step 2: Strengthen exact invitation payload tests**

Capture Clipboard text and QR encoder input:

```ts
expect(copiedText).toBe('https://game.test/?room=0007');
expect(qrInput).toBe(copiedText);
for (const secret of [token, playerId, requestId, nickname]) {
  expect(copiedText).not.toContain(secret);
  expect(qrInput).not.toContain(secret);
}
```

- [ ] **Step 3: Run RED tests**

```text
pnpm exec vitest run apps/client/src/session/onlineSession.test.ts apps/client/src/session/invitation.test.ts apps/server/src/__tests__/clientOnlineSession.test.ts
```

Expected: missing lobby commands or QR adapter assertions fail.

- [ ] **Step 4: Implement `LobbyView.vue`**

Props include the complete public room, local player ID, command pending states, and error. Emit add/remove/start/leave/copy/show-QR actions. Render:

- four-digit room code as the primary heading;
- host, BOT, and offline labels from public room fields;
- host-only BOT and start controls;
- non-host “等待房主开始” state;
- explicit start-disabled reason;
- QR modal generated only when requested.

Use buttons with at least 44px touch targets and a one-column mobile layout.

- [ ] **Step 5: Wire only OnlineSession methods**

App handlers call `onlineSession.addBot()`, `removeBot()`, `startRoom()`, and `leave()`. Do not mutate the player array locally; the next `room:state` replaces it.

- [ ] **Step 6: Verify GREEN and build**

```text
pnpm exec vitest run apps/client/src/session/onlineSession.test.ts apps/client/src/session/invitation.test.ts apps/server/src/__tests__/clientOnlineSession.test.ts
pnpm --filter @richman/client build
```

Expected: host/guest controls over real sockets, exact invitation payload, and Vue build pass.

- [ ] **Step 7: Commit**

```text
git add apps/client/src/views/LobbyView.vue apps/client/src/App.vue apps/client/src/style.css apps/client/src/session
git commit -m "feat(client): add live room lobby"
```

---

### Task 11: Connect the existing game screen to both sessions

**Files:**
- Create: `apps/client/src/views/GameView.vue`
- Modify: `apps/client/src/App.vue`
- Modify: `apps/client/src/components/PlayerRail.vue`
- Modify: `apps/client/src/components/ActionPanel.vue`
- Modify: `apps/client/src/style.css`
- Test: permission/session tests from Tasks 6 and 8

- [ ] **Step 1: Add observable permission-state RED tests**

Test a pure view-model selector, not component source text:

```ts
expect(getGameInteractionState(onlineSession)).toEqual({
  kind: 'waiting_for_player',
  message: '等待 小王 操作',
  canSendIntent: false,
  canSkipOfflineTurn: false,
});
```

Cover local actor, online local actor, other online actor, BOT, offline actor, offline debtor, takeover locked local actor, reconnecting, and animating.

- [ ] **Step 2: Run RED tests**

```text
pnpm exec vitest run apps/client/src/session/gameSession.test.ts
```

Expected: selector or cases are missing.

- [ ] **Step 3: Move the existing game composition into `GameView.vue`**

Reuse `PlayerRail`, `GameBoard`, `FocusedBoard`, `ActionPanel`, `AssetPanel`, `CellDetailPanel`, and `SettlementDialog`. Accept one `GameSession`; never call engine functions in the view. Keep selected cell and mobile board mode as local visual state.

- [ ] **Step 4: Render online-only state without branching rule logic**

Add:

- top connection banner for `reconnecting`/`failed`;
- player offline badge sourced from session-rendered state;
- waiting/BOT/debt/takeover message from `getGameInteractionState`;
- host “托管本回合” button only when selector permits;
- retry/home actions for failed reconnect;
- confirmation before playing/ended leave;
- local-only “重新开局”.

`ActionPanel` receives already-filtered actions and does not decide ownership.

- [ ] **Step 5: Preserve settlement behavior**

Local settlement keeps restart and inspect-board actions. Online settlement offers inspect board and confirmed leave; it never creates local state inside the online room.

- [ ] **Step 6: Verify focused tests and client build**

```text
pnpm exec vitest run apps/client/src/session/gameSession.test.ts apps/client/src/session/gamePresenter.test.ts apps/client/src/session/onlineSession.test.ts apps/client/src/game/clientGame.test.ts
pnpm --filter @richman/client build
```

Expected: all permission matrices and prior local behavior pass; Vue build succeeds.

- [ ] **Step 7: Commit**

```text
git add apps/client/src/views/GameView.vue apps/client/src/App.vue apps/client/src/components apps/client/src/style.css apps/client/src/session
git commit -m "feat(client): share game UI across local and online sessions"
```

---

### Task 12: Prove the complete M3 flow in real browsers

**Files:**
- Create screenshots under: `plan/assets/screenshots/phase2/`
- Modify production code/tests only if a real scenario exposes a reproducible defect; use a focused RED before each correction

- [ ] **Step 1: Run the pre-browser automated gate**

```text
pnpm test
pnpm typecheck
pnpm exec tsc -p scripts/tsconfig.json --noEmit
pnpm validate-data
pnpm build
pnpm exec tsx scripts/smoke-production.ts
```

Expected: all tests pass, all typechecks/builds pass, data validation reports 61 cells and 15+15 cards, smoke prints `smoke ok`.

- [ ] **Step 2: Start the production single-port app**

Run the built server on an unused local port using the existing production startup path. Use two isolated browser contexts: desktop 1440×900 and mobile 390×844. Do not use the Vite dev split-port setup for final acceptance.

- [ ] **Step 3: Verify create, invitation, join, lobby, and start**

Desktop creates a room. Capture the exact copied invitation string and verify only `room` appears in its query. Mobile opens it, enters a nickname, and joins. Desktop adds one BOT and starts. Assert both contexts show the same room status, players, opening current player, cash, positions, and ownership.

- [ ] **Step 4: Verify intermediate-transition synchronization**

Play through at least one roll, one buy/skip decision, one build/skip decision when reachable, and one turn end. After every accepted action, compare both contexts' phase, cash, position, and property ownership before proceeding. This specifically proves the new per-transition snapshot contract.

- [ ] **Step 5: Verify disconnect, presence, resume, and takeover**

Disconnect mobile during an animation; desktop must show offline and must remain offline after the queued snapshot applies. Mobile shows the reconnect banner, reconnects through resume, and matches desktop. Disconnect the active human with no debt, request host takeover, reconnect before the timer completes, and verify the actor sees “房主托管正在执行” with disabled actions until `takeoverPlayerId` clears.

- [ ] **Step 6: Verify leave safety and local mode**

Force a leave timeout and confirm the active token remains and resume still works. Then perform successful leave and confirm local storage clears. From home, start 本机同乐 and complete one normal turn with the existing UI.

- [ ] **Step 7: Capture real screenshots**

Save at least:

```text
plan/assets/screenshots/phase2/m3-home-desktop-1440x900.png
plan/assets/screenshots/phase2/m3-home-mobile-390x844.png
plan/assets/screenshots/phase2/m3-lobby-desktop-1440x900.png
plan/assets/screenshots/phase2/m3-lobby-mobile-390x844.png
plan/assets/screenshots/phase2/m3-game-desktop-1440x900.png
plan/assets/screenshots/phase2/m3-game-mobile-390x844.png
plan/assets/screenshots/phase2/m3-disconnected-mobile-390x844.png
```

Inspect actual pixels for clipping, unreadable room code, hidden controls, horizontal overflow, low contrast, and touch-target size.

- [ ] **Step 8: Run the final gate again after browser QA**

```text
pnpm test
pnpm typecheck
pnpm exec tsc -p scripts/tsconfig.json --noEmit
pnpm validate-data
pnpm build
pnpm exec tsx scripts/smoke-production.ts
```

Expected: the exact final working tree passes every command; report real test-file/test counts and smoke output.

- [ ] **Step 9: Request independent spec and quality review**

Review the full implementation range against `docs/superpowers/specs/2026-07-11-m3-client-online-design.md`. Resolve every Critical/Important finding with a focused RED test and re-run the affected gate before proceeding.

- [ ] **Step 10: Commit the verified browser artifacts and any final tested correction**

```text
git add plan/assets/screenshots/phase2 apps packages pnpm-lock.yaml
git commit -m "test(client): verify M3 online play flow"
```

Do not include build output, localStorage dumps, tokens, room saves, browser profiles, or temporary logs.
