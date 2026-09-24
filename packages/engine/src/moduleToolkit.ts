// 规则模块复用 core 实现的内部集中点。
//
// 背景：world-tour 模块此前直接 import core 的内部文件（./effects ./movement …），那是对
// core 私有实现的穿透依赖。本文件把这些被模块用到的 core 函数集中 re-export，使依赖关系
// 诚实化——模块经此一处引用，core 的内部文件结构可自由演化。
//
// #21 B（模块注册表上下文显式传递）：registry 缺口已补齐。
//   历史上 resolveLanding / applyCardEffect 的 registry 参数默认取 defaultRuleModuleRegistry，
//   world-tour 调用时不传 registry；当时能工作，仅因全仓唯一的非 core 模块（world-tour）自身
//   就注册在 defaultRuleModuleRegistry 里，自洽。一旦出现「注册在自定义 registry 上的第三方
//   模块」从本文件调用这些函数，就会在递归落点/连锁抽卡处拿到
//   `Unknown rule module` 或 `No enabled cell handler` 而失败——这是扩展性硬伤。
//
//   现在的契约：所有 handler 上下文（CellSettlement / EffectExecution / IntentExecution /
//   BotStrategy / PositiveRent / PostTransition）都携带 `registry` 字段，其值恒等于本次
//   `applyIntent(..., registry)` / `resolveLanding(..., registry)` 实际使用的注册表。
//   模块 handler 内需要递归时**必须**把它透传：
//
//     // 推荐：直接用上下文里已绑定 registry 的便捷封装
//     const settled = landingFor(context)(moved, events);
//
//     // 等价写法（显式透传）
//     const settled = resolveLanding(moved, playerId, events, 0, context.registry);
//
//   回归测试见 `__tests__/moduleRegistry.test.ts` 的「自定义 registry 的模块 handler 内递归落点」。

export { resolveLanding, applyCardEffect } from './effects';
export { getNextCellId, walkPath } from './movement';
export { processQueuedPayments } from './payments';
export { rollDice, rollSingleDice } from './rng';
export { advanceToNextPlayableTurn } from './turns';
export { finishCashGoalIfReached } from './victory';

import { resolveLanding as resolveLandingImpl, applyCardEffect as applyCardEffectImpl } from './effects';
import type { EffectResult } from './effects';
import type { CellSettlementContext, EffectExecutionContext, IntentExecutionContext } from './moduleRegistry';
import type { GameEvent, GameState } from './types';

/** 只要求上下文里带 registry 与 playerId 的最小形状；三种 handler 上下文都满足。 */
type RegistryBoundContext =
  | Pick<CellSettlementContext, 'registry' | 'playerId'>
  | Pick<EffectExecutionContext, 'registry' | 'playerId'>
  | Pick<IntentExecutionContext, 'registry' | 'playerId'>;

/**
 * 把 core 的落点结算绑定到 handler 上下文实际使用的 registry。
 * 返回的函数签名与 `resolveLanding` 一致（只省略 registry 参数），模块内递归时用它可以
 * 彻底避免「忘记透传 registry」这一类扩展性缺陷。
 */
export function landingFor(context: RegistryBoundContext) {
  return (
    state: GameState,
    playerId: string = context.playerId,
    events: GameEvent[] = [],
    depth = 0,
  ): EffectResult => resolveLandingImpl(state, playerId, events, depth, context.registry);
}

/**
 * 同理：把卡牌/格效果执行绑定到 handler 上下文实际使用的 registry。
 * 参数顺序与 `applyCardEffect` 一致（只省略 registry 参数）。
 */
export function cardEffectFor(context: RegistryBoundContext) {
  return (
    state: GameState,
    playerId: string,
    card: Parameters<typeof applyCardEffectImpl>[2],
    events: GameEvent[] = [],
    depth = 0,
  ): EffectResult => applyCardEffectImpl(state, playerId, card, events, depth, context.registry);
}
