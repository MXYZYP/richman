import {
  applyIntent,
  chooseBotIntent,
  createGame,
  currentPendingAuction,
  currentPendingTrade,
  defaultRuleModuleRegistry,
  skipCurrentTurn,
} from '@richman/engine';
import type { BotDifficulty } from '@richman/engine';
import type { BoardData, CardsData, DeepReadonly, GameConfig, MapRef, RuleModuleRef } from '@richman/board-data';
import type {
  ApplyResult,
  CreateGameInput,
  ErrorCode,
  GameEvent,
  GameState,
  Intent,
} from '@richman/engine';

export interface GameRuntimeGateway {
  createGame(input: CreateGameInput): GameState;
  applyIntent(state: GameState, playerId: string, intent: Intent): ApplyResult;
  chooseBotIntent(state: GameState, playerId: string, difficulty?: BotDifficulty): Intent;
}

export const defaultGameGateway: GameRuntimeGateway = {
  createGame,
  applyIntent,
  chooseBotIntent: (state, playerId, difficulty) => chooseBotIntent(state, playerId, defaultRuleModuleRegistry, difficulty),
};

const NO_ARG_INTENTS = new Set<Intent['type']>([
  'roll_dice',
  'roll_airport_branch',
  'buy_property',
  'skip_buy',
  'build_house',
  'skip_build',
  'end_turn',
  'declare_bankrupt',
  'surrender',
]);

const CELL_ID_INTENTS = new Set<Intent['type']>([
  'sell_house',
  'sell_property',
  'mortgage_property',
  'redeem_property',
]);

/**
 * 交易 / 拍卖（#105 / #106）的意图：都带参数，且参数形状比 cellId 复杂（含嵌套的出价侧），
 * 所以不走上面两张集合，单独严格校验（见 isValidBargainIntent）。
 */
const BARGAIN_INTENTS = new Set<Intent['type']>([
  'propose_trade',
  'respond_trade',
  'cancel_trade',
  'place_bid',
  'pass_bid',
]);

/** 一次交易出价侧的最大地产数量：只为挡住畸形大数组，正常报价远小于它。 */
const TRADE_SIDE_MAX_CELLS = 64;
const TRADE_SIDE_KEYS = ['cash', 'cellIds'] as const;

/** 交易出价的一侧：`{cash, cellIds}`，现金为非负安全整数、cellIds 为非负整数数组。 */
function isValidTradeSideValue(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !hasPlainPrototype(value)) return false;
  const side = value as Record<string, unknown>;
  if (!hasExactKeys(side, TRADE_SIDE_KEYS)) return false;
  const cash = dataValue(side, 'cash');
  if (!Number.isSafeInteger(cash) || (cash as number) < 0) return false;
  const cellIds = dataValue(side, 'cellIds');
  return Array.isArray(cellIds)
    && cellIds.length <= TRADE_SIDE_MAX_CELLS
    && cellIds.every((cellId) => Number.isSafeInteger(cellId) && (cellId as number) >= 0);
}

/**
 * 精确形状校验（不含语义）：越权/越界一律由引擎的 handler 判定。
 * 传输层只保证「形状正确、且不会变成畸形大对象」，语义判断集中在引擎一处，避免两处规则漂移。
 */
function isValidBargainIntent(record: Record<string, unknown>, type: string): boolean {
  if (!hasPlainPrototype(record)) return false;
  switch (type) {
    case 'propose_trade': {
      if (!hasExactKeys(record, ['type', 'targetId', 'offer', 'request'])) return false;
      const targetId = dataValue(record, 'targetId');
      return typeof targetId === 'string'
        && targetId.length > 0
        && targetId.length <= 64
        && isValidTradeSideValue(dataValue(record, 'offer'))
        && isValidTradeSideValue(dataValue(record, 'request'));
    }
    case 'respond_trade':
      return hasExactKeys(record, ['type', 'accept']) && typeof dataValue(record, 'accept') === 'boolean';
    case 'place_bid': {
      if (!hasExactKeys(record, ['type', 'amount'])) return false;
      const amount = dataValue(record, 'amount');
      return Number.isSafeInteger(amount) && (amount as number) > 0;
    }
    case 'cancel_trade':
    case 'pass_bid':
      return hasExactKeys(record, ['type']);
    default:
      return false;
  }
}

