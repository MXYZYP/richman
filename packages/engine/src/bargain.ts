// 交易（#105）与拍卖（#106）——两者共用「出价 / 确认」这一套语义，故放在同一个文件里。
//
// 设计取舍（为什么是现在这个样子）：
//  - 交易报价由**当前玩家**在 managing 阶段发起，然后暂停回合等对手答复；
//    答复只能由 `pendingTrade.targetId` 本人发出 —— 这是引擎里唯一「当前行动者之外的玩家
//    可以合法提交意图」的场景（applyIntent 的全局闸门为 respond_trade 开了特例）。
//    这样交易在单机热座与联机里走的是**同一条**引擎路径，可回放、可存档、可被机器人驱动。
//  - 拍卖只在房规开启（state.auctionOnDecline）时由 skip_buy 触发，默认关闭，
//    因此既有对局与既有快照的语义一个字都没变。
import type {
  ApplyResult,
  GameEvent,
  GameState,
  PendingAuction,
  PendingTrade,
  TradeSide,
} from './types';

/** 拍卖最小加价幅度。 */
export const AUCTION_MIN_INCREMENT = 100;

function playerOf(state: GameState, playerId: string) {
  return state.players.find((player) => player.id === playerId);
}

function isAlive(state: GameState, playerId: string): boolean {
  const player = playerOf(state, playerId);
  return player !== undefined && !player.bankrupt;
}

/**
 * 校验交易的一侧：现金必须是「该玩家真的拿得出来」的非负整数，地产必须全部属于该玩家。
 *
 * 为什么禁止带房地产：房屋不随地产转手（本作没有「房屋随地产一并过户」的规则），
 * 允许带房交易就会产出「新业主名下凭空多出几幢房」这种用既有规则无法解释、也无法回滚的状态。
 * 想交易带房的地皮，先卖光房屋。
 */
function isValidSide(state: GameState, ownerId: string, side: unknown): side is TradeSide {
  if (typeof side !== 'object' || side === null) return false;
  const candidate = side as { cash?: unknown; cellIds?: unknown };
  if (!Number.isSafeInteger(candidate.cash) || (candidate.cash as number) < 0) return false;
  if (!Array.isArray(candidate.cellIds)) return false;

  const owner = playerOf(state, ownerId);
  if (owner === undefined || owner.bankrupt) return false;
  if (owner.cash < (candidate.cash as number)) return false;

  const seen = new Set<number>();
  for (const cellId of candidate.cellIds) {
    if (!Number.isSafeInteger(cellId)) return false;
    const id = cellId as number;
    if (seen.has(id)) return false;
    seen.add(id);
    const property = state.properties[id];
    if (property === undefined || property.ownerId !== ownerId) return false;
    if (property.level > 0) return false;
  }
  return true;
}

function isEmptySide(side: TradeSide): boolean {
  return side.cash === 0 && side.cellIds.length === 0;
}

function normalizeSide(side: TradeSide): TradeSide {
  return Object.freeze({ cash: side.cash, cellIds: Object.freeze([...side.cellIds]) });
}

/** 交易是否已在进行中（缺省字段按「没有」处理）。 */
export function currentPendingTrade(state: GameState): PendingTrade | null {
  return state.pendingTrade ?? null;
}

/** 拍卖是否已在进行中（缺省字段按「没有」处理）。 */
export function currentPendingAuction(state: GameState): PendingAuction | null {
  return state.pendingAuction ?? null;
}

