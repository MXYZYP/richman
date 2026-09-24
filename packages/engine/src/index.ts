// @richman/engine 入口
export * from './types';
export { createGame, applyIntent, skipCurrentTurn } from './engine';
export type { CreateGameInput } from './engine';
export { getCurrentRent, canBuyProperty, canBuild, getSellableAssets } from './selectors';
export { chooseBotIntent } from './bot';
export type { BotDifficulty } from './bot';
export { hydrateGameState, resolveOverriddenGameConfig } from './hydrate';
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
  CellSettlementContext,
  EffectExecutionHandler,
  EffectExecutionContext,
  ModuleEffectExecutionContext,
  ModuleEffectExecutionHandler,
  IntentExecutionContext,
  BotStrategyContext,
  PositiveRentContext,
  PostTransitionContext,
  ReadonlyEffectCard,
  IntentHandler,
  BotStrategyHook,
  PositiveRentHook,
  PostTransitionHook,
} from './moduleRegistry';
// #21 B：模块 handler 内递归时用的「已绑定 registry」便捷封装。
export { landingFor, cardEffectFor } from './moduleToolkit';
export {
  WORLD_TOUR_MODULE_KEY,
  WORLD_TOUR_MODULE_REF,
  worldTourRuleModuleDefinition,
} from './worldTourModule';
export {
  GREAT_WALL_MODULE_KEY,
  GREAT_WALL_MODULE_REF,
  greatWallRuleModuleDefinition,
  isGreatWallBeacon,
  greatWallBeaconCells,
} from './greatWallModule';
