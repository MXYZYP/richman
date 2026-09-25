import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@richman/board-data';
import { northeastTourMap } from '@richman/board-data';
import { chooseBotIntent } from '../bot';
import { applyCardEffect, resolveLanding } from '../effects';
import { applyIntent, createGame, skipCurrentTurn } from '../engine';
import { hydrateGameState } from '../hydrate';
import { defaultRuleModuleRegistry } from '../moduleRegistry';
import {
  BOT_BAIL_RESERVE,
  PRISON_MODULE_KEY,
  prisonAttemptsOf,
  prisonAwaitsDecision,
  prisonBailCost,
  prisonGotoJailCellIds,
  prisonHeldCardsOf,
  prisonIsDetained,
  prisonJailCellId,
} from '../prisonModule';
import type { GameEvent, GameState, PendingModuleAction } from '../types';

const prisonRef = { id: 'prison', version: 1 } as const;
const coreRef = { id: 'core', version: 1 } as const;

/** 与 maps/northeast-tour/v1 一致：唯一监狱角格、三个进牢格、保释金 1500 元。 */
const JAIL_CELL_ID = 42;
const GOTO_JAIL_CELL_IDS = [5, 17, 33];
const GOTO_JAIL_CELL_ID = GOTO_JAIL_CELL_IDS[0]!;
const BAIL_COST = 1500;

function makePrisonGame(playerCount = 2): GameState {
  return createGame({
    mapRef: northeastTourMap.ref,
    ruleModules: northeastTourMap.game.requiredRuleModules,
    board: northeastTourMap.game.board,
    cards: northeastTourMap.game.cards,
    config: northeastTourMap.game.config,
    players: [
      { id: 'p1', nickname: '甲' },
      { id: 'p2', nickname: '乙' },
      { id: 'p3', nickname: '丙' },
      { id: 'p4', nickname: '丁' },
    ].slice(0, playerCount),
    seed: 'prison-module-state',
  });
}

function playerOf(state: GameState, playerId: string) {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new Error(`unknown player ${playerId}`);
  return player;
}

function cashOf(state: GameState, playerId: string): number {
  return playerOf(state, playerId).cash;
}

function placePlayer(state: GameState, playerId: string, position: number): GameState {
  return {
    ...state,
    players: state.players.map((player) => (
      player.id === playerId ? { ...player, position } : player
    )),
  };
}

function setCash(state: GameState, playerId: string, cash: number): GameState {
  return {
    ...state,
    players: state.players.map((player) => (
      player.id === playerId ? { ...player, cash } : player
    )),
  };
}

function withModules(
  state: GameState,
  modules: Record<string, JsonValue>,
  pendingActions: PendingModuleAction[] = [],
): GameState {
  return {
    ...structuredClone(state),
    publicRuleState: { modules, pendingActions },
  };
}

function moduleEventTypes(events: readonly GameEvent[]): string[] {
  return events
    .filter((event) => event.type === 'module')
    .map((event) => (event as unknown as { eventType: string }).eventType);
}

/** 只取 prison@1 自己摆出来的待选动作（避免把别的模块/核心动作算进来）。 */
function choiceActions(state: GameState): PendingModuleAction[] {
  return state.publicRuleState.pendingActions.filter((action) => (
    action.module.id === prisonRef.id && action.module.version === prisonRef.version
  ));
}

function choiceOf(action: PendingModuleAction): unknown {
  const payload = action.payload;
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>).choice
    : undefined;
}

function choiceAction(state: GameState, choice: string): PendingModuleAction {
  const action = choiceActions(state).find((candidate) => choiceOf(candidate) === choice);
  if (!action) throw new Error(`missing jail-choice action: ${choice}`);
  return action;
}

function intentFor(action: PendingModuleAction) {
  return {
    type: 'module' as const,
    module: action.module,
    action: action.action,
    payload: action.payload,
  };
}

/** 让「当前玩家」停在进牢格上，返回入狱后的状态（棋子已被移到监狱角格）。 */
function jailCurrentPlayer(state: GameState): GameState {
  const playerId = state.currentPlayerId;
  return resolveLanding(placePlayer(state, playerId, GOTO_JAIL_CELL_ID), playerId, []).state;
}

