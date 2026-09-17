# World Tour Board and Airport Branch Design

Date: 2026-07-16
Status: Implemented and verified on `main`; 2026-07-30 correction applied
Scope: World Tour v1 board topology, property references, fixed special cells, and the Thailand-to-Norway airport branch

## 1. Goal

Define the approved physical “世界之旅” topology and airport-branch rules for the active second versioned map, without changing China Tour behavior or creating a second rules engine.

This design fixes the following product facts:

1. The board has a clockwise 52-cell outer loop with cell `0` as the single start cell.
2. The four green-framed scenes printed at the corners are fixed board cells, not cards or overlays.
3. Thailand Bangkok Airport is the only branch entrance.
4. The branch is one-way and merges back into the outer loop at Norway Oslo.
5. Property, ocean, chance, and destiny settlement is shared with the outer loop and with the existing engine.
6. Local games, bots, online rooms, reconnects, and future saves use the same deterministic state and map data.

> **Owner direction and implementation correction (2026-07-30):** The owner required the outer loop to contain exactly 52 cells and accepted that old saves need not survive. The implementation removes Portugal / Lisbon (`id=29`) and deliberately leaves the ID sparse. To retain the four printed special corners and fourteen visible cells per side, it also uses the local route order Thailand (`48`) → Malaysia (`49`) → Singapore (`11`) → Bangkok Airport (`10`) → Indonesia (`12`). Bangkok Airport's outer successor is therefore Indonesia (`12`); its branch entry remains Pacific Ocean (`40`). The current `world-tour@1` data is authoritative where it conflicts with the original transcription below.

## 2. Source authority

The sources are applied in this order when they differ:

1. the 2026-07-30 owner direction: exactly 52 outer cells, old saves need not survive, and the correction may stay on `world-tour@1`;
2. product decisions confirmed in the 2026-07-16 design discussion;
3. the confirmed Feishu workbook: <https://bcne8a82ogna.feishu.cn/wiki/IsGfw6mqji8VeIkrqH2caBFOnGL>;
4. the supplied board and property-card photographs;
5. old plans or inferred physical-board behavior.

The final pack contains 38 normal properties, four oceans, two utilities, 23 chance cards, and 22 destiny cards. The tests lock every final value and the exact route below. Portugal is retained only in the implementation-deviation record, not as a current cell.

## 3. Relationship to the multi-map platform

The active World Tour release is a normal map pack under the multi-map contract in `2026-07-15-multi-map-modularization-design.md`, with one explicitly authorized exception recorded on 2026-07-30:

- Stable map family ID: `world-tour`.
- Active version: `world-tour@1`.
- The owner authorized this one correction in place on `world-tour@1` and accepted that old World Tour saves become incompatible.
- The content hash changes with the corrected data; incompatible saves surface the existing “找不到这局使用的地图版本” recovery flow.
- This is not a general relaxation of immutable-map rules. Future published map-content changes require a new version unless the owner explicitly authorizes another deviation.
- Cell `0` remains the single start cell.
- Movement follows board-array order plus explicit `nextId` links, never visual coordinates.
- The map contains no executable code, arbitrary CSS, or client-side rule implementation.
- The server remains authoritative for online dice, movement, settlement, and turn transitions.
- China Tour retains its current airport timing and trigger behavior.

World Tour extends the existing airport-branch framework with map-controlled behavior rather than introducing a route-choice UI or a separate mini-game.

## 4. Outer-loop topology

The outer route follows the first 52 entries of `board.json` in the exact order below, then cell `39` links to start cell `0`. Cell IDs are stable identities rather than route indices, so the removed `id=29` remains absent.

