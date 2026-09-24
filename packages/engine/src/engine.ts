// 规则引擎核心：createGame / applyIntent（03 §4）
// 纯函数、确定性、无副作用——可被穷举测试、可在浏览器和服务器两边跑
import type {
  BoardData,
  CardsData,
  DeepReadonly,
  GameConfig,
  MapRef,
  RuleModuleRef,
} from '@richman/board-data';
import type {
  GameState, PlayerState, PlayerColor, PropertyState, DebtResumeState,
  Intent, ApplyResult, GameEvent,
} from './types';
import { hashSeed, shuffle, rollDice, rollSingleDice } from './rng';
import { walkPath } from './movement';
import { applyCardEffect, resolveLanding } from './effects';
import { processQueuedPayments } from './payments';
import { finishCashGoalIfReached } from './victory';
import { defaultRuleModuleRegistry, type RuleModuleRegistry } from './moduleRegistry';
import { advanceToNextPlayableTurn } from './turns';
import {
  currentPendingAuction,
  currentPendingTrade,
  handleCancelTrade,
  handlePassBid,
  handlePlaceBid,
  handleProposeTrade,
  handleRespondTrade,
  reconcileBargainAfterDeparture,
  startAuction,
} from './bargain';

export interface CreateGameInput {
  board: DeepReadonly<BoardData>;
  cards: DeepReadonly<CardsData>;
  config: DeepReadonly<GameConfig>;
  mapRef: MapRef;
  ruleModules: readonly RuleModuleRef[];
  players: readonly { id: string; nickname: string; isBot?: boolean }[]; // 按输入座次
  seed: string;
  cashGoal?: number | null;
  /** 单机真人抽卡确认（作弊重抽）：仅本地会话传入；不传 = 原有立即结算，联机/电脑玩家不受影响。 */
  cardChoiceMode?: 'local-human';
  /** 房规「放弃购买即拍卖」（#106）：不传 = false = 沿用既有「无拍卖」行为。 */
  auctionOnDecline?: boolean;
}

const SEAT_COLORS: PlayerColor[] = ['red', 'blue', 'yellow', 'green', 'purple', 'orange'];

function copyMapRef(mapRef: MapRef): MapRef {
  return Object.freeze({
    id: mapRef.id,
    version: mapRef.version,
    contentHash: mapRef.contentHash,
  });
}

function copyRuleModules(ruleModules: readonly RuleModuleRef[]): readonly RuleModuleRef[] {
  return Object.freeze(ruleModules.map((module) => Object.freeze({
    id: module.id,
    version: module.version,
  })));
}

function deepCloneAndFreeze<T>(value: T): DeepReadonly<T> {
  const clone = structuredClone(value);
  const freeze = (current: unknown): void => {
    if (current === null || typeof current !== 'object' || Object.isFrozen(current)) return;
    for (const child of Object.values(current)) freeze(child);
    Object.freeze(current);
  };
  freeze(clone);
  return clone as DeepReadonly<T>;
}

/** 决定座次：每人掷一次骰子，点数大者先行；同点者组内复掷直至唯一（01 §3）
 *  关键：复掷只决定同点组内的相对顺序，不影响与非同点玩家的档位 */
function resolveOrder(
  initialRolls: { idx: number; sum: number }[],
  state: number,
): { order: number[]; state: number } {
  const arr = [...initialRolls].sort((a, b) => b.sum - a.sum || a.idx - b.idx);
  let s = state;
  // 递归处理同点子组：只组内复掷 + 组内重排，绝不越过非同点玩家
  const resolveGroup = (start: number, end: number) => {
    if (start >= end) return;
    // 找组内第一个同点子组
    let i = start;
    while (i < end && arr[i].sum !== arr[i + 1].sum) i++;
    if (i >= end) return; // 组内已全唯一
    let j = i + 1;
    while (j + 1 <= end && arr[j + 1].sum === arr[i].sum) j++;
    // 子组 [i, j] 内复掷
    for (let k = i; k <= j; k++) {
      const [dice, ns] = rollDice(s);
      s = ns;
      arr[k] = { idx: arr[k].idx, sum: dice[0] + dice[1] };
    }
    // 只在子组 [i, j] 内重排（不动组外顺序）
    const seg = arr.slice(i, j + 1).sort((a, b) => b.sum - a.sum || a.idx - b.idx);
    for (let k = i; k <= j; k++) arr[k] = seg[k - i];
    // 复掷后可能产生新的同点子组，递归处理
    resolveGroup(i, j);
    // 继续处理组内后续可能的同点子组
    resolveGroup(j + 1, end);
  };
  resolveGroup(0, arr.length - 1);
  return { order: arr.map((r) => r.idx), state: s };
}

