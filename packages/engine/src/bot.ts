// 电脑玩家决策（03 §4.4 策略 v1）
// 纯函数、确定性：v1 阈值全为常量，无随机。随机性预留位（state.seed）暂未使用。
// 合法性：决策复用 selectors 作为闸门；任意可达状态下产出须被 applyIntent 接受（属性测试保证）。
import type { GameState, Intent } from './types';
import {
  canBuyProperty,
  canBuild,
  getProjectedRentAfterRedemption,
  getSellableAssets,
} from './selectors';
import { defaultRuleModuleRegistry, type RuleModuleRegistry } from './moduleRegistry';
import { AUCTION_MIN_INCREMENT, currentPendingAuction, currentPendingTrade } from './bargain';

/** 电脑玩家难度（P1-6）：影响买地/盖房预留现金与是否主动赎回抵押地产。
 *  normal 与既有策略 v1 行为完全一致，保证存量测试与联机默认不回归。 */
export type BotDifficulty = 'easy' | 'normal' | 'hard';

/** 各难度下买地/盖房须保留的安全垫（>= price/reserve 才出手）。easy 更保守，hard 更激进。 */
const DIFFICULTY_RESERVE: Record<BotDifficulty, number> = { easy: 4000, normal: 2000, hard: 800 };

/** 各难度下赎回抵押地产后必须保留的最低现金（easy 不赎回）。 */
const DIFFICULTY_REDEEM_RESERVE: Record<BotDifficulty, number> = { easy: 0, normal: 1000, hard: 600 };

/** 各难度是否主动赎回抵押地产。 */
const DIFFICULTY_REDEEMS: Record<BotDifficulty, boolean> = { easy: false, normal: true, hard: true };

/** 电脑玩家在给定局面下选择的意图。
 *  注意：调用方负责确认"轮到该玩家行动"——驱动器应取 actor = state.debt?.debtorId ?? state.currentPlayerId。 */
export function chooseBotIntent(
  state: GameState,
  playerId: string,
  registry: RuleModuleRegistry = defaultRuleModuleRegistry,
  difficulty: BotDifficulty = 'normal',
): Intent {
  const decision = registry.runBotStrategyHooks(state.ruleModules, {
    state,
    playerId,
    currentDecision: undefined,
    registry,
    applyCore: () => chooseCoreBotIntent(state, playerId, difficulty),
  });
  // 防御（修复“电脑玩家不会自主掷骰”）：若所有模块的 bot hook 都未产出决策
  // （极端情况下某模块 hook 返回 undefined），绝不直接抛错让电脑玩家整局卡死，
  // 而是回退到核心策略，保证至少能掷骰 / 结束回合，使对局持续推进。
  return decision ?? chooseCoreBotIntent(state, playerId, difficulty);
}

