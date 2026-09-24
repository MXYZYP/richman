import board from '../maps/yellow-river/v1/board.json';
import cards from '../maps/yellow-river/v1/cards.json';
import config from '../maps/yellow-river/v1/game-config.json';
import manifest from '../maps/yellow-river/v1/manifest.json';
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

/** 「黄河之旅」：螺旋棋盘：64 格 8×8 盘旋布局，自入海口一路溯源收束到河源，越近源头地价越高，河源之后回到入海口重新启程。 */
export const yellowRiverMap: Readonly<MapPack> = deepFreeze(mapPack);
