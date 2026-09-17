# M3-4 Mortgage/Redeem Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add engine-only mortgage and redemption rules for owned properties.

**Architecture:** Extend existing engine intents/events and reuse current debt recovery helpers. Mortgage/redeem live beside sell-house/sell-property handlers in `engine.ts`; rent behavior remains in selectors/effects and already checks `mortgaged` in tier counts.

**Tech Stack:** TypeScript, Vitest, existing `@richman/engine` and `@richman/board-data`.

---

## Files

- Modify `packages/engine/src/types.ts`: add mortgage/redeem intents and events.
- Modify `packages/engine/src/engine.ts`: route intents and implement handlers.
- Modify `packages/engine/src/simulate.ts`: include mortgage/redeem events in bank-balance accounting.
- Add or modify `packages/engine/src/__tests__/mortgage.test.ts`: focused RED/GREEN rule tests.
- Modify existing rent/simulation tests only if a focused regression needs to live next to existing helpers.

## Task 1: Add RED tests for mortgage success and validation

- [ ] Create `packages/engine/src/__tests__/mortgage.test.ts`.
- [ ] Test successful mortgage of an owned normal property: cash increases by `mortgageValue`, property becomes `mortgaged`, event is `property_mortgaged`.
- [ ] Test successful mortgage of owned station and utility with `level: 0`.
- [ ] Test rejection for property with houses, already mortgaged, wrong owner, and wrong phase.
- [ ] Run `pnpm vitest run packages/engine/src/__tests__/mortgage.test.ts` and confirm RED because the new intent/event types are not implemented yet.

## Task 2: Implement mortgage intent and event

- [ ] Add `{ type: 'mortgage_property'; cellId: number }` to `Intent`.
- [ ] Add `{ type: 'property_mortgaged'; playerId: string; cellId: number; amount: number }` to `GameEvent`.
- [ ] Route `mortgage_property` in `applyIntent()`.
- [ ] Implement `handleMortgageProperty()` using existing `handleSellProperty()` style.
- [ ] Use `payDebtIfPossible()` and `finishCashGoalIfReached()` after mortgage cash is added.
- [ ] Run `pnpm vitest run packages/engine/src/__tests__/mortgage.test.ts` and confirm mortgage tests pass.

## Task 3: Add RED tests for redeem success and validation

- [ ] Extend `mortgage.test.ts` with redeem tests.
- [ ] Test successful redeem: cost is `Math.round(mortgageValue * (1 + mortgageInterestRate))`, cash decreases, `mortgaged` becomes false, event is `property_redeemed`.
- [ ] Test rejection for not mortgaged, wrong owner, insufficient cash, wrong phase, and active debt.
- [ ] Run `pnpm vitest run packages/engine/src/__tests__/mortgage.test.ts` and confirm RED for redeem.

## Task 4: Implement redeem intent and event

- [ ] Add `{ type: 'redeem_property'; cellId: number }` to `Intent`.
- [ ] Add `{ type: 'property_redeemed'; playerId: string; cellId: number; amount: number }` to `GameEvent`.
- [ ] Route `redeem_property` in `applyIntent()`.
- [ ] Implement `handleRedeemProperty()`.
- [ ] Run `pnpm vitest run packages/engine/src/__tests__/mortgage.test.ts` and confirm redeem tests pass.

## Task 5: Add rent and debt regressions

- [ ] Add/extend tests proving mortgaged normal property charges no rent.
- [ ] Add/extend tests proving mortgaged station/utility do not count in station/utility tiers.
- [ ] Add a debt-state mortgage test proving mortgage can settle a debt through `payDebtIfPossible()`.
- [ ] Run focused tests: `pnpm vitest run packages/engine/src/__tests__/mortgage.test.ts packages/engine/src/__tests__/rent.test.ts packages/engine/src/__tests__/rent_payment.test.ts`.

## Task 6: Update simulation accounting and verify

- [ ] Update `bankDelta()` in `simulate.ts`:
  - `property_mortgaged` is money from bank to player: negative bank delta.
  - `property_redeemed` is money from player to bank: positive bank delta.
- [ ] Run `pnpm vitest run packages/engine/src/__tests__/simulation.test.ts`.
- [ ] Run full verification:
  - `pnpm test`
  - `pnpm typecheck`
  - `pnpm validate-data`
  - `pnpm --filter @richman/client build`

## Acceptance

- Focused mortgage tests pass.
- Rent behavior for mortgaged property remains correct.
- Debt settlement after mortgage cash follows existing `debt_resolved` behavior.
- Simulation cash conservation remains zero violations.
- Full verification passes.
