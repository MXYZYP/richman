import { describe, expect, it } from 'vitest';
import { getActiveMapPack, listActiveMaps } from '@richman/board-data';
import { describeMapLayout, getMapThumbnailModel } from './mapThumbnail';

describe('map thumbnail model', () => {
  it('每个正式地图都能生成覆盖全部棋格的缩略图模型', () => {
    for (const entry of listActiveMaps()) {
      const pack = getActiveMapPack(entry.ref.id);
      const model = getMapThumbnailModel(pack);

      expect(model.canvasSize).toBe(pack.presentation.canvas.size);
      expect(model.cells).toHaveLength(pack.game.board.cells.length);
      expect(model.cells.map((cell) => cell.id)).toEqual(pack.game.board.cells.map((cell) => cell.id));
      expect(model.routes).toHaveLength(pack.presentation.routes.length);

      // 所有几何都得落在画布内，否则 SVG viewBox 会裁掉一部分，缩略图就"缺角"了。
      for (const cell of model.cells) {
        expect(cell.x).toBeGreaterThanOrEqual(0);
        expect(cell.y).toBeGreaterThanOrEqual(0);
        expect(cell.x + cell.width).toBeLessThanOrEqual(model.canvasSize);
        expect(cell.y + cell.height).toBeLessThanOrEqual(model.canvasSize);
        expect(cell.width).toBeGreaterThan(0);
        expect(cell.height).toBeGreaterThan(0);
      }
    }
  });

  it('地产格取色带色，非地产格回落到通用格底色', () => {
    const pack = getActiveMapPack('silk-road');
    const model = getMapThumbnailModel(pack);
    const bands = pack.presentation.theme.propertyBands;

    const bandedCell = pack.game.board.cells.find((cell) => {
      const band = pack.presentation.cells[cell.id]?.propertyBand;
      return band !== undefined;
    });
    const plainCell = pack.game.board.cells.find(
      (cell) => pack.presentation.cells[cell.id]?.propertyBand === undefined,
    );

    expect(bandedCell).toBeDefined();
    expect(plainCell).toBeDefined();
    const bandedId = bandedCell!.id;
    const plainId = plainCell!.id;
    expect(model.cells[bandedId]!.fill).toBe(
      bands[pack.presentation.cells[bandedId]!.propertyBand!],
    );
    expect(model.cells[plainId]!.fill).toBe(pack.presentation.theme.colors.cell);
  });

  it('几何拓扑按「中央是否被棋格占据 / 是否由外向内盘绕 / 是否逐行铺开」区分：丝路之旅回字双环、黄河之旅螺旋盘绕、长城之旅与长江之旅与山西之旅与东北之旅蛇形网格、新疆之旅与其余环形棋路', () => {
    const layouts = Object.fromEntries(
      listActiveMaps().map((entry) => {
        const model = getMapThumbnailModel(getActiveMapPack(entry.ref.id));
        return [entry.ref.id, model.layout];
      }),
    );

    expect(layouts).toEqual({
      'china-tour': 'ring',
      'world-tour': 'ring',
      'classic-tour': 'ring',
      'silk-road': 'nested',
      'great-wall': 'grid',
      'yellow-river': 'spiral',
      'yangtze-tour': 'grid',
      'pearl-tour': 'ring',
      'xinjiang-tour': 'ring',
      'shanxi-tour': 'grid',
      'northeast-tour': 'grid',
    });
  });

  it('每种拓扑都有自己的中文描述', () => {
    const labels = Object.fromEntries(
      listActiveMaps().map((entry) => {
        const pack = getActiveMapPack(entry.ref.id);
        const model = getMapThumbnailModel(pack);
        return [
          entry.ref.id,
          model.layoutLabel.replace(` · ${model.cells.length} 格`, ''),
        ];
      }),
    );

    expect(labels).toEqual({
      'china-tour': '环形棋路',
      'world-tour': '环形棋路',
      'classic-tour': '环形棋路',
      'silk-road': '回字双环',
      'great-wall': '蛇形网格',
      'yellow-river': '螺旋盘绕',
      'yangtze-tour': '蛇形网格',
      'pearl-tour': '环形棋路',
      'xinjiang-tour': '环形棋路',
      'shanxi-tour': '蛇形网格',
      'northeast-tour': '蛇形网格',
    });
  });

  it('describeMapLayout 按「整格落在中央窗口内」的比例判定，擦边不算', () => {
    const ringCell = (x: number, y: number) => ({ x, y, width: 9, height: 9 });
    const coreCell = (x: number, y: number) => ({ x, y, width: 7, height: 7 });

    // 全贴边、中央留空 -> 环形。
    expect(describeMapLayout(
      [ringCell(0, 0), ringCell(91, 0), ringCell(0, 91), ringCell(91, 91), ringCell(41, 0)],
      100,
    )).toBe('ring');
    // 中央窗口内有 4 整格、总数 20（恰好到 20% 门槛）-> 嵌套。
    expect(describeMapLayout(
      [...Array.from({ length: 16 }, (_, index) => ringCell(index < 8 ? 0 : 91, 0)),
        coreCell(31, 31), coreCell(45, 45), coreCell(59, 45), coreCell(45, 31)],
      100,
    )).toBe('nested');
    // 中央只有 3 整格 -> 不足门槛（对应 china-tour 那条斜向支路）-> 环形。
    expect(describeMapLayout(
      [ringCell(0, 0), ringCell(91, 0), coreCell(31, 31), coreCell(45, 45), coreCell(45, 31)],
      100,
    )).toBe('ring');
    // 只是擦到窗口边缘、没有整格在里面 -> 环形。
    expect(describeMapLayout([{ x: 20, y: 20, width: 10, height: 10 }], 100)).toBe('ring');
    // 6 行长行、中央只有 4 整格（不足 20%）-> 蛇形网格。
    // 几何与 maps/great-wall/v1 一致：120 画布、每行 8 格、格 13×18 留 2 单位缝。
    expect(describeMapLayout(
      Array.from({ length: 48 }, (_, id) => ({
        x: 1 + (id % 8) * 15,
        y: 1 + Math.floor(id / 8) * 20,
        width: 13,
        height: 18,
      })),
      120,
    )).toBe('grid');
    // 同样是网格，但只有 4 行长行（12×4）-> 仍按环形显示，门槛未达。
    expect(describeMapLayout(
      Array.from({ length: 48 }, (_, id) => ({
        x: 1 + (id % 12) * 10,
        y: 1 + Math.floor(id / 12) * 30,
        width: 8,
        height: 28,
      })),
      120,
    )).toBe('ring');

    // 8×8 螺旋（几何与 maps/yellow-river/v1 一致：100 画布、原点 3、步长 12、格 10×10）：
    // 半径每绕完一圈就整档缩小（单调率 1.000、收缩 27.69）-> 螺旋盘绕。
    const walkSpiral = (size: number): [number, number][] => {
      const result: [number, number][] = [];
      let top = 0;
      let bottom = size - 1;
      let left = 0;
      let right = size - 1;
      while (top <= bottom && left <= right) {
        for (let col = left; col <= right; col += 1) result.push([top, col]);
        top += 1;
        for (let row = top; row <= bottom; row += 1) result.push([row, right]);
        right -= 1;
        if (top <= bottom) {
          for (let col = right; col >= left; col -= 1) result.push([bottom, col]);
          bottom -= 1;
        }
        if (left <= right) {
          for (let row = bottom; row >= top; row -= 1) result.push([row, left]);
          left += 1;
        }
      }
      return result;
    };
    const spiral = walkSpiral(8).map(([row, col]) => ({
      x: 3 + col * 12,
      y: 3 + row * 12,
      width: 10,
      height: 10,
    }));
    expect(spiral).toHaveLength(64);
    expect(describeMapLayout(spiral, 100)).toBe('spiral');

    // 只取最外一圈（28 格、半径恒为 42）：单调率同样是 1.000，但首尾没有落差（收缩 0）。
    // 这条守住「单调 + 收缩两个门槛必须同时满足」，防止只卡单调率就把外环也认成螺旋。
    expect(describeMapLayout(spiral.slice(0, 28), 100)).toBe('ring');
  });

  it('路线按类型给出 SVG 可用属性', () => {
    const pack = getActiveMapPack('silk-road');
    const model = getMapThumbnailModel(pack);

    for (const route of model.routes) {
      expect(route.stroke).toBeTruthy();
      expect(route.strokeWidth).toBeGreaterThan(0);
      if (route.shape === 'polyline') {
        expect(route.points).toMatch(/^-?[\d.]+,-?[\d.]+( -?[\d.]+,-?[\d.]+)+$/);
      } else if (route.shape === 'line') {
        expect(route.x1).not.toBeNull();
        expect(route.y2).not.toBeNull();
      } else {
        expect(route.d).toBeTruthy();
      }
    }
  });
});
