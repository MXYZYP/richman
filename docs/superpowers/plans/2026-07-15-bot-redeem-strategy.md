# Bot Redeem Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bot actively redeem mortgaged properties during the managing phase, prioritized by projected post-redemption rent, while preserving at least ¥1,000 cash.

**Architecture:** Extend `chooseBotIntent` in `packages/engine/src/bot.ts` so that the non-debt `managing` branch first attempts redemptions before falling back to `end_turn`. Add a pure selector that computes projected post-redemption rent directly from the board/property state without cloning a complete `GameState` per candidate. No engine rule changes, no new domain types.

**Tech Stack:** TypeScript, Vitest, pnpm monorepo

**Spec reference:** User decisions 2026-07-15 — "保留至少 ¥1,000 后按赎回后即时过路费从高到低赎回"；`utility` 类资产统一按双骰期望点数 7 计算预计过路费，不读取 `state.lastDice`。

## Approved corrections (authoritative)

- 预计租金必须由纯 selector 直接计算；禁止为每个候选复制整份 `GameState`。
- `utility` 预计租金固定使用 7 点：持有一处未抵押时为 `7 × 10`，两处均未抵押时为 `7 × 100`。
- 同租金候选依次按赎回价升序、cell ID 升序确定，测试必须使用确定性 fixture。
- 测试不得因当前中国之旅数据缺少某种天然组合而 `return`、skip 或静默通过；必要时在测试 state 中构造明确的 board fixture。
- 用户未授权 commit、push 或 PR；本计划中的 commit 步骤不执行。

---

## File Structure

- **Modify:** `packages/engine/src/bot.ts` — add redeem logic to the `managing` branch
- **Modify:** `packages/engine/src/selectors.ts` — add efficient projected post-redemption rent calculation
- **Modify:** `packages/engine/src/__tests__/bot.test.ts` — add redeem tests, update the existing "managing → end_turn" test
- **Modify:** `packages/engine/src/__tests__/rent.test.ts` — cover normal/station/utility projected rent semantics

---

### Task 1: Add redeem ranking helper tests

**Files:**
- Test: `packages/engine/src/__tests__/bot.test.ts`

- [ ] **Step 1: Write failing tests for the managing redeem branch**

Add these tests inside the existing `describe('chooseBotIntent ...')` block in `bot.test.ts`. They use the existing helper functions (`makeBotGame`, `setPlayer`, `withProp`, `setCurrent`) and board data (`boardData`, `cellPrice`).

First, add a helper to find a normal property cell with known rents:

```typescript
// Find a normal property cell and its bare-land rent (rents[0]).
function normalPropertyCell(id?: number) {
  const cell = id !== undefined
    ? boardData.cells.find((c) => c.id === id)
    : boardData.cells.find((c) => c.type === 'property' && c.subtype === 'normal');
  if (!cell || cell.type !== 'property' || cell.subtype !== 'normal') throw new Error('no normal property cell');
  return cell;
}

function cellMortgageValue(id: number) {
  const cell = boardData.cells.find((c) => c.id === id);
  if (!cell || cell.type !== 'property') throw new Error(`cell ${id} not property`);
  return cell.mortgageValue;
}

function redeemCost(state: GameState, cellId: number) {
  return Math.round(cellMortgageValue(cellId) * (1 + gameConfig.mortgageInterestRate));
}
```

Then add these test cases:

```typescript
it('managing（有已抵押地，现金充足）→ 按过路费从高到低赎回', () => {
  // Use two normal property cells. Pick cells with different rents[0].
  const normals = boardData.cells.filter(
    (c): c is typeof c & { type: 'property'; subtype: 'normal'; rents: number[] } =>
      c.type === 'property' && c.subtype === 'normal' && typeof (c as { rents?: number[] }).rents?.[0] === 'number',
  );
  const expensive = normals.reduce((best, c) => ((c as { rents: number[] }).rents[0] > (best as { rents: number[] }).rents[0] ? c : best));
  const cheap = normals.find((c) => c.id !== expensive.id && (c as { rents: number[] }).rents[0] < (expensive as { rents: number[] }).rents[0])!;

  let s = makeBotGame(2);
  s = setCurrent({ ...s, turnPhase: 'managing' });
  s = withProp(s, expensive.id, { ownerId: 'p1', level: 0, mortgaged: true });
  s = withProp(s, cheap.id, { ownerId: 'p1', level: 0, mortgaged: true });
  s = setPlayer(s, 'p1', { cash: 99999 });

  const intent = chooseBotIntent(s, 'p1');
  expect(intent).toEqual({ type: 'redeem_property', cellId: expensive.id });
});

it('managing（赎回后现金不足 ¥1,000）→ 跳过赎回，结束回合', () => {
  const cell = normalPropertyCell() as { id: number; mortgageValue: number };
  let s = makeBotGame(2);
  s = setCurrent({ ...s, turnPhase: 'managing' });
  s = withProp(s, cell.id, { ownerId: 'p1', level: 0, mortgaged: true });
  // Set cash so that after redeem, less than 1000 remains
  s = setPlayer(s, 'p1', { cash: redeemCost(s, cell.id) + 500 });

  const intent = chooseBotIntent(s, 'p1');
  expect(intent).toEqual({ type: 'end_turn' });
});

it('managing（赎回后现金恰好 ¥1,000）→ 仍可赎回', () => {
  const cell = normalPropertyCell() as { id: number; mortgageValue: number };
  let s = makeBotGame(2);
  s = setCurrent({ ...s, turnPhase: 'managing' });
  s = withProp(s, cell.id, { ownerId: 'p1', level: 0, mortgaged: true });
  s = setPlayer(s, 'p1', { cash: redeemCost(s, cell.id) + 1000 });

  const intent = chooseBotIntent(s, 'p1');
  expect(intent).toEqual({ type: 'redeem_property', cellId: cell.id });
});

it('managing（无已抵押地）→ end_turn（保持现有行为）', () => {
  const s = setCurrent({ ...makeBotGame(2), turnPhase: 'managing' });
  const intent = chooseBotIntent(s, 'p1');
  expect(intent).toEqual({ type: 'end_turn' });
});

it('managing（已抵押地属于他人）→ 不赎回，结束回合', () => {
  const cell = normalPropertyCell() as { id: number; mortgageValue: number };
  let s = makeBotGame(2);
  s = setCurrent({ ...s, turnPhase: 'managing' });
  s = withProp(s, cell.id, { ownerId: 'p2', level: 0, mortgaged: true });
  s = setPlayer(s, 'p1', { cash: 99999 });

  const intent = chooseBotIntent(s, 'p1');
  expect(intent).toEqual({ type: 'end_turn' });
});

it('managing（预计过路费相同）→ 赎回价低的优先', () => {
  // 在测试 state 中克隆两个 normal cell，并显式设置相同 rents[0]、不同 mortgageValue。
  // 不得依赖生产数据恰好存在同租金组合，也不得在找不到组合时提前 return。
});

it('managing（预计过路费和赎回价都相同）→ cell ID 小的优先', () => {
  // 在测试 state 中构造完全相同的 rent/cost，确定性断言 cell ID tie-break。
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run packages/engine/src/__tests__/bot.test.ts`
Expected: FAIL — bot still returns `end_turn` for all managing cases, and the existing "managing → end_turn" test for the case without mortgaged properties still passes.

---

### Task 2: Update the existing "managing → end_turn" test

**Files:**
- Test: `packages/engine/src/__tests__/bot.test.ts`

- [ ] **Step 1: Narrow the existing test**

The existing test `it('managing（无债务）→ end_turn', ...)` currently asserts that ALL managing states return `end_turn`. After the change, managing with no mortgaged properties still returns `end_turn`, but managing WITH redeemable mortgaged properties returns `redeem_property`. Update the test description to be precise:

```typescript
it('managing（无已抵押地、无债务）→ end_turn', () => {
  const s = setCurrent({ ...makeBotGame(2), turnPhase: 'managing' });
  expect(chooseBotIntent(s, 'p1')).toEqual({ type: 'end_turn' });
});
```

- [ ] **Step 2: Run tests to confirm this one still passes**

Run: `pnpm exec vitest run packages/engine/src/__tests__/bot.test.ts`
Expected: PASS for this test, FAIL for the new redeem tests from Task 1.

---

### Task 3: Implement the redeem logic in bot.ts

