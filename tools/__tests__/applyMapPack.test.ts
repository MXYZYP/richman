import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  camelCase,
  insertAfterLast,
  insertBeforeClosingBracket,
  patchDeployList,
  patchIndexTs,
  patchRegistryTs,
  readKnownModules,
  renderMapTs,
} from '../apply-map-pack';

/**
 * 这组用例锁定的是「一键落地」工具与仓库真实文件的**契约**，不是工具的内部细节：
 * registry.ts / index.ts / deploy-manual.ps1 一旦改结构，补丁锚点正则就会静默失效，
 * 而那种失败只有在下一次新增地图时才会暴露。所以这里直接拿当前真实文件内容去跑补丁，
 * 断言「已落地的图再补一次应该完全没有改动」—— 一旦锚点漂移，本用例立刻变红。
 */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const boardDataSrc = join(repoRoot, 'packages', 'board-data', 'src');
const indexPath = join(boardDataSrc, 'index.ts');
const registryPath = join(boardDataSrc, 'registry.ts');
const deployPath = join(repoRoot, 'deploy-manual.ps1');

const registrySource = readFileSync(registryPath, 'utf8');
const indexSource = readFileSync(indexPath, 'utf8');
const deploySource = readFileSync(deployPath, 'utf8');

/** 与 registry.ts 的 activeMapRefs 顺序一致。 */
const ACTIVE_MAP_IDS = [
  'china-tour',
  'world-tour',
  'classic-tour',
  'silk-road',
  'great-wall',
  'yellow-river',
  'yangtze-tour',
  'pearl-tour',
  'xinjiang-tour',
  'shanxi-tour',
] as const;

describe('apply-map-pack: camelCase', () => {
  it('把地图 id 转成与仓库既有命名一致的驼峰名', () => {
    expect(ACTIVE_MAP_IDS.map(camelCase)).toEqual([
      'chinaTour',
      'worldTour',
      'classicTour',
      'silkRoad',
      'greatWall',
      'yellowRiver',
      'yangtzeTour',
      'pearlTour',
      'xinjiangTour',
      'shanxiTour',
    ]);
  });

  it('结果真的能对上 registry.ts 里已注册的模块名（id 与命名不能各写一套）', () => {
    for (const mapId of ACTIVE_MAP_IDS) {
      const camel = camelCase(mapId);
      expect(registrySource).toContain(`import { ${camel}Map } from './${camel}Map';`);
      expect(registrySource).toContain(`productionRegistry.registerMapPack(${camel}Map);`);
      expect(indexSource).toContain(`export { ${camel}Map } from './${camel}Map';`);
      expect(existsSync(join(boardDataSrc, `${camel}Map.ts`))).toBe(true);
    }
  });
});

describe('apply-map-pack: readKnownModules', () => {
  it('从 registry.ts 解析出 knownRuleModules，不自己维护副本', () => {
    expect(readKnownModules(registrySource)).toEqual([
      { id: 'core', version: 1 },
      { id: 'world-tour', version: 1 },
      { id: 'great-wall', version: 1 },
    ]);
  });
});

describe('apply-map-pack: 已落地地图必须完全幂等', () => {
  it('index.ts 对十张已注册地图补导出都是空操作', () => {
    for (const mapId of ACTIVE_MAP_IDS) {
      const patch = patchIndexTs(indexSource, camelCase(mapId));
      expect(patch.changed, `${mapId} 的 index.ts 导出行缺失或锚点漂移`).toBe(false);
      expect(patch.content).toBe(indexSource);
    }
  });

  it('registry.ts 对十张已注册地图补注册都是空操作', () => {
    const modules = readKnownModules(registrySource);
    for (const mapId of ACTIVE_MAP_IDS) {
      const patch = patchRegistryTs(registrySource, camelCase(mapId), modules);
      expect(patch.changed, `${mapId} 的 registry.ts 注册行缺失或锚点漂移`).toBe(false);
      expect(patch.content).toBe(registrySource);
    }
  });

  it('deploy-manual.ps1 对十张已注册地图补清单都是空操作（含各自的 *.test.ts）', () => {
    for (const mapId of ACTIVE_MAP_IDS) {
      const camel = camelCase(mapId);
      const hasTest = existsSync(join(boardDataSrc, '__tests__', `${camel}Map.test.ts`));
      const patch = patchDeployList(deploySource, mapId, camel, hasTest);
      expect(patch.changed, `${mapId} 的部署清单行缺失`).toBe(false);
      expect(patch.content).toBe(deploySource);
    }
  });
});

