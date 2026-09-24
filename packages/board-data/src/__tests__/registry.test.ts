import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { chinaTourMap } from '../chinaTourMap';
import { classicTourMap } from '../classicTourMap';
import { greatWallMap } from '../greatWallMap';
import { computeContentHash } from '../hash';
import type { MapPack, MapRef } from '../mapTypes';
import { pearlTourMap } from '../pearlTourMap';
import { shanxiTourMap } from '../shanxiTourMap';
import { silkRoadMap } from '../silkRoadMap';
import { worldTourMap } from '../worldTourMap';
import { xinjiangTourMap } from '../xinjiangTourMap';
import { yangtzeTourMap } from '../yangtzeTourMap';
import { yellowRiverMap } from '../yellowRiverMap';
import {
  createMapRegistry,
  getActiveMapPack,
  getMapPack,
  listActiveMaps,
} from '../registry';

const CORE_MODULES = [{ id: 'core', version: 1 }] as const;

function makePack(id: string, version: number, title = `${id} v${version}`): MapPack {
  const pack: any = structuredClone(chinaTourMap);
  pack.ref = { id, version, contentHash: '0'.repeat(64) };
  pack.metadata.title = title;
  pack.ref.contentHash = computeContentHash(pack as MapPack);
  return pack as MapPack;
}

function createRegistry(activeMapRefs: readonly MapRef[], assets: readonly {
  readonly ref: MapRef;
  readonly paths: readonly string[];
}[] = []) {
  return createMapRegistry({
    activeMapRefs,
    knownRuleModules: CORE_MODULES,
    assetAllowlist: assets,
  });
}

describe('production map registry', () => {
  it('按批准顺序公开并精确解析十张正式地图', async () => {
    expect(listActiveMaps()).toEqual([
      {
        ref: chinaTourMap.ref,
        title: chinaTourMap.metadata.title,
        description: chinaTourMap.metadata.description,
      },
      {
        ref: worldTourMap.ref,
        title: worldTourMap.metadata.title,
        description: worldTourMap.metadata.description,
      },
      {
        ref: classicTourMap.ref,
        title: classicTourMap.metadata.title,
        description: classicTourMap.metadata.description,
      },
      {
        ref: silkRoadMap.ref,
        title: silkRoadMap.metadata.title,
        description: silkRoadMap.metadata.description,
      },
      {
        ref: greatWallMap.ref,
        title: greatWallMap.metadata.title,
        description: greatWallMap.metadata.description,
      },
      {
        ref: yellowRiverMap.ref,
        title: yellowRiverMap.metadata.title,
        description: yellowRiverMap.metadata.description,
      },
      {
        ref: yangtzeTourMap.ref,
        title: yangtzeTourMap.metadata.title,
        description: yangtzeTourMap.metadata.description,
      },
      {
        ref: pearlTourMap.ref,
        title: pearlTourMap.metadata.title,
        description: pearlTourMap.metadata.description,
      },
      {
        ref: xinjiangTourMap.ref,
        title: xinjiangTourMap.metadata.title,
        description: xinjiangTourMap.metadata.description,
      },
      {
        ref: shanxiTourMap.ref,
        title: shanxiTourMap.metadata.title,
        description: shanxiTourMap.metadata.description,
      },
    ]);
    expect(getActiveMapPack('china-tour')).toBe(getMapPack(chinaTourMap.ref));
    expect(getMapPack(chinaTourMap.ref)).toEqual(chinaTourMap);
    expect(getActiveMapPack('world-tour')).toBe(getMapPack(worldTourMap.ref));
    expect(getMapPack(worldTourMap.ref)).toEqual(worldTourMap);
    expect(getActiveMapPack('classic-tour')).toBe(getMapPack(classicTourMap.ref));
    expect(getMapPack(classicTourMap.ref)).toEqual(classicTourMap);
    expect(getActiveMapPack('silk-road')).toBe(getMapPack(silkRoadMap.ref));
    expect(getMapPack(silkRoadMap.ref)).toEqual(silkRoadMap);
    expect(getActiveMapPack('great-wall')).toBe(getMapPack(greatWallMap.ref));
    expect(getMapPack(greatWallMap.ref)).toEqual(greatWallMap);
    expect(getActiveMapPack('yellow-river')).toBe(getMapPack(yellowRiverMap.ref));
    expect(getMapPack(yellowRiverMap.ref)).toEqual(yellowRiverMap);
    expect(getActiveMapPack('yangtze-tour')).toBe(getMapPack(yangtzeTourMap.ref));
    expect(getMapPack(yangtzeTourMap.ref)).toEqual(yangtzeTourMap);
    expect(getActiveMapPack('pearl-tour')).toBe(getMapPack(pearlTourMap.ref));
    expect(getMapPack(pearlTourMap.ref)).toEqual(pearlTourMap);
    expect(getActiveMapPack('xinjiang-tour')).toBe(getMapPack(xinjiangTourMap.ref));
    expect(getMapPack(xinjiangTourMap.ref)).toEqual(xinjiangTourMap);
    expect(getActiveMapPack('shanxi-tour')).toBe(getMapPack(shanxiTourMap.ref));
    expect(getMapPack(shanxiTourMap.ref)).toEqual(shanxiTourMap);
    expect(() => getMapPack({ ...worldTourMap.ref, contentHash: 'f'.repeat(64) }))
      .toThrow(/hash mismatch.*world-tour@1/i);

    const publicApi = await import('../index');
    expect(publicApi.listActiveMaps).toBe(listActiveMaps);
    expect(publicApi.getActiveMapPack).toBe(getActiveMapPack);
    expect(publicApi.getMapPack).toBe(getMapPack);
    expect(publicApi).not.toHaveProperty('createMapRegistry');
    expect(publicApi).not.toHaveProperty('registerMapPack');

    const registryModule = await import('../registry');
    expect(registryModule).not.toHaveProperty('registerMapPack');
  });

  it('package exports 只开放根入口，阻止消费者绕过 public API 导入 registry subpath', () => {
    const require = createRequire(import.meta.url);
    // Windows 上 require.resolve 返回反斜杠路径；统一成 POSIX 分隔符再断言，避免平台相关假失败。
    expect(require.resolve('@richman/board-data').replace(/\\/g, '/'))
      .toMatch(/packages\/board-data\/src\/index\.ts$/);

    let error: unknown;
    try {
      require.resolve('@richman/board-data/src/registry');
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  });

  it('catalog 是冻结的最小 allowlist，不暴露完整地图内容', () => {
    const catalog = listActiveMaps();

    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog[0])).toBe(true);
    expect(Object.isFrozen(catalog[1])).toBe(true);
    expect(Object.isFrozen(catalog[2])).toBe(true);
    expect(Object.isFrozen(catalog[0]!.ref)).toBe(true);
    expect(Object.keys(catalog[0]!).sort()).toEqual(['description', 'ref', 'title']);
    expect(catalog[0]).not.toHaveProperty('game');
    expect(catalog[0]).not.toHaveProperty('presentation');
  });
});

