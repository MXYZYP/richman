/**
 * 小程序端 BGM 桩。
 *
 * 源站用 WebAudio（window.AudioContext）合成背景音乐；小程序没有 WebAudio，
 * 只有 uni.createInnerAudioContext（需要真实音频文件）。第一版先静音，
 * 但**保留开关的持久化语义**，避免设置页读到一个不存在的值而反复弹提示。
 */
const BGM_KEY = 'richman-bgm-enabled';
const BGM_VOLUME_KEY = 'richman-bgm-volume';

export const BGM_DEFAULT_VOLUME = 0.7;

export function isBgmEnabled(): boolean {
  return localStorage.getItem(BGM_KEY) !== '0';
}

export function getBgmVolume(): number {
  const raw = Number(localStorage.getItem(BGM_VOLUME_KEY));
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 1) : BGM_DEFAULT_VOLUME;
}

export function setBgmVolume(value: number): void {
  localStorage.setItem(BGM_VOLUME_KEY, String(Math.max(0, Math.min(value, 1))));
}

export function setBgmEnabled(value: boolean): void {
  localStorage.setItem(BGM_KEY, value ? '1' : '0');
}

export function startBgm(): void {}
export function stopBgm(): void {}
export function armBgmAutoStart(): void {}
