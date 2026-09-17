# M3-6 Cell Detail Panel Design

## Goal

Let players click any board cell and read a clear explanation of that cell in the existing right-side UI. This slice is read-only: it explains board state and rules; it does not add new gameplay actions, engine rules, board data, or layout semantics.

## User-visible behavior

- Clicking any board cell selects it.
- The selected cell is visually highlighted on the board.
- A new right-side detail panel shows information for the selected cell.
- Clicking another cell switches the highlight and panel content.
- The panel has a close button that clears the selection.
- Desktop layout keeps the panel in the existing side column below action/asset UI.
- Mobile layout stacks the panel below action and asset panels, matching the existing responsive side-panel flow.
- The panel must never cover the board; no modal and no bottom drawer in this slice.

## Scope

In scope:

- Board cells become keyboard- and pointer-selectable.
- The selected cell is highlighted without changing `boardLayout.ts` placement semantics.
- A right-side `CellDetailPanel` renders selected-cell details.
- A pure client helper derives a display model from `GameState` and `cellId`.
- Focused client tests cover the display model for property and non-property cells.
- Browser smoke verifies desktop and mobile layout after selecting a cell.

Out of scope:

- Buying, selling, mortgaging, redeeming, or building from the cell detail panel.
- Board-cell direct action buttons.
- Modal/card artwork.
- Bottom-sheet drawer.
- Engine, board-data, config, or board layout changes.
- Event log rewrite.
- Full bankruptcy/debt-management screen.

## Layout decision

Use the existing right-side column.

Reason:

- It does not obscure the 61-cell board or player tokens.
- It reuses the `ActionPanel` / `AssetPanel` visual rhythm.
- It works on mobile by stacking naturally under the board and current side-panel sections.
- It is simpler and less fragile than a modal or bottom drawer.

## Interaction model

`App.vue` owns selection state:

```ts
const selectedCellId = ref<number | null>(null);
const selectedCellDetail = computed(() =>
  selectedCellId.value === null ? null : getCellDetail(game.state.value, selectedCellId.value),
);
```

`GameBoard.vue` accepts:

```ts
selectedCellId?: number | null;
```

and emits:

```ts
selectCell: [cellId: number];
```

`BoardCell.vue` renders as a real button-like control. It should be focusable and expose an accessible label such as:

```text
查看格子详情：上海
```

Implementation may use a `<button>` wrapper or `role="button"` with keyboard handling. Prefer a native `<button>` if it does not disrupt the existing grid layout.

## Display model

Add a pure helper to `apps/client/src/game/clientGame.ts`:

```ts
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
  rentRows: Array<{ label: string; amount: number }>;
  notes: string[];
}

export function getCellDetail(state: GameState, cellId: number): CellDetail | null;
```

Rules:

- Return `null` if `cellId` is not found.
- Use the board cell name from `state.board.cells`.
- Use current property state from `state.properties[cellId]`.
- Use player nickname for owned property; return `null` owner for unowned property.
- Preserve numeric money values in the helper; Vue components format money with existing `formatMoney()`.
- Do not duplicate board layout knowledge in this helper.

## Property detail rules

For normal property cells:

- `typeLabel`: `普通地产`
- `description`: `可购买、收租、盖房或旅馆的地产。`
- `price`: `cell.price`
- `ownerName`: owner nickname or `null`
- `levelLabel`:
  - level 0: `裸地`
  - level 1-4: `${level} 级房屋`
  - level 5: `旅馆`
- `mortgagedLabel`:
  - mortgaged: `已抵押`
  - otherwise: `未抵押`
- `mortgageValue`: `cell.mortgageValue ?? null`
- `rentRows`: six rows from `cell.rents`:
  - `裸地`
  - `1 级房屋`
  - `2 级房屋`
  - `3 级房屋`
  - `4 级房屋`
  - `旅馆`

For station property cells:

- `typeLabel`: `车站`
- `description`: `按同一玩家持有的车站数量计算租金。`
- `levelLabel`: `车站`
- `rentRows`: rows from `cell.rents`, labelled `持有 1 座车站` through `持有 N 座车站`.
- `notes` includes `抵押中不收租。` when the property is mortgaged.

