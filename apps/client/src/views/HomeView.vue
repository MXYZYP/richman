<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { PublicRoomSummary, RoomRole } from '@richman/protocol';
import { listActiveMaps, type MapCatalogEntry } from '@richman/board-data';
import MapPicker from '../components/MapPicker.vue';
import PwaInstallRow from '../components/PwaInstallRow.vue';
import ReleaseNotesDialog from '../components/ReleaseNotesDialog.vue';
import { capRoomCode, isValidRoomCode, planCreateSubmission, planJoinSubmission } from '../session/appFlow';
import type { PendingRoomRequest } from '../session/sessionStorage';
import type { LocalSaveCard, LocalSaveIdentity, LocalSaveObservedRecord } from '../session/localGameSave';
import { deriveAchievements, describeNextAchievement, type AchievementGroup } from '../session/achievements';
import {
  buildLeaderboardSubmission,
  describeLeaderboardFailure,
  ensurePlayerId,
  loadLeaderboard,
  publishLeaderboard,
  type LeaderboardEntry,
} from '../session/leaderboard';
import { browserStorage, encodeStatsCode, importStatsCode, loadPlayerStats, type PlayerStats } from '../session/playerStats';
import { formatMoney } from '../ui/format';
import { THEMES, getStoredTheme, setTheme, type ThemeId } from '../ui/themeManager';
import {
  localCardKey,
  requestLocalDelete as planLocalDelete,
  type LocalDeleteConfirmation,
} from './localDeleteConfirmation';

const props = withDefaults(defineProps<{
  submitting?: boolean;
  resume?: PendingRoomRequest | null;
  /** A leftover pending entry can still be retried with the same request id. */
  pendingRetryable?: boolean;
  /** A stored active session survived a deferred restore and can be re-entered. */
  canResumeActive?: boolean;
  initialRoomCode?: string;
  error?: string | null;
  localSaveError?: string | null;
  localSaveCards?: readonly LocalSaveCard[];
  initialMapId?: string;
  activeMaps?: readonly MapCatalogEntry[];
  /** 公开房间列表（#108）：由 App 统一拉取，这里只负责渲染。 */
  publicRooms?: readonly PublicRoomSummary[];
  roomListLoading?: boolean;
  roomListError?: string | null;
}>(), {
  submitting: false,
  resume: null,
  pendingRetryable: true,
  canResumeActive: false,
  initialRoomCode: '',
  error: null,
  localSaveError: null,
  localSaveCards: () => [],
  initialMapId: '',
  activeMaps: () => listActiveMaps(),
  publicRooms: () => [],
  roomListLoading: false,
  roomListError: null,
});

const emit = defineEmits<{
  // 建房只带昵称与地图：电脑难度与规则自定义（初始资金等）都改成「房主在大厅里设」，
  // 因为联机建房那一刻房间里还没有电脑玩家，先问难度是问不出所以然的（#4 / #6）。
  create: [nickname: string, mapId: string];
  join: [payload: { roomCode: string; nickname: string; role: RoomRole }];
  /** 手动刷新公开房间列表（#108）；首屏那一次由 App 自己触发。 */
  refreshRooms: [];
  /** 打开「玩法说明」（#109）：首次进站会自动弹一次，这里是不想等/想重看时的入口。 */
  openGuide: [];
  /** 打开「导入复盘」（#115）：收到别人发来的复盘码时，首页就是入口。 */
  openReplay: [];
  /** 打开「地图工坊」（#117）：本机装自定义地图、单机试玩、删掉不要的那张。 */
  openWorkshop: [];
  local: [mapId: string];
  resume: [];
  abandonPending: [];
  resumeActive: [];
  abandonActive: [];
  resumeLocal: [observed: LocalSaveIdentity];
  deleteLocal: [observed: LocalSaveObservedRecord];
}>();

// Invite links prefill the room code only — never auto-submit.
const nickname = ref('');
const roomCode = ref(capRoomCode(props.initialRoomCode));
// Join role is an explicit choice (players by default); spectators may enter full or
// already-playing rooms read-only.
const joinRole = ref<RoomRole>('player');
const selectedMapId = ref(
  props.activeMaps.some((entry) => entry.ref.id === props.initialMapId)
    ? props.initialMapId
    : (props.activeMaps[0]?.ref.id ?? ''),
);
// 建房时不再问电脑难度与皮肤：皮肤收进设置（#5），难度与规则自定义收进大厅的房主设置（#4 / #6）。
const showMapSelector = computed(() => props.activeMaps.length > 1);
watch(
  () => props.activeMaps,
  (activeMaps) => {
    if (!activeMaps.some((entry) => entry.ref.id === selectedMapId.value)) {
      selectedMapId.value = activeMaps[0]?.ref.id ?? '';
    }
  },
  { immediate: true },
);

const canCreate = computed(() => (
  props.activeMaps.some((entry) => entry.ref.id === selectedMapId.value)
  && planCreateSubmission(nickname.value, props.submitting) !== null
));
const canJoin = computed(() => planJoinSubmission(roomCode.value, nickname.value, props.submitting) !== null);
const showRoomError = computed(() => roomCode.value.length > 0 && !isValidRoomCode(roomCode.value));
const confirmingLocalDelete = ref<LocalDeleteConfirmation | null>(null);

function requestLocalDelete(card: LocalSaveCard): void {
  const request = planLocalDelete(confirmingLocalDelete.value, card);
  confirmingLocalDelete.value = request.confirmation;
  if (request.observed !== null) emit('deleteLocal', request.observed);
}