/**
 * 反复「跳过当前玩家的回合」，直到轮到指定玩家且处在 `awaiting_roll`。
 *
 * 用 `skipCurrentTurn` 而不是掷骰推进：它不消费随机数、不移动棋子，因此测试与骰子无关、
 * 不会因为某位玩家半路踩进监狱或踩到别人地产而变得难解释。它照样会跑统一的
 * postTransitionHook，所以监狱选项的生成/清理走的都是生产路径。
 */
function advanceTo(state: GameState, playerId: string): GameState {
  let current = state;
  for (let step = 0; step < 12; step += 1) {
    if (current.currentPlayerId === playerId && current.turnPhase === 'awaiting_roll') return current;
    const result = skipCurrentTurn(current, current.currentPlayerId);
    if (!result.ok) throw new Error(`无法推进回合：${result.code} / ${current.turnPhase}`);
    current = result.state;
  }
  throw new Error('推进回合次数超出上限');
}

/** 造出「某玩家已在狱中、且正好轮到他做决策」的状态。 */
function jailedDecisionState(cash = 9000): { state: GameState; playerId: string } {
  const jailed = jailCurrentPlayer(makePrisonGame(2));
  const playerId = jailed.currentPlayerId;
  return { state: advanceTo(setCash(jailed, playerId, cash), playerId), playerId };
}

/** 地图上第一张带指定模块效果的卡（避免把卡 id 写死在测试里）。 */
function findCardWithEffect(effectType: string) {
  for (const deck of ['chance', 'destiny'] as const) {
    const card = northeastTourMap.game.cards[deck].find((candidate) => (
      candidate.effect.type === 'module' && candidate.effect.effectType === effectType
    ));
    if (card) return { deck, card };
  }
  throw new Error(`missing card with effect ${effectType}`);
}

describe('prison@1 public runtime state', () => {
  it('createGame 初始化空的公开规则状态，且 prison@1 已在规则模块里', () => {
    const state = makePrisonGame();

    expect(state.publicRuleState).toEqual({ modules: {}, pendingActions: [] });
    expect(state.ruleModules).toEqual([coreRef, prisonRef]);
    expect(JSON.parse(JSON.stringify(state.publicRuleState))).toEqual(state.publicRuleState);
  });

  it('棋盘恰好一个监狱角格与三个进牢格，且默认 registry 认识这两类格处理器', () => {
    const state = makePrisonGame();

    expect(prisonJailCellId(state.board)).toBe(JAIL_CELL_ID);
    expect(prisonGotoJailCellIds(state.board)).toEqual(GOTO_JAIL_CELL_IDS);
    for (const cellId of [...GOTO_JAIL_CELL_IDS, JAIL_CELL_ID]) {
      const cell = state.board.cells.find((candidate) => candidate.id === cellId)!;
      expect(() => defaultRuleModuleRegistry.getCellHandler(state.ruleModules, cell)).not.toThrow();
    }
  });

  it('保释金取自地图 config，非监狱图一律没有', () => {
    const state = makePrisonGame();

    expect(prisonBailCost(state)).toBe(BAIL_COST);
    expect(prisonBailCost({ ...state, config: { ...state.config, jailBailCost: undefined } }))
      .toBeUndefined();
    expect(BAIL_COST).toBe(northeastTourMap.game.config.jailBailCost);
  });
});

