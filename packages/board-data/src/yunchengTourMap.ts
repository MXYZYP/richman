import board from '../maps/yuncheng-tour/v1/board.json';
import cards from '../maps/yuncheng-tour/v1/cards.json';
import config from '../maps/yuncheng-tour/v1/game-config.json';
import manifest from '../maps/yuncheng-tour/v1/manifest.json';
import type { MapPack } from './mapTypes';
import type { BoardData, CardsData, GameConfig } from './types';

const mapManifest = manifest as unknown as Pick<MapPack, 'ref' | 'metadata' | 'presentation'> & {
  readonly requiredRuleModules: MapPack['game']['requiredRuleModules'];
};

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value;

  seen.add(value);
  for (const nestedValue of Object.values(value)) {
    deepFreeze(nestedValue, seen);
  }
  return Object.freeze(value);
}

const mapPack = {
  ref: mapManifest.ref,
  metadata: mapManifest.metadata,
  game: {
    board: board as BoardData,
    cards: cards as CardsData,
    config: config as GameConfig,
    requiredRuleModules: mapManifest.requiredRuleModules,
  },
  presentation: mapManifest.presentation,
} satisfies MapPack;

/** 「运城之旅」：盐湖之畔的黄河金三角：48 格 6×8 蛇形闭环，从运城站出发经解州关帝庙、鹳雀楼一路向东南到运城盐湖，沿途票号通商、河工争水，走到盐池白土再折回起点。 */
export const yunchengTourMap: Readonly<MapPack> = deepFreeze(mapPack);
