<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import MobileSheet from './MobileSheet.vue';
import PwaInstallRow from './PwaInstallRow.vue';
import ReleaseNotesDialog from './ReleaseNotesDialog.vue';
import {
  SFX_DEFAULT_VOLUME,
  getSfxVolume,
  isSfxEnabled,
  setSfxEnabled,
  setSfxVolume,
} from '../audio/sfx';
import {
  BGM_DEFAULT_VOLUME,
  getBgmVolume,
  isBgmEnabled,
  setBgmEnabled,
  setBgmVolume,
} from '../audio/bgm';
import { THEMES, getStoredAppearance, getStoredTheme, resolveTheme, setAppearance, setTheme, type AppearanceId, type ThemeId } from '../ui/themeManager';
import { PLAYBACK_SPEED_OPTIONS, getPlaybackSpeedRef, setPlaybackSpeed } from '../session/playbackPace';
import { describeMapRulesById } from '../ui/mapRules';
import { formatMoney } from '../ui/format';

/**
 * 统一设置入口（路线图 #13 扩展）。
 *
 * 之前散落三处：对局侧栏（桌面把设置行直接摊在侧栏里，没有标题也没有入口）、移动端底部
 * 操作坞的「设置」抽屉、大厅卡片里的「安装应用」一行。这里收成一个弹窗：
 * 手机是底部抽屉、桌面是居中弹窗，两端同一份内容与同一套语义。
 *
 * 分区原则：凡是「只影响本机观感」的（深色模式/皮肤/动画/音效/BGM/音量/安装）都放这里并
 * 标注清楚，避免玩家误以为改了会同步给别人。规则说明则相反 —— 它按**当前地图**渲染（#13），
 * 让「本局到底在玩什么」在设置里就能看全，而不是一句任何地图都成立的通用话。
 *
 * 两条外观轴的归属（#11）：皮肤是「对局内配色」，所以首页不再提供选择器，只在这里；
 * 深色模式是「整站外观」，覆盖首页/大厅/设置等页面级界面。二者用 'auto' 皮肤串起来。
 */
const props = withDefaults(defineProps<{
  open: boolean;
  /** 单机热座才有悔棋/回放（联机以服务器为权威态，不可本地回退）。 */
  isLocalGame?: boolean;
  canUndo?: boolean;
  canReplay?: boolean;
  /** 本局胜利条件（现金目标）；null 表示不限。 */
  cashGoal?: number | null;
  /** 退出按钮文案（本地「返回首页」/ 联机「离开房间」）。 */
  exitLabel?: string;
  canSurrender?: boolean;
  /** 会话级操作（退出/投降）：桌面侧栏已有同款按钮，故只在移动端抽屉里显示。 */
  showSessionActions?: boolean;
  /** 当前地图 id；用于按地图渲染规则说明。缺省或未知 id 时回落到通用要点。 */
  mapId?: string | null;
}>(), {
  isLocalGame: false,
  canUndo: false,
  canReplay: false,
  cashGoal: null,
  exitLabel: '退出',
  canSurrender: false,
  showSessionActions: false,
  mapId: null,
});

const emit = defineEmits<{
  'update:open': [open: boolean];
  undo: [];
  replay: [];
  exit: [];
  surrender: [];
}>();

const themes = THEMES;
const theme = ref<ThemeId>(getStoredTheme());
const darkMode = ref(getStoredAppearance() === 'dark');
/** 当前皮肤的实际配色（'auto' 时随深色模式解析），用于把「跟随深色」的结果说清楚。 */
const resolvedThemeLabel = computed(
  () => THEMES.find((option) => option.id === resolveTheme(theme.value, darkMode.value ? 'dark' : 'light'))?.label ?? '',
);

function chooseTheme(id: ThemeId): void {
  theme.value = id;
  setTheme(id);
}

/** 深色模式：整站页面级外观；'auto' 皮肤依赖它，故 setAppearance 内部会一并重算 data-theme。 */
function chooseDarkMode(next: boolean): void {
  darkMode.value = next;
  const appearance: AppearanceId = next ? 'dark' : 'light';
  setAppearance(appearance);
}

const playbackSpeed = getPlaybackSpeedRef();
const paceOptions = PLAYBACK_SPEED_OPTIONS;

const sfxEnabled = ref(isSfxEnabled());
function toggleSfx(): void {
  sfxEnabled.value = !sfxEnabled.value;
  setSfxEnabled(sfxEnabled.value);
}

const bgmEnabled = ref(isBgmEnabled());
function toggleBgm(): void {
  bgmEnabled.value = !bgmEnabled.value;
  setBgmEnabled(bgmEnabled.value);
}

