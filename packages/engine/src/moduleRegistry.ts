import type {
  Cell,
  CellEffect,
  CoreCellEffect,
  CoreCellType,
  DeepReadonly,
  ModuleCell,
  ModuleEffect,
  ModuleIntent,
  RuleModuleRef,
} from '@richman/board-data';
import type { ApplyResult, CoreIntent, GameEvent, GameState, Intent } from './types';
import { worldTourRuleModuleDefinition } from './worldTourModule';
import { greatWallRuleModuleDefinition } from './greatWallModule';

type ReadonlyCell = DeepReadonly<Cell>;

export interface RuleEffectResult {
  readonly state: GameState;
  readonly events: GameEvent[];
  readonly newDebt: GameState['debt'];
}

export interface CellSettlementContext {
  readonly state: GameState;
  readonly playerId: string;
  readonly events: GameEvent[];
  readonly depth: number;
  readonly cell: ReadonlyCell;
  readonly applyCore: () => RuleEffectResult;
  /**
   * 当前 `applyIntent(..., registry)` 使用的注册表（#21 B）。
   * 模块 handler 需要**递归落点**（如移动类效果再结算一次落点）或再次执行卡牌效果时，
   * 必须把本字段透传给 `resolveLanding` / `applyCardEffect`，不要依赖它们的默认参数
   * （默认取 `defaultRuleModuleRegistry`，那会让注册在自定义 registry 上的第三方模块
   * 在递归落点时拿到 `Unknown module` / `No enabled cell handler`）。
   */
  readonly registry: RuleModuleRegistry;
}

export interface EffectExecutionContext {
  readonly state: GameState;
  readonly playerId: string;
  readonly card: ReadonlyEffectCard;
  readonly events: GameEvent[];
  readonly depth: number;
  readonly applyCore: () => RuleEffectResult;
  /** 见 `CellSettlementContext.registry`：递归效果必须原样透传。 */
  readonly registry: RuleModuleRegistry;
}

export type ReadonlyEffectCard<TEffect extends CellEffect = CellEffect> = DeepReadonly<{
  id: string;
  effect: TEffect;
}>;

export interface ModuleEffectExecutionContext extends Omit<EffectExecutionContext, 'card'> {
  readonly card: ReadonlyEffectCard<ModuleEffect>;
}

export interface IntentExecutionContext {
  readonly state: GameState;
  readonly playerId: string;
  readonly intent: Intent;
  readonly applyCore: () => ApplyResult;
  /** 见 `CellSettlementContext.registry`：模块意图内若再触发落点/卡牌结算必须原样透传。 */
  readonly registry: RuleModuleRegistry;
}

export interface BotStrategyContext {
  readonly state: GameState;
  readonly playerId: string;
  readonly currentDecision?: Intent;
  readonly applyCore: () => Intent;
  /** 见 `CellSettlementContext.registry`。 */
  readonly registry: RuleModuleRegistry;
}

export interface PositiveRentContext {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
  readonly payerId: string;
  readonly ownerId: string;
  readonly cellId: number;
  readonly amount: number;
  /** 见 `CellSettlementContext.registry`。 */
  readonly registry: RuleModuleRegistry;
}

export interface PositiveRentResult {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
  readonly amount: number;
}

export interface PositiveRentHook {
  readonly apply: (context: PositiveRentContext) => PositiveRentResult;
}

export interface PostTransitionContext {
  readonly previousState: GameState;
  readonly playerId: string;
  readonly intent: Intent;
  readonly result: ApplyResult;
  /** 见 `CellSettlementContext.registry`。 */
  readonly registry: RuleModuleRegistry;
}

export interface PostTransitionHook {
  readonly apply: (context: PostTransitionContext) => ApplyResult;
}

export interface CoreCellSettlementHandler {
  readonly type: CoreCellType;
  readonly handle: (context: CellSettlementContext) => RuleEffectResult;
}

export interface ModuleCellSettlementHandler {
  readonly type: 'module';
  readonly cellType: string;
  readonly handle: (context: CellSettlementContext) => RuleEffectResult;
}

export type CellSettlementHandler = CoreCellSettlementHandler | ModuleCellSettlementHandler;

export interface CoreEffectExecutionHandler {
  readonly type: CoreCellEffect['type'];
  readonly handle: (context: EffectExecutionContext) => RuleEffectResult;
}

export interface ModuleEffectExecutionHandler {
  readonly type: 'module';
  readonly effectType: string;
  readonly handle: (context: ModuleEffectExecutionContext) => RuleEffectResult;
}

export type EffectExecutionHandler = CoreEffectExecutionHandler | ModuleEffectExecutionHandler;

export interface CoreIntentHandler {
  readonly type: CoreIntent['type'];
  readonly handle: (context: IntentExecutionContext) => ApplyResult;
}

