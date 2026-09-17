# Phase 2 M2 Server-Authoritative Engine Design

> Status: proposed for independent review. This document defines M2 only. Production implementation must not begin until this spec is reviewed, revised, committed, and approved by the owner.

## 1. Goal

Move the existing pure `@richman/engine` into the Phase 2 room server so a started room owns one authoritative `GameState`:

- `room:start` creates a real game from the room players;
- clients send intents, never rule outcomes;
- the server applies every intent and broadcasts canonical `GameEvent[]` batches;
- authoritative snapshots are delivered at start, turn boundaries, game over, and resume;
- computer players are driven by the server with visible pacing;
- a host can ask the server to complete the current offline human's turn;
- engine exceptions, stale timers, disconnects, and concurrent client actions cannot corrupt a room or crash the server.

M2 is the backend game-runtime slice. It does not build the online client UI.

## 2. Accepted decisions

1. **One aggregate, one game state.** `RoomManager` remains the only owner of rooms. Each room stores zero or one `GameState`. No parallel `Map<roomCode, GameState>` may become a second source of truth.
2. **Focused runtime module.** Engine calls and automated-intent selection live in a small game runtime module. Room lifecycle and timer ownership remain in `RoomManager`; Socket.IO stays in the adapter.
3. **Events precede ack.** For an accepted player intent, the server commits state, broadcasts events and any required snapshot, then acknowledges success.
4. **One automatic action per timer.** BOT and offline-takeover actions are not collapsed into a whole-turn batch. Every action is delayed and broadcast separately.
5. **Offline takeover belongs to M2.** M2 implements the server protocol and behavior; M3 later supplies the button.
6. **Takeover is turn-locked.** Once accepted, takeover continues until that turn ends even if the player reconnects. Reconnected input is rejected during the lock.
7. **Game completion is represented.** A room becomes `ended` when the engine enters `game_over`; final state remains resumable. Reclamation remains M4.
8. **No engine rule rewrite.** M2 consumes the current engine APIs. Server-specific scheduling and offline behavior stay outside `packages/engine`.

## 3. Scope

### 3.1 Included

- attach `GameState` to started rooms;
- deterministic seed injection and production seed generation;
- typed `game:intent`, `game:events`, and `game:snapshot` Socket.IO protocol;
- engine error-code bridging with safe messages;
- state/event/ack ordering;
- initial, turn-boundary, final, and resume snapshots;
- RoomPlayer/GameState online-state synchronization;
- server BOT action scheduling at 0.8–1.6 seconds per action;
- backend `room:skip_offline_turn` behavior;
- stale-callback and shutdown cancellation;
- real two-client Socket.IO integration tests;
- regression coverage for all M1 behavior.

### 3.2 Explicitly deferred

- client `OnlineSession`, lobby UI, reconnect banner, offline marker rendering, and takeover button: M3;
- atomic JSON saves, process restart recovery, 24-hour playing-room reclamation, and one-hour ended-room reclamation: M4;
- Playwright multi-browser games and real-device acceptance: M5;
- cloud deployment and authentication beyond the existing reconnect token;
- new engine rules, trading, prison mechanics, or BOT difficulty levels;
- client-side event animation implementation.

`room:skip_offline_turn` is the only M3-facing command implemented early because its correctness depends on M2's authoritative state, host validation, and automation lock.

## 4. Existing contracts that remain authoritative

### 4.1 Engine

The server uses the current public exports from `packages/engine/src/index.ts`:

```ts
createGame(input: CreateGameInput): GameState;
applyIntent(state: GameState, playerId: string, intent: Intent): ApplyResult;
chooseBotIntent(state: GameState, playerId: string): Intent;
```

`applyIntent` is synchronous and immutable. A successful result contains a new state and a causally ordered event array. Rule failures return one of:

```ts
type ErrorCode =
  | 'NOT_YOUR_TURN'
  | 'WRONG_PHASE'
  | 'INSUFFICIENT_FUNDS'
  | 'ILLEGAL_INTENT';
```

`createGame` can throw for invalid input. An effect-chain depth overflow can also escape from `applyIntent`. The server boundary must therefore treat engine calls as potentially throwing even though normal rule errors use `ApplyResult`.

### 4.2 M1 room and socket invariants

M2 must preserve:

