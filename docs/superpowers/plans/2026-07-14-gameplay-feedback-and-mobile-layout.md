# Gameplay Feedback and Mobile Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mobile purchase actions visible in the first viewport, separate transient online command errors from persistent room state, hold Chance/Destiny cards for six seconds, and show per-player cash changes in real time.

**Architecture:** `GamePresenter` remains the single display-transition owner: it delays `card_drawn`, compares paired snapshots, and emits identity-keyed cash notices. `GameSession` exposes cash and transient notices; `OnlineSession` classifies acknowledgement failures and owns transient-notice expiry, while `GameView` only renders those refs and provides a synchronous UI submission lock. Existing Vue components receive additive props/slots; engine rules, protocol payloads, board data, and board geometry remain unchanged.

**Tech Stack:** Vue 3 Composition API, TypeScript, Vitest, existing CSS/scoped SFC styles, real Chromium verification through the existing app.

**Approved design:** `docs/superpowers/specs/2026-07-14-gameplay-feedback-and-mobile-layout-design.md`

---

## File map

- Modify `apps/client/src/session/gameSession.ts`: shared `CashNotice` / `TransientNotice` types and additive session refs.
- Modify `apps/client/src/session/gamePresenter.ts`: six-second card dwell, FIFO-safe snapshot cash comparison, notice identity/lifecycle.
- Modify `apps/client/src/session/gamePresenter.test.ts`: presenter timing, queue, cash aggregation, reset/dispose regressions.
- Modify `apps/client/src/session/localSession.ts`: expose presenter cash notices and a stable null transient ref.
- Modify `apps/client/src/session/onlineSession.ts`: presenter notice synchronization, transient failure classification/expiry/ownership, reset/dispose cleanup.
- Modify `apps/client/src/session/onlineSession.test.ts`: exact error mapping, expiry/restart, ownership, persistent closure/recovery cases.
- Modify `apps/client/src/ui/format.ts`: pure cash amount and latest-transition announcement formatting.
- Create `apps/client/src/ui/cashFeedback.test.ts`: formatting/sign/a11y announcement contracts.
- Modify `apps/client/src/components/PlayerRail.vue`: fixed notice tracks, identity-keyed pills, one combined live region, four-player horizontal scroll.
- Modify `apps/client/src/components/ActionPanel.vue`: named turn-header slot and responsive report/purchase row.
- Modify `apps/client/src/views/GameView.vue`: request lock, persistent reason banner, transient toast, mobile toggle slot, notice props.

No dependency, engine, protocol, data, persistence-schema, or board-layout file changes.

---

### Task 1: Presenter card dwell and cash notices

**Files:**
- Modify: `apps/client/src/session/gameSession.ts`
- Modify: `apps/client/src/session/gamePresenter.ts`
- Modify: `apps/client/src/session/gamePresenter.test.ts`
- Modify: `apps/client/src/session/localSession.ts`

- [ ] **Step 1: Write failing presenter tests**

Add focused tests using the existing injected `wait` / `deferredWait` helpers:

```ts
it('holds a drawn card for 6000 ms while ordinary events use 120 ms', async () => {
  const waits: number[] = [];
  const presenter = createGamePresenter(createTestSnapshot(), async (ms) => { waits.push(ms); });
  await presenter.playEvents([cardDrawnEvent], nextSnapshot);
  expect(waits).toContain(6_000);
});

it('publishes aggregate cash deltas when the paired snapshot becomes visible', async () => {
  await presenter.playEvents(events, snapshotWithCash({ p1: -500, p2: 500 }));
  expect(presenter.cashNotices.value.map(({ playerId, delta }) => ({ playerId, delta }))).toEqual([
    { playerId: 'p1', delta: -500 },
    { playerId: 'p2', delta: 500 },
  ]);
});
```

Cover: ordinary 120 ms cadence, no notice for equal cash, several mutations net to one delta, matching by player id rather than order, same-player replacement with a new `transitionId`, standalone snapshot no notice, and reset/dispose clearing/cancelling stale playback.

- [ ] **Step 2: Run presenter tests and verify RED**

Run:

```bash
pnpm exec vitest run apps/client/src/session/gamePresenter.test.ts
```

Expected: new tests fail because `CARD_DWELL_MS` and `cashNotices` do not exist and `card_drawn` still waits 120 ms.

- [ ] **Step 3: Add shared notice contracts**

In `gameSession.ts` add:

