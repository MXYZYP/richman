import { describe, it, expect } from 'vitest';
import { createGame, applyIntent } from '../engine';
import { hydrateGameState } from '../hydrate';
import { chooseBotIntent } from '../bot';
import { getActiveMapPack } from '@richman/board-data';
import type { GameState, TradeSide } from '../types';

const chinaMap = getActiveMapPack('china-tour');
const board = chinaMap.game.board;
const config = chinaMap.game.config;

const normalCellIds = board.cells.filter((c) => c.type === 'property' && c.subtype === 'normal').map((c) => c.id);

/** 直接从 createGame 造一局，并把阶段推到 managing —— 交易与拍卖都以 managing 为前置阶段。
 *  （createGame 产出的是开局 'awaiting_roll'；这里关心的是议价语义，不关心掷骰。） */
function makeGame(options: { seed?: string; auctionOnDecline?: boolean; playerCount?: number } = {}): GameState {
  const playerCount = options.playerCount ?? 3;
  const state = createGame({
    mapRef: chinaMap.ref,
    ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: chinaMap.game.config,
    players: Array.from({ length: playerCount }, (_, index) => ({
      id: `p${index + 1}`,
      nickname: `${index + 1}号`,
    })),
    seed: options.seed ?? 'bargain',
    ...(options.auctionOnDecline === undefined ? {} : { auctionOnDecline: options.auctionOnDecline }),
  });
  return { ...state, turnPhase: 'managing' };
}

const actor = (state: GameState): string => state.currentPlayerId;
function player(state: GameState, id: string): GameState['players'][number] {
  const candidate = state.players.find((p) => p.id === id);
  if (candidate === undefined) throw new Error(`missing player ${id}`);
  return candidate;
}
function otherThan(state: GameState, id: string): GameState['players'][number] {
  const candidate = state.players.find((p) => p.id !== id && !p.bankrupt);
  if (candidate === undefined) throw new Error('no other player');
  return candidate;
}
function cashOf(state: GameState, id: string): number {
  return player(state, id).cash;
}
/** 直接改产权/现金的测试夹具（引擎状态不可变，用展开构造新 state）。 */
function withOwner(state: GameState, cellId: number, ownerId: string): GameState {
  return { ...state, properties: { ...state.properties, [cellId]: { ownerId, level: 0, mortgaged: false } } };
}
function withCash(state: GameState, id: string, cash: number): GameState {
  return { ...state, players: state.players.map((p) => (p.id === id ? { ...p, cash } : p)) };
}
function withLevel(state: GameState, cellId: number, level: number): GameState {
  const existing = state.properties[cellId];
  return { ...state, properties: { ...state.properties, [cellId]: { ...existing, level } } };
}
const empty: TradeSide = { cash: 0, cellIds: [] };

// === 交易（#105）===

