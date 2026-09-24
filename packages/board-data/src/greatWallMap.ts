import board from '../maps/great-wall/v1/board.json';
import cards from '../maps/great-wall/v1/cards.json';
import config from '../maps/great-wall/v1/game-config.json';
import manifest from '../maps/great-wall/v1/manifest.json';
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
 * 「长城之旅」：**横向蛇形网格**棋盘（长江之旅是它的纵向变体，两者同属网格类）。
 * 8 列 × 6 段城墙共 48 格，按「第 0 段自西向东、第 1 段折返」的蛇形（boustrophedon）顺序
 * 沿数组排列，末格「山海关」用 `nextId: 0` 折回起点；格与格之间留 2 单位缝隙，让路线虚线
 * 从缝里透出来，玩家能一眼看出行进方向。
 *
 * 地图自带 6 座 `beacon` 烽火台（great-wall@1 模块格）：落在无主烽火台上可花 claimCost 占据，
 * 他人再落到已被占据的烽火台要付 toll 通行费。因此这是全仓第一张 `requiredRuleModules`
 * 含 `core@1` 之外模块的地图。
 */
export const greatWallMap: Readonly<MapPack> = deepFreeze(mapPack);
