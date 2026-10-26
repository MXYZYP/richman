<script setup lang="ts">
import { computed } from 'vue';
import type { Cell as BoardCellData, DeepReadonly } from '@richman/board-data';
import type { PropertyState, PlayerColor } from '@richman/engine';
import type { CellPresentationModel } from '../ui/boardLayout';

/**
 * 小程序端棋格（源站 components/BoardCell.vue 的移植版）。
 *
 * 差异只在渲染层：源站用内联 <svg> 画「格名 + 地球 + 房屋」，
 * 而小程序没有 SVG，`<svg>` 会被编译成不存在的自定义组件、静默渲染为空。
 * 这里把三样东西换成 view/text：
 *
 *   格名   → <text>，绝对定位 + calc(var(--board-size) * N)
 *   地球   → CSS 画的圆圈 + 赤道线
 *   房屋   → CSS 方块（clip-path 切出屋顶），旅馆加金色顶
 *
 * 几何换算：棋盘画布是 100×100，--board-size 是它的像素边长，
 * 所以「1 画布单位 = var(--board-size) 的 1%」，与源站 cqw 完全等价。
 */
const props = withDefaults(defineProps<{
  cell: DeepReadonly<BoardCellData>;
  presentation: CellPresentationModel;
  property?: PropertyState;
  ownerColorKey?: PlayerColor;
  selected?: boolean;
  maxHouseLevel?: number;
  ownerName?: string | null;
}>(), { maxHouseLevel: 5, ownerName: null });

const emit = defineEmits<{ select: [] }>();

function selectCell() {
  emit('select');
}

const buildLevel = computed(() => {
  const property = props.property;
  if (property === undefined || !property.ownerId) return 0;
  return property.level ?? 0;
});
const isHotel = computed(() => buildLevel.value > 0 && buildLevel.value >= props.maxHouseLevel);
const houseCount = computed(() => (isHotel.value ? 0 : buildLevel.value));
const hasBuildings = computed(() => buildLevel.value > 0);

const buildLabel = computed(() => {
  if (!hasBuildings.value) return null;
  return isHotel.value ? '旅馆' : `${buildLevel.value} 级房屋`;
});

const compactBuild = computed(() => (
  hasBuildings.value && !isHotel.value && canvasUnits(props.presentation.style.width) < 5.6
));

const buildStyle = computed(() => ({
  '--build-count': String(Math.max(houseCount.value, 1)),
  '--build-sat': `${Math.min(62 + (buildLevel.value - 1) * 13, 100)}%`,
}));

const ownerSummary = computed(() => {
  const parts: string[] = [props.cell.name];
  if (props.ownerName !== null && props.ownerName !== undefined) parts.push(`归属 ${props.ownerName}`);
  if (buildLabel.value !== null) parts.push(buildLabel.value);
  else if (props.property?.ownerId) parts.push('裸地');
  if (props.property?.mortgaged) parts.push('已抵押');
  return parts.join(' · ');
});

const CARD_INSET = 0.18;
const WORLD_GLYPH = '🌐';

const isProperty = computed(() => props.cell.type === 'property');
const isWorld = computed(() => props.presentation.iconGlyph === WORLD_GLYPH);
const label = computed(() => props.presentation.compactLabel);
const hasImage = computed(() => props.presentation.assetUrl !== null);
const bandStyle = computed(() => ({ background: props.presentation.bandColor ?? 'transparent' }));

function canvasUnits(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function cardOf(width: string | undefined, height: string | undefined) {
  return {
    width: Math.max(canvasUnits(width) - CARD_INSET * 2, 0.6),
    height: Math.max(canvasUnits(height) - CARD_INSET * 2, 0.6),
  };
}

function labelFontSize(length: number): number {
  if (length <= 2) return 2.5;
  if (length === 3) return 2.25;
  return 2;
}

function estimateTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const character of text) {
    width += (character.codePointAt(0) ?? 0) > 0x2e7f ? fontSize : fontSize * 0.6;
  }
  return width;
}

function labelMetrics(card: { width: number; height: number }) {
  const fontSize = labelFontSize([...label.value].length);
  const compressed = estimateTextWidth(label.value, fontSize) > card.width;
  const baseY = isWorld.value || hasImage.value ? card.height * 0.713 : card.height / 2;
  return {
    fontSize,
    compressed,
    textLength: compressed ? card.width : undefined,
    textAnchor: compressed ? 'start' as const : 'middle' as const,
    x: compressed ? 0 : card.width / 2,
    y: hasBuildings.value && baseY > card.height * 0.55
      ? Math.max(baseY - 1.15, card.height * 0.18)
      : baseY,
  };
}

interface CellGraphic {
  readonly name: 'desktop' | 'mobile';
  readonly card: { readonly width: number; readonly height: number };
  readonly globe: { readonly x: number; readonly y: number } | null;
  readonly label: ReturnType<typeof labelMetrics>;
}

