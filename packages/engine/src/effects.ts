// 卡牌/格效果的统一执行器（01 §9 全 effect 类型）
// 纯函数：接收 state + card，返回新 state + 累积事件 + 可能触发的债务
import type { CellEffect, DeepReadonly, ModuleEffect } from '@richman/board-data';
import type { GameState, GameEvent, DebtState, PlayerState, PendingCardChoice, TurnPhase, QueuedPayment } from './types';
import { getNextCellId, walkPath } from './movement';
import { getCurrentRent } from './selectors';
import { processQueuedPayments } from './payments';
import { finishCashGoalIfReached } from './victory';
import {
  defaultRuleModuleRegistry,
  type ReadonlyEffectCard,
  type RuleModuleRegistry,
} from './moduleRegistry';

export interface EffectResult {
  state: GameState;
  events: GameEvent[];
  newDebt: DebtState | null;
}

const MAX_EFFECT_DEPTH = 8;

function getPlayer(state: GameState, playerId: string): PlayerState {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new Error(`player not found: ${playerId}`);
  return player;
}

/** 沿棋盘 next 指针前进至目标格；不可达时回退为跳跃，避免支线目标造成死循环 */
function walkForwardToTarget(
  state: GameState,
  startCellId: number,
  targetCellId: number,
): { path: number[]; crossedStart: boolean } {
  const maxSteps = state.board.cells.length + 1;
  let current = startCellId;
  const path: number[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const next = getNextCellId(state.board, current);
    path.push(next);
    if (next === targetCellId) {
      return { path, crossedStart: path.includes(0) };
    }
    current = next;
  }
  // 数据异常兜底：目标沿 next 不可达时以跳跃动画落到目标，避免无限循环。
  return { path: [targetCellId], crossedStart: false };
}

function withCurrentPlayer(
  state: GameState,
  playerId: string,
  updater: (player: PlayerState) => PlayerState,
): GameState {
  return {
    ...state,
    players: state.players.map((p) => (p.id === playerId ? updater(p) : p)),
  };
}

/** 单机真人确认模式：仅本地显式开启，且抽卡者不是电脑玩家时，效果结算前暂停等待接受/重抽。 */
export function shouldConfirmCardChoice(state: GameState, playerId: string): boolean {
  if (state.cardChoice?.mode !== 'local-human') return false;
  const player = state.players.find((candidate) => candidate.id === playerId);
  return player !== undefined && !player.isBot;
}

/** 记录待确认卡牌：只覆盖 pending，保留 mode，效果留到 accept_card 时执行。 */
function pauseForCardChoice(state: GameState, pending: PendingCardChoice): GameState {
  return { ...state, cardChoice: { mode: 'local-human', pending } };
}

/** 按 01 §4/§9 结算当前玩家所在落点。移动类 effect 会递归调用这里。 */
export function resolveLanding(
  state: GameState,
  playerId: string,
  events: GameEvent[],
  depth = 0,
  registry: RuleModuleRegistry = defaultRuleModuleRegistry,
): EffectResult {
  if (depth > MAX_EFFECT_DEPTH || state.phase === 'game_over') {
    return resolveCoreLanding(state, playerId, events, depth, registry);
  }
  const player = getPlayer(state, playerId);
  const cell = state.board.cells.find((candidate) => candidate.id === player.position);
  if (!cell) return resolveCoreLanding(state, playerId, events, depth, registry);
  const handler = registry.getCellHandler(state.ruleModules, cell);
  if (!handler) throw new Error(`No enabled cell handler for ${cell.type}`);
  return handler.handle({
    state,
    playerId,
    events,
    depth,
    cell,
    applyCore: () => resolveCoreLanding(state, playerId, events, depth, registry),
  });
}

