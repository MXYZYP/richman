# PublicGameSnapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every public game snapshot omits RNG seed and shuffled deck order while exposing only deck counts.

**Architecture:** Keep complete `GameState` inside the engine, RoomManager, and internal domain events. Define one `PublicGameSnapshot` type and one pure projector in the protocol layer, then invoke that projector at the two Socket.IO egress points: `game:snapshot` dispatch and deferred `session:resume` acknowledgement. Final settlement snapshots reuse the same `game:snapshot` dispatch path.

**Tech Stack:** TypeScript, Socket.IO, Vitest, Vue/Node 20 monorepo.

---

### Task 1: Public snapshot projection and all wire boundaries

**Files:**
- Modify: `apps/server/src/protocol.ts`
- Modify: `apps/server/src/socket/roomSocketAdapter.ts`
- Test: `apps/server/src/__tests__/socketGame.test.ts`
- Test: `apps/server/src/__tests__/socketGameReconnect.test.ts`
- Modify: `plan/03-架构与联机协议.md`

- [ ] **Step 1: Write failing public snapshot serialization tests**

In `socketGame.test.ts`, add a helper and exercise it against a real received initial snapshot and the existing final game-over snapshot:

```ts
function expectSerializedPublicSnapshot(state: PublicGameSnapshot): void {
  const serialized = JSON.stringify(state);
  expect(serialized).not.toContain('"seed"');
  expect(serialized).not.toContain('"decks"');
  expect(state.deckCounts).toEqual({ chance: 15, destiny: 15 });
  expect(Number.isInteger(state.deckCounts.chance)).toBe(true);
  expect(Number.isInteger(state.deckCounts.destiny)).toBe(true);
}
```

In `socketGameReconnect.test.ts`, invoke the equivalent assertion on a successful playing `session:resume` snapshot so the second egress path is locked. Do not weaken existing token, ordering, resume-freshness, or settlement assertions.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm exec vitest run apps/server/src/__tests__/socketGame.test.ts apps/server/src/__tests__/socketGameReconnect.test.ts
pnpm --filter @richman/server build
```

Expected: RED because wire snapshots are still typed and serialized as `GameState`, contain `seed` and `decks`, and lack `deckCounts`.

- [ ] **Step 3: Define the public type and pure projector**

In `apps/server/src/protocol.ts` add:

```ts
export type PublicGameSnapshot = Omit<GameState, 'seed' | 'decks'> & {
  deckCounts: {
    chance: number;
    destiny: number;
  };
};

export function toPublicGameSnapshot(state: GameState): PublicGameSnapshot {
  const { seed, decks, ...snapshot } = state;
  void seed;
  return {
    ...snapshot,
    deckCounts: {
      chance: decks.chance.length,
      destiny: decks.destiny.length,
    },
  };
}
```

Change the public contracts only:

```ts
export interface ResumeAck {
  room: PublicRoomState;
  snapshot?: PublicGameSnapshot;
}

export interface ServerToClientEvents {
  'game:snapshot': (payload: { state: PublicGameSnapshot }) => void;
}
```

Keep `RoomDomainEvent.game_snapshot` and internal RoomManager state typed as complete `GameState`.

- [ ] **Step 4: Project at both Socket.IO egress points**

In `roomSocketAdapter.ts`, import `toPublicGameSnapshot`.

For internal `game_snapshot` events:

```ts
io.to(event.roomCode).emit('game:snapshot', {
  state: toPublicGameSnapshot(event.state),
});
```

Inside the existing deferred resume response factory, project the latest snapshot at acknowledgement time:

```ts
const snapshot = roomManager.getGameSnapshot(payload.roomCode);
return snapshot === null
  ? { ok: true, room }
  : { ok: true, room, snapshot: toPublicGameSnapshot(snapshot) };
```

Do not move projection earlier; resume freshness and internal automation must continue using complete state.

- [ ] **Step 5: Update protocol documentation**

In `plan/03-架构与联机协议.md` §5.2:

- document `{state: PublicGameSnapshot}`;
- define `PublicGameSnapshot = GameState - seed - decks + deckCounts`;
- state that shuffled queue order and RNG state never leave the server;
- state that `deckCounts` exposes only `chance`/`destiny` counts;
- state that actual draws are shown from `card_drawn` events;
- state that `session:resume` and final settlement snapshots use the same structure.

- [ ] **Step 6: Run focused and full verification**

Run:

```bash
pnpm exec vitest run apps/server/src/__tests__/socketGame.test.ts apps/server/src/__tests__/socketGameReconnect.test.ts apps/server/src/__tests__/roomGame.test.ts
pnpm test
pnpm typecheck
pnpm exec tsc -p scripts/tsconfig.json --noEmit
pnpm validate-data
pnpm build
pnpm --filter @richman/server build
pnpm exec tsx scripts/smoke-production.ts
```

Expected: all pass; snapshots serialize without `seed`/`decks`; smoke prints `smoke ok`.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/protocol.ts \
  apps/server/src/socket/roomSocketAdapter.ts \
  apps/server/src/__tests__/socketGame.test.ts \
  apps/server/src/__tests__/socketGameReconnect.test.ts \
  plan/03-架构与联机协议.md
git commit -m "fix(server): hide RNG state and deck order from public snapshots"
```
