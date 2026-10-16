<script setup lang="ts">
import { computed, ref } from 'vue';
import { listActiveMaps, type MapCatalogEntry } from '@richman/board-data';
import ViewShell from './ViewShell.vue';
import { DEFAULT_ONLINE_NICKNAME } from '../session/appFlow';
import {
  browserStorage,
  encodeStatsCode,
  importStatsCode,
  loadPlayerStats,
  type PlayerStats,
} from '../session/playerStats';
import { formatMoney } from '../ui/format';

/**
 * 「战绩」详情页（《UI 改造方案》§四）—— 首页那排图标里的第一个。
 *
 * 与它同源的「战绩码导入 / 导出」也在这页：那份码搬的就是这份战绩，本来就该在一起。
 * 逻辑全部照搬自原首页 HomeView，只有一处**变简单了** —— 原来导入战绩后要回头喊一句
 * `refreshLeaderboard()`（因为排行榜就挂在首页下方，战绩一变它就得重取）；现在排行榜
 * 是另一个页面，进去时自己会拉一次，那条跨区块的耦合自然消失。
 */
const props = withDefaults(defineProps<{
  /**
   * 昵称只用来给导出的战绩码署名。
   *
   * 它是「这次会话里玩家自称什么」，由 App 持有、在线对战页输入 —— 与首页那版行为完全一致
   * （留空时导出兜底署名 `DEFAULT_ONLINE_NICKNAME`）。刻意不做本地持久化：那会改变
   * 「刷新一次昵称就空了」这个既有行为，不属于本次改造的范围。
   */
  nickname?: string;
  /** 用来把 `favoriteMaps` 里的地图 id 翻译成人读的名字。 */
  activeMaps?: readonly MapCatalogEntry[];
}>(), {
  nickname: '',
  activeMaps: () => listActiveMaps(),
});

const emit = defineEmits<{ back: [] }>();

// 本地战绩（路线图 #12）：无存储时为 null，界面据此给出「还没打过」的说明。
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
    nickname: props.nickname.trim() === '' ? DEFAULT_ONLINE_NICKNAME : props.nickname.trim(),
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
}
</script>

<template>
  <ViewShell title="我的战绩" aside="本机" @back="emit('back')">
    <p v-if="!playerStats" class="view-empty" role="status">
      这台设备上还没有战绩。打完一局（联机或单机都可以）就会记在这里。
    </p>

    <div v-else class="player-stats">
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
    </div>
  </ViewShell>
</template>

<style scoped>
.view-empty {
  margin: 0;
  color: var(--color-muted);
  font-size: 13px;
  line-height: 1.7;
}

.player-stats {
  display: grid;
  gap: 10px;
  padding: 16px 18px;
  border: 1px solid var(--color-border);
  border-radius: 18px;
  background: var(--surface-quiet);
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
  font-size: var(--text-l3-size);
  font-weight: var(--text-l3-weight);
  color: var(--color-muted);
}

.stats-cell dd {
  margin: 0;
  font-size: var(--text-l2-size);
  font-weight: var(--text-l2-weight);
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
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
  color: #fff4ec;
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
  color: var(--color-pay);
}
</style>
