# M3-5 Asset Mortgage UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a current-player asset panel that lets players sell houses, mortgage eligible level-0 properties, and redeem mortgaged properties without changing engine rules.

**Architecture:** Keep rules in the engine and derive UI state through a pure client helper. `clientGame.ts` owns asset display rows, debt-state actor dispatch, and readable event messages. `AssetPanel.vue` renders the rows as a sibling to `ActionPanel.vue`, while `App.vue` wires actions to existing `sendIntent()`.

**Tech Stack:** TypeScript, Vue 3 `<script setup>`, Vitest, existing `@richman/engine`, `@richman/board-data`, and client CSS variables.

---

## Files

- Modify: `apps/client/src/game/clientGame.ts`
  - Add `AssetRow` interface.
  - Add exported `getAssetRows(state, playerId)` pure helper.
  - Add debt recovery intent allowlist.
  - Dispatch debt-state intents as `state.debt.debtorId`.
  - Add readable `house_sold`, `property_mortgaged`, and `property_redeemed` event messages.
- Modify: `apps/client/src/game/clientGame.test.ts`
  - Add RED/GREEN tests for asset rows, debt dispatch, and event messages.
- Create: `apps/client/src/components/AssetPanel.vue`
  - Render current actor assets and row action buttons.
- Modify: `apps/client/src/App.vue`
  - Import `AssetPanel`.
  - Compute active actor id, active actor name, debt amount, and asset rows.
  - Render `AssetPanel` below `ActionPanel`.
- Add docs already created:
  - `docs/superpowers/specs/2026-07-07-m3-5-asset-mortgage-ui-design.md`
  - `docs/superpowers/plans/2026-07-07-m3-5-asset-mortgage-ui.md`

Do not modify:

- `packages/engine/src/*`
- `packages/board-data/data/*`
- `apps/client/src/ui/boardLayout.ts`

---

## Task 1: RED tests for asset rows

**Files:**

- Modify: `apps/client/src/game/clientGame.test.ts`

- [ ] **Step 1: Add imports and helpers**

Update the import line to include `getAssetRows`:

```ts
import { createClientGame, getAssetRows, getAvailableActions, type ClientGame } from './clientGame';
```

Add these helpers after `placeCurrentPlayerForRoll()`:

```ts
function makeCurrentPlayerOwn(game: ClientGame, cellId: number, level = 0, mortgaged = false) {
  const ownerId = game.state.value.currentPlayerId;
  game.state.value = {
    ...game.state.value,
    turnPhase: 'managing',
    properties: {
      ...game.state.value.properties,
      [cellId]: { ownerId, level, mortgaged },
    },
  };
}

function currentActorId(game: ClientGame): string {
  return game.state.value.debt?.debtorId ?? game.state.value.currentPlayerId;
}
```

- [ ] **Step 2: Add failing asset-row tests**

Add this describe block after `describe('getAvailableActions', ...)`:

```ts
describe('getAssetRows', () => {
  it('lists current-player owned assets in board order', () => {
    const game = createClientGame({ wait: async () => undefined });
    const ownerId = game.state.value.currentPlayerId;
    game.state.value = {
      ...game.state.value,
      turnPhase: 'managing',
      properties: {
        ...game.state.value.properties,
        11: { ownerId, level: 0, mortgaged: false },
        2: { ownerId, level: 0, mortgaged: false },
      },
    };

    const rows = getAssetRows(game.state.value, ownerId);

    expect(rows.map((row) => row.cellId)).toEqual([2, 11]);
    expect(rows.map((row) => row.name)).toEqual(['福建省', '浙江省']);
  });

  it('marks properties with houses as sellable but not mortgageable', () => {
    const game = createClientGame({ wait: async () => undefined });
    makeCurrentPlayerOwn(game, 2, 2, false);

    const row = getAssetRows(game.state.value, currentActorId(game)).find((candidate) => candidate.cellId === 2);

    expect(row).toMatchObject({
      cellId: 2,
      level: 2,
      mortgaged: false,
      sellHouseRefund: 750,
      canSellHouse: true,
      canMortgage: false,
      mortgageReason: '需先卖房',
    });
  });

  it('marks level-0 unmortgaged properties as mortgageable', () => {
    const game = createClientGame({ wait: async () => undefined });
    makeCurrentPlayerOwn(game, 2, 0, false);

    const row = getAssetRows(game.state.value, currentActorId(game)).find((candidate) => candidate.cellId === 2);

    expect(row).toMatchObject({
      cellId: 2,
      mortgageValue: 1200,
      canSellHouse: false,
      sellHouseReason: '无房可卖',
      canMortgage: true,
      mortgageReason: null,
    });
  });

  it('marks mortgaged properties as redeemable only outside debt', () => {
    const game = createClientGame({ wait: async () => undefined });
    makeCurrentPlayerOwn(game, 2, 0, true);

    const row = getAssetRows(game.state.value, currentActorId(game)).find((candidate) => candidate.cellId === 2);

    expect(row).toMatchObject({
      cellId: 2,
      redeemCost: 1320,
      canMortgage: false,
      mortgageReason: '已抵押',
      canRedeem: true,
      redeemReason: null,
    });

    game.state.value = {
      ...game.state.value,
      debt: { debtorId: game.state.value.currentPlayerId, amount: 100, creditorId: null, resume: { payments: [] } },
    };

    const debtRow = getAssetRows(game.state.value, currentActorId(game)).find((candidate) => candidate.cellId === 2);

    expect(debtRow).toMatchObject({
      canRedeem: false,
      redeemReason: '债务中不可赎回',
    });
  });
});
```

- [ ] **Step 3: Run RED test**

Run:

```bash
pnpm vitest run apps/client/src/game/clientGame.test.ts
```

Expected: FAIL because `getAssetRows` is not exported from `clientGame.ts`.

---

## Task 2: Implement asset-row helper

**Files:**

- Modify: `apps/client/src/game/clientGame.ts`
- Test: `apps/client/src/game/clientGame.test.ts`

- [ ] **Step 1: Import board cell helpers**

Add imports near the top of `clientGame.ts`:

```ts
import type { PropertyCell } from '@richman/board-data';
import { getShortCellName } from '../ui/boardLayout';
```

- [ ] **Step 2: Add `AssetRow` interface**

Add after `DisplayCard`:

```ts
export interface AssetRow {
  cellId: number;
  name: string;
  displayName: string;
  subtype: PropertyCell['subtype'];
  level: number;
  mortgaged: boolean;
  mortgageValue: number | null;
  sellHouseRefund: number | null;
  redeemCost: number | null;
  canSellHouse: boolean;
  canMortgage: boolean;
  canRedeem: boolean;
  sellHouseReason: string | null;
  mortgageReason: string | null;
  redeemReason: string | null;
}
```

- [ ] **Step 3: Add money math helpers**

Add before `getAvailableActions()`:

```ts
function roundMoney(amount: number): number {
  return Math.round(amount);
}

function redeemCost(state: GameState, mortgageValue: number): number {
  return roundMoney(mortgageValue * (1 + state.config.mortgageInterestRate));
}
```

- [ ] **Step 4: Add `getAssetRows()`**

Add before `getAvailableActions()`:

```ts
export function getAssetRows(state: GameState, playerId: string): AssetRow[] {
  const player = state.players.find((candidate) => candidate.id === playerId);
  const isManaging = state.turnPhase === 'managing';
  const activeDebt = state.debt;
  const isActiveDebtor = !activeDebt || activeDebt.debtorId === playerId;

  return state.board.cells
    .filter((cell): cell is PropertyCell => cell.type === 'property')
    .flatMap((cell) => {
      const prop = state.properties[cell.id];
      if (!prop || prop.ownerId !== playerId) return [];

      const mortgageValue = typeof cell.mortgageValue === 'number' ? cell.mortgageValue : null;
      const sellHouseRefund = cell.subtype === 'normal' && typeof cell.houseCost === 'number'
        ? roundMoney(cell.houseCost * state.config.sellHouseRefundRate)
        : null;
      const currentRedeemCost = mortgageValue === null ? null : redeemCost(state, mortgageValue);
      const hasCashToRedeem = player ? currentRedeemCost !== null && player.cash >= currentRedeemCost : false;

      const canSellHouse = isManaging && isActiveDebtor && cell.subtype === 'normal' && prop.level > 0;
      const sellHouseReason = canSellHouse
        ? null
        : prop.level <= 0
          ? '无房可卖'
          : !isManaging || !isActiveDebtor
            ? '非当前阶段'
            : null;

      const canMortgage = isManaging && isActiveDebtor && prop.level === 0 && !prop.mortgaged && mortgageValue !== null;
      const mortgageReason = canMortgage
        ? null
        : prop.mortgaged
          ? '已抵押'
          : prop.level > 0
            ? '需先卖房'
            : !isManaging || !isActiveDebtor
              ? '非当前阶段'
              : null;

      const canRedeem = isManaging && !activeDebt && prop.mortgaged && hasCashToRedeem;
      const redeemReason = canRedeem
        ? null
        : activeDebt
          ? '债务中不可赎回'
          : !prop.mortgaged
            ? '未抵押'
            : !isManaging
              ? '非当前阶段'
              : !hasCashToRedeem
                ? '现金不足'
                : null;

      return [{
        cellId: cell.id,
        name: cell.name,
        displayName: getShortCellName(cell),
        subtype: cell.subtype,
        level: prop.level,
        mortgaged: prop.mortgaged,
        mortgageValue,
        sellHouseRefund,
        redeemCost: currentRedeemCost,
        canSellHouse,
        canMortgage,
        canRedeem,
        sellHouseReason,
        mortgageReason,
        redeemReason,
      }];
    });
}
```

- [ ] **Step 5: Run GREEN test**

Run:

```bash
pnpm vitest run apps/client/src/game/clientGame.test.ts
```

Expected: PASS for the new asset-row tests and existing client tests.

---

## Task 3: RED tests for debt dispatch and event messages

**Files:**

- Modify: `apps/client/src/game/clientGame.test.ts`

- [ ] **Step 1: Add failing debt dispatch tests**

Add these tests inside `describe('createClientGame', ...)`, after the existing debt refusal test:

```ts
  it('allows active debtor to mortgage during debt using debt.debtorId as actor', async () => {
    const game = createClientGame({ wait: async () => undefined });
    const debtorId = 'p2';
    game.state.value = {
      ...game.state.value,
      currentPlayerId: 'p1',
      turnPhase: 'managing',
      debt: { debtorId, amount: 500, creditorId: null, resume: { payments: [] } },
      players: game.state.value.players.map((player) =>
        player.id === debtorId ? { ...player, cash: 0 } : player,
      ),
      properties: {
        ...game.state.value.properties,
        2: { ownerId: debtorId, level: 0, mortgaged: false },
      },
    };

    await game.sendIntent({ type: 'mortgage_property', cellId: 2 });

    expect(game.lastError.value).toBeNull();
    expect(game.state.value.properties[2]?.mortgaged).toBe(true);
    expect(game.eventMessage.value).toContain('抵押');
    expect(game.eventMessage.value).not.toBe('property_mortgaged');
  });

  it('allows active debtor to sell a house during debt', async () => {
    const game = createClientGame({ wait: async () => undefined });
    const debtorId = 'p2';
    game.state.value = {
      ...game.state.value,
      currentPlayerId: 'p1',
      turnPhase: 'managing',
      debt: { debtorId, amount: 5000, creditorId: null, resume: { payments: [] } },
      properties: {
        ...game.state.value.properties,
        2: { ownerId: debtorId, level: 2, mortgaged: false },
      },
    };

    await game.sendIntent({ type: 'sell_house', cellId: 2 });

    expect(game.lastError.value).toBeNull();
    expect(game.state.value.properties[2]?.level).toBe(1);
    expect(game.eventMessage.value).toContain('卖出');
    expect(game.eventMessage.value).not.toBe('house_sold');
  });

  it('keeps redeem blocked during debt with a clear message', async () => {
    const game = createClientGame({ wait: async () => undefined });
    const debtorId = game.state.value.currentPlayerId;
    game.state.value = {
      ...game.state.value,
      turnPhase: 'managing',
      debt: { debtorId, amount: 500, creditorId: null, resume: { payments: [] } },
      properties: {
        ...game.state.value.properties,
        2: { ownerId: debtorId, level: 0, mortgaged: true },
      },
    };

    await game.sendIntent({ type: 'redeem_property', cellId: 2 });

    expect(game.state.value.properties[2]?.mortgaged).toBe(true);
    expect(game.lastError.value).toBe('资金不足，请先卖房或抵押资产');
  });
```