describe('交易 propose_trade（#105）', () => {
  it('报价成功后进入 awaiting_trade_response，并留下 pendingTrade 与 trade_proposed 事件', () => {
    const base = makeGame();
    const me = actor(base);
    const you = otherThan(base, me);
    const state = withOwner(base, normalCellIds[0], me);
    const result = applyIntent(state, me, {
      type: 'propose_trade',
      targetId: you.id,
      offer: { cash: 200, cellIds: [normalCellIds[0]] },
      request: { cash: 300, cellIds: [] },
    });
    if (!result.ok) throw new Error('propose should succeed');
    expect(result.state.turnPhase).toBe('awaiting_trade_response');
    expect(result.state.pendingTrade).toEqual({
      proposerId: me,
      targetId: you.id,
      offer: { cash: 200, cellIds: [normalCellIds[0]] },
      request: { cash: 300, cellIds: [] },
    });
    expect(result.events).toEqual([{ type: 'trade_proposed', proposerId: me, targetId: you.id }]);
  });

  it('现金与地产都在答复同意时互换，随后回到 managing', () => {
    const base = makeGame();
    const me = actor(base);
    const you = otherThan(base, me);
    const secondCell = normalCellIds[1];
    let state = withOwner(base, normalCellIds[0], me);
    state = withOwner(state, secondCell, you.id);
    state = withCash(state, me, 5000);
    state = withCash(state, you.id, 5000);

    const proposed = applyIntent(state, me, {
      type: 'propose_trade',
      targetId: you.id,
      offer: { cash: 200, cellIds: [normalCellIds[0]] },
      request: { cash: 300, cellIds: [secondCell] },
    });
    if (!proposed.ok) throw new Error('propose should succeed');

    const answered = applyIntent(proposed.state, you.id, { type: 'respond_trade', accept: true });
    if (!answered.ok) throw new Error('accept should succeed');
    expect(cashOf(answered.state, me)).toBe(5000 - 200 + 300);
    expect(cashOf(answered.state, you.id)).toBe(5000 - 300 + 200);
    expect(answered.state.properties[normalCellIds[0]].ownerId).toBe(you.id);
    expect(answered.state.properties[secondCell].ownerId).toBe(me);
    expect(answered.state.turnPhase).toBe('managing');
    expect(answered.state.pendingTrade ?? null).toBeNull();
    expect(answered.events).toEqual([{
      type: 'trade_resolved',
      proposerId: me,
      targetId: you.id,
      accepted: true,
      cashFromProposer: 200,
      cashFromTarget: 300,
      cellsToProposer: [secondCell],
      cellsToTarget: [normalCellIds[0]],
    }]);
  });

  it('拒绝时不发生任何资产变动，回合照常回到 managing', () => {
    const base = makeGame();
    const me = actor(base);
    const you = otherThan(base, me);
    const state = withOwner(base, normalCellIds[0], me);
    const proposed = applyIntent(state, me, {
      type: 'propose_trade',
      targetId: you.id,
      offer: { cash: 0, cellIds: [normalCellIds[0]] },
      request: { cash: 100, cellIds: [] },
    });
    if (!proposed.ok) throw new Error('propose should succeed');

    const answered = applyIntent(proposed.state, you.id, { type: 'respond_trade', accept: false });
    if (!answered.ok) throw new Error('decline should succeed');
    expect(cashOf(answered.state, me)).toBe(cashOf(state, me));
    expect(cashOf(answered.state, you.id)).toBe(cashOf(state, you.id));
    expect(answered.state.properties[normalCellIds[0]].ownerId).toBe(me);
    expect(answered.state.turnPhase).toBe('managing');
    expect(answered.events).toEqual([{
      type: 'trade_resolved',
      proposerId: me,
      targetId: you.id,
      accepted: false,
      cashFromProposer: 0,
      cashFromTarget: 0,
      cellsToProposer: [],
      cellsToTarget: [],
    }]);
  });

  it('只有报价目标能答复：发起者与第三方都被 NOT_YOUR_TURN 拒绝', () => {
    const base = makeGame();
    const me = actor(base);
    const you = otherThan(base, me);
    const third = base.players.find((p) => p.id !== me && p.id !== you.id);
    const state = withOwner(base, normalCellIds[0], me);
    const proposed = applyIntent(state, me, {
      type: 'propose_trade',
      targetId: you.id,
      offer: { cash: 0, cellIds: [normalCellIds[0]] },
      request: { cash: 100, cellIds: [] },
    });
    if (!proposed.ok) throw new Error('propose should succeed');

    for (const id of [me, third?.id]) {
      if (id === undefined) continue;
      const attempt = applyIntent(proposed.state, id, { type: 'respond_trade', accept: true });
      expect(attempt.ok).toBe(false);
      if (!attempt.ok) expect(attempt.code).toBe('NOT_YOUR_TURN');
    }
  });

  it('发起者可以撤回报价；目标不能撤回', () => {
    const base = makeGame();
    const me = actor(base);
    const you = otherThan(base, me);
    const state = withOwner(base, normalCellIds[0], me);
    const proposed = applyIntent(state, me, {
      type: 'propose_trade',
      targetId: you.id,
      offer: { cash: 0, cellIds: [normalCellIds[0]] },
      request: { cash: 100, cellIds: [] },
    });
    if (!proposed.ok) throw new Error('propose should succeed');

    const targetAttempt = applyIntent(proposed.state, you.id, { type: 'cancel_trade' });
    expect(targetAttempt.ok).toBe(false);
    if (!targetAttempt.ok) expect(targetAttempt.code).toBe('NOT_YOUR_TURN');

    const cancelled = applyIntent(proposed.state, me, { type: 'cancel_trade' });
    if (!cancelled.ok) throw new Error('cancel should succeed');
    expect(cancelled.state.turnPhase).toBe('managing');
    expect(cancelled.state.pendingTrade ?? null).toBeNull();
    expect(cancelled.events).toEqual([{ type: 'trade_cancelled', proposerId: me, targetId: you.id }]);
  });

  it('交易等待期间当前玩家不能正常行动（end_turn / 卖地都被拒）', () => {
    const base = makeGame();
    const me = actor(base);
    const you = otherThan(base, me);
    const state = withOwner(base, normalCellIds[0], me);
    const proposed = applyIntent(state, me, {
      type: 'propose_trade',
      targetId: you.id,
      offer: { cash: 0, cellIds: [normalCellIds[0]] },
      request: { cash: 100, cellIds: [] },
    });
    if (!proposed.ok) throw new Error('propose should succeed');

    for (const intent of [{ type: 'end_turn' as const }, { type: 'sell_property' as const, cellId: normalCellIds[0] }]) {
      const attempt = applyIntent(proposed.state, me, intent);
      expect(attempt.ok).toBe(false);
      if (!attempt.ok) expect(['NOT_YOUR_TURN', 'WRONG_PHASE']).toContain(attempt.code);
    }
  });

  it('畸形报价一律 ILLEGAL_INTENT：目标非法 / 现金超额 / 非己方地产 / 带房地产 / 双方空手', () => {
    const base = makeGame();
    const me = actor(base);
    const you = otherThan(base, me);
    const mine = withOwner(base, normalCellIds[0], me);
    const theirs = withOwner(mine, normalCellIds[1], you.id);
    const cases = [
      { targetId: me, offer: { cash: 0, cellIds: [normalCellIds[0]] }, request: empty },
      { targetId: 'ghost', offer: { cash: 0, cellIds: [normalCellIds[0]] }, request: empty },
      { targetId: you.id, offer: { cash: 999999, cellIds: [] }, request: empty },
      { targetId: you.id, offer: { cash: 0, cellIds: [normalCellIds[1]] }, request: empty },
      { targetId: you.id, offer: { cash: 0, cellIds: [] }, request: empty },
    ];
    for (const intent of cases) {
      const attempt = applyIntent(theirs, me, { type: 'propose_trade', ...intent });
      expect(attempt.ok).toBe(false);
      if (!attempt.ok) expect(attempt.code).toBe('ILLEGAL_INTENT');
    }
    // 带房地产：先盖一幢（用 level 直接模拟），再拿它去交易
    const withHouse = withLevel(mine, normalCellIds[0], 2);
    const attempt = applyIntent(withHouse, me, {
      type: 'propose_trade',
      targetId: you.id,
      offer: { cash: 0, cellIds: [normalCellIds[0]] },
      request: empty,
    });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.code).toBe('ILLEGAL_INTENT');
  });

  it('非 managing 阶段不能发起；已有进行中的报价时不能重复发起', () => {
    const base = makeGame();
    const me = actor(base);
    const you = otherThan(base, me);
    const state = withOwner(base, normalCellIds[0], me);
    const payload = {
      type: 'propose_trade' as const,
      targetId: you.id,
      offer: { cash: 0, cellIds: [normalCellIds[0]] },
      request: { cash: 100, cellIds: [] },
    };

    const tooEarly = applyIntent({ ...state, turnPhase: 'awaiting_roll' }, me, payload);
    expect(tooEarly.ok).toBe(false);
    if (!tooEarly.ok) expect(tooEarly.code).toBe('WRONG_PHASE');

    const first = applyIntent(state, me, payload);
    if (!first.ok) throw new Error('first propose should succeed');
    const second = applyIntent(first.state, me, payload);
    expect(second.ok).toBe(false);
    // 报价进行中「谁是合法行动者」已经变成对手，所以先撞上 NOT_YOUR_TURN 闸门（阶段不合法则报 WRONG_PHASE）。
    if (!second.ok) expect(['NOT_YOUR_TURN', 'WRONG_PHASE']).toContain(second.code);
  });

  it('报价目标投降出局时交易被自动作废，回合回到 managing（不留静默冻结）', () => {
    const base = makeGame();
    const me = actor(base);
    const you = otherThan(base, me);
    const state = withOwner(base, normalCellIds[0], me);
    const proposed = applyIntent(state, me, {
      type: 'propose_trade',
      targetId: you.id,
      offer: { cash: 0, cellIds: [normalCellIds[0]] },
      request: { cash: 100, cellIds: [] },
    });
    if (!proposed.ok) throw new Error('propose should succeed');

    const surrendered = applyIntent(proposed.state, you.id, { type: 'surrender' });
    if (!surrendered.ok) throw new Error('surrender should succeed');
    expect(surrendered.state.pendingTrade ?? null).toBeNull();
    expect(surrendered.state.turnPhase).toBe('managing');
    expect(surrendered.events.some((e) => e.type === 'trade_cancelled')).toBe(true);
  });

  it('电脑玩家作为目标一定给出明确答复：划算就同意，吃亏就拒绝', () => {
    const base = makeGame();
    const me = actor(base);
    const you = otherThan(base, me);
    // 一块地归我、一块地归目标（报价的两侧都必须真的是各自手里的资产）。
    const mine = withOwner(base, normalCellIds[0], me);
    const both = withOwner(mine, normalCellIds[1], you.id);

    // 目标白拿一块地 → 同意
    const generous = applyIntent(both, me, {
      type: 'propose_trade',
      targetId: you.id,
      offer: { cash: 0, cellIds: [normalCellIds[0]] },
      request: empty,
    });
    if (!generous.ok) throw new Error('propose should succeed');
    expect(chooseBotIntent(generous.state, you.id)).toEqual({ type: 'respond_trade', accept: true });

    // 想白拿目标的地、一分钱不给 → 拒绝
    const greedy = applyIntent(both, me, {
      type: 'propose_trade',
      targetId: you.id,
      offer: empty,
      request: { cash: 0, cellIds: [normalCellIds[1]] },
    });
    if (!greedy.ok) throw new Error('propose should succeed');
    expect(chooseBotIntent(greedy.state, you.id)).toEqual({ type: 'respond_trade', accept: false });
  });

  it('电脑玩家被驱动到错误的行动者上时撤回报价（保证阶段一定能收敛）', () => {
    const base = makeGame();
    const me = actor(base);
    const you = otherThan(base, me);
    const proposed = applyIntent(base, me, {
      type: 'propose_trade',
      targetId: you.id,
      offer: empty,
      request: { cash: 100, cellIds: [] },
    });
    if (!proposed.ok) throw new Error('propose should succeed');
    // 让发起者（电脑）自己决策：撤回是合法且必然收敛的一步。
    expect(chooseBotIntent(proposed.state, me)).toEqual({ type: 'cancel_trade' });
  });
});

