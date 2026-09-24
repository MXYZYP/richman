import { describe, expect, it } from 'vitest';
import {
  buildLeaderboardSubmission,
  describeLeaderboardFailure,
  ensurePlayerId,
  loadLeaderboard,
  loadPlayerId,
  parseLeaderboardEntry,
  parseLeaderboardPayload,
  PLAYER_ID_KEY,
  publishLeaderboard,
  randomPlayerId,
  type LeaderboardEntry,
  type LeaderboardRequest,
} from './leaderboard';
import type { PlayerStats } from './playerStats';
import type { StorageLike } from './sessionStorage';

/**
 * 成就排行榜的客户端（路线图 #116）。
 *
 * 「成就」本身是纯本地的（`achievements.ts` 已单独测过），这里只测那件必须联网的事：
 * 身份怎么存、提交什么数字、服务端回来的东西怎么校验、失败怎么翻译成人话。
 * 网络用注入的假 `request` 走，因为 node 测试环境里没有真实网络。
 */

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

class ReadOnlyStorage implements StorageLike {
  getItem(): string | null { return null; }
  setItem(): void { throw new Error('quota exceeded'); }
  removeItem(): void { /* noop */ }
}

const EMPTY: PlayerStats = {
  schemaVersion: 1,
  gamesPlayed: 0,
  wins: 0,
  losses: 0,
  bestAsset: 0,
  favoriteMaps: {},
  lastPlayedAt: 0,
};

function stats(overrides: Partial<PlayerStats> = {}): PlayerStats {
  return { ...EMPTY, ...overrides };
}

function jsonResponse(status: number, payload: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload,
  } as unknown as Response;
}

/** 记录每次调用，并按脚本依次返回结果。 */
function recordingRequest(responses: Response[]): { request: LeaderboardRequest; calls: Array<{ url: string; init?: { method?: string; body?: string } }> } {
  const calls: Array<{ url: string; init?: { method?: string; body?: string } }> = [];
  const request: LeaderboardRequest = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next === undefined) throw new Error('unexpected extra request');
    return next;
  };
  return { request, calls };
}

const VALID_ENTRY: LeaderboardEntry = {
  playerId: 'aaaaaaaaaaaaaaaa',
  nickname: '小明',
  wins: 3,
  gamesPlayed: 7,
  bestAsset: 42_000,
  mapCount: 2,
  updatedAt: 1_700_000_000_000,
};

