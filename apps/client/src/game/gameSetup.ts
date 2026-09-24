import {
  getActiveMapPack,
  listActiveMaps,
  type MapCatalogEntry,
  type MapPack,
} from '@richman/board-data';
import type { BotDifficulty } from '@richman/engine';
import type { CreateLocalSessionOptions } from '../session/localSession';
import {
  hasAllClientMapAssets,
  resolveClientMapAsset,
  type ClientMapAssetResolver,
} from './mapAssets';

const HUMAN_NAMES = ['玩家一', '玩家二', '玩家三', '玩家四', '玩家五', '玩家六'] as const;
const BOT_NAMES = ['电脑A', '电脑B', '电脑C', '电脑D', '电脑E'] as const;
const MIN_PLAYERS = 2;
/** #8：单机热座上限对齐联机（服务端 roomManager.MAX_PLAYERS 同为 6）。 */
const MAX_PLAYERS = 6;
const MIN_HUMANS = 1;
const DEFAULT_HUMANS = 1;
const DEFAULT_BOTS = 2;
const DEFAULT_BOT_DIFFICULTY: BotDifficulty = 'normal';

/**
 * 电脑难度档位（#6）：单机建房与联机大厅共用同一份文案，避免两处各写一遍而慢慢说岔。
 * hint 描述的是「这台电脑的决策偏好」——难度只喂给 `chooseBotIntent`，不改任何规则数值。
 */
export interface BotDifficultyOption {
  value: BotDifficulty;
  label: string;
  hint: string;
}

export const BOT_DIFFICULTY_OPTIONS: readonly BotDifficultyOption[] = [
  { value: 'easy', label: '轻松', hint: '电脑留钱多（应急储备 4000），不主动赎回抵押地产，适合带新手。' },
  { value: 'normal', label: '普通', hint: '电脑留钱 2000，会赎回抵押地产，默认难度。' },
  { value: 'hard', label: '困难', hint: '电脑只留 800，几乎全部投入买地，最难缠。' },
];

export interface GameSetupPlayer {
  id: string;
  nickname: string;
  isBot: boolean;
}

/** 规则自定义（P2-10）：玩家可调的初始资金、最高房级、抵押利率。 */
export interface RuleConfigForm {
  initialCash: number;
  maxHouseLevel: number;
  mortgageInterestRate: number;
}

export interface GameSetupForm {
  mapId: string;
  humanCount: number;
  botCount: number;
  players: GameSetupPlayer[];
  cashGoalEnabled: boolean;
  cashGoal: number;
  config: RuleConfigForm;
  /** 电脑玩家难度（P1-6 / #6）：原先只在首页设，现在移到这里；botCount 为 0 时无意义。 */
  botDifficulty: BotDifficulty;
}

export type GameSetupValidation = { ok: true } | { ok: false; message: string };

export interface GameSetupDependencies {
  readonly catalog: readonly MapCatalogEntry[];
  readonly resolveActive: (mapId: string) => MapPack;
  readonly resolveAsset?: ClientMapAssetResolver;
}

const defaultDependencies: GameSetupDependencies = {
  catalog: listActiveMaps(),
  resolveActive: getActiveMapPack,
};

export function createDefaultGameSetup(dependencies: GameSetupDependencies = defaultDependencies): GameSetupForm {
  const mapId = dependencies.catalog[0]?.ref.id ?? '';
  const pack = resolveGameSetupMap({ mapId }, dependencies);
  const baseConfig = pack?.game.config;
  return buildSetup(mapId, DEFAULT_HUMANS, DEFAULT_BOTS, [], false, (baseConfig?.initialCash ?? 0) * 2, {
    initialCash: baseConfig?.initialCash ?? 15000,
    maxHouseLevel: baseConfig?.maxHouseLevel ?? 5,
    mortgageInterestRate: baseConfig?.mortgageInterestRate ?? 0.1,
  }, DEFAULT_BOT_DIFFICULTY);
}