// 音量用 0~100 的整数百分比驱动滑块，写回模块时再折算成 0~1 的线性音量。
const sfxVolume = ref(getSfxVolume());
function changeSfxVolume(event: Event): void {
  const percent = Number((event.target as HTMLInputElement).value);
  const next = Number.isFinite(percent) ? percent / 100 : SFX_DEFAULT_VOLUME;
  sfxVolume.value = next;
  setSfxVolume(next);
}

const bgmVolume = ref(getBgmVolume());
function changeBgmVolume(event: Event): void {
  const percent = Number((event.target as HTMLInputElement).value);
  const next = Number.isFinite(percent) ? percent / 100 : BGM_DEFAULT_VOLUME;
  bgmVolume.value = next;
  setBgmVolume(next);
}

function percentLabel(value: number): number {
  return Math.round(value * 100);
}

/** 恢复默认设置：只重置本机偏好，不碰账号、存档与对局状态。 */
const resetNotice = ref(false);
let resetNoticeTimer: number | null = null;
function restoreDefaults(): void {
  chooseDarkMode(false);
  chooseTheme('auto');
  setPlaybackSpeed('standard');
  sfxEnabled.value = true;
  setSfxEnabled(true);
  bgmEnabled.value = false;
  setBgmEnabled(false);
  sfxVolume.value = SFX_DEFAULT_VOLUME;
  setSfxVolume(SFX_DEFAULT_VOLUME);
  bgmVolume.value = BGM_DEFAULT_VOLUME;
  setBgmVolume(BGM_DEFAULT_VOLUME);
  resetNotice.value = true;
  if (resetNoticeTimer !== null) window.clearTimeout(resetNoticeTimer);
  resetNoticeTimer = window.setTimeout(() => {
    resetNotice.value = false;
    resetNoticeTimer = null;
  }, 2400);
}
onBeforeUnmount(() => {
  if (resetNoticeTimer !== null) window.clearTimeout(resetNoticeTimer);
});

const title = '设置';
const victoryCopy = computed(() => (
  props.cashGoal === null ? null : `胜利条件：现金达到 ${formatMoney(props.cashGoal)}。`
));

/** 当前地图的规则事实；无地图上下文（如大厅未选图）时为 null。 */
const mapRules = computed(() => describeMapRulesById(props.mapId));
const rulesSummary = computed(() => (
  mapRules.value === null ? '本局规则要点' : `《${mapRules.value.title}》规则要点`
));
</script>

