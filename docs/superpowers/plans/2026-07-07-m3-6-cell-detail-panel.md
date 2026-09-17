# M3-6 Cell Detail Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only right-side cell detail panel so players can click any board cell and understand its price, owner, rent, house level, mortgage status, or functional effect.

**Architecture:** Keep the feature in the client. `clientGame.ts` owns the pure `getCellDetail()` display model. `App.vue` owns selected-cell state. `GameBoard.vue` forwards selection events from `BoardCell.vue`. `CellDetailPanel.vue` renders the model without gameplay actions.

**Tech Stack:** Vue 3 `<script setup>`, TypeScript, Vitest, existing `@richman/engine`, existing `@richman/board-data`, existing CSS variables.

---

## Scope Guard

Do not modify:

- `packages/engine/**`
- `packages/board-data/data/**`
- `apps/client/src/ui/boardLayout.ts`
- `apps/client/src/ui/boardLayout.test.ts`

Do not add:

- modal dialog
- bottom drawer
- cell-level gameplay buttons
- new board-data fields
- new dependencies

Expected files:

- Modify: `apps/client/src/game/clientGame.ts`
- Modify: `apps/client/src/game/clientGame.test.ts`
- Modify: `apps/client/src/App.vue`
- Modify: `apps/client/src/components/GameBoard.vue`
- Modify: `apps/client/src/components/BoardCell.vue`
- Create: `apps/client/src/components/CellDetailPanel.vue`

---

### Task 1: Add `CellDetail` display model tests

**Files:**

- Modify: `apps/client/src/game/clientGame.test.ts`
- Later implementation target: `apps/client/src/game/clientGame.ts`

- [ ] **Step 1: Write failing tests**

Append tests near the other client display-model tests in `apps/client/src/game/clientGame.test.ts`.

```ts
it('returns normal property detail with owner, level, mortgage value, and rent rows', () => {
  const game = createClientGame({ wait: async () => undefined });
  const ownerId = game.state.value.currentPlayerId;
  const owner = game.state.value.players.find((player) => player.id === ownerId)!;

  game.state.value = {
    ...game.state.value,
    properties: {
      ...game.state.value.properties,
      2: { ownerId, level: 2, mortgaged: false },
    },
  };

  const detail = getCellDetail(game.state.value, 2);

  expect(detail).toMatchObject({
    cellId: 2,
    name: '香港',
    typeLabel: '普通地产',
    price: 2200,
    ownerName: owner.nickname,
    levelLabel: '2 级房屋',
    mortgagedLabel: '未抵押',
    mortgageValue: 1100,
  });
  expect(detail?.rentRows).toEqual([
    { label: '裸地', amount: 180 },
    { label: '1 级房屋', amount: 900 },
    { label: '2 级房屋', amount: 2500 },
    { label: '3 级房屋', amount: 8750 },
    { label: '4 级房屋', amount: 10500 },
    { label: '旅馆', amount: 10500 },
  ]);
  expect(detail?.notes).toContain(`拥有者：${owner.nickname}`);
});

it('returns unowned property detail with unowned note', () => {
  const game = createClientGame({ wait: async () => undefined });

  const detail = getCellDetail(game.state.value, 2);

  expect(detail?.ownerName).toBeNull();
  expect(detail?.levelLabel).toBe('裸地');
  expect(detail?.notes).toContain('当前无主。');
});

it('marks mortgaged property details as rent-free', () => {
  const game = createClientGame({ wait: async () => undefined });
  const ownerId = game.state.value.currentPlayerId;

  game.state.value = {
    ...game.state.value,
    properties: {
      ...game.state.value.properties,
      2: { ownerId, level: 0, mortgaged: true },
    },
  };

  const detail = getCellDetail(game.state.value, 2);

  expect(detail?.mortgagedLabel).toBe('已抵押');
  expect(detail?.notes).toContain('抵押中不收租。');
});

it('returns readable non-property cell details without rent rows', () => {
  const game = createClientGame({ wait: async () => undefined });

  expect(getCellDetail(game.state.value, 3)).toMatchObject({
    name: '机会',
    typeLabel: '机会',
    description: '抽一张机会卡并执行效果。',
    rentRows: [],
  });
  expect(getCellDetail(game.state.value, 4)).toMatchObject({
    name: '命运',
    typeLabel: '命运',
    description: '抽一张命运卡并执行效果。',
    rentRows: [],
  });
  expect(getCellDetail(game.state.value, 13)).toMatchObject({
    name: '机场',
    typeLabel: '机场',
    description: '可进入机场支线移动流程。',
    rentRows: [],
  });
});

it('returns null for unknown cell detail', () => {
  const game = createClientGame({ wait: async () => undefined });

  expect(getCellDetail(game.state.value, 999)).toBeNull();
});
```

