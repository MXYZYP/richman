import { ref, type Ref } from 'vue';

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