describe('本机玩家标识', () => {
  it('生成的标识符合服务端的格式要求，且可以完全确定（注入随机源）', () => {
    const id = randomPlayerId(() => 0.5);
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(id).toHaveLength(32);
    expect(id).toBe(randomPlayerId(() => 0.5));
  });

  it('第一次生成即落盘，之后每次都拿到同一个（重复提交不会变成榜上多一行）', () => {
    const storage = new MemoryStorage();
    const first = ensurePlayerId(storage);
    expect(first).not.toBeNull();
    expect(storage.getItem(PLAYER_ID_KEY)).toBe(first);
    expect(ensurePlayerId(storage)).toBe(first);
  });

  it('存储里的值被改坏时重新生成，而不是把坏值当身份用', () => {
    const storage = new MemoryStorage();
    storage.setItem(PLAYER_ID_KEY, 'short');
    expect(loadPlayerId(storage)).toBeNull();
    const repaired = ensurePlayerId(storage);
    expect(repaired).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('存储不可用时返回 null —— 宁可这次不上榜，也不要每次提交都换一个身份', () => {
    expect(ensurePlayerId(new ReadOnlyStorage())).toBeNull();
  });
});

describe('buildLeaderboardSubmission — 只上传四个聚合数字', () => {
  it('昵称为空时用兜底名，过长则截断到 12 字以内', () => {
    expect(buildLeaderboardSubmission(stats(), '   ', 'player-0001').nickname).toBe('大富翁玩家');
    expect(buildLeaderboardSubmission(stats(), '一二三四五六七八九十十一十二十三', 'player-0001').nickname)
      .toHaveLength(12);
    expect(buildLeaderboardSubmission(stats(), ' 小红 ', 'player-0001').nickname).toBe('小红');
  });

  it('地图数只数「至少完成过一局」的地图', () => {
    const submission = buildLeaderboardSubmission(
      stats({ favoriteMaps: { 'china-tour': 3, 'world-tour': 0, 'silk-road': 1 } }),
      '小明',
      'player-0001',
    );
    expect(submission.mapCount).toBe(2);
  });

  it('导入来的战绩若出现「胜场多于总场次」，会被抬平后再提交（否则服务端整次拒收）', () => {
    const submission = buildLeaderboardSubmission(
      stats({ wins: 9, gamesPlayed: 2 }),
      '小明',
      'player-0001',
    );
    expect(submission.gamesPlayed).toBe(9);
    expect(submission.wins).toBeLessThanOrEqual(submission.gamesPlayed);
  });

  it('负数、小数、超上限都先被收拾干净', () => {
    const submission = buildLeaderboardSubmission(
      stats({ wins: 1.7, gamesPlayed: -5, bestAsset: Number.MAX_SAFE_INTEGER }),
      '小明',
      'player-0001',
    );
    expect(submission.wins).toBe(1);
    expect(submission.gamesPlayed).toBe(1);
    expect(submission.bestAsset).toBe(10_000_000);
  });

  it('提交体里没有 token / 时间戳这类不该上传的东西', () => {
    const submission = buildLeaderboardSubmission(stats(), '小明', 'player-0001');
    expect(Object.keys(submission).sort()).toEqual(
      ['bestAsset', 'gamesPlayed', 'mapCount', 'nickname', 'playerId', 'wins'].sort(),
    );
  });
});

describe('服务端返回的数据一律先校验再渲染', () => {
  it('合法的一行通过校验', () => {
    expect(parseLeaderboardEntry(VALID_ENTRY)).toEqual(VALID_ENTRY);
  });

  it('胜场多于总场次、负数、超长昵称、非法 playerId 的单行被丢掉', () => {
    const bad = [
      { ...VALID_ENTRY, wins: 99, gamesPlayed: 1 },
      { ...VALID_ENTRY, bestAsset: -1 },
      { ...VALID_ENTRY, nickname: '一二三四五六七八九十十一十二十三' },
      { ...VALID_ENTRY, playerId: 'bad id' },
      { ...VALID_ENTRY, updatedAt: 'yesterday' },
      { ...VALID_ENTRY, mapCount: 1.5 },
      'not an object',
    ];
    for (const value of bad) expect(parseLeaderboardEntry(value), JSON.stringify(value)).toBeNull();
  });

  it('整个响应体：`ok` 不为 true 或 `entries` 不是数组都算取不到', () => {
    expect(parseLeaderboardPayload({ ok: false, entries: [] })).toBeNull();
    expect(parseLeaderboardPayload({ ok: true })).toBeNull();
    expect(parseLeaderboardPayload({ ok: true, entries: 'nope' })).toBeNull();
    expect(parseLeaderboardPayload(null)).toBeNull();
  });

  it('混合榜单里只保留合法行，名次缺失或非正数一律归为「没上榜」', () => {
    const parsed = parseLeaderboardPayload({
      ok: true,
      entries: [VALID_ENTRY, { ...VALID_ENTRY, wins: 99, gamesPlayed: 1 }],
      rank: 0,
    });
    expect(parsed?.entries.map((entry) => entry.playerId)).toEqual([VALID_ENTRY.playerId]);
    expect(parsed?.rank).toBeNull();
  });
});

describe('取榜单 / 提交榜单', () => {
  it('不带身份时只读榜单；带身份时把 playerId 拼进查询串并回自己的名次', async () => {
    const plain = recordingRequest([jsonResponse(200, { ok: true, entries: [VALID_ENTRY], rank: null })]);
    const first = await loadLeaderboard({ request: plain.request });
    expect(plain.calls[0]?.url).toBe('/api/leaderboard');
    expect(first).toMatchObject({ ok: true, rank: null });

    const mine = recordingRequest([jsonResponse(200, { ok: true, entries: [VALID_ENTRY], rank: 1 })]);
    const second = await loadLeaderboard({ request: mine.request, playerId: 'aaaaaaaaaaaaaaaa' });
    expect(mine.calls[0]?.url).toBe('/api/leaderboard?playerId=aaaaaaaaaaaaaaaa');
    expect(second).toMatchObject({ ok: true, rank: 1 });
  });

  it('提交走 POST，且 body 就是那份提交记录', async () => {
    const { request, calls } = recordingRequest([jsonResponse(200, { ok: true, entries: [VALID_ENTRY], rank: 1 })]);
    const submission = buildLeaderboardSubmission(stats({ wins: 3, gamesPlayed: 7 }), '小明', 'aaaaaaaaaaaaaaaa');
    const result = await publishLeaderboard(submission, { request });

    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init?.body ?? '{}')).toEqual(submission);
    expect(result).toMatchObject({ ok: true, rank: 1 });
  });

  it('各类失败分别映射成 network / rate_limited / server，不把半截数据当成功', async () => {
    const throttled = recordingRequest([jsonResponse(429, { ok: false, error: 'rate_limited' })]);
    expect(await loadLeaderboard({ request: throttled.request })).toEqual({ ok: false, reason: 'rate_limited' });

    const broken = recordingRequest([jsonResponse(500, { ok: false })]);
    expect(await loadLeaderboard({ request: broken.request })).toEqual({ ok: false, reason: 'server' });

    const html = { status: 200, ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } } as unknown as Response;
    const notJson = recordingRequest([html]);
    expect(await loadLeaderboard({ request: notJson.request })).toEqual({ ok: false, reason: 'server' });

    const throwing: LeaderboardRequest = async () => { throw new TypeError('fetch failed'); };
    expect(await loadLeaderboard({ request: throwing })).toEqual({ ok: false, reason: 'network' });
  });

  it('失败原因都有人话解释，界面不必自己拼文案', () => {
    for (const reason of ['network', 'rate_limited', 'storage', 'server'] as const) {
      const text = describeLeaderboardFailure(reason);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain('undefined');
    }
  });
});
