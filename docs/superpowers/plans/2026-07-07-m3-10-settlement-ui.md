# M3-10 Settlement UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show bankrupt player status and a clear game-over settlement dialog in the local hotseat UI.

**Architecture:** Keep rule outcomes in the engine and derive all settlement display from existing `GameState`. Add pure settlement derivation in `apps/client/src/game/settlement.ts` so behavior is testable without new dependencies, render it with `SettlementDialog.vue`, extend `PlayerRail.vue`, and let `App.vue` own overlay dismissal/restart behavior.

**Tech Stack:** Vue 3 Composition API, TypeScript, Vitest, existing `@richman/engine` state types. Do not add Vue component test dependencies.

---

## File Structure

- Create `apps/client/src/game/settlement.ts`
  - Exports `getSettlementSummary(state: GameState): SettlementSummary`.
  - Sorts winner first, active players by cash descending, bankrupt players last.
- Create `apps/client/src/game/settlement.test.ts`
  - RED/GREEN pure tests for winner, reason, bankrupt rows, and fallback game-over title.
- Create `apps/client/src/components/SettlementDialog.vue`
  - Modal rendering `getSettlementSummary(state)`.
  - Props: `state: GameState`.
  - Emits: `restart`, `close`.
- Modify `apps/client/src/components/PlayerRail.vue`
  - Add bankrupt class and `破产` badge.
- Modify `apps/client/src/App.vue`
  - Show `SettlementDialog` when game over and not dismissed.
  - Add `查看棋盘` and `再开一局` behavior.

---

### Task 1: RED Settlement Summary Tests

**Files:**
- Create: `apps/client/src/game/settlement.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/client/src/game/settlement.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { GameState } from '@richman/engine';
import { createGame } from '@richman/engine';
import { boardData, cardsData, gameConfig } from '@richman/board-data';
import { getSettlementSummary } from './settlement';

function makeState(overrides: Partial<GameState> = {}): GameState {
  const state = createGame({
    board: boardData,
    cards: cardsData,
    config: gameConfig,
    players: [
      { id: 'p1', nickname: '玩家一', isBot: false },
      { id: 'p2', nickname: '电脑A', isBot: true },
      { id: 'p3', nickname: '电脑B', isBot: true },
    ],
    seed: 'settlement-summary-test',
    cashGoal: null,
  });

  return {
    ...state,
    phase: 'game_over',
    winnerId: 'p1',
    players: state.players.map((player) => {
      if (player.id === 'p1') return { ...player, cash: 42000, bankrupt: false };
      if (player.id === 'p2') return { ...player, cash: 0, bankrupt: true };
      return { ...player, cash: 1500, bankrupt: true };
    }),
    ...overrides,
  };
}

describe('getSettlementSummary', () => {
  it('returns winner title and game-over reason', () => {
    const summary = getSettlementSummary(makeState());

    expect(summary.title).toBe('玩家一 获胜');
    expect(summary.reason).toBe('所有对手已破产，本局结束');
  });

  it('orders winner first and bankrupt players after active players', () => {
    const summary = getSettlementSummary(makeState());

    expect(summary.rows.map((row) => row.name)).toEqual(['玩家一', '电脑A', '电脑B']);
    expect(summary.rows[0]).toMatchObject({ rank: 1, name: '玩家一', status: '¥42,000', isWinner: true });
    expect(summary.rows[1]).toMatchObject({ rank: 2, name: '电脑A', status: '破产', isBankrupt: true });
    expect(summary.rows[2]).toMatchObject({ rank: 3, name: '电脑B', status: '破产', isBankrupt: true });
  });

  it('sorts non-bankrupt non-winners by cash before bankrupt players', () => {
    const state = makeState({
      winnerId: 'p3',
      players: makeState().players.map((player) => {
        if (player.id === 'p1') return { ...player, cash: 3000, bankrupt: false };
        if (player.id === 'p2') return { ...player, cash: 9000, bankrupt: false };
        return { ...player, cash: 12000, bankrupt: false };
      }),
    });

    const summary = getSettlementSummary(state);

    expect(summary.rows.map((row) => row.id)).toEqual(['p3', 'p2', 'p1']);
  });

  it('falls back to a neutral title when winner is missing', () => {
    const summary = getSettlementSummary(makeState({ winnerId: null }));

    expect(summary.title).toBe('本局结束');
  });
});
```

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run apps/client/src/game/settlement.test.ts
```

Expected: FAIL because `./settlement` does not exist.

---

### Task 2: GREEN Settlement Summary Helper

**Files:**
- Create: `apps/client/src/game/settlement.ts`
- Test: `apps/client/src/game/settlement.test.ts`

- [ ] **Step 1: Implement helper**

Create `apps/client/src/game/settlement.ts`:

```ts
import type { GameState, PlayerState } from '@richman/engine';
import { formatMoney } from '../ui/format';

export interface SettlementRow {
  id: string;
  rank: number;
  name: string;
  status: string;
  cash: number;
  isWinner: boolean;
  isBankrupt: boolean;
  isBot: boolean;
}

export interface SettlementSummary {
  title: string;
  reason: string;
  rows: SettlementRow[];
}