| Route | ID | Side | Cell | Type / settlement |
|---:|---:|---|---|---|
| 0 | 0 | bottom-right corner | 北京首都机场（起点） | start |
| 1 | 1 | bottom | 日本·东京 | normal property |
| 2 | 2 | bottom | 韩国·首尔 | normal property |
| 3 | 3 | bottom | 机会 | chance |
| 4 | 4 | bottom | 中国·北京 | normal property |
| 5 | 5 | bottom | 北冰洋 | ocean |
| 6 | 6 | bottom | 命运 | destiny |
| 7 | 7 | bottom | 俄罗斯·莫斯科 | normal property |
| 8 | 8 | bottom | 学习各种外语，增强语言能力 | skip one personal turn |
| 9 | 9 | bottom | 越南·河内 | normal property |
| 10 | 48 | bottom | 泰国·曼谷 | normal property |
| 11 | 49 | bottom | 马来西亚·吉隆坡 | normal property |
| 12 | 11 | bottom | 新加坡·新加坡市 | normal property |
| 13 | 10 | bottom-left corner | 泰国曼谷机场 | branch airport; outer successor `12`, branch entry `40` |
| 14 | 12 | left | 印度尼西亚·雅加达 | normal property |
| 15 | 13 | left | 机会 | chance |
| 16 | 14 | left | 印度·新德里 | normal property |
| 17 | 15 | left | 巴基斯坦·伊斯兰堡 | normal property |
| 18 | 16 | left | 购买无线上网卡 | pay bank 1000 |
| 19 | 17 | left | 土耳其·安卡拉 | normal property |
| 20 | 57 | left | 阿联酋·阿布扎比 | normal property |
| 21 | 18 | left | 伊拉克·巴格达 | normal property |
| 22 | 60 | left | 摩洛哥·拉巴特 | normal property |
| 23 | 19 | left | 埃及·开罗 | normal property |
| 24 | 50 | left | 苏伊士运河 | utility |
| 25 | 51 | left | 南非·比勒陀利亚 | normal property |
| 26 | 20 | upper-left corner | 罗马文化节 | receive bank 1000 |
| 27 | 21 | top | 尼日利亚·阿布贾 | normal property |
| 28 | 22 | top | 命运 | destiny |
| 29 | 23 | top | 肯尼亚·内罗毕 | normal property |
| 30 | 24 | top | 印度洋 | ocean |
| 31 | 25 | top | 法国·巴黎 | normal property |
| 32 | 26 | top | 德国·柏林 | normal property |
| 33 | 27 | top | 机会 | chance |
| 34 | 28 | top | 意大利·罗马 | normal property |
| 35 | 52 | top | 西班牙·马德里 | normal property |
| 36 | 53 | top | 荷兰·阿姆斯特丹 | normal property |
| 37 | 54 | top | 瑞士·伯尔尼 | normal property |
| 38 | 55 | top | 瑞典·斯德哥尔摩 | normal property |
| 39 | 30 | upper-right corner | 伦敦航班延误 | pay bank 1000 |
| 40 | 31 | right | 挪威·奥斯陆 | normal property and branch merge |
| 41 | 32 | right | 加拿大·温哥华 | normal property |
| 42 | 33 | right | 美国·华盛顿 | normal property |
| 43 | 34 | right | 命运 | destiny |
| 44 | 35 | right | 墨西哥·墨西哥城 | normal property |
| 45 | 56 | right | 巴拿马运河 | utility |
| 46 | 36 | right | 危地马拉·危地马拉城 | normal property |
| 47 | 37 | right | 大西洋 | ocean |
| 48 | 38 | right | 巴西·巴西利亚 | normal property |
| 49 | 58 | right | 阿根廷·布宜诺斯艾利斯 | normal property |
| 50 | 59 | right | 智利·圣地亚哥 | normal property |
| 51 | 39 | right | 秘鲁·利马 | normal property; successor `0` |

## 5. Branch topology

The branch contains eight internal cells with stable IDs `40–47`. They follow the 52 outer entries in the board array, while gameplay follows the explicit airport and merge links.

| ID | Type | Name | Subtitle | Price | Card / effect | Next |
|---:|---|---|---|---:|---|---:|
| 40 | property / ocean | 太平洋 | — | 2000 | 54-54 | 41 |
| 41 | special | 班机延误 | — | — | land: pause once | 42 |
| 42 | property | 澳大利亚 | 堪培拉 | 1600 | 54-48 | 43 |
| 43 | chance | 机会 | — | — | World Tour chance deck | 44 |
| 44 | property | 新西兰 | 惠灵顿 | 800 | 54-49 | 45 |
| 45 | destiny | 命运 | — | — | World Tour destiny deck | 46 |
| 46 | property | 南极洲 | — | 600 | 54-50 | 47 |
| 47 | special | 得奖金1000元 | — | — | land: receive 1000 from bank | 31 |