function formatSavedAt(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

const resumeLabel = computed(() => {
  const pending = props.resume;
  if (pending === null) return '';
  return pending.operation === 'create'
    ? `继续创建房间（${pending.nickname}）`
    : pending.role === 'spectator'
      ? `继续以观战身份加入房间 ${pending.roomCode}（${pending.nickname}）`
      : `继续加入房间 ${pending.roomCode}（${pending.nickname}）`;
});

// Normalize before capping so a pasted "12 34" becomes "1234" rather than a raw-truncated "12 3".
function onRoomInput(event: Event) {
  const input = event.target as HTMLInputElement;
  const next = capRoomCode(input.value);
  roomCode.value = next;
  // When the normalized value equals the current ref, Vue skips the patch, so the raw text
  // (e.g. an unstripped space) would linger in the DOM — force the element to agree.
  if (input.value !== next) input.value = next;
}

// Each field maps to exactly one action, bound to its own Enter key, so a single keystroke
// can never fire both create and join and the buttons below stay plain clicks.
function submitCreate() {
  const payload = planCreateSubmission(nickname.value, props.submitting);
  if (payload !== null && props.activeMaps.some((entry) => entry.ref.id === selectedMapId.value)) {
    emit('create', payload.nickname, selectedMapId.value);
  }
}

function submitJoin() {
  const payload = planJoinSubmission(roomCode.value, nickname.value, props.submitting, joinRole.value);
  if (payload !== null) emit('join', payload);
}

// ---- 公开房间列表（#108） ----

const roomListHint = ref<string | null>(null);

/**
 * 从公开房间列表里加入 / 旁观。
 *
 * 复用与手动加入完全相同的 `planJoinSubmission`：昵称没填、或有人正在提交时一律不放行，
 * 因此列表入口不会绕开「必须填昵称」这条既有规则。被拦下时给出明确提示——
 * 静默什么都不做是最糟的表现（用户会以为按钮坏了）。
 */
function joinFromList(roomCode: string, role: RoomRole): void {
  const payload = planJoinSubmission(roomCode, nickname.value, props.submitting, role);
  if (payload === null) {
    roomListHint.value = nickname.value.trim().length === 0
      ? '请先在左上角填好昵称，才能从列表加入。'
      : '昵称需为 1 至 20 个字符。';
    return;
  }
  roomListHint.value = null;
  emit('join', payload);
}

// 列表内容每次刷新都可能变，上一次的提示（「请先填昵称」）到那时已经过期了。
watch(() => props.publicRooms, () => {
  roomListHint.value = null;
});

/** 列表行的状态徽标：让「点进去会发生什么」在点之前就看得出来。 */
function roomStatusLabel(summary: PublicRoomSummary): string {
  if (summary.status === 'lobby') return '大厅等待中';
  if (summary.status === 'playing') return '对局进行中';
  return '已结束';
}

function roomSeatLabel(summary: PublicRoomSummary): string {
  const seat = `${summary.playerCount}/${summary.playerLimit} 人`;
  return summary.spectatorCount > 0 ? `${seat} · 观战 ${summary.spectatorCount}` : seat;
}

// 房间设置里也有一份限时（#107），列表上顺手标出来：限时 0 等于不限时，不必显示。
function roomLimitLabel(summary: PublicRoomSummary): string | null {
  return summary.turnTimeLimitSec > 0 ? `每步 ${summary.turnTimeLimitSec} 秒` : null;
}

function submitLocal() {
  if (props.submitting || !props.activeMaps.some((entry) => entry.ref.id === selectedMapId.value)) return;
  emit('local', selectedMapId.value);
}

// 本地战绩（路线图 #12）：无存储时为 null，UI 自动隐藏该区块。
// 用 ref 而不是 computed：导入战绩码之后要主动刷新结果（storage 本身不是响应式的）。
function readPlayerStats(): PlayerStats | null {
  const storage = browserStorage();
  return storage === undefined ? null : loadPlayerStats(storage);
}

const playerStats = ref<PlayerStats | null>(readPlayerStats());
const favoriteMapTitle = computed(() => {
  const stats = playerStats.value;
  if (stats === null) return null;
  let bestId = '';
  let bestCount = 0;
  for (const [id, count] of Object.entries(stats.favoriteMaps)) {
    if (count > bestCount) { bestCount = count; bestId = id; }
  }
  if (bestId === '') return null;
  return props.activeMaps.find((entry) => entry.ref.id === bestId)?.title ?? null;
});

// ───────────── 战绩码：导入 / 导出（路线图 #102） ─────────────
// 战绩只存在这台设备上。用一段「只有昵称与战绩」的码把它搬走——不需要账号，也不需要密码。
const statsCode = ref('');
const statsImportInput = ref('');
const statsNotice = ref<{ kind: 'ok' | 'error'; message: string } | null>(null);

function exportStatsCode(): void {
  const storage = browserStorage();
  if (storage === undefined) {
    statsNotice.value = { kind: 'error', message: '当前浏览器不允许本地存储，无法导出战绩。' };
    return;
  }
  statsCode.value = encodeStatsCode({
    nickname: nickname.value.trim() === '' ? '大富翁玩家' : nickname.value.trim(),
    stats: loadPlayerStats(storage),
  });
  statsNotice.value = { kind: 'ok', message: '已生成战绩码，复制后可在别的设备导入。' };
}

async function copyStatsCode(): Promise<void> {
  if (statsCode.value === '') return;
  try {
    await navigator.clipboard.writeText(statsCode.value);
    statsNotice.value = { kind: 'ok', message: '战绩码已复制到剪贴板。' };
  } catch {
    // 剪贴板权限被拒 / 非安全上下文：码就在下面的框里，手动选中复制一样走通。
    statsNotice.value = { kind: 'error', message: '复制失败，请手动选中下面的战绩码复制。' };
  }
}

function importStats(): void {
  const storage = browserStorage();
  if (storage === undefined) {
    statsNotice.value = { kind: 'error', message: '当前浏览器不允许本地存储，无法导入战绩。' };
    return;
  }
  const outcome = importStatsCode(storage, statsImportInput.value);
  if (!outcome.ok) {
    statsNotice.value = {
      kind: 'error',
      message: outcome.reason === 'checksum'
        ? '这段战绩码不完整（可能复制时掉了字符），请重新复制完整的一段。'
        : outcome.reason === 'storage'
          ? '本机存储不可用，战绩没能写入。'
          : '这不是一段有效的战绩码。',
    };
    return;
  }
  playerStats.value = outcome.stats;
  statsImportInput.value = '';
  statsNotice.value = {
    kind: 'ok',
    message: outcome.applied
      ? `已合并${outcome.nickname === '' ? '' : `「${outcome.nickname}」的`}战绩，本机原有战绩未受影响。`
      : '这份战绩码之前已经导入过了，没有重复计数。',
  };
  // 成就与排行都是「战绩的读法」，战绩一变就得跟着重算/重取。
  void refreshLeaderboard();
}

// ───────────── 成就（路线图 #116） ─────────────
// 成就全部由**本机战绩**派生，不新增采集、不发任何网络请求，所以它紧挨着「我的战绩」：
// 两者本来就是同一份数据的不同读法（换设备后导入战绩码，成就也会一起回来）。

const achievementSummary = computed(() => {
  const current = playerStats.value;
  if (current === null) return null;
  // 地图 id 用「当前已发布」的那份：下架的地图不该继续挂在收集类成就里当未完成项。
  return deriveAchievements(current, { mapIds: props.activeMaps.map((entry) => entry.ref.id) });
});

const ACHIEVEMENT_GROUPS: ReadonlyArray<{ id: AchievementGroup; label: string }> = [
  { id: 'milestone', label: '里程碑' },
  { id: 'wealth', label: '财富' },
  { id: 'explorer', label: '地图' },
];

const achievementGroups = computed(() => {
  const summary = achievementSummary.value;
  if (summary === null) return [];
  return ACHIEVEMENT_GROUPS.map((group) => ({
    label: group.label,
    items: summary.achievements.filter((achievement) => achievement.group === group.id),
  }));
});

// ───────────── 成就排行榜（路线图 #116） ─────────────
// 本页唯一会往外发数据的地方，所以规矩直接写在界面上：**不点不上传**。
// 上传的只有昵称与四个聚合数字（胜场 / 总局数 / 资产峰值 / 玩过的地图数）。
//
// 拉取放在组件自己身上，而不是像公开房间列表（#108）那样交给 App：排行榜是一条独立的
// 同源 HTTP 接口，与会话/房间协议无关，没必要为它铺一串 props + emit。
// `onMounted` 在 node 测试环境里不会执行，因此这一块对 SSR 渲染契约测试是透明的。
const leaderboardEntries = ref<readonly LeaderboardEntry[]>([]);
const leaderboardRank = ref<number | null>(null);
const leaderboardNotice = ref<{ kind: 'ok' | 'error'; message: string } | null>(null);
const leaderboardBusy = ref(false);
const leaderboardLoaded = ref(false);

/** 本机身份标识；存储不可用时为 `null`（那时只读榜单，不上榜）。 */
function currentPlayerId(): string | null {
  const storage = browserStorage();
  return storage === undefined ? null : ensurePlayerId(storage);
}

async function refreshLeaderboard(): Promise<void> {
  if (leaderboardBusy.value) return;
  leaderboardBusy.value = true;
  const result = await loadLeaderboard({ playerId: currentPlayerId() });
  leaderboardBusy.value = false;
  if (!result.ok) {
    leaderboardNotice.value = { kind: 'error', message: describeLeaderboardFailure(result.reason) };
    return;
  }
  leaderboardEntries.value = result.entries;
  leaderboardRank.value = result.rank;
  leaderboardLoaded.value = true;
  leaderboardNotice.value = result.entries.length === 0
    ? { kind: 'ok', message: '榜上还没有人，你可以是第一个。' }
    : null;
}

async function publishMyStats(): Promise<void> {
  if (leaderboardBusy.value) return;
  const storage = browserStorage();
  const playerId = storage === undefined ? null : ensurePlayerId(storage);
  if (storage === undefined || playerId === null) {
    leaderboardNotice.value = { kind: 'error', message: describeLeaderboardFailure('storage') };
    return;
  }

  leaderboardBusy.value = true;
  // 刻意重新读一遍战绩（而不是用 `playerStats.value`）：刚打完一局回来时它可能还是旧值。
  const result = await publishLeaderboard(
    buildLeaderboardSubmission(loadPlayerStats(storage), nickname.value, playerId),
  );
  leaderboardBusy.value = false;
  if (!result.ok) {
    leaderboardNotice.value = { kind: 'error', message: describeLeaderboardFailure(result.reason) };
    return;
  }
  leaderboardEntries.value = result.entries;
  leaderboardRank.value = result.rank;
  leaderboardLoaded.value = true;
  leaderboardNotice.value = {
    kind: 'ok',
    message: result.rank === null
      ? '已提交。这些成绩还没能进前 100 名。'
      : `已提交，你目前第 ${result.rank} 名。`,
  };
}

onMounted(() => {
  void refreshLeaderboard();
});
</script>

<template>
  <main class="home-shell">
    <section class="home-card" aria-labelledby="home-title">
      <p class="home-eyebrow">联机对战 · 单机游玩</p>
      <h1 id="home-title">进入大富翁</h1>
      <p class="home-copy">用 6 位房间码和好友同桌，或单机游玩开一局。手机、电脑浏览器皆可。</p>

      <!-- 玩法说明入口（#109）：首次进站会自动弹一次；这里是「想重看」或「没看到那次弹窗」的兜底。
           放在标题正下方，是想看说明的人一眼就能找到，不必先滚到页脚。
           旁边并列「导入复盘」（#115）：别人发来一段复盘码时，首页就是入口 ——
           不该逼玩家先随便开一局，才能找到粘贴的地方。
           再旁边是「地图工坊」（#117）：本机装自定义地图的地方。三条入口都是「不需要先开一局」
           的动作，归在同一行；地图工坊那条刻意不叫「自定义地图」，因为玩家要装的正是编辑器导出的东西。 -->
      <div class="home-entry-row">
        <button type="button" class="home-guide" @click="emit('openGuide')">第一次玩？看玩法说明</button>
        <button type="button" class="home-guide" @click="emit('openReplay')">收到复盘码？导入回看</button>
        <button type="button" class="home-guide" @click="emit('openWorkshop')">自己画了图？地图工坊</button>
      </div>

      <p v-if="error" class="home-error" role="alert">{{ error }}</p>
      <p v-if="localSaveError" class="home-error" role="alert">{{ localSaveError }}</p>

      <section v-if="localSaveCards.length > 0" class="local-saves" aria-labelledby="local-saves-title">
        <h2 id="local-saves-title">继续单机</h2>
        <p class="local-saves-hint">以下为本机存档，仅保存在这台设备上，与在线房间互不影响。</p>
        <article v-for="card in localSaveCards" :key="localCardKey(card)" class="local-save-card">
          <template v-if="card.kind === 'valid'">
            <div class="local-save-copy">
              <strong>{{ card.summary.title }}</strong>
              <span>{{ card.summary.players.map((player) => `${player.nickname}${player.isBot ? '（电脑）' : ''}`).join('、') }}</span>
              <span>第 {{ card.summary.turn }} 回合 · 保存于 {{ formatSavedAt(card.summary.updatedAt) }}</span>
            </div>
            <div class="local-save-actions">
              <button type="button" class="home-resume-button" @click="emit('resumeLocal', card.summary)">继续游戏</button>
              <button type="button" class="home-resume-abandon" @click="requestLocalDelete(card)">
                {{ confirmingLocalDelete?.key === localCardKey(card) ? '确认删除' : '删除存档' }}
              </button>
              <button
                v-if="confirmingLocalDelete?.key === localCardKey(card)"
                type="button"
                class="home-resume-abandon"
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
              <button type="button" class="home-resume-abandon" :disabled="card.recordToken === undefined" @click="requestLocalDelete(card)">
                {{ confirmingLocalDelete?.key === localCardKey(card) ? '确认删除' : '删除存档' }}
              </button>
              <button
                v-if="confirmingLocalDelete?.key === localCardKey(card)"
                type="button"
                class="home-resume-abandon"
                @click="confirmingLocalDelete = null"
              >取消</button>
            </div>
          </template>
        </article>
      </section>

      <section v-if="canResumeActive" class="home-resume" aria-label="回到上一局">
        <div>
          <strong>你还有一局进行中</strong>
          <span>已选择暂不恢复，可随时回到上一局。</span>
        </div>
        <div class="home-resume-actions">
          <button type="button" class="home-resume-button" :disabled="submitting" @click="emit('resumeActive')">
            回到上一局
          </button>
          <button type="button" class="home-resume-abandon" :disabled="submitting" @click="emit('abandonActive')">
            放弃这局
          </button>
        </div>
      </section>

      <section v-if="resume" class="home-resume" aria-label="上次操作">
        <div>
          <strong>上次操作未完成</strong>
          <span>{{ resumeLabel }}</span>
          <span v-if="!pendingRetryable" class="home-resume-note">该房间已无法进入，请放弃后重新开始。</span>
        </div>
        <div class="home-resume-actions">
          <button v-if="pendingRetryable" type="button" class="home-resume-button" :disabled="submitting" @click="emit('resume')">
            继续上次操作
          </button>
          <button type="button" class="home-resume-abandon" :disabled="submitting" @click="emit('abandonPending')">
            放弃上次操作
          </button>
        </div>
      </section>

      <section v-if="playerStats" class="player-stats" aria-labelledby="stats-title">
        <h2 id="stats-title">我的战绩</h2>
        <dl class="stats-grid">
          <div class="stats-cell">
            <dt>胜 / 负</dt>
            <dd>{{ playerStats.wins }} / {{ playerStats.losses }}</dd>
          </div>
          <div class="stats-cell">
            <dt>总资产峰值</dt>
            <dd>{{ formatMoney(playerStats.bestAsset) }}</dd>
          </div>
          <div v-if="favoriteMapTitle" class="stats-cell">
            <dt>常用地图</dt>
            <dd>{{ favoriteMapTitle }}</dd>
          </div>
        </dl>

        <!-- 成就（#116）：与上面的战绩同源，全部在本机算出，不上传任何东西。 -->
        <div v-if="achievementSummary" class="achievements">
          <p class="achievements-summary">
            <strong>成就 {{ achievementSummary.unlockedCount }} / {{ achievementSummary.total }}</strong>
            <span class="achievements-next">{{ describeNextAchievement(achievementSummary) }}</span>
          </p>
          <div v-for="group in achievementGroups" :key="group.label" class="achievement-group">
            <span class="achievement-group-label">{{ group.label }}</span>
            <ul class="achievement-list">
              <li
                v-for="achievement in group.items"
                :key="achievement.id"
                class="achievement"
                :class="{ 'achievement-unlocked': achievement.unlocked }"
              >
                <span class="achievement-head">
                  <span class="achievement-mark">{{ achievement.unlocked ? '已解锁' : '未解锁' }}</span>
                  <span class="achievement-title">{{ achievement.title }}</span>
                  <span class="achievement-progress">{{ achievement.progress.current }} / {{ achievement.progress.target }}</span>
                </span>
                <span class="achievement-desc">{{ achievement.description }}</span>
              </li>
            </ul>
          </div>
        </div>

        <div class="stats-transfer">
          <p class="stats-transfer-hint">
            战绩只存在这台设备上。换设备或清缓存前先导出「战绩码」：它只含昵称与战绩，不需要账号密码；
            在新设备粘贴导入即可（导入是合并，不会覆盖本机已有的战绩）。
          </p>
          <div class="stats-transfer-actions">
            <button type="button" class="stats-transfer-button" @click="exportStatsCode">导出战绩码</button>
            <button v-if="statsCode !== ''" type="button" class="stats-transfer-button" @click="copyStatsCode">复制</button>
          </div>
          <textarea
            v-if="statsCode !== ''"
            class="stats-transfer-code"
            rows="3"
            readonly
            aria-label="导出的战绩码"
            :value="statsCode"
          ></textarea>
          <label class="stats-transfer-field">
            <span>导入战绩码</span>
            <textarea
              v-model="statsImportInput"
              class="stats-transfer-code"
              rows="3"
              placeholder="粘贴从别的设备导出的战绩码"
            ></textarea>
          </label>
          <button
            type="button"
            class="stats-transfer-button"
            :disabled="statsImportInput.trim() === ''"
            @click="importStats"
          >导入战绩码</button>
          <p
            v-if="statsNotice"
            class="stats-transfer-notice"
            :class="`stats-transfer-notice--${statsNotice.kind}`"
            role="status"
          >{{ statsNotice.message }}</p>
        </div>
      </section>

      <!-- 排行榜（#116）。刻意不在这里写长注释：SSR 的开发构建会把模板注释原样输出，
           把说明放回脚本里，页面产物就只剩真正要渲染的内容。 -->
      <section v-if="playerStats" class="leaderboard" aria-labelledby="leaderboard-title">
        <div class="leaderboard-head">
          <h2 id="leaderboard-title">成就排行榜</h2>
          <div class="leaderboard-actions">
            <button
              type="button"
              class="leaderboard-button"
              :disabled="leaderboardBusy"
              @click="publishMyStats"
            >{{ leaderboardBusy ? '处理中…' : '上榜 / 更新我的成绩' }}</button>
            <button
              type="button"
              class="leaderboard-button leaderboard-button-ghost"
              :disabled="leaderboardBusy"
              @click="refreshLeaderboard"
            >刷新榜单</button>
          </div>
        </div>

        <p class="leaderboard-hint">
          榜单按胜场排序。只有点「上榜 / 更新我的成绩」才会把数据发到服务器，内容仅
          <strong>昵称</strong>与<strong>胜场、总局数、资产峰值、玩过的地图数</strong>这四个数字：
          没有账号、没有密码、没有对局内容。成就本身完全在本机计算，不会上传。
        </p>

        <p
          v-if="leaderboardNotice"
          class="leaderboard-notice"
          :class="`leaderboard-notice--${leaderboardNotice.kind}`"
          role="status"
        >{{ leaderboardNotice.message }}</p>
        <p v-else-if="!leaderboardLoaded" class="leaderboard-notice" role="status">正在加载榜单…</p>

        <p v-if="leaderboardRank !== null" class="leaderboard-me" role="status">
          你目前第 {{ leaderboardRank }} 名。
        </p>

        <ol v-if="leaderboardEntries.length > 0" class="leaderboard-list">
          <li
            v-for="(entry, index) in leaderboardEntries"
            :key="entry.playerId"
            class="leaderboard-row"
            :class="{ 'leaderboard-row-self': leaderboardRank === index + 1 }"
          >
            <span class="leaderboard-rank">{{ index + 1 }}</span>
            <span class="leaderboard-nick">{{ entry.nickname }}</span>
            <span class="leaderboard-metric">{{ entry.wins }} 胜 / {{ entry.gamesPlayed }} 局</span>
            <span class="leaderboard-metric">峰值 {{ formatMoney(entry.bestAsset) }}</span>
          </li>
        </ol>
      </section>

      <form class="home-form" @submit.prevent>
        <label class="home-field">
          <span>你的昵称</span>
          <input
            v-model="nickname"
            type="text"
            maxlength="12"
            autocomplete="nickname"
            placeholder="例如：小明"
            :disabled="submitting"
            @keydown.enter.prevent="submitCreate"
          />
        </label>

        <MapPicker
          v-if="showMapSelector"
          v-model="selectedMapId"
          :maps="activeMaps"
          :disabled="submitting"
        />

        <div class="home-actions">
          <button type="button" class="home-primary" :disabled="!canCreate" @click="submitCreate">
            创建房间
          </button>
          <p class="home-hint">
            建房后进入房间大厅：房主可添加电脑玩家并设定其难度、自定义初始资金等规则；
            皮肤与深色模式在设置里随时切换。
          </p>
        </div>

        <div class="home-join">
          <label class="home-field">
            <span>房间码</span>
            <input
              :value="roomCode"
              type="text"
              inputmode="numeric"
              autocomplete="off"
              placeholder="6 位数字"
              aria-describedby="home-room-hint"
              :aria-invalid="showRoomError"
              :disabled="submitting"
              @keydown.enter.prevent="submitJoin"
              @input="onRoomInput"
            />
          </label>
          <div class="home-role-field" role="radiogroup" aria-label="加入身份">
            <button
              type="button"
              class="home-role-option"
              :class="{ active: joinRole === 'player' }"
              :aria-pressed="joinRole === 'player'"
              :disabled="submitting"
              @click="joinRole = 'player'"
            >参赛</button>
            <button
              type="button"
              class="home-role-option"
              :class="{ active: joinRole === 'spectator' }"
              :aria-pressed="joinRole === 'spectator'"
              :disabled="submitting"
              @click="joinRole = 'spectator'"
            >观战</button>
          </div>
          <button type="button" class="home-secondary" :disabled="!canJoin" @click="submitJoin">
            {{ joinRole === 'spectator' ? '以观战身份加入' : '加入房间' }}
          </button>
        </div>
        <p id="home-room-hint" class="home-hint" :class="{ invalid: showRoomError }" role="status">
          {{ showRoomError ? '房间码需为 6 位数字' : (joinRole === 'spectator'
            ? '观战仅查看棋盘、资产与战报；满员或已开局的房间也可加入'
            : '输入好友分享的 6 位房间码；开局前可加入，开局后仅可观战') }}
        </p>
      </form>

      <!-- 公开房间列表（#108）：只有房主主动公开的房间才会出现在这里，是「知道房间码」之外
           的第二条发现途径。做成可选路径而不是首页主轴——手输房间码永远可用，列表拉不到
           也不该妨碍任何人进屋。 -->
      <section class="home-rooms" aria-labelledby="home-rooms-title">
        <div class="home-rooms__head">
          <h2 id="home-rooms-title" class="home-rooms__title">公开房间</h2>
          <button
            type="button"
            class="home-rooms__refresh"
            :disabled="roomListLoading"
            @click="emit('refreshRooms')"
          >{{ roomListLoading ? '刷新中…' : '刷新' }}</button>
        </div>

        <p v-if="roomListError" class="home-rooms__notice home-rooms__notice--error" role="status">
          {{ roomListError }}
        </p>
        <p v-else-if="publicRooms.length === 0" class="home-rooms__notice" role="status">
          {{ roomListLoading ? '正在加载…' : '现在没有公开的房间。输入房间码可以直接加入好友的房。' }}
        </p>
        <ul v-else class="home-rooms__list">
          <li v-for="entry in publicRooms" :key="entry.roomCode" class="home-rooms__item">
            <div class="home-rooms__meta">
              <span class="home-rooms__code">{{ entry.roomCode }}</span>
              <span class="home-rooms__status">{{ roomStatusLabel(entry) }}</span>
              <p class="home-rooms__detail">
                {{ entry.hostNickname }} · {{ entry.mapTitle }} · {{ roomSeatLabel(entry) }}
                <template v-if="roomLimitLabel(entry)"> · {{ roomLimitLabel(entry) }}</template>
              </p>
            </div>
            <div class="home-rooms__actions">
              <button
                type="button"
                class="home-rooms__button"
                :disabled="submitting || !entry.joinable"
                :title="entry.joinable ? '' : '这局已经开局或人数已满，只能旁观'"
                @click="joinFromList(entry.roomCode, 'player')"
              >加入</button>
              <button
                type="button"
                class="home-rooms__button home-rooms__button--ghost"
                :disabled="submitting || !entry.spectatable"
                :title="entry.spectatable ? '' : '观战位已满'"
                @click="joinFromList(entry.roomCode, 'spectator')"
              >旁观</button>
            </div>
          </li>
        </ul>

        <p v-if="roomListHint" class="home-rooms__notice home-rooms__notice--error" role="status">
          {{ roomListHint }}
        </p>
      </section>

      <div class="home-divider" role="separator" aria-hidden="true"><span>或</span></div>

      <button type="button" class="home-local" :disabled="submitting" @click="submitLocal">
        单机游玩（无需联网）
      </button>
    </section>

    <footer class="home-beian">
      <!-- 更新说明入口：首页必须能看到当前版本并打开更新历史（组件自带触发按钮 + 弹层）。 -->
      <ReleaseNotesDialog />
      <a href="https://beian.miit.gov.cn" target="_blank" rel="noopener noreferrer">新ICP备2026008728号</a>
    </footer>
  </main>
</template>

<style scoped>
.home-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 18px;
}

