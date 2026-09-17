# Multi-Map Modularization Design

Date: 2026-07-15
Status: Approved for implementation planning
Scope: Board data, deterministic engine extensions, room protocol/server map locking, and data-driven client board presentation

## 1. Goals

Turn the existing China Tour game into the first map of a controlled multi-map platform without rewriting the game, changing China Tour behavior, or introducing runtime plugins.

The completed design must provide these outcomes:

1. A map that uses the existing rules can be added by adding its versioned map files and one registry entry.
2. Every map renders inside a square board, but the square is not required to use a 14 × 14 grid.
3. Cell count, cell coordinates, route shape, and branch count are map data. A map may have no branch, one branch, or multiple branches.
4. Cell ID `0` is always the single start cell on every map.
5. A map may opt into formally shipped rule modules for small additional mechanics, but cannot carry executable code.
6. Local and online games use the same map identity and deterministic rule definitions.
7. An online room locks an exact map version when the room is created.
8. China Tour keeps its current game data, behavior, responsive board experience, and visual design.

The existing project remains the correct home for this work. It already contains the tested engine, bot behavior, local session, authoritative online rooms, reconnect handling, and shared client. Rebuilding those systems for each map would duplicate the highest-risk parts of the product.

## 2. Non-goals

This change does not include:

- a second player-facing map;
- a map editor or authoring UI;
- uploading or installing maps at runtime;
- third-party JavaScript, CSS, or rule plugins;
- a local save/load UI;
- changing maps after an online room has been created;
- pre-implementing teleport, jail, portal, or other unspecified mechanics;
- redesigning China Tour visuals or rules;
- changing the shared player rail, action panel, dialogs, or other product chrome per map;
- allowing non-square board containers.

## 3. Immutable map identity

Every registered map version has an immutable identity:

```ts
export interface MapRef {
  id: string;
  version: number;
  contentHash: string;
}
```

- `id` is the stable family identity, for example `china-tour`.
- `version` identifies a published revision of that map.
- `contentHash` is a canonical content fingerprint covering the manifest, game data, and presentation data for that version.
The canonical hash excludes the `contentHash` field itself and uses one deterministic serialization algorithm shared by validation tooling and every runtime.

The hash prevents two deployments from silently treating different content as the same map version. Editing published content requires a new version and a new hash.

The map registry supports multiple versions of one map. It separately identifies the version currently available for new games.

```ts
listActiveMaps(): readonly MapCatalogEntry[];
getActiveMapPack(mapId: string): MapPack;
getMapPack(mapRef: MapRef): MapPack;
```

`getActiveMapPack` is used only when creating a new local game or room. Restores and reconnects use `getMapPack` with the exact reference and never substitute the latest version.

China Tour becomes `china-tour@1`.

## 4. Map pack contract

A map pack contains immutable game data and controlled presentation data:

```ts
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
```

The initial directory shape is:

```text
packages/board-data/maps/
└── china-tour/
    └── v1/
        ├── manifest
        ├── board
        ├── cards
        ├── config
        └── presentation
```

Exact file extensions are an implementation-plan decision. The contract, version boundary, and validation behavior are not.

### 4.1 Board rules

The generic board contract keeps these platform invariants:

- cell IDs are unique numeric identifiers;
- cell ID `0` exists and is the only cell with type `start`;
- other cell IDs do not need to be contiguous;
- explicit references such as `nextId`, card destinations, and module data must resolve to existing cells;
- absent `nextId` continues to mean the next cell in board array order;
- the final array cell must explicitly define its next destination;
- game movement follows board data only, never visual coordinates.
Core validation and movement support zero or more airport cells and validate every declared `branchEntryId`; they must not stop after the first airport. A branch choice beyond the existing airport behavior requires a formal rule module.

The current generic `direction: 'clockwise'` field is not a game rule and must not constrain future routes. China Tour may retain clockwise information as presentation metadata if useful, but the platform does not require every map to be clockwise.