const MODULE_INTENT_MAX_BYTES = 16 * 1024;

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(record);
  return actual.length === keys.length && actual.every((key) => typeof key === 'string')
    && keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      return descriptor?.enumerable === true && 'value' in descriptor;
    });
}

function dataValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function hasPlainPrototype(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown, seen = new Set<object>(), depth = 0, nodes = { count: 0 }): boolean {
  nodes.count += 1;
  if (nodes.count > 2_048 || depth > 32) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== 'string')
      || ownKeys.length !== value.length + 1
      || !ownKeys.includes('length')) {
      seen.delete(value);
      return false;
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)
        || !isJsonValue(descriptor.value, seen, depth + 1, nodes)) {
        seen.delete(value);
        return false;
      }
    }
    seen.delete(value);
    return true;
  }

  if (!hasPlainPrototype(value)) {
    seen.delete(value);
    return false;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      seen.delete(value);
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)
      || !isJsonValue(descriptor.value, seen, depth + 1, nodes)) {
      seen.delete(value);
      return false;
    }
  }
  seen.delete(value);
  return true;
}

function isValidModuleIntent(record: Record<string, unknown>): boolean {
  if (!hasPlainPrototype(record) || !hasExactKeys(record, ['type', 'module', 'action', 'payload'])) return false;
  const moduleValue = dataValue(record, 'module');
  const action = dataValue(record, 'action');
  const payload = dataValue(record, 'payload');
  if (moduleValue === null || typeof moduleValue !== 'object' || Array.isArray(moduleValue)
    || !hasPlainPrototype(moduleValue)) return false;
  const module = moduleValue as Record<string, unknown>;
  const moduleId = dataValue(module, 'id');
  const moduleVersion = dataValue(module, 'version');
  if (!hasExactKeys(module, ['id', 'version'])
    || typeof moduleId !== 'string'
    || moduleId.length === 0
    || moduleId.length > 64
    || moduleId.trim() !== moduleId
    || !Number.isSafeInteger(moduleVersion)
    || (moduleVersion as number) <= 0
    || typeof action !== 'string'
    || action.length === 0
    || action.length > 128
    || action.trim() !== action
    || !isJsonValue(payload)) return false;

  return new TextEncoder().encode(JSON.stringify(record)).byteLength <= MODULE_INTENT_MAX_BYTES;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => (
    key === rightKeys[index] && jsonEqual(leftRecord[key], rightRecord[key])
  ));
}

function isAuthorizedModuleIntent(state: GameState, playerId: string, intent: Extract<Intent, { type: 'module' }>): boolean {
  const enabled = state.ruleModules.some((module) => (
    module.id === intent.module.id && module.version === intent.module.version
  ));
  if (!enabled || state.currentPlayerId !== playerId || state.debt !== null) return false;
  return state.publicRuleState.pendingActions.some((action) => (
    action.playerId === playerId
    && action.requiredPhase === state.turnPhase
    && action.module.id === intent.module.id
    && action.module.version === intent.module.version
    && action.action === intent.action
    && jsonEqual(action.payload, intent.payload)
  ));
}

export function isValidIntent(value: unknown): value is Intent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;

  const record = value as Record<string, unknown>;
  const type = dataValue(record, 'type');
  if (typeof type !== 'string') return false;
  if (type === 'module') return isValidModuleIntent(record);
  if (NO_ARG_INTENTS.has(type as Intent['type'])) return true;
  if (CELL_ID_INTENTS.has(type as Intent['type'])) return Number.isInteger(dataValue(record, 'cellId'));
  if (BARGAIN_INTENTS.has(type as Intent['type'])) return isValidBargainIntent(record, type);
  return false;
}

