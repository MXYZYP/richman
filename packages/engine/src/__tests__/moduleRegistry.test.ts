import { describe, expect, it } from 'vitest';
import type {
  CoreCellEffect,
  CoreCellType,
  RuleModuleRef,
} from '@richman/board-data';
import { getActiveMapPack } from '@richman/board-data';
import { applyIntent, createGame } from '../engine';
import { applyCardEffect, resolveLanding } from '../effects';
import { chooseBotIntent } from '../bot';
import type { CoreIntent, GameState } from '../types';
import {
  CORE_CELL_HANDLER_TYPES,
  CORE_EFFECT_HANDLER_TYPES,
  CORE_INTENT_HANDLER_TYPES,
  createRuleModuleRegistry,
  defaultRuleModuleRegistry,
  type RuleModuleDefinition,
} from '../moduleRegistry';

const coreRef = { id: 'core', version: 1 } as const;
const chinaMap = getActiveMapPack('china-tour');

function makeGame(): GameState {
  return createGame({
    mapRef: chinaMap.ref,
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: chinaMap.game.config,
    players: [
      { id: 'p1', nickname: '甲' },
      { id: 'p2', nickname: '乙' },
    ],
    seed: 'module-registry',
    ruleModules: [coreRef],
  });
}

function botOnlyModule(ref: RuleModuleRef, calls: string[]): RuleModuleDefinition {
  return {
    ref,
    cellHandlers: [],
    effectHandlers: [],
    intentHandlers: [],
    botStrategyHook: {
      decide: () => {
        calls.push(`${ref.id}@${ref.version}`);
        return undefined;
      },
    },
  };
}