function chooseCoreBotIntent(state: GameState, playerId: string, difficulty: BotDifficulty): Intent {
  // 模块待选动作闸门（修复「联网电脑 B 行动中、无法掷骰」根治点）：
  // 当 applyIntent 的模块闸门激活（publicRuleState.pendingActions 非空）时，引擎只接受 type:'module'
  // 的意图。若当前行动者在当前阶段存在 module 待选动作（如环球旅行模块在 awaiting_roll 注入的
  // enter-airport-branch / roll-branch），必须原样返回匹配该动作的 module 意图；否则返回 roll_dice
  // 会被 WRONG_PHASE 拒绝，而联机驱动器在提交失败后即永久清空自动化、对局冻结。
  const pending = state.publicRuleState.pendingActions.find(
    (action) => action.playerId === playerId && action.requiredPhase === state.turnPhase,
  );
  if (pending !== undefined) {
    return {
      type: 'module',
      module: pending.module,
      action: pending.action,
      payload: pending.payload,
    };
  }

  // 单机真人作弊：本轮抽到的卡在效果前等待确认，驱动器（含测试用的真人驱动）选择接受。
  // 电脑玩家自己抽卡从不产生 pending，所以此分支不影响 BOT/联机既有行为。
  if (state.cardChoice?.pending) return { type: 'accept_card' };

  // 交易答复（#105）：报价目标必须**一定能给出答复**，否则回合会被永久挂住——
  // 这正是本项目历史上「电脑 B 行动中、谁都无法掷骰」那类静默冻结的成因，不能重演。
  // 因此这里不做「拿不准就不答复」，而是无论估值如何都返回一个明确的 accept/decline。
  if (state.turnPhase === 'awaiting_trade_response') {
    const trade = currentPendingTrade(state);
    if (trade !== null && trade.targetId === playerId) {
      return { type: 'respond_trade', accept: shouldAcceptTrade(state, playerId, difficulty) };
    }
    // 防御：被驱动到了错误的行动者身上（正常由服务端 #engineActor 保证不会发生）。
    // 发起者本人撤回报价一定能收敛，胜过硬发一个必被拒的意图让驱动层反复重试。
    return { type: 'cancel_trade' };
  }

  // 拍卖叫价（#106）：同样必须一定能收敛（出价或弃权二选一）。
  if (state.turnPhase === 'awaiting_auction_bid') {
    const auction = currentPendingAuction(state);
    if (auction !== null && auction.bidderId === playerId) {
      return chooseAuctionIntent(state, playerId, auction, difficulty);
    }
    return { type: 'pass_bid' };
  }

  // 修正1（设计评审）：债务态的 turnPhase 就是 managing，必须先判债务走清算分支，
  // 否则照 turnPhase 表会发 end_turn 吃 WRONG_PHASE。
  if (state.debt && state.debt.debtorId === playerId) {
    const { sellableHouses, sellableProperties } = getSellableAssets(state, playerId);
    const mortgageableProperties = sellableProperties.filter((cellId) =>
      Number.isFinite(cellValue(state, cellId, 'mortgageValue')),
    );
    if (sellableHouses.length > 0) {
      return { type: 'sell_house', cellId: pickCheapest(state, sellableHouses, 'houseCost') };
    }
    if (mortgageableProperties.length > 0) {
      return { type: 'mortgage_property', cellId: pickCheapest(state, mortgageableProperties, 'mortgageValue') };
    }
    if (sellableProperties.length > 0) {
      return { type: 'sell_property', cellId: pickCheapest(state, sellableProperties, 'price') };
    }
    return { type: 'declare_bankrupt' };
  }

  const player = state.players.find((p) => p.id === playerId);
  if (!player) return { type: 'end_turn' }; // 防御：不应发生

  switch (state.turnPhase) {
    case 'awaiting_roll':
      return { type: 'roll_dice' };
    case 'awaiting_airport_roll':
      return { type: 'roll_airport_branch' };
    case 'awaiting_buy_decision': {
      if (!canBuyProperty(state)) return { type: 'skip_buy' };
      const price = cellValue(state, player.position, 'price');
      return player.cash >= price + DIFFICULTY_RESERVE[difficulty] ? { type: 'buy_property' } : { type: 'skip_buy' };
    }
    case 'awaiting_build_decision': {
      if (!canBuild(state)) return { type: 'skip_build' };
      const houseCost = cellValue(state, player.position, 'houseCost');
      return player.cash >= houseCost + DIFFICULTY_RESERVE[difficulty] ? { type: 'build_house' } : { type: 'skip_build' };
    }
    case 'managing': {
      if (state.debt) return { type: 'end_turn' };
      if (!DIFFICULTY_REDEEMS[difficulty]) return { type: 'end_turn' };
      const cellId = pickRedemption(state, playerId, player.cash, DIFFICULTY_REDEEM_RESERVE[difficulty]);
      return cellId === undefined ? { type: 'end_turn' } : { type: 'redeem_property', cellId };
    }
    default:
      return { type: 'end_turn' };
  }
}

/** 按预计租金降序、赎回价升序、cell ID 升序选择可赎回地产。 */
function pickRedemption(state: GameState, playerId: string, cash: number, redeemReserve: number): number | undefined {
  let best: { cellId: number; rent: number; cost: number } | undefined;

  for (const cell of state.board.cells) {
    if (cell.type !== 'property') continue;
    const prop = state.properties[cell.id];
    if (!prop || prop.ownerId !== playerId || !prop.mortgaged) continue;
    if (!Number.isFinite(cell.mortgageValue) || cell.mortgageValue < 0) continue;

    const cost = Math.round(cell.mortgageValue * (1 + state.config.mortgageInterestRate));
    if (cash - cost < redeemReserve) continue;
    const rent = getProjectedRentAfterRedemption(state, cell.id);

    if (
      !best
      || rent > best.rent
      || (rent === best.rent && cost < best.cost)
      || (rent === best.rent && cost === best.cost && cell.id < best.cellId)
    ) {
      best = { cellId: cell.id, rent, cost };
    }
  }

  return best?.cellId;
}

