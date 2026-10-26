import {
  assertValidMapPack,
  computeContentHash,
  createMapRegistry,
  PRODUCTION_RULE_MODULES,
} from '@richman/board-data';
import type { MapCatalogEntry, MapPack, MapRegistry } from '@richman/board-data';
import type { StorageLike } from './sessionStorage';

/**
 * 地图工坊（#117）。
 *
 * 目标：让玩家把 `tools/map-editor.html` 导出的地图包**在本机装进来**并单机开一局，
 * 不需要改仓库、不需要等发版。
 *
 * ── 三条硬约束（都来自既有的数据管线，不是这里新加的规矩）──────────────────
 *
 * 1. **只走单机。** 联机建房走的是服务端的生产注册表（`packages/board-data/src/registry.ts`
 *    里的模块私有单例，只认那十一张正式地图）。客户端多装一张自定义地图，服务端一无所知，
 *    建房会直接被拒（`Requested map is unavailable.`）。所以工坊导入的地图**不进**首页
 *    「创建房间」的地图选择器，只能用于单机。UI 必须把这件事说明白，别让玩家点了半天才发现。
 *
 * 2. **过与生产完全同一套校验。** `assertValidMapPack` + `computeContentHash` 都是直接从
 *    `@richman/board-data` 拿的，规则模块白名单也复用 `PRODUCTION_RULE_MODULES`。
 *    绝不在这里另写一套宽松校验 —— 那只会把「工坊放行、开局炸」的坑留给玩家。
 *
 * 3. **不采信包内声明的 contentHash。** 声明值只用来提示「和重算结果不一致」，
 *    真正入库的哈希一律由本机重算，与 `tools/apply-map-pack.ts` 的做法一致。
 *
 * ── 资源限制 ──────────────────────────────────────────────────────────────
 * 自定义地图只能使用 **built-in icon**：包内图片（`local-asset`）依赖构建期由 Vite 注册的
 * URL（见 `game/mapAssets.ts`），运行时导入的地图拿不到注册项，`hasAllClientMapAssets`
 * 会判为不可渲染。校验时传空资源白名单，正好把这类地图挡在导入环节并给出明确原因。
 */

export const CUSTOM_MAPS_KEY = 'richman_custom_maps_v1';
export const CUSTOM_MAPS_SCHEMA_VERSION = 1;
/** 上限刻意很小：这是「本机装几张自己玩」的抽屉，不是地图仓库。 */
export const CUSTOM_MAP_MAX_ENTRIES = 8;
/** 单次粘贴/导入的文本上限。地图包是纯 JSON，正常几 KB，512 KB 足够且能挡住误贴大文件。 */
export const CUSTOM_MAP_MAX_IMPORT_BYTES = 512 * 1024;

export interface CustomMapRecord {
  /** 已经过校验、哈希已复核的地图包。 */
  readonly pack: MapPack;
  /** 导入时间（ISO 字符串，仅用于显示与排序）。 */
  readonly importedAt: string;
}

/** 工坊里一行地图的展示信息：目录项 + 导入时间。 */
export interface CustomMapSummary extends MapCatalogEntry {
  readonly importedAt: string;
}

/**
 * 导入失败的原因。
 *
 * 刻意分得比「能用/不能用」细：玩家拿到的是**编辑器的导出物**，出问题时最常见的三种情况是
 * 「复制少了半截」「用了不支持的规则模块」「图片资源引用了包内图片」——它们需要的补救动作
 * 完全不同，笼统报一个「导入失败」等于让玩家自己猜。
 */
export type CustomMapImportFailure =
  | 'empty'
  | 'too_large'
  | 'bad_json'
  | 'bad_shape'
  | 'reserved_id'
  | 'unsupported_module'
  | 'invalid_map'
  | 'full'
  | 'storage';

export type CustomMapParseResult =
  | { readonly ok: true; readonly pack: MapPack; readonly declaredHashMatched: boolean }
  | { readonly ok: false; readonly reason: CustomMapImportFailure; readonly detail: string };

