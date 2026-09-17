import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPlaybackSpeedRef, paceMultiplier, setPlaybackSpeed } from './playbackPace';

describe('playbackPace', () => {
  beforeEach(() => {
    setPlaybackSpeed('standard');
  });
  it('defaults to standard speed (1x multiplier)', () => {
    expect(getPlaybackSpeedRef().value).toBe('standard');
    expect(paceMultiplier()).toBe(1);
  });

  it('updates the shared ref and multiplier when the speed changes', () => {
    setPlaybackSpeed('slow');
    expect(getPlaybackSpeedRef().value).toBe('slow');
    expect(paceMultiplier()).toBe(1.6);

    setPlaybackSpeed('fast');
    expect(getPlaybackSpeedRef().value).toBe('fast');
    expect(paceMultiplier()).toBe(0.2);

    setPlaybackSpeed('standard');
  });

  it('persists the choice so a later session restores it', () => {
    const store: Record<string, string> = {};
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => { store[key] = value; },
      },
    });
    try {
      setPlaybackSpeed('fast');
      expect(store['richman.playback-speed']).toBe('fast');
    } finally {
      setPlaybackSpeed('standard');
      if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
      else Object.defineProperty(globalThis, 'localStorage', original);
    }
  });

  it('ignores unavailable storage while keeping the in-memory speed', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => { throw new Error('Storage blocked'); },
    });
    try {
      expect(() => setPlaybackSpeed('fast')).not.toThrow();
      expect(getPlaybackSpeedRef().value).toBe('fast');
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
      else Object.defineProperty(globalThis, 'localStorage', original);
    }
  });

  it('falls back to standard when stored speed cannot be read or is invalid', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    try {
      for (const getItem of [
        () => { throw new Error('Storage blocked'); },
        () => 'turbo',
      ]) {
        Object.defineProperty(globalThis, 'localStorage', {
          configurable: true,
          value: { getItem, setItem: () => undefined },
        });
        vi.resetModules();
        // This test intentionally reloads the known module to exercise its initialization boundary.
        const freshModule = await import('./playbackPace');
        expect(freshModule.getPlaybackSpeedRef().value).toBe('standard');
      }
    } finally {
      vi.resetModules();
      if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
      else Object.defineProperty(globalThis, 'localStorage', original);
    }
  });
});
