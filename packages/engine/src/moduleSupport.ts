// 规则模块的公共支撑层（#23「每张地图都要有规则」）。
//
// 背景：仓库里原有三个模块（world-tour / great-wall / prison）各自复制了一套
// `isRecord` / `hasExactKeys` / `withXxxState` / `synchronizeXxx` 样板。本轮一次性新增 8 个模块，
// 若继续复制，同一处「公共模块状态的读/写/清空 + 待选动作保留」逻辑会出现 11 份，
// 任何一次修正都要改 11 处。这里把它收敛成一处**只做机械搬运、不含任何玩法决策**的工具集。
//
// 刻意不放进本文件的东西：
//   · 任何玩法常量（费用、收益、上限）—— 必须留在各自模块里，否则改一个数字会波及别的图；
//   · 任何校验函数 —— hydrate 的严格校验必须留在各模块内（见 moduleRegistry 的契约说明），
//     本文件只提供它们共用的 `isRecord` / `hasExactKeys` 原语。
import type { JsonValue, RuleModuleRef } from '@richman/board-data';
import type { GameEvent, GameState, PendingModuleAction } from './types';
import { rngInt } from './rng';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** `{ id, version }` → `'id@version'`，与 publicRuleState.modules 的键格式一致。 */
export function moduleKeyOf(ref: RuleModuleRef): string {
  return `${ref.id}@${ref.version}`;
}

/**
 * 读取本模块的公共状态原始 JSON（从未写过时返回 undefined）。
 * 调用方负责把它收窄成自己的形状——本函数不做任何形状假设。
 */
export function readRawModuleState(state: GameState, key: string): JsonValue | undefined {
  return state.publicRuleState.modules[key];
}

/**
 * 写入 / 清除本模块的公共状态，并可选替换待选动作。
 *
 * `value === null` 表示**清除键**而不是写 `null`：与 great-wall 的既有行为一致
 * （状态为空时不占键，房间快照与存档更精简，hydrate 也不必为「空对象」和「无键」写两条分支）。
 */
export function withRawModuleState(
  state: GameState,
  key: string,
  value: JsonValue | null,
  pendingActions: readonly PendingModuleAction[] = state.publicRuleState.pendingActions,
): GameState {
  const modules = { ...state.publicRuleState.modules };
  if (value === null) delete modules[key];
  else modules[key] = value;
  return { ...state, publicRuleState: { modules, pendingActions } };
}

/** 构造本模块的 module 事件（战报/动画驱动源）。 */
export function moduleEventFor(ref: RuleModuleRef, eventType: string, payload: JsonValue): GameEvent {
  return { type: 'module', module: ref, eventType, payload };
}

/**
 * 本次转移是否跨过了一个回合边界。
 *
 * 为什么用「回合号变化」而不是「intent === 'end_turn'」：回合推进有 3 条路径
 * （end_turn / skipCurrentTurn 的托管跳过 / 破产稳定器自动推进），只看 intent 会漏掉后两条。
 * 而回合内的多次意图（掷骰 → 买地 → 建房）都不改 turn，天然不会误触发。
 */
export function crossedTurnBoundary(previousState: GameState, nextState: GameState): boolean {
  return nextState.turn !== previousState.turn;
}

/**
 * 本次转移中该玩家**第一次**移动的路径；没有移动则返回 undefined。
 *
 * `token_moved` 在一次转移里可能出现多条（落点再触发 move_to/move_steps 位移时会追加），
 * 而第一次才是「掷骰走出来的那条路」——这是本文件里最容易写错的一点，故取首个匹配。
 */
export function firstMovedPath(
  events: readonly GameEvent[],
  playerId: string,
): readonly number[] | undefined {
  for (const event of events) {
    if (event.type === 'token_moved' && event.playerId === playerId) return event.path;
  }
  return undefined;
}

/** 落点格 id：第一次移动路径的终点（位移类效果追加的那条不算）。 */
export function landedCellId(events: readonly GameEvent[], playerId: string): number | undefined {
  const path = firstMovedPath(events, playerId);
  if (path === undefined || path.length === 0) return undefined;
  return path[path.length - 1];
}

/** 该玩家本次是否**经过或停留**在指定格（用于「经过即触发」类玩法）。 */
export function passedThroughCell(
  events: readonly GameEvent[],
  playerId: string,
  cellId: number,
): boolean {
  const path = firstMovedPath(events, playerId);
  return path !== undefined && path.includes(cellId);
}

/**
 * 从 `0..count-1` 均匀取一个整数，并返回推进后的随机数状态。
 * 取不到（count <= 0）时返回 null，由调用方决定降级策略——本函数不抛错，
 * 因为规则模块跑在 `applyIntent` 主路径上，抛错会让整局卡住。
 */
export function pickRandomIndex(
  state: GameState,
  count: number,
): { index: number; seed: string } | null {
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  const numericSeed = Number(state.seed);
  if (!Number.isFinite(numericSeed)) return null;
  const [index, nextSeed] = rngInt(numericSeed, 0, count - 1);
  return { index, seed: String(nextSeed) };
}

/** 把金额裁到 [min, max] 的整数（规则模块里所有钱都按整数元结算）。 */
export function clampAmount(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
