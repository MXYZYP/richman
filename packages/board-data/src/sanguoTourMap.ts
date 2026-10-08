import board from '../maps/sanguo-tour/v1/board.json';
import cards from '../maps/sanguo-tour/v1/cards.json';
import config from '../maps/sanguo-tour/v1/game-config.json';
import manifest from '../maps/sanguo-tour/v1/manifest.json';
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

/**
 * 「三国风云」：28 格四方闭环（四角大格 + 每边 6 格小格）。
 *
 * 数值全部来自实物：初始资金 / 过起点工资取自规则书（各 2000 两），可建地租值取自 15 张产权纸
 * 的「空地过路费 / 一兵营 / 二兵营 / 一城池」四档（因此 `maxHouseLevel = 3`，rents 长度恒为 4）。
 *
 * 两处**刻意偏离实物**，都在 sanguoTourMap.test.ts 里有注释说明：
 *   · 义士的城池建设费实物印作 10500（其余 12 张两列相等），但 `PropertyCell.houseCost` 是单值字段，
 *     无法同时表达「兵营 1500 / 城池 10500」，故取兵营费 1500；
 *   · 陈留与长安的「一座城池」档在产权纸上未读到（印作「—」），按同价位档插值/外推为 9800 / 20000。
 */
export const sanguoTourMap: Readonly<MapPack> = deepFreeze(mapPack);