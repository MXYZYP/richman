# Pre-Merge Save Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the confirmed stale-delete and unsafe-hydration gaps before merging PR #1, while keeping Cloudflare HTTPS as the canonical durable-save origin and deferring LAN-HTTP persistence.

**Architecture:** Keep exact-token mutation guards in the existing save store. Make the delete confirmation UI retain the first observed record, and strengthen the pure engine hydrator with only invariants produced by real engine states. Do not add a second storage backend, online storage, or deployment changes.

**Tech Stack:** TypeScript 5, Vue 3, Vitest, pnpm workspaces

---

### Task 1: Preserve the first delete observation

**Files:**
- Create: `apps/client/src/views/localDeleteConfirmation.ts`
- Test: `apps/client/src/views/localDeleteConfirmation.test.ts`
- Modify: `apps/client/src/views/HomeView.vue`

- [x] **Step 1: Write the failing state-machine tests**

Cover valid and invalid cards. After arming revision 1, pass a refreshed revision 2 card with the same game/slot key and require the emitted deletion observation to remain revision 1's `recordToken`.

```ts
const armed = requestLocalDelete(null, revision1Card);
const confirmed = requestLocalDelete(armed.confirmation, revision2Card);
expect(confirmed.observed).toEqual({ slot: 1, recordToken: 'revision-1-raw' });
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm exec vitest run apps/client/src/views/localDeleteConfirmation.test.ts`

Expected: FAIL because the confirmation state machine does not exist.

- [x] **Step 3: Implement the minimal confirmation state machine**

Represent armed confirmation as `{ key, observed }`. The first request stores the exact observed record; a second request for the same key returns that stored observation and clears confirmation. Cards without a readable token remain non-deletable.

- [x] **Step 4: Wire HomeView to the state machine**

Replace the string-only `confirmingLocalDelete` ref with the typed confirmation. Keep the existing labels and cancel behavior; emit only the observation returned by the state machine.

- [x] **Step 5: Run focused UI/save tests and verify GREEN**

Run: `pnpm exec vitest run apps/client/src/views/localDeleteConfirmation.test.ts apps/client/src/views/localResumeUi.test.ts apps/client/src/session/localGameSave.test.ts`

Expected: all selected tests pass.

### Task 2: Reject invalid persisted RNG and unreachable states

**Files:**
- Modify: `packages/engine/src/hydrate.ts`
- Test: `packages/engine/src/__tests__/hydrate.test.ts`

- [x] **Step 1: Write failing hydration tests**

Reject 400-digit seeds, leading-zero seeds, `-0`, values outside signed 32-bit range, a bankrupt current player in `playing`, `awaiting_airport_roll` away from an airport, a bankrupt debt debtor, unresolved debt in `game_over`, and a bankrupt winner.

```ts
expect(hydrateGameState(corrupted((state) => { state.seed = '9'.repeat(400); }), chinaMap)).toMatchObject({ ok: false });
expect(hydrateGameState(corrupted((state) => { state.turnPhase = 'awaiting_airport_roll'; }), chinaMap)).toMatchObject({ ok: false });
```

- [x] **Step 2: Run hydrate tests and verify RED**

Run: `pnpm exec vitest run packages/engine/src/__tests__/hydrate.test.ts`

Expected: the new corruptions are incorrectly accepted.

- [x] **Step 3: Implement minimal domain checks**

Accept only `0` or a non-zero signed decimal without leading zeros whose numeric value is an integer from `-2147483648` through `2147483647`. After player/reference validation, require the approved cross-field invariants without constraining legitimate engine-generated terminal turn phases.

- [x] **Step 4: Run engine hydration and trace tests and verify GREEN**

Run: `pnpm exec vitest run packages/engine/src/__tests__/hydrate.test.ts packages/engine/src/__tests__/deterministicMigration.test.ts packages/engine/src/__tests__/simulation.test.ts`

Expected: all selected tests pass, including the existing 3,000-step real-engine hydration trace.

### Task 3: Complete merge gates

**Files:**
- Modify only if a gate exposes a directly related defect.

- [x] **Step 1: Run static and automated gates**

Run in order:

```bash
pnpm build
pnpm test
pnpm typecheck
pnpm validate-data
pnpm --filter @richman/engine simulate:500
pnpm exec tsx scripts/smoke-production.ts
git diff --check
```

Expected: 62+ test files pass; typecheck/data/build succeed; 500/500 simulations terminate with zero illegal intents, cash-conservation violations, exceptions, or failed games; smoke prints `smoke ok`.

- [ ] **Step 2: Verify real browser behavior** *(1440×900 与真实双标签 stale-delete 已验证；390×844 因浏览器工具未能应用 viewport，仍未复验。)*

At 1440×900 and 390×844, verify normal two-slot create/resume/delete. In two tabs, arm delete on revision 1, advance revision 2 in the other tab, confirm in the first tab, and require a visible conflict with revision 2 preserved.

- [x] **Step 3: Request independent final review**

Review `origin/main..HEAD` for Critical/High/Medium issues. Do not merge with unresolved Critical, High, or Medium findings.

- [ ] **Step 4: Commit, push, and verify the GitHub merge result**

Commit only the scoped fix and documentation, push `m3-client-online`, fetch `refs/pull/1/merge` into a clean temporary worktree, and repeat the complete static/automated gates on that exact merge commit.

- [ ] **Step 5: Merge PR #1 normally**

Use the repository's standard merge-commit method, then verify remote `main` contains the PR head and the merged tree matches the verified merge result.