export function createGame(input: CreateGameInput): GameState {
  const {
    mapRef: inputMapRef,
    ruleModules: inputRuleModules,
    players: inputPlayers,
    seed,
    cashGoal = null,
  } = input;
  const board = deepCloneAndFreeze(input.board);
  const cards = deepCloneAndFreeze(input.cards);
  const config = deepCloneAndFreeze(input.config);
  const mapRef = copyMapRef(inputMapRef);
  const ruleModules = copyRuleModules(inputRuleModules);

  if (inputPlayers.length < 2 || inputPlayers.length > 6) {
    throw new Error(`createGame: 玩家数须 2-6，实为 ${inputPlayers.length}`);
  }

  if (cashGoal !== null && cashGoal <= config.initialCash) {
    throw new Error(`createGame: 现金目标须大于初始资金（${config.initialCash}），实为 ${cashGoal}`);
  }

  let state = hashSeed(seed);

  // 1. 收集玩家基础信息（颜色待定序后按座次分配，02 §4.2 / 03 §4.1）
  const basePlayers = inputPlayers.map((p) => ({
    id: p.id,
    nickname: p.nickname,
    isBot: p.isBot ?? false,
  }));

  // 2. 决定座次（01 §3：每人掷一次，点数大者先行，同点者复掷）
  const initialRolls: { idx: number; sum: number }[] = [];
  for (let i = 0; i < basePlayers.length; i++) {
    const [dice, s] = rollDice(state);
    state = s;
    initialRolls.push({ idx: i, sum: dice[0] + dice[1] });
  }
  const { order, state: stateAfterOrder } = resolveOrder(initialRolls, state);
  state = stateAfterOrder;

  // 按定序后座次分配颜色 + 组装 PlayerState
  const players: PlayerState[] = order.map((origIdx, seat) => ({
    id: basePlayers[origIdx].id,
    nickname: basePlayers[origIdx].nickname,
    color: SEAT_COLORS[seat],
    isBot: basePlayers[origIdx].isBot,
    cash: config.initialCash,
    position: 0,
    skipTurns: 0,
    bankrupt: false,
    bankruptTurn: null,
    online: true,
  }));

  // 3. 牌堆洗乱（01 §9：开局各自洗乱；抽顶补底）
  const [shuffledChance, s1] = shuffle(
    cards.chance.map((c) => c.id),
    state,
  );
  const [shuffledDestiny, s2] = shuffle(
    cards.destiny.map((c) => c.id),
    s1,
  );
  state = s2;

  // 4. 地产初始化（全部无主、level 0、未抵押）
  const properties: Record<number, PropertyState> = {};
  for (const cell of board.cells) {
    if (cell.type === 'property') {
      properties[cell.id] = { ownerId: null, level: 0, mortgaged: false };
    }
  }

  // 5. 构造初始 GameState
  return {
    mapRef,
    ruleModules,
    publicRuleState: { modules: {}, pendingActions: [] },
    seed: String(state), // 后续 applyIntent 从此 state 继续推进掷骰
    turn: 1,
    phase: 'playing',
    turnPhase: 'awaiting_roll',
    currentPlayerId: players[0].id,
    players,
    properties,
    decks: { chance: shuffledChance, destiny: shuffledDestiny },
    debt: null,
    // 交易 / 拍卖（#105 / #106）：显式落成 null / false，让 createGame 产出的状态是完整形状，
    // 不依赖「读的时候再 ?? null」（缺省仍被 hydrate 接受，见那里对可选键的处理）。
    pendingTrade: null,
    pendingAuction: null,
    auctionOnDecline: input.auctionOnDecline ?? false,
    lastDice: null,
    recentLog: [{ type: 'game_started' }],
    winnerId: null,
    cashGoal,
    ...(input.cardChoiceMode === 'local-human' ? { cardChoice: { mode: 'local-human' as const, pending: null } } : {}),
    board,
    cards,
    config,
  };
}

export function applyIntent(
  state: GameState,
  playerId: string,
  intent: Intent,
  registry: RuleModuleRegistry = defaultRuleModuleRegistry,
): ApplyResult {
  // 全局校验
  if (state.phase !== 'playing') return { ok: false, code: 'WRONG_PHASE' };

  // 「本阶段谁才是合法行动者」：正常是 currentPlayerId；但交易等待阶段要由**报价目标**答复、
  // 拍卖阶段要由**轮到的叫价者**出价，二者都不是 currentPlayerId。这是引擎里仅有的两处例外，
  // 集中在这里判断，避免散落到各个 handler 里导致「谁能动」这件事出现两个真相。
  const pendingTrade = currentPendingTrade(state);
  const pendingAuction = currentPendingAuction(state);
  const isTradePhase = state.turnPhase === 'awaiting_trade_response' && pendingTrade !== null;
  const isAuctionPhase = state.turnPhase === 'awaiting_auction_bid' && pendingAuction !== null;
  const activePlayerId = isTradePhase
    ? pendingTrade!.targetId
    : isAuctionPhase
      ? pendingAuction!.bidderId
      : state.currentPlayerId;
  // 发起者本人撤回自己的报价也算合法（否则对手离线时这个回合只能靠超时机制救）。
  const isProposerCancelling = isTradePhase
    && intent.type === 'cancel_trade'
    && playerId === pendingTrade!.proposerId;

  // 投降不受“是否轮到该玩家 / 是否处于债务态”限制：任何仍在局的玩家都能随时认输出局。
  if (state.debt) {
    if (playerId !== state.debt.debtorId && intent.type !== 'surrender') return { ok: false, code: 'NOT_YOUR_TURN' };
  } else if (playerId !== activePlayerId && !isProposerCancelling && intent.type !== 'surrender') {
    return { ok: false, code: 'NOT_YOUR_TURN' };
  }

  // 单机真人作弊：待确认卡牌存在时冻结其他一切操作，只接受重抽/接受；投降可随时发动。
  const pendingCardChoice = state.cardChoice?.pending;
  if (pendingCardChoice) {
    if (intent.type === 'surrender') {
      // 允许：投降不受待确认卡牌冻结限制。
    } else if (playerId !== pendingCardChoice.playerId) {
      return { ok: false, code: 'NOT_YOUR_TURN' };
    } else if (intent.type !== 'redraw_card' && intent.type !== 'accept_card') {
      return { ok: false, code: 'WRONG_PHASE' };
    }
  } else if (intent.type === 'redraw_card' || intent.type === 'accept_card') {
    // 联机与电脑玩家从不产生 pending，因此这两个意图在默认流程里始终非法。
    return { ok: false, code: 'WRONG_PHASE' };
  }

  // 模块待选动作存在时，非匹配的意图一律非法；投降例外（不受模块流程阻挡）。
  if (intent.type !== 'surrender' && state.publicRuleState.pendingActions.length > 0) {
    const pending = state.publicRuleState.pendingActions.find((action) => (
      intent.type === 'module'
      && action.playerId === playerId
      && action.requiredPhase === state.turnPhase
      && action.module.id === intent.module.id
      && action.module.version === intent.module.version
      && action.action === intent.action
      && deepEqualJson(action.payload, intent.payload)
    ));
    if (!pending) return { ok: false, code: 'WRONG_PHASE' };
  }

  // 债务状态：冻结正常流程，只能卖房/卖地/破产/投降（01 §11；步 9 完整实现筹款）
  if (state.debt) {
    switch (intent.type) {
      case 'sell_house':
      case 'sell_property':
      case 'mortgage_property':
      case 'declare_bankrupt':
      case 'surrender':
        break; // 允许，继续到下面的 switch 处理
      default:
        return { ok: false, code: 'WRONG_PHASE' };
    }
  }

  const handler = registry.getIntentHandler(state.ruleModules, intent);
  if (!handler) return { ok: false, code: 'ILLEGAL_INTENT' };

  const result = handler.handle({ state, playerId, intent, registry, applyCore: () => {
    switch (intent.type) {
    case 'roll_dice':
      return handleRollDice(state, playerId, registry);
    case 'roll_airport_branch':
      return handleAirportBranchRoll(state, playerId, registry);
    case 'buy_property':
      return handleBuyProperty(state, playerId);
    case 'skip_buy':
      return handleSkipBuy(state, playerId);
    case 'build_house':
      return handleBuildHouse(state, playerId);
    case 'skip_build':
      return handleSkipBuild(state, playerId);
    case 'sell_house':
      return handleSellHouse(state, playerId, intent);
    case 'sell_property':
      return handleSellProperty(state, playerId, intent);
    case 'mortgage_property':
      return handleMortgageProperty(state, playerId, intent);
    case 'redeem_property':
      return handleRedeemProperty(state, playerId, intent);
    case 'end_turn':
      return handleEndTurn(state, playerId);
    case 'declare_bankrupt':
      return handleDeclareBankrupt(state, playerId);
    case 'surrender':
      return handleSurrender(state, playerId);
    case 'redraw_card':
      return handleRedrawCard(state, playerId);
    case 'accept_card':
      return handleAcceptCard(state, playerId, registry);
    case 'propose_trade':
      return handleProposeTrade(state, playerId, intent);
    case 'respond_trade':
      return handleRespondTrade(state, playerId, intent);
    case 'cancel_trade':
      return handleCancelTrade(state, playerId);
    case 'place_bid':
      return handlePlaceBid(state, playerId, intent);
    case 'pass_bid':
      return handlePassBid(state, playerId);
    default:
      return { ok: false, code: 'ILLEGAL_INTENT' };
    }
  } });

  if (!result.ok) return result;
  const stabilized = stabilizeAutomaticBankruptcies(result, state);
  const finalized = finalizeWinConditions(stabilized, state);
  const transitioned = registry.runPostTransitionHooks(state.ruleModules, {
    previousState: state,
    playerId,
    intent,
    result: finalized,
    registry,
  });
  return transitioned;
}

