import { describe, expect, it } from 'vitest';
import {
  getActiveMapPack,
  type BoardData,
  type CardsData,
  type JsonValue,
  type ModuleEvent,
  type ModuleIntent,
  type RuleModuleRef,
} from '@richman/board-data';
import { chooseBotIntent } from '../bot';
import { applyCardEffect, resolveLanding } from '../effects';
import { applyIntent, createGame } from '../engine';
import {
  coreRuleModuleDefinition,
  createRuleModuleRegistry,
  type EffectExecutionContext,
  type ModuleEffectExecutionHandler,
  type RuleModuleDefinition,
} from '../moduleRegistry';
import type { GameEvent, GameState } from '../types';

const coreRef = { id: 'core', version: 1 } as const;
const alphaRef = { id: 'alpha', version: 1 } as const;
const betaRef = { id: 'beta', version: 1 } as const;
const chinaMap = getActiveMapPack('china-tour');

const assertReadonlyModuleEffectContext: ModuleEffectExecutionHandler['handle'] = (context) => {
  if (context.card.effect.type !== 'module') return context.applyCore();
  // @ts-expect-error module handler 不得改写 effect envelope
  context.card.effect.effectType = 'mutated';
  // @ts-expect-error module handler 不得改写 card identity
  context.card.id = 'mutated';
  return context.applyCore();
};

void assertReadonlyModuleEffectContext;

function assertReadonlyEffectContext(context: EffectExecutionContext): void {
  if (context.card.effect.type !== 'pay_bank') return;
  // @ts-expect-error 所有 effect handler 都不得改写 card effect
  context.card.effect.amount = 1;
}

void assertReadonlyEffectContext;

function moduleEvent(module: RuleModuleRef, eventType: string): ModuleEvent {
  return { type: 'module', module, eventType, payload: { owner: module.id } };
}

function moduleDefinition(ref: RuleModuleRef): RuleModuleDefinition {
  return {
    ref,
    cellHandlers: [{
      type: 'module',
      cellType: 'shared',
      handle: (context) => ({
        state: { ...context.state, turnPhase: 'managing' },
        events: [...context.events, moduleEvent(ref, 'cell_settled')],
        newDebt: context.state.debt,
      }),
    }],
    effectHandlers: [{
      type: 'module',
      effectType: 'shared',
      handle: (context) => ({
        state: context.state,
        events: [...context.events, moduleEvent(ref, 'effect_applied')],
        newDebt: context.state.debt,
      }),
    }],
    intentHandlers: [{
      type: 'module',
      action: 'shared',
      handle: (context) => ({
        ok: true,
        state: context.state,
        events: [moduleEvent(ref, 'intent_applied')],
      }),
    }],
    botStrategyHook: {
      decide: (context) => context.currentDecision ?? {
        type: 'module',
        module: ref,
        action: 'shared',
        payload: { source: 'bot' },
      },
    },
  };
}

function makeState(): { state: GameState; alphaCellId: number; betaCellId: number } {
  const alphaCellId = 10_001;
  const betaCellId = 10_002;
  const board = structuredClone(chinaMap.game.board) as BoardData;
  board.cells.push({
    id: alphaCellId,
    type: 'module',
    name: 'Alpha shared',
    nextId: 0,
    module: alphaRef,
    cellType: 'shared',
    payload: { owner: 'alpha' },
  });
  board.cells.push({
    id: betaCellId,
    type: 'module',
    name: 'Beta shared',
    nextId: 0,
    module: betaRef,
    cellType: 'shared',
    payload: { owner: 'beta' },
  });
  const cards = structuredClone(chinaMap.game.cards) as CardsData;
  const state = createGame({
    mapRef: chinaMap.ref,
    board,
    cards,
    config: chinaMap.game.config,
    players: [{ id: 'p1', nickname: '甲' }, { id: 'p2', nickname: '乙' }],
    seed: 'module-envelope',
    ruleModules: [coreRef, alphaRef, betaRef],
  });
  return { state, alphaCellId, betaCellId };
}

function lastModuleEvent(events: readonly GameEvent[]): ModuleEvent {
  return events.at(-1) as ModuleEvent;
}

