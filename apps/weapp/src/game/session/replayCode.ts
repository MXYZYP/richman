import { applyIntent } from '@richman/engine';
import type { GameEvent, GameState, Intent } from '@richman/engine';
import { getActiveMapPack, type GameConfig, type MapPack, type MapRef } from '@richman/board-data';
import {
  createInitialLocalGameState,
  type CreateLocalSessionOptions,
  type LocalActionLogEntry,
  type LocalGameRecipe,
} from './localSession';

/**
 * 复盘导出（#115）。
 *
 * 为什么能只存「开局配方 + 一串意图」：
 *   本仓引擎是**确定性**的 —— `applyIntent` 是纯函数，随机数也全部走状态里的 RNG
 *   （`GameState.seed` 承载着 RNG 的当前状态、跟着局面一起往后走）。于是「重建起始态 + 按原顺序
 *   重放同一串意图」必然逐字节复现整局，不需要录事件、也不需要存中间快照。
 *
 * 但「重建起始态」这一步有两个坑，都踩过（详见 localSession.ts 的 LocalGameRecipe 注释）：
 *   ① 必须存 `createGame` 的**输入种子**，不能存 `GameState.seed`（后者是创建后的 RNG 状态，
 *      回喂会先被 `hashSeed` 再哈希一次 → 变成另一局：座次、牌堆全变）。
 *   ② 玩家表必须是**输入顺序**，不能是落座后的 `initialState.players`（定序掷骰按输入下标发点数，
 *      喂落座顺序会让座次重排）。
 *   所以 payload 存的是「配方」（seed + 输入顺序玩家表），而 `restoreState` 恢复的对局没有配方 ——
 *   那种局根本无从复现（存档里只有局面），本模块因此只服务「从头开局」的本地对局。
 *
 * 为什么连电脑玩家的动作也要录：
 *   本地对局里电脑的动作是 `chooseBotIntent` 在**客户端**算出来的，它同样经过
 *   `applyLocalIntent`，因此也在 actionLog 里。所以复盘不依赖难度设置 ——
 *   换个难度导入同一份复盘，结果不变（这一点很重要，否则难度会被迫进 payload）。
 *
 * 为什么联机不提供：
 *   联机以服务端为权威态，客户端手里只有「事件流 + 自己发过的意图」，
 *   没有全房逐条意图日志（服务端也不打算为此新增持久化）。与其给一份**会跑偏**的复盘，
 *   不如只做单机 —— 与既有「悔棋/回放仅单机」的产品决定保持一致。
 *
 * 码的格式沿用战绩码（playerStats.ts）约定：`RMREPLAY1.<base64url(JSON)>.<FNV-1a 8位hex>`，
 * 先看前缀段数、再看校验和、最后才解码 —— 粘贴来的垃圾不该让 JSON.parse 白跑一趟。
 */

export const REPLAY_CODE_PREFIX = 'RMREPLAY1';
const REPLAY_CODE_PAYLOAD_VERSION = 1;

/** 一份复盘的意图条数上限。整局 200 步量级的对局远低于此；设上限只为挡住畸形粘贴。 */
export const MAX_REPLAY_INTENTS = 20_000;
/** 单份码的字符数上限（约 2MB），超过直接判格式错误，避免把浏览器卡死。 */
export const MAX_REPLAY_CODE_LENGTH = 2_000_000;

export interface ReplayMapRef {
  readonly id: string;
  readonly version: number;
  readonly contentHash: string;
}

export interface ReplayPlayerSpec {
  readonly id: string;
  readonly nickname: string;
  readonly isBot?: boolean;
}

/** 复盘结果摘要：只用来在界面上说「这是谁打的一局、打到第几回合、谁赢了」。 */
export interface ReplaySummary {
  readonly turns: number;
  readonly winnerId: string | null;
  readonly playerCount: number;
}

export interface ReplayPayload {
  readonly v: 1;
  /** 导出时刻（epoch ms）。 */
  readonly createdAt: number;
  readonly map: ReplayMapRef;
  /** **创建时输入顺序**的玩家表（不是落座后的 `initialState.players`，见 localSession 的坑注释）。 */
  readonly players: readonly ReplayPlayerSpec[];
  /** `createGame` 的**输入种子**（不是 `GameState.seed`——那是创建之后的 RNG 状态，回喂会变成另一局）。 */
  readonly seed: string;
  readonly cashGoal: number | null;
  /** **生效后的**整份 config（不是覆盖项）。全量存是为了让重建走与正常开局完全相同的合并路径。 */
  readonly config: GameConfig;
  readonly intents: readonly Intent[];
  readonly summary: ReplaySummary | null;
}

