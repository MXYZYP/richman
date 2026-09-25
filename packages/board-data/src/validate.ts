/**
 * 正式地图包的 build-time 校验入口。
 *
 * 运行：pnpm validate（packages/board-data 内）或 pnpm validate-data（根）
 * 退出码：0 = 全绿；1 = 有错误。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertChinaTourMapDataParity,
  assertChinaTourSourceReconciliation,
  type ChinaTourSourceTexts,
} from './chinaTourValidation';
import { chinaTourMap } from './chinaTourMap';
import { assertValidMapPack } from './mapValidation';
import { getMapPack } from './registry';
import { worldTourMap } from './worldTourMap';
import mapBoard from '../maps/china-tour/v1/board.json';
import mapCards from '../maps/china-tour/v1/cards.json';
import mapConfig from '../maps/china-tour/v1/game-config.json';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rawDirectory = resolve(packageDirectory, '../../raw');

function loadText(path: string): string {
  return readFileSync(path, 'utf8');
}

const sources: ChinaTourSourceTexts = {
  normalProperties: loadText(resolve(rawDirectory, '大富翁-普通地皮.md')),
  nonNormalProperties: loadText(resolve(rawDirectory, '大富翁-非普通地皮.md')),
  chanceCards: loadText(resolve(rawDirectory, '机会卡.md')),
  destinyCards: loadText(resolve(rawDirectory, '命运卡.md')),
};

const formalPacks = [getMapPack(chinaTourMap.ref), getMapPack(worldTourMap.ref)];

function printPackSummary(pack: (typeof formalPacks)[number]): void {
  const cells = pack.game.board.cells;
  const typeCounts: Record<string, number> = {};
  const subtypeCounts: Record<string, number> = {};
  for (const cell of cells) {
    typeCounts[cell.type] = (typeCounts[cell.type] ?? 0) + 1;
    if (cell.type === 'property') {
      subtypeCounts[cell.subtype] = (subtypeCounts[cell.subtype] ?? 0) + 1;
    }
  }

  console.log(`=== 棋盘数据校验（${pack.ref.id}@${pack.ref.version}）===`);
  console.log(`格子总数：${cells.length}`);
  console.log(`类型分布：${Object.entries(typeCounts).map(([key, value]) => `${key}=${value}`).join('，')}`);
  console.log(`地产子类：${Object.entries(subtypeCounts).map(([key, value]) => `${key}=${value}`).join('，')}`);
  console.log(`卡牌张数：机会 ${pack.game.cards.chance.length}，命运 ${pack.game.cards.destiny.length}`);
  console.log('');
}

for (const pack of formalPacks) printPackSummary(pack);

try {
  // Build registration Gate：raw/map source 仅在 Node CLI 校验，绝不进入 browser runtime registry。
  const knownModules = [
    { id: 'core', version: 1 },
    { id: 'world-tour', version: 1 },
    { id: 'great-wall', version: 1 },
    { id: 'prison', version: 1 },
  ];
  for (const pack of formalPacks) assertValidMapPack(pack, knownModules, []);
  const registeredChinaPack = formalPacks[0];
  assertChinaTourMapDataParity(registeredChinaPack, {
    board: mapBoard,
    cards: mapCards,
    config: mapConfig,
  });
  assertChinaTourSourceReconciliation(registeredChinaPack, sources);
  console.log('✅ 全部校验通过。');
} catch (error) {
  console.error('❌ 校验失败：');
  console.error(error instanceof Error ? error.message : String(error));
  console.error('');
  console.error('请修复上述错误后重跑 pnpm validate-data。');
  process.exitCode = 1;
}
