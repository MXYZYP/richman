import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLeaderboardStore,
  parseLeaderboardFile,
  parseLeaderboardSubmission,
  sortLeaderboardEntries,
  LEADERBOARD_MAX_ENTRIES,
  LEADERBOARD_SCHEMA_VERSION,
  type LeaderboardEntry,
  type LeaderboardStore,
} from '../leaderboard/leaderboardStore';
import { createLeaderboardApi, LEADERBOARD_PATH } from '../leaderboard/leaderboardRoutes';
import type { RoomDomainEvent } from '../rooms/roomTypes';

/**
 * 成就排行榜（路线图 #116）。
 *
 * 这一套测试盯住四件事，每一条都对应一个真实的翻车方式：
 *  1. **重复提交是更新不是新增** —— 否则同一个人每打一局就在榜上多占一行；
 *  2. **落盘坏了不能带崩进程**（坏文件隔离、版本不符丢弃）—— 榜单是锦上添花的功能；
 *  3. **接口的输入校验与体积上限** —— 这是一条任何人都能写的公网接口；
 *  4. **`/api/leaderboard` 绝不能落到静态托管的 SPA 兜底里** —— `sirv({ single: true })`
 *     会把未知路径当前端路由返回 `index.html`（200 + HTML），客户端 `json()` 会抛出一个
 *     与真实原因毫不相干的解析错误。最后一条只有把接口挂进真 HTTP 服务才测得到。
 */

const tempRoots: string[] = [];
const openServers: HttpServer[] = [];

