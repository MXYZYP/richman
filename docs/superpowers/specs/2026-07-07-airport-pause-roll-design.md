# Airport Pause Roll Design

## Goal

When a player lands exactly on 北京首都国际机场, the game must pause on the airport cell and wait for the same player to explicitly roll one airport die before entering the world branch.

## User-visible behavior

1. A normal `roll_dice` still uses two dice and moves along the outer ring.
2. If the player lands on the airport cell, the token stops on the airport.
3. The game does not automatically roll the branch die.
4. The current turn enters `awaiting_airport_roll`.
5. The action panel shows one primary action: `再掷一次`.
6. Clicking it sends `roll_airport_branch`.
7. `roll_airport_branch` rolls one die, enters the branch with 首尔 as step 1, then resolves the branch landing exactly as the previous automatic branch logic did.

## Non-goals

- Do not change board data or branch geometry.
- Do not change the one-die branch distance rule.
- Do not implement a card-style airport popup.
- Do not change chance/destiny, debt recovery, mortgage, or multiplayer behavior.
- Do not trigger the airport branch from card/effect movement to airport; current scope is normal roll landing only.

## Engine design

Add one turn phase:

```ts
'awaiting_airport_roll'
```

Add one intent:

```ts
{ type: 'roll_airport_branch' }
```

`roll_dice` behavior changes only at the airport branch point:

- before: normal roll lands on airport, engine immediately rolls one die and moves to the branch;
- after: normal roll lands on airport, engine returns state with the player position still at airport and `turnPhase: 'awaiting_airport_roll'`.

`roll_airport_branch` is allowed only in `awaiting_airport_roll`. It rolls one die using `rollSingleDice`, starts at the airport cell's `branchEntryId`, treats 首尔 as step 1, emits `dice_rolled` with one die, emits `token_moved` for the branch path, then calls existing landing resolution.

## Client design

`getAvailableActions()` maps `awaiting_airport_roll` to:

```ts
[{ label: '再掷一次', intent: { type: 'roll_airport_branch' }, primary: true }]
```

The existing event playback loop can remain unchanged because it already plays `dice_rolled` and `token_moved` events sequentially.

## Documentation updates

Update `plan/01-游戏规则规格书.md`, `plan/02-棋盘数据与素材规范.md`, and `assets/棋盘数据核对表.md` to replace “立即再掷” wording with “停留后等待玩家再掷一颗骰子”.

## Tests

Engine tests must prove:

- `roll_dice` landing on airport emits only the normal two-dice `dice_rolled`, emits only the normal movement, leaves the player on airport, and sets `turnPhase` to `awaiting_airport_roll`.
- `roll_airport_branch` is rejected outside `awaiting_airport_roll`.
- `roll_airport_branch` emits exactly one one-die `dice_rolled`, moves along the same branch path semantics as before, and resolves the branch landing.

Client tests must prove:

- `awaiting_airport_roll` shows `再掷一次` mapped to `roll_airport_branch`.
