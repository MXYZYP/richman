import { describe, expect, it } from 'vitest';
import { worldTourMap } from '@richman/board-data';
import { applyIntent, createGame, skipCurrentTurn } from '../engine';
import { applyCardEffect } from '../effects';
import { resolveLanding } from '../effects';
import { chooseBotIntent } from '../bot';
import { hydrateGameState } from '../hydrate';
import { defaultRuleModuleRegistry } from '../moduleRegistry';
import type { GameState, PendingModuleAction } from '../types';

const worldTourRef = { id: 'world-tour', version: 1 } as const;

function makeWorldGame(playerCount = 2): GameState {
  return createGame({
    mapRef: worldTourMap.ref,
    ruleModules: worldTourMap.game.requiredRuleModules,
    board: worldTourMap.game.board,
    cards: worldTourMap.game.cards,
    config: worldTourMap.game.config,
    players: [
      { id: 'p1', nickname: '甲' },
      { id: 'p2', nickname: '乙' },
      { id: 'p3', nickname: '丙' },
      { id: 'p4', nickname: '丁' },
    ].slice(0, playerCount),
    seed: 'world-tour-module-state',
  });
}

function currentPlayer(state: GameState) {
  return state.players.find((player) => player.id === state.currentPlayerId)!;
}

function pendingIntent(state: GameState) {
  const action = state.publicRuleState.pendingActions[0];
  if (!action) throw new Error('missing pending module action');
  return {
    type: 'module' as const,
    module: action.module,
    action: action.action,
    payload: action.payload,
  };
}

function readSteps(payload: PendingModuleAction['payload']): number | undefined {
  return typeof payload === 'object' && payload !== null && 'steps' in payload && typeof payload.steps === 'number'
    ? payload.steps
    : undefined;
}

function readTargetCellId(payload: PendingModuleAction['payload']): number | null | undefined {
  if (typeof payload !== 'object' || payload === null || !('targetCellId' in payload)) return undefined;
  const value = payload.targetCellId;
  return typeof value === 'number' ? value : null;
}

function makeBranchTurn(position: number): GameState {
  const state = makeWorldGame();
  const playerId = state.currentPlayerId;
  const optionId = `world-tour@1:branch-roll:${playerId}:10:${state.turn}`;
  return {
    ...state,
    players: state.players.map((player) => (
      player.id === playerId ? { ...player, position } : player
    )),
    publicRuleState: {
      modules: {
        'world-tour@1': {
          pendingAirportByPlayerId: {},
          branchAirportByPlayerId: { [playerId]: 10 },
          tollImmunityPlayerIds: [],
        },
      },
      pendingActions: [{
        optionId,
        module: worldTourRef,
        playerId,
        requiredPhase: 'awaiting_roll',
        label: '掷骰子',
        action: 'roll-branch',
        payload: { optionId },
      }],
    },
  };
}

function findWorldCard(deck: 'chance' | 'destiny', id: string) {
  const card = worldTourMap.game.cards[deck].find((candidate) => candidate.id === id);
  if (!card) throw new Error(`missing ${deck} card ${id}`);
  return card;
}

