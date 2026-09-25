// landmark-passport@1（地标护照 / 世界经典之旅）的模块级测试。
//
// 覆盖四件事：
//   1) 落点结算只摆选项、不动钱；盖章/不盖章共用同一动作名 `passport-choice`。
//   2) 收集式阶梯奖励：第 n 枚章给 n × 1000；盖过章的地标不再摆选项（否则纯噪音）。
//   3) 集满后过起点领「环球旅行家津贴」——判定依据是引擎自己发的 salary_collected，
//      模块不重走一遍 walkPath（避免第二条会漂移的真相）。
//   4) 回归：postTransitionHook 必须清掉失效待选动作，否则投降 / 托管跳过会留下
//      `managing` 选项把下一位玩家永久锁在 WRONG_PHASE。
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@richman/board-data';
import { classicTourMap } from '@richman/board-data';
import { applyIntent, createGame, skipCurrentTurn } from '../engine';
import { resolveLanding } from '../effects';
import { chooseBotIntent } from '../bot';
import { hydrateGameState } from '../hydrate';
import { defaultRuleModuleRegistry } from '../moduleRegistry';
import { LANDMARK_PASSPORT_MODULE_KEY, landmarkCells } from '../landmarkPassportModule';
import type { GameEvent, GameState, PendingModuleAction } from '../types';

const landmarkRef = { id: 'landmark-passport', version: 1 } as const;
const coreRef = { id: 'core', version: 1 } as const;

/** 世界经典之旅的两处地标（棋盘数组顺序 = 盖章顺序无关，仅用于总数）。 */
const LANDMARK_A = 26;
const LANDMARK_B = 39;
/** 主环最后一格：nextId 指向起点 0，站在这里掷骰必然过起点。 */
const LAST_MAIN_CELL = 51;
const STAMP_UNIT = 1000;
const LAP_BONUS = 1000;

function makeGame(playerCount = 2): GameState {
  return createGame({
    mapRef: classicTourMap.ref,
    ruleModules: classicTourMap.game.requiredRuleModules,
    board: classicTourMap.game.board,
    cards: classicTourMap.game.cards,
    config: classicTourMap.game.config,
    players: [
      { id: 'p1', nickname: '甲' },
      { id: 'p2', nickname: '乙' },
      { id: 'p3', nickname: '丙' },
    ].slice(0, playerCount),
    seed: '20260923',
  });
}

function cashOf(state: GameState, playerId: string): number {
  return state.players.find((player) => player.id === playerId)!.cash;
}

function playerOf(state: GameState, playerId: string) {
  return state.players.find((player) => player.id === playerId)!;
}

function placePlayer(state: GameState, playerId: string, position: number): GameState {
  return {
    ...state,
    players: state.players.map((player) => (
      player.id === playerId ? { ...player, position } : player
    )),
  };
}

/** 把公开模块状态写成「某玩家已盖了这些章」。 */
function withStamps(state: GameState, playerId: string, stamps: readonly number[]): GameState {
  return {
    ...state,
    publicRuleState: {
      ...state.publicRuleState,
      modules: { ...state.publicRuleState.modules, [LANDMARK_PASSPORT_MODULE_KEY]: { stampsByPlayerId: { [playerId]: [...stamps] } } },
    },
  };
}

/** 回到「等掷骰」阶段（盖章结算会把阶段停在 managing）。 */
function awaitingRoll(state: GameState): GameState {
  return { ...state, turnPhase: 'awaiting_roll' };
}

