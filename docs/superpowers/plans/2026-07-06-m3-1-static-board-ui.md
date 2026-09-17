# M3-1 Static Board UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first visible hotseat UI slice: a data-driven 61-cell board, fixed 3-player rail, placeholder controls, and verified 1440×900 / 390×844 screenshots.

**Architecture:** Keep the UI DOM/CSS-based per plan/02 §4.5. Put deterministic board coordinate and label logic in small TypeScript utilities with Vitest coverage; keep Vue components focused: `GameBoard`, `BoardCell`, `PlayerRail`, `ActionPanel`, and `App` composition.

**Tech Stack:** Vue 3 + TypeScript + Vite, existing `@richman/engine` and `@richman/board-data`, CSS Grid/absolute positioning, Vitest for layout utilities, browser screenshots for visual validation.

---

## File Structure

- Create `apps/client/src/game/demoState.ts`: fixed 3-player `createGame` state used only by M3-1 demo UI.
- Create `apps/client/src/ui/boardLayout.ts`: 14×14 outer-ring mapping, branch coordinates, short-name generation, color-band helpers.
- Create `apps/client/src/ui/boardLayout.test.ts`: utility tests for 52 outer positions, branch order, duplicate-safe short names.
- Create `apps/client/src/ui/format.ts`: money formatting helper.
- Create `apps/client/src/components/BoardCell.vue`: one board cell; data in, visual out.
- Create `apps/client/src/components/GameBoard.vue`: board composition, central panel, branch layer, token layer.
- Create `apps/client/src/components/PlayerRail.vue`: 3-player cash/marker/bot display.
- Create `apps/client/src/components/ActionPanel.vue`: static M3-1 placeholder buttons/status.
- Modify `apps/client/src/App.vue`: replace M1 placeholder with fixed 3-player board screen.
- Modify `apps/client/src/style.css`: global responsive shell variables and resets.
- Modify `plan/04-阶段1-单机热座版.md`: mark M3-1 screenshot evidence location after screenshots are captured.

---

### Task 1: Data-driven layout utilities and tests

**Files:**
- Create: `apps/client/src/ui/boardLayout.ts`
- Create: `apps/client/src/ui/boardLayout.test.ts`
- Create: `apps/client/src/ui/format.ts`

- [ ] **Step 1: Write failing tests for grid mapping and labels**

Create `apps/client/src/ui/boardLayout.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { boardData } from '@richman/board-data';
import { getBoardPlacement, getShortCellName, getPropertyBandClass } from './boardLayout';

describe('M3-1 board layout utilities', () => {
  it('maps the 52 outer cells onto a 14×14 grid ring', () => {
    expect(getBoardPlacement(0)).toEqual({ kind: 'outer', row: 14, col: 14 });
    expect(getBoardPlacement(1)).toEqual({ kind: 'outer', row: 14, col: 13 });
    expect(getBoardPlacement(12)).toEqual({ kind: 'outer', row: 14, col: 2 });
    expect(getBoardPlacement(13)).toEqual({ kind: 'outer', row: 14, col: 1 });
    expect(getBoardPlacement(26)).toEqual({ kind: 'outer', row: 1, col: 1 });
    expect(getBoardPlacement(39)).toEqual({ kind: 'outer', row: 1, col: 14 });
    expect(getBoardPlacement(51)).toEqual({ kind: 'outer', row: 13, col: 14 });
  });

  it('places branch cells in airport-to-Heilongjiang order', () => {
    const placements = [52, 53, 54, 55, 56, 57, 58, 59, 60].map(getBoardPlacement);
    expect(placements.every((p) => p.kind === 'branch')).toBe(true);
    expect(placements.map((p) => p.branchIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('generates readable, non-duplicate short names for known collision cells', () => {
    const airport = boardData.cells.find((c) => c.id === 13)!;
    const heilongjiang = boardData.cells.find((c) => c.id === 40)!;
    const palace = boardData.cells.find((c) => c.id === 41)!;
    expect(getShortCellName(airport)).toBe('机场');
    expect(getShortCellName(heilongjiang)).toBe('黑龙江');
    expect(getShortCellName(palace)).toBe('故宫');
  });

  it('returns property band classes from real board data', () => {
    expect(getPropertyBandClass(boardData.cells.find((c) => c.id === 16)!)).toBe('band-entry');
    expect(getPropertyBandClass(boardData.cells.find((c) => c.id === 11)!)).toBe('band-mid');
    expect(getPropertyBandClass(boardData.cells.find((c) => c.id === 2)!)).toBe('band-high');
    expect(getPropertyBandClass(boardData.cells.find((c) => c.id === 42)!)).toBe('band-top');
    expect(getPropertyBandClass(boardData.cells.find((c) => c.id === 6)!)).toBe('band-station');
    expect(getPropertyBandClass(boardData.cells.find((c) => c.id === 10)!)).toBe('band-utility');
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
pnpm vitest run apps/client/src/ui/boardLayout.test.ts
```