- [ ] **Step 2: Add failing redeem message test**

Add after the mortgage debt test or near other event-message tests:

```ts
  it('shows a readable message after redeeming a property', async () => {
    const game = createClientGame({ wait: async () => undefined });
    const ownerId = game.state.value.currentPlayerId;
    game.state.value = {
      ...game.state.value,
      turnPhase: 'managing',
      players: game.state.value.players.map((player) =>
        player.id === ownerId ? { ...player, cash: 5000 } : player,
      ),
      properties: {
        ...game.state.value.properties,
        2: { ownerId, level: 0, mortgaged: true },
      },
    };

    await game.sendIntent({ type: 'redeem_property', cellId: 2 });

    expect(game.lastError.value).toBeNull();
    expect(game.state.value.properties[2]?.mortgaged).toBe(false);
    expect(game.eventMessage.value).toContain('赎回');
    expect(game.eventMessage.value).not.toBe('property_redeemed');
  });
```

- [ ] **Step 3: Run RED test**

Run:

```bash
pnpm vitest run apps/client/src/game/clientGame.test.ts
```

Expected: FAIL because the current debt guard blocks debt actions and event messages fall back to raw event type strings.

---

## Task 4: Implement debt dispatch and readable events

**Files:**

- Modify: `apps/client/src/game/clientGame.ts`
- Test: `apps/client/src/game/clientGame.test.ts`

- [ ] **Step 1: Add debt allowlist helpers**

Add before `createClientGame()`:

```ts
function canSendDuringDebt(intent: Intent): boolean {
  return intent.type === 'sell_house' || intent.type === 'mortgage_property';
}

function debtBlockMessage(intent: Intent): string {
  return intent.type === 'redeem_property'
    ? '资金不足，请先卖房或抵押资产'
    : '资金不足，请先卖房或抵押资产';
}
```

- [ ] **Step 2: Replace the current debt guard and actor dispatch**

Replace this block in `sendIntent()`:

```ts
    if (state.value.debt) {
      lastError.value = '资金不足，债务处理将在下一切片接入';
      return;
    }

    lastError.value = null;
    const result = applyIntent(state.value, state.value.currentPlayerId, intent);
```

with:

```ts
    if (state.value.debt && !canSendDuringDebt(intent)) {
      lastError.value = debtBlockMessage(intent);
      return;
    }

    lastError.value = null;
    const actorId = state.value.debt?.debtorId ?? state.value.currentPlayerId;
    const result = applyIntent(state.value, actorId, intent);
```

- [ ] **Step 3: Add readable event cases**

Inside `playEvent()` switch, after `house_built` and before `rent_paid`, add:

```ts
      case 'house_sold': {
        const cell = state.value.board.cells.find((candidate) => candidate.id === event.cellId);
        const refund = cell?.type === 'property' && typeof cell.houseCost === 'number'
          ? Math.round(cell.houseCost * state.value.config.sellHouseRefundRate)
          : 0;
        eventMessage.value = `${cellName(state.value, event.cellId)} 卖出一级房屋，返还 ${money(refund)}`;
        await wait(DEFAULT_STEP_MS);
        return;
      }
      case 'property_mortgaged': {
        eventMessage.value = `${playerName(state.value, event.playerId)} 将 ${cellName(state.value, event.cellId)} 抵押给银行，获得 ${money(event.amount)}`;
        await wait(DEFAULT_STEP_MS);
        return;
      }
      case 'property_redeemed': {
        eventMessage.value = `${playerName(state.value, event.playerId)} 赎回 ${cellName(state.value, event.cellId)}，支付 ${money(event.amount)}`;
        await wait(DEFAULT_STEP_MS);
        return;
      }
```

- [ ] **Step 4: Run GREEN test**

Run:

```bash
pnpm vitest run apps/client/src/game/clientGame.test.ts
```

Expected: PASS for debt dispatch and readable event tests.

---

## Task 5: Build AssetPanel UI

**Files:**

- Create: `apps/client/src/components/AssetPanel.vue`
- Modify: `apps/client/src/App.vue`

- [ ] **Step 1: Create `AssetPanel.vue`**

Create `apps/client/src/components/AssetPanel.vue` with:

```vue
<script setup lang="ts">
import type { AssetRow, ClientAction } from '../game/clientGame';
import { formatMoney } from '../ui/format';

const props = defineProps<{
  actorName: string;
  debtAmount: number | null;
  assets: AssetRow[];
  isAnimating: boolean;
}>();

const emit = defineEmits<{
  action: [action: ClientAction];
}>();

function send(action: ClientAction) {
  if (props.isAnimating) return;
  emit('action', action);
}

function sellHouseAction(row: AssetRow): ClientAction {
  return { label: '卖房', intent: { type: 'sell_house', cellId: row.cellId } };
}

function mortgageAction(row: AssetRow): ClientAction {
  return { label: '抵押', intent: { type: 'mortgage_property', cellId: row.cellId } };
}

function redeemAction(row: AssetRow): ClientAction {
  return { label: '赎回', intent: { type: 'redeem_property', cellId: row.cellId } };
}
</script>

<template>
  <section class="asset-panel" aria-label="我的资产">
    <div class="asset-head">
      <div>
        <h2>我的资产</h2>
        <p>{{ actorName }}</p>
      </div>
      <strong v-if="debtAmount !== null" class="debt-pill">欠款 ¥{{ formatMoney(debtAmount) }}</strong>
    </div>

    <p v-if="assets.length === 0" class="empty-assets">暂无地产资产</p>

    <div v-else class="asset-list">
      <article v-for="row in assets" :key="row.cellId" class="asset-row" :class="{ mortgaged: row.mortgaged }">
        <div class="asset-main">
          <div>
            <strong>{{ row.displayName }}</strong>
            <span>{{ row.name }}</span>
          </div>
          <em v-if="row.mortgaged">已抵押</em>
          <em v-else-if="row.level >= 5">旅馆</em>
          <em v-else-if="row.level > 0">{{ row.level }}级房</em>
          <em v-else>裸地</em>
        </div>

        <dl class="asset-money">
          <div v-if="row.sellHouseRefund !== null && row.level > 0">
            <dt>卖房</dt>
            <dd>¥{{ formatMoney(row.sellHouseRefund) }}</dd>
          </div>
          <div v-if="row.mortgageValue !== null && !row.mortgaged">
            <dt>抵押</dt>
            <dd>¥{{ formatMoney(row.mortgageValue) }}</dd>
          </div>
          <div v-if="row.redeemCost !== null && row.mortgaged">
            <dt>赎回</dt>
            <dd>¥{{ formatMoney(row.redeemCost) }}</dd>
          </div>
        </dl>

        <div class="asset-actions">
          <button
            type="button"
            :disabled="isAnimating || !row.canSellHouse"
            :title="row.sellHouseReason ?? '卖出一级房屋'"
            :aria-label="`卖房 ${row.name}`"
            @click="send(sellHouseAction(row))"
          >
            {{ row.canSellHouse ? '卖房' : row.sellHouseReason }}
          </button>
          <button
            type="button"
            :disabled="isAnimating || !row.canMortgage"
            :title="row.mortgageReason ?? '抵押地产'"
            :aria-label="`抵押 ${row.name}`"
            @click="send(mortgageAction(row))"
          >
            {{ row.canMortgage ? '抵押' : row.mortgageReason }}
          </button>
          <button
            type="button"
            :disabled="isAnimating || !row.canRedeem"
            :title="row.redeemReason ?? '赎回地产'"
            :aria-label="`赎回 ${row.name}`"
            @click="send(redeemAction(row))"
          >
            {{ row.canRedeem ? '赎回' : row.redeemReason }}
          </button>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.asset-panel {
  padding: 12px;
  border: 1px solid var(--color-border);
  background: rgb(255 255 255 / 82%);
  border-radius: 16px;
}

.asset-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: start;
  margin-bottom: 10px;
}

.asset-head h2 {
  margin: 0;
  font-size: 1rem;
}

.asset-head p {
  margin: 3px 0 0;
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 800;
}

.debt-pill {
  padding: 4px 8px;
  border-radius: 999px;
  background: var(--color-primary);
  color: #fff;
  font-size: 12px;
  white-space: nowrap;
}

.empty-assets {
  margin: 0;
  color: var(--color-muted);
  font-size: 13px;
  font-weight: 700;
}

.asset-list {
  display: grid;
  gap: 8px;
  max-height: min(46vh, 420px);
  overflow-y: auto;
  padding-right: 2px;
}

.asset-row {
  padding: 9px;
  border: 1px solid var(--color-border);
  border-radius: 13px;
  background: rgb(255 255 255 / 72%);
}

.asset-row.mortgaged {
  background: rgb(136 133 120 / 13%);
}

.asset-main {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: start;
}

.asset-main strong {
  display: block;
  color: var(--color-primary);
  font-size: 14px;
}

.asset-main span {
  display: block;
  color: var(--color-muted);
  font-size: 11px;
  font-weight: 700;
}

.asset-main em {
  flex: 0 0 auto;
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--button-disabled-bg);
  color: var(--button-disabled-text);
  font-size: 11px;
  font-style: normal;
  font-weight: 900;
}

.asset-money {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 5px;
  margin: 8px 0;
}

.asset-money div {
  padding: 5px;
  border-radius: 9px;
  background: var(--board-surface);
}

.asset-money dt,
.asset-money dd {
  margin: 0;
  font-size: 11px;
}

.asset-money dt {
  color: var(--color-muted);
  font-weight: 800;
}

.asset-money dd {
  color: var(--color-text);
  font-weight: 900;
  font-variant-numeric: tabular-nums;
}

.asset-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 5px;
}

.asset-actions button {
  min-width: 0;
  border: 0;
  border-radius: 9px;
  padding: 7px 5px;
  background: var(--button-enabled-bg);
  color: var(--button-enabled-text);
  font-size: 12px;
  font-weight: 900;
  cursor: pointer;
}

.asset-actions button:disabled {
  background: var(--button-disabled-bg);
  color: var(--button-disabled-text);
  cursor: not-allowed;
  opacity: 0.78;
}

@media (max-width: 767px) {
  .asset-panel {
    padding: 10px;
  }

  .asset-list {
    max-height: 40vh;
  }

  .asset-actions button {
    font-size: 11px;
    padding: 7px 4px;
  }
}
</style>
```