- four-digit rooms, max-four membership, nickname rules, host-only lobby actions, and token secrecy;
- five-minute lobby disconnect grace;
- playing host transfer to the next online human;
- same-socket old-identity cleanup;
- replacement-socket stale-disconnect protection;
- missing-ack guards before mutation;
- safe `{ok:false, code, message}` failures;
- room event broadcast before success ack;
- separate cleanup of all timer registries after Socket.IO shutdown;
- idempotent `dispose()` and server `close()`.

Existing M1 tests must not be weakened or rewritten to accept changed behavior.

## 5. Architecture

```mermaid
flowchart LR
    C[Socket.IO client] -->|room:* / game:intent| A[roomSocketAdapter]
    A -->|authenticated room/player| R[RoomManager]
    R -->|create/apply/choose| G[gameRuntime]
    G --> E[@richman/engine]
    E -->|new state + ordered events| G
    G -->|transition result| R
    R -->|RoomDomainEvent[]| A
    A -->|room:state / game:events / game:snapshot| C
    R -->|one-shot fakeable timer| R
```

### 5.1 `game/gameRuntime.ts`

A stateless module with no Room map, Socket.IO dependency, timer registry, or network types. Responsibilities:

- construct initial game input from room players and injected seed;
- call `createGame` using `boardData`, `cardsData`, and `gameConfig`;
- call `applyIntent` and preserve the previous state on failures or exceptions;
- map engine error codes and caught exceptions to safe server failures;
- choose one BOT intent through `chooseBotIntent`;
- choose one offline-takeover intent through the fixed policy in §9.

The default M2 game uses `cashGoal: null`. Selecting cash-goal room rules requires a future lobby setting and is not invented in M2.

### 5.2 `RoomManager`

Remains the aggregate and lifecycle owner:

- stores `room.gameState: GameState | null`;
- stores public room status: `lobby | playing | ended`;
- applies authenticated game intents;
- mirrors connection state into room and game player records;
- owns one automation record and at most one automation timer per room;
- generates domain events for room, game events, and snapshots;
- schedules, validates, and cancels automated actions;
- cancels game automation on game over and dispose.

Lobby timeout timers and game automation timers are separate maps with separate key helpers and cancellation methods. Sharing the injected `setTimer/clearTimer` primitives is allowed; sharing registries or semantics is not.

### 5.3 `roomSocketAdapter`

Remains a transport adapter:

- validates payload shape and ack presence;
- uses the existing socket binding as the only player identity;
- calls RoomManager methods;
- translates domain events to Socket.IO events;
- dispatches events before success ack;
- does not call engine APIs or choose automatic intents directly.

### 5.4 `protocol.ts`

Owns wire-facing event and ack types. Engine `Intent`, `GameEvent`, and `GameState` are imported as types rather than copied into parallel interfaces.

## 6. Room and dependency model

### 6.1 Room state

```ts
type RoomStatus = 'lobby' | 'playing' | 'ended';

interface Room {
  code: string;
  status: RoomStatus;
  hostId: string;
  players: RoomPlayer[];
  gameState: GameState | null;
}
```

Invariants:

- `lobby` implies `gameState === null`;
- `playing` implies `gameState !== null && gameState.phase === 'playing'`;
- `ended` implies `gameState !== null && gameState.phase === 'game_over'`;
- every non-bot RoomPlayer ID appears exactly once in `gameState.players` after start;
- every BOT RoomPlayer ID appears exactly once with `isBot: true`;
- room tokens never enter GameState;
- host identity is a room concern and is not copied into GameState.

### 6.2 Injected dependencies

M2 extends the current deterministic dependency surface with:

```ts
generateGameSeed(): string;
nextAutomationDelayMs(): number;
```

Production behavior:

- game seed: cryptographically random string generated once at start;
- automation delay: integer in the inclusive range 800–1600 ms;
- existing native `setTimeout/clearTimeout` primitives schedule actions.

Tests inject fixed seeds, fixed delays, and captured fake timer handles. No M2 test waits 0.8 seconds.

## 7. Start transition

`startRoom(roomCode, requesterId)` remains the only `lobby → playing` transition.

Exact order:

1. validate room exists;
2. validate requester is host;
3. validate room is still lobby;
4. validate total players ≥2 and at least one human;
5. generate one seed;
6. call `createGame` with current players, `boardData`, `cardsData`, `gameConfig`, and `cashGoal:null`;
7. if creation throws, return `INVALID_ROOM_ACTION` with a safe message; keep status, room players, lobby timers, and GameState unchanged;
8. immutably mirror every RoomPlayer's current `online` value into the newly created GameState player with the same ID; this preserves an offline lobby guest if the host starts during that guest's grace period;
9. cancel lobby disconnect timers;
10. assign GameState and set status `playing`;
11. emit `room_state` followed by `game_snapshot`;
12. schedule automation if the first engine actor is a BOT;
13. the adapter broadcasts both events and then returns `{ok:true}`.

The RoomPlayer array retains room/join order for host succession. GameState player order is the engine's dice-resolved seat order and is authoritative for turns and colors.

## 8. Player intent processing

### 8.1 Wire contract

```ts
'game:intent': (
  payload: { intent: Intent },
  ack: (response: Ack<Record<string, never>>) => void,
) => void;
```

Runtime shape validation rejects null, arrays, missing/non-string `type`, unknown intent types, unexpected required-field types, and non-finite/non-integer `cellId` where applicable. The engine remains the final semantic validator.

### 8.2 Manual socket authorization

For a bound socket, the adapter and RoomManager perform manual-only checks:

1. resolve binding; reject unbound sockets with `INVALID_ROOM_ACTION`;
2. validate payload shape;
3. require room status `playing` and non-null GameState;
4. if the room has an active offline takeover for the engine actor, reject that actor's **manual** intent with `INVALID_ROOM_ACTION`;
5. call the shared committed transition in §8.3.

### 8.3 Shared committed transition

Manual intents and timer-driven intents use one internal transition primitive after their caller-specific authorization. The primitive accepts the room, actor ID, intent, and source (`manual | bot | offline_takeover`). It does **not** repeat socket binding, payload-shape, or manual takeover-lock checks; automated callbacks have already passed §9.2 stale checks and therefore cannot be rejected by manual-only step 4 above.

Exact transition:

1. call `gameRuntime.apply` synchronously with the current state;
2. on normal engine failure, return the mapped engine code/message; state reference remains identical and no domain event is produced;
3. on exception, log server-side context without tokens or the full private room, return `ILLEGAL_INTENT`, retain the old state, and emit nothing;
4. on success, replace `room.gameState` before producing events;
5. emit one `game_events` domain event containing exactly that intent's ordered events;
6. if events contain `turn_ended`, emit one snapshot immediately after the event batch;
7. if the new state is `game_over` or events contain `game_over`, set room status `ended`, cancel automation, and emit a final snapshot unless step 6 already emitted the same state;
8. otherwise run the source-aware automation reconciliation in §9.2;
9. return success plus the ordered domain events.

For a manual socket intent, the adapter broadcasts all returned events before `{ok:true}` ack. For a timer-driven intent, RoomManager sends returned events through the existing async-domain-event sink; there is no socket ack.

No `await` occurs between reading the current state and replacing it. Node's event loop therefore serializes simultaneous client intents: the second handler reads the first handler's committed state.

### 8.4 Error messages

The server defines fixed, non-sensitive messages for the four engine codes. It never forwards exception text to clients. Error codes stay distinct from M1 room errors but share the same ack failure shape.

## 9. Automation

### 9.1 Automation record

Each room has at most one active record, maintained by RoomManager rather than serialized in GameState:

```ts
interface RoomAutomation {
  generation: number;
  mode: 'bot' | 'offline_takeover';
  playerId: string;
  startedTurn: number;
}
```

`startedTurn` is copied from `state.turn` when the record is created. A callback is current only when its captured generation equals the room's current monotonically increasing generation and the live state still has the same `turn`. Clearing or replacing automation increments the generation, cancels the known pending handle, removes the record, and invalidates callbacks already queued by the event loop.

The **engine actor** is defined once for every automation and authorization decision:

```ts
const actorId = state.debt?.debtorId ?? state.currentPlayerId;
```

This matters because debt decisions belong to the debtor even when `currentPlayerId` still names the turn owner. BOT automation follows a BOT debtor; human debt never starts BOT automation merely because the turn owner is a BOT.

### 9.2 Automation callbacks and post-transition reconciliation

Every automation callback first removes its fired handle from the pending-timer map, then re-reads the room and checks:

- room still exists and is `playing`;
- GameState exists and is not game over;
- automation generation, mode, player ID, and `startedTurn === state.turn` still match;
- the engine actor is still the automation player;
- mode-specific eligibility still holds.