describe('prison@1 入狱', () => {
  it('停在进牢格：棋子直接移到监狱角格、本回合移动结束、attempts 归零，并发 sent_to_jail', () => {
    const base = makePrisonGame();
    const playerId = base.currentPlayerId;
    const landed = resolveLanding(placePlayer(base, playerId, GOTO_JAIL_CELL_ID), playerId, []);

    expect(playerOf(landed.state, playerId).position).toBe(JAIL_CELL_ID);
    // 不经过起点、不领报酬金：现金必须与入狱前一致（E19）。
    expect(cashOf(landed.state, playerId)).toBe(base.config.initialCash);
    expect(landed.state.turnPhase).toBe('managing');
    expect(prisonIsDetained(landed.state, playerId)).toBe(true);
    expect(prisonAttemptsOf(landed.state, playerId)).toBe(0);
    expect(moduleEventTypes(landed.events)).toEqual(['sent_to_jail']);
    expect(landed.events).toContainEqual({
      type: 'module',
      module: prisonRef,
      eventType: 'sent_to_jail',
      payload: { playerId, jailCellId: JAIL_CELL_ID },
    });
  });

  it('抽到进牢卡同样入狱，且不改动牌堆', () => {
    const base = makePrisonGame();
    const playerId = base.currentPlayerId;
    const { card } = findCardWithEffect('prison-confine');

    const result = applyCardEffect(base, playerId, { id: card.id, effect: card.effect }, []);

    expect(playerOf(result.state, playerId).position).toBe(JAIL_CELL_ID);
    expect(prisonIsDetained(result.state, playerId)).toBe(true);
    expect(moduleEventTypes(result.events)).toEqual(['sent_to_jail']);
    // 硬约束：牌堆队列原样不动，否则存档/快照会被 hydrate 判为损坏。
    expect(result.state.decks).toEqual(base.decks);
  });

  it('恰好停在监狱角格只是路过：记 jail_visited、不入狱、不收钱', () => {
    const base = makePrisonGame();
    const playerId = base.currentPlayerId;
    const landed = resolveLanding(placePlayer(base, playerId, JAIL_CELL_ID), playerId, []);

    expect(prisonIsDetained(landed.state, playerId)).toBe(false);
    expect(landed.state.turnPhase).toBe('managing');
    expect(cashOf(landed.state, playerId)).toBe(base.config.initialCash);
    expect(moduleEventTypes(landed.events)).toEqual(['jail_visited']);
  });

  it('抽到出狱许可证卡后持卡（牌堆同样不动），且持卡不进 modules 之外的任何地方', () => {
    const base = makePrisonGame();
    const playerId = base.currentPlayerId;
    const { deck, card } = findCardWithEffect('prison-card');

    const result = applyCardEffect(base, playerId, { id: card.id, effect: card.effect }, []);

    expect(prisonHeldCardsOf(result.state, playerId)).toEqual([{ deck, cardId: card.id }]);
    expect(moduleEventTypes(result.events)).toEqual(['jail_card_granted']);
    expect(result.state.decks).toEqual(base.decks);
    expect(result.state.publicRuleState.modules[PRISON_MODULE_KEY]).toEqual({
      jailedByPlayerId: {},
      heldCardsByPlayerId: { [playerId]: [{ deck, cardId: card.id }] },
    });
  });
});

describe('prison@1 出狱决策的选项', () => {
  it('轮到在押玩家：给出「掷骰 / 保释」两个共用动作名的选项，且 phase 复用 awaiting_roll', () => {
    const { state, playerId } = jailedDecisionState();

    expect(prisonAwaitsDecision(state)).toBe(true);
    expect(state.turnPhase).toBe('awaiting_roll');
    const actions = choiceActions(state);
    expect(actions.map(choiceOf)).toEqual(['roll', 'bail']);
    // 硬约束：同一时刻的待选动作必须是同一个 `模块@版本:动作`，否则 hydrate 判存档非法。
    expect([...new Set(actions.map((action) => `${action.module.id}@${action.module.version}:${action.action}`))])
      .toEqual([`${PRISON_MODULE_KEY}:jail-choice`]);
    expect(actions.map((action) => action.playerId)).toEqual([playerId, playerId]);
    expect(actions.map((action) => action.requiredPhase)).toEqual(['awaiting_roll', 'awaiting_roll']);
    expect(actions.map((action) => action.label)).toEqual([
      `掷骰尝试出狱（点数 ≥ ${state.config.jailExitMinRoll} 即可出狱）`,
      `缴纳保释金出狱（${BAIL_COST} 元）`,
    ]);
  });

  it('现金不足时不给保释选项（沿用「买不起就不给」的既有范式）', () => {
    const { state } = jailedDecisionState(BAIL_COST - 1);

    expect(choiceActions(state).map(choiceOf)).toEqual(['roll']);
  });

  it('地图没配 jailBailCost 时完全不提供保释（其余规则图照旧）', () => {
    const jailed = jailCurrentPlayer(makePrisonGame(2));
    const playerId = jailed.currentPlayerId;
    const legacy = { ...jailed, config: { ...jailed.config, jailBailCost: undefined } };
    const ready = advanceTo(legacy, playerId);

    expect(prisonBailCost(ready)).toBeUndefined();
    expect(choiceActions(ready).map(choiceOf)).toEqual(['roll']);
  });

  it('机会用尽后不再给任何选项（含保释），轮到该玩家时由钩子自动放人', () => {
    const jailed = jailCurrentPlayer(makePrisonGame(2));
    const playerId = jailed.currentPlayerId;
    const exhausted = withModules(jailed, {
      [PRISON_MODULE_KEY]: {
        jailedByPlayerId: { [playerId]: { attempts: jailed.config.jailMaxAttempts } },
        heldCardsByPlayerId: {},
      },
    });

    const ready = advanceTo(exhausted, playerId);

    expect(prisonIsDetained(ready, playerId)).toBe(false);
    expect(ready.turnPhase).toBe('awaiting_roll');
    expect(choiceActions(ready)).toEqual([]);
    expect(moduleEventTypes(ready.recentLog)).toContain('jail_released');
  });
});

