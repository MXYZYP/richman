# World Tour Map Implementation Plan

> **Status:** Implemented and verified on `main`; the 2026-07-30 52-cell correction and final review fixes are complete.
> **Historical execution note:** The original work used test-driven milestone commits on the isolated `world-tour-map` branch. That branch restriction no longer describes the current `main` workspace.
> **Owner direction and implementation correction (2026-07-30):** The owner required a 52-cell outer loop and accepted that old saves need not survive. The implementation removes Portugal / Lisbon (`id=29`) and uses the local route Thailand (`48`) → Malaysia (`49`) → Singapore (`11`) → Bangkok Airport (`10`) → Indonesia (`12`) so all four printed corners remain special cells. This correction supersedes conflicting historical counts and successor notes below.

**Goal:** Deliver `world-tour@1` as the second active, fully playable formal map without changing China Tour behavior, the permanent test map, or any file reserved by the parallel visual branch.

**Architecture:** Add a normally immutable World Tour `MapPack` and a `world-tour@1` rule module. The 2026-07-30 in-place data correction is a one-time owner-authorized versioning exception recorded below; future published content changes still require a new version. The existing `core@1` module remains authoritative for ordinary movement, purchase, rent, debt, cards, and turn flow. World Tour adds only controlled module envelopes and composable `RuleModuleRegistry` hooks for next-turn airport entry, one-die branch movement, toll immunity, and the six interactive card effects. The server remains authoritative; the client renders only allowlisted public rule state and sends validated module intents.

**Tech Stack:** TypeScript, JSON map packs, Vitest, Vue 3, Socket.IO, pnpm monorepo

**Authoritative sources:**

- `docs/superpowers/specs/2026-07-16-world-tour-board-and-branch-design.md`
- Feishu workbook revision `41`: `普通地产`, `非普通地皮`, `机会卡`, `命运卡`
- `docs/superpowers/specs/2026-07-15-multi-map-modularization-design.md`
- `plan/03-架构与联机协议.md` §4

---

## Approved inputs

### Approved by owner

- The corrected 52-cell outer loop and eight-cell Bangkok branch are authoritative.
- Feishu revision 41 supplied 28 listed normal-property rows, four oceans, 23 chance cards (`C01–C23`), and 22 destiny cards (`D01–D22`). That workbook count is a source subset, not the final board total: the completed formal pack contains 38 normal properties, four oceans, two utilities, and 44 purchasable cells.
- On 2026-07-17 the owner explicitly approved the full chance and destiny decks as read back from that workbook.
- On 2026-07-17 the owner approved initial cash `15000`, pass-start salary `2000`, cash-goal presets `[30000, 50000]`, and `maxHouseLevel=4`.
- The owner approved using the existing action area for interactive card choices, the deterministic bot/offline policy below, and the presentation scope below.
- World Tour normal properties use five rent stages: empty, one house, two houses, three houses, hotel. `maxHouseLevel` is therefore `4`.
- Property group colors and all prices, mortgages, rents, building costs, subtitles, ocean values, and card wording come from the approved spec/workbook, never from inferred or placeholder data.

### Approved implementation policies

1. Game config: initial cash `15000`, pass-start salary `2000`, cash-goal presets `[30000, 50000]`; all other fields reuse China Tour except `maxHouseLevel=4`.
2. Under the reserved-file constraint, interactive card choices appear as ordinary buttons in the existing action area. D02 can produce a long vertically scrolling list of eligible properties. A modal or click-a-cell chooser would require changing reserved UI files and is out of scope.
3. Bot/offline policy: bots choose deterministic legal options (own property before unowned before opponent for D02; largest bus distance; decline paid flights; first eligible opponent for the duel). Offline takeover skips an airport-wait turn without consuming the pending entry, as required by the spec.
4. Presentation scope: use the current warm-paper theme tokens, approved property bands, built-in semantic icons, and code-drawn routes only; add no unapproved image asset or final artwork in this branch.

---

## Immutable board mapping

