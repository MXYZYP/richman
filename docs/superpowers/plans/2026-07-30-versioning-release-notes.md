# Versioning and Release Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a player-visible `2.4.0` version history, generated CHANGELOG, safe release command, and deploy-time version gate.

**Architecture:** `release-notes.json` is the only hand-edited release history. Pure Node helpers validate, bump, and render it; a CLI updates the manifest, root package version, and generated CHANGELOG. The client bundles the JSON directly and renders it through a native `<dialog>`. When deployable runtime paths change, CI compares the current catalog with the revision from the latest successful `main`-branch run of this deployment workflow, so failed deploy attempts remain in the comparison range until a deployment succeeds.

**Tech Stack:** TypeScript, Node.js standard library, pnpm, Vitest, Vue 3, Vite, native HTML dialog, GitHub Actions.

**Scope note:** Do not commit, push, tag, or publish unless the owner explicitly requests it.

---

### Task 1: Pure release catalog rules

**Files:**
- Create: `scripts/releaseNotes.ts`
- Create: `scripts/releaseNotes.test.ts`
- Modify: `vitest.config.ts`
- Modify: `scripts/tsconfig.json`

- [ ] **Step 1: Extend test discovery and scripts type coverage**

Add `scripts/**/*.test.ts` to `vitest.config.ts` and change `scripts/tsconfig.json` include to `['**/*.ts']`.

- [ ] **Step 2: Write failing pure-rule tests**

Cover these observable contracts:

```ts
expect(parseReleaseCatalog(validCatalog).releases[0]?.version).toBe('2.4.0');
expect(() => parseReleaseCatalog(duplicateVersions)).toThrow(/重复/);
expect(() => parseReleaseCatalog(outOfOrderVersions)).toThrow(/必须高于/);
expect(() => parseReleaseCatalog(emptyChanges)).toThrow(/更新内容/);
expect(bumpVersion('2.3.4', 'patch')).toBe('2.3.5');
expect(bumpVersion('2.3.4', 'minor')).toBe('2.4.0');
expect(renderChangelog(catalog)).toContain('## [2.4.0] - 2026-07-30');
expect(requiresVersionBump(['apps/client/src/App.vue'])).toBe(true);
expect(requiresVersionBump(['docs/spec.md', '.github/workflows/deploy-pages.yml'])).toBe(false);
expect(() => validateReleaseTransition(previous, currentSameVersion, ['packages/engine/src/index.ts'])).toThrow(/递增版本/);
```

- [ ] **Step 3: Run the targeted test and observe RED**

Run:

```bash
pnpm exec vitest run scripts/releaseNotes.test.ts
```

Expected: failure because `scripts/releaseNotes.ts` does not exist.

- [ ] **Step 4: Implement the pure module**

Export these exact contracts:

```ts
export type ReleaseBump = 'patch' | 'minor';
export interface ReleaseEntry {
  readonly version: string;
  readonly date: string;
  readonly title: string;
  readonly changes: readonly string[];
}
export interface ReleaseCatalog {
  readonly releases: readonly ReleaseEntry[];
}

export function parseReleaseCatalog(value: unknown): ReleaseCatalog;
export function bumpVersion(version: string, bump: ReleaseBump): string;
export function renderChangelog(catalog: ReleaseCatalog): string;
export function requiresVersionBump(paths: readonly string[]): boolean;
export function validateReleaseTransition(
  previous: ReleaseCatalog | null,
  current: ReleaseCatalog,
  changedPaths: readonly string[],
): void;
```

Validation rules: plain objects only; strict `major.minor.patch`; real `YYYY-MM-DD`; non-empty trimmed title/changes; unique versions; descending version order. Use a fail-safe path policy: `docs/**`, `plan/**`, screenshots within those trees, `.github/**`, `scripts/**`, agent metadata, and Markdown files do not independently force a player version; every other existing or future path does.

- [ ] **Step 5: Run the targeted test and observe GREEN**

Run the same Vitest command. Expected: all release-rule tests pass.

### Task 2: Filesystem release command and consistency checker

