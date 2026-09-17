# M2 Step 9 Debt & Bankruptcy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 01 §11 debt fundraising and bankruptcy for the hotseat rule engine, covering E12-E15 and E17.

**Architecture:** Keep `applyIntent` pure and deterministic. Debt remains a single active `DebtState`; multi-payment cards are represented as a small pending debt queue in `GameState`, so the engine freezes on one debtor at a time, then resumes the queued payments after that debt is resolved or that debtor bankrupts. Existing sell-house/sell-property handlers become debt-aware and immediately settle if cash becomes sufficient.

**Tech Stack:** TypeScript, Vitest, pnpm monorepo, `@richman/engine` pure functions.

---

## File Map

- Modify `packages/engine/src/types.ts`
  - Extend `DebtState` with `resume?: DebtResumeState` for queued multi-payment cards.
  - Keep existing fields (`debtorId`, `creditorId`, `amount`) compatible.
- Modify `packages/engine/src/effects.ts`
  - Fix `receive_from_each_player` and `pay_each_player` to enter debt for the first underfunded payment instead of erasing shortfalls.
  - Reuse an exported queued-payment helper, but keep it small.
- Create `packages/engine/src/payments.ts`
  - Shared helper `processQueuedPayments(...)` used by both `effects.ts` and `engine.ts`.
- Modify `packages/engine/src/engine.ts`
  - Let debt debtor operate even when debtor is not `currentPlayerId`.
  - Auto-settle debt after sell-house/sell-property if debtor cash is sufficient.
  - Implement `declare_bankrupt`.
  - After resolving/ bankrupting a queued debtor, continue pending payments according to owner decision A: for `receive_from_each_player`, if one payer bankrupts, continue collecting from later players.
  - If the current turn player bankrupts and game is not over, automatically emit `turn_ended` / `turn_started`, advance to the next non-bankrupt player, and set `turnPhase='awaiting_roll'`.
  - End game if only one non-bankrupt player remains.
- Add `packages/engine/src/__tests__/debt_bankruptcy.test.ts`
  - RED tests for E12-E15/E17.
- Modify docs:
  - `plan/01-游戏规则规格书.md`: add one-line airport-trigger deviation note.
  - `plan/03-架构与联机协议.md`: add server-side warning to catch engine exceptions, especially effect-depth errors.
  - `.slim/deepwork/phase1-hotseat.md`: record step 8b commit and step 9 owner decision A.

---

## Task 1: RED tests for simple debt resolution and bankruptcy