### Outer loop

| Route | ID | Cell | Type / settlement |
|---:|---:|---|---|
| 0 | 0 | 北京首都机场（起点） | start |
| 1 | 1 | 日本·东京 | normal property |
| 2 | 2 | 韩国·首尔 | normal property |
| 3 | 3 | 机会 | chance |
| 4 | 4 | 中国·北京 | normal property |
| 5 | 5 | 北冰洋 | ocean |
| 6 | 6 | 命运 | destiny |
| 7 | 7 | 俄罗斯·莫斯科 | normal property |
| 8 | 8 | 学习各种外语 | skip one personal turn |
| 9 | 9 | 越南·河内 | normal property |
| 10 | 48 | 泰国·曼谷 | normal property |
| 11 | 49 | 马来西亚·吉隆坡 | normal property |
| 12 | 11 | 新加坡·新加坡市 | normal property |
| 13 | 10 | 泰国曼谷机场 | next-turn branch airport; outer successor 12, branch entry 40 |
| 14 | 12 | 印度尼西亚·雅加达 | normal property |
| 15 | 13 | 机会 | chance |
| 16 | 14 | 印度·新德里 | normal property |
| 17 | 15 | 巴基斯坦·伊斯兰堡 | normal property |
| 18 | 16 | 无线上网 | pay bank 1000 |
| 19 | 17 | 土耳其·安卡拉 | normal property |
| 20 | 57 | 阿联酋·阿布扎比 | normal property |
| 21 | 18 | 伊拉克·巴格达 | normal property |
| 22 | 60 | 摩洛哥·拉巴特 | normal property |
| 23 | 19 | 埃及·开罗 | normal property |
| 24 | 50 | 苏伊士运河 | utility |
| 25 | 51 | 南非·比勒陀利亚 | normal property |
| 26 | 20 | 罗马文化节 | receive bank 1000 |
| 27 | 21 | 尼日利亚·阿布贾 | normal property |
| 28 | 22 | 命运 | destiny |
| 29 | 23 | 肯尼亚·内罗毕 | normal property |
| 30 | 24 | 印度洋 | ocean |
| 31 | 25 | 法国·巴黎 | normal property |
| 32 | 26 | 德国·柏林 | normal property |
| 33 | 27 | 机会 | chance |
| 34 | 28 | 意大利·罗马 | normal property |
| 35 | 52 | 西班牙·马德里 | normal property |
| 36 | 53 | 荷兰·阿姆斯特丹 | normal property |
| 37 | 54 | 瑞士·伯尔尼 | normal property |
| 38 | 55 | 瑞典·斯德哥尔摩 | normal property |
| 39 | 30 | 伦敦航班延误 | pay bank 1000 |
| 40 | 31 | 挪威·奥斯陆 | normal property and branch merge |
| 41 | 32 | 加拿大·温哥华 | normal property |
| 42 | 33 | 美国·华盛顿 | normal property |
| 43 | 34 | 命运 | destiny |
| 44 | 35 | 墨西哥·墨西哥城 | normal property |
| 45 | 56 | 巴拿马运河 | utility |
| 46 | 36 | 危地马拉·危地马拉城 | normal property |
| 47 | 37 | 大西洋 | ocean |
| 48 | 38 | 巴西·巴西利亚 | normal property |
| 49 | 58 | 阿根廷·布宜诺斯艾利斯 | normal property |
| 50 | 59 | 智利·圣地亚哥 | normal property |
| 51 | 39 | 秘鲁·利马 | normal property; successor 0 |

### Bangkok branch

| ID | Cell | Type / settlement | Successor |
|---:|---|---|---:|
| 40 | 太平洋 | station-style ocean | 41 |
| 41 | 班机延误 | skip one personal turn | 42 |
| 42 | 澳大利亚·堪培拉 | normal property | 43 |
| 43 | 机会 | chance | 44 |
| 44 | 新西兰·惠灵顿 | normal property | 45 |
| 45 | 命运 | destiny | 46 |
| 46 | 南极洲 | normal property | 47 |
| 47 | 得奖金 1000 元 | receive bank 1000 | 31 |