export interface ModuleIntentHandler {
  readonly type: 'module';
  readonly action: string;
  readonly handle: (context: IntentExecutionContext) => ApplyResult;
}

export type IntentHandler = CoreIntentHandler | ModuleIntentHandler;

export interface BotStrategyHook {
  readonly decide: (context: BotStrategyContext) => Intent | undefined;
}

export interface RuleModuleDefinition {
  readonly ref: RuleModuleRef;
  readonly cellHandlers: readonly CellSettlementHandler[];
  readonly effectHandlers: readonly EffectExecutionHandler[];
  readonly intentHandlers: readonly IntentHandler[];
  readonly botStrategyHook?: BotStrategyHook;
  readonly positiveRentHook?: PositiveRentHook;
  readonly postTransitionHook?: PostTransitionHook;
}

export const CORE_CELL_HANDLER_TYPES = Object.freeze({
  start: true,
  property: true,
  chance: true,
  destiny: true,
  tax: true,
  airport: true,
  special: true,
  world: true,
} satisfies Record<CoreCellType, true>);

export const CORE_EFFECT_HANDLER_TYPES = Object.freeze({
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
} satisfies Record<CoreCellEffect['type'], true>);

export const CORE_INTENT_HANDLER_TYPES = Object.freeze({
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
} satisfies Record<CoreIntent['type'], true>);

function moduleKey(ref: RuleModuleRef): string {
  return `${ref.id}@${ref.version}`;
}

function assertValidModuleRef(ref: RuleModuleRef): void {
  if (typeof ref.id !== 'string' || ref.id.trim() === '') {
    throw new Error('Rule module id must be non-empty');
  }
  if (!Number.isSafeInteger(ref.version) || ref.version <= 0) {
    throw new Error('Rule module version must be a positive safe integer');
  }
}

