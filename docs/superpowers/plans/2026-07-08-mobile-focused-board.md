# Mobile Focused Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On mobile, replace the dense default full-board view with a readable local route board and keep a one-tap global-board toggle.

**Architecture:** Add a pure route-window helper for deterministic focused-cell selection, then add a mobile-only `FocusedBoard` component that renders larger route cards from existing `GameState`. Wire it in `App.vue` with a mobile toggle; desktop continues rendering the existing `GameBoard` unchanged.

**Tech Stack:** Vue 3 SFC, TypeScript, Vitest, existing `@richman/board-data` and `@richman/engine` types, current Vite client app.

---

## File structure

- Create `apps/client/src/ui/focusedRoute.ts`
  - Pure helper: choose the focused actor, resolve display position, return up to 7 nearby cells.
  - No DOM, no Vue, no engine mutation.
- Create `apps/client/src/ui/focusedRoute.test.ts`
  - RED/GREEN unit coverage for outer wrap, branch clamp, display-position override, and game-over fallback.
- Create `apps/client/src/components/FocusedBoard.vue`
  - Mobile route-card board.
  - Uses existing board data and property state.
  - Emits `selectCell` like `GameBoard`.
- Modify `apps/client/src/App.vue`
  - Add mobile board-mode state.
  - Render `FocusedBoard` by default on mobile and `GameBoard` in global mode.
  - Keep desktop `GameBoard` unchanged.
  - Add mobile safe-area bottom padding.
- No changes to:
  - `packages/engine/**`
  - `packages/board-data/data/**`
  - `apps/client/src/ui/boardLayout.ts`

## Task 1: Focused route helper

**Files:**
- Create: `apps/client/src/ui/focusedRoute.ts`
- Create: `apps/client/src/ui/focusedRoute.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/client/src/ui/focusedRoute.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { GameState, PlayerState } from '@richman/engine';
import boardData from '@richman/board-data/data/board.json';
import { getFocusedRouteCells } from './focusedRoute';

function player(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    id: 'p1',
    nickname: '玩家一',
    color: 'red',
    cash: 15000,
    position: 0,
    bankrupt: false,
    bankruptTurn: null,
    isBot: false,
    ...overrides,
  };
}

function state(overrides: Partial<GameState> = {}): GameState {
  const players = overrides.players ?? [player({ id: 'p1', position: 0 }), player({ id: 'p2', position: 10, color: 'blue' })];
  return {
    board: boardData,
    players,
    properties: {},
    phase: 'awaiting_roll',
    turn: 1,
    currentPlayerId: players[0].id,
    winnerId: null,
    dice: null,
    lastDiceTotal: null,
    chanceDeck: [],
    destinyDeck: [],
    retainedCards: {},
    debt: null,
    recentLog: [],
    config: { startingCash: 15000, salary: 2000, cashGoal: null },
    ...overrides,
  } as GameState;
}

describe('getFocusedRouteCells', () => {
  it('centers seven outer-ring cells on the active actor', () => {
    const result = getFocusedRouteCells(state({ players: [player({ position: 10 })] }), 'p1');
    expect(result.map((entry) => entry.cell.id)).toEqual([7, 8, 9, 10, 11, 12, 13]);
    expect(result.find((entry) => entry.isCurrent)?.cell.id).toBe(10);
  });

  it('wraps outer-ring cells across the start seam', () => {
    const result = getFocusedRouteCells(state({ players: [player({ position: 1 })] }), 'p1');
    expect(result.map((entry) => entry.cell.id)).toEqual([50, 51, 0, 1, 2, 3, 4]);
  });

  it('clamps branch cells at branch ends', () => {
    const result = getFocusedRouteCells(state({ players: [player({ position: 60 })] }), 'p1');
    expect(result.map((entry) => entry.cell.id)).toEqual([57, 58, 59, 60]);
    expect(result.find((entry) => entry.isCurrent)?.cell.id).toBe(60);
  });

  it('uses display position instead of stored player position during animation', () => {
    const result = getFocusedRouteCells(state({ players: [player({ position: 10 })] }), 'p1', { p1: 12 });
    expect(result.map((entry) => entry.cell.id)).toEqual([9, 10, 11, 12, 13, 14, 15]);
  });

  it('falls back to the winner when the game is over', () => {
    const result = getFocusedRouteCells(
      state({
        phase: 'game_over',
        winnerId: 'p2',
        currentPlayerId: 'p1',
        players: [player({ id: 'p1', position: 5 }), player({ id: 'p2', color: 'blue', position: 20 })],
      }),
      'p1',
    );
    expect(result.find((entry) => entry.isCurrent)?.cell.id).toBe(20);
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm vitest run apps/client/src/ui/focusedRoute.test.ts
```