If the captured generation is no longer current, the callback returns without touching the newer record. If the generation still matches but any room/status/state/turn/actor/mode check fails, it clears the current record; when a live playing state remains, it then runs normal BOT reconciliation for the live engine actor. No failed stale check applies an intent or emits a fabricated event.

An automated callback invokes the shared transition in §8.3 directly; it never passes through manual socket checks. After **every** successful shared transition, including source `manual`, RoomManager performs exactly one source-aware reconciliation:

1. if state is game over, clear automation and stop;
2. compute the new engine actor from the committed state;
3. for `manual`, run normal BOT reconciliation for the new actor; this schedules a BOT after a human `end_turn` or after a human resolves debt and control returns to a BOT;
4. for `offline_takeover`, clear the record if **any debt exists**, the actor changed, or `state.turn !== startedTurn`; after clearing, run normal BOT reconciliation for the new actor and otherwise wait for a new host command or human input;
5. for `bot`, keep the record only if the actor is the same BOT and `state.turn === startedTurn` (including that BOT resolving its own debt); otherwise clear it and run normal BOT reconciliation for the new actor;
6. if an automation record remains current, schedule exactly one next action with a newly generated delay.

If an automated transition returns a rule failure or throws, both automation modes clear the record, cancel any pending handle, log server-side context for exceptions, keep the last valid state, emit no fabricated event, and do not retry. A connected human can then act; an offline human waits for resume or a new valid host takeover request. Manual failures retain the private-ack behavior from §8.3 and do not run reconciliation because no state changed.

Production delays are recalculated per action and must be within 800–1600 ms. Tests fire captured callbacks directly.

### 9.3 BOT mode

BOT mode begins whenever the engine actor is a non-bankrupt BOT and the room does not already have the exact current automation tuple `(mode:'bot', playerId:actorId, startedTurn:state.turn)` with an active pending handle. Each callback:

```ts
const intent = chooseBotIntent(state, botPlayerId);
```

The shared transition applies it. BOT debt is handled by the existing engine BOT policy. Actor/turn changes use §9.2 reconciliation, so consecutive BOT seats receive separate records and separate delays.

A BOT rule failure or exception follows the common failure-stop behavior in §9.2. It must not spin or immediately retry.

### 9.4 Offline takeover mode

Wire contract:

```ts
'room:skip_offline_turn': (
  ack: (response: Ack<Record<string, never>>) => void,
) => void;
```

Acceptance requirements:

- socket is bound;
- room is `playing`;
- requester is current room host;
- `state.debt === null`;
- the engine actor (§9.1, therefore also `state.currentPlayerId` while debt is null) is a human RoomPlayer;
- that RoomPlayer is offline;
- no automation record or pending automation timer exists for the room.

On acceptance, the server creates `(mode:'offline_takeover', playerId:actorId, startedTurn:state.turn)` with a fresh generation, schedules the first action, and returns `{ok:true}`. Because no game transition has occurred yet, this scheduling ack is immediate; normal game-intent event-before-ack ordering does not apply to the later timer callbacks.

Fixed takeover policy:

| Turn phase | Intent |
|---|---|
| `awaiting_roll` | `{type:'roll_dice'}` |
| `awaiting_airport_roll` | `{type:'roll_airport_branch'}` |
| `awaiting_buy_decision` | `{type:'skip_buy'}` |
| `awaiting_build_decision` | `{type:'skip_build'}` |
| `managing` | `{type:'end_turn'}` |

If an automatic action creates debt for **any** player, its canonical engine events are broadcast and §9.2 clears takeover. If the debtor is a BOT, normal BOT reconciliation starts that BOT's debt actions; if the debtor is human, the room waits. When that debt later resolves and control returns to the original offline player, no stale takeover lock remains: the host may issue a new takeover request, or a reconnected player may act manually.

Reconnect during an active takeover mirrors online state and returns the latest snapshot but does not itself cancel the turn lock. Manual intents from the takeover player are rejected only while that exact current takeover record remains. `turn_ended`, `game_over`, any debt, actor/turn change, rule failure, or exception clears the record through §9.2.

Takeover never sells assets or declares bankruptcy on behalf of a human.

## 10. Connection-state synchronization

Both RoomPlayer and engine PlayerState currently contain `online`. To avoid contradictory snapshots:

