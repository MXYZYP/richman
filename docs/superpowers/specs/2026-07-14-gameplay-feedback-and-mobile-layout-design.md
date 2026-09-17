# Gameplay Feedback and Mobile Layout Design

Date: 2026-07-14
Status: Approved for implementation
Scope: Local hot-seat and online game views, except where explicitly marked online-only

## 1. Goals

Fix four user-visible problems without changing engine rules, board data, room protocol, or the desktop board geometry:

1. Keep mobile purchase/build decisions reachable within a 390 × 844 viewport without scrolling past the action buttons.
2. Prevent online transient command failures from permanently replacing the battle report.
3. Hold Chance/Destiny card results long enough to read.
4. Show each player’s cash change at the player card where it happened.

## 2. Mobile action layout

### Current problem

The mobile board-mode header consumes a full row above the board. During a purchase decision, the action panel then stacks the dice, battle report, property offer, and action buttons vertically. The purchase buttons fall below the initial viewport.

### Design

- Remove the standalone mobile row containing “棋盘视图”.
- Place the existing mobile board-mode toggle in the right side of the “当前回合” card.
- Keep the button labels “查看全局棋盘” and “回到当前位置”.
- Keep the toggle hidden on desktop.
- Keep the dice visible during purchase/build decisions.
- Put the battle report and purchase offer in one responsive row when an offer exists:
  - battle report on the left;
  - property name and price on the right;
  - both columns use `minmax(0, 1fr)` so long text cannot widen the panel;
  - below 340 px of available panel width, stack the offer below the full-width report rather than forcing unreadably narrow columns.
- Let the battle report occupy the full row when there is no purchase offer.
- Preserve the existing board order, focused/global board behavior, and action order.
- The turn-header action slot and toggle collapse to zero footprint on desktop; the desktop turn card keeps its current layout.

### Acceptance

At 390 × 844, with three players and a pending property purchase, the full “买地” and “放弃” buttons are visible without vertical scrolling. At narrower panel widths, report and offer text remain readable through the explicit stacking fallback. The desktop layout remains unchanged except for shared internal markup needed by the mobile arrangement.

## 3. Online transient command feedback

### Current problem

`lastError` currently carries both temporary command failures and persistent room state. A fast duplicate intent can set “请求正在处理中”; an engine rejection can set a rule failure. These values replace the battle report and may remain indefinitely. Persistent states such as “需要某玩家回来处理债务” must not be auto-dismissed.

### Design

Use two explicit feedback channels:

- Persistent status: keep using `lastError`. In-game takeover and absent-debtor states stay in the existing action-panel error ribbon. Room closure, failed recovery, and other states that can clear `state` render through a persistent banner outside the `v-if="state"` game shell, using the specific `lastError` reason instead of replacing it with a generic disconnected message.
- Transient action notice: add a separate session value rendered as a top toast.

Online intent failures routed to the transient notice:

- `OPERATION_IN_PROGRESS` → “操作过快，请稍候重试”
- `INSUFFICIENT_FUNDS` → “现金不足”
- `WRONG_PHASE` → “当前阶段不能执行这个操作”
- `NOT_YOUR_TURN` → “还没轮到你行动”
- `ILLEGAL_INTENT` → “这个操作现在不可用”

Connection, recovery, room-closure, takeover, and absent-debtor states remain persistent. In particular, “需要某玩家回来处理债务” and “房主托管正在执行” must never be converted into auto-dismissed notices.

The toast:

- appears above the game content, below any connection/persistent banner;
- honors `env(safe-area-inset-top)` when no banner precedes it;
- uses `role="status"` / polite announcement semantics;
- does not block the board or require confirmation;
- disappears after 2.5 seconds;
- receives a monotonically increasing notice identity so the same message can restart its lifetime;
- is cleared by the request that owned it when that request later succeeds, but a success never clears a newer notice emitted by a later request.

`GameView` also applies a synchronous, view-local submission lock around `sendIntent`. Main action buttons and asset action buttons become disabled until the request settles. The lock releases in `finally` on success, rejection, and early return. The server/session single-flight guard remains the final defense for races or non-UI callers.

## 4. Chance and Destiny dwell time

### Current problem

All presenter events use the same 120 ms step. A card draw is followed quickly by its effect and the next turn, so the card preview flashes too briefly to understand.

### Design

- Add a dedicated card dwell duration of 6,000 ms.
- When a `card_drawn` event is played:
  - show the full card preview;
  - show the matching battle-report message;
  - pause client presenter playback for 6 seconds.
- After 6 seconds, continue the remaining queued events in order.
- Local play also pauses rule/BOT progression because `LocalSession` awaits presenter playback.
- Online rooms remain server-authoritative: the server and online BOT automation may continue during the client dwell. Event/snapshot pairs received meanwhile stay in the existing FIFO presenter queue and drain in order after the card dwell; the UI does not expose actions from a newer snapshot before its queued playback reaches it.
- Keep the existing generation/disposal cancellation checks so restart, leave, reconnect reset, or disposal invalidates stale queued playback.
- Apply the same visible 6-second dwell to local humans, local BOTs, online humans, and online BOTs.
- Do not change the 120 ms movement/ordinary-event cadence.
- The agreed six-second dwell is fixed and has no skip control.

## 5. Per-player cash-change notices

### Current problem

Player cash totals update, but the player must compare old and new numbers mentally. Card effects and rent can affect more than one player, making the result hard to follow.

