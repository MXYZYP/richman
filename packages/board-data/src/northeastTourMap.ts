import board from '../maps/northeast-tour/v1/board.json';
import cards from '../maps/northeast-tour/v1/cards.json';
import config from '../maps/northeast-tour/v1/game-config.json';
import manifest from '../maps/northeast-tour/v1/manifest.json';
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

/** 「东北之旅」：蛇形网格：48 格 6×8 自沈阳北上漠河再折回大连；踩中哨卡、越界、偷渡会被关进旅顺监狱，需掷骰或耗用出狱许可证脱身。 */
export const northeastTourMap: Readonly<MapPack> = deepFreeze(mapPack);