/**
 * 跳过当前玩家的一次行动，不掷骰、不消费待选动作，也不推进随机数。
 * 服务器只在 owner 已批准的离线托管流程中调用；规则模块仍通过统一 hook 同步公开状态。
 */
export function skipCurrentTurn(
  state: GameState,
  playerId: string,
  registry: RuleModuleRegistry = defaultRuleModuleRegistry,
): ApplyResult {
  if (state.phase !== 'playing' || state.debt !== null || state.cardChoice?.pending != null) {
    return { ok: false, code: 'WRONG_PHASE' };
  }
  if (state.currentPlayerId !== playerId) return { ok: false, code: 'NOT_YOUR_TURN' };

  const advanced = advanceToNextPlayableTurn(state, playerId, []);
  const result: ApplyResult = {
    ok: true,
    state: {
      ...advanced.state,
      recentLog: [...state.recentLog, ...advanced.events].slice(-200),
    },
    events: advanced.events,
  };
  return registry.runPostTransitionHooks(state.ruleModules, {
    previousState: state,
    playerId,
    intent: { type: 'end_turn' },
    result,
    registry,
  });
}

function deepEqualJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => deepEqualJson(value, right[index]));
  }
  if (typeof left !== 'object' || left === null || Array.isArray(left)
    || typeof right !== 'object' || right === null || Array.isArray(right)) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index] && deepEqualJson(leftRecord[key], rightRecord[key])
    ));
}

function hasLegalFundraisingAction(state: GameState, playerId: string): boolean {
  for (const cell of state.board.cells) {
    if (cell.type !== 'property') continue;
    const property = state.properties[cell.id];
    if (!property || property.ownerId !== playerId) continue;
    if (cell.subtype === 'normal' && property.level > 0) return true;
    if (property.level === 0 && !property.mortgaged) return true;
  }
  return false;
}

function stabilizeAutomaticBankruptcies(
  result: Extract<ApplyResult, { ok: true }>,
  previousState: GameState,
): Extract<ApplyResult, { ok: true }> {
  let state = result.state;
  let events = result.events;

  while (state.phase === 'playing' && state.debt && !hasLegalFundraisingAction(state, state.debt.debtorId)) {
    const bankruptcy = handleDeclareBankrupt(
      { ...state, recentLog: previousState.recentLog },
      state.debt.debtorId,
    );
    if (!bankruptcy.ok) break;
    state = bankruptcy.state;
    events = [...events, ...bankruptcy.events];
  }

  return {
    ok: true,
    state: { ...state, recentLog: [...previousState.recentLog, ...events].slice(-200) },
    events,
  };
}

function alivePlayers(state: GameState): PlayerState[] {
  return state.players.filter((p) => !p.bankrupt);
}

function finalizeWinConditions(result: Extract<ApplyResult, { ok: true }>, previousState: GameState): ApplyResult {
  if (result.state.phase === 'game_over') return result;

  const alive = alivePlayers(result.state);
  if (alive.length === 1) {
    const event: GameEvent = { type: 'game_over', winnerId: alive[0].id, reason: 'last_standing' };
    return {
      ok: true,
      state: {
        ...result.state,
        phase: 'game_over',
        winnerId: alive[0].id,
        recentLog: [...previousState.recentLog, ...result.events, event].slice(-200),
      },
      events: [...result.events, event],
    };
  }

  // cash_goal 兜底（正常情况下各现金增加点已即时短路；此处仅防御性补漏）
  // 必须跳过未清债务（E18：债务优先，卖产临时达标不算获胜）
  if (result.state.cashGoal !== null && result.state.debt === null) {
    const winner = result.state.players.find((p) => !p.bankrupt && p.cash >= result.state.cashGoal!);
    if (winner) {
      const event: GameEvent = { type: 'game_over', winnerId: winner.id, reason: 'cash_goal' };
      return {
        ok: true,
        state: {
          ...result.state,
          phase: 'game_over',
          winnerId: winner.id,
          recentLog: [...previousState.recentLog, ...result.events, event].slice(-200),
        },
        events: [...result.events, event],
      };
    }
  }

  return result;
}