function pendingOfKind(state: GameState, kind: string): PendingModuleAction {
  const action = state.publicRuleState.pendingActions.find((candidate) => (
    typeof candidate.payload === 'object'
    && candidate.payload !== null
    && (candidate.payload as Record<string, JsonValue>).kind === kind
  ));
  if (!action) throw new Error(`missing passport-choice action with kind=${kind}`);
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

function moduleEvents(events: readonly GameEvent[]): GameEvent[] {
  return events.filter((event) => event.type === 'module');
}

function landOnLandmark(state: GameState, playerId: string, cellId = LANDMARK_A) {
  return resolveLanding(placePlayer(state, playerId, cellId), playerId, []);
}

describe('landmark-passport@1 落点结算与选项', () => {
  it('createGame 初始化干净的公开规则状态，且注册表认识 landmark-passport@1', () => {
    const state = makeGame();

    expect(state.publicRuleState).toEqual({ modules: {}, pendingActions: [] });
    expect(state.ruleModules).toEqual([coreRef, landmarkRef]);
    expect(classicTourMap.game.requiredRuleModules).toEqual([coreRef, landmarkRef]);
  });

  it('棋盘上恰好两处地标，且默认 registry 认识 landmark 格的处理器', () => {
    const state = makeGame();

    expect(landmarkCells(state.board).map((cell) => cell.id)).toEqual([LANDMARK_A, LANDMARK_B]);
    for (const cell of landmarkCells(state.board)) {
      expect(() => defaultRuleModuleRegistry.getCellHandler(state.ruleModules, cell)).not.toThrow();
    }
  });

  it('落在未盖章的地标生成两个共用 action 名的选项，且落点不动钱也不写状态', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnLandmark(base, playerId);

    expect(landed.state.turnPhase).toBe('managing');
    const actions = landed.state.publicRuleState.pendingActions;
    expect(actions).toHaveLength(2);
    expect([...new Set(actions.map((action) => `${action.module.id}@${action.module.version}:${action.action}`))])
      .toEqual([`${LANDMARK_PASSPORT_MODULE_KEY}:passport-choice`]);
    expect(actions.map((action) => action.requiredPhase)).toEqual(['managing', 'managing']);
    expect(actions.map((action) => action.playerId)).toEqual([playerId, playerId]);
    expect(actions.map((action) => action.label)).toEqual([
      `盖纪念章（第 1/2 枚，得 ${STAMP_UNIT} 元）`,
      '不盖章',
    ]);
    expect(actions.every((action) => (
      (action.payload as Record<string, JsonValue>).optionId === action.optionId
    ))).toBe(true);
    expect(cashOf(landed.state, playerId)).toBe(base.config.initialCash);
    // 护照是收集式状态，但落点本身不写：只有真正盖章才落键。
    expect(landed.state.publicRuleState.modules).toEqual({});
    expect(moduleEvents(landed.events).map((event) => (event as unknown as { eventType: string }).eventType))
      .toEqual(['landmark_visited']);
  });

  it('盖过章的地标不再摆选项（直接交回 core，不留纯噪音的选择）', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const stamped = withStamps(base, playerId, [LANDMARK_A]);

    const landed = landOnLandmark(stamped, playerId, LANDMARK_A);

    expect(landed.state.publicRuleState.pendingActions).toEqual([]);
    expect(landed.state.turnPhase).toBe('managing');
    expect(landed.events).toEqual([]);
  });
});

describe('landmark-passport@1 盖章与津贴', () => {
  it('第一枚章奖励 1000，第二枚 2000（阶梯 = 枚数 × 1000）', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;

    const first = landOnLandmark(base, playerId, LANDMARK_A);
    const stampedFirst = applyIntent(first.state, playerId, intentFor(pendingOfKind(first.state, 'stamp')));
    expect(stampedFirst.ok).toBe(true);
    if (!stampedFirst.ok) return;

    expect(cashOf(stampedFirst.state, playerId)).toBe(base.config.initialCash + STAMP_UNIT);
    expect(stampedFirst.state.publicRuleState.modules).toEqual({
      [LANDMARK_PASSPORT_MODULE_KEY]: { stampsByPlayerId: { [playerId]: [LANDMARK_A] } },
    });
    expect(stampedFirst.state.publicRuleState.pendingActions).toEqual([]);
    expect(stampedFirst.state.recentLog.slice(-2)).toEqual([
      {
        type: 'module',
        module: landmarkRef,
        eventType: 'landmark_stamped',
        payload: { playerId, cellId: LANDMARK_A, count: 1, total: 2, reward: STAMP_UNIT, completed: false },
      },
      { type: 'bank_received', playerId, amount: STAMP_UNIT },
    ]);

    const second = landOnLandmark(stampedFirst.state, playerId, LANDMARK_B);
    expect(pendingOfKind(second.state, 'stamp').label).toBe(`盖纪念章（第 2/2 枚，得 ${2 * STAMP_UNIT} 元）`);
    const stampedSecond = applyIntent(second.state, playerId, intentFor(pendingOfKind(second.state, 'stamp')));
    expect(stampedSecond.ok).toBe(true);
    if (!stampedSecond.ok) return;

    expect(cashOf(stampedSecond.state, playerId)).toBe(base.config.initialCash + STAMP_UNIT + 2 * STAMP_UNIT);
    expect(stampedSecond.state.recentLog.slice(-2)[0]).toEqual({
      type: 'module',
      module: landmarkRef,
      eventType: 'landmark_stamped',
      payload: { playerId, cellId: LANDMARK_B, count: 2, total: 2, reward: 2 * STAMP_UNIT, completed: true },
    });
    // 章按升序去重保存：同一存档只有一种字节表示。
    expect(stampedSecond.state.publicRuleState.modules).toEqual({
      [LANDMARK_PASSPORT_MODULE_KEY]: { stampsByPlayerId: { [playerId]: [LANDMARK_A, LANDMARK_B] } },
    });
  });

  it('不盖章只记事件，不写状态也不动钱', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnLandmark(base, playerId);

    const declined = applyIntent(landed.state, playerId, intentFor(pendingOfKind(landed.state, 'skip')));
    expect(declined.ok).toBe(true);
    if (!declined.ok) return;

    expect(cashOf(declined.state, playerId)).toBe(base.config.initialCash);
    expect(declined.state.publicRuleState.pendingActions).toEqual([]);
    expect(declined.state.publicRuleState.modules).toEqual({});
    expect(declined.state.recentLog.slice(-1)).toEqual([{
      type: 'module',
      module: landmarkRef,
      eventType: 'landmark_declined',
      payload: { playerId, cellId: LANDMARK_A },
    }]);

    // 选项消费后本回合可以正常结束。
    expect(applyIntent({ ...declined.state, turnPhase: 'managing' }, playerId, { type: 'end_turn' }).ok).toBe(true);
  });

  it('集满全部地标后，过起点额外领 1000 环球旅行家津贴', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const full = awaitingRoll(placePlayer(withStamps(base, playerId, [LANDMARK_A, LANDMARK_B]), playerId, LAST_MAIN_CELL));
    const before = cashOf(full, playerId);
    const rolled = applyIntent(full, playerId, { type: 'roll_dice' });
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;

    // 引擎自己发的过起点工资 + 模块追加的津贴，两者都在。
    expect(rolled.events).toContainEqual({
      type: 'salary_collected',
      playerId,
      amount: base.config.passStartSalary,
    });
    expect(rolled.events).toContainEqual({
      type: 'module',
      module: landmarkRef,
      eventType: 'passport_lap_bonus',
      payload: { playerId, amount: LAP_BONUS, stamps: 2 },
    });
    expect(cashOf(rolled.state, playerId)).toBe(before + base.config.passStartSalary + LAP_BONUS);
  });

  it('没集满时过起点只领工资，不发津贴', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const partial = awaitingRoll(placePlayer(withStamps(base, playerId, [LANDMARK_A]), playerId, LAST_MAIN_CELL));
    const before = cashOf(partial, playerId);

    const rolled = applyIntent(partial, playerId, { type: 'roll_dice' });
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;

    expect(rolled.events.some((event) => event.type === 'salary_collected')).toBe(true);
    expect(rolled.events.some((event) => (
      event.type === 'module' && (event as unknown as { eventType: string }).eventType === 'passport_lap_bonus'
    ))).toBe(false);
    expect(cashOf(rolled.state, playerId)).toBe(before + base.config.passStartSalary);
  });
});