// === 拍卖（#106）===

function atBuyDecision(options: { auctionOnDecline?: boolean; playerCount?: number } = {}): GameState {
  const state = makeGame({ seed: 'auction', ...options });
  const cellId = normalCellIds[3];
  return {
    ...state,
    turnPhase: 'awaiting_buy_decision',
    players: state.players.map((p) => (p.id === state.currentPlayerId ? { ...p, position: cellId } : p)),
  };
}

describe('拍卖 skip_buy → 全场叫价（#106）', () => {
  it('房规未开启时保持既有行为：流拍、无 auction 事件', () => {
    const state = atBuyDecision();
    const result = applyIntent(state, actor(state), { type: 'skip_buy' });
    if (!result.ok) throw new Error('skip_buy should succeed');
    expect(result.state.turnPhase).toBe('managing');
    expect(result.state.pendingAuction ?? null).toBeNull();
    expect(result.events).toEqual([{ type: 'buy_declined' }]);
  });

  it('房规开启时进入 awaiting_auction_bid：首叫价者是座次下一位存活玩家，放弃购买者被排除', () => {
    const state = atBuyDecision({ auctionOnDecline: true });
    const me = actor(state);
    const result = applyIntent(state, me, { type: 'skip_buy' });
    if (!result.ok) throw new Error('skip_buy should succeed');
    const seatIndex = state.players.findIndex((p) => p.id === me);
    const expected = state.players[(seatIndex + 1) % state.players.length].id;
    expect(result.state.turnPhase).toBe('awaiting_auction_bid');
    expect(result.state.pendingAuction).toEqual({
      cellId: normalCellIds[3],
      bidderId: expected,
      leaderId: null,
      leaderBid: 0,
      // 放弃购买的人已按标价被问过一次，不再参与叫价 —— 否则「放弃 → 起拍价买回」是纯套利。
      passedIds: [me],
    });
    expect(result.events.map((e) => e.type)).toEqual(['buy_declined', 'auction_started']);
    expect(applyIntent(result.state, me, { type: 'place_bid', amount: 500 }).ok).toBe(false);
  });

  it('叫价后最高价更新，叫价权推进给下一位未弃权玩家', () => {
    let state = atBuyDecision({ auctionOnDecline: true, playerCount: 4 });
    const opened = applyIntent(state, actor(state), { type: 'skip_buy' });
    if (!opened.ok) throw new Error('skip_buy should succeed');
    state = opened.state;
    const first = (state.pendingAuction as { bidderId: string }).bidderId;

    const bid = applyIntent(state, first, { type: 'place_bid', amount: 500 });
    if (!bid.ok) throw new Error('bid should succeed');
    expect(bid.state.pendingAuction?.leaderId).toBe(first);
    expect(bid.state.pendingAuction?.leaderBid).toBe(500);
    expect(bid.state.pendingAuction?.bidderId).not.toBe(first);
    expect(bid.state.turnPhase).toBe('awaiting_auction_bid');
    expect(bid.events).toEqual([{ type: 'auction_bid_placed', playerId: first, cellId: normalCellIds[3], amount: 500 }]);
  });

  it('出价低于最小加价 → ILLEGAL_INTENT；超过现金 → INSUFFICIENT_FUNDS；非叫价者 → NOT_YOUR_TURN', () => {
    const base = atBuyDecision({ auctionOnDecline: true });
    const skip = applyIntent(base, actor(base), { type: 'skip_buy' });
    if (!skip.ok) throw new Error('skip_buy should succeed');
    const state = skip.state;
    const bidder = (state.pendingAuction as { bidderId: string }).bidderId;

    const tooLow = applyIntent(state, bidder, { type: 'place_bid', amount: 0 });
    expect(tooLow.ok).toBe(false);
    if (!tooLow.ok) expect(tooLow.code).toBe('ILLEGAL_INTENT');

    const broke = withCash(state, bidder, 10);
    const tooRich = applyIntent(broke, bidder, { type: 'place_bid', amount: 100 });
    expect(tooRich.ok).toBe(false);
    if (!tooRich.ok) expect(tooRich.code).toBe('INSUFFICIENT_FUNDS');

    const notBidder = state.players.find((p) => p.id !== bidder)!.id;
    const wrongActor = applyIntent(state, notBidder, { type: 'place_bid', amount: 500 });
    expect(wrongActor.ok).toBe(false);
    if (!wrongActor.ok) expect(wrongActor.code).toBe('NOT_YOUR_TURN');
  });

  it('全部弃权 → 流拍：地产仍无主，回合回到 managing', () => {
    const base = atBuyDecision({ auctionOnDecline: true, playerCount: 2 });
    const skip = applyIntent(base, actor(base), { type: 'skip_buy' });
    if (!skip.ok) throw new Error('skip_buy should succeed');
    const bidder = (skip.state.pendingAuction as { bidderId: string }).bidderId;

    const passed = applyIntent(skip.state, bidder, { type: 'pass_bid' });
    if (!passed.ok) throw new Error('pass should succeed');
    expect(passed.state.turnPhase).toBe('managing');
    expect(passed.state.pendingAuction ?? null).toBeNull();
    expect(passed.state.properties[normalCellIds[3]].ownerId).toBeNull();
    expect(passed.events).toEqual([
      { type: 'auction_passed', playerId: bidder, cellId: normalCellIds[3] },
      { type: 'auction_resolved', cellId: normalCellIds[3], winnerId: null, amount: 0 },
    ]);
  });

  it('唯一出价者成交：按成交价扣款拿地，随后回 managing', () => {
    const base = atBuyDecision({ auctionOnDecline: true, playerCount: 2 });
    const skip = applyIntent(base, actor(base), { type: 'skip_buy' });
    if (!skip.ok) throw new Error('skip_buy should succeed');
    const bidder = (skip.state.pendingAuction as { bidderId: string }).bidderId;
    const before = cashOf(skip.state, bidder);

    const bid = applyIntent(skip.state, bidder, { type: 'place_bid', amount: 700 });
    if (!bid.ok) throw new Error('bid should succeed');
    expect(bid.events.map((e) => e.type)).toEqual(['auction_bid_placed', 'auction_resolved']);
    expect(bid.state.turnPhase).toBe('managing');
    expect(bid.state.pendingAuction ?? null).toBeNull();
    expect(bid.state.properties[normalCellIds[3]].ownerId).toBe(bidder);
    expect(cashOf(bid.state, bidder)).toBe(before - 700);
  });

  it('多人轮流加价：弃权者永久退出，最后只剩最高出价者时立即成交', () => {
    const base = atBuyDecision({ auctionOnDecline: true, playerCount: 3 });
    const skip = applyIntent(base, actor(base), { type: 'skip_buy' });
    if (!skip.ok) throw new Error('skip_buy should succeed');

    let state = skip.state;
    const order: string[] = [];
    for (let guard = 0; guard < 8 && state.turnPhase === 'awaiting_auction_bid'; guard += 1) {
      const bidder = (state.pendingAuction as { bidderId: string }).bidderId;
      order.push(bidder);
      // 第一位加价，其余弃权
      const step = order.length === 1
        ? applyIntent(state, bidder, { type: 'place_bid', amount: 400 })
        : applyIntent(state, bidder, { type: 'pass_bid' });
      if (!step.ok) throw new Error(`step failed for ${bidder}`);
      state = step.state;
    }

    const winner = (state.pendingAuction ?? null) === null
      ? state.properties[normalCellIds[3]].ownerId
      : null;
    expect(state.turnPhase).toBe('managing');
    expect(winner).toBe(order[0]);
    expect(cashOf(state, order[0])).toBe(cashOf(skip.state, order[0]) - 400);
  });

  it('破产玩家不参与轮转：跳过破产者找到下一位叫价人，无人可叫价时立即流拍', () => {
    const base = atBuyDecision({ auctionOnDecline: true, playerCount: 3 });
    const me = actor(base);
    const others = base.players.filter((p) => p.id !== me);
    // 把「紧挨着我的下一位」设为破产：首位叫价者应跳过他去到再下一位。
    const bankruptState: GameState = {
      ...base,
      players: base.players.map((p) => (p.id === others[0].id ? { ...p, bankrupt: true, bankruptTurn: 1 } : p)),
    };
    const skip = applyIntent(bankruptState, me, { type: 'skip_buy' });
    if (!skip.ok) throw new Error('skip_buy should succeed');
    expect(skip.state.turnPhase).toBe('awaiting_auction_bid');
    expect((skip.state.pendingAuction as { bidderId: string }).bidderId).toBe(others[1].id);

    // 他弃权后已无人可叫价（放弃购买者 + 破产者都不参与）→ 立即流拍
    const passed = applyIntent(skip.state, others[1].id, { type: 'pass_bid' });
    if (!passed.ok) throw new Error('pass should succeed');
    expect(passed.state.turnPhase).toBe('managing');
    expect(passed.state.pendingAuction ?? null).toBeNull();
    expect(passed.state.properties[normalCellIds[3]].ownerId).toBeNull();
    expect(passed.events).toEqual([
      { type: 'auction_passed', playerId: others[1].id, cellId: normalCellIds[3] },
      { type: 'auction_resolved', cellId: normalCellIds[3], winnerId: null, amount: 0 },
    ]);
  });

  it('轮到的叫价者投降出局时拍卖自动推进，不会卡住', () => {
    const base = atBuyDecision({ auctionOnDecline: true, playerCount: 3 });
    const skip = applyIntent(base, actor(base), { type: 'skip_buy' });
    if (!skip.ok) throw new Error('skip_buy should succeed');
    const bidder = (skip.state.pendingAuction as { bidderId: string }).bidderId;

    const surrendered = applyIntent(skip.state, bidder, { type: 'surrender' });
    if (!surrendered.ok) throw new Error('surrender should succeed');
    const auction = surrendered.state.pendingAuction ?? null;
    if (auction !== null) {
      // 叫价权必须交给别人，且出局者不能残留在 passedIds 里（hydrate 只接受仍在局的玩家）。
      expect(auction.bidderId).not.toBe(bidder);
      expect(auction.passedIds).not.toContain(bidder);
      expect(auction.leaderId).not.toBe(bidder);
      expect(surrendered.state.turnPhase).toBe('awaiting_auction_bid');
    } else {
      expect(surrendered.state.turnPhase).toBe('managing');
    }
  });

  it('电脑玩家在拍卖里一定给出出价或弃权（不挂起），且不会出到现金以下', () => {
    const base = atBuyDecision({ auctionOnDecline: true, playerCount: 3 });
    const skip = applyIntent(base, actor(base), { type: 'skip_buy' });
    if (!skip.ok) throw new Error('skip_buy should succeed');

    let state = skip.state;
    // 电脑每次只加最小幅度（100），所以拉锯轮数与「预算 / 100」同阶；给足上限只为验证一定收敛。
    for (let guard = 0; guard < 60 && state.turnPhase === 'awaiting_auction_bid'; guard += 1) {
      const bidder = (state.pendingAuction as { bidderId: string }).bidderId;
      const decision = chooseBotIntent(state, bidder, undefined, 'hard');
      const step = applyIntent(state, bidder, decision);
      if (!step.ok) throw new Error(`bot auction decision rejected: ${JSON.stringify(decision)}`);
      state = step.state;
    }
    expect(state.turnPhase).toBe('managing');
  });
});