export type CreateInitialGameResult =
  | { ok: true; state: GameState }
  | { ok: false; message: string; error: unknown };

export interface CreateInitialGameOptions {
  /** 房规「放弃购买即拍卖」（#106）；不传 = false = 沿用既有「放弃即流拍」。 */
  auctionOnDecline?: boolean;
  /**
   * 房规「现金目标」（#23 ③ / 待-5 剩余）；不传 = `null` = 关闭。
   *
   * 与 `auctionOnDecline` 一样属于**对局级**选项：写进 `GameState.cashGoal` 后由引擎驱动，
   * 之后改房间设置不再影响这一局。引擎侧（`createGame`）已硬校验
   * `cashGoal > config.initialCash`——这里不做二次校验，只负责原样透传，
   * 房间层在 `RoomManager.updateRoomSettings` 已按**生效**初始资金拦过一次。
   */
  cashGoal?: number | null;
}

export function createInitialGame(
  gateway: GameRuntimeGateway,
  players: { id: string; nickname: string; isBot: boolean }[],
  seed: string,
  board: DeepReadonly<BoardData>,
  cards: DeepReadonly<CardsData>,
  config: DeepReadonly<GameConfig>,
  mapRef: MapRef,
  ruleModules: readonly RuleModuleRef[],
  options: CreateInitialGameOptions = {},
): CreateInitialGameResult {
  try {
    return {
      ok: true,
      state: gateway.createGame({
        board,
        cards,
        config,
        mapRef,
        ruleModules,
        players,
        seed,
        cashGoal: options.cashGoal ?? null,
        auctionOnDecline: options.auctionOnDecline ?? false,
      }),
    };
  } catch (error) {
    return { ok: false, message: 'Unable to start the game with the current room players.', error };
  }
}

export type GameApplyOutcome =
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; code: ErrorCode; error?: unknown };

export function applyGameIntent(
  gateway: GameRuntimeGateway,
  state: GameState,
  playerId: string,
  intent: Intent,
): GameApplyOutcome {
  if (intent.type === 'module' && !isAuthorizedModuleIntent(state, playerId, intent)) {
    return { ok: false, code: 'ILLEGAL_INTENT' };
  }
  let result: ApplyResult;
  try {
    result = gateway.applyIntent(state, playerId, intent);
  } catch (error) {
    return { ok: false, code: 'ILLEGAL_INTENT', error };
  }

  if (!result.ok) return { ok: false, code: result.code };
  return { ok: true, state: result.state, events: result.events };
}

export function skipOfflineTakeoverTurn(state: GameState, playerId: string): GameApplyOutcome {
  try {
    const result = skipCurrentTurn(state, playerId);
    return result.ok
      ? { ok: true, state: result.state, events: result.events }
      : { ok: false, code: result.code };
  } catch (error) {
    return { ok: false, code: 'ILLEGAL_INTENT', error };
  }
}

const TAKEOVER_POLICY: Record<GameState['turnPhase'], Intent> = {
  awaiting_roll: { type: 'roll_dice' },
  awaiting_airport_roll: { type: 'roll_airport_branch' },
  awaiting_buy_decision: { type: 'skip_buy' },
  awaiting_build_decision: { type: 'skip_build' },
  managing: { type: 'end_turn' },
  // 议价阶段由 chooseTakeoverIntent 提前交给 bot 策略处理（见那里的说明），下面两条只是
  // 兜底：`Record<TurnPhase, Intent>` 必须穷尽，这样将来再加阶段时编译器会当场拦住我们。
  awaiting_trade_response: { type: 'cancel_trade' },
  awaiting_auction_bid: { type: 'pass_bid' },
};