Thailand Bangkok Airport keeps outer-loop successor `12` (Indonesia) for players who merely pass it. Its branch entry points to cell `40`. Cell `47` explicitly merges into Norway Oslo at cell `31`.

The player never chooses between routes. Route entry is determined by the airport landing rule below.

## 6. Airport entry behavior

### 6.1 Trigger

The trigger is based on final position, not the source of movement.

- Any movement that finishes exactly on Thailand Bangkok Airport activates the branch wait state.
- This includes normal dice, chance, destiny, and other movement effects.
- Merely crossing the airport does not activate the branch and movement continues toward Indonesia.
- Landing resolves the airport trigger once; it does not recursively retrigger while the player waits there.

### 6.2 Waiting and entry

Landing at the airport ends the player's current turn. Other players continue normally.

When the same player's next personal turn begins:

1. that player rolls one die;
2. Pacific Ocean, cell `40`, is step 1;
3. the resulting branch landing uses the ordinary landing-resolution pipeline;
4. no route-choice prompt is shown.

This differs from China Tour, where the airport branch roll remains an explicit action in the current turn. The behaviors must coexist and be selected by immutable map data; adding World Tour must not change China Tour.

### 6.3 Dice while on the branch

As long as the player's current position is one of cells `40–47`, each movement turn uses one die.

- A pause effect skips the affected personal turn without rolling.
- After the pause is consumed, the player remains on the branch and still uses one die.
- Landing on chance, destiny, property, or ocean does not change the one-die rule unless a card effect actually moves the token out of the branch.

### 6.4 Exit and excess movement

The branch does not require an exact roll to exit.

- Movement follows `47 → 31` and then the normal outer successors.
- If a roll has steps remaining after reaching Norway, those steps continue toward Canada and later outer cells.
- The final outer-loop landing resolves normally.
- Once the movement ends outside cells `40–47`, the player's next movement turn returns to the normal two-dice rule.

## 7. Landing-only settlement

Except for configured pass-start salary, every board-cell settlement in this design triggers only when movement finishes on that cell. Passing a non-start cell never buys property, charges rent, draws a card, pauses a turn, pays a fee, or grants a reward. World Tour config sets pass-start salary to `2000`; passing or landing on cell `0` follows the existing salary rule.

This rule covers:

- all normal properties and oceans;
- chance and destiny;
- 班机延误;
- 得奖金1000元;
- cells 8, 16, 20, and 30 on the outer loop.

Specific approved effects are:

- cell 8: add one skipped personal turn;
- cell 16: pay 1000 to the bank;
- cell 20: receive 1000 from the bank;
- cell 30: pay 1000 to the bank;
- cell 41: add one skipped personal turn;
- cell 47: receive 1000 from the bank.

Payments use the existing debt and bankruptcy pipeline. Rewards use the existing bank-receipt and victory checks. No special cell performs client-side cash mutation.

## 8. Shared property behavior

Branch properties and oceans use the same ownership, purchase, rent, building, mortgage, redemption, sale, debt, and bot rules as equivalent outer-loop cells.

- Australia, New Zealand, and Antarctica are normal properties.
- Pacific Ocean uses the same ocean/station-style ownership-count rent rule as the other three oceans.
- No ocean can be developed with houses or a hotel.
- The branch has no separate property market, deck, bank, or ownership namespace.
- Every World Tour chance cell uses one World Tour chance deck, and every World Tour destiny cell uses one World Tour destiny deck. This does not reuse China Tour card content.
- “Station-style” describes rent calculation only. Player-facing text must call the subtype “海洋”, count ownership in “片”, and never display “车站” or “座车站” for these cells.

