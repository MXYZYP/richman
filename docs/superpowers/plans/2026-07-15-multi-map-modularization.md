# Multi-Map Modularization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the single China Tour game into the first map of a controlled multi-map platform — versioned map packs, deterministic rule-module registry, data-driven square board presentation, and protocol-level map locking — without changing any China Tour rule outcome or visual.

**Architecture:** Five sequential phases. Phase 1 adds map-pack types and the versioned registry in `@richman/board-data`. Phase 2 adds map identity to engine state and routes rule behavior through controlled interfaces. Phase 3 locks map identity in the online protocol and room lifecycle. Phase 4 makes client presentation fully data-driven. Phase 5 migrates all callers, removes the single-map globals, and verifies end-to-end.

**Tech Stack:** TypeScript, Vitest, Vue 3, Socket.IO, pnpm monorepo

**Spec:** `docs/superpowers/specs/2026-07-15-multi-map-modularization-design.md`

---

## Approved execution corrections (authoritative)

The approved design spec is authoritative over every older example below. Execute with these corrected contracts:

- `MapRef` is exactly `{ id, version, contentHash }`; `RuleModuleRef` is exactly `{ id, version }`. Do not introduce `mapId`/`moduleId` aliases inside these types.
- `MapPack` is exactly `ref + metadata(title/description) + game(board/cards/config/requiredRuleModules) + presentation`. Do not add unapproved `minPlayers`/`maxPlayers` fields or a second flattened shape.
- `contentHash` covers the map identity without its hash, metadata, immutable game data, required modules, and presentation. Canonical serialization sorts object keys recursively, preserves array order, rejects non-JSON values, and feeds a synchronous pure-TypeScript SHA-256 implementation shared by Node validation and browser runtime. Do not import Node `crypto` into runtime code.
- Phase 1 validation must cover invalid maps as well as valid fixtures: exact start ID `0`, unique/non-contiguous IDs, every reference, every presentation cell, bounds/overlap, allowlisted icons/theme/decorations/assets, canonical hash, duplicate versions, active/exact resolution, and unknown modules. China source reconciliation remains separate.
- The permanent test-only map has a different cell count, non-China labels, a different square layout, no branch, non-contiguous non-start IDs, and `core@1`; it is never returned by the player catalog.
- Module registries use stable `id + version` ordering, reject duplicate/unknown references and exclusive-handler conflicts, and add only the extension boundaries required by the spec. Do not move working core switches merely to create speculative abstraction.
- `PublicGameSnapshot` and its serializer enumerate every public runtime field individually. They must never use `Omit<GameState, ...>` or spread the internal state, and must exclude seed, deck order, full board/cards/config, presentation, and module-private data.
- Exact map resolution never falls back to active/latest/China Tour. Phase 5 removes global single-map exports and every temporary compatibility default or alias.
- The test-only map must traverse board-data, engine, protocol/server, and client rendering before acceptance; unit registration alone is insufficient.
- The user has not authorized commits, staging, push, PR, deployment, or publication. Every commit step below is disabled unless the user later authorizes it.

## Dependency order

```
Phase 1 (board-data) → Phase 2 (engine) → Phase 3 (protocol+server)
                                            → Phase 4 (client)
                                              → Phase 5 (cutover)
```

Single-player local resume (`docs/superpowers/specs/2026-07-15-local-game-resume-design.md`) depends on Phase 2's `mapRef` in `GameState`. It can be planned in parallel but implemented only after Phase 2 ships.

---

## Phase 1: Map package foundation

### Task 1.1: Add MapRef, RuleModuleRef, and MapPack types

**Files:**
- Create: `packages/board-data/src/mapTypes.ts`

- [ ] Define `MapRef`, `RuleModuleRef`, `MapPresentation`, `CellPresentation`, `RouteDecoration`, `CenterDecoration`, `MapThemeTokens`, `MapPack`, `MapCatalogEntry` per spec §3-§5.

Key types:

```typescript
export interface MapRef {
  id: string;
  version: number;
  contentHash: string;
}

export interface RuleModuleRef {
  id: string;
  version: number;
}

export interface MapPack {
  ref: MapRef;
  metadata: {
    title: string;
    description: string;
  };
  game: {
    board: BoardData;
    cards: CardsData;
    config: GameConfig;
    requiredRuleModules: readonly RuleModuleRef[];
  };
  presentation: MapPresentation;
}

export interface MapCatalogEntry {
  ref: MapRef;
  title: string;
  description: string;
}
```