```ts
export interface CashNotice {
  readonly generation: number;
  readonly transitionId: number;
  readonly playerId: string;
  readonly delta: number;
}

export interface TransientNotice {
  readonly id: number;
  readonly message: string;
}
```

Add required `cashNotices: Ref<CashNotice[]>` and `transientNotice: Ref<TransientNotice | null>` to `GameSession`. In the existing explicit `GameSession` fixture in `gamePresenter.test.ts`, add `cashNotices: ref([])` and `transientNotice: ref(null)` in the same RED/GREEN cycle so the required public contract is type-complete before the task finishes.

- [ ] **Step 4: Implement presenter timing and delta publication**

In `gamePresenter.ts`:

```ts
const DEFAULT_STEP_MS = 120;
const CARD_DWELL_MS = 6_000;
```

Expose `cashNotices`. Capture a monotonically increasing `transitionId` per queued `playEvents` call. Inside the generation-guarded batch `finally`, compare the currently displayed `state.value.players` to the incoming snapshot by id before assigning `state.value = snapshot`. Replace only notices for players changed in this transition and retain each other player's latest keyed notice. `reset` and `dispose` clear notices; reset also starts a fresh transition sequence. `card_drawn` calls `_wait(CARD_DWELL_MS)`.

- [ ] **Step 5: Wire the local session**

Return `cashNotices: presenter.cashNotices` and a local `ref<TransientNotice | null>(null)` from `createLocalSession`; do not change local error behavior.

- [ ] **Step 6: Run presenter tests and verify GREEN**

Run the same focused command. Expected: all `gamePresenter.test.ts` tests pass with no unhandled timers/promises.

---

### Task 2: Online transient feedback and persistent state

**Files:**
- Modify: `apps/client/src/session/onlineSession.ts`
- Modify: `apps/client/src/session/onlineSession.test.ts`

- [ ] **Step 1: Write failing online-session tests**

Add one exact mapping assertion for each intent rejection:

```ts
const expected = {
  OPERATION_IN_PROGRESS: '操作过快，请稍候重试',
  INSUFFICIENT_FUNDS: '现金不足',
  WRONG_PHASE: '当前阶段不能执行这个操作',
  NOT_YOUR_TURN: '还没轮到你行动',
  ILLEGAL_INTENT: '这个操作现在不可用',
};
```

Using fake timers and the existing fake socket/storage helpers, assert: expiry after 2,500 ms; repeated identical notice gets a new id and restarts expiry; a request clears the notice that existed when it began after success; an older request success cannot clear a newer duplicate notice; transient failures do not change `lastError`; takeover/absent-debtor remain persistent; `room:closed` and failed resume keep a specific `lastError` after state is cleared.

Add an online presenter queue test where a `card_drawn` transition is followed by a BOT transition before the first six-second wait releases; snapshots must become visible in FIFO order, and reset/dispose must invalidate queued playback.

- [ ] **Step 2: Run online tests and verify RED**

```bash
pnpm exec vitest run apps/client/src/session/onlineSession.test.ts
```

Expected: notice assertions fail because all acknowledgement failures currently call `fail()` and no transient notice ref exists.

- [ ] **Step 3: Implement transient-notice lifecycle**

In `onlineSession.ts`, create a readonly mapping for only the five gameplay rejection codes, plus:

```ts
const transientNotice = ref<TransientNotice | null>(null);
let transientNoticeId = 0;
let transientNoticeTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
```

`showTransientNotice(code)` increments the id, replaces the ref, clears/restarts the 2,500 ms timer, and only expires the matching id. `clearTransientNotice(id)` clears only when `transientNotice.value?.id === id`.

At `emitAck` entry capture the current notice id. Route only `operation === 'intent'` failures whose code is in the mapping to `showTransientNotice`; all transport, recovery, entry, lobby, room, and takeover failures continue through `fail()`. On success, clear only the notice captured when that request began. The local duplicate-in-flight early return must use the same classifier for intent operations.

- [ ] **Step 4: Synchronize presenter cash notices and cleanup**

Add a top-level `cashNotices` ref. In `ensurePresenter`, sync `presenter.cashNotices` alongside existing presenter refs. `resetSession` and `dispose` clear cash/transient refs and cancel the transient timer. Return both refs through `OnlineGameSession`.

Keep `onClosed` ordering: reset first, then assign the specific persistent reason and `connectionStatus = 'failed'`.

- [ ] **Step 5: Run online and presenter tests and verify GREEN**

```bash
pnpm exec vitest run apps/client/src/session/onlineSession.test.ts apps/client/src/session/gamePresenter.test.ts
```

