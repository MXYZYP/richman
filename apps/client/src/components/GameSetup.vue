<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { getActiveMapPack, listActiveMaps } from '@richman/board-data';
import {
  createDefaultGameSetup,
  resolveGameSetupMap,
  updateGameSetupMapId,
  updateGameSetupCounts,
  validateGameSetup,
  type GameSetupDependencies,
  type GameSetupForm,
} from '../game/gameSetup';
import type { LocalSaveSummary } from '../session/localGameSave';

const defaultSetupDependencies = { catalog: listActiveMaps(), resolveActive: getActiveMapPack };

const props = defineProps<{
  initialSetup?: GameSetupForm;
  dependencies?: GameSetupDependencies;
  replacementSummary?: LocalSaveSummary | null;
  storageUnavailable?: boolean;
  storagePrompt?: boolean;
  saveError?: string | null;
}>();
const setupDependencies = props.dependencies ?? defaultSetupDependencies;

const emit = defineEmits<{
  start: [setup: GameSetupForm];
  back: [];
  confirmReplacement: [];
  cancelReplacement: [];
  retryStorage: [];
  startTemporary: [];
}>();

const setup = ref(cloneSetup(props.initialSetup ?? createDefaultGameSetup(setupDependencies)));
const validation = computed(() => validateGameSetup(setup.value, setupDependencies));
const totalPlayers = computed(() => setup.value.humanCount + setup.value.botCount);
const humanOptions = [1, 2, 3, 4];
const botOptions = [0, 1, 2, 3];
const minCashGoal = computed(() => {
  const initialCash = resolveGameSetupMap(setup.value, setupDependencies)?.game.config.initialCash;
  return initialCash === undefined ? 1 : initialCash + 1;
});
const dialogOpen = computed(() => props.replacementSummary != null || props.storagePrompt === true);
const replacementCancelButton = ref<HTMLButtonElement | null>(null);
const storageRetryButton = ref<HTMLButtonElement | null>(null);
const startButton = ref<HTMLButtonElement | null>(null);

watch(dialogOpen, async (open, wasOpen) => {
  await nextTick();
  if (open) {
    (props.replacementSummary != null ? replacementCancelButton.value : storageRetryButton.value)?.focus();
  } else if (wasOpen) {
    startButton.value?.focus();
  }
}, { immediate: true });

function setHumanCount(event: Event) {
  const humanCount = Number((event.target as HTMLSelectElement).value);
  setup.value = updateGameSetupCounts(setup.value, { humanCount });
}

function setBotCount(event: Event) {
  const botCount = Number((event.target as HTMLSelectElement).value);
  setup.value = updateGameSetupCounts(setup.value, { botCount });
}

function setMap(event: Event) {
  setup.value = updateGameSetupMapId(setup.value, (event.target as HTMLSelectElement).value);
}

function updateNickname(index: number, event: Event) {
  setup.value.players[index].nickname = (event.target as HTMLInputElement).value;
}

function updateCashGoal(event: Event) {
  setup.value.cashGoal = Number((event.target as HTMLInputElement).value);
}

function submitSetup() {
  if (!validation.value.ok || dialogOpen.value) return;
  emit('start', cloneSetup(setup.value));
}

function isHumanOptionDisabled(humanCount: number): boolean {
  const total = humanCount + setup.value.botCount;
  return total < 2 || total > 4;
}

function isBotOptionDisabled(botCount: number): boolean {
  const total = setup.value.humanCount + botCount;
  return total < 2 || total > 4;
}

function cloneSetup(value: GameSetupForm): GameSetupForm {
  return {
    mapId: value.mapId,
    humanCount: value.humanCount,
    botCount: value.botCount,
    cashGoalEnabled: value.cashGoalEnabled,
    cashGoal: value.cashGoal,
    players: value.players.map((player) => ({ ...player })),
  };
}
</script>

