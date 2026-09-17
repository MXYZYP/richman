# M3-2 Playable Turn Design

## Goal

Turn the M3-1.5 static board into a minimally playable hot-seat turn loop using the existing rule engine as the only source of game rules.

A player must be able to roll dice, watch the token move cell by cell, resolve the immediate land decision, end the turn, and hand control to the next player.

## Scope

### In scope

- Real `GameState` held by the client UI.
- Real intents sent through `applyIntent()`:
  - `roll_dice`
  - `buy_property`
  - `skip_buy`
  - `build_house`
  - `skip_build`
  - `end_turn`
- Button availability driven by `state.turnPhase`.
- Dice display driven by `dice_rolled` events.
- Token movement animation driven by `token_moved.path`.
- Short event message display for the current action.
- Existing desktop and mobile layouts preserved.
- Two screenshots after implementation:
  - `plan/assets/screenshots/phase1/m3-2-playable-turn-desktop-1440x900.png`
  - `plan/assets/screenshots/phase1/m3-2-playable-turn-mobile-390x844.png`

### Out of scope

- Selling houses or properties from the UI.
- Debt management UI.
- Bankruptcy UI.
- Card detail modal or full card art display.
- Victory result screen.
- Opening setup page.
- Bot auto-turns.
- Networked play.
- Changes to board data or engine rule behavior.

Those are later M3 tasks in `plan/04-阶段1-单机热座版.md`.

## Architecture

Use a lightweight client game controller instead of placing all interaction state in Vue components.

Create `apps/client/src/game/clientGame.ts` as the browser-side playback controller. It owns UI playback state, calls the pure engine, and exposes reactive state to Vue. The engine remains the only rule authority; the controller never recalculates rent, purchase legality, house legality, turn order, or board paths.

Vue components stay presentational:

- `App.vue` creates the controller and passes state/handlers down.
- `ActionPanel.vue` renders available actions, dice, busy state, and event copy.
- `GameBoard.vue` renders tokens at `displayPositions` during animation, falling back to `player.position` when no animation override exists.
- `PlayerRail.vue` remains driven by `state.players` and `state.currentPlayerId`.

This keeps M3-2 small while leaving a stable seam for later card modals, debt UI, bot turns, and setup flow.

## Controller contract

`clientGame.ts` exports a factory named `createClientGame()`.

It returns:

- `state`: reactive `GameState`.
- `displayPositions`: reactive record keyed by player id.
- `dice`: latest dice values from `dice_rolled`, or `null` before the first roll.
- `eventMessage`: current human-readable event message.
- `isAnimating`: true while event playback is running.
- `lastError`: short user-facing error message for rejected actions, or `null`.
- `availableActions`: derived action model for the operation panel.
- `sendIntent(intent: Intent): Promise<void>`: serially applies one player intent and plays returned events.

### Invariants

- `sendIntent()` always uses `state.currentPlayerId` as the acting player.
- If `isAnimating` is true, `sendIntent()` refuses the new intent and sets `lastError` to a short message. It must not call `applyIntent()` a second time.
- On successful `applyIntent()`, `state` is replaced with the returned engine state before or during playback, but tokens visually follow `displayPositions` until playback finishes.
- After playback, every `displayPositions[player.id]` equals that player's final `state.players[].position`.
- On engine error, `state` is unchanged and `lastError` maps the engine error code to readable copy.

## Event playback

Playback consumes `GameEvent[]` in order.

### `dice_rolled`

- Set `dice` to the event dice array.
- Set `eventMessage` to `玩家名 掷出 X + Y`.
- Keep buttons disabled briefly through `isAnimating`.

### `token_moved`

- For each cell id in `path`, update `displayPositions[playerId]`.
- Wait about 120 ms between cells.
- Set `eventMessage` to `玩家名 前进到 格子名` for the final step or latest step.
- Do not change `boardLayout.ts`; movement follows engine-provided cell ids.

### Money and property events

Use short messages:

- `salary_collected`: `经过起点，领取 ¥2,000`.
- `property_bought`: `玩家名 买下 格子名`.
- `buy_declined`: `放弃购买`.
- `house_built`: `格子名 升到 N 级`; level 5 may say `建成旅馆`.
- `turn_ended`: `玩家名 回合结束`.
- `turn_started`: `轮到 玩家名`.
- Other engine events may display their `type` as a fallback only for this slice; later slices will replace those with richer UI.

## Action panel behavior

