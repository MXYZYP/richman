// 工坊自定义地图服务端门禁的拒绝矩阵（D6 阶段 1）。
// 每一条拒绝理由都对应 customMapGate.ts 校验链的一环；「合法图通过」用
// china-tour 的深拷贝改 id 重算哈希构造——与客户端工坊导出的包同构。
import { describe, expect, test } from 'vitest';
import { chinaTourMap, computeContentHash } from '@richman/board-data';
import type { MapPack } from '@richman/board-data';
import { acceptCustomMapPack, CUSTOM_MAP_MAX_BYTES } from '../rooms/customMapGate';

const RESERVED_IDS = ['china-tour', 'world-tour'];

function buildCustomPack(mutate?: (pack: MapPack) => void): MapPack {
  const pack = structuredClone(chinaTourMap) as MapPack;
  pack.ref = { id: 'my-workshop-map', version: 1, contentHash: '' };
  mutate?.(pack);
  // computeContentHash 不吃 ref.contentHash（只吃 id/version/metadata/game/presentation），
  // 先置空再算，模拟客户端导入时的「重算并回填」。
  pack.ref.contentHash = computeContentHash(pack);
  return pack;
}

describe('customMapGate：合法包', () => {
  test('结构完整、哈希一致、id 无冲突的工坊图通过', () => {
    const result = acceptCustomMapPack(buildCustomPack(), RESERVED_IDS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pack.ref.id).toBe('my-workshop-map');
      expect(result.pack.game.board.cells.length).toBe(chinaTourMap.game.board.cells.length);
    }
  });
});

describe('customMapGate：拒绝矩阵', () => {
  test('非对象（null / 数组 / 字符串）拒绝', () => {
    for (const raw of [null, [chinaTourMap], 'not-a-pack', 42]) {
      const result = acceptCustomMapPack(raw, RESERVED_IDS);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.detail).toContain('JSON 对象');
    }
  });

  test('超过 512 KiB 上限拒绝（与客户端 CUSTOM_MAP_MAX_IMPORT_BYTES 对齐）', () => {
    const oversized = buildCustomPack((pack) => {
      pack.metadata.description = 'x'.repeat(CUSTOM_MAP_MAX_BYTES + 1024);
    });
    const result = acceptCustomMapPack(oversized, RESERVED_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('上限');
  });

  test('ref.id 与内置地图冲突拒绝', () => {
    const pack = buildCustomPack();
    pack.ref = { ...pack.ref, id: 'china-tour', contentHash: '' };
    pack.ref.contentHash = computeContentHash(pack);
    const result = acceptCustomMapPack(pack, RESERVED_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('与内置地图冲突');
  });

  test('哈希与声明不符拒绝（改一格数据不重算哈希）', () => {
    const pack = buildCustomPack();
    pack.metadata.description = `${pack.metadata.description ?? ''}被篡改的一格`;
    const result = acceptCustomMapPack(pack, RESERVED_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('contentHash 与实际内容不符');
  });

  test('未注册的规则模块拒绝（模块逻辑在服务端，包不能自带）', () => {
    const pack = buildCustomPack((p) => {
      (p.game as { requiredRuleModules: Array<{ id: string; version: number }> }).requiredRuleModules = [
        { id: 'no-such-module', version: 1 },
      ];
    });
    const result = acceptCustomMapPack(pack, RESERVED_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('结构校验');
  });

  test('非法 id 格式拒绝（assertValidMapPack 的小写连字符规则）', () => {
    const pack = buildCustomPack((p) => {
      p.ref = { ...p.ref, id: 'Bad_Id!' };
    });
    const result = acceptCustomMapPack(pack, RESERVED_IDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('结构校验');
  });

  test('缺 ref.id / version 非安全整数拒绝', () => {
    const noId = buildCustomPack();
    (noId.ref as { id?: string }).id = '';
    expect(acceptCustomMapPack(noId, RESERVED_IDS).ok).toBe(false);

    const badVersion = buildCustomPack((p) => {
      p.ref = { ...p.ref, version: 1.5 };
    });
    expect(acceptCustomMapPack(badVersion, RESERVED_IDS).ok).toBe(false);
  });

  test('结构与四字段不符拒绝（多字段/缺字段都会被 computeContentHash 的精确校验拦下）', () => {
    const extra = buildCustomPack();
    (extra as unknown as Record<string, unknown>).sneaky = true;
    expect(acceptCustomMapPack(extra, RESERVED_IDS).ok).toBe(false);
  });
});
