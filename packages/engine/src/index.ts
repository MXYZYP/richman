// @richman/engine 入口
export * from './types';
export { createGame, applyIntent, skipCurrentTurn } from './engine';
export type { CreateGameInput } from './engine';
export { getCurrentRent, canBuyProperty, canBuild, getSellableAssets } from './selectors';
export { chooseBotIntent } from './bot';
export { hydrateGameState } from './hydrate';
export type { HydrateGameStateResult } from './hydrate';
export {
  RuleModuleRegistry,
  createRuleModuleRegistry,
  coreRuleModuleDefinition,
  defaultRuleModuleRegistry,
} from './moduleRegistry';
export type {
  RuleModuleDefinition,
  CellSettlementHandler,
  EffectExecutionHandler,
  EffectExecutionContext,
  ModuleEffectExecutionContext,
  ModuleEffectExecutionHandler,
  ReadonlyEffectCard,
  IntentHandler,
  BotStrategyHook,
  PositiveRentHook,
  PostTransitionHook,
} from './moduleRegistry';
export {
  WORLD_TOUR_MODULE_KEY,
  WORLD_TOUR_MODULE_REF,
  worldTourRuleModuleDefinition,
} from './worldTourModule';