Expected: FAIL because `boardLayout.ts` does not exist.

- [ ] **Step 3: Implement `boardLayout.ts`**

Create `apps/client/src/ui/boardLayout.ts`:

```ts
import type { Cell } from '@richman/board-data';

export type OuterPlacement = { kind: 'outer'; row: number; col: number };
export type BranchPlacement = { kind: 'branch'; branchIndex: number };
export type BoardPlacement = OuterPlacement | BranchPlacement;

const SHORT_NAME_OVERRIDES: Record<number, string> = {
  13: '机场',
  26: '兰州',
  39: '维港',
  40: '黑龙江',
  41: '故宫',
  52: '首尔',
  53: '东京',
  55: '纽约',
  56: '伦敦',
  57: '巴黎',
  59: '曼谷',
  60: '河内',
};

export function getBoardPlacement(cellId: number): BoardPlacement {
  if (cellId >= 0 && cellId <= 12) return { kind: 'outer', row: 14, col: 14 - cellId };
  if (cellId === 13) return { kind: 'outer', row: 14, col: 1 };
  if (cellId >= 14 && cellId <= 25) return { kind: 'outer', row: 27 - cellId, col: 1 };
  if (cellId === 26) return { kind: 'outer', row: 1, col: 1 };
  if (cellId >= 27 && cellId <= 38) return { kind: 'outer', row: 1, col: cellId - 25 };
  if (cellId === 39) return { kind: 'outer', row: 1, col: 14 };
  if (cellId >= 40 && cellId <= 51) return { kind: 'outer', row: cellId - 38, col: 14 };
  if (cellId >= 52 && cellId <= 60) return { kind: 'branch', branchIndex: cellId - 52 };
  throw new Error(`unknown cell id: ${cellId}`);
}

export function getShortCellName(cell: Cell): string {
  if (SHORT_NAME_OVERRIDES[cell.id]) return SHORT_NAME_OVERRIDES[cell.id];
  if (cell.type === 'property') {
    const cleaned = cell.name.replace(/(省|市)$/u, '');
    return cleaned.length <= 3 ? cleaned : cleaned.slice(0, 2);
  }
  return cell.name.length <= 3 ? cell.name : cell.name.slice(0, 2);
}

export function getPropertyBandClass(cell: Cell): string {
  if (cell.type !== 'property') return 'band-function';
  if (cell.subtype === 'station') return 'band-station';
  if (cell.subtype === 'utility') return 'band-utility';
  if (cell.houseCost === 500) return 'band-entry';
  if (cell.houseCost === 1000) return 'band-mid';
  if (cell.houseCost === 1500) return 'band-high';
  return 'band-top';
}

export function getCellIcon(cell: Cell): string {
  switch (cell.type) {
    case 'start': return '→';
    case 'airport': return '✈';
    case 'chance': return '?';
    case 'destiny': return '!';
    case 'tax': return '¥';
    case 'special': return cell.id === 26 ? '🍜' : '☾';
    case 'world': return '🌐';
    default: return '';
  }
}
```

- [ ] **Step 4: Implement money formatting**

Create `apps/client/src/ui/format.ts`:

```ts
export function formatMoney(value: number): string {
  return value.toLocaleString('zh-CN');
}
```

- [ ] **Step 5: Run tests and verify they pass**

Run:

```bash
pnpm vitest run apps/client/src/ui/boardLayout.test.ts
```

Expected: PASS.

---

### Task 2: Fixed 3-player demo state

**Files:**
- Create: `apps/client/src/game/demoState.ts`

