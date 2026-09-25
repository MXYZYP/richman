import { chinaTourMap } from './chinaTourMap';
import { canonicalStringify } from './hash';
import type { MapCatalogEntry, MapPack, MapRef, RuleModuleRef } from './mapTypes';
import { assertValidMapPack } from './mapValidation';
import { worldTourMap } from './worldTourMap';
import { classicTourMap } from './classicTourMap';
import { greatWallMap } from './greatWallMap';
import { silkRoadMap } from './silkRoadMap';
import { yellowRiverMap } from './yellowRiverMap';
import { yangtzeTourMap } from './yangtzeTourMap';
import { pearlTourMap } from './pearlTourMap';
import { xinjiangTourMap } from './xinjiangTourMap';
import { shanxiTourMap } from './shanxiTourMap';
import { northeastTourMap } from './northeastTourMap';

interface AssetAllowlistEntry {
  readonly ref: MapRef;
  readonly paths: readonly string[];
}

export interface MapRegistryOptions {
  readonly activeMapRefs: readonly MapRef[];
  readonly knownRuleModules: readonly RuleModuleRef[];
  readonly assetAllowlist?: readonly AssetAllowlistEntry[];
}

/**
 * 生产环境允许的规则模块白名单（#117 地图工坊）。
 * 提出来是为了让**客户端侧的自定义地图校验**用与生产注册表完全同一份白名单——
 * 否则工坊会放行一张服务器/引擎根本不认识的模块地图，直到开局才炸。
 */
export const PRODUCTION_RULE_MODULES: readonly RuleModuleRef[] = [
  { id: 'core', version: 1 },
  { id: 'world-tour', version: 1 },
  { id: 'great-wall', version: 1 },
  { id: 'prison', version: 1 },
  // #23「每张地图都要有规则」：8 张纯 core 地图各配一个模块。
  { id: 'caravan-market', version: 1 },
  { id: 'landmark-passport', version: 1 },
  { id: 'oasis-camp', version: 1 },
  { id: 'piaohao', version: 1 },
  { id: 'port-trade', version: 1 },
  { id: 'rail-hub', version: 1 },
  { id: 'river-tide', version: 1 },
  { id: 'yangtze-ferry', version: 1 },
];

export interface MapRegistry {
  listActiveMaps(): readonly MapCatalogEntry[];
  getActiveMapPack(mapId: string): MapPack;
  getMapPack(mapRef: MapRef): MapPack;
  registerMapPack(pack: MapPack): void;
}

function versionKey(id: string, version: number): string {
  return `${id}@${version}`;
}

function exactKey(ref: MapRef): string {
  return `${versionKey(ref.id, ref.version)}#${ref.contentHash}`;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;

  seen.add(value);
  for (const nestedValue of Object.values(value)) {
    deepFreeze(nestedValue, seen);
  }
  return Object.freeze(value);
}

function frozenClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