describe('landmark-passport@1 bot 策略', () => {
  it('有盖章选项时一律盖章（免费且只赚不亏）', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOnLandmark(base, playerId);

    expect(chooseBotIntent(landed.state, playerId)).toEqual({
      type: 'module',
      module: landmarkRef,
      action: 'passport-choice',
      payload: pendingOfKind(landed.state, 'stamp').payload,
    });
  });

  it('没有地标选项时把决策交回既有链路（掷骰）', () => {
    const base = makeGame();
    expect(chooseBotIntent(base, base.currentPlayerId)).toEqual({ type: 'roll_dice' });
  });
});

describe('landmark-passport@1 失效选项清理（回归）', () => {
  it('投降推进回合后不留下失效的地标选项，下一位玩家可以正常掷骰', () => {
    const base = makeGame(3);
    const playerId = base.currentPlayerId;
    const landed = landOnLandmark(base, playerId);
    expect(landed.state.publicRuleState.pendingActions).toHaveLength(2);

    const surrendered = applyIntent(landed.state, playerId, { type: 'surrender' });
    expect(surrendered.ok).toBe(true);
    if (!surrendered.ok) return;

    expect(surrendered.state.publicRuleState.pendingActions).toEqual([]);
    const next = surrendered.state.currentPlayerId;
    expect(next).not.toBe(playerId);
    expect(applyIntent(surrendered.state, next, { type: 'roll_dice' }).ok).toBe(true);
  });

  it('托管跳过当前玩家后同样清掉失效选项', () => {
    const base = makeGame(3);
    const playerId = base.currentPlayerId;
    const landed = landOnLandmark(base, playerId);

    const skipped = skipCurrentTurn(landed.state, playerId);
    expect(skipped.ok).toBe(true);
    if (!skipped.ok) return;

    expect(skipped.state.publicRuleState.pendingActions).toEqual([]);
  });
});

describe('landmark-passport@1 hydrate 校验', () => {
  it('正常状态可以无损恢复', () => {
    const state = makeGame();
    expect(hydrateGameState(structuredClone(state), classicTourMap)).toMatchObject({ ok: true });
  });

  it('合法护照（属于存活玩家、指向真实地标、严格递增）可以恢复', () => {
    const state = withStamps(makeGame(), 'p1', [LANDMARK_A, LANDMARK_B]);
    expect(hydrateGameState(structuredClone(state), classicTourMap)).toMatchObject({ ok: true });
  });

  it('幽灵玩家 / 指向非地标 / 乱序重复 / 空数组都视为损坏存档', () => {
    const base = makeGame();
    const cases = [
      withStamps(base, 'px', [LANDMARK_A]),
      withStamps(base, 'p1', [1]),
      withStamps(base, 'p1', [LANDMARK_B, LANDMARK_A]),
      withStamps(base, 'p1', [LANDMARK_A, LANDMARK_A]),
      withStamps(base, 'p1', []),
    ];
    for (const broken of cases) {
      expect(hydrateGameState(structuredClone(broken), classicTourMap)).toMatchObject({ ok: false });
    }
  });
});