- [ ] **Step 1: Create demo state factory**

Create `apps/client/src/game/demoState.ts`:

```ts
import { boardData, cardsData, gameConfig } from '@richman/board-data';
import { createGame } from '@richman/engine';

export function createDemoGameState() {
  return createGame({
    board: boardData,
    cards: cardsData,
    config: gameConfig,
    seed: 'm3-static-board-demo',
    cashGoal: 30000,
    players: [
      { id: 'p1', nickname: '玩家一' },
      { id: 'p2', nickname: '电脑A', isBot: true },
      { id: 'p3', nickname: '电脑B', isBot: true },
    ],
  });
}
```

- [ ] **Step 2: Typecheck client**

Run:

```bash
pnpm --filter @richman/client build
```

Expected: PASS.

---

### Task 3: Board cell and player rail components

**Files:**
- Create: `apps/client/src/components/BoardCell.vue`
- Create: `apps/client/src/components/PlayerRail.vue`

- [ ] **Step 1: Implement `BoardCell.vue`**

Create `apps/client/src/components/BoardCell.vue`:

```vue
<script setup lang="ts">
import type { Cell as BoardCellData } from '@richman/board-data';
import type { PropertyState } from '@richman/engine';
import { getCellIcon, getPropertyBandClass, getShortCellName } from '../ui/boardLayout';
import { formatMoney } from '../ui/format';

const props = defineProps<{
  cell: BoardCellData;
  property?: PropertyState;
  ownerColor?: string;
  compact?: boolean;
}>();

const isProperty = props.cell.type === 'property';
const icon = getCellIcon(props.cell);
const shortName = getShortCellName(props.cell);
const bandClass = getPropertyBandClass(props.cell);
</script>

<template>
  <div class="board-cell" :class="[`type-${cell.type}`, bandClass, { compact }]">
    <div v-if="isProperty" class="cell-band" />
    <div v-if="property?.ownerId" class="owner-strip" :style="{ background: ownerColor }" />
    <div class="cell-main">
      <div v-if="icon" class="cell-icon">{{ icon }}</div>
      <div class="cell-name" :title="cell.name">{{ compact ? shortName : cell.name }}</div>
      <div v-if="isProperty && !compact" class="cell-price">¥{{ formatMoney(cell.price) }}</div>
    </div>
  </div>
</template>
```

Add scoped CSS in the same file:

```css
.board-cell { position: relative; min-width: 0; min-height: 0; border: 1px solid var(--color-border); background: var(--color-cell); border-radius: 7px; overflow: hidden; box-shadow: 0 1px 2px rgb(0 0 0 / 6%); }
.cell-band { height: 22%; min-height: 7px; }
.band-entry .cell-band { background: #8FBC8F; }
.band-mid .cell-band { background: #4FA3D1; }
.band-high .cell-band { background: #E8A33D; }
.band-top .cell-band { background: #C0392B; }
.band-station .cell-band { background: #546E7A; }
.band-utility .cell-band { background: #8E7CC3; }
.owner-strip { position: absolute; inset: auto 4px 3px 4px; height: 4px; border-radius: 999px; }
.cell-main { height: 78%; display: grid; place-items: center; align-content: center; gap: 2px; padding: 2px 3px 5px; text-align: center; }
.cell-icon { font-size: clamp(12px, 1.2vw, 18px); line-height: 1; }
.cell-name { max-width: 100%; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-weight: 700; font-size: clamp(10px, 0.82vw, 13px); line-height: 1.12; }
.cell-price { color: var(--color-muted); font-size: clamp(9px, 0.72vw, 11px); font-variant-numeric: tabular-nums; }
.compact .cell-main { padding: 1px 2px 4px; }
.compact .cell-name { font-size: 10px; line-height: 1.05; -webkit-line-clamp: 2; }
.compact .cell-icon { font-size: 12px; }
.type-chance, .type-destiny, .type-tax, .type-airport, .type-start, .type-special, .type-world { background: linear-gradient(180deg, #fffdf8, #f4ecdd); }
```

- [ ] **Step 2: Implement `PlayerRail.vue`**

Create `apps/client/src/components/PlayerRail.vue`:

```vue
<script setup lang="ts">
import type { PlayerState } from '@richman/engine';
import { formatMoney } from '../ui/format';

defineProps<{ players: PlayerState[]; currentPlayerId: string }>();

const marks: Record<string, string> = { red: '●', blue: '■', yellow: '▲', green: '★' };
</script>

<template>
  <aside class="player-rail" aria-label="玩家资产条">
    <article v-for="player in players" :key="player.id" class="player-card" :class="{ current: player.id === currentPlayerId }">
      <div class="avatar" :class="`avatar-${player.color}`">{{ marks[player.color] }}</div>
      <div class="player-info">
        <div class="player-name">{{ player.nickname }} <span v-if="player.isBot" class="bot">BOT</span></div>
        <div class="player-cash">¥{{ formatMoney(player.cash) }}</div>
      </div>
    </article>
  </aside>
</template>
```

Add scoped CSS:

```css
.player-rail { display: flex; gap: 10px; overflow-x: auto; padding: 10px; }
.player-card { display: flex; align-items: center; gap: 9px; min-width: 132px; padding: 9px 10px; background: rgb(255 255 255 / 82%); border: 1px solid var(--color-border); border-radius: 14px; box-shadow: 0 4px 14px rgb(0 0 0 / 7%); }
.player-card.current { outline: 2px solid var(--color-accent); }
.avatar { width: 34px; height: 34px; border-radius: 999px; display: grid; place-items: center; color: #fff; font-size: 16px; font-weight: 800; }
.avatar-red { background: #d84b3f; }
.avatar-blue { background: #3478c6; }
.avatar-yellow { background: #d8a725; }
.avatar-green { background: #2f9d63; }
.player-name { font-weight: 800; white-space: nowrap; }
.player-cash { font-variant-numeric: tabular-nums; color: var(--color-muted); }
.bot { margin-left: 4px; padding: 1px 4px; border-radius: 999px; background: #eef1f4; color: #546E7A; font-size: 10px; }
```

- [ ] **Step 3: Run client typecheck/build**

Run:

```bash
pnpm --filter @richman/client build
```

Expected: PASS or only fails because components are not imported yet; fix import/type names if TypeScript reports them.

---

### Task 4: GameBoard composition and responsive shell

**Files:**
- Create: `apps/client/src/components/GameBoard.vue`
- Create: `apps/client/src/components/ActionPanel.vue`
- Modify: `apps/client/src/App.vue`
- Modify: `apps/client/src/style.css`

- [ ] **Step 1: Implement `ActionPanel.vue`**

Create `apps/client/src/components/ActionPanel.vue`:

```vue
<template>
  <section class="action-panel" aria-label="操作面板">
    <div class="turn-copy">M3-1 静态预览 · 交互将在下一切片接入</div>
    <div class="button-row">
      <button disabled>掷骰</button>
      <button disabled>买地</button>
      <button disabled>盖房</button>
      <button disabled>结束回合</button>
    </div>
  </section>
</template>

<style scoped>
.action-panel { padding: 12px; border: 1px solid var(--color-border); background: rgb(255 255 255 / 80%); border-radius: 16px; }
.turn-copy { margin-bottom: 10px; color: var(--color-muted); font-weight: 700; }
.button-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
button { border: 0; border-radius: 12px; padding: 10px 12px; background: #eadfcb; color: var(--color-muted); font-weight: 800; }
</style>
```

- [ ] **Step 2: Implement `GameBoard.vue`**

Create `apps/client/src/components/GameBoard.vue`:

```vue
<script setup lang="ts">
import type { GameState } from '@richman/engine';
import BoardCell from './BoardCell.vue';
import { getBoardPlacement } from '../ui/boardLayout';

const props = defineProps<{ state: GameState }>();

const playerColorHex: Record<string, string> = {
  red: '#d84b3f', blue: '#3478c6', yellow: '#d8a725', green: '#2f9d63',
};
const playerShape: Record<string, string> = { red: '●', blue: '■', yellow: '▲', green: '★' };

function cellStyle(cellId: number) {
  const placement = getBoardPlacement(cellId);
  if (placement.kind === 'outer') return { gridRow: String(placement.row), gridColumn: String(placement.col) };
  const pct = 14 + placement.branchIndex * 8.8;
  return { left: `${pct}%`, bottom: `${pct}%` };
}

function propertyFor(cellId: number) {
  return props.state.properties[cellId];
}

function ownerColor(cellId: number) {
  const ownerId = props.state.properties[cellId]?.ownerId;
  const owner = props.state.players.find((p) => p.id === ownerId);
  return owner ? playerColorHex[owner.color] : undefined;
}

function tokensOn(cellId: number) {
  return props.state.players.filter((p) => p.position === cellId && !p.bankrupt);
}
</script>

<template>
  <section class="board-wrap" aria-label="棋盘">
    <div class="board-grid">
      <BoardCell
        v-for="cell in state.board.cells.filter((cell) => cell.id <= 51)"
        :key="cell.id"
        class="outer-cell"
        :style="cellStyle(cell.id)"
        :cell="cell"
        :property="propertyFor(cell.id)"
        :owner-color="ownerColor(cell.id)"
        :compact="false"
      />

      <div class="center-panel">
        <div class="dice-placeholder">⚂ ⚄</div>
        <div class="event-placeholder">当前事件提示区域</div>
      </div>

      <BoardCell
        v-for="cell in state.board.cells.filter((cell) => cell.id >= 52)"
        :key="cell.id"
        class="branch-cell"
        :style="cellStyle(cell.id)"
        :cell="cell"
        :property="propertyFor(cell.id)"
        compact
      />

      <div v-for="cell in state.board.cells" :key="`tokens-${cell.id}`" class="token-layer" :style="cellStyle(cell.id)">
        <span
          v-for="(player, index) in tokensOn(cell.id)"
          :key="player.id"
          class="token"
          :style="{ background: playerColorHex[player.color], transform: `translate(${(index % 2) * 16}px, ${Math.floor(index / 2) * 16}px)` }"
        >{{ playerShape[player.color] }}</span>
      </div>
    </div>
  </section>
</template>
```

Add scoped CSS:

```css
.board-wrap { width: min(100%, 78vh); aspect-ratio: 1; margin: 0 auto; }
.board-grid { position: relative; width: 100%; height: 100%; display: grid; grid-template-columns: repeat(14, 1fr); grid-template-rows: repeat(14, 1fr); gap: 3px; padding: 6px; border-radius: 24px; background: #dfd4c1; box-shadow: 0 14px 40px rgb(53 39 20 / 14%); }
.outer-cell { width: 100%; height: 100%; }
.branch-cell { position: absolute; width: 9.4%; height: 9.4%; transform: translate(-50%, 50%); z-index: 3; }
.center-panel { grid-row: 3 / 13; grid-column: 3 / 13; display: grid; place-content: center; gap: 8px; border-radius: 22px; background: linear-gradient(135deg, rgb(255 255 255 / 78%), rgb(247 243 234 / 70%)); border: 1px dashed #cbbd9d; text-align: center; color: var(--color-muted); }
.dice-placeholder { font-size: clamp(28px, 5vw, 56px); color: var(--color-primary); letter-spacing: 0.15em; }
.event-placeholder { font-weight: 800; }
.token-layer { pointer-events: none; position: relative; z-index: 5; min-width: 0; min-height: 0; }
.branch-cell + .token-layer { position: absolute; width: 9.4%; height: 9.4%; transform: translate(-50%, 50%); }
.token { position: absolute; right: 3px; bottom: 3px; width: 18px; height: 18px; border: 2px solid #fff; border-radius: 999px; display: grid; place-items: center; color: #fff; font-size: 9px; font-weight: 900; box-shadow: 0 2px 6px rgb(0 0 0 / 30%); }
@media (max-width: 767px) {
  .board-wrap { width: 100%; aspect-ratio: 1; }
  .board-grid { gap: 2px; padding: 4px; border-radius: 16px; }
  .center-panel { grid-row: 4 / 12; grid-column: 4 / 12; }
  .branch-cell { width: 10.2%; height: 10.2%; }
}
```

- [ ] **Step 3: Replace `App.vue` placeholder**