function resolveCoreLanding(
  state: GameState,
  playerId: string,
  events: GameEvent[],
  depth: number,
  registry: RuleModuleRegistry,
): EffectResult {
  if (depth > MAX_EFFECT_DEPTH) {
    throw new Error('effect depth exceeded');
  }

  // 上游已 game_over（如领工资/收租即时终局）→ 不再继续落点结算
  if (state.phase === 'game_over') return { state, events, newDebt: null };

  const player = getPlayer(state, playerId);
  const cell = state.board.cells.find((c) => c.id === player.position);
  if (!cell) return { state: { ...state, turnPhase: 'managing' }, events, newDebt: null };

  let s = state;
  let evts = events;
  let debt: DebtState | null = null;
  let turnPhase: TurnPhase = 'managing';

  if (cell.type === 'property') {
    const prop = s.properties[player.position];
    if (!prop?.ownerId) {
      turnPhase = 'awaiting_buy_decision';
    } else if (prop.ownerId === playerId && cell.subtype === 'normal') {
      turnPhase = 'awaiting_build_decision';
    } else if (prop.ownerId !== playerId) {
      const toll = getCurrentRent(s, player.position);
      if (toll > 0) {
        const intercepted = registry.runPositiveRentHooks(s.ruleModules, {
          state: s,
          events: evts,
          payerId: playerId,
          ownerId: prop.ownerId,
          cellId: player.position,
          amount: toll,
        });
        s = intercepted.state;
        evts = [...intercepted.events];
        const effectiveToll = intercepted.amount;
        const currentPlayer = getPlayer(s, playerId);
        if (effectiveToll > 0) {
          const paid = Math.min(currentPlayer.cash, effectiveToll);
          s = {
            ...s,
            players: s.players.map((p) => {
              if (p.id === playerId) return { ...p, cash: p.cash - paid };
              if (p.id === prop.ownerId) return { ...p, cash: p.cash + paid };
              return p;
            }),
          };
          evts = [...evts, { type: 'rent_paid', from: playerId, to: prop.ownerId, cellId: player.position, amount: paid }];
          // E18：收租者加钱后现金达标 → 立即终局，不再创建债务、不再继续落点链
          const rentCashGoalWin = finishCashGoalIfReached(s, evts);
          if (rentCashGoalWin) {
            return { state: rentCashGoalWin.state, events: rentCashGoalWin.events, newDebt: null };
          }
          if (paid < effectiveToll) {
            debt = { debtorId: playerId, creditorId: prop.ownerId, amount: effectiveToll - paid };
            evts = [...evts, { type: 'debt_entered', debtorId: playerId, amount: effectiveToll - paid, creditorId: prop.ownerId }];
          }
        }
      }
    }
  } else if (cell.type === 'tax') {
    const amount = (cell as { amount: number }).amount;
    const paid = Math.min(player.cash, amount);
    s = withCurrentPlayer(s, playerId, (p) => ({ ...p, cash: p.cash - paid }));
    evts = [...evts, { type: 'tax_paid', playerId, amount: paid }];
    if (paid < amount) {
      debt = { debtorId: playerId, creditorId: null, amount: amount - paid };
      evts = [...evts, { type: 'debt_entered', debtorId: playerId, amount: amount - paid, creditorId: null }];
    }
  } else if (cell.type === 'chance' || cell.type === 'destiny') {
    const deck = cell.type;
    const queue = s.decks[deck];
    if (queue.length > 0) {
      const cardId = queue[0];
      const beforePos = player.position;
      s = { ...s, decks: { ...s.decks, [deck]: [...queue.slice(1), cardId] } };
      evts = [...evts, { type: 'card_drawn', playerId, deck, cardId }];
      if (shouldConfirmCardChoice(s, playerId)) {
        // 单机真人作弊：先暂停等待接受/重抽，卡牌效果不做任何结算（见 types.CardChoiceState）。
        // resumeTurnPhase 记录默认模式在此刻传给 applyCardEffect 的环境阶段，接受时原样恢复。
        s = pauseForCardChoice(s, { playerId, deck, cardId, resumeTurnPhase: s.turnPhase });
      } else {
        const card = s.cards[deck].find((c) => c.id === cardId);
        if (card) {
          const r = applyCardEffect(s, playerId, card, evts, depth + 1, registry);
          s = r.state;
          evts = r.events;
          if (r.newDebt) debt = r.newDebt;
          const afterPos = getPlayer(s, playerId).position;
          turnPhase = afterPos !== beforePos ? s.turnPhase : 'managing';
        }
      }
    }
  } else if (cell.type === 'special' || cell.type === 'world') {
    const effect = (cell as { effect?: CellEffect }).effect;
    if (effect) {
      const beforePos = player.position;
      const r = applyCardEffect(s, playerId, { id: `cell-${cell.id}`, effect }, evts, depth + 1, registry);
      s = r.state;
      evts = r.events;
      if (r.newDebt) debt = r.newDebt;
      const afterPos = getPlayer(s, playerId).position;
      turnPhase = afterPos !== beforePos ? s.turnPhase : 'managing';
    }
  } else if (cell.type === 'airport') {
    // 机场支线只由普通掷骰“停留机场”触发；卡牌/效果移动到机场时不扩展新规则。
    turnPhase = 'managing';
  }

  return { state: { ...s, turnPhase, debt }, events: evts, newDebt: debt };
}

