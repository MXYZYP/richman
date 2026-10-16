<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { getActiveMapPack, listActiveMaps } from '@richman/board-data';
import type { BotDifficulty } from '@richman/engine';
import MapPicker from './MapPicker.vue';
import {
  BOT_DIFFICULTY_OPTIONS,
  createDefaultGameSetup,
  resolveGameSetupMap,
  updateGameSetupBotDifficulty,
  updateGameSetupMapId,
  updateGameSetupCounts,
  validateGameSetup,
  type GameSetupDependencies,
  type GameSetupForm,
} from '../game/gameSetup';
import type {
  LocalSaveCard,
  LocalSaveIdentity,
  LocalSaveObservedRecord,
  LocalSaveSummary,
} from '../session/localGameSave';
// 删除确认是纯决策逻辑（「这一下该不该真的删」），与存档读写同源；
// 它现在只服务这一页 —— 首页那版随本机存档一起搬了过来。
import {
  localCardKey,
  requestLocalDelete as planLocalDelete,
  type LocalDeleteConfirmation,
} from '../views/localDeleteConfirmation';

const defaultSetupDependencies = { catalog: listActiveMaps(), resolveActive: getActiveMapPack };

const props = defineProps<{
  initialSetup?: GameSetupForm;
  dependencies?: GameSetupDependencies;
  replacementSummary?: LocalSaveSummary | null;
  storageUnavailable?: boolean;
  storagePrompt?: boolean;
  saveError?: string | null;
  /** 本机存档卡（「继续单机」）。原来挂在首页中部，现在跟着「要玩什么」一起落到这一页。 */
  localSaveCards?: readonly LocalSaveCard[];
}>();
const setupDependencies = props.dependencies ?? defaultSetupDependencies;

const emit = defineEmits<{
  start: [setup: GameSetupForm];
  back: [];
  confirmReplacement: [];
  cancelReplacement: [];
  retryStorage: [];
  startTemporary: [];
  resumeLocal: [observed: LocalSaveIdentity];
  deleteLocal: [observed: LocalSaveObservedRecord];
}>();

const setup = ref(cloneSetup(props.initialSetup ?? createDefaultGameSetup(setupDependencies)));
const validation = computed(() => validateGameSetup(setup.value, setupDependencies));
const totalPlayers = computed(() => setup.value.humanCount + setup.value.botCount);
// #8：单机热座上限 6 人，与联机（roomManager.MAX_PLAYERS）对齐。
const MAX_SETUP_PLAYERS = 6;
const humanOptions = [1, 2, 3, 4, 5, 6];
const botOptions = [0, 1, 2, 3, 4, 5];
// #6：电脑难度只在真的有电脑玩家时才出现，所以选项常驻在组件里、由 botCount 控制显隐。
// 档位文案与联机大厅（LobbyView）共用 gameSetup.ts 里的一份定义，避免两处说岔。
const botDifficultyOptions = BOT_DIFFICULTY_OPTIONS;
const botDifficultyHint = computed(
  () => botDifficultyOptions.find((option) => option.value === setup.value.botDifficulty)?.hint ?? '',
);
const minCashGoal = computed(() => setup.value.config.initialCash + 1);
/** 当前地图自己的最高房级：过路费按 rents[level] 取档，超出地图档位就会收 0 元租金。 */
const mapMaxHouseLevel = computed(
  () => resolveGameSetupMap(setup.value, setupDependencies)?.game.config.maxHouseLevel
    ?? setup.value.config.maxHouseLevel,
);
const dialogOpen = computed(() => props.replacementSummary != null || props.storagePrompt === true);
const replacementCancelButton = ref<HTMLButtonElement | null>(null);
const storageRetryButton = ref<HTMLButtonElement | null>(null);
const startButton = ref<HTMLButtonElement | null>(null);

// ---- 继续单机 · 本机存档 ----
// 两次点击确认删除：planLocalDelete 第一次只把这张卡标成「待确认」，
// 第二次（同一张卡）才真的把 observed 交给上层去删。逻辑在 localDeleteConfirmation.ts 里，
// 与「存档列表可能已经变了」的复核对齐同一套判据。
const confirmingLocalDelete = ref<LocalDeleteConfirmation | null>(null);

function requestLocalDelete(card: LocalSaveCard): void {
  const request = planLocalDelete(confirmingLocalDelete.value, card);
  confirmingLocalDelete.value = request.confirmation;
  if (request.observed !== null) emit('deleteLocal', request.observed);
}

