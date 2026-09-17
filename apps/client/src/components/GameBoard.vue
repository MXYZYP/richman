<script setup lang="ts">
import { computed } from 'vue';
import type { PlayerColor } from '@richman/engine';
import type { RenderableGameState } from '../session/gameSession';
import BoardCell from './BoardCell.vue';
import {
  getCellPresentationModel,
  getCenterDecorationModel,
  getMapThemeStyle,
  getRouteDecorationModels,
} from '../ui/boardLayout';
import type { ClientMapAssetResolver } from '../game/mapAssets';

const props = defineProps<{
  state: RenderableGameState;
  displayPositions?: Record<string, number>;
  selectedCellId?: number | null;
  assetResolver?: ClientMapAssetResolver;
}>();

const emit = defineEmits<{ selectCell: [cellId: number] }>();

const playerShape: Record<PlayerColor, string> = {
  red: '●',
  blue: '■',
  yellow: '▲',
  green: '★',
  purple: '◆',
  orange: '⬟',
};

const cellModels = computed(() => new Map(
  props.state.board.cells.map((cell) => [cell.id, getCellPresentationModel(props.state, cell.id, props.assetResolver)]),
));
const routeModels = computed(() => getRouteDecorationModels(props.state.presentation));
const centerModels = computed(() => props.state.presentation.center.map((decoration) => (
  getCenterDecorationModel(props.state, decoration, props.assetResolver)
)));
const boardStyle = computed(() => getMapThemeStyle(props.state.presentation));
const currentCellId = computed(() => {
  const actor = props.state.players.find((player) => player.id === props.state.currentPlayerId);
  return actor ? (props.displayPositions?.[actor.id] ?? actor.position) : null;
});

function cellModel(cellId: number) {
  const model = cellModels.value.get(cellId);
  if (model === undefined) throw new Error(`Missing presentation for cell ${cellId}`);
  return model;
}

function propertyFor(cellId: number) {
  return props.state.properties[cellId];
}

function ownerColorKey(cellId: number) {
  const ownerId = props.state.properties[cellId]?.ownerId;
  return props.state.players.find((player) => player.id === ownerId)?.color;
}

/** 归属玩家昵称：用于棋格的悬停/读屏提示，点开详情面板能看到完整信息。 */
function ownerName(cellId: number): string | null {
  const ownerId = props.state.properties[cellId]?.ownerId;
  return props.state.players.find((player) => player.id === ownerId)?.nickname ?? null;
}

function tokenOffset(cellId: number, index: number, stackCount: number) {
  const placement = props.state.presentation.cells[cellId];
  if (placement === undefined) return {};
  const canvasSize = props.state.presentation.canvas.size;
  const xDirection = placement.x + placement.width / 2 > canvasSize / 2 ? -1 : 1;
  const yDirection = placement.y + placement.height / 2 > canvasSize / 2 ? -1 : 1;
  // ≤4 枚维持两列 16px 阵型，行为不变。
  if (stackCount <= 4) {
    return {
      transform: `translate(${xDirection * (index % 2) * 16}px, ${yDirection * Math.floor(index / 2) * 16}px)`,
    };
  }
  // 5-6 枚：三列两行，步长按最窄格（含手机轨）换算成 cqw，避免 11px 在窄格溢出邻格。
  const box = placement.mobile ?? placement;
  const toCqw = (value: number) => (value / canvasSize) * 100;
  const columns = 3;
  const rows = 2;
  const tokenW = 3.2;
  const tokenH = 3.3;
  const inset = 0.35;
  const stepX = Math.max(0.7, Math.min(1.2, (toCqw(box.width) - tokenW - inset) / (columns - 1)));
  const stepY = Math.max(0.7, Math.min(1.2, (toCqw(box.height) - tokenH - inset) / (rows - 1)));
  return {
    transform: `translate(${xDirection * (index % columns) * stepX}cqw, ${yDirection * Math.floor(index / columns) * stepY}cqw)`,
  };
}

const playerTokens = computed(() => {
  const stackIndex = new Map<number, number>();
  const activePlayers = props.state.players.filter((player) => !player.bankrupt);
  // 先数同格棋子数：≤4 维持两列阵型，5-6 改用紧凑三列阵。
  const stackCounts = new Map<number, number>();
  for (const player of activePlayers) {
    const cellId = props.displayPositions?.[player.id] ?? player.position;
    stackCounts.set(cellId, (stackCounts.get(cellId) ?? 0) + 1);
  }
  return activePlayers.map((player) => {
    const cellId = props.displayPositions?.[player.id] ?? player.position;
    const index = stackIndex.get(cellId) ?? 0;
    stackIndex.set(cellId, index + 1);
    return {
      playerId: player.id,
      shape: playerShape[player.color],
      colorKey: player.color,
      placement: cellModel(cellId).style,
      offset: tokenOffset(cellId, index, stackCounts.get(cellId) ?? 1),
    };
  });
});
</script>

