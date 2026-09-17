# Phase 1 Acceptance Package

## Goal

Close the agent-side evidence package for Phase 1 (`plan/04`) before owner playtest.

Phase 1 target:

```text
One browser/device, 2-4 total players, local hotseat turns, real board data, playable to game over.
```

This package does not add gameplay code. It collects:

- E01-E18 rule-test mapping.
- Browser smoke evidence.
- Desktop/mobile screenshots.
- Independent review result and fixes.
- Final verification output.
- Remaining owner acceptance checklist.

## Worktree

```text
/Users/admin/Documents/Richman/.worktrees/m3-11-full-game-smoke
```

Branch:

```text
m3-11-full-game-smoke
```

Base before this acceptance package:

```text
2daebbb M3-11 record full-game smoke
```

## Scope status

### Implemented before this package

- M2 rule engine and regression tests.
- Static 61-cell board layout.
- Playable local turns.
- Dice movement animation driven by event stream.
- Buy/skip/build/end-turn actions.
- Chance/Destiny card display in the action panel.
- Cell detail / deed panel.
- Asset panel with sell/mortgage/redeem actions.
- Debt handling UI in the asset panel.
- Game setup page for human/BOT counts and cash-goal house rule.
- BOT autoplay for local hotseat.
- Settlement dialog for game-over states.
- Desktop and mobile layouts.

### Not in Phase 1 scope

Per `plan/04 §4`:

- Network rooms / online multiplayer.
- Deployment.
- Sound effects.
- Account system, lobby, chat, ranking, custom maps.

Mortgage/redeem exists earlier than originally staged, but that does not change Phase 1 acceptance requirements.

## E01-E18 rule-test mapping

Source of examples: `plan/01-游戏规则规格书.md §13`.

| Example | Rule | Test coverage |
|---|---|---|
| E01 | Stop on / pass start pays salary once | `packages/engine/src/__tests__/roll_dice.test.ts`; `movement.test.ts` |
| E02 | Card `move_to` passes start and collects salary | `packages/engine/src/__tests__/cards.test.ts` lines covering `move_to collectSalary=true` from cell 48 to 上海站; marker is not named `E02`, but behavior is tested |
| E03 | Full-level hotel cannot build further | `packages/engine/src/__tests__/build_house.test.ts`; rent progression also in `rent.test.ts` |
| E04 | Only one house per landing | `packages/engine/src/__tests__/build_house.test.ts` |
| E05 | Mortgaged own property cannot build | `packages/engine/src/__tests__/build_house.test.ts` |
| E06 | Mortgaged opponent property charges no rent | `packages/engine/src/__tests__/rent.test.ts`; `rent_payment.test.ts` |
| E07 | Utility rent uses current dice and ownership multiplier | `packages/engine/src/__tests__/rent.test.ts`; `rent_payment.test.ts` |
| E08 | Jail dice/utility interaction | Not applicable in this board version; `plan/01 §13` marks jail module closed |
| E09 | Station rent by owned station count; mortgaged stations excluded | `packages/engine/src/__tests__/rent.test.ts`; `rent_payment.test.ts` |
| E10 | Selling hotel downgrades 5→4 and refunds one half-cost house | `packages/engine/src/__tests__/sell.test.ts` |
| E11 | Sold property becomes unowned and can be bought again | `packages/engine/src/__tests__/sell.test.ts` |
| E12 | Debt state: selling assets pays creditor and resumes flow | `packages/engine/src/__tests__/debt_bankruptcy.test.ts` |
| E13 | Player-creditor bankruptcy transfers cash and clears properties | `packages/engine/src/__tests__/debt_bankruptcy.test.ts` |
| E14 | Bank-creditor bankruptcy pays bank and clears properties | `packages/engine/src/__tests__/debt_bankruptcy.test.ts` |
| E15 | Multi-payment card debts resolve by seat order; bankruptcy stops/resumes correctly | `packages/engine/src/__tests__/debt_bankruptcy.test.ts` |
| E16 | Jail-free card retain/return behavior | Not applicable in this board version; `plan/01 §13` marks jail module closed |
| E17 | Bankrupt players are skipped; 2-player bankruptcy ends the game | `packages/engine/src/__tests__/debt_bankruptcy.test.ts` |
| E18 | Cash-goal immediate win on salary/rent/creditor payout | `packages/engine/src/__tests__/victory.test.ts` |

## Browser acceptance evidence

### Environment A: production preview

Commands:

```bash
pnpm --filter @richman/client build
pnpm exec vite preview --host 127.0.0.1 --port 5188
```

Observed before smoke:

```text
HTTP/1.1 200 OK
```