.home-card {
  width: min(560px, 100%);
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

.player-stats {
  display: grid;
  gap: 10px;
  padding: 16px 18px;
  border: 1px solid var(--color-border);
  border-radius: 18px;
  background: rgb(255 255 255 / 60%);
}

.player-stats h2 {
  margin: 0;
  font-size: 15px;
  color: var(--color-muted);
  font-weight: 600;
}

.stats-grid {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 12px;
}

.stats-cell {
  display: grid;
  gap: 4px;
}

.stats-cell dt {
  font-size: 12px;
  color: var(--color-muted);
}

.stats-cell dd {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: var(--color-text);
}

/* 战绩码（#102）：只在本机有存储时出现，导出与导入共用一套码框样式。 */
.stats-transfer {
  display: grid;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px dashed var(--color-border);
}

.stats-transfer-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-muted);
}

.stats-transfer-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.stats-transfer-button {
  min-height: 40px;
  padding-inline: 16px;
  border: 0;
  border-radius: 14px;
  background: var(--color-primary);
  color: var(--button-enabled-text);
  font-size: 0.95rem;
  font-weight: 900;
  cursor: pointer;
}

.stats-transfer-button:disabled {
  background: var(--button-disabled-bg);
  color: var(--color-muted);
  cursor: not-allowed;
}