export function updateGameSetupCounts(
  setup: GameSetupForm,
  counts: { humanCount?: number; botCount?: number },
): GameSetupForm {
  const requestedHumans = clampInt(counts.humanCount ?? setup.humanCount, MIN_HUMANS, MAX_PLAYERS);
  const requestedBots = clampInt(counts.botCount ?? setup.botCount, 0, BOT_NAMES.length);
  const { humanCount, botCount } = normalizeCounts(requestedHumans, requestedBots);
  return buildSetup(
    setup.mapId,
    humanCount,
    botCount,
    setup.players,
    setup.cashGoalEnabled,
    setup.cashGoal,
    setup.config,
    setup.botDifficulty,
  );
}

export function validateGameSetup(
  setup: GameSetupForm,
  dependencies: GameSetupDependencies = defaultDependencies,
): GameSetupValidation {
  const pack = resolveGameSetupMap(setup, dependencies);
  if (pack === null) return { ok: false, message: '所选地图当前不可用' };
  return validateResolvedGameSetup(setup, pack);
}

function validateResolvedGameSetup(setup: GameSetupForm, pack: MapPack): GameSetupValidation {
  const totalPlayers = setup.humanCount + setup.botCount;
  if (setup.humanCount < MIN_HUMANS) return { ok: false, message: '至少需要 1 位真人玩家' };
  if (totalPlayers < MIN_PLAYERS || totalPlayers > MAX_PLAYERS) {
    return { ok: false, message: `玩家总数需要为 ${MIN_PLAYERS}-${MAX_PLAYERS} 人` };
  }
  if (setup.players.some((player) => player.nickname.trim().length === 0)) {
    return { ok: false, message: '玩家昵称不能为空' };
  }
  // 规则自定义（P2-10）范围校验：保证这些参数能被引擎安全消费，不会造出无法进行的对局。
  if (!Number.isFinite(setup.config.initialCash) || setup.config.initialCash <= 0) {
    return { ok: false, message: '初始资金必须大于 0' };
  }
  // 最高房级必须落在**这张地图**自己的档位内：过路费按 rents[level] 取档，而 rents 长度
  // 恒为 maxHouseLevel + 1，超出就是 rents[level] === undefined → 顶层房屋收 0 元租金。
  // 联机快照恢复时 hydrate 还会按地图配置校验 level，超限的对局根本恢复不回来。
  const mapMaxHouseLevel = pack.game.config.maxHouseLevel;
  if (
    !Number.isInteger(setup.config.maxHouseLevel)
    || setup.config.maxHouseLevel < 1
    || setup.config.maxHouseLevel > mapMaxHouseLevel
  ) {
    return { ok: false, message: `最高房级需为 1-${mapMaxHouseLevel} 之间的整数` };
  }
  if (!Number.isFinite(setup.config.mortgageInterestRate) || setup.config.mortgageInterestRate < 0 || setup.config.mortgageInterestRate > 1) {
    return { ok: false, message: '抵押利率需在 0%-100% 之间' };
  }
  if (setup.cashGoalEnabled && (!Number.isFinite(setup.cashGoal) || setup.cashGoal <= setup.config.initialCash)) {
    return { ok: false, message: `现金目标必须高于初始资金 ${formatYuan(setup.config.initialCash)}` };
  }

  return { ok: true };
}

export function gameSetupToCreateOptions(
  setup: GameSetupForm,
  dependencies: GameSetupDependencies = defaultDependencies,
): CreateLocalSessionOptions {
  const mapPack = resolveGameSetupMap(setup, dependencies);
  if (mapPack === null) throw new Error('所选地图当前不可用');
  const validation = validateResolvedGameSetup(setup, mapPack);
  if (!validation.ok) throw new Error(validation.message);
  return {
    mapPack,
    players: setup.players.map((player) => ({
      id: player.id,
      nickname: player.nickname.trim(),
      isBot: player.isBot,
    })),
    cashGoal: setup.cashGoalEnabled ? setup.cashGoal : null,
    config: setup.config,
    botDifficulty: setup.botDifficulty,
  };
}

