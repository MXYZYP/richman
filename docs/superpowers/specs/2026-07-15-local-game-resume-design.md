# Local Game Resume Design

**Date:** 2026-07-15
**Status:** Approved for implementation planning
**Scope:** Browser-local persistence and resume for local hot-seat games only

## 1. Goal

A local hot-seat game survives reloads, closed tabs, browser process loss, and mobile background eviction. The home page offers at most the two most recently played unfinished local games. Resuming restores the exact authoritative game state rather than starting a similar game or replaying only visible UI state.

This feature is intentionally separate from online recovery:

- online recovery continues to use server-owned rooms and the existing room credential flow;
- local recovery uses browser storage and never contacts the server;
- the existing online restore, defer, retry, abandon, and reconnect behavior must not change.

## 2. Accepted product behavior

### 2.1 Home-page resume cards

When unfinished local saves exist, the home page shows a `继续单机` section with at most two cards sorted by `updatedAt` descending.

Each valid card displays:

- map title;
- player nicknames and bot markers;
- current turn number;
- last saved time;
- `继续游戏` and `删除存档` actions.

Deletion requires a second explicit confirmation. Deleting one local save never touches the other local save or any online recovery record.

The first click snapshots the exact observed record. If another tab changes that slot before the second click, confirmation submits the original snapshot, reports a conflict, and preserves the newer record.

An invalid or incompatible slot remains visible as `无法恢复的本机存档` with a concise reason and a confirmed delete action. The client does not silently delete user data merely because the current build cannot hydrate it.

### 2.2 Starting and leaving games

Starting a first or second unfinished local game uses an empty save slot. The initial authoritative state is persisted before the board is shown.

When both slots contain unfinished games, starting another local game presents an in-app confirmation naming the oldest save that will be replaced. Until the user confirms:

- neither existing save is changed;
- no new game session is created;
- the setup form remains intact.

The active local-game exit control becomes `保存并返回首页`. It disposes presentation timers and returns home while retaining the latest persisted state.

### 2.3 Completed games

A game that reaches `game_over` no longer occupies a resume slot. The transition reaches the settlement UI normally, then its local save is removed. If storage rejects removal, the home-page reader still treats a validated `game_over` record as non-resumable and reports cleanup failure rather than offering it as an unfinished game.

Completed games are not retained for history viewing. This project does not add a match archive.

### 2.4 Resume behavior

Selecting `继续游戏`:

1. re-reads the selected slot;
2. validates its envelope, exact map identity, immutable game data, enabled rule modules, and runtime state;
3. creates a local session from the stored authoritative `GameState`;
4. initializes the presenter directly at that stable state without replaying old animations;
5. continues bot automation if the current actor is a bot.

A resume never generates a new seed, reshuffles decks, resets the turn, substitutes current map content, or creates a new save ID.

### 2.5 Deployment boundary

The canonical production entry is the Cloudflare-hosted HTTPS site. Durable local saves require a browser-provided safe mutation lock and are supported on that secure origin. The plain-HTTP LAN party entry remains a lower-priority development and gathering aid; adding durable saves to that origin is deferred and is not part of this slice.

Local saves are origin-scoped. The Cloudflare site and a LAN-IP URL do not share or migrate saves.

## 3. Non-goals

This slice does not add:

- a historical timeline or turn-by-turn board viewer;
- replay animation for past events;
- rollback, branching, or “continue from an earlier turn”;
- cloud sync or transfer between devices;
- server storage for local games;
- more than two unfinished local saves;
- retention of completed games;
- changes to online room recovery;
- migration from a previous local-save format, because none exists.

## 4. Storage model

### 4.1 Fixed slots

Use two fixed `localStorage` keys:

```text
richman_local_game_1
richman_local_game_2
```

A fixed two-slot design is preferred over a separate index plus arbitrary record keys:

- listing requires exactly two reads;
- replacing the oldest save is one atomic `setItem` per slot;
- one malformed slot cannot make the other slot unreadable;
- there is no index/body split that can be interrupted between writes;
- the storage layout directly enforces the product limit.

Online keys such as `richman_session` and `richman_pending_room_request` remain unchanged.

### 4.2 Versioned envelope

```ts
interface LocalGameSaveV1 {
  schemaVersion: 1;
  gameId: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  state: GameState;
}
```

Invariants:

- `gameId` is a non-empty opaque ID generated once for a new game;
- timestamps are finite non-negative epoch milliseconds;
- `updatedAt >= createdAt`;
- `revision` is a positive safe integer and increases by exactly one for every persisted engine transition;
- `state.phase !== 'game_over'` for a resumable record;
- `state.mapRef` is the sole map identity and contains the exact map ID, version, and canonical content hash;
- `state` retains complete immutable `board`, `cards`, and `config` data as defined by the multi-map design.