**Files:**
- Create: `scripts/release.ts`
- Create: `scripts/release.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing command tests using a temporary directory**

Test that:

```ts
await createRelease({
  rootDir,
  bump: 'patch',
  title: '体验优化',
  changes: ['修复手机布局。'],
  date: '2026-07-31',
});
```

updates all three files to `2.4.1`; invalid input leaves their original bytes unchanged; `checkReleaseFiles(rootDir)` rejects a hand-edited CHANGELOG or mismatched package version.

- [ ] **Step 2: Run RED**

```bash
pnpm exec vitest run scripts/release.test.ts
```

Expected: module missing.

- [ ] **Step 3: Implement release filesystem operations**

Export:

```ts
export interface CreateReleaseOptions {
  readonly rootDir: string;
  readonly bump: ReleaseBump;
  readonly title: string;
  readonly changes: readonly string[];
  readonly date?: string;
}
export async function createRelease(options: CreateReleaseOptions): Promise<string>;
export async function checkReleaseFiles(rootDir: string): Promise<ReleaseCatalog>;
```

The CLI syntax is:

```bash
pnpm release --title "体验优化" --change "修复手机布局。" --change "改善提示文案。"
pnpm release minor --title "新玩法" --change "新增正式地图。"
pnpm release:check
```

Compute and validate all output in memory before writing. Write temporary sibling files and rename them into place. CLI failures print a concise Chinese reason and set a non-zero exit code.

`release:check` additionally reads `RELEASE_PREVIOUS_SHA` when present. Accept only a 40-character hexadecimal SHA; treat forty zeroes as “no previous revision”. For a real SHA, use `git diff --name-only <sha> HEAD` and `git show <sha>:release-notes.json`. A missing historical manifest is the one-time bootstrap case; all later runtime changes require the version to increase.

Add root scripts:

```json
{
  "release": "tsx scripts/release.ts create",
  "release:check": "tsx scripts/release.ts check"
}
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
pnpm exec vitest run scripts/release.test.ts scripts/releaseNotes.test.ts
pnpm release:check
```

The first command passes. The second is expected to fail until Task 3 creates the catalog.

### Task 3: Backfill verified player releases

**Files:**
- Create: `release-notes.json`
- Create: `CHANGELOG.md` through the generator
- Modify: `package.json`

- [ ] **Step 1: Create the six-entry catalog**

Newest-first entries:

- `2.4.0`, 2026-07-30, version history and CHANGELOG;
- `2.3.0`, 2026-07-30, World Tour expansion, detailed cell rules, retained map selection, BOT renaming;
- `2.2.0`, 2026-07-27, World Tour second map and its dedicated mechanics;
- `2.1.0`, 2026-07-16, two local save slots, safe recovery, multi-map foundation;
- `2.0.0`, 2026-07-13, room-code online play, lobby/invites, reconnect and host takeover;
- `1.0.0`, 2026-07-09, complete local hot-seat game, BOT players, desktop/mobile layouts and settlement.

Each entry must contain 2-5 short player-facing Chinese changes and no internal file/function names.

- [ ] **Step 2: Set root product version and generate CHANGELOG**

Set only the root `package.json` version to `2.4.0`; private workspace package versions remain internal. Generate `CHANGELOG.md` from the catalog rather than hand-writing it.

- [ ] **Step 3: Verify consistency**

```bash
pnpm release:check
```

Expected: success with current version `2.4.0`.

### Task 4: Client release-notes dialog

**Files:**
- Create: `apps/client/src/components/ReleaseNotesDialog.vue`
- Create: `apps/client/src/components/ReleaseNotesDialog.test.ts`

- [ ] **Step 1: Write the failing SSR component test**

Render the component and assert that the native dialog contains the current version, all six releases newest-first, every player-facing change, the labelled heading, and an explicit close control.

- [ ] **Step 2: Run RED**

```bash
pnpm exec vitest run apps/client/src/components/ReleaseNotesDialog.test.ts
```

- [ ] **Step 3: Import the checked catalog**

Import the root `release-notes.json` directly. Root builds and the deploy workflow run `release:check` before Vite, so malformed catalogs fail before bundling; no runtime fetch or “unknown version” fallback is permitted.

- [ ] **Step 4: Implement the native dialog**

The component always renders:

- a low-emphasis `v{version} · 更新说明` trigger and its native `<dialog>`;
- the current release highlighted first;
- older releases newest-first in one vertically scrollable timeline;
- an explicit close button, native Escape handling, backdrop click close, and native focus restoration.

Use existing theme variables (`--color-border`, `--color-primary`, `--color-muted`, `--board-surface`) and no new dependency, image, or web font.

- [ ] **Step 5: Run GREEN**

Run the targeted component test.

### Task 5: Home integration and build guard

**Files:**
- Modify: `apps/client/src/views/HomeView.vue`
- Create: `apps/client/src/views/HomeView.test.ts`
- Modify: `apps/client/src/App.vue`
- Modify: `package.json`

- [ ] **Step 1: Extend the existing HomeView SSR test**

Assert that the home page includes exactly one `v2.4.0 · 更新说明` trigger without changing existing create/join/local flows.

- [ ] **Step 2: Run the HomeView test and observe RED**

```bash
pnpm exec vitest run apps/client/src/views/HomeView.test.ts
```

- [ ] **Step 3: Integrate the component**

Render the low-emphasis trigger in `HomeView.vue`, emit one open intent, and keep the persistent `ReleaseNotesDialog` mounted in `App.vue` so opening it never changes game or session state.

- [ ] **Step 4: Make root production builds validate release data first**

Prepend `pnpm release:check` to the root `build` script. Keep the client package build self-contained (`vue-tsc` + Vite); CI runs the same release check explicitly before its direct client build.

- [ ] **Step 5: Run focused verification**

```bash
pnpm exec vitest run apps/client/src/components/ReleaseNotesDialog.test.ts apps/client/src/views/HomeView.test.ts
pnpm --filter @richman/client build
```

Expected: tests and production build pass; built client contains `2.4.0`.

### Task 6: Deployment version gate

**Files:**
- Modify: `.github/workflows/deploy-pages.yml`
- Test: `scripts/releaseNotes.test.ts`

- [ ] **Step 1: Add path-policy transition cases**

Lock these behaviors:

- runtime source changed + same version => fail;
- runtime source changed + higher version => pass;
- docs/workflow-only changed + same version => pass;
- first catalog introduction with no previous catalog => pass;
- lower or malformed current catalog => fail before path comparison.

- [ ] **Step 2: Fetch history and add the CI check before build**

Change checkout so the previous successful production deployment revision is available:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0

- name: Resolve last successful deployment revision
  id: release-revision
  # Query the latest successful main-branch run of this workflow; failed deploy attempts must remain inside the next comparison range.

- name: Validate release metadata
  run: pnpm release:check
  env:
    RELEASE_PREVIOUS_SHA: ${{ steps.release-revision.outputs.sha }}
```

Do not add write permissions, tags, commits, Releases, or deployment-side version mutation.

- [ ] **Step 3: Run release tooling tests and YAML inspection**

```bash
pnpm exec vitest run scripts/releaseNotes.test.ts scripts/release.test.ts
pnpm release:check
```

### Task 7: End-to-end verification

**Files:**
- No production file changes unless a verified defect is found.

- [ ] **Step 1: Run full automated verification**

```bash
pnpm test
pnpm typecheck
pnpm validate-data
pnpm --filter @richman/client build
```

Record exact file/test counts and command outcomes.

- [ ] **Step 2: Run desktop browser smoke**

Start the production-equivalent app, open the homepage, click `v2.4.0 · 更新说明`, verify all six versions appear newest-first, close with Escape, and confirm focus returns to the trigger.

- [ ] **Step 3: Run 390×844 browser smoke**

Verify no horizontal overflow, readable text, internal vertical scrolling, and a touch-accessible close button. Capture screenshots only as verification artifacts; do not add them to the repository unless requested.

- [ ] **Step 4: Confirm built-version consistency**

Verify the browser shows `2.4.0`, root package version is `2.4.0`, and `pnpm release:check` passes against the checked-in catalog and CHANGELOG.
