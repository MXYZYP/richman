<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { getActiveMapPack, listActiveMaps } from '@richman/board-data';
import type { BotDifficulty } from '@richman/engine';
import MapPicker from './MapPicker.vue';
import { setCashUnitForMap } from '../ui/format';
import ViewShell from '../views/ViewShell.vue';
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
// 换地图时同步货币单位：设置页的规则摘要里就有初始资金 / 地价，不能等到开局才换。
watch(() => setup.value.mapId, (mapId) => setCashUnitForMap(mapId), { immediate: true });
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

function setHumanCount(event: { detail: { value: number | string } }) {
  // 小程序 picker 回传的是下标，不是 option 的值。
  const humanCount = humanOptions[Number(event.detail.value)] ?? setup.value.humanCount;
  setup.value = updateGameSetupCounts(setup.value, { humanCount });
}

function setBotCount(event: { detail: { value: number | string } }) {
  const botCount = botOptions[Number(event.detail.value)] ?? setup.value.botCount;
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

<!--
  10-16 第五版（用户：「返回首页位置要一致，在线在左上角、单机跑到最下面不合适」
                  +「里面的样式也统一，操作逻辑要符合人类直觉，布局要好看规整」）：

  1. 壳换成与在线页同一个 `ViewShell` ⇒ 返回首页**一律在左上角的返回条上**，
     底部不再重复一个「返回首页」；卡片宽 / 圆角 / 间距两页逐字节相同。
  2. 「继续单机 · 本机存档」从页面最底**提到最前**：有存档的人进来十有八九是想接着玩，
     却要先把整张新开局表单滚一遍才看得见「继续游戏」—— 这是在惩罚最常用的那条路。
     提到最前之后，这一页与在线页的顺位完全一致：
     续玩提示 → 主行动 → 表单 → （在线多一段公开房间列表）。
  3. 表单收进「开一局新的」分区，页面上第一次出现「我到底在干哪件事」的小标题。
     「无需联网 · 随时开局」那行角标删掉：壳右上角的状态字已经是「无需联网」，
     同一句话说两遍只是噪音。
-->
<template>
  <ViewShell title="单机模式" aside="无需联网" @back="emit('back')">
    <view class="entry-body">
      <view class="setup-copy">选地图、真人和电脑数量（最多 6 人），确认昵称后进入棋盘。不需要登录，也不需要网络。</view>

      <!-- 续玩优先（见上方注释 2）：与在线页两块「续上一局」同一个位置、同一个形状。 -->
      <view
        v-if="localSaveCards && localSaveCards.length > 0"
        class="entry-section"
        aria-labelledby="local-saves-title"
      >
        <view id="local-saves-title" class="entry-section-title">继续单机 · 本机存档</view>
        <view class="entry-section-hint">以下为本机存档，仅保存在这台设备上，与在线房间互不影响。</view>
        <view
          v-for="card in localSaveCards"
          :key="localCardKey(card)"
          class="entry-resume"
          :class="{ 'setup-save--broken': card.kind !== 'valid' }"
        >
          <template v-if="card.kind === 'valid'">
            <view class="entry-resume__copy">
              <text>{{ card.summary.title }}</text>
              <text>{{ card.summary.players.map((player) => `${player.nickname}${player.isBot ? '（电脑）' : ''}`).join('、') }}</text>
              <text>第 {{ card.summary.turn }} 回合 · 保存于 {{ formatSavedAt(card.summary.updatedAt) }}</text>
            </view>
            <view class="entry-row">
              <button type="button" class="entry-primary" @click="emit('resumeLocal', card.summary)">继续游戏</button>
              <button type="button" class="entry-secondary" @click="requestLocalDelete(card)">
                {{ confirmingLocalDelete?.key === localCardKey(card) ? '确认删除' : '删除存档' }}
              </button>
              <button
                v-if="confirmingLocalDelete?.key === localCardKey(card)"
                type="button"
                class="entry-secondary"
                @click="confirmingLocalDelete = null"
              >取消</button>
            </view>
          </template>
          <template v-else>
            <view class="entry-resume__copy">
              <text>无法恢复的本机存档</text>
              <text>{{ card.reason }}</text>
            </view>
            <view class="entry-row">
              <button type="button" class="entry-secondary" :disabled="card.recordToken === undefined" @click="requestLocalDelete(card)">
                {{ confirmingLocalDelete?.key === localCardKey(card) ? '确认删除' : '删除存档' }}
              </button>
              <button
                v-if="confirmingLocalDelete?.key === localCardKey(card)"
                type="button"
                class="entry-secondary"
                @click="confirmingLocalDelete = null"
              >取消</button>
            </view>
          </template>
        </view>
      </view>

      <view v-if="!validation.ok" class="entry-error" role="alert">{{ validation.message }}</view>
      <view v-if="storageUnavailable" class="entry-hint entry-hint--invalid" role="alert">本浏览器无法保存进度，关闭页面后这局无法恢复</view>
      <view v-if="saveError" class="entry-error" role="alert">{{ saveError }}</view>

      <view class="entry-section" aria-labelledby="setup-new-title">
        <view id="setup-new-title" class="entry-section-title">开一局新的</view>

        <view class="setup-fields" :disabled="dialogOpen">
          <MapPicker
            :model-value="setup.mapId"
            :maps="setupDependencies.catalog"
            label="地图"
            @update:model-value="selectMap"
          />

          <view class="setup-counts" aria-label="玩家数量">
            <view class="entry-field">
              <text>真人玩家</text>
              <picker
                mode="selector"
                :range="humanOptions"
                :value="Math.max(0, humanOptions.indexOf(setup.humanCount))"
                @change="setHumanCount"
              >
                <view class="setup-picker">{{ setup.humanCount }} 人</view>
              </picker>
            </view>
            <view class="entry-field">
              <text>电脑玩家</text>
              <picker
                mode="selector"
                :range="botOptions"
                :value="Math.max(0, botOptions.indexOf(setup.botCount))"
                @change="setBotCount"
              >
                <view class="setup-picker">{{ setup.botCount }} 人</view>
              </picker>
            </view>
            <text class="setup-total">{{ totalPlayers }} 人开局</text>
          </view>

          <view class="setup-roster" aria-label="玩家昵称">
            <view v-for="(player, index) in setup.players" :key="player.id" class="entry-field">
              <text>{{ player.isBot ? '电脑' : '真人' }} {{ index + 1 }}</text>
              <input :value="player.nickname" maxlength="12" @input="updateNickname(index, $event)" />
            </view>
          </view>

          <!-- #6：难度只在真的有电脑玩家时才出现 —— 没选电脑就问难度是问不出所以然的。 -->
          <view v-if="setup.botCount > 0" class="setup-difficulty" aria-label="电脑玩家难度">
            <text class="setup-difficulty-label">电脑玩家难度</text>
            <view class="setup-difficulty-options" role="radiogroup" aria-label="电脑玩家难度">
              <button
                v-for="option in botDifficultyOptions"
                :key="option.value"
                type="button"
                class="setup-difficulty-option"
                :class="{ active: setup.botDifficulty === option.value }"
                :aria-pressed="setup.botDifficulty === option.value"
                @click="setBotDifficulty(option.value)"
              >{{ option.label }}</button>
            </view>
            <view class="setup-difficulty-hint">{{ botDifficultyHint }}仅影响电脑决策，不影响真人玩家。</view>
          </view>

          <view class="setup-rule-card" aria-label="房规">
            <view class="setup-checkbox">
              <input v-model="setup.cashGoalEnabled" type="checkbox" />
              <text>开启现金目标</text>
            </view>
            <view class="entry-field setup-cash-goal" :class="{ disabled: !setup.cashGoalEnabled }">
              <text>现金目标</text>
              <input
                type="number"
                :min="minCashGoal"
                step="1000"
                :disabled="!setup.cashGoalEnabled"
                :value="setup.cashGoal"
                @input="updateCashGoal"
              />
            </view>
          </view>

          <view class="setup-rules" aria-label="规则自定义">
            <view class="setup-rules-title">规则自定义</view>
            <view class="entry-field setup-rule-field">
              <text>初始资金</text>
              <input type="number" :min="1000" :step="1000" :value="setup.config.initialCash" @input="updateRuleConfig('initialCash', $event)" />
            </view>
            <view class="entry-field setup-rule-field">
              <text>最高房级</text>
              <input type="number" min="1" :max="mapMaxHouseLevel" step="1" :value="setup.config.maxHouseLevel" @input="updateRuleConfig('maxHouseLevel', $event)" />
            </view>
            <view class="entry-field setup-rule-field">
              <text>抵押利率（%）</text>
              <input type="number" min="0" max="100" :step="5" :value="Math.round(setup.config.mortgageInterestRate * 100)" @input="updateMortgageRate" />
            </view>
          </view>
        </view>
      </view>

      <view v-if="replacementSummary" class="setup-confirm" role="dialog" aria-modal="true" aria-labelledby="replace-save-title">
        <view id="replace-save-title" class="setup-confirm-title">将替换最旧存档</view>
        <view>{{ replacementSummary.title }} · 第 {{ replacementSummary.turn }} 回合</view>
        <view>{{ replacementSummary.players.map((player) => player.nickname).join('、') }}</view>
        <view class="entry-row setup-confirm-actions">
          <button type="button" class="entry-primary" @click="emit('confirmReplacement')">确认替换并开始</button>
          <button ref="replacementCancelButton" type="button" class="entry-secondary" @click="emit('cancelReplacement')">取消</button>
        </view>
      </view>

      <view v-if="storagePrompt" class="setup-confirm" role="dialog" aria-modal="true" aria-labelledby="storage-prompt-title">
        <view id="storage-prompt-title" class="setup-confirm-title">无法保存这局</view>
        <view>你可以重试存储，或开始一局仅存在于本机内存的临时游戏（关闭页面即丢失，与在线房间无关）。</view>
        <view class="entry-row setup-confirm-actions">
          <button ref="storageRetryButton" type="button" class="entry-primary" @click="emit('retryStorage')">重试保存</button>
          <button type="button" class="entry-secondary" @click="emit('startTemporary')">开始临时游戏</button>
        </view>
      </view>

      <view class="entry-actions">
        <button ref="startButton" type="button" class="entry-primary" :disabled="!validation.ok || dialogOpen" @click="submitSetup">开始新对局</button>
      </view>
    </view>
  </ViewShell>
</template>

<style scoped>
/* 本页只保留「单机模式独有」的东西：人数 / 昵称 / 难度 / 房规这几块内容自身的排版。
   壳、卡片、控件、按钮、分区小标题、续玩卡 —— 全部在 ViewShell 与 ui/entryPage.css 里，
   两页共用一份（见那两个文件头部的说明）。 */

.setup-copy {
  margin: 0;
  color: var(--color-muted);
  line-height: 1.6;
}

.setup-fields {
  min-width: 0;
  display: grid;
  gap: 18px;
  margin: 0;
  padding: 0;
  border: 0;
}

.setup-counts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr)) auto;
  gap: 12px;
  align-items: end;
}