export interface ParseCustomMapImportOptions {
  /**
   * 不允许占用的地图 id —— 由调用方决定，工坊传的是**内置地图**的 id。
   *
   * 刻意不把「本机已装的自定义地图 id」也算进来：玩家在地图编辑器里改完图、按原 id 重新导出时，
   * 最自然的期望是**升级那张图**，而不是被判重名、被迫换个 id 让抽屉里堆出一张旧图。
   * 同 id 覆盖由 `upsertCustomMap` 承担（保留原位置、刷新导入时间）。
   */
  readonly reservedIds?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pick(source: Record<string, unknown>, ...keys: readonly string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined) return source[key];
  }
  return undefined;
}

/**
 * 接受两种形态的输入，统一成 `MapPack`：
 *
 * - **完整地图包**：`{ ref, metadata, game, presentation }`（地图编辑器「导出 4 个 JSON」之外的
 *   整包形态，也是本机存储与复盘里流转的形状）。
 * - **编辑器 bundle**：`{ 'manifest.json', 'board.json', 'cards.json', 'game-config.json' }`
 *   ——就是 `tools/apply-map-pack.ts` 与地图编辑器「一键落地」按钮吃的那个文件。
 *   键名同时容忍去掉 `.json` 后缀的写法（编辑器自己的导入逻辑就这么读，两边保持一致）。
 *
 * 只做「拼起来」，不做任何校验：校验统一交给 `assertValidMapPack`，避免两处判断慢慢说岔。
 */
function normalizeMapPack(value: unknown): MapPack | null {
  if (!isRecord(value)) return null;

  if (isRecord(value.ref) && isRecord(value.metadata) && isRecord(value.game) && isRecord(value.presentation)) {
    return value as unknown as MapPack;
  }

  const manifest = pick(value, 'manifest.json', 'manifest');
  const board = pick(value, 'board.json', 'board');
  const cards = pick(value, 'cards.json', 'cards');
  const config = pick(value, 'game-config.json', 'game-config');
  if (!isRecord(manifest) || !isRecord(board) || !isRecord(cards) || !isRecord(config)) return null;

  return {
    ref: manifest.ref,
    metadata: manifest.metadata,
    game: {
      board,
      cards,
      config,
      requiredRuleModules: manifest.requiredRuleModules,
    },
    presentation: manifest.presentation,
  } as unknown as MapPack;
}

/**
 * 解析一段导入文本（纯函数，不碰存储）。
 *
 * 顺序上刻意「先便宜后昂贵」：空/超长 → JSON → 形状 → 撞名 → 重算哈希 → 全量校验。
 * 全量校验最贵也最能给出有用的错误，所以放最后，让简单错误先返回。
 */
export function parseCustomMapImport(
  text: string,
  options: ParseCustomMapImportOptions = {},
): CustomMapParseResult {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'empty', detail: '没有内容可导入。' };
  }
  if (trimmed.length > CUSTOM_MAP_MAX_IMPORT_BYTES) {
    return {
      ok: false,
      reason: 'too_large',
      detail: `内容有 ${Math.round(trimmed.length / 1024)} KB，超过了 ${CUSTOM_MAP_MAX_IMPORT_BYTES / 1024} KB 的上限。`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return { ok: false, reason: 'bad_json', detail: messageOf(error) };
  }

  const candidate = normalizeMapPack(parsed);
  if (candidate === null) {
    return {
      ok: false,
      reason: 'bad_shape',
      detail: '既不是完整地图包，也不是含 manifest / board / cards / game-config 四份 JSON 的 bundle。',
    };
  }

  const rawRef = candidate.ref as { id?: unknown; version?: unknown; contentHash?: unknown } | undefined;
  const id = rawRef?.id;
  const version = rawRef?.version;
  if (typeof id !== 'string' || id.trim() === '' || !Number.isSafeInteger(version)) {
    return { ok: false, reason: 'bad_shape', detail: 'manifest.ref 里缺 id 或 version。' };
  }
  if ((options.reservedIds ?? []).includes(id)) {
    return {
      ok: false,
      reason: 'reserved_id',
      detail: `地图 id「${id}」已被内置地图占用，请在地图编辑器里改个 id 再导出。`,
    };
  }

  // 重算哈希：包内声明的值只当提示，不采信（与 tools/apply-map-pack.ts 一致）。
  let contentHash: string;
  try {
    contentHash = computeContentHash(candidate);
  } catch (error) {
    return { ok: false, reason: 'bad_shape', detail: `这份地图不是合法的 JSON 数据：${messageOf(error)}` };
  }
  const declared = typeof rawRef?.contentHash === 'string' ? rawRef.contentHash : '';
  const normalized = {
    ...candidate,
    ref: { id, version: version as number, contentHash },
  } as MapPack;

  try {
    assertValidMapPack(normalized, PRODUCTION_RULE_MODULES, []);
  } catch (error) {
    const detail = messageOf(error);
    // 「不支持的规则模块」是最值得单独说的一类：玩家可能拿的是别人改过引擎版本的地图。
    const reason: CustomMapImportFailure = /unknown rule module/.test(detail)
      ? 'unsupported_module'
      : 'invalid_map';
    return { ok: false, reason, detail };
  }

  return { ok: true, pack: normalized, declaredHashMatched: declared === contentHash };
}

