# Automatic Bankruptcy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当欠款玩家已无任何合法筹款动作时，在同一个 intent 内自动执行现有破产结算，并连续处理付款队列直到状态稳定。

**Architecture:** 在 `engine.ts` 增加无分配的“是否仍可筹款”判断，并在 `applyIntent` 的成功结果进入胜利判定前运行稳定化循环。循环复用 `handleDeclareBankrupt`；每次破产都可能恢复 `debt.resume` 并产生下一位债务人，因此反复处理到无债务、有合法筹款动作或游戏结束。

**Tech Stack:** TypeScript 纯函数规则引擎、Vitest、现有 `GameState`/`ApplyResult`/`GameEvent`

---

### Task 1: Lock the new behavior with failing tests

**Files:**
- Modify: `packages/engine/src/__tests__/debt_bankruptcy.test.ts`
- Modify: `packages/engine/src/__tests__/tax.test.ts`
- Modify: `packages/engine/src/__tests__/rent_payment.test.ts`

- [ ] **Step 1: Add a test that preserves debt while any legal liquidation remains**

Add to `debt_bankruptcy.test.ts`:

```ts
it('欠款仍有可卖资产时不自动破产', () => {
  let s = makeStarted(['p1', 'p2', 'p3']);
  s = withProperty(s, 2, 'p1', { level: 0 });
  s = withProperty(s, 3, 'p1', { level: 0 });
  s = {
    ...s,
    currentPlayerId: 'p1',
    turnPhase: 'managing',
    debt: { debtorId: 'p1', creditorId: 'p2', amount: 999999 },
    players: s.players.map((p) => (p.id === 'p1' ? { ...p, cash: 0 } : p)),
  };

  const r = applyIntent(s, 'p1', { type: 'sell_property', cellId: 2 });
  if (!r.ok) throw new Error('fail');

  expect(player(r.state, 'p1').bankrupt).toBe(false);
  expect(r.state.debt?.debtorId).toBe('p1');
  expect(r.state.properties[3].ownerId).toBe('p1');
});
```

- [ ] **Step 2: Add tests for last fundraising action and stability looping**

```ts
it('抵押最后一块可筹款地产仍不足时立即自动破产', () => {
  let s = makeStarted(['p1', 'p2', 'p3']);
  s = withProperty(s, 2, 'p1', { level: 0 });
  s = {
    ...s,
    currentPlayerId: 'p1',
    turnPhase: 'managing',
    debt: { debtorId: 'p1', creditorId: 'p2', amount: 999999 },
    players: s.players.map((p) => (p.id === 'p1' ? { ...p, cash: 0 } : p)),
  };

  const r = applyIntent(s, 'p1', { type: 'mortgage_property', cellId: 2 });
  if (!r.ok) throw new Error('fail');

  expect(player(r.state, 'p1').bankrupt).toBe(true);
  expect(r.state.debt).toBeNull();
  expect(r.state.properties[2]).toEqual({ ownerId: null, level: 0, mortgaged: false });
  expect(r.events.map((event) => event.type)).toEqual(expect.arrayContaining(['property_mortgaged', 'player_bankrupt']));
});

it('同一 intent 连续自动处理付款队列中的多个无资产债务人', () => {
  let s = makeStarted(['p1', 'p2', 'p3', 'p4']);
  s = withProperty(s, 2, 'p2', { level: 0 });
  s = {
    ...s,
    currentPlayerId: 'p1',
    turnPhase: 'managing',
    debt: {
      debtorId: 'p2',
      creditorId: 'p1',
      amount: 999999,
      resume: { payments: [{ debtorId: 'p3', creditorId: 'p1', amount: 500 }] },
    },
    players: s.players.map((p) => {
      if (p.id === 'p2') return { ...p, cash: 0 };
      if (p.id === 'p3') return { ...p, cash: 100 };
      return p;
    }),
  };

  const r = applyIntent(s, 'p2', { type: 'sell_property', cellId: 2 });
  if (!r.ok) throw new Error('fail');

  expect(player(r.state, 'p2').bankrupt).toBe(true);
  expect(player(r.state, 'p3').bankrupt).toBe(true);
  expect(r.state.debt).toBeNull();
  expect(r.events.filter((event) => event.type === 'player_bankrupt')).toHaveLength(2);
});
```

- [ ] **Step 3: Update tax tests to distinguish debt from insolvency**

