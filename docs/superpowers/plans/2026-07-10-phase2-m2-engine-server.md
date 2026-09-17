# Phase 2 M2 Server-Authoritative Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the pure `@richman/engine` into the M1 room server so a started room owns exactly one authoritative `GameState`, clients send intents (never outcomes), the server applies every intent and broadcasts canonical `GameEvent[]` batches plus boundary snapshots, and BOT/offline-takeover automation runs with server-controlled pacing — without corrupting rooms, crashing on engine exceptions, or weakening any M1 behavior.

**Architecture:** `RoomManager` stays the single aggregate and timer owner; each room gains `gameState: GameState | null` and a public status `lobby | playing | ended`. A stateless `game/gameRuntime.ts` wraps engine calls (create/apply/chooseBot), validates intent shape, maps engine error codes, and rolls back on exceptions. `RoomManager` owns one automation record + at most one automation timer per room, generation-guarded against stale callbacks. `roomSocketAdapter` stays a transport layer that validates payloads, dispatches domain events before success acks, and maps `game_events`/`game_snapshot` domain events onto `game:events`/`game:snapshot` wire events. `protocol.ts` imports engine `Intent`/`GameEvent`/`GameState` as types instead of copying them.

**Tech Stack:** TypeScript 5, Node.js 20, Socket.IO 4, `socket.io-client`, Vitest (fake/captured timers, no real sleeps), `@richman/engine`, `@richman/board-data`, pnpm workspaces.

**Authoritative design:** `docs/superpowers/specs/2026-07-10-phase2-m2-engine-server-design.md` (approved head `9bccc80`). Section references below (`§7`, `§9.2`, …) point into that spec.

**Execution rule:** Every behavior task follows RED → GREEN. Test files MUST be authored by a `Tester` agent before production code is edited; implementation agents never write their own tests. During a task, skip project-wide formatters and full suites — run only that task's listed targeted command. Full verification happens in Task 13.

**Worktree:** `/Users/admin/Documents/Richman/.worktrees/phase2-m2-engine-server`

**Preserve M1:** Existing M1 tests (`roomManager.test.ts`, `socketRooms.test.ts`, `production.test.ts`, `serverStatic.test.ts`, `partyLauncher.test.ts`, `networkAddress.test.ts`) and all `@richman/engine` / `@richman/board-data` tests MUST keep passing. The sanctioned M1 test edits are strictly limited to: (1) mechanical dependency-factory updates (spec §16) that inject the two new required `RoomManagerDependencies` fields in the three factories listed below, and (2) exactly one assertion/name update in `roomManager.test.ts` for the existing `startRoom` test so it expects ordered `room_state` then `game_snapshot` instead of only `room_state`. No other M1 assertion or expected behavior may change.

---

## File responsibility map

### Server production files

- Modify `apps/server/package.json`: add workspace dependencies `@richman/engine` and `@richman/board-data` (`workspace:*`). No other dep changes.
- Modify `apps/server/src/protocol.ts`: import engine `Intent`/`GameEvent`/`GameState` as types; extend `RoomStatus` with `'ended'`; add `game:intent` + `room:skip_offline_turn` client events; add `game:events` + `game:snapshot` server events; add `ResumeAck` (the `session:resume` ack change to `Ack<ResumeAck>` is deferred to Task 12, where it lands with the adapter's resume-snapshot assembly); extend `RoomDomainEvent` with `game_events` + `game_snapshot`.
- Modify `apps/server/src/rooms/roomErrors.ts`: add the game failure catalog (`GameErrorCode`, `GAME_ERROR_MESSAGES`, `gameFailure`, `GameFailure`, `WireFailure = RoomFailure | GameFailure`) while keeping the existing room error shape. This is the "separate game failure mapper" allowed by spec §16.
- Modify `apps/server/src/rooms/roomTypes.ts`: add `gameState` to `Room`; add `generateGameSeed`/`nextAutomationDelayMs` (required) and `gameGateway`/`onServerError` (optional) to `RoomManagerDependencies`; add `RoomAutomation`, `AutomationSource`, `GameActionResult`; re-export new game types.
- Create `apps/server/src/game/gameRuntime.ts`: stateless engine gateway — `isValidIntent`, `GameRuntimeGateway`, `defaultGameGateway`, `createInitialGame`, `applyGameIntent` (exception rollback), `chooseTakeoverIntent`. No Room map, no Socket.IO, no timers.
- Modify `apps/server/src/rooms/roomManager.ts`: game-state lifecycle in `startRoom`; `applyGameIntent`, `requestSkipOfflineTurn`, `getGameSnapshot`; online mirroring in `resumeRoom`/`markDisconnected`/`leaveRoom`; automation record/generation/timer maps; shared committed transition; source-aware reconciliation; stale-callback + dispose cancellation.
- Modify `apps/server/src/socket/roomSocketAdapter.ts`: Task 2 adds the `game_events`/`game_snapshot` dispatch branches and makes the existing `room_closed` fallthrough explicit (adding union members would otherwise leave `event.reason` unresolved); Task 11 widens `toActionAck` to accept `WireFailure` and adds the `game:intent` handler; Task 12 adds `room:skip_offline_turn` and assembles the resume `ResumeAck`. Never call engine APIs or choose intents.
- Modify `apps/server/src/production.ts`: wire `generateGameSeed` (crypto-random hex) and `nextAutomationDelayMs` (`randomInt` 800–1600 inclusive) into the production `RoomManager`, and supply a safe `onServerError` console logger (no tokens). Task 13 extracts the delay/seed into exported functions and exports them for unit testing.

### Server test files (split by responsibility — do not grow M1 suites)

- Create `apps/server/src/__tests__/gameRuntime.test.ts`: pure gateway/validation/rollback/takeover-policy tests (Task 3).
- Create `apps/server/src/__tests__/roomGame.test.ts`: pure room+game-state tests — start, transitions, snapshots, ended, online mirror, automation, takeover (Tasks 4–10).
- Create `apps/server/src/__tests__/socketGame.test.ts`: real two-client Socket.IO game tests — intents, ordering, game over (Task 11).
- Create `apps/server/src/__tests__/socketGameReconnect.test.ts`: real two-client resume/takeover/BOT-timer/stale-socket tests (Task 12).
- Modify `apps/server/src/__tests__/roomManager.test.ts`, `apps/server/src/__tests__/socketRooms.test.ts`, and `apps/server/src/__tests__/serverStatic.test.ts`: only the dependency-factory helpers (`createHarness`, `createDeterministicRoomManagerFactory`, `createDeterministicRoomManager`) gain the two new required deps (Task 4). `serverStatic.test.ts` imports the real `RoomManagerDependencies` from `roomTypes`, so it fails to typecheck until it supplies the two new fields alongside the other factories.
- Sanctioned M1 assertion change (spec §7 step 11, one place only): the `roomManager.test.ts` test "startRoom allows a host with one bot, emits only room_state, and rejects a repeat start" (≈line 570) is renamed to "...emits room_state then game_snapshot, and rejects a repeat start", and its single `expect(result.events).toEqual([{ type: 'room_state', ... }])` assertion is updated to `toEqual([ room_state, game_snapshot ])` with the created `GameState`. No other M1 assertion or expected behavior may change.
- Modify `apps/server/src/__tests__/production.test.ts`: add the automation-delay boundary test (Task 13).
- Create `scripts/smoke-production.ts`: maintained, async `main()` production smoke — starts an ephemeral production server, fetches the built client `index.html`, closes twice/gracefully, exits nonzero on failure. Run with the repo's existing `tsx`; gated by `scripts/tsconfig.json` and committed in Task 13.

### Documentation, last (Task 13)

- Modify `plan/03-架构与联机协议.md`: document the `game:intent`/`game:events`/`game:snapshot`/`room:skip_offline_turn` protocol, the four engine error codes on the shared ack shape, and the `ended` status.
- Modify `plan/05-阶段2-联机版.md`: mark M2 server-authoritative engine + `room:skip_offline_turn` behavior complete; keep reclamation as M4.
- Modify `README.md`: mark Phase 2 M2 complete only after Task 13's gate passes.

---

## Phases, review gates, and task index

Five phases mirror spec §17. **No phase advances while any Critical or Important review finding is unresolved.** Each phase ends with an independent spec-compliance review AND a code-quality review; fixes land before the next phase starts.

| Phase | Tasks | Independent review gate |
|---|---|---|
| 1. Protocol & pure runtime | 1, 2, 3 | Gate A — types, validation, gateway, rollback |
| 2. Room aggregate | 4, 5, 6 | Gate B — start, intents, snapshots, ended, online mirror |
| 3. Automation | 7, 8, 9, 10 | Gate C — BOT timers, cross-player debt, takeover, stale/dispose |
| 4. Socket.IO integration | 11, 12 | Gate D — handlers, resume snapshot, real two-client ordering |
| 5. Closure | 13 | Final gate — docs, full automated gate, production smoke, final review |

- Task 1 — Server engine/board-data dependencies
- Task 2 — Wire protocol + game failure catalog
- Task 3 — `gameRuntime` module (validation / gateway / rollback / takeover policy)
- Task 4 — Room game-state model, deps, `getGameSnapshot`, `startRoom` creation + initial snapshot
- Task 5 — `applyGameIntent` shared committed transition + snapshots + `ended`
- Task 6 — Online-state mirroring (disconnect / leave / resume) + M1-shape resume
- Task 7 — Automation infrastructure: record, generation, schedule/clear, stale guard, dispose
- Task 8 — BOT mode + post-transition reconciliation + `startRoom` BOT-first
- Task 9 — Cross-player debt actor reconciliation
- Task 10 — Offline takeover behavior
- Task 11 — Socket adapter game events + `game:intent` two-client ordering
- Task 12 — `room:skip_offline_turn` + resume snapshot + BOT timer chain over real sockets
- Task 13 — Production wiring, delay boundary, docs, full gate, smoke, final review

---
## Phase 1 — Protocol and pure runtime

### Task 1: Add server engine + board-data dependencies

**Files:**
- Modify: `apps/server/package.json`
- Modify: `pnpm-lock.yaml` (regenerated by pnpm)

This is a build/config task (no runtime behavior), so its gate is the typecheck, not a Tester RED test.

- [ ] **Step 1: Declare the workspace dependencies with pnpm**

Run from the worktree root:

```bash
pnpm --filter @richman/server add @richman/engine@workspace:* @richman/board-data@workspace:*
```

Expected: `apps/server/package.json` `dependencies` now contains `"@richman/engine": "workspace:*"` and `"@richman/board-data": "workspace:*"`; `pnpm-lock.yaml` updates with the workspace links. `apps/client/package.json` already uses this exact pattern — mirror it.

- [ ] **Step 2: Verify resolution before touching source**

Run:

```bash
pnpm list @richman/engine @richman/board-data --filter @richman/server --depth 0
```

Expected: both packages are listed under `@richman/server` dependencies as linked workspace packages. If either is missing, the dependency was not linked — rerun Step 1. (A package-manager resolution/list command is used instead of inline bare-node TypeScript execution, per harness policy.)

- [ ] **Step 3: Confirm the server still typechecks with no source changes**

Run: `pnpm --filter @richman/server build`
Expected: PASS (exit 0). `apps/server/package.json`'s `build` is `tsc --noEmit`; adding deps alone must not break it.

- [ ] **Step 4: Commit**

```bash
git add apps/server/package.json pnpm-lock.yaml
git commit -m "build(server): depend on @richman/engine and @richman/board-data"
```

---

### Task 2: Wire protocol types, game failure catalog, and adapter dispatch

**Files:**
- Modify: `apps/server/src/protocol.ts`
- Modify: `apps/server/src/rooms/roomErrors.ts`
- Modify: `apps/server/src/socket/roomSocketAdapter.ts`

Pure type + constant additions plus the adapter dispatch fix they force. Gate is the typecheck; no Tester RED needed (no runtime behavior yet). The `session:resume` ack callback type stays `Ack<{ room: PublicRoomState }>` for now; `ResumeAck` is defined here and the callback change to `Ack<ResumeAck>` is staged to Task 12, where it lands with the adapter's resume-snapshot assembly.

- [ ] **Step 1: Extend `protocol.ts` with engine-typed wire events**

Add the engine type import at the top of `apps/server/src/protocol.ts`:

```ts
import type { GameEvent, GameState, Intent } from '@richman/engine';
```

Change `RoomStatus` and define the resume ack type (the `session:resume` callback is changed to `Ack<ResumeAck>` only in Task 12, with the adapter rewrite):

```ts
export type RoomStatus = 'lobby' | 'playing' | 'ended';

export interface ResumeAck {
  room: PublicRoomState;
  snapshot?: GameState;
}
```

Extend `RoomDomainEvent` (append the two new members to the existing union):

```ts
export type RoomDomainEvent =
  | { type: 'room_state'; roomCode: string; room: PublicRoomState }
  | { type: 'player_connection'; roomCode: string; playerId: string; online: boolean }
  | { type: 'room_closed'; roomCode: string; reason: 'empty_lobby' | 'lobby_idle_timeout' }
  | { type: 'game_events'; roomCode: string; events: GameEvent[] }
  | { type: 'game_snapshot'; roomCode: string; state: GameState };
```

In `ClientToServerEvents`, change the `session:resume` ack type and add the two game commands:

```ts
  'session:resume': (
    payload: { roomCode: string; playerId: string; token: string },
    // Kept on Ack<{ room: PublicRoomState }> in this task; changed to Ack<ResumeAck> in Task 12.
    ack: (response: Ack<{ room: PublicRoomState }>) => void,
  ) => void;
  // ...existing room:* commands unchanged...
  'game:intent': (
    payload: { intent: Intent },
    ack: (response: Ack<Record<string, never>>) => void,
  ) => void;
  'room:skip_offline_turn': (ack: (response: Ack<Record<string, never>>) => void) => void;
```

In `ServerToClientEvents`, add:

```ts
  'game:events': (payload: { events: GameEvent[] }) => void;
  'game:snapshot': (payload: { state: GameState }) => void;
```

- [ ] **Step 2: Add the game failure catalog to `roomErrors.ts`**

Append to `apps/server/src/rooms/roomErrors.ts` (keep the existing `ROOM_ERROR_CODES`, `RoomErrorCode`, `RoomFailure`, `roomFailure` intact):

```ts
import type { ErrorCode } from '@richman/engine';

export type GameErrorCode = ErrorCode; // 'NOT_YOUR_TURN' | 'WRONG_PHASE' | 'INSUFFICIENT_FUNDS' | 'ILLEGAL_INTENT'

// Fixed, non-sensitive messages (spec §8.4). Exception text is never forwarded.
export const GAME_ERROR_MESSAGES: Record<GameErrorCode, string> = {
  NOT_YOUR_TURN: '还没轮到你行动。',
  WRONG_PHASE: '当前阶段不能执行该操作。',
  INSUFFICIENT_FUNDS: '现金不足，无法执行该操作。',
  ILLEGAL_INTENT: '该操作不合法。',
};

// A game failure preserves the exact GameErrorCode literals (never widens the code field).
export type GameFailure = { ok: false; code: GameErrorCode; message: string };

// Shared ack failure shape (spec §8.4): distinct room/game codes, same {ok:false, code, message}.
// RoomFailure is { ok:false; code: RoomErrorCode; message } and is assignable to this union.
export type WireFailure = RoomFailure | GameFailure;

export function gameFailure(code: GameErrorCode): GameFailure {
  return { ok: false, code, message: GAME_ERROR_MESSAGES[code] };
}
```

`RoomFailure` (code `RoomErrorCode`) and `GameFailure` (code `GameErrorCode`) are both assignable to `WireFailure`; both satisfy the protocol `Ack` failure branch. `GameActionResult` (Task 4) uses `WireFailure` as its failure branch.

- [ ] **Step 2b: Keep `roomSocketAdapter.ts` compiling after the union grows**

Adding `game_events`/`game_snapshot` to `RoomDomainEvent` breaks the adapter's `dispatchDomainEvents`: its final unconditional fallthrough reads `event.reason`, which is only valid on the `room_closed` variant. Add explicit branches (dispatch the new game events now) and make `room_closed` an explicit branch so the union is exhaustively handled:

```ts
  function dispatchDomainEvents(events: RoomDomainEvent[]): void {
    for (const event of events) {
      if (event.type === 'room_state') {
        io.to(event.roomCode).emit('room:state', event.room);
        continue;
      }

      if (event.type === 'player_connection') {
        io.to(event.roomCode).emit('player:connection', {
          playerId: event.playerId,
          online: event.online,
        });
        continue;
      }

      if (event.type === 'game_events') {
        io.to(event.roomCode).emit('game:events', { events: event.events });
        continue;
      }

      if (event.type === 'game_snapshot') {
        io.to(event.roomCode).emit('game:snapshot', { state: event.state });
        continue;
      }

      // event.type === 'room_closed' (made explicit; was the implicit fallthrough)
      io.to(event.roomCode).emit('room:closed', { reason: event.reason });
    }
  }
```

No handlers are registered yet — the two new socket events and the `game:intent`/`room:skip_offline_turn` handlers arrive in Tasks 11–12.

- [ ] **Step 3: Verify the package typechecks**

Run: `pnpm --filter @richman/server build`
Expected: PASS (exit 0). If `ErrorCode`/`Intent`/`GameEvent`/`GameState` fail to import, Task 1 did not link `@richman/engine` — fix that first. The adapter must also compile now that `RoomDomainEvent` has two new members and the `room_closed` fallthrough is explicit.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/protocol.ts apps/server/src/rooms/roomErrors.ts apps/server/src/socket/roomSocketAdapter.ts
git commit -m "feat(server): add game wire protocol, engine error catalog, and adapter dispatch"
```

---

### Task 3: `gameRuntime` module — validation, gateway, rollback, takeover policy

**Files:**
- Create: `apps/server/src/game/gameRuntime.ts`
- Test: `apps/server/src/__tests__/gameRuntime.test.ts` (Tester authors first)

- [ ] **Step 1 (Tester): Write the failing tests**

Create `apps/server/src/__tests__/gameRuntime.test.ts`. Use the real engine + real board data for contract paths; inject a throwing gateway only for the exception path. No timers, no sleeps.

```ts
import { describe, expect, test, vi } from 'vitest';
import { boardData, cardsData, gameConfig } from '@richman/board-data';
import type { GameState, Intent } from '@richman/engine';
import {
  applyGameIntent,
  chooseTakeoverIntent,
  createInitialGame,
  defaultGameGateway,
  isValidIntent,
  type GameRuntimeGateway,
} from '../game/gameRuntime';

const players = [
  { id: 'p1', nickname: 'A', isBot: false },
  { id: 'p2', nickname: 'B', isBot: false },
];

function startState(seed = 'runtime-seed'): GameState {
  const created = createInitialGame(defaultGameGateway, players, seed, boardData, cardsData, gameConfig);
  if (!created.ok) throw new Error('expected createInitialGame to succeed');
  return created.state;
}

describe('isValidIntent', () => {
  test('accepts known no-arg intents', () => {
    for (const type of ['roll_dice', 'roll_airport_branch', 'buy_property', 'skip_buy', 'build_house', 'skip_build', 'end_turn', 'declare_bankrupt']) {
      expect(isValidIntent({ type })).toBe(true);
    }
  });

  test('accepts cellId intents only with an integer cellId', () => {
    expect(isValidIntent({ type: 'sell_house', cellId: 3 })).toBe(true);
    expect(isValidIntent({ type: 'mortgage_property', cellId: 0 })).toBe(true);
    expect(isValidIntent({ type: 'sell_house' })).toBe(false);
    expect(isValidIntent({ type: 'sell_house', cellId: 1.5 })).toBe(false);
    expect(isValidIntent({ type: 'sell_house', cellId: '3' })).toBe(false);
    expect(isValidIntent({ type: 'sell_house', cellId: Number.NaN })).toBe(false);
  });

  test('rejects null, arrays, missing/non-string type, and unknown types', () => {
    expect(isValidIntent(null)).toBe(false);
    expect(isValidIntent([])).toBe(false);
    expect(isValidIntent({})).toBe(false);
    expect(isValidIntent({ type: 123 })).toBe(false);
    expect(isValidIntent({ type: 'teleport' })).toBe(false);
    expect(isValidIntent({ type: 'roll_dice', extra: 1 })).toBe(true); // extra keys tolerated; engine is final validator
  });
});

describe('createInitialGame', () => {
  test('uses cashGoal:null and produces a playing game with both players seated', () => {
    const created = createInitialGame(defaultGameGateway, players, 'seed-a', boardData, cardsData, gameConfig);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.state.cashGoal).toBeNull();
    expect(created.state.phase).toBe('playing');
    expect(created.state.players.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
  });

  test('same seed is deterministic', () => {
    const a = createInitialGame(defaultGameGateway, players, 'same', boardData, cardsData, gameConfig);
    const b = createInitialGame(defaultGameGateway, players, 'same', boardData, cardsData, gameConfig);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.state).toEqual(b.state);
  });

  test('reports failure (does not throw) when the gateway createGame throws and preserves the original error', () => {
    const boom = new Error('bad input');
    const throwing: GameRuntimeGateway = {
      ...defaultGameGateway,
      createGame: () => {
        throw boom;
      },
    };
    const created = createInitialGame(throwing, players, 'seed', boardData, cardsData, gameConfig);
    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created).toMatchObject({ ok: false, message: 'Unable to start the game with the current room players.' });
      expect(created.error).toBe(boom);
    }
  });
});

