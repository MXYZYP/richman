# Local Game Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Browser-local persistence for hot-seat games — survive reloads, closed tabs, and background eviction; offer at most two recoverable unfinished games from the home page.

**Architecture:** Two fixed `localStorage` slots with a versioned envelope. `LocalSession` persists the authoritative engine state before animating each accepted transition. A pure save-store module handles all storage operations with explicit result types. Hydration validates the envelope, exact map reference, immutable data, and runtime state. Online recovery flows are untouched.

**Tech Stack:** TypeScript, Vitest, Vue 3, localStorage, pnpm monorepo

**Spec:** `docs/superpowers/specs/2026-07-15-local-game-resume-design.md`

**Dependency:** Requires Phase 2 of the multi-map plan (`mapRef` in `GameState`).

---

## Phase A: Pure storage and hydration layer

### Task A1: Save envelope types

**Files:**
- Create: `apps/client/src/session/localGameSave.ts`

- [ ] Define:

```typescript
export const LOCAL_GAME_SAVE_KEYS = ['richman_local_game_1', 'richman_local_game_2'] as const;
export type LocalSaveSlot = 1 | 2;
export const LOCAL_GAME_SCHEMA_VERSION = 1;

export interface LocalGameSaveV1 {
  schemaVersion: 1;
  gameId: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  state: GameState;
}

export type LocalSaveSummary = {
  slot: LocalSaveSlot;
  gameId: string;
  title: string;
  players: { nickname: string; isBot: boolean }[];
  turn: number;
  updatedAt: number;
};

export type LocalSaveReadResult =
  | { kind: 'valid'; slot: LocalSaveSlot; save: LocalGameSaveV1; summary: LocalSaveSummary }
  | { kind: 'incompatible'; slot: LocalSaveSlot; reason: string }
  | { kind: 'corrupt'; slot: LocalSaveSlot; reason: string }
  | { kind: 'empty'; slot: LocalSaveSlot };

export type CreateLocalSaveResult =
  | { ok: true; slot: LocalSaveSlot; gameId: string; revision: number }
  | { ok: false; reason: 'no_empty_slot'; oldestSlot: LocalSaveSlot; oldestGameId: string }
  | { ok: false; reason: 'storage_error' };

export type CommitLocalSaveResult =
  | { ok: true; slot: LocalSaveSlot; revision: number }
  | { ok: false; reason: 'not_found' | 'game_id_mismatch' | 'revision_mismatch' | 'storage_error' };

export type RemoveLocalSaveResult =
  | { ok: true; slot: LocalSaveSlot }
  | { ok: false; reason: 'game_id_mismatch' | 'storage_error' };

export type SlotChoice =
  | { kind: 'empty'; slot: LocalSaveSlot }
  | { kind: 'replace_oldest'; slot: LocalSaveSlot; gameId: string };
```

### Task A2: Save-store read operations

**Files:**
- Modify: `apps/client/src/session/localGameSave.ts`
- Test: `apps/client/src/session/localGameSave.test.ts`

- [ ] Implement `readLocalSaveSlot(storage, slot, mapRegistry): LocalSaveReadResult`.

  - Catch all storage errors → `corrupt` with reason.
  - Parse JSON; validate envelope fields (`schemaVersion`, `gameId`, timestamps, `revision`).
  - Unsupported `schemaVersion` → `incompatible`.
  - Call `getMapPack(state.mapRef)` for exact resolution; failure → `incompatible`.
  - Validate runtime game state (players, properties, decks, turn, debt references).
  - Build `LocalSaveSummary` from validated state.

- [ ] Implement `readAllLocalSaveSlots(storage, mapRegistry): LocalSaveReadResult[]`.

- [ ] Test with in-memory `StorageLike` fake:
  - empty slot → `{ kind: 'empty' }`
  - valid save → `{ kind: 'valid', summary: { ... } }`
  - malformed JSON → `{ kind: 'corrupt' }`
  - unsupported schema → `{ kind: 'incompatible' }`
  - missing map → `{ kind: 'incompatible' }`
  - one corrupt slot doesn't affect the other

### Task A3: Save-store write operations

**Files:**
- Modify: `apps/client/src/session/localGameSave.ts`
- Test: `apps/client/src/session/localGameSave.test.ts`

- [ ] Implement `chooseLocalSaveSlot(results): SlotChoice` — return first empty slot, or oldest valid slot if both occupied.

- [ ] Implement `createLocalSave(storage, state, now): CreateLocalSaveResult`:
  - Find empty slot; if none, return `{ ok: false, reason: 'no_empty_slot', ... }`.
  - Generate `gameId` (UUID-like), `revision: 1`.
  - Write envelope JSON.
  - Return slot + gameId.

