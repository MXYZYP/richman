// port-trade@1（湾区口岸 / 珠江之旅）的模块级测试。
//
// 覆盖四件事：
//   1) 落点只摆选项（押注 / 不押注），同一动作名下两分支。
//   2) 押注是「现场掷两骰」：赢则连本带利拿回、输则押金没收；随机数状态写回 state.seed。
//   3) 现金不足押金时不生成押注选项。
//   4) 回归：本模块没有公共状态，但必须靠 postTransitionHook 清掉失效待选动作。
//
// 种子是刻意挑的（用真实流程探针枚举出来的，见下方两条断言的 win 真假）：
// 注意 createGame 内部洗牌会消耗随机数，所以不能拿裸种子直接算点数 —— 探针必须在建局之后掷。
// 这两个种子只保证「赢 / 输」的走向，具体点数是断言不变量而不是断言字面值，避免被 RNG 调整打碎。
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@richman/board-data';
import { pearlTourMap } from '@richman/board-data';
import { applyIntent, createGame, skipCurrentTurn } from '../engine';
import { resolveLanding } from '../effects';
import { chooseBotIntent } from '../bot';
import { hydrateGameState } from '../hydrate';
import { defaultRuleModuleRegistry } from '../moduleRegistry';
import { PORT_TRADE_MODULE_KEY, portCells } from '../portTradeModule';
import type { GameEvent, GameState, PendingModuleAction } from '../types';

const portRef = { id: 'port-trade', version: 1 } as const;
const coreRef = { id: 'core', version: 1 } as const;

const PORT_A = 16;
const PORT_B = 35;
const STAKE = 600;
const WIN_PAYOUT = 1500;
const WIN_THRESHOLD = 8;
const WIN_DELTA = WIN_PAYOUT - STAKE;
const BOT_STAKE_RESERVE = 800;

/** 探针验证过走向的两个种子：port-1 必赢、port-3 必输。 */
const WIN_SEED = 'port-1';
const LOSE_SEED = 'port-3';

interface PortTradedPayload {
  readonly playerId: string;
  readonly cellId: number;
  readonly dice: readonly number[];
  readonly sum: number;
  readonly win: boolean;
  readonly stake: number;
  readonly payout: number;
}