No gameplay code may identify the branch by hard-coded `40–47`. The airport module payload declares its entry, merge, and member cells, and World Tour validation proves that payload matches the board graph.

---

## Card implementation classification

Feishu workbook revision 41 was rechecked with the product owner: C14 is a player-to-player transfer only and must not be classified as a bank payment/reward.

### Reuse `core@1` effects unchanged

- Bank payment/reward: C01, C04–C08, C10, C12–C13, C15, D01, D04–D05, D07–D08, D10, D14, D17, D19.
- Player-to-player queued payments: C03, C14, C17, D13, D15.
- Repairs: C09, D11. Hotel detection must use `config.maxHouseLevel`.
- Pause: C16, D12.
- Forward movement: C11, C18, D06, D09, D16.
- Move to named cell: C19, D03, D18, D20.
- Draw another deck: C20.

### `world-tour@1` module effects/intents

- C02: one non-stacking toll immunity; consume only on the next positive ordinary-property/ocean toll.
- C21: roll two dice, then require selection of die A, die B, or their sum; no extra turn and no double-dice bonus.
- C22: optionally pay 3500 and choose an eligible outer property/ocean 1–6 forward steps away; direct transfer, no salary.
- C23: optionally pay 8000 and choose any outer property/ocean; direct transfer, no salary.
- D02: require one free upgrade on any eligible normal property, regardless of owner; ownership stays unchanged and three houses may become a hotel.
- D21: require one opponent, roll one die each until non-tie, and queue a 1200 payment from loser to winner.
- D22: automatically give 2000 to the lowest-cash non-bankrupt player; ties resolve from the drawer in turn order.

Every decision is represented by authoritative pending module actions. A replayed, stale, forged, wrong-player, or wrong-phase option must be rejected without changing state or RNG.

---

## Reserved files and permitted adapter strategy

The following files must remain byte-for-byte unchanged:

- `apps/client/src/components/BoardCell.vue`
- `apps/client/src/components/GameBoard.vue`
- `apps/client/src/components/FocusedBoard.vue`
- `apps/client/src/views/GameView.vue`
- `apps/client/src/components/ActionPanel.vue`
- `apps/client/src/style.css`
- every file under `apps/client/src/session/`

Permitted client work is limited to pure adapters under `apps/client/src/game/` and new tests. The existing `ActionPanel` already renders arbitrary `ClientAction[]`, so module choices can be surfaced without changing the reserved view/component/session files. The adapter will translate World Tour level 4 hotels to the existing asset-row display convention while preserving authoritative level 4 in engine state.

If a required behavior cannot be delivered through these adapters, stop and report rather than modifying a reserved file.

2026-07-30 exception: the owner requested complete, unclipped board-cell names. `BoardCell.vue` may change only for that display fix; the other reserved files and all session files remain protected.

---

## Task 1: Lock approved source data with failing board-data tests

**Files:**

- Create: `packages/board-data/src/__tests__/worldTourMap.test.ts`
- Modify: `packages/board-data/src/__tests__/mapValidation.test.ts`
- Test only at this task; do not create the formal map JSON before the owner gate is approved.

- [x] Add fixtures/assertions for the exact 52-cell outer loop and eight-cell branch table above.
- [x] Assert Bangkok `nextId=12`, branch entry `40`, branch `47→31`, and `39→0`.
- [x] Assert 38 normal-property rows, four ocean rows, and two utility rows match the approved final data.
- [x] Assert all 44 purchasable cells satisfy `price === mortgage × 2`.
- [x] Assert five rents per normal property, four rents per ocean, and `maxHouseLevel=4`.
- [x] Assert all 23/22 card IDs, exact texts, effect envelopes, target cells, and amounts.
- [x] Add invalid cases for missing `core@1`, missing `world-tour@1`, malformed airport payload, wrong branch membership, wrong merge, invalid choice payload, and stale content hash.