**Files:**
- Modify: `packages/engine/src/bot.ts`

- [ ] **Step 1: Add the redeem reserve constant and import**

At the top of `bot.ts`, update the import from selectors and add the reserve constant:

```typescript
import { canBuyProperty, canBuild, getSellableAssets, getCurrentRent } from './selectors';
```

Add a constant for the minimum cash floor after redemption:

```typescript
/** 赎回后至少保留的现金安全垫（用户定案 2026-07-15） */
const BOT_REDEEM_RESERVE = 1000;
```

- [ ] **Step 2: Add the projected-rent helper**

Add this function after `cellValue`:

```typescript
/** 计算某格赎回后立即产生的过路费（用假设未抵押状态调用 getCurrentRent） */
function projectedRentAfterRedeem(
  state: GameState,
  cellId: number,
): number {
  const prop = state.properties[cellId];
  if (!prop) return 0;
  const hypothetical: GameState = {
    ...state,
    properties: {
      ...state.properties,
      [cellId]: { ...prop, mortgaged: false },
    },
  };
  return getCurrentRent(hypothetical, cellId);
}
```

- [ ] **Step 3: Add the redeem candidate selector**

Add this function:

```typescript
/** 在无债务 managing 阶段，选出最优赎回目标。
 *  规则：赎回后现金 ≥ BOT_REDEEM_RESERVE；按赎回后过路费降序、赎回价升序、cellId 升序。 */
function chooseRedeemIntent(
  state: GameState,
  playerId: string,
): Intent | null {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return null;

  let bestCellId = -1;
  let bestRent = -1;
  let bestCost = Infinity;

  for (const cell of state.board.cells) {
    if (cell.type !== 'property') continue;
    const prop = state.properties[cell.id];
    if (!prop || prop.ownerId !== playerId || !prop.mortgaged) continue;
    if (typeof cell.mortgageValue !== 'number') continue;

    const cost = Math.round(cell.mortgageValue * (1 + state.config.mortgageInterestRate));
    if (player.cash - cost < BOT_REDEEM_RESERVE) continue;

    const rent = projectedRentAfterRedeem(state, cell.id);

    if (
      rent > bestRent ||
      (rent === bestRent && cost < bestCost) ||
      (rent === bestRent && cost === bestCost && (bestCellId === -1 || cell.id < bestCellId))
    ) {
      bestCellId = cell.id;
      bestRent = rent;
      bestCost = cost;
    }
  }

  if (bestCellId === -1) return null;
  return { type: 'redeem_property', cellId: bestCellId };
}
```

- [ ] **Step 4: Update the managing branch**

Replace the `managing` case in the `switch` block:

Before:
```typescript
    case 'managing':
      return { type: 'end_turn' };
```

After:
```typescript
    case 'managing': {
      const redeem = chooseRedeemIntent(state, playerId);
      if (redeem) return redeem;
      return { type: 'end_turn' };
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run packages/engine/src/__tests__/bot.test.ts`
Expected: ALL PASS (including the new redeem tests and the narrowed existing test).

---

### Task 4: Full engine test suite and simulation

**Files:** None (verification only)

- [ ] **Step 1: Run the full engine test suite**

Run: `pnpm exec vitest run packages/engine/`
Expected: ALL tests pass. The redeem tests are new; all existing engine tests (mortgage, debt, bankruptcy, end_turn, simulation) must remain green.

- [ ] **Step 2: Run the 500-game self-play simulation**

Run: `pnpm --filter @richman/engine simulate:500`
Expected: Simulation completes without errors. Bots now redeem properties, which may slightly change game outcomes but must not produce illegal intents or crashes.

- [ ] **Step 3: Run the full project test suite**

Run: `pnpm test`
Expected: ALL test files pass. No regressions in client, server, or protocol tests.

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/bot.ts packages/engine/src/__tests__/bot.test.ts
git commit -m "feat(bot): actively redeem mortgaged properties by projected rent

Bot now redeems mortgaged properties during the non-debt managing phase,
prioritizing by post-redemption rent (highest first), then redeem cost
(lowest first), then cell ID. Preserves at least ¥1,000 cash after each
redemption. Previously the bot only mortgaged during debt and never
redeemed, leaving properties permanently mortgaged."
```
