# Airport Pause Roll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change airport branch entry from automatic second roll to an explicit player action after the token stops on 北京首都国际机场.

**Architecture:** Add `awaiting_airport_roll` and `roll_airport_branch` to the engine state machine. Keep branch movement data-driven through `branchEntryId` and reuse existing `resolveLanding()` for the branch destination. The client only maps the new phase to a button; event playback remains unchanged.

**Tech Stack:** TypeScript, Vitest, Vue 3, existing `@richman/engine` and `@richman/board-data` packages.

---

## File Structure

- Modify `packages/engine/src/types.ts`: add the new turn phase and intent.
- Modify `packages/engine/src/engine.ts`: split airport handling out of `handleRollDice()` into a new `handleAirportBranchRoll()` path.
- Modify `packages/engine/src/__tests__/branch.test.ts`: update old automatic-branch expectations and add new explicit-roll coverage.
- Modify `apps/client/src/game/clientGame.ts`: map `awaiting_airport_roll` to `再掷一次`.
- Modify `apps/client/src/game/clientGame.test.ts`: add client action mapping test.
- Modify `plan/01-游戏规则规格书.md`, `plan/02-棋盘数据与素材规范.md`, `assets/棋盘数据核对表.md`: update rule wording from immediate auto-roll to explicit second roll.

## Task 1: Engine RED tests

- [ ] **Step 1: Replace automatic branch assertions in `packages/engine/src/__tests__/branch.test.ts`**

Expected behaviors:

```ts
it('停机场后停在机场并等待玩家再掷一颗骰子', () => {
  const s = makeStoppedAtAirport();
  const r = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
  if (!r.ok) throw new Error('fail');
  const diceEvents = r.events.filter((e): e is Extract<typeof e, { type: 'dice_rolled' }> => e.type === 'dice_rolled');
  const moves = r.events.filter((e): e is Extract<typeof e, { type: 'token_moved' }> => e.type === 'token_moved');
  expect(diceEvents).toHaveLength(1);
  expect(diceEvents[0].dice).toHaveLength(2);
  expect(moves).toHaveLength(1);
  expect(P(r.state).position).toBe(13);
  expect(r.state.turnPhase).toBe('awaiting_airport_roll');
});
```

- [ ] **Step 2: Add explicit branch roll rejection test**

```ts
it('非机场等待阶段不能掷机场支线骰', () => {
  const s = makeStarted();
  const r = applyIntent(s, s.currentPlayerId, { type: 'roll_airport_branch' });
  expect(r.ok).toBe(false);
});
```

- [ ] **Step 3: Add explicit branch roll movement tests**

Keep the existing target helpers. They should now call `roll_dice` first, then `roll_airport_branch` on the returned state:

```ts
const first = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
if (!first.ok) throw new Error('first fail');
const second = applyIntent(first.state, first.state.currentPlayerId, { type: 'roll_airport_branch' });
if (!second.ok) throw new Error('second fail');
```

Assert the one-die event, branch path, and resolved final position exactly as the old automatic tests did.

- [ ] **Step 4: Run RED**

```bash
pnpm vitest run packages/engine/src/__tests__/branch.test.ts
```

Expected: fails because `roll_dice` still auto-rolls and `roll_airport_branch` type is not implemented.

## Task 2: Engine implementation

- [ ] **Step 1: Update `packages/engine/src/types.ts`**

Add:

```ts
| 'awaiting_airport_roll'
```

to `TurnPhase`, and add:

```ts
| { type: 'roll_airport_branch' }
```

to `Intent`.

- [ ] **Step 2: Modify `handleRollDice()`**

When the normal movement lands on airport, do not roll the branch die. Instead, set the moved player position to airport and pass `turnPhase = 'awaiting_airport_roll'` into the resulting state.

- [ ] **Step 3: Add `handleAirportBranchRoll()`**

Allow only `state.turnPhase === 'awaiting_airport_roll'`. Read the current airport cell, use `branchEntryId`, roll one die, walk from branch entry with `d - 1`, emit `dice_rolled` and `token_moved`, apply player position, then call `resolveLanding()` for the branch destination.

- [ ] **Step 4: Wire `applyIntent()`**

Route `intent.type === 'roll_airport_branch'` to `handleAirportBranchRoll()`.

- [ ] **Step 5: Run GREEN**

```bash
pnpm vitest run packages/engine/src/__tests__/branch.test.ts
```

Expected: branch tests pass.

## Task 3: Client RED/GREEN

- [ ] **Step 1: Add test in `apps/client/src/game/clientGame.test.ts`**

```ts
it('maps awaiting_airport_roll to explicit branch roll', () => {
  const game = createClientGame({ wait: async () => undefined });
  game.state.value = { ...game.state.value, turnPhase: 'awaiting_airport_roll' };
  expect(getAvailableActions(game.state.value)).toEqual([
    { label: '再掷一次', intent: { type: 'roll_airport_branch' }, primary: true },
  ]);
});
```

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run apps/client/src/game/clientGame.test.ts
```

Expected: fails before client mapping exists.

- [ ] **Step 3: Update `apps/client/src/game/clientGame.ts`**

Add a `case 'awaiting_airport_roll'` to `getAvailableActions()` returning the action above.

- [ ] **Step 4: Run GREEN**

```bash
pnpm vitest run apps/client/src/game/clientGame.test.ts
```

Expected: client tests pass.

## Task 4: Documentation

- [ ] **Step 1: Update rule docs**

Replace “立即再掷一颗骰子” style wording with “停留后等待玩家再掷一颗骰子” in:

- `plan/01-游戏规则规格书.md`
- `plan/02-棋盘数据与素材规范.md`
- `assets/棋盘数据核对表.md`

- [ ] **Step 2: Preserve historical notes**

Keep prior K13 one-die/step semantics; only change immediate-vs-explicit timing.

## Task 5: Full verification

- [ ] **Step 1: Run focused tests**

```bash
pnpm vitest run packages/engine/src/__tests__/branch.test.ts apps/client/src/game/clientGame.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run full verification**

```bash
pnpm test
pnpm typecheck
pnpm validate-data
pnpm --filter @richman/client build
```

Expected: all pass.

- [ ] **Step 3: Manual browser smoke if time permits**

Use a seed/state if available to reach airport, or rely on engine tests if browser setup cannot deterministically land there. The important contract is engine state machine correctness plus client action mapping.

## Self Review

- Spec coverage: engine, client, docs, and verification requirements from `2026-07-07-airport-pause-roll-design.md` are covered.
- Placeholder scan: no TBD/TODO placeholders remain.
- Type consistency: `awaiting_airport_roll` and `roll_airport_branch` are used consistently across engine and client tasks.
