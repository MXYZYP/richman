import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  renderSummaryMarkdown,
  summarize,
  yesterdayKey,
  type TelemetryLine,
} from './ops-daily';

let tempRoot: string | undefined;

afterEach(async () => {
  if (tempRoot === undefined) return;
  const root = tempRoot;
  tempRoot = undefined;
  await rm(root, { recursive: true, force: true });
});

function line(id: string, name: string, props?: Record<string, unknown>): TelemetryLine {
  return props === undefined ? { id, name, t: 1 } : { id, name, t: 1, props };
}

describe('summarize', () => {
  it('counts active ids, opens, starts and ends', () => {
    const summary = summarize('2026-11-01', [
      line('a', 'app_open'),
      line('a', 'game_start', { mode: 'local', map: 'yuncheng', players: 4 }),
      line('a', 'game_end', { map: 'yuncheng', players: 4, turns: 30, seconds: 300, outcome: 'winner' }),
      line('b', 'app_open'),
    ], new Set());

    expect(summary.activeIds).toBe(2);
    expect(summary.opens).toBe(2);
    expect(summary.starts).toBe(1);
    expect(summary.startsLocal).toBe(1);
    expect(summary.startsOnline).toBe(0);
    expect(summary.ends).toBe(1);
  });

  it('separates local and online starts and ranks maps by popularity', () => {
    const summary = summarize('2026-11-01', [
      line('a', 'game_start', { mode: 'online', map: 'china-tour' }),
      line('b', 'game_start', { mode: 'local', map: 'yuncheng' }),
      line('c', 'game_start', { mode: 'local', map: 'yuncheng' }),
    ], new Set());

    expect(summary.startsLocal).toBe(2);
    expect(summary.startsOnline).toBe(1);
    expect(summary.startsByMap).toEqual([['yuncheng', 2], ['china-tour', 1]]);
  });

  it('reports completion rate as null when nobody started a game (not 0)', () => {
    const summary = summarize('2026-11-01', [line('a', 'app_open')], new Set());

    // 0 会被读成「开了局但一局都没打完」，那是完全不同的结论。
    expect(summary.completionRate).toBeNull();
    expect(summary.starts).toBe(0);
  });

  it('averages only the games that actually reported a duration', () => {
    const summary = summarize('2026-11-01', [
      line('a', 'game_end', { seconds: 100 }),
      line('a', 'game_end', { seconds: 200 }),
      line('a', 'game_end', { map: 'x' }),
    ], new Set());

    expect(summary.ends).toBe(3);
    expect(summary.averageSeconds).toBe(150);
  });

  it('splits errors by source', () => {
    const summary = summarize('2026-11-01', [
      line('a', 'app_error', { source: 'vue', message: 'x' }),
      line('a', 'app_error', { source: 'promise', message: 'y' }),
      line('a', 'app_error', { source: 'vue', message: 'z' }),
    ], new Set());

    expect(summary.errors).toBe(3);
    expect(summary.errorsBySource).toEqual({ vue: 2, promise: 1 });
  });

  it('treats an id seen in the previous window as returning, not new', () => {
    const lines = [line('a', 'app_open'), line('b', 'app_open')];
    expect(summarize('2026-11-01', lines, new Set(['a'])).newIds).toBe(1);
    expect(summarize('2026-11-01', lines, new Set()).newIds).toBe(2);
  });

  it('ignores unknown event names instead of failing', () => {
    const summary = summarize('2026-11-01', [line('a', 'something_else'), line('a', 'app_open')], new Set());
    expect(summary.opens).toBe(1);
  });
});

describe('renderSummaryMarkdown', () => {
  it('renders a readable report with the numbers in it', () => {
    const markdown = renderSummaryMarkdown(summarize('2026-11-01', [
      line('a', 'app_open'),
      line('a', 'game_start', { mode: 'local', map: 'yuncheng' }),
      line('a', 'game_end', { seconds: 492 }),
      line('a', 'app_error', { source: 'vue' }),
    ], new Set()));

    expect(markdown).toContain('运营日报 2026-11-01');
    expect(markdown).toContain('活跃玩家');
    expect(markdown).toContain('完成率：100%');
    expect(markdown).toContain('8 分 12 秒');
    expect(markdown).toContain('yuncheng');
    // 口径必须写进文件：不然三周后没人记得「完成率」是怎么算的。
    expect(markdown).toContain('口径');
  });

  it('says "no games" instead of printing a misleading 0% completion', () => {
    const markdown = renderSummaryMarkdown(summarize('2026-11-01', [line('a', 'app_open')], new Set()));

    expect(markdown).toContain('没有开局');
    expect(markdown).not.toContain('完成率：0%');
  });
});

describe('yesterdayKey', () => {
  it('is the calendar day before the given moment', () => {
    expect(yesterdayKey(new Date(2026, 10, 1, 4, 17))).toBe('2026-10-31');
    // 跨月也要对：脚本在每月 1 号凌晨跑，读的必须是上个月最后一天。
    expect(yesterdayKey(new Date(2026, 10, 1, 0, 5))).toBe('2026-10-31');
  });
});

describe('main', () => {
  it('writes the report next to the telemetry files', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'richman-ops-'));
    const dir = join(tempRoot, 'runtime');
    await writeFile(join(tempRoot, '.keep'), '');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'telemetry-2026-10-31.ndjson'),
      `${JSON.stringify(line('a', 'app_open'))}\n${JSON.stringify(line('a', 'game_start', { mode: 'local', map: 'yuncheng' }))}\n`,
      'utf8',
    );

    const { main } = await import('./ops-daily');
    await main(['--date', '2026-10-31', '--dir', dir]);

    const report = await readFile(join(dir, 'ops-daily-2026-10-31.md'), 'utf8');
    expect(report).toContain('运营日报 2026-10-31');
    expect(report).toContain('开局：1');
  });
});