/** 结算一次交易：现金对换 + 地产过户（房屋已在校验阶段排除，抵押状态原样随地产走）。 */
function settleTrade(
  state: GameState,
  trade: PendingTrade,
  accepted: boolean,
): { state: GameState; events: GameEvent[] } {
  const { proposerId, targetId, offer, request } = trade;
  if (!accepted) {
    return {
      state: { ...state, pendingTrade: null, turnPhase: 'managing' },
      events: [{
        type: 'trade_resolved',
        proposerId,
        targetId,
        accepted: false,
        cashFromProposer: 0,
        cashFromTarget: 0,
        cellsToProposer: [],
        cellsToTarget: [],
      }],
    };
  }

  const players = state.players.map((player) => {
    if (player.id === proposerId) return { ...player, cash: player.cash - offer.cash + request.cash };
    if (player.id === targetId) return { ...player, cash: player.cash - request.cash + offer.cash };
    return player;
  });

  const properties = { ...state.properties };
  for (const cellId of request.cellIds) {
    properties[cellId] = { ...properties[cellId], ownerId: proposerId };
  }
  for (const cellId of offer.cellIds) {
    properties[cellId] = { ...properties[cellId], ownerId: targetId };
  }

  return {
    state: { ...state, players, properties, pendingTrade: null, turnPhase: 'managing' },
    events: [{
      type: 'trade_resolved',
      proposerId,
      targetId,
      accepted: true,
      cashFromProposer: offer.cash,
      cashFromTarget: request.cash,
      cellsToProposer: [...request.cellIds],
      cellsToTarget: [...offer.cellIds],
    }],
  };
}

/** propose_trade：当前玩家在 managing 阶段向另一名存活玩家报价。 */
export function handleProposeTrade(
  state: GameState,
  playerId: string,
  intent: { targetId: string; offer: TradeSide; request: TradeSide },
): ApplyResult {
  if (state.turnPhase !== 'managing' || state.debt !== null) return { ok: false, code: 'WRONG_PHASE' };
  if (currentPendingTrade(state) !== null || currentPendingAuction(state) !== null) {
    return { ok: false, code: 'WRONG_PHASE' };
  }
  if (state.currentPlayerId !== playerId) return { ok: false, code: 'NOT_YOUR_TURN' };

  const { targetId } = intent;
  if (typeof targetId !== 'string' || targetId === playerId) return { ok: false, code: 'ILLEGAL_INTENT' };
  if (!isAlive(state, targetId)) return { ok: false, code: 'ILLEGAL_INTENT' };

  if (!isValidSide(state, playerId, intent.offer) || !isValidSide(state, targetId, intent.request)) {
    return { ok: false, code: 'ILLEGAL_INTENT' };
  }
  // 双方都空手的报价毫无意义，直接拒掉（否则会造出一个「等对手点同意」的空回合）。
  if (isEmptySide(intent.offer) && isEmptySide(intent.request)) return { ok: false, code: 'ILLEGAL_INTENT' };

  const pendingTrade: PendingTrade = Object.freeze({
    proposerId: playerId,
    targetId,
    offer: normalizeSide(intent.offer),
    request: normalizeSide(intent.request),
  });
  const events: GameEvent[] = [{ type: 'trade_proposed', proposerId: playerId, targetId }];
  return {
    ok: true,
    state: {
      ...state,
      pendingTrade,
      turnPhase: 'awaiting_trade_response',
      recentLog: [...state.recentLog, ...events].slice(-200),
    },
    events,
  };
}

/** respond_trade：报价目标本人答复（这是唯一允许「非当前玩家」提交的意图）。 */
export function handleRespondTrade(
  state: GameState,
  playerId: string,
  intent: { accept: boolean },
): ApplyResult {
  if (state.turnPhase !== 'awaiting_trade_response' || state.debt !== null) {
    return { ok: false, code: 'WRONG_PHASE' };
  }
  const trade = currentPendingTrade(state);
  if (trade === null) return { ok: false, code: 'WRONG_PHASE' };
  if (trade.targetId !== playerId) return { ok: false, code: 'NOT_YOUR_TURN' };
  if (typeof intent.accept !== 'boolean') return { ok: false, code: 'ILLEGAL_INTENT' };

  // 同意前再校验一次资产：正常流程里这个阶段没有任何东西能改动它们，
  // 但报价里携带的是玩家自己填的数字，重校验是最后一道门（不同意则无需校验）。
  if (intent.accept
    && (!isValidSide(state, trade.proposerId, trade.offer) || !isValidSide(state, trade.targetId, trade.request))) {
    return { ok: false, code: 'ILLEGAL_INTENT' };
  }

  const settled = settleTrade(state, trade, intent.accept);
  return {
    ok: true,
    state: { ...settled.state, recentLog: [...state.recentLog, ...settled.events].slice(-200) },
    events: settled.events,
  };
}

