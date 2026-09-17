import {
  getActiveMapPack,
  listActiveMaps,
  type MapCatalogEntry,
  type MapPack,
} from '@richman/board-data';
import type { CreateLocalSessionOptions } from '../session/localSession';
import {
  hasAllClientMapAssets,
  resolveClientMapAsset,
  type ClientMapAssetResolver,
} from './mapAssets';

const HUMAN_NAMES = ['玩家一', '玩家二', '玩家三', '玩家四'] as const;
const BOT_NAMES = ['电脑A', '电脑B', '电脑C'] as const;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const MIN_HUMANS = 1;
const DEFAULT_HUMANS = 1;
const DEFAULT_BOTS = 2;

export interface GameSetupPlayer {
  id: string;
  nickname: string;
  isBot: boolean;
}

export interface GameSetupForm {
  mapId: string;
  humanCount: number;
  botCount: number;
  players: GameSetupPlayer[];
  cashGoalEnabled: boolean;
  cashGoal: number;
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
  return buildSetup(mapId, DEFAULT_HUMANS, DEFAULT_BOTS, [], false, (pack?.game.config.initialCash ?? 0) * 2);
}

export function updateGameSetupCounts(
  setup: GameSetupForm,
  counts: { humanCount?: number; botCount?: number },
): GameSetupForm {
  const requestedHumans = clampInt(counts.humanCount ?? setup.humanCount, MIN_HUMANS, MAX_PLAYERS);
  const requestedBots = clampInt(counts.botCount ?? setup.botCount, 0, BOT_NAMES.length);
  const { humanCount, botCount } = normalizeCounts(requestedHumans, requestedBots);
  return buildSetup(setup.mapId, humanCount, botCount, setup.players, setup.cashGoalEnabled, setup.cashGoal);
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
  if (totalPlayers < MIN_PLAYERS || totalPlayers > MAX_PLAYERS) return { ok: false, message: '玩家总数需要为 2-4 人' };
  if (setup.players.some((player) => player.nickname.trim().length === 0)) {
    return { ok: false, message: '玩家昵称不能为空' };
  }
  if (setup.cashGoalEnabled && (!Number.isFinite(setup.cashGoal) || setup.cashGoal <= pack.game.config.initialCash)) {
    return { ok: false, message: `现金目标必须高于初始资金 ${formatYuan(pack.game.config.initialCash)}` };
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

export function updateGameSetupMapId(setup: GameSetupForm, mapId: string): GameSetupForm {
  return { ...setup, mapId };
}

function buildSetup(
  mapId: string,
  humanCount: number,
  botCount: number,
  existingPlayers: GameSetupPlayer[],
  cashGoalEnabled: boolean,
  cashGoal: number,
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

  return { mapId, humanCount, botCount, players, cashGoalEnabled, cashGoal };
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
