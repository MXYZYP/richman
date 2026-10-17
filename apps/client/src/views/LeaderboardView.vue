<script setup lang="ts">
import { onMounted, ref } from 'vue';
import DetailSheet from '../components/DetailSheet.vue';
import {
  buildLeaderboardSubmission,
  describeLeaderboardFailure,
  ensurePlayerId,
  loadLeaderboard,
  publishLeaderboard,
  type LeaderboardEntry,
} from '../session/leaderboard';
import { browserStorage, loadPlayerStats } from '../session/playerStats';
import { formatMoney } from '../ui/format';

/**
 * 「成就排行榜」详情页（《UI 改造方案》§四）—— 首页那排图标里的第四个。
 *
 * 本页是**唯一会往外发数据的地方**，所以规矩直接写在界面上：不点不上传。
 * 上传的只有昵称与四个聚合数字（胜场 / 总局数 / 资产峰值 / 玩过的地图数）。
 *
 * 拉取放在组件自己身上，而不是像公开房间列表（#108）那样交给 App：排行榜是一条独立的
 * 同源 HTTP 接口，与会话/房间协议无关，没必要为它铺一串 props + emit。
 * 独立成页之后，「进页面就拉一次」正好是想要的行为 —— 榜单长度也不再受首页高度限制。
 * `onMounted` 在 node 测试环境里不会执行，因此这一块对 SSR 渲染契约测试是透明的。
 *
 * 模板里刻意不写注释：SSR 的开发构建会把模板注释原样输出，说明留在脚本里就好。
 */
const props = withDefaults(defineProps<{
  /** 上榜时用的昵称。由 App 持有、在线对战页输入，与首页那版行为一致。 */
  nickname?: string;
  /** 弹窗是否打开。四个图标入口改成弹窗后由 App 传 true（本详情只在该面板激活时挂载）。 */
  open: boolean;
}>(), {
  nickname: '',
});

const emit = defineEmits<{ close: [] }>();

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
  // 刻意重新读一遍战绩（而不是缓存一份）：刚打完一局进来时缓存可能还是旧值。
  const result = await publishLeaderboard(
    buildLeaderboardSubmission(loadPlayerStats(storage), props.nickname, playerId),
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
  <DetailSheet
    :open="open"
    title="成就排行榜"
    :aside="leaderboardRank === null ? '' : `第 ${leaderboardRank} 名`"
    @close="emit('close')"
  >
    <div class="leaderboard">
      <div class="leaderboard-head">
        <h2 id="leaderboard-title">本期榜单</h2>
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
    </div>
  </DetailSheet>
</template>

<style scoped>
/* ---- 成就排行榜（#116） ---- */
.leaderboard {
  display: grid;
  gap: 8px;
  padding: 16px 18px;
  border: 1px solid var(--color-border);
  border-radius: 18px;
  background: var(--surface-quiet);
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
  font-size: var(--text-section-size);
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
  color: var(--color-pay);
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

/* 榜单行照参考图做成「一张一张的小卡片」：12px 圆角 + 细描边 + 实心底，
   前三名的名次换成奖牌色块，自己那一行整块高亮（描边 + 底色 + 一条底边）。 */
.leaderboard-row {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) auto auto;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--surface-soft);
  font-size: 12px;
}

.leaderboard-row-self {
  border-color: color-mix(in srgb, var(--color-accent) 62%, var(--color-border));
  background: color-mix(in srgb, var(--color-accent) 16%, var(--surface-card));
  color: var(--color-text);
  font-weight: 800;
  box-shadow: 0 2px 0 color-mix(in srgb, var(--color-accent) 42%, transparent);
}

.leaderboard-rank {
  display: grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-muted) 14%, transparent);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  font-weight: 900;
  color: var(--color-muted);
}

/* 金 / 银 / 铜：只给前三名上色，其余保持中性灰块。 */
.leaderboard-row:nth-child(1) .leaderboard-rank {
  background: var(--color-accent);
  color: #3a2a10;
}

.leaderboard-row:nth-child(2) .leaderboard-rank {
  background: color-mix(in srgb, var(--color-muted) 30%, #ffffff);
  color: #3a3a34;
}

.leaderboard-row:nth-child(3) .leaderboard-rank {
  background: color-mix(in srgb, var(--color-primary) 26%, #ffffff);
  color: #4a2a18;
}

.leaderboard-row-self .leaderboard-rank {
  color: inherit;
}

.leaderboard-nick {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 900;
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

/* 自己那一行的强调已经由整卡描边承担，不再需要左侧那条 3px 竖条。 */
</style>
