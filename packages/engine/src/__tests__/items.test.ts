// 道具系统（#1）的引擎回归测试。
//
// 覆盖四件事：
//  1. 买道具的合法性闸门（阶段 / 现金 / 上限 / 欠债）与扣钱入包；
//  2. 遥控骰子「指哪走哪」且**不消耗随机数**（同 seed 的后续随机序列不变）；
//  3. 免租卡 / 收租翻倍自动生效且互斥；
//  4. 存档（itemBags）可选、可校验、旧存档不炸。
import { describe, it, expect } from 'vitest';
import { applyIntent, createGame } from '../engine';
import { hydrateGameState } from '../hydrate';
import { walkPath } from '../movement';
import {
  EMPTY_ITEM_BAG,
  ITEM_DEFINITIONS,
  adjustItem,
  applyRentItems,
  bagTotal,
  checkBuyItem,
  itemCount,
  readItemBag,
  splitRemoteDice,
} from '../items';
import { getActiveMapPack } from '@richman/board-data';
import type { GameState } from '../types';

const chinaMap = getActiveMapPack('china-tour');
const BOARD = chinaMap.game.board;

function makeGame(): GameState {
  return createGame({
    mapRef: chinaMap.ref,
    ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: chinaMap.game.config,
    players: [
      { id: 'p1', nickname: '甲' },
      { id: 'p2', nickname: '乙' },
    ],
    seed: 'items-test',
  });
}

/** 造一个「轮到 p1、指定阶段、指定现金」的局面。 */
function scenario(options: {
  turnPhase: GameState['turnPhase'];
  cash?: number;
  position?: number;
  bag?: Partial<GameState['itemBags'] extends undefined ? never : { remote_die: number; toll_pass: number; rent_boost: number }>;
}): GameState {
  const base = makeGame();
  const playerId = base.currentPlayerId;
  const withCash: GameState = {
    ...base,
    turnPhase: options.turnPhase,
    players: base.players.map((p) => (
      p.id === playerId
        ? { ...p, cash: options.cash ?? p.cash, position: options.position ?? p.position }
        : p
    )),
    ...(options.bag === undefined ? {} : { itemBags: { [playerId]: { ...EMPTY_ITEM_BAG, ...options.bag } } }),
  };
  return withCash;
}

const actor = (state: GameState): string => state.currentPlayerId;

describe('买道具（buy_item）', () => {
  it('managing 阶段有钱就能买：扣钱、入包、发 item_bought', () => {
    const state = scenario({ turnPhase: 'managing', cash: 5000 });
    const me = actor(state);
    const price = ITEM_DEFINITIONS.toll_pass.price;

    const result = applyIntent(state, me, { type: 'buy_item', itemId: 'toll_pass' });
    if (!result.ok) throw new Error(`buy_item rejected: ${result.code}`);

    expect(result.state.players.find((p) => p.id === me)?.cash).toBe(5000 - price);
    expect(itemCount(result.state, me, 'toll_pass')).toBe(1);
    expect(result.events).toEqual([{ type: 'item_bought', playerId: me, itemId: 'toll_pass', price }]);
  });

  it('钱不够 → INSUFFICIENT_FUNDS；不在 managing → WRONG_PHASE；欠债时也拒绝', () => {
    const poor = scenario({ turnPhase: 'managing', cash: 10 });
    expect(applyIntent(poor, actor(poor), { type: 'buy_item', itemId: 'toll_pass' }))
      .toEqual({ ok: false, code: 'INSUFFICIENT_FUNDS' });

    const rolling = scenario({ turnPhase: 'awaiting_roll', cash: 9999 });
    expect(applyIntent(rolling, actor(rolling), { type: 'buy_item', itemId: 'toll_pass' }))
      .toEqual({ ok: false, code: 'WRONG_PHASE' });

    const inDebt: GameState = {
      ...scenario({ turnPhase: 'managing', cash: 9999 }),
      debt: { debtorId: actor(scenario({ turnPhase: 'managing' })), creditorId: null, amount: 100 },
    };
    expect(applyIntent(inDebt, inDebt.debt!.debtorId, { type: 'buy_item', itemId: 'toll_pass' }).ok).toBe(false);
  });

  it(`每人每种上限 ${ITEM_DEFINITIONS.toll_pass.limit} 张：到顶后再买一律拒绝`, () => {
    const limit = ITEM_DEFINITIONS.toll_pass.limit;
    const state = scenario({ turnPhase: 'managing', cash: 99999, bag: { toll_pass: limit } });
    const me = actor(state);

    expect(checkBuyItem(state, me, 'toll_pass')).toBe('LIMIT_REACHED');
    expect(applyIntent(state, me, { type: 'buy_item', itemId: 'toll_pass' }))
      .toEqual({ ok: false, code: 'ILLEGAL_INTENT' });
  });
});