Expected: FAIL because `apps/client/src/ui/focusedRoute.ts` does not exist.

- [ ] **Step 3: Implement focused route helper**

Create `apps/client/src/ui/focusedRoute.ts`:

```ts
import type { Cell } from '@richman/board-data';
import type { GameState } from '@richman/engine';

export interface FocusedRouteEntry {
  cell: Cell;
  offset: number;
  isCurrent: boolean;
}

const OUTER_START = 0;
const OUTER_END = 51;
const OUTER_COUNT = 52;
const BRANCH_START = 52;
const BRANCH_END = 60;
const WINDOW_RADIUS = 3;

export function getFocusedRouteCells(
  state: GameState,
  activeActorId: string,
  displayPositions: Record<string, number> = {},
): FocusedRouteEntry[] {
  const focusPlayerId = resolveFocusPlayerId(state, activeActorId);
  const player = state.players.find((candidate) => candidate.id === focusPlayerId) ?? state.players.find((candidate) => candidate.id === activeActorId) ?? state.players[0];
  if (!player) return [];

  const current = displayPositions[player.id] ?? player.position;
  const ids = current >= BRANCH_START ? branchWindow(current) : outerWindow(current);
  return ids.map((id) => ({
    cell: state.board.cells[id],
    offset: id - current,
    isCurrent: id === current,
  })).filter((entry) => entry.cell !== undefined);
}

function resolveFocusPlayerId(state: GameState, activeActorId: string) {
  if (state.phase === 'game_over') return state.winnerId ?? activeActorId;
  return activeActorId;
}

function outerWindow(current: number) {
  const ids: number[] = [];
  for (let offset = -WINDOW_RADIUS; offset <= WINDOW_RADIUS; offset += 1) {
    ids.push(wrapOuter(current + offset));
  }
  return ids;
}

function branchWindow(current: number) {
  const start = Math.max(BRANCH_START, current - WINDOW_RADIUS);
  const end = Math.min(BRANCH_END, current + WINDOW_RADIUS);
  const ids: number[] = [];
  for (let id = start; id <= end; id += 1) ids.push(id);
  return ids;
}

function wrapOuter(id: number) {
  if (id < OUTER_START) return OUTER_COUNT + id;
  if (id > OUTER_END) return id - OUTER_COUNT;
  return id;
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
pnpm vitest run apps/client/src/ui/focusedRoute.test.ts
```

Expected: PASS, 5 tests passed.

- [ ] **Step 5: Commit helper**

```bash
git add apps/client/src/ui/focusedRoute.ts apps/client/src/ui/focusedRoute.test.ts
git commit -m "Add mobile focused route helper"
```

## Task 2: FocusedBoard component

**Files:**
- Create: `apps/client/src/components/FocusedBoard.vue`
- Reuse: `apps/client/src/ui/focusedRoute.ts`
- Reuse: `apps/client/src/ui/format.ts`

- [ ] **Step 1: Create component**

