# M3-3 Card Presentation Design

## Goal

Make chance/destiny draws understandable in the playable hot-seat UI without changing engine rules.

## User-visible behavior

- When a player draws a chance or destiny card, the action panel shows a small card panel.
- The panel displays deck label (`机会` or `命运`) and the card text from `GameState.cards`.
- The event ribbon says who drew which card and includes the card text.
- Follow-up settlement events use readable Chinese messages instead of raw event type names where practical: bank paid/received, payment made, rent, tax, debt entered, bankruptcy, and game over.
- The card panel remains visible while subsequent settlement events play, so the player can connect the effect to the card.

## Non-goals

- No modal dialog.
- No separate card artwork asset.
- No engine rule change.
- No new card data fields.
- No full debt recovery UI.

## Client design

Add an `activeCard` ref to `createClientGame()`:

```ts
interface DisplayCard {
  deck: 'chance' | 'destiny';
  cardId: string;
  text: string;
}
```

On `card_drawn`, look up the card from `state.value.cards[event.deck]`, update `activeCard`, and set a readable event message.

Pass `activeCard` to `ActionPanel`. Render it below the dice/event ribbon.

Do not clear `activeCard` on ordinary settlement events. It may be replaced by another `card_drawn` event, such as destiny card 71-30 drawing a chance card.

## Tests

- Client controller test: a real roll landing on a card cell sets `activeCard` with deck/card text and does not leave `eventMessage` as raw `card_drawn`.
- ActionPanel render can be covered by build/typecheck rather than Vue component testing, because the app has no component test harness.
