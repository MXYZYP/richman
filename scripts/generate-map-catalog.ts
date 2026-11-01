import { writeFileSync } from 'node:fs';
import { chinaTourMap } from '../packages/board-data/src/chinaTourMap';
import { worldTourMap } from '../packages/board-data/src/worldTourMap';
import { classicTourMap } from '../packages/board-data/src/classicTourMap';
import { silkRoadMap } from '../packages/board-data/src/silkRoadMap';
import { greatWallMap } from '../packages/board-data/src/greatWallMap';
import { yellowRiverMap } from '../packages/board-data/src/yellowRiverMap';
import { yangtzeTourMap } from '../packages/board-data/src/yangtzeTourMap';
import { pearlTourMap } from '../packages/board-data/src/pearlTourMap';
import { xinjiangTourMap } from '../packages/board-data/src/xinjiangTourMap';
import { shanxiTourMap } from '../packages/board-data/src/shanxiTourMap';
import { northeastTourMap } from '../packages/board-data/src/northeastTourMap';
import { yunchengTourMap } from '../packages/board-data/src/yunchengTourMap';
import { sanguoTourMap } from '../packages/board-data/src/sanguoTourMap';

const packs = [
  chinaTourMap, worldTourMap, classicTourMap, silkRoadMap, greatWallMap,
  yellowRiverMap, yangtzeTourMap, pearlTourMap, xinjiangTourMap,
  shanxiTourMap, northeastTourMap, yunchengTourMap, sanguoTourMap,
];

const entries = packs.map((pack) => ({
  ref: { id: pack.ref.id, version: pack.ref.version, contentHash: pack.ref.contentHash },
  title: pack.metadata.title,
  description: pack.metadata.description,
}));

const body = `// 生产地图目录（轻量版）—— 由 scripts/generate-map-catalog.ts 生成，**不要手改**。
//
// 为什么需要它：首屏（首页）只需要「有哪些地图 + 名字 + 一句话介绍」，
// 而完整的地图包（棋盘格、卡牌、规则模块）十三张加起来 258 KB —— 首页根本用不到。
// 有了这份目录，首屏就不必加载任何地图包；玩家点进设置 / 建房 / 开局时才按需加载。
//
// 漂移防线：catalog 与真实地图包的一致性由 packages/board-data/src/__tests__/
// mapCatalog.test.ts 逐字段比对（id / version / contentHash / title / description），
// 地图一改而忘了重新生成本文件，那条测试立刻变红。

import type { MapCatalogEntry } from './mapTypes';

export interface ProductionCatalogEntry extends MapCatalogEntry {
  readonly description: string;
}

/** 与生产注册表完全一致的一份目录（顺序也一致）。 */
export const PRODUCTION_CATALOG: readonly ProductionCatalogEntry[] = ${JSON.stringify(entries, null, 2)};
`;

writeFileSync(new URL('../packages/board-data/src/mapCatalog.ts', import.meta.url), body, 'utf8');
console.log(`generated ${entries.length} catalog entries`);
