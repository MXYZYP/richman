import type { MapPack } from '@richman/board-data';

/**
 * 地图缩略图模型：把 MapPack 的 presentation（棋格矩形 + 路线装饰）压成一组
 * 纯数字/颜色，供 `<MapThumbnail>` 直接塞进 SVG。
 *
 * 为什么不用 boardLayout 里的 getCellPresentationModel：那套输出的是 **DOM 用的百分比
 * 字符串样式**（left/top/width/height + --mobile-*），给 SVG 的 x/y/width/height 用不了。
 * 缩略图只关心「形状轮廓」，所以这里直接取原始画布坐标，不做 1:1 复刻。
 */
export interface ThumbnailCell {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** 地产色带色；非地产格回落到通用格底色。 */
  readonly fill: string;
}

export interface ThumbnailRoute {
  readonly shape: 'line' | 'polyline' | 'path';
  readonly points: string | null;
  readonly d: string | null;
  readonly x1: number | null;
  readonly y1: number | null;
  readonly x2: number | null;
  readonly y2: number | null;
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly dash: string | null;
  readonly opacity: number;
}

/**
 * 棋路拓扑：
 * - `nested` = 中央被棋格占据（回字/嵌套双环）
 * - `ring` = 中央留空的单环
 * - `grid` = 逐行铺开的蛇形网格（画布几乎被棋格填满）
 * - `spiral` = 由外向内盘绕收束的螺旋（一圈比一圈小，终点落在棋盘中心）
 */
export type MapLayoutKind = 'nested' | 'ring' | 'grid' | 'spiral';

const LAYOUT_LABELS: Readonly<Record<MapLayoutKind, string>> = {
  nested: '回字双环',
  ring: '环形棋路',
  grid: '蛇形网格',
  spiral: '螺旋盘绕',
};

export interface MapThumbnailModel {
  readonly canvasSize: number;
  readonly boardColor: string;
  readonly borderColor: string;
  readonly routeColor: string;
  readonly cells: readonly ThumbnailCell[];
  readonly routes: readonly ThumbnailRoute[];
  readonly layout: MapLayoutKind;
  /** 给玩家看的一句话几何描述，例如「回字双环 · 60 格」。 */
  readonly layoutLabel: string;
}

/** 判定「中央被棋格占据」的窗口：画布 30%~70% 的居中正方形（随地图缩放）。 */
const CORE_LOW_RATIO = 0.3;
const CORE_HIGH_RATIO = 0.7;
/**
 * 中央自成一圈的判定门槛。
 *
 * 实测十张图：china-tour / classic-tour / world-tour / xinjiang-tour 都是「外环 + 一条支路」，
 * 支路整体落进中央窗口的只有 3 / 3 / 4 / 5 格（其余格子只是擦到窗口边缘）；silk-road 的内环
 * 20 格全部落在里面（33.3%）。所以按「整格落在窗口内」的比例判定才对——只看"是否擦到"
 * 会把它们全判成嵌套。yellow-river 虽然是螺旋、末尾 4 格也落在窗口中央，但先撞上 spiral
 * 判定。pearl-tour 的三角环路中央恰好 4 整格（8.3%），只卡格数门槛会误判成嵌套，
 * 靠 20% 占比门槛把它拦在 nested 之外。
 */
const NESTED_MIN_CELLS = 4;
const NESTED_MIN_SHARE = 0.2;

/**
 * 蛇形网格的判定门槛：把棋格按 y 中心聚成「行」，长行（≥ GRID_MIN_ROW_CELLS 格）数量达到
 * GRID_MIN_LONG_ROWS 就认为棋盘是逐行铺开的网格。
 *
 * 实测十张图：china-tour / world-tour / classic-tour / xinjiang-tour 的长行都只有 2 条
 * （上下两条横边）；
 * silk-road 有 7 条长行，但它内环 20 格整格落在中央窗口，会先被判成 nested；
 * great-wall 的 8×6 横向蛇形是 6 条长行、中央只有 4 整格（8.3% < 20%）；
 * yangtze-tour 的 6×9 纵向蛇形每条横向层都排满 6 格，长行多达 9 条、中央只有 6 整格（11.1%）；
 * shanxi-tour 的 6×8 蛇形 8 条长行全部排满 6 格、中央只有 4 整格（8.3%）；
 * pearl-tour 的三角环路只有底边 1 条长行（两条斜边逐格换行，每行仅 2 格），中央 4 整格（8.3%）；
 * yellow-river 螺旋的长行也够 5 条，所以必须由更靠前的 spiral 判定截住。
 * 因此判定顺序必须是 **nested → spiral → grid → ring**，不能把 grid 提到 nested 前面，
 * 否则 silk-road 会被误判成网格。
 */