<template>
  <MobileSheet
    class="sheet-settings"
    layout="modal"
    :open="open"
    :title="title"
    @close="emit('update:open', false)"
  >
    <section class="settings-group" aria-labelledby="settings-appearance">
      <h3 id="settings-appearance" class="settings-group-title">外观</h3>
      <label class="setting-row" for="dark-mode-toggle">
        <span>深色模式</span>
        <input
          id="dark-mode-toggle"
          type="checkbox"
          :checked="darkMode"
          @change="chooseDarkMode(!darkMode)"
        />
      </label>
      <div class="settings-field">
        <span class="settings-field-label">对局皮肤</span>
        <div class="settings-options" role="radiogroup" aria-label="对局皮肤">
          <button
            v-for="option in themes"
            :key="option.id"
            type="button"
            class="settings-option"
            :class="{ active: theme === option.id }"
            :aria-pressed="theme === option.id"
            :title="option.hint"
            @click="chooseTheme(option.id)"
          >{{ option.label }}</button>
        </div>
        <p class="settings-hint">
          当前实际配色：{{ resolvedThemeLabel }}。
          <template v-if="theme === 'auto'">
            「跟随深色」会随上面的深色模式自动切换（开 → 暗夜，关 → 经典）；
            想锁死某个配色，直接点经典 / 海洋 / 暗夜即可。
          </template>
        </p>
      </div>
      <div class="pace-control" role="group" aria-label="动画速度">
        <span class="pace-label">动画</span>
        <button
          v-for="option in paceOptions"
          :key="option.value"
          type="button"
          class="pace-option"
          :class="{ 'pace-active': option.value === playbackSpeed }"
          :aria-pressed="option.value === playbackSpeed"
          @click="setPlaybackSpeed(option.value)"
        >{{ option.label }}</button>
      </div>
      <p class="settings-hint">
        深色模式、皮肤与动画速度都是本机显示偏好：每位参赛者与观战者各自设置、只影响自己
        看到的画面，不同步给他人，也不改变任何对局状态。深色模式作用于首页 / 大厅 / 设置等
        页面级界面；对局内配色由皮肤决定，选「跟随深色」即可跟着一起变暗。
      </p>
    </section>

    <section class="settings-group" aria-labelledby="settings-sound">
      <h3 id="settings-sound" class="settings-group-title">声音</h3>
      <label class="setting-row" for="sfx-toggle">
        <span>音效</span>
        <input id="sfx-toggle" type="checkbox" :checked="sfxEnabled" @change="toggleSfx" />
      </label>
      <label class="setting-row setting-row--volume" for="sfx-volume">
        <span>音效音量</span>
        <input
          id="sfx-volume"
          class="volume-slider"
          type="range"
          min="0"
          max="100"
          step="5"
          :value="percentLabel(sfxVolume)"
          :aria-valuetext="`${percentLabel(sfxVolume)}%`"
          @input="changeSfxVolume"
        />
        <output class="volume-value" for="sfx-volume">{{ percentLabel(sfxVolume) }}%</output>
      </label>
      <label class="setting-row" for="bgm-toggle">
        <span>背景音乐</span>
        <input id="bgm-toggle" type="checkbox" :checked="bgmEnabled" @change="toggleBgm" />
      </label>
      <label class="setting-row setting-row--volume" for="bgm-volume">
        <span>音乐音量</span>
        <input
          id="bgm-volume"
          class="volume-slider"
          type="range"
          min="0"
          max="100"
          step="5"
          :value="percentLabel(bgmVolume)"
          :aria-valuetext="`${percentLabel(bgmVolume)}%`"
          @input="changeBgmVolume"
        />
        <output class="volume-value" for="bgm-volume">{{ percentLabel(bgmVolume) }}%</output>
      </label>
      <p class="settings-hint">
        开关与音量都只影响本机：不同步给他人、不改变任何对局状态。把某一项音量拉到 0
        等同于静音——不再排期发声；开关重新打开后，音量按上面保存的数值生效。
      </p>
    </section>

    <section v-if="isLocalGame" class="settings-group" aria-labelledby="settings-game">
      <h3 id="settings-game" class="settings-group-title">对局操作</h3>
      <div class="setting-row">
        <span>悔棋</span>
        <button
          type="button"
          class="setting-action"
          :disabled="!canUndo"
          @click="emit('undo')"
        >撤回上一步</button>
      </div>
      <div class="setting-row">
        <span>回放</span>
        <button
          type="button"
          class="setting-action"
          :disabled="!canReplay"
          @click="emit('replay')"
        >观看本局回放</button>
      </div>
      <p class="settings-hint">悔棋与回放只在单机对局可用；联机对局以服务器状态为准，无法本地回退。</p>
    </section>

    <section class="settings-group" aria-labelledby="settings-help">
      <h3 id="settings-help" class="settings-group-title">规则说明</h3>
      <details class="rules-help" open>
        <summary>{{ rulesSummary }}</summary>
        <!-- 按当前地图渲染的事实清单（#13）：数字全部来自地图包，不写死任何一张图。 -->
        <dl v-if="mapRules" class="rules-facts">
          <div v-for="fact in mapRules.facts" :key="fact.label" class="rules-fact">
            <dt>{{ fact.label }}</dt>
            <dd>{{ fact.value }}</dd>
          </div>
        </dl>
        <ul>
          <li>掷骰按点数前进，落在无主地产可购买。</li>
          <li>落在他人地产需按租金付费；现金不足会被接管或出局。</li>
          <li v-if="victoryCopy">{{ victoryCopy }}</li>
          <li>房主可踢出捣乱玩家（对局中=强制出局）。</li>
        </ul>
        <ul v-if="mapRules && mapRules.moduleNotes.length > 0" class="rules-module-notes">
          <li v-for="note in mapRules.moduleNotes" :key="note">{{ note }}</li>
        </ul>
        <p v-if="mapRules === null" class="rules-fallback">
          选好地图进入对局后，这里会换成当前地图的实际数值（格数、地块与渡口数量、房屋上限、胜利目标等）。
        </p>
      </details>
    </section>

    <section class="settings-group" aria-labelledby="settings-app">
      <h3 id="settings-app" class="settings-group-title">应用</h3>
      <PwaInstallRow hint="安装后可离线打开，像原生 App 一样" />
      <div class="setting-row">
        <span>版本</span>
        <!-- 复用首页那颗「更新说明」入口：对局中也能查到自己玩的是哪个版本、这次改了什么。
             这里传 defer：设置面板本身嵌在大厅/对局视图里，正文若预先渲染，整份更新说明
             就会出现在这两个视图的渲染结果中。 -->
        <ReleaseNotesDialog defer />
      </div>
      <div class="setting-row">
        <span>恢复默认</span>
        <button type="button" class="setting-action setting-action--ghost" @click="restoreDefaults">
          恢复默认设置
        </button>
      </div>
      <p class="settings-hint">
        恢复默认设置只重置本机的皮肤、动画速度与声音偏好（含音量），不碰账号、存档与正在进行的对局。
      </p>
      <p v-if="resetNotice" class="settings-notice" role="status">已恢复默认设置。</p>
    </section>

    <template v-if="showSessionActions">
      <button type="button" class="settings-session-button" @click="emit('exit')">{{ exitLabel }}</button>
      <button
        v-if="canSurrender"
        type="button"
        class="settings-session-button settings-session-button--danger"
        @click="emit('surrender')"
      >投降</button>
    </template>
  </MobileSheet>