.setup-total {
  padding: 11px 14px;
  border-radius: 999px;
  background: var(--color-accent);
  color: var(--color-text);
  font-size: var(--text-body-size);
  text-align: center;
  white-space: nowrap;
}

.setup-roster {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

/* ---- 电脑难度（#6）---- */
.setup-difficulty {
  display: grid;
  gap: 8px;
  padding: 12px;
  border-radius: var(--radius-panel);
  background: var(--surface-raised);
}

.setup-difficulty-label {
  color: var(--color-muted);
  font-size: var(--text-meta-size);
  font-weight: 800;
}

.setup-difficulty-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.setup-difficulty-option {
  min-height: 44px;
  padding: 4px 10px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--board-surface);
  color: var(--color-text);
  font-family: inherit;
  font-size: var(--text-body-size);
  font-weight: 800;
  cursor: pointer;
}

.setup-difficulty-option.active {
  border-color: var(--color-primary);
  background: var(--color-primary);
  color: #fff4ec;
}

.setup-difficulty-hint {
  margin: 0;
  color: var(--color-muted);
  font-size: var(--text-meta-size);
  line-height: 1.6;
}

/* ---- 现金目标 ---- */
.setup-rule-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 180px;
  gap: 12px;
  align-items: center;
  padding: 12px;
  border-radius: var(--radius-panel);
  background: var(--surface-raised);
}