- `RoomPlayer.online` is the authoritative connection value because M1 socket lifecycle owns it;
- after start, every successful playing/ended disconnect or resume mirrors that value into the matching GameState player using an immutable GameState update;
- engine rule code does not decide online status;
- a connection-only mirror does not create a `game:events` batch because no game rule occurred;
- playing/ended resume returns the mirrored latest snapshot;
- lobby behavior remains unchanged because no GameState exists;
- BOT players always remain online in both representations.

Playing host transfer remains a room-state event. It does not alter GameState except for the disconnected player's mirrored online field.

To preserve the exact M1 `resumeRoom()` contract and its equality-based tests, `resumeRoom()` continues returning `RoomResult<PublicRoomState>`. It performs token validation, connection updates, and the GameState online mirror synchronously. Only after that success, the adapter calls a separate internal `getGameSnapshot(roomCode): GameState | null` accessor and constructs the wire `ResumeAck {room, snapshot?}`. Lobby results therefore retain their existing value shape; no second snapshot Map is introduced.

## 11. Snapshot policy

Wire event:

```ts
'game:snapshot': (payload: { state: GameState }) => void;
```

Snapshots contain complete GameState, including board/cards/config and the recent 200-event log. This is intentional and token-safe; clients can reconstruct without another data fetch.

Delivery rules:

- broadcast initial snapshot after `room:state playing`;
- after each accepted transition whose events contain `turn_ended`;
- after a transition that enters `game_over`, without duplicating an already-emitted identical boundary snapshot;
- return the latest snapshot in a successful playing/ended `session:resume` ack;
- do not broadcast a full snapshot to existing peers merely because one player resumed;
- do not snapshot after every intermediate intent.

Resume ack shape:

```ts
interface ResumeAck {
  room: PublicRoomState;
  snapshot?: GameState;
}
```

`snapshot` is absent in lobby and present in playing/ended rooms.

## 12. Domain and wire events

RoomManager extends its internal event union:

```ts
type RoomDomainEvent =
  | ExistingM1Events
  | { type: 'game_events'; roomCode: string; events: GameEvent[] }
  | { type: 'game_snapshot'; roomCode: string; state: GameState };
```

The adapter maps them to:

```ts
'game:events': { events: GameEvent[] };
'game:snapshot': { state: GameState };
```

One accepted intent always creates one `game:events` batch, even if the engine event array is empty. This keeps acknowledgement and client queue semantics explicit. The adapter preserves domain event array order.

No separate `game:error` broadcast exists. Failures are private acks to the requester. Debt produced during takeover is already represented by canonical engine events.

## 13. Ended rooms

When GameState enters `game_over`:

- room status becomes `ended`;
- a final authoritative snapshot is delivered;
- BOT/takeover automation is canceled;
- further `game:intent`, `room:start`, and takeover commands fail safely;
- disconnect marks humans offline and mirrors snapshot presence without deleting players;
- token resume remains valid and returns final room/snapshot;
- explicit leave follows playing semantics: retain the seat, mark offline, and do not destroy final state;
- M2 does not schedule one-hour cleanup or delete state.

M4 adds persisted recovery and reclamation. Until then, ended rooms live for the server process lifetime.

## 14. Disposal and stale work

`RoomManager.dispose()` must:

1. cancel every lobby-disconnect timer;
2. cancel every game-automation timer;
3. clear both registries and automation records;
4. become harmless on repeated calls.

The existing server close order remains:

1. close Socket.IO, allowing disconnect callbacks;
2. dispose RoomManager, clearing timers scheduled by that disconnect wave;
3. close the HTTP server if still listening.

No automation callback may emit after dispose. Callback generation and room/status checks provide defense in depth if a canceled callback was already queued.

## 15. Test design

### 15.1 Pure room-game tests

Create a dedicated server test file rather than expanding the 1,500-line M1 room suite. Cover:

- deterministic start input and seat order;
- start creation exception leaves the lobby byte-for-byte unchanged;
- room/game player ID and BOT-flag invariants;
- automatic action creates debt for a different human or BOT: old record clears, human debt waits, BOT debt receives a fresh BOT record, and control can later return without a stale lock;
- accepted intent updates state and emits exact ordered domain events;
- every engine failure retains the same state reference and emits nothing;
- thrown apply retains state and maps to safe failure;
- turn-ended and game-over snapshot rules;
- `ended` transition and command rejection;
- online mirroring on disconnect/resume;
- BOT one-action timer chain, consecutive BOTs, debt actions, failure stop;
- manual `end_turn` or debt resolution hands control to a BOT and creates exactly one fresh BOT timer;
- takeover host/online/debt/duplicate guards;
- reconnect during takeover does not cancel it;
- debt created during takeover stops automation;
- stale timer, game-over timer, and dispose cancellation.

