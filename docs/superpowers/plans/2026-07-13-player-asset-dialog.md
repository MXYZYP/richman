# Player Asset Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让顶部玩家卡可打开对应玩家的只读资产详情，并保持手机端三卡同屏与页尾“重新开局”布局。

**Architecture:** `PlayerRail.vue` 只负责发出玩家选择事件；`GameView.vue` 从现有 `RenderableGameState` 派生所选玩家、位置、债务和 `AssetRow[]`；新建 `PlayerAssetDialog.vue` 负责响应式弹层、关闭和滚动。复用 `getAssetRows`，不新增资产计算口径。

**Tech Stack:** Vue 3 Composition API、TypeScript、现有 CSS variables、Vitest、Chromium browser smoke test

---

### Task 1: Make player cards selectable

**Files:**
- Modify: `apps/client/src/components/PlayerRail.vue`

- [ ] **Step 1: Add the typed event contract**

```ts
const emit = defineEmits<{
  selectPlayer: [playerId: string];
}>();
```

- [ ] **Step 2: Replace each non-interactive card with a semantic button**

```vue
<button
  v-for="player in players"
  :key="player.id"
  type="button"
  class="player-card"
  :class="{ current: player.id === currentPlayerId, bankrupt: player.bankrupt }"
  :aria-label="`查看${player.nickname}的资产`"
  @click="emit('selectPlayer', player.id)"
>
  <!-- keep the existing avatar/player-info subtree unchanged -->
</button>
```

- [ ] **Step 3: Neutralize native button styles without changing layout**

```css
.player-card {
  appearance: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.player-card:focus-visible {
  outline: 3px solid var(--color-accent);
  outline-offset: 2px;
}
```

- [ ] **Step 4: Run the client typecheck**

Run: `pnpm --filter @richman/client exec vue-tsc --noEmit`

Expected: PASS; no Vue template or emit typing errors.

### Task 2: Add the responsive read-only dialog

**Files:**
- Create: `apps/client/src/components/PlayerAssetDialog.vue`
- Reuse: `apps/client/src/game/clientGame.ts` (`AssetRow`)

- [ ] **Step 1: Define a presentation-only prop contract**

```ts
import { onMounted, ref } from 'vue';
import type { PlayerColor, PlayerState } from '@richman/engine';
import type { AssetRow } from '../game/clientGame';
import { formatMoney } from '../ui/format';

defineProps<{
  player: PlayerState;
  currentPlayerId: string;
  positionName: string;
  debtAmount: number | null;
  assets: AssetRow[];
}>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const marks: Record<PlayerColor, string> = { red: '●', blue: '■', yellow: '▲', green: '★' };

onMounted(() => {
  dialog.value?.showModal();
  closeButton.value?.focus();
});

function closeFromBackdrop(event: MouseEvent): void {
  if (event.target === dialog.value) emit('close');
}
```

Use the platform modal `<dialog>` rather than a simulated overlay. `showModal()` makes the rest of the document inert, traps focus in the top layer, and emits `cancel` for Escape.

- [ ] **Step 2: Render the player identity, independent status badges, summary and complete asset list**

```vue
<Teleport to="body">
  <dialog
    ref="dialog"
    class="player-dialog-layer"
    :aria-labelledby="`player-dialog-${player.id}`"
    @cancel.prevent="emit('close')"
    @click="closeFromBackdrop"
  >
    <section class="player-dialog">
      <header>
        <div class="player-identity">
          <div class="dialog-avatar" :class="`avatar-${player.color}`">{{ marks[player.color] }}</div>
          <div>
            <span class="eyebrow">玩家资产</span>
            <h2 :id="`player-dialog-${player.id}`">{{ player.nickname }}</h2>
            <div class="status-badges" aria-label="玩家状态">
              <span v-if="player.isBot">BOT</span>
              <span v-if="player.id === currentPlayerId">当前回合</span>
              <span v-if="!player.online">离线</span>
              <span v-if="player.bankrupt">破产</span>
            </div>
          </div>
        </div>
        <button ref="closeButton" type="button" class="dialog-close" aria-label="关闭玩家资产" @click="emit('close')">×</button>
      </header>
      <dl class="player-summary">
        <div><dt>现金</dt><dd>¥{{ formatMoney(player.cash) }}</dd></div>
        <div><dt>当前位置</dt><dd>{{ positionName }}</dd></div>
        <div v-if="debtAmount !== null"><dt>待偿欠款</dt><dd>¥{{ formatMoney(debtAmount) }}</dd></div>
      </dl>
      <div class="asset-scroll">
        <p v-if="assets.length === 0" class="empty-assets">暂无房产</p>
        <ul v-else class="asset-grid">
          <li v-for="asset in assets" :key="asset.cellId" class="asset-card">
            <strong>{{ asset.displayName }}</strong>
            <span>{{ asset.subtype === 'normal' ? (asset.level === 5 ? '旅馆' : asset.level > 0 ? `${asset.level} 级房屋` : '裸地') : asset.subtype === 'station' ? '车站' : '公用事业' }}</span>
            <span v-if="asset.mortgaged" class="mortgaged">已抵押</span>
          </li>
        </ul>
      </div>
    </section>
  </dialog>
</Teleport>
```

