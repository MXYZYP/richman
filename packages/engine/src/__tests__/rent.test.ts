import { describe, it, expect } from 'vitest';
import { createGame } from '../engine';
import { getCurrentRent, getProjectedRentAfterRedemption } from '../selectors';
import { getActiveMapPack } from '@richman/board-data';
import type { GameState, PropertyState } from '../types';

const chinaMap = getActiveMapPack('china-tour');

function makeStarted(): GameState {
  return createGame({
    mapRef: chinaMap.ref,
    ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: chinaMap.game.config,
    players: [
      { id: 'p1', nickname: '甲' },
      { id: 'p2', nickname: '乙' },
    ],
    seed: 'rent-test',
  });
}

/** 在基础 state 上把指定 cellId 设为某玩家所有（可选 level/mortgaged） */
function withOwner(
  s: GameState,
  cellId: number,
  ownerId: string,
  opts: { level?: number; mortgaged?: boolean } = {},
): GameState {
  const cur: PropertyState = s.properties[cellId] ?? { ownerId: null, level: 0, mortgaged: false };
  return {
    ...s,
    properties: {
      ...s.properties,
      [cellId]: { ownerId, level: opts.level ?? 0, mortgaged: opts.mortgaged ?? false },
    },
  };
}

const cell = (id: number) => chinaMap.game.board.cells.find((c) => c.id === id)!;

describe('getCurrentRent / 01 §6.1 // 步4', () => {
  it('无主地产 → 0', () => {
    const s = makeStarted();
    expect(getCurrentRent(s, 2)).toBe(0);
  });

  it('自己地产仍按租金表计算（selector 是纯查询，"落自己地不付费"由调用方判断）', () => {
    const s = withOwner(makeStarted(), 2, 'p2', { level: 0 });
    expect(getCurrentRent(s, 2)).toBe((cell(2) as { readonly rents: readonly number[] }).rents[0]);
  });

  describe('normal 普通地皮', () => {
    it('空地（level=0）取 rents[0]', () => {
      const s = withOwner(makeStarted(), 2, 'p2', { level: 0 });
      // cell 2 福建省 rents[0] = 200
      expect(getCurrentRent(s, 2)).toBe((cell(2) as { readonly rents: readonly number[] }).rents[0]);
    });

    it('旅馆（level=5）取 rents[5]', () => {
      const s = withOwner(makeStarted(), 2, 'p2', { level: 5 });
      expect(getCurrentRent(s, 2)).toBe((cell(2) as { readonly rents: readonly number[] }).rents[5]);
    });

    it('E03 等级递增租金递增', () => {
      const base = makeStarted();
      const rents = (cell(2) as { readonly rents: readonly number[] }).rents;
      for (let lvl = 0; lvl <= 5; lvl++) {
        expect(getCurrentRent(withOwner(base, 2, 'p2', { level: lvl }), 2)).toBe(rents[lvl]);
      }
    });
  });

  describe('E06 抵押中不收费', () => {
    it('他人抵押中的地产 → 0', () => {
      const s = withOwner(makeStarted(), 2, 'p2', { level: 3, mortgaged: true });
      expect(getCurrentRent(s, 2)).toBe(0);
    });
  });

  describe('E09 车站按持有数取档（抵押中不计）', () => {
    it('持有 1 个车站 → rents[0] = 250', () => {
      let s = withOwner(makeStarted(), 6, 'p2'); // 广州站
      expect(getCurrentRent(s, 6)).toBe(250);
    });
    it('持有 2 个车站 → rents[1] = 500', () => {
      let s = withOwner(makeStarted(), 6, 'p2');
      s = withOwner(s, 19, 'p2'); // 上海站
      expect(getCurrentRent(s, 6)).toBe(500);
    });
    it('持有 4 个车站 → rents[3] = 2000', () => {
      let s = withOwner(makeStarted(), 6, 'p2');
      s = withOwner(s, 19, 'p2');
      s = withOwner(s, 33, 'p2'); // 南京站
      s = withOwner(s, 43, 'p2'); // 北京站
      expect(getCurrentRent(s, 6)).toBe(2000);
    });
    it('K8：3 个车站中 1 个抵押 → 按 2 个车站档（500）计', () => {
      let s = withOwner(makeStarted(), 6, 'p2');
      s = withOwner(s, 19, 'p2');
      s = withOwner(s, 33, 'p2', { mortgaged: true }); // 南京站抵押
      expect(getCurrentRent(s, 6)).toBe(500); // 按 2 个未抵押车站
    });
  });

  describe('E07 utility 特殊地皮（骰点 × 倍数）', () => {
    it('持有 1 处 utility → 骰点和 × 10', () => {
      let s = withOwner(makeStarted(), 10, 'p2'); // 中国大运河
      // 骰点 [3, 4] = 7 → 7 × 10 = 70
      expect(getCurrentRent(s, 10, [3, 4])).toBe(70);
    });
    it('持有 2 处 utility（全有）→ 骰点和 × 100', () => {
      let s = withOwner(makeStarted(), 10, 'p2');
      s = withOwner(s, 47, 'p2'); // 大唐托克托发电厂
      expect(getCurrentRent(s, 10, [3, 4])).toBe(700); // 7 × 100
    });
    it('K8：两处 utility 其一抵押 → 按 × 10 计', () => {
      let s = withOwner(makeStarted(), 10, 'p2');
      s = withOwner(s, 47, 'p2', { mortgaged: true }); // 抵押
      expect(getCurrentRent(s, 10, [3, 4])).toBe(70); // × 10
    });
    it('utility 用 state.lastDice（缺省 dice 参数）', () => {
      let s = withOwner(makeStarted(), 10, 'p2');
      s = { ...s, lastDice: [5, 5] }; // 10
      expect(getCurrentRent(s, 10)).toBe(100); // 10 × 10
    });
  });
});

describe('getProjectedRentAfterRedemption', () => {
  it('normal 按当前 level 取预计租金', () => {
    const s = withOwner(makeStarted(), 2, 'p1', { level: 3, mortgaged: true });

    expect(getProjectedRentAfterRedemption(s, 2)).toBe((cell(2) as { readonly rents: readonly number[] }).rents[3]);
  });

  it('station 按目标格解除抵押后的未抵押车站总数取档', () => {
    let s = withOwner(makeStarted(), 6, 'p1', { mortgaged: true });
    s = withOwner(s, 19, 'p1');

    expect(getProjectedRentAfterRedemption(s, 6)).toBe(500);
  });

  it('utility 固定按 7 点估算，且不读取 lastDice', () => {
    let oneUtility = withOwner(makeStarted(), 10, 'p1', { mortgaged: true });
    oneUtility = { ...oneUtility, lastDice: [6, 6] };
    expect(getProjectedRentAfterRedemption(oneUtility, 10)).toBe(7 * chinaMap.game.config.utilityMultipliers[0]);

    let twoUtilities = withOwner(oneUtility, 47, 'p1');
    twoUtilities = { ...twoUtilities, lastDice: [1, 1] };
    expect(getProjectedRentAfterRedemption(twoUtilities, 10)).toBe(7 * chinaMap.game.config.utilityMultipliers[1]);
  });
});