Modify `apps/client/src/App.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue';
import GameBoard from './components/GameBoard.vue';
import PlayerRail from './components/PlayerRail.vue';
import ActionPanel from './components/ActionPanel.vue';
import { createDemoGameState } from './game/demoState';

const state = createDemoGameState();
const recentLogs = computed(() => state.recentLog.slice(-3));
</script>

<template>
  <main class="game-shell">
    <PlayerRail class="players" :players="state.players" :current-player-id="state.currentPlayerId" />
    <GameBoard class="board" :state="state" />
    <aside class="side-panel">
      <ActionPanel />
      <section class="log-card">
        <h2>最近日志</h2>
        <p v-for="(event, index) in recentLogs" :key="index">{{ event.type }}</p>
      </section>
    </aside>
  </main>
</template>
```

Add scoped CSS:

```css
.game-shell { min-height: 100vh; display: grid; grid-template-columns: minmax(0, 1fr) 340px; grid-template-rows: auto minmax(0, 1fr); gap: 14px; padding: 16px; }
.players { grid-column: 1 / -1; }
.board { align-self: start; }
.side-panel { display: grid; align-content: start; gap: 14px; }
.log-card { padding: 12px; border: 1px solid var(--color-border); border-radius: 16px; background: rgb(255 255 255 / 80%); }
.log-card h2 { margin: 0 0 8px; font-size: 1rem; }
.log-card p { margin: 4px 0; color: var(--color-muted); }
@media (max-width: 767px) {
  .game-shell { display: flex; flex-direction: column; min-height: 100vh; padding: 8px; gap: 8px; }
  .side-panel { gap: 8px; }
}
```

- [ ] **Step 4: Update global CSS**

Modify `apps/client/src/style.css` by adding:

```css
button, input, select, textarea { font: inherit; }
body { overflow-x: hidden; }
#app { min-height: 100vh; }
```

- [ ] **Step 5: Build**

Run:

```bash
pnpm --filter @richman/client build
```

Expected: PASS.

---

### Task 5: Browser visual verification and screenshots

**Files:**
- Create screenshots in `plan/assets/screenshots/phase1/`
- Modify `plan/04-阶段1-单机热座版.md` with the two screenshot file paths after capture

- [ ] **Step 1: Start dev server**

Run:

```bash
pnpm dev
```

Expected: Vite serves the client. Keep server running for screenshot capture.

- [ ] **Step 2: Capture desktop screenshot**

Open the app in a browser at 1440×900 and save:

```text
plan/assets/screenshots/phase1/m3-1-board-desktop-1440x900.png
```

Visual checks:
- 52 outer cells form a 14×14 ring.
- Corners are 起点 / 机场 / 兰州 / 维港 in the expected positions.
- Branch visibly runs 机场 → 首尔 → 东京 → 机会 → 纽约 → 伦敦 → 巴黎 → 命运 → 曼谷 → 河内 → 黑龙江.
- 3 tokens appear at 起点 with visible same-cell offsets.
- Player rail shows 3 players, cash, avatar colors, and BOT badges for bot players.

- [ ] **Step 3: Capture mobile screenshot**

Open the app in a browser at 390×844 and save:

```text
plan/assets/screenshots/phase1/m3-1-board-mobile-390x844.png
```

Visual checks:
- Board fits width without page zoom.
- Grid content is naked-eye readable.
- Mobile cells use short labels/icons; no duplicate confusing labels for 机场/故宫/黑龙江.
- Player rail remains usable horizontally.

- [ ] **Step 4: Final verification**

Run:

```bash
pnpm test && pnpm typecheck && pnpm validate-data && pnpm --filter @richman/client build
```

Expected: all commands pass. Screenshot files exist at the two paths above.

- [ ] **Step 5: Commit M3-1 implementation**

Run:

```bash
git add apps/client/src plan/assets/screenshots/phase1 plan/04-阶段1-单机热座版.md
git commit -m "M3-1 static board UI"
```

Commit message may include screenshot paths in the body if useful.

---

## Self-Review

- Spec coverage: board mapping, branch/central coexistence, 390px readability, board-data-driven rendering, player rail from real `GameState`, and screenshot requirements are covered by Tasks 1–5.
- Placeholder scan: every task has concrete file paths, commands, expected outputs, and code snippets; no open-ended implementation slots remain.
- Type consistency: component props use `GameState`, `PlayerState`, `PropertyState` from `@richman/engine` and `Cell` from `@richman/board-data`; helper signatures match those exports.
