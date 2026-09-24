import board from '../maps/pearl-tour/v1/board.json';
import cards from '../maps/pearl-tour/v1/cards.json';
import config from '../maps/pearl-tour/v1/game-config.json';
import manifest from '../maps/pearl-tour/v1/manifest.json';
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

/** 「珠江之旅」：三角洲三角形环路：48 格沿三角三边闭合巡游，自珠江口出发沿东江北上、登顶珠江源后顺西江回落，珠江口最平、珠江源最贵。 */
export const pearlTourMap: Readonly<MapPack> = deepFreeze(mapPack);