function makeGame(playerCount = 2, seed = WIN_SEED): GameState {
  return createGame({
    mapRef: pearlTourMap.ref,
    ruleModules: pearlTourMap.game.requiredRuleModules,
    board: pearlTourMap.game.board,
    cards: pearlTourMap.game.cards,
    config: pearlTourMap.game.config,
    players: [
      { id: 'p1', nickname: '甲' },
      { id: 'p2', nickname: '乙' },
      { id: 'p3', nickname: '丙' },
    ].slice(0, playerCount),
    seed,
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

function moduleEvents(events: readonly GameEvent[]): { eventType: string; payload: JsonValue }[] {
  return events
    .filter((event) => event.type === 'module')
    .map((event) => event as unknown as { eventType: string; payload: JsonValue });
}

function pendingOfKind(state: GameState, kind: string): PendingModuleAction {
  const action = state.publicRuleState.pendingActions.find((candidate) => (
    typeof candidate.payload === 'object'
    && candidate.payload !== null
    && (candidate.payload as Record<string, JsonValue>).kind === kind
  ));
  if (!action) throw new Error(`missing port-choice action with kind=${kind}`);
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

function landOnPort(state: GameState, playerId: string, cellId = PORT_A) {
  return resolveLanding(placePlayer(state, playerId, cellId), playerId, []);
}

describe('port-trade@1 落点结算与选项', () => {
  it('createGame 初始化干净的公开规则状态，且注册表认识 port-trade@1', () => {
    const state = makeGame();

    expect(state.publicRuleState).toEqual({ modules: {}, pendingActions: [] });
    expect(state.ruleModules).toEqual([coreRef, portRef]);
  });

  it('棋盘上恰好两处口岸，且默认 registry 认识 port 格的处理器', () => {
    const state = makeGame();

    expect(portCells(state.board).map((cell) => cell.id)).toEqual([PORT_A, PORT_B]);
    for (const port of portCells(state.board)) {
      expect(() => defaultRuleModuleRegistry.getCellHandler(state.ruleModules, port)).not.toThrow();
    }
  });

  it('落在口岸生成两个共用 action 名的选项，落点本身不动钱', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnPort(base, playerId);

    expect(landed.state.turnPhase).toBe('managing');
    const actions = landed.state.publicRuleState.pendingActions;
    expect(actions).toHaveLength(2);
    expect([...new Set(actions.map((action) => `${action.module.id}@${action.module.version}:${action.action}`))])
      .toEqual([`${PORT_TRADE_MODULE_KEY}:port-choice`]);
    expect(actions.map((action) => action.requiredPhase)).toEqual(['managing', 'managing']);
    expect(actions.map((action) => action.label)).toEqual([
      `押货下注（押 ${STAKE}，两骰 ≥ 8 得 ${WIN_PAYOUT}）`,
      '不押货',
    ]);
    expect(actions.every((action) => (
      (action.payload as Record<string, JsonValue>).optionId === action.optionId
    ))).toBe(true);
    expect(cashOf(landed.state, playerId)).toBe(base.config.initialCash);
    expect(moduleEvents(landed.events).map((event) => event.eventType)).toEqual(['port_visited']);
  });
});

describe('port-trade@1 押注结算', () => {
  it('掷出达标点数时连本带利拿回，净赚 WIN_PAYOUT − STAKE', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnPort(base, playerId);
    const seedBeforeStake = landed.state.seed;
    const stake = pendingOfKind(landed.state, 'stake');

    const traded = applyIntent(landed.state, playerId, intentFor(stake));
    expect(traded.ok).toBe(true);
    if (!traded.ok) return;

    const [tradedEvent] = moduleEvents(traded.events);
    expect(tradedEvent!.eventType).toBe('port_traded');
    const payload = tradedEvent!.payload as unknown as PortTradedPayload;
    expect(payload.playerId).toBe(playerId);
    expect(payload.cellId).toBe(PORT_A);
    expect(payload.stake).toBe(STAKE);
    expect(payload.win).toBe(true);
    // 不变量：两颗骰子各在 1..6、和 = 两点数之和、且达标才判赢。
    expect(payload.dice).toHaveLength(2);
    expect(payload.dice.every((die) => Number.isInteger(die) && die >= 1 && die <= 6)).toBe(true);
    expect(payload.sum).toBe(payload.dice[0]! + payload.dice[1]!);
    expect(payload.sum).toBeGreaterThanOrEqual(WIN_THRESHOLD);
    expect(payload.payout).toBe(WIN_PAYOUT);
    expect(cashOf(traded.state, playerId)).toBe(base.config.initialCash + WIN_DELTA);
    expect(traded.events).toContainEqual({ type: 'bank_received', playerId, amount: WIN_DELTA });
    // 掷骰结果写回 lastDice 与 seed（同 seed 全局可复现，联机双方看到同一组点数）。
    expect(traded.state.lastDice).toEqual([...payload.dice]);
    expect(traded.state.seed).not.toBe(seedBeforeStake);
    expect(traded.state.publicRuleState.pendingActions).toEqual([]);
  });

  it('点数不达标时押金没收，且不留下任何公共模块状态', () => {
    const base = makeGame(2, LOSE_SEED);
    const playerId = base.currentPlayerId;
    const landed = landOnPort(base, playerId);
    const stake = pendingOfKind(landed.state, 'stake');

    const traded = applyIntent(landed.state, playerId, intentFor(stake));
    expect(traded.ok).toBe(true);
    if (!traded.ok) return;

    const [tradedEvent] = moduleEvents(traded.events);
    expect(tradedEvent!.eventType).toBe('port_traded');
    const payload = tradedEvent!.payload as unknown as PortTradedPayload;
    expect(payload.win).toBe(false);
    expect(payload.sum).toBe(payload.dice[0]! + payload.dice[1]!);
    expect(payload.sum).toBeLessThan(WIN_THRESHOLD);
    expect(payload.payout).toBe(0);
    expect(cashOf(traded.state, playerId)).toBe(base.config.initialCash - STAKE);
    expect(traded.events).toContainEqual({ type: 'bank_paid', playerId, amount: STAKE });
    expect(traded.state.publicRuleState.modules).toEqual({});
  });

  it('不押货只记事件、不扣钱，且选项不会被立刻摆回来', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnPort(base, playerId);

    const declined = applyIntent(landed.state, playerId, intentFor(pendingOfKind(landed.state, 'skip')));
    expect(declined.ok).toBe(true);
    if (!declined.ok) return;

    expect(cashOf(declined.state, playerId)).toBe(base.config.initialCash);
    expect(declined.state.publicRuleState.pendingActions).toEqual([]);
    expect(moduleEvents(declined.events).map((event) => event.eventType)).toEqual(['port_declined']);

    const ended = applyIntent(declined.state, playerId, { type: 'end_turn' });
    expect(ended.ok).toBe(true);
  });

  it('现金不足押金时不生成押注选项', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnPort(setCash(base, playerId, STAKE - 1), playerId);

    expect(landed.state.publicRuleState.pendingActions).toHaveLength(1);
    expect(landed.state.publicRuleState.pendingActions[0]!.label).toBe('不押货');
  });
});

