// 道具系统（#1）—— 机制的全部纯逻辑集中在这里，engine / effects / bot / 客户端各自只调一个口。
//
// 为什么是 core 而不是规则模块：道具要拦在「掷骰」「收租」这两条**核心**链路上，
// 而模块注册表没有掷骰钩子；做成 core 还能让所有地图都直接可用，不必为每张地图
// 改 manifest.requiredRuleModules（那会连带刷新 13 份 contentHash，把存量存档全判死）。
//
// 三种道具的定位：
//   · 遥控骰子 remote_die —— 主动道具：自己回合掷骰前指定点数和，绕开随机（最贵的确定性）。
//   · 免租卡 toll_pass     —— 被动道具：踩到别人地产时自动消耗一张，本次租金全免。
//   · 收租翻倍 rent_boost  —— 被动道具：向别人收租时自动消耗一张，本次租金翻倍。
// 被动道具刻意做成**自动触发**：踩到地就弹一次确认框会把每个回合切碎，
// 而且联机要为此再加一个「等待 payer 决策」的阶段（回合挂起风险），不值得。
//
// 确定性：买道具与用遥控骰子都**不消耗 rng**（遥控骰子本来就是拿掉随机；
// 买道具不动 seed），因此同 seed 的既有对局重新跑一遍，随机序列完全不变。

import type { GameState, ItemBag, ItemId, PlayerState } from './types';
import type { GameEvent } from './types';

/** 道具目录：价格与每人持有上限。价格按「一张免租卡约等于一次中等过路费」标定。 */
export interface ItemDefinition {
  readonly id: ItemId;
  readonly label: string;
  readonly price: number;
  readonly limit: number;
  /** 被动道具（踩地/收租时自动用）。主动道具只能在自己的回合主动使用。 */
  readonly passive: boolean;
  readonly description: string;
}

export const ITEM_DEFINITIONS: Readonly<Record<ItemId, ItemDefinition>> = Object.freeze({
  remote_die: Object.freeze({
    id: 'remote_die',
    label: '遥控骰子',
    price: 900,
    limit: 3,
    passive: false,
    description: '自己回合掷骰前使用：指定 2-12 的点数和，指哪走哪。',
  }),
  toll_pass: Object.freeze({
    id: 'toll_pass',
    label: '免租卡',
    price: 1200,
    limit: 3,
    passive: true,
    description: '踩到别人地产时自动生效：本次租金全免。',
  }),
  rent_boost: Object.freeze({
    id: 'rent_boost',
    label: '收租翻倍',
    price: 1000,
    limit: 3,
    passive: true,
    description: '向别人收租时自动生效：本次租金翻倍。',
  }),
});

export const ITEM_IDS: readonly ItemId[] = Object.freeze(['remote_die', 'toll_pass', 'rent_boost']);

export const EMPTY_ITEM_BAG: Readonly<ItemBag> = Object.freeze({ remote_die: 0, toll_pass: 0, rent_boost: 0 });

/** 遥控骰子可指定的点数和区间（两颗骰子）。 */
export const REMOTE_DIE_MIN = 2;
export const REMOTE_DIE_MAX = 12;

export function isItemId(value: unknown): value is ItemId {
  return typeof value === 'string' && (ITEM_IDS as readonly string[]).includes(value);
}

/** 读某人的背包；没有任何道具时返回一份全 0 的只读背包（不写状态）。 */
export function readItemBag(state: GameState, playerId: string): Readonly<ItemBag> {
  const bag = state.itemBags?.[playerId];
  if (bag === undefined) return EMPTY_ITEM_BAG;
  return {
    remote_die: bag.remote_die,
    toll_pass: bag.toll_pass,
    rent_boost: bag.rent_boost,
  };
}

export function itemCount(state: GameState, playerId: string, itemId: ItemId): number {
  return readItemBag(state, playerId)[itemId];
}

export function bagTotal(bag: Readonly<ItemBag>): number {
  return bag.remote_die + bag.toll_pass + bag.rent_boost;
}