describe('prison@1 保释金（owner 2026-09-23 追加）', () => {
  it('缴纳保释金：扣钱付银行、立即出狱、本回合照常掷骰移动', () => {
    const { state, playerId } = jailedDecisionState();
    const before = cashOf(state, playerId);
    const prisonStateBefore = state.publicRuleState.modules[PRISON_MODULE_KEY];

    const result = applyIntent(state, playerId, intentFor(choiceAction(state, 'bail')));
    if (!result.ok) throw new Error(result.code);

    expect(cashOf(result.state, playerId)).toBe(before - BAIL_COST);
    expect(prisonIsDetained(result.state, playerId)).toBe(false);
    // 与「使用出狱许可证」同一条路径：停在监狱格原地，等玩家掷骰。
    expect(playerOf(result.state, playerId).position).toBe(JAIL_CELL_ID);
    expect(result.state.turnPhase).toBe('awaiting_roll');
    expect(choiceActions(result.state)).toEqual([]);
    expect(moduleEventTypes(result.events)).toEqual(['jail_exited_by_bail']);
    expect(result.events).toContainEqual({
      type: 'module',
      module: prisonRef,
      eventType: 'jail_exited_by_bail',
      payload: { playerId, cost: BAIL_COST },
    });
    // 保释金离开牌桌：除模块事件外还必须发一条 core 的 bank_paid（金额与模块事件 payload 一致）。
    // 这条是 simulate.ts 现金守恒不变量（sum(玩家现金) + bankBalance === 初始资金 × 人数）的唯一依据：
    // 只扣玩家 cash 而不留银行流水，残差会永久留在账上，逐局跑模拟时必然报红。
    // 「银行收支」类统计按 core 事件求和，模块事件不算账，所以这里不存在重复计数。
    expect(result.events).toContainEqual({ type: 'bank_paid', playerId, amount: BAIL_COST });
    // 保释不动牌堆：持卡记录保持原样（此处本来为空），牌堆队列逐项一致。
    expect(result.state.publicRuleState.modules[PRISON_MODULE_KEY]).toBeUndefined();
    // 保释前在押记录确实存在（否则这条用例根本没在验证「释放后状态被清掉」）。
    expect(prisonStateBefore).toEqual({
      jailedByPlayerId: { [playerId]: { attempts: 0 } },
      heldCardsByPlayerId: {},
    });
    expect(result.state.decks).toEqual(state.decks);

    // 保释后本回合仍能正常掷骰（这正是保释金买到的东西）：仍在狱中时这个意图会被待选动作闸门挡掉
    // （pendingActions 非空且不匹配 → WRONG_PHASE）。
    // 刻意不断言「位置一定离开监狱格」：从监狱格前进 2~12 步，若落点抽到「进牢」卡，
    // 棋子会被合法地送回监狱格 —— 那依然是「掷骰被受理并已走棋」。
    const rolled = applyIntent(result.state, playerId, { type: 'roll_dice' });
    if (!rolled.ok) throw new Error(rolled.code);
    expect(rolled.events.some((event) => event.type === 'dice_rolled')).toBe(true);
    expect(prisonAwaitsDecision(rolled.state)).toBe(false);
  });

  it('保释后仍持有出狱许可证（只花钱、不动卡）', () => {
    const jailed = jailCurrentPlayer(makePrisonGame(2));
    const playerId = jailed.currentPlayerId;
    const { deck, card } = findCardWithEffect('prison-card');
    const granted = applyCardEffect(jailed, playerId, { id: card.id, effect: card.effect }, []);
    const ready = advanceTo(setCash(granted.state, playerId, 9000), playerId);

    expect(choiceActions(ready).map(choiceOf)).toEqual(['roll', 'card', 'bail']);
    const result = applyIntent(ready, playerId, intentFor(choiceAction(ready, 'bail')));
    if (!result.ok) throw new Error(result.code);

    expect(prisonHeldCardsOf(result.state, playerId)).toEqual([{ deck, cardId: card.id }]);
    expect(moduleEventTypes(result.events)).toEqual(['jail_exited_by_bail']);
  });

  it('现金不足时提交保释意图被拒（INSUFFICIENT_FUNDS），状态不动', () => {
    const { state, playerId } = jailedDecisionState();
    // 直接改现金、绕过钩子：模拟「房间快照过期 / 客户端乱提交」——选项还在，但钱已经不够了。
    const poor = setCash(state, playerId, BAIL_COST - 1);

    const result = applyIntent(poor, playerId, intentFor(choiceAction(poor, 'bail')));

    expect(result).toMatchObject({ ok: false, code: 'INSUFFICIENT_FUNDS' });
    expect(prisonIsDetained(poor, playerId)).toBe(true);
    expect(cashOf(poor, playerId)).toBe(BAIL_COST - 1);
  });

  it('地图没有保释金时提交保释意图被拒（ILLEGAL_INTENT）', () => {
    const { state, playerId } = jailedDecisionState();
    const legacy = { ...state, config: { ...state.config, jailBailCost: undefined } };

    const result = applyIntent(legacy, playerId, intentFor(choiceAction(legacy, 'bail')));

    expect(result).toMatchObject({ ok: false, code: 'ILLEGAL_INTENT' });
    expect(prisonIsDetained(legacy, playerId)).toBe(true);
  });

  it('使用出狱许可证仍与保释并存且免费：用卡不加也不扣钱', () => {
    const jailed = jailCurrentPlayer(makePrisonGame(2));
    const playerId = jailed.currentPlayerId;
    const { card } = findCardWithEffect('prison-card');
    const granted = applyCardEffect(jailed, playerId, { id: card.id, effect: card.effect }, []);
    const ready = advanceTo(setCash(granted.state, playerId, 9000), playerId);
    const before = cashOf(ready, playerId);

    const result = applyIntent(ready, playerId, intentFor(choiceAction(ready, 'card')));
    if (!result.ok) throw new Error(result.code);

    expect(cashOf(result.state, playerId)).toBe(before);
    expect(prisonHeldCardsOf(result.state, playerId)).toEqual([]);
    expect(prisonIsDetained(result.state, playerId)).toBe(false);
    expect(result.state.turnPhase).toBe('awaiting_roll');
    expect(moduleEventTypes(result.events)).toEqual(['jail_card_used', 'jail_exited_by_card']);
    expect(result.state.decks).toEqual(ready.decks);
  });
});