describe('遥控骰子（use_remote_die）', () => {
  it('按指定点数和移动、消耗一张、且不推进随机数', () => {
    const state = scenario({ turnPhase: 'awaiting_roll', position: 0, bag: { remote_die: 1 } });
    const me = actor(state);
    const expected = walkPath(BOARD, 0, 7);

    const result = applyIntent(state, me, { type: 'use_remote_die', total: 7 });
    if (!result.ok) throw new Error(`use_remote_die rejected: ${result.code}`);

    expect(result.state.players.find((p) => p.id === me)?.position).toBe(expected.finalCellId);
    expect(itemCount(result.state, me, 'remote_die')).toBe(0);
    // 关键：遥控骰子拿掉的是随机，不该顺手消耗掉 rng 状态。
    expect(result.state.seed).toBe(state.seed);
    expect(result.state.lastDice).toEqual(splitRemoteDice(7));
    expect(result.events.slice(0, 3)).toEqual([
      { type: 'item_used', playerId: me, itemId: 'remote_die', cellId: null, amount: 7 },
      { type: 'dice_rolled', playerId: me, dice: splitRemoteDice(7) },
      { type: 'token_moved', playerId: me, path: expected.path },
    ]);
  });

  it('没有道具 / 阶段不对 / 点数越界 一律拒绝', () => {
    const noItem = scenario({ turnPhase: 'awaiting_roll', position: 0 });
    expect(applyIntent(noItem, actor(noItem), { type: 'use_remote_die', total: 5 }))
      .toEqual({ ok: false, code: 'ILLEGAL_INTENT' });

    const wrongPhase = scenario({ turnPhase: 'managing', bag: { remote_die: 1 } });
    expect(applyIntent(wrongPhase, actor(wrongPhase), { type: 'use_remote_die', total: 5 }))
      .toEqual({ ok: false, code: 'WRONG_PHASE' });

    for (const total of [1, 13, 2.5]) {
      const bad = scenario({ turnPhase: 'awaiting_roll', position: 0, bag: { remote_die: 1 } });
      expect(applyIntent(bad, actor(bad), { type: 'use_remote_die', total }))
        .toEqual({ ok: false, code: 'ILLEGAL_INTENT' });
    }
  });

  it('两颗骰面永远合法（1-6），和固定', () => {
    for (let total = 2; total <= 12; total += 1) {
      const [a, b] = splitRemoteDice(total);
      expect(a + b).toBe(total);
      expect(a).toBeGreaterThanOrEqual(1);
      expect(a).toBeLessThanOrEqual(6);
      expect(b).toBeGreaterThanOrEqual(1);
      expect(b).toBeLessThanOrEqual(6);
    }
  });
});

describe('被动道具：免租卡 / 收租翻倍', () => {
  it('付租方有免租卡时租金归零并消耗一张', () => {
    const state = scenario({ turnPhase: 'managing', bag: { toll_pass: 1 } });
    const payer = actor(state);
    const result = applyRentItems(state, payer, 'p2', 1500);

    expect(result.amount).toBe(0);
    expect(itemCount(result.state, payer, 'toll_pass')).toBe(0);
    expect(result.events).toEqual([{ type: 'item_used', playerId: payer, itemId: 'toll_pass', cellId: null, amount: 1500 }]);
  });

  it('房主持有收租翻倍时租金翻倍并消耗一张', () => {
    const state = scenario({ turnPhase: 'managing' });
    const payer = actor(state);
    const owner = 'p2';
    const withOwnerBoost = adjustItem(state, owner, 'rent_boost', 1);

    const result = applyRentItems(withOwnerBoost, payer, owner, 800);
    expect(result.amount).toBe(1600);
    expect(itemCount(result.state, owner, 'rent_boost')).toBe(0);
  });

  it('两者互斥：付租方有免租卡时不吃房主的翻倍卡', () => {
    const base = scenario({ turnPhase: 'managing', bag: { toll_pass: 1 } });
    const payer = actor(base);
    const owner = 'p2';
    const both = adjustItem(base, owner, 'rent_boost', 1);

    const result = applyRentItems(both, payer, owner, 900);
    expect(result.amount).toBe(0);
    expect(itemCount(result.state, payer, 'toll_pass')).toBe(0);
    expect(itemCount(result.state, owner, 'rent_boost')).toBe(1);
  });

  it('0 元租金不吃任何卡', () => {
    const state = adjustItem(scenario({ turnPhase: 'managing' }), 'p2', 'rent_boost', 1);
    const result = applyRentItems(state, actor(state), 'p2', 0);
    expect(result.amount).toBe(0);
    expect(itemCount(result.state, 'p2', 'rent_boost')).toBe(1);
  });
});

describe('存档：itemBags 可选且可校验', () => {
  it('带背包的状态能原样 hydrate 回来', () => {
    const state = adjustItem(makeGame(), 'p1', 'remote_die', 2);
    const hydrated = hydrateGameState(JSON.parse(JSON.stringify(state)), chinaMap);
    if (!hydrated.ok) throw new Error(`hydrate failed: ${hydrated.reason}`);
    expect(itemCount(hydrated.state, 'p1', 'remote_die')).toBe(2);
  });

  it('旧存档没有 itemBags 键也能 hydrate（按全员空背包处理）', () => {
    const state = makeGame();
    const legacy = JSON.parse(JSON.stringify(state));
    delete legacy.itemBags;
    const hydrated = hydrateGameState(legacy, chinaMap);
    if (!hydrated.ok) throw new Error(`hydrate failed: ${hydrated.reason}`);
    expect(bagTotal(readItemBag(hydrated.state, 'p1'))).toBe(0);
  });

  it('背包形状不对（负数 / 缺键 / 陌生玩家）一律拒收', () => {
    const base = makeGame();
    const bad = [
      { p1: { remote_die: -1, toll_pass: 0, rent_boost: 0 } },
      { p1: { remote_die: 1 } },
      { nobody: { remote_die: 1, toll_pass: 0, rent_boost: 0 } },
    ];
    for (const itemBags of bad) {
      const hydrated = hydrateGameState(JSON.parse(JSON.stringify({ ...base, itemBags })), chinaMap);
      expect(hydrated.ok).toBe(false);
    }
  });
});