/** cancel_trade：发起者撤回尚未答复的报价（对手离线 / 改变主意时用，避免回合被无限挂住）。 */
export function handleCancelTrade(state: GameState, playerId: string): ApplyResult {
  if (state.turnPhase !== 'awaiting_trade_response') return { ok: false, code: 'WRONG_PHASE' };
  const trade = currentPendingTrade(state);
  if (trade === null) return { ok: false, code: 'WRONG_PHASE' };
  if (trade.proposerId !== playerId) return { ok: false, code: 'NOT_YOUR_TURN' };

  const events: GameEvent[] = [{ type: 'trade_cancelled', proposerId: trade.proposerId, targetId: trade.targetId }];
  return {
    ok: true,
    state: {
      ...state,
      pendingTrade: null,
      turnPhase: 'managing',
      recentLog: [...state.recentLog, ...events].slice(-200),
    },
    events,
  };
}

// === 拍卖 ===

/** 从 fromPlayerId 之后（按座次环形）找下一个「存活且未弃权且不是当前最高出价者」的玩家。
 *  找不到 = 本轮拍卖该结算了（没有更高出价者）。 */
function nextAuctionBidder(
  state: GameState,
  auction: PendingAuction,
  fromPlayerId: string,
): string | null {
  const total = state.players.length;
  const startIndex = state.players.findIndex((player) => player.id === fromPlayerId);
  if (startIndex === -1) return null;
  const passed = new Set(auction.passedIds);
  for (let step = 1; step <= total; step += 1) {
    const candidate = state.players[(startIndex + step) % total];
    if (candidate.bankrupt) continue;
    if (passed.has(candidate.id)) continue;
    if (candidate.id === auction.leaderId) continue;
    return candidate.id;
  }
  return null;
}

/** 结束本轮拍卖：最高出价者付款拿地；无人出价则流拍（地产保持无主，可被任何人日后买下）。 */
function resolveAuction(state: GameState, auction: PendingAuction): { state: GameState; events: GameEvent[] } {
  const winnerId = auction.leaderId;
  const amount = winnerId === null ? 0 : auction.leaderBid;
  const events: GameEvent[] = [{ type: 'auction_resolved', cellId: auction.cellId, winnerId, amount }];

  if (winnerId === null) {
    return {
      state: { ...state, pendingAuction: null, turnPhase: 'managing' },
      events,
    };
  }

  const players = state.players.map((player) => (
    player.id === winnerId ? { ...player, cash: player.cash - amount } : player
  ));
  const properties = {
    ...state.properties,
    [auction.cellId]: { ...state.properties[auction.cellId], ownerId: winnerId },
  };
  return {
    state: { ...state, players, properties, pendingAuction: null, turnPhase: 'managing' },
    events,
  };
}

/** skip_buy 的拍卖分支：把「无人认领的地产」交给全场叫价。
 *
 *  重要取舍：**放弃购买的人不参与本轮叫价**（把他记进 passedIds，轮转自然跳过）。
 *  允许他参与会造出一条套利路径：先放弃标价 P，再从起拍价（100）把同一块地买回来 ——
 *  只比标价便宜，于是「买 / 不买」这个决定彻底失去意义。让他出局后，
 *  「放弃」的代价变成「可能被对手低价捡走」，这才是这条房规想制造的张力。 */