World Tour normal properties have exactly five rent stages: empty land, one house, two houses, three houses, and hotel. There is no four-house stage. The implementation must use the map invariant `level === config.maxHouseLevel` to identify a hotel instead of assuming that every map uses China Tour's level `5` convention. For World Tour, level `4` is the hotel; selling it returns the property to three houses. China Tour keeps its existing four-house-then-hotel progression with level `5` as the hotel.

Confirmed branch values are:

| Property | Price | Mortgage | Empty / 1 / 2 / 3 / hotel rent | House cost |
|---|---:|---:|---|---:|
| 澳大利亚 | 1600 | 800 | 120 / 600 / 1800 / 5000 / 9000 | 1000 |
| 新西兰 | 800 | 400 | 40 / 200 / 600 / 1800 / 4000 | 500 |
| 南极洲 | 600 | 300 | 20 / 100 / 300 / 900 / 2500 | 500 |

Pacific Ocean costs 2000, mortgages for 1000, and charges 2000 / 4000 / 6000 / 8000 according to ownership of one through four oceans.

### 8.1 Confirmed property color groups

Normal-property bands use the colors already confirmed in column A of the Feishu workbook. They must not be re-inferred from card price or board position.

| Card range | Group color |
|---|---|
| 54-23–54-24 | `#4F8A10` |
| 54-25–54-28 | `#5B2C83` |
| 54-29–54-32 | `#225F2B` |
| 54-33–54-36 | `#C5840A` |
| 54-37–54-44 | `#5A3025` |
| 54-45–54-47 | `#0878B8` |
| 54-48–54-50 | `#B83222` |

The four oceans share one ocean presentation category. Its final theme token is part of the deferred visual theme, while its semantic subtype and “海洋 / 片” terminology are fixed by this design.

## 9. Engine and state boundaries

The implementation extends the existing deterministic airport framework with map-defined airport behavior. It must represent, in authoritative game state:

- whether each player is waiting to enter an airport branch on their next personal turn;
- enough immutable board information to identify branch membership and its entry;
- whether the current movement uses one or two dice.

The state cannot infer a pending airport entry solely from the current global turn phase because the triggering player's turn has already ended and other players act before entry. Pending entry therefore belongs to the player or to an equivalent per-player deterministic state record.

The pending-entry lifecycle is:

1. a qualifying airport landing sets exactly one pending airport ID for that player and ends the turn;
2. the pending state is valid only while the non-bankrupt player remains on that same airport and the airport has a valid branch entry;
3. when the player's next actionable turn accepts its roll, the engine atomically consumes the pending state and performs the one-die entry movement;
4. a skipped turn, including an offline-turn skip, does not roll and does not consume the pending entry;
5. bankruptcy clears pending entry;
6. hydrate, reconnect, and local restore reject a pending airport that does not satisfy these invariants;
7. stale, duplicate, or replayed roll intents cannot consume or enter the same pending branch twice.

Branch membership is derived from validated board topology or immutable map configuration, not from hard-coded World Tour cell-number ranges in gameplay code. The `40–47` range is valid map data but must not become a platform-wide assumption.

The client only renders public state, available actions, dice events, movement events, and settlement events. Online clients never select dice count or advance branch movement locally.

## 10. Client behavior

No new airport reminder, modal, toast, or map-specific action wording is added.

- The interaction stays within the existing turn/action framework.
- On the waiting player's next turn, the ordinary roll action remains in place; no World Tour-specific “branch roll” label is introduced.
- Dice presentation must reflect the authoritative one-die or two-dice event.
- Board animation follows the event path, including a roll that exits through Norway and continues farther on the outer loop.
- Existing property, card, debt, and pause presentation is reused.
- Ocean details, assets, rent projections, and ownership summaries use “海洋” and “片” terminology while reusing the ownership-count calculation.
- Hotel details, assets, build/sell events, and repair calculations use the map-configured hotel level.
- The branch remains visible in both full-board and focused-board presentation according to the multi-map layout contract.
- At viewport widths of 1100 px and above, outer-loop and branch cells show their complete data names at readable sizes and retain semantic icons without truncation.
- At viewport widths of 1099 px and below, cells use the approved compact short labels so the board remains legible.

## 11. Bot, online, reconnect, and restore behavior

