# Property Rent Display Design

## Goal

Owner 否决棋盘租金角标：红色角标遮盖地名，违反 `plan/02` 的名称可读底线；开局满盘红与主题 A 冲突；浮层叠加在不同视口下遮挡程度不一致。

最终选定：**方案一：整体移除棋盘租金显示，租金信息回归产权卡**。

- 棋盘格不显示租金、等级租金或“过路费”文字。
- 产权卡继续显示完整价格、状态、抵押额、建筑费和租金表。
- 回归检查要求：1440×900 与 390×844 两个断点下，棋盘格名称零遮挡。

## Confirmed board-data facts

以下三格都可以盖房：

| cellId | name | subtype | houseCost | rents |
|---:|---|---|---:|---|
| 44 | 澳门大三巴牌坊 | normal | 2000 | 260, 1300, 3900, 9000, 11000, 12750 |
| 45 | 敦煌莫高窟 | normal | 2000 | 280, 1500, 4500, 10000, 12000, 14000 |
| 46 | 丽江古城 | normal | 500 | 60, 300, 900, 2700, 4000, 5500 |

规则层依据：engine 只允许 `normal` 地产盖房；车站、utility、特殊格不能盖房。

## Display rules

### Fixed board cells

Property cells show:

- color band
- owner strip / player token when applicable
- name

Property cells do **not** show:

- current rent
- level/rent badge
- purchase price
- “过路费” text
- red pay/warning color metadata

Reason: board-cell names are the primary navigation target. Price and rent are secondary facts and belong outside the board grid.

### Focused route cards

Focused mobile route cards keep name, ownership summary, token, current-position badge, mortgage state when applicable, and unowned purchase price.

They do **not** show rent metadata or station/utility rent hints.


### Action panel

When the current player lands on an unowned property and the game enters `awaiting_buy_decision`, the right-side operation panel shows:

- property name
- purchase price
- existing buy / skip buttons

### Detail card

`CellDetailPanel.vue` remains the source of complete facts:

- purchase price
- owner
- level/status
- mortgage state/value
- single-house build cost for normal land
- full rent table

## Layout rules

### Outer ring priority

Adjust `GameBoard.vue` layout without changing `boardLayout.ts` placement semantics.

Allowed changes:

- Increase first/last grid row and column track ratios so the outer ring has more thickness.
- Reduce board gap/padding if screenshots show wasted space.
- Reduce central branch cell footprint.
- Keep central decorative panel visually subordinate.

Forbidden changes:

- Do not change `boardLayout.ts` coordinates or tests.
- Do not modify board data.
- Do not change engine movement or rent rules.

### Mobile layout

At `max-width: 767px`:

- keep focused route cards name-first;
- keep unowned purchase price in focused route cards;
- keep rent out of route cards;
- keep detail panel as the source of complete facts;
- avoid horizontal page overflow.

## Components and data flow

### `BoardCell.vue`

Remove rent/status and price display from fixed board cells. Keep `BoardCell` display-only and data flow unchanged.

### `FocusedBoard.vue`

Remove rent and rent-hint metadata from focused-route cards. Keep the local route readable on mobile; unowned purchase price remains in the focused card because this surface has enough room, while full-board cells stay price-free.

### `CellDetailPanel.vue`

No rollback. It already carries the full rent table and was expanded to show single-house build cost.

### `ActionPanel.vue`

Render the current landed unowned property's purchase price during `awaiting_buy_decision`.

## Regression checks

Add a regression check that fails if rent metadata returns to board cells:

- fixed board cells must not contain `cell-status`/status rent markup or `cell-price`/board price markup;
- focused route cards must contain unowned purchase-price metadata and must not contain rent/过路费 metadata;
- screenshots at 1440×900 and 390×844 must show zero name overlap.

### Browser verification

Capture screenshots after implementation:

- desktop 1440×900
- mobile 390×844

Acceptance criteria:

- no horizontal overflow;
- no red rent/status badges on board cells;
- board-cell names are unobscured at both breakpoints;
- focused route cards do not show rent/过路费 metadata;
- selecting a property still shows complete facts and rent table in the detail card.

## Out of scope

- Changing rent rules.
- Changing build eligibility.
- Adding station/utility dynamic rent badges.
- Changing board data.
- Changing `boardLayout.ts` placement semantics.
- Adding new art assets, images, or canvas rendering.