function assertNonEmptySubtype(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Module ${field} must be non-empty`);
  }
  return value;
}

function assertJsonPayload(value: unknown, field: string, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new Error(`Module ${field} must be valid JSON`);
  }
  if (typeof value !== 'object') throw new Error(`Module ${field} must be valid JSON`);
  if (ancestors.has(value)) throw new Error(`Module ${field} must be valid JSON`);
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) throw new Error(`Module ${field} must be valid JSON`);
    const keys = Reflect.ownKeys(value);
    const indexKeys = keys.filter((key) => key !== 'length');
    if (indexKeys.length !== value.length) throw new Error(`Module ${field} must be valid JSON`);
    for (const key of indexKeys) {
      if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
        throw new Error(`Module ${field} must be valid JSON`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw new Error(`Module ${field} must be valid JSON`);
      }
    }
  } else if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`Module ${field} must be valid JSON`);
  }
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (typeof key !== 'string') throw new Error(`Module ${field} must be valid JSON`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error(`Module ${field} must be valid JSON`);
    }
    assertJsonPayload(descriptor.value, field, ancestors);
  }
  ancestors.delete(value);
}

function assertModuleCellEnvelope(cell: ModuleCell): string {
  assertJsonPayload(cell.payload, 'payload');
  return assertNonEmptySubtype(cell.cellType, 'cellType');
}

function assertModuleEffectEnvelope(effect: ModuleEffect): string {
  assertJsonPayload(effect.payload, 'payload');
  return assertNonEmptySubtype(effect.effectType, 'effectType');
}

function assertModuleIntentEnvelope(intent: ModuleIntent): string {
  assertJsonPayload(intent.payload, 'payload');
  return assertNonEmptySubtype(intent.action, 'action');
}

function assertEnvelopeEnabled(ref: RuleModuleRef, enabled: ReadonlySet<string>): string {
  assertValidModuleRef(ref);
  const key = moduleKey(ref);
  if (!enabled.has(key)) throw new Error(`Rule module ${key} must be enabled`);
  return key;
}

function compareRefs(left: RuleModuleRef, right: RuleModuleRef): number {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return left.version - right.version;
}

function copyDefinition(definition: RuleModuleDefinition): RuleModuleDefinition {
  return Object.freeze({
    ref: Object.freeze({ id: definition.ref.id, version: definition.ref.version }),
    cellHandlers: Object.freeze(definition.cellHandlers.map((handler) => Object.freeze({ ...handler }))),
    effectHandlers: Object.freeze(definition.effectHandlers.map((handler) => Object.freeze({ ...handler }))),
    intentHandlers: Object.freeze(definition.intentHandlers.map((handler) => Object.freeze({ ...handler }))),
    ...(definition.botStrategyHook
      ? { botStrategyHook: Object.freeze({ ...definition.botStrategyHook }) }
      : {}),
    ...(definition.positiveRentHook
      ? { positiveRentHook: Object.freeze({ ...definition.positiveRentHook }) }
      : {}),
    ...(definition.postTransitionHook
      ? { postTransitionHook: Object.freeze({ ...definition.postTransitionHook }) }
      : {}),
  });
}

interface OwnedHandler<T> {
  readonly moduleKey: string;
  readonly handler: T;
}

export class RuleModuleRegistry {
  readonly #modules: ReadonlyMap<string, RuleModuleDefinition>;
  readonly #cellHandlers: ReadonlyMap<string, OwnedHandler<CellSettlementHandler>>;
  readonly #effectHandlers: ReadonlyMap<string, OwnedHandler<EffectExecutionHandler>>;
  readonly #intentHandlers: ReadonlyMap<string, OwnedHandler<IntentHandler>>;

  constructor(inputDefinitions: readonly RuleModuleDefinition[]) {
    const modules = new Map<string, RuleModuleDefinition>();
    const cellHandlers = new Map<string, OwnedHandler<CellSettlementHandler>>();
    const effectHandlers = new Map<string, OwnedHandler<EffectExecutionHandler>>();
    const intentHandlers = new Map<string, OwnedHandler<IntentHandler>>();

    for (const inputDefinition of inputDefinitions) {
      assertValidModuleRef(inputDefinition.ref);
      const definition = copyDefinition(inputDefinition);
      const key = moduleKey(definition.ref);
      if (modules.has(key)) throw new Error(`Duplicate rule module ${key}`);
      modules.set(key, definition);

      for (const handler of definition.cellHandlers) {
        const handlerKey = handler.type === 'module'
          ? `${key}:module:${assertNonEmptySubtype(handler.cellType, 'cellType')}`
          : `core:${handler.type}`;
        const existing = cellHandlers.get(handlerKey);
        if (existing) throw new Error(`Cell handler conflict for ${handler.type === 'module' ? handler.cellType : handler.type}: ${existing.moduleKey} and ${key}`);
        cellHandlers.set(handlerKey, { moduleKey: key, handler });
      }
      for (const handler of definition.effectHandlers) {
        const handlerKey = handler.type === 'module'
          ? `${key}:module:${assertNonEmptySubtype(handler.effectType, 'effectType')}`
          : `core:${handler.type}`;
        const existing = effectHandlers.get(handlerKey);
        if (existing) throw new Error(`Effect handler conflict for ${handler.type === 'module' ? handler.effectType : handler.type}: ${existing.moduleKey} and ${key}`);
        effectHandlers.set(handlerKey, { moduleKey: key, handler });
      }
      for (const handler of definition.intentHandlers) {
        const handlerKey = handler.type === 'module'
          ? `${key}:module:${assertNonEmptySubtype(handler.action, 'action')}`
          : `core:${handler.type}`;
        const existing = intentHandlers.get(handlerKey);
        if (existing) throw new Error(`Intent handler conflict for ${handler.type === 'module' ? handler.action : handler.type}: ${existing.moduleKey} and ${key}`);
        intentHandlers.set(handlerKey, { moduleKey: key, handler });
      }
    }

    this.#modules = modules;
    this.#cellHandlers = cellHandlers;
    this.#effectHandlers = effectHandlers;
    this.#intentHandlers = intentHandlers;
    Object.freeze(this);
  }

  #resolveEnabled(refs: readonly RuleModuleRef[]): readonly RuleModuleDefinition[] {
    const seen = new Set<string>();
    const definitions = refs.map((ref) => {
      assertValidModuleRef(ref);
      const key = moduleKey(ref);
      if (seen.has(key)) throw new Error(`Duplicate enabled rule module ${key}`);
      seen.add(key);
      const definition = this.#modules.get(key);
      if (!definition) throw new Error(`Unknown rule module ${key}`);
      return definition;
    });
    return definitions.sort((left, right) => compareRefs(left.ref, right.ref));
  }

  getCellHandler(
    refs: readonly RuleModuleRef[],
    cell: ReadonlyCell | CoreCellType,
  ): CellSettlementHandler | undefined {
    const enabled = new Set(this.#resolveEnabled(refs).map((definition) => moduleKey(definition.ref)));
    const handlerKey = typeof cell === 'string'
      ? `core:${cell}`
      : cell.type === 'module'
        ? `${assertEnvelopeEnabled(cell.module, enabled)}:module:${assertModuleCellEnvelope(cell)}`
        : `core:${cell.type}`;
    const owned = this.#cellHandlers.get(handlerKey);
    return owned && enabled.has(owned.moduleKey) ? owned.handler : undefined;
  }

  getEffectHandler(
    refs: readonly RuleModuleRef[],
    effect: ModuleEffect,
  ): ModuleEffectExecutionHandler | undefined;
  getEffectHandler(
    refs: readonly RuleModuleRef[],
    effect: CoreCellEffect | CoreCellEffect['type'],
  ): CoreEffectExecutionHandler | undefined;
  getEffectHandler(
    refs: readonly RuleModuleRef[],
    effect: CellEffect | CoreCellEffect['type'],
  ): EffectExecutionHandler | undefined {
    const enabled = new Set(this.#resolveEnabled(refs).map((definition) => moduleKey(definition.ref)));
    const handlerKey = typeof effect === 'string'
      ? `core:${effect}`
      : effect.type === 'module'
        ? `${assertEnvelopeEnabled(effect.module, enabled)}:module:${assertModuleEffectEnvelope(effect)}`
        : `core:${effect.type}`;
    const owned = this.#effectHandlers.get(handlerKey);
    if (!owned || !enabled.has(owned.moduleKey)) return undefined;
    if (typeof effect !== 'string' && effect.type === 'module') {
      return owned.handler.type === 'module' ? owned.handler : undefined;
    }
    return owned.handler.type === 'module' ? undefined : owned.handler;
  }

  getIntentHandler(refs: readonly RuleModuleRef[], intent: Intent | CoreIntent['type']): IntentHandler | undefined {
    const enabled = new Set(this.#resolveEnabled(refs).map((definition) => moduleKey(definition.ref)));
    const handlerKey = typeof intent === 'string'
      ? `core:${intent}`
      : intent.type === 'module'
        ? `${assertEnvelopeEnabled(intent.module, enabled)}:module:${assertModuleIntentEnvelope(intent)}`
        : `core:${intent.type}`;
    const owned = this.#intentHandlers.get(handlerKey);
    return owned && enabled.has(owned.moduleKey) ? owned.handler : undefined;
  }

  runBotStrategyHooks(refs: readonly RuleModuleRef[], context: BotStrategyContext): Intent | undefined {
    let decision = context.currentDecision;
    for (const definition of this.#resolveEnabled(refs)) {
      const candidate = definition.botStrategyHook?.decide({ ...context, currentDecision: decision });
      if (candidate !== undefined) decision = candidate;
    }
    if (decision !== undefined && !this.getIntentHandler(refs, decision)) {
      throw new Error(`No enabled intent handler for ${decision.type}`);
    }
    return decision;
  }

  runPositiveRentHooks(refs: readonly RuleModuleRef[], context: PositiveRentContext): PositiveRentResult {
    let result: PositiveRentResult = {
      state: context.state,
      events: context.events,
      amount: context.amount,
    };
    for (const definition of this.#resolveEnabled(refs)) {
      const hook = definition.positiveRentHook;
      if (!hook) continue;
      result = hook.apply({
        ...context,
        state: result.state,
        events: result.events,
        amount: result.amount,
      });
    }
    return result;
  }

  runPostTransitionHooks(refs: readonly RuleModuleRef[], context: PostTransitionContext): ApplyResult {
    let result = context.result;
    for (const definition of this.#resolveEnabled(refs)) {
      const hook = definition.postTransitionHook;
      if (!hook) continue;
      result = hook.apply({ ...context, result });
    }
    return result;
  }
}

export function createRuleModuleRegistry(
  definitions: readonly RuleModuleDefinition[],
): RuleModuleRegistry {
  return new RuleModuleRegistry(definitions);
}

const callCoreCell: CellSettlementHandler['handle'] = (context) => context.applyCore();
const callCoreEffect: CoreEffectExecutionHandler['handle'] = (context) => context.applyCore();
const callCoreIntent: IntentHandler['handle'] = (context) => context.applyCore();

const coreRuleModuleInput: RuleModuleDefinition = {
  ref: { id: 'core', version: 1 },
  cellHandlers: (Object.keys(CORE_CELL_HANDLER_TYPES) as CoreCellType[]).map((type) => ({
    type,
    handle: callCoreCell,
  })),
  effectHandlers: (Object.keys(CORE_EFFECT_HANDLER_TYPES) as CoreCellEffect['type'][]).map((type) => ({
    type,
    handle: callCoreEffect,
  })),
  intentHandlers: (Object.keys(CORE_INTENT_HANDLER_TYPES) as CoreIntent['type'][]).map((type) => ({
    type,
    handle: callCoreIntent,
  })),
  botStrategyHook: {
    decide: (context) => context.currentDecision ?? context.applyCore(),
  },
};

export const coreRuleModuleDefinition = copyDefinition(coreRuleModuleInput);
export const defaultRuleModuleRegistry = createRuleModuleRegistry([
  coreRuleModuleDefinition,
  worldTourRuleModuleDefinition,
  greatWallRuleModuleDefinition,
]);
