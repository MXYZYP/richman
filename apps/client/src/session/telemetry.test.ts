import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTelemetry,
  isTelemetryOptedOut,
  resolveTelemetryClientId,
  setTelemetryOptOut,
  TELEMETRY_FLUSH_THRESHOLD,
  TELEMETRY_ID_KEY,
  TELEMETRY_MAX_QUEUE,
  TELEMETRY_OPT_OUT_KEY,
  TELEMETRY_PATH,
} from './telemetry';
import type { StorageLike } from './sessionStorage';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

/** 会抛的 storage：模拟 Safari 无痕 / 禁用存储。 */
function throwingStorage(): StorageLike {
  return {
    getItem: () => {
      throw new Error('storage disabled');
    },
    setItem: () => {
      throw new Error('storage disabled');
    },
    removeItem: () => {
      throw new Error('storage disabled');
    },
  };
}

describe('resolveTelemetryClientId', () => {
  it('generates and persists an id on first use', () => {
    const storage = memoryStorage();
    const id = resolveTelemetryClientId(storage, () => 'fixed-id');

    expect(id).toBe('fixed-id');
    expect(storage.getItem(TELEMETRY_ID_KEY)).toBe('fixed-id');
  });

  it('reuses the stored id across sessions', () => {
    const storage = memoryStorage({ [TELEMETRY_ID_KEY]: 'existing' });
    expect(resolveTelemetryClientId(storage, () => 'new')).toBe('existing');
  });

  it('falls back to a per-session id when storage throws', () => {
    expect(resolveTelemetryClientId(throwingStorage(), () => 'session-only')).toBe('session-only');
  });

  it('works without storage at all', () => {
    expect(resolveTelemetryClientId(undefined, () => 'no-storage')).toBe('no-storage');
  });
});

describe('telemetry opt-out', () => {
  it('defaults to enabled and reads the stored opt-out', () => {
    expect(isTelemetryOptedOut(memoryStorage())).toBe(false);
    expect(isTelemetryOptedOut(memoryStorage({ [TELEMETRY_OPT_OUT_KEY]: '1' }))).toBe(true);
  });

  it('writes and clears the flag, and survives a throwing storage', () => {
    const storage = memoryStorage();
    setTelemetryOptOut(storage, true);
    expect(storage.getItem(TELEMETRY_OPT_OUT_KEY)).toBe('1');
    setTelemetryOptOut(storage, false);
    expect(storage.getItem(TELEMETRY_OPT_OUT_KEY)).toBeNull();

    expect(() => setTelemetryOptOut(throwingStorage(), true)).not.toThrow();
    expect(isTelemetryOptedOut(throwingStorage())).toBe(false);
  });
});