export function createMapRegistry(options: MapRegistryOptions): MapRegistry {
  const activeMapRefs = frozenClone(options.activeMapRefs);
  const knownRuleModules = frozenClone(options.knownRuleModules);
  const activeById = new Map<string, MapRef>();
  for (const ref of activeMapRefs) {
    if (activeById.has(ref.id)) {
      throw new Error(`Duplicate active map id: ${ref.id}`);
    }
    activeById.set(ref.id, ref);
  }

  const assetPathsByExactRef = new Map<string, readonly string[]>();
  for (const entry of options.assetAllowlist ?? []) {
    const key = exactKey(entry.ref);
    if (assetPathsByExactRef.has(key)) {
      throw new Error(`Duplicate asset allowlist for map: ${versionKey(entry.ref.id, entry.ref.version)}`);
    }
    assetPathsByExactRef.set(key, frozenClone(entry.paths));
  }

  const packsById = new Map<string, Map<number, MapPack>>();

  function findActivePack(ref: MapRef): MapPack {
    const pack = packsById.get(ref.id)?.get(ref.version);
    if (pack === undefined || pack.ref.contentHash !== ref.contentHash) {
      throw new Error(`Active map ${versionKey(ref.id, ref.version)} is not registered with its exact hash`);
    }
    return pack;
  }

  return {
    registerMapPack(pack: MapPack): void {
      canonicalStringify(pack);
      const key = versionKey(pack.ref.id, pack.ref.version);
      if (packsById.get(pack.ref.id)?.has(pack.ref.version)) {
        throw new Error(`Duplicate map version: ${key}`);
      }

      assertValidMapPack(
        pack,
        knownRuleModules,
        assetPathsByExactRef.get(exactKey(pack.ref)) ?? [],
      );
      const registeredPack = frozenClone(pack);

      let versions = packsById.get(registeredPack.ref.id);
      if (versions === undefined) {
        versions = new Map<number, MapPack>();
        packsById.set(registeredPack.ref.id, versions);
      }
      versions.set(registeredPack.ref.version, registeredPack);
    },

    getMapPack(mapRef: MapRef): MapPack {
      const versions = packsById.get(mapRef.id);
      if (versions === undefined) {
        throw new Error(`Unknown map id: ${mapRef.id}`);
      }
      const pack = versions.get(mapRef.version);
      if (pack === undefined) {
        throw new Error(`Unknown map version: ${versionKey(mapRef.id, mapRef.version)}`);
      }
      if (pack.ref.contentHash !== mapRef.contentHash) {
        throw new Error(`Map hash mismatch for ${versionKey(mapRef.id, mapRef.version)}`);
      }
      return pack;
    },

    getActiveMapPack(mapId: string): MapPack {
      const activeRef = activeById.get(mapId);
      if (activeRef === undefined) throw new Error(`Inactive map id: ${mapId}`);
      return findActivePack(activeRef);
    },

    listActiveMaps(): readonly MapCatalogEntry[] {
      const catalog = activeMapRefs.map((ref) => {
        const pack = findActivePack(ref);
        return {
          ref: pack.ref,
          title: pack.metadata.title,
          description: pack.metadata.description,
        } satisfies MapCatalogEntry;
      });
      return deepFreeze(catalog);
    },
  };
}

const productionRegistry = createMapRegistry({
  activeMapRefs: [
    chinaTourMap.ref,
    worldTourMap.ref,
    classicTourMap.ref,
    silkRoadMap.ref,
    greatWallMap.ref,
    yellowRiverMap.ref,
    yangtzeTourMap.ref,
    pearlTourMap.ref,
    xinjiangTourMap.ref,
    shanxiTourMap.ref,
    northeastTourMap.ref,
  ],
  knownRuleModules: PRODUCTION_RULE_MODULES,
  assetAllowlist: [
    { ref: chinaTourMap.ref, paths: [] },
    { ref: worldTourMap.ref, paths: [] },
    { ref: classicTourMap.ref, paths: [] },
    { ref: silkRoadMap.ref, paths: [] },
    { ref: greatWallMap.ref, paths: [] },
    { ref: yellowRiverMap.ref, paths: [] },
    { ref: yangtzeTourMap.ref, paths: [] },
    { ref: pearlTourMap.ref, paths: [] },
    { ref: xinjiangTourMap.ref, paths: [] },
    { ref: shanxiTourMap.ref, paths: [] },
    { ref: northeastTourMap.ref, paths: [] },
  ],
});

productionRegistry.registerMapPack(chinaTourMap);
productionRegistry.registerMapPack(worldTourMap);
productionRegistry.registerMapPack(classicTourMap);
productionRegistry.registerMapPack(silkRoadMap);
productionRegistry.registerMapPack(greatWallMap);
productionRegistry.registerMapPack(yellowRiverMap);
productionRegistry.registerMapPack(yangtzeTourMap);
productionRegistry.registerMapPack(pearlTourMap);
productionRegistry.registerMapPack(xinjiangTourMap);
productionRegistry.registerMapPack(shanxiTourMap);
productionRegistry.registerMapPack(northeastTourMap);

export function listActiveMaps(): readonly MapCatalogEntry[] {
  return productionRegistry.listActiveMaps();
}

export function getActiveMapPack(mapId: string): MapPack {
  return productionRegistry.getActiveMapPack(mapId);
}

export function getMapPack(mapRef: MapRef): MapPack {
  return productionRegistry.getMapPack(mapRef);
}