- [ ] **Step 3: Add responsive CSS**

Reset `.player-dialog-layer` to a transparent, borderless top-layer container and style `.player-dialog-layer::backdrop` with `var(--overlay-scrim)`. Desktop contract: centered dialog, `width: min(720px, calc(100vw - 36px))`, `max-height: min(720px, calc(100dvh - 36px))`, asset grid using `repeat(auto-fit, minmax(150px, 1fr))`. Reuse the four existing player color variables for `.dialog-avatar`.

Mobile contract under `767px`: dialog margin aligns to the viewport bottom; dialog content gets `width: 100%`, `max-height: 80dvh`, rounded top corners only; `.asset-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }`; `.asset-scroll { overflow-y: auto; overscroll-behavior: contain; }`; no horizontal overflow.

- [ ] **Step 4: Run the client typecheck**

Run: `pnpm --filter @richman/client exec vue-tsc --noEmit`

Expected: PASS.

### Task 3: Wire dialog state into GameView

**Files:**
- Modify: `apps/client/src/views/GameView.vue`

- [ ] **Step 1: Import dependencies and define selected-player state**

```ts
import PlayerAssetDialog from '../components/PlayerAssetDialog.vue';
import { getAssetRows } from '../game/clientGame';

const selectedPlayerId = ref<string | null>(null);
let playerCardToRestore: HTMLElement | null = null;
const selectedPlayer = computed(() => gameState.value?.players.find((player) => player.id === selectedPlayerId.value) ?? null);
const selectedPlayerAssets = computed(() => selectedPlayer.value && gameState.value ? getAssetRows(gameState.value, selectedPlayer.value.id) : []);
const selectedPlayerPositionName = computed(() => {
  if (!selectedPlayer.value || !gameState.value) return '';
  return gameState.value.board.cells.find((cell) => cell.id === selectedPlayer.value!.position)?.name ?? '未知位置';
});
const selectedPlayerDebt = computed(() => {
  const debt = gameState.value?.debt;
  return debt && debt.debtorId === selectedPlayerId.value ? debt.amount : null;
});
```

- [ ] **Step 2: Add open/close handlers with focus restoration**

```ts
function openPlayerAssets(playerId: string): void {
  playerCardToRestore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  selectedPlayerId.value = playerId;
}

async function closePlayerAssets(): Promise<void> {
  selectedPlayerId.value = null;
  await nextTick();
  playerCardToRestore?.focus();
  playerCardToRestore = null;
}
```

Watch both session state and the player list. If `state.phase !== 'playing'` or `selectedPlayerId` no longer exists, clear the selection **without** restoring focus; this prevents the asset dialog from overlapping `SettlementDialog` or focusing a control behind it. Also clear selection during session replacement and component unmount.

- [ ] **Step 3: Connect PlayerRail and render the dialog**

```vue
<PlayerRail
  class="players"
  :players="gameState.players"
  :current-player-id="gameState.currentPlayerId"
  @select-player="openPlayerAssets"
/>

<PlayerAssetDialog
  v-if="selectedPlayer"
  :player="selectedPlayer"
  :current-player-id="gameState.currentPlayerId"
  :position-name="selectedPlayerPositionName"
  :debt-amount="selectedPlayerDebt"
  :assets="selectedPlayerAssets"
  @close="closePlayerAssets"
/>
```

The restart button is currently the first grid child in `.side-panel`, which is correct on desktop but wrong on mobile. Keep that desktop button, add a second button with the same `requestExit` handler immediately after the log section, and make the two variants mutually exclusive:

```vue
<button type="button" class="restart-button restart-desktop" @click="requestExit">{{ exitLabel }}</button>
<!-- existing panels and log -->
<button type="button" class="restart-button restart-mobile" @click="requestExit">{{ exitLabel }}</button>
```

```css
.restart-mobile { display: none; }

@media (max-width: 767px) {
  .restart-desktop { display: none; }
  .restart-mobile { display: block; }
}
```

This preserves the desktop position and gives mobile both the correct visual order and the correct keyboard Tab order.

- [ ] **Step 4: Run focused client checks**

Run: `pnpm exec vitest run apps/client/src/game/clientGame.test.ts apps/client/src/game/gameInteraction.test.ts`

Expected: both files PASS.

Run: `pnpm --filter @richman/client exec vue-tsc --noEmit && pnpm --filter @richman/client build`

Expected: PASS.

### Task 4: Browser acceptance

**Files:**
- No source changes unless a visible defect is found.

- [ ] **Step 1: Start the production preview**

Run: `pnpm --filter @richman/client build` then serve `apps/client/dist` on a local port.

- [ ] **Step 2: Verify mobile 390×844**

Check: three player cards remain on one row; each opens only its player; close button, backdrop and Escape close; focus returns to the clicked card; 0/1/2/12 assets use two columns and internal vertical scrolling; no horizontal scroll; “重新开局” remains after 战报记录.

- [ ] **Step 3: Verify desktop 1440×900**

Check: centered dialog; cards retain size/order/current highlight; restart placement unchanged.

- [ ] **Step 4: Verify online mode**

Open a live/public snapshot-backed session and confirm the same dialog renders from `RenderableGameState` without exposing private engine fields.
