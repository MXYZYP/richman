import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@richman/board-data';
import { greatWallMap } from '@richman/board-data';
import { applyIntent, createGame, skipCurrentTurn } from '../engine';
import { applyCardEffect, resolveLanding } from '../effects';
import { chooseBotIntent } from '../bot';
import { hydrateGameState } from '../hydrate';
import { defaultRuleModuleRegistry } from '../moduleRegistry';
import {
  GREAT_WALL_MODULE_KEY,
  greatWallBeaconCells,
} from '../greatWallModule';
import type { GameEvent, GameState, PendingModuleAction } from '../types';

const greatWallRef = { id: 'great-wall', version: 1 } as const;
const otherModuleRef = { id: 'core', version: 1 } as const;

const BEACON_CELL_ID = 5;
const BEACON_CLAIM_COST = 600;
const BEACON_TOLL = 300;
const BOT_CLAIM_RESERVE = 1000;

function makeGreatWallGame(playerCount = 2): GameState {
  return createGame({
    mapRef: greatWallMap.ref,
    ruleModules: greatWallMap.game.requiredRuleModules,
    board: greatWallMap.game.board,
    cards: greatWallMap.game.cards,
    config: greatWallMap.game.config,
    players: [
      { id: 'p1', nickname: '甲' },
      { id: 'p2', nickname: '乙' },
      { id: 'p3', nickname: '丙' },
      { id: 'p4', nickname: '丁' },
    ].slice(0, playerCount),
    seed: 'great-wall-module-state',
  });
}