describe('rule-module registry', () => {
  it('core@1 完整声明所有现有 cell/effect/intent ownership', () => {
    const expectedCells = {
      start: true,
      property: true,
      chance: true,
      destiny: true,
      tax: true,
      airport: true,
      special: true,
      world: true,
    } satisfies Record<CoreCellType, true>;
    const expectedEffects = {
      move_to: true,
      move_steps: true,
      pay_bank: true,
      receive_bank: true,
      pay_each_player: true,
      receive_from_each_player: true,
      repairs: true,
      skip_turn: true,
      draw_card: true,
      none: true,
    } satisfies Record<CoreCellEffect['type'], true>;
    const expectedIntents = {
      roll_dice: true,
      roll_airport_branch: true,
      buy_property: true,
      skip_buy: true,
      build_house: true,
      skip_build: true,
      sell_house: true,
      sell_property: true,
      mortgage_property: true,
      redeem_property: true,
      end_turn: true,
      declare_bankrupt: true,
      surrender: true,
      redraw_card: true,
      accept_card: true,
      propose_trade: true,
      respond_trade: true,
      cancel_trade: true,
      place_bid: true,
      pass_bid: true,
    } satisfies Record<CoreIntent['type'], true>;

    expect(CORE_CELL_HANDLER_TYPES).toEqual(expectedCells);
    expect(CORE_EFFECT_HANDLER_TYPES).toEqual(expectedEffects);
    expect(CORE_INTENT_HANDLER_TYPES).toEqual(expectedIntents);
    for (const type of Object.keys(expectedCells) as CoreCellType[]) {
      expect(defaultRuleModuleRegistry.getCellHandler([coreRef], type)).toBeDefined();
    }
    for (const type of Object.keys(expectedEffects) as CoreCellEffect['type'][]) {
      expect(defaultRuleModuleRegistry.getEffectHandler([coreRef], type)).toBeDefined();
    }
    for (const type of Object.keys(expectedIntents) as CoreIntent['type'][]) {
      expect(defaultRuleModuleRegistry.getIntentHandler([coreRef], type)).toBeDefined();
    }
  });

  it('拒绝 unknown 和 duplicate enabled module refs', () => {
    expect(() => defaultRuleModuleRegistry.getIntentHandler(
      [{ id: 'unknown', version: 1 }],
      'roll_dice',
    )).toThrow(/unknown rule module/i);
    expect(() => defaultRuleModuleRegistry.getIntentHandler(
      [coreRef, { ...coreRef }],
      'roll_dice',
    )).toThrow(/duplicate enabled rule module/i);
  });

  it('拒绝重复注册同一个 module definition ref', () => {
    const first = botOnlyModule({ id: 'duplicate', version: 1 }, []);
    const second = botOnlyModule({ id: 'duplicate', version: 1 }, []);

    expect(() => createRuleModuleRegistry([first, second])).toThrow(/duplicate rule module duplicate@1/i);
  });

  it.each([
    [{ id: '', version: 1 }, /module id.*non-empty/i],
    [{ id: 'invalid-version', version: 0 }, /module version.*positive safe integer/i],
    [{ id: 'invalid-version', version: Number.NaN }, /module version.*positive safe integer/i],
  ])('构造时拒绝非法 module ref：%j', (ref, expected) => {
    expect(() => createRuleModuleRegistry([botOnlyModule(ref, [])])).toThrow(expected);
  });

  it.each([
    [{ id: '', version: 1 }, /module id.*non-empty/i],
    [{ id: 'invalid-version', version: 0 }, /module version.*positive safe integer/i],
    [{ id: 'invalid-version', version: Number.NaN }, /module version.*positive safe integer/i],
  ])('解析 enabled refs 时拒绝非法 module ref：%j', (ref, expected) => {
    expect(() => defaultRuleModuleRegistry.getIntentHandler([ref], 'end_turn')).toThrow(expected);
  });

  it('构造时拒绝 exclusive cell/effect/intent handler 冲突', () => {
    const first: RuleModuleDefinition = {
      ref: { id: 'alpha', version: 1 },
      cellHandlers: [{ type: 'start', handle: (context) => context.applyCore() }],
      effectHandlers: [{ type: 'none', handle: (context) => context.applyCore() }],
      intentHandlers: [{ type: 'end_turn', handle: (context) => context.applyCore() }],
    };
    const second: RuleModuleDefinition = {
      ref: { id: 'beta', version: 1 },
      cellHandlers: [{ type: 'start', handle: (context) => context.applyCore() }],
      effectHandlers: [{ type: 'none', handle: (context) => context.applyCore() }],
      intentHandlers: [{ type: 'end_turn', handle: (context) => context.applyCore() }],
    };

    expect(() => createRuleModuleRegistry([first, second])).toThrow(/cell handler conflict.*start/i);
    expect(() => createRuleModuleRegistry([
      { ...second, cellHandlers: [] },
      { ...first, cellHandlers: [] },
    ])).toThrow(/effect handler conflict.*none/i);
    expect(() => createRuleModuleRegistry([
      { ...first, cellHandlers: [], effectHandlers: [] },
      { ...second, cellHandlers: [], effectHandlers: [] },
    ])).toThrow(/intent handler conflict.*end_turn/i);
  });

  it('拒绝空 module cellType/effectType/action', () => {
    const base = botOnlyModule({ id: 'empty-subtype', version: 1 }, []);
    expect(() => createRuleModuleRegistry([{
      ...base,
      cellHandlers: [{ type: 'module', cellType: ' ', handle: (context) => context.applyCore() }],
    }])).toThrow(/cellType.*non-empty/i);
    expect(() => createRuleModuleRegistry([{
      ...base,
      effectHandlers: [{ type: 'module', effectType: '', handle: (context) => context.applyCore() }],
    }])).toThrow(/effectType.*non-empty/i);
    expect(() => createRuleModuleRegistry([{
      ...base,
      intentHandlers: [{ type: 'module', action: '', handle: (context) => context.applyCore() }],
    }])).toThrow(/action.*non-empty/i);
  });

  it('composable bot hooks 始终按 module id + version 顺序执行', () => {
    const calls: string[] = [];
    const registry = createRuleModuleRegistry([
      botOnlyModule({ id: 'zeta', version: 2 }, calls),
      botOnlyModule({ id: 'alpha', version: 3 }, calls),
      botOnlyModule({ id: 'alpha', version: 1 }, calls),
    ]);
    const state = {} as GameState;

    registry.runBotStrategyHooks(
      [{ id: 'zeta', version: 2 }, { id: 'alpha', version: 3 }, { id: 'alpha', version: 1 }],
      { state, playerId: 'p1', registry, applyCore: () => ({ type: 'end_turn' }) },
    );

    expect(calls).toEqual(['alpha@1', 'alpha@3', 'zeta@2']);
  });

  it('positive-rent hooks 按 module id + version 顺序串联 state/events/amount', () => {
    const calls: string[] = [];
    const moduleWithRentHook = (ref: RuleModuleRef, delta: number): RuleModuleDefinition => ({
      ...botOnlyModule(ref, []),
      positiveRentHook: {
        apply: (context) => {
          calls.push(`${ref.id}@${ref.version}:${context.amount}`);
          return { ...context, amount: context.amount + delta };
        },
      },
    });
    const registry = createRuleModuleRegistry([
      moduleWithRentHook({ id: 'zeta', version: 1 }, 10),
      moduleWithRentHook({ id: 'alpha', version: 2 }, 20),
      moduleWithRentHook({ id: 'alpha', version: 1 }, 30),
    ]);
    const state = {} as GameState;

    const result = registry.runPositiveRentHooks(
      [{ id: 'zeta', version: 1 }, { id: 'alpha', version: 2 }, { id: 'alpha', version: 1 }],
      { state, events: [], payerId: 'p1', ownerId: 'p2', cellId: 1, amount: 100, registry },
    );

    expect(calls).toEqual(['alpha@1:100', 'alpha@2:130', 'zeta@1:150']);
    expect(result.amount).toBe(160);
  });

  it('post-transition hooks 按 module id + version 顺序串联成功结果', () => {
    const calls: string[] = [];
    const moduleWithCleanup = (ref: RuleModuleRef): RuleModuleDefinition => ({
      ...botOnlyModule(ref, []),
      postTransitionHook: {
        apply: (context) => {
          const current = context.result;
          if (!current.ok) return current;
          calls.push(`${ref.id}@${ref.version}:${current.events.length}`);
          return {
            ...current,
            events: [...current.events, { type: 'buy_declined' }],
          };
        },
      },
    });
    const registry = createRuleModuleRegistry([
      moduleWithCleanup({ id: 'zeta', version: 1 }),
      moduleWithCleanup({ id: 'alpha', version: 1 }),
    ]);
    const state = {} as GameState;

    const result = registry.runPostTransitionHooks(
      [{ id: 'zeta', version: 1 }, { id: 'alpha', version: 1 }],
      {
        previousState: state,
        playerId: 'p1',
        intent: { type: 'end_turn' },
        result: { ok: true, state, events: [] },
        registry,
      },
    );

    expect(calls).toEqual(['alpha@1:0', 'zeta@1:1']);
    expect(result).toMatchObject({ ok: true, events: [{ type: 'buy_declined' }, { type: 'buy_declined' }] });
  });

  it('bot pipeline 依次传递 currentDecision，core 仅填空，后续 module 可覆盖', () => {
    const calls: string[] = [];
    const registry = createRuleModuleRegistry([
      {
        ...botOnlyModule({ id: 'zeta', version: 1 }, calls),
        intentHandlers: [{ type: 'roll_dice', handle: (context) => context.applyCore() }],
        botStrategyHook: {
          decide: (context) => {
            calls.push(`zeta:${context.currentDecision?.type ?? 'empty'}`);
            return { type: 'roll_dice' };
          },
        },
      },
      {
        ref: coreRef,
        cellHandlers: [],
        effectHandlers: [],
        intentHandlers: [],
        botStrategyHook: {
          decide: (context) => {
            calls.push(`core:${context.currentDecision?.type ?? 'empty'}`);
            return context.currentDecision ?? context.applyCore();
          },
        },
      },
      {
        ...botOnlyModule({ id: 'alpha', version: 1 }, calls),
        botStrategyHook: {
          decide: (context) => {
            calls.push(`alpha:${context.currentDecision?.type ?? 'empty'}`);
            return { type: 'end_turn' };
          },
        },
      },
    ]);

    const decision = registry.runBotStrategyHooks(
      [{ id: 'zeta', version: 1 }, coreRef, { id: 'alpha', version: 1 }],
      {
        state: {} as GameState,
        playerId: 'p1',
        currentDecision: undefined,
        registry,
        applyCore: () => ({ type: 'declare_bankrupt' }),
      },
    );

    expect(calls).toEqual(['alpha:empty', 'core:end_turn', 'zeta:end_turn']);
    expect(decision).toEqual({ type: 'roll_dice' });
  });

  it('复制并冻结 module definitions，不受调用方后续 mutation 影响', () => {
    const calls: string[] = [];
    const definition = botOnlyModule({ id: 'stable', version: 1 }, calls);
    const definitions = [definition];
    const registry = createRuleModuleRegistry(definitions);
    definitions.length = 0;
    (definition.ref as { id: string }).id = 'mutated';

    expect(Object.isFrozen(registry)).toBe(true);
    expect(() => registry.runBotStrategyHooks(
      [{ id: 'stable', version: 1 }],
      { state: {} as GameState, playerId: 'p1', applyCore: () => ({ type: 'end_turn' }), registry },
    )).not.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('public applyIntent 通过 core handler，同时保留全局回合校验', () => {
    const state = { ...makeGame(), turnPhase: 'managing' as const };
    const otherPlayerId = state.players.find((player) => player.id !== state.currentPlayerId)!.id;

    expect(applyIntent(state, otherPlayerId, { type: 'end_turn' })).toEqual({
      ok: false,
      code: 'NOT_YOUR_TURN',
    });
    expect(applyIntent(state, state.currentPlayerId, { type: 'end_turn' }).ok).toBe(true);
    expect(applyIntent({ ...state, ruleModules: [] }, state.currentPlayerId, { type: 'end_turn' })).toEqual({
      ok: false,
      code: 'ILLEGAL_INTENT',
    });
  });

  it('public landing/effect/bot 入口均通过 enabled core@1', () => {
    const state = makeGame();
    const playerId = state.currentPlayerId;

    expect(resolveLanding(state, playerId, []).state.turnPhase).toBe('managing');
    expect(applyCardEffect(
      state,
      playerId,
      { id: 'none', effect: { type: 'none' } },
      [],
    ).state).toBe(state);
    expect(chooseBotIntent(state, playerId)).toEqual({ type: 'roll_dice' });

    const withoutModules = { ...state, ruleModules: [] };
    expect(() => resolveLanding(withoutModules, playerId, [])).toThrow(/no enabled cell handler/i);
    expect(() => applyCardEffect(
      withoutModules,
      playerId,
      { id: 'none', effect: { type: 'none' } },
      [],
    )).toThrow(/no enabled effect handler/i);
    // 电脑玩家决策不再因"没有启用的 bot hook"抛错：所有模块 hook 都未产出决策时回退到核心策略，
    // 保证任何可达局面下电脑至少能掷骰 / 结束回合（修复"电脑玩家整局卡死"）。
    expect(chooseBotIntent(withoutModules, playerId)).toEqual({ type: 'roll_dice' });
  });

  it('registry wrapper 保留既有 game-over 短路与 effect depth guard 优先级', () => {
    const state = makeGame();
    const gameOverWithoutPlayers = {
      ...state,
      phase: 'game_over' as const,
      players: [],
    };

    expect(resolveLanding(gameOverWithoutPlayers, 'missing-player', [])).toEqual({
      state: gameOverWithoutPlayers,
      events: [],
      newDebt: null,
    });
    expect(() => applyCardEffect(
      { ...state, ruleModules: [] },
      state.currentPlayerId,
      { id: 'too-deep', effect: { type: 'none' } },
      [],
      9,
    )).toThrow(/effect depth exceeded/i);
  });
});
