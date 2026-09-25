// @richman/engine 入口
export * from './types';
export { createGame, applyIntent, skipCurrentTurn } from './engine';
export type { CreateGameInput } from './engine';
export { getCurrentRent, canBuyProperty, canBuild, getSellableAssets } from './selectors';
export { chooseBotIntent } from './bot';
export type { BotDifficulty } from './bot';
// 交易 / 拍卖（#105 / #106）：服务端需要按「当前真实行动者」调度自动化，
// 而交易等待阶段与拍卖阶段的行动者都不是 currentPlayerId，故把读取器导出。
export {
  AUCTION_MIN_INCREMENT,
  currentPendingTrade,
  currentPendingAuction,
} from './bargain';
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
export {
  PRISON_MODULE_KEY,
  PRISON_MODULE_REF,
  PRISON_CHOICE_ACTION,
  PRISON_DECISION_PHASE,
  PRISON_GOTO_JAIL_CELL_TYPE,
  PRISON_JAIL_CELL_TYPE,
  PRISON_CONFINE_EFFECT_TYPE,
  PRISON_CARD_EFFECT_TYPE,
  prisonRuleModuleDefinition,
  isPrisonGotoJail,
  isPrisonJail,
  prisonJailCellId,
  prisonGotoJailCellIds,
  prisonIsDetained,
  prisonAttemptsOf,
  prisonHeldCardsOf,
  prisonDetainedPlayerIds,
  prisonAwaitsDecision,
  validatePrisonPublicModuleState,
} from './prisonModule';
export type { PrisonChoice, PrisonDetention, PrisonHeldCard, PrisonPublicModuleState } from './prisonModule';
