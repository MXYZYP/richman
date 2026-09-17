import { describe, expect, it } from 'vitest';
import board from '../../maps/__test__/test-map-v1/board.json';
import cards from '../../maps/__test__/test-map-v1/cards.json';
import config from '../../maps/__test__/test-map-v1/game-config.json';
import manifest from '../../maps/__test__/test-map-v1/manifest.json';
import { chinaTourMap } from '../chinaTourMap';
import { computeContentHash } from '../hash';
import type { MapPack } from '../mapTypes';
import { assertValidMapPack } from '../mapValidation';
import { createMapRegistry, listActiveMaps } from '../registry';
import type { BoardData, CardsData, GameConfig } from '../types';

const fixtureManifest = manifest as unknown as Pick<MapPack, 'ref' | 'metadata' | 'presentation'> & {
  readonly requiredRuleModules: MapPack['game']['requiredRuleModules'];
};

const testMap = {
  ref: fixtureManifest.ref,
  metadata: fixtureManifest.metadata,
  game: {
    board: board as BoardData,
    cards: cards as CardsData,
    config: config as GameConfig,
    requiredRuleModules: fixtureManifest.requiredRuleModules,
  },
  presentation: fixtureManifest.presentation,
} satisfies MapPack;

describe('permanent test-only map fixture', () => {
  it('刻意不同于 China Tour：小规模、非连续 ID、非中国标签、无 branch、不同方形布局', () => {
    const cells = testMap.game.board.cells;

    expect(cells).toHaveLength(8);
    expect(cells).not.toHaveLength(chinaTourMap.game.board.cells.length);
    expect(cells.map((cell) => cell.id)).toEqual([0, 10, 20, 30, 40, 50, 60, 70]);
    expect(cells.filter((cell) => cell.type === 'start').map((cell) => cell.id)).toEqual([0]);
    expect(cells.every((cell) => cell.type !== 'airport' && !('branchEntryId' in cell))).toBe(true);
    expect(cells.map((cell) => cell.name).join(' ')).toMatch(/Launch|Cedar|Signal|Harbor/);
    expect(cells.map((cell) => cell.name).join(' ')).not.toMatch(/中国|省|机会|命运/);
    expect(testMap.game.requiredRuleModules).toEqual([{ id: 'core', version: 1 }]);

    expect(testMap.presentation.canvas).toEqual({ size: 80 });
    const placements = Object.values(testMap.presentation.cells);
    expect(new Set(placements.map((placement) => placement.x))).toEqual(new Set([0, 20, 40]));
    expect(new Set(placements.map((placement) => placement.y))).toEqual(new Set([0, 20, 40]));
    expect(testMap.presentation.theme.propertyBands).toEqual({ 'band:harbor': '#12a594' });
  });

  it('通过同一个 generic validator，manifest 保存 canonical exact hash', () => {
    expect(computeContentHash(testMap)).toBe(testMap.ref.contentHash);
    expect(() => assertValidMapPack(testMap, [{ id: 'core', version: 1 }], [])).not.toThrow();
  });

  it('可注册并 exact resolve，但不进入任何 player-facing active catalog', () => {
    const registry = createMapRegistry({
      activeMapRefs: [],
      knownRuleModules: [{ id: 'core', version: 1 }],
    });

    registry.registerMapPack(testMap);

    expect(registry.getMapPack(testMap.ref)).toEqual(testMap);
    expect(registry.listActiveMaps()).toEqual([]);
    expect(() => registry.getActiveMapPack(testMap.ref.id)).toThrow(/inactive map id/i);
    expect(listActiveMaps().map((entry) => entry.ref.id)).toEqual(['china-tour', 'world-tour']);
    expect(listActiveMaps().some((entry) => entry.ref.id === testMap.ref.id)).toBe(false);
  });
});
