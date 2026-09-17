# M3-2 Playable Turn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing M3-1.5 board minimally playable for local hot-seat turns: roll dice, animate token movement, resolve buy/build choices, end turn, and continue to the next player.

**Architecture:** Add a lightweight client controller in `apps/client/src/game/clientGame.ts`. It calls the existing pure engine, serializes intent handling, plays engine events into UI playback state, and exposes an action model to Vue components. Components remain presentational; `GameBoard.vue` only receives optional display positions for animation.

**Tech Stack:** Vue 3 Composition API, TypeScript, Vitest, existing `@richman/engine` and `@richman/board-data` packages. No new dependencies.

---

## File Structure

- Create `apps/client/src/game/clientGame.ts`
  - Owns browser playback state and action model.
  - Exports `createClientGame()`, `getAvailableActions()`, and small types used by Vue components/tests.
  - Uses `applyIntent()` as the only rule-changing operation.
- Create `apps/client/src/game/clientGame.test.ts`
  - Unit-tests action mapping, serialization, event playback, and engine error handling.
- Modify `apps/client/src/App.vue`
  - Replace static `createDemoGameState()` usage with `createClientGame()`.
  - Pass controller state/actions to `GameBoard`, `ActionPanel`, and logs.
- Modify `apps/client/src/components/ActionPanel.vue`
  - Replace static preview buttons with real action buttons driven by props.
  - Keep existing M3-1.5 visual style.
- Modify `apps/client/src/components/GameBoard.vue`
  - Add optional `displayPositions` prop.
  - Use display position override only for token placement.
- Output screenshots after implementation:
  - `plan/assets/screenshots/phase1/m3-2-playable-turn-desktop-1440x900.png`
  - `plan/assets/screenshots/phase1/m3-2-playable-turn-mobile-390x844.png`

---

### Task 1: Add client game controller tests

**Files:**
- Create: `apps/client/src/game/clientGame.test.ts`
- Later implementation: `apps/client/src/game/clientGame.ts`

- [ ] **Step 1: Write failing tests for controller behavior**