function clearPlayerProperties(state: GameState, playerId: string): GameState['properties'] {
  const properties = { ...state.properties };
  for (const [cellId, prop] of Object.entries(properties)) {
    if (prop.ownerId === playerId) {
      properties[Number(cellId)] = { ownerId: null, level: 0, mortgaged: false };
    }
  }
  return properties;
}

function payDebtIfPossible(state: GameState, events: GameEvent[]): { state: GameState; events: GameEvent[] } {
  if (!state.debt) return { state, events };
  const debt = state.debt;
  const debtor = state.players.find((p) => p.id === debt.debtorId);
  if (!debtor || debtor.cash < debt.amount) return { state, events };
  const players = state.players.map((p) => {
    if (p.id === debt.debtorId) return { ...p, cash: p.cash - debt.amount };
    if (debt.creditorId && p.id === debt.creditorId) return { ...p, cash: p.cash + debt.amount };
    return p;
  });
  const resolvedEvents: GameEvent[] = [...events, { type: 'debt_resolved', amount: debt.amount, creditorId: debt.creditorId }];
  const stateAfterDebt = { ...state, players, debt: null, turnPhase: 'managing' as const };
  // E18：债主收到钱后现金达标 → 立即终局，不再继续排队付款
  const cashGoalWin = finishCashGoalIfReached(stateAfterDebt, resolvedEvents);
  if (cashGoalWin) return { state: cashGoalWin.state, events: cashGoalWin.events };
  if (debt.resume?.payments.length) {
    const queued = processQueuedPayments(stateAfterDebt, debt.resume.payments, resolvedEvents);
    return { state: { ...queued.state, debt: queued.newDebt, turnPhase: queued.newDebt ? 'managing' : queued.state.turnPhase }, events: queued.events };
  }
  return { state: stateAfterDebt, events: resolvedEvents };
}

/** 一次掷骰 + 沿 next 移动：返回骰子、逐格路径、是否过起点、终点、推进后的 rngState */
function rollAndMove(
  board: GameState['board'],
  startPos: number,
  rngState: number,
): {
  dice: [number, number];
  path: number[];
  crossedStart: boolean;
  finalCellId: number;
  rngState: number;
} {
  const [dice, s] = rollDice(rngState);
  const steps = dice[0] + dice[1];
  const { path, crossedStart, finalCellId } = walkPath(board, startPos, steps);
  return { dice, path, crossedStart, finalCellId, rngState: s };
}

/** 处理 roll_dice：掷骰 → 沿 next 移动 → 经过/停留起点领工资 → 落点分流
 *  E22（01 §5.1）：停留机场 → 停在机场，等待玩家显式再掷一颗机场支线骰 */
function handleRollDice(
  state: GameState,
  playerId: string,
  registry: RuleModuleRegistry,
): ApplyResult {
  if (state.turnPhase !== 'awaiting_roll') return { ok: false, code: 'WRONG_PHASE' };

  const player = state.players.find((p) => p.id === playerId);
  if (!player) return { ok: false, code: 'ILLEGAL_INTENT' };

  let events: GameEvent[] = [];
  let rngState = Number(state.seed);
  let cash = player.cash;
  let position = player.position;
  let lastDice: number[] | null = null;

  const applyRoll = (startPos: number) => {
    const r = rollAndMove(state.board, startPos, rngState);
    rngState = r.rngState;
    position = r.finalCellId;
    lastDice = r.dice;
    events.push({ type: 'dice_rolled', playerId, dice: r.dice });
    events.push({ type: 'token_moved', playerId, path: r.path });
    if (r.crossedStart) {
      cash += state.config.passStartSalary;
      events.push({ type: 'salary_collected', playerId, amount: state.config.passStartSalary });
    }
  };

  // 第一次掷骰
  applyRoll(position);

  // E22：停留机场 → 本次操作停在机场，等待玩家下一次显式 roll_airport_branch。
  // 经过机场不触发，仅停留触发（01 §5.1 定案）。
  const landed = state.board.cells.find((c) => c.id === position);

  // 把移动与经过起点工资应用到玩家，再统一走落点结算（地产/税/卡牌/特殊/世界）。
  const intermediatePlayers = state.players.map((p) => {
    if (p.id === playerId) return { ...p, position, cash };
    return p;
  });
  const workingState: GameState = {
    ...state,
    players: intermediatePlayers,
    seed: String(rngState),
    lastDice,
  };
  // E18：经过起点领工资使现金达标 → 立即终局，不再继续落点扣租/触发债务
  // 仅在本次确实领过工资（现金增加点）检查；否则不因"开局已达标"误判
  if (events.some((e) => e.type === 'salary_collected')) {
    const cashGoalWin = finishCashGoalIfReached(workingState, events);
    if (cashGoalWin) {
      return {
        ok: true,
        state: { ...cashGoalWin.state, recentLog: [...state.recentLog, ...cashGoalWin.events].slice(-200) },
        events: cashGoalWin.events,
      };
    }
  }
  if (landed?.type === 'airport') {
    return {
      ok: true,
      state: {
        ...workingState,
        turnPhase: 'awaiting_airport_roll',
        recentLog: [...state.recentLog, ...events].slice(-200),
      },
      events,
    };
  }
  const settled = resolveLanding(workingState, playerId, events, 0, registry);
  events = settled.events;

  const newState: GameState = {
    ...settled.state,
    debt: settled.newDebt,
    recentLog: [...state.recentLog, ...events].slice(-200),
  };

  return { ok: true, state: newState, events };
}

