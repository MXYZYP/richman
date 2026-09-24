import { describe, expect, it } from 'vitest';
import { listActiveMaps } from '@richman/board-data';
import {
  THEMES,
  THEME_BY_MAP,
  recommendedThemeForMap,
  resolveTheme,
  type ResolvedThemeId,
  type ThemeId,
} from './themeManager';

/**
 * 皮肤解析纯函数层（#118 地图主题皮肤）。
 *
 * 这里只测「解析」这一段，因为它是唯一能在 node 环境下跑到的东西（本仓 vitest 是 node 环境、
 * 没有 DOM，applyTheme 写 <html data-theme> 的那两行测不到、也不值得为它引 jsdom）。
 *
 * 两个必须守住的契约：
 *   1) 自动挡永远收敛到一套**真实存在**的配色 —— 任何 THEME_BY_MAP 的取值都必须在 THEMES 里有条目，
 *      否则设置面板会显示「当前实际配色：」后面空白，CSS 也找不到对应块。
 *   2) 深色模式优先于「跟随地图」—— 否则夜间开暗色、再选跟随地图，会被地图强制拉回亮色。
 */

const RESOLVED_THEME_IDS: readonly ResolvedThemeId[] = ['classic', 'ocean', 'midnight', 'forest', 'sand'];

describe('themeManager', () => {
  describe('THEMES 目录', () => {
    it('lists every id exactly once', () => {
      const ids = THEMES.map((option) => option.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('offers a label + hint for every resolved palette so the picker is never blank', () => {
      for (const resolved of RESOLVED_THEME_IDS) {
        const entry = THEMES.find((option) => option.id === resolved);
        expect(entry, `missing THEMES entry for resolved palette "${resolved}"`).toBeDefined();
        expect(entry?.label.length).toBeGreaterThan(0);
        expect(entry?.hint.length).toBeGreaterThan(0);
      }
    });

    it('keeps both automatic gears before the explicit palettes', () => {
      expect(THEMES.slice(0, 2).map((option) => option.id)).toEqual(['auto', 'map']);
    });
  });

  describe('recommendedThemeForMap', () => {
    it('falls back to classic for anything unknown instead of throwing', () => {
      expect(recommendedThemeForMap('does-not-exist')).toBe('classic');
      expect(recommendedThemeForMap('')).toBe('classic');
      expect(recommendedThemeForMap(null)).toBe('classic');
      expect(recommendedThemeForMap(undefined)).toBe('classic');
    });

    it('only ever returns a palette that THEMES actually offers', () => {
      for (const [mapId, themeId] of Object.entries(THEME_BY_MAP)) {
        expect(RESOLVED_THEME_IDS, `THEME_BY_MAP["${mapId}"] = "${themeId}"`).toContain(themeId);
      }
    });

    it('covers exactly the shipped maps — adding a map must extend THEME_BY_MAP', () => {
      // 硬编码清单：本仓风格是「新增地图必须同步改清单」，这里让遗漏在测试期就暴露，
      // 而不是等玩家选到新地图时莫名其妙回落到经典。
      const activeIds = listActiveMaps().map((entry) => entry.ref.id).sort();
      expect(Object.keys(THEME_BY_MAP).sort()).toEqual(activeIds);
    });

    it('actually differentiates maps — not everything collapses to one palette', () => {
      const used = new Set(Object.values(THEME_BY_MAP));
      expect(used.size).toBeGreaterThanOrEqual(3);
    });
  });

  describe('resolveTheme', () => {
    it('resolves the dark-following gear from the appearance axis', () => {
      expect(resolveTheme('auto', 'light')).toBe('classic');
      expect(resolveTheme('auto', 'dark')).toBe('midnight');
    });

    it('resolves the map-following gear from the map id', () => {
      expect(resolveTheme('map', 'light', 'silk-road')).toBe('sand');
      expect(resolveTheme('map', 'light', 'great-wall')).toBe('forest');
      expect(resolveTheme('map', 'light', 'yangtze-tour')).toBe('ocean');
      expect(resolveTheme('map', 'light', 'china-tour')).toBe('classic');
    });

    it('lets dark mode win over the map recommendation', () => {
      // 夜间开暗色再选跟随地图，不该被地图拉回亮色。
      for (const mapId of Object.keys(THEME_BY_MAP)) {
        expect(resolveTheme('map', 'dark', mapId)).toBe('midnight');
      }
    });

    it('needs no map id for the map gear — outside a game it degrades to classic', () => {
      expect(resolveTheme('map', 'light')).toBe('classic');
      expect(resolveTheme('map', 'light', null)).toBe('classic');
    });

    it('passes explicit palettes straight through, ignoring appearance and map', () => {
      for (const explicit of RESOLVED_THEME_IDS) {
        expect(resolveTheme(explicit, 'dark', 'silk-road')).toBe(explicit);
        expect(resolveTheme(explicit, 'light', null)).toBe(explicit);
      }
    });

    it('returns a palette the picker can name for every reachable input', () => {
      const gears: ThemeId[] = ['auto', 'map'];
      for (const gear of gears) {
        for (const appearance of ['light', 'dark'] as const) {
          for (const mapId of [null, ...Object.keys(THEME_BY_MAP), 'unknown-map']) {
            const resolved = resolveTheme(gear, appearance, mapId);
            expect(RESOLVED_THEME_IDS).toContain(resolved);
          }
        }
      }
    });
  });
});