**Files:**
- Create: `packages/engine/src/__tests__/debt_bankruptcy.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { createGame, applyIntent } from '../engine';
import { boardData, cardsData, gameConfig } from '@richman/board-data';
import type { GameState, PropertyState } from '../types';

function makeStarted(players = ['p1', 'p2', 'p3']): GameState {
  return createGame({
    board: boardData,
    cards: cardsData,
    config: gameConfig,
    players: players.map((id) => ({ id, nickname: id })),
    seed: 'debt-bankruptcy-test',
  });
}

function player(s: GameState, id: string) {
  return s.players.find((p) => p.id === id)!;
}

function withProperty(
  s: GameState,
  cellId: number,
  ownerId: string,
  opts: { level?: number; mortgaged?: boolean } = {},
): GameState {
  const prop: PropertyState = { ownerId, level: opts.level ?? 0, mortgaged: opts.mortgaged ?? false };
  return { ...s, properties: { ...s.properties, [cellId]: prop } };
}

describe('债务与破产（01 §11） // M2 step9', () => {
  it('E12: 债务状态下卖房后现金足额，立即支付债主并恢复 managing', () => {
    let s = makeStarted(['p1', 'p2']);
    s = withProperty(s, 2, 'p1', { level: 2 }); // 福建 houseCost=1500，卖一幢返 750
    s = {
      ...s,
      currentPlayerId: 'p1',
      turnPhase: 'managing',
      debt: { debtorId: 'p1', creditorId: 'p2', amount: 700 },
      players: s.players.map((p) => (p.id === 'p1' ? { ...p, cash: 0 } : p)),
    };
    const creditorBefore = player(s, 'p2').cash;
    const r = applyIntent(s, 'p1', { type: 'sell_house', cellId: 2 });
    if (!r.ok) throw new Error('fail');
    expect(r.state.debt).toBeNull();
    expect(player(r.state, 'p1').cash).toBe(50);
    expect(player(r.state, 'p2').cash).toBe(creditorBefore + 700);
    expect(r.events.some((e) => e.type === 'debt_resolved')).toBe(true);
    expect(r.state.turnPhase).toBe('managing');
  });

  it('E13: 欠玩家且全部变现仍不足时可破产，现金给债主，地产全部变无主', () => {
    let s = makeStarted(['p1', 'p2']);
    s = withProperty(s, 2, 'p1', { level: 0 });
    s = withProperty(s, 6, 'p1', { level: 0 });
    s = {
      ...s,
      currentPlayerId: 'p1',
      turnPhase: 'managing',
      debt: { debtorId: 'p1', creditorId: 'p2', amount: 999999 },
      players: s.players.map((p) => (p.id === 'p1' ? { ...p, cash: 123 } : p)),
    };
    const creditorBefore = player(s, 'p2').cash;
    const r = applyIntent(s, 'p1', { type: 'declare_bankrupt' });
    if (!r.ok) throw new Error('fail');
    expect(player(r.state, 'p1').bankrupt).toBe(true);
    expect(player(r.state, 'p1').cash).toBe(0);
    expect(player(r.state, 'p2').cash).toBe(creditorBefore + 123);
    expect(r.state.properties[2].ownerId).toBeNull();
    expect(r.state.properties[6].ownerId).toBeNull();
    expect(r.state.debt).toBeNull();
    expect(r.events.some((e) => e.type === 'player_bankrupt')).toBe(true);
  });

  it('E14: 欠银行破产时现金缴银行，地产同样变无主', () => {
    let s = makeStarted(['p1', 'p2']);
    s = withProperty(s, 2, 'p1', { level: 0 });
    s = {
      ...s,
      currentPlayerId: 'p1',
      turnPhase: 'managing',
      debt: { debtorId: 'p1', creditorId: null, amount: 999999 },
      players: s.players.map((p) => (p.id === 'p1' ? { ...p, cash: 123 } : p)),
    };
    const r = applyIntent(s, 'p1', { type: 'declare_bankrupt' });
    if (!r.ok) throw new Error('fail');
    expect(player(r.state, 'p1').bankrupt).toBe(true);
    expect(player(r.state, 'p1').cash).toBe(0);
    expect(r.state.properties[2].ownerId).toBeNull();
    expect(r.events.find((e) => e.type === 'player_bankrupt')).toMatchObject({ creditorId: null });
  });
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
pnpm vitest run packages/engine/src/__tests__/debt_bankruptcy.test.ts
```

Expected: tests fail because `declare_bankrupt` returns `WRONG_PHASE` and sell handlers do not auto-settle debt.

---

## Task 2: GREEN simple debt settlement and bankruptcy

**Files:**
- Modify: `packages/engine/src/engine.ts`
- Test: `packages/engine/src/__tests__/debt_bankruptcy.test.ts`

- [ ] **Step 1: Implement helpers**

Add internal helpers near sell handlers:

```ts
function payDebtIfPossible(state: GameState, events: GameEvent[]): { state: GameState; events: GameEvent[] } {
  if (!state.debt) return { state, events };
  const debt = state.debt;
  const debtor = state.players.find((p) => p.id === debt.debtorId)!;
  if (debtor.cash < debt.amount) return { state, events };
  const players = state.players.map((p) => {
    if (p.id === debt.debtorId) return { ...p, cash: p.cash - debt.amount };
    if (debt.creditorId && p.id === debt.creditorId) return { ...p, cash: p.cash + debt.amount };
    return p;
  });
  return { state: { ...state, players, debt: null, turnPhase: 'managing' }, events: [...events, { type: 'debt_resolved' }] };
}

function clearPlayerProperties(state: GameState, playerId: string): GameState['properties'] {
  const properties = { ...state.properties };
  for (const [cellId, prop] of Object.entries(properties)) {
    if (prop.ownerId === playerId) properties[Number(cellId)] = { ownerId: null, level: 0, mortgaged: false };
  }
  return properties;
}
```