### 4.2 Core and module data envelopes

Existing core cell, effect, intent, and event types remain strongly typed. Future module-owned data uses namespaced envelopes rather than widening every core union to arbitrary strings:

```ts
interface ModuleCellData {
  type: 'module';
  module: RuleModuleRef;
  cellType: string;
  payload: JsonValue;
}

interface ModuleEffect {
  type: 'module';
  module: RuleModuleRef;
  effectType: string;
  payload: JsonValue;
}

interface ModuleIntent {
  type: 'module';
  module: RuleModuleRef;
  action: string;
  payload: JsonValue;
}

interface ModuleEvent {
  type: 'module';
  module: RuleModuleRef;
  eventType: string;
  payload: JsonValue;
}
```

A concrete future mechanism may refine these envelopes when implemented. The map pack can only reference module definitions already compiled into the application.

## 5. Data-driven square board presentation

`MapPresentation` defines a square design canvas and a placement for every game cell.

```ts
export interface MapPresentation {
  canvas: {
    size: number;
  };
  cells: Record<number, CellPresentation>;
  routes: readonly RouteDecoration[];
  center: readonly CenterDecoration[];
  theme: MapThemeTokens;
}
```

Each `CellPresentation` provides controlled display data, including:

- `x`, `y`, `width`, and `height` in map design units;
- orientation or rotation;
- layer order where required;
- short label and compact-label behavior;
- built-in icon ID or validated package-local asset reference;
- property band color/token;
- optional accessibility label overrides.

The design canvas is always square, but its size and internal coordinate system are map-defined. It is not a 14 × 14 grid contract.

### 5.1 No structural branch concept in the renderer

The generic client does not know about an outer ring or branch cells. It renders all cells from the same placement collection. A map may define zero or more visual route decorations.

- Board movement uses game `nextId` and rule-module data.
- Route decorations draw lines, paths, or other approved visual connectors only.
- A route decoration cannot change movement behavior.

This removes the current assumptions that IDs `0–51` are an outer ring, IDs `52–60` are a branch, and all cells fit a fixed 14 × 14 CSS grid.

### 5.2 Controlled theming

A map may provide only allowlisted presentation values:

- board, cell, border, route, title, and decoration colors;
- property-band colors;
- approved typography roles;
- built-in icon IDs;
- validated package-local assets and decoration types.

A map may not provide arbitrary CSS, JavaScript, remote images, network fonts, or selectors that restyle shared controls. Buttons, player cards, dialogs, action panels, and navigation remain application-owned.

China Tour presentation absorbs the current short-name overrides, icons, property bands, center decoration, placements, and route visuals now held in `boardLayout.ts` and `GameBoard.vue`.

### 5.3 Responsive behavior

The board scales its square design canvas uniformly into available space. The existing mobile global/focused-board behavior remains:

- the full-board view provides position and route context;
- the focused view provides readable cells and practical interaction targets;
- desktop and mobile consume the same map coordinates;
- a map does not supply viewport-specific executable layout logic.

Automated validation catches missing placements, out-of-bounds rectangles, and illegal overlaps. Real browser checks remain required because data validation cannot prove legibility.

## 6. Deterministic rule-module registry

Maps declare rule requirements but never supply rule code:

```ts
export interface RuleModuleRef {
  id: string;
  version: number;
}
```

China Tour declares only `core@1`.

The engine exposes one immutable `RuleModuleRegistry` compiled into the release. A formal module can register controlled capabilities such as:

- module cell settlement;
- module effect execution;
- module intent validation and application;
- module-specific map and state validation;
- bot and offline-takeover decisions;
- client-safe event descriptions or presentation metadata.

### 6.1 Determinism and conflicts

