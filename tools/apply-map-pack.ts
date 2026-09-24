/**
 * 地图编辑器「一键落地」：把 tools/map-editor.html 导出的地图包接进仓库。
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs tools/apply-map-pack.ts <bundle.json> [--dry-run] [--force]
 *   （根脚本：corepack pnpm map:apply <bundle.json>）
 *
 * bundle.json = 编辑器「导出四份 JSON」得到的内容，形如：
 *   { "manifest.json": {...}, "board.json": {...}, "cards.json": {...}, "game-config.json": {...} }
 *
 * 为什么需要它：新增一张地图在仓库里要同步 6 处（4 份 JSON / 入口导出 / registry 三处注册 /
 * 3 处硬编码测试清单 / 部署清单）。漏任何一处都**不会在本地报错**，只在上线或某个测试里炸。
 * 本工具把「机器能做的部分」全部自动化，并明确列出仍需人工确认的部分。
 *
 * 安全设计：contentHash **由仓库自己的 hash.ts 重算**，不信任 bundle 里带的值；
 * 落地前必须通过 assertValidMapPack；落地后会重新从磁盘读回并复核哈希，防止 JSON 往返丢字段。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeContentHash } from '../packages/board-data/src/hash';
import { assertValidMapPack } from '../packages/board-data/src/mapValidation';
import type { MapPack } from '../packages/board-data/src/mapTypes';
import type { BoardData, CardsData, GameConfig } from '../packages/board-data/src/types';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const boardDataSrc = join(repoRoot, 'packages', 'board-data', 'src');
const mapsRoot = join(repoRoot, 'packages', 'board-data', 'maps');
const registryPath = join(boardDataSrc, 'registry.ts');
const indexPath = join(boardDataSrc, 'index.ts');
const deployScriptPath = join(repoRoot, 'deploy-manual.ps1');

const FILE_NAMES = ['board.json', 'cards.json', 'game-config.json', 'manifest.json'] as const;

function fail(message: string): never {
  console.error('❌ ' + message);
  process.exit(1);
}

function camelCase(id: string): string {
  const parts = id.split(/[^a-zA-Z0-9]+/).filter((part) => part.length > 0);
  return parts
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

/**
 * 从 registry.ts 里读出已知规则模块白名单，避免本工具自己维护一份会漂移的副本。
 *
 * #117 之后白名单从对象属性 `knownRuleModules: [...]` 抽成了顶层常量
 * `PRODUCTION_RULE_MODULES`（客户端地图工坊要与服务端共用**同一份**白名单，
 * 不能再各写一套）。两种形态都认：优先常量声明，找不到再退回旧写法，
 * 这样工具在两种布局下都能用，不会因为一次重构就静默失效。
 */
function readKnownModules(registrySource: string) {
  const constAnchor = 'PRODUCTION_RULE_MODULES: readonly RuleModuleRef[] = [';
  const inlineAnchor = '  knownRuleModules: [';
  const usingConst = registrySource.includes(constAnchor);
  const start = registrySource.indexOf(usingConst ? constAnchor : inlineAnchor);
  if (start < 0) fail('registry.ts 里找不到 knownRuleModules 数组');
  const end = registrySource.indexOf(usingConst ? '\n];' : '  ],', start);
  if (end < 0) fail('registry.ts 的 knownRuleModules 数组没有正常闭合');
  const block = registrySource.slice(start, end);
  const modules = [...block.matchAll(/\{\s*id:\s*'([^']+)',\s*version:\s*(\d+)\s*\}/g)].map((match) => ({
    id: match[1],
    version: Number(match[2]),
  }));
  if (modules.length === 0) fail('registry.ts 的 knownRuleModules 里没解析出任何模块');
  return modules;
}

interface PatchResult {
  readonly content: string;
  readonly changed: boolean;
}

function insertAfterLast(content: string, pattern: RegExp, line: string): PatchResult {
  if (content.includes(line)) return { content, changed: false };
  const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  let last: RegExpExecArray | null = null;
  let match = regex.exec(content);
  while (match !== null) {
    last = match;
    match = regex.exec(content);
  }
  if (last === null) fail('找不到插入锚点：' + pattern.source);
  const at = last.index + last[0].length;
  return { content: content.slice(0, at) + '\n' + line + content.slice(at), changed: true };
}