<template>
  <main class="setup-shell">
    <section class="setup-card" aria-labelledby="setup-title">
      <p class="setup-eyebrow">单机游玩 · 无需联网</p>
      <h1 id="setup-title">开始一局大富翁</h1>
      <p class="setup-copy">选择真人和电脑数量，确认昵称后进入棋盘。单机游玩，不需要登录。</p>

      <fieldset class="setup-fields" :disabled="dialogOpen">
        <label class="setup-map-field">
          <span>地图</span>
          <select aria-label="地图" :value="setup.mapId" @change="setMap">
            <option v-for="entry in setupDependencies.catalog" :key="entry.ref.id" :value="entry.ref.id">
              {{ entry.title }}
            </option>
          </select>
        </label>

        <div class="setup-counts" aria-label="玩家数量">
        <label>
          <span>真人玩家</span>
          <select :value="setup.humanCount" @change="setHumanCount">
            <option v-for="count in humanOptions" :key="count" :value="count" :disabled="isHumanOptionDisabled(count)">
              {{ count }} 人
            </option>
          </select>
        </label>
        <label>
          <span>电脑玩家</span>
          <select :value="setup.botCount" @change="setBotCount">
            <option v-for="count in botOptions" :key="count" :value="count" :disabled="isBotOptionDisabled(count)">
              {{ count }} 人
            </option>
          </select>
        </label>
        <strong>{{ totalPlayers }} 人开局</strong>
        </div>

        <div class="setup-roster" aria-label="玩家昵称">
        <label v-for="(player, index) in setup.players" :key="player.id" class="setup-player">
          <span>{{ player.isBot ? '电脑' : '真人' }} {{ index + 1 }}</span>
          <input :value="player.nickname" maxlength="12" @input="updateNickname(index, $event)" />
        </label>
        </div>

        <section class="setup-rule-card" aria-label="房规">
        <label class="setup-checkbox">
          <input v-model="setup.cashGoalEnabled" type="checkbox" />
          <span>开启现金目标</span>
        </label>
        <label class="setup-cash-goal" :class="{ disabled: !setup.cashGoalEnabled }">
          <span>现金目标</span>
          <input
            type="number"
            :min="minCashGoal"
            step="1000"
            :disabled="!setup.cashGoalEnabled"
            :value="setup.cashGoal"
            @input="updateCashGoal"
          />
        </label>
        </section>
      </fieldset>

      <p v-if="!validation.ok" class="setup-error" role="alert">{{ validation.message }}</p>
      <p v-if="storageUnavailable" class="setup-warning" role="alert">本浏览器无法保存进度，关闭页面后这局无法恢复</p>
      <p v-if="saveError" class="setup-error" role="alert">{{ saveError }}</p>

      <section v-if="replacementSummary" class="setup-confirm" role="dialog" aria-modal="true" aria-labelledby="replace-save-title">
        <h2 id="replace-save-title">将替换最旧存档</h2>
        <p>{{ replacementSummary.title }} · 第 {{ replacementSummary.turn }} 回合</p>
        <p>{{ replacementSummary.players.map((player) => player.nickname).join('、') }}</p>
        <div class="setup-confirm-actions">
          <button type="button" class="setup-start" @click="emit('confirmReplacement')">确认替换并开始</button>
          <button ref="replacementCancelButton" type="button" class="setup-secondary" @click="emit('cancelReplacement')">取消</button>
        </div>
      </section>

      <section v-if="storagePrompt" class="setup-confirm" role="dialog" aria-modal="true" aria-labelledby="storage-prompt-title">
        <h2 id="storage-prompt-title">无法保存这局</h2>
        <p>你可以重试存储，或明确开始一局关闭页面后无法恢复的临时游戏。</p>
        <div class="setup-confirm-actions">
          <button ref="storageRetryButton" type="button" class="setup-start" @click="emit('retryStorage')">重试保存</button>
          <button type="button" class="setup-secondary" @click="emit('startTemporary')">开始临时游戏</button>
        </div>
      </section>
      <div class="setup-actions">
        <button type="button" class="setup-secondary" @click="emit('back')">返回首页</button>
        <button ref="startButton" type="button" class="setup-start" :disabled="!validation.ok || dialogOpen" @click="submitSetup">开始游戏</button>
      </div>
    </section>
  </main>
</template>

<style scoped>
.setup-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 18px;
}