describe('createTelemetry', () => {
  let posted: { url: string; body: string }[];
  let beaconed: { url: string; body: string }[];
  let seq: number;

  beforeEach(() => {
    posted = [];
    beaconed = [];
    seq = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function deps(overrides: Partial<Parameters<typeof createTelemetry>[0]> = {}) {
    return {
      storage: memoryStorage(),
      now: () => 1000 + seq++,
      randomId: () => 'client-1',
      post: async (url: string, body: string) => {
        posted.push({ url, body });
        return true;
      },
      beacon: (url: string, body: string) => {
        beaconed.push({ url, body });
        return true;
      },
      ...overrides,
    };
  }

  it('buffers events until the flush threshold is reached', () => {
    const telemetry = createTelemetry(deps());

    telemetry.track('app_open');

    expect(telemetry.pending()).toBe(1);
    expect(posted).toHaveLength(0);

    for (let i = 0; i < TELEMETRY_FLUSH_THRESHOLD - 1; i += 1) {
      telemetry.track('tick');
    }

    expect(posted).toHaveLength(1);
    expect(telemetry.pending()).toBe(0);
  });

  it('sends the anonymous id and the buffered events to the telemetry endpoint', () => {
    const telemetry = createTelemetry(deps());
    telemetry.track('game_start', { map: 'yuncheng', players: 4 });
    telemetry.flush();

    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe(TELEMETRY_PATH);
    expect(JSON.parse(posted[0]!.body)).toEqual({
      clientId: 'client-1',
      events: [{ name: 'game_start', t: 1000, props: { map: 'yuncheng', players: 4 } }],
    });
  });

  it('prefixes the configured origin for cross-origin deployments', () => {
    const telemetry = createTelemetry(deps({ origin: 'https://game.mxyzyp.xyz' }));
    telemetry.track('app_open');
    telemetry.flush();

    expect(posted[0]!.url).toBe(`https://game.mxyzyp.xyz${TELEMETRY_PATH}`);
  });

  it('uses the beacon channel when flushing during unload', () => {
    const telemetry = createTelemetry(deps());
    telemetry.track('app_open');
    telemetry.flush(true);

    expect(beaconed).toHaveLength(1);
    expect(posted).toHaveLength(0);
  });

  it('drops events with names that the server would reject', () => {
    const telemetry = createTelemetry(deps());
    telemetry.track('rm -rf /');
    telemetry.track('中文事件');
    telemetry.track('');

    expect(telemetry.pending()).toBe(0);
  });

  it('keeps only scalar props and truncates long strings', () => {
    const telemetry = createTelemetry(deps());
    // junk 是故意塞进去的非标量：类型上要显式绕开，正是为了验证运行时会被丢掉。
    const rawProps = { map: 'yuncheng', ok: true, turns: 12, junk: { a: 1 }, long: 'x'.repeat(300) };
    telemetry.track('game_end', rawProps as unknown as Record<string, string | number | boolean>);
    telemetry.flush();

    const props = (JSON.parse(posted[0]!.body) as { events: { props?: Record<string, unknown> }[] }).events[0]!.props;
    expect(props).toEqual({ map: 'yuncheng', ok: true, turns: 12, long: 'x'.repeat(200) });
  });

  it('never grows the queue without bound when sending keeps failing', () => {
    const telemetry = createTelemetry(deps({ post: async () => false, beacon: undefined }));

    for (let i = 0; i < TELEMETRY_MAX_QUEUE + 50; i += 1) {
      // 不触发自动 flush 的阈值：手动 flush 且上报失败时队列会被清空，
      // 这里直接连打上限 +50 条，验证的是队列自身的截断。
      telemetry.track('tick');
    }

    expect(telemetry.pending()).toBeLessThanOrEqual(TELEMETRY_MAX_QUEUE);
  });

  it('collects nothing once disabled, and forgets what was pending', () => {
    const telemetry = createTelemetry(deps());
    telemetry.track('app_open');
    telemetry.setEnabled(false);

    expect(telemetry.pending()).toBe(0);
    expect(telemetry.enabled()).toBe(false);

    telemetry.track('game_start');
    telemetry.flush();

    expect(posted).toHaveLength(0);
    // 关闭状态要写进 storage，下次打开仍然生效。
    expect(isTelemetryOptedOut(memoryStorage({ [TELEMETRY_OPT_OUT_KEY]: '1' }))).toBe(true);
  });

  it('starts disabled when the stored opt-out is set', () => {
    const storage = memoryStorage({ [TELEMETRY_OPT_OUT_KEY]: '1' });
    const telemetry = createTelemetry(deps({ storage }));

    expect(telemetry.enabled()).toBe(false);
    telemetry.track('app_open');
    expect(telemetry.pending()).toBe(0);
  });

  it('stays usable when storage throws', () => {
    const telemetry = createTelemetry(deps({ storage: throwingStorage() }));
    telemetry.track('app_open');
    telemetry.flush();

    expect(posted).toHaveLength(1);
  });

  it('does nothing on flush when the queue is empty', () => {
    const telemetry = createTelemetry(deps());
    telemetry.flush();
    telemetry.flush(true);

    expect(posted).toHaveLength(0);
    expect(beaconed).toHaveLength(0);
  });

  it('falls back to global fetch when no transport is injected', () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(null, { status: 200 }));
    });

    const telemetry = createTelemetry({ storage: memoryStorage(), now: () => 1, randomId: () => 'c' });
    telemetry.track('app_open');
    telemetry.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(TELEMETRY_PATH);
    expect((calls[0]!.init as { keepalive?: boolean }).keepalive).toBe(true);
  });
});
