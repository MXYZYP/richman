// 确定性随机数工具（mulberry32）
// 纯函数式：每次返回 [值, 新state]，避免 closure 副作用，让 GameState 可序列化、可复现
// 同 seed ⇒ 完全相同的随机序列（测试的关键，03 §4）

/** 把任意字符串 seed 哈希为 32 位无符号整数（mulberry32 初始 state） */
export function hashSeed(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

/** 单步推进 mulberry32：返回 [0, 1) 随机数 + 推进后的 state */
export function rngNext(state: number): [number, number] {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, state];
}

/** 从 state 取一个 [min, max] 闭区间整数，返回 [整数, 新state] */
export function rngInt(state: number, min: number, max: number): [number, number] {
  const [v, s] = rngNext(state);
  return [min + Math.floor(v * (max - min + 1)), s];
}

/** Fisher-Yates 洗牌：返回 [打乱后的新数组, 新state]（不改原数组） */
export function shuffle<T>(arr: readonly T[], state: number): [T[], number] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const [j, s] = rngInt(state, 0, i);
    state = s;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return [a, state];
}

/** 掷两颗骰子（K2 定案）：返回 [[d1, d2], 新state]，点数和 2-12 */
export function rollDice(state: number): [[number, number], number] {
  const [d1, s1] = rngInt(state, 1, 6);
  const [d2, s2] = rngInt(s1, 1, 6);
  return [[d1, d2], s2];
}

/** 掷一颗骰子：返回 [点数, 新state]（1-6）—— 机场支线专用（01 §5.1 定案） */
export function rollSingleDice(state: number): [number, number] {
  return rngInt(state, 1, 6);
}
