<script setup lang="ts">
import { computed } from 'vue';
import type { Cell as BoardCellData, DeepReadonly } from '@richman/board-data';
import type { PropertyState, PlayerColor } from '@richman/engine';
import type { CellPresentationModel } from '../ui/boardLayout';

// 棋盘单格：可渲染地产、事件格、机场、起点等任意格子。
// 版式对照已批准的浅色掌机真实地图 SVG：短标签横向一行居中；海外岔路格在名称上方
// 叠一枚本地线框地球；地产色带与归属条都是细条。几何一律用画布单位表达
// （棋盘 100×100，1 单位 = 1cqw，容器在 GameBoard 的画布上），随棋盘等比缩放。
// 每格有桌面/移动两套几何（--mobile-* 在窄屏生效），因此备两套同尺寸 viewBox 的
// graphic，由同一条 767px 断点的媒体查询切换，避免 SVG 被错误比例压缩。
const props = withDefaults(defineProps<{
  cell: DeepReadonly<BoardCellData>;
  presentation: CellPresentationModel;
  property?: PropertyState;
  ownerColorKey?: PlayerColor;
  selected?: boolean;
  /** 满级即旅馆：level === maxHouseLevel。由对局状态下发，默认 5（裸地/1-4 房/旅馆）。 */
  maxHouseLevel?: number;
  ownerName?: string | null;
}>(), { maxHouseLevel: 5, ownerName: null });

const emit = defineEmits<{
  select: [];
}>();

function selectCell() {
  emit('select');
}

/* ---- 地产建筑标识 ----
   level 0 裸地；1..maxHouseLevel-1 是各级房屋（画 level 栋小屋，越高级颜色越饱和）；
   level === maxHouseLevel 是旅馆（金色屋顶 + 旗子的高塔，与最高级房屋一眼可分）。
   车站/公用事业不允许建房，level 恒为 0，天然不会画。 */
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

/** 窄格（宽度不足 5.6 画布单位）改紧凑排布：房屋折成两行，保证每栋仍看得清。 */
const compactBuild = computed(() => (
  hasBuildings.value && !isHotel.value && canvasUnits(props.presentation.style.width) < 5.6
));

/** 建筑用归属玩家的主题色，等级越高越饱和（1 级最浅，满级房最实）。 */
const buildStyle = computed(() => ({
  '--build-count': String(Math.max(houseCount.value, 1)),
  '--build-sat': `${Math.min(62 + (buildLevel.value - 1) * 13, 100)}%`,
}));

/** 悬停 / 读屏：归属 + 房屋等级或旅馆 + 抵押状态一次说清。 */
const ownerSummary = computed(() => {
  const parts: string[] = [props.cell.name];
  if (props.ownerName !== null && props.ownerName !== undefined) parts.push(`归属 ${props.ownerName}`);
  if (buildLabel.value !== null) parts.push(buildLabel.value);
  else if (props.property?.ownerId) parts.push('裸地');
  if (props.property?.mortgaged) parts.push('已抵押');
  return parts.join(' · ');
});

/** 原型的棋格间隙：每格四周各收进 0.18 画布单位，相邻卡片之间留 0.36 单位。 */
const CARD_INSET = 0.18;
/** 展示模型只暴露字形；这个字形来自内置 world 图标，改画本地线框地球而不是 emoji。 */
const WORLD_GLYPH = '🌐';

const isProperty = computed(() => props.cell.type === 'property');
const isWorld = computed(() => props.presentation.iconGlyph === WORLD_GLYPH);
const label = computed(() => props.presentation.compactLabel);
const hasImage = computed(() => props.presentation.assetUrl !== null);
const bandStyle = computed(() => ({ background: props.presentation.bandColor ?? 'transparent' }));

/** 展示模型给的是画布百分比字符串；画布 100×100，数值本身即画布单位。 */
function canvasUnits(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 卡片比棋格四周各小 CARD_INSET；graphic 的 viewBox 与卡片同尺寸，坐标系即画布单位。 */
function cardOf(width: string | undefined, height: string | undefined) {
  return {
    width: Math.max(canvasUnits(width) - CARD_INSET * 2, 0.6),
    height: Math.max(canvasUnits(height) - CARD_INSET * 2, 0.6),
  };
}

/** 原型字号：1–2 字 2.5 单位，3 字 2.25；更长再降一档并交给 textLength 压进卡片。 */
function labelFontSize(length: number): number {
  if (length <= 2) return 2.5;
  if (length === 3) return 2.25;
  return 2;
}

/** 只用于判断是否需要压缩：CJK 按 1em，其余按 0.6em。 */
function estimateTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const character of text) {
    width += (character.codePointAt(0) ?? 0) > 0x2e7f ? fontSize : fontSize * 0.6;
  }
  return width;
}