/** 按 houseCost / mortgageValue / price 升序选最便宜的格子（03 §4.4：最便宜的先处理） */
function pickCheapest(
  state: GameState,
  cellIds: number[],
  key: 'houseCost' | 'mortgageValue' | 'price',
): number {
  let best = cellIds[0];
  let bestVal = Infinity;
  for (const id of cellIds) {
    const val = cellValue(state, id, key);
    if (val < bestVal) {
      bestVal = val;
      best = id;
    }
  }
  return best;
}

function cellValue(
  state: GameState,
  cellId: number,
  key: 'houseCost' | 'mortgageValue' | 'price',
): number {
  const cell = state.board.cells.find((c) => c.id === cellId) as
    | { houseCost?: number; mortgageValue?: number; price?: number }
    | undefined;
  return cell?.[key] ?? Infinity;
}

// === 交易 / 拍卖的估值（#105 / #106）===
//
// v1 估值刻意做得「笨且确定」：一块地按面值计价（抵押中的按抵押价打折），
// 现金与地价 1:1。不做组合加成、不看位置、不看租金收益——那需要随机性与搜索，
// 会破坏引擎「同 seed 全局可复现」的前提。宁可弱一点，也要保证：
// **任何局面下电脑玩家都能给出一个明确的答复**（有界、不挂起）。

/** 各难度对一块地的心理溢价上限（相对面值的倍数）。 */
const AUCTION_VALUE_MULTIPLIER: Record<BotDifficulty, number> = { easy: 1.0, normal: 1.2, hard: 1.5 };

/** 各难度接受交易所需的最低净收益（easy 更不信任「等价交换」）。 */
const TRADE_ACCEPT_MARGIN: Record<BotDifficulty, number> = { easy: 500, normal: 1, hard: 1 };

/** 单块地对电脑玩家的估值：未抵押按面值，抵押中按抵押价（差额视为已被套现）。 */
function botCellWorth(state: GameState, cellId: number): number {
  const property = state.properties[cellId];
  const cell = state.board.cells.find((c) => c.id === cellId) as
    | { price?: number; mortgageValue?: number }
    | undefined;
  if (cell === undefined) return 0;
  if (property?.mortgaged) return Number.isFinite(cell.mortgageValue) ? (cell.mortgageValue as number) : 0;
  return Number.isFinite(cell.price) ? (cell.price as number) : 0;
}

/** 交易答复：目标是「收到的东西 − 付出的东西」的净收益高于该难度的门槛就同意。
 *  `offer` 是发起方给目标的，`request` 是发起方从目标手里要的。 */
function shouldAcceptTrade(state: GameState, playerId: string, difficulty: BotDifficulty): boolean {
  const trade = currentPendingTrade(state);
  if (trade === null || trade.targetId !== playerId) return false;
  const incoming = trade.offer.cash + trade.offer.cellIds.reduce((sum, id) => sum + botCellWorth(state, id), 0);
  const outgoing = trade.request.cash + trade.request.cellIds.reduce((sum, id) => sum + botCellWorth(state, id), 0);
  return incoming - outgoing >= TRADE_ACCEPT_MARGIN[difficulty];
}

/** 拍卖心理价位上限：既要留下难度对应的安全垫，也不超过地价 × 难度溢价。 */
function auctionBudget(state: GameState, playerId: string, cellId: number, difficulty: BotDifficulty): number {
  const player = state.players.find((p) => p.id === playerId);
  if (player === undefined) return 0;
  const worth = botCellWorth(state, cellId);
  const byWorth = Math.round(worth * AUCTION_VALUE_MULTIPLIER[difficulty]);
  const byCash = player.cash - DIFFICULTY_RESERVE[difficulty];
  return Math.max(0, Math.min(byWorth, byCash));
}

/** 拍卖叫价：能加价就只加最小幅度（省现金），加不动就弃权。 */
function chooseAuctionIntent(
  state: GameState,
  playerId: string,
  auction: { cellId: number; leaderId: string | null; leaderBid: number },
  difficulty: BotDifficulty,
): Intent {
  const budget = auctionBudget(state, playerId, auction.cellId, difficulty);
  const minimum = auction.leaderId === null ? AUCTION_MIN_INCREMENT : auction.leaderBid + AUCTION_MIN_INCREMENT;
  if (budget < minimum) return { type: 'pass_bid' };
  if (auction.leaderId === null) {
    // 开价：出到心理价位的一半（但不低于最小加价），别一上来就把预算打满。
    const worth = botCellWorth(state, auction.cellId);
    return { type: 'place_bid', amount: Math.max(minimum, Math.min(budget, Math.round(worth * 0.5))) };
  }
  return { type: 'place_bid', amount: minimum };
}
