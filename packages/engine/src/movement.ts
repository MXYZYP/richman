// 移动逻辑：沿 next 指针行走（01 §4.1 / §5.1）
// 棋盘是"每格指向下一格"的有向图（外环成环 + 支线为岔路），引擎按图行走，完全数据驱动（03 §4 模块化扩展点①）
import type { BoardData, DeepReadonly } from '@richman/board-data';

/** 沿行进方向获取某格的下一格 id */
export function getNextCellId(board: DeepReadonly<BoardData>, cellId: number): number {
  const cells = board.cells;
  const idx = cells.findIndex((c) => c.id === cellId);
  if (idx === -1) throw new Error(`getNextCellId: cell ${cellId} 不存在`);
  const cell = cells[idx];
  // 显式 nextId 优先（成环、支线出入口）；否则默认数组下一格
  if (cell.nextId !== undefined) return cell.nextId;
  if (idx + 1 < cells.length) return cells[idx + 1].id;
  throw new Error(`getNextCellId: cell ${cellId} 无 next（最后一格必须有显式 nextId）`);
}

/** 从 startPos 走 steps 步（正数=前进）
 *  返回逐格路径（供 token_moved 动画）、是否经过/停留起点（cell 0）、终点 id */
export function walkPath(board: DeepReadonly<BoardData>, startPos: number, steps: number): {
  path: number[];
  crossedStart: boolean;
  finalCellId: number;
} {
  const path: number[] = [];
  let cur = startPos;
  let crossedStart = false;
  for (let i = 0; i < steps; i++) {
    cur = getNextCellId(board, cur);
    path.push(cur);
    if (cur === 0) crossedStart = true; // 经过或停留起点都标记（E01：与经过同酬，不叠加）
  }
  return { path, crossedStart, finalCellId: cur };
}