export function describeCustomMapImportFailure(reason: CustomMapImportFailure): string {
  switch (reason) {
    case 'empty':
      return '没有内容可导入。请粘贴地图包或编辑器导出的 bundle 的 JSON。';
    case 'too_large':
      return `导入内容太大（上限 ${CUSTOM_MAP_MAX_IMPORT_BYTES / 1024} KB），请确认没有误贴别的内容。`;
    case 'bad_json':
      return '这不是合法的 JSON，多半是复制时少了半截。请重新完整复制后再试。';
    case 'bad_shape':
      return '结构对不上：需要一份完整地图包，或地图编辑器导出的含 manifest / board / cards / game-config 的 bundle。';
    case 'reserved_id':
      return '地图 id 与内置地图重名。请在地图编辑器里换一个 id 重新导出。';
    case 'unsupported_module':
      return '这张地图用了当前版本不支持的规则模块（只认 core、world-tour、great-wall）。';
    case 'invalid_map':
      return '没通过地图校验。下面的定位信息会指出具体是哪个字段不合格。';
    case 'full':
      return `本机最多保存 ${CUSTOM_MAP_MAX_ENTRIES} 张自定义地图，请先删掉一张再导入。`;
    case 'storage':
      return '浏览器无法保存这次导入，请检查是否禁用了本地存储（隐私模式常见）。';
    default:
      return '导入失败。';
  }
}

function toRecords(value: Record<string, unknown>): CustomMapRecord[] {
  const list = Array.isArray(value.records) ? value.records : [];
  const records: CustomMapRecord[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const pack = normalizeMapPack(entry.pack);
    const importedAt = entry.importedAt;
    if (pack === null || typeof importedAt !== 'string') continue;
    // 读回来的每一条都重新复核结构与哈希：存储被人为改坏 / 版本换代后字段变形的条目直接丢掉，
    // 一条坏数据不该把整张地图列表带崩（同 playerStats 的容错策略）。
    try {
      if (computeContentHash(pack) !== (pack.ref as { contentHash?: unknown }).contentHash) continue;
      assertValidMapPack(pack, PRODUCTION_RULE_MODULES, []);
    } catch {
      continue;
    }
    if (seen.has(pack.ref.id)) continue;
    seen.add(pack.ref.id);
    records.push({ pack, importedAt });
    if (records.length >= CUSTOM_MAP_MAX_ENTRIES) break;
  }
  return records;
}

/** 读取本机自定义地图；无存储 / 损坏 / 版本不符一律回退到空列表，绝不抛错。 */
export function loadCustomMaps(storage: StorageLike): CustomMapRecord[] {
  let raw: string | null;
  try {
    raw = storage.getItem(CUSTOM_MAPS_KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.schemaVersion !== CUSTOM_MAPS_SCHEMA_VERSION) return [];
    return toRecords(parsed);
  } catch {
    return [];
  }
}

/** 写入自定义地图。返回 false 表示写不进去（调用方据此提示「导入没能保存」）。 */
export function persistCustomMaps(storage: StorageLike, records: readonly CustomMapRecord[]): boolean {
  try {
    storage.setItem(CUSTOM_MAPS_KEY, JSON.stringify({
      schemaVersion: CUSTOM_MAPS_SCHEMA_VERSION,
      records: records.map((record) => ({ pack: record.pack, importedAt: record.importedAt })),
    }));
    return true;
  } catch {
    return false;
  }
}