describe('createMapRegistry', () => {
  it('同一 id 可注册多个版本，但 active 由显式 exact ref 固定而非最高版本', () => {
    const v1 = makePack('versioned-map', 1);
    const v2 = makePack('versioned-map', 2);
    const registry = createRegistry([v1.ref]);

    registry.registerMapPack(v2);
    registry.registerMapPack(v1);

    expect(registry.getActiveMapPack('versioned-map').ref).toEqual(v1.ref);
    expect(registry.getMapPack(v2.ref).ref).toEqual(v2.ref);
    expect(registry.listActiveMaps().map((entry) => entry.ref)).toEqual([v1.ref]);
  });

  it('按 active 配置顺序稳定列出地图，且不列出只供 exact restore 的地图', () => {
    const first = makePack('first-map', 1);
    const second = makePack('second-map', 1);
    const internal = makePack('internal-map', 1);
    const registry = createRegistry([second.ref, first.ref]);

    registry.registerMapPack(first);
    registry.registerMapPack(internal);
    registry.registerMapPack(second);

    expect(registry.listActiveMaps().map((entry) => entry.ref.id)).toEqual([
      'second-map',
      'first-map',
    ]);
    expect(registry.getMapPack(internal.ref)).toEqual(internal);
  });

  it('exact lookup 对 stale hash、未知版本和未知 id 分别失败且不 fallback', () => {
    const pack = makePack('exact-map', 1);
    const registry = createRegistry([pack.ref]);
    registry.registerMapPack(pack);

    expect(() => registry.getMapPack({ ...pack.ref, contentHash: 'f'.repeat(64) }))
      .toThrow(/hash mismatch.*exact-map@1/i);
    expect(() => registry.getMapPack({ ...pack.ref, version: 2 }))
      .toThrow(/unknown map version.*exact-map@2/i);
    expect(() => registry.getMapPack({ ...pack.ref, id: 'missing-map' }))
      .toThrow(/unknown map id.*missing-map/i);
  });

  it('拒绝同 id + version 的重复注册，即使第二份 hash 不同', () => {
    const first = makePack('duplicate-map', 1, 'First content');
    const second = makePack('duplicate-map', 1, 'Different content');
    const registry = createRegistry([]);
    registry.registerMapPack(first);

    expect(() => registry.registerMapPack(second)).toThrow(/duplicate map version.*duplicate-map@1/i);
  });

  it('注册时通过 generic validator 拒绝 invalid pack 和 stale hash', () => {
    const invalid: any = makePack('invalid-map', 1);
    invalid.metadata.title = '   ';
    invalid.ref.contentHash = computeContentHash(invalid as MapPack);
    const stale: any = makePack('stale-map', 1);
    stale.metadata.description = 'changed without rehashing';
    const registry = createRegistry([]);

    expect(() => registry.registerMapPack(invalid)).toThrow(/metadata\.title.*non-empty/i);
    expect(() => registry.registerMapPack(stale)).toThrow(/contentHash.*canonical/i);
  });

  it('拒绝重复 active id，并在 active exact ref 未注册时显式报告配置错误', () => {
    const v1 = makePack('configured-map', 1);
    const v2 = makePack('configured-map', 2);

    expect(() => createRegistry([v1.ref, v2.ref])).toThrow(/duplicate active map id.*configured-map/i);

    const registry = createRegistry([v1.ref]);
    expect(() => registry.listActiveMaps()).toThrow(/active map.*configured-map@1.*not registered/i);
    expect(() => registry.getActiveMapPack('configured-map'))
      .toThrow(/active map.*configured-map@1.*not registered/i);
    expect(() => registry.getActiveMapPack('unknown-map')).toThrow(/inactive map id.*unknown-map/i);
  });

  it('注册时复制并深度冻结 pack，调用方后续 mutation 不污染 runtime', () => {
    const source: any = makePack('mutable-map', 1);
    const originalTitle = source.metadata.title;
    const registry = createRegistry([source.ref]);
    registry.registerMapPack(source);

    const registered = registry.getMapPack(source.ref);
    source.metadata.title = 'mutated outside registry';
    source.game.board.cells[0].name = 'mutated start';

    expect(registered.metadata.title).toBe(originalTitle);
    expect(registered.game.board.cells[0]!.name).not.toBe('mutated start');
    expect(Object.isFrozen(registered)).toBe(true);
    expect(Object.isFrozen(registered.game.board.cells[0])).toBe(true);
    expect(() => {
      (registered.metadata as { title: string }).title = 'runtime mutation';
    }).toThrow(TypeError);
  });

  it('不执行恶意 pack accessor，并在任何字段读取前拒绝注册', () => {
    const pack: any = makePack('accessor-map', 1);
    let getterCalls = 0;
    Object.defineProperty(pack.metadata, 'title', {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'Accessor map';
      },
    });
    const registry = createRegistry([]);

    expect(() => registry.registerMapPack(pack)).toThrow(/accessor/i);
    expect(getterCalls).toBe(0);
  });

  it('构造时快照 knownRuleModules，调用方后续修改不能改变 validation gate', () => {
    const knownRuleModules: { id: string; version: number }[] = [{ id: 'core', version: 1 }];
    const registry = createMapRegistry({ activeMapRefs: [], knownRuleModules });
    knownRuleModules.length = 0;
    knownRuleModules.push({ id: 'future', version: 1 });

    expect(() => registry.registerMapPack(makePack('core-map', 1))).not.toThrow();

    const future: any = makePack('future-map', 1);
    future.game.requiredRuleModules.push({ id: 'future', version: 1 });
    future.ref.contentHash = computeContentHash(future as MapPack);
    expect(() => registry.registerMapPack(future)).toThrow(/unknown rule module future@1/i);
  });

  it('只接受 registry 为 exact map ref 配置的可信 asset allowlist', () => {
    const pack: any = makePack('asset-map', 1);
    pack.presentation.cells[0].artwork = { type: 'local-asset', path: 'assets/start.png' };
    pack.ref.contentHash = computeContentHash(pack as MapPack);

    const trusted = createRegistry([], [{ ref: pack.ref, paths: ['assets/start.png'] }]);
    expect(() => trusted.registerMapPack(pack)).not.toThrow();

    const wrongHashRef = { ...pack.ref, contentHash: 'e'.repeat(64) };
    const untrusted = createRegistry([], [{ ref: wrongHashRef, paths: ['assets/start.png'] }]);
    expect(() => untrusted.registerMapPack(pack)).toThrow(/known package asset/i);
  });
});
