# M3-3 Card Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show readable chance/destiny card information in the playable hot-seat UI.

**Architecture:** Keep engine events unchanged. The client controller turns `card_drawn` events into a persistent `activeCard` display model and readable messages. `ActionPanel` renders the display model.

**Tech Stack:** TypeScript, Vue 3, Vitest, existing `@richman/engine` and `@richman/board-data`.

---

## Files

- Modify `apps/client/src/game/clientGame.ts`: add `DisplayCard`, `activeCard`, card lookup, readable event messages.
- Modify `apps/client/src/game/clientGame.test.ts`: add tests for real card draw presentation.
- Modify `apps/client/src/components/ActionPanel.vue`: add `activeCard` prop and render card panel.
- Modify `apps/client/src/App.vue`: pass `game.activeCard.value`.
- Create no new production dependencies.

## Tasks

1. Write RED tests in `clientGame.test.ts` for card presentation.
2. Implement `DisplayCard` and `activeCard` in `clientGame.ts`.
3. Replace raw event fallback for common settlement events with readable Chinese messages.
4. Render `activeCard` in `ActionPanel.vue` and wire it from `App.vue`.
5. Run focused client tests, then full verification.

## Acceptance

- Card draw test fails before implementation and passes after.
- `pnpm vitest run apps/client/src/game/clientGame.test.ts` passes.
- `pnpm test`, `pnpm typecheck`, `pnpm validate-data`, and client build pass.