/** 放不下时用 textLength + spacingAndGlyphs 压进卡片（不缩小到看不见、也不裁掉文字）。 */
function labelMetrics(card: { width: number; height: number }) {
  const fontSize = labelFontSize([...label.value].length);
  const compressed = estimateTextWidth(label.value, fontSize) > card.width;
  // 有地球/插画时上图标下名称（原型里地球在名称上方）；否则名称垂直居中。
  const baseY = isWorld.value || hasImage.value ? card.height * 0.713 : card.height / 2;
  return {
    fontSize,
    textLength: compressed ? card.width : undefined,
    textAnchor: compressed ? 'start' as const : 'middle' as const,
    x: compressed ? 0 : card.width / 2,
    // 底部要摆房屋/旅馆时，靠下的格名整体上移，避免和建筑标识叠在一起。
    y: hasBuildings.value && baseY > card.height * 0.55
      ? Math.max(baseY - 1.15, card.height * 0.18)
      : baseY,
  };
}

interface CellGraphic {
  readonly name: 'desktop' | 'mobile';
  readonly viewBox: string;
  readonly globe: { readonly x: number; readonly y: number } | null;
  readonly label: ReturnType<typeof labelMetrics>;
}

/** 桌面几何来自棋格本身，窄屏几何来自 --mobile-*；两者各自成为一套 graphic。 */
const graphics = computed<CellGraphic[]>(() => {
  const style = props.presentation.style;
  const cards = [
    { name: 'desktop' as const, card: cardOf(style.width, style.height) },
    { name: 'mobile' as const, card: cardOf(style['--mobile-width'] ?? style.width, style['--mobile-height'] ?? style.height) },
  ];
  return cards.map(({ name, card }) => ({
    name,
    viewBox: `0 0 ${card.width} ${card.height}`,
    globe: isWorld.value ? { x: card.width / 2, y: card.height * 0.298 } : null,
    label: labelMetrics(card),
  }));
});
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
    <span class="cell-card">
      <span
        v-if="isProperty && presentation.bandColor"
        class="cell-band"
        :style="bandStyle"
      />
      <span
        v-if="property?.ownerId && ownerColorKey"
        class="owner-strip"
        :class="[`owner-${ownerColorKey}`, { mortgaged: property.mortgaged }]"
      />
      <img
        v-if="presentation.assetUrl"
        class="cell-artwork"
        :src="presentation.assetUrl"
        alt=""
        aria-hidden="true"
      />
      <svg
        v-for="graphic in graphics"
        :key="graphic.name"
        class="cell-graphic"
        :class="`cell-graphic-${graphic.name}`"
        :viewBox="graphic.viewBox"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <g
          v-if="graphic.globe"
          class="cell-globe"
          fill="none"
          stroke-width=".2"
          :transform="`translate(${graphic.globe.x} ${graphic.globe.y})`"
        >
          <circle r="1.1" />
          <ellipse rx=".5" ry="1.1" />
          <path d="M-1.1 0h2.2" />
        </g>
        <text
          class="cell-label"
          :x="graphic.label.x"
          :y="graphic.label.y"
          :font-size="graphic.label.fontSize"
          :textLength="graphic.label.textLength"
          lengthAdjust="spacingAndGlyphs"
          :text-anchor="graphic.label.textAnchor"
          dominant-baseline="central"
        >{{ label }}</text>
      </svg>
      <!-- 建筑标识：房屋按等级画对应栋数（颜色随等级加深），旅馆画金色屋顶高塔 + 旗子。
           宽度按栋数自动收缩，窄格也不会挤出卡片。 -->
      <span
        v-if="hasBuildings"
        class="build-row"
        :class="[ownerColorKey ? `owner-${ownerColorKey}` : '', { 'build-hotel': isHotel, compact: compactBuild }]"
        :style="buildStyle"
        aria-hidden="true"
      >
        <template v-if="isHotel">
          <svg class="build-icon" viewBox="0 0 12 12" focusable="false">
            <path class="build-pole" d="M9.25 4.6V1.5" />
            <path class="build-flag" d="M9.25 1.6 11.8 2.45 9.25 3.3Z" />
            <path class="build-shape" d="M2.9 4.6 6 1.9 9.1 4.6V10.5H2.9Z" />
            <path class="build-roof" d="M2.9 4.6 6 1.9 9.1 4.6Z" />
          </svg>
        </template>
        <template v-else>
          <svg
            v-for="index in houseCount"
            :key="index"
            class="build-icon"
            viewBox="0 0 10 10"
            focusable="false"
          >
            <path class="build-shape" d="M1.5 4.7 5 1.5 8.5 4.7V8.8H1.5Z" />
          </svg>
        </template>
      </span>
    </span>
  </button>
