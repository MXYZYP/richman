import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTelemetryStore,
  parseTelemetryBatch,
  type TelemetryBatch,
} from '../telemetry/telemetryStore';

let tempRoot: string | undefined;

afterEach(async () => {
  if (tempRoot === undefined) return;
  const root = tempRoot;
  tempRoot = undefined;
  await rm(root, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), 'richman-telemetry-'));
  return join(tempRoot, 'runtime');
}

function batch(events: unknown[], clientId = 'abc123'): unknown {
  return { clientId, events };
}

describe('parseTelemetryBatch', () => {
  const fixedNow = () => 1_700_000_000_000;

  it('keeps a well-formed batch as-is', () => {
    const parsed = parseTelemetryBatch(batch([
      { name: 'app_open', t: fixedNow(), props: { map: 'china-tour', players: 4 } },
    ]), { now: fixedNow });

    expect(parsed).toEqual({
      clientId: 'abc123',
      events: [{ name: 'app_open', t: fixedNow(), props: { map: 'china-tour', players: 4 } }],
    });
  });

  it('rejects batches without a usable client id', () => {
    expect(parseTelemetryBatch(batch([{ name: 'app_open', t: 1 }], ''), { now: fixedNow })).toBeNull();
    expect(parseTelemetryBatch(batch([{ name: 'app_open', t: 1 }], 'a b c'), { now: fixedNow })).toBeNull();
    // 64 字符上限：超长 id 只可能是坏客户端或被滥用。
    expect(parseTelemetryBatch(batch([{ name: 'app_open', t: 1 }], 'x'.repeat(65)), { now: fixedNow })).toBeNull();
  });

  it('drops events whose name is not on the allowlist pattern', () => {
    const parsed = parseTelemetryBatch(batch([
      { name: 'app_open', t: fixedNow() },
      { name: 'rm -rf /', t: fixedNow() },
      { name: '游戏开始', t: fixedNow() },
      { name: '', t: fixedNow() },
    ]), { now: fixedNow });

    expect(parsed?.events.map((event) => event.name)).toEqual(['app_open']);
  });

  it('keeps only scalar props, caps the count, and truncates long strings', () => {
    const parsed = parseTelemetryBatch(batch([
      {
        name: 'game_end',
        t: fixedNow(),
        props: {
          map: 'yuncheng',
          ok: true,
          turns: 42,
          bad: { nested: 1 },
          'bad key': 1,
          long: 'x'.repeat(500),
          p1: 1, p2: 1, p3: 1, p4: 1, p5: 1, p6: 1, p7: 1, p8: 1,
        },
      },
    ]), { now: fixedNow });

    const props = parsed?.events[0]?.props ?? {};
    expect(props.map).toBe('yuncheng');
    expect(props.ok).toBe(true);
    expect(props.turns).toBe(42);
    expect(props.bad).toBeUndefined();
    expect(props['bad key']).toBeUndefined();
    expect((props.long as string).length).toBe(200);
    // 上限 10 个键。
    expect(Object.keys(props).length).toBe(10);
  });

  it('replaces absurd client timestamps with the server clock instead of dropping the event', () => {
    const serverNow = fixedNow();
    const parsed = parseTelemetryBatch(batch([
      { name: 'app_open', t: 0 },
      { name: 'game_start', t: serverNow + 1000 },
    ]), { now: fixedNow });

    expect(parsed?.events.map((event) => event.t)).toEqual([serverNow, serverNow + 1000]);
  });

  it('returns null when nothing usable survives', () => {
    expect(parseTelemetryBatch(batch([{ name: '!!', t: 1 }]), { now: fixedNow })).toBeNull();
    expect(parseTelemetryBatch(batch([]), { now: fixedNow })).toBeNull();
    expect(parseTelemetryBatch('not an object', { now: fixedNow })).toBeNull();
    expect(parseTelemetryBatch(null, { now: fixedNow })).toBeNull();
  });

  it('caps the number of events per batch', () => {
    const events = Array.from({ length: 250 }, () => ({ name: 'tick', t: fixedNow() }));
    const parsed = parseTelemetryBatch(batch(events), { now: fixedNow });
    expect(parsed?.events.length).toBe(100);
  });
});

describe('createTelemetryStore', () => {
  it('appends one ndjson line per event into the day file', async () => {
    const directory = await tempDir();
    const store = createTelemetryStore({ directory, now: () => Date.UTC(2026, 9, 31, 12) });
    const day = new Date(Date.UTC(2026, 9, 31, 12));

    const written = store.append({
      clientId: 'client-a',
      events: [
        { name: 'app_open', t: 1 },
        { name: 'game_start', t: 2, props: { map: 'yuncheng' } },
      ],
    }, day);

    expect(written).toBe(2);
    const raw = await readFile(store.filePathFor(day), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!)).toEqual({ id: 'client-a', name: 'app_open', t: 1 });
    expect(JSON.parse(lines[1]!)).toEqual({ id: 'client-a', name: 'game_start', t: 2, props: { map: 'yuncheng' } });
  });

  it('creates the directory on first write instead of requiring a pre-made one', async () => {
    const directory = await tempDir();
    expect(existsSync(directory)).toBe(false);

    const store = createTelemetryStore({ directory });
    store.append({ clientId: 'c', events: [{ name: 'app_open', t: 1 }] });

    expect(existsSync(store.filePathFor(new Date()))).toBe(true);
  });

  it('splits files per calendar day', async () => {
    const directory = await tempDir();
    const store = createTelemetryStore({ directory });
    const dayOne = new Date(Date.UTC(2026, 9, 31, 12));
    const dayTwo = new Date(Date.UTC(2026, 10, 1, 12));

    store.append({ clientId: 'c', events: [{ name: 'app_open', t: 1 }] }, dayOne);
    store.append({ clientId: 'c', events: [{ name: 'app_open', t: 2 }] }, dayTwo);

    expect(store.filePathFor(dayOne)).not.toBe(store.filePathFor(dayTwo));
    expect(await readFile(store.filePathFor(dayOne), 'utf8')).toContain('"t":1');
    expect(await readFile(store.filePathFor(dayTwo), 'utf8')).toContain('"t":2');
  });

  it('appends rather than overwrites (a restart must not lose earlier lines)', async () => {
    const directory = await tempDir();
    const day = new Date(Date.UTC(2026, 9, 31, 12));

    const first: TelemetryBatch = { clientId: 'a', events: [{ name: 'app_open', t: 1 }] };
    const second: TelemetryBatch = { clientId: 'b', events: [{ name: 'app_open', t: 2 }] };
    createTelemetryStore({ directory }).append(first, day);
    createTelemetryStore({ directory }).append(second, day);

    const raw = await readFile(createTelemetryStore({ directory }).filePathFor(day), 'utf8');
    expect(raw.trim().split('\n').length).toBe(2);
  });

  it('returns 0 and writes nothing for an empty batch', async () => {
    const directory = await tempDir();
    const store = createTelemetryStore({ directory });
    const day = new Date(Date.UTC(2026, 9, 31, 12));

    expect(store.append({ clientId: 'c', events: [] }, day)).toBe(0);
    expect(existsSync(store.filePathFor(day))).toBe(false);
  });
});