Expected: all focused tests pass; fake timers leave no pending callbacks.

---

### Task 3: Pure cash-feedback formatting

**Files:**
- Modify: `apps/client/src/ui/format.ts`
- Create: `apps/client/src/ui/cashFeedback.test.ts`

- [ ] **Step 1: Write failing pure tests**

Import the existing `format.ts` module as a namespace and narrow the not-yet-present exports to optional functions, so RED is an assertion failure rather than a missing-module error:

```ts
import * as formatters from './format';

const cashFormatters = formatters as typeof formatters & {
  formatCashDelta?: (delta: number) => string;
  formatCashAnnouncement?: (
    players: Array<{ id: string; nickname: string }>,
    notices: CashNotice[],
  ) => string;
};
```

Assert `formatCashDelta?.(1000) === '+¥1,000'`, `formatCashDelta?.(-1000) === '−¥1,000'`, and a same-transition two-player announcement `玩家一减少 ¥500；玩家二增加 ¥500`. Add an adjacent-transition case with retained `[p1@t1, p2@t2]` notices and assert the second announcement contains only p2: the live region must never repeat p1’s older transition.

- [ ] **Step 2: Run and verify RED**

```bash
pnpm exec vitest run apps/client/src/ui/cashFeedback.test.ts
```

Expected: assertion failures because the optional formatter exports are currently `undefined`.

- [ ] **Step 3: Implement the pure helpers**

Add the exports to existing `format.ts`. Use `formatMoney` and explicit Chinese verbs/signs; ignore notices whose player id is absent from the supplied player list. For announcements, first select the maximum `generation`, then the maximum `transitionId` within that generation, and announce only notices from that transition in deterministic notice order.

- [ ] **Step 4: Run and verify GREEN**

Run the same command. Expected: all formatting tests pass.

---

### Task 4: Mobile action layout, request lock, toast, and player notices

**Files:**
- Modify: `apps/client/src/components/ActionPanel.vue`
- Modify: `apps/client/src/components/PlayerRail.vue`
- Modify: `apps/client/src/views/GameView.vue`

- [ ] **Step 1: Record deterministic real-browser RED evidence**

Create a temporary `apps/client/src/qa/gameplayFeedbackHarness.ts` that is never imported by the production entry and is deleted after final browser QA. The module imports `createApp`, `h`, and `ref` from `vue`, the actual `GameView`, `createLocalSession`, and `GameSession`; Vite transforms those bare imports because the browser loads the source module through `/src/qa/gameplayFeedbackHarness.ts`. Export `mountThreePurchase(mode)` which owns its three-human roster, clears a dedicated QA root, creates `createLocalSession({ players: THREE_HUMANS, seed: '1', wait: async () => undefined })`, sends one `roll_dice`, then mounts `h(GameView, { session })`. Seed `1` starts p3 and rolls `[2, 3]` onto purchasable cell 5. For `mode === 'online'`, pass a structurally complete `{ ...localSession, mode: 'online', localPlayerId: ref(currentActorId), connectionStatus: ref('connected') } satisfies GameSession`; all other required refs/methods come from the spread local session. Also export `mountFourPlayers()` and return the live `session` handle for notice injection.

From Chromium, run `const qa = await import('/src/qa/gameplayFeedbackHarness.ts'); window.__qa = await qa.mountThreePurchase('local')` and inspect 390 × 844. Record that the standalone “棋盘视图” row consumes vertical space and whether the full “买地/放弃” row is outside the first viewport. Then run `window.__qa = await qa.mountThreePurchase('online')` for the deterministic online-equivalent layout and `window.__qa = await qa.mountFourPlayers()` to record current four-player cash truncation. This temporary source module is QA scaffolding, not a production route or public API.

- [ ] **Step 2: Move the board toggle into the turn card**

In `ActionPanel`, wrap the existing turn text in `.turn-copy-text` and add `<slot name="turn-action" />` as the second header child. In `GameView`, remove `.mobile-board-header` and pass the existing toggle button through `#turn-action`. Keep `.mobile-board-toggle { display: none; }` by default and show it only under 767 px, ensuring zero desktop footprint.

- [ ] **Step 3: Build the responsive report/offer row**

Wrap `.event-ribbon` and optional `.purchase-offer` in `.feedback-row`. Desktop uses `display: contents` to preserve existing stacking. Add `container-type: inline-size` to `.action-panel`. Under 767 px, use `grid-template-columns: repeat(2, minmax(0, 1fr))`; add `@container (max-width: 339px)` to stack `.feedback-row` to one column based on panel width, not viewport width. Remove the 280 px offer cap only inside this mobile row. Browser verification must narrow the panel itself below 340 px and observe the stack.

