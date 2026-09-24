import board from '../maps/silk-road/v1/board.json';
import cards from '../maps/silk-road/v1/cards.json';
import config from '../maps/silk-road/v1/game-config.json';
import manifest from '../maps/silk-road/v1/manifest.json';
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
 * 「丝路之旅」：几何结构与其余各图都不同的**回字形双环**棋盘（唯一一张嵌套双环）。
 * 外环 0..39 是陆上丝路，走到 id 24（葱岭）时经 `nextId` 跳入内环 40..59（海上丝路），
 * 内环绕行一周后从 id 52（亚历山大港）回到外环 id 25（白沙瓦）继续陆路。
 * 全程只用核心规则的 `nextId` 跳接，因此不需要任何规则模块（只依赖 core@1）。
 */
export const silkRoadMap: Readonly<MapPack> = deepFreeze(mapPack);