Add `getCellDetail` to the test import from `./clientGame`.

- [ ] **Step 2: Run RED test**

Run:

```bash
pnpm vitest run apps/client/src/game/clientGame.test.ts
```

Expected: FAIL because `getCellDetail` is not exported yet.

- [ ] **Step 3: Commit RED test only if your workflow requires checkpoints**

Do not commit a failing branch unless your coordinator asks for RED commits. Otherwise continue to Task 2.

---

### Task 2: Implement `getCellDetail()` helper

**Files:**

- Modify: `apps/client/src/game/clientGame.ts`
- Verify: `apps/client/src/game/clientGame.test.ts`

- [ ] **Step 1: Add exported types near `AssetRow`**

In `apps/client/src/game/clientGame.ts`, add:

```ts
export interface CellDetailRentRow {
  label: string;
  amount: number;
}

export interface CellDetail {
  cellId: number;
  name: string;
  typeLabel: string;
  description: string;
  price: number | null;
  ownerName: string | null;
  levelLabel: string | null;
  mortgagedLabel: string | null;
  mortgageValue: number | null;
  rentRows: CellDetailRentRow[];
  notes: string[];
}
```

- [ ] **Step 2: Add small helper functions**

Add below existing display-model helpers and before `getAssetRows()`:

```ts
function propertyTypeLabel(subtype: PropertyCell['subtype']): string {
  switch (subtype) {
    case 'normal':
      return '普通地产';
    case 'station':
      return '车站';
    case 'utility':
      return '公用事业';
  }
}

function propertyDescription(subtype: PropertyCell['subtype']): string {
  switch (subtype) {
    case 'normal':
      return '可购买、收租、盖房或旅馆的地产。';
    case 'station':
      return '按同一玩家持有的车站数量计算租金。';
    case 'utility':
      return '按本次骰点和持有数量计算租金。';
  }
}

function propertyLevelLabel(subtype: PropertyCell['subtype'], level: number): string {
  if (subtype === 'station') return '车站';
  if (subtype === 'utility') return '公用事业';
  if (level === 0) return '裸地';
  if (level === 5) return '旅馆';
  return `${level} 级房屋`;
}

function rentRowsForProperty(cell: PropertyCell): CellDetailRentRow[] {
  if (cell.subtype === 'normal') {
    const labels = ['裸地', '1 级房屋', '2 级房屋', '3 级房屋', '4 级房屋', '旅馆'];
    return cell.rents.map((amount, index) => ({ label: labels[index] ?? `档位 ${index + 1}`, amount }));
  }
  if (cell.subtype === 'station') {
    return cell.rents.map((amount, index) => ({ label: `持有 ${index + 1} 座车站`, amount }));
  }
  return cell.rents.map((amount, index) => ({ label: `档位 ${index + 1}`, amount }));
}

function nonPropertyTypeLabel(cell: Exclude<Cell, PropertyCell>): string {
  switch (cell.type) {
    case 'start':
      return '起点';
    case 'chance':
      return '机会';
    case 'destiny':
      return '命运';
    case 'tax':
      return '税格';
    case 'airport':
      return '机场';
    case 'special':
      return '特殊格';
    case 'world':
      return '世界之窗';
  }
}

function nonPropertyDescription(cell: Exclude<Cell, PropertyCell>): string {
  switch (cell.type) {
    case 'start':
      return '经过或停在起点时按规则获得奖励。';
    case 'chance':
      return '抽一张机会卡并执行效果。';
    case 'destiny':
      return '抽一张命运卡并执行效果。';
    case 'tax':
      return '按格子金额向银行缴税。';
    case 'airport':
      return '可进入机场支线移动流程。';
    case 'special':
      return '按格子规则结算。';
    case 'world':
      return '按格子规则结算。';
  }
}
```

If TypeScript cannot see `PropertyCell` or `Cell`, add type imports from the existing package at the top:

```ts
import type { Cell, PropertyCell } from '@richman/board-data';
```

- [ ] **Step 3: Add `getCellDetail()`**

Add:

```ts
export function getCellDetail(state: GameState, cellId: number): CellDetail | null {
  const cell = state.board.cells.find((candidate) => candidate.id === cellId);
  if (!cell) return null;

  if (cell.type === 'property') {
    const prop = state.properties[cell.id];
    const owner = prop ? state.players.find((player) => player.id === prop.ownerId) : undefined;
    const level = prop?.level ?? 0;
    const mortgaged = prop?.mortgaged ?? false;
    const ownerName = owner?.nickname ?? null;
    const notes: string[] = [];

    if (ownerName) {
      notes.push(`拥有者：${ownerName}`);
    } else {
      notes.push('当前无主。');
    }
    if (mortgaged) {
      notes.push('抵押中不收租。');
    }

    return {
      cellId: cell.id,
      name: cell.name,
      typeLabel: propertyTypeLabel(cell.subtype),
      description: propertyDescription(cell.subtype),
      price: cell.price,
      ownerName,
      levelLabel: propertyLevelLabel(cell.subtype, level),
      mortgagedLabel: mortgaged ? '已抵押' : '未抵押',
      mortgageValue: typeof cell.mortgageValue === 'number' ? cell.mortgageValue : null,
      rentRows: rentRowsForProperty(cell),
      notes,
    };
  }

  return {
    cellId: cell.id,
    name: cell.name,
    typeLabel: nonPropertyTypeLabel(cell),
    description: nonPropertyDescription(cell),
    price: null,
    ownerName: null,
    levelLabel: null,
    mortgagedLabel: null,
    mortgageValue: null,
    rentRows: [],
    notes: [],
  };
}
```

- [ ] **Step 4: Run GREEN test**

Run:

```bash
pnpm vitest run apps/client/src/game/clientGame.test.ts
```

Expected: PASS, with client test count increased by 5.

- [ ] **Step 5: Commit helper and tests**

Run:

```bash
git add apps/client/src/game/clientGame.ts apps/client/src/game/clientGame.test.ts
git commit -m "M3-6 add cell detail model"
```

---

### Task 3: Wire selectable board cells

**Files:**

- Modify: `apps/client/src/components/BoardCell.vue`
- Modify: `apps/client/src/components/GameBoard.vue`
- Verify: `pnpm --filter @richman/client build`

- [ ] **Step 1: Update `BoardCell.vue` props and emits**

Add props:

```ts
selected?: boolean;
```

Add emit:

```ts
const emit = defineEmits<{
  select: [];
}>();
```

Add a click handler:

```ts
function selectCell() {
  emit('select');
}
```

- [ ] **Step 2: Make the root element selectable**

Change the root template from a plain `div` to a native button:

```vue
<button
  type="button"
  class="board-cell"
  :class="[`type-${cell.type}`, bandClass, { compact, selected }]"
  :aria-label="`查看格子详情：${cell.name}`"
  @click="selectCell"
>
```

Close with `</button>` instead of `</div>`.

- [ ] **Step 3: Preserve board-cell layout style**

In the `.board-cell` style, add button reset properties without changing dimensions:

```css
appearance: none;
border: 1px solid var(--color-border);
font: inherit;
color: inherit;
cursor: pointer;
padding: 0;
text-align: inherit;
```

Add selected/focus styles:

```css
.board-cell.selected {
  outline: 3px solid var(--color-accent);
  outline-offset: -3px;
  box-shadow: 0 0 0 2px rgb(217 164 65 / 28%), 0 1px 2px rgb(0 0 0 / 6%);
}

.board-cell:focus-visible {
  outline: 3px solid var(--color-primary);
  outline-offset: -3px;
}
```

- [ ] **Step 4: Update `GameBoard.vue` props and emits**

Add prop:

```ts
selectedCellId?: number | null;
```

Add emit:

```ts
const emit = defineEmits<{
  selectCell: [cellId: number];
}>();
```

Add handler:

```ts
function selectCell(cellId: number) {
  emit('selectCell', cellId);
}
```

- [ ] **Step 5: Pass selection to both BoardCell loops**

For outer cells and branch cells, add:

```vue
:selected="selectedCellId === cell.id"
@select="selectCell(cell.id)"
```

Do not change `cellStyle()`, `getBoardPlacement()`, or the board loops.

- [ ] **Step 6: Build-check board wiring**

Run:

```bash
pnpm --filter @richman/client build
```

Expected: `vue-tsc --noEmit` passes and Vite build succeeds.

- [ ] **Step 7: Commit selectable board wiring**

Run:

```bash
git add apps/client/src/components/BoardCell.vue apps/client/src/components/GameBoard.vue
git commit -m "M3-6 make board cells selectable"
```

---

### Task 4: Add `CellDetailPanel.vue` and App wiring

**Files:**

- Create: `apps/client/src/components/CellDetailPanel.vue`
- Modify: `apps/client/src/App.vue`
- Verify: `pnpm --filter @richman/client build`

- [ ] **Step 1: Create `CellDetailPanel.vue`**

Create `apps/client/src/components/CellDetailPanel.vue`:

```vue
<script setup lang="ts">
import type { CellDetail } from '../game/clientGame';
import { formatMoney } from '../ui/format';

const props = defineProps<{
  detail: CellDetail | null;
}>();

const emit = defineEmits<{
  close: [];
}>();
</script>

<template>
  <section class="cell-detail-panel" aria-label="格子详情">
    <div class="detail-head">
      <h2>格子详情</h2>
      <button
        v-if="props.detail"
        type="button"
        class="close-button"
        aria-label="关闭格子详情"
        @click="emit('close')"
      >关闭</button>
    </div>

    <p v-if="!props.detail" class="empty-detail">点击棋盘格查看详情</p>

    <article v-else class="detail-card">
      <div class="title-row">
        <strong>{{ props.detail.name }}</strong>
        <span class="type-chip">{{ props.detail.typeLabel }}</span>
      </div>
      <p class="description">{{ props.detail.description }}</p>

      <dl class="facts">
        <div v-if="props.detail.price !== null">
          <dt>价格</dt>
          <dd>¥{{ formatMoney(props.detail.price) }}</dd>
        </div>
        <div v-if="props.detail.ownerName !== null">
          <dt>拥有者</dt>
          <dd>{{ props.detail.ownerName }}</dd>
        </div>
        <div v-if="props.detail.levelLabel !== null">
          <dt>状态</dt>
          <dd>{{ props.detail.levelLabel }}</dd>
        </div>
        <div v-if="props.detail.mortgagedLabel !== null">
          <dt>抵押</dt>
          <dd>{{ props.detail.mortgagedLabel }}</dd>
        </div>
        <div v-if="props.detail.mortgageValue !== null">
          <dt>抵押额</dt>
          <dd>¥{{ formatMoney(props.detail.mortgageValue) }}</dd>
        </div>
      </dl>

      <div v-if="props.detail.rentRows.length > 0" class="rent-block">
        <h3>租金表</h3>
        <dl class="rent-list">
          <div v-for="row in props.detail.rentRows" :key="row.label">
            <dt>{{ row.label }}</dt>
            <dd>¥{{ formatMoney(row.amount) }}</dd>
          </div>
        </dl>
      </div>

      <ul v-if="props.detail.notes.length > 0" class="notes">
        <li v-for="note in props.detail.notes" :key="note">{{ note }}</li>
      </ul>
    </article>
  </section>
</template>

<style scoped>
.cell-detail-panel {
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 16px;
  background: rgb(255 255 255 / 82%);
}

.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.detail-head h2 {
  margin: 0;
  font-size: 1rem;
}

.close-button {
  border: 0;
  border-radius: 999px;
  padding: 5px 10px;
  background: var(--button-secondary-bg);
  color: var(--color-text);
  font-weight: 700;
  cursor: pointer;
}

.empty-detail {
  margin: 0;
  color: var(--color-muted);
}

.detail-card {
  display: grid;
  gap: 10px;
}

.title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.title-row strong {
  font-size: 1.05rem;
}

.type-chip {
  border-radius: 999px;
  padding: 3px 8px;
  background: var(--color-accent);
  color: #fff;
  font-size: 0.76rem;
  font-weight: 800;
  white-space: nowrap;
}

.description {
  margin: 0;
  color: var(--color-muted);
  line-height: 1.45;
}

.facts,
.rent-list {
  display: grid;
  gap: 6px;
  margin: 0;
}

.facts div,
.rent-list div {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px dashed rgb(0 0 0 / 10%);
  padding-bottom: 5px;
}

.facts dt,
.rent-list dt {
  color: var(--color-muted);
}

.facts dd,
.rent-list dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
  font-weight: 800;
  text-align: right;
}

.rent-block h3 {
  margin: 0 0 8px;
  font-size: 0.92rem;
}

.rent-list {
  max-height: 180px;
  overflow-y: auto;
  padding-right: 2px;
}

.notes {
  margin: 0;
  padding-left: 18px;
  color: var(--color-muted);
  line-height: 1.45;
}

@media (max-width: 767px) {
  .cell-detail-panel {
    padding: 10px;
  }

  .rent-list {
    max-height: none;
  }
}
</style>
```

- [ ] **Step 2: Wire `App.vue` state**

Update imports:

```ts
import { computed, ref } from 'vue';
import CellDetailPanel from './components/CellDetailPanel.vue';
import { createClientGame, getAssetRows, getCellDetail, type ClientAction } from './game/clientGame';
```

Add state:

```ts
const selectedCellId = ref<number | null>(null);
const selectedCellDetail = computed(() => (
  selectedCellId.value === null ? null : getCellDetail(game.state.value, selectedCellId.value)
));

function handleSelectCell(cellId: number) {
  selectedCellId.value = cellId;
}

function clearSelectedCell() {
  selectedCellId.value = null;
}
```