export function chooseTakeoverIntent(state: GameState, difficulty: BotDifficulty = 'normal'): Intent | null {
  // 债务阶段：`turnPhase` 此时通常仍是 `managing`，但按阶段查表会发出 `end_turn`，
  // 而欠债时的 end_turn 必然吃 WRONG_PHASE。清偿（卖房 → 抵押 → 卖地 → 宣告破产）
  // 只有 bot 策略会做，所以这里必须提前交给它。
  // 不处理的话，离线真人一旦欠债就再也没人推进——房间停在「零计时器、零服务端错误」，
  // 正是本项目最熟悉的那类静默冻结（整局冒烟已复现：拍卖把电脑现金掏空后立刻欠租）。
  if (state.debt !== null) {
    return chooseBotIntent(state, state.debt.debtorId, defaultRuleModuleRegistry, difficulty);
  }

  // 议价阶段（#105 / #106）：合法行动者不是 currentPlayerId（交易 = 报价目标、拍卖 = 轮到的叫价者），
  // 所以按阶段查表的 TAKEOVER_POLICY 模型在这里不成立。一律交给 bot 策略 ——
  // 它对这两个阶段一定产出明确答复（同意/拒绝、撤回；出价/弃权），保证回合必然收敛。
  // 与「世界巡游机场等待」那次事故同理：这里绝不能返回 null（null 会被当作离线跳过）。
  if (state.turnPhase === 'awaiting_trade_response' || state.turnPhase === 'awaiting_auction_bid') {
    const trade = currentPendingTrade(state);
    const auction = currentPendingAuction(state);
    const actorId = state.turnPhase === 'awaiting_trade_response'
      ? trade?.targetId ?? state.currentPlayerId
      : auction?.bidderId ?? state.currentPlayerId;
    return chooseBotIntent(state, actorId, defaultRuleModuleRegistry, difficulty);
  }

  // 待选动作只可能由规则模块产生（core 从不产生 pendingActions），所以这里按「当前玩家 +
  // 当前阶段」筛选**任何模块**的待选动作，而不是只认某一个模块 id。
  //
  // 为什么不能写死模块 id：历史上这里只匹配 world-tour@1，于是其它模块（如 great-wall@1 的
  // 烽火台 beacon-choice）的待选动作会被整体过滤掉，落入下面的 TAKEOVER_POLICY。而挂起待选动作时
  // turnPhase 通常是 `managing`，策略返回的是 end_turn —— 既不解决选项（选项滞留、该模块的机制
  // 对该玩家永久失效），又把回合草草推给下一个人。
  const pendingActions = state.publicRuleState.pendingActions.filter((action) => (
    action.playerId === state.currentPlayerId
    && action.requiredPhase === state.turnPhase
  ));
  // 托管（离线接管）玩家与电脑玩家采用同一决策：世界巡游模块的待选动作（机场入口
  // enter-airport-branch / 支线掷骰 roll-branch、短/长途航班、巴士、免费升级）一律交给 bot
  // 策略产出对应意图，使其能正常推进。
  //
  // 为什么不在这里返回 null（历史上曾如此）：roomManager 对「null + offline_takeover」的处理是
  // skipCurrentTurn —— 只跳过这一回合、不消费 pendingAirportByPlayerId、玩家仍留在机场格上。
  // 于是一个长期离线的玩家会被「每回合跳过」，永远停在机场格不再移动（整局冒烟验证：回合数已到
  // 626 仍未终局），并且这种反复的跳过/重排会与自动化重建路径交错，最终在某个回合出现
  // 「没有任何活跃计时器、也没有服务端错误」的静默硬冻结——正是线上「一直提示某人行动中、
  // 无法掷骰子」的形态。交给 bot 策略后，棋子会走进支线并继续正常移动，对局必然收敛。
  if (pendingActions.length > 0) return chooseBotIntent(state, state.currentPlayerId, defaultRuleModuleRegistry, difficulty);
  return TAKEOVER_POLICY[state.turnPhase];
}