- Unknown or duplicate module references reject the map.
- One module cell type has one primary handler.
- One module effect type has one executor.
- One module intent action has one handler.
- Exclusive-handler collisions reject registry construction.
- Explicitly composable hooks run in stable `module id + version` order, never import or registration order.
- Local play, server play, bots, and offline takeover resolve definitions from the same registry.
- Protocol and client validation use the same declared module identities, but only the engine executes rules.

This change creates the extension interfaces and represents existing behavior as `core@1`. It does not implement any speculative mechanism.

Adding a future mechanism requires one reviewed application release containing that module. After that release, any map may enable it through data without duplicating engine, bot, server, or client-session logic.

## 7. Engine state and reproducibility

`GameState` gains `mapRef` and the enabled rule-module references. It continues to retain complete immutable game data (`board`, `cards`, and `config`) so `applyIntent(state, ...)` remains deterministic and a future saved state remains self-contained.

The internal state therefore contains:

- exact `MapRef`;
- complete game-data snapshot;
- exact enabled rule modules;
- random state and private deck order;
- public gameplay state.

No current local `GameState` persistence exists. Browser storage currently keeps only online room identity and reconnect credentials. This project must not claim to migrate local saves that do not exist.

A future save format must persist `MapRef`, the immutable game-data snapshot, enabled rule modules, and runtime state. Hydration must validate all references and must not reinterpret unknown content as the current map version.

## 8. Online room and protocol flow

### 8.1 Room creation and locking

1. The local or online setup obtains map choices from `listActiveMaps()`.
2. The map selector is hidden while only one active map exists.
3. A local game resolves the active `MapPack` immediately.
4. `room:create` sends `mapId`; the client cannot choose a version or hash.
5. The server resolves the current supported `MapRef` and stores it in the new `Room` before returning success.
6. The room keeps that exact reference through lobby, game start, reconnect, bot automation, and offline takeover.
7. A room never changes maps. Choosing another map requires creating another room.
8. Joining clients inherit the room map and do not submit a map choice.

`PublicRoomState` exposes a safe map summary containing the exact reference and title. The lobby displays the title when more than one active map exists; with one active map it may remain visually hidden while the identity still travels through the protocol.

### 8.2 Explicit public game snapshots

`PublicGameSnapshot` must no longer be defined as `Omit<GameState, ...>`. The public type and `toPublicGameSnapshot` explicitly list runtime fields allowed on the wire, including:

- `mapRef`;
- turn, phase, and current-player state;
- players, properties, debt, dice, winner, cash goal, and required recent events;
- public deck counts.

The snapshot excludes:

- seed/random internals;
- private deck order;
- complete internal game-data snapshots;
- module-private state not explicitly declared public;
- presentation coordinates and theme data.

The client resolves the exact local `MapPack` from `mapRef` and composes its game/presentation data with the public runtime snapshot. Presentation is not retransmitted with every snapshot.

If the exact map version and hash are unavailable locally, the client refuses to render the room and asks for refresh/update. It never substitutes a newer map with the same ID.

### 8.3 Failure behavior

- Unknown `mapId` during room creation returns a clear unavailable-map acknowledgement.
- An unsupported or inactive version cannot be selected for a new room.
- An existing exact version may continue for rooms or future saves that reference it.
- A hash mismatch is a hard compatibility failure.
- A map with missing modules or invalid references cannot enter the runtime registry.
- A missing client presentation pack is a visible compatibility failure, not a fallback to China Tour.

## 9. Validation architecture

Validation is split into platform validation, map-specific source reconciliation, and runtime identity checks.

### 9.1 Generic map-pack validation

Every registered map version is checked for:

- valid and unique map ID/version registration;
- canonical content hash equality;
- unique numeric cell IDs;
- exactly one start cell and its ID equal to `0`;
- valid `nextId`, branch/module, card, and effect references;
- complete effect payloads;
- coherent property, rent, mortgage, card, and config values;
- resolvable and conflict-free rule-module references;
- one presentation placement for every cell and no unknown placement IDs;
- square canvas with positive dimensions;
- finite, in-bounds cell rectangles and no illegal overlap;
- valid visual route references;
- allowlisted theme tokens, icons, decorations, and local assets.

