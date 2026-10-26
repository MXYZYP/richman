/**
 * 小程序端音效桩。
 *
 * 源站用 WebAudio 振荡器合成音效；小程序端第一版不发声，
 * 但保留开关与音量的持久化接口，供设置页读写。
 */
const SFX_KEY = 'richman-sfx-enabled';
const SFX_VOLUME_KEY = 'richman-sfx-volume';

export type SfxName = 'dice' | 'pay' | 'coin' | 'bankrupt' | 'win' | 'lose';

export const SFX_DEFAULT_VOLUME = 0.7;

export function isSfxEnabled(): boolean {
  return localStorage.getItem(SFX_KEY) !== '0';
}

export function setSfxEnabled(value: boolean): void {
  localStorage.setItem(SFX_KEY, value ? '1' : '0');
}

export function getSfxVolume(): number {
  const raw = Number(localStorage.getItem(SFX_VOLUME_KEY));
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 1) : SFX_DEFAULT_VOLUME;
}

export function setSfxVolume(value: number): void {
  localStorage.setItem(SFX_VOLUME_KEY, String(Math.max(0, Math.min(value, 1))));
}

export function playSfx(_name: SfxName): void {}
