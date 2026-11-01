import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushTelemetry,
  getTelemetry,
  installTelemetryLifecycle,
  isTelemetryEnabled,
  resetTelemetryForTests,
  setTelemetryEnabled,
  trackEvent,
} from './telemetryClient';
import type { StorageLike } from './sessionStorage';

function memoryStorage(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

let posts: string[];

beforeEach(() => {
  posts = [];
  resetTelemetryForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetTelemetryForTests();
});

describe('telemetryClient', () => {
  it('reports through the injected global fetch and keeps a single instance', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      posts.push(init.body as string);
      return Promise.resolve(new Response(null, { status: 200 }));
    });

    trackEvent('app_open');
    flushTelemetry();

    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!)).toMatchObject({ events: [{ name: 'app_open' }] });
    // 单例：两次 getTelemetry 是同一个对象，队列不会因为拿错实例而丢。
    expect(getTelemetry()).toBe(getTelemetry());
  });

  it('never throws when the environment is missing (SSR / native shell)', () => {
    vi.stubGlobal('localStorage', undefined);
    vi.stubGlobal('fetch', undefined);

    expect(() => trackEvent('app_open')).not.toThrow();
    expect(() => flushTelemetry()).not.toThrow();
  });

  it('survives a localStorage that throws on read', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => undefined,
    });
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 200 })));

    expect(() => trackEvent('app_open')).not.toThrow();
    expect(isTelemetryEnabled()).toBe(true);
  });

  it('binds pagehide / visibilitychange exactly once', () => {
    const bound: string[] = [];
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 200 })));
    vi.stubGlobal('addEventListener', (type: string) => {
      bound.push(type);
    });

    installTelemetryLifecycle();
    installTelemetryLifecycle();

    expect(bound).toEqual(['visibilitychange', 'pagehide']);
  });

  it('stops collecting after being disabled', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      posts.push(init.body as string);
      return Promise.resolve(new Response(null, { status: 200 }));
    });

    trackEvent('app_open');
    setTelemetryEnabled(false);

    expect(isTelemetryEnabled()).toBe(false);

    trackEvent('game_start');
    flushTelemetry();

    expect(posts).toHaveLength(0);
  });

  it('uses sendBeacon when flushing on unload', () => {
    const beacons: unknown[] = [];
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('navigator', { sendBeacon: (_url: string, body: unknown) => {
      beacons.push(body);
      return true;
    } });

    trackEvent('app_open');
    flushTelemetry(true);

    expect(beacons).toHaveLength(1);
  });
});
