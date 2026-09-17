// 规则模块复用 core 实现的内部集中点。
//
// 背景：world-tour 模块此前直接 import core 的内部文件（./effects ./movement …），那是对
// core 私有实现的穿透依赖。本文件把这些被模块用到的 core 函数集中 re-export，使依赖关系
// 诚实化——模块经此一处引用，core 的内部文件结构可自由演化。
//
// 【已知缺口，暂未实现】registry 未随上下文线程传递。
//   resolveLanding / applyCardEffect 的 registry 参数默认取 defaultRuleModuleRegistry，
//   world-tour 调用时不传 registry。当前之所以工作正常，仅因全仓唯一的非 core 模块
//   （world-tour）自身就注册在 defaultRuleModuleRegistry 里，自洽。
//   若将来出现「注册在自定义 registry 的第三方模块」从本文件调用这些函数并期望它认识
//   自己的 cell/effect，将得到 Unknown module。届时应在 handler context 上携带当前
//   applyIntent(..., registry) 的 registry（或提供已绑定 registry 的 core operations），
//   并补「自定义模块 handler 内递归落点」的回归测试。在该需求出现前，此处仅收敛依赖，
//   不提前设计 context API，避免过度设计。

export { resolveLanding, applyCardEffect } from './effects';
export { getNextCellId, walkPath } from './movement';
export { processQueuedPayments } from './payments';
export { rollDice, rollSingleDice } from './rng';
export { advanceToNextPlayableTurn } from './turns';
export { finishCashGoalIfReached } from './victory';