const GRID_MIN_ROW_CELLS = 4;
const GRID_MIN_LONG_ROWS = 5;
/** 同一行的 y 中心容差：取最小格高的一半，轻微错位并进同一行，又不至于跨行误并。 */
const ROW_CLUSTER_TOLERANCE_RATIO = 0.5;

/**
 * 螺旋棋路的判定：沿棋盘顺序（id 递增）算每格到画布中心的棋盘距离（切比雪夫半径），
 * 螺旋的签名是「半径全程不回头地单调收束」。
 *
 * 实测十张图（画布 100 归一化后的 shrink = 前 20% 半径均值 − 后 20% 半径均值）：
 * - china-tour / classic-tour shrink 18.63、world-tour 16.67、xinjiang-tour 18.60，
 *   单调率 0.933 / 0.933 / 0.949 / 0.933
 *   —— 外环半径恒定，最后才沿斜向支路收几步，所以既能掉进「单调」也绝不到收缩门槛；
 * - silk-road shrink 0（回字双环首尾都在最外圈）、great-wall shrink 0（蛇形上下对称）、
 *   yangtze-tour shrink 0（纵向蛇形首尾都贴画布上缘）、shanxi-tour shrink 0（横向蛇形同理），
 *   单调率 0.983 / 0.787 / 0.736 / 0.766；
 * - pearl-tour shrink 17.80、单调率 0.702 —— 三角环路的半径来回起伏，单调率远不到门槛；
 * - yellow-river shrink 27.69、单调率 1.000 —— 每绕一圈半径就稳稳缩一档。
 *
 * 两个门槛必须同时满足：只卡单调率会误收 silk-road（0.983），只卡收缩幅度对「先出门
 * 再绕回中心」的怪形状不稳。取 0.22 让环形（≤0.186）与螺旋（0.277）之间留出余量。
 * 判定必须排在 `nested` 之后、`grid` 之前：螺旋的长行数也够多，放在 grid 后面会被当成网格。
 */
const SPIRAL_SAMPLE_RATIO = 0.2;
const SPIRAL_RADIUS_BIN_RATIO = 0.05;
const SPIRAL_NON_INCREASING_TOLERANCE_RATIO = 0.5;
const SPIRAL_MIN_MONOTONE_RATIO = 0.98;
const SPIRAL_MIN_SHRINK_RATIO = 0.22;

/** 切比雪夫半径：格子中心到画布中心在 x / y 上偏离较大的那一维。 */
function radiusOf(
  cell: Pick<ThumbnailCell, 'x' | 'y' | 'width' | 'height'>,
  canvasSize: number,
): number {
  const center = canvasSize / 2;
  return Math.max(
    Math.abs(cell.x + cell.width / 2 - center),
    Math.abs(cell.y + cell.height / 2 - center),
  );
}

function describeSpiral(
  cells: readonly Pick<ThumbnailCell, 'x' | 'y' | 'width' | 'height'>[],
  canvasSize: number,
): boolean {
  const steps = cells.length - 1;
  if (steps < 1) return false;

  const tolerance = canvasSize * SPIRAL_RADIUS_BIN_RATIO * SPIRAL_NON_INCREASING_TOLERANCE_RATIO;
  const radii = cells.map((cell) => radiusOf(cell, canvasSize));

  let nonIncreasing = 0;
  for (let index = 1; index < radii.length; index += 1) {
    if (radii[index]! <= radii[index - 1]! + tolerance) nonIncreasing += 1;
  }
  if (nonIncreasing / steps < SPIRAL_MIN_MONOTONE_RATIO) return false;

  const sample = Math.max(1, Math.round(radii.length * SPIRAL_SAMPLE_RATIO));
  const mean = (values: readonly number[]) => (
    values.reduce((sum, value) => sum + value, 0) / values.length
  );
  const shrink = mean(radii.slice(0, sample)) - mean(radii.slice(-sample));
  return shrink >= canvasSize * SPIRAL_MIN_SHRINK_RATIO;
}