describe('port-trade@1 bot 策略', () => {
  it('现金宽裕时押货下注', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnPort(setCash(base, playerId, STAKE + BOT_STAKE_RESERVE), playerId);

    expect(chooseBotIntent(landed.state, playerId)).toEqual({
      type: 'module',
      module: portRef,
      action: 'port-choice',
      payload: pendingOfKind(landed.state, 'stake').payload,
    });
  });

  it('没有安全垫余量时不押货', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnPort(setCash(base, playerId, STAKE + BOT_STAKE_RESERVE - 1), playerId);

    expect(chooseBotIntent(landed.state, playerId)).toEqual({
      type: 'module',
      module: portRef,
      action: 'port-choice',
      payload: pendingOfKind(landed.state, 'skip').payload,
    });
  });

  it('没有口岸选项时把决策交回既有链路（掷骰）', () => {
    const base = makeGame();
    expect(chooseBotIntent(base, base.currentPlayerId)).toEqual({ type: 'roll_dice' });
  });
});

describe('port-trade@1 失效选项清理（回归）', () => {
  it('投降推进回合后不留下失效的口岸选项，下一位玩家可以正常掷骰', () => {
    const base = makeGame(3);
    const playerId = base.currentPlayerId;
    const landed = landOnPort(base, playerId);

    const surrendered = applyIntent(landed.state, playerId, { type: 'surrender' });
    expect(surrendered.ok).toBe(true);
    if (!surrendered.ok) return;

    expect(surrendered.state.publicRuleState.pendingActions).toEqual([]);
    const next = surrendered.state.currentPlayerId;
    expect(applyIntent(surrendered.state, next, { type: 'roll_dice' }).ok).toBe(true);
  });

  it('托管跳过当前玩家后同样清掉失效选项', () => {
    const base = makeGame(3);
    const playerId = base.currentPlayerId;
    const landed = landOnPort(base, playerId);

    const skipped = skipCurrentTurn(landed.state, playerId);
    expect(skipped.ok).toBe(true);
    if (!skipped.ok) return;

    expect(skipped.state.publicRuleState.pendingActions).toEqual([]);
  });
});

describe('port-trade@1 hydrate 校验', () => {
  it('正常状态可以无损恢复', () => {
    const state = makeGame();
    expect(hydrateGameState(structuredClone(state), pearlTourMap)).toMatchObject({ ok: true });
  });

  it('无状态模块在 publicRuleState.modules 里出现键即视为损坏存档', () => {
    const state = makeGame();
    const broken = {
      ...structuredClone(state),
      publicRuleState: { modules: { [PORT_TRADE_MODULE_KEY]: { marketPrice: 1000 } }, pendingActions: [] },
    };

    expect(hydrateGameState(broken, pearlTourMap)).toMatchObject({ ok: false });
  });
});
