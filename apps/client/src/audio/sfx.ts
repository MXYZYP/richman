// 轻量音效模块（路线图 #13 / P1 音效）：Web Audio 振荡器合成，无需任何音频素材文件。
// 受"音效"开关控制，偏好存 localStorage。首次用户手势后才创建 AudioContext（满足浏览器自动播放策略）。

export type SfxName = 'dice' | 'pay' | 'coin' | 'bankrupt' | 'win' | 'lose';

const SFX_KEY = 'richman_sfx_enabled';
/**
 * 音效音量（#13 设置面板扩展）：0~1 的线性音量，与「音效开关」相互独立——
 * 开关管「响不响」，音量管「多响」。两者都只写本机偏好键，不进对局状态。
 */
const SFX_VOLUME_KEY = 'richman_sfx_volume';
/** 默认音量：留出余量，掷骰那一下三层叠加（摩擦 + 九次撞击 + 停稳）在 1.0 时偏吵。 */
export const SFX_DEFAULT_VOLUME = 0.7;

/**
 * 通用起音斜坡（P1-4 修复）。
 * 包络若从静音直接跳到满幅，波形会出现阶跃 → 每次发声都带一下"啪"的爆音。
 * 3ms 斜坡足以消掉阶跃，听感上仍然是"立刻"发声。
 */
const ATTACK_MS = 3;

/**
 * 骰子音色（#2：由「四次点击」换成「真骰子滚落」的自然音）。
 *
 * 上一版是四记等距带通噪声脉冲，听感像敲了四下木鱼：次数太少、间隔太规则、
 * 没有"滚动"的持续摩擦声，也没有收尾那一下停稳。真人掷骰的声学结构其实是三层：
 *   1) 滚落摩擦（bed）——骰子在盘里翻滚时持续的沙沙声，带通中心频率先升后降；
 *   2) 撞击（knock）——9 次疏密不均的清脆磕碰，每次的中心频率/增益/衰减都带随机抖动，
 *      避免重复感（人耳对等间隔同音高的连击极其敏感，一听就是电子音）；
 *   3) 停稳（settle）——最后两记低频闷响，表示骰子定住。
 * 三层都只是白噪声/正弦经过滤波与包络，不引入任何音频素材文件。
 */
const DICE_ROLL_KNOCK_COUNT = 9;
/** 各次撞击的基准偏移（毫秒）：间隔逐次拉开，模拟骰子掷出后一路减速、最后又磕一下才定住。 */
const DICE_ROLL_KNOCK_OFFSETS_MS: readonly number[] = [0, 26, 52, 84, 118, 152, 196, 248, 318];
/** 每次撞击的时间抖动幅度（毫秒）：±9ms 足以打散等距感，又不会乱到听起来散架。 */
const DICE_ROLL_KNOCK_JITTER_MS = 9;
/** 撞击基准中心频率（Hz）：高低交错，模拟骰子不同棱角着地。 */
const DICE_ROLL_KNOCK_FILTER_HZ: readonly number[] = [980, 1480, 2240, 1260, 2680, 1720, 3120, 1180, 2060];
const DICE_ROLL_KNOCK_Q = 1.4;
const DICE_ROLL_KNOCK_BASE_GAIN = 0.11;
const DICE_ROLL_KNOCK_BASE_DECAY_MS = 46;
/** 滚落摩擦声：整段约 400ms，中心频率 700 → 2400 → 900Hz，像骰子滚出去又滚回来。 */
const DICE_ROLL_BED_MS = 400;
const DICE_ROLL_BED_GAIN = 0.05;
/** 停稳闷响：[频率 Hz, 相对停稳时刻的延迟 ms, 增益]。 */
const DICE_SETTLE_THUMPS: readonly (readonly [number, number, number])[] = [
  [196, 0, 0.09],
  [147, 34, 0.055],
];
const DICE_ROLL_SETTLE_OFFSET_MS = 352;
/** 白噪声缓冲长度：需覆盖最长的一段（滚动摩擦声 400ms）。 */
const DICE_NOISE_SECONDS = 0.5;