- [ ] **Step 2: Wire `AssetPanel` in `App.vue`**

Update imports:

```ts
import AssetPanel from './components/AssetPanel.vue';
import { createClientGame, getAssetRows, type ClientAction } from './game/clientGame';
```

Add computed values after `recentLogs`:

```ts
const activeActorId = computed(() => game.state.value.debt?.debtorId ?? game.state.value.currentPlayerId);
const activeActor = computed(() => game.state.value.players.find((player) => player.id === activeActorId.value));
const activeActorName = computed(() => activeActor.value?.nickname ?? activeActorId.value);
const activeDebtAmount = computed(() => game.state.value.debt?.amount ?? null);
const assetRows = computed(() => getAssetRows(game.state.value, activeActorId.value));
```

Render below `ActionPanel` and above `log-card`:

```vue
      <AssetPanel
        :actor-name="activeActorName"
        :debt-amount="activeDebtAmount"
        :assets="assetRows"
        :is-animating="game.isAnimating.value"
        @action="handleAction"
      />
```

- [ ] **Step 3: Run client typecheck/build**

Run:

```bash
pnpm --filter @richman/client build
```

Expected: PASS.

---

## Task 6: Focused verification and browser smoke

**Files:**

- No planned production edits unless verification exposes defects.

- [ ] **Step 1: Run focused client tests**

Run:

```bash
pnpm vitest run apps/client/src/game/clientGame.test.ts
```

Expected: one test file passes; all clientGame tests pass.

- [ ] **Step 2: Run full automated verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm validate-data
pnpm --filter @richman/client build
```

Expected:

- `pnpm test`: all test files pass.
- `pnpm typecheck`: exit 0.
- `pnpm validate-data`: `[OK] 全部校验通过。`
- client build: Vite build succeeds.

- [ ] **Step 3: Start dev server**

Run:

```bash
pnpm dev -- --port 5176 --host 127.0.0.1
```

Expected: dev server serves `http://127.0.0.1:5176/`.

- [ ] **Step 4: Browser smoke desktop**

Open `http://127.0.0.1:5176/` at `1440×900`.

Check:

- Asset panel appears below the action panel.
- At least one asset row appears for the demo current player after the state has owned properties.
- Buttons are not clipped in the right panel.
- Long asset list, if present, scrolls inside the panel instead of pushing the board.

- [ ] **Step 5: Browser smoke mobile**

Open the same URL at `390×844`.

Check:

- No horizontal overflow.
- Asset panel is below primary action area.
- Asset list scrolls at or below `40vh`.
- Buttons remain tappable and labels are readable.

---

## Task 7: Review checkpoint and finish options

**Files:**

- Review current diff only.

- [ ] **Step 1: Request focused review**

Ask reviewer to inspect:

- `apps/client/src/game/clientGame.ts`
- `apps/client/src/game/clientGame.test.ts`
- `apps/client/src/components/AssetPanel.vue`
- `apps/client/src/App.vue`
- M3-5 spec and plan docs

Reviewer must check:

- No engine/data/boardLayout changes.
- Debt-state actor dispatch is correct.
- Sell-house/mortgage/redeem enable rules match spec.
- UI accessibility and mobile layout are acceptable.
- Tests defend behavior, not implementation trivia.

- [ ] **Step 2: Fix Critical/Important review feedback**

If review returns Critical or Important issues, fix them and rerun:

```bash
pnpm vitest run apps/client/src/game/clientGame.test.ts
pnpm test
pnpm typecheck
pnpm validate-data
pnpm --filter @richman/client build
```

- [ ] **Step 3: Present finish choices**

Do not commit or merge automatically. Present exactly these options to the owner:

1. Commit and merge locally.
2. Commit branch only.
3. Keep uncommitted.
4. Discard work.