**Verify:**

- Run `pnpm exec vitest run packages/board-data/src/__tests__/worldTourMap.test.ts packages/board-data/src/__tests__/mapValidation.test.ts`.
- Expected before implementation: new tests fail for missing World Tour data/module support.

## Task 2: Add the immutable World Tour map pack

**Files:**

- Create: `packages/board-data/maps/world-tour/v1/board.json`
- Create: `packages/board-data/maps/world-tour/v1/cards.json`
- Create: `packages/board-data/maps/world-tour/v1/game-config.json`
- Create: `packages/board-data/maps/world-tour/v1/manifest.json`
- Create: `packages/board-data/src/worldTourMap.ts`
- Modify: `packages/board-data/src/index.ts`
- Modify: `packages/board-data/src/mapTypes.ts`
- Modify: `packages/board-data/src/mapValidation.ts`

- [x] Encode the corrected outer/branch graph with sparse stable IDs; `id=29` is retired.
- [x] Represent Bangkok as a `world-tour@1` module cell with immutable entry/member/merge data.
- [x] Encode only approved cards and config; no placeholder or synthetic release data.
- [x] Add presentation for all 60 cells on a 100×100 canvas: 52-cell square outer loop with fourteen cells per side, visible eight-cell diagonal branch, property bands, warm-paper theme, built-in icons, and code-drawn routes.
- [x] Add presentation terminology for oceans (`海洋`, ownership unit `片`) without changing China Tour station terminology.
- [x] Compute the canonical hash only after board/cards/config/manifest are final; write the exact lowercase SHA-256 into `manifest.json`.
- [x] Deep-freeze `worldTourMap` exactly like `chinaTourMap`.

**Verify:** focused World Tour and generic map-validation tests pass.

## Task 3: Add public deterministic rule-module runtime state

**Files:**

- Modify: `packages/engine/src/types.ts`
- Modify: `packages/engine/src/engine.ts`
- Modify: `packages/engine/src/hydrate.ts`
- Modify: `packages/engine/src/moduleRegistry.ts`
- Create: `packages/engine/src/worldTourModule.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/src/__tests__/moduleRegistry.test.ts`
- Test: `packages/engine/src/__tests__/hydrate.test.ts`
- Create: `packages/engine/src/__tests__/worldTourModule.test.ts`

- [x] Add an exact JSON-safe public rule-state field initialized empty by `createGame`.
- [x] Add typed pending module actions containing module ref, player, required phase, label, action, payload, and deterministic option identity.
- [x] Hydrate rejects unknown module keys, non-JSON payloads, wrong players/phases, inconsistent airport position, stale branch membership, and invalid pending options.
- [x] Extend `RuleModuleRegistry` only with composable hooks actually needed here: positive-rent interception and post-transition state cleanup. Run hooks in stable module order.
- [x] Keep `core@1` handler ownership and all China Tour outcomes unchanged.
- [x] Register `world-tour@1` beside `core@1` in the default runtime registry.

**Verify:** module registry, hydrate, deterministic migration, and existing China Tour engine tests pass.

## Task 4: Implement Bangkok next-turn entry and one-die branch movement

**Files:**

- Modify: `packages/engine/src/worldTourModule.ts`
- Create: `packages/engine/src/turns.ts` only if the existing turn advance must be shared without importing `engine.ts` cyclically.
- Modify: `packages/engine/src/engine.ts` only to route through approved generic registry hooks/helpers.
- Modify: `packages/engine/src/bot.ts`
- Test: `packages/engine/src/__tests__/worldTourModule.test.ts`
- Test: `packages/engine/src/__tests__/bot.test.ts`
- Test: `packages/engine/src/__tests__/branch.test.ts`