Graph checks are module-aware. Core validates its normal route and airport behavior; future modules validate their own additional references and traversal semantics.

### 9.2 China Tour source reconciliation

The existing checks against the China Tour Markdown source tables remain, but move behind a China-specific validation entry point. They continue to defend China Tour names, values, card text, exact card counts, and approved configuration.

The platform validator does not require future maps to have China place names, 35 normal properties, six special properties, 15 Chance cards, 15 Destiny cards, or China Tour prices.

### 9.3 Runtime checks

Room creation performs only the cheap authoritative lookup of an active `mapId`; map packs are already fully validated at registry construction.

Future save hydration and current reconnect composition validate:

- exact `MapRef` availability;
- content hash equality;
- cell, property, card, and module references in runtime state;
- compatibility between the public snapshot and local presentation pack.

Client-side checks improve error messages but never override server authority.

## 10. Test strategy

A permanent test-only map fixture proves that the platform is not still China-specific. It is not registered in the player-facing catalog.

The fixture must:

- use a different cell count;
- use cell ID `0` as its start;
- have no branch;
- use non-China labels;
- use a different square coordinate layout;
- use `core@1` only.

### 10.1 Board-data and registry tests

- Register and resolve active and exact map versions.
- Reject duplicate IDs/versions, stale hashes, and missing versions.
- Reject a start cell whose ID is not `0`.
- Accept non-contiguous non-start IDs.
- Validate both China Tour and the test-only map.
- Reject missing placements, out-of-bounds rectangles, illegal overlaps, invalid visual references, unknown theme tokens, and unknown modules.
- Keep China Tour source reconciliation as a separate passing suite.

### 10.2 Engine and rule-module tests

- Create and play deterministic China Tour states with `china-tour@1` and `core@1`.
- Compare key deterministic sequences before and after migration for the same seeds.
- Create, move, settle, and complete turns on the test-only map.
- Reject unknown modules and conflicting handlers.
- Prove stable hook order independent of registration order.
- Keep existing rule, bot, debt, bankruptcy, and simulation suites passing.

### 10.3 Protocol and server tests

- `room:create` requires a valid `mapId` and locks the server-resolved `MapRef`.
- The room map remains unchanged through join, start, reconnect, bot automation, and takeover.
- Unknown maps fail without creating a room.
- Public room state includes the safe map summary.
- Public game snapshots include only explicit runtime fields and `mapRef`.
- Seed, private decks, full game data, and presentation never leak.
- Exact-version mismatch fails rather than falling back.

### 10.4 Client and browser verification

- A single active map keeps the selector hidden.
- Multiple injected catalog entries expose the selector and submit the chosen `mapId`.
- GameBoard renders both China Tour and the test-only map without ID-range branches.
- China Tour keeps the current short labels, icons, color bands, center, and route appearance.
- Real local and online flows work at 1440 × 900 and 390 × 844.
- Global/focused mobile board switching remains usable.
- Missing exact presentation produces the explicit compatibility state.

## 11. Migration sequence

### Phase 1: Map package foundation

- Add `MapRef`, `RuleModuleRef`, `MapPack`, and presentation types to `@richman/board-data`.
- Move China Tour data into `maps/china-tour/v1`.
- Add the versioned registry and canonical hash verification.
- Split generic validation from China-specific source reconciliation.
- Add the test-only map fixtures and contract tests.

### Phase 2: Engine identity and rule boundaries

- Add map identity and enabled modules to `GameState` and game creation.
- Introduce the immutable rule-module registry and represent current rules as `core@1`.
- Route core cell/effect/intent/bot behavior through the controlled interfaces where extension is required.
- Preserve all current deterministic China Tour behavior.

### Phase 3: Protocol and authoritative room locking

