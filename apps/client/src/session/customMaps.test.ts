import { describe, expect, it } from 'vitest';
import { chinaTourMap, computeContentHash, listActiveMaps } from '@richman/board-data';
import type { MapPack } from '@richman/board-data';
import {
  CUSTOM_MAPS_KEY,
  CUSTOM_MAPS_SCHEMA_VERSION,
  CUSTOM_MAP_MAX_ENTRIES,
  CUSTOM_MAP_MAX_IMPORT_BYTES,
  createCustomMapRegistry,
  createCustomMapResolver,
  customMapSummaries,
  describeCustomMapImportFailure,
  exportCustomMapBundle,
  loadCustomMaps,
  mergeMapCatalog,
  parseCustomMapImport,
  persistCustomMaps,
  removeCustomMap,
  upsertCustomMap,
  type CustomMapImportFailure,
  type CustomMapRecord,
} from './customMaps';
import type { StorageLike } from './sessionStorage';

class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  failWrites = false;

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('quota exceeded');
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** 以正式地图 china-tour 为骨架造一张自定义地图：结构一定合法，只换 id / 标题。 */
function customPack(id = 'workshop-demo', mutate?: (pack: any) => void): MapPack {
  const pack: any = structuredClone(chinaTourMap);
  pack.ref = { id, version: 1, contentHash: '0'.repeat(64) };
  pack.metadata.title = `${id} 测试图`;
  pack.metadata.description = '地图工坊测试用地图';
  mutate?.(pack);
  pack.ref.contentHash = computeContentHash(pack as MapPack);
  return pack as MapPack;
}

/** 与地图编辑器「一键落地」按钮导出的 bundle 同形。 */
function bundleOf(pack: MapPack): Record<string, unknown> {
  return {
    'manifest.json': {
      ref: pack.ref,
      metadata: pack.metadata,
      requiredRuleModules: pack.game.requiredRuleModules,
      presentation: pack.presentation,
    },
    'board.json': pack.game.board,
    'cards.json': pack.game.cards,
    'game-config.json': pack.game.config,
  };
}

function recordOf(pack: MapPack, importedAt = '2026-09-23T00:00:00.000Z'): CustomMapRecord {
  return { pack, importedAt };
}

function parseOk(text: string, options?: Parameters<typeof parseCustomMapImport>[1]) {
  const result = parseCustomMapImport(text, options);
  if (!result.ok) throw new Error(`期望导入成功，却得到 ${result.reason}: ${result.detail}`);
  return result;
}

function parseFail(text: string, options?: Parameters<typeof parseCustomMapImport>[1]) {
  const result = parseCustomMapImport(text, options);
  if (result.ok) throw new Error('期望导入失败，却成功了');
  return result;
}

