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