/** 处理 roll_airport_branch：机场等待阶段显式再掷一颗骰，首尔为第 1 步进入支线 */
function handleAirportBranchRoll(
  state: GameState,
  playerId: string,
  registry: RuleModuleRegistry,
): ApplyResult {
  if (state.turnPhase !== 'awaiting_airport_roll') return { ok: false, code: 'WRONG_PHASE' };

  const player = state.players.find((p) => p.id === playerId);
  if (!player) return { ok: false, code: 'ILLEGAL_INTENT' };

  const airport = state.board.cells.find((c) => c.id === player.position);
  if (airport?.type !== 'airport') return { ok: false, code: 'ILLEGAL_INTENT' };

  let rngState = Number(state.seed);
  const [d, s] = rollSingleDice(rngState);
  rngState = s;

  // 路径语义：首尔(branchEntryId)是第 1 步落点，再走"点数-1"步（掷 1 正好停首尔）
  const branchEntry = airport.branchEntryId;
  const walk = walkPath(state.board, branchEntry, d - 1);
  const branchPath = [branchEntry, ...walk.path];
  const events: GameEvent[] = [
    { type: 'dice_rolled', playerId, dice: [d] },
    { type: 'token_moved', playerId, path: branchPath },
  ];

  const workingState: GameState = {
    ...state,
    players: state.players.map((p) => (p.id === playerId ? { ...p, position: walk.finalCellId } : p)),
    seed: String(rngState),
    lastDice: [d],
  };

  const settled = resolveLanding(workingState, playerId, events, 0, registry);

  const newState: GameState = {
    ...settled.state,
    debt: settled.newDebt,
    recentLog: [...state.recentLog, ...settled.events].slice(-200),
  };

  return { ok: true, state: newState, events: settled.events };
}

/** 处理 redraw_card：放弃待确认卡（留在堆底不动），从同一牌堆抽下一张继续等待（不限次数） */
function handleRedrawCard(state: GameState, playerId: string): ApplyResult {
  const choice = state.cardChoice;
  const pending = choice?.pending;
  if (!choice || !pending || pending.playerId !== playerId) return { ok: false, code: 'WRONG_PHASE' };

  const deck = pending.deck;
  const queue = state.decks[deck];
  if (queue.length === 0) return { ok: false, code: 'ILLEGAL_INTENT' }; // 数据异常兜底：正常牌堆不会为空

  // 抽顶放回堆底：被放弃的卡上一轮抽到时已移到堆底，这里只继续轮转。
  const nextCardId = queue[0];
  const events: GameEvent[] = [{ type: 'card_drawn', playerId, deck, cardId: nextCardId }];
  const newState: GameState = {
    ...state,
    decks: { ...state.decks, [deck]: [...queue.slice(1), nextCardId] },
    // 重抽只是换一张待确认卡：效果进入阶段沿用原值（环境没有变化）。
    cardChoice: {
      mode: choice.mode,
      pending: { playerId, deck, cardId: nextCardId, resumeTurnPhase: pending.resumeTurnPhase },
    },
    recentLog: [...state.recentLog, ...events].slice(-200),
  };
  return { ok: true, state: newState, events };
}

/** 处理 accept_card：执行待确认卡牌的效果并清除 pending（效果只执行一次；连锁抽卡会再次暂停） */
function handleAcceptCard(state: GameState, playerId: string, registry: RuleModuleRegistry): ApplyResult {
  const choice = state.cardChoice;
  const pending = choice?.pending;
  if (!choice || !pending || pending.playerId !== playerId) return { ok: false, code: 'WRONG_PHASE' };

  const card = state.cards[pending.deck].find((candidate) => candidate.id === pending.cardId);
  if (!card) return { ok: false, code: 'ILLEGAL_INTENT' };

  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) return { ok: false, code: 'ILLEGAL_INTENT' };

  const beforePos = player.position;
  const events: GameEvent[] = [];
  // 先清空 pending：连锁抽卡（draw_card / 移动后落到卡格）会在同一结算里重新写入新的 pending。
  // 同时恢复效果进入时的环境阶段，使被接受卡牌的 applyCardEffect 输入与默认模式完全一致
  // （提前终局等早退路径会读回该阶段）；对外暴露的暂停阶段仍是 managing。
  const cleared: GameState = {
    ...state,
    turnPhase: pending.resumeTurnPhase,
    cardChoice: { mode: choice.mode, pending: null },
  };
  const applied = applyCardEffect(cleared, playerId, card, events, 0, registry);
  const afterPos = applied.state.players.find((candidate) => candidate.id === playerId)?.position ?? beforePos;
  const pausedAgain = applied.state.cardChoice?.pending != null;
  const turnPhase: GameState['turnPhase'] = pausedAgain || afterPos === beforePos
    ? 'managing'
    : applied.state.turnPhase;

  const newState: GameState = {
    ...applied.state,
    turnPhase,
    debt: applied.newDebt,
    recentLog: [...state.recentLog, ...applied.events].slice(-200),
  };
  return { ok: true, state: newState, events: applied.events };
}

/** 处理 buy_property：扣地价、设所有者、转 managing（01 §6.2） */
function handleBuyProperty(state: GameState, playerId: string): ApplyResult {
  if (state.turnPhase !== 'awaiting_buy_decision') return { ok: false, code: 'WRONG_PHASE' };
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return { ok: false, code: 'ILLEGAL_INTENT' };
  const cell = state.board.cells.find((c) => c.id === player.position);
  if (!cell || cell.type !== 'property') return { ok: false, code: 'ILLEGAL_INTENT' };
  const prop = state.properties[player.position];
  if (!prop || prop.ownerId) return { ok: false, code: 'ILLEGAL_INTENT' }; // 已有主或非地产

  if (player.cash < cell.price) return { ok: false, code: 'INSUFFICIENT_FUNDS' };

  const events: GameEvent[] = [
    { type: 'property_bought', playerId, cellId: player.position, price: cell.price },
  ];
  const newState: GameState = {
    ...state,
    players: state.players.map((p) =>
      p.id === playerId ? { ...p, cash: p.cash - cell.price } : p,
    ),
    properties: {
      ...state.properties,
      [player.position]: { ...prop, ownerId: playerId },
    },
    turnPhase: 'managing',
    recentLog: [...state.recentLog, ...events].slice(-200),
  };
  return { ok: true, state: newState, events };
}