export type ReplayCodeFailure = 'format' | 'checksum';

export type ReplayCodeDecodeResult =
  | { ok: true; payload: ReplayPayload }
  | { ok: false; reason: ReplayCodeFailure };

export type ReplayVerifyFailure = 'map_unavailable' | 'map_hash_mismatch' | 'replay_diverged';

export type ReplayVerification =
  | { ok: true; steps: number; state: GameState }
  | { ok: false; reason: ReplayVerifyFailure; stepIndex: number | null; detail: string };

/** 32 位 FNV-1a：只为「复制时掉了几个字符」兜底，不承担任何安全职责。 */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ReplaySource {
  /** 会话创建时的引擎状态（`LocalSession.initialState`）。 */
  readonly initialState: GameState;
  /** 开局配方（`LocalSession.createRecipe`）：输入种子 + 输入顺序的玩家表。 */
  readonly recipe: LocalGameRecipe;
  /** 有序意图序列（`LocalSession.actionLog` 里的 intent，顺序即执行顺序）。 */
  readonly intents: readonly Intent[];
  /** 导出时刻；显式传入以便测试稳定。 */
  readonly createdAt: number;
  readonly summary?: ReplaySummary | null;
}

/**
 * `GameState.config` 是 `DeepReadonly<GameConfig>`（引擎把整份配置深冻结），而码里要存的是
 * 可变的 `GameConfig`：逐字段摊平，顺手把两个嵌套集合复制成可变数组。
 * 只写 `{ ...config }` 不够 —— 展开会原样带上 `readonly` 的元组与数组，类型不兼容。
 */
function toMutableConfig(config: GameState['config']): GameConfig {
  return {
    initialCash: config.initialCash,
    passStartSalary: config.passStartSalary,
    maxHouseLevel: config.maxHouseLevel,
    sellHouseRefundRate: config.sellHouseRefundRate,
    sellLandRate: config.sellLandRate,
    mortgageInterestRate: config.mortgageInterestRate,
    utilityMultipliers: [config.utilityMultipliers[0], config.utilityMultipliers[1]],
    jailExitMinRoll: config.jailExitMinRoll,
    jailMaxAttempts: config.jailMaxAttempts,
    // 保释金是可选字段（只有带监狱的地图才有）。**不能无条件写这个键**：值为 undefined 时
    // JSON.stringify 会丢掉它，看似无害；但这里保留条件展开，好让「没有该字段的图」
    // 展平出来的对象与地图 config 逐键一致 —— 复盘重建时会拿它与地图档做深比较。
    ...(config.jailBailCost === undefined ? {} : { jailBailCost: config.jailBailCost }),
    cashGoalPresets: [...config.cashGoalPresets],
    diceMode: 'two_dice',
    airportBranchDice: config.airportBranchDice,
    jailEnabled: config.jailEnabled,
  };
}

export function buildReplayPayload(source: ReplaySource): ReplayPayload {
  const { initialState } = source;
  return {
    v: REPLAY_CODE_PAYLOAD_VERSION,
    createdAt: source.createdAt,
    map: {
      id: initialState.mapRef.id,
      version: initialState.mapRef.version,
      contentHash: initialState.mapRef.contentHash,
    },
    players: source.recipe.players.map((player) => (
      player.isBot === true
        ? { id: player.id, nickname: player.nickname, isBot: true }
        : { id: player.id, nickname: player.nickname }
    )),
    seed: source.recipe.seed,
    cashGoal: initialState.cashGoal,
    config: toMutableConfig(initialState.config),
    intents: source.intents.map((intent) => ({ ...intent })),
    summary: source.summary ?? null,
  };
}