function insertBeforeClosingBracket(content: string, anchor: string, line: string): PatchResult {
  const start = content.indexOf(anchor);
  if (start < 0) fail('找不到数组锚点：' + anchor);
  // 从数组起始处往后找**第一个**独立成行的闭合括号（`],` 或 `];`，允许任意缩进）。
  // 之所以不用「锚点文字 + `],`」这种写法：同一个数组既可能是配置对象里的属性（收 `  ],`），
  // 也可能是顶层常量声明（收 `];`）——写死一种就会在另一种上 fail，而这正是 #117 那次重构干的事。
  const closing = /^[ \t]*\](?:,|;)?[ \t]*$/m.exec(content.slice(start));
  if (closing === null) fail('数组没有正常闭合：' + anchor);
  const closeAt = start + closing.index;
  // 数组项比闭合括号深一级：闭合行缩进 + 2 空格。
  // 这样不管是 `  ],`（项 4 空格）还是 `];`（项 2 空格）都能落成与邻居一致的排版。
  const closingIndent = /^[ \t]*/.exec(content.slice(closeAt))?.[0] ?? '';
  const entry = closingIndent + '  ' + line.trimStart();
  return { content: content.slice(0, closeAt) + entry + '\n' + content.slice(closeAt), changed: true };
}

function patchIndexTs(source: string, camel: string): PatchResult {
  return insertAfterLast(source, /^export \{ \w+Map \} from '\.\/\w+Map';$/m, `export { ${camel}Map } from './${camel}Map';`);
}

function patchRegistryTs(source: string, camel: string, modules: readonly { id: string; version: number }[]): PatchResult {
  let next = source;
  next = insertAfterLast(next, /^import \{ \w+Map \} from '\.\/\w+Map';$/m, `import { ${camel}Map } from './${camel}Map';`).content;
  const activeLine = `    ${camel}Map.ref,`;
  if (!next.includes(activeLine)) next = insertBeforeClosingBracket(next, '  activeMapRefs: [', activeLine).content;
  const allowlistLine = `    { ref: ${camel}Map.ref, paths: [] },`;
  if (!next.includes(allowlistLine)) next = insertBeforeClosingBracket(next, '  assetAllowlist: [', allowlistLine).content;
  next = insertAfterLast(next, /^productionRegistry\.registerMapPack\(\w+Map\);$/m, `productionRegistry.registerMapPack(${camel}Map);`).content;
  // 白名单现在住在顶层常量 PRODUCTION_RULE_MODULES 里（见 readKnownModules 的说明）；
  // 常量在就往常量里补，否则退回旧的 inline 属性写法。
  const moduleAnchor = next.includes('PRODUCTION_RULE_MODULES: readonly RuleModuleRef[] = [')
    ? 'PRODUCTION_RULE_MODULES: readonly RuleModuleRef[] = ['
    : '  knownRuleModules: [';
  for (const module of modules) {
    // 判存在时**不带前导缩进**：同一个模块在顶层常量里是 2 空格、在旧的对象属性里是 4 空格，
    // 带上缩进去比对会把已有的模块当成缺失的，重复插一遍。
    const entry = `{ id: '${module.id}', version: ${module.version} },`;
    if (!next.includes(entry)) {
      next = insertBeforeClosingBracket(next, moduleAnchor, `    ${entry}`).content;
    }
  }
  return { content: next, changed: next !== source };
}

function patchDeployList(source: string, mapId: string, camel: string, hasTest: boolean): PatchResult {
  const additions: string[] = [];
  for (const name of FILE_NAMES) {
    const line = `  "packages/board-data/maps/${mapId}/v1/${name}",`;
    if (!source.includes(line)) additions.push(line);
  }
  const mapTs = `  "packages/board-data/src/${camel}Map.ts",`;
  if (!source.includes(mapTs)) additions.push(mapTs);
  if (hasTest) {
    const testTs = `  "packages/board-data/src/__tests__/${camel}Map.test.ts",`;
    if (!source.includes(testTs)) additions.push(testTs);
  }
  if (additions.length === 0) return { content: source, changed: false };

  const lines = source.split('\n');
  let anchor = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*"packages\/board-data\/maps\/[^"]+",\s*$/.test(lines[index])) anchor = index;
  }
  if (anchor < 0) {
    for (let index = 0; index < lines.length; index += 1) {
      if (/^\s*"packages\/board-data\/src\/[^"]+Map\.ts",\s*$/.test(lines[index])) anchor = index;
    }
  }
  if (anchor < 0) fail('deploy-manual.ps1 里找不到 packages/board-data 清单行作为锚点');

  const jsonAdditions = additions.filter((line) => line.includes('/maps/'));
  const otherAdditions = additions.filter((line) => !line.includes('/maps/'));
  const merged = [...lines.slice(0, anchor + 1), ...jsonAdditions, ...otherAdditions, ...lines.slice(anchor + 1)];
  return { content: merged.join('\n'), changed: true };
}

function writeIfChanged(path: string, content: string, dryRun: boolean): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  if (!dryRun) writeFileSync(path, content, 'utf8');
  return true;
}

