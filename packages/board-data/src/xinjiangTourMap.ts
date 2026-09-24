import board from '../maps/xinjiang-tour/v1/board.json';
import cards from '../maps/xinjiang-tour/v1/cards.json';
import config from '../maps/xinjiang-tour/v1/game-config.json';
import manifest from '../maps/xinjiang-tour/v1/manifest.json';
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

/** 「新疆之旅」：环形棋路：40 格主环绕行天山南北，阿克苏可转入「独库公路」6 格支线，越深入腹地地价越高。 */
export const xinjiangTourMap: Readonly<MapPack> = deepFreeze(mapPack);
