# M3-5 Asset Mortgage UI Design

## Goal

Expose the M3-4 mortgage/redeem engine rules in the playable client UI through a current-player asset panel. The panel must also include sell-house affordances because properties with houses cannot be mortgaged: the player must sell houses down to level 0 before mortgaging the land.

## Scope

In scope:

- Add a right-side current-player asset panel in the existing client layout.
- Show each property owned by the active financial actor.
- Show property level, mortgaged state, mortgage value, sell-house refund, and redeem cost.
- Allow selling one house level when legal.
- Allow mortgaging eligible unmortgaged level-0 properties.
- Allow redeeming eligible mortgaged properties when no debt is active.
- Allow debtor recovery actions during debt where engine rules allow them.
- Render readable event messages for `house_sold`, `property_mortgaged`, and `property_redeemed`.
- Keep engine, board-data, and boardLayout unchanged.

Out of scope:

- Full bankruptcy/debt-management screen.
- Selling bare land from the new panel, unless needed by a later slice.
- Trading UI.
- Board-cell direct selection.
- PlayerRail expansion.
- Changing mortgage rules to allow mortgaging properties with houses.
- Changing house sale or mortgage financial formulas.

## Product rules

### House sale

Houses are not mortgaged. Houses can only be sold one level at a time.

A sell-house action succeeds only when the engine already allows `sell_house`:

- The actor owns the property.
- The property is a normal property.
- The property level is greater than 0.
- The game is in `turnPhase: 'managing'`.
- Debt state is allowed when the actor is the active debtor.

Refund:

```text
round(houseCost × sellHouseRefundRate)
```

Current config:

```text
sellHouseRefundRate = 0.5
```

A level-5 hotel is treated as five house levels. Selling once changes level 5 to level 4 and refunds one half house cost. Repeating the action eventually reaches level 0.

### Mortgage

A property can be mortgaged only when all are true:

- Actor owns the property.
- Property is not already mortgaged.
- Property level is 0.
- Property has numeric `mortgageValue`.
- The game is in `turnPhase: 'managing'`.
- If `state.debt` exists, actor must be `state.debt.debtorId`.

Mortgage income:

```text
mortgageValue
```

Properties with houses must not expose an enabled mortgage button. They should show an explanation such as `需先卖房`.

### Redeem

A property can be redeemed only when all are true:

- No debt is active.
- Actor owns the property.
- Property is currently mortgaged.
- Actor has enough cash.
- The game is in `turnPhase: 'managing'`.

Redeem cost:

```text
Math.round(mortgageValue × (1 + state.config.mortgageInterestRate))
```

Current config:

```text
mortgageInterestRate = 0.1
```

Redeem must be disabled during debt.

## Actor rule

The client must not always dispatch intents as `currentPlayerId`.

Use:

```ts
const actorId = state.value.debt?.debtorId ?? state.value.currentPlayerId;
```

Reason: queued debt can make the active debtor different from `currentPlayerId`. The engine requires debt recovery actions to be performed by `state.debt.debtorId`.

## Client debt dispatch rule

The existing client debt guard must be refined. During debt, the client currently blocks every intent and shows the placeholder debt message. M3-5 must allow engine-approved debt recovery actions through.

Allowed during debt for this slice:

- `sell_house`
- `mortgage_property`

Not allowed during debt:

- `redeem_property`
- normal turn actions such as roll, buy, build, end turn

If the engine rejects an action, the existing `lastError` path remains the source of truth.

## Display model

Add an exported pure helper in `clientGame.ts`:

```ts
export interface AssetRow {
  cellId: number;
  name: string;
  displayName: string;
  subtype: 'normal' | 'station' | 'utility';
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

export function getAssetRows(state: GameState, playerId: string): AssetRow[];
```

Rules:

- List only properties owned by `playerId`.
- Sort by board order.
- Use existing board data for `name`, `level`, `mortgaged`, `mortgageValue`, and `houseCost`.
- Use `getShortCellName(cell)` for compact labels; `shortName` is not a data field.
- Keep all enable/disable decisions in this pure helper, not inside Vue templates.

Reason strings should be short and user-facing:

- `可卖房`
- `无房可卖`
- `需先卖房`
- `已抵押`
- `现金不足`
- `债务中不可赎回`
- `非当前阶段`