Create `apps/client/src/game/clientGame.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { createClientGame, getAvailableActions, type ClientGame } from './clientGame';

async function finishCurrentTurn(game: ClientGame) {
  if (game.state.value.turnPhase === 'awaiting_buy_decision') {
    await game.sendIntent({ type: 'skip_buy' });
  }
  if (game.state.value.turnPhase === 'awaiting_build_decision') {
    await game.sendIntent({ type: 'skip_build' });
  }
  if (game.state.value.turnPhase === 'managing') {
    await game.sendIntent({ type: 'end_turn' });
  }
}

describe('getAvailableActions', () => {
  it('maps awaiting_roll to roll dice only', () => {
    const game = createClientGame({ wait: async () => undefined });
    game.state.value = { ...game.state.value, turnPhase: 'awaiting_roll' };

    expect(getAvailableActions(game.state.value)).toEqual([
      { label: '掷骰子', intent: { type: 'roll_dice' }, primary: true },
    ]);
  });

  it('maps buy, build, and managing phases to the expected buttons', () => {
    const game = createClientGame({ wait: async () => undefined });

    game.state.value = { ...game.state.value, turnPhase: 'awaiting_buy_decision' };
    expect(getAvailableActions(game.state.value).map((action) => action.label)).toEqual(['买地', '放弃']);

    game.state.value = { ...game.state.value, turnPhase: 'awaiting_build_decision' };
    expect(getAvailableActions(game.state.value).map((action) => action.label)).toEqual(['盖房', '跳过']);

    game.state.value = { ...game.state.value, turnPhase: 'managing' };
    expect(getAvailableActions(game.state.value).map((action) => action.label)).toEqual(['结束回合']);
  });

  it('disables gameplay actions while unresolved debt is present', () => {
    const game = createClientGame({ wait: async () => undefined });
    game.state.value = {
      ...game.state.value,
      debt: { debtorId: game.state.value.currentPlayerId, amount: 100, creditorId: null, resume: { payments: [] } },
    };

    expect(getAvailableActions(game.state.value)).toEqual([]);
  });
});

describe('createClientGame', () => {
  it('initializes display positions from the engine player positions', () => {
    const game = createClientGame({ wait: async () => undefined });

    expect(Object.fromEntries(game.state.value.players.map((player) => [player.id, player.position]))).toEqual(game.displayPositions.value);
  });

  it('rolls through the real engine and aligns display position after playback', async () => {
    const game = createClientGame({ wait: async () => undefined });
    const actorId = game.state.value.currentPlayerId;

    await game.sendIntent({ type: 'roll_dice' });

    const actor = game.state.value.players.find((player) => player.id === actorId)!;
    expect(game.dice.value).not.toBeNull();
    expect(game.dice.value).toHaveLength(2);
    expect(game.displayPositions.value[actorId]).toBe(actor.position);
    expect(game.isAnimating.value).toBe(false);
    expect(game.lastError.value).toBeNull();
  });

  it('visits token_moved path cells in order during playback', async () => {
    const visited: number[] = [];
    let lastPosition: number | undefined;
    let actorId = '';
    const game = createClientGame({
      wait: async () => {
        const current = game.displayPositions.value[actorId];
        if (current !== undefined && current !== lastPosition) {
          visited.push(current);
          lastPosition = current;
        }
      },
    });
    actorId = game.state.value.currentPlayerId;
    const before = game.displayPositions.value[actorId];
    lastPosition = before;

    await game.sendIntent({ type: 'roll_dice' });

    expect(visited.length).toBeGreaterThan(0);
    expect(visited[0]).not.toBe(before);
    expect(visited[visited.length - 1]).toBe(game.displayPositions.value[actorId]);
  });

  it('refuses a second intent while animation is still playing', async () => {
    let release!: () => void;
    let waitCount = 0;
    const wait = () => {
      waitCount += 1;
      if (waitCount === 1) {
        return new Promise<void>((resolve) => { release = resolve; });
      }
      return Promise.resolve();
    };
    const game = createClientGame({ wait });
    const first = game.sendIntent({ type: 'roll_dice' });
    await Promise.resolve();
    const stateWhileAnimating = game.state.value;

    await game.sendIntent({ type: 'roll_dice' });

    expect(game.lastError.value).toBe('动画播放中，请稍候');
    expect(game.state.value).toBe(stateWhileAnimating);

    release();
    await first;
  });

  it('sets lastError and preserves state when the engine rejects an intent', async () => {
    const game = createClientGame({ wait: async () => undefined });
    const before = game.state.value;

    await game.sendIntent({ type: 'buy_property' });

    expect(game.state.value).toBe(before);
    expect(game.lastError.value).toBe('当前阶段不能执行这个操作');
  });

  it('can complete two consecutive turns without desynchronizing display positions', async () => {
    const game = createClientGame({ wait: async () => undefined });
    const firstPlayerId = game.state.value.currentPlayerId;

    await game.sendIntent({ type: 'roll_dice' });
    await finishCurrentTurn(game);

    const secondPlayerId = game.state.value.currentPlayerId;
    expect(secondPlayerId).not.toBe(firstPlayerId);

    await game.sendIntent({ type: 'roll_dice' });

    const secondPlayer = game.state.value.players.find((player) => player.id === secondPlayerId)!;
    expect(game.displayPositions.value[secondPlayerId]).toBe(secondPlayer.position);
  });
});
```

- [ ] **Step 2: Run the controller tests and verify RED**

Run:

```bash
pnpm vitest run apps/client/src/game/clientGame.test.ts
```

Expected: FAIL because `./clientGame` does not exist.

- [ ] **Step 3: Commit is not allowed yet**

Do not commit failing tests alone. Continue to Task 2 and make them pass first.

---

### Task 2: Implement client game controller

**Files:**
- Create: `apps/client/src/game/clientGame.ts`
- Test: `apps/client/src/game/clientGame.test.ts`

- [ ] **Step 1: Implement the controller minimally**

Create `apps/client/src/game/clientGame.ts` with:

```ts
import { computed, ref, shallowRef } from 'vue';
import type { ComputedRef, Ref, ShallowRef } from 'vue';
import type { GameEvent, GameState, Intent } from '@richman/engine';
import { applyIntent } from '@richman/engine';
import { createDemoGameState } from './demoState';
import { formatMoney } from '../ui/format';

export interface ClientAction {
  label: string;
  intent: Intent;
  primary?: boolean;
}

export interface CreateClientGameOptions {
  wait?: (ms: number) => Promise<void>;
}

export interface ClientGame {
  state: ShallowRef<GameState>;
  displayPositions: Ref<Record<string, number>>;
  dice: Ref<number[] | null>;
  eventMessage: Ref<string>;
  isAnimating: Ref<boolean>;
  lastError: Ref<string | null>;
  availableActions: ComputedRef<ClientAction[]>;
  sendIntent: (intent: Intent) => Promise<void>;
}

const DEFAULT_STEP_MS = 120;

const ERROR_MESSAGES: Record<string, string> = {
  NOT_YOUR_TURN: '还没轮到这位玩家',
  WRONG_PHASE: '当前阶段不能执行这个操作',
  INSUFFICIENT_FUNDS: '现金不足',
  ILLEGAL_INTENT: '这个操作现在不可用',
};

export function getAvailableActions(state: GameState): ClientAction[] {
  if (state.debt) return [];

  switch (state.turnPhase) {
    case 'awaiting_roll':
      return [{ label: '掷骰子', intent: { type: 'roll_dice' }, primary: true }];
    case 'awaiting_buy_decision':
      return [
        { label: '买地', intent: { type: 'buy_property' }, primary: true },
        { label: '放弃', intent: { type: 'skip_buy' } },
      ];
    case 'awaiting_build_decision':
      return [
        { label: '盖房', intent: { type: 'build_house' }, primary: true },
        { label: '跳过', intent: { type: 'skip_build' } },
      ];
    case 'managing':
      return [{ label: '结束回合', intent: { type: 'end_turn' }, primary: true }];
  }
}

export function createClientGame(options: CreateClientGameOptions = {}): ClientGame {
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms)));
  const state = shallowRef(createDemoGameState());
  const displayPositions = ref<Record<string, number>>(Object.fromEntries(state.value.players.map((player) => [player.id, player.position])));
  const dice = ref<number[] | null>(null);
  const currentPlayer = state.value.players.find((player) => player.id === state.value.currentPlayerId)!;
  const eventMessage = ref(`轮到 ${currentPlayer.nickname}`);
  const isAnimating = ref(false);
  const lastError = ref<string | null>(null);

  const availableActions = computed(() => getAvailableActions(state.value));

  async function sendIntent(intent: Intent) {
    if (isAnimating.value) {
      lastError.value = '动画播放中，请稍候';
      return;
    }

    if (state.value.debt) {
      lastError.value = '资金不足，债务处理将在下一切片接入';
      return;
    }

    lastError.value = null;
    const result = applyIntent(state.value, state.value.currentPlayerId, intent);
    if (!result.ok) {
      lastError.value = ERROR_MESSAGES[result.code] ?? '这个操作现在不可用';
      return;
    }

    isAnimating.value = true;
    state.value = result.state;
    await playEvents(result.events);
    displayPositions.value = Object.fromEntries(state.value.players.map((player) => [player.id, player.position]));
    isAnimating.value = false;
  }

  async function playEvents(events: GameEvent[]) {
    for (const event of events) {
      await playEvent(event);
    }
  }

  async function playEvent(event: GameEvent) {
    switch (event.type) {
      case 'dice_rolled': {
        const player = state.value.players.find((candidate) => candidate.id === event.playerId);
        dice.value = event.dice;
        eventMessage.value = `${player?.nickname ?? event.playerId} 掷出 ${event.dice.join(' + ')}`;
        await wait(DEFAULT_STEP_MS);
        return;
      }
      case 'token_moved': {
        const player = state.value.players.find((candidate) => candidate.id === event.playerId);
        for (const cellId of event.path) {
          const cell = state.value.board.cells.find((candidate) => candidate.id === cellId);
          displayPositions.value = { ...displayPositions.value, [event.playerId]: cellId };
          eventMessage.value = `${player?.nickname ?? event.playerId} 前进到 ${cell?.name ?? `第 ${cellId} 格`}`;
          await wait(DEFAULT_STEP_MS);
        }
        return;
      }
      case 'salary_collected':
        eventMessage.value = `经过起点，领取 ¥${formatMoney(event.amount)}`;
        await wait(DEFAULT_STEP_MS);
        return;
      case 'property_bought': {
        const player = state.value.players.find((candidate) => candidate.id === event.playerId);
        const cell = state.value.board.cells.find((candidate) => candidate.id === event.cellId);
        eventMessage.value = `${player?.nickname ?? event.playerId} 买下 ${cell?.name ?? `第 ${event.cellId} 格`}`;
        await wait(DEFAULT_STEP_MS);
        return;
      }
      case 'buy_declined':
        eventMessage.value = '放弃购买';
        await wait(DEFAULT_STEP_MS);
        return;
      case 'house_built': {
        const cell = state.value.board.cells.find((candidate) => candidate.id === event.cellId);
        const cellLabel = cell?.name ?? `第 ${event.cellId} 格`;
        eventMessage.value = event.level >= 5 ? `${cellLabel} 建成旅馆` : `${cellLabel} 升到 ${event.level} 级`;
        await wait(DEFAULT_STEP_MS);
        return;
      }
      case 'turn_ended': {
        const player = state.value.players.find((candidate) => candidate.id === event.playerId);
        eventMessage.value = `${player?.nickname ?? event.playerId} 回合结束`;
        await wait(DEFAULT_STEP_MS);
        return;
      }
      case 'turn_started': {
        const player = state.value.players.find((candidate) => candidate.id === event.playerId);
        eventMessage.value = `轮到 ${player?.nickname ?? event.playerId}`;
        await wait(DEFAULT_STEP_MS);
        return;
      }
      default:
        eventMessage.value = event.type;
        await wait(DEFAULT_STEP_MS);
    }
  }

  return {
    state,
    displayPositions,
    dice,
    eventMessage,
    isAnimating,
    lastError,
    availableActions,
    sendIntent,
  };
}
```