The summary shown on the home page is derived only from a validated envelope and state. No independent summary fields duplicate map title, players, turn, or phase.

## 5. Persistence boundary

### 5.1 Authoritative state, not presenter state

`LocalSession` owns an internal authoritative engine state. The presenter intentionally lags while playing dice, movement, card, and cash animations. Persistence must therefore observe engine transitions directly and must never watch the rendered Vue state.

`createLocalSession` gains two distinct initialization paths:

- create a new game from a selected `MapPack` and setup options;
- restore a previously hydrated `GameState`.

It also accepts a persistence boundary that can commit the proposed next state before the session publishes it:

```ts
interface LocalGamePersistence {
  commit(nextState: GameState): Promise<LocalSaveCommitResult>;
  complete(finalState: GameState): Promise<LocalSaveCommitResult>;
}
```

The concrete browser store remains in the client package. The pure engine package has no browser-storage dependency.

### 5.2 Transition ordering

For every accepted human or bot intent:

1. call pure `applyIntent(currentState, actorId, intent)`;
2. obtain `result.state` and `result.events` without mutating the session;
3. persist `result.state` with the expected `gameId` and `revision`;
4. only after a successful commit, replace the in-memory authoritative state;
5. play events toward the new renderable state;
6. schedule the next bot action if applicable.

This ordering guarantees that a browser shutdown during animation resumes at the complete accepted transition.

If a previously durable game cannot commit its next revision, the transition is not published or animated. The current in-memory and durable states remain the same and the player receives a retryable `保存失败，本次操作未执行` message. This prevents silent restoration to an older state.

### 5.3 Initial storage failure

If the browser denies storage before a new local game begins, the setup UI explains that the game cannot be recovered after closing the page. The user may explicitly choose either:

- retry storage; or
- start a temporary unsaved game.

The application never labels a temporary game as saved. Temporary games do not consume a slot and retain the existing in-memory local-session behavior.

## 6. Slot operations

A client-owned `localGameSaveStore` module provides storage-safe operations over a `StorageLike` adapter so tests use an in-memory fake:

```ts
readLocalSaveSlots(storage, mapRegistry): LocalSaveSlotResult[]
createLocalSave(storage, state, now): CreateLocalSaveResult
commitLocalSave(storage, slot, expectedGameId, expectedRevision, state, now): CommitResult
removeLocalSave(storage, slot, expectedGameId?): RemoveResult
chooseLocalSaveSlot(results): EmptySlot | ReplaceOldest
```

Rules:

- all storage calls are caught and return explicit results; public operations do not throw browser storage errors;
- the oldest valid unfinished record is the lower `updatedAt`, with slot number as a deterministic tie-breaker;
- replacing the oldest slot validates that it still contains the same game ID observed by the confirmation UI;
- a changed slot produces a conflict and asks the user to review the current home-page list instead of deleting a newer game;
- deleting a slot can optionally require the expected game ID for the same reason.

## 7. Hydration and compatibility

Local storage is untrusted input. Type assertions are not hydration.

### 7.1 Envelope validation

The reader validates:

- supported `schemaVersion`;
- exact required envelope fields;
- `gameId`, timestamps, and revision;
- a structurally valid `state.mapRef` before consulting the registry.

Unknown schema versions remain visible as incompatible records and are not rewritten.

### 7.2 Exact map resolution

Hydration calls `getMapPack(state.mapRef)`, never `getActiveMapPack(state.mapRef.id)`.

It fails visibly when:

- the map ID or exact version is unavailable;
- the stored hash differs from the registry hash;
- a required rule module or presentation contract is unavailable;
- the immutable `board`, `cards`, or `config` snapshot does not match the resolved pack.

There is no fallback to China Tour or the latest version.

### 7.3 Runtime game-state validation

The engine exposes a pure hydration validator for unknown persisted values. At minimum it proves:

- all players, IDs, colors, cash values, positions, and status fields are valid;
- the current player, winner, debtor, creditor, and queued-payment references exist where required;
- property state keys refer to property cells and owner IDs refer to players;
- deck queues contain exactly the expected card IDs with valid multiplicity;
- turn, phase, turn phase, dice, RNG, debt, and recent-log fields satisfy their declared domains;
- RNG state is the canonical signed 32-bit decimal string emitted by the engine;
- a playing state has a live current player, an airport-roll state has that player on an airport, and a debt references a live debtor;
- a game-over state has no unresolved debt and names a live winner;
- enabled rule modules match the map reference and registry;
- every cell/card/config reference belongs to the exact immutable pack.

