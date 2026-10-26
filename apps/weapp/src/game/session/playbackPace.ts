import { ref, type Ref } from 'vue';

// 动画速度（#55 权限与同步裁定）：
//   问题：动画调节是「仅房主可调」还是「人人可调」？若仅房主可调，是全局同步还是仅本人可见？
//   结论：**所有参与者（含观战者）都可各自调节；只影响本机显示、不同步给他人、不改变对局状态。**
//   理由：它本质是「观看节奏」这类本机偏好，与棋盘状态无关；把它变成房主权限或全局同步，会让
//   一个玩家放慢观看速度就拖慢全桌，且需要新增网络协议与状态合并——收益为零、风险最高。
//   实现保障：本模块只持有内存 ref + localStorage 单键持久化，不 import 任何 session / protocol /
//   网络层，也不写入游戏状态。回归测试见 playbackPace.test.ts 的「只写本机偏好键」用例。
/** 动画速度档位：slow=细读, standard=推荐, fast=接近旧版快节奏。 */
export type PlaybackSpeed = 'slow' | 'standard' | 'fast';

export const PLAYBACK_SPEED_OPTIONS: ReadonlyArray<{ value: PlaybackSpeed; label: string }> = [
  { value: 'slow', label: '慢速' },
  { value: 'standard', label: '标准' },
  { value: 'fast', label: '快速' },
];

const STORAGE_KEY = 'richman.playback-speed';
const SPEED_MULTIPLIERS: Record<PlaybackSpeed, number> = { slow: 1.6, standard: 1, fast: 0.2 };

interface PlaybackStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const browserGlobal = globalThis as typeof globalThis & { readonly localStorage?: PlaybackStorage };

function isPlaybackSpeed(value: unknown): value is PlaybackSpeed {
  return value === 'slow' || value === 'standard' || value === 'fast';
}

let sharedSpeed: Ref<PlaybackSpeed> | null = null;

/** 全局共享的速度档位（两个会话与 GameView 读取同一个，切换即时生效）。 */
export function getPlaybackSpeedRef(): Ref<PlaybackSpeed> {
  if (sharedSpeed === null) {
    let initial: PlaybackSpeed = 'standard';
    try {
      const stored = browserGlobal.localStorage?.getItem(STORAGE_KEY);
      if (isPlaybackSpeed(stored)) initial = stored;
    } catch { /* SSR/隐私模式下无存储 */ }
    sharedSpeed = ref(initial);
  }
  return sharedSpeed;
}

export function setPlaybackSpeed(speed: PlaybackSpeed): void {
  getPlaybackSpeedRef().value = speed;
  try { browserGlobal.localStorage?.setItem(STORAGE_KEY, speed); } catch { /* 存储不可用时只保活本次会话 */ }
}

/** 当前档位对应的时长倍率；presenter 每个事件都会重新读取，因此中途调速立即生效。 */
export function paceMultiplier(): number {
  return SPEED_MULTIPLIERS[getPlaybackSpeedRef().value];
}