Create `apps/client/src/components/FocusedBoard.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue';
import type { Cell as BoardCellData } from '@richman/board-data';
import type { GameState, PlayerColor } from '@richman/engine';
import { formatMoney } from '../ui/format';
import { getCellIcon, getPropertyBandClass, getShortCellName } from '../ui/boardLayout';
import { getFocusedRouteCells } from '../ui/focusedRoute';

const props = defineProps<{
  state: GameState;
  activeActorId: string;
  displayPositions?: Record<string, number>;
  selectedCellId?: number | null;
}>();

const emit = defineEmits<{
  selectCell: [cellId: number];
}>();

const playerShape: Record<PlayerColor, string> = {
  red: '●',
  blue: '■',
  yellow: '▲',
  green: '★',
};

const focusedCells = computed(() => getFocusedRouteCells(props.state, props.activeActorId, props.displayPositions));

function propertyFor(cellId: number) {
  return props.state.properties[cellId];
}

function ownerName(cellId: number) {
  const ownerId = props.state.properties[cellId]?.ownerId;
  return props.state.players.find((player) => player.id === ownerId)?.nickname ?? '';
}

function ownerColorKey(cellId: number) {
  const ownerId = props.state.properties[cellId]?.ownerId;
  return props.state.players.find((player) => player.id === ownerId)?.color;
}

function tokensOn(cellId: number) {
  return props.state.players.filter((player) => {
    const displayPosition = props.displayPositions?.[player.id] ?? player.position;
    return displayPosition === cellId && !player.bankrupt;
  });
}

function cardTitle(cell: BoardCellData) {
  return getShortCellName(cell);
}

function cardSubtitle(cell: BoardCellData) {
  if (cell.type !== 'property') return nonPropertyHint(cell);
  const property = propertyFor(cell.id);
  if (!property?.ownerId) return '无主地产';
  if (property.ownerId === props.activeActorId) return '你的地产';
  return `${ownerName(cell.id)} 的地`;
}

function cardMeta(cell: BoardCellData) {
  if (cell.type !== 'property') return nonPropertyMeta(cell);
  return propertyFor(cell.id)?.mortgaged ? '已抵押' : '';
}

function cardPrice(cell: BoardCellData) {
  if (cell.type !== 'property') return '';
  if (propertyFor(cell.id)?.ownerId) return '';
  return `价格 ¥${formatMoney(cell.price)}`;
}

function nonPropertyHint(cell: BoardCellData) {
  switch (cell.type) {
    case 'chance': return '抽机会卡';
    case 'destiny': return '抽命运卡';
    case 'tax': return '缴纳税款';
    case 'airport': return '机场支线';
    case 'start': return '领取工资';
    case 'world': return '环游支线';
    case 'special': return cell.name;
    default: return cell.name;
  }
}

function nonPropertyMeta(cell: BoardCellData) {
  switch (cell.type) {
    case 'chance': return '抽一张机会卡';
    case 'destiny': return '抽一张命运卡';
    case 'tax': return '按规则缴税';
    case 'airport': return '掷骰可进支线';
    case 'start': return '经过或停留领取工资';
    case 'world': return cell.effect === 'skip_turn' ? '停留一回合' : '环游格';
    default: return '';
  }
}

function ariaLabel(cell: BoardCellData, isCurrent: boolean) {
  const current = isCurrent ? '当前位置，' : '';
  const price = cardPrice(cell);
  const facts = [cardSubtitle(cell), cardMeta(cell), price].filter(Boolean).join('，');
  return `${current}查看格子详情：${cell.name}，${facts}`;
}
</script>

<template>
  <section class="focused-board" aria-label="当前位置附近棋盘">
    <div class="focused-route" role="list">
      <button
        v-for="entry in focusedCells"
        :key="entry.cell.id"
        type="button"
        role="listitem"
        class="focused-card"
        :class="[
          `type-${entry.cell.type}`,
          getPropertyBandClass(entry.cell),
          { current: entry.isCurrent, selected: selectedCellId === entry.cell.id },
        ]"
        :aria-label="ariaLabel(entry.cell, entry.isCurrent)"
        :aria-current="entry.isCurrent ? 'location' : undefined"
        @click="emit('selectCell', entry.cell.id)"
      >
        <div v-if="entry.cell.type === 'property'" class="focus-band" />
        <div v-if="propertyFor(entry.cell.id)?.ownerId && ownerColorKey(entry.cell.id)" class="focus-owner" :class="`owner-${ownerColorKey(entry.cell.id)}`" />
        <div class="focus-card-body">
          <div class="focus-card-topline">
            <span v-if="getCellIcon(entry.cell)" class="focus-icon">{{ getCellIcon(entry.cell) }}</span>
            <strong>{{ cardTitle(entry.cell) }}</strong>
          </div>
          <span v-if="entry.isCurrent" class="current-badge">当前位置</span>
          <p class="focus-subtitle">{{ cardSubtitle(entry.cell) }}</p>
          <p v-if="cardMeta(entry.cell)" class="focus-meta">{{ cardMeta(entry.cell) }}</p>
          <p v-if="cardPrice(entry.cell)" class="focus-price">{{ cardPrice(entry.cell) }}</p>
          <div v-if="tokensOn(entry.cell.id).length > 0" class="focus-tokens" aria-hidden="true">
            <span
              v-for="player in tokensOn(entry.cell.id)"
              :key="player.id"
              class="focus-token"
              :class="`token-${player.color}`"
            >{{ playerShape[player.color] }}</span>
          </div>
        </div>
      </button>
    </div>
  </section>
</template>

<style scoped>
.focused-board {
  width: 100%;
  overflow: hidden;
}

.focused-route {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(86px, 1fr);
  gap: 8px;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  padding: 4px 2px 10px;
  scroll-snap-type: x proximity;
}

.focused-card {
  position: relative;
  min-width: 86px;
  min-height: 112px;
  appearance: none;
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: color-mix(in srgb, var(--color-cell) 92%, white);
  color: var(--color-text);
  box-shadow: 0 6px 16px rgb(53 39 20 / 10%);
  overflow: hidden;
  text-align: left;
  padding: 0;
  font: inherit;
  cursor: pointer;
  scroll-snap-align: center;
}

.focused-card.current {
  outline: 3px solid var(--color-accent);
  outline-offset: -3px;
  box-shadow: 0 10px 24px rgb(217 164 65 / 26%);
}

.focused-card.selected {
  border-color: var(--color-primary);
}

.focus-band {
  height: 10px;
  background: var(--band-feishu-d73a49);
}

.band-feishu-d73a49 .focus-band { background: var(--band-feishu-d73a49); }
.band-feishu-1677ff .focus-band { background: var(--band-feishu-1677ff); }
.band-feishu-8e44ad .focus-band { background: var(--band-feishu-8e44ad); }
.band-feishu-1f5fbf .focus-band { background: var(--band-feishu-1f5fbf); }
.band-feishu-e66a95 .focus-band { background: var(--band-feishu-e66a95); }
.band-feishu-2ea44f .focus-band { background: var(--band-feishu-2ea44f); }
.band-feishu-c2185b .focus-band { background: var(--band-feishu-c2185b); }
.band-feishu-757575 .focus-band { background: var(--band-feishu-757575); }
.band-station .focus-band { background: var(--band-station); }
.band-utility .focus-band { background: var(--band-utility); }

.focus-owner {
  position: absolute;
  inset: auto 8px 7px 8px;
  height: 4px;
  border-radius: 999px;
}

.owner-red { background: var(--player-red); }
.owner-blue { background: var(--player-blue); }
.owner-yellow { background: var(--player-yellow); }
.owner-green { background: var(--player-green); }

.focus-card-body {
  display: grid;
  gap: 4px;
  padding: 8px;
}

.focus-card-topline {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.focus-card-topline strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 900;
}

.focus-icon {
  flex: none;
  font-size: 14px;
}

.current-badge {
  justify-self: start;
  border-radius: 999px;
  padding: 2px 6px;
  background: color-mix(in srgb, var(--color-accent) 24%, white);
  color: var(--color-primary);
  font-size: 10px;
  font-weight: 900;
}

.focus-subtitle,
.focus-meta,
.focus-price {
  margin: 0;
  line-height: 1.2;
}

.focus-subtitle {
  color: var(--color-primary);
  font-size: 12px;
  font-weight: 900;
}

.focus-meta {
  color: var(--color-text);
  font-size: 11px;
  font-weight: 800;
}

.focus-price {
  color: var(--color-muted);
  font-size: 10px;
  font-weight: 800;
}

.focus-tokens {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  margin-top: 2px;
}

.focus-token {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  color: #fff;
  font-size: 11px;
  font-weight: 900;
}

.token-red { background: var(--player-red); }
.token-blue { background: var(--player-blue); }
.token-yellow { background: var(--player-yellow); }
.token-green { background: var(--player-green); }
</style>
```