### Desktop production smoke

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

Observed initial board:

```json
{
  "setupGone": true,
  "playerCards": 4,
  "boardCells": 61,
  "overflow": false
}
```

Observed midgame/progress smoke:

```json
{
  "uniqueActions": ["掷骰子", "买地", "结束回合"],
  "hasRentLog": true,
  "overflow": false
}
```

Production smoke reached a real rent event in the visible log:

```text
电脑A 向 电脑C 支付 辽宁省 租金 ¥180
```

### Mobile production smoke

Viewport:

```text
390x844
```

Setup page:

```json
{
  "setup": true,
  "viewport": { "width": 390, "height": 844, "scrollWidth": 390 },
  "overflow": false
}
```

2-human midgame smoke:

```json
{
  "boardCells": 61,
  "uniqueActions": ["掷骰子", "买地", "结束回合"],
  "viewport": { "width": 390, "height": 844, "scrollWidth": 390 },
  "overflow": false
}
```

### Existing complete-game smoke reused

M3-11 already ran real production complete-game smoke and is part of this acceptance evidence:

```text
setup -> board -> human action -> BOT autoplay -> cash-goal game_over -> settlement dialog -> inspect/restart path
```

Reference:

```text
docs/superpowers/plans/2026-07-08-m3-11-full-game-smoke.md
```

Key observed results from that run:

- Desktop 1 human + 3 BOT reached cash-goal settlement with no overflow.
- Mobile 1 human + 3 BOT reached cash-goal settlement with dialog fitting 390px.
- Mobile 2-human endurance smoke performed 148 real actions with no horizontal overflow.

### Explicit M4 coverage gap

`plan/04 §2 M4` asks for an agent-played complete browser game that covers:

```text
buy land, rent, build, both card decks, jail, bankruptcy, victory
```

This board version has no jail; `plan/01 §13` marks jail examples not applicable.

The current production browser smoke demonstrates:

- setup;
- board render;
- human actions;
- BOT autoplay;
- buy land;
- rent log;
- build action in previous M3-11 mobile endurance smoke;
- cash-goal game over;
- settlement dialog;
- desktop/mobile no horizontal overflow.

The current production browser smoke **does not organically demonstrate**:

- drawing both Chance and Destiny during the same agent-played complete browser game;
- bankruptcy during the same agent-played complete browser game.

Those two rule areas are covered by engine tests (`cards.test.ts`, `debt_bankruptcy.test.ts`) and by controlled visual screenshots below, but this package does not pretend they were organically hit in production browser play. A future dedicated deterministic e2e runner should close that gap without relying on random board movement.

### Controlled visual fixtures

Some Phase 1 key screens are hard to deterministically reach through random production play without a dedicated e2e fixture harness. For visual proof only, existing app components were rendered in DEV with controlled local state:

- Card display screenshot: existing `ActionPanel` and `activeCard` rendering.
- Debt screenshot: existing `AssetPanel` with a real-shaped `debt` state and owned assets.
- Settlement screenshot: existing `debugSettlement=1` DEV-only hook from M3-10.

These screenshots are **not** used as rule correctness proof. Rule correctness comes from the engine tests above and production browser smoke.

## Screenshot index

Stored under `plan/assets/screenshots/phase1/`.

Filenames encode the tested viewport width/height; captures are full-page PNGs, so image height can exceed the viewport when page content scrolls.

| Screen | File | Source |
|---|---|---|
| Desktop setup | `m4-acceptance-desktop-setup-1440x900.png` | production preview |
| Desktop midgame | `m4-acceptance-desktop-midgame-1440x900.png` | production preview |
| Desktop cell/deed detail | `m4-acceptance-desktop-cell-detail-1440x900.png` | production preview |
| Desktop card display | `m4-acceptance-desktop-card-1440x900.png` | DEV visual fixture |
| Desktop debt panel | `m4-acceptance-desktop-debt-1440x900.png` | DEV visual fixture |
| Desktop settlement | `m4-acceptance-desktop-settlement-1440x900.png` | DEV visual fixture; real settlement path covered by M3-11 |
| Mobile setup | `m4-acceptance-mobile-setup-390x844.png` | production preview |
| Mobile midgame | `m4-acceptance-mobile-midgame-390x844.png` | production preview |
| Mobile cell/deed detail | `m4-acceptance-mobile-cell-detail-390x844.png` | DEV visual fixture using real component state |
| Mobile card display | `m4-acceptance-mobile-card-390x844.png` | DEV visual fixture |
| Mobile debt panel | `m4-acceptance-mobile-debt-390x844.png` | DEV visual fixture |
| Mobile settlement | `m4-acceptance-mobile-settlement-390x844.png` | DEV visual fixture; real settlement path covered by M3-11 |
| Desktop property rent display | `property-rent-display-desktop-1440x900.png` | production preview; board cells have no rent/status/price overlays and action panel shows landed purchase price |
| Mobile property rent display | `property-rent-display-mobile-390x844.png` | production preview; focused route keeps unowned purchase price, full-board cells stay price-free, no horizontal overflow |