- Add `mapId` to room creation.
- Store the resolved `MapRef` in `Room` at creation time.
- Add the safe map summary to public room state.
- Replace automatic `Omit` snapshots and spread serialization with explicit public fields.
- Update room start, reconnect, automation, socket adapters, and tests.

### Phase 4: Data-driven client presentation

- Read catalog/map identity in local and online setup.
- Hide the selector for one map and expose it automatically for multiple active maps.
- Compose online runtime snapshots with the exact local map pack.
- Replace fixed outer/branch rendering with one data-driven cell collection.
- Move China Tour labels, icons, property bands, placements, routes, center, and theme into its presentation data.
- Preserve the current square responsive and focused-board behavior.

### Phase 5: Clean cutover and verification

- Migrate every caller away from global `boardData`, `cardsData`, and `gameConfig` exports.
- Remove the fixed `boardLayout.ts` inference path and obsolete China-specific helpers from shared client code.
- Leave no compatibility aliases or second map-loading convention.
- Run focused tests after each phase, then the complete test, typecheck, data-validation, and client-build commands.
- Exercise local and online play in a real browser and capture desktop/mobile evidence.
- Request an independent code review and resolve every Critical or Important finding.

## 12. Compatibility and rollout

- China Tour content is copied without value or behavior changes and becomes the first versioned pack.
- There are no existing local game saves to migrate.
- Current rooms are in-memory and do not survive server replacement, so no persisted room migration is required.
- Client and server protocol changes ship together; no legacy create-room compatibility shim is retained.
- Existing invitation URLs remain room-code based and do not encode map identity.
- Old map versions remain in the registry while any supported restore path may reference them.
- A published map version is immutable; corrections create a new version.

## 13. Risks and mitigations

### Hidden China-specific assumptions

Risk: the second map appears to work while a third map requires another refactor.

Mitigation: the test-only map deliberately differs in cell count, labels, route structure, and layout; shared code is forbidden from branching on China IDs or names.

### Client/server content drift

Risk: the server applies one map revision while the client renders another.

Mitigation: rooms and snapshots carry an exact `MapRef`, and both sides reject hash mismatches.

### Public-state leakage

Risk: future internal fields become public because snapshots spread the entire engine state.

Mitigation: protocol and serializer explicitly enumerate public runtime fields.

### Rule-module nondeterminism

Risk: local, bot, and server behavior differs based on import order or missing handlers.

Mitigation: one immutable registry, exclusive-handler conflict checks, stable hook ordering, and shared definitions across runtimes.

### Responsive layout regressions

Risk: valid coordinates still produce unreadable mobile cells.

Mitigation: square design units, automated geometry checks, preserved focused-board mode, and real 390 × 844 plus 1440 × 900 browser verification.

### Platform validation remains China-specific

Risk: every new map is forced to copy China Tour counts and source files.

Mitigation: generic structural validation and China-specific source reconciliation are separate commands/suites.

## 14. Acceptance criteria

The modularization is complete only when all of the following are observed:

1. China Tour is resolved through `china-tour@1`, not through global single-map exports.
2. China Tour rule outcomes remain deterministic for the existing seeds and test suite.
3. The test-only map runs through engine, server room locking, protocol snapshot, and client board rendering without shared-code special cases.
4. Every map starts on cell ID `0`.
5. Every board renders in a square container without requiring a 14 × 14 grid or any branch.
6. A room locks one exact `MapRef` at creation and preserves it through the full room lifecycle.
7. Public snapshots expose explicit runtime data and do not leak private engine or presentation data.
8. Unknown maps, modules, versions, and hashes fail clearly and safely.
9. One-map UI remains unchanged; the selector appears only when multiple active maps exist.
10. China Tour desktop and mobile visuals remain equivalent to the current application.
11. Focused tests, the full suite, typecheck, map validation, and client build pass.
12. Real local and online browser scenarios pass at 1440 × 900 and 390 × 844.
13. Independent review reports no unresolved Critical or Important findings.
