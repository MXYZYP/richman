import { describe, expect, test } from 'vitest';
import { getActiveMapPack } from '@richman/board-data';
import type { GameState, Intent } from '@richman/engine';
import {
  applyGameIntent,
  chooseTakeoverIntent,
  createInitialGame,
  defaultGameGateway,
  isValidIntent,
  type GameRuntimeGateway,
} from '../game/gameRuntime';

const players = [
  { id: 'p1', nickname: 'Alice', isBot: false },
  { id: 'p2', nickname: 'Bot Bob', isBot: true },
];
const mapPack = getActiveMapPack('china-tour');

function startState(seed = 'runtime-seed'): GameState {
  const created = createInitialGame(defaultGameGateway, players, seed, mapPack.game.board, mapPack.game.cards, mapPack.game.config, mapPack.ref, mapPack.game.requiredRuleModules);
  if (!created.ok) throw new Error('expected createInitialGame to succeed');
  return created.state;
}

describe('isValidIntent', () => {
  test('accepts every no-argument engine intent type', () => {
    const noArgumentTypes = [
      'roll_dice',
      'roll_airport_branch',
      'buy_property',
      'skip_buy',
      'build_house',
      'skip_build',
      'end_turn',
      'declare_bankrupt',
    ] as const;

    for (const type of noArgumentTypes) {
      expect(isValidIntent({ type })).toBe(true);
    }
  });

  test('accepts cellId intents only when cellId is a finite integer', () => {
    const cellIdTypes = ['sell_house', 'sell_property', 'mortgage_property', 'redeem_property'] as const;

    for (const type of cellIdTypes) {
      expect(isValidIntent({ type, cellId: 0 })).toBe(true);
      expect(isValidIntent({ type, cellId: 42 })).toBe(true);

      expect(isValidIntent({ type })).toBe(false);
      expect(isValidIntent({ type, cellId: '0' })).toBe(false);
      expect(isValidIntent({ type, cellId: 1.5 })).toBe(false);
      expect(isValidIntent({ type, cellId: Number.NaN })).toBe(false);
      expect(isValidIntent({ type, cellId: Number.POSITIVE_INFINITY })).toBe(false);
    }
  });

  test('rejects non-object, missing, non-string, and unknown intent types while tolerating extra keys', () => {
    expect(isValidIntent(null)).toBe(false);
    expect(isValidIntent([])).toBe(false);
    expect(isValidIntent({})).toBe(false);
    expect(isValidIntent({ type: 123 })).toBe(false);
    expect(isValidIntent({ type: 'teleport' })).toBe(false);
    expect(isValidIntent({ type: 'constructor' })).toBe(false);
    expect(isValidIntent({ type: 'toString' })).toBe(false);
    expect(isValidIntent({ type: 'hasOwnProperty' })).toBe(false);

    expect(isValidIntent({ type: 'roll_dice', ignored: 'transport-only metadata' })).toBe(true);
    expect(isValidIntent({ type: 'sell_house', cellId: 3, ignored: 'transport-only metadata' })).toBe(true);
  });

  test('rejects single-player redraw intents and keeps them invalid at the engine boundary', () => {
    expect(isValidIntent({ type: 'redraw_card' })).toBe(false);
    expect(isValidIntent({ type: 'accept_card' })).toBe(false);

    // 即使绕过传输校验，联机状态没有 cardChoice.pending，引擎也一律拒绝。
    const state = startState('redraw-online-seed');
    expect(applyGameIntent(defaultGameGateway, state, state.currentPlayerId, { type: 'redraw_card' }))
      .toEqual({ ok: false, code: 'WRONG_PHASE' });
    expect(applyGameIntent(defaultGameGateway, state, state.currentPlayerId, { type: 'accept_card' }))
      .toEqual({ ok: false, code: 'WRONG_PHASE' });
    expect(state.cardChoice).toBeUndefined();
  });

  test('accepts only exact, bounded, JSON-safe module intent envelopes', () => {
    const valid = {
      type: 'module',
      module: { id: 'world-tour', version: 1 },
      action: 'enter-airport-branch',
      payload: { optionId: 'world-tour@1:airport-entry:p1:10:2', airportCellId: 10 },
    };

    expect(isValidIntent(valid)).toBe(true);
    expect(isValidIntent({ ...valid, ignored: true })).toBe(false);
    expect(isValidIntent({ ...valid, module: { ...valid.module, ignored: true } })).toBe(false);
    expect(isValidIntent({ ...valid, module: { id: '', version: 1 } })).toBe(false);
    expect(isValidIntent({ ...valid, module: { id: 'world-tour', version: 0 } })).toBe(false);
    expect(isValidIntent({ ...valid, action: '' })).toBe(false);
    expect(isValidIntent({ ...valid, payload: { amount: Number.POSITIVE_INFINITY } })).toBe(false);
    expect(isValidIntent({ ...valid, payload: { missing: undefined } })).toBe(false);
    expect(isValidIntent({ ...valid, payload: 'x'.repeat(20_000) })).toBe(false);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(isValidIntent({ ...valid, payload: cyclic })).toBe(false);

    let getterCalls = 0;
    const accessorEnvelope = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessorEnvelope, 'payload', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return {};
      },
    });
    expect(isValidIntent(accessorEnvelope)).toBe(false);
    expect(getterCalls).toBe(0);
  });
});