### Design

At the end of each real presenter transition, before replacing the displayed snapshot:

1. Match players by `playerId`, never by array position.
2. Compare each player’s cash in the currently displayed snapshot with the incoming authoritative snapshot.
3. Emit one aggregate delta per changed player.
4. Update the displayed cash totals and show the corresponding delta at the same time.

This snapshot-difference approach covers salary, rent, tax, purchases, houses, sales, mortgages, redemptions, cards, debt payments, and bankruptcy without maintaining a second list of money rules in the client.

Each notice has `{ generation, transitionId, playerId, delta }` identity:

- `generation` prevents a stale playback from publishing after reset/dispose;
- `transitionId` is monotonically increasing within a presenter generation;
- a newer notice for the same player replaces the older one and restarts its visual animation;
- reset, initial load, resume, standalone reconciliation, and dispose clear all visible notice state;
- the visual lifetime is implemented by a keyed 2.4-second animation, not an old timer that could clear a newer notice.

Presentation:

- profit: red pill with an explicit plus sign, for example `+¥1,000`;
- loss: green pill with an explicit minus sign, for example `−¥1,000`;
- duration: approximately 2.4 seconds;
- placement: a permanent fixed-height notice track directly below each player card;
- the track is always part of the rail layout and remains empty while idle, so appearance/disappearance causes no layout jump and cannot be clipped by the rail’s overflow container;
- multiple changed players display simultaneously;
- one transition containing several transfers shows the net change for that player;
- sign and amount remain understandable without relying on color alone.

For mobile four-player games, player slots keep a readable minimum width and the rail scrolls horizontally instead of squeezing all four cards until totals and pills truncate. Three-player mobile games continue to fit in one row without scrolling.

`PlayerRail` includes one polite live region outside the per-card pills. A transition with multiple deltas produces one combined announcement such as “玩家一减少 ¥500；玩家二增加 ¥500”, avoiding overlapping screen-reader announcements.

The notice is produced only by paired event-plus-snapshot playback. `reset`, initial load, resume, and standalone reconciliation snapshots update totals without reporting historical cash as a new gain/loss.

The feature applies to mobile and desktop, local and online sessions.

## 6. Component and state boundaries

- `GamePresenter` owns card timing, computes cash deltas from display snapshot transitions, and assigns notice generation/transition identity.
- `GameSession` exposes presenter cash notices and a separate transient action notice.
- `OnlineSession` classifies intent acknowledgement failures into transient versus persistent feedback and preserves specific persistent failure reasons outside active state.
- `LocalSession` exposes no online transient notice but forwards the shared presenter cash notices.
- `GameView` owns the short UI submission lock, renders the top transient toast, and renders persistent failure reasons even when game state has been cleared.
- `ActionPanel` owns the compact turn header and report/offer row; a named turn-header action slot keeps board-mode state in `GameView`.
- `PlayerRail` renders fixed notice tracks, the matching cash-change pills, and one combined polite announcement.

No engine event, protocol payload, room state, board data, or persistence schema changes are required.

## 7. Tests

### Presenter tests

- `card_drawn` waits exactly 6,000 ms while ordinary events retain the existing step duration.
- Reset/dispose cancels stale card playback and clears visible cash notices.
- A paired transition reports positive, negative, and simultaneous two-player cash deltas by player id.
- Multiple cash mutations in one transition produce one net delta per player.
- Two transitions changing the same player before 2.4 seconds replace/restart the notice without an old expiry clearing the new one.
- Equal cash produces no notice.
- Reset/resume-style standalone snapshots produce no notice.
- An online card-to-BOT sequence keeps every event/snapshot pair in FIFO order, drains after the dwell, and is safely discarded by reset/dispose.

### Online session tests

- A duplicate in-flight intent produces the transient “操作过快，请稍候重试” notice rather than persistent `lastError`.
- Each gameplay rejection maps exactly: `INSUFFICIENT_FUNDS`, `WRONG_PHASE`, `NOT_YOUR_TURN`, and `ILLEGAL_INTENT`.
- A successful request clears only the notice it owns and never clears a newer notice.
- The notice expires after 2.5 seconds and repeated identical notices restart the timer.
- Takeover and absent-debtor messages remain persistent.
- `room:closed` and failed-resume reasons remain visible after active game state is cleared and do not auto-dismiss.

### UI and browser verification

- 390 × 844 local purchase state: both action buttons are fully visible without scrolling.
- 390 × 844 online purchase state: same layout and button visibility.
- Sub-340 px action panel: battle report and purchase offer stack without clipping or unreadable columns.
- Desktop layout: no regression in board/side-panel geometry or empty turn-header spacing.
- Rapid online action: buttons lock immediately, release on every completion path, and any race fallback appears as a temporary toast below persistent banners/safe-area.
- Chance/Destiny: card content remains unchanged and readable for 6 seconds before client playback continues.
- Rent/card/payment scenario: affected player cards show correctly signed and colored deltas, while their cash totals update.
- 390 px four-player scenario: the rail scrolls horizontally and both totals and delta pills remain legible.
- Cash delta announcements are combined into one polite live-region update.

## 8. Non-goals

- No engine rule or money calculation changes.
- No protocol or server acknowledgement changes.
- No board-coordinate or board-data changes.
- No sticky bottom action bar.
- No hiding the dice during purchase/build decisions.
- No modal acknowledgement for routine action failures.
- No permanent transaction history inside player cards.
