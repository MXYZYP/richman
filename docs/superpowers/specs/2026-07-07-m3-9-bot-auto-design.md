# M3-9 BOT Auto Action Driver Design

## Goal

Make local hotseat games with computer players playable without the human manually clicking actions for BOT players.

Observable result: in a 1 human + 3 BOT game, the human only acts on human turns. When a BOT is the active actor, the client waits a random 0.8-1.6 seconds, chooses a legal intent with the existing engine BOT strategy, sends it, plays the existing event animation, and repeats until a human turn or game over.

## Scope

### In scope

- Local client BOT autoplay only.
- Use existing `chooseBotIntent(state, actorId)` from `@richman/engine`.
- Actor resolution follows engine guidance: `state.debt?.debtorId ?? state.currentPlayerId`.
- Random delay per BOT intent: `800 + Math.random() * 800` milliseconds.
- UI disables manual action while the BOT is thinking or animating.
- Manual UI cannot submit intents on behalf of a BOT actor.
- Safety cap: stop after 20 consecutive automated BOT intents and show a user-facing error.
- App enables BOT autoplay for normal local games.
- Existing tests that construct `createClientGame()` directly remain deterministic unless they opt into autoplay.

### Out of scope

- No new BOT strategy or difficulty levels.
- No server/online BOT driver.
- No victory settlement screen.
- No sound, vibration, or new animation system.
- No changes to board data or rule semantics.

## Architecture

`packages/engine/src/index.ts` exports `chooseBotIntent` so the client can use the already-tested strategy without duplicating decision logic.

`apps/client/src/game/clientGame.ts` owns the local BOT driver because it already owns state, animation playback, wait timing, and `sendIntent`. `CreateClientGameOptions` gains:

```ts
autoPlayBots?: boolean;
botDelay?: () => number;
```

- `autoPlayBots` defaults to `false` for test/backward compatibility.
- `App.vue` passes `autoPlayBots: true` for real local games.
- `botDelay` defaults to a random integer in `[800, 1600]`; tests inject a deterministic delay.

The driver lifecycle:

1. After game creation, call `scheduleBotTurnIfNeeded()`.
2. After every successful `sendIntent`, call `scheduleBotTurnIfNeeded()` again.
3. If current actor is not BOT, reset the consecutive BOT counter and stop.
4. If current actor is BOT and the game is not over:
   - set `isBotThinking=true`;
   - set event message to `电脑思考中：<name>`;
   - wait random delay;
   - re-check the actor is still BOT and no animation is running;
   - call `chooseBotIntent(state, actorId)`;
   - call internal `sendIntent(intent, { automated: true })`.

Manual `sendIntent(intent)` rejects BOT actors with a short message. Internal automated calls bypass that guard.

## UI

`ClientGame` exposes `isBotThinking: Ref<boolean>`. `App.vue` treats `isAnimating || isBotThinking` as busy and passes that to `ActionPanel` and `AssetPanel`, so buttons are disabled while a BOT is thinking or event animation is playing.

No new large UI is introduced. Existing event ribbon shows:

```text
电脑思考中：电脑A
```

then the regular event messages.

## Testing

Add focused Vitest coverage in `apps/client/src/game/clientGame.test.ts`:

- random BOT delay stays within 800-1600 milliseconds;
- manual actions are blocked when the actor is a BOT;
- autoplay sends a BOT intent after the configured delay;
- autoplay chains multiple BOT decisions until the next human actor;
- human turns do not auto-send intents;
- game over does not auto-send intents;
- debt actor resolution uses `debt.debtorId` when the debtor is a BOT.

Browser smoke:

- start a 1 human + 3 BOT game;
- verify default setup still works;
- when a BOT becomes actor, observe automatic action without clicking BOT buttons;
- verify desktop 1440x900 and mobile 390x844 have no horizontal overflow.

## Risks and mitigations

- **Infinite auto loop:** cap at 20 consecutive automated intents.
- **Manual user racing BOT delay:** manual `sendIntent` rejects BOT actor; UI buttons are disabled while `isBotThinking`.
- **Test nondeterminism:** direct `createClientGame()` keeps autoplay off by default, and tests inject `botDelay` when needed.
- **Wrong actor during debt:** driver always uses `debt?.debtorId ?? currentPlayerId`.