describe('createInitialGame', () => {
  test('creates a playing game with cashGoal disabled and the exact room players', () => {
    const created = createInitialGame(defaultGameGateway, players, 'seed-a', mapPack.game.board, mapPack.game.cards, mapPack.game.config, mapPack.ref, mapPack.game.requiredRuleModules);

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.state.cashGoal).toBeNull();
    expect(created.state.phase).toBe('playing');
    expect(created.state.turnPhase).toBe('awaiting_roll');
    expect(
      created.state.players
        .map((player) => ({ id: player.id, nickname: player.nickname, isBot: player.isBot }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual([...players].sort((a, b) => a.id.localeCompare(b.id)));
  });

  test('returns identical initial state for identical players and seed', () => {
    const first = createInitialGame(defaultGameGateway, players, 'same-seed', mapPack.game.board, mapPack.game.cards, mapPack.game.config, mapPack.ref, mapPack.game.requiredRuleModules);
    const second = createInitialGame(defaultGameGateway, players, 'same-seed', mapPack.game.board, mapPack.game.cards, mapPack.game.config, mapPack.ref, mapPack.game.requiredRuleModules);

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.state).toEqual(second.state);
    }
  });

  test('converts createGame exceptions into a safe fixed message and preserves the original error', () => {
    const originalError = new Error('createGame internals should not leak');
    const throwingGateway: GameRuntimeGateway = {
      ...defaultGameGateway,
      createGame: () => {
        throw originalError;
      },
    };

    const created = createInitialGame(throwingGateway, players, 'seed', mapPack.game.board, mapPack.game.cards, mapPack.game.config, mapPack.ref, mapPack.game.requiredRuleModules);

    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.message).toBe('Unable to start the game with the current room players.');
      expect(created.error).toBe(originalError);
    }
  });
});

describe('applyGameIntent', () => {
  test('successful roll returns a replacement state and canonical engine events', () => {
    const state = startState();
    const actorId = state.currentPlayerId;

    const outcome = applyGameIntent(defaultGameGateway, state, actorId, { type: 'roll_dice' });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.state).not.toBe(state);
    expect(outcome.state.currentPlayerId).toBe(actorId);
    expect(outcome.events.length).toBeGreaterThan(0);
    expect(outcome.events[0]).toMatchObject({ type: 'dice_rolled', playerId: actorId });
  });

  test('wrong player maps the engine rule failure to NOT_YOUR_TURN without an exception object', () => {
    const state = startState();
    const wrongPlayerId = state.players.find((player) => player.id !== state.currentPlayerId)?.id;
    if (!wrongPlayerId) throw new Error('expected a non-current player');

    const outcome = applyGameIntent(defaultGameGateway, state, wrongPlayerId, { type: 'roll_dice' });

    expect(outcome).toEqual({ ok: false, code: 'NOT_YOUR_TURN' });
  });

  test('converts thrown applyIntent exceptions to ILLEGAL_INTENT and preserves the original error', () => {
    const originalError = new Error('effect-chain overflow');
    const throwingGateway: GameRuntimeGateway = {
      ...defaultGameGateway,
      applyIntent: () => {
        throw originalError;
      },
    };
    const state = startState();

    const outcome = applyGameIntent(throwingGateway, state, state.currentPlayerId, { type: 'roll_dice' });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('ILLEGAL_INTENT');
      expect(outcome.error).toBe(originalError);
    }
  });

  test('rejects forged, disabled, stale, and wrong-player module options before invoking the engine gateway', () => {
    const worldPack = getActiveMapPack('world-tour');
    const created = createInitialGame(
      defaultGameGateway,
      players,
      'module-boundary-seed',
      worldPack.game.board,
      worldPack.game.cards,
      worldPack.game.config,
      worldPack.ref,
      worldPack.game.requiredRuleModules,
    );
    if (!created.ok) throw new Error('expected World Tour game');
    const actorId = created.state.currentPlayerId;
    const option = {
      optionId: 'world-tour@1:test-option',
      module: { id: 'world-tour', version: 1 },
      playerId: actorId,
      requiredPhase: 'awaiting_roll' as const,
      label: '掷骰子',
      action: 'enter-airport-branch',
      payload: { optionId: 'world-tour@1:test-option', airportCellId: 10 },
    };
    const state = {
      ...created.state,
      publicRuleState: { ...created.state.publicRuleState, pendingActions: [option] },
    };
    let calls = 0;
    const gateway: GameRuntimeGateway = {
      ...defaultGameGateway,
      applyIntent: (...args) => {
        calls += 1;
        return defaultGameGateway.applyIntent(...args);
      },
    };
    const exactIntent: Intent = {
      type: 'module',
      module: option.module,
      action: option.action,
      payload: option.payload,
    };

    expect(applyGameIntent(gateway, state, players[1]!.id, exactIntent)).toEqual({ ok: false, code: 'ILLEGAL_INTENT' });
    expect(applyGameIntent(gateway, state, actorId, { ...exactIntent, module: { id: 'disabled', version: 1 } })).toEqual({ ok: false, code: 'ILLEGAL_INTENT' });
    expect(applyGameIntent(gateway, state, actorId, { ...exactIntent, payload: { ...option.payload, optionId: 'stale' } })).toEqual({ ok: false, code: 'ILLEGAL_INTENT' });
    expect(calls).toBe(0);
  });
});