Previously captured screenshots still relevant:

```text
plan/assets/screenshots/phase1/m3-1-board-desktop-1440x900.png
plan/assets/screenshots/phase1/m3-1-board-mobile-390x844.png
plan/assets/screenshots/phase1/m3-1-5-theme-a-desktop-1440x900.png
plan/assets/screenshots/phase1/m3-1-5-theme-a-mobile-390x844.png
plan/assets/screenshots/phase1/m3-2-playable-turn-desktop-1440x900.png
plan/assets/screenshots/phase1/m3-2-playable-turn-mobile-390x844.png
```

## Independent review

Reviewer: `M4AcceptanceReview`.

Initial result:

```text
NOT commit-ready as a satisfied-M4 package.
```

Important findings:

1. Production browser evidence did not demonstrate both card draws and bankruptcy; the package needed to state this explicitly or produce a deterministic production smoke.
2. Screenshot set did not include every key screen for both sizes; the package needed missing screenshots or an explicit substitution note.

Fixes applied in this revision:

- Added explicit M4 coverage gap section.
- Added desktop settlement screenshot.
- Added mobile cell/deed detail screenshot.
- Added mobile card screenshot.
- Added mobile debt screenshot.
- Clarified which screenshots are production preview vs DEV visual fixtures.
- Clarified full-page screenshot naming.
- Recorded final verification output below.

## Final verification

Command run after Feishu property-color and price-display correction:

```bash
pnpm test && pnpm typecheck && pnpm validate-data && pnpm --filter @richman/client build
```

Observed result:

```text
pnpm test:
  Test Files 25 passed (25)
  Tests 280 passed (280)
pnpm typecheck:
  passed

pnpm validate-data:
  格子总数：61
  类型分布：start=1，property=41，chance=4，airport=1，destiny=4，tax=1，special=2，world=7
  地产子类：normal=35，station=4，utility=2
  卡牌张数：机会 15，命运 15
  ✅ 全部校验通过。

pnpm --filter @richman/client build:
  vue-tsc --noEmit passed
  vite build passed
  dist/index.html                  0.43 kB │ gzip: 0.33 kB
  dist/assets/index-BZtiwOIf.css  32.04 kB │ gzip: 6.43 kB
  dist/assets/index-BBFX7w-N.js  138.95 kB │ gzip: 49.75 kB
```

## Agent-side Phase 1 checklist

| Requirement | Status | Evidence |
|---|---|---|
| `pnpm test` full green | Done | 25 files / 280 tests passed |
| `pnpm validate-data` green | Done | board/cards validation passed |
| E01-E18 mapping | Done | Table above |
| Desktop screenshots | Done with source labels | Screenshot index above |
| Mobile screenshots | Done with source labels | Screenshot index above |
| Automatic complete-game description | Partial, with explicit gap | M3-11 report + browser smoke section + M4 coverage gap section |
| Independent review | Done | Findings and fixes recorded above |
| README progress update | Done | README marks Phase 1 as evidence package ready / owner acceptance pending |

## Owner acceptance checklist

These still require owner playtest and explicit approval:

- [ ] Desktop browser can start a 3-player game with nicknames.
- [ ] Dice animation moves tokens cell by cell.
- [ ] Landing on unowned land can buy; color strip appears; opponent rent payment is visible.
- [ ] Landing on own land can build; rent increases by deed table; fifth house becomes hotel.
- [ ] Low-cash player can sell houses and sell land.
- [ ] Chance/Destiny cards show text and apply matching effects.
- [ ] Debt flow lets player raise money; unrecoverable player goes bankrupt and properties reset.
- [ ] Cash goal ends the game immediately when reached.
- [ ] Last-standing game-over appears.
- [ ] One human + three BOTs can finish a full game without manual BOT clicks.
- [ ] Mobile browser on the same network is playable in portrait.

## Current verdict

Agent-side Phase 1 acceptance evidence is collected and verified, with one known remaining engineering gap:

```text
No deterministic production e2e runner yet covers both card decks and bankruptcy inside one browser-played complete game.
```

The product is ready for owner playtest, but Phase 1 should only be marked fully complete after owner acceptance.