- Bots obey the same pending-entry and one-die branch rules; they do not choose a route.
- The online server alone applies the airport trigger, advances turns, rolls dice, and emits movement.
- Public snapshots expose only the state needed to render the current position and legal interaction; seed, deck order, and hidden data remain private.
- Reconnect must restore a player waiting at Bangkok Airport, paused on the branch, or standing on any branch cell without changing dice mode or losing the pending entry.
- Local saves preserve the same states and exact completed World Tour map reference; the one-time 2026-07-30 content-hash change intentionally makes older World Tour saves incompatible.

## 12. Validation and acceptance criteria

### 12.1 Board data

- Exactly one start cell exists and its ID is `0`.
- The outer route is the closed 52-cell loop recorded by the current `board.json`.
- Bangkok Airport's outer successor is Indonesia and its branch entry is Pacific Ocean.
- The eight branch cells appear in the exact order in section 5 and merge into Norway.
- Every property price, mortgage, rent, building cost, subtitle, and card reference matches the confirmed workbook.
- Before catalog activation, every presentation cell must exist exactly once and every game cell must have a presentation.
- Catalog activation and content-hash verification are release gates after every deferred `MapPack` input is confirmed.

### 12.2 Engine tests

Tests must prove all of the following with deterministic dice:

1. passing Bangkok Airport does not trigger branch entry;
2. landing on it by normal dice ends the turn and records next-personal-turn entry;
3. landing on it through a movement effect records the same entry;
4. other players act before the waiting player enters the branch;
5. Pacific Ocean is step 1 of the entry roll;
6. every movement roll that starts on cells `40–47` uses one die, including a roll that exits the branch and lands on the outer loop;
7. 班机延误 skips exactly the next personal turn and preserves branch mode;
8. branch properties, oceans, chance, and destiny reuse normal settlement;
9. the bonus pays 1000 only on landing;
10. excess exit movement continues through Norway toward Canada;
11. the next movement turn after exit uses two dice;
12. World Tour progresses from three houses directly to a hotel and uses the correct five-entry rent table;
13. World Tour hotel rent, repair cost, asset/detail labels, build/sell events, sale back to three houses, and hydrate bounds all use `config.maxHouseLevel`;
14. ocean detail, asset, and projected-rent text uses “海洋” and “片”, not station terminology;
15. pending entry survives ordinary and offline skipped turns, clears on successful entry or bankruptcy, and fails hydration when inconsistent with player position;
16. China Tour keeps its existing four-house-then-hotel progression and airport behavior;
17. bots produce no illegal intent in every airport, pause, branch, debt, and exit state;
18. cash conservation remains valid except for explicit bank payments, rewards, and configured salary.

Chance and destiny pipeline tests cover both deterministic effect behavior and the completed 23/22-card World Tour decks. Real-deck acceptance is part of the implemented release gate.

### 12.3 Online and privacy tests

- A real Socket.IO room reproduces waiting, intervening players, branch entry, pause, reconnect, and exit.
- Reconnect during the airport wait and during branch pause restores the authoritative state.
- Stale or duplicate intents cannot roll twice or enter the branch twice.
- Public snapshots and events reveal neither seed nor deck order.

### 12.4 Geometry acceptance for this scope

- The full outer loop and diagonal branch are readable at 1440 × 900.
- The focused route clearly follows Bangkok → branch → Norway at 390 × 844 and 320 × 700.
- One-die events render as one die; ordinary outer-loop rolls render as two.
- No map cell overlaps or becomes unreachable by focused-board navigation.

These geometry checks were completed against the real map and client. The current release uses the approved property bands, existing theme, built-in icons, and code-drawn routes; bespoke future artwork is optional and does not block catalog activation.

## 13. Optional follow-up scope

The implemented World Tour release is fully playable and release-ready. This completed design does not add:

- bespoke final artwork beyond the approved property bands, existing theme, built-in icons, and code-drawn routes;
- changes to China Tour rules;
- route selection, reverse travel, or re-entering the branch from Norway;
- repository deployment configuration or manual publication operations.

These are optional future changes, not missing acceptance criteria for the current World Tour map.