.stats-transfer-field {
  display: grid;
  gap: 4px;
  font-size: 12px;
  color: var(--color-muted);
}

.stats-transfer-code {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--surface-input);
  color: var(--color-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  word-break: break-all;
  resize: vertical;
}

.stats-transfer-notice {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
}

.stats-transfer-notice--ok {
  color: var(--player-green);
}

.stats-transfer-notice--error {
  color: var(--color-primary);
}

/* ---- 成就（#116）：与战绩同格，视觉上也是「战绩的延伸」。 ---- */
.achievements {
  display: grid;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px dashed var(--color-border);
}

.achievements-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin: 0;
  font-size: 12px;
  color: var(--color-muted);
}

.achievements-summary strong {
  color: var(--color-text);
}

.achievement-group {
  display: grid;
  gap: 4px;
}

.achievement-group-label {
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: var(--color-muted);
}

.achievement-list {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.achievement {
  display: grid;
  gap: 1px;
  padding: 5px 8px;
  border-left: 3px solid var(--color-border);
  border-radius: 6px;
  background: rgb(0 0 0 / 3%);
  opacity: 0.65;
}

/* 已解锁用绿色左侧条：与「失败/危险」的红完全分开，一眼能扫出拿到了几项。 */
.achievement-unlocked {
  border-left-color: var(--player-green);
  opacity: 1;
}

.achievement-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
}