export function startAuction(state: GameState, cellId: number, declinerId: string, events: GameEvent[]): ApplyResult {
  const opening: PendingAuction = Object.freeze({
    cellId,
    bidderId: '',
    leaderId: null,
    leaderBid: 0,
    passedIds: Object.freeze([declinerId]) as readonly string[],
  });
  const firstBidderId = nextAuctionBidder(state, opening, declinerId);
  // 没有别的存活玩家可出价 → 直接流拍（保持既有「无拍卖」结果）。
  if (firstBidderId === null) {
    return {
      ok: true,
      state: { ...state, turnPhase: 'managing', recentLog: [...state.recentLog, ...events].slice(-200) },
      events,
    };
  }

  const auction: PendingAuction = Object.freeze({ ...opening, bidderId: firstBidderId });
  const started: GameEvent[] = [...events, { type: 'auction_started', cellId, firstBidderId }];
  return {
    ok: true,
    state: {
      ...state,
      pendingAuction: auction,
      turnPhase: 'awaiting_auction_bid',
      recentLog: [...state.recentLog, ...started].slice(-200),
    },
    events: started,
  };
}

/** place_bid：轮到的玩家出价，必须高于当前最高价至少一个加价幅度，且不超过自己的现金。 */
export function handlePlaceBid(state: GameState, playerId: string, intent: { amount: number }): ApplyResult {
  if (state.turnPhase !== 'awaiting_auction_bid') return { ok: false, code: 'WRONG_PHASE' };
  const auction = currentPendingAuction(state);
  if (auction === null) return { ok: false, code: 'WRONG_PHASE' };
  if (auction.bidderId !== playerId) return { ok: false, code: 'NOT_YOUR_TURN' };

  const player = playerOf(state, playerId);
  if (player === undefined || player.bankrupt) return { ok: false, code: 'ILLEGAL_INTENT' };

  const amount = intent.amount;
  const minimum = auction.leaderId === null ? AUCTION_MIN_INCREMENT : auction.leaderBid + AUCTION_MIN_INCREMENT;
  if (!Number.isSafeInteger(amount) || amount < minimum) return { ok: false, code: 'ILLEGAL_INTENT' };
  if (amount > player.cash) return { ok: false, code: 'INSUFFICIENT_FUNDS' };

  const events: GameEvent[] = [{ type: 'auction_bid_placed', playerId, cellId: auction.cellId, amount }];
  const raised: PendingAuction = Object.freeze({
    ...auction,
    leaderId: playerId,
    leaderBid: amount,
  });

  const next = nextAuctionBidder(state, raised, playerId);
  if (next === null) {
    // 已无人能再加价（其余人要么破产、要么已弃权）→ 立即成交。
    const resolved = resolveAuction(state, raised);
    return {
      ok: true,
      state: { ...resolved.state, recentLog: [...state.recentLog, ...events, ...resolved.events].slice(-200) },
      events: [...events, ...resolved.events],
    };
  }

  const advanced: PendingAuction = Object.freeze({ ...raised, bidderId: next });
  return {
    ok: true,
    state: {
      ...state,
      pendingAuction: advanced,
      recentLog: [...state.recentLog, ...events].slice(-200),
    },
    events,
  };
}

/** pass_bid：轮到的玩家弃权（永久退出本轮，不参与后续加价）。 */
export function handlePassBid(state: GameState, playerId: string): ApplyResult {
  if (state.turnPhase !== 'awaiting_auction_bid') return { ok: false, code: 'WRONG_PHASE' };
  const auction = currentPendingAuction(state);
  if (auction === null) return { ok: false, code: 'WRONG_PHASE' };
  if (auction.bidderId !== playerId) return { ok: false, code: 'NOT_YOUR_TURN' };

  const events: GameEvent[] = [{ type: 'auction_passed', playerId, cellId: auction.cellId }];
  const passed: PendingAuction = Object.freeze({
    ...auction,
    passedIds: Object.freeze([...auction.passedIds, playerId]),
  });

  const next = nextAuctionBidder(state, passed, playerId);
  if (next === null) {
    const resolved = resolveAuction(state, passed);
    return {
      ok: true,
      state: { ...resolved.state, recentLog: [...state.recentLog, ...events, ...resolved.events].slice(-200) },
      events: [...events, ...resolved.events],
    };
  }

  const advanced: PendingAuction = Object.freeze({ ...passed, bidderId: next });
  return {
    ok: true,
    state: {
      ...state,
      pendingAuction: advanced,
      recentLog: [...state.recentLog, ...events].slice(-200),
    },
    events,
  };
}