function formatSavedAt(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

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

function selectMap(mapId: string) {
  // 换图后原房级可能超出新图档位（如 world-tour 只有 4 级）：夹取逻辑在 gameSetup.ts 的
  // updateGameSetupMapId 里，单机表单与联机大厅共用同一份模型行为，界面不再各写一遍。
  setup.value = updateGameSetupMapId(setup.value, mapId, setupDependencies);
}

function setBotDifficulty(difficulty: BotDifficulty) {
  setup.value = updateGameSetupBotDifficulty(setup.value, difficulty);
}

function updateNickname(index: number, event: Event) {
  setup.value.players[index].nickname = (event.target as HTMLInputElement).value;
}

function updateCashGoal(event: Event) {
  setup.value.cashGoal = Number((event.target as HTMLInputElement).value);
}

// 规则自定义（P2-10）：初始资金 / 最高房级直接覆盖；抵押利率以百分比展示、存为小数。
function updateRuleConfig(field: 'initialCash' | 'maxHouseLevel', event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  setup.value = { ...setup.value, config: { ...setup.value.config, [field]: value } };
}

function updateMortgageRate(event: Event) {
  const percent = Number((event.target as HTMLInputElement).value);
  const rate = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) / 100 : 0.1;
  setup.value = { ...setup.value, config: { ...setup.value.config, mortgageInterestRate: rate } };
}

function submitSetup() {
  if (!validation.value.ok || dialogOpen.value) return;
  emit('start', cloneSetup(setup.value));
}

function isHumanOptionDisabled(humanCount: number): boolean {
  const total = humanCount + setup.value.botCount;
  return total < 2 || total > MAX_SETUP_PLAYERS;
}

function isBotOptionDisabled(botCount: number): boolean {
  const total = setup.value.humanCount + botCount;
  return total < 2 || total > MAX_SETUP_PLAYERS;
}

function cloneSetup(value: GameSetupForm): GameSetupForm {
  return {
    mapId: value.mapId,
    humanCount: value.humanCount,
    botCount: value.botCount,
    cashGoalEnabled: value.cashGoalEnabled,
    cashGoal: value.cashGoal,
    config: { ...value.config },
    players: value.players.map((player) => ({ ...player })),
    botDifficulty: value.botDifficulty,
  };
}
</script>