<template>
  <section class="board-wrap" aria-label="棋盘">
    <div class="board-frame" :style="boardStyle">
      <div class="board-canvas">
        <svg
          v-for="(route, index) in routeModels"
          :key="`route-${index}`"
          class="map-route"
          :viewBox="`0 0 ${state.presentation.canvas.size} ${state.presentation.canvas.size}`"
          aria-hidden="true"
          preserveAspectRatio="none"
        >
          <line
            v-if="route.type === 'line' && route.line"
            :x1="route.line.x1" :y1="route.line.y1" :x2="route.line.x2" :y2="route.line.y2"
            :style="[route.style, { stroke: 'var(--color-text)', strokeWidth: 0.45, strokeDasharray: '1.2 1', opacity: 0.55 }]"
          />
          <polyline
            v-else-if="route.type === 'polyline'"
            :points="route.points ?? undefined"
            :style="[route.style, { stroke: 'var(--color-text)', strokeWidth: 0.45, strokeDasharray: '1.2 1', opacity: 0.55 }]"
          />
          <path
            v-else-if="route.type === 'path'"
            :d="route.path ?? undefined"
            :style="[route.style, { stroke: 'var(--color-text)', strokeWidth: 0.45, strokeDasharray: '1.2 1', opacity: 0.55 }]"
          />
        </svg>

        <template v-for="(decoration, index) in centerModels" :key="`center-${index}`">
          <div
            v-if="decoration.type === 'panel'"
            class="center-decoration center-panel"
            :style="decoration.style"
            aria-hidden="true"
          />
          <div
            v-else-if="decoration.type === 'text'"
            class="center-decoration center-text"
            :style="decoration.style"
            aria-hidden="true"
          >{{ decoration.text }}</div>
          <img
            v-else-if="decoration.type === 'image' && decoration.assetUrl"
            class="center-decoration center-image"
            :style="decoration.style"
            :src="decoration.assetUrl"
            :alt="decoration.accessibilityLabel ?? ''"
          />
        </template>

        <BoardCell
          v-for="cell in state.board.cells"
          :key="cell.id"
          class="map-cell"
          :class="{ 'current-stop': currentCellId === cell.id && state.phase === 'playing' }"
          :aria-current="currentCellId === cell.id && state.phase === 'playing' ? 'location' : undefined"
          :style="cellModel(cell.id).style"
          :cell="cell"
          :presentation="cellModel(cell.id)"
          :property="propertyFor(cell.id)"
          :owner-color-key="ownerColorKey(cell.id)"
          :owner-name="ownerName(cell.id)"
          :max-house-level="state.config.maxHouseLevel"
          :selected="selectedCellId === cell.id"
          @select="emit('selectCell', cell.id)"
        />

        <div
          v-for="token in playerTokens"
          :key="`token-${token.playerId}`"
          class="token-layer"
          :style="token.placement"
        >
          <span class="token" :class="`token-${token.colorKey}`" :style="token.offset">{{ token.shape }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.board-wrap {
  /* --board-size 由 GameView 实测棋盘容器后写入（px）：取容器 min(宽,高)，
     所以任何宽高比下都是一个完整可见的正方形，不会再被裁掉一角。
     脚本还没跑完（首帧 / 老浏览器）时用视口高度兜底。 */
  width: var(--board-size, min(100%, 84vh));
  height: var(--board-size, auto);
  aspect-ratio: 1;
  max-width: 100%;
  margin: 0 auto;
}

/* 薄棋框：1px 描边 + 小圆角 + 极短内阴影（去掉了厚内衬与浮凸底边）。 */
.board-frame {
  position: relative;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  /* 边框调成偏棕的木框色，像实体棋盘的外框。 */
  border: 1px solid color-mix(in srgb, var(--color-primary, #88551f) 24%, var(--center-border, #b7c2aa));
  border-radius: 7px;
  /* 经典大富翁盘面：浅绿台面 + 中央受光 + 边缘微暗角 + 极淡斜纹纸感。
     整块只是背景层，不参与布局；棋格照旧压在上面。 */
  background:
    radial-gradient(115% 105% at 50% 34%, rgb(255 255 255 / 52%), transparent 62%),
    radial-gradient(122% 108% at 50% 48%, transparent 56%, rgb(64 88 48 / 15%)),
    repeating-linear-gradient(45deg, rgb(255 255 255 / 5%) 0 3px, rgb(74 96 58 / 3%) 3px 6px),
    linear-gradient(158deg, rgb(206 226 184 / 74%), rgb(176 205 152 / 60%)),
    var(--game-board-base, var(--board-surface));
  box-shadow:
    inset 0 0 0 1px rgb(255 255 255 / 34%),
    inset 0 2px 6px rgb(122 136 109 / 15%),
    0 2px 10px rgb(53 39 20 / 13%);
  overflow: hidden;
}

/* 画布即尺寸容器：格内几何用 cqw 表达画布单位，随棋盘等比。 */
.board-canvas {
  position: relative;
  width: 100%;
  height: 100%;
  isolation: isolate;
  /* inline-size（仅宽度包含）即足以支撑 cqw；size 会在与 aspect-ratio 尺寸链
     叠加时把画布高度算成 0（真实 Chromium/WebView 偶发），导致棋盘塌成一条竖线。 */
  container-type: inline-size;
}

.map-cell { z-index: 3; }

.map-route {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 2; /* 原型里航线压在中心面板上、又被棋格盖住 */
  pointer-events: none;
}

.center-decoration {
  position: absolute;
  pointer-events: none;
  box-sizing: border-box;
}

/* 中心纯色面：原型是一块浅色棋盘底，没有描边。
   加一点层次：淡内阴影收边 + 柔和外投影浮起，留白更通透但不抢棋格。 */
.center-panel {
  border-radius: 2.4cqw;
  /* 中心区做成实体棋盘中央的“画片区”：奶白纸面透出一点台面绿，中央高光收边。 */
  background-color: color-mix(in srgb, var(--color-cell, var(--map-cell-color)) 46%, transparent);
  background-image:
    radial-gradient(78% 66% at 50% 38%, rgb(255 255 255 / 58%), transparent 72%),
    linear-gradient(155deg, rgb(214 232 194 / 42%), rgb(255 255 255 / 18%));
  box-shadow:
    inset 0 0 1.4cqw rgb(122 136 109 / 16%),
    0 0.22cqw 0.5cqw rgb(53 39 20 / 9%);
}

/* 棋盘题字：黑绿书法体、轻微倾斜（角度来自地图数据），去掉签条与暖底卡。
   内边距把字心对到原型的落点（题字框左上角 26,25 → 文字 28,28.2）。 */
.center-text {
  display: grid;
  place-items: center;
  padding: 1.1cqw 2cqw 0;
  color: var(--color-text, #35413a);
  font-family: "Songti SC", "STSong", serif;
  font-size: 4.4cqw;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.center-image { object-fit: contain; }

/* 棋子层：每玩家一个稳定元素，left/top 过渡跟随逐格推进。
   过渡时长贴近 gamePresenter 的 token_moved 步进（260ms/格）并改用 linear：
   逐格连续推进时相邻两格的动画首尾相接，整段移动更平滑自然（原为 120ms + ease-out，观感过急）。 */
.token-layer {
  position: absolute;
  pointer-events: none;
  z-index: 8 !important;
  transition:
    left calc(220ms * var(--game-motion-pace, 1)) linear,
    top calc(220ms * var(--game-motion-pace, 1)) linear,
    transform calc(220ms * var(--game-motion-pace, 1)) linear;
}

@media (prefers-reduced-motion: reduce) {
  .token-layer { transition: none; }
}

/* 棋子按画布单位缩放：任何棋盘尺寸下都贴在格角，不压住垂直居中的格名。 */
.token {
  position: absolute;
  top: 0.3cqw;
  right: 0.3cqw;
  width: 3.2cqw;
  height: 3.3cqw;
  border: 0.4cqw solid var(--token-ring);
  border-radius: 50% 50% 22% 22%;
  display: grid;
  place-items: center;
  color: var(--token-ring);
  font-size: 1.6cqw;
  font-weight: 900;
  box-shadow: var(--token-shadow);
}

.token-red { background: var(--player-red); }
.token-blue { background: var(--player-blue); }
.token-yellow { background: var(--player-yellow); }
.token-green { background: var(--player-green); }
.token-purple { background: var(--player-purple); }
.token-orange { background: var(--player-orange); }

@media (max-width: 767px) {
  /* 棋盘尺寸一律交给 --board-size（脚本实测），这里只切换手机版的格子几何：
     手机上格名/字号改用大一号触屏版坐标（--mobile-*）。 */
  .map-cell,
  .token-layer,
  .center-decoration {
    left: var(--mobile-left) !important;
    top: var(--mobile-top) !important;
    width: var(--mobile-width) !important;
    height: var(--mobile-height) !important;
    max-width: var(--mobile-max-width) !important;
    max-height: var(--mobile-max-height) !important;
  }
}

/* 横屏不再需要特例：--board-size 取的是容器 min(宽,高)，竖屏/横屏通用。 */
</style>