- [ ] **Step 2: Run client build**

Run:

```bash
pnpm --filter @richman/client build
```

Expected: PASS.

- [ ] **Step 3: Commit component**

```bash
git add apps/client/src/components/FocusedBoard.vue
git commit -m "Add mobile focused board component"
```

## Task 3: Wire mobile toggle in App.vue

**Files:**
- Modify: `apps/client/src/App.vue`

- [ ] **Step 1: Import and state**

In `apps/client/src/App.vue`, add import:

```ts
import FocusedBoard from './components/FocusedBoard.vue';
```

Add state near `selectedCellId`:

```ts
const isGlobalBoardMobile = ref(false);
```

Update `startGame` and `restartGame` to reset mobile board mode:

```ts
isGlobalBoardMobile.value = false;
```

- [ ] **Step 2: Replace direct board render with responsive board shell**

Replace the current `GameBoard` block in the template with:

```vue
<section class="board-area" aria-label="棋盘区域">
  <div class="mobile-board-toolbar">
    <strong>{{ isGlobalBoardMobile ? '全局棋盘' : '当前位置附近' }}</strong>
    <button type="button" class="board-mode-button" @click="isGlobalBoardMobile = !isGlobalBoardMobile">
      {{ isGlobalBoardMobile ? '回到当前位置' : '查看全局' }}
    </button>
  </div>
  <FocusedBoard
    v-if="!isGlobalBoardMobile"
    class="focused-board-mobile"
    :state="game.state.value"
    :active-actor-id="activeActorId"
    :display-positions="game.displayPositions.value"
    :selected-cell-id="selectedCellId"
    @select-cell="handleSelectCell"
  />
  <GameBoard
    v-show="isGlobalBoardMobile"
    class="board board-mobile-global"
    :state="game.state.value"
    :display-positions="game.displayPositions.value"
    :selected-cell-id="selectedCellId"
    @select-cell="handleSelectCell"
  />
  <GameBoard
    class="board board-desktop"
    :state="game.state.value"
    :display-positions="game.displayPositions.value"
    :selected-cell-id="selectedCellId"
    @select-cell="handleSelectCell"
  />
</section>
```