describe('formal module envelopes', () => {
  it('按 exact module ref + subtype/action 隔离同名 handler，并通过公共入口 dispatch', () => {
    const registry = createRuleModuleRegistry([
      coreRuleModuleDefinition,
      moduleDefinition(betaRef),
      moduleDefinition(alphaRef),
    ]);
    const { state, alphaCellId, betaCellId } = makeState();
    const playerId = state.currentPlayerId;

    const alphaLanding = resolveLanding({
      ...state,
      players: state.players.map((player) => (
        player.id === playerId ? { ...player, position: alphaCellId } : player
      )),
    }, playerId, [], 0, registry);
    const betaLanding = resolveLanding({
      ...state,
      players: state.players.map((player) => (
        player.id === playerId ? { ...player, position: betaCellId } : player
      )),
    }, playerId, [], 0, registry);
    expect(lastModuleEvent(alphaLanding.events).module).toEqual(alphaRef);
    expect(lastModuleEvent(betaLanding.events).module).toEqual(betaRef);

    for (const module of [alphaRef, betaRef]) {
      const effectResult = applyCardEffect(state, playerId, {
        id: `${module.id}-effect`,
        effect: { type: 'module', module, effectType: 'shared', payload: {} },
      }, [], 0, registry);
      expect(lastModuleEvent(effectResult.events).module).toEqual(module);

      const intent: ModuleIntent = {
        type: 'module', module, action: 'shared', payload: {},
      };
      const intentResult = applyIntent(state, playerId, intent, registry);
      expect(intentResult.ok).toBe(true);
      if (intentResult.ok) expect(lastModuleEvent(intentResult.events).module).toEqual(module);
    }
  });

  it('core effect 递归落点时传播同一个 custom registry，并拒绝未 enabled 的 envelope ref', () => {
    const registry = createRuleModuleRegistry([coreRuleModuleDefinition, moduleDefinition(alphaRef)]);
    const { state, alphaCellId } = makeState();
    const playerId = state.currentPlayerId;
    const alphaOnly = { ...state, ruleModules: [coreRef, alphaRef] };

    const moved = applyCardEffect(alphaOnly, playerId, {
      id: 'move-to-alpha',
      effect: { type: 'move_to', cellId: alphaCellId, collectSalary: false },
    }, [], 0, registry);
    expect(lastModuleEvent(moved.events).eventType).toBe('cell_settled');

    expect(() => applyCardEffect(
      { ...state, ruleModules: [coreRef] },
      playerId,
      {
        id: 'disabled-alpha',
        effect: { type: 'module', module: alphaRef, effectType: 'shared', payload: {} },
      },
      [],
      0,
      registry,
    )).toThrow(/alpha@1.*enabled/i);
  });

  it('chooseBotIntent 使用可注入 registry，并返回 module intent', () => {
    const registry = createRuleModuleRegistry([moduleDefinition(alphaRef)]);
    const { state } = makeState();
    const alphaOnly = { ...state, ruleModules: [alphaRef] };

    expect(chooseBotIntent(alphaOnly, state.currentPlayerId, registry)).toEqual({
      type: 'module',
      module: alphaRef,
      action: 'shared',
      payload: { source: 'bot' },
    });
    expect(() => registry.getIntentHandler(alphaOnly.ruleModules, {
      type: 'module', module: alphaRef, action: ' ', payload: {},
    })).toThrow(/action.*non-empty/i);
    expect(() => registry.getIntentHandler(alphaOnly.ruleModules, {
      type: 'module',
      module: alphaRef,
      action: 'shared',
      payload: { invalid: undefined } as unknown as JsonValue,
    })).toThrow(/payload.*valid JSON/i);
  });

  it('拒绝 bot hook 返回未知 ref、缺失 action、非法 payload 或无 handler 的 core intent', () => {
    const { state } = makeState();
    const alphaOnly = { ...state, ruleModules: [alphaRef] };
    const invalidPayloads: JsonValue[] = [];
    const sparse: unknown[] = [];
    sparse.length = 1;
    invalidPayloads.push(sparse as unknown as JsonValue);
    const extraProperty: unknown[] = [];
    Object.defineProperty(extraProperty, 'extra', { value: true, enumerable: true });
    invalidPayloads.push(extraProperty as unknown as JsonValue);
    const customPrototype = Object.setPrototypeOf([], { custom: true });
    invalidPayloads.push(customPrototype as unknown as JsonValue);
    const hiddenProperty = {};
    Object.defineProperty(hiddenProperty, 'hidden', { value: true, enumerable: false });
    invalidPayloads.push(hiddenProperty as unknown as JsonValue);

    const registryReturning = (intent: ModuleIntent) => createRuleModuleRegistry([{
      ...moduleDefinition(alphaRef),
      botStrategyHook: { decide: () => intent },
    }]);

    expect(() => chooseBotIntent(alphaOnly, state.currentPlayerId, registryReturning({
      type: 'module', module: betaRef, action: 'shared', payload: {},
    }))).toThrow(/beta@1.*enabled/i);
    expect(() => chooseBotIntent(alphaOnly, state.currentPlayerId, registryReturning({
      type: 'module', module: alphaRef, action: 'missing', payload: {},
    }))).toThrow(/no enabled intent handler/i);
    for (const payload of invalidPayloads) {
      expect(() => chooseBotIntent(alphaOnly, state.currentPlayerId, registryReturning({
        type: 'module', module: alphaRef, action: 'shared', payload,
      }))).toThrow(/payload.*valid JSON/i);
    }

    const coreWithoutHandler = createRuleModuleRegistry([{
      ref: alphaRef,
      cellHandlers: [],
      effectHandlers: [],
      intentHandlers: [],
      botStrategyHook: { decide: () => ({ type: 'end_turn' }) },
    }]);
    expect(() => chooseBotIntent(alphaOnly, state.currentPlayerId, coreWithoutHandler))
      .toThrow(/no enabled intent handler/i);
  });
});