/** 扣玩家现金；不足触发债务（creditorId=null 对银行）。返回新玩家数组 + 实付 + 债务 */
function deductCash(
  players: PlayerState[],
  playerId: string,
  amount: number,
): { players: PlayerState[]; debt: DebtState | null } {
  const p = players.find((pp) => pp.id === playerId)!;
  const paid = Math.min(p.cash, amount);
  const newPlayers = players.map((pp) =>
    pp.id === playerId ? { ...pp, cash: pp.cash - paid } : pp,
  );
  if (paid < amount) {
    return { players: newPlayers, debt: { debtorId: playerId, creditorId: null, amount: amount - paid } };
  }
  return { players: newPlayers, debt: null };
}

/** 执行一张卡牌/格效果（递归处理 draw_card / 移动后的落点结算）。
 *  注意：直接调用者必须读取返回的 newDebt；普通掷骰流程由 resolveLanding/handleRollDice 写入 state.debt。 */
export function applyCardEffect(
  state: GameState,
  playerId: string,
  card: DeepReadonly<{ id: string; effect: CellEffect }>,
  events: GameEvent[],
  depth = 0,
  registry: RuleModuleRegistry = defaultRuleModuleRegistry,
): EffectResult {
  if (depth > MAX_EFFECT_DEPTH) {
    return applyCoreCardEffect(state, playerId, card, events, depth, registry);
  }
  if (card.effect.type === 'module') {
    const moduleCard: ReadonlyEffectCard<ModuleEffect> = {
      id: card.id,
      effect: card.effect,
    };
    const handler = registry.getEffectHandler(state.ruleModules, card.effect);
    if (!handler) throw new Error(`No enabled effect handler for ${card.effect.type}`);
    return handler.handle({
      state,
      playerId,
      card: moduleCard,
      events,
      depth,
      applyCore: () => applyCoreCardEffect(state, playerId, card, events, depth, registry),
    });
  }
  const handler = registry.getEffectHandler(state.ruleModules, card.effect);
  if (!handler) throw new Error(`No enabled effect handler for ${card.effect.type}`);
  return handler.handle({
    state,
    playerId,
    card,
    events,
    depth,
    applyCore: () => applyCoreCardEffect(state, playerId, card, events, depth, registry),
  });
}

