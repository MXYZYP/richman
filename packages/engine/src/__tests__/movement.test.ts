import { describe, it, expect } from 'vitest';
import { walkPath, getNextCellId } from '../movement';
import { getActiveMapPack } from '@richman/board-data';

const chinaMap = getActiveMapPack('china-tour');

describe('movement / 01 §4.1 §5.1 // 步2', () => {
  describe('getNextCellId', () => {
    it('默认下一格（无 nextId）: 起点 0 → 1', () => {
      expect(getNextCellId(chinaMap.game.board, 0)).toBe(1);
    });
    it('显式 nextId: 外环末端 51 → 0（成环）', () => {
      expect(getNextCellId(chinaMap.game.board, 51)).toBe(0);
    });
    it('显式 nextId: 支线末端河内 60 → 黑龙江 40（汇回外环，K13 定案）', () => {
      expect(getNextCellId(chinaMap.game.board, 60)).toBe(40);
    });
    it('机场 13 的下一格是 14（不是支线入口；仅停留触发支线，01 §5.1）', () => {
      expect(getNextCellId(chinaMap.game.board, 13)).toBe(14);
    });
    it('机场支线入口由 branchEntryId 指定（13.branchEntryId → 52 首尔）', () => {
      const airport = chinaMap.game.board.cells.find((c) => c.id === 13)!;
      expect(airport.type).toBe('airport');
      expect((airport as { branchEntryId: number }).branchEntryId).toBe(52);
    });
  });

  describe('walkPath — E01 / E21', () => {
    it('E21 外环绕圈取模: 从 50 走 5 步 → 51→0→1→2→3', () => {
      const r = walkPath(chinaMap.game.board, 50, 5);
      expect(r.path).toEqual([51, 0, 1, 2, 3]);
      expect(r.crossedStart).toBe(true);
      expect(r.finalCellId).toBe(3);
    });

    it('E01 不经过起点: 从 5 走 3 步 → 6→7→8, crossedStart=false', () => {
      const r = walkPath(chinaMap.game.board, 5, 3);
      expect(r.path).toEqual([6, 7, 8]);
      expect(r.crossedStart).toBe(false);
    });

    it('E01 恰好停留起点: 从 51 走 1 步 → 0, crossedStart=true（与经过同酬不叠加）', () => {
      const r = walkPath(chinaMap.game.board, 51, 1);
      expect(r.path).toEqual([0]);
      expect(r.crossedStart).toBe(true);
      expect(r.finalCellId).toBe(0);
    });

    it('绕外环整一圈: 从 5 走 52 步回到 5, 途中经过起点一次', () => {
      const r = walkPath(chinaMap.game.board, 5, 52);
      expect(r.finalCellId).toBe(5);
      expect(r.crossedStart).toBe(true);
      expect(r.path).toHaveLength(52);
    });

    it('支线内移动: 从首尔 52 走 5 步 → 53→54→55→56→57, 不经过起点', () => {
      const r = walkPath(chinaMap.game.board, 52, 5);
      expect(r.path).toEqual([53, 54, 55, 56, 57]);
      expect(r.crossedStart).toBe(false);
    });

    it('E21 支线越过河内自然走上外环: 从河内 60 走 3 步 → 40→41→42', () => {
      const r = walkPath(chinaMap.game.board, 60, 3);
      expect(r.path).toEqual([40, 41, 42]);
      expect(r.crossedStart).toBe(false);
      expect(r.finalCellId).toBe(42);
    });

    it('支线汇回外环（单元测试）: 从命运格 58 走 3 步 → 59→60→40', () => {
      // 机场一掷最多到巴黎(57)，但效果移动(move_steps 卡牌)可能让玩家从 58 起走
      const r = walkPath(chinaMap.game.board, 58, 3);
      expect(r.path).toEqual([59, 60, 40]);
      expect(r.finalCellId).toBe(40);
      expect(r.crossedStart).toBe(false);
    });

    it('从机场停留格开始走: 13 走 2 步 → 14→15（沿外环，不进支线）', () => {
      const r = walkPath(chinaMap.game.board, 13, 2);
      expect(r.path).toEqual([14, 15]);
    });
  });
});