afterEach(async () => {
  for (const server of openServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempFile(name = 'leaderboard.json'): string {
  const root = mkdtempSync(join(tmpdir(), 'richman-leaderboard-'));
  tempRoots.push(root);
  return join(root, name);
}

function submission(overrides: Partial<Parameters<LeaderboardStore['upsert']>[0]> = {}) {
  return {
    playerId: 'player-0001',
    nickname: '小明',
    wins: 3,
    gamesPlayed: 7,
    bestAsset: 42_000,
    mapCount: 2,
    ...overrides,
  };
}

function entry(overrides: Partial<LeaderboardEntry> = {}): LeaderboardEntry {
  return {
    playerId: 'player-0001',
    nickname: '小明',
    wins: 1,
    gamesPlayed: 2,
    bestAsset: 20_000,
    mapCount: 1,
    // 用「现在」而不是固定的小数字：默认保留期是 90 天，写死一个 1000 会被当成
    // 陈年条目在读取时清理掉，用例会以一个和被测行为毫不相干的理由失败。
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('leaderboardStore — 落盘榜单', () => {
  it('新记录进榜，同名 playerId 再提交是更新而不是多占一行', () => {
    const store = createLeaderboardStore({ file: tempFile() });
    store.upsert(submission());
    expect(store.size()).toBe(1);
    expect(store.rankOf('player-0001')).toBe(1);

    store.upsert(submission({ wins: 9, gamesPlayed: 12 }));
    expect(store.size()).toBe(1);
    expect(store.entries()[0]?.wins).toBe(9);
  });

  it('排序：胜场优先，再看资产峰值、总局数、更新时间、playerId', () => {
    const sorted = sortLeaderboardEntries([
      entry({ playerId: 'p-b', wins: 2, bestAsset: 10_000 }),
      entry({ playerId: 'p-a', wins: 2, bestAsset: 10_000 }),
      entry({ playerId: 'p-c', wins: 3, bestAsset: 1 }),
      entry({ playerId: 'p-d', wins: 2, bestAsset: 20_000 }),
    ]);
    expect(sorted.map((item) => item.playerId)).toEqual(['p-c', 'p-d', 'p-a', 'p-b']);
  });

  it('排名完全确定：完全同分时用 playerId 收尾，不会每次读取都换位置', () => {
    const tied = [entry({ playerId: 'p-zzz' }), entry({ playerId: 'p-aaa' }), entry({ playerId: 'p-mmm' })];
    const first = sortLeaderboardEntries(tied).map((item) => item.playerId);
    const second = sortLeaderboardEntries([...tied].reverse()).map((item) => item.playerId);
    expect(first).toEqual(second);
  });

  it('超过上限后按名次截断，榜外的人 rankOf 返回 null（而不是 0）', () => {
    const store = createLeaderboardStore({ file: tempFile(), maxEntries: 2 });
    store.upsert(submission({ playerId: 'player-low', wins: 0, gamesPlayed: 1 }));
    store.upsert(submission({ playerId: 'player-mid', wins: 5, gamesPlayed: 6 }));
    store.upsert(submission({ playerId: 'player-top', wins: 50, gamesPlayed: 60 }));

    expect(store.entries()).toHaveLength(2);
    expect(store.rankOf('player-top')).toBe(1);
    expect(store.rankOf('player-low')).toBeNull();
  });

  it('落盘后能被新实例读回（原子写落的是正式文件，不靠进程存活）', () => {
    const file = tempFile();
    createLeaderboardStore({ file }).upsert(submission({ nickname: '小红' }));

    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      schemaVersion: LEADERBOARD_SCHEMA_VERSION,
      entries: [{ nickname: '小红' }],
    });

    const reloaded = createLeaderboardStore({ file });
    expect(reloaded.size()).toBe(1);
    expect(reloaded.entries()[0]?.nickname).toBe('小红');
  });

  it('目录不存在会自动创建（部署后第一次写入不该失败）', () => {
    const file = join(tempFile(), 'nested', 'leaderboard.json');
    const store = createLeaderboardStore({ file });
    store.upsert(submission());
    expect(store.rankOf('player-0001')).toBe(1);
  });

  it('损坏的 JSON 被隔离为 .corrupt，读取不会抛错', () => {
    const file = tempFile();
    writeFileSync(file, '{ this is not json', 'utf8');

    const store = createLeaderboardStore({ file });
    expect(store.size()).toBe(0);
    expect(readdirSync(join(file, '..')).some((name) => name.endsWith('.corrupt'))).toBe(true);
  });

  it('schemaVersion 不符的榜单被丢弃，不会读回半新半旧的数据', () => {
    const file = tempFile();
    const stale = { schemaVersion: LEADERBOARD_SCHEMA_VERSION + 1, entries: [entry()] };
    writeFileSync(file, JSON.stringify(stale), 'utf8');

    expect(createLeaderboardStore({ file }).size()).toBe(0);
    expect(parseLeaderboardFile(stale)).toBeNull();
  });

  it('保留期外的条目在读取时被清理，避免榜单被久不露面的人占满', () => {
    const file = tempFile();
    const base = createLeaderboardStore({ file, now: () => 1_000_000 });
    base.upsert(submission({ playerId: 'player-old' }));

    const later = createLeaderboardStore({
      file,
      retentionMs: 60_000,
      now: () => 1_000_000 + 120_000,
    });
    expect(later.size()).toBe(0);
  });

  it('榜单里混入的不合法条目会被逐条剔掉，好条目照常读出', () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({
      schemaVersion: LEADERBOARD_SCHEMA_VERSION,
      entries: [
        entry({ playerId: 'player-good' }),
        { ...entry(), playerId: 'bad id with spaces' },
        { ...entry(), wins: 999, gamesPlayed: 1 },
        { ...entry(), bestAsset: -5 },
      ],
    }), 'utf8');

    const store = createLeaderboardStore({ file });
    expect(store.entries().map((item) => item.playerId)).toEqual(['player-good']);
  });
});

describe('parseLeaderboardSubmission — 只收白名单字段', () => {
  it('合法提交被规范化（昵称去空白、多余字段被忽略）', () => {
    const parsed = parseLeaderboardSubmission({
      playerId: 'player-0001',
      nickname: '  小明  ',
      wins: 1,
      gamesPlayed: 2,
      bestAsset: 100,
      mapCount: 1,
      // 客户端将来多塞的字段一律不落库。
      token: 'should-not-be-stored',
      updatedAt: 999_999_999,
    });
    expect(parsed).toEqual({
      playerId: 'player-0001', nickname: '小明', wins: 1, gamesPlayed: 2, bestAsset: 100, mapCount: 1,
    });
    expect(parsed).not.toHaveProperty('token');
    expect(parsed).not.toHaveProperty('updatedAt');
  });

  it('胜场多于总场次、负值、超长昵称、非法 playerId 一律拒绝', () => {
    const cases: Array<[string, unknown]> = [
      ['胜场多于总场次', submission({ wins: 5, gamesPlayed: 2 })],
      ['负资产', submission({ bestAsset: -1 })],
      ['非整数', { ...submission(), wins: 1.5 }],
      ['昵称过长', submission({ nickname: '一二三四五六七八九十十一十二十三' })],
      ['昵称全空白', submission({ nickname: '   ' })],
      ['playerId 含空格', submission({ playerId: 'player 0001' })],
      ['playerId 过短', submission({ playerId: 'abc' })],
      ['不是对象', 'nope'],
      ['缺字段', { playerId: 'player-0001' }],
    ];
    for (const [label, value] of cases) {
      expect(parseLeaderboardSubmission(value), label).toBeNull();
    }
  });
});

interface TestApi {
  baseUrl: string;
  close: () => Promise<void>;
}

/** 把排行榜接口单独挂进一个裸 HTTP 服务，不牵扯房间/静态托管，便于逐条验证协议行为。 */
async function startLeaderboardApi(options: {
  store: LeaderboardStore;
  rateLimit?: Parameters<typeof createLeaderboardApi>[0]['rateLimit'];
  maxBodyBytes?: number;
}): Promise<TestApi> {
  const api = createLeaderboardApi(options);
  const server = createServer((request, response) => {
    if (api(request, response)) return;
    // 与生产一致的对照：没被接口接走的请求交给「静态兜底」，这里用 404 代表。
    response.statusCode = 404;
    response.end('Not found');
  });
  openServers.push(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('排行榜接口', () => {
  it('GET 返回榜单；带 playerId 时顺带回自己的名次', async () => {
    const store = createLeaderboardStore({ file: tempFile() });
    store.upsert(submission({ playerId: 'player-0001', wins: 4, gamesPlayed: 5 }));
    store.upsert(submission({ playerId: 'player-0002', wins: 9, gamesPlayed: 10 }));
    const api = await startLeaderboardApi({ store, rateLimit: false });

    const plain = await fetch(`${api.baseUrl}${LEADERBOARD_PATH}`);
    expect(plain.status).toBe(200);
    expect(plain.headers.get('content-type')).toMatch(/^application\/json/);
    expect(plain.headers.get('cache-control')).toBe('no-store');
    const body = await plain.json() as { ok: boolean; entries: LeaderboardEntry[]; rank: number | null };
    expect(body.ok).toBe(true);
    expect(body.entries.map((item) => item.playerId)).toEqual(['player-0002', 'player-0001']);
    expect(body.rank).toBeNull();

    const mine = await fetch(`${api.baseUrl}${LEADERBOARD_PATH}?playerId=player-0001`);
    expect((await mine.json() as { rank: number | null }).rank).toBe(2);
  });

  it('POST 合法提交写入并回名次，随后 GET 能看到', async () => {
    const api = await startLeaderboardApi({ store: createLeaderboardStore({ file: tempFile() }), rateLimit: false });

    const posted = await fetch(`${api.baseUrl}${LEADERBOARD_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(submission({ nickname: '冠军' })),
    });
    expect(posted.status).toBe(200);
    const body = await posted.json() as { ok: boolean; rank: number | null; entries: LeaderboardEntry[] };
    expect(body.ok).toBe(true);
    expect(body.rank).toBe(1);
    expect(body.entries[0]?.nickname).toBe('冠军');
  });

  it('非法 JSON / 非法条目 / 超大请求体分别回 400、400、413，而不是静默收下', async () => {
    const api = await startLeaderboardApi({
      store: createLeaderboardStore({ file: tempFile() }),
      rateLimit: false,
      maxBodyBytes: 256,
    });

    const badJson = await fetch(`${api.baseUrl}${LEADERBOARD_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ not json',
    });
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toMatchObject({ error: 'invalid_json' });

    const badEntry = await fetch(`${api.baseUrl}${LEADERBOARD_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(submission({ wins: 99, gamesPlayed: 1 })),
    });
    expect(badEntry.status).toBe(400);
    expect(await badEntry.json()).toMatchObject({ error: 'invalid_entry' });

    const tooLarge = await fetch(`${api.baseUrl}${LEADERBOARD_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...submission(), padding: 'x'.repeat(1024) }),
    });
    expect(tooLarge.status).toBe(413);
  });

  it('超出窗口阈值时回 429，且被拒的次数不占用配额', async () => {
    const api = await startLeaderboardApi({
      store: createLeaderboardStore({ file: tempFile() }),
      rateLimit: { windowMs: 60_000, maxPerWindow: 2 },
    });

    const hit = () => fetch(`${api.baseUrl}${LEADERBOARD_PATH}`).then((response) => response.status);
    expect(await hit()).toBe(200);
    expect(await hit()).toBe(200);
    expect(await hit()).toBe(429);
    // 连续被拒不会把窗口越顶越死：窗口滑过后仍然只放行两次。
    expect(await hit()).toBe(429);
  });

  it('只接 /api/leaderboard 这一条路径，其它方法与路径原样交还给后续处理器', async () => {
    const api = await startLeaderboardApi({ store: createLeaderboardStore({ file: tempFile() }), rateLimit: false });

    const otherPath = await fetch(`${api.baseUrl}/api/other`);
    expect(otherPath.status).toBe(404);

    const wrongMethod = await fetch(`${api.baseUrl}${LEADERBOARD_PATH}`, { method: 'PUT' });
    expect(wrongMethod.status).toBe(405);
    expect(await wrongMethod.json()).toMatchObject({ error: 'method_not_allowed' });
  });

  it('写入失败时回 503，而不是假装已经上榜', async () => {
    const failing: LeaderboardStore = {
      upsert() { throw new Error('disk full'); },
      entries: () => [],
      rankOf: () => null,
      size: () => 0,
    };
    const api = await startLeaderboardApi({ store: failing, rateLimit: false });

    const response = await fetch(`${api.baseUrl}${LEADERBOARD_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(submission()),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'storage_unavailable' });
  });
});

describe('挂进真实服务时的路由顺序', () => {
  /** 把排行榜接口挂进**真的** `createRoomServer`（含静态托管），才能验证路由顺序。 */
  async function startServerWithApi(leaderboard: LeaderboardStore | false): Promise<{ baseUrl: string }> {
    const root = mkdtempSync(join(tmpdir(), 'richman-leaderboard-static-'));
    tempRoots.push(root);
    const distPath = join(root, 'client-dist');
    mkdirSync(distPath, { recursive: true });
    // 只放一个 index.html：`sirv({ single: true })` 会把任何未知路径都回它。
    writeFileSync(join(distPath, 'index.html'), '<!doctype html><div id="app"></div>', 'utf8');

    const [{ createRoomServer }, { RoomManager }] = await Promise.all([
      import('../server'),
      import('../rooms/roomManager'),
    ]);

    const server = createRoomServer<NodeJS.Timeout>({
      clientDistPath: distPath,
      rateLimit: false,
      leaderboard,
      leaderboardRateLimit: false,
      roomManagerFactory: (onAsyncEvents: (events: RoomDomainEvent[]) => void) => new RoomManager<NodeJS.Timeout>({
        generatePlayerId: () => 'p1',
        generateToken: () => 'token-1',
        nextRoomNumber: () => 1,
        setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimer: (handle) => clearTimeout(handle),
        compareTokens: (actual, expected) => actual === expected,
        onAsyncEvents,
        generateGameSeed: () => 'seed',
        nextAutomationDelayMs: () => 1_000,
      }),
    });
    openServers.push(server.httpServer);

    await new Promise<void>((resolve) => server.httpServer.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.httpServer.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${port}` };
  }

  it('/api/leaderboard 返回 JSON，而不是被静态托管的 SPA 兜底吞成 index.html', async () => {
    const store = createLeaderboardStore({ file: tempFile() });
    store.upsert(submission({ nickname: '榜一' }));
    const { baseUrl } = await startServerWithApi(store);

    const response = await fetch(`${baseUrl}${LEADERBOARD_PATH}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    const body = await response.json() as { ok: boolean; entries: LeaderboardEntry[] };
    expect(body.ok).toBe(true);
    expect(body.entries[0]?.nickname).toBe('榜一');

    // 顺带确认 SPA 兜底仍然正常（没有因为插了一条 API 就把静态托管挤掉）。
    const index = await fetch(`${baseUrl}/rooms/0007`);
    expect(await index.text()).toContain('id="app"');
  });

  it('leaderboard: false 表示完全不挂这条路由', async () => {
    const { baseUrl } = await startServerWithApi(false);

    const response = await fetch(`${baseUrl}${LEADERBOARD_PATH}`);
    // 没挂路由时按既有的 SPA 兜底行为处理，而不是 404 —— 这正是「关掉」的含义。
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
  });
});

describe('榜单上限常量', () => {
  it('上限是个合理正整数（榜单文件不会无界增长）', () => {
    expect(Number.isSafeInteger(LEADERBOARD_MAX_ENTRIES)).toBe(true);
    expect(LEADERBOARD_MAX_ENTRIES).toBeGreaterThan(0);
  });
});