- [ ] **Step 2: Wire debt auto-settle after sell handlers**

In `handleSellHouse` and `handleSellProperty`, after constructing `newState`, call `payDebtIfPossible(newState, events)` and return that result.

- [ ] **Step 3: Implement `handleDeclareBankrupt` and route it**

Replace the `declare_bankrupt` case with a handler. Handler should:
- Require `state.debt` and `state.debt.debtorId === playerId`.
- Transfer remaining cash to `creditorId` if creditor is a player; bank receives nothing in state.
- Set debtor cash to 0 and bankrupt true.
- Clear all debtor properties to ownerId null, level 0, mortgaged false.
- Clear `state.debt`.
- Emit `player_bankrupt`.
- If one non-bankrupt player remains, set `phase='game_over'`, `winnerId`, emit `game_over` (E17 minimal).
- If game is not over and debtor was `currentPlayerId`, immediately end that bankrupt player's turn: emit `turn_ended(debtor)` then `turn_started(nextAlive)`, set `currentPlayerId=nextAlive`, `turnPhase='awaiting_roll'`, and increment `turn` by 1.
- If game is not over and debtor was not `currentPlayerId`, keep `currentPlayerId` unchanged and return to `managing` for the original player's turn.

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
pnpm vitest run packages/engine/src/__tests__/debt_bankruptcy.test.ts packages/engine/src/__tests__/sell.test.ts packages/engine/src/__tests__/end_turn.test.ts
```

Expected: all selected tests pass.

---

## Task 3: RED/GREEN non-current debtor can resolve debt

**Files:**
- Modify: `packages/engine/src/__tests__/debt_bankruptcy.test.ts`
- Modify: `packages/engine/src/engine.ts`

- [ ] **Step 1: Write failing test**

Add:

```ts
it('债务人不是 currentPlayerId 时，债务人仍可卖产筹款', () => {
  let s = makeStarted(['p1', 'p2', 'p3']);
  s = withProperty(s, 2, 'p2', { level: 1 });
  s = {
    ...s,
    currentPlayerId: 'p1',
    turnPhase: 'managing',
    debt: { debtorId: 'p2', creditorId: 'p1', amount: 500 },
    players: s.players.map((p) => (p.id === 'p2' ? { ...p, cash: 0 } : p)),
  };
  const r = applyIntent(s, 'p2', { type: 'sell_house', cellId: 2 });
  if (!r.ok) throw new Error('fail');
  expect(r.state.debt).toBeNull();
  expect(player(r.state, 'p1').cash).toBe(15500);
  expect(r.state.currentPlayerId).toBe('p1'); // 债务临时由 p2 处理，但回合仍属于 p1
});
```

- [ ] **Step 2: Verify RED**

Expected failure: `NOT_YOUR_TURN`.

- [ ] **Step 3: Minimal implementation**

Change `applyIntent` global validation:

```ts
if (state.debt) {
  if (playerId !== state.debt.debtorId) return { ok: false, code: 'NOT_YOUR_TURN' };
} else if (playerId !== state.currentPlayerId) {
  return { ok: false, code: 'NOT_YOUR_TURN' };
}
```

Keep debt-phase allowed intents to `sell_house`, `sell_property`, `declare_bankrupt`.

- [ ] **Step 4: Run selected tests**

Run debt/sell/end_turn tests. Expected: pass.

---

## Task 4: RED/GREEN multi-payment cards and owner decision A

**Files:**
- Modify: `packages/engine/src/types.ts`
- Create: `packages/engine/src/payments.ts`
- Modify: `packages/engine/src/effects.ts`
- Modify: `packages/engine/src/engine.ts`
- Modify: `packages/engine/src/__tests__/debt_bankruptcy.test.ts`

- [ ] **Step 1: Extend `DebtState` type**

```ts
export interface QueuedPayment {
  debtorId: string;
  creditorId: string | null;
  amount: number;
}

export interface DebtResumeState {
  payments: QueuedPayment[];
}

