/**
 * 工坊自定义地图的服务端门禁（D6 阶段 1）。
 *
 * 为什么服务端必须重验一遍：建房 payload 里的 customMapPack 来自网络，是**不可信输入**；
 * 客户端导入时做过同一套校验（apps/client/src/session/customMaps.ts），但二者之间没有任何
 * 传输层承诺。这里用与客户端完全相同的校验器（assertValidMapPack + PRODUCTION_RULE_MODULES）
 * 和相同的大小上限，保证「客户端能导进来的图，服务端才收；客户端收不了的，这里也拒」。
 *
 * 校验链（顺序即实现顺序）：
 *   1. 体积 ≤ 512 KiB（与客户端 CUSTOM_MAP_MAX_IMPORT_BYTES 对齐）；
 *   2. ref.id 必须是字符串且不与内置地图 id 冲突（reservedIds 由调用方传入）；
 *   3. computeContentHash 重算内容指纹，且必须与包内声明的 ref.contentHash 一致——
 *      改一格数据不改哈希 = 拒绝；哈希不符的包没有「精确 ref」语义可言；
 *   4. assertValidMapPack：完整结构校验 + 规则模块必须在生产白名单内。模块逻辑在服务端，
 *      自定义包不可能携带新模块——这是安全模型的一部分，不是限制疏漏。
 *
 * 注意：MapPack 是纯数据（board/cards/game-config/presentation），无可执行代码，
 * 校验通过后不存在注入面；最坏情况是一张「合法但难玩」的图。
 */
import { assertValidMapPack, computeContentHash, PRODUCTION_RULE_MODULES } from '@richman/board-data';
import type { MapPack } from '@richman/board-data';

/** 与客户端导入上限对齐：apps/client/src/session/customMaps.ts 的 CUSTOM_MAP_MAX_IMPORT_BYTES。 */
export const CUSTOM_MAP_MAX_BYTES = 512 * 1024;

export type CustomMapGateResult =
  | { ok: true; pack: MapPack }
  | { ok: false; detail: string };

export function acceptCustomMapPack(raw: unknown, reservedIds: readonly string[]): CustomMapGateResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, detail: 'customMapPack 必须是地图包 JSON 对象。' };
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(raw) ?? '';
  } catch {
    return { ok: false, detail: '地图包无法序列化为 JSON。' };
  }
  if (serialized.length > CUSTOM_MAP_MAX_BYTES) {
    return {
      ok: false,
      detail: `地图包有 ${Math.round(serialized.length / 1024)} KB，超过 ${CUSTOM_MAP_MAX_BYTES / 1024} KB 上限。`,
    };
  }

  const candidate = raw as { ref?: { id?: unknown; version?: unknown; contentHash?: unknown } };
  const id = candidate.ref?.id;
  if (typeof id !== 'string' || id.trim() === '') {
    return { ok: false, detail: '地图包缺少 ref.id。' };
  }
  if (!Number.isSafeInteger(candidate.ref?.version)) {
    return { ok: false, detail: '地图包 ref.version 必须是安全整数。' };
  }
  if (reservedIds.includes(id)) {
    return { ok: false, detail: `地图 id「${id}」与内置地图冲突。` };
  }

  const declared = typeof candidate.ref?.contentHash === 'string' ? candidate.ref.contentHash : '';
  // 这两个校验器只读取数据，不修改包；此处尚未证明它结构合法，用 unknown→MapPack 视图读取即可。
  const asPack = raw as unknown as MapPack;
  let computedHash: string;
  try {
    computedHash = computeContentHash(asPack);
  } catch (error) {
    return { ok: false, detail: `地图包不是合法的地图数据：${messageOf(error)}` };
  }
  if (declared !== computedHash) {
    return { ok: false, detail: '地图包声明的 contentHash 与实际内容不符（数据可能被篡改）。' };
  }

  try {
    assertValidMapPack(raw, PRODUCTION_RULE_MODULES, []);
  } catch (error) {
    return { ok: false, detail: `地图包未通过结构校验：${messageOf(error)}` };
  }

  return { ok: true, pack: raw as MapPack };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