describe('world-tour@1 public runtime state', () => {
  it('createGame 初始化精确且 JSON-safe 的空公开规则状态', () => {
    const state = makeWorldGame();

    expect(state.publicRuleState).toEqual({ modules: {}, pendingActions: [] });
    expect(JSON.parse(JSON.stringify(state.publicRuleState))).toEqual(state.publicRuleState);
  });

  it('待选动作携带稳定 option identity、module、玩家、阶段、标签、action 与 payload', () => {
    const option: PendingModuleAction = {
      optionId: 'world-tour@1:airport-entry:p1:10:7',
      module: worldTourRef,
      playerId: 'p1',
      requiredPhase: 'awaiting_roll',
      label: '掷骰子',
      action: 'enter-airport-branch',
      payload: { optionId: 'world-tour@1:airport-entry:p1:10:7', airportCellId: 10 },
    };

    expect(option).toEqual({
      optionId: 'world-tour@1:airport-entry:p1:10:7',
      module: worldTourRef,
      playerId: 'p1',
      requiredPhase: 'awaiting_roll',
      label: '掷骰子',
      action: 'enter-airport-branch',
      payload: { optionId: 'world-tour@1:airport-entry:p1:10:7', airportCellId: 10 },
    });
  });

  it('默认 registry 同时认识 core@1 与 world-tour@1', () => {
    expect(() => defaultRuleModuleRegistry.getIntentHandler(
      worldTourMap.game.requiredRuleModules,
      'roll_dice',
    )).not.toThrow();
  });

  it('路过曼谷不触发，普通双骰恰停曼谷则结束本回合并记录下回合入口', () => {
    const base = makeWorldGame();
    const playerId = base.currentPlayerId;
    const passing = applyIntent({
      ...base,
      seed: '3',
      players: base.players.map((player) => (
        player.id === playerId ? { ...player, position: 8 } : player
      )),
    }, playerId, { type: 'roll_dice' });
    expect(passing.ok).toBe(true);
    if (!passing.ok) return;
    expect(currentPlayer(passing.state).position).toBe(12);
    expect(passing.state.publicRuleState).toEqual({ modules: {}, pendingActions: [] });

    const landing = applyIntent({
      ...base,
      seed: '12',
      players: base.players.map((player) => (
        player.id === playerId ? { ...player, position: 48 } : player
      )),
    }, playerId, { type: 'roll_dice' });
    expect(landing.ok).toBe(true);
    if (!landing.ok) return;
    expect(landing.state.players.find((player) => player.id === playerId)?.position).toBe(10);
    expect(landing.state.currentPlayerId).not.toBe(playerId);
    expect(landing.state.publicRuleState.modules['world-tour@1']).toMatchObject({
      pendingAirportByPlayerId: { [playerId]: 10 },
    });
    expect(landing.state.publicRuleState.pendingActions).toEqual([]);
    expect(landing.events.slice(-2).map((event) => event.type)).toEqual(['turn_ended', 'turn_started']);
  });

  it('移动效果恰停曼谷同样记录入口，轮到本人时只提供普通文案的 module 掷骰动作', () => {
    const base = makeWorldGame();
    const playerId = base.currentPlayerId;
    const moved = applyCardEffect(base, playerId, {
      id: 'move-to-bangkok',
      effect: { type: 'move_to', cellId: 10, collectSalary: false },
    }, []);
    expect(moved.state.currentPlayerId).not.toBe(playerId);
    expect(moved.state.publicRuleState.modules['world-tour@1']).toMatchObject({
      pendingAirportByPlayerId: { [playerId]: 10 },
    });

    const otherId = moved.state.currentPlayerId;
    const returned = applyIntent({ ...moved.state, turnPhase: 'managing' }, otherId, { type: 'end_turn' });
    expect(returned.ok).toBe(true);
    if (!returned.ok) return;
    expect(returned.state.currentPlayerId).toBe(playerId);
    expect(returned.state.publicRuleState.pendingActions).toHaveLength(1);
    expect(returned.state.publicRuleState.pendingActions[0]).toMatchObject({
      module: worldTourRef,
      playerId,
      requiredPhase: 'awaiting_roll',
      label: '掷骰子',
      action: 'enter-airport-branch',
      payload: { airportCellId: 10 },
    });
  });

  it('入口 intent 原子消费等待状态，单骰 1 以太平洋为第 1 步', () => {
    const base = makeWorldGame();
    const playerId = base.currentPlayerId;
    const landed = applyIntent({
      ...base,
      seed: '12',
      players: base.players.map((player) => (
        player.id === playerId ? { ...player, position: 48 } : player
      )),
    }, playerId, { type: 'roll_dice' });
    if (!landed.ok) throw new Error(landed.code);
    const otherId = landed.state.currentPlayerId;
    const returned = applyIntent({ ...landed.state, turnPhase: 'managing' }, otherId, { type: 'end_turn' });
    if (!returned.ok) throw new Error(returned.code);

    const entered = applyIntent({ ...returned.state, seed: '7' }, playerId, pendingIntent(returned.state));
    expect(entered.ok).toBe(true);
    if (!entered.ok) return;
    expect(entered.events.slice(0, 2)).toEqual([
      { type: 'dice_rolled', playerId, dice: [1] },
      { type: 'token_moved', playerId, path: [40] },
    ]);
    expect(currentPlayer(entered.state).position).toBe(40);
    expect(entered.state.publicRuleState.modules['world-tour@1']).toMatchObject({
      pendingAirportByPlayerId: {},
      branchAirportByPlayerId: { [playerId]: 10 },
    });
    expect(entered.state.publicRuleState.pendingActions).toEqual([]);

    expect(applyIntent(returned.state, playerId, pendingIntent(returned.state))).toMatchObject({ ok: true });
    expect(applyIntent(entered.state, playerId, pendingIntent(returned.state))).toEqual({
      ok: false,
      code: 'WRONG_PHASE',
    });
  });

  it('离线跳过机场等待回合不掷骰、不推进随机数，并在下个个人回合恢复同一入口', () => {
    const base = makeWorldGame();
    const playerId = base.currentPlayerId;
    const moved = applyCardEffect(base, playerId, {
      id: 'move-to-bangkok-for-offline-skip',
      effect: { type: 'move_to', cellId: 10, collectSalary: false },
    }, []);
    const otherId = moved.state.currentPlayerId;
    const returned = applyIntent({ ...moved.state, turnPhase: 'managing' }, otherId, { type: 'end_turn' });
    if (!returned.ok) throw new Error(returned.code);
    const seedBefore = returned.state.seed;

    const skipped = skipCurrentTurn(returned.state, playerId);
    expect(skipped.ok).toBe(true);
    if (!skipped.ok) return;
    expect(skipped.state.seed).toBe(seedBefore);
    expect(skipped.state.currentPlayerId).toBe(otherId);
    expect(skipped.state.players.find((player) => player.id === playerId)?.position).toBe(10);
    expect(skipped.state.publicRuleState.modules['world-tour@1']).toMatchObject({
      pendingAirportByPlayerId: { [playerId]: 10 },
    });
    expect(skipped.state.publicRuleState.pendingActions).toEqual([]);

    const nextReturn = skipCurrentTurn(skipped.state, otherId);
    expect(nextReturn.ok).toBe(true);
    if (!nextReturn.ok) return;
    expect(nextReturn.state.currentPlayerId).toBe(playerId);
    expect(nextReturn.state.publicRuleState.pendingActions[0]).toMatchObject({
      playerId,
      action: 'enter-airport-branch',
      payload: { airportCellId: 10 },
    });
  });

  it('支线回合拒绝普通双骰，单骰超出出口后继续从挪威走向外环', () => {
    const state = { ...makeBranchTurn(46), seed: '4' };
    const playerId = state.currentPlayerId;

    expect(applyIntent(state, playerId, { type: 'roll_dice' })).toEqual({
      ok: false,
      code: 'WRONG_PHASE',
    });
    const result = applyIntent(state, playerId, pendingIntent(state));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events.slice(0, 2)).toEqual([
      { type: 'dice_rolled', playerId, dice: [6] },
      { type: 'token_moved', playerId, path: [47, 31, 32, 33, 34, 35] },
    ]);
    expect(currentPlayer(result.state).position).toBe(35);
    expect(result.state.publicRuleState.modules['world-tour@1']).toBeUndefined();
  });

  it('支线单骰状态可由 exact World Tour pack 无损恢复', () => {
    const state = makeBranchTurn(44);
    expect(hydrateGameState(structuredClone(state), worldTourMap)).toMatchObject({ ok: true });
  });

  it('支线暂停恰好跳过下一次个人回合，保留支线归属并在再下一回合恢复单骰动作', () => {
    const state = { ...makeBranchTurn(40), seed: '7' };
    const playerId = state.currentPlayerId;
    const paused = applyIntent(state, playerId, pendingIntent(state));
    expect(paused.ok).toBe(true);
    if (!paused.ok) return;
    expect(currentPlayer(paused.state)).toMatchObject({ position: 41, skipTurns: 1 });

    const ended = applyIntent(paused.state, playerId, { type: 'end_turn' });
    if (!ended.ok) throw new Error(ended.code);
    const otherId = ended.state.currentPlayerId;
    const skipped = applyIntent({ ...ended.state, turnPhase: 'managing' }, otherId, { type: 'end_turn' });
    if (!skipped.ok) throw new Error(skipped.code);
    expect(skipped.state.currentPlayerId).toBe(otherId);
    expect(skipped.state.players.find((player) => player.id === playerId)?.skipTurns).toBe(0);
    expect(skipped.state.publicRuleState.modules['world-tour@1']).toMatchObject({
      branchAirportByPlayerId: { [playerId]: 10 },
    });

    const returned = applyIntent({ ...skipped.state, turnPhase: 'managing' }, otherId, { type: 'end_turn' });
    if (!returned.ok) throw new Error(returned.code);
    expect(returned.state.currentPlayerId).toBe(playerId);
    expect(returned.state.publicRuleState.pendingActions[0]).toMatchObject({ action: 'roll-branch' });
  });

  it('bot 对机场入口和支线回合复用同一权威 module intent', () => {
    const state = makeBranchTurn(40);
    expect(chooseBotIntent(state, state.currentPlayerId)).toEqual(pendingIntent(state));
  });

  it('破产后清除机场等待、支线归属和免过路费状态', () => {
    const base = makeWorldGame();
    const playerId = base.currentPlayerId;
    const state: GameState = {
      ...base,
      turnPhase: 'managing',
      debt: { debtorId: playerId, creditorId: null, amount: 999_999 },
      players: base.players.map((player) => (
        player.id === playerId ? { ...player, cash: 0, position: 10 } : player
      )),
      publicRuleState: {
        modules: {
          'world-tour@1': {
            pendingAirportByPlayerId: { [playerId]: 10 },
            branchAirportByPlayerId: {},
            tollImmunityPlayerIds: [playerId],
          },
        },
        pendingActions: [],
      },
    };

    const result = applyIntent(state, playerId, { type: 'declare_bankrupt' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.publicRuleState).toEqual({ modules: {}, pendingActions: [] });
  });

  it('C02 不叠加；零租金不消耗，下一次正过路费被完整抵消后消耗', () => {
    const base = makeWorldGame();
    const playerId = base.currentPlayerId;
    const ownerId = base.players.find((player) => player.id !== playerId)!.id;
    const first = applyCardEffect(base, playerId, findWorldCard('chance', 'C02'), []);
    const second = applyCardEffect(first.state, playerId, findWorldCard('chance', 'C02'), []);
    expect((second.state.publicRuleState.modules['world-tour@1'] as any).tollImmunityPlayerIds).toEqual([playerId]);

    const mortgaged = resolveLanding({
      ...second.state,
      players: second.state.players.map((player) => (
        player.id === playerId ? { ...player, position: 1 } : player
      )),
      properties: {
        ...second.state.properties,
        1: { ownerId, level: 0, mortgaged: true },
      },
    }, playerId, []);
    expect((mortgaged.state.publicRuleState.modules['world-tour@1'] as any).tollImmunityPlayerIds).toEqual([playerId]);

    const beforeCash = currentPlayer(mortgaged.state).cash;
    const charged = resolveLanding({
      ...mortgaged.state,
      properties: {
        ...mortgaged.state.properties,
        1: { ownerId, level: 0, mortgaged: false },
      },
    }, playerId, []);
    expect(currentPlayer(charged.state).cash).toBe(beforeCash);
    expect(charged.events.some((event) => event.type === 'rent_paid')).toBe(false);
    expect(charged.events).toContainEqual(expect.objectContaining({
      type: 'module', eventType: 'toll_immunity_used',
    }));
    expect(charged.state.publicRuleState.modules['world-tour@1']).toBeUndefined();
  });

  it('C21 先掷两骰再给骰 A、骰 B、总和三个确定选项，选后正常前进结算', () => {
    const base = makeWorldGame();
    const playerId = base.currentPlayerId;
    const state = {
      ...base,
      seed: '12',
      turnPhase: 'managing' as const,
      players: base.players.map((player) => (
        player.id === playerId ? { ...player, position: 30 } : player
      )),
    };
    const offered = applyCardEffect(state, playerId, findWorldCard('chance', 'C21'), []);
    expect(offered.events).toContainEqual({ type: 'dice_rolled', playerId, dice: [2, 1] });
    expect(offered.state.publicRuleState.pendingActions.map((action) => readSteps(action.payload))).toEqual([2, 1, 3]);

    const chosenState = {
      ...offered.state,
      publicRuleState: {
        ...offered.state.publicRuleState,
        pendingActions: [offered.state.publicRuleState.pendingActions[2]],
      },
    };
    const moved = applyIntent(chosenState, playerId, pendingIntent(chosenState));
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.events).toContainEqual({ type: 'token_moved', playerId, path: [31, 32, 33] });
    expect(currentPlayer(moved.state).position).toBe(33);
  });

  it('C22 短途航班可拒绝；支付3500后只可选前方1至6步的主环地产/海洋且不领工资', () => {
    const base = makeWorldGame();
    const playerId = base.currentPlayerId;
    const state = {
      ...base,
      turnPhase: 'managing' as const,
      players: base.players.map((player) => (
        player.id === playerId ? { ...player, position: 27 } : player
      )),
    };
    const offered = applyCardEffect(state, playerId, findWorldCard('chance', 'C22'), []);
    const offeredTargets = offered.state.publicRuleState.pendingActions
      .map((action) => readTargetCellId(action.payload));
    expect(offeredTargets).toEqual([null, 28, 52, 53, 54, 55]);
    // 公用事业格（苏伊士运河50、巴拿马运河56）不得作为航班目的地
    expect(offeredTargets).not.toContain(50);
    expect(offeredTargets).not.toContain(56);

    const declinedAction = offered.state.publicRuleState.pendingActions[0];
    const declineState = { ...offered.state, publicRuleState: { ...offered.state.publicRuleState, pendingActions: [declinedAction] } };
    const declined = applyIntent(declineState, playerId, pendingIntent(declineState));
    expect(declined.ok).toBe(true);
    if (!declined.ok) return;
    expect(currentPlayer(declined.state)).toMatchObject({ position: 27, cash: currentPlayer(state).cash });

    const targetAction = offered.state.publicRuleState.pendingActions.at(-1)!;
    const paidState = { ...offered.state, publicRuleState: { ...offered.state.publicRuleState, pendingActions: [targetAction] } };
    const paid = applyIntent(paidState, playerId, pendingIntent(paidState));
    expect(paid.ok).toBe(true);
    if (!paid.ok) return;
    expect(currentPlayer(paid.state)).toMatchObject({ position: 55, cash: currentPlayer(state).cash - 3500 });
    expect(paid.events).toContainEqual({ type: 'bank_paid', playerId, amount: 3500 });
    expect(paid.events.some((event) => event.type === 'salary_collected')).toBe(false);
  });

  it('C23 长途航班支付8000后可选主环全部38块地产/海洋，另有拒绝选项', () => {
    const base = makeWorldGame();
    const playerId = base.currentPlayerId;
    const offered = applyCardEffect(
      { ...base, turnPhase: 'managing' },
      playerId,
      findWorldCard('chance', 'C23'),
      [],
    );
    const actions = offered.state.publicRuleState.pendingActions;
    expect(actions).toHaveLength(39);
    expect(readTargetCellId(actions[0].payload)).toBeNull();
    const offeredTargets = actions
      .slice(1)
      .map((action) => readTargetCellId(action.payload))
      .filter((value): value is number => typeof value === 'number');
    expect(offeredTargets).toEqual(expect.arrayContaining([1, 5, 24, 37, 39, 48, 51, 55, 59]));
    // 公用事业格不得作为航班目的地
    expect(offeredTargets).not.toContain(50);
    expect(offeredTargets).not.toContain(56);
  });

  it('D02 可免费升级自己、对手或无主的未抵押普通地产，并可从三栋升级为旅馆', () => {
    const base = makeWorldGame();
    const playerId = base.currentPlayerId;
    const opponentId = base.players.find((player) => player.id !== playerId)!.id;
    const state: GameState = {
      ...base,
      turnPhase: 'managing',
      properties: {
        ...base.properties,
        1: { ownerId: null, level: 0, mortgaged: false },
        2: { ownerId: playerId, level: 3, mortgaged: false },
        4: { ownerId: opponentId, level: 0, mortgaged: false },
        7: { ownerId: opponentId, level: 0, mortgaged: true },
      },
    };
    const offered = applyCardEffect(state, playerId, findWorldCard('destiny', 'D02'), []);
    const targetIds = offered.state.publicRuleState.pendingActions.map((action) => (action.payload as any).cellId);
    expect(targetIds).toEqual(expect.arrayContaining([1, 2, 4]));
    expect(targetIds).not.toContain(7);
    expect(targetIds).not.toContain(5);

    const unownedAction = offered.state.publicRuleState.pendingActions.find((action) => (action.payload as any).cellId === 1)!;
    const unownedState = { ...offered.state, publicRuleState: { ...offered.state.publicRuleState, pendingActions: [unownedAction] } };
    const upgraded = applyIntent(unownedState, playerId, pendingIntent(unownedState));
    expect(upgraded.ok).toBe(true);
    if (!upgraded.ok) return;
    expect(upgraded.state.properties[1]).toEqual({ ownerId: null, level: 1, mortgaged: false });
    expect(upgraded.events.find((e) => e.type === 'house_built')).toMatchObject({ cellId: 1, level: 1, amount: 0 });
    expect(hydrateGameState(structuredClone(upgraded.state), worldTourMap)).toMatchObject({ ok: true });

    const hotelAction = offered.state.publicRuleState.pendingActions.find((action) => (action.payload as any).cellId === 2)!;
    const hotelState = { ...offered.state, publicRuleState: { ...offered.state.publicRuleState, pendingActions: [hotelAction] } };
    const hotel = applyIntent(hotelState, playerId, pendingIntent(hotelState));
    expect(hotel.ok).toBe(true);
    if (hotel.ok) expect(hotel.state.properties[2].level).toBe(4);
  });

  it('D21 选择对手后用状态 RNG 单骰重掷至非平局，输家通过付款队列支付1200', () => {
    const base = makeWorldGame();
    const playerId = base.currentPlayerId;
    const opponentId = base.players.find((player) => player.id !== playerId)!.id;
    const offered = applyCardEffect(
      { ...base, seed: '7', turnPhase: 'managing' },
      playerId,
      findWorldCard('destiny', 'D21'),
      [],
    );
    expect(offered.state.publicRuleState.pendingActions).toHaveLength(1);
    expect(offered.state.publicRuleState.pendingActions[0].payload).toMatchObject({ opponentId });
    const result = applyIntent(offered.state, playerId, pendingIntent(offered.state));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const diceEvents = result.events.filter((event) => event.type === 'dice_rolled');
    expect(diceEvents.length).toBeGreaterThanOrEqual(2);
    expect(result.events).toContainEqual(expect.objectContaining({ type: 'payment_made', amount: 1200 }));
    expect(applyIntent(offered.state, playerId, pendingIntent(offered.state))).toEqual(result);
  });

  it('D22 现金最少并列时从抽卡者起按座次选择，目标从银行获得2000', () => {
    const base = makeWorldGame(3);
    const playerId = base.currentPlayerId;
    const currentIndex = base.players.findIndex((player) => player.id === playerId);
    const nextPlayer = base.players[(currentIndex + 1) % base.players.length];
    const state = {
      ...base,
      players: base.players.map((player) => (
        player.id === playerId ? { ...player, cash: 5000 } : { ...player, cash: 1000 }
      )),
    };
    const result = applyCardEffect(state, playerId, findWorldCard('destiny', 'D22'), []);
    expect(result.state.players.find((player) => player.id === nextPlayer.id)?.cash).toBe(3000);
    expect(result.events).toContainEqual({ type: 'bank_received', playerId: nextPlayer.id, amount: 2000 });
  });

  it('World Tour 维修以 maxHouseLevel=4 识别旅馆，China Tour level=5 行为保持不变', () => {
    const base = makeWorldGame();
    const playerId = base.currentPlayerId;
    const state = {
      ...base,
      properties: { ...base.properties, 1: { ownerId: playerId, level: 4, mortgaged: false } },
    };
    const before = currentPlayer(state).cash;
    const result = applyCardEffect(state, playerId, findWorldCard('chance', 'C09'), []);
    expect(currentPlayer(result.state).cash).toBe(before - 900);
  });

  it('45 张正式卡均可由统一 effect pipeline 确定性执行或生成权威选择', () => {
    for (const deck of ['chance', 'destiny'] as const) {
      for (const card of worldTourMap.game.cards[deck]) {
        const state = makeWorldGame();
        expect(() => applyCardEffect(
          { ...state, turnPhase: 'managing' },
          state.currentPlayerId,
          card,
          [],
        ), `${deck}:${card.id}`).not.toThrow();
      }
    }
  });
});