- [x] Passing Bangkok does nothing; every exact landing source records one pending airport and ends that turn.
- [x] The waiting player sees the ordinary `掷骰子` action on the next actionable personal turn, backed by a module intent.
- [x] Entry atomically consumes pending state; Pacific is step 1.
- [x] Every movement turn beginning on a branch member uses one die; excess movement follows `47→31→32…`.
- [x] Paused and offline-skipped turns preserve pending entry. Bankruptcy clears it.
- [x] A completed exit returns to two dice on the next movement turn.
- [x] Bots use the same legal module intent; no route choice exists.
- [x] China Tour retains current-turn `awaiting_airport_roll` and `roll_airport_branch` behavior byte-for-byte in outcome tests.

**Verify:** deterministic tests cover all 18 engine criteria in spec §12.2 that concern branch, pause, bots, and China regression.

## Task 5: Implement World Tour card module effects

**Files:**

- Modify: `packages/engine/src/worldTourModule.ts`
- Modify: `packages/engine/src/effects.ts` only for generic hotel-level calculation and registry hook invocation; no China rule change.
- Modify: `packages/engine/src/payments.ts` only if a shared exported queue helper is required.
- Test: `packages/engine/src/__tests__/worldTourModule.test.ts`
- Test: `packages/engine/src/__tests__/cards.test.ts`
- Test: `packages/engine/src/__tests__/debt_bankruptcy.test.ts`

- [x] Implement C02/C21/C22/C23 and D02/D21/D22 exactly as classified above.
- [x] Use the existing queued-payment/debt/bankruptcy pipeline for all player payments.
- [x] Use the existing cash-goal check for every bank reward and winning duel/collection outcome.
- [x] Count a hotel with `level === config.maxHouseLevel` for repairs.
- [x] Ensure C02 does not stack and consumes only on a positive toll.
- [x] Ensure optional flight decline changes neither cash nor position; paid flight cannot collect salary.
- [x] Ensure D02 cannot change ownership and cannot target mortgaged/full-level/non-normal property.
- [x] Ensure every random result is derived from state RNG and is replay deterministic.

**Verify:** exact-card tests traverse all 45 cards and assert events, cash, debt, state, and landing continuation.

## Task 6: Project module intents through protocol and authoritative server

**Files:**

- Modify: `packages/protocol/src/index.ts`
- Modify: `apps/server/src/game/gameRuntime.ts`
- Modify: `apps/server/src/publicGameSnapshot.ts`
- Modify: `apps/server/src/rooms/roomManager.ts` only where generic module intent/takeover handling requires it.
- Test: `apps/server/src/__tests__/roomGame.test.ts`
- Test: `apps/server/src/__tests__/phase3MultiMap.test.ts`
- Test: `apps/server/src/__tests__/socketGame.test.ts`
- Test: `apps/server/src/__tests__/socketGameReconnect.test.ts`

- [x] Add the allowlisted public rule-state field explicitly to `PublicGameSnapshot`; do not spread internal `GameState`.
- [x] Validate module intent envelopes, exact keys, enabled module ref, JSON payload, size bounds, and pending-option match at the server boundary.
- [x] Never expose seed, deck order, full config/cards, or any non-public module state.
- [x] A real Socket.IO room proves airport wait, intervening player, entry, branch pause, reconnect, exit, duplicate/stale intent rejection, and privacy.
- [x] Offline takeover uses the World Tour safe fallback and cannot consume airport pending state.

**Verify:** focused server integration tests pass, including ack/reconnect/privacy assertions.

## Task 7: Add generic client adapters without touching reserved files

**Files:**

- Modify: `apps/client/src/game/clientGame.ts`
- Modify: `apps/client/src/game/mapResolver.ts`
- Test: `apps/client/src/game/clientGame.test.ts`
- Test: `apps/client/src/game/mapResolver.test.ts`
- Test: `apps/client/src/components/boardRendering.test.ts` only if no reserved production component changes are needed.