/**
 * 有人出局（破产 / 投降）后的收尾：交易与拍卖都可能正停在一个刚刚离场的人身上。
 *
 * 不做这一步会留下**静默冻结**：交易目标的玩家退出了，`turnPhase` 仍是
 * 'awaiting_trade_response'，而唯一能答复的人已经不在了 —— 整局从此谁也不动，
 * 且服务端没有任何错误可看。这与本项目历史上「离线托管跳过机场等待」那次事故同源，
 * 所以出局结算里必须显式清理（由 engine.ts 的 settlePlayerBankruptcy 调用）。
 *
 * 两条铁律（否则清出来的状态会被 hydrate 判定为「阶段与议价状态对不上」而拒绝恢复）：
 *  1. 只要有议价残留，`turnPhase` 就必须与它对应；反之亦然。
 *  2. `passedIds` 只允许装**仍在局**的玩家（hydrate 的校验前提），
 *     所以离场者一律从中剔除，而不是留在里面当纪念。
 */
export function reconcileBargainAfterDeparture(
  state: GameState,
  departingPlayerId: string,
): { state: GameState; events: GameEvent[] } {
  const events: GameEvent[] = [];
  let next = state;

  // 回合主人离场 = 这个回合的上下文整体没了（settlePlayerBankruptcy 可能已把回合推进给下一位）。
  // 此时任何进行中的议价都必须作废，而不是「换个行动者继续」—— 那个行动者属于新回合。
  const hostGone = state.currentPlayerId === departingPlayerId;

  const trade = currentPendingTrade(next);
  if (trade !== null
    && (hostGone || trade.proposerId === departingPlayerId || trade.targetId === departingPlayerId)) {
    next = {
      ...next,
      pendingTrade: null,
      // 阶段若还停在交易等待则收回 managing；若已经被破产流程推进过（新回合的 awaiting_roll），保持原样。
      ...(next.turnPhase === 'awaiting_trade_response' ? { turnPhase: 'managing' as const } : {}),
    };
    events.push({ type: 'trade_cancelled', proposerId: trade.proposerId, targetId: trade.targetId });
  }

  const auction = currentPendingAuction(next);
  if (auction !== null) {
    // 宿主回合没了、或阶段已被破产流程改写 → 拍卖无法再被驱动，整场作废：
    // 不产生赢家、不动现金、地皮保持无主。保留当前 turnPhase（可能已是新回合的 awaiting_roll）。
    if (hostGone || next.turnPhase !== 'awaiting_auction_bid') {
      return {
        state: { ...next, pendingAuction: null },
        events: [...events, { type: 'auction_resolved', cellId: auction.cellId, winnerId: null, amount: 0 }],
      };
    }

    let updated: PendingAuction = Object.freeze({
      ...auction,
      // 出局者永久退出轮转；若他正是当前最高出价者，最高价一并作废（他不再有钱付款）。
      ...(auction.leaderId === departingPlayerId ? { leaderId: null, leaderBid: 0 } : {}),
      passedIds: Object.freeze(auction.passedIds.filter((id) => id !== departingPlayerId)),
    });
    if (updated.bidderId === departingPlayerId) {
      const nextBidder = nextAuctionBidder(next, updated, departingPlayerId);
      if (nextBidder === null) {
        const resolved = resolveAuction(next, updated);
        return { state: resolved.state, events: [...events, ...resolved.events] };
      }
      updated = Object.freeze({ ...updated, bidderId: nextBidder });
    }
    next = { ...next, pendingAuction: updated };
  }

  return { state: next, events };
}