describe('apply-map-pack: 新地图确实能被补进去', () => {
  const camel = 'fixtureMap';
  const mapId = 'fixture-map';

  it('index.ts 在最后一个导出之后插入新导出', () => {
    const patch = patchIndexTs(indexSource, camel);
    const line = `export { ${camel}Map } from './${camel}Map';`;

    expect(patch.changed).toBe(true);
    expect(patch.content).toContain(line);
    // 必须插在原有导出之后，保持文件里「同一类语句聚在末尾」的既有排版。
    expect(patch.content.indexOf(line)).toBeGreaterThan(indexSource.indexOf('yellowRiverMap } from'));
    // 原有导出一个都不能少。
    for (const id of ACTIVE_MAP_IDS) {
      expect(patch.content).toContain(`export { ${camelCase(id)}Map } from './${camelCase(id)}Map';`);
    }
  });

  it('registry.ts 同时补 import / activeMapRefs / assetAllowlist / registerMapPack', () => {
    const patch = patchRegistryTs(registrySource, camel, readKnownModules(registrySource));

    expect(patch.changed).toBe(true);
    expect(patch.content).toContain(`import { ${camel}Map } from './${camel}Map';`);
    expect(patch.content).toContain(`    ${camel}Map.ref,`);
    expect(patch.content).toContain(`    { ref: ${camel}Map.ref, paths: [] },`);
    expect(patch.content).toContain(`productionRegistry.registerMapPack(${camel}Map);`);

    // 两个数组项必须落在各自数组内部，而不是被塞到别的数组或文件末尾。
    const activeStart = patch.content.indexOf('activeMapRefs: [');
    const activeEnd = patch.content.indexOf('],', activeStart);
    expect(patch.content.indexOf(`    ${camel}Map.ref,`)).toBeGreaterThan(activeStart);
    expect(patch.content.indexOf(`    ${camel}Map.ref,`)).toBeLessThan(activeEnd);

    const allowStart = patch.content.indexOf('assetAllowlist: [');
    const allowEnd = patch.content.indexOf('],', allowStart);
    const allowLineAt = patch.content.indexOf(`    { ref: ${camel}Map.ref, paths: [] },`);
    expect(allowLineAt).toBeGreaterThan(allowStart);
    expect(allowLineAt).toBeLessThan(allowEnd);
  });

  it('registry.ts 只补缺失的 knownRuleModules 项，已有的不重复', () => {
    const modules = [...readKnownModules(registrySource), { id: 'fixture-module', version: 1 }];
    const patch = patchRegistryTs(registrySource, camel, modules);

    expect(patch.content).toContain("    { id: 'fixture-module', version: 1 },");
    expect(patch.content.match(/\{ id: 'core', version: 1 \}/g)).toHaveLength(1);
    expect(patch.content.match(/\{ id: 'world-tour', version: 1 \}/g)).toHaveLength(1);
  });

  it('deploy-manual.ps1 在最后一组地图清单行之后插入 4 份 JSON 与 Map.ts', () => {
    const patch = patchDeployList(deploySource, mapId, camel, true);

    expect(patch.changed).toBe(true);
    for (const name of ['board.json', 'cards.json', 'game-config.json', 'manifest.json']) {
      expect(patch.content).toContain(`  "packages/board-data/maps/${mapId}/v1/${name}",`);
    }
    expect(patch.content).toContain(`  "packages/board-data/src/${camel}Map.ts",`);
    expect(patch.content).toContain(`  "packages/board-data/src/__tests__/${camel}Map.test.ts",`);
    // 插在既有地图清单行之后，且原有清单一行不丢。
    const insertAt = patch.content.indexOf(`  "packages/board-data/maps/${mapId}/v1/board.json",`);
    expect(insertAt).toBeGreaterThan(patch.content.indexOf('"packages/board-data/maps/yellow-river/v1/manifest.json",'));
    expect(patch.content).toContain('"packages/board-data/maps/yellow-river/v1/manifest.json",');
    expect(patch.content.split('\n').length).toBeGreaterThan(deploySource.split('\n').length);
  });
});

describe('apply-map-pack: 低层插入原语', () => {
  it('insertAfterLast 取最后一个匹配并保持幂等', () => {
    const source = [
      "import { a } from './a';",
      "import { b } from './b';",
      '',
      'const x = 1;',
    ].join('\n');

    const first = insertAfterLast(source, /^import \{ \w+ \} from '\.\/\w+';$/m, "import { c } from './c';");
    expect(first.changed).toBe(true);
    expect(first.content.split('\n')).toEqual([
      "import { a } from './a';",
      "import { b } from './b';",
      "import { c } from './c';",
      '',
      'const x = 1;',
    ]);

    const second = insertAfterLast(first.content, /^import \{ \w+ \} from '\.\/\w+';$/m, "import { c } from './c';");
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
  });

  it('insertBeforeClosingBracket 插到数组结束前（只承担配置对象里的 `],` 收尾形态）', () => {
    const source = ['const config = {', '  list: [', '    one,', '    two,', '  ],', '};', ''].join('\n');
    const patch = insertBeforeClosingBracket(source, '  list: [', '    three,');

    expect(patch.changed).toBe(true);
    expect(patch.content.split('\n').slice(0, 7)).toEqual([
      'const config = {',
      '  list: [',
      '    one,',
      '    two,',
      '    three,',
      '  ],',
      '};',
    ]);
  });
});

describe('apply-map-pack: renderMapTs', () => {
  it('产出的模块文件与既有 *Map.ts 同构', () => {
    const rendered = renderMapTs('new-lands', 'newLands', '新大陆', '给测试用的地图');

    expect(rendered).toContain("import board from '../maps/new-lands/v1/board.json';");
    expect(rendered).toContain("import manifest from '../maps/new-lands/v1/manifest.json';");
    expect(rendered).toContain('export const newLandsMap');
    expect(rendered).toContain('satisfies MapPack;');
    expect(rendered).toContain('Readonly<MapPack> = deepFreeze(mapPack);');
    // 每个生成的模块都必须引用同一套类型入口，否则 typecheck 会炸。
    expect(rendered).toContain("import type { MapPack } from './mapTypes';");
    expect(rendered).toContain('readonly requiredRuleModules: MapPack[\'game\'][\'requiredRuleModules\'];');
  });
});
