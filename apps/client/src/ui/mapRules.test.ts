import { describe, expect, it } from 'vitest';
import { getActiveMapPack, type MapPack } from '@richman/board-data';
import { describeMapRules, describeMapRulesById } from './mapRules';

/** 可写的地图包形状：只描述本测试要动的那几个字段，其余原样透传。 */
interface MutablePack {
  ref: { id: string };
  metadata: { title: string; description: string };
  game: {
    board: { boardName: string; cells: unknown[] };
    cards: unknown;
    config: Record<string, unknown>;
    requiredRuleModules: { id: string; version: number }[];
  };
  presentation: unknown;
}

/**
 * 深拷贝一张正式地图并允许就地改数据。
 * 用途：构造「不存在的形状」（没有水电格、没有预设胜利目标）来验证事实清单是**按数据生成**的，
 * 而不是把某张图的数字写死在模块里。
 */
function mutablePack(mapId: string): MutablePack {
  return structuredClone(getActiveMapPack(mapId)) as unknown as MutablePack;
}

function factsOf(pack: MutablePack): Record<string, string> {
  return Object.fromEntries(
    describeMapRules(pack as unknown as MapPack).facts.map((fact) => [fact.label, fact.value]),
  );
}

describe('describeMapRules：按地图数据生成规则事实', () => {
  it('珠江之旅的全部事实与棋盘数据一致，且不含任何写死值', () => {
    const summary = describeMapRulesById('pearl-tour');
    expect(summary).not.toBeNull();
    expect(summary!.mapId).toBe('pearl-tour');
    expect(summary!.title).toBe('珠江之旅');
    expect(summary!.cellCount).toBe(48);

    expect(summary!.facts).toEqual([
      { label: '地图', value: '珠江之旅 · 48 格' },
      { label: '规则模块', value: '仅核心规则' },
      { label: '初始资金', value: '¥15,000' },
      { label: '过起点收入', value: '¥2,000' },
      { label: '房屋上限', value: '每块地产最多 5 级' },
      { label: '抵押利息', value: '每回合 10%' },
      { label: '地产地价', value: '13 档（¥1,600 ~ ¥4,500）' },
      { label: '车站 / 渡口', value: '4 处（租金随持有数递增）' },
      { label: '水电 / 水利', value: '2 处（租金 = 点数 × 10 / × 100）' },
      { label: '机会 / 命运', value: '3 / 4 格' },
      { label: '税费格', value: '2 处' },
      { label: '可选胜利目标', value: '¥30,000 或 ¥50,000' },
    ]);
  });

  it('纯核心规则的地图不产出任何模块提示（不是漏写，是这张图确实没有特化规则）', () => {
    expect(describeMapRulesById('pearl-tour')!.moduleNotes).toEqual([]);
    expect(describeMapRulesById('china-tour')!.moduleNotes).toEqual([]);
  });

  it('长城之旅会带上烽火台数量与规则模块提示', () => {
    const summary = describeMapRulesById('great-wall')!;
    const facts = factsOf(mutablePack('great-wall'));

    expect(facts['规则模块']).toBe('烽火台');
    expect(facts['烽火台']).toBe('6 座（可占据并向过客收通行费）');
    // 烽火台插在「水电 / 水利」与「机会 / 命运」之间，顺序必须稳定。
    const labels = summary.facts.map((fact) => fact.label);
    expect(labels.indexOf('烽火台')).toBe(labels.indexOf('水电 / 水利') + 1);
    expect(labels.indexOf('机会 / 命运')).toBe(labels.indexOf('烽火台') + 1);

    expect(summary.moduleNotes).toHaveLength(1);
    expect(summary.moduleNotes[0]).toContain('烽火台');
    expect(summary.moduleNotes[0]).toContain('通行费');
  });

  it('世界之旅的规则模块是「世界巡游」，提示说明机场支线', () => {
    const summary = describeMapRulesById('world-tour')!;
    expect(factsOf(mutablePack('world-tour'))['规则模块']).toBe('世界巡游');
    expect(summary.moduleNotes).toHaveLength(1);
    expect(summary.moduleNotes[0]).toContain('世界巡游');
  });

  it('只出现地图上真实存在的行：没有水电 / 没有税费 / 没有预设目标就整行不出现', () => {
    const pack = mutablePack('pearl-tour');
    pack.game.board.cells = pack.game.board.cells.filter((cell) => {
      const typed = cell as { type?: string; subtype?: string };
      return !(typed.type === 'property' && typed.subtype === 'utility');
    });
    pack.game.config.cashGoalPresets = [];
    const facts = factsOf(pack);

    expect(facts['水电 / 水利']).toBeUndefined();
    expect(facts['可选胜利目标']).toBeUndefined();
    // 同一次改动不该误伤别的行。
    expect(facts['车站 / 渡口']).toBe('4 处（租金随持有数递增）');
    expect(facts['税费格']).toBe('2 处');
  });

  it('车站与水电都清空后，这两行同时消失', () => {
    const pack = mutablePack('silk-road');
    pack.game.board.cells = pack.game.board.cells.filter((cell) => {
      const typed = cell as { type?: string };
      return typed.type !== 'property';
    });
    const facts = factsOf(pack);

    expect(facts['车站 / 渡口']).toBeUndefined();
    expect(facts['水电 / 水利']).toBeUndefined();
    expect(facts['地产地价']).toBeUndefined();
  });

  it('地价只有一档时用「均」表述，不再显示区间', () => {
    const pack = mutablePack('pearl-tour');
    pack.game.board.cells = pack.game.board.cells.map((cell) => {
      const typed = cell as { type?: string; subtype?: string };
      if (typed.type === 'property' && typed.subtype === 'normal') {
        return { ...(cell as object), price: 2000 };
      }
      return cell;
    });
    expect(factsOf(pack)['地产地价']).toBe('1 档（均 ¥2,000）');
  });

  it('未登记的规则模块回落到 id 本身，不显示空白', () => {
    const pack = mutablePack('pearl-tour');
    pack.game.requiredRuleModules = [{ id: 'core', version: 1 }, { id: 'future-module', version: 2 }];
    const summary = describeMapRules(pack as unknown as MapPack);
    expect(summary.facts.find((fact) => fact.label === '规则模块')?.value).toBe('future-module');
    expect(summary.moduleNotes).toEqual([]);
  });

  it('是纯函数：不改动传入的地图包', () => {
    const pack = mutablePack('pearl-tour');
    const before = JSON.stringify(pack);
    describeMapRules(pack as unknown as MapPack);
    expect(JSON.stringify(pack)).toBe(before);
  });
});

describe('describeMapRulesById：按 id 解析并兜住未知名', () => {
  it('十张正式地图都能解析出摘要', () => {
    for (const mapId of [
      'china-tour', 'world-tour', 'classic-tour', 'silk-road',
      'great-wall', 'yellow-river', 'yangtze-tour', 'pearl-tour',
      'xinjiang-tour', 'shanxi-tour',
    ]) {
      const summary = describeMapRulesById(mapId);
      expect(summary, `${mapId} 应能解析`).not.toBeNull();
      expect(summary!.mapId).toBe(mapId);
      expect(summary!.facts.length).toBeGreaterThan(5);
    }
  });

  it('空值与未知 id 一律返回 null，交给调用方回落到通用要点', () => {
    expect(describeMapRulesById(null)).toBeNull();
    expect(describeMapRulesById(undefined)).toBeNull();
    expect(describeMapRulesById('')).toBeNull();
    expect(describeMapRulesById('not-a-map')).toBeNull();
  });
});