Tests inject fake engine gateway functions only when forcing exceptional paths. Normal contract tests use the real engine.

### 15.2 Real Socket.IO integration tests

Use ephemeral HTTP servers and two real `socket.io-client` clients. Cover:

- create → join → start, both clients receive playing room state then equal initial snapshot before ack;
- correct player rolls, both receive identical event batch before sender ack;
- wrong player gets `NOT_YOUR_TURN`, with no peer broadcast;
- a deterministic full turn reaches `turn_ended` and sends events then snapshot then ack;
- disconnect while peers continue; resume returns current snapshot;
- replacement socket and stale disconnect retain M1 behavior;
- 1 human + 1 BOT advances one action per manually fired timer;
- takeover schedules, rejects concurrent manual input, and continues after resume;
- malformed intent and missing ack cause no mutation;
- game over delivers final snapshot and rejects later intents.

### 15.3 Ordering and flakiness rules

- no real sleeps;
- fake timer handles expose callback, delay, active, and generation;
- register event listeners before emitting commands;
- use bounded Promise rejection only to prevent hangs, not to orchestrate state;
- disconnect all clients and close server in `afterEach`;
- assert event order structurally, never by timestamp;
- production delay range gets a pure boundary test;
- run all existing engine, client, M1 room, static, production, and party tests unchanged.

### 15.4 Automated gate

The implementation is not complete until all commands pass from a worktree with built client assets:

```bash
pnpm test
pnpm typecheck
pnpm exec tsc -p scripts/tsconfig.json --noEmit
pnpm validate-data
pnpm build
pnpm --filter @richman/server build
```

A bounded production smoke must still serve the built client and close gracefully.

## 16. Planned file impact

Likely production files:

- create `apps/server/src/game/gameRuntime.ts`;
- modify `apps/server/src/protocol.ts`;
- modify `apps/server/src/rooms/roomTypes.ts`;
- modify `apps/server/src/rooms/roomErrors.ts` or introduce a separate game failure mapper while preserving the shared ack shape;
- modify `apps/server/src/rooms/roomManager.ts`;
- modify `apps/server/src/socket/roomSocketAdapter.ts`;
- modify `apps/server/src/production.ts` for seed/delay dependencies;
- modify test factories that construct RoomManager dependencies.

New tests should be split by responsibility rather than added to already-large M1 files:

- `apps/server/src/__tests__/roomGame.test.ts`;
- `apps/server/src/__tests__/socketGame.test.ts`;
- optional separate `socketGameReconnect.test.ts` only if the first Socket.IO file becomes difficult to review.

No `packages/engine` production file is expected to change.

## 17. Implementation phases and review gates

The later implementation plan must preserve these phase boundaries:

1. **Protocol and pure runtime:** types, validation, engine gateway, error rollback. Independent review.
2. **Room aggregate:** GameState lifecycle, start, intent transitions, snapshots, online mirroring. Independent review.
3. **Automation:** BOT timers, offline takeover, stale callback/dispose behavior. Independent review.
4. **Socket.IO integration:** handlers, resume snapshot, real two-client ordering. Independent review.
5. **Closure:** protocol docs, complete gate, production smoke, final review.

Every behavioral task begins with Tester-authored RED tests. No phase advances with unresolved Critical or Important review findings.

## 18. Acceptance criteria

M2 is accepted only when all are true:

- starting a valid room creates exactly one authoritative GameState;
- two real clients receive identical initial state, game events, and turn-boundary snapshots;
- the server, not the client, validates and applies every intent;
- failed or thrown intents do not change state or broadcast;
- simultaneous intents serialize against the latest committed state;
- BOTs visibly act one intent at a time with server-controlled delay;
- host takeover of an offline human follows the fixed no-buy/no-build policy and turn lock;
- disconnect and resume keep room presence and snapshot online flags consistent;
- stale/replaced sockets and stale timers cannot change current state;
- game over produces a final resumable ended room;
- no token appears in GameState, game events, snapshots, logs, or public room state;
- all M1 behavior and tests remain intact;
- independent reviewers approve every implementation phase and the final result.