const graphics = computed<CellGraphic[]>(() => {
  const style = props.presentation.style;
  const cards = [
    { name: 'desktop' as const, card: cardOf(style.width, style.height) },
    { name: 'mobile' as const, card: cardOf(style['--mobile-width'] ?? style.width, style['--mobile-height'] ?? style.height) },
  ];
  return cards.map(({ name, card }) => ({
    name,
    card,
    globe: isWorld.value ? { x: card.width / 2, y: card.height * 0.298 } : null,
    label: labelMetrics(card),
  }));
});

/** 画布单位 → 百分比（相对卡片）。 */
const pct = (value: number, total: number) => `${total > 0 ? (value / total) * 100 : 0}%`;

/** 画布单位 → 像素（相对棋盘边长）。 */
const units = (value: number) => `calc(var(--board-size, 375px) * ${(value / 100).toFixed(6)})`;

function labelStyle(graphic: CellGraphic) {
  const { card, label: metrics } = graphic;
  return {
    left: pct(metrics.x, card.width),
    top: pct(metrics.y, card.height),
    fontSize: units(metrics.fontSize),
    // 未压缩时以文字中心对齐格心；压缩时左对齐、由 max-width 兜住。
    transform: `translate(${metrics.textAnchor === 'middle' ? '-50%' : '0'}, -50%)`,
    maxWidth: `${card.width * 100}%`,
    letterSpacing: metrics.compressed ? '-0.04em' : 'normal',
  };
}

function globeStyle(graphic: CellGraphic) {
  const globe = graphic.globe;
  if (globe === null) return {};
  // 源站 viewBox 里圆半径 1.1 → 直径 2.2 画布单位。
  const diameter = units(2.2);
  return {
    left: pct(globe.x, graphic.card.width),
    top: pct(globe.y, graphic.card.height),
    width: diameter,
    height: diameter,
  };
}
</script>

<template>
  <button
    type="button"
    class="board-cell"
    :class="{ selected }"
    :style="presentation.style"
    :title="ownerSummary"
    :aria-label="`查看格子详情：${presentation.accessibilityLabel}${buildLabel ? `，${buildLabel}` : ''}`"
    :aria-pressed="selected ? 'true' : 'false'"
    @click="selectCell"
  >
    <view class="cell-card">
      <view
        v-if="isProperty && presentation.bandColor"
        class="cell-band"
        :style="bandStyle"
      />
      <view
        v-if="property?.ownerId && ownerColorKey"
        class="owner-strip"
        :class="[`owner-${ownerColorKey}`, { mortgaged: property.mortgaged }]"
      />
      <image
        v-if="presentation.assetUrl"
        class="cell-artwork"
        :src="presentation.assetUrl"
        mode="aspectFit"
        alt=""
        aria-hidden="true"
      />
      <view
        v-for="graphic in graphics"
        :key="graphic.name"
        class="cell-graphic"
        :class="`cell-graphic-${graphic.name}`"
        aria-hidden="true"
      >
        <view v-if="graphic.globe" class="cell-globe" :style="globeStyle(graphic)" />
        <text class="cell-label" :style="labelStyle(graphic)">{{ label }}</text>
      </view>
      <view
        v-if="hasBuildings"
        class="build-row"
        :class="[ownerColorKey ? `owner-${ownerColorKey}` : '', { 'build-hotel': isHotel, compact: compactBuild }]"
        :style="buildStyle"
        aria-hidden="true"
      >
        <view v-if="isHotel" class="build-icon build-icon--hotel" />
        <template v-else>
          <view
            v-for="index in houseCount"
            :key="index"
            class="build-icon build-icon--house"
          />
        </template>
      </view>
    </view>
  </button>
</template>