- [ ] Export from `packages/board-data/src/index.ts`.

- [ ] Test: create `packages/board-data/src/__tests__/mapTypes.test.ts` verifying type-level contracts compile.

### Task 1.2: Compute canonical content hash

**Files:**
- Create: `packages/board-data/src/hash.ts`
- Test: `packages/board-data/src/__tests__/hash.test.ts`

- [ ] Implement `canonicalStringify(value): string` and `computeContentHash(content): string` using one synchronous pure-TypeScript SHA-256 implementation. Runtime code must not import `node:crypto`, and the digest format is lowercase 64-character hexadecimal.

- [ ] The hash input includes `ref.id`, `ref.version`, metadata, immutable game data, required modules, and presentation while excluding only `ref.contentHash`. Object keys sort recursively; arrays retain order; `undefined`, functions, symbols, bigint, non-finite numbers, and cycles reject.

- [ ] Test against standard SHA-256 known vectors, then verify identical content → same hash; any manifest/game/presentation value change → different hash; object key insertion order does not matter; array order does matter; invalid JSON values reject.

### Task 1.3: Move China Tour into maps/china-tour/v1

**Files:**
- Create: `packages/board-data/maps/china-tour/v1/manifest.json`
- Move: `packages/board-data/data/board.json` → `maps/china-tour/v1/board.json`
- Move: `packages/board-data/data/cards.json` → `maps/china-tour/v1/cards.json`
- Move: `packages/board-data/data/game-config.json` → `maps/china-tour/v1/game-config.json`
- Keep copies at old paths during Phase 1-4; Phase 5 removes them.

- [ ] `manifest.json` contains `ref: {id:"china-tour",version:1,contentHash}`, `metadata: {title,description}`, `requiredRuleModules: [{id:"core",version:1}]`, and presentation data extracted from the current `boardLayout.ts` constants.

- [ ] Extract the current 14×14 placement, cell coordinates, short names, icons, property bands, route decorations, and center decorations into the manifest's `presentation` field. These must reproduce the exact current visual.

### Task 1.4: Versioned map registry

**Files:**
- Create: `packages/board-data/src/registry.ts`
- Test: `packages/board-data/src/__tests__/registry.test.ts`

- [ ] Implement:

```typescript
listActiveMaps(): readonly MapCatalogEntry[];
getActiveMapPack(mapId: string): MapPack;
getMapPack(mapRef: MapRef): MapPack;
registerMapPack(pack: MapPack): void; // build-time only
```

- [ ] Registry construction validates each pack: board graph integrity, cell ID 0 is start, `nextId` chains, airport `branchEntryId` targets exist, presentation covers every cell, theme tokens are known, rule-module references are registered.

- [ ] `getMapPack` does exact `id + version + contentHash` matching. No fuzzy fallback.

- [ ] Test: register china-tour@1, list it as active, resolve by exact ref, reject stale hash, reject unknown version.

### Task 1.5: Split generic vs China-specific validation

**Files:**
- Modify: `packages/board-data/src/validate.ts`
- Test: `packages/board-data/src/__tests__/validate.test.ts`

- [ ] Keep China Tour source reconciliation (names, values, card text, counts) as a China-specific validation entry point invoked during registry construction for china-tour only.

- [ ] Generic validation (graph checks, placement checks, module checks) applies to all maps.

- [ ] Run: `pnpm validate-data` — must pass for china-tour@1.

### Task 1.6: Test-only map fixture

**Files:**
- Create: `packages/board-data/maps/__test__/test-map-v1/` with board, cards, config, manifest
- Test: `packages/board-data/src/__tests__/testMap.test.ts`

- [ ] The test map deliberately differs from China Tour: different cell count (e.g., 20 cells on a 8×8 square), different labels, no airport branch, non-contiguous non-start IDs, different theme tokens.

- [ ] Test: the test map registers, validates, and resolves through the same generic code path without any China-specific branch.

- [ ] The test map is NOT in the active catalog.

### Task 1.7: Phase 1 verification and commit

- [ ] Run: `pnpm validate-data` — pass
- [ ] Run: `pnpm exec vitest run packages/board-data/` — all pass
- [ ] Run: `pnpm typecheck` — no errors
- [ ] Do not commit unless the user explicitly authorizes it.

---

## Phase 2: Engine identity and rule boundaries

### Task 2.1: Add mapRef and ruleModules to GameState