describe('地图工坊：导入解析（#117）', () => {
  it('接受编辑器 bundle 形态，重算哈希并保留地图内容', () => {
    const pack = customPack();
    const result = parseOk(JSON.stringify(bundleOf(pack)));

    expect(result.pack.ref.id).toBe('workshop-demo');
    expect(result.pack.ref.version).toBe(1);
    expect(result.declaredHashMatched).toBe(true);
    // 重算结果必须与包内声明一致，否则等于悄悄改了玩家的地图。
    expect(result.pack.ref.contentHash).toBe(pack.ref.contentHash);
    expect(result.pack.game.board.cells.length).toBe(chinaTourMap.game.board.cells.length);
  });

  it('也接受完整地图包形态，以及去掉 .json 后缀的 bundle 键名', () => {
    const pack = customPack();
    expect(parseOk(JSON.stringify(pack)).pack.ref.id).toBe('workshop-demo');

    const loose = bundleOf(pack) as Record<string, unknown>;
    const renamed = {
      manifest: loose['manifest.json'],
      board: loose['board.json'],
      cards: loose['cards.json'],
      'game-config': loose['game-config.json'],
    };
    expect(parseOk(JSON.stringify(renamed)).pack.ref.id).toBe('workshop-demo');
  });

  it('包内声明的哈希不对时，以本机重算值为准并标记不一致', () => {
    const pack = customPack();
    const tampered = { ...pack, ref: { ...pack.ref, contentHash: 'a'.repeat(64) } };
    const result = parseOk(JSON.stringify(tampered));

    expect(result.declaredHashMatched).toBe(false);
    expect(result.pack.ref.contentHash).toBe(pack.ref.contentHash);
  });

  it('空内容、超长内容、坏 JSON、形状不对各归各的失败原因', () => {
    expect(parseFail('   ').reason).toBe('empty');
    expect(parseFail('x'.repeat(CUSTOM_MAP_MAX_IMPORT_BYTES + 1)).reason).toBe('too_large');
    expect(parseFail('{ 这不是 JSON').reason).toBe('bad_json');
    expect(parseFail('{"a":1}').reason).toBe('bad_shape');
    // 只有 manifest 一半的 bundle 也算形状不对，不能当成「缺字段的合法地图」放过去。
    expect(parseFail(JSON.stringify({ 'manifest.json': { ref: { id: 'x', version: 1 } } })).reason)
      .toBe('bad_shape');
  });

  it('ref 缺 id / version 归到 bad_shape', () => {
    const pack = customPack();
    expect(parseFail(JSON.stringify({ ...pack, ref: { version: 1, contentHash: pack.ref.contentHash } })).reason)
      .toBe('bad_shape');
    expect(parseFail(JSON.stringify({ ...pack, ref: { id: 'workshop-demo', contentHash: pack.ref.contentHash } })).reason)
      .toBe('bad_shape');
  });

  it('reservedIds 里列出的 id 一律拒绝（工坊传的是内置地图的那些 id）', () => {
    const pack = customPack();
    const result = parseFail(JSON.stringify(pack), { reservedIds: ['workshop-demo'] });
    expect(result.reason).toBe('reserved_id');
    expect(result.detail).toContain('workshop-demo');
  });

  it('用了白名单外的规则模块 → unsupported_module', () => {
    const pack = customPack('workshop-bad-module', (draft) => {
      draft.game.requiredRuleModules = [...draft.game.requiredRuleModules, { id: 'mystery', version: 1 }];
    });
    const result = parseFail(JSON.stringify(pack));
    expect(result.reason).toBe('unsupported_module');
    expect(result.detail).toContain('mystery@1');
  });

  it('结构不合格（例如房规越界）→ invalid_map，且带上字段定位', () => {
    const pack = customPack('workshop-bad-config', (draft) => {
      draft.game.config.initialCash = -1;
    });
    const result = parseFail(JSON.stringify(pack));
    expect(result.reason).toBe('invalid_map');
    expect(result.detail).toContain('game.config.initialCash');
  });

  it('引用包内图片的自定义地图被拒（运行时拿不到构建期注册的资源 URL）', () => {
    const pack = customPack('workshop-asset', (draft) => {
      draft.presentation.cells['0'].artwork = { type: 'local-asset', path: 'assets/banner.png' };
    });
    const result = parseFail(JSON.stringify(pack));
    expect(result.reason).toBe('invalid_map');
    expect(result.detail).toContain('known package asset');
  });

  it('每种失败原因都有可读文案，且不含 undefined', () => {
    const reasons: readonly CustomMapImportFailure[] = [
      'empty', 'too_large', 'bad_json', 'bad_shape', 'reserved_id',
      'unsupported_module', 'invalid_map', 'full', 'storage',
    ];
    for (const reason of reasons) {
      const message = describeCustomMapImportFailure(reason);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain('undefined');
    }
  });
});