function cashOf(state: GameState, playerId: string): number {
  return state.players.find((player) => player.id === playerId)!.cash;
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

function withBeaconOwners(state: GameState, owners: Record<number, string>): GameState {
  const beaconOwnersByCellId: Record<string, string> = {};
  for (const [cellId, ownerId] of Object.entries(owners)) beaconOwnersByCellId[cellId] = ownerId;
  return {
    ...state,
    publicRuleState: {
      modules: { [GREAT_WALL_MODULE_KEY]: { beaconOwnersByCellId } },
      pendingActions: [],
    },
  };
}

function moduleEventTypes(events: readonly GameEvent[]): string[] {
  return events
    .filter((event) => event.type === 'module')
    .map((event) => (event as unknown as { eventType: string }).eventType);
}

function pendingChoice(state: GameState, claim: boolean): PendingModuleAction {
  const action = state.publicRuleState.pendingActions.find((candidate) => (
    typeof candidate.payload === 'object'
    && candidate.payload !== null
    && (candidate.payload as Record<string, JsonValue>).claim === claim
  ));
  if (!action) throw new Error(`missing beacon-choice action with claim=${claim}`);
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

/** 落在指定烽火台格上，返回落点结算结果。 */
function landOnBeacon(state: GameState, playerId: string, cellId = BEACON_CELL_ID) {
  return resolveLanding(placePlayer(state, playerId, cellId), playerId, []);
}

describe('great-wall@1 public runtime state', () => {
  it('createGame 初始化精确且 JSON-safe 的空公开规则状态', () => {
    const state = makeGreatWallGame();

    expect(state.publicRuleState).toEqual({ modules: {}, pendingActions: [] });
    expect(JSON.parse(JSON.stringify(state.publicRuleState))).toEqual(state.publicRuleState);
    expect(state.ruleModules).toEqual([otherModuleRef, greatWallRef]);
  });

  it('棋盘上恰好六座烽火台，且默认 registry 认识 great-wall@1 的 beacon 格处理器', () => {
    const state = makeGreatWallGame();

    expect(greatWallBeaconCells(state.board).map((cell) => cell.id)).toEqual([5, 13, 21, 29, 36, 44]);
    for (const beacon of greatWallBeaconCells(state.board)) {
      expect(() => defaultRuleModuleRegistry.getCellHandler(state.ruleModules, beacon)).not.toThrow();
    }
  });

  it('落在无主烽火台生成两个共用 action 名的选项（占据 / 不占据）', () => {
    const base = makeGreatWallGame();
    const playerId = base.currentPlayerId;
    const landed = landOnBeacon(base, playerId);

    expect(landed.state.turnPhase).toBe('managing');
    const actions = landed.state.publicRuleState.pendingActions;
    expect(actions).toHaveLength(2);
    // 硬约束：同一时刻的待选动作必须是同一个 `模块@版本:动作`，否则 hydrate 判存档非法。
    expect([...new Set(actions.map((action) => `${action.module.id}@${action.module.version}:${action.action}`))])
      .toEqual([`${GREAT_WALL_MODULE_KEY}:beacon-choice`]);
    expect(actions.map((action) => action.requiredPhase)).toEqual(['managing', 'managing']);
    expect(actions.map((action) => action.playerId)).toEqual([playerId, playerId]);
    expect(actions.map((action) => action.label)).toEqual([
      `占据烽火台（${BEACON_CLAIM_COST} 元）`,
      '不占据',
    ]);
    expect(actions.map((action) => action.payload)).toEqual([
      {
        optionId: `${GREAT_WALL_MODULE_KEY}:beacon-choice:${playerId}:${base.turn}:${BEACON_CELL_ID}:claim`,
        cellId: BEACON_CELL_ID,
        claim: true,
      },
      {
        optionId: `${GREAT_WALL_MODULE_KEY}:beacon-choice:${playerId}:${base.turn}:${BEACON_CELL_ID}:skip`,
        cellId: BEACON_CELL_ID,
        claim: false,
      },
    ]);
    // optionId 与 payload.optionId 必须一致（hydrate 会逐条校验）。
    expect(actions.every((action) => (
      (action.payload as Record<string, JsonValue>).optionId === action.optionId
    ))).toBe(true);
  });

  it('选择占据会扣除 claimCost、写入占据关系并消费掉全部选项', () => {
    const base = makeGreatWallGame();
    const playerId = base.currentPlayerId;
    const landed = landOnBeacon(base, playerId);
    const claim = pendingChoice(landed.state, true);

    const claimed = applyIntent(landed.state, playerId, intentFor(claim));
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    expect(cashOf(claimed.state, playerId)).toBe(base.config.initialCash - BEACON_CLAIM_COST);
    expect(claimed.state.publicRuleState.modules[GREAT_WALL_MODULE_KEY]).toEqual({
      beaconOwnersByCellId: { [String(BEACON_CELL_ID)]: playerId },
    });
    expect(claimed.state.publicRuleState.pendingActions).toEqual([]);
    // 尾巴上固定是「模块事件 + 一条 core 的 bank_paid」：认领费离开牌桌必须有银行流水，
    // 否则现金守恒不变量在 simulate.ts 里会持续失配。两条都要逐字段校验。
    expect(claimed.state.recentLog.slice(-2)).toEqual([
      {
        type: 'module',
        module: greatWallRef,
        eventType: 'beacon_claimed',
        payload: { playerId, cellId: BEACON_CELL_ID, cost: BEACON_CLAIM_COST },
      },
      { type: 'bank_paid', playerId, amount: BEACON_CLAIM_COST },
    ]);
  });

  it('选择不占据只记事件、不扣钱、不写入占据关系，且选项不会被立刻摆回来', () => {
    const base = makeGreatWallGame();
    const playerId = base.currentPlayerId;
    const landed = landOnBeacon(base, playerId);
    const skip = pendingChoice(landed.state, false);

    const declined = applyIntent(landed.state, playerId, intentFor(skip));
    expect(declined.ok).toBe(true);
    if (!declined.ok) return;

    expect(cashOf(declined.state, playerId)).toBe(base.config.initialCash);
    expect(declined.state.publicRuleState.modules).toEqual({});
    // postTransitionHook 只清理、不重建：否则「不占据」会被立刻摆回来，形成点不完的循环。
    expect(declined.state.publicRuleState.pendingActions).toEqual([]);
    expect(declined.state.recentLog.slice(-1)).toEqual([{
      type: 'module',
      module: greatWallRef,
      eventType: 'beacon_declined',
      payload: { playerId, cellId: BEACON_CELL_ID },
    }]);

    // 选项放行后本回合可以正常结束。
    const ended = applyIntent(declined.state, playerId, { type: 'end_turn' });
    expect(ended.ok).toBe(true);
  });

  it('其他玩家落在已被占据的烽火台时向占据者支付通行费，且不再获得占据选项', () => {
    const base = makeGreatWallGame();
    const payer = base.currentPlayerId;
    const owner = base.players.find((player) => player.id !== payer)!.id;
    const owned = withBeaconOwners(base, { [BEACON_CELL_ID]: owner });

    const landed = landOnBeacon(owned, payer);

    expect(cashOf(landed.state, payer)).toBe(base.config.initialCash - BEACON_TOLL);
    expect(cashOf(landed.state, owner)).toBe(base.config.initialCash + BEACON_TOLL);
    expect(moduleEventTypes(landed.events)).toEqual(['beacon_toll_paid']);
    expect(landed.events).toContainEqual({
      type: 'payment_made',
      from: payer,
      to: owner,
      amount: BEACON_TOLL,
    });
    expect(landed.state.publicRuleState.pendingActions).toEqual([]);
    expect(landed.state.publicRuleState.modules[GREAT_WALL_MODULE_KEY]).toEqual({
      beaconOwnersByCellId: { [String(BEACON_CELL_ID)]: owner },
    });
    expect(landed.newDebt).toBeNull();
  });

  it('通行费付不起时差额转为债务，债权人正是烽火台占据者', () => {
    const base = makeGreatWallGame();
    const payer = base.currentPlayerId;
    const owner = base.players.find((player) => player.id !== payer)!.id;
    const owned = withBeaconOwners(setCash(base, payer, 100), { [BEACON_CELL_ID]: owner });

    const landed = landOnBeacon(owned, payer);

    expect(cashOf(landed.state, payer)).toBe(0);
    expect(cashOf(landed.state, owner)).toBe(base.config.initialCash + 100);
    expect(landed.newDebt).toEqual({
      debtorId: payer,
      creditorId: owner,
      amount: BEACON_TOLL - 100,
      resume: { payments: [] },
    });
    expect(landed.state.debt).toBeNull(); // resolveLanding 不写入 state.debt，由调用方读取 newDebt
  });

  it('占据者本人再次落回自家烽火台只记「巡视」，不产生任何费用', () => {
    const base = makeGreatWallGame();
    const owner = base.currentPlayerId;
    const owned = withBeaconOwners(base, { [BEACON_CELL_ID]: owner });

    const landed = landOnBeacon(owned, owner);

    expect(cashOf(landed.state, owner)).toBe(base.config.initialCash);
    expect(moduleEventTypes(landed.events)).toEqual(['beacon_revisited']);
    expect(landed.state.publicRuleState.pendingActions).toEqual([]);
  });

  it('现金不足以支付 claimCost 时不生成占据选项', () => {
    const base = makeGreatWallGame();
    const playerId = base.currentPlayerId;
    const landed = landOnBeacon(setCash(base, playerId, BEACON_CLAIM_COST - 1), playerId);

    expect(landed.state.publicRuleState.pendingActions).toEqual([]);
  });

  it('占据者破产后烽火台回到无主状态，其他人可以重新占据', () => {
    const base = makeGreatWallGame(3);
    const owner = base.currentPlayerId;
    const other = base.players.find((player) => player.id !== owner)!.id;

    const surrendered = applyIntent(withBeaconOwners(base, { [BEACON_CELL_ID]: owner }), owner, {
      type: 'surrender',
    });
    expect(surrendered.ok).toBe(true);
    if (!surrendered.ok) return;

    expect(surrendered.state.players.find((player) => player.id === owner)?.bankrupt).toBe(true);
    expect(surrendered.state.publicRuleState.modules).toEqual({});

    const landed = landOnBeacon(surrendered.state, other);
    expect(landed.state.publicRuleState.pendingActions).toHaveLength(2);
  });

  it('换人推进时清掉上一位玩家的失效烽火台选项', () => {
    const base = makeGreatWallGame();
    const playerId = base.currentPlayerId;
    const landed = landOnBeacon(base, playerId);
    expect(landed.state.publicRuleState.pendingActions).toHaveLength(2);

    const skipped = skipCurrentTurn(landed.state, playerId);
    expect(skipped.ok).toBe(true);
    if (!skipped.ok) return;

    expect(skipped.state.currentPlayerId).not.toBe(playerId);
    expect(skipped.state.publicRuleState.pendingActions).toEqual([]);
  });

  it('beacon-patrol 按名下烽火台数量发钱', () => {
    const base = makeGreatWallGame(3);
    const playerId = base.currentPlayerId;
    const other = base.players.find((player) => player.id !== playerId)!.id;
    const card = greatWallMap.game.cards.chance.find((candidate) => candidate.id === 'gw-c03')!;
    const owned = withBeaconOwners(base, { 5: playerId, 13: playerId, 21: other });

    const result = applyCardEffect(owned, playerId, { id: card.id, effect: card.effect }, []);

    expect(cashOf(result.state, playerId)).toBe(base.config.initialCash + 400 * 2);
    expect(moduleEventTypes(result.events)).toEqual(['beacon_patrol_paid']);
    expect(result.events).toContainEqual({
      type: 'module',
      module: greatWallRef,
      eventType: 'beacon_patrol_paid',
      payload: { playerId, beacons: 2, amount: 800 },
    });
    expect(result.events).toContainEqual({ type: 'bank_received', playerId, amount: 800 });
    // 卡牌效果只同步清理占据关系，不改动既有归属。
    expect(result.state.publicRuleState.modules[GREAT_WALL_MODULE_KEY]).toEqual({
      beaconOwnersByCellId: { '5': playerId, '13': playerId, '21': other },
    });
  });

  it('名下没有烽火台时 beacon-patrol 记空转事件且不发钱', () => {
    const base = makeGreatWallGame();
    const playerId = base.currentPlayerId;
    const card = greatWallMap.game.cards.chance.find((candidate) => candidate.id === 'gw-c03')!;

    const result = applyCardEffect(base, playerId, { id: card.id, effect: card.effect }, []);

    expect(cashOf(result.state, playerId)).toBe(base.config.initialCash);
    expect(moduleEventTypes(result.events)).toEqual(['beacon_patrol_idle']);
    expect(result.events.some((event) => event.type === 'bank_received')).toBe(false);
  });
});

describe('great-wall@1 bot strategy', () => {
  it('现金宽裕时占据烽火台', () => {
    const base = makeGreatWallGame();
    const playerId = base.currentPlayerId;
    const landed = landOnBeacon(base, playerId);

    const intent = chooseBotIntent(landed.state, playerId);
    expect(intent).toEqual({
      type: 'module',
      module: greatWallRef,
      action: 'beacon-choice',
      payload: pendingChoice(landed.state, true).payload,
    });
  });

  it('现金刚好买得起但没有安全垫余量时选择不占据', () => {
    const base = makeGreatWallGame();
    const playerId = base.currentPlayerId;
    const tight = setCash(base, playerId, BEACON_CLAIM_COST + BOT_CLAIM_RESERVE - 1);
    const landed = landOnBeacon(tight, playerId);
    expect(landed.state.publicRuleState.pendingActions).toHaveLength(2);

    const intent = chooseBotIntent(landed.state, playerId);
    expect(intent).toEqual({
      type: 'module',
      module: greatWallRef,
      action: 'beacon-choice',
      payload: pendingChoice(landed.state, false).payload,
    });
  });

  it('没有烽火台选项时把决策交回既有链路（掷骰）', () => {
    const base = makeGreatWallGame();
    const playerId = base.currentPlayerId;

    expect(chooseBotIntent(base, playerId)).toEqual({ type: 'roll_dice' });
  });
});

describe('great-wall@1 hydrate validation', () => {
  function claimedState(): GameState {
    const base = makeGreatWallGame(3);
    const playerId = base.currentPlayerId;
    const landed = landOnBeacon(base, playerId);
    const claimed = applyIntent(landed.state, playerId, intentFor(pendingChoice(landed.state, true)));
    if (!claimed.ok) throw new Error(claimed.code);
    return claimed.state;
  }

  function withModules(state: GameState, modules: Record<string, JsonValue>, pendingActions: PendingModuleAction[] = []) {
    return {
      ...structuredClone(state),
      publicRuleState: { modules, pendingActions },
    };
  }

  it('占据后的快照可由 exact Great Wall pack 无损恢复', () => {
    const state = claimedState();

    expect(hydrateGameState(structuredClone(state), greatWallMap)).toMatchObject({ ok: true });
  });

  it('占据关系指向非烽火台格时拒绝恢复', () => {
    const state = claimedState();
    const owner = state.players[0]!.id;
    const broken = withModules(state, {
      [GREAT_WALL_MODULE_KEY]: { beaconOwnersByCellId: { '4': owner } },
    });

    expect(hydrateGameState(broken, greatWallMap)).toMatchObject({ ok: false });
  });

  it('占据者不是本局玩家时拒绝恢复', () => {
    const state = claimedState();
    const broken = withModules(state, {
      [GREAT_WALL_MODULE_KEY]: { beaconOwnersByCellId: { [String(BEACON_CELL_ID)]: 'ghost' } },
    });

    expect(hydrateGameState(broken, greatWallMap)).toMatchObject({ ok: false });
  });

  it('占据者已破产时拒绝恢复', () => {
    const state = claimedState();
    const other = state.players.find((player) => player.id !== state.currentPlayerId)!;
    const broken = {
      ...withModules(state, {
        [GREAT_WALL_MODULE_KEY]: { beaconOwnersByCellId: { [String(BEACON_CELL_ID)]: other.id } },
      }),
      players: state.players.map((player) => (
        player.id === other.id ? { ...player, bankrupt: true, bankruptTurn: 2 } : player
      )),
    };

    expect(hydrateGameState(broken, greatWallMap)).toMatchObject({ ok: false });
  });

  it('占据关系的键不是规范 cellId 字符串时拒绝恢复', () => {
    const state = claimedState();
    const owner = state.players[0]!.id;
    const broken = withModules(state, {
      [GREAT_WALL_MODULE_KEY]: { beaconOwnersByCellId: { '05': owner } },
    });

    expect(hydrateGameState(broken, greatWallMap)).toMatchObject({ ok: false });
  });

  it('beacon-choice 的 payload.claim 不是布尔值时拒绝恢复', () => {
    const state = claimedState();
    const owner = state.players[0]!.id;
    const optionId = `${GREAT_WALL_MODULE_KEY}:beacon-choice:${state.currentPlayerId}:9:${BEACON_CELL_ID}:claim`;
    const broken = withModules(
      { ...state, turnPhase: 'managing' },
      { [GREAT_WALL_MODULE_KEY]: { beaconOwnersByCellId: { [String(BEACON_CELL_ID)]: owner } } },
      [{
        optionId,
        module: greatWallRef,
        playerId: state.currentPlayerId,
        requiredPhase: 'managing',
        label: '占据烽火台（600 元）',
        action: 'beacon-choice',
        payload: { optionId, cellId: BEACON_CELL_ID, claim: 'yes' },
      }],
    );

    expect(hydrateGameState(broken, greatWallMap)).toMatchObject({ ok: false });
  });

  it('beacon-choice 的 requiredPhase 与当前阶段不一致时拒绝恢复', () => {
    const state = claimedState();
    const owner = state.players[0]!.id;
    const optionId = `${GREAT_WALL_MODULE_KEY}:beacon-choice:${state.currentPlayerId}:9:${BEACON_CELL_ID}:claim`;
    const broken = withModules(
      { ...state, turnPhase: 'managing' },
      { [GREAT_WALL_MODULE_KEY]: { beaconOwnersByCellId: { [String(BEACON_CELL_ID)]: owner } } },
      [{
        optionId,
        module: greatWallRef,
        playerId: state.currentPlayerId,
        requiredPhase: 'awaiting_roll',
        label: '占据烽火台（600 元）',
        action: 'beacon-choice',
        payload: { optionId, cellId: BEACON_CELL_ID, claim: true },
      }],
    );

    expect(hydrateGameState(broken, greatWallMap)).toMatchObject({ ok: false });
  });
});
