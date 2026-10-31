<script setup lang="ts">
import { computed, ref } from 'vue';
import { listActiveMaps, type MapCatalogEntry } from '@richman/board-data';
import DetailSheet from '../components/DetailSheet.vue';
import { deriveAchievements, describeNextAchievement, type AchievementGroup } from '../session/achievements';
import { browserStorage, loadPlayerStats, type PlayerStats } from '../session/playerStats';
import { deriveWeeklyChallenges } from '../session/weeklyChallenges';

/**
 * 「成就」详情页（《UI 改造方案》§四）—— 首页那排图标里的第二个。
 *
 * 成就全部由**本机战绩**派生：不新增采集、不发任何网络请求。原来它是首页里一个
 * `<details>` 折叠块，明细一铺开就把首页顶得很长；现在整页都是它的，折叠只是
 * 「一进来就看到几项」的顺手写法，不是省地方。
 */
const props = withDefaults(defineProps<{
  /** 收集类成就按「当前已发布」的地图算 —— 下架的地图不该继续挂在待完成项里。 */
  activeMaps?: readonly MapCatalogEntry[];
  /** 弹窗是否打开。四个图标入口改成弹窗后由 App 传 true（本详情只在该面板激活时挂载）。 */
  open: boolean;
}>(), {
  activeMaps: () => listActiveMaps(),
});

const emit = defineEmits<{ close: [] }>();

function readPlayerStats(): PlayerStats | null {
  const storage = browserStorage();
  return storage === undefined ? null : loadPlayerStats(storage);
}

const playerStats = ref<PlayerStats | null>(readPlayerStats());

const achievementSummary = computed(() => {
  const current = playerStats.value;
  if (current === null) return null;
  return deriveAchievements(current, { mapIds: props.activeMaps.map((entry) => entry.ref.id) });
});

/**
 * 本周挑战：成就是一次性的，这里补一个周期性目标（进度按**本周增量**算，
 * 跨周自动归零）。读不到存储/战绩时为 null —— 与下面「没有战绩就不显示成就」一致，
 * 宁可整块不出现，也不要摆一排 0/3 让人以为坏了。
 */
const weeklyChallenges = computed(() => {
  const storage = browserStorage();
  const current = playerStats.value;
  if (storage === undefined || current === null) return null;
  return deriveWeeklyChallenges(storage, current, { now: Date.now() });
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
</script>

<template>
  <DetailSheet
    :open="open"
    title="成就"
    :aside="achievementSummary ? `${achievementSummary.unlockedCount} / ${achievementSummary.total}` : ''"
    @close="emit('close')"
  >
    <p v-if="!achievementSummary" class="view-empty" role="status">
      这台设备上还没有战绩，成就也就无从算起。打完一局（联机或单机都可以）再回来看看。
    </p>

    <!-- 每周挑战：给「这周为什么再来一局」一个答案。放在成就之前——
         它比成就更当下，且每周一自动刷新。 -->
    <section v-if="weeklyChallenges" class="weekly" aria-label="本周挑战">
      <header class="weekly-head">
        <strong>本周挑战</strong>
        <span class="weekly-count">{{ weeklyChallenges.doneCount }} / {{ weeklyChallenges.challenges.length }}</span>
      </header>
      <ul class="weekly-list">
        <li
          v-for="challenge in weeklyChallenges.challenges"
          :key="challenge.id"
          class="weekly-item"
          :class="{ 'weekly-done': challenge.done }"
        >
          <span class="achievement-head">
            <span class="achievement-mark">{{ challenge.done ? '已完成' : '进行中' }}</span>
            <span class="achievement-title">{{ challenge.title }}</span>
            <span class="achievement-progress">{{ challenge.progress.current }} / {{ challenge.progress.target }}</span>
          </span>
          <span class="achievement-desc">{{ challenge.description }}</span>
        </li>
      </ul>
      <p class="weekly-note">{{ weeklyChallenges.weekKey }} · 每周一刷新，只算本周打的部分。</p>
    </section>

    <!-- 用 <details> 而不是条件渲染：明细始终留在 DOM 里，折叠只是视觉收起，
         展开时不会有「先空一下再填」的跳动，也不需要额外状态。 -->
    <details v-if="achievementSummary" id="achievements" class="achievements" open>
      <summary class="achievements-summary">
        <strong>成就 {{ achievementSummary.unlockedCount }} / {{ achievementSummary.total }}</strong>
        <span class="achievements-toggle" aria-hidden="true"></span>
      </summary>
      <div class="achievements-body">
        <p class="achievements-next">{{ describeNextAchievement(achievementSummary) }}</p>
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
        <p class="achievements-note">成就全部由本机战绩算出，不会上传到服务器。</p>
      </div>
    </details>
  </DetailSheet>
</template>

<style scoped>
.view-empty {
  margin: 0;
  color: var(--color-muted);
  font-size: 13px;
  line-height: 1.7;
}

/* ---- 每周挑战 ---- */
.weekly {
  margin: 0 0 12px;
  padding: 10px 12px;
  border-radius: var(--radius-panel);
  background: var(--surface-raised);
}

.weekly-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.weekly-count {
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 800;
}

.weekly-list {
  display: grid;
  gap: 6px;
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}

.weekly-note {
  margin: 6px 0 0;
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.7;
}

.weekly-done .achievement-mark {
  color: var(--color-primary);
}

/* 原来在首页里，这句说明靠外层区块的间距撑着；独立成页后它需要自己的呼吸。 */
.achievements-note {
  margin: 4px 0 0;
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.7;
}

/* ---- 成就（#116）：与战绩同格，视觉上也是「战绩的延伸」。
        收成下拉块：收起时只占一行，默认不占主屏。 ---- */
.achievements {
  padding-top: 12px;
  border-top: 1px dashed var(--color-border);
}

.achievements-summary {
  display: flex;
  align-items: center;
  gap: 4px 10px;
  min-height: 32px;
  font-size: 12px;
  color: var(--color-muted);
  cursor: pointer;
  /* 去掉浏览器自带的三角，改用右侧的「展开 / 收起」文字：手机上手指点起来更明确。 */
  list-style: none;
}

.achievements-summary::-webkit-details-marker {
  display: none;
}

.achievements-summary strong {
  color: var(--color-text);
}

.achievements-toggle {
  margin-inline-start: auto;
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}

.achievements-toggle::after {
  content: '展开 ▾';
}

.achievements[open] .achievements-toggle::after {
  content: '收起 ▴';
}

.achievements-body {
  display: grid;
  gap: 8px;
  padding-top: 8px;
}

.achievements-next {
  margin: 0;
  font-size: 12px;
  color: var(--color-muted);
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
</style>