describe('地图工坊：本机存储（#117）', () => {
  it('落盘再读回，地图与哈希逐字不变', () => {
    const storage = new MemoryStorage();
    const pack = customPack();
    expect(persistCustomMaps(storage, [recordOf(pack)])).toBe(true);

    const loaded = loadCustomMaps(storage);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.pack.ref).toEqual(pack.ref);
    expect(loaded[0]!.importedAt).toBe('2026-09-23T00:00:00.000Z');
    expect(computeContentHash(loaded[0]!.pack)).toBe(pack.ref.contentHash);
  });

  it('无存储 / 空 / 坏 JSON / schemaVersion 不符都回退到空列表', () => {
    expect(loadCustomMaps(new MemoryStorage())).toEqual([]);

    const broken = new MemoryStorage();
    broken.setItem(CUSTOM_MAPS_KEY, '{oops');
    expect(loadCustomMaps(broken)).toEqual([]);

    const oldVersion = new MemoryStorage();
    oldVersion.setItem(CUSTOM_MAPS_KEY, JSON.stringify({
      schemaVersion: CUSTOM_MAPS_SCHEMA_VERSION + 1,
      records: [{ pack: customPack(), importedAt: '2026-09-23T00:00:00.000Z' }],
    }));
    expect(loadCustomMaps(oldVersion)).toEqual([]);
  });

  it('读回时逐条复核：哈希被改过、结构被改坏的条目被丢掉，其余照常读出', () => {
    const storage = new MemoryStorage();
    const good = customPack('workshop-good');
    const tamperedHash = customPack('workshop-tampered');
    const structureBroken = customPack('workshop-broken');
    storage.setItem(CUSTOM_MAPS_KEY, JSON.stringify({
      schemaVersion: CUSTOM_MAPS_SCHEMA_VERSION,
      records: [
        { pack: good, importedAt: '2026-09-23T00:00:00.000Z' },
        // 哈希与内容对不上：存储被人为改过
        { pack: { ...tamperedHash, metadata: { ...tamperedHash.metadata, title: '偷偷改了标题' } }, importedAt: '2026-09-23T00:00:00.000Z' },
        // 结构不合格（房规越界）
        { pack: customPack('workshop-broken', (draft) => { draft.game.config.initialCash = -1; }), importedAt: '2026-09-23T00:00:00.000Z' },
        { pack: structureBroken, importedAt: 42 },
      ],
    }));

    const loaded = loadCustomMaps(storage);
    expect(loaded.map((entry) => entry.pack.ref.id)).toEqual(['workshop-good']);
  });

  it('写不进去时返回 false（调用方据此提示），不抛错', () => {
    const storage = new MemoryStorage();
    storage.failWrites = true;
    expect(persistCustomMaps(storage, [recordOf(customPack())])).toBe(false);
  });

  it('同 id 覆盖（保留位置并刷新导入时间），新 id 追加，超上限返回 null', () => {
    const first = customPack('workshop-a');
    const second = customPack('workshop-b');
    let records: CustomMapRecord[] = [recordOf(first, '2026-01-01T00:00:00.000Z'), recordOf(second)];
    expect(records).toHaveLength(2);

    const replaced = upsertCustomMap(records, customPack('workshop-a'), Date.parse('2026-09-23T10:00:00.000Z'));
    expect(replaced).not.toBeNull();
    records = replaced!;
    expect(records).toHaveLength(2);
    expect(records[0]!.pack.ref.id).toBe('workshop-a');
    expect(records[0]!.importedAt).toBe('2026-09-23T10:00:00.000Z');

    let full: CustomMapRecord[] = [];
    for (let index = 0; index < CUSTOM_MAP_MAX_ENTRIES; index += 1) {
      full = upsertCustomMap(full, customPack(`workshop-${index}`), Date.now())!;
    }
    expect(full).toHaveLength(CUSTOM_MAP_MAX_ENTRIES);
    expect(upsertCustomMap(full, customPack('workshop-overflow'), Date.now())).toBeNull();
    // 但同 id 覆盖在满员时仍然允许 —— 那是「升级」，不是「新增」。
    expect(upsertCustomMap(full, customPack('workshop-0'), Date.now())).not.toBeNull();
  });

  it('删除按 id 生效，不存在的 id 是空操作', () => {
    const records = [recordOf(customPack('workshop-a')), recordOf(customPack('workshop-b'))];
    expect(removeCustomMap(records, 'workshop-a').map((entry) => entry.pack.ref.id)).toEqual(['workshop-b']);
    expect(removeCustomMap(records, 'nope')).toHaveLength(2);
  });
});

describe('地图工坊：注册表与目录（#117）', () => {
  it('独立注册表能取到自定义地图，且完全不影响生产地图', () => {
    const pack = customPack();
    const registry = createCustomMapRegistry([recordOf(pack)]);
    expect(registry.getActiveMapPack('workshop-demo').ref).toEqual(pack.ref);
    expect(registry.listActiveMaps().map((entry) => entry.ref.id)).toEqual(['workshop-demo']);

    // 生产注册表照旧十一张，一张不多。
    expect(listActiveMaps().map((entry) => entry.ref.id)).toEqual([
      'china-tour', 'world-tour', 'classic-tour', 'silk-road', 'great-wall',
      'yellow-river', 'yangtze-tour', 'pearl-tour', 'xinjiang-tour', 'shanxi-tour',
      'northeast-tour',
    ]);
    expect(() => createCustomMapRegistry([recordOf(pack)]).getActiveMapPack('china-tour'))
      .toThrow(/Inactive map id/);
  });

  it('解析器按 id 取包，取不到返回 null（而不是抛错）', () => {
    const resolve = createCustomMapResolver([recordOf(customPack())]);
    expect(resolve('workshop-demo')).not.toBeNull();
    expect(resolve('china-tour')).toBeNull();
    expect(resolve('nope')).toBeNull();
    expect(createCustomMapResolver([])('workshop-demo')).toBeNull();
  });

  it('目录合并：生产在前，同名以生产为准', () => {
    const custom = customMapSummaries([recordOf(customPack('workshop-a'))]);
    expect(custom[0]!.title).toBe('workshop-a 测试图');
    expect(custom[0]!.importedAt).toBe('2026-09-23T00:00:00.000Z');

    const production = [{ ref: chinaTourMap.ref, title: '中国之旅', description: '正式图' }];
    const merged = mergeMapCatalog(production, [
      { ref: chinaTourMap.ref, title: '顶包', description: '不该出现' },
      ...custom,
    ]);
    expect(merged.map((entry) => entry.title)).toEqual(['中国之旅', 'workshop-a 测试图']);
  });

  it('导出的 bundle 能原样再导入（往返后 ref 与哈希不变）', () => {
    const pack = customPack();
    const bundleText = exportCustomMapBundle(pack);
    expect(bundleText).toContain('"manifest.json"');
    expect(bundleText).toContain('"game-config.json"');

    const reparsed = parseOk(bundleText);
    expect(reparsed.pack.ref).toEqual(pack.ref);
    expect(reparsed.declaredHashMatched).toBe(true);
  });
});