// === 存档/快照恢复（hydrate）===

describe('交易与拍卖的存档校验（hydrate）', () => {
  it('进行中的报价可以被原样恢复', () => {
    const base = makeGame();
    const me = actor(base);
    const you = otherThan(base, me);
    const state = withOwner(base, normalCellIds[0], me);
    const proposed = applyIntent(state, me, {
      type: 'propose_trade',
      targetId: you.id,
      offer: { cash: 0, cellIds: [normalCellIds[0]] },
      request: { cash: 100, cellIds: [] },
    });
    if (!proposed.ok) throw new Error('propose should succeed');
    const hydrated = hydrateGameState(JSON.parse(JSON.stringify(proposed.state)) as unknown, chinaMap);
    if (!hydrated.ok) throw new Error(`hydrate failed: ${hydrated.reason}`);
    expect(hydrated.state.pendingTrade).toEqual(proposed.state.pendingTrade);
    expect(hydrated.state.turnPhase).toBe('awaiting_trade_response');
  });

  it('阶段与议价状态不一致、或报价本身非法时一律拒绝恢复', () => {
    const base = makeGame();
    const me = actor(base);
    const you = otherThan(base, me);
    const state = withOwner(base, normalCellIds[0], me);
    const proposed = applyIntent(state, me, {
      type: 'propose_trade',
      targetId: you.id,
      offer: { cash: 0, cellIds: [normalCellIds[0]] },
      request: { cash: 100, cellIds: [] },
    });
    if (!proposed.ok) throw new Error('propose should succeed');
    const raw = JSON.parse(JSON.stringify(proposed.state)) as Record<string, unknown>;

    // ① 阶段说在等答复，但没有 pendingTrade
    const missingTrade = { ...raw, pendingTrade: null };
    expect(hydrateGameState(missingTrade, chinaMap).ok).toBe(false);

    // ② pendingTrade 里塞了别人的地
    const wrongOwner = {
      ...raw,
      pendingTrade: {
        ...(raw.pendingTrade as Record<string, unknown>),
        offer: { cash: 0, cellIds: [normalCellIds[1]] },
      },
    };
    expect(hydrateGameState(wrongOwner, chinaMap).ok).toBe(false);

    // ③ 拍卖状态出现在交易阶段
    const strayAuction = {
      ...raw,
      pendingAuction: { cellId: normalCellIds[0], bidderId: me, leaderId: null, leaderBid: 0, passedIds: [] },
    };
    expect(hydrateGameState(strayAuction, chinaMap).ok).toBe(false);

    // ④ 未知键
    expect(hydrateGameState({ ...raw, pendingBidding: null }, chinaMap).ok).toBe(false);
  });

  it('旧存档（完全没有交易/拍卖字段）照旧可以恢复', () => {
    const base = makeGame();
    const raw = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    delete raw.pendingTrade;
    delete raw.pendingAuction;
    delete raw.auctionOnDecline;
    const hydrated = hydrateGameState(raw, chinaMap);
    if (!hydrated.ok) throw new Error(`hydrate failed: ${hydrated.reason}`);
    expect(hydrated.state.turnPhase).toBe(base.turnPhase);
    expect(hydrated.state.config.initialCash).toBe(config.initialCash);
  });

  it('auctionOnDecline 必须为布尔值', () => {
    const base = makeGame();
    const raw = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    expect(hydrateGameState({ ...raw, auctionOnDecline: 'yes' }, chinaMap).ok).toBe(false);
    expect(hydrateGameState({ ...raw, auctionOnDecline: true }, chinaMap).ok).toBe(true);
  });
});