.achievement-mark {
  font-size: 11px;
  font-weight: 800;
  color: var(--color-muted);
}

.achievement-unlocked .achievement-mark {
  color: var(--player-green);
}

.achievement-title {
  font-size: 13px;
  font-weight: 800;
  color: var(--color-text);
}

.achievement-progress {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--color-muted);
}

.achievement-desc {
  font-size: 11px;
  line-height: 1.5;
  color: var(--color-muted);
}

/* ---- 成就排行榜（#116） ---- */
.leaderboard {
  display: grid;
  gap: 8px;
  padding: 16px 18px;
  border: 1px solid var(--color-border);
  border-radius: 18px;
  background: rgb(255 255 255 / 60%);
}

.leaderboard-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.leaderboard h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--color-muted);
}

.leaderboard-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.leaderboard-button {
  min-height: 32px;
  padding-inline: 12px;
  border: 0;
  border-radius: 10px;
  background: var(--color-accent);
  color: var(--color-text);
  font-size: 12px;
  font-weight: 800;
  cursor: pointer;
}

.leaderboard-button-ghost {
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-muted);
}

.leaderboard-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.leaderboard-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-muted);
}

.leaderboard-notice {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  color: var(--color-muted);
}

.leaderboard-notice--ok {
  color: var(--player-green);
}

