# M3-4 Mortgage/Redeem Engine Design

## Goal

Implement the engine rule foundation for property mortgage and redemption, without adding UI.

## Scope

In scope:

- Add player intents:
  - `mortgage_property` with `cellId`.
  - `redeem_property` with `cellId`.
- Add game events:
  - `property_mortgaged` with `playerId`, `cellId`, `amount`.
  - `property_redeemed` with `playerId`, `cellId`, `amount`.
- A player may mortgage their own unmortgaged property if it has no houses/hotel.
- Mortgage income equals `cell.mortgageValue`.
- A player may redeem their own mortgaged property by paying `round(mortgageValue × (1 + mortgageInterestRate))`.
- Mortgaged property does not charge rent.
- Mortgaged station and utility properties do not count toward station/utility rent tiers.
- Mortgaged property cannot be sold back to bank.
- Mortgage is allowed in `managing` and in debt state, following the existing sell-house/sell-property debt recovery pattern.
- If mortgage income makes an existing debt payable, reuse `payDebtIfPossible()` to settle it immediately.
- If redemption spends cash, it cannot happen when the player is in debt.

Out of scope:

- UI buttons or asset panel.
- Debt recovery UI copy.
- Bot strategy changes beyond keeping existing bot behavior legal.
- New data fields; `PropertyState.mortgaged` and `mortgageValue` already exist.

## Behavioral rules

### Mortgage

A mortgage attempt succeeds only when all are true:

1. The action actor owns the property.
2. The property is not already mortgaged.
3. The property level is `0`.
4. The property has a numeric `mortgageValue`.
5. The game is in `turnPhase: 'managing'`.
6. If `state.debt` exists, the actor must be `state.debt.debtorId`.

On success:

- Set `properties[cellId].mortgaged = true`.
- Add `mortgageValue` to the player cash.
- Emit `property_mortgaged`.
- If debt can now be paid, pay it using existing debt settlement logic.
- If no debt exists, cash-goal win may trigger after the cash increase.

### Redeem

A redeem attempt succeeds only when all are true:

1. No debt is active.
2. The actor owns the property.
3. The property is currently mortgaged.
4. The player has enough cash for `round(mortgageValue × (1 + mortgageInterestRate))` using `gameConfig.mortgageInterestRate`.
5. The game is in `turnPhase: 'managing'`.

On success:

- Set `properties[cellId].mortgaged = false`.
- Subtract the redemption cost from player cash.
- Emit `property_redeemed`.

## Test focus

- Mortgage success on normal property, station, and utility.
- Reject mortgage with houses, already mortgaged, wrong owner, wrong phase, missing property.
- Redeem success and cost calculation.
- Reject redeem while not mortgaged, insufficient cash, wrong owner, or active debt.
- Mortgaged property does not collect rent.
- Mortgaged station/utility excluded from rent tiers.
- Mortgage during debt can settle debt via existing `payDebtIfPossible()`.
