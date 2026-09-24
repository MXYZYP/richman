<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import type { MapCatalogEntry } from '@richman/board-data';
import MapThumbnail from './MapThumbnail.vue';

const props = withDefaults(defineProps<{
  modelValue: string;
  maps: readonly MapCatalogEntry[];
  label?: string;
  disabled?: boolean;
}>(), {
  label: '地图',
  disabled: false,
});

const emit = defineEmits<{
  'update:modelValue': [mapId: string];
}>();

// A custom map switcher that mirrors the app's dialog language (see .lobby-qr-dialog /
// .setup-confirm) instead of the browser-native <select> popup, which looked inconsistent
// across platforms. The two call sites (HomeView + GameSetup) share this one component so
// the "地图切换" control is visually unified everywhere.
//
// 每项都带真实盘面缩略图 + 描述：地图多了以后光看名字分不出差别（尤其"换皮"同构图），
// 缩略图直接显示棋格轮廓，"回字双环"和"外环 + 支路"一眼可辨。
//
// #7：菜单从「单列大行」改成「多列小卡」网格。地图到 8 张以后，单列每项 78px 高、
// 一屏只放得下 5 行，找地图得一路下滑；换成三到四列的缩略图卡片后整屏铺开，
// 十张图也能在两三行内看完，滚动量基本归零。
const open = ref(false);
const rootRef = ref<HTMLElement | null>(null);
const triggerRef = ref<HTMLButtonElement | null>(null);

const currentEntry = computed(() => (
  props.maps.find((entry) => entry.ref.id === props.modelValue) ?? null
));

const currentTitle = computed(() => currentEntry.value?.title ?? props.modelValue);

function toggle() {
  if (props.disabled || props.maps.length === 0) return;
  if (open.value) close();
  else openPicker();
}

function openPicker() {
  open.value = true;
  document.addEventListener('click', onDocClick, true);
  window.addEventListener('keydown', onKeydown);
}

function close() {
  open.value = false;
  document.removeEventListener('click', onDocClick, true);
  window.removeEventListener('keydown', onKeydown);
}

function onDocClick(event: MouseEvent) {
  if (rootRef.value !== null && !rootRef.value.contains(event.target as Node)) close();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    close();
    triggerRef.value?.focus();
  }
}

function select(mapId: string) {
  emit('update:modelValue', mapId);
  close();
  triggerRef.value?.focus();
}

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick, true);
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div ref="rootRef" class="map-picker">
    <span class="map-picker-label">{{ label }}</span>
    <button
      ref="triggerRef"
      type="button"
      class="map-picker-trigger"
      :disabled="disabled"
      :aria-haspopup="'listbox'"
      :aria-expanded="open"
      :aria-label="label"
      @click="toggle"
    >
      <MapThumbnail class="map-picker-trigger-thumb" :map-id="modelValue" :title="currentTitle" :size="28" />
      <span class="map-picker-value">{{ currentTitle }}</span>
      <span class="map-picker-chevron" aria-hidden="true">▾</span>
    </button>
    <ul v-if="open" class="map-picker-menu" role="listbox" :aria-label="label">
      <li v-for="entry in maps" :key="entry.ref.id">
        <button
          type="button"
          class="map-picker-option"
          :class="{ active: entry.ref.id === modelValue }"
          :aria-selected="entry.ref.id === modelValue"
          role="option"
          @click="select(entry.ref.id)"
        >
          <MapThumbnail
            class="map-picker-option-thumb"
            :map-id="entry.ref.id"
            :title="entry.title"
            :size="56"
          />
          <span class="map-picker-option-text">
            <span class="map-picker-option-title">{{ entry.title }}</span>
            <span class="map-picker-option-desc">{{ entry.description }}</span>
          </span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.map-picker {
  position: relative;
  display: grid;
  gap: 6px;
  font-weight: 800;
}

.map-picker-label {
  color: var(--color-muted);
}

.map-picker-trigger {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  min-height: 44px;
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--surface-input);
  color: var(--color-text);
  font: inherit;
  font-weight: 800;
  cursor: pointer;
}

.map-picker-trigger:disabled {
  background: var(--button-disabled-bg);
  color: var(--button-disabled-text);
  cursor: not-allowed;
}

.map-picker-trigger:focus-visible {
  outline: 3px solid var(--color-accent);
  outline-offset: 2px;
}

.map-picker-trigger-thumb {
  flex: none;
}

.map-picker-value {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.map-picker-chevron {
  flex: none;
  color: var(--color-muted);
  transition: transform 0.15s ease;
}

.map-picker-trigger[aria-expanded='true'] .map-picker-chevron {
  transform: rotate(180deg);
}

/* #7：缩略图卡片网格。每项从「一行宽条」变成「一张竖卡」，列数随宽度自适应
   （窄屏 3 列、宽屏 4 列），高度按行数增长，不再是一条长列表。 */
.map-picker-menu {
  position: absolute;
  z-index: 20;
  top: 100%;
  left: 0;
  margin: 6px 0 0;
  padding: 8px;
  list-style: none;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 8px;
  width: min(100%, 460px);
  /* 卡片化以后单屏能塞下两三行，高度上限比原单列方案更矮，双保险不溢出屏幕。 */
  max-height: min(58vh, 420px);
  overflow-y: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--color-accent);
  border-radius: 16px;
  background: var(--board-surface);
  box-shadow: 0 18px 48px rgb(53 39 20 / 18%);
}

.map-picker-menu > li {
  display: grid;
  min-width: 0;
}

.map-picker-option {
  display: grid;
  justify-items: center;
  align-content: start;
  gap: 6px;
  width: 100%;
  height: 100%;
  min-height: 44px;
  padding: 8px 6px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--color-text);
  font: inherit;
  font-weight: 800;
  text-align: center;
  cursor: pointer;
}

.map-picker-option-thumb {
  flex: none;
}

.map-picker-option-text {
  display: grid;
  gap: 2px;
  min-width: 0;
  justify-items: center;
}

.map-picker-option-title {
  font-size: 13px;
  font-weight: 800;
}

/* 描述两行截断：太长也不把卡片撑得比别人高一截。 */
.map-picker-option-desc {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  color: var(--color-muted);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.3;
}

.map-picker-option:hover,
.map-picker-option.active {
  background: var(--event-bg);
  color: var(--event-text);
}

.map-picker-option.active {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
</style>