- [ ] **Step 4: Add request lock and feedback banners**

In `GameView`, add `isSubmittingIntent`. Make `handleAction` async, set the lock synchronously before awaiting `session.sendIntent`, and release it in `finally`. Include it in the `isBusy` value passed to both `ActionPanel` and `AssetPanel`.

Render `session.transientNotice.value` above `<main>` with its id as `key`, `role="status"`, and polite live semantics. Keep it after the persistent connection banner; add safe-area top padding when no banner exists. For failed connection state, show `lastError ?? interaction.message` in `connectionBanner`; pass `null` to the action-panel error ribbon while a connection banner is active so the persistent reason is not duplicated.

- [ ] **Step 5: Render fixed per-player cash tracks**

Pass `cashNotices` from `GameView` to `PlayerRail`. Change each rail child to a `.player-slot` containing the existing asset button and an always-present fixed-height `.cash-notice-track`. Match by player id; key the pill by `generation-transitionId-playerId`; use `formatCashDelta` and profit/loss classes. Give each pill a keyed 2.4-second CSS animation that ends at opacity 0 with `forwards`; replacing a same-player key restarts the animation, and no presenter/UI expiry timer may remove a newer pill.

Keep pills backed by each player’s latest retained notice, but compute the visually hidden polite live-region text with `formatCashAnnouncement`, which announces only notices from the maximum generation/transition id. Thus a later p2-only transition never repeats an older retained p1 notice.

On mobile, three slots retain equal one-row widths. Apply a four-player class when `players.length === 4`; those slots use a readable minimum width and horizontal scrolling instead of shrinking to approximately 97 px.

- [ ] **Step 6: Run focused build/type validation**

```bash
pnpm exec vitest run apps/client/src/ui/cashFeedback.test.ts apps/client/src/session/gamePresenter.test.ts apps/client/src/session/onlineSession.test.ts
pnpm typecheck
pnpm --filter @richman/client build
```

Expected: all commands exit 0 with no TypeScript/Vue template errors.

---

### Task 5: End-to-end verification and review

**Files:**
- Temporary QA-only `apps/client/src/qa/gameplayFeedbackHarness.ts`; delete after browser verification. No planned delivered production changes; fix only issues demonstrated by verification/review.

- [ ] **Step 1: Run the full repository checks**

```bash
pnpm test
pnpm typecheck
pnpm validate-data
pnpm build
```

Record exact test-file/test counts and build results.

- [ ] **Step 2: Verify real browser behavior**

At 390 × 844 and desktop 1440 × 900 verify: three-player local purchase buttons in first viewport; online equivalent; sub-340 action-panel stacking; four-player horizontal rail; desktop board/side-panel geometry; six-second Chance and Destiny visibility; signed cash pills and updated totals; persistent room/recovery errors; transient toast; immediate main/asset button lock and release.

For the 2.4-second cash lifecycle, inject fixed notice `generation 1 / transition 1 / p1`, wait about one second, then replace it with `generation 1 / transition 2 / p1`. Confirm the DOM key/text changes and `getAnimations()[0].currentTime` restarts near zero rather than inheriting the old elapsed time. Confirm the replacement animation has duration 2400 ms and `fill: forwards`, remains unfinished just before 2.4 seconds, and finishes with computed opacity 0 just after 2.4 seconds. Then inject `p2@transition3` while p1’s retained notice remains and confirm the polite live region announces only p2.

- [ ] **Step 3: Remove QA scaffolding and revalidate**

Delete `apps/client/src/qa/gameplayFeedbackHarness.ts`, verify no production entry imported it, then rerun:

```bash
pnpm typecheck
pnpm --filter @richman/client build
```

- [ ] **Step 4: Run independent code and visual review**

Request an architecture/quality reviewer for session/presenter races, timer cleanup, public contract completeness, and regression risk. Request a designer review for mobile first viewport, four-player rail, toast/banner layering, cash pill legibility, desktop regression, and accessibility. Fix all Critical/Important findings and rerun affected checks.

- [ ] **Step 5: Update implementation records**

Update `.slim/deepwork/gameplay-feedback-mobile-layout.md` with final changed files, exact verification evidence, reviewer verdicts, and any explicitly unverified scenario. Do not commit or publish; no commit was requested.