.leaderboard-notice--error {
  color: var(--color-primary);
}

.leaderboard-me {
  margin: 0;
  font-size: 12px;
  font-weight: 800;
  color: var(--color-text);
}

.leaderboard-list {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.leaderboard-row {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto auto;
  gap: 8px;
  align-items: center;
  padding: 6px 8px;
  border-radius: 8px;
  background: rgb(0 0 0 / 3%);
  font-size: 12px;
}

.leaderboard-row-self {
  background: var(--event-bg);
  color: var(--event-text);
  font-weight: 800;
}

.leaderboard-rank {
  font-variant-numeric: tabular-nums;
  font-weight: 800;
  color: var(--color-muted);
}

.leaderboard-row-self .leaderboard-rank {
  color: inherit;
}

.leaderboard-nick {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 800;
  color: var(--color-text);
}

.leaderboard-row-self .leaderboard-nick {
  color: inherit;
}

.leaderboard-metric {
  font-variant-numeric: tabular-nums;
  color: var(--color-muted);
  white-space: nowrap;
}

.leaderboard-row-self .leaderboard-metric {
  color: inherit;
}

.home-eyebrow,
.home-copy,
.home-field span,
.home-hint {
  color: var(--color-muted);
}

.home-eyebrow {
  margin: 0;
  font-size: 12px;
  font-weight: 900;
  letter-spacing: 0.2em;
}

.home-card h1 {
  margin: 0;
  color: var(--color-primary);
  font-size: clamp(30px, 6vw, 48px);
  line-height: 1;
}

.home-copy {
  margin: 0;
  line-height: 1.6;
}

/* 玩法说明入口（#109）：次要动作，所以是描边胶囊而不是实心主按钮。 */
.home-entry-row {
  /* 三条入口并列，窄屏自动折行；整行仍靠左，保持与标题对齐。 */
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-self: start;
}

.home-guide {
  justify-self: start;
  min-height: 36px;
  padding-inline: 14px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: transparent;
  color: var(--color-muted);
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}

.home-guide:hover {
  color: var(--color-text);
}

.home-error {
  margin: 0;
  padding: 10px 12px;
  border-radius: 12px;
  background: #ffe1d8;
  color: var(--color-primary);
  font-weight: 900;
}

.home-resume {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  padding: 12px 14px;
  border-radius: 16px;
  border: 1px solid var(--color-accent);
  background: var(--event-bg);
  color: var(--event-text);
}

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

.home-resume div {
  display: grid;
  gap: 2px;
}

.home-resume strong {
  font-size: 14px;
}

.home-resume span {
  font-size: 13px;
}

.home-form {
  display: grid;
  gap: 12px;
}

.home-field {
  display: grid;
  gap: 6px;
  font-weight: 800;
}

.home-card input,
.home-card select {
  min-height: 44px;
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  padding: 8px 10px;
  background: var(--surface-input);
  color: var(--color-text);
  font-weight: 800;
}

.home-card input[aria-invalid='true'] {
  border-color: var(--color-primary);
}

.home-card input:focus-visible,
.home-card select:focus-visible,
.home-card button:focus-visible {
  outline: 3px solid var(--color-accent);
  outline-offset: 2px;
}

.home-join {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 12px;
  align-items: end;
}

.home-role-field {
  display: flex;
  border-radius: 12px;
  overflow: hidden;
  border: 2px solid var(--color-accent);
  align-self: end;
}

.home-role-option {
  flex: 1;
  min-height: 48px;
  padding-inline: 14px;
  border: 0;
  background: transparent;
  color: var(--color-text);
  font-size: 0.9rem;
  font-weight: 700;
  cursor: pointer;
}

.home-role-option.active {
  background: var(--color-accent);
}

.home-role-option:disabled {
  cursor: default;
  opacity: 0.6;
}

.home-actions {
  display: grid;
  gap: 8px;
}

.home-hint {
  margin: 0;
  font-size: 12px;
}

.home-hint.invalid {
  color: var(--color-primary);
  font-weight: 900;
}

.home-beian {
  margin: 14px 0 0;
  font-size: 12px;
  color: var(--color-muted);
  text-align: center;
  letter-spacing: 0.02em;
}

.home-beian a {
  color: inherit;
  text-decoration: none;
}

.home-beian a:hover {
  text-decoration: underline;
}

.home-primary,
.home-secondary,
.home-local,
.home-resume-button {
  min-height: 48px;
  border: 0;
  border-radius: 16px;
  font-size: 1rem;
  font-weight: 900;
  cursor: pointer;
}

.home-primary {
  width: 100%;
  background: var(--button-enabled-bg);
  color: var(--button-enabled-text);
}

.home-secondary {
  padding-inline: 18px;
  background: var(--color-accent);
  color: var(--color-text);
}

.home-resume-button {
  padding-inline: 16px;
  background: var(--color-primary);
  color: var(--button-enabled-text);
}

.home-resume-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.home-resume-abandon {
  min-height: 48px;
  padding-inline: 16px;
  border: 1px solid var(--color-border);
  border-radius: 16px;
  background: transparent;
  color: var(--event-text);
  font-size: 1rem;
  font-weight: 900;
  cursor: pointer;
}

.home-resume-note {
  color: var(--color-primary);
  font-weight: 900;
}

.home-local {
  background: var(--button-disabled-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
}

.home-primary:disabled,
.home-secondary:disabled,
.home-resume-button:disabled,
.home-resume-abandon:disabled,
.home-local:disabled {
  background: var(--button-disabled-bg);
  color: var(--button-disabled-text);
  cursor: not-allowed;
}

/* ---- 公开房间列表（#108）---- */
.home-rooms {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: var(--color-surface-muted, transparent);
}

.home-rooms__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.home-rooms__title {
  margin: 0;
  font-size: 14px;
  font-weight: 800;
}

.home-rooms__refresh {
  padding: 4px 10px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: transparent;
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}

.home-rooms__refresh:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.home-rooms__notice {
  margin: 0;
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.6;
}

.home-rooms__notice--error {
  color: var(--color-warning, #b45309);
}

.home-rooms__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.home-rooms__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
}

.home-rooms__meta {
  min-width: 0;
}

.home-rooms__code {
  font-variant-numeric: tabular-nums;
  font-weight: 800;
  letter-spacing: 1px;
}

.home-rooms__status {
  margin-left: 8px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--color-border);
  color: var(--color-muted);
  font-size: 11px;
  font-weight: 700;
}

.home-rooms__detail {
  margin: 2px 0 0;
  overflow: hidden;
  color: var(--color-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.home-rooms__actions {
  display: flex;
  flex-shrink: 0;
  gap: 6px;
}

.home-rooms__button {
  padding: 5px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-primary, #2563eb);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}

.home-rooms__button--ghost {
  background: transparent;
  color: inherit;
}

.home-rooms__button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.home-divider {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 12px;
  align-items: center;
  color: var(--color-muted);
  font-size: 13px;
  font-weight: 800;
}

.home-divider::before,
.home-divider::after {
  content: '';
  height: 1px;
  background: var(--color-border);
}

@media (max-width: 767px) {
  .home-shell {
    padding: 10px;
    place-items: start center;
  }

  .home-join {
    grid-template-columns: 1fr;
  }

  .home-role-field {
    align-self: start;
  }
}
</style>