export interface DebtState {
  debtorId: string;
  creditorId: string | null;
  amount: number;
  resume?: DebtResumeState;
}
```

- [ ] **Step 2: Write failing tests**

Add tests:

```ts
import { applyCardEffect } from '../effects';

it('E15/A: receive_from_each_player 某付款人现金不足进入该付款人债务，后续付款排队', () => {
  let s = makeStarted(['p1', 'p2', 'p3']);
  s = {
    ...s,
    players: s.players.map((p) => {
      if (p.id === 'p1') return { ...p, cash: 1000 };
      if (p.id === 'p2') return { ...p, cash: 300 };
      return { ...p, cash: 1000 };
    }),
  };
  const card = cardsData.chance.find((c) => c.id === '71-02')!; // 每人给 p1 500
  const r = applyCardEffect(s, 'p1', card, []);
  expect(r.newDebt).toMatchObject({ debtorId: 'p2', creditorId: 'p1', amount: 200 });
  expect(r.newDebt?.resume?.payments).toEqual([{ debtorId: 'p3', creditorId: 'p1', amount: 500 }]);
  expect(player(r.state, 'p1').cash).toBe(1300);
  expect(player(r.state, 'p2').cash).toBe(0);
  expect(r.events.filter((e) => e.type === 'debt_entered')).toHaveLength(1);
});

it('E15/A: receive_from_each_player 中一个付款人破产后继续收后续玩家', () => {
  let s = makeStarted(['p1', 'p2', 'p3']);
  s = {
    ...s,
    currentPlayerId: 'p1',
    turnPhase: 'managing',
    debt: { debtorId: 'p2', creditorId: 'p1', amount: 200, resume: { payments: [{ debtorId: 'p3', creditorId: 'p1', amount: 500 }] } },
    players: s.players.map((p) => {
      if (p.id === 'p2') return { ...p, cash: 0 };
      if (p.id === 'p3') return { ...p, cash: 1000 };
      return p;
    }),
  };
  const before = player(s, 'p1').cash;
  const r = applyIntent(s, 'p2', { type: 'declare_bankrupt' });
  if (!r.ok) throw new Error('fail');
  expect(player(r.state, 'p2').bankrupt).toBe(true);
  expect(player(r.state, 'p3').cash).toBe(500);
  expect(player(r.state, 'p1').cash).toBe(before + 500);
  expect(r.state.debt).toBeNull();
  const bankruptcyIdx = r.events.findIndex((e) => e.type === 'player_bankrupt' && (e as { playerId: string }).playerId === 'p2');
  expect(bankruptcyIdx).toBeGreaterThanOrEqual(0);
});

it('E15/A: 卖房还清当前付款人债务后，继续处理队列中的后续付款', () => {
  let s = makeStarted(['p1', 'p2', 'p3']);
  s = withProperty(s, 2, 'p2', { level: 1 });
  s = {
    ...s,
    currentPlayerId: 'p1',
    turnPhase: 'managing',
    debt: { debtorId: 'p2', creditorId: 'p1', amount: 200, resume: { payments: [{ debtorId: 'p3', creditorId: 'p1', amount: 500 }] } },
    players: s.players.map((p) => {
      if (p.id === 'p2') return { ...p, cash: 0 };
      if (p.id === 'p3') return { ...p, cash: 1000 };
      return p;
    }),
  };
  const before = player(s, 'p1').cash;
  const r = applyIntent(s, 'p2', { type: 'sell_house', cellId: 2 });
  if (!r.ok) throw new Error('fail');
  expect(r.state.debt).toBeNull();
  expect(player(r.state, 'p1').cash).toBe(before + 200 + 500);
  expect(player(r.state, 'p3').cash).toBe(500);
  const resolvedIdx = r.events.findIndex((e) => e.type === 'debt_resolved');
  expect(resolvedIdx).toBeGreaterThanOrEqual(0);
});