function compareSettlementPlayers(state: GameState, originalIndex: Map<string, number>) {
  return (left: PlayerState, right: PlayerState): number => {
    if (left.id === state.winnerId) return -1;
    if (right.id === state.winnerId) return 1;
    if (left.bankrupt !== right.bankrupt) return left.bankrupt ? 1 : -1;
    if (!left.bankrupt && !right.bankrupt && left.cash !== right.cash) return right.cash - left.cash;
    return (originalIndex.get(left.id) ?? 0) - (originalIndex.get(right.id) ?? 0);
  };
}

export function getSettlementSummary(state: GameState): SettlementSummary {
  const winner = state.players.find((player) => player.id === state.winnerId) ?? null;
  const originalIndex = new Map(state.players.map((player, index) => [player.id, index]));
  const sortedPlayers = [...state.players].sort(compareSettlementPlayers(state, originalIndex));

  return {
    title: winner ? `${winner.nickname} 获胜` : '本局结束',
    reason: '所有对手已破产，本局结束',
    rows: sortedPlayers.map((player, index) => ({
      id: player.id,
      rank: index + 1,
      name: player.nickname,
      status: player.bankrupt ? '破产' : `¥${formatMoney(player.cash)}`,
      cash: player.cash,
      isWinner: player.id === state.winnerId,
      isBankrupt: player.bankrupt,
      isBot: player.isBot,
    })),
  };
}
```

- [ ] **Step 2: Run GREEN**

```bash
pnpm vitest run apps/client/src/game/settlement.test.ts
```

Expected: PASS.

---

### Task 3: Settlement Dialog and App Wiring

**Files:**
- Create: `apps/client/src/components/SettlementDialog.vue`
- Modify: `apps/client/src/App.vue`

- [ ] **Step 1: Create dialog component**

Create `SettlementDialog.vue` using `getSettlementSummary(props.state)`. Include:

```vue
<section class="settlement-dialog" role="dialog" aria-modal="true" aria-labelledby="settlement-title">
```

Render rows with:

```vue
<li v-for="row in summary.rows" :key="row.id" class="settlement-row" :class="{ winner: row.isWinner, bankrupt: row.isBankrupt }">
  <span class="rank">{{ row.rank }}</span>
  <span class="name">{{ row.name }} <em v-if="row.isBot">BOT</em></span>
  <span class="status">{{ row.status }}</span>
</li>
```

Buttons:

```vue
<button type="button" class="primary" @click="emit('restart')">再开一局</button>
<button type="button" class="secondary" @click="emit('close')">查看棋盘</button>
```

- [ ] **Step 2: Wire App**

In `App.vue`:

```ts
import SettlementDialog from './components/SettlementDialog.vue';
const isSettlementDismissed = ref(false);
const shouldShowSettlement = computed(
  () => game.value?.state.value.phase === 'game_over' && !isSettlementDismissed.value,
);
function inspectFinalBoard() { isSettlementDismissed.value = true; }
function restartFromSettlement() {
  selectedCellId.value = null;
  isSettlementDismissed.value = false;
  game.value = null;
}
```

Reset `isSettlementDismissed.value = false` inside `startGame()` before assigning `game.value`.

Render:

```vue
<SettlementDialog
  v-if="game && shouldShowSettlement"
  :state="game.state.value"
  @restart="restartFromSettlement"
  @close="inspectFinalBoard"
/>
```

- [ ] **Step 3: Run focused checks**

```bash
pnpm vitest run apps/client/src/game/settlement.test.ts && pnpm typecheck
```

Expected: PASS.

---

### Task 4: PlayerRail Bankruptcy Badge

**Files:**
- Modify: `apps/client/src/components/PlayerRail.vue`

- [ ] **Step 1: Add badge**

Update class binding:

```vue
:class="{ current: player.id === currentPlayerId, bankrupt: player.bankrupt }"
```

Inside `.player-name` after BOT badge:

```vue
<span v-if="player.bankrupt" class="bankrupt-badge">破产</span>
```

Add CSS:

```css
.player-card.bankrupt {
  opacity: 0.72;
}

.bankrupt-badge {
  margin-left: 4px;
  padding: 1px 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-primary) 14%, white);
  color: var(--color-primary);
  font-size: 10px;
  font-weight: 900;
}
```

- [ ] **Step 2: Verify typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

---

### Task 5: Browser Smoke and Review

**Files:**
- No planned code changes; fix issues found by smoke/review.

- [ ] **Step 1: Build preview**

```bash
pnpm --filter @richman/client build
pnpm exec vite preview --host 127.0.0.1 --port 5184
```

- [ ] **Step 2: Browser smoke**

Desktop 1440x900 and mobile 390x844:

- no horizontal overflow;
- forced or naturally reached game-over state shows settlement dialog;
- `查看棋盘` hides overlay and final board remains;
- `再开一局` returns to setup;
- bankrupt player cards show `破产` when a bankrupt state is visible.

- [ ] **Step 3: Independent review**

Request code and UX review. Critical/Important must be None or fixed.

- [ ] **Step 4: Final verification**

```bash
pnpm test && pnpm typecheck && pnpm validate-data && pnpm --filter @richman/client build
```

Expected: PASS.

- [ ] **Step 5: Commit implementation**

```bash
git add apps/client/src docs/superpowers/plans/2026-07-07-m3-10-settlement-ui.md
git commit -m "M3-10 add settlement UI"
```