**Files:**
- Modify: `packages/engine/src/types.ts`
- Modify: `packages/engine/src/engine.ts` (`createGame` / `createInitialGame`)
- Test: `packages/engine/src/__tests__/engine.test.ts`

- [ ] Add `mapRef: MapRef` and `ruleModules: readonly RuleModuleRef[]` to `GameState`.

- [ ] During Phase 2 only, `createGame` may accept temporary defaults to keep the migration buildable. Phase 5 must migrate every caller, make exact map/module identity mandatory for new games, and remove these defaults completely.

- [ ] Existing tests pass without modification (they don't pass `mapRef` and get the default).

### Task 2.2: Rule-module registry interface

**Files:**
- Create: `packages/engine/src/moduleRegistry.ts`
- Test: `packages/engine/src/__tests__/moduleRegistry.test.ts`

- [ ] Define interfaces for cell-effect handlers, intent handlers, and bot-strategy hooks.

- [ ] Represent current behavior as `core@1` — register existing cell effects, intents, and bot strategy under this module.

- [ ] Conflict detection: one module owns one cell-effect type, one intent action. Composable hooks run in stable `id + version` order.

- [ ] `applyIntent` resolves handlers from the registry; during migration, the existing switch-case logic moves behind the registry interface without behavior change.

- [ ] Test: register core@1, dispatch intents, verify identical outcomes to current direct calls; reject duplicate handlers; verify stable hook order independent of registration order.

### Task 2.3: Deterministic seed comparison

**Files:**
- Test: `packages/engine/src/__tests__/deterministicMigration.test.ts`

- [ ] For the same seeds used in existing tests, compare key state transitions before and after the mapRef/module migration. The sequences must be identical.

- [ ] This is a regression guard: if the migration changes any dice roll, card draw, or movement, these tests fail.

### Task 2.4: Update simulate.ts to use registry

**Files:**
- Modify: `packages/engine/src/simulate.ts`

- [ ] Replace direct `boardData`/`cardsData`/`gameConfig` imports with `getActiveMapPack('china-tour')`.

- [ ] Run: `pnpm --filter @richman/engine simulate:500` — completes without errors.

### Task 2.5: Phase 2 verification and commit

- [ ] Run: `pnpm exec vitest run packages/engine/` — all pass
- [ ] Run: `pnpm --filter @richman/engine simulate:500` — pass
- [ ] Run: `pnpm typecheck` — no errors
- [ ] Do not commit unless the user explicitly authorizes it.

---

## Phase 3: Protocol and authoritative room locking

### Task 3.1: Add mapId to room creation protocol

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `apps/server/src/rooms/roomTypes.ts` (add `mapRef: MapRef` to `Room`)
- Modify: `apps/server/src/rooms/roomManager.ts`

- [ ] `CreateRoomPayload` gains `mapId: string`.

- [ ] `Room` stores the server-resolved `MapRef` at creation time.

- [ ] `handleCreate` resolves the active `MapRef` via `getActiveMapPack(mapId).ref` and locks it. Unknown `mapId` → clear error ack.

- [ ] The room keeps that exact reference through lobby, game start, reconnect, bot automation, and offline takeover.

### Task 3.2: Replace Omit-based PublicGameSnapshot

**Files:**
- Modify: `packages/protocol/src/index.ts` (`PublicGameSnapshot`)
- Modify: `apps/server/src/publicGameSnapshot.ts` (`toPublicGameSnapshot`)
- Modify: `apps/server/src/rooms/roomManager.ts` (snapshot emission)

- [ ] `PublicGameSnapshot` explicitly lists runtime fields on the wire: `mapRef`, `turn`, `phase`, `turnPhase`, `currentPlayerId`, `players`, `properties`, `debt`, `lastDice`, `recentLog`, `winnerId`, `cashGoal`, and `deckCounts`. No spread of internal state.

- [ ] `toPublicGameSnapshot` constructs the snapshot field-by-field. Internal fields (`seed`, `decks`, `board`, `cards`, `config`, `ruleModules`) never appear on the wire.

### Task 3.3: Update all server tests

**Files:**
- Modify: `apps/server/src/__tests__/roomManager.test.ts`
- Modify: `apps/server/src/__tests__/socketGame.test.ts`
- Modify: `apps/server/src/__tests__/socketGameReconnect.test.ts`

- [ ] All `room:create` calls include `mapId: 'china-tour'`.

- [ ] Verify room keeps exact `mapRef` through join/start/reconnect.

- [ ] Verify snapshot no longer leaks `seed` or `decks`.

### Task 3.4: Phase 3 verification and commit

- [ ] Run: `pnpm exec vitest run apps/server/ packages/protocol/` — all pass
- [ ] Run: `pnpm typecheck` — no errors
- [ ] Do not commit unless the user explicitly authorizes it.

---

## Phase 4: Data-driven client presentation

### Task 4.1: Client map-pack resolver

**Files:**
- Create: `apps/client/src/game/mapResolver.ts`
- Test: `apps/client/src/game/mapResolver.test.ts`

- [ ] Given a `MapRef`, call `getMapPack(mapRef)` to resolve the exact local pack.

- [ ] Compose the presentation + immutable data with the public runtime snapshot into a renderable state.

- [ ] If the exact map version/hash is unavailable, refuse to render and show a compatibility error. Never substitute a newer version.

### Task 4.2: Data-driven GameBoard

**Files:**
- Modify: `apps/client/src/components/GameBoard.vue`
- Modify: `apps/client/src/components/BoardCell.vue`
- Modify: `apps/client/src/components/FocusedBoard.vue`
- Modify: `apps/client/src/ui/boardLayout.ts`

- [ ] `boardLayout.ts` reads placement data from `MapPresentation.cells` instead of hardcoded 14×14 constants.

- [ ] Short names, icons, property bands, cell coordinates, route decorations, and center decorations all come from the map pack's presentation data.

- [ ] China Tour visual output is pixel-identical to current.

- [ ] The test-only map (different cell count, different layout) renders correctly without any shared-code branch.

### Task 4.3: Map selector in setup UI

**Files:**
- Modify: `apps/client/src/components/GameSetup.vue`
- Modify: `apps/client/src/game/gameSetup.ts`
- Test: `apps/client/src/game/gameSetup.test.ts`

- [ ] `listActiveMaps()` populates the selector. Hidden when only one active map exists.

- [ ] Local game setup resolves the active `MapPack` immediately and passes `mapId` to room creation for online.

### Task 4.4: Phase 4 verification and commit

- [ ] Run: `pnpm exec vitest run apps/client/` — all pass
- [ ] Run: `pnpm --filter @richman/client build` — pass
- [ ] Run: `pnpm typecheck` — no errors
- [ ] Do not commit unless the user explicitly authorizes it.

---

## Phase 5: Clean cutover and verification

### Task 5.1: Migrate all callers away from single-map globals

**Files:**
- Modify: every file currently importing `{ boardData, cardsData, gameConfig }` from `@richman/board-data`

- [ ] Engine, simulate, server tests, client localSession, client clientGame — all resolve data through `getActiveMapPack` or the `GameState.board/cards/config` they already hold.

- [ ] Remove the global `boardData`, `cardsData`, `gameConfig` exports from `packages/board-data/src/index.ts`.

- [ ] Remove the old `data/*.json` files (already moved to `maps/china-tour/v1/` in Phase 1).

### Task 5.2: Remove China-specific helpers from shared client code

**Files:**
- Modify: `apps/client/src/ui/boardLayout.ts`

- [ ] Remove any hardcoded China Tour cell IDs, names, or layout constants now superseded by map-pack presentation data.

- [ ] `boardLayout.test.ts` expectations remain valid because they test the function contract, not China-specific values.

### Task 5.3: Full verification

- [ ] Run: `pnpm test` — all files pass
- [ ] Run: `pnpm typecheck` — no errors
- [ ] Run: `pnpm validate-data` — pass
- [ ] Run: `pnpm --filter @richman/client build` — pass
- [ ] Run: `pnpm --filter @richman/engine simulate:500` — pass

### Task 5.4: Real browser verification

- [ ] Start dev server: `pnpm dev`
- [ ] China Tour local game at 1440×900: board, cells, labels, property bands, route, center identical to pre-migration.
- [ ] China Tour local game at 390×844: mobile layout, global/focused board switch, no horizontal overflow.
- [ ] China Tour online game (2 browser tabs): create room, join, start, play several turns, reconnect after reload.
- [ ] Capture screenshots for desktop and mobile.

### Task 5.5: Review

- [ ] Do not commit unless the user explicitly authorizes it.
- [ ] Request independent code review (reviewer or oracle agent).
- [ ] Resolve every Critical or Important finding before merge.