## Components

### App.vue

Keep the current shell, but pass asset rows and dispatch callbacks into a sibling asset panel:

```text
<aside class="side-panel">
  <ActionPanel />
  <AssetPanel />
</aside>
```

### AssetPanel.vue

Create `apps/client/src/components/AssetPanel.vue`.

Responsibilities:

- Render `section aria-label="我的资产"`.
- Show active actor name and, when debt exists, debt amount.
- Render asset rows.
- Per row, show:
  - compact property label;
  - level or mortgaged badge;
  - sell-house refund when level > 0;
  - mortgage value when level 0 and not mortgaged;
  - redeem cost when mortgaged;
  - one or more action buttons.
- Emit existing `ClientAction` or a narrow action event back to `App.vue`.

Accessibility:

- Every row action button must have an `aria-label`, e.g. `抵押 福建省`.
- Do not rely on color alone for mortgaged state; include text/icon.
- Disabled buttons should expose the reason in visible text or title.

Layout:

- The asset list body must be scrollable for long portfolios.
- Use `max-height` and `overflow-y: auto`; target `max-height: 40vh` on mobile.
- Do not push dice, event ribbon, or primary action buttons out of reach.
- Do not overlap the board.

### ActionPanel.vue

Keep focused on dice, event/card display, and primary turn actions.

Do not embed the full asset drawer inside `ActionPanel.vue`.

## Event messages

Add readable `playEvent()` cases:

- `house_sold`:

```text
上海 卖出一级房屋，返还 ¥500
```

`house_sold` currently carries only `cellId` and the new `level`; the client must derive the refund from the property `houseCost × sellHouseRefundRate`.

- `property_mortgaged`:

```text
玩家甲 将 上海 抵押给银行，获得 ¥250
```

- `property_redeemed`:

```text
玩家甲 赎回 上海，支付 ¥275
```

Messages must use existing `playerName`, `cellName`, and `money` helpers where the event carries the required fields.

## Testing

Use TDD. Add RED tests before production code.

Focused tests in `apps/client/src/game/clientGame.test.ts`:

1. `getAssetRows` lists current-player owned assets in board order.
2. A normal property with `level > 0` exposes `canSellHouse=true`, `canMortgage=false`, and mortgage reason `需先卖房`.
3. A level-0 unmortgaged property exposes `canMortgage=true`.
4. A mortgaged property exposes `canRedeem=true` when no debt and cash is sufficient.
5. A mortgaged property exposes `canRedeem=false` during debt with reason `债务中不可赎回`.
6. During debt, `sendIntent({ type: 'mortgage_property' })` dispatches as `state.debt.debtorId`, not `currentPlayerId`.
7. During debt, `sendIntent({ type: 'sell_house' })` is allowed for the active debtor.
8. `property_mortgaged` and `property_redeemed` events produce Chinese messages, not raw event type strings.
9. `house_sold` produces a readable Chinese message.

Manual/browser smoke:

- Desktop 1440×900: asset panel visible, scrolls when long, buttons reachable.
- Mobile 390×844: no horizontal overflow, asset panel stacks below primary action area, list scrolls.
- Interact with one sell-house action and one mortgage action on real app state.

Verification commands:

```bash
pnpm vitest run apps/client/src/game/clientGame.test.ts
pnpm test
pnpm typecheck
pnpm validate-data
pnpm --filter @richman/client build
```

## Acceptance

M3-5 is complete when:

- Current-player assets are visible in the playable UI.
- Houses show sell-house affordance and do not allow direct mortgage.
- Level-0 unmortgaged properties can be mortgaged.
- Mortgaged properties can be redeemed only when no debt is active and cash is sufficient.
- Debt-state mortgage and sell-house actions are not blocked by the client placeholder guard.
- Debt-state actions use the debtor as actor.
- Success messages are readable Chinese.
- Focused tests, full tests, typecheck, data validation, and client build pass.
- Browser smoke verifies desktop and mobile layout.

## Non-goals confirmed by owner

- Do not change the rule that properties with houses cannot be mortgaged.
- Do not add direct mortgage of houses.
- Do not allow a property with houses to be mortgaged without first selling houses.