let ctx: AudioContext | null = null;
let noiseCache: { context: AudioContext; buffer: AudioBuffer } | null = null;

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

function loadSfxPref(): boolean {
  try {
    const raw = window.localStorage.getItem(SFX_KEY);
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}

let enabled = loadSfxPref();

/** 把任意输入收进 0~1；非有限数（NaN / Infinity）回落到默认值，避免把增益算成 NaN。 */
function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return SFX_DEFAULT_VOLUME;
  return Math.min(1, Math.max(0, value));
}

function loadSfxVolume(): number {
  try {
    const raw = window.localStorage.getItem(SFX_VOLUME_KEY);
    if (raw === null) return SFX_DEFAULT_VOLUME;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampVolume(parsed) : SFX_DEFAULT_VOLUME;
  } catch {
    return SFX_DEFAULT_VOLUME;
  }
}

let volume = loadSfxVolume();

export function isSfxEnabled(): boolean {
  return enabled;
}

export function setSfxEnabled(value: boolean): void {
  enabled = value;
  try {
    window.localStorage.setItem(SFX_KEY, value ? '1' : '0');
  } catch {
    // 存储不可用时仍按内存值生效。
  }
}

export function getSfxVolume(): number {
  return volume;
}

export function setSfxVolume(value: number): void {
  volume = clampVolume(value);
  try {
    window.localStorage.setItem(SFX_VOLUME_KEY, String(volume));
  } catch {
    // 存储不可用时仍按内存值生效。
  }
}

function tone(freq: number, durationMs: number, type: OscillatorType, gain: number): void {
  // 音量归零等同于静音：直接不排期，省掉一次「从 0 起振」的指数斜坡（目标值为 0 不合法）。
  if (!enabled || volume <= 0) return;
  const ac = getCtx();
  if (ac === null) return;
  const osc = ac.createOscillator();
  const gainNode = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(gainNode);
  gainNode.connect(ac.destination);
  const start = ac.currentTime;
  const seconds = durationMs / 1000;
  const attackSeconds = Math.min(ATTACK_MS / 1000, seconds / 3);
  gainNode.gain.setValueAtTime(0.0001, start);
  gainNode.gain.linearRampToValueAtTime(gain * volume, start + attackSeconds);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
  osc.start(start);
  osc.stop(start + seconds);
}

/** 白噪声缓冲按 AudioContext 缓存：一局里骰子会响很多次，不必每次重算。 */
function noiseBuffer(ac: AudioContext): AudioBuffer {
  if (noiseCache !== null && noiseCache.context === ac) return noiseCache.buffer;
  const length = Math.max(1, Math.floor(ac.sampleRate * DICE_NOISE_SECONDS));
  const buffer = ac.createBuffer(1, length, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < length; index += 1) data[index] = Math.random() * 2 - 1;
  noiseCache = { context: ac, buffer };
  return buffer;
}

/** 一次撞击：带通白噪声脉冲 + 起音斜坡 + 指数衰减。 */
function diceKnock(
  ac: AudioContext,
  at: number,
  filterHz: number,
  gain: number,
  decayMs: number,
): void {
  const source = ac.createBufferSource();
  source.buffer = noiseBuffer(ac);
  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = filterHz;
  filter.Q.value = DICE_ROLL_KNOCK_Q;
  const gainNode = ac.createGain();
  const decaySeconds = decayMs / 1000;
  gainNode.gain.setValueAtTime(0.0001, at);
  gainNode.gain.linearRampToValueAtTime(gain * volume, at + ATTACK_MS / 1000);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, at + decaySeconds);
  source.connect(filter);
  filter.connect(gainNode);
  gainNode.connect(ac.destination);
  source.start(at);
  source.stop(at + decaySeconds);
}