/** 处理 skip_buy：放弃购买，地产保持无主，转 managing（01 §6.2：无拍卖）
 *  房规开启「放弃购买即拍卖」（#106）时改走拍卖：全场按座次轮流叫价，流拍则保持无主。 */
function handleSkipBuy(state: GameState, playerId: string): ApplyResult {
  if (state.turnPhase !== 'awaiting_buy_decision') return { ok: false, code: 'WRONG_PHASE' };
  const events: GameEvent[] = [{ type: 'buy_declined' }];

  if (state.auctionOnDecline === true) {
    const player = state.players.find((p) => p.id === playerId);
    const cell = player === undefined ? undefined : state.board.cells.find((c) => c.id === player.position);
    const property = player === undefined ? undefined : state.properties[player.position];
    // 只有「无主的真实地产」才谈得上拍卖；其余情况静默退回既有行为。
    if (player !== undefined && cell?.type === 'property' && property !== undefined && property.ownerId === null) {
      return startAuction(state, player.position, playerId, events);
    }
  }

  return {
    ok: true,
    state: {
      ...state,
      turnPhase: 'managing',
      recentLog: [...state.recentLog, ...events].slice(-200),
    },
    events,
  };
}

/** 处理 build_house：停留自己 normal 地产上可盖一幢（01 §6.3 核心特色）
 *  - 仅 normal 可盖（车站/特殊地皮不可）
 *  - 一次停留仅一幢（E04）：盖完即转 managing，不能连盖
 *  - 满级 5（旅馆）不可再盖（E03）
 *  - 抵押中不可盖（E05，K8）：须先赎回（阶段 3） */
function handleBuildHouse(state: GameState, playerId: string): ApplyResult {
  if (state.turnPhase !== 'awaiting_build_decision') return { ok: false, code: 'WRONG_PHASE' };
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return { ok: false, code: 'ILLEGAL_INTENT' };
  const cell = state.board.cells.find((c) => c.id === player.position);
  if (!cell || cell.type !== 'property' || cell.subtype !== 'normal') {
    return { ok: false, code: 'ILLEGAL_INTENT' }; // 仅普通地皮可盖
  }
  const prop = state.properties[player.position];
  if (!prop || prop.ownerId !== playerId) return { ok: false, code: 'ILLEGAL_INTENT' };
  if (prop.mortgaged) return { ok: false, code: 'ILLEGAL_INTENT' }; // E05 抵押中不可盖
  if (prop.level >= state.config.maxHouseLevel) return { ok: false, code: 'ILLEGAL_INTENT' }; // E03 满级

  const houseCost = cell.houseCost!;
  if (player.cash < houseCost) return { ok: false, code: 'INSUFFICIENT_FUNDS' };

  const newLevel = prop.level + 1;
  const events: GameEvent[] = [{ type: 'house_built', cellId: player.position, level: newLevel, amount: houseCost }];
  const newState: GameState = {
    ...state,
    players: state.players.map((p) =>
      p.id === playerId ? { ...p, cash: p.cash - houseCost } : p,
    ),
    properties: {
      ...state.properties,
      [player.position]: { ...prop, level: newLevel },
    },
    turnPhase: 'managing', // E04：一次停留仅一幢
    recentLog: [...state.recentLog, ...events].slice(-200),
  };
  return { ok: true, state: newState, events };
}

/** 处理 skip_build：不盖房，转 managing */
function handleSkipBuild(state: GameState, playerId: string): ApplyResult {
  if (state.turnPhase !== 'awaiting_build_decision') return { ok: false, code: 'WRONG_PHASE' };
  return {
    ok: true,
    state: { ...state, turnPhase: 'managing' },
    events: [],
  };
}

/** 处理 sell_house：卖一幢房，返还 houseCost × 0.5（01 §6.4）
 *  - 旅馆视同 5 幢房屋逐幢出售（E10：5→4 返还一幢半价，依此类推）
 *  - 仅 normal 可卖（车站/特殊地皮无房）
 *  - managing 或债务状态均可 */
function handleSellHouse(
  state: GameState,
  playerId: string,
  intent: { cellId: number },
): ApplyResult {
  if (state.turnPhase !== 'managing') return { ok: false, code: 'WRONG_PHASE' };
  const cell = state.board.cells.find((c) => c.id === intent.cellId);
  if (!cell || cell.type !== 'property' || cell.subtype !== 'normal') {
    return { ok: false, code: 'ILLEGAL_INTENT' };
  }
  const prop = state.properties[intent.cellId];
  if (!prop || prop.ownerId !== playerId) return { ok: false, code: 'ILLEGAL_INTENT' };
  if (prop.level <= 0) return { ok: false, code: 'ILLEGAL_INTENT' }; // 无房可卖

  const refund = Math.round(cell.houseCost! * state.config.sellHouseRefundRate);
  const newLevel = prop.level - 1;
  const events: GameEvent[] = [{ type: 'house_sold', cellId: intent.cellId, level: newLevel }];
  const stateAfterSale: GameState = {
    ...state,
    players: state.players.map((p) =>
      p.id === playerId ? { ...p, cash: p.cash + refund } : p,
    ),
    properties: {
      ...state.properties,
      [intent.cellId]: { ...prop, level: newLevel },
    },
  };
  const settled = payDebtIfPossible(stateAfterSale, events);
  // E18：非债务状态卖房加现金也可能触发 cash_goal（有债务时 helper 自行跳过）
  const final = finishCashGoalIfReached(settled.state, settled.events) ?? settled;
  return {
    ok: true,
    state: { ...final.state, recentLog: [...state.recentLog, ...final.events].slice(-200) },
    events: final.events,
  };
}