function applyCoreCardEffect(
  state: GameState,
  playerId: string,
  card: DeepReadonly<{ id: string; effect: CellEffect }>,
  events: GameEvent[],
  depth: number,
  registry: RuleModuleRegistry,
): EffectResult {
  if (depth > MAX_EFFECT_DEPTH) throw new Error('effect depth exceeded'); // 防止链式效果无限递归

  const effect = card.effect;
  let s = state;
  let evts = events;
  let debt: DebtState | null = null;

  switch (effect.type) {
    case 'pay_bank': {
      const amount = effect.amount ?? 0;
      const r = deductCash(s.players, playerId, amount);
      s = { ...s, players: r.players };
      const paid = amount - (r.debt?.amount ?? 0); // 实付 = 应付 - 入债差额
      evts = [...evts, { type: 'bank_paid', playerId, amount: paid }];
      if (r.debt) {
        debt = r.debt;
        evts = [...evts, { type: 'debt_entered', debtorId: playerId, amount: r.debt.amount, creditorId: null }];
      }
      break;
    }
    case 'receive_bank': {
      const amount = effect.amount ?? 0;
      s = { ...s, players: s.players.map((p) => (p.id === playerId ? { ...p, cash: p.cash + amount } : p)) };
      evts = [...evts, { type: 'bank_received', playerId, amount }];
      // E18：receive_bank 加钱后现金达标 → 立即终局
      const cg = finishCashGoalIfReached(s, evts);
      if (cg) { s = cg.state; evts = cg.events; }
      break;
    }
    case 'pay_each_player': {
      // 本玩家付给其他每位在场玩家（01 §9 互动卡，如 71-02/71-27 的反向）
      const amount = effect.amount ?? 0;
      const payments: QueuedPayment[] = s.players
        .filter((p) => p.id !== playerId && !p.bankrupt)
        .map((p) => ({ debtorId: playerId, creditorId: p.id, amount }));
      const r = processQueuedPayments(s, payments, evts);
      s = r.state;
      evts = r.events;
      if (r.newDebt) debt = r.newDebt;
      break;
    }
    case 'receive_from_each_player': {
      // 其他每位玩家付给本玩家 amount（E15 多笔按座次；owner A：某付款人破产后继续收后续玩家）
      const amount = effect.amount ?? 0;
      const payments: QueuedPayment[] = s.players
        .filter((p) => p.id !== playerId && !p.bankrupt)
        .map((p) => ({ debtorId: p.id, creditorId: playerId, amount }));
      const r = processQueuedPayments(s, payments, evts);
      s = r.state;
      evts = r.events;
      if (r.newDebt) debt = r.newDebt;
      break;
    }
    case 'repairs': {
      // 按名下房屋幢数 + 旅馆数缴费（01 §9；71-06/71-19）
      const perHouse = effect.perHouse ?? 0;
      const perHotel = effect.perHotel ?? 0;
      let houses = 0;
      let hotels = 0;
      for (const [cellIdStr, prop] of Object.entries(s.properties)) {
        if (prop.ownerId !== playerId) continue;
        const cell = s.board.cells.find((c) => c.id === Number(cellIdStr));
        if (cell?.type !== 'property' || cell.subtype !== 'normal') continue;
        if (prop.level === s.config.maxHouseLevel) hotels++;
        else houses += prop.level;
      }
      const total = houses * perHouse + hotels * perHotel;
      if (total > 0) {
        const r = deductCash(s.players, playerId, total);
        s = { ...s, players: r.players };
        const paid = total - (r.debt?.amount ?? 0); // 实付
        evts = [...evts, { type: 'bank_paid', playerId, amount: paid }];
        if (r.debt) {
          debt = r.debt;
          evts = [...evts, { type: 'debt_entered', debtorId: playerId, amount: r.debt.amount, creditorId: null }];
        }
      }
      break;
    }
    case 'skip_turn': {
      // 暂停 N 回合（01 §9；河内 turns=2，两个角格 turns=1）
      const turns = effect.turns ?? 1;
      s = { ...s, players: s.players.map((p) => (p.id === playerId ? { ...p, skipTurns: p.skipTurns + turns } : p)) };
      break;
    }
    case 'draw_card': {
      // 立即再从指定牌堆抽一张并生效（71-30 命运卡联动机会）
      const deck = effect.deck ?? 'chance';
      const queue = s.decks[deck];
      if (queue.length === 0) break;
      const nextCardId = queue[0];
      const newQueue = [...queue.slice(1), nextCardId]; // 抽顶放回堆底
      s = { ...s, decks: { ...s.decks, [deck]: newQueue } };
      evts = [...evts, { type: 'card_drawn', playerId, deck, cardId: nextCardId }];
      if (shouldConfirmCardChoice(s, playerId)) {
        // 单机真人作弊：连锁抽卡同样先暂停，等待玩家接受后再结算该卡效果。
        s = pauseForCardChoice(s, { playerId, deck, cardId: nextCardId, resumeTurnPhase: s.turnPhase });
        break;
      }
      const nextCard = s.cards[deck].find((c) => c.id === nextCardId);
      if (nextCard) {
        const sub = applyCardEffect(s, playerId, nextCard, evts, depth + 1, registry);
        s = sub.state;
        evts = sub.events;
        if (sub.newDebt) debt = sub.newDebt;
      }
      break;
    }
    case 'move_to': {
      // collectSalary=true 表示“前进至”：只有真实前进路径经过/停留起点才领工资。
      // collectSalary=false 表示“退回/传送”：不领工资，动画保持跳跃。
      const targetCellId = effect.cellId ?? 0;
      const collectSalary = effect.collectSalary ?? true;
      const player = getPlayer(s, playerId);
      let newCash = player.cash;
      const walk = collectSalary
        ? walkForwardToTarget(s, player.position, targetCellId)
        : { path: [targetCellId], crossedStart: false };
      const shouldCollectSalary = collectSalary && walk.crossedStart;
      if (shouldCollectSalary) {
        newCash += s.config.passStartSalary;
      }
      s = { ...s, players: s.players.map((p) => (p.id === playerId ? { ...p, position: targetCellId, cash: newCash } : p)) };
      evts = [...evts, { type: 'token_moved', playerId, path: walk.path }];
      if (shouldCollectSalary) {
        evts = [...evts, { type: 'salary_collected', playerId, amount: s.config.passStartSalary }];
        // E18：卡牌 move_to 经过起点领工资达标 → 立即终局，不再落点结算
        const cg = finishCashGoalIfReached(s, evts);
        if (cg) return { state: cg.state, events: cg.events, newDebt: null };
      }
      const landed = resolveLanding(s, playerId, evts, depth + 1, registry);
      s = landed.state;
      evts = landed.events;
      if (landed.newDebt) debt = landed.newDebt;
      break;
    }
    case 'move_steps': {
      // 前进/后退 N 格（支线内 move_steps 越过河内自然走上外环，walkPath 已处理）
      const steps = effect.steps ?? 0;
      const player = s.players.find((p) => p.id === playerId)!;
      if (steps === 0) break;
      const walk = walkPath(s.board, player.position, steps);
      let newCash = player.cash;
      const shouldCollectSalary = walk.crossedStart;
      if (shouldCollectSalary) {
        newCash += s.config.passStartSalary;
      }
      s = { ...s, players: s.players.map((p) => (p.id === playerId ? { ...p, position: walk.finalCellId, cash: newCash } : p)) };
      evts = [...evts, { type: 'token_moved', playerId, path: walk.path }];
      if (shouldCollectSalary) {
        evts = [...evts, { type: 'salary_collected', playerId, amount: s.config.passStartSalary }];
        // E18：卡牌 move_steps 经过起点领工资达标 → 立即终局，不再落点结算
        const cg = finishCashGoalIfReached(s, evts);
        if (cg) return { state: cg.state, events: cg.events, newDebt: null };
      }
      const landed = resolveLanding(s, playerId, evts, depth + 1, registry);
      s = landed.state;
      evts = landed.events;
      if (landed.newDebt) debt = landed.newDebt;
      break;
    }
    case 'none':
      break; // 纯趣味卡（71-20），无数值效果
  }

  return { state: s, events: evts, newDebt: debt };
}