<style scoped>
.board-cell {
  position: absolute;
  min-width: 0;
  min-height: 0;
  appearance: none;
  border: none;
  padding: 0;
  background: transparent;
  font: inherit;
  color: inherit;
  cursor: pointer;
  border-radius: calc(var(--board-size, 375px) * 0.006);

  --cell-surface: var(--color-cell, var(--map-cell-color, #ffffff));
  --cell-ink: var(--color-text, #35413a);
  --cell-line: var(--color-border, var(--map-border-color, #b9c0b1));
}

.board-cell.current-stop {
  --cell-surface: var(--color-accent, #b98634);
  --cell-ink: #ffffff;
  --cell-line: var(--color-accent, #b98634);
}

.board-cell:active .cell-card {
  filter: brightness(0.95);
}

.board-cell.selected .cell-card {
  box-shadow: 0 0 0 2px var(--color-accent, #b98634);
}

.cell-card {
  position: absolute;
  inset: calc(var(--board-size, 375px) * 0.0018);
  box-shadow: inset 0 0 0 calc(var(--board-size, 375px) * 0.002) var(--cell-line);
  border-radius: calc(var(--board-size, 375px) * 0.005);
  background: var(--cell-surface);
  overflow: hidden;
}

.cell-band {
  position: absolute;
  top: calc(var(--board-size, 375px) * 0.002);
  left: calc(var(--board-size, 375px) * 0.0025);
  right: calc(var(--board-size, 375px) * 0.0025);
  height: calc(var(--board-size, 375px) * 0.0065);
  border-radius: calc(var(--board-size, 375px) * 0.001);
}

.owner-strip {
  position: absolute;
  left: calc(var(--board-size, 375px) * 0.005);
  right: calc(var(--board-size, 375px) * 0.005);
  bottom: calc(var(--board-size, 375px) * 0.0045);
  height: calc(var(--board-size, 375px) * 0.0055);
  border-radius: calc(var(--board-size, 375px) * 0.0015);
}

.owner-red { background: var(--player-red); }
.owner-blue { background: var(--player-blue); }
.owner-yellow { background: var(--player-yellow); }
.owner-green { background: var(--player-green); }
.owner-purple { background: var(--player-purple); }
.owner-orange { background: var(--player-orange); }

.owner-strip.mortgaged {
  background: repeating-linear-gradient(135deg, var(--owner-mortgaged) 0 2px, var(--cell-surface) 2px 3px);
}

.build-row {
  position: absolute;
  left: calc(var(--board-size, 375px) * 0.004);
  right: calc(var(--board-size, 375px) * 0.004);
  bottom: calc(var(--board-size, 375px) * 0.0105);
  display: flex;
  align-items: flex-end;
  gap: calc(var(--board-size, 375px) * 0.0012);
  pointer-events: none;
  --build-color: var(--color-muted);
  --build-fill: color-mix(in srgb, var(--build-color) var(--build-sat, 100%), #fff);
}

.build-icon {
  flex: none;
  height: auto;
  /* 单颗上限 1.7 画布单位；栋数多或格子窄时按可用宽度等分。 */
  width: min(
    calc(var(--board-size, 375px) * 0.017),
    calc((100% - var(--board-size, 375px) * 0.0012 * var(--build-count, 1)) / var(--build-count, 1))
  );
  aspect-ratio: 1;
  box-sizing: border-box;
  border: 1px solid rgb(26 30 20 / 70%);
}

/* 房屋剪影：硬山墙屋顶 + 方身。剪影用 clip-path，iOS/Android 内核均支持。 */
.build-icon--house {
  background: var(--build-fill);
  clip-path: polygon(50% 0%, 100% 34%, 100% 100%, 0% 100%, 0% 34%);
}

/* 旅馆：单颗更大，金色屋顶与最高级房屋（一排小屋）一眼可分。 */
.build-hotel .build-icon {
  width: min(calc(var(--board-size, 375px) * 0.023), 45%);
}

.build-icon--hotel {
  position: relative;
  background: var(--build-fill);
  border-radius: 1px;
}

.build-icon--hotel::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 36%;
  background: var(--color-accent, #d8a725);
}

.build-row.compact {
  flex-wrap: wrap;
  max-width: 62%;
}

.build-row.compact .build-icon {
  width: min(
    calc(var(--board-size, 375px) * 0.0135),
    calc((100% - var(--board-size, 375px) * 0.0024) / 2)
  );
}

.build-row.owner-red { --build-color: var(--player-red); }
.build-row.owner-blue { --build-color: var(--player-blue); }
.build-row.owner-yellow { --build-color: var(--player-yellow); }
.build-row.owner-green { --build-color: var(--player-green); }
.build-row.owner-purple { --build-color: var(--player-purple); }
.build-row.owner-orange { --build-color: var(--player-orange); }

.cell-graphic {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
}

.cell-graphic-mobile { display: none; }

@media (max-width: 1024px) {
  .cell-graphic-desktop { display: none; }
  .cell-graphic-mobile { display: block; }
}

/* 格名：小程序 <text> 是内联盒，必须显式定位与行高，否则基线会漂。 */
.cell-label {
  position: absolute;
  color: var(--cell-ink);
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
}

/* 地球：一个圆 + 赤道线。源站是 circle + ellipse + 横线，这里取最能表达「地球」的两笔。 */
.cell-globe {
  position: absolute;
  box-sizing: border-box;
  border: calc(var(--board-size, 375px) * 0.002) solid var(--cell-ink);
  border-radius: 50%;
  transform: translate(-50%, -50%);
}

.cell-globe::after {
  content: '';
  position: absolute;
  left: 6%;
  right: 6%;
  top: 50%;
  height: 0;
  border-top: calc(var(--board-size, 375px) * 0.002) solid var(--cell-ink);
}

.cell-artwork {
  position: absolute;
  left: 50%;
  top: 29.8%;
  width: 42%;
  max-height: 34%;
  transform: translate(-50%, -50%);
}
</style>