In the existing “现金不足付税 → 债务” case, assign one unencumbered property to the current player before rolling so the expected debt remains legal:

```ts
properties: {
  ...base.properties,
  2: { ownerId: base.currentPlayerId, level: 0, mortgaged: false },
},
```

Add a second case using the original no-property fixture and assert `bankrupt === true`, `debt === null`, and event order includes `debt_entered` before `player_bankrupt`.

- [ ] **Step 4: Preserve the rent-debt fixture’s intended contract**

In `rent_payment.test.ts`, assign a separate unencumbered property (for example cell 3) to the landing player before the roll. The test continues to assert that forced rent first exhausts cash and stores only the unpaid difference; automatic bankruptcy is tested separately.

- [ ] **Step 5: Run tests and confirm the new cases fail for the missing behavior**

Run: `pnpm exec vitest run packages/engine/src/__tests__/debt_bankruptcy.test.ts packages/engine/src/__tests__/tax.test.ts packages/engine/src/__tests__/rent_payment.test.ts`

Expected before implementation: new automatic-bankruptcy assertions FAIL; existing debt-with-assets assertions remain valid.

### Task 2: Add liquidation eligibility and stabilize successful intents

**Files:**
- Modify: `packages/engine/src/engine.ts`

- [ ] **Step 1: Add the exact legal-action predicate**

Place near `alivePlayers`:

```ts
function hasLiquidationAction(state: GameState, playerId: string): boolean {
  return state.board.cells.some((cell) => {
    if (cell.type !== 'property') return false;
    const property = state.properties[cell.id];
    if (!property || property.ownerId !== playerId) return false;
    if (cell.subtype === 'normal' && property.level > 0) return true;
    return property.level === 0 && !property.mortgaged;
  });
}
```

This mirrors the existing intent guards: a normal property with a building can `sell_house`; any unencumbered level-zero property can `sell_property` (and, when configured, `mortgage_property`). Mortgaged land cannot raise more cash.

- [ ] **Step 2: Add a bounded stability loop that reuses manual bankruptcy**

Place after `handleDeclareBankrupt` (function declarations are hoisted):

```ts
function settleAutomaticBankruptcies(
  result: Extract<ApplyResult, { ok: true }>,
): Extract<ApplyResult, { ok: true }> {
  let settled = result;

  while (settled.state.phase === 'playing' && settled.state.debt) {
    const debtorId = settled.state.debt.debtorId;
    if (hasLiquidationAction(settled.state, debtorId)) break;

    const bankruptcy = handleDeclareBankrupt(settled.state, debtorId);
    if (!bankruptcy.ok) break;

    settled = {
      ok: true,
      state: bankruptcy.state,
      events: [...settled.events, ...bankruptcy.events],
    };
  }

  return settled;
}
```

Each iteration bankrupts one live player, so the finite player list bounds the loop without allocating a visited set. `handleDeclareBankrupt` already restores queued payments, advances turns, clears assets, transfers cash and resolves victory.

- [ ] **Step 3: Insert stabilization before final victory checks**

Change the successful tail of `applyIntent` to:

```ts
if (!result.ok) return result;
const settled = settleAutomaticBankruptcies(result);
return finalizeWinConditions(settled, state);
```

Do not call the stabilizer inside `applyCardEffect`; game intents are the authoritative mutation boundary, and direct effect tests retain their low-level `newDebt` contract.

- [ ] **Step 4: Run focused engine tests**

Run: `pnpm exec vitest run packages/engine/src/__tests__/debt_bankruptcy.test.ts packages/engine/src/__tests__/tax.test.ts packages/engine/src/__tests__/rent_payment.test.ts packages/engine/src/__tests__/payments.test.ts packages/engine/src/__tests__/victory.test.ts`

Expected: all selected files PASS; the queue test records two `player_bankrupt` events in one result.

### Task 3: Regression verification

**Files:**
- No source changes unless verification exposes a scoped regression.

- [ ] **Step 1: Run the full engine suite**

Run: `pnpm --filter @richman/engine test`

Expected: PASS.

- [ ] **Step 2: Run repository type and data checks**

Run: `pnpm typecheck && pnpm validate-data`

Expected: PASS.

- [ ] **Step 3: Run the client production build**

Run: `pnpm build`

Expected: PASS; browser/server consumers compile against the unchanged public engine types.
