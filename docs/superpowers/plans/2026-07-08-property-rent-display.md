# Property Rent Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owner 否决棋盘租金角标后，按方案一整体移除棋盘租金显示；随后 owner 追加要求：全局棋盘格不显示购买价格，手机版局部地图保留无主地购买价格，走到可购买地时右侧操作面板也显示价格。

**Architecture:** Remove board-cell rent/price metadata and focused-route rent metadata. Keep unowned purchase price on mobile focused-route cards. Keep the existing detail card rent table as the complete source of rent information; add a purchase-offer model for `awaiting_buy_decision` and render it in `ActionPanel`.

**Tech Stack:** Vue 3 SFC, TypeScript, Vitest, Vite, existing `@richman/board-data` and `@richman/engine` types.

---

## File structure

- Modify `apps/client/src/components/BoardCell.vue`
  - Remove fixed-board rent/status badge and price rendering/styles.
  - Keep aria label focused on selecting the named cell.
- Modify `apps/client/src/components/FocusedBoard.vue`
  - Remove rent and station/utility rent-hint metadata from focused-route cards.
  - Keep ownership summary, mortgage state, current-position badge, token display, and unowned purchase price.
- Modify `apps/client/src/components/ActionPanel.vue`
  - Render the landed unowned property's purchase price while buy / skip buttons are visible.
- Modify `apps/client/src/game/clientGame.ts`
  - Add `getPendingPurchaseOffer(state)` for action-panel display.
- Delete `apps/client/src/ui/propertyStatus.ts`
  - The helper existed only to feed board rent badges.
- Rename/update test to `apps/client/src/ui/boardRentDisplay.test.ts`
  - Assert fixed board cells do not reintroduce rent/status/price overlay metadata, and focused-route cards keep price while excluding rent metadata.

## Task 1: Regression check first

**Files:**
- Rename/update: `apps/client/src/ui/boardRentDisplay.test.ts`

- [x] **Step 1: Add regression checks**

The test asserts:

- `BoardCell.vue` does not contain `cell-status`, `status-mobile`, `过路费`, `cell-price`, or `shouldShowPropertyPrice`;
- `FocusedBoard.vue` contains `cardPrice`, `价格 ¥`, and `focus-price`, but does not contain `租金`, `过路费`, or `getPropertyStatusDisplay`.

- [x] **Step 2: Verify RED**

Before implementation the test failed because `BoardCell.vue` still rendered rent status.

## Task 2: Remove board rent and price display

**Files:**
- Modify: `apps/client/src/components/BoardCell.vue`
- Modify: `apps/client/src/components/FocusedBoard.vue`
- Delete: `apps/client/src/ui/propertyStatus.ts`

- [x] **Step 1: Remove fixed board rent badge and price**

Remove `propertyStatus`, `.cell-status`, `.cell-price`, and desktop/mobile status/price markup/styles.

- [x] **Step 2: Remove focused-route rent metadata but keep price**

Focused cards no longer show current rent or station/utility rent hints. Focused cards still show unowned purchase price because the mobile local map has enough space. Rent remains available through the detail panel; purchase price also appears in the action panel when it matters.

## Task 3: Show purchase price in action panel

**Files:**
- Modify: `apps/client/src/game/clientGame.ts`
- Modify: `apps/client/src/components/ActionPanel.vue`
- Modify: `apps/client/src/App.vue`

- [x] **Step 1: Add purchase-offer helper**

`getPendingPurchaseOffer(state)` returns `{ cellId, name, price }` only during `awaiting_buy_decision` on an unowned property.

- [x] **Step 2: Render offer in operation panel**

`ActionPanel` shows property name and price above buy / skip buttons.

- [x] **Step 3: Verify GREEN**

Run:

```bash
pnpm vitest run apps/client/src/ui/boardRentDisplay.test.ts
```

Expected: PASS.

## Task 4: Verification and screenshots

**Files:**
- Update screenshots:
  - `plan/assets/screenshots/phase1/property-rent-display-desktop-1440x900.png`
  - `plan/assets/screenshots/phase1/property-rent-display-mobile-390x844.png`

- [ ] **Step 1: Run targeted tests**

Run:

```bash
pnpm vitest run apps/client/src/ui/boardRentDisplay.test.ts apps/client/src/ui/boardLayout.test.ts apps/client/src/game/clientGame.test.ts
pnpm --filter @richman/client build
```

- [ ] **Step 2: Browser screenshots and overlap check**

Capture:

- desktop 1440x900
- mobile 390x844

Run DOM overlap check at both breakpoints:

- fixed board cell names and focused route card names must not be covered by rent/status overlays; focused route may show its own price line;
- no horizontal overflow;
- action panel shows landed purchase price when buy / skip decision is active;
- detail panel still shows full rent facts after selecting a property.

- [ ] **Step 3: Run full verification**

Run:

```bash
pnpm test && pnpm typecheck && pnpm validate-data && pnpm --filter @richman/client build
```

## Commit guidance

Do not commit unless the user explicitly confirms commit after verification.