</template>

<style scoped>
/* 单格根元素只负责占位与交互；可见卡片是内部的 .cell-card。 */
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
  border-radius: 0.6cqw;

  --cell-surface: var(--color-cell, var(--map-cell-color, #ffffff));
  --cell-ink: var(--color-text, #35413a);
  --cell-line: var(--color-border, var(--map-border-color, #b9c0b1));
}

/* 当前行动格：原型是实心琥珀卡片 + 白色格名，色带照旧。 */
.board-cell.current-stop {
  --cell-surface: var(--color-accent, #b98634);
  --cell-ink: #ffffff;
  --cell-line: var(--color-accent, #b98634);
}

.board-cell:focus-visible {
  outline: 2px solid var(--color-primary, #88551f);
  outline-offset: -1px;
}

.board-cell:active .cell-card {
  filter: brightness(0.95);
}

.board-cell.selected .cell-card {
  box-shadow: 0 0 0 2px var(--color-accent, #b98634);
}

.cell-card {
  position: absolute;
  inset: 0.18cqw;
  box-shadow: inset 0 0 0 0.2cqw var(--cell-line);
  border-radius: 0.5cqw;
  background: var(--cell-surface);
  overflow: hidden;
}

/* 地产色带：顶部细短条，左右各留 0.25 单位。 */
.cell-band {
  position: absolute;
  top: 0.2cqw;
  left: 0.25cqw;
  right: 0.25cqw;
  height: 0.65cqw;
  border-radius: 0.1cqw;
}

/* 归属条：贴卡片下沿的细条，颜色与 PlayerRail 玩家身份色同源（--player-*）。 */
.owner-strip {
  position: absolute;
  left: 0.5cqw;
  right: 0.5cqw;
  bottom: 0.45cqw;
  height: 0.55cqw;
  border-radius: 0.15cqw;
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

/* ---- 建筑标识 ----
   贴在卡片下沿、归属条之上。图标宽度按栋数自动收缩（min() 取“卡片可用宽 / 栋数”），
   所以 4 级房屋在窄格上也能整排放下，绝不溢出卡片。 */
.build-row {
  position: absolute;
  left: 0.4cqw;
  right: 0.4cqw;
  bottom: 1.05cqw;
  display: flex;
  align-items: flex-end;
  gap: 0.12cqw;
  pointer-events: none;
  --build-color: var(--color-muted);
  --build-fill: color-mix(in srgb, var(--build-color) var(--build-sat, 100%), #fff);
}

.build-icon {
  flex: none;
  height: auto;
  /* 单颗上限 1.7cqw；栋数多或格子窄时按可用宽度等分。 */
  width: min(1.7cqw, calc((100% - 0.12cqw * var(--build-count, 1)) / var(--build-count, 1)));
  aspect-ratio: 1;
  overflow: visible;
}

/* 旅馆：单颗更大，造型与最高级房屋（一排小屋）完全不同。 */
.build-hotel .build-icon {
  width: min(2.3cqw, 45%);
}

/* 窄格紧凑排布：折成两行，每栋反而比一排四栋更大更清楚。 */
.build-row.compact {
  flex-wrap: wrap;
  max-width: 62%;
}

.build-row.compact .build-icon {
  width: min(1.35cqw, calc((100% - 0.12cqw * 2) / 2));
}

.build-shape {
  fill: var(--build-fill);
  stroke: rgb(26 30 20 / 70%);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
  paint-order: fill stroke;
}

/* 旅馆的金色屋顶：与房屋的整体单色形成强对比。 */
.build-roof {
  fill: var(--color-accent, #d8a725);
  stroke: rgb(26 30 20 / 55%);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.build-pole {
  fill: none;
  stroke: rgb(26 30 20 / 70%);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.build-flag {
  fill: var(--color-accent, #d8a725);
}

/* 建筑取归属玩家的主题色，与归属条、棋子、玩家座同源。 */
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

/* 两套几何只在各自的断点里出现，viewBox 始终与卡片实际比例一致。 */
.cell-graphic-mobile { display: none; }

@media (max-width: 767px) {
  .cell-graphic-desktop { display: none; }
  .cell-graphic-mobile { display: block; }
}

.cell-label {
  fill: var(--cell-ink);
  font-weight: 600;
}

.cell-globe {
  stroke: var(--cell-ink);
}

.cell-artwork {
  position: absolute;
  left: 50%;
  top: 29.8%;
  width: 42%;
  max-height: 34%;
  transform: translate(-50%, -50%);
  object-fit: contain;
}
</style>