.setup-checkbox {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: var(--text-body-size);
  font-weight: 900;
}

/* 18×18 的复选框：靠这条压过 ui/entryPage.css 里那组 44px 高的输入框规则。
   entryPage 的否定选择器写了 :where()，特异度是 (0,1,1)，这里 (0,2,1) 稳稳压住。 */
.setup-checkbox input {
  width: 18px;
  height: 18px;
  accent-color: var(--color-primary);
}

.setup-cash-goal.disabled {
  opacity: 0.56;
}

/* ---- 规则自定义 ---- */
.setup-rules {
  display: grid;
  gap: 12px;
  padding: 14px 12px;
  border-radius: var(--radius-panel);
  background: var(--surface-raised);
}

.setup-rules-title {
  margin: 0;
  color: var(--color-primary);
  font-size: var(--text-section-size);
  font-weight: 900;
}

.setup-rule-field {
  grid-template-columns: 1fr 160px;
  gap: 12px;
  align-items: center;
}

/* ---- 存档替换 / 存储不可用确认 ---- */
.setup-confirm {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 12px;
  border-radius: 16px;
  background: var(--event-bg);
  color: var(--event-text);
}

.setup-confirm-title {
  margin: 0;
  font-size: var(--text-section-size);
  font-weight: 900;
}

.setup-confirm p {
  margin: 0;
  font-size: var(--text-body-size);
}

/* ---- 损坏 / 不兼容的存档卡：从暖黄票根降级成普通描边，别和「可继续」的长得一样 ---- */
.setup-save--broken {
  border-color: var(--color-border);
  background: var(--surface-raised);
  color: var(--color-text);
}

.setup-save--broken .entry-resume__copy {
  color: inherit;
}

@media (max-width: 1024px) {
  .setup-counts,
  .setup-roster,
  .setup-rule-card,
  .setup-rule-field {
    grid-template-columns: 1fr;
  }
}
</style>