- [ ] **Step 3: Add responsive CSS**

Add CSS before the existing media query:

```css
.board-area {
  align-self: start;
}

.mobile-board-toolbar,
.focused-board-mobile,
.board-mobile-global {
  display: none;
}
```

Inside `@media (max-width: 767px)`, add/update:

```css
.game-shell {
  padding-bottom: calc(88px + env(safe-area-inset-bottom, 0px));
}

.board-area {
  width: 100%;
  min-width: 0;
}

.mobile-board-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  padding: 0 2px;
}

.mobile-board-toolbar strong {
  color: var(--color-primary);
  font-size: 14px;
  font-weight: 900;
}

.board-mode-button {
  min-height: 36px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  padding: 0 12px;
  background: rgb(255 255 255 / 82%);
  color: var(--color-primary);
  font-weight: 900;
}

.focused-board-mobile {
  display: block;
}

.board-mobile-global {
  display: block;
}

.board-desktop {
  display: none;
}
}

@media (min-width: 768px) {
  .board-desktop {
    display: block;
  }
}
```

- [ ] **Step 4: Run focused build**

Run:

```bash
pnpm vitest run apps/client/src/ui/focusedRoute.test.ts apps/client/src/ui/boardLayout.test.ts
pnpm --filter @richman/client build
```