<template>
  <main class="setup-shell">
    <section class="setup-card" aria-labelledby="setup-title">
      <p class="setup-eyebrow">无需联网 · 随时开局</p>
      <h1 id="setup-title">单机模式</h1>
      <p class="setup-copy">选地图、真人和电脑数量（最多 6 人），确认昵称后进入棋盘。不需要登录，也不需要网络。</p>

      <fieldset class="setup-fields" :disabled="dialogOpen">
        <MapPicker
          :model-value="setup.mapId"
          :maps="setupDependencies.catalog"
          label="地图"
          @update:model-value="selectMap"
        />

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

        <!-- #6：难度只在真的有电脑玩家时才出现 —— 没选电脑就问难度是问不出所以然的。 -->
        <section v-if="setup.botCount > 0" class="setup-difficulty" aria-label="电脑玩家难度">
          <span class="setup-difficulty-label">电脑玩家难度</span>
          <div class="setup-difficulty-options" role="radiogroup" aria-label="电脑玩家难度">
            <button
              v-for="option in botDifficultyOptions"
              :key="option.value"
              type="button"
              class="setup-difficulty-option"
              :class="{ active: setup.botDifficulty === option.value }"
              :aria-pressed="setup.botDifficulty === option.value"
              @click="setBotDifficulty(option.value)"
            >{{ option.label }}</button>
          </div>
          <p class="setup-difficulty-hint">{{ botDifficultyHint }}仅影响电脑决策，不影响真人玩家。</p>
        </section>

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

        <section class="setup-rules" aria-label="规则自定义">
          <h2>规则自定义</h2>
          <label class="setup-rule-field">
            <span>初始资金</span>
            <input type="number" :min="1000" :step="1000" :value="setup.config.initialCash" @input="updateRuleConfig('initialCash', $event)" />
          </label>
          <label class="setup-rule-field">
            <span>最高房级</span>
            <input type="number" min="1" :max="mapMaxHouseLevel" step="1" :value="setup.config.maxHouseLevel" @input="updateRuleConfig('maxHouseLevel', $event)" />
          </label>
          <label class="setup-rule-field">
            <span>抵押利率（%）</span>
            <input type="number" min="0" max="100" :step="5" :value="Math.round(setup.config.mortgageInterestRate * 100)" @input="updateMortgageRate" />
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
        <p>你可以重试存储，或开始一局仅存在于本机内存的临时游戏（关闭页面即丢失，与在线房间无关）。</p>
        <div class="setup-confirm-actions">
          <button ref="storageRetryButton" type="button" class="setup-start" @click="emit('retryStorage')">重试保存</button>
          <button type="button" class="setup-secondary" @click="emit('startTemporary')">开始临时游戏</button>
        </div>
      </section>
      <div class="setup-actions">
        <button type="button" class="setup-secondary" @click="emit('back')">返回首页</button>
        <button ref="startButton" type="button" class="setup-start" :disabled="!validation.ok || dialogOpen" @click="submitSetup">开始新对局</button>
      </div>

      <!-- 继续单机（原首页中部那块）：存档跟着「要玩什么」走，不再和首页别的内容抢位置。 -->
      <section v-if="localSaveCards && localSaveCards.length > 0" class="local-saves" aria-labelledby="local-saves-title">
        <h2 id="local-saves-title">继续单机 · 本机存档</h2>
        <p class="local-saves-hint">以下为本机存档，仅保存在这台设备上，与在线房间互不影响。</p>
        <article v-for="card in localSaveCards" :key="localCardKey(card)" class="local-save-card">
          <template v-if="card.kind === 'valid'">
            <div class="local-save-copy">
              <strong>{{ card.summary.title }}</strong>
              <span>{{ card.summary.players.map((player) => `${player.nickname}${player.isBot ? '（电脑）' : ''}`).join('、') }}</span>
              <span>第 {{ card.summary.turn }} 回合 · 保存于 {{ formatSavedAt(card.summary.updatedAt) }}</span>
            </div>
            <div class="local-save-actions">
              <button type="button" class="setup-start" @click="emit('resumeLocal', card.summary)">继续游戏</button>
              <button type="button" class="setup-secondary" @click="requestLocalDelete(card)">
                {{ confirmingLocalDelete?.key === localCardKey(card) ? '确认删除' : '删除存档' }}
              </button>
              <button
                v-if="confirmingLocalDelete?.key === localCardKey(card)"
                type="button"
                class="setup-secondary"
                @click="confirmingLocalDelete = null"
              >取消</button>
            </div>
          </template>
          <template v-else>
            <div class="local-save-copy">
              <strong>无法恢复的本机存档</strong>
              <span>{{ card.reason }}</span>
            </div>
            <div class="local-save-actions">
              <button type="button" class="setup-secondary" :disabled="card.recordToken === undefined" @click="requestLocalDelete(card)">
                {{ confirmingLocalDelete?.key === localCardKey(card) ? '确认删除' : '删除存档' }}
              </button>
              <button
                v-if="confirmingLocalDelete?.key === localCardKey(card)"
                type="button"
                class="setup-secondary"
                @click="confirmingLocalDelete = null"
              >取消</button>
            </div>
          </template>
        </article>
      </section>
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
    var(--surface-card),
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
  background: var(--surface-input);
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

.setup-rules {
  display: grid;
  gap: 12px;
  padding: 14px 12px;
  border-radius: 18px;
  background: rgb(255 255 255 / 58%);
}

.setup-rules h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 900;
  color: var(--color-primary);
}

.setup-rule-field {
  display: grid;
  grid-template-columns: 1fr 160px;
  gap: 12px;
  align-items: center;
}

.setup-rule-field span {
  color: var(--color-muted);
  font-weight: 800;
}

.setup-error {
  margin: 0;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--color-error-bg);
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

/* 阈值与首页 / GameView 统一到 1024px：折叠屏内屏与小平板竖屏常落在 768–1024，
   用 767 会让它们拿到桌面版的多列布局，选项与规则卡被挤成窄条。 */
@media (max-width: 1024px) {
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
  .setup-rule-card,
  .setup-rule-field {
    grid-template-columns: 1fr;
  }
}

/* 本机存档卡：原样从首页搬来（配色边条取自 P2「视觉层次」那一组）。 */
.local-saves {
  display: grid;
  gap: 10px;
}

.local-saves h2 {
  margin: 0;
  color: var(--color-primary);
  font-size: 18px;
}

.local-saves-hint {
  margin: -4px 0 0;
  font-size: 12px;
  color: var(--color-muted);
}

.local-save-card {
  min-width: 0;
  display: grid;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--color-accent);
  border-radius: 16px;
  background: var(--event-bg);
}

.local-save-copy {
  min-width: 0;
  display: grid;
  gap: 3px;
  color: var(--event-text);
}

.local-save-copy span {
  overflow-wrap: anywhere;
  font-size: 13px;
}

.local-save-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.local-save-card { border-left: 4px solid var(--mode-local); }

</style>
