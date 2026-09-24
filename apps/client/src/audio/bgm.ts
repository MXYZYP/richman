// 背景音乐模块（路线图 P1-4 BGM）：Web Audio 振荡器合成轻柔循环旋律，无需任何音频素材文件。
// 受"背景音乐"开关控制，偏好存 localStorage。首次用户手势后随开关启动（满足浏览器自动播放策略）。

const BGM_KEY = 'richman_bgm_enabled';
/**
 * 音乐音量（#13 设置面板扩展）：0~1 的线性音量，与「背景音乐开关」相互独立。
 * 只写本机偏好键，不进对局状态；改动在下一个音符（≤ 一个 STEP_MS）即生效，
 * 不去改已经排期的那个音符——中途改增益会让正在响的音突然变调，听感更差。
 */
const BGM_VOLUME_KEY = 'richman_bgm_volume';
export const BGM_DEFAULT_VOLUME = 0.7;
/** 铺底音符的峰值增益；乘上音量后仍远低于削波阈值。 */
const BGM_PEAK_GAIN = 0.045;

let ctx: AudioContext | null = null;
let timer: number | null = null;
let step = 0;
let enabled = loadBgmPref();

// C 大调五声音阶的柔和循环，避免刺耳；低增益铺底。
const MELODY: ReadonlyArray<number> = [
  261.63, 329.63, 392.0, 329.63, // C E G E
  293.66, 349.23, 440.0, 349.23, // D F A F
  261.63, 392.0, 523.25, 392.0, // C G C5 G
  329.63, 293.66, 261.63, 196.0, // E D C G2
];
const STEP_MS = 380;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined' || typeof window.AudioContext === 'undefined') return null;
  if (ctx === null) {
    const Ctor = window.AudioContext;
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function loadBgmPref(): boolean {
  try {
    const raw = window.localStorage.getItem(BGM_KEY);
    return raw === null ? false : raw === '1';
  } catch {
    return false;
  }
}

/** 把任意输入收进 0~1；非有限数（NaN / Infinity）回落到默认值。 */
function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return BGM_DEFAULT_VOLUME;
  return Math.min(1, Math.max(0, value));
}

function loadBgmVolume(): number {
  try {
    const raw = window.localStorage.getItem(BGM_VOLUME_KEY);
    if (raw === null) return BGM_DEFAULT_VOLUME;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampVolume(parsed) : BGM_DEFAULT_VOLUME;
  } catch {
    return BGM_DEFAULT_VOLUME;
  }
}

let volume = loadBgmVolume();

export function isBgmEnabled(): boolean {
  return enabled;
}

export function getBgmVolume(): number {
  return volume;
}

export function setBgmVolume(value: number): void {
  volume = clampVolume(value);
  try {
    window.localStorage.setItem(BGM_VOLUME_KEY, String(volume));
  } catch {
    // 存储不可用时仍按内存值生效。
  }
}

export function setBgmEnabled(value: boolean): void {
  enabled = value;
  try {
    window.localStorage.setItem(BGM_KEY, value ? '1' : '0');
  } catch {
    // 存储不可用时仍按内存值生效。
  }
  if (value) startBgm();
  else stopBgm();
}

function playNote(freq: number): void {
  // 音量归零等同于静音：不排期，省掉一次「目标值为 0」的指数斜坡（不合法）。
  if (volume <= 0) return;
  const ac = getCtx();
  if (ac === null) return;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(ac.destination);
  const start = ac.currentTime;
  const dur = STEP_MS / 1000;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(BGM_PEAK_GAIN * volume, start + 0.06);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.start(start);
  osc.stop(start + dur);
}

function tick(): void {
  playNote(MELODY[step % MELODY.length]);
  step += 1;
}

export function startBgm(): void {
  if (timer !== null) return;
  const ac = getCtx();
  if (ac === null) return;
  tick();
  timer = window.setInterval(tick, STEP_MS);
}

export function stopBgm(): void {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}

// 重载续播（P1-4 体验缺口修复）：用户上轮已开启 BGM 并写入 localStorage，但浏览器自动播放策略
// 禁止无用户手势创建/恢复 AudioContext。故在首次手势（点击/按键）时启动一次；启动后即移除监听。
// 仅当 enabled===true（来自存储）时才布防；开关由 UI 切换走 setBgmEnabled 直接 startBgm，不依赖此监听。
let autoStartArmed = false;
export function armBgmAutoStart(): void {
  if (typeof window === 'undefined' || !enabled || autoStartArmed) return;
  autoStartArmed = true;
  const starter = (): void => {
    window.removeEventListener('pointerdown', starter);
    window.removeEventListener('keydown', starter);
    startBgm();
  };
  window.addEventListener('pointerdown', starter, { once: true });
  window.addEventListener('keydown', starter, { once: true });
}