/**
 * 放进一张地图：同 id 覆盖（重新导入同一张图就是「升级」），否则追加。
 * 已满时返回 `null` —— 调用方据此提示玩家先删一张，而不是悄悄顶掉别人的图。
 */
export function upsertCustomMap(
  records: readonly CustomMapRecord[],
  pack: MapPack,
  now: number,
): CustomMapRecord[] | null {
  const record: CustomMapRecord = { pack, importedAt: new Date(now).toISOString() };
  const index = records.findIndex((entry) => entry.pack.ref.id === pack.ref.id);
  if (index >= 0) {
    const next = [...records];
    next[index] = record;
    return next;
  }
  if (records.length >= CUSTOM_MAP_MAX_ENTRIES) return null;
  return [...records, record];
}

export function removeCustomMap(records: readonly CustomMapRecord[], mapId: string): CustomMapRecord[] {
  return records.filter((record) => record.pack.ref.id !== mapId);
}

export function customMapSummaries(records: readonly CustomMapRecord[]): CustomMapSummary[] {
  return records.map((record) => ({
    ref: record.pack.ref,
    title: record.pack.metadata.title,
    description: record.pack.metadata.description,
    importedAt: record.importedAt,
  }));
}

/**
 * 用**独立**注册表装载自定义地图。
 *
 * 这是 #117 能在不碰生产单例的前提下复用全套校验的关键：`createMapRegistry` 从
 * `@richman/board-data` 开放出来就是为这件事（生产注册表本身是模块私有的，外部无法注入）。
 * 于是每张自定义地图在装载时都要重新过一遍 `assertValidMapPack`，跟正式地图同一条门槛。
 */
export function createCustomMapRegistry(records: readonly CustomMapRecord[]): MapRegistry {
  const unique = new Map<string, MapPack>();
  for (const record of records) {
    if (!unique.has(record.pack.ref.id)) unique.set(record.pack.ref.id, record.pack);
  }
  const registry = createMapRegistry({
    activeMapRefs: [...unique.values()].map((pack) => pack.ref),
    knownRuleModules: PRODUCTION_RULE_MODULES,
    assetAllowlist: [],
  });
  for (const pack of unique.values()) registry.registerMapPack(pack);
  return registry;
}

/**
 * 造一个「按 id 取自定义地图」的解析器，直接喂给 `GameSetupDependencies.resolveActive`。
 * 取不到返回 `null`（而不是抛错）——调用方的 `resolveGameSetupMap` 正是按 nullable 处理的。
 */
export function createCustomMapResolver(
  records: readonly CustomMapRecord[],
): (mapId: string) => MapPack | null {
  const registry = createCustomMapRegistry(records);
  return (mapId: string): MapPack | null => {
    try {
      return registry.getActiveMapPack(mapId);
    } catch {
      return null;
    }
  };
}

/**
 * 合并「生产地图 + 自定义地图」的目录，供**单机**设置页的地图选择器使用。
 *
 * 生产地图在前、同名时生产地图优先：万一有人把自定义地图的 id 改成了 `china-tour`，
 * 也不能让它顶掉正式地图在单机里的位置（导入时其实已经拦了，这里是第二道）。
 */
export function mergeMapCatalog(
  production: readonly MapCatalogEntry[],
  custom: readonly MapCatalogEntry[],
): MapCatalogEntry[] {
  const taken = new Set(production.map((entry) => entry.ref.id));
  return [...production, ...custom.filter((entry) => !taken.has(entry.ref.id))];
}

/** 把一张地图导回编辑器 bundle（方便分享给别人或再导入），键名与地图编辑器的导出物一致。 */
export function exportCustomMapBundle(pack: MapPack): string {
  return JSON.stringify({
    'manifest.json': {
      ref: pack.ref,
      metadata: pack.metadata,
      requiredRuleModules: pack.game.requiredRuleModules,
      presentation: pack.presentation,
    },
    'board.json': pack.game.board,
    'cards.json': pack.game.cards,
    'game-config.json': pack.game.config,
  }, null, 2);
}