/** 滚落摩擦声：一段带通白噪声，中心频率先升后降，音量两端包住中间。 */
function diceRollBed(ac: AudioContext, at: number, durationMs: number): void {
  const source = ac.createBufferSource();
  source.buffer = noiseBuffer(ac);
  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 0.9;
  const seconds = durationMs / 1000;
  filter.frequency.setValueAtTime(700, at);
  filter.frequency.linearRampToValueAtTime(2400, at + seconds * 0.45);
  filter.frequency.linearRampToValueAtTime(900, at + seconds);
  const gainNode = ac.createGain();
  const peak = DICE_ROLL_BED_GAIN * volume;
  gainNode.gain.setValueAtTime(0.0001, at);
  gainNode.gain.linearRampToValueAtTime(peak, at + 0.05);
  // 保持到 70% 处再收：滚动过程是连续的，不能全程渐弱，否则听起来像一次点击的尾巴。
  gainNode.gain.setValueAtTime(peak, at + seconds * 0.7);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
  source.connect(filter);
  filter.connect(gainNode);
  gainNode.connect(ac.destination);
  source.start(at);
  source.stop(at + seconds);
}

/** 停稳：两记低频闷响（正弦），短促衰减，表示骰子落地定住。 */
function diceSettleThump(ac: AudioContext, at: number): void {
  for (const [freq, delayMs, gain] of DICE_SETTLE_THUMPS) {
    const start = at + delayMs / 1000;
    const seconds = 0.12;
    const osc = ac.createOscillator();
    const gainNode = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.82, start + seconds);
    osc.connect(gainNode);
    gainNode.connect(ac.destination);
    gainNode.gain.setValueAtTime(0.0001, start);
    gainNode.gain.linearRampToValueAtTime(gain * volume, start + ATTACK_MS / 1000);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
    osc.start(start);
    osc.stop(start + seconds);
  }
}

/** 掷骰：摩擦声 + 九次带抖动撞击 + 停稳闷响，一次性排期（不留定时器回调）。 */
function diceRattle(): void {
  if (!enabled || volume <= 0) return;
  const ac = getCtx();
  if (ac === null) return;
  const start = ac.currentTime;
  diceRollBed(ac, start, DICE_ROLL_BED_MS);
  for (let index = 0; index < DICE_ROLL_KNOCK_COUNT; index += 1) {
    const baseMs = DICE_ROLL_KNOCK_OFFSETS_MS[index] ?? 0;
    const jitterMs = (Math.random() * 2 - 1) * DICE_ROLL_KNOCK_JITTER_MS;
    const filterHz = (DICE_ROLL_KNOCK_FILTER_HZ[index] ?? 1500) * (0.9 + Math.random() * 0.2);
    const gain = DICE_ROLL_KNOCK_BASE_GAIN * (0.75 + Math.random() * 0.5);
    const decayMs = DICE_ROLL_KNOCK_BASE_DECAY_MS * (0.7 + Math.random() * 0.7);
    diceKnock(ac, start + Math.max(0, baseMs + jitterMs) / 1000, filterHz, gain, decayMs);
  }
  diceSettleThump(ac, start + DICE_ROLL_SETTLE_OFFSET_MS / 1000);
}

/** 两段式音效的第二次发声：静音（关掉开关或音量归零）时连定时器都不排，避免留下无人需要的回调。 */
function delayedTone(
  freq: number,
  durationMs: number,
  type: OscillatorType,
  gain: number,
  delayMs: number,
): void {
  if (!enabled || volume <= 0) return;
  window.setTimeout(() => tone(freq, durationMs, type, gain), delayMs);
}

export function playSfx(name: SfxName): void {
  switch (name) {
    case 'dice':
      diceRattle();
      break;
    case 'pay':
      tone(220, 120, 'sawtooth', 0.05);
      break;
    case 'coin':
      tone(880, 100, 'triangle', 0.05);
      break;
    case 'bankrupt':
      tone(140, 260, 'sawtooth', 0.06);
      break;
    case 'win':
      tone(660, 160, 'triangle', 0.06);
      delayedTone(990, 200, 'triangle', 0.06, 120);
      break;
    case 'lose':
      tone(330, 200, 'sine', 0.05);
      delayedTone(220, 260, 'sine', 0.05, 140);
      break;
  }
}
