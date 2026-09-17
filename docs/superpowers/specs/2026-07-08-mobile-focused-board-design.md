# Mobile Focused Board Design

## Goal

On mobile, default to a focused local route board so cells are large and readable, while keeping a one-tap switch to the full global board for overview.

The design choice is:

```text
Mobile default: local route board
Toggle: global full board
Desktop: unchanged full board
```

## Problem

The current mobile full-board view renders the 61-cell board inside a 390px viewport. The outer ring uses 14 columns, so each top/bottom cell is roughly 25–27px wide after padding. That width cannot comfortably hold a cell name, rent/status, ownership color, and player token.

Observed real-device issue:

- The board is technically playable and has no horizontal overflow.
- Cards are too small.
- Information density is too high.
- The primary action area is pushed toward the Safari bottom toolbar.

## Product decision

Mobile should not force the complete board to be the primary play surface. The complete board remains available as an overview, but the default mobile play surface should show the current player's nearby route with larger cards.

This follows a three-layer information model:

| Layer | Responsibility |
|---|---|
| Focused route board | Current position, nearby route, actionable cell information |
| Global full board | Overall positions, ownership distribution, map awareness |
| Cell detail panel | Full deed/card/price/rent details on demand |

## Scope

### In scope

- Mobile-only focused route board.
- Toggle button between focused route and global board.
- Focused route shows current actor's nearby cells by default.
- Full board remains the existing `GameBoard` component.
- Desktop layout remains unchanged.
- Bottom safe-area spacing so primary actions are not hidden by mobile browser chrome.
- Real phone/browser screenshot verification.

### Out of scope

- Changing engine rules.
- Changing `board.json`, `cards.json`, or game config data.
- Changing `boardLayout.ts` placement semantics.
- Replacing the full board on desktop.
- Pinch zoom, drag-to-pan map, or canvas rendering.
- Network multiplayer.
- New art assets.

## Mobile interaction model

### Default view

After game start on mobile, the board area shows the focused route board.

Header controls:

```text
当前位置附近                         查看全局
```

The focused route board shows up to 7 route cards around the active actor. Branch-end views may show fewer cards because the branch is clamped:

```text
[前3格] [前2格] [前1格] [当前格] [后1格] [后2格] [后3格]
```

The current cell is visually emphasized.

### Global view

Tapping `查看全局` switches the board area to the existing full board.

Header controls:

```text
全局棋盘                             回到当前位置
```

Tapping `回到当前位置` returns to the focused route board.

### Cell selection

- Tapping a focused route card selects that cell and opens/updates the existing cell detail panel.
- Tapping a full-board cell keeps the current existing behavior.
- Returning from global to focused mode clears no game state and does not reset selection.

### Turn changes

When active actor changes, focused route automatically centers on the new active actor unless the user is in global view. If the user is in global view, it stays global until they tap `回到当前位置`.

### Movement animation
The first implementation updates the focused route after each display position change. Animated route-strip scrolling is excluded from this slice. When the user switches to the full board, the existing `GameBoard` token animation must remain intact. The focused route must not alter the shared `displayPositions` stepping in `clientGame.ts`.

## Focused route content

Each route card should be large enough to read on 390px phones.

### Normal property, unowned

```text
澳门
无主地产
价格 ¥3,000
```

### Normal property, owned by another player

```text
辽宁省
电脑A 的地
```

### Normal property, owned by active actor

```text
广东省
你的地产
```

### Mortgaged property

```text
山东
你的地产
已抵押
```

### Station / utility

Show name, ownership, and unowned purchase price when applicable. Do not show rent hints in the focused route card.

```text
自来水厂
无主地产
价格 ¥1,000
```

### Chance / Destiny / Tax / Airport / Start / World cells

Show icon/name and one short hint:

```text
机会
抽一张机会卡
```

```text
起点
经过或停留领取工资
```

## Route semantics

The first implementation should use board cell order as route order:

- Outer ring cells: IDs `0..51` in clockwise order.
- Branch cells: IDs `52..60` shown when the active/displayed position is on the branch.

Focused route window rules:

1. If the active actor is on the outer ring, show `current - 3` through `current + 3`, wrapping around `0..51`.
2. If the active actor is on the branch, show the branch sequence around that branch cell, clamped to `52..60`.
3. If movement path display positions are active, center on `displayPositions[activeActorId]` rather than the stored player position.
4. Bankrupt players are not centered unless they are somehow still the active actor; normal game flow should skip them.
5. If the game is over, keep the focused route centered on the winner when available; otherwise center on the last active actor. The global/full-board toggle remains available for final board inspection.

Airport-to-branch transition does not need a special visual path in the first implementation. It only needs to show the correct focused cells after position changes.

## Layout requirements

### Mobile

- Focused route board replaces the full board by default below `767px` width.
- Focused route cards use horizontal scrolling only inside the route strip when the rendered card count cannot fit comfortably.
- The page itself must not horizontally scroll.
- Primary action button must stay clear of Safari bottom toolbar with safe-area padding.
- Full board mode may use the existing compact full board.

### Desktop

- Desktop continues to show the full board only.
- No focused route toggle on desktop.

## Visual direction

Focused route cards should use the existing warm paper style, radius, shadows, property band colors, and player colors.

Do not introduce a new visual theme. This is a mobile density fix, not a re-skin.

## Accessibility

- Toggle button must be a real button.
- Toggle labels must be clear: `查看全局` and `回到当前位置`.
- Focused route cards must be buttons with aria labels that include full cell name and key state.
- Current cell should not rely only on color; include text such as `当前位置` or an aria marker.
- Touch targets should be at least 44px high.

## Testing and verification

### Unit tests

Add tests for the pure focused route helper:

- Outer ring centers on current position.
- Outer ring wraps around start/end.
- Branch route clamps at branch ends.
- Display position overrides stored player position.
- Game-over fallback centers on the winner or last active actor.

### Build checks

Run:

```bash
pnpm vitest run apps/client/src/ui/focusedRoute.test.ts apps/client/src/ui/boardLayout.test.ts
pnpm --filter @richman/client build
```

### Browser verification

Use a real browser viewport and owner phone when available:

- Mobile `390x844`: default view is focused route.
- Mobile `390x844`: `查看全局` shows full board.
- Mobile `390x844`: `回到当前位置` returns to focused route.
- Mobile Safari: primary action button is not hidden by bottom toolbar.
- Desktop `1440x900`: full board remains unchanged.

### Screenshots

Save:

```text
plan/assets/screenshots/phase1/mobile-focused-board-route-390x844.png
plan/assets/screenshots/phase1/mobile-focused-board-global-390x844.png
plan/assets/screenshots/phase1/mobile-focused-board-desktop-1440x900.png
```

## Acceptance criteria

- On mobile, default board area uses focused route cards instead of the dense full board.
- A visible button switches to the full global board.
- A visible button switches back to the focused current-position board.
- Focused cards are materially larger and easier to read than current full-board cells: on a 390px viewport, each focused route card should be at least 80px wide and at least 64px high.
- Current actor location is obvious through a non-color marker: visible `当前位置` text on the active route card plus the existing player token.
- Existing full board remains available.
- Desktop layout is unchanged.
- No rule/data changes.
- Focused-route windowing passes unit tests for outer-ring wrap, branch-end clamping, display-position override, and game-over fallback.
- Tests, typecheck, data validation, and client build pass before commit.