describe('applyGameIntent', () => {
  test('accepted roll returns ok, a new state, and ordered events', () => {
    const state = startState();
    const actor = state.currentPlayerId;
    const outcome = applyGameIntent(defaultGameGateway, state, actor, { type: 'roll_dice' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state).not.toBe(state);
    expect(Array.isArray(outcome.events)).toBe(true);
  });

  test('engine rule failure returns the mapped code with no exception flag', () => {
    const state = startState();
    const notActor = state.players.find((p) => p.id !== state.currentPlayerId)!.id;
    const outcome = applyGameIntent(defaultGameGateway, state, notActor, { type: 'roll_dice' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NOT_YOUR_TURN');
    expect(outcome.error).toBeUndefined();
  });

  test('a thrown applyIntent maps to ILLEGAL_INTENT and surfaces the error object', () => {
    const boom = new Error('effect-chain overflow');
    const throwing: GameRuntimeGateway = {
      ...defaultGameGateway,
      applyIntent: () => {
        throw boom;
      },
    };
    const state = startState();
    const outcome = applyGameIntent(throwing, state, state.currentPlayerId, { type: 'roll_dice' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('ILLEGAL_INTENT');
    expect(outcome.error).toBe(boom);
  });
});

describe('chooseTakeoverIntent', () => {
  test('maps each turnPhase to the fixed no-buy/no-build policy', () => {
    const base = startState();
    const cases: Array<[GameState['turnPhase'], Intent]> = [
      ['awaiting_roll', { type: 'roll_dice' }],
      ['awaiting_airport_roll', { type: 'roll_airport_branch' }],
      ['awaiting_buy_decision', { type: 'skip_buy' }],
      ['awaiting_build_decision', { type: 'skip_build' }],
      ['managing', { type: 'end_turn' }],
    ];
    for (const [turnPhase, intent] of cases) {
      expect(chooseTakeoverIntent({ ...base, turnPhase })).toEqual(intent);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run apps/server/src/__tests__/gameRuntime.test.ts`
Expected: FAIL — `Cannot find module '../game/gameRuntime'` (file does not exist yet).

- [ ] **Step 3: Implement `gameRuntime.ts`**

Create `apps/server/src/game/gameRuntime.ts`:

```ts
import { applyIntent, chooseBotIntent, createGame } from '@richman/engine';
import type { BoardData, CardsData, GameConfig } from '@richman/board-data';
import type {
  ApplyResult,
  CreateGameInput,
  ErrorCode,
  GameEvent,
  GameState,
  Intent,
} from '@richman/engine';

// Board/card/config types are imported directly from @richman/board-data; do not rely on engine barrel re-exports.
export interface GameRuntimeGateway {
  createGame(input: CreateGameInput): GameState;
  applyIntent(state: GameState, playerId: string, intent: Intent): ApplyResult;
  chooseBotIntent(state: GameState, playerId: string): Intent;
}

export const defaultGameGateway: GameRuntimeGateway = { createGame, applyIntent, chooseBotIntent };

const NO_ARG_INTENTS = new Set<Intent['type']>([
  'roll_dice',
  'roll_airport_branch',
  'buy_property',
  'skip_buy',
  'build_house',
  'skip_build',
  'end_turn',
  'declare_bankrupt',
]);

const CELL_ID_INTENTS = new Set<Intent['type']>([
  'sell_house',
  'sell_property',
  'mortgage_property',
  'redeem_property',
]);

export function isValidIntent(value: unknown): value is Intent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== 'string') return false;
  if (NO_ARG_INTENTS.has(type as Intent['type'])) return true;
  if (CELL_ID_INTENTS.has(type as Intent['type'])) return Number.isInteger(record.cellId);
  return false;
}

export type CreateInitialGameResult =
  | { ok: true; state: GameState }
  | { ok: false; message: string; error: unknown };

export function createInitialGame(
  gateway: GameRuntimeGateway,
  players: { id: string; nickname: string; isBot: boolean }[],
  seed: string,
  board: BoardData,
  cards: CardsData,
  config: GameConfig,
): CreateInitialGameResult {
  try {
    const state = gateway.createGame({ board, cards, config, players, seed, cashGoal: null });
    return { ok: true, state };
  } catch (error) {
    return { ok: false, message: 'Unable to start the game with the current room players.', error };
  }
}

export type GameApplyOutcome =
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; code: ErrorCode; error?: unknown };

export function applyGameIntent(
  gateway: GameRuntimeGateway,
  state: GameState,
  playerId: string,
  intent: Intent,
): GameApplyOutcome {
  let result: ApplyResult;
  try {
    result = gateway.applyIntent(state, playerId, intent);
  } catch (error) {
    return { ok: false, code: 'ILLEGAL_INTENT', error };
  }
  if (!result.ok) return { ok: false, code: result.code };
  return { ok: true, state: result.state, events: result.events };
}

const TAKEOVER_POLICY: Record<GameState['turnPhase'], Intent> = {
  awaiting_roll: { type: 'roll_dice' },
  awaiting_airport_roll: { type: 'roll_airport_branch' },
  awaiting_buy_decision: { type: 'skip_buy' },
  awaiting_build_decision: { type: 'skip_build' },
  managing: { type: 'end_turn' },
};

// Fixed offline-takeover policy (spec §9.4). Never sells assets or declares bankruptcy.
export function chooseTakeoverIntent(state: GameState): Intent {
  return TAKEOVER_POLICY[state.turnPhase];
}
```

`BoardData`/`CardsData`/`GameConfig` are imported directly from `@richman/board-data`; do not use the engine barrel for those types.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run apps/server/src/__tests__/gameRuntime.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/game/gameRuntime.ts apps/server/src/__tests__/gameRuntime.test.ts
git commit -m "feat(server): add stateless gameRuntime gateway with intent validation and rollback"
```

---

### Review Gate A (end of Phase 1)

Dispatch two independent reviewers before Phase 2:
- **Spec-compliance review** against spec §4.1, §5.1, §5.4, §8.1, §8.4, §9.4: intent-shape validation matches §8.1; `createInitialGame` uses `cashGoal:null`; error messages are fixed and non-sensitive; exception path returns `ILLEGAL_INTENT` and never forwards exception text; takeover policy table exactly matches §9.4.
- **Code-quality review**: gateway is stateless (no Room map / Socket.IO / timers), no `any`, no dead branches, `isValidIntent` rejects arrays/null/unknown types.

Resolve every Critical/Important finding and re-run `vitest run src/__tests__/gameRuntime.test.ts` before Task 4.

---
## Phase 2 — Room aggregate

### Task 4: Room game-state model, deps, `getGameSnapshot`, `startRoom` creation + initial snapshot

**Files:**
- Modify: `apps/server/src/rooms/roomTypes.ts`
- Modify: `apps/server/src/rooms/roomManager.ts`
- Modify: `apps/server/src/production.ts` (provide the two new required deps)
- Modify: `apps/server/src/__tests__/roomManager.test.ts` (harness factory + the single sanctioned startRoom event assertion/name update)
- Modify: `apps/server/src/__tests__/socketRooms.test.ts` (harness factory only)
- Modify: `apps/server/src/__tests__/serverStatic.test.ts` (deterministic factory only)
- Test: `apps/server/src/__tests__/roomGame.test.ts` (Tester authors first)

- [ ] **Step 1 (Tester): Write the failing start tests**

Create `apps/server/src/__tests__/roomGame.test.ts` with a local deterministic harness (mirror `roomManager.test.ts`'s `createHarness`, plus `generateGameSeed`/`nextAutomationDelayMs`). Use the real engine + real board data. No timers fire in this task.

```ts
import { describe, expect, test } from 'vitest';
import { boardData, cardsData, gameConfig } from '@richman/board-data';
import type { GameState } from '@richman/engine';
import { createGame } from '@richman/engine';
import { RoomManager } from '../rooms/roomManager';
import type { RoomDomainEvent, RoomManagerDependencies } from '../rooms/roomTypes';

type TimerHandle = { callback: () => void; delayMs: number; active: boolean; generation?: number };

type HarnessOptions = {
  playerIds?: string[];
  tokens?: string[];
  roomNumbers?: number[];
  seed?: string;
  delays?: number[];
  gameGateway?: RoomManagerDependencies<TimerHandle>['gameGateway'];
  onServerError?: RoomManagerDependencies<TimerHandle>['onServerError'];
};

function createHarness(options: HarnessOptions = {}) {
  const roomNumbers = options.roomNumbers ?? [7];
  const playerIds = options.playerIds ?? [];
  const tokens = options.tokens ?? [];
  const delays = options.delays ?? [];
  const asyncEvents: RoomDomainEvent[] = [];
  const timers: TimerHandle[] = [];
  let roomNumberIndex = 0;
  let playerIdIndex = 0;
  let tokenIndex = 0;
  let delayIndex = 0;

  const dependencies: RoomManagerDependencies<TimerHandle> = {
    generatePlayerId: () => {
      const id = playerIds[playerIdIndex] ?? `player-${playerIdIndex}`;
      playerIdIndex += 1;
      return id;
    },
    generateToken: () => {
      const token = tokens[tokenIndex] ?? `token-${tokenIndex}`;
      tokenIndex += 1;
      return token;
    },
    nextRoomNumber: () => roomNumbers[roomNumberIndex++],
    compareTokens: (actual, supplied) => actual === supplied,
    setTimer: (callback, delayMs) => {
      let handle: TimerHandle;
      handle = {
        delayMs,
        active: true,
        callback: () => {
          handle.active = false;
          callback();
        },
      };
      timers.push(handle);
      return handle;
    },
    clearTimer: (handle) => {
      handle.active = false;
    },
    onAsyncEvents: (events) => asyncEvents.push(...events),
    generateGameSeed: () => options.seed ?? 'game-seed',
    nextAutomationDelayMs: () => {
      const delay = delays[delayIndex] ?? 1000;
      delayIndex += 1;
      return delay;
    },
    gameGateway: options.gameGateway,
    onServerError: options.onServerError,
  };

  const manager = new RoomManager<TimerHandle>(dependencies);
  return { manager, asyncEvents, timers };
}

// Two humans + host so the room can start; first engine actor is always a human here.
function startedRoom(seed = 'game-seed') {
  const { manager, timers } = createHarness({
    playerIds: ['host', 'guest'],
    tokens: ['tok-host', 'tok-guest'],
    seed,
  });
  const create = manager.createRoom('房主');
  if (!create.ok) throw new Error('createRoom failed');
  const join = manager.joinRoom('0007', '客人');
  if (!join.ok) throw new Error('joinRoom failed');
  return { manager, timers };
}

describe('startRoom creates one authoritative GameState', () => {
  test('emits room_state(playing) then a game_snapshot whose state matches deterministic createGame', () => {
    const { manager } = startedRoom('deterministic-seed');
    const result = manager.startRoom('0007', 'host');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe('playing');
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({ type: 'room_state', roomCode: '0007' });
    expect((result.events[0] as { room: { status: string } }).room.status).toBe('playing');

    const snapshotEvent = result.events[1] as { type: string; state: GameState };
    expect(snapshotEvent.type).toBe('game_snapshot');

    const expected = createGame({
      board: boardData,
      cards: cardsData,
      config: gameConfig,
      players: [
        { id: 'host', nickname: '房主', isBot: false },
        { id: 'guest', nickname: '客人', isBot: false },
      ],
      seed: 'deterministic-seed',
      cashGoal: null,
    });
    expect(snapshotEvent.state).toEqual(expected);
    expect(snapshotEvent.state.cashGoal).toBeNull();
  });

  test('room/game invariants: every non-bot RoomPlayer appears once in gameState.players', () => {
    const { manager } = startedRoom();
    manager.startRoom('0007', 'host');
    const snapshot = manager.getGameSnapshot('0007');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.players.map((p) => p.id).sort()).toEqual(['guest', 'host']);
    expect(JSON.stringify(snapshot)).not.toContain('tok-host');
    expect(JSON.stringify(snapshot)).not.toContain('tok-guest');
  });

  test('getGameSnapshot returns null for a lobby room and null for an unknown room', () => {
    const { manager } = startedRoom();
    expect(manager.getGameSnapshot('0007')).toBeNull(); // still lobby
    expect(manager.getGameSnapshot('9999')).toBeNull();
  });

  test('mirrors an offline lobby guest into the created GameState player', () => {
    const { manager } = createHarness({ playerIds: ['host', 'guest'], tokens: ['t1', 't2'] });
    manager.createRoom('房主');
    manager.joinRoom('0007', '客人');
    manager.markDisconnected('0007', 'guest'); // guest offline during lobby grace
    const result = manager.startRoom('0007', 'host');
    expect(result.ok).toBe(true);
    const snapshot = manager.getGameSnapshot('0007');
    expect(snapshot!.players.find((p) => p.id === 'guest')!.online).toBe(false);
    expect(snapshot!.players.find((p) => p.id === 'host')!.online).toBe(true);
  });

  test('createGame exception leaves the lobby byte-for-byte unchanged, logs the original error, and returns INVALID_ROOM_ACTION', () => {
    const asyncEvents: RoomDomainEvent[] = [];
    const serverErrors: unknown[] = [];
    const boom = new Error('boom');
    const throwingGateway = {
      createGame: () => {
        throw boom;
      },
      applyIntent: () => {
        throw new Error('unused');
      },
      chooseBotIntent: () => ({ type: 'roll_dice' as const }),
    };
    const deps: RoomManagerDependencies<TimerHandle> = {
      generatePlayerId: (() => {
        let i = 0;
        const ids = ['host', 'guest'];
        return () => ids[i++] ?? `p-${i}`;
      })(),
      generateToken: (() => {
        let i = 0;
        return () => `tok-${i++}`;
      })(),
      nextRoomNumber: () => 7,
      compareTokens: (a, b) => a === b,
      setTimer: (callback, delayMs) => ({ callback, delayMs, active: true }),
      clearTimer: (h) => {
        h.active = false;
      },
      onAsyncEvents: (e) => asyncEvents.push(...e),
      generateGameSeed: () => 'seed',
      nextAutomationDelayMs: () => 1000,
      gameGateway: throwingGateway,
      onServerError: (_message, error) => serverErrors.push(error),
    };
    const manager = new RoomManager<TimerHandle>(deps);
    manager.createRoom('房主');
    manager.joinRoom('0007', '客人');
    const before = manager.getPublicRoom('0007');

    const result = manager.startRoom('0007', 'host');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_ROOM_ACTION');
    expect(serverErrors).toEqual([boom]);
    expect(manager.getPublicRoom('0007')).toEqual(before); // status still lobby, players unchanged
    expect(manager.getGameSnapshot('0007')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run apps/server/src/__tests__/roomGame.test.ts`
Expected: FAIL — `getGameSnapshot` is not a function / `gameState` / new deps do not exist yet, and `startRoom` emits only `room_state` (length 1, no `game_snapshot`).

- [ ] **Step 3: Extend `roomTypes.ts`**

```ts
import type { PublicRoomPlayer, PublicRoomState, RoomDomainEvent, RoomStatus } from '../protocol';
import type { RoomFailure, WireFailure } from './roomErrors';
import type { GameState } from '@richman/engine';
import type { GameRuntimeGateway } from '../game/gameRuntime';

export type { PublicRoomPlayer, PublicRoomState, RoomDomainEvent, RoomStatus } from '../protocol';
export type { RoomErrorCode, RoomFailure, GameErrorCode, WireFailure } from './roomErrors';

export type RoomSuccess<T> = { ok: true; value: T; events: RoomDomainEvent[] };
export type RoomResult<T> = RoomSuccess<T> | RoomFailure;
// Game actions may fail with engine codes; their failure still satisfies the wire ack shape.
export type GameActionResult<T> = RoomSuccess<T> | WireFailure;

export type AutomationSource = 'manual' | 'bot' | 'offline_takeover';

export interface RoomAutomation {
  generation: number;
  mode: 'bot' | 'offline_takeover';
  playerId: string;
  startedTurn: number;
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
  gameGateway?: GameRuntimeGateway; // optional: real engine by default; stub only to force exceptions
  onServerError?(message: string, error: unknown): void; // optional server-side logging (no tokens)
}

export interface RoomPlayer extends PublicRoomPlayer {
  token: string | null;
}

export interface Room {
  code: string;
  status: RoomStatus;
  hostId: string;
  players: RoomPlayer[];
  gameState: GameState | null;
}
```

Keep `CreateRoomValue`/`JoinRoomValue` unchanged.

- [ ] **Step 4: Extend `roomManager.ts` — imports, fields, helpers, `getGameSnapshot`, `startRoom`, `dispose`**

Add imports near the top:

```ts
import { boardData, cardsData, gameConfig } from '@richman/board-data';
import type { GameState } from '@richman/engine';
import { createInitialGame, defaultGameGateway } from '../game/gameRuntime';
import type { GameRuntimeGateway } from '../game/gameRuntime';
import type { AutomationSource, GameActionResult, Room, RoomAutomation /* + existing */ } from './roomTypes';
```

Add fields inside the class:

```ts
  readonly #gameAutomationTimers = new Map<string, TTimerHandle>();
  readonly #automation = new Map<string, RoomAutomation>();
  readonly #automationGeneration = new Map<string, number>();
  readonly #gateway: GameRuntimeGateway;
```

In the constructor, resolve the gateway:

```ts
  constructor(dependencies: RoomManagerDependencies<TTimerHandle>) {
    this.#dependencies = dependencies;
    this.#gateway = dependencies.gameGateway ?? defaultGameGateway;
  }
```

Set `gameState: null` in the two places rooms are created (`createRoom`'s room literal). The `Room` literal in `createRoom` must include `gameState: null`.

Add helpers (bodies used from this task onward):

```ts
  #engineActor(state: GameState): string {
    return state.debt?.debtorId ?? state.currentPlayerId;
  }

  #mirrorOnlineIntoGame(room: Room, playerId: string, online: boolean): void {
    const state = room.gameState;
    if (state === null) return;
    const gamePlayer = state.players.find((p) => p.id === playerId);
    if (gamePlayer === undefined || gamePlayer.isBot || gamePlayer.online === online) return;
    room.gameState = {
      ...state,
      players: state.players.map((p) => (p.id === playerId ? { ...p, online } : p)),
    };
  }

  #currentGeneration(roomCode: string): number {
    return this.#automationGeneration.get(roomCode) ?? 0;
  }

  #clearAutomation(roomCode: string): void {
    const handle = this.#gameAutomationTimers.get(roomCode);
    if (handle !== undefined) {
      this.#dependencies.clearTimer(handle);
      this.#gameAutomationTimers.delete(roomCode);
    }
    this.#automation.delete(roomCode);
    this.#automationGeneration.set(roomCode, this.#currentGeneration(roomCode) + 1);
  }
```

Add the snapshot accessor:

```ts
  getGameSnapshot(roomCode: string): GameState | null {
    return this.#rooms.get(roomCode)?.gameState ?? null;
  }
```

Rewrite `startRoom` (keep the M1 validations, add game creation; automation scheduling on start is added in Task 8):

```ts
  startRoom(roomCode: string, requesterId: string): RoomResult<PublicRoomState> {
    const validation = validateHostLobbyRoom(this.#rooms.get(roomCode), requesterId);
    if (!validation.ok) return validation;
    const room = validation.room;
    if (room.players.length < 2 || room.players.every((player) => player.isBot)) {
      return roomFailure('NOT_ENOUGH_PLAYERS', 'At least two players including one human are required.');
    }

    const seed = this.#dependencies.generateGameSeed();
    const created = createInitialGame(
      this.#gateway,
      room.players.map((p) => ({ id: p.id, nickname: p.nickname, isBot: p.isBot })),
      seed,
      boardData,
      cardsData,
      gameConfig,
    );
    if (!created.ok) {
      this.#dependencies.onServerError?.('startRoom createGame failed', created.error);
      return roomFailure('INVALID_ROOM_ACTION', 'Unable to start the game.');
    }

    // Mirror each RoomPlayer's current online value into the new GameState (spec §7 step 8).
    let state = created.state;
    state = {
      ...state,
      players: state.players.map((gamePlayer) => {
        const roomPlayer = room.players.find((p) => p.id === gamePlayer.id);
        return roomPlayer !== undefined && !gamePlayer.isBot && gamePlayer.online !== roomPlayer.online
          ? { ...gamePlayer, online: roomPlayer.online }
          : gamePlayer;
      }),
    };

    this.#cancelLobbyDisconnectTimersForRoom(room.code);
    room.gameState = state;
    room.status = 'playing';

    const publicRoom = projectPublicRoom(room);
    const events: RoomDomainEvent[] = [
      { type: 'room_state', roomCode: room.code, room: publicRoom },
      { type: 'game_snapshot', roomCode: room.code, state },
    ];
    // Task 8 inserts: this.#reconcileAfterStart(room, state); (BOT-first automation)
    return { ok: true, value: publicRoom, events };
  }
```

Update `dispose` to also cancel game-automation timers (spec §14):

```ts
  dispose(): void {
    for (const handle of this.#lobbyDisconnectTimers.values()) {
      this.#dependencies.clearTimer(handle);
    }
    this.#lobbyDisconnectTimers.clear();
    const automationRoomCodes = new Set([...this.#gameAutomationTimers.keys(), ...this.#automation.keys()]);
    for (const roomCode of automationRoomCodes) {
      this.#clearAutomation(roomCode); // cancels timer, removes record, and bumps generation for queued callbacks
    }
    this.#gameAutomationTimers.clear();
    this.#automation.clear();
  }
```

- [ ] **Step 5: Supply the two new required deps in production + M1 harness factories**

`apps/server/src/production.ts` — add to `createProductionRoomManager`'s dependency object (import `randomBytes` already present; `randomInt` already imported):

```ts
    generateGameSeed: () => randomBytes(TOKEN_BYTE_LENGTH).toString('hex'),
    nextAutomationDelayMs: () => randomInt(MIN_AUTOMATION_DELAY_MS, MAX_AUTOMATION_DELAY_MS + 1),
```

Add the constants near the top of `production.ts`:

```ts
const MIN_AUTOMATION_DELAY_MS = 800;
const MAX_AUTOMATION_DELAY_MS = 1600;
```

`apps/server/src/__tests__/roomManager.test.ts` — in `createHarness`, add to the returned `dependencies` object (mechanical), and update the one sanctioned M1 assertion named in the file map from `room_state` only to ordered `[room_state, game_snapshot]` with a deterministic `GameState` expectation:

```ts
    generateGameSeed() {
      return 'test-game-seed';
    },
    nextAutomationDelayMs() {
      return 1000;
    },
```

Also add the two fields to the local `RoomManagerDependencies` interface declared in that test file.

`apps/server/src/__tests__/socketRooms.test.ts` — in `createDeterministicRoomManagerFactory`'s `dependencies`, add the same two functions:

```ts
      generateGameSeed() {
        return 'socket-game-seed';
      },
      nextAutomationDelayMs() {
        return 1000;
      },
```

`apps/server/src/__tests__/serverStatic.test.ts` — in `createDeterministicRoomManager`'s typed `RoomManagerDependencies` object, add the same two functions. This file imports the real dependency type, so the build fails until it is updated:

```ts
      generateGameSeed() {
        return 'static-game-seed';
      },
      nextAutomationDelayMs() {
        return 1000;
      },
```

- [ ] **Step 6: Run the new + M1 room/static tests**

Run: `pnpm exec vitest run apps/server/src/__tests__/roomGame.test.ts apps/server/src/__tests__/roomManager.test.ts apps/server/src/__tests__/socketRooms.test.ts apps/server/src/__tests__/serverStatic.test.ts`
Expected: PASS — new start tests green; the sanctioned `roomManager.test.ts` start assertion now expects `room_state` then `game_snapshot`; every other M1 room, socket, and static test remains green.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/rooms/roomTypes.ts apps/server/src/rooms/roomManager.ts apps/server/src/production.ts apps/server/src/__tests__/roomGame.test.ts apps/server/src/__tests__/roomManager.test.ts apps/server/src/__tests__/socketRooms.test.ts apps/server/src/__tests__/serverStatic.test.ts
git commit -m "feat(server): attach authoritative GameState to started rooms with initial snapshot"
```

---
### Task 5: `applyGameIntent` shared committed transition, snapshots, and `ended`

**Files:**
- Modify: `apps/server/src/rooms/roomManager.ts`
- Test: `apps/server/src/__tests__/roomGame.test.ts` (Tester adds a `describe` block)

This task builds the shared committed transition (spec §8.3) and the manual entry point (§8.2). Source-aware reconciliation (§9.2) is a no-op stub here — implemented in Phase 3. The manual takeover-lock check reads the (currently always-empty) `#automation` map; its rejection behavior is exercised in Task 10.

- [ ] **Step 1 (Tester): Write the failing transition tests**

Add to `apps/server/src/__tests__/roomGame.test.ts`. Reuse `createHarness`/`startedRoom`. Drive a real deterministic turn: read the snapshot's `currentPlayerId` and apply the actor's real intents.

```ts
describe('applyGameIntent shared committed transition', () => {
  test('accepted intent replaces state and emits exactly one game_events batch', () => {
    const { manager } = startedRoom('turn-seed');
    const start = manager.startRoom('0007', 'host');
    if (!start.ok) throw new Error('start failed');
    const before = manager.getGameSnapshot('0007')!;
    const actor = before.currentPlayerId;

    const result = manager.applyGameIntent('0007', actor, { type: 'roll_dice' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const gameEvents = result.events.filter((e) => e.type === 'game_events');
    expect(gameEvents).toHaveLength(1);
    expect(manager.getGameSnapshot('0007')).not.toBe(before); // state replaced
  });

  test('engine rule failure keeps the same state reference and emits nothing', () => {
    const { manager } = startedRoom();
    manager.startRoom('0007', 'host');
    const before = manager.getGameSnapshot('0007')!;
    const notActor = before.players.find((p) => p.id !== before.currentPlayerId)!.id;

    const result = manager.applyGameIntent('0007', notActor, { type: 'roll_dice' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NOT_YOUR_TURN');
    expect(result.message).toBe('还没轮到你行动。');
    expect(manager.getGameSnapshot('0007')).toBe(before); // identical reference
  });

  test('a thrown apply retains state, logs server-side, and maps to ILLEGAL_INTENT', () => {
    const logs: string[] = [];
    const boom = new Error('overflow');
    const gateway = {
      createGame,
      applyIntent: () => {
        throw boom;
      },
      chooseBotIntent: () => ({ type: 'roll_dice' as const }),
    };
    const { manager } = startedRoomWith({ gameGateway: gateway, onServerError: (m) => logs.push(m) });
    manager.startRoom('0007', 'host');
    const before = manager.getGameSnapshot('0007')!;

    const result = manager.applyGameIntent('0007', before.currentPlayerId, { type: 'roll_dice' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('ILLEGAL_INTENT');
    expect(manager.getGameSnapshot('0007')).toBe(before);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join(' ')).not.toContain('tok-'); // no tokens leaked to logs
  });

  test('a transition whose events include turn_ended appends a snapshot after the batch', () => {
    // Drive the current actor to end_turn through its real phases; assert order.
    const { manager } = startedRoom('boundary-seed');
    manager.startRoom('0007', 'host');
    const events = playFullTurn(manager, '0007'); // helper returns the concatenated domain events of the final transition
    const finalTransition = events; // events from the transition that produced turn_ended
    const turnEndedIdx = finalTransition.findIndex(
      (e) => e.type === 'game_events' && e.events.some((ge) => ge.type === 'turn_ended'),
    );
    const snapshotIdx = finalTransition.findIndex((e) => e.type === 'game_snapshot');
    expect(turnEndedIdx).toBeGreaterThanOrEqual(0);
    expect(snapshotIdx).toBe(turnEndedIdx + 1); // snapshot immediately after the turn_ended batch
  });

  test('game_over sets status ended, cancels automation, and delivers a final snapshot; later commands fail safely', () => {
    // Use a forced two-player last-standing finish via a scripted gateway that returns game_over events.
    const { manager } = startedRoomWith({ gameGateway: gameOverGateway });
    manager.startRoom('0007', 'host');
    const before = manager.getGameSnapshot('0007')!;
    const result = manager.applyGameIntent('0007', before.currentPlayerId, { type: 'end_turn' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(manager.getPublicRoom('0007')!.status).toBe('ended');
    const snapshots = result.events.filter((e) => e.type === 'game_snapshot');
    expect(snapshots).toHaveLength(1); // one final snapshot, not duplicated
    expect((snapshots[0] as { state: GameState }).state.phase).toBe('game_over');

    // Later commands on an ended room fail safely and do not mutate.
    const after = manager.applyGameIntent('0007', before.currentPlayerId, { type: 'roll_dice' });
    expect(after.ok).toBe(false);
    expect(manager.startRoom('0007', 'host').ok).toBe(false);
  });
});
```

The Tester adds three small helpers to the test file:
- `startedRoomWith(extraDeps)`: like `startedRoom` but merges `extraDeps` (e.g. `gameGateway`, `onServerError`) into the harness `dependencies`.
- `playFullTurn(manager, roomCode)`: repeatedly reads the snapshot's `currentPlayerId`/`turnPhase`, applies the real deterministic intent for that phase (roll → possibly airport roll → skip_buy → skip_build → end_turn), and returns the `RoomDomainEvent[]` of the transition that produced `turn_ended`.
- `gameOverGateway`: `{ createGame, applyIntent: (state, id, intent) => ({ ok: true, state: { ...state, phase: 'game_over', winnerId: id }, events: [{ type: 'game_over', winnerId: id, reason: 'last_standing' }] }), chooseBotIntent }`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run apps/server/src/__tests__/roomGame.test.ts -t "applyGameIntent shared committed transition"`
Expected: FAIL — `applyGameIntent` is not a function on `RoomManager`.

- [ ] **Step 3: Implement the manual entry point + shared transition**

Add to `apps/server/src/rooms/roomManager.ts`. Import the runtime + failure helpers:

```ts
import { applyGameIntent as runtimeApplyGameIntent } from '../game/gameRuntime';
import { gameFailure } from './roomErrors';
import type { WireFailure } from './roomErrors';
import type { Intent } from '@richman/engine';
```

Public method:

```ts
  applyGameIntent(roomCode: string, playerId: string, intent: Intent): GameActionResult<Record<string, never>> {
    const room = this.#rooms.get(roomCode);
    if (room === undefined || room.status !== 'playing' || room.gameState === null) {
      return roomFailure('INVALID_ROOM_ACTION', 'No active game for that action.');
    }
    // Manual-only takeover lock (spec §8.2 step 4): reject the locked actor's manual intent.
    const record = this.#automation.get(roomCode);
    if (record !== undefined && record.mode === 'offline_takeover' && record.playerId === playerId) {
      return roomFailure('INVALID_ROOM_ACTION', 'The server is completing this offline turn.');
    }
    const outcome = this.#commitTransition(room, playerId, intent, 'manual');
    if (!outcome.ok) return outcome;
    return { ok: true, value: {}, events: outcome.events };
  }
```

Private shared committed transition (spec §8.3):

```ts
  #commitTransition(
    room: Room,
    actorId: string,
    intent: Intent,
    source: AutomationSource,
  ): { ok: true; events: RoomDomainEvent[] } | WireFailure {
    const previousState = room.gameState!;
    const outcome = runtimeApplyGameIntent(this.#gateway, previousState, actorId, intent);
    if (!outcome.ok) {
      if (outcome.error !== undefined) {
        this.#dependencies.onServerError?.(`game intent threw in room ${room.code}`, outcome.error);
      }
      return gameFailure(outcome.code); // state reference unchanged; no domain event
    }

    room.gameState = outcome.state; // replace before producing events (spec §8.3 step 4)
    const events: RoomDomainEvent[] = [{ type: 'game_events', roomCode: room.code, events: outcome.events }];

    const turnEnded = outcome.events.some((e) => e.type === 'turn_ended');
    if (turnEnded) {
      events.push({ type: 'game_snapshot', roomCode: room.code, state: outcome.state });
    }

    const gameOver = outcome.state.phase === 'game_over' || outcome.events.some((e) => e.type === 'game_over');
    if (gameOver) {
      room.status = 'ended';
      this.#clearAutomation(room.code);
      if (!turnEnded) {
        events.push({ type: 'game_snapshot', roomCode: room.code, state: outcome.state });
      }
    } else {
      this.#reconcileAfterTransition(room, source);
    }

    return { ok: true, events };
  }
```

Add the Phase-3 hook as a temporary no-op so this task compiles and the game-over/turn-boundary tests pass without automation. Task 8 replaces the body:

```ts
  #reconcileAfterTransition(_room: Room, _source: AutomationSource): void {
    // Filled in Task 8 (BOT reconciliation) and Tasks 9/10 (debt/takeover).
  }
```

- [ ] **Step 4: Run to verify passing**

Run: `pnpm exec vitest run apps/server/src/__tests__/roomGame.test.ts`
Expected: PASS — transition, failure, exception, turn-ended-then-snapshot, and game-over-final-snapshot tests green; earlier start tests still green.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/rooms/roomManager.ts apps/server/src/__tests__/roomGame.test.ts
git commit -m "feat(server): commit game intents with ordered events, boundary snapshots, and ended status"
```

---
### Task 6: Online-state mirroring (disconnect / leave / resume) and M1-shape resume

**Files:**
- Modify: `apps/server/src/rooms/roomManager.ts`
- Test: `apps/server/src/__tests__/roomGame.test.ts` (Tester adds a `describe` block)

Spec §10 + §13. `resumeRoom` keeps its exact M1 signature `RoomResult<PublicRoomState>`; it only additionally mirrors online into GameState. The wire snapshot is fetched separately via `getGameSnapshot` (Task 4) and assembled by the adapter (Task 12). A connection-only mirror never creates a `game_events` batch.

- [ ] **Step 1 (Tester): Write the failing mirroring tests**

Add to `apps/server/src/__tests__/roomGame.test.ts`.

```ts
describe('online-state mirroring', () => {
  test('playing disconnect mirrors offline into GameState without emitting game_events', () => {
    const { manager } = startedRoom();
    manager.startRoom('0007', 'host');
    const result = manager.markDisconnected('0007', 'guest');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events.some((e) => e.type === 'game_events')).toBe(false);
    expect(manager.getGameSnapshot('0007')!.players.find((p) => p.id === 'guest')!.online).toBe(false);
    // RoomPlayer online is authoritative and also false:
    expect(manager.getPublicRoom('0007')!.players.find((p) => p.id === 'guest')!.online).toBe(false);
  });

  test('resumeRoom keeps the exact M1 RoomResult<PublicRoomState> shape and mirrors online back into GameState', () => {
    const { manager } = startedRoom();
    manager.startRoom('0007', 'host');
    manager.markDisconnected('0007', 'guest');

    const result = manager.resumeRoom('0007', 'guest', 'tok-guest');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // M1 shape: value is PublicRoomState, no snapshot field on the room result itself.
    expect(result.value.roomCode).toBe('0007');
    expect('snapshot' in result.value).toBe(false);
    expect(result.events.some((e) => e.type === 'game_snapshot')).toBe(false); // no snapshot broadcast to peers on resume
    expect(manager.getGameSnapshot('0007')!.players.find((p) => p.id === 'guest')!.online).toBe(true);
  });

  test('BOT players stay online in both representations', () => {
    const { manager } = createHarness({ playerIds: ['host', 'guest'], tokens: ['t1', 't2'] });
    manager.createRoom('房主');
    manager.joinRoom('0007', '客人');
    manager.addBot('0007', 'host');
    manager.startRoom('0007', 'host');
    const snapshot = manager.getGameSnapshot('0007')!;
    for (const p of snapshot.players.filter((pl) => pl.isBot)) {
      expect(p.online).toBe(true);
    }
  });

  test('ended-room disconnect marks the human offline and mirrors it without deleting the seat', () => {
    const { manager } = startedRoomWith({ gameGateway: gameOverGateway });
    manager.startRoom('0007', 'host');
    const s0 = manager.getGameSnapshot('0007')!;
    manager.applyGameIntent('0007', s0.currentPlayerId, { type: 'end_turn' }); // → ended
    expect(manager.getPublicRoom('0007')!.status).toBe('ended');

    const result = manager.markDisconnected('0007', 'guest');
    expect(result.ok).toBe(true);
    expect(manager.getPublicRoom('0007')!.players.some((p) => p.id === 'guest')).toBe(true); // seat retained
    expect(manager.getGameSnapshot('0007')!.players.find((p) => p.id === 'guest')!.online).toBe(false);
  });

  test('ended-room resume returns final room and keeps the seat; token resume stays valid', () => {
    const { manager } = startedRoomWith({ gameGateway: gameOverGateway });
    manager.startRoom('0007', 'host');
    const s0 = manager.getGameSnapshot('0007')!;
    manager.applyGameIntent('0007', s0.currentPlayerId, { type: 'end_turn' });
    manager.markDisconnected('0007', 'guest');

    const result = manager.resumeRoom('0007', 'guest', 'tok-guest');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(manager.getGameSnapshot('0007')!.phase).toBe('game_over');
    expect(manager.getGameSnapshot('0007')!.players.find((p) => p.id === 'guest')!.online).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run apps/server/src/__tests__/roomGame.test.ts -t "online-state mirroring"`
Expected: FAIL — GameState `online` still `true` after disconnect (mirror not wired into `#markPlayerOffline`/`resumeRoom`).

- [ ] **Step 3: Wire mirroring into `#markPlayerOffline` and `resumeRoom`**

In `#markPlayerOffline`, after setting `player.online = false`, mirror into GameState (only affects playing/ended rooms since lobby rooms have `gameState === null`):

```ts
  #markPlayerOffline(room: Room, playerIndex: number, transferHost: boolean): RoomSuccess<PublicRoomState | null> {
    const player = room.players[playerIndex];
    const events: RoomDomainEvent[] = [];
    if (player.online) {
      player.online = false;
      events.push({ type: 'player_connection', roomCode: room.code, playerId: player.id, online: false });
      this.#mirrorOnlineIntoGame(room, player.id, false);
    }

    if (transferHost && room.hostId === player.id && transferHostToNextHuman(room, playerIndex)) {
      events.push({ type: 'room_state', roomCode: room.code, room: projectPublicRoom(room) });
    }

    return { ok: true, value: projectPublicRoom(room), events };
  }
```

In `resumeRoom`, after `player.online = true`, mirror into GameState (add one line; do not change the return shape or the host-reassign logic):

```ts
    if (!player.online) {
      player.online = true;
      this.#mirrorOnlineIntoGame(room, playerId, true);
      events.push({ type: 'player_connection', roomCode, playerId, online: true });
    }
```

No change to `leaveRoom`: for playing/ended rooms it already routes through `#markPlayerOffline`, which now mirrors. Confirm the non-lobby branch of `leaveRoom` and `markDisconnected` both call `#markPlayerOffline`.

- [ ] **Step 4: Run to verify passing**

Run: `pnpm exec vitest run apps/server/src/__tests__/roomGame.test.ts apps/server/src/__tests__/roomManager.test.ts`
Expected: PASS — mirroring tests green; M1 room tests (which assert `resumeRoom` equality on `PublicRoomState`) still green because the result shape is unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/rooms/roomManager.ts apps/server/src/__tests__/roomGame.test.ts
git commit -m "feat(server): mirror connection state into GameState on disconnect, leave, and resume"
```

---

### Review Gate B (end of Phase 2)

Dispatch two independent reviewers before Phase 3:
- **Spec-compliance review** against §6 (room invariants), §7 (start order incl. offline-guest mirror + creation-exception rollback), §8.3 (events precede ack, state replaced before events, turn_ended/game_over snapshot rules), §10 (RoomPlayer.online authoritative, connection-only mirror emits no game_events, resume keeps M1 shape), §13 (ended disconnect/leave/resume retain seats).
- **Code-quality review**: no second GameState map introduced; immutable GameState updates only; `#commitTransition` has no `await` between reading and replacing state; game-over path cancels automation and does not duplicate the boundary snapshot.

Resolve every Critical/Important finding and re-run `vitest run src/__tests__/roomGame.test.ts src/__tests__/roomManager.test.ts src/__tests__/socketRooms.test.ts` before Task 7.

---
## Phase 3 — Automation

Automation invariants (spec §9.1–§9.2): one record + at most one game-automation timer per room; the engine actor is always `state.debt?.debtorId ?? state.currentPlayerId`; clearing/replacing automation increments the room generation, cancels the pending handle, and invalidates already-queued callbacks. Every automated callback goes through the shared committed transition (§8.3) and never through the manual socket checks.

### Task 7: Automation infrastructure — schedule, callback stale-guard, BOT scheduling primitive, dispose

**Files:**
- Modify: `apps/server/src/rooms/roomManager.ts`
- Test: `apps/server/src/__tests__/roomGame.test.ts` (Tester adds a `describe` block)

Introduces `#scheduleAutomation`, `#runAutomationCallback`, `#createAutomation`, `#startBotIfActorIsBot`, `#modeEligible`, `#reconcileAfterStart`, and wires `startRoom` to schedule a BOT when the first actor is a BOT. `#reconcileAfterTransition` stays the Task-5 no-op until Task 8, so a BOT scheduled here fires exactly once (the chain arrives in Task 8).

- [ ] **Step 1 (Tester): Write the failing infrastructure tests**

Add to `apps/server/src/__tests__/roomGame.test.ts`. Use the real engine; pick a seed that seats a BOT first via a pure scan helper. `TimerHandle` exposes `callback`, `delayMs`, `active`.

```ts
import { createGame } from '@richman/engine';

// Pure scan (real engine): find a seed whose first engine actor is the given bot id.
function seedWithBotFirst(players: { id: string; nickname: string; isBot: boolean }[], botId: string): string {
  for (let i = 0; i < 5000; i += 1) {
    const seed = `bot-first-${i}`;
    const state = createGame({ board: boardData, cards: cardsData, config: gameConfig, players, seed, cashGoal: null });
    if (state.currentPlayerId === botId) return seed;
  }
  throw new Error('no bot-first seed found');
}

// host (human) + one bot; returns manager + captured timers, started with a bot-first seed.
function startedBotFirstRoom(delays: number[] = [1234]) {
  const players = [
    { id: 'host', nickname: '房主', isBot: false },
    { id: 'botA', nickname: '电脑 A', isBot: true },
  ];
  const seed = seedWithBotFirst(players, 'botA');
  const { manager, timers, asyncEvents } = createHarness({ playerIds: ['host', 'botA'], tokens: ['tok-host'], seed, delays });
  manager.createRoom('房主');
  manager.addBot('0007', 'host');
  const start = manager.startRoom('0007', 'host');
  if (!start.ok) throw new Error('start failed');
  expect(start.events.map((e) => e.type)).toEqual(['room_state', 'game_snapshot']); // BOT-first start itself is still synchronous room_state + snapshot only
  return { manager, timers, asyncEvents };
}

describe('automation infrastructure', () => {
  test('startRoom schedules exactly one BOT automation timer with the injected delay when the first actor is a BOT', () => {
    const { timers } = startedBotFirstRoom([1234]);
    expect(timers.filter((t) => t.active)).toHaveLength(1);
    expect(timers[timers.length - 1].delayMs).toBe(1234);
  });

  test('firing the current BOT timer applies exactly one BOT intent and emits one game_events batch via onAsyncEvents', () => {
    const { manager, timers, asyncEvents } = startedBotFirstRoom();
    const before = manager.getGameSnapshot('0007')!;
    timers[timers.length - 1].callback();
    expect(manager.getGameSnapshot('0007')).not.toBe(before);
    expect(asyncEvents.filter((e) => e.type === 'game_events')).toHaveLength(1);
  });

  test('a human-first start schedules no automation timer', () => {
    const { manager, timers } = startedRoom(); // two humans; startRoom not yet called
    const start = manager.startRoom('0007', 'host');
    expect(start.ok).toBe(true);
    expect(timers.filter((t) => t.active)).toHaveLength(0); // human first actor -> no automation
  });

  test('dispose cancels the pending BOT timer and a later fire of that handle emits nothing', () => {
    const { manager, timers, asyncEvents } = startedBotFirstRoom();
    const handle = timers[timers.length - 1];
    manager.dispose();
    expect(handle.active).toBe(false);
    const emittedBefore = asyncEvents.length;
    handle.callback(); // simulate an already-queued callback firing after dispose
    expect(asyncEvents.length).toBe(emittedBefore); // no emit after dispose
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run apps/server/src/__tests__/roomGame.test.ts -t "automation infrastructure"`
Expected: FAIL — no timer is scheduled at start (startRoom does not yet call `#reconcileAfterStart`).

- [ ] **Step 3: Implement the infrastructure**

Add imports to `roomManager.ts`:

```ts
import { chooseTakeoverIntent } from '../game/gameRuntime';
```

Add the methods:

```ts
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
      return; // already scheduled for this exact bot tuple
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
    this.#clearAutomation(room.code); // cancel pending + bump generation
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
        return; // canceled, already fired, or superseded: never run against the current record
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
    return !actor.isBot && state.debt === null; // offline_takeover ignores online (reconnect keeps the lock)
  }

  #runAutomationCallback(roomCode: string, generation: number): void {
    const room = this.#rooms.get(roomCode);
    if (room === undefined || room.status !== 'playing') return;
    const state = room.gameState;
    if (state === null || state.phase === 'game_over') return;
    if (generation !== this.#currentGeneration(roomCode)) return; // superseded generation
    const record = this.#automation.get(roomCode);
    if (record === undefined || record.generation !== generation) return;

    const actorId = this.#engineActor(state);
    const stillCurrent =
      record.playerId === actorId && record.startedTurn === state.turn && this.#modeEligible(record, state, actorId);
    if (!stillCurrent) {
      this.#clearAutomation(roomCode);
      const liveState = room.gameState;
      if (liveState !== null && liveState.phase === 'playing') {
        this.#startBotIfActorIsBot(room, liveState, this.#engineActor(liveState));
      }
      return;
    }

    let intent: Intent;
    try {
      intent = record.mode === 'bot' ? this.#gateway.chooseBotIntent(state, actorId) : chooseTakeoverIntent(state);
    } catch (error) {
      this.#dependencies.onServerError?.(`automation choose intent threw in room ${room.code}`, error);
      this.#clearAutomation(roomCode);
      return;
    }
    const outcome = this.#commitTransition(room, actorId, intent, record.mode);
    if (!outcome.ok) {
      this.#clearAutomation(roomCode); // rule failure / exception during automation → stop, keep last valid state
      return;
    }
    this.#dependencies.onAsyncEvents(outcome.events);
  }
```

Wire `startRoom` to schedule BOT-first automation — replace the Task-4 comment `// Task 8 inserts:` with:

```ts
    this.#reconcileAfterStart(room, state);
```

(Note: `startRoom` builds `events` before this call and returns them synchronously; the BOT's own first action is delivered later through `onAsyncEvents`, never inside the start ack.)

- [ ] **Step 4: Run to verify passing**

Run: `pnpm exec vitest run apps/server/src/__tests__/roomGame.test.ts`
Expected: PASS — infrastructure tests green; callbacks mark fired handles inactive via the harness while stale explicit invocation remains possible; `chooseBotIntent` throws are logged and stop automation; all earlier roomGame + M1 tests still green.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/rooms/roomManager.ts apps/server/src/__tests__/roomGame.test.ts
git commit -m "feat(server): schedule generation-guarded BOT automation with stale-callback and dispose safety"
```

---

### Task 8: BOT mode reconciliation — chain, consecutive BOTs, manual→BOT handoff, failure stop

**Files:**
- Modify: `apps/server/src/rooms/roomManager.ts`
- Test: `apps/server/src/__tests__/roomGame.test.ts` (Tester adds a `describe` block)

Replaces the `#reconcileAfterTransition` no-op with the full source-aware §9.2 body so BOT turns chain one action per timer, consecutive BOT seats get separate records/delays, a human `end_turn` (or debt resolution returning control to a BOT) schedules exactly one fresh BOT timer, and a superseded queued callback is a no-op.

- [ ] **Step 1 (Tester): Write the failing reconciliation tests**

Add to `apps/server/src/__tests__/roomGame.test.ts`.

```ts
describe('BOT mode reconciliation', () => {
  test('a BOT turn advances one action per fired timer and reschedules the next with a fresh delay', () => {
    const { manager, timers } = startedBotFirstRoom([800, 1600, 1200, 900, 1500, 1100]);
    let fires = 0;
    // Fire successive current handles until the observed turn changes; each fire = one action + at most one new timer.
    const initialTurn = manager.getGameSnapshot('0007')!.turn;
    while (fires < 8 && manager.getGameSnapshot('0007')!.turn === initialTurn) {
      const active = timers.filter((t) => t.active);
      expect(active).toHaveLength(1); // never more than one pending automation timer
      active[0].callback(); // harness marks the fired handle inactive before invoking the callback
      fires += 1;
    }
    expect(fires).toBeGreaterThan(0);
    expect(manager.getGameSnapshot('0007')!.turn).not.toBe(initialTurn); // bounded observed turn change
    // delays came from the injected sequence, one per scheduled action
    expect(timers.map((t) => t.delayMs).slice(0, 2)).toEqual([800, 1600]);
  });

  test('manual human end_turn that hands control to a BOT schedules exactly one fresh BOT timer', () => {
    // Two humans + one bot; drive the human actor to end_turn and assert one bot timer appears.
    const players = [
      { id: 'host', nickname: '房主', isBot: false },
      { id: 'guest', nickname: '客人', isBot: false },
      { id: 'botA', nickname: '电脑 A', isBot: true },
    ];
    const seed = seedWithHumanFirstThenBot(players); // Tester helper: human first, bot immediately after in seat order
    const { manager, timers } = createHarness({ playerIds: ['host', 'guest', 'botA'], tokens: ['t1', 't2'], seed, delays: [999] });
    manager.createRoom('房主');
    manager.joinRoom('0007', '客人');
    manager.addBot('0007', 'host');
    manager.startRoom('0007', 'host');
    const actor = manager.getGameSnapshot('0007')!.currentPlayerId; // a human
    playTurnToEnd(manager, '0007', actor); // applies real intents up to and including end_turn
    const nextActor = manager.getGameSnapshot('0007')!.currentPlayerId;
    expect(manager.getGameSnapshot('0007')!.players.find((p) => p.id === nextActor)!.isBot).toBe(true);
    expect(timers.filter((t) => t.active)).toHaveLength(1);
    expect(timers[timers.length - 1].delayMs).toBe(999);
  });

  test('a superseded queued BOT callback (old generation) does nothing after the record was replaced', () => {
    const { manager, timers } = startedBotFirstRoom([100, 200, 300]);
    const staleHandle = timers[timers.length - 1];
    staleHandle.callback(); // first action schedules/replaces with a current handle
    const replacement = timers.find((t) => t.active);
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(staleHandle);
    const beforeStaleRefire = manager.getGameSnapshot('0007');
    staleHandle.callback(); // explicit stale invocation: handle identity is superseded even if the record generation is reused
    expect(manager.getGameSnapshot('0007')).toBe(beforeStaleRefire);
  });

  test('a BOT returned rule failure stops automation without spinning', () => {
    const failingBotGateway = {
      createGame,
      applyIntent: () => ({ ok: false as const, code: 'ILLEGAL_INTENT' as const }),
      chooseBotIntent: () => ({ type: 'roll_dice' as const }),
    };
    const { manager, timers } = startedBotFirstRoomWith(failingBotGateway);
    const before = manager.getGameSnapshot('0007');
    timers[timers.length - 1].callback();
    expect(manager.getGameSnapshot('0007')).toBe(before); // failure retains last valid state
    expect(timers.filter((t) => t.active)).toHaveLength(0); // no retry scheduled
  });

  test('a thrown chooseBotIntent is logged and stops automation without spinning', () => {
    const boom = new Error('bot planner exploded');
    const logs: unknown[] = [];
    const throwingBotGateway = {
      createGame,
      applyIntent,
      chooseBotIntent: () => {
        throw boom;
      },
    };
    const { manager, timers } = startedBotFirstRoomWith(throwingBotGateway, { onServerError: (_message, error) => logs.push(error) });
    const before = manager.getGameSnapshot('0007');
    timers[timers.length - 1].callback();
    expect(manager.getGameSnapshot('0007')).toBe(before);
    expect(timers.filter((t) => t.active)).toHaveLength(0);
    expect(logs).toContain(boom);
  });
});
```

Tester helpers to add: `seedWithHumanFirstThenBot(players)` (bounded scan, fail loudly if no seed produces a human first and the next actor after a completed human turn is the BOT; never weaken this into an optional assertion), `playTurnToEnd(manager, roomCode, actorId)` (apply the real per-phase intent sequence ending in `end_turn`), and `startedBotFirstRoomWith(gateway, extraDeps?)` (like `startedBotFirstRoom` but merges a `gameGateway` and optional dependency overrides).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run apps/server/src/__tests__/roomGame.test.ts -t "BOT mode reconciliation"`
Expected: FAIL — after the first BOT action nothing reschedules (reconciliation is still the no-op), so the chain/handoff assertions fail.

- [ ] **Step 3: Implement `#reconcileAfterTransition`**

Replace the Task-5 no-op body with the full §9.2 logic:

```ts
  #reconcileAfterTransition(room: Room, source: AutomationSource): void {
    const state = room.gameState;
    if (state === null || state.phase === 'game_over') {
      this.#clearAutomation(room.code);
      return;
    }
    const actorId = this.#engineActor(state);
    const record = this.#automation.get(room.code);

    if (source === 'offline_takeover' && record !== undefined && record.mode === 'offline_takeover') {
      const keep = state.debt === null && record.playerId === actorId && record.startedTurn === state.turn;
      if (keep) {
        this.#scheduleAutomation(room, record); // continue takeover with a fresh delay
        return;
      }
      this.#clearAutomation(room.code);
    } else if (source === 'bot' && record !== undefined && record.mode === 'bot') {
      const keep =
        record.playerId === actorId && record.startedTurn === state.turn && this.#modeEligible(record, state, actorId);
      if (keep) {
        this.#scheduleAutomation(room, record); // same BOT, same turn, next action, fresh delay
        return;
      }
      this.#clearAutomation(room.code);
    }

    // 'manual', or after clearing a stale bot/takeover record: normal BOT reconciliation for the new actor.
    this.#startBotIfActorIsBot(room, state, actorId);
  }
```

- [ ] **Step 4: Run to verify passing**

Run: `pnpm exec vitest run apps/server/src/__tests__/roomGame.test.ts`
Expected: PASS — reconciliation, chain, manual→BOT handoff, stale-generation, and failure-stop tests green; all earlier tests still green.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/rooms/roomManager.ts apps/server/src/__tests__/roomGame.test.ts
git commit -m "feat(server): reconcile BOT automation across transitions with one action per timer"
```

---
### Task 9: Cross-player debt actor reconciliation

**Files:**
- Modify: `apps/server/src/rooms/roomManager.ts` (verification only — no new production code expected)
- Test: `apps/server/src/__tests__/roomGame.test.ts` (Tester adds a `describe` block)

Spec §9.1 (actor = `debt?.debtorId ?? currentPlayerId`) and §9.2 already drive this: when an automated action creates debt for a **different** player, `#reconcileAfterTransition` sees a changed actor, clears the acting record, and runs normal BOT reconciliation for the debtor — scheduling a BOT record for a BOT debtor and waiting for a human debtor. This task locks that behavior with tests. It uses a **controlled gateway** to inject a precise debt configuration deterministically; the engine's own debt rules are covered by `@richman/engine` tests, so this test targets only the RoomManager reconciliation seam.

- [ ] **Step 1 (Tester): Write the failing cross-player debt tests**

Add to `apps/server/src/__tests__/roomGame.test.ts`.

```ts
// Real createGame + scripted applyIntent that puts `target` into debt on the acting player's move.
function debtInjectingGateway(target: string) {
  return {
    createGame,
    applyIntent: (state: GameState) => ({
      ok: true as const,
      state: {
        ...state,
        turnPhase: 'managing' as const,
        debt: { debtorId: target, creditorId: null, amount: 100 },
      },
      events: [{ type: 'debt_entered' as const, debtorId: target, amount: 100, creditorId: null }],
    }),
    chooseBotIntent: () => ({ type: 'declare_bankrupt' as const }),
  };
}


describe('cross-player debt actor reconciliation', () => {
  test('an automatic action that puts a BOT into debt clears the old record and schedules a fresh BOT record for the debtor', () => {
    const { manager, timers } = startedRoomBotFirstWithGateway(
      debtInjectingGateway('botB'),
      ['host', 'botA', 'botB'],
      'botA',
    );
    // Fire botA's scheduled action → creates debt for botB.
    timers[timers.length - 1].active = false;
    timers[timers.length - 1].callback();
    expect(manager.getGameSnapshot('0007')!.debt!.debtorId).toBe('botB');
    // botB (a BOT) is the new engine actor → exactly one fresh BOT timer is scheduled.
    expect(timers.filter((t) => t.active)).toHaveLength(1);
  });

  test('an automatic action that puts a HUMAN into debt clears the record and waits (no automation scheduled)', () => {
    const { manager, timers } = startedRoomBotFirstWithGateway(
      debtInjectingGateway('host'),
      ['host', 'botA', 'botB'],
      'botA',
    );
    timers[timers.length - 1].active = false;
    timers[timers.length - 1].callback();
    expect(manager.getGameSnapshot('0007')!.debt!.debtorId).toBe('host');
    expect(timers.filter((t) => t.active)).toHaveLength(0); // human debtor waits
  });

  test('after a human debtor resolves debt, control returning to a BOT schedules exactly one BOT timer and firing it progresses', () => {
    const resolvingGateway = {
      createGame,
      applyIntent: (state: GameState, playerId: string) => {
        if (state.debt !== null && playerId === state.debt.debtorId) {
          return {
            ok: true as const,
            state: { ...state, debt: null, currentPlayerId: 'botB', turnPhase: 'managing' as const },
            events: [{ type: 'debt_resolved' as const, amount: 100, creditorId: null }],
          };
        }
        return { ok: true as const, state: { ...state, debt: { debtorId: 'host', creditorId: null, amount: 100 }, turnPhase: 'managing' as const }, events: [{ type: 'debt_entered' as const, debtorId: 'host', amount: 100, creditorId: null }] };
      },
      chooseBotIntent: () => ({ type: 'end_turn' as const }),
    };
    const { manager, timers } = startedRoomBotFirstWithGateway(resolvingGateway, ['host', 'botA', 'botB'], 'botA');
    timers[timers.length - 1].callback(); // botA action → host in debt, waits
    expect(timers.filter((t) => t.active)).toHaveLength(0);
    const resolve = manager.applyGameIntent('0007', 'host', { type: 'declare_bankrupt' });
    expect(resolve.ok).toBe(true);
    expect(manager.getGameSnapshot('0007')!.debt).toBeNull();
    expect(manager.getGameSnapshot('0007')!.currentPlayerId).toBe('botB');
    expect(timers.filter((t) => t.active)).toHaveLength(1);
    const beforeBot = manager.getGameSnapshot('0007');
    timers[timers.length - 1].callback();
    expect(manager.getGameSnapshot('0007')).not.toBe(beforeBot);
  });
});
```

The Tester adds one helper `startedRoomBotFirstWithGateway(gateway, playerIds, botFirstId)`: computes a bot-first seed for the real player array, builds `createHarness` with that seed **and** `gameGateway: gateway` merged into the dependencies, creates the room, adds the bots, and starts — returning `{ manager, timers }`.

- [ ] **Step 2: Run to verify status**

Run: `pnpm exec vitest run apps/server/src/__tests__/roomGame.test.ts -t "cross-player debt actor reconciliation"`
Expected: These pass immediately if Task 8's `#reconcileAfterTransition` is correct (no new production code). If any fail, the actor computation or the clear-then-reschedule branch is wrong — fix `#reconcileAfterTransition`/`#startBotIfActorIsBot`, not the tests.

- [ ] **Step 3: Fix production code only if a test fails**

If the BOT-debtor test fails, confirm `#engineActor` uses `state.debt?.debtorId ?? state.currentPlayerId` and that `#startBotIfActorIsBot` is invoked for the debtor after the record clears. If the human-debtor test fails, confirm `#modeEligible`/`#startBotIfActorIsBot` refuses to schedule for a non-bot actor. Make the minimal change and re-run.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/rooms/roomManager.ts apps/server/src/__tests__/roomGame.test.ts
git commit -m "test(server): lock cross-player debt actor reconciliation for bot and human debtors"
```

---

### Task 10: Offline takeover behavior

**Files:**
- Modify: `apps/server/src/rooms/roomManager.ts`
- Test: `apps/server/src/__tests__/roomGame.test.ts` (Tester adds a `describe` block)

Implements `requestSkipOfflineTurn` (spec §9.4): acceptance guards, fixed no-buy/no-build policy, turn-lock, manual rejection of the locked actor, automated bypass of the manual guard (§8.3), reconnect-does-not-cancel, and debt-during-takeover clearing (§9.2 offline_takeover branch, already in Task 8).

- [ ] **Step 1 (Tester): Write the failing takeover tests**

Add to `apps/server/src/__tests__/roomGame.test.ts`. Setup: two humans; read the snapshot's `currentPlayerId`, disconnect that actor, and have the surviving online host request the skip.

```ts
// Two humans; returns manager + timers + { host, actor } where `actor` is offline and `host` is the online host.
function startedRoomWithOfflineActor() {
  const { manager, timers } = createHarness({ playerIds: ['h1', 'h2'], tokens: ['tk1', 'tk2'], seed: 'takeover-seed', delays: [700, 700] });
  manager.createRoom('玩家一');
  manager.joinRoom('0007', '玩家二');
  manager.startRoom('0007', 'h1');
  const actor = manager.getGameSnapshot('0007')!.currentPlayerId;
  manager.markDisconnected('0007', actor); // actor offline; host transfers to the other online human if needed
  const host = manager.getPublicRoom('0007')!.hostId; // current online host
  return { manager, timers, actor, host };
}

describe('offline takeover', () => {
  test('host request for an offline current human schedules one takeover action and returns immediately', () => {
    const { manager, timers, actor, host } = startedRoomWithOfflineActor();
    const before = timers.filter((t) => t.active).length;
    const result = manager.requestSkipOfflineTurn('0007', host);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toEqual([]); // immediate scheduling ack, no game transition yet
    expect(timers.filter((t) => t.active).length).toBe(before + 1);
    expect(timers[timers.length - 1].delayMs).toBe(700);
  });

  test('rejects when requester is not host, actor is online, debt exists, or automation already exists', () => {
    const { manager, actor, host } = startedRoomWithOfflineActor();
    const notHost = manager.getPublicRoom('0007')!.players.find((p) => p.id !== host)!.id;
    expect(manager.requestSkipOfflineTurn('0007', notHost).ok).toBe(false); // not host
    const debtCase = startedRoomWithOfflineActorGateway(debtPresentGateway(actor));
    expect(debtCase.manager.requestSkipOfflineTurn('0007', debtCase.host).ok).toBe(false); // debt exists
    // second request after one is accepted → duplicate rejected
    expect(manager.requestSkipOfflineTurn('0007', host).ok).toBe(true);
    expect(manager.requestSkipOfflineTurn('0007', host).ok).toBe(false); // automation already exists
  });

  test('rejects skip for an online actor', () => {
    const { manager } = createHarness({ playerIds: ['h1', 'h2'], tokens: ['tk1', 'tk2'], seed: 'takeover-seed' });
    manager.createRoom('玩家一');
    manager.joinRoom('0007', '玩家二');
    manager.startRoom('0007', 'h1');
    const host = manager.getPublicRoom('0007')!.hostId;
    expect(manager.requestSkipOfflineTurn('0007', host).ok).toBe(false); // current actor still online
  });

  test('firing a takeover timer applies the fixed policy intent and bypasses the manual takeover lock', () => {
    const { manager, timers, actor, host } = startedRoomWithOfflineActor();
    manager.requestSkipOfflineTurn('0007', host);
    // While the lock is active, the locked actor's manual intent is rejected...
    const manual = manager.applyGameIntent('0007', actor, { type: 'roll_dice' });
    expect(manual.ok).toBe(false);
    if (!manual.ok) expect(manual.code).toBe('INVALID_ROOM_ACTION');
    // ...but the automated timer callback bypasses that guard and commits the actor's intent.
    const before = manager.getGameSnapshot('0007');
    timers[timers.length - 1].active = false;
    timers[timers.length - 1].callback();
    expect(manager.getGameSnapshot('0007')).not.toBe(before);
  });

  test('reconnect during an active takeover does not cancel the turn lock', () => {
    const { manager, timers, actor, host } = startedRoomWithOfflineActor();
    manager.requestSkipOfflineTurn('0007', host);
    const activeBefore = timers.filter((t) => t.active).length;
    const token = actor === 'h1' ? 'tk1' : 'tk2';
    manager.resumeRoom('0007', actor, token); // player reconnects
    expect(timers.filter((t) => t.active).length).toBe(activeBefore); // takeover timer still pending
    const manual = manager.applyGameIntent('0007', actor, { type: 'roll_dice' });
    expect(manual.ok).toBe(false); // still rejected while lock holds
  });

  test('debt created during a takeover action clears the takeover record; reconnect can resolve debt manually', () => {
    const debtGateway = {
      createGame,
      applyIntent: (state: GameState, playerId: string, intent: Intent) => {
        if (state.debt !== null && playerId === state.debt.debtorId && intent.type === 'declare_bankrupt') {
          return { ok: true as const, state: { ...state, debt: null, turnPhase: 'managing' as const }, events: [{ type: 'debt_resolved' as const, amount: 50, creditorId: null }] };
        }
        return {
          ok: true as const,
          state: { ...state, turnPhase: 'managing' as const, debt: { debtorId: state.currentPlayerId, creditorId: null, amount: 50 } },
          events: [{ type: 'debt_entered' as const, debtorId: state.currentPlayerId, amount: 50, creditorId: null }],
        };
      },
      chooseBotIntent: () => ({ type: 'declare_bankrupt' as const }),
    };
    const { manager, timers, actor, host } = startedRoomWithOfflineActorGateway(debtGateway);
    manager.requestSkipOfflineTurn('0007', host);
    timers[timers.length - 1].callback(); // takeover action creates debt for the (human) actor
    expect(manager.getGameSnapshot('0007')!.debt).not.toBeNull();
    expect(timers.filter((t) => t.active)).toHaveLength(0); // takeover cleared, no reschedule; room waits
    const token = actor === 'h1' ? 'tk1' : 'tk2';
    expect(manager.resumeRoom('0007', actor, token).ok).toBe(true);
    const manual = manager.applyGameIntent('0007', actor, { type: 'declare_bankrupt' });
    expect(manual.ok).toBe(true); // accepted scripted debt action proves the takeover lock is gone
  });
});
```

Tester helper `startedRoomWithOfflineActorGateway(gateway)`: same as `startedRoomWithOfflineActor` but merges `gameGateway: gateway` into the harness dependencies.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run apps/server/src/__tests__/roomGame.test.ts -t "offline takeover"`
Expected: FAIL — `requestSkipOfflineTurn` is not a function on `RoomManager`.

- [ ] **Step 3: Implement `requestSkipOfflineTurn`**

Add to `apps/server/src/rooms/roomManager.ts`:

```ts
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
    const actorId = this.#engineActor(state); // debt is null, so this equals state.currentPlayerId
    const actorRoomPlayer = room.players.find((p) => p.id === actorId);
    if (actorRoomPlayer === undefined || actorRoomPlayer.isBot) {
      return roomFailure('INVALID_ROOM_ACTION', 'The current player is not a human.');
    }
    if (actorRoomPlayer.online) {
      return roomFailure('INVALID_ROOM_ACTION', 'The current player is online.');
    }
    if (this.#automation.has(roomCode) || this.#gameAutomationTimers.has(roomCode)) {
      return roomFailure('INVALID_ROOM_ACTION', 'Automation is already active for this turn.');
    }

    const record = this.#createAutomation(room, state, 'offline_takeover', actorId);
    this.#scheduleAutomation(room, record);
    return { ok: true, value: {}, events: [] };
  }
```

The manual takeover-lock (already added in Task 5's `applyGameIntent`) rejects the locked actor's manual intents while the `offline_takeover` record exists. The automated path in `#runAutomationCallback` calls `#commitTransition` directly with `source: 'offline_takeover'`, so it bypasses that manual guard — proving the §8.3 "automated callbacks never pass through manual-only checks" contract. Debt/turn/actor changes clear the record through Task 8's `#reconcileAfterTransition` offline_takeover branch.

- [ ] **Step 4: Run to verify passing**

Run: `pnpm exec vitest run apps/server/src/__tests__/roomGame.test.ts`
Expected: PASS — all takeover tests green; every earlier roomGame + M1 test still green.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/rooms/roomManager.ts apps/server/src/__tests__/roomGame.test.ts
git commit -m "feat(server): implement host offline-takeover with turn lock and automated guard bypass"
```

---

### Review Gate C (end of Phase 3)

Dispatch two independent reviewers before Phase 4:
- **Spec-compliance review** against §9.1 (single record, actor definition, generation semantics), §9.2 (callback stale checks, source-aware reconciliation steps 1–6, failure-stop), §9.3 (BOT one-action-per-timer, consecutive seats, debt), §9.4 (takeover acceptance guards, fixed policy, turn lock, reconnect keeps lock, debt clears), §14 (dispose cancels game automation; no callback emits after dispose).
- **Code-quality review**: at most one pending automation timer per room at all times; every scheduling path bumps/keeps generation coherently; no unbounded retry after failure; no `setTimeout` real sleeps in tests; controlled gateways used only where the real engine cannot deterministically produce the seam.

Resolve every Critical/Important finding and re-run the full `roomGame` + M1 room/socket suites before Task 11.

---
## Phase 4 — Socket.IO integration

Both socket test files use the real ephemeral-server + two-`socket.io-client` pattern already established in `socketRooms.test.ts` (`startTestServer`, `connectClient`, `emitAck`, `nextRoomState`, `listenOnEphemeralLocalhost`, the `clients`/`servers` `afterEach` teardown, and a deterministic `RoomManager` factory that captures timers into `options.timers`). Port those helpers into each new file and extend the factory with `generateGameSeed`/`nextAutomationDelayMs`. Register every listener before emitting; assert order structurally; never sleep.

### Task 11: Socket adapter game events + `game:intent` two-client ordering

**Files:**
- Modify: `apps/server/src/socket/roomSocketAdapter.ts`
- Test: `apps/server/src/__tests__/socketGame.test.ts` (Tester authors first)

- [ ] **Step 1 (Tester): Write the failing two-client tests**

Create `apps/server/src/__tests__/socketGame.test.ts`. Port the `socketRooms.test.ts` harness (including the deterministic factory with `options.timers`) and add game helpers: `emitStart(socket)`, `emitGameIntent(socket, intent)` (emits `game:intent` with `{ intent }` and resolves the ack), `nextGameEvents(socket)` / `nextGameSnapshot(socket)` (`socket.once('game:events'|'game:snapshot', resolve)`), and `collectOrdered(socket, ['room:state','game:snapshot',...])` that records arrival order. Use a fixed `seed` in the factory so seat order is deterministic; read the initial snapshot to learn `currentPlayerId`.

```ts
describe('Socket.IO game intents', () => {
  test('create → join → start delivers playing room state then an equal initial snapshot to both clients before the start ack', async () => {
    const { url } = await startGameTestServer({ seed: 'sock-seed' });
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { nickname: '玩家一' });
    const guest = await connectClient(url);
    await emitAck(guest, 'room:join', { roomCode: create.roomCode, nickname: '玩家二' });

    const order: string[] = [];
    host.on('room:state', () => order.push('room_state'));
    const hostSnap = recordNextGameSnapshot(host, order, 'snapshot');
    const guestSnap = nextGameSnapshot(guest);
    const startPromise = emitStart(host).then((ack) => {
      order.push('ack');
      return ack;
    });

    const start = await startPromise;
    expect(order).toEqual(['room_state', 'snapshot', 'ack']);
    const [gsHost, gsGuest] = await Promise.all([hostSnap, guestSnap]);
    expect(gsHost.state).toEqual(gsGuest.state); // identical initial snapshot
    expect(JSON.stringify(gsHost.state)).not.toContain('token'); // no token in snapshot
  });

  test('the correct player rolling delivers one identical game:events batch to both clients before the sender ack', async () => {
    const { host, guest, actorSocket } = await startTwoClientGame({ seed: 'roll-seed' });
    const order: string[] = [];
    const hostEvents = nextGameEvents(host).then((payload) => {
      order.push('events');
      return payload;
    });
    const guestEvents = nextGameEvents(guest);
    const ack = await emitGameIntent(actorSocket, { type: 'roll_dice' }).then((value) => {
      order.push('ack');
      return value;
    });

    expect(ack).toEqual({ ok: true });
    const [he, ge] = await Promise.all([hostEvents, guestEvents]);
    expect(order).toEqual(['events', 'ack']);
    expect(he.events).toEqual(ge.events);
    expect(he.events.length).toBeGreaterThan(0);
  });

  test('a wrong-player intent returns NOT_YOUR_TURN with no game:events broadcast to the peer', async () => {
    const { url, host, guest, actorSocket, nonActorSocket } = await startTwoClientGame({ seed: 'wrong-seed' });
    let peerGotEvents = false;
    host.on('game:events', () => (peerGotEvents = true));
    guest.on('game:events', () => (peerGotEvents = true));
    const ack = await emitGameIntent(nonActorSocket, { type: 'roll_dice' });
    expect(ack).toEqual({ ok: false, code: 'NOT_YOUR_TURN', message: '还没轮到你行动。' });
    await tick(); // one macrotask; no events should have arrived
    expect(peerGotEvents).toBe(false);
  });

  test('a deterministic full turn reaches turn_ended and sends events, then a snapshot, then the ack — in that order', async () => {
    const { host, guest, actorSocket, roomCode } = await startTwoClientGame({ seed: 'turn-seed' });
    const order: string[] = [];
    actorSocket.on('game:events', () => order.push('events'));
    actorSocket.on('game:snapshot', () => order.push('snapshot'));
    // Play the actor's real phases; the transition producing turn_ended must emit events then snapshot before its ack.
    const acks = await playSocketTurn(actorSocket, roomCode /* reads snapshots between intents */);
    order.push('ack'); // the final end_turn ack resolved last
    const endIdx = order.lastIndexOf('events');
    expect(order[endIdx + 1]).toBe('snapshot');
    expect(order[order.length - 1]).toBe('ack');
  });

  test('simultaneous intents serialize with exactly one accepted batch', async () => {
    const { host, guest, actorSocket, nonActorSocket } = await startTwoClientGame({ seed: 'race-seed' });
    const hostEvents = nextGameEvents(host);
    const guestEvents = nextGameEvents(guest);
    const [actorAck, nonActorAck] = await Promise.all([
      emitGameIntent(actorSocket, { type: 'roll_dice' }),
      emitGameIntent(nonActorSocket, { type: 'roll_dice' }),
    ]);
    const acks = [actorAck, nonActorAck];
    expect(acks.filter((ack) => ack.ok)).toHaveLength(1);
    expect(acks.filter((ack) => !ack.ok && ack.code === 'NOT_YOUR_TURN')).toHaveLength(1);
    const [he, ge] = await Promise.all([hostEvents, guestEvents]);
    expect(he.events).toEqual(ge.events);
    expect(he.events.length).toBeGreaterThan(0);
  });

  test('a malformed intent and a missing ack cause no state mutation', async () => {
    const { host, guest, actorSocket, roomCode, manager } = await startTwoClientGame({ seed: 'malformed-seed' });
    const before = manager.getGameSnapshot(roomCode)!;
    const badAck = await emitRawGameIntent(actorSocket, { intent: { type: 'teleport' } });
    expect(badAck).toEqual({ ok: false, code: 'INVALID_ROOM_ACTION', message: 'Invalid room action payload.' });
    emitGameIntentWithoutAck(actorSocket, { type: 'roll_dice' }); // no ack callback
    await tick();
    expect(manager.getGameSnapshot(roomCode)).toBe(before); // unchanged reference
  });

  test('game over delivers a final snapshot and later intents are rejected', async () => {
    const { host, guest, actorSocket, roomCode } = await startTwoClientGame({ seed: 'over-seed', gameGateway: gameOverGateway });
    const snap = nextGameSnapshot(host);
    const ack = await emitGameIntent(actorSocket, { type: 'end_turn' });
    expect(ack).toEqual({ ok: true });
    const finalSnap = await snap;
    expect(finalSnap.state.phase).toBe('game_over');
    const later = await emitGameIntent(actorSocket, { type: 'roll_dice' });
    expect(later.ok).toBe(false);
  });
});
```

`tick()` = `new Promise((r) => setTimeout(r, 0))` (one macrotask, not a real delay). `gameOverGateway` mirrors the Task-5 helper. `startTwoClientGame` creates+joins+starts, reads the initial snapshot, and returns `{ url, roomCode, host, guest, actorSocket, nonActorSocket, manager }` where `actorSocket` is the client bound to the snapshot's `currentPlayerId`. `recordNextGameSnapshot(socket, order, label)` registers a one-shot listener before the emit, pushes `label` into `order`, and resolves the payload so tests can assert `room_state → snapshot → ack`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run apps/server/src/__tests__/socketGame.test.ts`
Expected: FAIL — clients never receive `game:snapshot`/`game:events` (adapter does not dispatch them) and `game:intent` has no handler, so acks time out or come back malformed.

- [ ] **Step 3: Implement adapter dispatch + `game:intent` handler**

In `apps/server/src/socket/roomSocketAdapter.ts`:

Add import:

```ts
import { isValidIntent } from '../game/gameRuntime';
import type { WireFailure } from '../rooms/roomErrors';
```

Extend `dispatchDomainEvents` — before the final `room:closed` branch, add:

```ts
      if (event.type === 'game_events') {
        io.to(event.roomCode).emit('game:events', { events: event.events });
        continue;
      }

      if (event.type === 'game_snapshot') {
        io.to(event.roomCode).emit('game:snapshot', { state: event.state });
        continue;
      }
```

Widen `toActionAck` to accept a wire failure (RoomFailure is already assignable):

```ts
  function toActionAck(result: RoomSuccess<unknown> | WireFailure): Ack<Record<string, never>> {
    if (!result.ok) {
      return result;
    }
    return { ok: true };
  }
```

(Import `RoomSuccess` from `../rooms/roomTypes` if not already imported.)

Add the handler:

```ts
  function handleGameIntent(socket: RoomSocket, payload: unknown, ack: (response: Ack<Record<string, never>>) => void): void {
    const binding = socketBindings.get(socket.id);
    if (binding === undefined) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }
    if (!isRecord(payload) || !isValidIntent(payload.intent)) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }
    try {
      const result = roomManager.applyGameIntent(binding.roomCode, binding.playerId, payload.intent);
      if (result.ok) {
        dispatchDomainEvents(result.events);
      }
      ackAfterEventFlush(ack, toActionAck(result));
    } catch (error) {
      logger?.error?.('game:intent failed unexpectedly', error);
      ack(INVALID_ROOM_ACTION_ACK);
    }
  }
```

Register it in `bind()` alongside the other handlers:

```ts
      socket.on('game:intent', (payload, ack) => {
        if (typeof ack !== 'function') {
          return;
        }
        handleGameIntent(socket, payload, ack);
      });
```

- [ ] **Step 4: Run to verify passing**

Run: `pnpm exec vitest run apps/server/src/__tests__/socketGame.test.ts apps/server/src/__tests__/socketRooms.test.ts`
Expected: PASS — game socket tests green; M1 socket tests unchanged and green.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/socket/roomSocketAdapter.ts apps/server/src/__tests__/socketGame.test.ts
git commit -m "feat(server): dispatch game events over Socket.IO and handle game:intent before ack"
```

---
### Task 12: `room:skip_offline_turn`, resume snapshot, and BOT timer chain over real sockets

**Files:**
- Modify: `apps/server/src/socket/roomSocketAdapter.ts`
- Test: `apps/server/src/__tests__/socketGameReconnect.test.ts` (Tester authors first)

- [ ] **Step 1 (Tester): Write the failing reconnect/takeover/BOT tests**

Create `apps/server/src/__tests__/socketGameReconnect.test.ts`. Port the harness (factory with captured `timers`), and add `emitSkipOfflineTurn(socket)` and `emitResume(socket, payload)` helpers (the latter resolving `Ack<ResumeAck>`).

```ts
describe('Socket.IO resume, takeover, and BOT pacing', () => {
  test('a playing resume ack includes the current snapshot; a lobby resume ack omits it', async () => {
    const { url, roomCode, host, guest, actorSocket, actorId, actorToken } = await startTwoClientGame({ seed: 'resume-seed' });
    const offline = onServer(host, 'player:connection');
    actorSocket.disconnect(); // actor drops after the listener is registered
    await expect(offline).resolves.toMatchObject({ playerId: actorId, online: false }); // observed offline before resume
    const resumeSocket = await connectClient(url);
    const resume = await emitResume(resumeSocket, { roomCode, playerId: actorId, token: actorToken });
    expect(resume.ok).toBe(true);
    if (!resume.ok) return;
    expect(resume.room.status).toBe('playing');
    expect(resume.snapshot).toBeDefined();
    expect(resume.snapshot!.players.find((p) => p.id === actorId)!.online).toBe(true);
  });

  test('resuming a lobby member returns room without a snapshot', async () => {
    const { url } = await startGameTestServer({ seed: 's' });
    const host = await connectClient(url);
    const create = await emitAck(host, 'room:create', { nickname: '玩家一' });
    const guest = await connectClient(url);
    const join = await emitAck(guest, 'room:join', { roomCode: create.roomCode, nickname: '玩家二' });
    guest.disconnect();
    const back = await connectClient(url);
    const resume = await emitResume(back, { roomCode: create.roomCode, playerId: join.playerId, token: join.token });
    expect(resume.ok).toBe(true);
    if (!resume.ok) return;
    expect(resume.room.status).toBe('lobby');
    expect(resume.snapshot).toBeUndefined();
  });

  test('host takeover schedules, rejects concurrent manual input from the locked actor, and continues after resume', async () => {
    const { url, roomCode, host, guest, actorSocket, actorId, actorToken, hostSocket, timers } =
      await startTwoClientGameOfflineActor({ seed: 'takeover-sock-seed' });
    const skip = await emitSkipOfflineTurn(hostSocket);
    expect(skip).toEqual({ ok: true });
    expect(timers.filter((t) => t.active)).toHaveLength(1);

    // Reconnect the actor; the lock persists and the manual intent is rejected.
    const resumeSocket = await connectClient(url);
    await emitResume(resumeSocket, { roomCode, playerId: actorId, token: actorToken });
    const manual = await emitGameIntent(resumeSocket, { type: 'roll_dice' });
    expect(manual.ok).toBe(false);
    expect(timers.filter((t) => t.active)).toHaveLength(1); // takeover still pending

    // Firing the captured timer advances the game and broadcasts events.
    const events = nextGameEvents(host);
    timers.filter((t) => t.active)[0].active = false;
    timers[timers.length - 1].callback();
    const batch = await events;
    expect(batch.events).toBeDefined();
  });

  test('a guaranteed-BOT actor advances exactly one action per manually fired timer', async () => {
    const { host, timers } = await startHumanBotGame({ seed: seedWithBotFirstSocket('botA') });
    const pending = timers.filter((t) => t.active);
    expect(pending).toHaveLength(1);
    const events = nextGameEvents(host);
    pending[0].callback();
    const batch = await events;
    expect(batch.events).toBeDefined();
    expect(timers.filter((t) => t.active).length).toBeLessThanOrEqual(1); // never more than one at once
  });

  test('a replacement socket and a stale disconnect retain M1 behavior in a playing room and GameState', async () => {
    const { url, roomCode, actorId, actorToken, manager } = await startTwoClientGame({ seed: 'stale-seed' });
    const first = await connectClient(url);
    const resumeA = await emitResume(first, { roomCode, playerId: actorId, token: actorToken });
    expect(resumeA.ok).toBe(true);
    const second = await connectClient(url);
    const resumeB = await emitResume(second, { roomCode, playerId: actorId, token: actorToken });
    expect(resumeB.ok).toBe(true);
    // The stale first socket disconnecting must not mark the player offline (M1 replacement-socket protection).
    let sawOffline = false;
    second.on('player:connection', (c) => {
      if (c.playerId === actorId && c.online === false) sawOffline = true;
    });
    first.disconnect();
    await tick();
    expect(sawOffline).toBe(false);
    expect(manager.getGameSnapshot(roomCode)!.players.find((p) => p.id === actorId)!.online).toBe(true);
  });
});
```

Harness helpers: `startTwoClientGameOfflineActor` (registers the peer's `player:connection` listener before disconnecting the actor, waits for the observed offline event, ensures the surviving socket is the online host, and returns `hostSocket` + `timers`), `startHumanBotGame` (host + one bot with a seed supplied by `seedWithBotFirstSocket('botA')`, so the BOT timer assertion is unconditional), `seedWithBotFirstSocket(botId)` (bounded seed scan through real `createGame`, fail loudly if unmet), `onServer(socket, event)` = one-shot listener promise. `startTwoClientGame` also returns `actorId`/`actorToken`/`hostSocket`/`manager`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run apps/server/src/__tests__/socketGameReconnect.test.ts`
Expected: FAIL — resume ack has no `snapshot`, and `room:skip_offline_turn` has no handler (ack times out).

- [ ] **Step 3: Implement resume snapshot + `room:skip_offline_turn` handler**

In `apps/server/src/socket/roomSocketAdapter.ts`:

Import the resume ack type:

```ts
import type { ResumeAck } from '../protocol';
```

Rewrite the success tail of `handleResume` to assemble the `ResumeAck` from the separate accessor (spec §10):

```ts
      const binding = { roomCode: payload.roomCode, playerId: payload.playerId };
      cleanupSocketBeforeRebind(socket, binding);
      bindSocket(socket, binding);
      dispatchDomainEvents(result.events);
      dispatchLobbyStateAfterConnectionEvent(result);
      const snapshot = roomManager.getGameSnapshot(payload.roomCode);
      const resumeAck: Ack<ResumeAck> =
        snapshot === null ? { ok: true, room: result.value } : { ok: true, room: result.value, snapshot };
      ackAfterEventFlush(ack, resumeAck);
```

Add the takeover handler:

```ts
  function handleSkipOfflineTurn(socket: RoomSocket, ack: (response: Ack<Record<string, never>>) => void): void {
    const binding = socketBindings.get(socket.id);
    if (binding === undefined) {
      ack(INVALID_ROOM_ACTION_ACK);
      return;
    }
    try {
      const result = roomManager.requestSkipOfflineTurn(binding.roomCode, binding.playerId);
      if (result.ok) {
        dispatchDomainEvents(result.events); // empty; scheduling ack is immediate
      }
      ackAfterEventFlush(ack, toActionAck(result));
    } catch (error) {
      logger?.error?.('room:skip_offline_turn failed unexpectedly', error);
      ack(INVALID_ROOM_ACTION_ACK);
    }
  }
```

Register it in `bind()`:

```ts
      socket.on('room:skip_offline_turn', (ack) => {
        if (typeof ack !== 'function') {
          return;
        }
        handleSkipOfflineTurn(socket, ack);
      });
```

Update the `handleResume` ack callback type annotation to `Ack<ResumeAck>` (matching the changed `session:resume` protocol type from Task 2).

- [ ] **Step 4: Run to verify passing**

Run: `pnpm exec vitest run apps/server/src/__tests__/socketGameReconnect.test.ts apps/server/src/__tests__/socketRooms.test.ts`
Expected: PASS — reconnect/takeover/BOT tests green; M1 socket tests (including replacement-socket + stale-disconnect) unchanged and green.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/socket/roomSocketAdapter.ts apps/server/src/__tests__/socketGameReconnect.test.ts
git commit -m "feat(server): return resume snapshots and handle room:skip_offline_turn over Socket.IO"
```

---

### Review Gate D (end of Phase 4)

Dispatch two independent reviewers before Phase 5:
- **Spec-compliance review** against §8.2/§8.3 (events dispatched before ack; adapter never calls engine or chooses intents), §10 (resume keeps M1 room shape; snapshot assembled from `getGameSnapshot`; no peer snapshot on someone else's resume), §11 (snapshot delivery rules), §12 (one `game:events` batch per accepted intent; adapter preserves order; no `game:error` broadcast), §15.2/§15.3 (real two-client servers, listeners before emit, no sleeps, teardown in `afterEach`).
- **Code-quality review**: `toActionAck` widening is sound; no token appears in any emitted snapshot/event; malformed intent and missing ack mutate nothing; both new socket files close all clients and servers in `afterEach`.

Resolve every Critical/Important finding and re-run all four socket + room suites before Task 13.

---
## Phase 5 — Closure

### Task 13: Production wiring, delay boundary, docs, full automated gate, and production smoke

**Files:**
- Modify: `apps/server/src/production.ts`
- Modify: `apps/server/src/__tests__/production.test.ts`
- Create: `scripts/smoke-production.ts`
- Modify: `scripts/tsconfig.json` (include the maintained production smoke in the scripts typecheck)
- Modify: `plan/03-架构与联机协议.md`, `plan/05-阶段2-联机版.md`, `README.md`

- [ ] **Step 1 (Tester): Write the failing delay-boundary test**

Extract the production automation-delay function so it is unit-testable, then test its boundary. Add to `apps/server/src/__tests__/production.test.ts`:

```ts
import { nextProductionAutomationDelayMs } from '../production';

describe('production automation delay', () => {
  test('always returns an integer within the inclusive 800–1600 ms range', () => {
    for (let i = 0; i < 2000; i += 1) {
      const delay = nextProductionAutomationDelayMs();
      expect(Number.isInteger(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(800);
      expect(delay).toBeLessThanOrEqual(1600);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run apps/server/src/__tests__/production.test.ts`
Expected: FAIL — `nextProductionAutomationDelayMs` is not exported by `../production`.

- [ ] **Step 3: Extract the production seed/delay functions**

In `apps/server/src/production.ts`, replace the inline arrows added in Task 4 with exported module functions and reference them in the factory:

```ts
const MIN_AUTOMATION_DELAY_MS = 800;
const MAX_AUTOMATION_DELAY_MS = 1600;

export function nextProductionAutomationDelayMs(): number {
  return randomInt(MIN_AUTOMATION_DELAY_MS, MAX_AUTOMATION_DELAY_MS + 1); // randomInt upper bound is exclusive
}

export function generateProductionGameSeed(): string {
  return randomBytes(TOKEN_BYTE_LENGTH).toString('hex');
}
```

In `createProductionRoomManager`'s dependency object:

```ts
    generateGameSeed: generateProductionGameSeed,
    nextAutomationDelayMs: nextProductionAutomationDelayMs,
```

- [ ] **Step 4: Run to verify passing**

Run: `pnpm exec vitest run apps/server/src/__tests__/production.test.ts`
Expected: PASS — boundary test green; the existing bootstrap test still green.

- [ ] **Step 5: Update protocol/phase docs**

- `plan/03-架构与联机协议.md`: document `game:intent` (payload `{ intent }`, empty-success ack), `game:events` (`{ events }`), `game:snapshot` (`{ state }`), and `room:skip_offline_turn`; record the four engine error codes (`NOT_YOUR_TURN`, `WRONG_PHASE`, `INSUFFICIENT_FUNDS`, `ILLEGAL_INTENT`) on the shared `{ok:false, code, message}` ack; document `session:resume` now returning `{ room, snapshot? }`; add the `ended` room status; note events precede success ack and one `game:events` batch per accepted intent.
- `plan/05-阶段2-联机版.md`: mark the server-authoritative engine slice and `room:skip_offline_turn` behavior as M2-complete; keep client `OnlineSession`/UI as M3 and persistence/reclamation as M4.
- `README.md`: mark Phase 2 M2 complete only after Step 7 passes.

- [ ] **Step 6: Create the maintained production smoke and include it in scripts typechecking**

Create `scripts/smoke-production.ts` before the full gate so `scripts/tsconfig.json` typechecks it:

```ts
import { startProductionServer } from '../apps/server/src/production';

async function main(): Promise<void> {
  const server = await startProductionServer(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    const body = await response.text();
    if (response.status !== 200 || !body.includes('<!DOCTYPE html')) {
      throw new Error(`production smoke failed: status=${response.status}`);
    }
  } finally {
    await server.close();
    await server.close(); // idempotent close
  }
  console.log('smoke ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

Update `scripts/tsconfig.json` so the existing scripts gate covers both maintained scripts:

```json
"include": ["party.ts", "smoke-production.ts"]
```

- [ ] **Step 7: Run the full automated gate from the worktree (spec §15.4)**

Run each and confirm PASS:

```bash
pnpm test
pnpm typecheck
pnpm exec tsc -p scripts/tsconfig.json --noEmit
pnpm validate-data
pnpm build
pnpm --filter @richman/server build
```

Expected: all pass. The scripts typecheck now includes `smoke-production.ts`; `pnpm test` runs every engine, client, M1 room, socket, static, production, and party suite plus the new `gameRuntime`/`roomGame`/`socketGame`/`socketGameReconnect` suites. `pnpm build` produces `apps/client/dist`, which the production smoke serves.

- [ ] **Step 8: Run the bounded production smoke (serves built client, closes gracefully)**

After `pnpm build`, run:

```bash
pnpm exec tsx scripts/smoke-production.ts
```

Expected: prints `smoke ok`. (`production.test.ts` already asserts create-room-over-WebSocket + idempotent close; this smoke additionally asserts the built client is served.)

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/production.ts apps/server/src/__tests__/production.test.ts scripts/smoke-production.ts scripts/tsconfig.json plan/03-架构与联机协议.md plan/05-阶段2-联机版.md README.md
git commit -m "docs(server): finalize M2 protocol docs and production automation wiring"
```

---

### Final Gate (end of Phase 5)

Dispatch the final independent reviews against spec §18 acceptance criteria:
- **Spec-compliance review**: every §18 bullet is demonstrably covered by a passing test — one authoritative GameState per started room; identical two-client state/events/turn snapshots; server-only validation; failed/thrown intents change nothing; simultaneous intents serialize; BOTs act one intent at a time with server delay; takeover follows the fixed no-buy/no-build policy + turn lock; disconnect/resume keep presence+snapshot flags consistent; stale sockets/timers cannot change state; game over yields a final resumable ended room; no token in GameState/events/snapshots/logs/public room; all M1 behavior intact.
- **Code-quality review**: full-gate output attached; no `any`/dead code; no second GameState/automation source of truth; docs match the implemented protocol.

M2 is complete only when both final reviews approve and every command in Step 7 plus the Step 8 smoke passed from the worktree.

---

## Self-review (author checklist — run once after writing)

**Spec coverage** (every spec section maps to a task):
- §4.1 engine API / §5.1 gameRuntime → Task 3. §4.2 M1 invariants → preserved across all tasks (M1 suites gate every phase).
- §5.4 protocol / §11 snapshot event / §12 domain+wire events → Tasks 2, 11, 12.
- §6 room+dependency model → Task 4. §7 start transition (incl. offline-guest mirror + creation-exception rollback) → Task 4.
- §8.1 intent shape / §8.2 manual authorization / §8.3 shared committed transition / §8.4 messages → Tasks 3, 5, 11.
- §9.1 automation record+actor / §9.2 callbacks+reconciliation / §9.3 BOT mode → Tasks 7, 8, 9. §9.4 takeover → Task 10, 12.
- §10 connection-state sync + M1-shape resume → Tasks 6, 12. §11 snapshot policy → Tasks 4, 5, 11, 12. §12 events → Tasks 5, 11.
- §13 ended rooms → Tasks 5, 6. §14 disposal+stale → Tasks 4, 7. §15 tests → all behavior tasks. §16 file impact → file map. §17 phases/gates → phase headers. §18 acceptance → Final Gate.

**Placeholder scan:** no "TBD/TODO/add tests" — every test step lists concrete cases + assertions; every implementation step shows the code; every run step gives the exact command + expected RED/GREEN.

**Type consistency checklist:**
- `RoomManagerDependencies` gains `generateGameSeed`/`nextAutomationDelayMs` (required) + `gameGateway`/`onServerError` (optional) — used identically in Tasks 4, 5, 7, 13 and the harness updates.
- `applyGameIntent(roomCode, playerId, intent): GameActionResult<Record<string, never>>` and `requestSkipOfflineTurn(roomCode, requesterId): GameActionResult<Record<string, never>>` — same signatures in RoomManager (Tasks 5, 10) and adapter (Tasks 11, 12).
- `getGameSnapshot(roomCode): GameState | null` — Tasks 4, 6, 11, 12.
- `#engineActor`, `#commitTransition(room, actorId, intent, source)`, `#reconcileAfterTransition(room, source)`, `#startBotIfActorIsBot`, `#createAutomation`, `#scheduleAutomation`, `#runAutomationCallback`, `#modeEligible`, `#clearAutomation`, `#mirrorOnlineIntoGame` — introduced once, referenced consistently.
- `GameRuntimeGateway`/`defaultGameGateway`/`isValidIntent`/`createInitialGame`/`applyGameIntent`(runtime)/`chooseTakeoverIntent`/`GameApplyOutcome` (Task 3) — imported by RoomManager (Tasks 4, 5, 7) and adapter (Task 11).
- `RoomDomainEvent` `game_events`/`game_snapshot`, `ResumeAck`, `RoomStatus 'ended'`, `WireFailure`/`GameErrorCode`/`GAME_ERROR_MESSAGES`/`gameFailure` (Task 2) — used everywhere downstream.

## Known risks and watch-items for the implementer

1. **Board-data imports (Task 3).** `BoardData`/`CardsData`/`GameConfig` are imported directly from `@richman/board-data`; do not move them back to the engine barrel.
2. **New required deps ripple (Task 4).** Adding `generateGameSeed`/`nextAutomationDelayMs` as required forces mechanical updates to `production.ts`, `roomManager.test.ts`, `socketRooms.test.ts`, and `serverStatic.test.ts` in the same commit, plus the one sanctioned `roomManager.test.ts` start assertion update. No other M1 assertion may change.
3. **Deterministic seat control in room tests (Tasks 7–10).** BOT-first / human-first seating is obtained by scanning seeds through the real `createGame`, not by guessing. Keep the scan bound (≤5000) and fail loudly if unmet.
4. **Controlled gateways vs. real engine (Tasks 5, 9, 10).** Use a scripted gateway only where the real engine cannot deterministically produce the seam (thrown apply, precise cross-player/ takeover debt, forced game_over). Reviewers at Gates B/C must confirm the real engine is used for all normal contract paths (§15.1).
5. **Ordering assertions (Tasks 11, 12).** Assert event/snapshot/ack order structurally via arrival-order arrays and `tick()` macrotasks — never timestamps or real sleeps. Register listeners before emitting.
6. **`ackAfterEventFlush` timing.** Success acks are deferred one macrotask so broadcast events land first. Keep game handlers on the same path; do not ack synchronously before `dispatchDomainEvents`.
7. **Generation vs. record identity.** `#scheduleAutomation` captures `record.generation`; keeping a record (bot/takeover continuation) reuses its generation, while clearing/replacing bumps it. A superseded queued callback must no-op — covered in Tasks 7 (dispose) and 8 (replacement).
8. **`resumeRoom` contract (Task 6).** It MUST keep returning `RoomResult<PublicRoomState>` (M1 equality tests depend on the exact shape). The wire snapshot is assembled only in the adapter via `getGameSnapshot` (Task 12). Never widen the manager return value.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-10-phase2-m2-engine-server.md`. Recommended execution: **Subagent-Driven** (superpowers:subagent-driven-development) — a fresh Tester authors each task's RED tests, a fresh implementer makes them GREEN, and each phase ends with the two independent reviews named in its gate before the next phase begins.