/** 处理 mortgage_property：无房未抵押地产抵押给银行，获得 mortgageValue（01 §7） */
function handleMortgageProperty(
  state: GameState,
  playerId: string,
  intent: { cellId: number },
): ApplyResult {
  if (state.turnPhase !== 'managing') return { ok: false, code: 'WRONG_PHASE' };
  const cell = state.board.cells.find((c) => c.id === intent.cellId);
  if (!cell || cell.type !== 'property') return { ok: false, code: 'ILLEGAL_INTENT' };
  const prop = state.properties[intent.cellId];
  if (!prop || prop.ownerId !== playerId) return { ok: false, code: 'ILLEGAL_INTENT' };
  if (prop.level > 0 || prop.mortgaged) return { ok: false, code: 'ILLEGAL_INTENT' };
  if (typeof cell.mortgageValue !== 'number') return { ok: false, code: 'ILLEGAL_INTENT' };

  const amount = cell.mortgageValue;
  const events: GameEvent[] = [
    { type: 'property_mortgaged', playerId, cellId: intent.cellId, amount },
  ];
  const stateAfterMortgage: GameState = {
    ...state,
    players: state.players.map((p) =>
      p.id === playerId ? { ...p, cash: p.cash + amount } : p,
    ),
    properties: {
      ...state.properties,
      [intent.cellId]: { ...prop, mortgaged: true },
    },
  };
  const settled = payDebtIfPossible(stateAfterMortgage, events);
  const final = finishCashGoalIfReached(settled.state, settled.events) ?? settled;
  return {
    ok: true,
    state: { ...final.state, recentLog: [...state.recentLog, ...final.events].slice(-200) },
    events: final.events,
  };
}

/** 处理 redeem_property：支付 mortgageValue + 利息，解除抵押（01 §7） */
function handleRedeemProperty(
  state: GameState,
  playerId: string,
  intent: { cellId: number },
): ApplyResult {
  if (state.turnPhase !== 'managing') return { ok: false, code: 'WRONG_PHASE' };
  const cell = state.board.cells.find((c) => c.id === intent.cellId);
  if (!cell || cell.type !== 'property') return { ok: false, code: 'ILLEGAL_INTENT' };
  const prop = state.properties[intent.cellId];
  if (!prop || prop.ownerId !== playerId) return { ok: false, code: 'ILLEGAL_INTENT' };
  if (!prop.mortgaged) return { ok: false, code: 'ILLEGAL_INTENT' };
  if (typeof cell.mortgageValue !== 'number') return { ok: false, code: 'ILLEGAL_INTENT' };

  const amount = Math.round(cell.mortgageValue * (1 + state.config.mortgageInterestRate));
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return { ok: false, code: 'ILLEGAL_INTENT' };
  if (player.cash < amount) return { ok: false, code: 'INSUFFICIENT_FUNDS' };

  const events: GameEvent[] = [
    { type: 'property_redeemed', playerId, cellId: intent.cellId, amount },
  ];
  const newState: GameState = {
    ...state,
    players: state.players.map((p) =>
      p.id === playerId ? { ...p, cash: p.cash - amount } : p,
    ),
    properties: {
      ...state.properties,
      [intent.cellId]: { ...prop, mortgaged: false },
    },
    recentLog: [...state.recentLog, ...events].slice(-200),
  };
  return { ok: true, state: newState, events };
}

/** 处理 sell_property：无房未抵押地产卖回银行，返还 price × 0.5（01 §6.5）
 *  - 卖出后变无主，可被任何人（含原主）再购买（E11）
 *  - 有房须先卖完所有房；抵押中不可卖 */
function handleSellProperty(
  state: GameState,
  playerId: string,
  intent: { cellId: number },
): ApplyResult {
  if (state.turnPhase !== 'managing') return { ok: false, code: 'WRONG_PHASE' };
  const cell = state.board.cells.find((c) => c.id === intent.cellId);
  if (!cell || cell.type !== 'property') return { ok: false, code: 'ILLEGAL_INTENT' };
  const prop = state.properties[intent.cellId];
  if (!prop || prop.ownerId !== playerId) return { ok: false, code: 'ILLEGAL_INTENT' };
  if (prop.level > 0) return { ok: false, code: 'ILLEGAL_INTENT' }; // 有房先卖房
  if (prop.mortgaged) return { ok: false, code: 'ILLEGAL_INTENT' }; // 抵押中不可卖

  const refund = Math.round(cell.price * state.config.sellLandRate);
  const events: GameEvent[] = [
    { type: 'property_sold', playerId, cellId: intent.cellId, amount: refund },
  ];
  const stateAfterSale: GameState = {
    ...state,
    players: state.players.map((p) =>
      p.id === playerId ? { ...p, cash: p.cash + refund } : p,
    ),
    properties: {
      ...state.properties,
      [intent.cellId]: { ownerId: null, level: 0, mortgaged: false }, // E11 变无主
    },
  };
  const settled = payDebtIfPossible(stateAfterSale, events);
  // E18：非债务状态卖地加现金也可能触发 cash_goal（有债务时 helper 自行跳过）
  const final = finishCashGoalIfReached(settled.state, settled.events) ?? settled;
  return {
    ok: true,
    state: { ...final.state, recentLog: [...state.recentLog, ...final.events].slice(-200) },
    events: final.events,
  };
}

/** 玩家出局的统一结算：现金清零、标记破产、名下地产转为无主可售，并按 creditorId 转移剩余现金。
 *  - declare_bankrupt 与 surrender 共用本函数，确保两种出局路径的结算结果完全一致。
 *  - 两人对局：creditorId 指向对手（或既有债务债主），cash_goal / last_standing 由现有破产流程判定。
 *  - 多人对局且无债主（creditorId=null）：现金缴银行、地产释放，其余玩家继续（turnPhase 仅在出局者是当前行动者时重置为 managing）。 */