describe('chooseTakeoverIntent', () => {
  test('maps every turn phase to the fixed offline takeover policy without liquidating assets or declaring bankruptcy', () => {
    const base = startState();
    const cases: Array<[GameState['turnPhase'], Intent]> = [
      ['awaiting_roll', { type: 'roll_dice' }],
      ['awaiting_airport_roll', { type: 'roll_airport_branch' }],
      ['awaiting_buy_decision', { type: 'skip_buy' }],
      ['awaiting_build_decision', { type: 'skip_build' }],
      ['managing', { type: 'end_turn' }],
    ];
    const liquidatingIntentTypes: Intent['type'][] = [
      'sell_house',
      'sell_property',
      'mortgage_property',
      'redeem_property',
      'declare_bankrupt',
    ];

    for (const [turnPhase, expectedIntent] of cases) {
      const intent = chooseTakeoverIntent({ ...base, turnPhase });
      expect(intent).toEqual(expectedIntent);
      if (intent === null) throw new Error(`unexpected offline-skip sentinel for ${turnPhase}`);
      expect(liquidatingIntentTypes).not.toContain(intent.type);
    }
  });

  test('returns the offline-skip sentinel for a World Tour airport or branch roll option', () => {
    const base = startState();
    const actorId = base.currentPlayerId;
    const state: GameState = {
      ...base,
      ruleModules: [...base.ruleModules, { id: 'world-tour', version: 1 }],
      publicRuleState: {
        modules: {},
        pendingActions: [{
          optionId: 'airport-option',
          module: { id: 'world-tour', version: 1 },
          playerId: actorId,
          requiredPhase: 'awaiting_roll',
          label: '掷骰子',
          action: 'enter-airport-branch',
          payload: { optionId: 'airport-option', airportCellId: 10 },
        }],
      },
    };

    expect(chooseTakeoverIntent(state)).toBeNull();
  });

  test('uses the deterministic module strategy for non-airport World Tour choices', () => {
    const base = startState();
    const actorId = base.currentPlayerId;
    const action = {
      optionId: 'flight-decline',
      module: { id: 'world-tour', version: 1 },
      playerId: actorId,
      requiredPhase: 'managing' as const,
      label: '不搭乘',
      action: 'short-flight',
      payload: { optionId: 'flight-decline', targetCellId: null, cost: 3500 },
    };
    const state: GameState = {
      ...base,
      turnPhase: 'managing',
      ruleModules: [...base.ruleModules, { id: 'world-tour', version: 1 }],
      publicRuleState: { modules: {}, pendingActions: [action] },
    };

    expect(chooseTakeoverIntent(state)).toEqual({
      type: 'module', module: action.module, action: action.action, payload: action.payload,
    });
  });
});