- [ ] **Step 3: Pass selection into `GameBoard`**

Change the `GameBoard` usage to:

```vue
<GameBoard
  class="board"
  :state="game.state.value"
  :display-positions="game.displayPositions.value"
  :selected-cell-id="selectedCellId"
  @select-cell="handleSelectCell"
/>
```

- [ ] **Step 4: Render the detail panel in the side panel**

Place after `AssetPanel` and before the log card:

```vue
<CellDetailPanel :detail="selectedCellDetail" @close="clearSelectedCell" />
```

- [ ] **Step 5: Build-check panel wiring**

Run:

```bash
pnpm --filter @richman/client build
```

Expected: build passes.

- [ ] **Step 6: Commit UI panel wiring**

Run:

```bash
git add apps/client/src/App.vue apps/client/src/components/CellDetailPanel.vue
git commit -m "M3-6 add cell detail panel"
```

---

### Task 5: Browser smoke and final verification

**Files:**

- No production edits unless smoke finds a defect.
- Possible fixes: same files touched by Tasks 3-4.

- [ ] **Step 1: Run focused and full automated checks**

Run:

```bash
pnpm vitest run apps/client/src/game/clientGame.test.ts
pnpm test
pnpm typecheck
pnpm validate-data
pnpm --filter @richman/client build
```

Expected:

- focused client test passes with the new M3-6 tests;
- full test suite passes;
- typecheck passes;
- data validation passes;
- client build passes.

- [ ] **Step 2: Start dev server**

Run:

```bash
pnpm dev -- --port 5178 --host 127.0.0.1
```

Keep the server running while browser smoke executes.

- [ ] **Step 3: Desktop browser smoke**

Open `http://127.0.0.1:5178/` at 1440×900.

Assertions:

- `.cell-detail-panel` exists.
- initial panel text contains `点击棋盘格查看详情`.
- clicking a board cell updates the panel to that cell name.
- exactly one `.board-cell.selected` exists after click.
- `document.documentElement.scrollWidth <= window.innerWidth`.
- detail panel bounding box does not overlap board bounding box.

- [ ] **Step 4: Mobile browser smoke**

Open `http://127.0.0.1:5178/` at 390×844.

Assertions:

- clicking a board cell updates the panel.
- no horizontal overflow.
- detail panel appears after board/action/asset content in document flow, not over the board.
- rent rows are visible for a property cell.

- [ ] **Step 5: Fix smoke defects only if found**

If a smoke assertion fails, fix only the affected M3-6 files and rerun:

```bash
pnpm vitest run apps/client/src/game/clientGame.test.ts
pnpm --filter @richman/client build
```

Then rerun the failed browser smoke.

- [ ] **Step 6: Commit smoke fixes if any**

If Step 5 changed files:

```bash
git add apps/client/src/App.vue apps/client/src/components/GameBoard.vue apps/client/src/components/BoardCell.vue apps/client/src/components/CellDetailPanel.vue apps/client/src/game/clientGame.ts apps/client/src/game/clientGame.test.ts
git commit -m "M3-6 polish cell detail smoke issues"
```

Skip this commit if no files changed.

---

### Task 6: Independent review and finish branch

**Files:**

- No edits unless review finds issues.

- [ ] **Step 1: Request independent review**

Ask a reviewer to inspect:

- `apps/client/src/game/clientGame.ts`
- `apps/client/src/game/clientGame.test.ts`
- `apps/client/src/App.vue`
- `apps/client/src/components/GameBoard.vue`
- `apps/client/src/components/BoardCell.vue`
- `apps/client/src/components/CellDetailPanel.vue`
- this plan and the spec

Review acceptance format:

```text
Critical:
Important:
Minor:
Strengths:
Assessment:
```

- [ ] **Step 2: Fix Critical/Important findings**

If review finds Critical or Important issues, fix them with focused tests/smoke and commit:

```bash
git add <changed-files>
git commit -m "M3-6 address cell detail review"
```

Minor issues may be fixed if safe and small.

- [ ] **Step 3: Final verification after review fixes**

Run:

```bash
pnpm test
pnpm typecheck
pnpm validate-data
pnpm --filter @richman/client build
```

Expected: all pass.

- [ ] **Step 4: Finish branch**

Use the finishing-a-development-branch workflow. Present the standard options to the owner:

1. Merge back to `main` locally
2. Push and create a Pull Request
3. Keep the branch as-is
4. Discard this work

Do not merge, push, or discard without owner selection.