- [x] Map authoritative pending module actions to existing `ClientAction[]`; no client-side dice, movement, cash, or eligibility logic.
- [x] Keep the airport action label `掷骰子`; do not add a World Tour reminder/modal/toast.
- [x] Format allowlisted World Tour module events in readable Chinese instead of the generic module fallback.
- [x] Use presentation terminology so ocean details say `海洋` and `片`.
- [x] Use `config.maxHouseLevel` for detail/log labels. Adapt World Tour level 4 hotel into the existing asset-row display contract without changing `AssetPanel.vue`.
- [x] Preserve event-animation/final-snapshot pairing because no session file is modified.

**Verify:** client game/resolver/presenter/session regression suites pass; `git diff --exit-code` proves all reserved files except the explicitly authorized `BoardCell.vue` display fix remain unchanged.

## Task 8: Activate the second map in registry and validation CLI

**Files:**

- Modify: `packages/board-data/src/registry.ts`
- Modify: `packages/board-data/src/validate.ts`
- Modify: `packages/board-data/src/__tests__/registry.test.ts`
- Modify: `packages/board-data/src/__tests__/validate.test.ts`
- Modify: `apps/client/src/game/gameSetup.test.ts`
- Modify: `apps/server/src/__tests__/phase3MultiMap.test.ts`

- [x] Add exact `worldTourMap.ref` to active catalog after its hash and module refs validate.
- [x] Register both packs; leave the permanent test map inactive and untouched.
- [x] Known production modules become `core@1` and `world-tour@1`.
- [x] `validate-data` checks both formal packs while China-specific source reconciliation still runs only for China Tour.
- [x] Catalog order remains China Tour first, World Tour second; the existing selector becomes visible automatically at length 2.
- [x] Exact hash resolution rejects stale World Tour refs with no fallback.

**Verify:** board-data validation, setup selector, and multi-map server tests pass.

## Task 9: Focused verification and first milestone commit

- [x] Run `pnpm validate-data`.
- [x] Run `pnpm exec vitest run packages/board-data packages/engine apps/server/src/__tests__/phase3MultiMap.test.ts apps/server/src/__tests__/socketGame.test.ts apps/server/src/__tests__/socketGameReconnect.test.ts apps/client/src/game`.
- [x] Run `pnpm typecheck`.
- [x] Inspect `git diff --check` and the reserved-file diff guard.
- [x] Commit map/data/runtime slice with an English message after all focused checks pass.

## Task 10: Full verification, simulations, and real-browser acceptance

- [x] Run `pnpm test`; record actual file/test counts.
- [x] Run `pnpm typecheck`.
- [x] Run `pnpm validate-data`; record both map/deck counts.
- [x] Run `pnpm build`.
- [x] Run the repository's 500-game simulation for China Tour and an equivalent deterministic 500-game World Tour simulation; record terminal games, illegal intents, conservation violations, exceptions, and failures.
- [x] Run production smoke if production runtime files changed.
- [x] Start the real client/server and verify the selector lists exactly China Tour and World Tour.
- [x] At 1440×900, 390×844, and 320×700, verify the outer route and Bangkok branch are readable and no horizontal overflow/unreachable focused cell exists.
- [x] Play one real local/browser opening on each formal map, including a purchase and at least one card draw.
- [x] Play a real Socket.IO World Tour branch sequence: Bangkok wait → intervening player → one-die entry → pause/reconnect → exit through Norway.
- [x] Confirm one-die/two-dice events and public snapshot privacy in the actual runtime.
- [x] Save screenshots/evidence only in approved plan assets if required; the only reserved visual-file exception is the authorized `BoardCell.vue` name-display fix.
- [x] Commit verification/docs evidence with a separate English message.

## Task 11: Historical completion audit and current handoff

- [x] Compare every spec §12 acceptance item and every objective completion item to direct evidence.
- [x] Confirm `packages/board-data/maps/china-tour/v1/` and `packages/board-data/maps/__test__/test-map-v1/` have no diff.
- [x] Confirm every reserved client file except the authorized `BoardCell.vue` display fix, and all `apps/client/src/session/` files, have no diff.
- [x] At the original delivery gate, confirm the isolated branch was `world-tour-map`, no merge/push occurred there, and record the handoff evidence. The implementation and the 2026-07-30 correction are now present in the `main` workspace.
- [x] Hand off actual commands, counts, browser dimensions, screenshots, commit IDs, known limitations, and any unverified item for final review.