- [ ] **Step 2: Run the controller tests and verify GREEN**

Run:

```bash
pnpm vitest run apps/client/src/game/clientGame.test.ts
```

Expected: PASS, 9 tests passed.

- [ ] **Step 3: Run typecheck for new controller types**

Run:

```bash
pnpm typecheck
```

Expected: PASS. If TypeScript reports `window` unavailable in tests, replace the default wait implementation with `globalThis.setTimeout`.

- [ ] **Step 4: Commit controller and tests**

Run:

```bash
git add apps/client/src/game/clientGame.ts apps/client/src/game/clientGame.test.ts
git commit -m "M3-2 add client game controller"
```

---

### Task 3: Wire animated token positions into GameBoard

**Files:**
- Modify: `apps/client/src/components/GameBoard.vue`
- Test: `apps/client/src/game/clientGame.test.ts` already covers display position state; browser verification covers rendered token movement because no Vue component test dependency exists.

- [ ] **Step 1: Change GameBoard props and token placement**

In `GameBoard.vue`, replace:

```ts
const props = defineProps<{ state: GameState }>();
```

with:

```ts
const props = defineProps<{
  state: GameState;
  displayPositions?: Record<string, number>;
}>();
```

Replace `tokensOn` with:

```ts
function tokensOn(cellId: number) {
  return props.state.players.filter((player) => {
    const displayPosition = props.displayPositions?.[player.id] ?? player.position;
    return displayPosition === cellId && !player.bankrupt;
  });
}
```

- [ ] **Step 2: Run existing board layout tests**

Run:

```bash
pnpm vitest run apps/client/src/ui/boardLayout.test.ts
```

Expected: PASS, 6 tests passed. This confirms placement semantics were not changed.

- [ ] **Step 3: Run client build**

Run:

```bash
pnpm --filter @richman/client build
```

Expected: PASS. This catches template/type errors from the prop change.

- [ ] **Step 4: Commit GameBoard wiring**

Run:

```bash
git add apps/client/src/components/GameBoard.vue
git commit -m "M3-2 support animated token positions"
```

---

### Task 4: Convert ActionPanel to real actions

**Files:**
- Modify: `apps/client/src/components/ActionPanel.vue`
- Uses types from: `apps/client/src/game/clientGame.ts`