function renderMapTs(mapId: string, camel: string, title: string, description: string): string {
  return `import board from '../maps/${mapId}/v1/board.json';
import cards from '../maps/${mapId}/v1/cards.json';
import config from '../maps/${mapId}/v1/game-config.json';
import manifest from '../maps/${mapId}/v1/manifest.json';
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

/** 「${title}」：${description} */
export const ${camel}Map: Readonly<MapPack> = deepFreeze(mapPack);
`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force');
  const bundlePath = argv.find((argument) => !argument.startsWith('--'));
  if (!bundlePath) {
    fail('用法：node node_modules/tsx/dist/cli.mjs tools/apply-map-pack.ts <bundle.json> [--dry-run] [--force]');
  }
  const bundleResolved = resolve(process.cwd(), bundlePath);
  if (!existsSync(bundleResolved)) fail('找不到 bundle 文件：' + bundleResolved);

  const bundle = JSON.parse(readFileSync(bundleResolved, 'utf8')) as Record<string, unknown>;
  for (const name of FILE_NAMES) {
    if (bundle[name] === undefined) fail(`bundle 缺少 ${name}`);
  }

  const manifest = bundle['manifest.json'] as Record<string, unknown>;
  const rawRef = manifest.ref as { id?: string; version?: number; contentHash?: string } | undefined;
  const mapId = rawRef?.id;
  const version = rawRef?.version;
  if (typeof mapId !== 'string' || typeof version !== 'number') fail('manifest.ref 缺少 id / version');
  const camel = camelCase(mapId);
  if (camel.length === 0) fail('mapId 无法转成驼峰名：' + mapId);

  // bundle 来自编辑器导出的 JSON，字段类型在编译期无从得知，统一在这里一次性收窄成 MapPack 的成员类型。
  const metadata = manifest.metadata as MapPack['metadata'];
  const requiredRuleModules = manifest.requiredRuleModules as MapPack['game']['requiredRuleModules'];
  const presentation = manifest.presentation as MapPack['presentation'];

  const mapDir = join(mapsRoot, mapId, `v${version}`);
  const registrySource = readFileSync(registryPath, 'utf8');
  const alreadyRegistered = registrySource.includes(`${camel}Map.ref`);
  if ((existsSync(mapDir) || alreadyRegistered) && !force) {
    fail(`地图 ${mapId} 看起来已经落地（${existsSync(mapDir) ? '目录已存在' : 'registry 已注册'}）；如要覆盖请加 --force`);
  }

  // 1) 用仓库自己的哈希实现重算 contentHash —— 不信任 bundle 里的值。
  const pack = {
    ref: { id: mapId, version, contentHash: typeof rawRef?.contentHash === 'string' ? rawRef.contentHash : '' },
    metadata,
    game: {
      board: bundle['board.json'] as BoardData,
      cards: bundle['cards.json'] as CardsData,
      config: bundle['game-config.json'] as GameConfig,
      requiredRuleModules,
    },
    presentation,
  } as unknown as MapPack;

  const contentHash = computeContentHash(pack);
  const finalManifest = {
    ref: { id: mapId, version, contentHash },
    metadata,
    requiredRuleModules,
    presentation,
  };
  const finalPack = { ...pack, ref: finalManifest.ref } as MapPack;

  const knownModules = readKnownModules(registrySource);
  assertValidMapPack(finalPack, knownModules, []);

  const declared = rawRef?.contentHash;
  if (declared !== undefined && declared !== contentHash && !/^0+$/.test(declared)) {
    console.warn(`⚠️  bundle 里的 contentHash 与仓库重算结果不同，已采用仓库结果：\n    bundle: ${declared}\n    重算  : ${contentHash}`);
  }

  const testPath = join(boardDataSrc, '__tests__', `${camel}Map.test.ts`);
  const outputs: { path: string; content: string }[] = [
    { path: join(mapDir, 'board.json'), content: JSON.stringify(bundle['board.json'], null, 2) + '\n' },
    { path: join(mapDir, 'cards.json'), content: JSON.stringify(bundle['cards.json'], null, 2) + '\n' },
    { path: join(mapDir, 'game-config.json'), content: JSON.stringify(bundle['game-config.json'], null, 2) + '\n' },
    { path: join(mapDir, 'manifest.json'), content: JSON.stringify(finalManifest, null, 2) + '\n' },
  ];

  const changed: string[] = [];
  if (!dryRun) mkdirSync(mapDir, { recursive: true });
  for (const output of outputs) {
    if (writeIfChanged(output.path, output.content, dryRun)) changed.push(output.path);
  }

  const mapTsPath = join(boardDataSrc, `${camel}Map.ts`);
  const mapTs = renderMapTs(mapId, camel, finalManifest.metadata.title, finalManifest.metadata.description);
  if (writeIfChanged(mapTsPath, mapTs, dryRun)) changed.push(mapTsPath);

  const indexPatch = patchIndexTs(readFileSync(indexPath, 'utf8'), camel);
  if (indexPatch.changed) {
    if (!dryRun) writeFileSync(indexPath, indexPatch.content, 'utf8');
    changed.push(indexPath);
  }

  const registryPatch = patchRegistryTs(registrySource, camel, knownModules);
  if (registryPatch.changed) {
    if (!dryRun) writeFileSync(registryPath, registryPatch.content, 'utf8');
    changed.push(registryPath);
  }

  if (existsSync(deployScriptPath)) {
    const deployPatch = patchDeployList(readFileSync(deployScriptPath, 'utf8'), mapId, camel, existsSync(testPath));
    if (deployPatch.changed) {
      if (!dryRun) writeFileSync(deployScriptPath, deployPatch.content, 'utf8');
      changed.push(deployScriptPath);
    }
  }

  // 2) 从磁盘读回复核：证明「写出去的 JSON 再读回来」哈希仍然一致（防 JSON 往返丢字段）。
  if (!dryRun) {
    const reread = {
      ref: (JSON.parse(readFileSync(join(mapDir, 'manifest.json'), 'utf8')) as { ref: MapPack['ref'] }).ref,
      metadata: (JSON.parse(readFileSync(join(mapDir, 'manifest.json'), 'utf8')) as { metadata: MapPack['metadata'] }).metadata,
      game: {
        board: JSON.parse(readFileSync(join(mapDir, 'board.json'), 'utf8')) as BoardData,
        cards: JSON.parse(readFileSync(join(mapDir, 'cards.json'), 'utf8')) as CardsData,
        config: JSON.parse(readFileSync(join(mapDir, 'game-config.json'), 'utf8')) as GameConfig,
        requiredRuleModules: (JSON.parse(readFileSync(join(mapDir, 'manifest.json'), 'utf8')) as { requiredRuleModules: MapPack['game']['requiredRuleModules'] }).requiredRuleModules,
      },
      presentation: (JSON.parse(readFileSync(join(mapDir, 'manifest.json'), 'utf8')) as { presentation: MapPack['presentation'] }).presentation,
    } as unknown as MapPack;
    const rereadHash = computeContentHash(reread);
    assertValidMapPack(reread, knownModules, []);
    if (rereadHash !== contentHash) fail(`落盘后复核失败：重算 ${rereadHash} 与写入的 ${contentHash} 不一致`);
  }

  console.log('=== 地图包落地' + (dryRun ? '（dry-run，未写盘）' : '') + ' ===');
  console.log(`地图：${mapId}@${version}（${camel}Map）`);
  console.log(`contentHash：${contentHash}`);
  console.log(`格子数：${finalPack.game.board.cells.length}，机会 ${finalPack.game.cards.chance.length} 张，命运 ${finalPack.game.cards.destiny.length} 张`);
  console.log('已同步：' + (changed.length ? '\n  - ' + changed.map((item) => item.replace(repoRoot + '\\', '')).join('\n  - ') : '无改动'));
  console.log('');
  console.log('仍需人工确认（本工具不会自动改测试期望值）：');
  console.log('  1. packages/board-data/src/__tests__/registry.test.ts —— 期望地图数量与 id 列表');
  console.log('  2. packages/board-data/src/__tests__/testMap.test.ts —— listActiveMaps() 期望数组');
  console.log('  3. apps/client/src/components/MapThumbnail.test.ts —— maps.map(e => e.ref.id) 期望数组');
  console.log(`  4. 新建 ${testPath.replace(repoRoot + '\\', '')}（照 greatWallMap.test.ts 抄）`);
  console.log('  5. apps/server/src/__tests__/fullGameSmoke.test.ts 的遍历清单可加入本图（真实网关跑整局）');
  console.log('');
  console.log('然后跑：corepack pnpm test 与 corepack pnpm typecheck');
}

// 纯函数对外暴露，供 tools/__tests__/applyMapPack.test.ts 直接锁定各补丁锚点——
// 这里最容易随仓库演进悄悄失效（registry.ts / index.ts / deploy-manual.ps1 一改结构，
// 正则就匹配不到，而失败只会在下次新增地图时才暴露）。
export {
  camelCase,
  insertAfterLast,
  insertBeforeClosingBracket,
  patchDeployList,
  patchIndexTs,
  patchRegistryTs,
  readKnownModules,
  renderMapTs,
};

// 只有被直接执行时才落地；被测试 import 时不应产生任何副作用。
const invokedAsScript = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) main();