describe('prison@1 bot strategy', () => {
  it('没有许可证但钱够（含安全垫）时缴保释金', () => {
    const { state, playerId } = jailedDecisionState(BAIL_COST + BOT_BAIL_RESERVE);

    expect(chooseBotIntent(state, playerId)).toEqual(intentFor(choiceAction(state, 'bail')));
  });

  it('钱够交保释但没有安全垫余量时改掷骰', () => {
    const { state, playerId } = jailedDecisionState(BAIL_COST + BOT_BAIL_RESERVE - 1);

    expect(choiceActions(state).map(choiceOf)).toEqual(['roll', 'bail']);
    expect(chooseBotIntent(state, playerId)).toEqual(intentFor(choiceAction(state, 'roll')));
  });

  it('持有出狱许可证时先用卡（免费），即使钱很多', () => {
    const jailed = jailCurrentPlayer(makePrisonGame(2));
    const playerId = jailed.currentPlayerId;
    const { card } = findCardWithEffect('prison-card');
    const granted = applyCardEffect(jailed, playerId, { id: card.id, effect: card.effect }, []);
    const ready = advanceTo(setCash(granted.state, playerId, 20000), playerId);

    expect(chooseBotIntent(ready, playerId)).toEqual(intentFor(choiceAction(ready, 'card')));
  });

  it('没有监狱选项时把决策交回既有链路（掷骰）', () => {
    const base = makePrisonGame();

    expect(chooseBotIntent(base, base.currentPlayerId)).toEqual({ type: 'roll_dice' });
  });
});