function countLongRows(
  cells: readonly Pick<ThumbnailCell, 'x' | 'y' | 'width' | 'height'>[],
): number {
  if (cells.length === 0) return 0;
  const minHeight = Math.min(...cells.map((cell) => cell.height));
  const tolerance = minHeight * ROW_CLUSTER_TOLERANCE_RATIO;
  const sorted = [...cells].sort((left, right) => (
    (left.y + left.height / 2) - (right.y + right.height / 2)
  ));

  const rowSizes: number[] = [];
  let anchor: number | null = null;
  let size = 0;
  for (const cell of sorted) {
    const center = cell.y + cell.height / 2;
    if (anchor === null || Math.abs(center - anchor) > tolerance) {
      if (anchor !== null) rowSizes.push(size);
      anchor = center;
      size = 1;
    } else {
      size += 1;
    }
  }
  rowSizes.push(size);
  return rowSizes.filter((rowSize) => rowSize >= GRID_MIN_ROW_CELLS).length;
}

export function describeMapLayout(
  cells: readonly Pick<ThumbnailCell, 'x' | 'y' | 'width' | 'height'>[],
  canvasSize: number,
): MapLayoutKind {
  const low = canvasSize * CORE_LOW_RATIO;
  const high = canvasSize * CORE_HIGH_RATIO;
  const insideCore = cells.filter((cell) => (
    cell.x >= low
    && cell.x + cell.width <= high
    && cell.y >= low
    && cell.y + cell.height <= high
  ));
  const nested = insideCore.length >= NESTED_MIN_CELLS
    && insideCore.length >= cells.length * NESTED_MIN_SHARE;
  if (nested) return 'nested';
  if (describeSpiral(cells, canvasSize)) return 'spiral';
  return countLongRows(cells) >= GRID_MIN_LONG_ROWS ? 'grid' : 'ring';
}

export function getMapThumbnailModel(pack: MapPack): MapThumbnailModel {
  const { presentation } = pack;
  const canvasSize = presentation.canvas.size;
  const { colors, propertyBands } = presentation.theme;

  const cells = pack.game.board.cells.map((cell) => {
    const placement = presentation.cells[cell.id];
    if (placement === undefined) {
      throw new Error(`Missing presentation for cell ${cell.id}`);
    }
    const band = placement.propertyBand;
    return {
      id: cell.id,
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
      fill: band === undefined ? colors.cell : (propertyBands[band] ?? colors.cell),
    } satisfies ThumbnailCell;
  });

  const routes = presentation.routes.map((route) => {
    const common = {
      stroke: colors[route.role],
      strokeWidth: route.strokeWidth,
      dash: route.dashPattern === undefined ? null : route.dashPattern.join(' '),
      opacity: route.opacity ?? 1,
    };
    if (route.type === 'line') {
      return {
        shape: 'line' as const,
        points: null,
        d: null,
        x1: route.from.x,
        y1: route.from.y,
        x2: route.to.x,
        y2: route.to.y,
        ...common,
      };
    }
    if (route.type === 'polyline') {
      return {
        shape: 'polyline' as const,
        points: route.points.map((point) => `${point.x},${point.y}`).join(' '),
        d: null,
        x1: null,
        y1: null,
        x2: null,
        y2: null,
        ...common,
      };
    }
    return {
      shape: 'path' as const,
      points: null,
      d: route.d,
      x1: null,
      y1: null,
      x2: null,
      y2: null,
      ...common,
    };
  });

  const layout = describeMapLayout(cells, canvasSize);
  return {
    canvasSize,
    boardColor: colors.board,
    borderColor: colors.border,
    routeColor: colors.route,
    cells,
    routes,
    layout,
    layoutLabel: `${LAYOUT_LABELS[layout]} · ${cells.length} 格`,
  };
}