function sameMapRef(left: MapPack['ref'], right: MapPack['ref']): boolean {
  return left.id === right.id && left.version === right.version && left.contentHash === right.contentHash;
}

export function resolveGameSetupMap(
  setup: Pick<GameSetupForm, 'mapId'>,
  dependencies: GameSetupDependencies = defaultDependencies,
): MapPack | null {
  const catalogEntry = dependencies.catalog.find((entry) => entry.ref.id === setup.mapId);
  if (catalogEntry === undefined) return null;
  try {
    const pack = dependencies.resolveActive(setup.mapId);
    const exact = sameMapRef(pack.ref, catalogEntry.ref);
    const renderable = exact && hasAllClientMapAssets(pack, dependencies.resolveAsset ?? resolveClientMapAsset);
    return renderable ? pack : null;
  } catch {
    return null;
  }
}

/**
 * 换地图（P2-10 规则自定义的配套约束）：最高房级既是房主可调的规则项，又受「这张地图」封顶
 * ——过路费按 `cell.rents[level]` 取档，而 rents 长度恒为 maxHouseLevel + 1（world-tour 只有 4 级）。
 * 换图后若原值超出新图档位，必须在这里夹回上限：否则用户只是换张图就会撞上
 * 「最高房级需为 1-N 之间的整数」而进不了对局，且不该由每个界面各自补一遍这个夹取。
 */
export function updateGameSetupMapId(
  setup: GameSetupForm,
  mapId: string,
  dependencies: GameSetupDependencies = defaultDependencies,
): GameSetupForm {
  const next = { ...setup, mapId };
  const mapMaxHouseLevel = resolveGameSetupMap(next, dependencies)?.game.config.maxHouseLevel;
  if (mapMaxHouseLevel === undefined || setup.config.maxHouseLevel <= mapMaxHouseLevel) return next;
  return { ...next, config: { ...setup.config, maxHouseLevel: mapMaxHouseLevel } };
}

/** 设定电脑玩家难度（#6）；只在 botCount > 0 时于建房表单里展示。 */
export function updateGameSetupBotDifficulty(
  setup: GameSetupForm,
  botDifficulty: BotDifficulty,
): GameSetupForm {
  return { ...setup, botDifficulty };
}

function buildSetup(
  mapId: string,
  humanCount: number,
  botCount: number,
  existingPlayers: GameSetupPlayer[],
  cashGoalEnabled: boolean,
  cashGoal: number,
  config: RuleConfigForm,
  botDifficulty: BotDifficulty,
): GameSetupForm {
  const existingHumans = existingPlayers.filter((player) => !player.isBot);
  const existingBots = existingPlayers.filter((player) => player.isBot);
  const players: GameSetupPlayer[] = [];
  for (let index = 0; index < humanCount; index++) {
    const id = `p${players.length + 1}`;
    players.push({ id, nickname: existingHumans[index]?.nickname ?? HUMAN_NAMES[index], isBot: false });
  }
  for (let index = 0; index < botCount; index++) {
    const id = `p${players.length + 1}`;
    players.push({ id, nickname: existingBots[index]?.nickname ?? BOT_NAMES[index], isBot: true });
  }

  return { mapId, humanCount, botCount, players, cashGoalEnabled, cashGoal, config, botDifficulty };
}

function normalizeCounts(humanCount: number, botCount: number): { humanCount: number; botCount: number } {
  let humans = Math.max(MIN_HUMANS, humanCount);
  let bots = Math.max(0, botCount);

  if (humans + bots > MAX_PLAYERS) {
    bots = Math.max(0, MAX_PLAYERS - humans);
  }
  if (humans + bots < MIN_PLAYERS) {
    bots = MIN_PLAYERS - humans;
  }

  return { humanCount: humans, botCount: bots };
}

function clampInt(value: number, min: number, max: number): number {
  const integer = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.min(max, Math.max(min, integer));
}

function formatYuan(amount: number): string {
  return `¥${amount.toLocaleString('zh-CN')}`;
}