it('E15: pay_each_player 当前付款人破产后，后续收款人不再收到付款', () => {
  let s = makeStarted(['p1', 'p2', 'p3']);
  s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, cash: 300 } : p)) };
  const synthetic = { id: 'synthetic-pay-each', effect: { type: 'pay_each_player', amount: 500 } as CellEffect };
  const r = applyCardEffect(s, 'p1', synthetic, []);
  expect(r.newDebt).toMatchObject({ debtorId: 'p1', creditorId: 'p2', amount: 200 });
  expect(r.newDebt?.resume?.payments).toEqual([{ debtorId: 'p1', creditorId: 'p3', amount: 500 }]);
  const bankrupt = applyIntent({ ...r.state, currentPlayerId: 'p1', turnPhase: 'managing', debt: r.newDebt }, 'p1', { type: 'declare_bankrupt' });
  if (!bankrupt.ok) throw new Error('fail');
  expect(player(bankrupt.state, 'p3').cash).toBe(15000); // p1 已破产，后续付款停止
});
```

- [ ] **Step 3: Implement shared queued payment processing**

Create `packages/engine/src/payments.ts`:

```ts
import type { GameState, GameEvent, DebtState, QueuedPayment } from './types';

export interface PaymentResult {
  state: GameState;
  events: GameEvent[];
  newDebt: DebtState | null;
}

function processPayments(
  state: GameState,
  payments: QueuedPayment[],
  events: GameEvent[],
): PaymentResult {
  let s = state;
  let evts = events;
  for (let i = 0; i < payments.length; i++) {
    const payment = payments[i];
    const debtor = s.players.find((p) => p.id === payment.debtorId)!;
    if (debtor.bankrupt) continue;
    const paid = Math.min(debtor.cash, payment.amount);
    s = { ...s, players: s.players.map((p) => {
      if (p.id === payment.debtorId) return { ...p, cash: p.cash - paid };
      if (payment.creditorId && p.id === payment.creditorId) return { ...p, cash: p.cash + paid };
      return p;
    }) };
    if (paid < payment.amount) {
      const debt = { debtorId: payment.debtorId, creditorId: payment.creditorId, amount: payment.amount - paid, resume: { payments: payments.slice(i + 1) } };
      evts = [...evts, { type: 'debt_entered', debtorId: debt.debtorId, amount: debt.amount, creditorId: debt.creditorId }];
      return { state: s, events: evts, newDebt: debt };
    }
  }
  return { state: s, events: evts, newDebt: null };
}
```

Export it as `processQueuedPayments` and import it from `effects.ts` and `engine.ts`.

Use it for `receive_from_each_player`: build one payment per non-bankrupt other player in seat order, creditor = current player.

Use it for `pay_each_player`: build one payment per non-bankrupt other player, debtor = current player, creditor = each other player. If current debtor bankrupts later, queued payments naturally stop because the same debtor is bankrupt; no additional payments are processed.

- [ ] **Step 4: Continue queued payments after debt resolution / bankruptcy**

In `engine.ts`, after `debt_resolved` or `player_bankrupt`, call `processQueuedPayments` with `debt.resume.payments` and either clear debt or enter the next one. If a queued payer is already bankrupt, skip them; this implements owner decision A for receive-from-each-player. Also update `payDebtIfPossible`: after paying the current debt and emitting `debt_resolved`, it must immediately process `debt.resume.payments` before returning.

- [ ] **Step 5: Verify GREEN**

Run debt/cards tests. Expected pass.

---

## Task 5: E17 end-turn/game-over behavior

**Files:**
- Modify: `packages/engine/src/__tests__/debt_bankruptcy.test.ts`
- Modify: `packages/engine/src/engine.ts`

- [ ] **Step 1: Write failing tests**

```ts
it('E17: 破产玩家在轮转中被跳过', () => {
  const base = makeStarted(['p1', 'p2', 'p3']);
  const s = { ...base, currentPlayerId: 'p1', turnPhase: 'managing' as const,
    players: base.players.map((p) => (p.id === 'p2' ? { ...p, bankrupt: true } : p)) };
  const r = applyIntent(s, 'p1', { type: 'end_turn' });
  if (!r.ok) throw new Error('fail');
  expect(r.state.currentPlayerId).toBe('p3');
});