.setup-card {
  width: min(720px, 100%);
  display: grid;
  gap: 18px;
  padding: clamp(20px, 4vw, 34px);
  border: 1px solid var(--color-border);
  border-radius: 28px;
  background:
    linear-gradient(180deg, rgb(255 255 255 / 94%), rgb(247 243 234 / 84%)),
    var(--board-surface);
  box-shadow: 0 18px 48px rgb(53 39 20 / 14%);
}

.setup-eyebrow,
.setup-copy,
.setup-map-field span,
.setup-counts span,
.setup-player span,
.setup-rule-card span {
  color: var(--color-muted);
}

.setup-eyebrow {
  margin: 0;
  font-size: 12px;
  font-weight: 900;
  letter-spacing: 0.2em;
}

.setup-card h1 {
  margin: 0;
  color: var(--color-primary);
  font-size: clamp(30px, 6vw, 52px);
  line-height: 1;
}

.setup-copy {
  margin: 0;
  line-height: 1.6;
}

.setup-counts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr)) auto;
  gap: 12px;
  align-items: end;
}

.setup-fields {
  min-width: 0;
  display: grid;
  gap: 18px;
  margin: 0;
  padding: 0;
  border: 0;
}

.setup-counts label,
.setup-map-field,
.setup-player,
.setup-cash-goal {
  display: grid;
  gap: 6px;
}

.setup-counts strong {
  padding: 11px 14px;
  border-radius: 999px;
  background: var(--color-accent);
  color: var(--color-text);
  font-size: 13px;
  text-align: center;
  white-space: nowrap;
}

.setup-card select,
.setup-card input[type='text'],
.setup-card input:not([type]),
.setup-card input[type='number'] {
  min-height: 44px;
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  padding: 8px 10px;
  background: rgb(255 255 255 / 84%);
  color: var(--color-text);
  font-weight: 800;
}

.setup-card select:focus-visible,
.setup-card input:focus-visible,
.setup-start:focus-visible {
  outline: 3px solid var(--color-accent);
  outline-offset: 2px;
}

.setup-roster {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.setup-rule-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 180px;
  gap: 12px;
  align-items: center;
  padding: 12px;
  border-radius: 18px;
  background: rgb(255 255 255 / 58%);
}

.setup-checkbox {
  display: flex;
  gap: 10px;
  align-items: center;
  font-weight: 900;
}

.setup-checkbox input {
  width: 18px;
  height: 18px;
  accent-color: var(--color-primary);
}

.setup-cash-goal.disabled {
  opacity: 0.56;
}

.setup-error {
  margin: 0;
  padding: 10px 12px;
  border-radius: 12px;
  background: #ffe1d8;
  color: var(--color-primary);
  font-weight: 900;
}

.setup-warning,
.setup-confirm {
  margin: 0;
  padding: 12px;
  border-radius: 16px;
  background: var(--event-bg);
  color: var(--event-text);
}

.setup-confirm {
  display: grid;
  gap: 8px;
}

.setup-confirm h2,
.setup-confirm p {
  margin: 0;
}

.setup-confirm-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.setup-actions {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
  gap: 10px;
}

.setup-actions .setup-secondary {
  min-height: 48px;
}

.setup-secondary {
  min-height: 44px;
  border: 1px solid var(--color-border);
  border-radius: 14px;
  padding: 8px 14px;
  background: var(--board-surface);
  color: var(--color-text);
  font-weight: 900;
  cursor: pointer;
}

.setup-start {
  min-height: 48px;
  border: 0;
  border-radius: 16px;
  background: var(--button-enabled-bg);
  color: var(--button-enabled-text);
  font-size: 1rem;
  font-weight: 900;
  cursor: pointer;
}

.setup-start:disabled {
  background: var(--button-disabled-bg);
  color: var(--button-disabled-text);
  cursor: not-allowed;
}

@media (max-width: 767px) {
  .setup-shell {
    padding: 10px;
    place-items: start center;
  }

  .setup-card {
    gap: 14px;
    border-radius: 22px;
  }

  .setup-counts,
  .setup-roster,
  .setup-rule-card {
    grid-template-columns: 1fr;
  }
}
</style>