interface BankruptcySettlementOptions {
  creditorId: string | null;
  resume?: DebtResumeState;
  /** 出局原因：破产走 player_bankrupt 事件，投降走 player_surrendered 事件（仅影响战报文案）。 */
  eventType: 'bankrupt' | 'surrender';
}

function settlePlayerBankruptcy(
  state: GameState,
  playerId: string,
  options: BankruptcySettlementOptions,
): ApplyResult {
  const { creditorId, eventType } = options;
  const debtor = state.players.find((p) => p.id === playerId);
  if (!debtor) return { ok: false, code: 'ILLEGAL_INTENT' };

  const transferredCash = debtor.cash;
  const bankruptEvent: GameEvent = eventType === 'surrender'
    ? { type: 'player_surrendered', playerId, creditorId, transferredCash }
    : { type: 'player_bankrupt', playerId, creditorId, transferredCash };
  const events: GameEvent[] = [bankruptEvent];
  const players = state.players.map((p) => {
    if (p.id === playerId) return { ...p, cash: 0, bankrupt: true, bankruptTurn: state.turn };
    if (creditorId !== null && p.id === creditorId) return { ...p, cash: p.cash + transferredCash };
    return p;
  });

  // 仅当出局者就是当前行动者（当前玩家或债务人）时，才把回合阶段重置为 managing；
  // 否则不动手它的玩家正在进行的回合（避免 turPhase 被错误改写）。
  const isDebtor = state.debt !== null && state.debt.debtorId === playerId;
  const isActivePlayer = state.currentPlayerId === playerId || isDebtor;

  let newState: GameState = {
    ...state,
    players,
    properties: clearPlayerProperties(state, playerId),
    debt: isDebtor ? null : state.debt,
    turnPhase: isActivePlayer ? 'managing' : state.turnPhase,
  };

  const alive = alivePlayers(newState);
  if (alive.length === 1) {
    events.push({ type: 'game_over', winnerId: alive[0].id, reason: 'last_standing' });
    newState = { ...newState, phase: 'game_over', winnerId: alive[0].id };
  } else {
    // E18：现金转移给玩家债主后，债主可能 cash_goal 即时终局（多人局）
    const cashGoalWin = finishCashGoalIfReached(newState, events);
    if (cashGoalWin) {
      newState = cashGoalWin.state;
      events.splice(0, events.length, ...cashGoalWin.events);
    } else {
      if (options.resume !== undefined && options.resume.payments.length) {
        const queued = processQueuedPayments(newState, options.resume.payments, events);
        newState = { ...queued.state, debt: queued.newDebt, turnPhase: queued.newDebt ? 'managing' : queued.state.turnPhase };
        events.splice(0, events.length, ...queued.events);
      }
      if (newState.phase !== 'game_over' && newState.debt === null && state.currentPlayerId === playerId) {
        const advanced = advanceToNextPlayableTurn(newState, playerId, events);
        newState = advanced.state;
        events.splice(0, events.length, ...advanced.events);
      }
    }
  }

  // 有人出局时，交易/拍卖可能正停在这个人身上：不清理就会留下「等一个已经不在场的人答复」
  // 的静默冻结（详见 bargain.ts 的 reconcileBargainAfterDeparture）。终局则无需处理。
  if (newState.phase !== 'game_over') {
    const reconciled = reconcileBargainAfterDeparture(newState, playerId);
    newState = reconciled.state;
    events.push(...reconciled.events);
  }

  return {
    ok: true,
    state: { ...newState, recentLog: [...state.recentLog, ...events].slice(-200) },
    events,
  };
}

function handleDeclareBankrupt(state: GameState, playerId: string): ApplyResult {
  if (!state.debt || state.debt.debtorId !== playerId) return { ok: false, code: 'WRONG_PHASE' };
  return settlePlayerBankruptcy(state, playerId, {
    creditorId: state.debt.creditorId,
    ...(state.debt.resume ? { resume: state.debt.resume } : {}),
    eventType: 'bankrupt',
  });
}

/** 处理 surrender：主动投降出局（无债务或非本人回合亦可发动，applyIntent 已放开相应校验）。
 *  - 两人对局：与破产完全一致的结算（有债务给债主、无债务给对手），胜负由破产流程判定。
 *  - 多人对局：立即出局，现金清零（缴银行），名下地产全部转为无主可售，其余玩家继续。 */
function handleSurrender(state: GameState, playerId: string): ApplyResult {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return { ok: false, code: 'ILLEGAL_INTENT' };
  if (player.bankrupt) return { ok: false, code: 'ILLEGAL_INTENT' };
  const alive = alivePlayers(state);
  if (alive.length <= 1) return { ok: false, code: 'WRONG_PHASE' }; // 已无对手可认输

  const debt = state.debt !== null && state.debt.debtorId === playerId ? state.debt : null;
  const twoPlayer = state.players.length === 2;
  // 两人对局、且投降者无既有债务时，把对手视为现金接收方（与破产一致）；多人对局缴银行。
  const fallbackCreditor = twoPlayer ? (alive.find((p) => p.id !== playerId)?.id ?? null) : null;

  return settlePlayerBankruptcy(state, playerId, {
    creditorId: debt !== null ? debt.creditorId : fallbackCreditor,
    ...(debt?.resume ? { resume: debt.resume } : {}),
    eventType: 'surrender',
  });
}

/** 处理 end_turn：结束当前回合，推进到下一位未破产玩家（01 §4 状态机）
 *  - 跳过 bankrupt 玩家
 *  - 债务未清不可结束（须先清算，步 9）
 *  - skipTurns 处理（步 8 补）、胜利检查（步 10 补） */
function handleEndTurn(state: GameState, playerId: string): ApplyResult {
  if (state.turnPhase !== 'managing') return { ok: false, code: 'WRONG_PHASE' };
  if (state.debt) return { ok: false, code: 'WRONG_PHASE' };
  const advanced = advanceToNextPlayableTurn(state, playerId, []);

  return {
    ok: true,
    state: {
      ...advanced.state,
      recentLog: [...state.recentLog, ...advanced.events].slice(-200),
    },
    events: advanced.events,
  };
}