For utility property cells:

- `typeLabel`: `公用事业`
- `description`: `按本次骰点和持有数量计算租金。`
- `levelLabel`: `公用事业`
- `rentRows`: rows from `cell.rents`, labelled according to the existing rent tiers. If data only provides numeric amounts, use `档位 1`, `档位 2`, etc.; do not invent rule text that is not represented by board data.
- `notes` includes `抵押中不收租。` when the property is mortgaged.

For any owned property:

- `notes` includes `拥有者：${ownerName}`.

For unowned property:

- `notes` includes `当前无主。`.

For mortgaged property:

- `notes` includes `抵押中不收租。`.

## Non-property detail rules

Use simple explanatory text from existing rule/data semantics:

- `start`: `起点` / `经过或停在起点时按规则获得奖励。`
- `chance`: `机会` / `抽一张机会卡并执行效果。`
- `destiny`: `命运` / `抽一张命运卡并执行效果。`
- `tax`: `税格` / `按格子金额向银行缴税。`
- `airport`: `机场` / `可进入机场支线移动流程。`
- `special`: `特殊格` / `按格子规则结算。`
- `world`: `世界之窗` / `按格子规则结算。`

For non-property cells:

- `price`, `ownerName`, `levelLabel`, `mortgagedLabel`, and `mortgageValue` are `null`.
- `rentRows` is empty.
- `notes` may include concise data-derived amounts when the cell has such fields, but no new board-data fields should be introduced.

## Component design

Create `apps/client/src/components/CellDetailPanel.vue`.

Props:

```ts
defineProps<{
  detail: CellDetail | null;
}>();
```

Events:

```ts
const emit = defineEmits<{
  close: [];
}>();
```

Rendering:

- Empty state: `点击棋盘格查看详情`.
- Selected state:
  - title: cell name
  - type chip
  - description
  - compact facts grid for price, owner, level, mortgage status/value
  - rent table if `rentRows.length > 0`
  - notes list if non-empty
  - close button

Accessibility:

- Section `aria-label="格子详情"`.
- Close button label `关闭格子详情`.
- Rent table uses semantic `<dl>` or `<table>`; choose whichever is easier to read in the existing CSS.

## Styling

Use existing CSS variables from `style.css` and component-local scoped CSS.

Desktop:

- Same card surface as `ActionPanel` and `AssetPanel`.
- Bounded panel height if rent rows are long; scroll inside the rent list, not the whole page.

Mobile:

- Full width inside existing `.side-panel` stack.
- No horizontal overflow at 390px.
- Rent rows may wrap but must remain readable.

Board selected state:

- Add a visible selected ring using `--color-accent` or `--color-primary`.
- Do not increase grid cell size; use outline/box-shadow so layout does not shift.
- Keep owner strip and player token visibility.

## Tests

Add focused tests to `apps/client/src/game/clientGame.test.ts`.

Required cases:

1. `getCellDetail()` returns normal-property details with price, owner nickname, level label, mortgage status, mortgage value, and six rent rows.
2. `getCellDetail()` returns unowned-property details with `ownerName === null` and note `当前无主。`.
3. `getCellDetail()` returns mortgaged-property note `抵押中不收租。`.
4. `getCellDetail()` returns chance/destiny/tax/airport non-property descriptions without rent rows.
5. `getCellDetail()` returns `null` for an unknown cell id.

Follow TDD:

- Write the failing tests first.
- Run only the focused client test file and confirm RED.
- Implement helper and components after RED.
- Re-run focused tests and confirm GREEN.

## Browser smoke

After implementation:

- Start the client dev server.
- Desktop 1440×900:
  - click a property cell;
  - assert detail panel appears;
  - assert selected ring exists;
  - assert no horizontal overflow;
  - assert panel does not overlap board.
- Mobile 390×844:
  - click a property cell;
  - assert detail panel appears below the existing side-panel content;
  - assert no horizontal overflow;
  - assert rent rows remain readable.

## Full verification

Run:

```bash
pnpm vitest run apps/client/src/game/clientGame.test.ts
pnpm test
pnpm typecheck
pnpm validate-data
pnpm --filter @richman/client build
```

Request an independent review before merging.