---

## Baseline evidence captured before implementation

- `pnpm install --frozen-lockfile`: passed.
- `pnpm build`: passed.
- Initial `pnpm test`: 62 files / 1078 tests passed, one Socket.IO disconnect timing assertion failed.
- Immediate isolated rerun `pnpm exec vitest run apps/server/src/__tests__/socketRooms.test.ts`: 1 file / 23 tests passed.
- No production code existed in the branch when this baseline was recorded; only the plan/08 start registration was modified.

## Delivery evidence captured after implementation

- Focused gate: 41 files / 668 tests passed; `pnpm typecheck`, `pnpm validate-data`, `git diff --check`, the reserved-file guard, and the China/test-map pack guard passed.
- Full gate: `pnpm test` passed 65 files / 1138 tests; `pnpm typecheck`, `pnpm validate-data`, and `pnpm build` passed.
- Data gate: China Tour has 61 cells and 15/15 cards; corrected World Tour has 60 cells (52 outer + 8 branch) and 23/22 cards. World Tour exposes 38 normal properties, four oceans, two utilities, and 44 purchasable cells.
- Deterministic simulation: China Tour 500/500 terminal, maximum 2565 intents; World Tour 500/500 terminal, maximum 5805 intents. Both reported zero illegal intents, cash-conservation violations, exceptions, and failed games.
- The World Tour simulation initially exposed two legitimate games longer than the old China-calibrated 3000-intent guard. Fixed seeds proved both eventually reached `last_standing`; a regression test now protects `sim-101`, and the finite simulation-only guard is 10000 intents. No gameplay rule changed.
- Production smoke: `pnpm exec tsx scripts/smoke-production.ts` returned `smoke ok`.
- Real Socket.IO integration: the World Tour room test covered Bangkok exact landing, intervening player, one-die entry onto the branch delay cell, pause state, duplicate/stale rejection, disconnect/reconnect, one-die branch travel, Norway merge/exit, and public-snapshot privacy.
- Real browser: the selector listed exactly China Tour and World Tour; both maps opened and rolled in local games. In World Tour the human player bought 北冰洋, and a bot drew and settled a chance card.
- Responsive browser checks: World Tour at 1440×900, 390×844, and 320×700 had no page-level horizontal overflow. The mobile global board showed the full outer route and all eight branch cells; focused view kept the current cell reachable. Primary game actions measured 44 px high.
- Browser console: no application errors were recorded on either formal map.
- Delivery commits: `ed0aa42`, `db5112e`, `de0cd7d`, `a420db7`, and `c82f398`, followed by the documentation-evidence commit.

## 2026-07-30 implementation deviation

- **Owner direction:** correct the World Tour outer loop to exactly 52 cells; old saves do not need compatibility.
- **Version exception:** the owner accepted the proposed direct correction on `world-tour@1`. The map content hash changes in place; existing saves resolve through the established incompatible-map message and cleanup path. This one-time exception does not change the default rule that future published map edits require a new version.
- **Topology correction:** retire Portugal / Lisbon (`id=29`), place Singapore before Bangkok Airport, preserve Bangkok's branch entry `40`, and change its pass-through outer successor to Indonesia (`12`).
- **Presentation correction:** four corners remain start / Bangkok Airport / Rome Festival / London delay, with fourteen visible cells on every side. `BoardCell.vue` is an authorized reserved-file exception solely for labels: standard desktop viewports at least 1100 px wide show complete data names at readable sizes and retain semantic icons without clipping; narrower tablet/desktop and mobile viewports 1099 px wide and below retain compact short labels for legibility.
- **Reason:** the 53-cell interim expansion could not divide evenly around a four-corner square board and produced a 15/14/13/15 visual imbalance.
