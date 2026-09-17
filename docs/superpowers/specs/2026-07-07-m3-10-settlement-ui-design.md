# M3-10 Settlement UI Design

## Goal

Make bankruptcy and game-over outcomes visible in the local hotseat UI without changing engine rules.

Observable result: when a player goes bankrupt, the player rail and recent event area make that status obvious while the game continues. When the engine reaches `phase: 'game_over'`, the client shows a clear settlement overlay with the winner, the end reason, player rankings/statuses, and actions to start a new game or inspect the final board.

## Approved direction

Use option A from the visual mockup: **final settlement modal + lightweight bankruptcy notice**.

Rationale:

- Bankruptcy is not necessarily the end of the game, so it should not block play.
- Victory is the end of the game, so it needs a clear modal state.
- Mobile 390px needs one focused surface for winner, reason, and buttons.
- This pairs with M3-9 BOT autoplay: a mostly automated game can advance to the end and then stop on a visible result instead of hiding the outcome in recent logs.

## Scope

### In scope

- Client UI only.
- Render bankrupt players distinctly in `PlayerRail`.
- Preserve existing event log text, but make recent bankruptcy/game-over outcomes readable in the side panel.
- Add a `SettlementDialog` component shown when `game.state.value.phase === 'game_over'`.
- Settlement dialog includes:
  - winner name;
  - end reason;
  - ordered player summary;
  - player cash;
  - bankrupt status;
  - primary action: `再开一局`;
  - secondary action: `查看棋盘`.
- `再开一局` returns to the existing setup screen using the existing setup state.
- `查看棋盘` closes/dismisses the overlay but leaves the final board visible.
- Desktop 1440x900 and mobile 390x844 browser smoke verification.

### Out of scope

- No engine rule changes.
- No board-data changes.
- No history, persistence, leaderboard, replay, or long-term statistics.
- No sound, vibration, or complex animation system.
- No online/server settlement flow.

## Data model and derivation

Use existing engine state. Do not add new engine fields unless tests prove the client cannot derive the UI safely.

The dialog derives:

- `winner` from `state.winnerId` matched against `state.players`.
- `isGameOver` from `state.phase === 'game_over'`.
- `bankrupt` from existing player state fields already used by engine tests and event formatting.
- ranking by simple, deterministic UI ordering:
  1. winner first;
  2. non-bankrupt players by cash descending;
  3. bankrupt players after active players, preserving original player order when cash is not useful.

If `winnerId` is unavailable despite game over, the dialog uses a defensive title `本局结束` and still lists player statuses. This is a UI fallback only; it must not mask engine test failures.

## Components

### `SettlementDialog.vue`

New presentational component.

Props:

```ts
state: GameState;
```

Emits:

```ts
restart: [];
close: [];
```

Responsibilities:

- Build the settlement summary from `GameState`.
- Render winner title and end reason.
- Render a compact ranking table/card list.
- Render `再开一局` and `查看棋盘` buttons.
- Use accessible dialog semantics:
  - `role="dialog"`;
  - `aria-modal="true"`;
  - title referenced by `aria-labelledby`.

### `PlayerRail.vue`

Extend existing player cards with a visible bankrupt badge/state.

Rules:

- Current player highlighting still works.
- BOT badge remains visible.
- Bankrupt status must be readable on desktop and mobile.
- Do not remove cash display; bankrupt status is additive.

### `App.vue`

Owns whether the settlement overlay is dismissed for board inspection.

State:

```ts
const isSettlementDismissed = ref(false);
```

Derived:

```ts
const shouldShowSettlement = computed(
  () => game.value?.state.value.phase === 'game_over' && !isSettlementDismissed.value,
);
```

Actions:

- `查看棋盘`: set `isSettlementDismissed = true`.
- `再开一局`: set `game = null`, clear selected cell, clear dismissal, keep existing setup state so the user can start again quickly.
- When a new game starts, clear dismissal.

## UX copy

Settlement title:

```text
<赢家名> 获胜
```

End reason:

```text
所有对手已破产，本局结束
```

If the engine exposes a more precise existing event message for game over, the dialog may use it as the supporting sentence, but the winner title remains the primary result.

Bankrupt badge:

```text
破产
```

Buttons:

```text
再开一局
查看棋盘
```

## Styling

Follow existing Theme A warm-paper board polish:

- Use existing global CSS variables where available.
- Keep modal surface warm, high-contrast, and readable.
- Avoid image assets, network fonts, canvas, or large animation libraries.
- Mobile layout must fit 390px width without horizontal overflow.

The overlay may dim the board. Dismissed overlay must not permanently hide board state.

## Testing

Use TDD. Add RED tests before production changes.

Focused tests:

- `SettlementDialog` renders winner name and game-over reason from a real `GameState` fixture.
- `SettlementDialog` lists bankrupt players with `破产` status.
- `SettlementDialog` emits `restart` and `close` from the two buttons.
- `PlayerRail` displays bankrupt status without dropping BOT/current-player markers.
- `App.vue` shows settlement on `game_over`, hides it after `查看棋盘`, and returns to setup on `再开一局`.

Browser smoke:

- Production preview desktop 1440x900:
  - force or reach a game-over state;
  - settlement dialog visible;
  - no horizontal overflow;
  - `查看棋盘` reveals final board;
  - restart path returns to setup.
- Production preview mobile 390x844:
  - dialog readable;
  - buttons reachable;
  - no horizontal overflow.

Final verification:

```bash
pnpm test && pnpm typecheck && pnpm validate-data && pnpm --filter @richman/client build
```

## Risks and mitigations

- **Game-over hard to reach manually:** tests should use deterministic state fixtures; browser smoke may expose a test hook/query only if it is clearly development-only and not shipped as product behavior. Prefer real state construction through existing client helpers.
- **Modal hides final board:** include `查看棋盘` and allow overlay dismissal.
- **Restart accidentally changes setup defaults:** restart returns to setup screen and reuses current `setup` ref; it does not silently start a different game.
- **Mobile overflow:** verify 390x844 in browser, not only build/typecheck.
- **Ambiguous ranking:** use deterministic display ordering and keep winner first; do not imply historical score tracking.