</template>

<style scoped>
.settings-group {
  display: grid;
  gap: 8px;
}

.settings-group-title {
  margin: 0;
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.06em;
}

.settings-field {
  display: grid;
  gap: 6px;
}

.settings-field-label {
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 700;
}

/* 皮肤有四档（含「跟随深色」）：固定 flex 平分在窄屏会把「跟随深色」挤成两行，
   改用自适应列宽，窄屏自动折成两行两列。 */
.settings-options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(76px, 1fr));
  gap: 6px;
}

.settings-option {
  min-height: 44px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--board-surface);
  color: var(--color-text);
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}

.settings-option.active {
  border-color: var(--color-primary);
  background: var(--color-primary);
  color: #fff;
}

.settings-option:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.pace-control {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--board-surface);
  font-size: 12px;
  font-weight: 700;
  color: var(--color-text);
}

.pace-label {
  color: var(--color-muted);
  margin-right: 2px;
}

.pace-option {
  flex: 1;
  min-height: 44px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.pace-option.pace-active {
  background: var(--color-primary);
  color: #fff;
}

.pace-option:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.settings-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-muted);
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--board-surface);
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text);
}

.setting-row input[type='checkbox'] {
  width: 20px;
  height: 20px;
  accent-color: var(--color-primary);
  cursor: pointer;
}

/* 音量行：标签固定宽度、滑块占满剩余、百分比定宽，三列对齐后两行滑块起止点一致。 */
.setting-row--volume {
  align-items: center;
}

.volume-slider {
  flex: 1;
  min-width: 0;
  min-height: 24px;
  accent-color: var(--color-primary);
  cursor: pointer;
}

.volume-slider:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
  border-radius: 6px;
}

.volume-value {
  min-width: 44px;
  text-align: right;
  color: var(--color-muted);
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  font-weight: 800;
}

.setting-action {
  padding: 6px 12px;
  border: 1px solid var(--color-primary);
  border-radius: 8px;
  background: var(--color-primary);
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: opacity 0.15s ease;
}

/* 次要动作（恢复默认）：描边而非实心，避免在一堆偏好项里被误当成主按钮。 */
.setting-action--ghost {
  border-color: var(--color-border);
  background: transparent;
  color: var(--color-text);
}

.setting-action:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.rules-help {
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--board-surface);
  font-size: 13px;
  font-weight: 600;
}

.rules-help summary {
  cursor: pointer;
  color: var(--color-text);
  font-weight: 800;
}

.rules-help ul {
  margin: 8px 0 0;
  padding-left: 18px;
  display: grid;
  gap: 5px;
  color: var(--color-muted);
  line-height: 1.45;
}

/* 按地图渲染的数值清单：左标签右数值，窄屏下自动折成上下两行。 */
.rules-facts {
  margin: 10px 0 0;
  display: grid;
  gap: 4px;
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-muted) 8%, transparent);
}

.rules-fact {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  line-height: 1.4;
}

.rules-fact dt {
  flex: 0 0 auto;
  color: var(--color-muted);
  font-weight: 700;
}

.rules-fact dd {
  margin: 0;
  min-width: 0;
  text-align: right;
  color: var(--color-text);
  font-weight: 800;
  overflow-wrap: anywhere;
}

/* 特化规则模块的提示与通用要点同形，用上分隔线表示「这一句是这张图独有的」。 */
.rules-module-notes {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--color-border);
}

.rules-fallback {
  margin: 8px 0 0;
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.45;
}

.settings-notice {
  margin: 0;
  color: var(--color-primary);
  font-size: 12px;
  font-weight: 800;
}

.settings-session-button {
  min-height: 44px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--board-surface);
  color: var(--color-text);
  font: inherit;
  font-weight: 800;
  cursor: pointer;
}

.settings-session-button--danger {
  border-color: color-mix(in srgb, var(--surrender, #b3402f) 40%, var(--color-border));
  color: var(--surrender, #b3402f);
}
</style>
