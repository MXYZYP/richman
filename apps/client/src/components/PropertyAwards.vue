<script setup lang="ts">
import { computed } from 'vue';
import type { RenderableGameState } from '../session/gameSession';
import { getPropertyAwards } from '../game/propertyAwards';

// 本局地块奖项：游戏进行中实时展示。数据由 propertyAwards 纯派生，无副作用。
const props = defineProps<{ state: RenderableGameState }>();
const awards = computed(() => getPropertyAwards(props.state).awards);
</script>

<template>
  <section v-if="awards.length > 0" class="awards-card" aria-label="本局地块奖项">
    <header>
      <span class="awards-title">本局地块奖项</span>
      <strong>实时统计</strong>
    </header>
    <ul>
      <li v-for="award in awards" :key="award.kind" :class="`award-${award.kind}`">
        <span class="award-title">{{ award.title }}</span>
        <span class="award-name" :title="award.cellName">{{ award.cellName }}</span>
        <span class="award-metric">{{ award.metric }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.awards-card {
  padding: 11px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--game-radius-panel);
  background: var(--game-panel);
  box-shadow: var(--game-shadow-panel);
}

.awards-card header {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: baseline;
  margin-bottom: 8px;
}

.awards-title {
  color: var(--color-text);
  font-size: 0.95rem;
  font-weight: 900;
  letter-spacing: 0.02em;
}

.awards-card header strong {
  color: var(--color-muted);
  font-size: 10.5px;
  font-weight: 800;
}

.awards-card ul {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.awards-card li {
  display: grid;
  grid-template-columns: minmax(60px, auto) minmax(0, 1fr) auto;
  gap: 8px;
  align-items: baseline;
  padding: 7px 8px;
  border: 1px solid var(--game-line-soft);
  border-radius: 9px;
  background: var(--game-panel-raised);
  border-inline-start: 3px solid var(--game-line-soft);
}

.award-title {
  color: var(--color-primary);
  font-size: 12px;
  font-weight: 900;
  white-space: nowrap;
}

.award-name {
  color: var(--color-text);
  font-size: 13px;
  font-weight: 800;
  overflow-wrap: anywhere;
}

.award-metric {
  color: var(--color-muted);
  font-family: var(--game-mono);
  font-size: 11px;
  font-weight: 800;
  white-space: nowrap;
}

.award-mvp { border-inline-start-color: var(--color-accent); }
.award-worst { border-inline-start-color: color-mix(in srgb, var(--color-pay) 55%, var(--color-border)); }
.award-bestValue { border-inline-start-color: var(--player-green, #3a9d5a); }
</style>