export function encodeReplayCode(payload: ReplayPayload): string {
  const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${REPLAY_CODE_PREFIX}.${body}.${fingerprint(body)}`;
}

/** 校验一份意图的形状。只挡「会让 applyIntent 直接炸」的输入，规则层面的合法性交给重放本身判定。 */
function parseIntent(value: unknown): Intent | null {
  if (!isRecord(value)) return null;
  if (typeof value.type !== 'string' || value.type.length === 0) return null;
  return value as unknown as Intent;
}

function parsePlayers(value: unknown): ReplayPlayerSpec[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const players: ReplayPlayerSpec[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    if (typeof entry.id !== 'string' || entry.id.length === 0) return null;
    if (typeof entry.nickname !== 'string') return null;
    players.push(entry.isBot === true
      ? { id: entry.id, nickname: entry.nickname, isBot: true }
      : { id: entry.id, nickname: entry.nickname });
  }
  return players;
}

function parseMapRef(value: unknown): ReplayMapRef | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || value.id.length === 0) return null;
  if (typeof value.version !== 'number' || !Number.isInteger(value.version)) return null;
  if (typeof value.contentHash !== 'string' || value.contentHash.length === 0) return null;
  return { id: value.id, version: value.version, contentHash: value.contentHash };
}

function parseConfig(value: unknown): GameConfig | null {
  if (!isRecord(value)) return null;
  const config = value as unknown as GameConfig;
  // 只要求存在性：字段含义由引擎负责，这里挡的是「缺字段导致重建出的对局与原件不同」。
  for (const key of ['initialCash', 'maxHouseLevel'] as const) {
    if (typeof (config as unknown as Record<string, unknown>)[key] !== 'number') return null;
  }
  return config;
}

/**
 * 解析一段复盘码。顺序与战绩码一致：前缀与段数 → 校验和 → 解码 → 逐字段。
 * 粘贴过程中的空白（换行/空格）先抹掉，否则从聊天窗口复制过来必然失败。
 */
export function decodeReplayCode(code: string): ReplayCodeDecodeResult {
  const trimmed = typeof code === 'string' ? code.replace(/\s+/g, '') : '';
  if (trimmed.length === 0 || trimmed.length > MAX_REPLAY_CODE_LENGTH) return { ok: false, reason: 'format' };

  const parts = trimmed.split('.');
  if (parts.length !== 3 || parts[0] !== REPLAY_CODE_PREFIX) return { ok: false, reason: 'format' };

  const body = parts[1] ?? '';
  const checksum = parts[2] ?? '';
  if (fingerprint(body) !== checksum) return { ok: false, reason: 'checksum' };

  const bytes = base64UrlToBytes(body);
  if (bytes === null) return { ok: false, reason: 'format' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, reason: 'format' };
  }
  if (!isRecord(parsed) || parsed.v !== REPLAY_CODE_PAYLOAD_VERSION) return { ok: false, reason: 'format' };

  const map = parseMapRef(parsed.map);
  const players = parsePlayers(parsed.players);
  const config = parseConfig(parsed.config);
  if (map === null || players === null || config === null) return { ok: false, reason: 'format' };
  if (typeof parsed.seed !== 'string' || parsed.seed.length === 0) return { ok: false, reason: 'format' };

  const cashGoal = parsed.cashGoal === null || parsed.cashGoal === undefined
    ? null
    : typeof parsed.cashGoal === 'number' && Number.isFinite(parsed.cashGoal) ? parsed.cashGoal : Number.NaN;
  if (Number.isNaN(cashGoal)) return { ok: false, reason: 'format' };

  if (!Array.isArray(parsed.intents) || parsed.intents.length > MAX_REPLAY_INTENTS) return { ok: false, reason: 'format' };
  const intents: Intent[] = [];
  for (const entry of parsed.intents) {
    const intent = parseIntent(entry);
    if (intent === null) return { ok: false, reason: 'format' };
    intents.push(intent);
  }

  const rawSummary = parsed.summary;
  let summary: ReplaySummary | null = null;
  if (isRecord(rawSummary)) {
    const turns = typeof rawSummary.turns === 'number' && Number.isFinite(rawSummary.turns) ? rawSummary.turns : 0;
    const playerCount = typeof rawSummary.playerCount === 'number' && Number.isFinite(rawSummary.playerCount)
      ? rawSummary.playerCount
      : players.length;
    const winnerId = typeof rawSummary.winnerId === 'string' ? rawSummary.winnerId : null;
    summary = { turns, winnerId, playerCount };
  }

  const createdAt = typeof parsed.createdAt === 'number' && Number.isFinite(parsed.createdAt) ? parsed.createdAt : 0;

  return {
    ok: true,
    payload: { v: REPLAY_CODE_PAYLOAD_VERSION, createdAt, map, players, seed: parsed.seed, cashGoal, config, intents, summary },
  };
}

function sameMapRef(left: MapRef, right: ReplayMapRef): boolean {
  return left.id === right.id && left.version === right.version && left.contentHash === right.contentHash;
}

type MapLookup =
  | { ok: true; pack: MapPack }
  | { ok: false; reason: 'map_unavailable' | 'map_hash_mismatch' };

function resolveReplayMapRef(ref: ReplayMapRef, provided?: MapPack): MapLookup {
  // 自定义地图（#117 地图工坊）不在生产注册表里，必须由调用方把包递进来。
  if (provided !== undefined) {
    return sameMapRef(provided.ref, ref) ? { ok: true, pack: provided } : { ok: false, reason: 'map_hash_mismatch' };
  }
  let pack: MapPack;
  try {
    pack = getActiveMapPack(ref.id);
  } catch {
    return { ok: false, reason: 'map_unavailable' };
  }
  return sameMapRef(pack.ref, ref) ? { ok: true, pack } : { ok: false, reason: 'map_hash_mismatch' };
}

/**
 * 重放整份复盘以证明它**真的能跑**，并收集每步的事件——回看会话直接吃这份 entries。
 *
 * 这是导入路径上唯一的把关点，失败时给出「第几步、引擎报了哪个码」——
 * 没有这个定位，用户只会看到「导入失败」，而失败原因可能是地图被换过、
 * 也可能是码被截断，必须区分。
 */
interface ReplayedGame {
  readonly mapPack: MapPack;
  readonly initialState: GameState;
  readonly entries: LocalActionLogEntry[];
  readonly finalState: GameState;
}

type ReplayRun =
  | { ok: true; game: ReplayedGame }
  | { ok: false; reason: ReplayVerifyFailure; stepIndex: number | null; detail: string };

function runReplay(payload: ReplayPayload, providedPack?: MapPack): ReplayRun {
  const lookup = resolveReplayMapRef(payload.map, providedPack);
  if (!lookup.ok) {
    return { ok: false, reason: lookup.reason, stepIndex: null, detail: payload.map.id };
  }

  const initialState = createInitialLocalGameState({
    mapPack: lookup.pack,
    players: payload.players.map((player) => ({ ...player })),
    seed: payload.seed,
    cashGoal: payload.cashGoal,
    // 全量 config：与地图默认值再合并一次的结果仍是它自己，因此重建出的起始态与原件同构。
    config: payload.config,
  });

  const entries: LocalActionLogEntry[] = [];
  let state = initialState;
  for (let index = 0; index < payload.intents.length; index += 1) {
    const intent = payload.intents[index];
    if (intent === undefined) continue;
    const actorId = state.debt?.debtorId ?? state.currentPlayerId;
    const result = applyIntent(state, actorId, intent);
    if (!result.ok) {
      return { ok: false, reason: 'replay_diverged', stepIndex: index + 1, detail: result.code };
    }
    entries.push({ intent, events: result.events as GameEvent[], resultingState: result.state });
    state = result.state;
  }

  return { ok: true, game: { mapPack: lookup.pack, initialState, entries, finalState: state } };
}

/** 校验一份复盘能否完整重放，成功时返回终局状态。 */
export function verifyReplayPayload(payload: ReplayPayload, options: { mapPack?: MapPack } = {}): ReplayVerification {
  const run = runReplay(payload, options.mapPack);
  if (!run.ok) return run;
  return { ok: true, steps: run.game.entries.length, state: run.game.finalState };
}

export type ReplayPlaybackFailure = ReplayVerifyFailure | 'no_actions';

export type ReplayPlaybackRequest =
  | { ok: true; steps: number; options: CreateLocalSessionOptions }
  | { ok: false; reason: ReplayPlaybackFailure; stepIndex: number | null; detail: string };

/**
 * 把一份复盘变成「回看会话」的入参（#115）。
 *
 * 关键三件事：
 *   ① `restoreState` 用**重建出的起始态**，`replayLog` 用跑出来的 entries —— 于是会话的
 *      `replay()` 从开局起逐帧重演整局，与录下来的那一局完全一致。
 *   ② `autoPlayBots: false`：回看不该自己往下走。
 *   ③ 不传 `persistence`：回看不是对局，绝不写存档、绝不占存档槽。
 */
export function prepareReplayPlayback(
  payload: ReplayPayload,
  options: { mapPack?: MapPack } = {},
): ReplayPlaybackRequest {
  const run = runReplay(payload, options.mapPack);
  if (!run.ok) return run;
  const { game } = run;
  if (game.entries.length === 0) {
    // 零动作的复盘重演起来就是一块静止的棋盘，不如直接说清楚。
    return { ok: false, reason: 'no_actions', stepIndex: null, detail: '0' };
  }
  return {
    ok: true,
    steps: game.entries.length,
    options: {
      mapPack: game.mapPack,
      players: payload.players.map((player) => ({ ...player })),
      seed: payload.seed,
      cashGoal: payload.cashGoal,
      config: payload.config,
      restoreState: game.initialState,
      replayLog: game.entries,
      autoPlayBots: false,
    },
  };
}

export type ReplayExportFailure = 'no_recipe' | 'no_actions' | 'diverged';

export type ReplayExportResult =
  | { ok: true; code: string; payload: ReplayPayload; steps: number }
  | { ok: false; reason: ReplayExportFailure; stepIndex: number | null; detail: string };

export interface ReplayExportSource {
  /** 会话创建时的引擎状态（`LocalSession.initialState`）。 */
  readonly initialState: GameState;
  /** 开局配方；`null` = 从存档恢复的对局，无从复现。 */
  readonly createRecipe: LocalGameRecipe | null;
  readonly intents: readonly Intent[];
  readonly mapPack: MapPack;
  readonly summary?: ReplaySummary | null;
}

/**
 * 导出当前对局的复盘码。
 *
 * 导出前**先自校验**：宁可当场告诉玩家「导不出来」，也不能给出一份
 * 到了别人机器上才发现跑不通的码 —— 那会变成最难排查的一类反馈。
 */
export function exportReplay(source: ReplayExportSource, now: number): ReplayExportResult {
  if (source.createRecipe === null) {
    return { ok: false, reason: 'no_recipe', stepIndex: null, detail: '' };
  }
  if (source.intents.length === 0) {
    return { ok: false, reason: 'no_actions', stepIndex: null, detail: '' };
  }

  const payload = buildReplayPayload({
    initialState: source.initialState,
    recipe: source.createRecipe,
    intents: source.intents,
    createdAt: now,
    summary: source.summary ?? null,
  });

  const verified = runReplay(payload, source.mapPack);
  if (!verified.ok) {
    return { ok: false, reason: 'diverged', stepIndex: verified.stepIndex, detail: verified.detail };
  }
  return { ok: true, code: encodeReplayCode(payload), payload, steps: verified.game.entries.length };
}

export type ReplayFailure = ReplayCodeFailure | ReplayVerifyFailure | ReplayExportFailure | ReplayPlaybackFailure;

/** 一句话描述失败原因，供界面直接显示。 */
export function describeReplayFailure(reason: ReplayFailure): string {
  switch (reason) {
    case 'format': return '复盘码格式不对，或不是这一版导出的（请整段重新复制）';
    case 'checksum': return '复盘码校验和不符，多半是复制时掉了字符（请整段重新复制）';
    case 'map_unavailable': return '这份复盘用的地图在本机不存在（可能是自定义地图或已下线的地图）';
    case 'map_hash_mismatch': return '本机同名地图的内容与导出时不一致，无法保证复盘准确';
    case 'replay_diverged': return '重放到某一步时规则不再成立，说明码被改动过或版本不匹配';
    case 'no_recipe': return '这局是从存档恢复的，没有开局信息，无法导出复盘（请从头开一局再导出）';
    case 'no_actions': return '这局还没走过任何一步，没有可复盘的内容';
    case 'diverged': return '本机重放这局时在第若干步对不上，无法导出（请反馈给开发者）';
  }
}

/** 在原因后面补上「第几步、引擎报了什么码」——没有定位的失败提示等于没提示。 */
function withStep(message: string, stepIndex: number | null, detail: string): string {
  if (stepIndex === null) return message;
  return detail.length > 0 ? `${message}（第 ${stepIndex} 步，引擎码 ${detail}）` : `${message}（第 ${stepIndex} 步）`;
}

export type ReplayImportOutcome =
  | { ok: true; payload: ReplayPayload; playback: CreateLocalSessionOptions; steps: number }
  | { ok: false; message: string };

/**
 * 导入一段复盘码：解析 → 校验 → 备好回看会话入参。**全程纯函数**，UI 只负责显示结果。
 * 这样「导入」这条最容易出错的路径可以在 node 环境下被完整测到（本仓测试环境没有 DOM）。
 */
export function inspectReplayCode(code: string, options: { mapPack?: MapPack } = {}): ReplayImportOutcome {
  const decoded = decodeReplayCode(code);
  if (!decoded.ok) return { ok: false, message: describeReplayFailure(decoded.reason) };

  const prepared = prepareReplayPlayback(decoded.payload, options);
  if (!prepared.ok) {
    return { ok: false, message: withStep(describeReplayFailure(prepared.reason), prepared.stepIndex, prepared.detail) };
  }
  return { ok: true, payload: decoded.payload, playback: prepared.options, steps: prepared.steps };
}

/** 导出结果 → 界面文案（含自校验失败时的定位）。 */
export function describeReplayExport(result: ReplayExportResult): string {
  if (result.ok) return `已自校验：整局 ${result.steps} 步都能重放。`;
  return withStep(describeReplayFailure(result.reason), result.stepIndex, result.detail);
}