`ActionPanel.vue` receives:

- `actions`: action model from controller.
- `dice`: current dice.
- `eventMessage`: current event copy.
- `isAnimating`: busy flag.
- `lastError`: optional short error.
- `onAction`: callback receiving the selected intent.

Visible actions:

- `awaiting_roll`: `掷骰子` → `{ type: 'roll_dice' }`.
- `awaiting_buy_decision`: `买地` → `{ type: 'buy_property' }`, `放弃` → `{ type: 'skip_buy' }`.
- `awaiting_build_decision`: `盖房` → `{ type: 'build_house' }`, `跳过` → `{ type: 'skip_build' }`.
- `managing`: `结束回合` → `{ type: 'end_turn' }`.

All visible actions are disabled while `isAnimating` is true.

Do not expose sell/debt/bankrupt buttons in M3-2. If the engine enters a debt state before debt UI exists, the panel shows `资金不足，债务处理将在下一切片接入` and disables gameplay actions. Full debt handling is out of scope for this design.

## Board behavior

`GameBoard.vue` accepts optional `displayPositions?: Record<string, number>`.

`tokensOn(cellId)` uses:

1. `displayPositions[player.id]` if present.
2. Otherwise `player.position`.

This makes animation a view concern. Rule state stays in engine-owned `GameState`.

Existing token color classes, owner strips, branch layout, short names, and mobile sizing remain unchanged.

## Testing plan

Follow TDD. No production code before a failing test.

### Unit tests for controller

Create `apps/client/src/game/clientGame.test.ts`.

Required behaviors:

1. Initial controller state exposes the demo game and initializes `displayPositions` from player positions.
2. `sendIntent({ type: 'roll_dice' })` calls the real engine path and eventually updates dice plus final display position.
3. `token_moved.path` playback visits intermediate cells in order. Use an injectable delay/scheduler so tests do not sleep in real time.
4. While `isAnimating` is true, a second intent is refused and does not advance engine state.
5. `availableActions` maps `awaiting_roll`, `awaiting_buy_decision`, `awaiting_build_decision`, and `managing` to the expected visible actions.
6. Engine errors set `lastError` and preserve state.

### Component tests

If current test setup supports Vue component rendering, add focused tests for `ActionPanel.vue`:

- Awaiting roll shows only `掷骰子`.
- Buy decision shows `买地` and `放弃`.
- Build decision shows `盖房` and `跳过`.
- Managing shows `结束回合`.
- Busy state disables visible buttons.

If the project lacks Vue component test tooling, keep M3-2 component verification browser-based and do not add new dependencies just for this slice.

### Existing tests that must stay green

- `apps/client/src/ui/boardLayout.test.ts` must remain green.
- All engine tests must remain green.
- Data validation must remain green.

## Manual/browser verification

After implementation:

1. Start dev server with `pnpm dev -- --port 5173 --host 127.0.0.1`.
2. Open desktop viewport 1440×900.
3. Confirm initial page shows current player and `掷骰子`.
4. Click `掷骰子`.
5. Confirm dice values appear, buttons disable during movement, and token moves step by step.
6. If the landing phase is buy/build, click one available option and confirm event copy updates.
7. Click `结束回合` when available and confirm current player changes.
8. Repeat in mobile viewport 390×844 and confirm no horizontal overflow.
9. Save desktop and mobile screenshots to the M3-2 screenshot paths.

## Non-goals and guardrails

- Do not change `packages/board-data/data/board.json`.
- Do not change `apps/client/src/ui/boardLayout.ts` placement semantics.
- Do not alter engine rule behavior unless a pre-existing engine bug is found and reproduced by a failing engine test first.
- Do not introduce Pinia in M3-2.
- Do not add new dependencies unless implementation cannot be verified without them; if needed, explain the user-visible reason first.
- Do not add speculative animation settings, themes, audio, or network abstractions.

## Acceptance criteria

- A human can complete at least two consecutive local hot-seat turns using visible buttons.
- Dice and token movement are visibly driven by engine events.
- Operation panel never offers actions inconsistent with `turnPhase`.
- No double-click can apply two intents while animation is still playing.
- Existing M3-1.5 board visuals remain intact on desktop and mobile.
- Verification commands pass:
  - `pnpm test`
  - `pnpm typecheck`
  - `pnpm validate-data`
  - `pnpm --filter @richman/client build`
- Desktop and mobile screenshots are captured for the M3-2 state.
