# M3-7 to M4 Merge Must-Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four required review blockers before merging the M3-7~M4 acceptance package into main.

**Architecture:** Reuse existing engine intents and client summary helpers. UI changes stay in the asset panel, settlement dialog, and cell detail panel; engine logic changes are limited to BOT debt intent ordering. Documentation changes record the mortgage timing deviation without changing board data.

**Tech Stack:** Vue 3 SFC, TypeScript, Vitest, existing `@richman/engine`, existing markdown planning docs.

---

## Task 1: Human debt liquidation UI

**Files:**
- Modify: `apps/client/src/game/clientGame.ts`
- Modify: `apps/client/src/game/clientGame.test.ts`
- Modify: `apps/client/src/components/AssetPanel.vue`

- [ ] Add `sellPropertyValue`, `canSellProperty`, `sellPropertyReason`, and `canDeclareBankrupt` surface data where needed.
- [ ] RED: debt actor with level-0 unmortgaged property exposes sell-property action state; non-debt/non-eligible rows do not.
- [ ] RED: asset panel sends `sell_property` for eligible row and sends `declare_bankrupt` only after confirmation.
- [ ] GREEN: wire `sell_property` row button and debt-level bankruptcy confirmation UI.
- [ ] Verify targeted tests and client build.

## Task 2: Settlement details

**Files:**
- Modify: `apps/client/src/game/settlement.ts`
- Modify: `apps/client/src/game/settlement.test.ts`
- Modify: `apps/client/src/components/SettlementDialog.vue`

- [ ] RED: settlement summary includes each player's property list and survived turn count.
- [ ] GREEN: compute owned properties from `state.properties` and `state.board.cells`; use `bankruptTurn` for bankrupt players and `state.turn` for active players.
- [ ] GREEN: render `存活 X 回合` and `地产：...` under each row.
- [ ] Verify targeted tests and client build.

## Task 3: Cell detail building fee

**Files:**
- Modify: `apps/client/src/game/clientGame.ts`
- Modify: `apps/client/src/game/clientGame.test.ts`
- Modify: `apps/client/src/components/CellDetailPanel.vue`

- [ ] RED: normal property detail exposes `houseCost`; station/utility/non-property details do not.
- [ ] GREEN: add `houseCost` to detail model and render `单栋建筑费`.
- [ ] Verify targeted tests and client build.

## Task 4: Rules/docs and BOT debt order

**Files:**
- Modify: `packages/engine/src/bot.ts`
- Modify: `packages/engine/src/__tests__/bot.test.ts`
- Modify: `plan/01-游戏规则规格书.md`
- Modify: `plan/03-架构与联机协议.md`

- [ ] RED: BOT debt state with no houses and an unmortgaged property chooses `mortgage_property` before `sell_property`.
- [ ] GREEN: choose debt intents in order: sell houses, mortgage unmortgaged level-0 assets, sell sellable assets, declare bankrupt.
- [ ] Remove `阶段 3 实现` from 01 §7 heading.
- [ ] Add 01 deviation record matching airport entry style: mortgage/redeem landed earlier than stage label because debt/bankruptcy acceptance needed a complete finance loop; owner is aware via merge-blocker instruction.
- [ ] Update 03 §4.4 BOT strategy text to say debt state mortgages before selling land.
- [ ] Verify targeted tests and docs diff.

## Task 5: Final verification and review

- [ ] Run targeted tests for changed suites.
- [ ] Run `pnpm test && pnpm typecheck && pnpm validate-data && pnpm --filter @richman/client build`.
- [ ] Browser-check production preview for debt buttons, bankruptcy confirmation, settlement details, building fee, and no obvious mobile overflow.
- [ ] Commit implementation.
- [ ] Request final code review before handoff.
