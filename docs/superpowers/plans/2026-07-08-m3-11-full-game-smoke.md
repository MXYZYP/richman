# M3-11 Full-Game Smoke Report

## Goal

Verify the current local hotseat game can run through the main end-to-end playable loop after M3-8 through M3-10:

```text
setup -> board -> human action -> BOT autoplay -> cash-goal game_over -> settlement dialog -> inspect/restart path
```

This slice intentionally does not add gameplay rules. It records smoke coverage and blockers found during real browser execution.

## Environment

Worktree:

```text
/Users/admin/Documents/Richman/.worktrees/m3-11-full-game-smoke
```

Branch:

```text
m3-11-full-game-smoke
```

Base commit:

```text
45a703b M3-10 add settlement UI
```

Production preview:

```text
pnpm --filter @richman/client build
pnpm exec vite preview --host 127.0.0.1 --port 5187
```

## Baseline

Commands run before smoke:

```bash
pnpm test && pnpm typecheck
```

Observed result:

```text
23 test files passed
266 tests passed
typecheck passed
```

## Scenario A: Desktop BOT-assisted complete game

Viewport:

```text
1440x900
```

Setup:

```text
1 human + 3 BOT
cash goal enabled
cash goal = 15001
```

Automation:

- Use the real production preview.
- Configure setup form through DOM events.
- Start game.
- Let BOT autoplay advance.
- If a human action appears, click the available action with safe priority.
- Stop when settlement dialog appears.
- Click `查看棋盘`.

Observed result:

```json
{
  "beforeInspect": {
    "dialog": true,
    "title": "电脑B 获胜",
    "reasonVisible": true,
    "actionCount": 0,
    "uniqueActions": [],
    "logCountText": "最近 3 条",
    "overflow": false
  },
  "afterInspect": {
    "dialog": false,
    "board": true,
    "overflow": false
  }
}
```

Verdict:

```text
PASS
```

Notes:

- BOT autoplay can finish the game without manual BOT clicks.
- Settlement dialog appears from a real game_over path.
- `查看棋盘` hides the dialog and leaves the final board visible.
- No horizontal overflow.

## Scenario B: Mobile human-action endurance smoke

Viewport:

```text
390x844
```

Setup:

```text
2 humans + 0 BOT
cash goal enabled
cash goal = 15001
```

Automation:

- Start game.
- Click real human action buttons for 148 actions.
- Stop after scripted limit if no settlement dialog appears.

Observed result:

```json
{
  "dialog": false,
  "actionCount": 148,
  "uniqueActions": ["掷骰子", "买地", "结束回合", "盖房"],
  "turnSamples": ["轮到 玩家二", "轮到 玩家一"],
  "overflow": false
}
```

Verdict:

```text
PASS as endurance smoke; not a terminal complete-game scenario.
```

Notes:

- Alternating human turns remained playable after 148 actions.
- No horizontal overflow on 390px.
- This did not reach settlement because the automated human strategy bought/expanded properties, keeping cash below the low cash goal.

## Scenario C: Mobile BOT-assisted complete game

Viewport:

```text
390x844
```

Setup:

```text
1 human + 3 BOT
cash goal enabled
cash goal = 15001
```

Automation:

- Start game.
- Human strategy deliberately skips purchases: `掷骰子 -> 放弃 -> 结束回合`.
- BOT autoplay handles BOT turns.
- Stop when settlement dialog appears.

Observed result:

```json
{
  "dialog": true,
  "title": "电脑B 获胜",
  "reason": "电脑B 率先达到现金目标，本局结束",
  "actionCount": 3,
  "uniqueActions": ["掷骰子", "放弃", "结束回合"],
  "cashes": [
    "●电脑C BOT¥12,400",
    "■电脑A BOT¥13,000",
    "▲玩家一 ¥15,000",
    "★电脑B BOT¥15,450"
  ],
  "dialogFits": true,
  "overflow": false
}
```

Verdict:

```text
PASS
```

Notes:

- Real human actions work on mobile.
- BOT autoplay advances from human turn to BOT turns and reaches game_over.
- Cash-goal settlement reason is correct.
- Settlement dialog fits 390px.
- No horizontal overflow.

## Blockers found

```text
None.
```

## Non-blocking observations

1. A naive human strategy that always buys/builds can run many turns without reaching cash-goal settlement. This is expected economic behavior, not a UI blocker.
2. The complete-game smoke uses a low cash goal (`15001`) to keep runtime bounded. This is a smoke scenario, not a balance assertion.
3. The production preview path was used for M3-11; no DEV-only debug hook was required.

## Final verification

Run after browser smoke:

```bash
pnpm test && pnpm typecheck && pnpm validate-data && pnpm --filter @richman/client build
```

Expected:

```text
PASS
```