describe('prison@1 hydrate validation', () => {
  it('在押 + 待选动作的快照可无损恢复（三种选项都不影响校验）', () => {
    const { state } = jailedDecisionState();

    expect(choiceActions(state).map(choiceOf)).toEqual(['roll', 'bail']);
    expect(hydrateGameState(structuredClone(state), northeastTourMap)).toMatchObject({ ok: true });
  });

  it('在押者棋子不在监狱角格时拒绝恢复', () => {
    const { state, playerId } = jailedDecisionState();
    const broken = placePlayer(state, playerId, 0);

    expect(hydrateGameState(broken, northeastTourMap)).toMatchObject({ ok: false });
  });

  it('在押者已破产时拒绝恢复', () => {
    const { state, playerId } = jailedDecisionState();
    const broken = {
      ...state,
      players: state.players.map((player) => (
        player.id === playerId ? { ...player, bankrupt: true, bankruptTurn: 2 } : player
      )),
    };

    expect(hydrateGameState(broken, northeastTourMap)).toMatchObject({ ok: false });
  });

  it('attempts 超过 jailMaxAttempts 时拒绝恢复', () => {
    const { state, playerId } = jailedDecisionState();
    const broken = withModules(state, {
      [PRISON_MODULE_KEY]: {
        jailedByPlayerId: { [playerId]: { attempts: state.config.jailMaxAttempts + 1 } },
        heldCardsByPlayerId: {},
      },
    });

    expect(hydrateGameState(broken, northeastTourMap)).toMatchObject({ ok: false });
  });

  it('持卡指向牌堆里不存在的卡时拒绝恢复', () => {
    const { state, playerId } = jailedDecisionState();
    const broken = withModules(state, {
      [PRISON_MODULE_KEY]: {
        jailedByPlayerId: { [playerId]: { attempts: 0 } },
        heldCardsByPlayerId: { [playerId]: [{ deck: 'chance', cardId: 'no-such-card' }] },
      },
    });

    expect(hydrateGameState(broken, northeastTourMap)).toMatchObject({ ok: false });
  });

  it('在押玩家轮到却没有任何 jail-choice 选项时拒绝恢复（残局）', () => {
    const { state, playerId } = jailedDecisionState();
    const broken = withModules(state, {
      [PRISON_MODULE_KEY]: {
        jailedByPlayerId: { [playerId]: { attempts: 0 } },
        heldCardsByPlayerId: {},
      },
    });

    expect(broken.turnPhase).toBe('awaiting_roll');
    expect(hydrateGameState(broken, northeastTourMap)).toMatchObject({ ok: false });
  });

  it('待选动作的 requiredPhase 与当前阶段不一致时拒绝恢复', () => {
    const { state, playerId } = jailedDecisionState();
    const optionId = `${PRISON_MODULE_KEY}:jail-choice:${playerId}:${state.turn}:bail`;
    const broken = withModules(
      state,
      {
        [PRISON_MODULE_KEY]: {
          jailedByPlayerId: { [playerId]: { attempts: 0 } },
          heldCardsByPlayerId: {},
        },
      },
      [{
        optionId,
        module: prisonRef,
        playerId,
        requiredPhase: 'managing',
        label: `缴纳保释金出狱（${BAIL_COST} 元）`,
        action: 'jail-choice',
        payload: { optionId, choice: 'bail' },
      }],
    );

    expect(hydrateGameState(broken, northeastTourMap)).toMatchObject({ ok: false });
  });
});