Hydration returns a typed `GameState` only after all checks pass.

## 8. Concurrent-tab conflict detection

Every active durable local session remembers its loaded `gameId` and `revision`.

Before each write, the store re-reads the slot and requires both values to match. The commit writes `revision + 1`. The application also listens for browser `storage` events affecting its active slot. If another tab changes or removes the record, the old tab becomes stale and stops accepting further game actions until the user returns home and reloads the save.

This prevents normal multi-tab use from silently overwriting newer progress. Storage operations and revision checks remain deterministic and unit-testable; no online server or socket is introduced.

## 9. UI integration

### 9.1 `App.vue`

The app shell owns:

- the two slot read results;
- local save selection and deletion;
- third-game replacement confirmation state;
- creation of durable or explicitly temporary `LocalSession` instances;
- refresh of local save summaries after create, resume, completion, deletion, and return home.

These values are separate from `AppFlowSnapshot`. The existing online page reducer and automatic restore precedence remain untouched.

### 9.2 `HomeView.vue`

`HomeView` receives local save cards and emits local-only actions. Existing online props and events keep their meanings.

The two cards must fit the existing visual language and remain legible at 390 × 844. The home page may scroll vertically; controls must not overflow horizontally.

### 9.3 `GameSetup.vue`

When both slots are occupied, setup preserves the chosen players and rules while showing a custom replacement confirmation. Native `window.confirm` is not used.

### 9.4 `GameView.vue`

For a durable or temporary local game, the active-game exit label becomes `保存并返回首页`. Online exit labels and confirmation behavior remain unchanged. Settlement behavior continues to use the existing shared view after the completed save is removed.

## 10. Error behavior

User-visible outcomes are specific and non-destructive:

- unsupported schema: `该存档来自不兼容的游戏版本`;
- missing or mismatched map: `找不到这局使用的地图版本`;
- invalid game state: `存档内容已损坏，无法恢复`;
- revision or game-ID mismatch: `这局已在另一个页面更新，请返回首页重新载入`;
- storage read/write rejection: `浏览器无法保存本次操作，请检查存储权限后重试`;
- failed delete: keep the card and report that deletion did not complete.

Errors from local-save operations never overwrite the existing online error state.

## 11. Verification

### 11.1 Focused automated contracts

Add focused tests for:

- zero, one, and two valid slots sorted by update time;
- malformed JSON in one slot leaving the other usable;
- unsupported schema retained as incompatible;
- exact map version/hash hydration;
- immutable data and runtime reference validation;
- initial create into an empty slot;
- confirmed replacement of the observed oldest game only;
- rejected replacement when the slot changed after confirmation;
- revision increments and stale-writer rejection;
- save-before-presenter ordering for human and bot actions;
- failed commit leaving the engine and presenter at the previous state;
- resume preserving seed, decks, turn, assets, debt, and actor;
- resuming a bot turn restarts automation once;
- `game_over` removal and non-resumability;
- local delete isolation from online storage keys;
- stale confirmed deletion after a cross-tab refresh preserving the newer exact record;
- rejection of non-canonical or out-of-range RNG state and unreachable airport/debt/player states;
- existing online app-flow and reconnect tests unchanged.

### 11.2 Real browser scenarios

Exercise both 1440 × 900 desktop and 390 × 844 mobile:

1. start a local game, take several human and bot actions, reload, resume, and compare the board and assets;
2. close during bot presentation, reopen, and confirm one complete transition rather than a partial animation state;
3. create two saves, continue each independently, and confirm sorted timestamps;
4. attempt a third game, cancel replacement, then confirm replacement;
5. finish a game and confirm its card disappears;
6. verify two resume cards, confirmation UI, and error text remain readable on mobile;
7. verify an existing online recovery record still follows the original restore/defer/resume path.

## 12. Acceptance criteria

1. At most two unfinished local games are recoverable from the home page.
2. Reload or browser loss resumes the latest complete accepted transition of the selected game.
3. Starting a third game never deletes an older game without explicit confirmation.
4. Completed games do not occupy a slot.
5. Invalid, incompatible, stale, or unwritable state fails visibly without substituting data or corrupting the other slot.
6. Local saves retain the exact map reference and self-contained authoritative game state.
7. Online recovery behavior and storage records are unchanged.
8. Desktop and 390 × 844 mobile browser scenarios pass with no horizontal overflow or inaccessible controls.