Expected: tests pass and client build passes.

- [ ] **Step 5: Commit App wiring**

```bash
git add apps/client/src/App.vue
git commit -m "Use focused board by default on mobile"
```

## Task 4: Browser verification and screenshots

**Files:**
- Create screenshots under `plan/assets/screenshots/phase1/`

- [ ] **Step 1: Build and start production preview**

Run:

```bash
pnpm --filter @richman/client build
pnpm exec vite preview --host 127.0.0.1 --port 5193
```

Expected: preview serves `HTTP/1.1 200 OK`.

- [ ] **Step 2: Verify mobile default focused route**

Open `http://127.0.0.1:5193/` at `390x844`, start a game, then verify:

```js
({
  hasFocusedHeader: document.body.innerText.includes('当前位置附近'),
  hasGlobalButton: document.body.innerText.includes('查看全局'),
  cardCount: document.querySelectorAll('.focused-card').length,
  minCardWidth: Math.min(...[...document.querySelectorAll('.focused-card')].map((node) => node.getBoundingClientRect().width)),
  minCardHeight: Math.min(...[...document.querySelectorAll('.focused-card')].map((node) => node.getBoundingClientRect().height)),
  overflow: document.documentElement.scrollWidth > window.innerWidth,
})
```

Expected:

```json
{
  "hasFocusedHeader": true,
  "hasGlobalButton": true,
  "cardCount": 4-7,
  "minCardWidth": ">= 80",
  "minCardHeight": ">= 64",
  "overflow": false
}
```

Save screenshot:

```text
plan/assets/screenshots/phase1/mobile-focused-board-route-390x844.png
```

- [ ] **Step 3: Verify mobile global toggle**

Click `查看全局`, then verify:

```js
({
  hasGlobalHeader: document.body.innerText.includes('全局棋盘'),
  hasReturnButton: document.body.innerText.includes('回到当前位置'),
  boardCells: document.querySelectorAll('.board-cell').length,
  overflow: document.documentElement.scrollWidth > window.innerWidth,
})
```

Expected:

```json
{
  "hasGlobalHeader": true,
  "hasReturnButton": true,
  "boardCells": 61,
  "overflow": false
}
```

Save screenshot:

```text
plan/assets/screenshots/phase1/mobile-focused-board-global-390x844.png
```

- [ ] **Step 4: Verify desktop unchanged**

Open `1440x900`, start a game, verify:

```js
({
  hasFocusedHeader: document.body.innerText.includes('当前位置附近'),
  boardCells: document.querySelectorAll('.board-cell').length,
  overflow: document.documentElement.scrollWidth > window.innerWidth,
})
```

Expected:

```json
{
  "hasFocusedHeader": false,
  "boardCells": 61,
  "overflow": false
}
```

Save screenshot:

```text
plan/assets/screenshots/phase1/mobile-focused-board-desktop-1440x900.png
```

- [ ] **Step 5: Run final verification**

Run:

```bash
pnpm test && pnpm typecheck && pnpm validate-data && pnpm --filter @richman/client build
```

Expected:

```text
all commands pass
```

- [ ] **Step 6: Commit screenshots and verification docs if updated**

```bash
git add plan/assets/screenshots/phase1/mobile-focused-board-route-390x844.png plan/assets/screenshots/phase1/mobile-focused-board-global-390x844.png plan/assets/screenshots/phase1/mobile-focused-board-desktop-1440x900.png
git commit -m "Verify mobile focused board view"
```

Do not commit if screenshots or verification fail.