/** 写回某人的背包：只改这一名玩家，其余玩家与其它字段保持原引用（便于 React 式浅比较）。 */
export function withItemBag(state: GameState, playerId: string, bag: Readonly<ItemBag>): GameState {
  return {
    ...state,
    itemBags: { ...(state.itemBags ?? {}), [playerId]: { ...bag } },
  };
}

/** 增减道具。delta 为负即消耗；不会减到负数（调用方应先查数量）。 */
export function adjustItem(
  state: GameState,
  playerId: string,
  itemId: ItemId,
  delta: number,
): GameState {
  const bag = readItemBag(state, playerId);
  const next = Math.max(0, bag[itemId] + delta);
  return withItemBag(state, playerId, { ...bag, [itemId]: next });
}

/** 遥控骰子的两颗骰子怎么摆：点数和固定，拆成两个 1-6 的合法骰面。 */
export function splitRemoteDice(total: number): [number, number] {
  const clamped = Math.min(REMOTE_DIE_MAX, Math.max(REMOTE_DIE_MIN, Math.round(total)));
  const first = Math.min(6, clamped - 1);
  return [first, clamped - first];
}

/** 租金道具结算结果。 */
export interface RentItemResult {
  readonly state: GameState;
  readonly events: GameEvent[];
  readonly amount: number;
}

/**
 * 租金道具结算：免租卡优先（付租方），否则收租翻倍（房主）。
 *
 * 两者**互斥**：同一笔租金最多消耗一张卡。既公平（不会「免租同时翻倍」互相抵消成怪数字），
 * 也让玩家能预期自己的卡是怎么没的。amount <= 0 时什么都不做（0 元租金不吃卡）。
 */
export function applyRentItems(
  state: GameState,
  payerId: string,
  ownerId: string,
  amount: number,
): RentItemResult {
  if (amount <= 0) return { state, events: [], amount };

  if (itemCount(state, payerId, 'toll_pass') > 0) {
    const next = adjustItem(state, payerId, 'toll_pass', -1);
    return {
      state: next,
      events: [{
        type: 'item_used',
        playerId: payerId,
        itemId: 'toll_pass',
        cellId: null,
        amount,
      }],
      amount: 0,
    };
  }

  if (itemCount(state, ownerId, 'rent_boost') > 0) {
    const next = adjustItem(state, ownerId, 'rent_boost', -1);
    const boosted = amount * 2;
    return {
      state: next,
      events: [{
        type: 'item_used',
        playerId: ownerId,
        itemId: 'rent_boost',
        cellId: null,
        amount: boosted - amount,
      }],
      amount: boosted,
    };
  }

  return { state, events: [], amount };
}

/** 买道具的合法性判定（引擎与客户端共用一个判据，避免界面亮着按钮点下去报错）。 */
export type BuyItemRejection = 'WRONG_PHASE' | 'INSUFFICIENT_FUNDS' | 'LIMIT_REACHED' | 'ILLEGAL_INTENT';

export function checkBuyItem(
  state: GameState,
  playerId: string,
  itemId: ItemId,
): BuyItemRejection | null {
  const definition = ITEM_DEFINITIONS[itemId];
  if (definition === undefined) return 'ILLEGAL_INTENT';
  if (state.phase !== 'playing') return 'WRONG_PHASE';
  if (state.turnPhase !== 'managing') return 'WRONG_PHASE';
  if (state.currentPlayerId !== playerId) return 'WRONG_PHASE';
  if (state.debt !== null) return 'WRONG_PHASE';
  const player: PlayerState | undefined = state.players.find((candidate) => candidate.id === playerId);
  if (player === undefined || player.bankrupt) return 'ILLEGAL_INTENT';
  if (itemCount(state, playerId, itemId) >= definition.limit) return 'LIMIT_REACHED';
  if (player.cash < definition.price) return 'INSUFFICIENT_FUNDS';
  return null;
}