- [ ] **Step 1: Replace static script with typed props and emit**

Replace the `<script setup lang="ts">` block with:

```vue
<script setup lang="ts">
import type { ClientAction } from '../game/clientGame';

const props = defineProps<{
  actions: ClientAction[];
  dice: number[] | null;
  eventMessage: string;
  isAnimating: boolean;
  lastError: string | null;
}>();

const emit = defineEmits<{
  action: [action: ClientAction];
}>();

function handleAction(action: ClientAction) {
  if (props.isAnimating) return;
  emit('action', action);
}
</script>
```

- [ ] **Step 2: Replace static template with real dice/actions**

Replace the `<template>` block with:

```vue
<template>
  <section class="action-panel" aria-label="操作面板">
    <div class="turn-copy">M3-2 最小可玩回合</div>
    <div class="panel-stage">
      <div class="dice-stage" aria-label="骰子">
        <span v-if="dice" class="die">{{ dice[0] }}</span>
        <span v-if="dice" class="die">{{ dice[1] }}</span>
        <span v-if="!dice" class="die placeholder">?</span>
        <span v-if="!dice" class="die placeholder">?</span>
      </div>
      <div class="event-ribbon">{{ lastError ?? eventMessage }}</div>
    </div>
    <div class="button-row">
      <button
        v-for="action in actions"
        :key="action.label"
        type="button"
        :class="action.primary ? 'btn-enabled' : 'btn-secondary'"
        :disabled="isAnimating"
        @click="handleAction(action)"
      >
        {{ action.label }}
      </button>
      <p v-if="actions.length === 0" class="no-actions">资金不足，债务处理将在下一切片接入</p>
    </div>
  </section>
</template>
```

- [ ] **Step 3: Add secondary button and busy styles**

Replace the entire existing `button`, `button:disabled`, `.btn-enabled`, `.btn-disabled`, and related action button rules with:
```css
button {
  border: 0;
  border-radius: 12px;
  padding: 10px 12px;
  font-weight: 800;
  cursor: pointer;
}

button:disabled {
  cursor: wait;
  opacity: 0.72;
}

.btn-enabled {
  background: var(--button-enabled-bg);
  color: var(--button-enabled-text);
  box-shadow: 0 2px 6px rgb(192 57 43 / 28%);
}

.btn-secondary {
  background: var(--button-disabled-bg);
  color: var(--button-disabled-text);
}

.no-actions {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--color-muted);
  font-weight: 700;
  text-align: center;
}

.placeholder {
  color: var(--color-muted);
}
```

The old `.btn-disabled` rule and the old `.btn-enabled { cursor: not-allowed; }` declaration must not remain.

- [ ] **Step 4: Run client build**

Run:

```bash
pnpm --filter @richman/client build
```

Expected: PASS.

- [ ] **Step 5: Commit ActionPanel conversion**

Run:

```bash
git add apps/client/src/components/ActionPanel.vue
git commit -m "M3-2 wire action panel controls"
```

---

### Task 5: Wire controller through App.vue and verify playable loop

**Files:**
- Modify: `apps/client/src/App.vue`

- [ ] **Step 1: Replace static demo state with controller**

Replace the `<script setup lang="ts">` block in `App.vue` with:

```vue
<script setup lang="ts">
import { computed } from 'vue';
import GameBoard from './components/GameBoard.vue';
import PlayerRail from './components/PlayerRail.vue';
import ActionPanel from './components/ActionPanel.vue';
import { createClientGame, type ClientAction } from './game/clientGame';

const game = createClientGame();

const recentLogs = computed(() => game.state.value.recentLog.slice(-3));

function handleAction(action: ClientAction) {
  void game.sendIntent(action.intent);
}
</script>
```

- [ ] **Step 2: Pass controller state to child components**

Replace the relevant template section with:

```vue
<PlayerRail
  class="players"
  :players="game.state.value.players"
  :current-player-id="game.state.value.currentPlayerId"
/>
<GameBoard class="board" :state="game.state.value" :display-positions="game.displayPositions.value" />
<aside class="side-panel">
  <ActionPanel
    :actions="game.availableActions.value"
    :dice="game.dice.value"
    :event-message="game.eventMessage.value"
    :is-animating="game.isAnimating.value"
    :last-error="game.lastError.value"
    @action="handleAction"
  />
  <section class="log-card">
    <h2>最近日志</h2>
    <p v-for="(event, index) in recentLogs" :key="index">{{ event.type }}</p>
  </section>
</aside>
```

- [ ] **Step 3: Run focused and full verification**

Run:

```bash
pnpm vitest run apps/client/src/game/clientGame.test.ts apps/client/src/ui/boardLayout.test.ts
pnpm test
pnpm typecheck
pnpm validate-data
pnpm --filter @richman/client build
```

Expected:

- Focused tests pass.
- Full test suite passes with the current test count plus the new controller tests.
- Typecheck passes.
- Data validation passes.
- Client build passes.

- [ ] **Step 4: Browser smoke test desktop**

Start dev server:

```bash
pnpm dev -- --port 5173 --host 127.0.0.1
```

In browser automation at 1440×900:

1. Open `http://127.0.0.1:5173/`.
2. Confirm only `掷骰子` is initially visible in the action panel.
3. Click `掷骰子`.
4. Confirm dice numbers replace `?` placeholders.
5. Confirm action buttons disable during movement.
6. Confirm token position changes at least once.
7. If `买地`/`放弃` appears, click one.
8. If `盖房`/`跳过` appears, click one.
9. Click `结束回合` when visible.
10. Confirm `currentPlayerId` changes in the player rail.
11. Repeat one more full turn: click `掷骰子`, resolve `买地`/`放弃` or `盖房`/`跳过` if shown, then click `结束回合` when visible.
12. Confirm the second turn also changes `currentPlayerId` and no debt message appears. If a rare debt path appears during this smoke test, reload and retry; debt recovery is intentionally out of scope for M3-2.
13. Save `plan/assets/screenshots/phase1/m3-2-playable-turn-desktop-1440x900.png`.

- [ ] **Step 5: Browser smoke test mobile**

At 390×844 mobile viewport:

1. Reload the page.
2. Confirm no horizontal overflow.
3. Click `掷骰子`.
4. Confirm dice/event/action panel remains readable.
5. Save `plan/assets/screenshots/phase1/m3-2-playable-turn-mobile-390x844.png`.

- [ ] **Step 6: Commit App wiring and screenshots**

Run:

```bash
git add \
  apps/client/src/App.vue \
  plan/assets/screenshots/phase1/m3-2-playable-turn-desktop-1440x900.png \
  plan/assets/screenshots/phase1/m3-2-playable-turn-mobile-390x844.png
git commit -m "M3-2 wire playable turn loop"
```

---

### Task 6: Final review and handoff

**Files:**
- Modify only if verification reveals a real defect.

- [ ] **Step 1: Request independent code review**

Dispatch reviewer with this scope:

```text
Review M3-2 playable turn implementation against docs/superpowers/specs/2026-07-07-m3-2-playable-turn-design.md and docs/superpowers/plans/2026-07-07-m3-2-playable-turn.md.

Focus on:
- controller/engine boundary
- intent serialization while animation plays
- displayPositions matching engine state after playback
- turnPhase -> action mapping
- no board data/layout semantic changes
- no out-of-scope debt/sell/card/victory UI creep
- tests and browser verification evidence
```

- [ ] **Step 2: Fix any Critical or Important review findings**

For each real finding:

1. Write or update a failing test first when the finding is behavioral.
2. Implement the minimal fix.
3. Re-run the focused test and full relevant verification.
4. Commit with an English message.

- [ ] **Step 3: Final verification evidence**

Run:

```bash
pnpm test
pnpm typecheck
pnpm validate-data
pnpm --filter @richman/client build
```

Expected: all pass.

- [ ] **Step 4: Final status check**

Run:

```bash
git status --short
git log --oneline -6
```

Expected: only intentionally untracked handoff docs may remain; M3-2 implementation commits are present.

- [ ] **Step 5: Report outcome**

Final response must include:

- Commits created.
- Files changed.
- Verification commands and observed results.
- Screenshot paths.
- Any remaining out-of-scope items.