- [ ] Implement `commitLocalSave(storage, slot, expectedGameId, expectedRevision, state, now): CommitLocalSaveResult`:
  - Re-read slot; verify `gameId` and `revision` match.
  - Write with `revision + 1`.
  - Mismatch → `game_id_mismatch` or `revision_mismatch`.

- [ ] Implement `removeLocalSave(storage, slot, expectedGameId?): RemoveLocalSaveResult`:
  - If `expectedGameId` given, verify match before removal.
  - Catch storage errors.

- [ ] Test: create into empty slot, commit with correct revision, reject stale revision, reject wrong gameId, remove with/without gameId guard, storage error handling.

### Task A4: Game-state hydration validator

**Files:**
- Create: `packages/engine/src/hydrate.ts`
- Test: `packages/engine/src/__tests__/hydrate.test.ts`

- [ ] Implement `hydrateGameState(unknown): { ok: true; state: GameState } | { ok: false; reason: string }`.

  - Validate all `GameState` fields: players (IDs, colors, cash ≥0, position is valid cell ID), properties (ownerId refers to a player or null, level 0-5, mortgaged boolean), decks (card IDs match cards data, correct counts), currentPlayerId/winnerId/debt references exist, turn/phase/turnPhase valid enums, seed is string, board/cards/config structurally valid.

  - This is a pure function over the input data; it does not consult the map registry (that's done by the save-store layer).

- [ ] Test with:
  - A valid `GameState` from `createGame` → `ok`.
  - Missing player → `fail`.
  - Invalid color → `fail`.
  - Property ownerId pointing to non-existent player → `fail`.
  - Deck with wrong card count → `fail`.
  - currentPlayerId not in players → `fail`.

---

## Phase B: LocalSession persistence integration

### Task B1: Persistence boundary interface

**Files:**
- Modify: `apps/client/src/session/localSession.ts`

- [ ] Add `persistence?: LocalGamePersistence` to `CreateLocalSessionOptions`:

```typescript
export interface LocalGamePersistence {
  commit(nextState: GameState): Promise<LocalSaveCommitResult>;
  complete(finalState: GameState): Promise<LocalSaveCommitResult>;
}
```

- [ ] In `createLocalSession`, add an optional `restoreState?: GameState` parameter. When provided, skip `createInitialGameState` and use the restored state directly.

- [ ] Store `gameId` and `revision` for stale-writer detection.

### Task B2: Save-before-animate ordering

**Files:**
- Modify: `apps/client/src/session/localSession.ts`

- [ ] In `applyLocalIntent`, after `applyIntent` succeeds but BEFORE replacing `engineState` and playing events:

```typescript
const result = applyIntent(engineState, getActorId(engineState), intent);
if (!result.ok) { ... return false; }

// Persist BEFORE publishing — a crash during animation resumes at this complete state.
if (persistence) {
  const commitResult = await persistence.commit(result.state);
  if (!commitResult.ok) {
    lastError.value = commitResult.reason === 'revision_mismatch'
      ? '这局已在另一个页面更新，请返回首页重新载入'
      : '保存失败，本次操作未执行';
    return false;
  }
  revision = commitResult.revision;
}

engineState = result.state;
// ... play events ...
```

- [ ] If `result.state.phase === 'game_over'`, call `persistence.complete(result.state)` after the commit to remove the save slot.

- [ ] Test: verify that a failed commit prevents the state transition; verify successful commit updates revision.

### Task B3: Session lifecycle for durable games

**Files:**
- Modify: `apps/client/src/session/localSession.ts`
- Test: `apps/client/src/session/localSession.test.ts`

- [ ] `createLocalSession` with `persistence` but no `restoreState` calls `createLocalSave` on construction. If save fails (no empty slot, storage error), returns a `null` session or a temporary-session flag so `App.vue` can handle it.

- [ ] `createLocalSession` with `restoreState` skips save creation (the slot already exists) but sets `gameId`/`revision` from the hydrated save.

- [ ] Dispose does NOT remove the save (the user may want to resume later). Only `game_over` or explicit home-page deletion removes it.

- [ ] Test: durable session persists initial state; restored session preserves seed, decks, turn, assets; bot turn resumes automation once.

---

## Phase C: Home page resume UI

### Task C1: Resume card data in App.vue

**Files:**
- Modify: `apps/client/src/App.vue`

- [ ] Add reactive state:

```typescript
const localSaves = ref<LocalSaveReadResult[]>([]);
function syncLocalSaves() {
  localSaves.value = storage ? readAllLocalSaveSlots(storage, mapRegistry) : [];
}
```

- [ ] Call `syncLocalSaves()` on mount and after: create local game, resume local game, return home, delete save, complete game.

- [ ] Pass valid summaries to `HomeView` as `localSaveCards` prop.

### Task C2: Resume cards in HomeView.vue

**Files:**
- Modify: `apps/client/src/views/HomeView.vue`
- Test: `apps/client/src/views/HomeView.test.ts` (if test infra exists; otherwise manual verification)

- [ ] Add props:

```typescript
localSaveCards?: LocalSaveSummary[];
```

- [ ] Add events:

```typescript
resumeLocal: [gameId: string];
deleteLocal: [gameId: string];
```

- [ ] Render a `继续单机` section (sorted by `updatedAt` desc) with cards showing: title, players, turn, updated time, `继续游戏` and `删除存档` buttons.

- [ ] Deletion requires a second confirmation (inline, not `window.confirm`).

- [ ] Cards must be legible at 390×844; no horizontal overflow.

### Task C3: Resume and delete handlers in App.vue

**Files:**
- Modify: `apps/client/src/App.vue`

- [ ] `handleResumeLocal(gameId)`:
  - Find the slot with matching `gameId`.
  - Re-read and validate.
  - Create `LocalSession` with `restoreState` + persistence.
  - Set `stage = 'local_game'`.
  - Call `runBotTurnIfNeeded()` if current actor is a bot.

- [ ] `handleDeleteLocal(gameId)`:
  - Find slot, call `removeLocalSave`.
  - `syncLocalSaves()`.

### Task C4: Third-game replacement confirmation

**Files:**
- Modify: `apps/client/src/App.vue`
- Modify: `apps/client/src/components/GameSetup.vue`

- [ ] When user starts a new local game and both slots are occupied:
  - Show replacement confirmation naming the oldest save (title, players, turn, updated time).
  - Cancel: return to setup without changes.
  - Confirm: delete oldest save (with gameId guard), then create new game.

### Task C5: Exit label change

**Files:**
- Modify: `apps/client/src/views/GameView.vue`

- [ ] Local game exit label changes from `重新开局` to `保存并返回首页`.
- [ ] Online exit labels and confirmation behavior remain unchanged.

---

## Phase D: Cross-tab conflict detection

### Task D1: Storage event listener

**Files:**
- Modify: `apps/client/src/session/localSession.ts`
- Modify: `apps/client/src/App.vue`

- [ ] When a durable local session is active, listen for `window.addEventListener('storage', ...)`.

- [ ] If the event affects the active slot and the value changed or was removed:
  - Set a `staleSession` flag.
  - Stop accepting game actions (show `这局已在另一个页面更新，请返回首页重新载入`).
  - The stale flag clears when the user returns home.

- [ ] Test: simulate storage event, verify session becomes stale, verify actions are blocked.

---

## Phase E: Storage-unavailable handling

### Task E1: Storage availability check

**Files:**
- Modify: `apps/client/src/App.vue`
- Modify: `apps/client/src/components/GameSetup.vue`

- [ ] On app init, test `localStorage` availability (write + read + remove a test key).

- [ ] If unavailable, `GameSetup` shows a warning: `本浏览器无法保存进度，关闭页面后这局无法恢复`.

- [ ] User can still start a temporary (unsaved) local game.

- [ ] Temporary games use `createLocalSession` without `persistence`. No slot is consumed.

---

## Phase F: Verification

### Task F1: Automated tests

- [ ] Run: `pnpm exec vitest run apps/client/src/session/localGameSave.test.ts` — all pass
- [ ] Run: `pnpm exec vitest run packages/engine/src/__tests__/hydrate.test.ts` — all pass
- [ ] Run: `pnpm test` — full suite, no regressions
- [ ] Run: `pnpm typecheck` — no errors
- [ ] Run: `pnpm --filter @richman/client build` — pass

### Task F2: Browser scenarios (desktop 1440×900)

1. Start local game, take several human + bot actions, reload, resume → board/assets/turn identical.
2. Close during bot animation, reopen → resume at the complete transition, not a partial state.
3. Create two saves, continue each independently → sorted by updated time.
4. Start third game → replacement confirmation shows oldest save; cancel → no change; confirm → oldest replaced.
5. Finish a game → its card disappears from home.
6. Verify online recovery still follows original restore/defer/resume path.

### Task F3: Browser scenarios (mobile 390×844)

1. Resume cards legible, no horizontal overflow.
2. Delete confirmation accessible.
3. Replacement confirmation accessible.
4. Full local game play + resume.

### Task F4: Commit

```bash
git add -A
git commit -m "feat(client): local game resume with two-slot persistence

Browser-local save/restore for hot-seat games. Two fixed localStorage
slots hold versioned envelopes with the authoritative GameState.
Saves happen before animation so crashes resume at the complete
transition. Home page shows up to two resume cards. Online recovery
flows are unchanged."
```

### Task F5: Review

- [ ] Request independent code review.
- [ ] Resolve every Critical or Important finding.