it('E17: 多人局当前玩家破产后，自动结束其回合并轮到下一位存活玩家', () => {
  const base = makeStarted(['p1', 'p2', 'p3']);
  const s = { ...base, currentPlayerId: 'p1', turnPhase: 'managing' as const,
    debt: { debtorId: 'p1', creditorId: 'p2', amount: 999999 } };
  const r = applyIntent(s, 'p1', { type: 'declare_bankrupt' });
  if (!r.ok) throw new Error('fail');
  expect(r.state.phase).toBe('playing');
  expect(r.state.currentPlayerId).toBe('p2');
  expect(r.state.turnPhase).toBe('awaiting_roll');
  expect(r.events.some((e) => e.type === 'turn_ended' && (e as { playerId: string }).playerId === 'p1')).toBe(true);
  expect(r.events.some((e) => e.type === 'turn_started' && (e as { playerId: string }).playerId === 'p2')).toBe(true);
});

it('E17: 2 人局一人破产即终局，另一人为胜者', () => {
  const s = { ...makeStarted(['p1', 'p2']), currentPlayerId: 'p1', turnPhase: 'managing' as const,
    debt: { debtorId: 'p1', creditorId: 'p2', amount: 999999 } };
  const r = applyIntent(s, 'p1', { type: 'declare_bankrupt' });
  if (!r.ok) throw new Error('fail');
  expect(r.state.phase).toBe('game_over');
  expect(r.state.winnerId).toBe('p2');
  expect(r.events.some((e) => e.type === 'game_over')).toBe(true);
});
```

- [ ] **Step 2: Implement / adjust**

`handleEndTurn` already skips bankrupt players; add a guard in bankruptcy helper to emit `game_over` when alive count is 1.

- [ ] **Step 3: Verify**

Run debt/end_turn tests.

---

## Task 6: Documentation notes requested by owner

**Files:**
- Modify: `plan/01-游戏规则规格书.md`
- Modify: `plan/03-架构与联机协议.md`
- Modify: `.slim/deepwork/phase1-hotseat.md`

- [ ] **Step 1: Add 01 note**

At the end/deviation notes in `plan/01-游戏规则规格书.md`, add:

```md
- 2026-07-06 实现备注：机场支线触发目前仅限“普通掷骰后停留机场”。本棋盘无卡牌/效果会移动到机场；未来地图若允许卡牌落机场，是否也触发支线需再由 owner 定。
```

- [ ] **Step 2: Add 03 server note**

Near server authoritative model / implementation notes, add:

```md
- 阶段 2 服务器调用 `applyIntent` 时必须捕获引擎异常并转成安全错误响应（状态不变、房间不中断）。尤其是卡牌/格效果链式深度超限（例如数据配置成循环抽牌）会主动抛错，不能让单局进程崩溃。
- 本版 effect 链式深度上限为 8；当前卡组最深合法链未触顶。未来换地图/换卡组若加长合法链条，需要同步调高上限并补测试。
```

- [ ] **Step 3: Add deepwork note**

Record:
- Step 8b commit `b7ef9d8` completed.
- Step 9 owner decision A: receive_from_each_player payer bankruptcy does not stop later payers.
- Effect depth limit 8 is enough for current data but should be revisited for future maps/cards.

---

## Task 7: Final validation and review

**Files:** all touched files.

- [ ] **Step 1: Run targeted tests**

```bash
pnpm vitest run packages/engine/src/__tests__/debt_bankruptcy.test.ts packages/engine/src/__tests__/cards.test.ts packages/engine/src/__tests__/sell.test.ts packages/engine/src/__tests__/rent_payment.test.ts packages/engine/src/__tests__/tax.test.ts packages/engine/src/__tests__/end_turn.test.ts
```

- [ ] **Step 2: Run full validation**

```bash
pnpm test && pnpm typecheck && pnpm validate-data
```

- [ ] **Step 3: Ask @oracle for result review**

Review prompt should include: owner decision A, changed files, test outputs, and known remaining item that victory cash-goal E18 is step 10.

---

## Self-Review

- Spec coverage: E12/E13/E14/E15/E17 covered by tasks 1, 4, 5.
- Known non-goals: cash-goal victory E18 remains step 10; mortgage/redeem remains phase 3.
- Risk: queued debt state is the only type extension; keep it minimal and serializable.
