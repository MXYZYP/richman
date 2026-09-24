<script setup lang="ts">
import { computed } from 'vue';
import { getActiveMapPack } from '@richman/board-data';
import { getMapThumbnailModel, type MapThumbnailModel } from '../ui/mapThumbnail';

/**
 * 地图缩略图：按地图自己的 presentation 画一张等比例缩小的 SVG 轮廓。
 *
 * 存在的理由：地图选择器原来只显示地图名字，玩家看不出「回字双环」和「外环 + 支路」
 * 的区别，换地图等于没换。这里用真实棋格矩形 + 路线，保证看到的就是真实盘面形状。
 * 颜色取自地图 theme，所以缩略图与进局后的棋盘观感一致。
 */
const props = withDefaults(defineProps<{
  mapId: string;
  /** 供读屏使用的名称，一般传地图标题。 */
  title?: string;
  /** 显示边长（px）；SVG 内部仍用地图自己的画布坐标系。 */
  size?: number;
  /** 是否叠出几何描述文字（如「回字双环 · 60 格」）。 */
  showLayoutLabel?: boolean;
}>(), {
  title: '',
  size: 72,
  showLayoutLabel: false,
});

// 目录里的 mapId 理论上都能解析；万一拿到下架地图也不该让整个选择器炸掉，故兜底成占位块。
const model = computed<MapThumbnailModel | null>(() => {
  try {
    return getMapThumbnailModel(getActiveMapPack(props.mapId));
  } catch {
    return null;
  }
});

const accessibilityLabel = computed(() => (
  props.title.length > 0 ? `${props.title} 地图缩略图` : '地图缩略图'
));
</script>

<template>
  <span class="map-thumb-wrap" :style="{ '--map-thumb-size': `${size}px` }">
    <svg
      v-if="model"
      class="map-thumb"
      :viewBox="`0 0 ${model.canvasSize} ${model.canvasSize}`"
      role="img"
      :aria-label="accessibilityLabel"
    >
      <rect
        :x="0"
        :y="0"
        :width="model.canvasSize"
        :height="model.canvasSize"
        :fill="model.boardColor"
      />
      <template v-for="(route, index) in model.routes" :key="`route-${index}`">
        <line
          v-if="route.shape === 'line'"
          :x1="route.x1 ?? 0"
          :y1="route.y1 ?? 0"
          :x2="route.x2 ?? 0"
          :y2="route.y2 ?? 0"
          :stroke="route.stroke"
          :stroke-width="route.strokeWidth"
          :stroke-dasharray="route.dash ?? undefined"
          :opacity="route.opacity"
          fill="none"
        />
        <polyline
          v-else-if="route.shape === 'polyline'"
          :points="route.points ?? ''"
          :stroke="route.stroke"
          :stroke-width="route.strokeWidth"
          :stroke-dasharray="route.dash ?? undefined"
          :opacity="route.opacity"
          fill="none"
        />
        <path
          v-else
          :d="route.d ?? ''"
          :stroke="route.stroke"
          :stroke-width="route.strokeWidth"
          :stroke-dasharray="route.dash ?? undefined"
          :opacity="route.opacity"
          fill="none"
        />
      </template>
      <rect
        v-for="cell in model.cells"
        :key="cell.id"
        :x="cell.x"
        :y="cell.y"
        :width="cell.width"
        :height="cell.height"
        :fill="cell.fill"
        :stroke="model.borderColor"
        stroke-width="0.5"
      />
    </svg>
    <span v-else class="map-thumb map-thumb-empty" aria-hidden="true">?</span>
    <span v-if="showLayoutLabel && model" class="map-thumb-layout">{{ model.layoutLabel }}</span>
  </span>
</template>

<style scoped>
.map-thumb-wrap {
  display: inline-grid;
  gap: 4px;
  justify-items: center;
}

.map-thumb {
  display: block;
  width: var(--map-thumb-size, 72px);
  height: var(--map-thumb-size, 72px);
  border: 1px solid rgb(0 0 0 / 18%);
  border-radius: 9px;
  background: var(--board-surface);
  overflow: hidden;
}

.map-thumb-empty {
  display: grid;
  place-items: center;
  color: var(--color-muted);
  font-size: calc(var(--map-thumb-size, 72px) * 0.4);
  font-weight: 900;
}

.map-thumb-layout {
  color: var(--color-muted);
  font-size: 11px;
  font-weight: 700;
  line-height: 1.2;
  text-align: center;
}
</style>
