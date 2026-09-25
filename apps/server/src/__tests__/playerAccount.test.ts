import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  accumulateStats,
  createPlayerAccountStore,
  createRecoveryCode,
  emptyStatsPayload,
  formatRecoveryCode,
  hashRecoveryCode,
  normalizeRecoveryCode,
  parsePlayerAccountFile,
  parseStatsPayload,
  PLAYER_ACCOUNT_SCHEMA_VERSION,
  RECOVERY_CODE_PREFIX,
  type PlayerAccountStore,
  type RandomBytes,
  type StatsPayload,
} from '../player/playerAccountStore';
import {
  createPlayerAccountApi,
  PLAYER_RESTORE_PATH,
  PLAYER_ROTATE_PATH,
  PLAYER_SYNC_PATH,
} from '../player/playerAccountRoutes';
import type { RoomDomainEvent } from '../rooms/roomTypes';

/**
 * 战绩上云（路线图 #123，第五批-3）。
 *
 * 这一套测试盯住四件事，每一条都对应一个真实的翻车方式：
 *  1. **恢复码要抄得下来、抄错要当场发现** —— 玩家会从一台设备的屏幕上抄到另一台设备，
 *     校验位是这段流程唯一的质量保证（服务端拿到错码只会回 401，玩家不知道自己错在哪）。
 *  2. **明文恢复码绝不落盘** —— 服务端只留 sha256；否则读到那个文件就等于拿到所有人的账号。
 *  3. **累加语义与幂等** —— 计数器相加、峰值取 max。峰值若也相加，「这台设备又点了一次同步」
 *     就会让资产峰值凭空翻倍。
 *  4. **接口校验与体积上限** —— `sync` 不带码就是一条任何人都能调用的建号接口。
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

function tempFile(name = 'player-accounts.json'): string {
  const root = mkdtempSync(join(tmpdir(), 'richman-player-'));
  tempRoots.push(root);
  return join(root, name);
}

/**
 * 可复现的「随机源」：每次调用把第一个字节设成调用序号，其余留 0。
 * 于是同一个测试里的账号 id 与恢复码都确定，但仍**互不相同** —— 用全零常量会让第二次建号
 * 撞上同一个 id，`mintIdentity` 的重试会穷尽并抛错（那是它该有的行为，不该被测试触发）。
 */
function sequentialRandom(): RandomBytes {
  let calls = 0;
  return (size: number) => {
    calls += 1;
    const bytes = new Uint8Array(size);
    bytes[0] = calls & 0xff;
    return bytes;
  };
}

function stats(overrides: Partial<StatsPayload> = {}): StatsPayload {
  return {
    schemaVersion: 1,
    gamesPlayed: 4,
    wins: 2,
    losses: 2,
    bestAsset: 12_000,
    favoriteMaps: { 'china-tour': 4 },
    lastPlayedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function storeWith(randomBytes?: RandomBytes): PlayerAccountStore {
  return createPlayerAccountStore({ file: tempFile(), randomBytes });
}

describe('恢复码 — 手抄容错与校验位', () => {
  it('生成的码是 20 位、只含字母表字符，且能被规范化回自身', () => {
    const code = createRecoveryCode(sequentialRandom());
    expect(code).toHaveLength(20);
    expect(normalizeRecoveryCode(code)).toBe(code);
  });

  it('小写、带 RM- 前缀、夹着空格与换行都能规范化回同一个码', () => {
    const code = createRecoveryCode(sequentialRandom());
    const shown = formatRecoveryCode(code);
    expect(shown.startsWith(`${RECOVERY_CODE_PREFIX}-`)).toBe(true);
    expect(normalizeRecoveryCode(shown)).toBe(code);
    expect(normalizeRecoveryCode(shown.toLowerCase())).toBe(code);
    expect(normalizeRecoveryCode(`  ${shown.slice(0, 6)}\n${shown.slice(6)}  `)).toBe(code);
  });

  it('校验位不对（抄错最后一位）直接判非法，不必等服务器回 401', () => {
    const code = createRecoveryCode(sequentialRandom());
    const tampered = code.slice(0, 19) + (code.charAt(19) === '0' ? '1' : '0');
    expect(normalizeRecoveryCode(tampered)).toBeNull();
  });

  it('少抄/多抄一位、混进字母表以外的字符，都判非法', () => {
    const code = createRecoveryCode(sequentialRandom());
    expect(normalizeRecoveryCode(code.slice(0, 19))).toBeNull();
    expect(normalizeRecoveryCode(`${code}Z`)).toBeNull();
    expect(normalizeRecoveryCode('')).toBeNull();
    expect(normalizeRecoveryCode(42)).toBeNull();
  });

  it('数据位抄错一位基本必被校验位抓住（字母表里能通过替换的至多 2 个）', () => {
    const code = createRecoveryCode(sequentialRandom());
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const stillValid = [...alphabet].filter((symbol) => normalizeRecoveryCode(symbol + code.slice(1)) !== null);
    // 1 个是原字符本身，其余至多 1 个（32 分之一）——留一点余地，不把断言写成伪随机。
    expect(stillValid).toContain(code.charAt(0));
    expect(stillValid.length).toBeLessThanOrEqual(2);
  });
});

describe('playerAccountStore — 账号与落盘', () => {
  it('建号后能用恢复码取回；形状正确但不存在的码返回 null', () => {
    const store = storeWith(sequentialRandom());
    const { account, recoveryCode } = store.create('小明', stats());

    expect(account.nickname).toBe('小明');
    const found = store.authenticate(recoveryCode);
    expect(found?.accountId).toBe(account.accountId);
    expect(found?.stats.gamesPlayed).toBe(4);

    expect(store.authenticate(createRecoveryCode(sequentialRandom()))).toBeNull();
    expect(store.authenticate('不是码')).toBeNull();
  });

  it('落盘文件里只有恢复码的哈希，没有任何明文', () => {
    const file = tempFile();
    const store = createPlayerAccountStore({ file, randomBytes: sequentialRandom() });
    const { recoveryCode } = store.create('小明', stats());

    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(recoveryCode);
    expect(raw).not.toContain(formatRecoveryCode(recoveryCode));
    expect(raw).toContain(hashRecoveryCode(recoveryCode));
    // 也不该把昵称之外的东西写进去 —— 账号里没有 token、没有 IP。
    expect(raw).not.toContain('token');
  });

  it('累加：计数器相加、峰值与时间取 max，且重复提交同一份增量是幂等的', () => {
    const store = storeWith(sequentialRandom());
    const { account, recoveryCode } = store.create('小明', stats());

    const first = store.accumulate(
      account.accountId,
      stats({ gamesPlayed: 1, wins: 1, losses: 0, bestAsset: 30_000, favoriteMaps: { 'china-tour': 1 } }),
    );
    expect(first?.stats.gamesPlayed).toBe(5);
    expect(first?.stats.wins).toBe(3);
    expect(first?.stats.bestAsset).toBe(30_000);
    expect(first?.stats.favoriteMaps['china-tour']).toBe(5);

    // 再送一次同样的增量：计数器理应继续相加（这是调用方的意图），
    // 但**峰值不能翻倍** —— 它取 max，所以第二次仍然是 30_000。
    const second = store.accumulate(account.accountId, stats({ gamesPlayed: 0, wins: 0, losses: 0, bestAsset: 30_000 }));
    expect(second?.stats.bestAsset).toBe(30_000);
    expect(store.authenticate(recoveryCode)?.stats.bestAsset).toBe(30_000);
  });

  it('换码后新码可用、旧码立即失效', () => {
    const store = storeWith(sequentialRandom());
    const { account, recoveryCode: old } = store.create('小明', stats());

    const rotated = store.rotate(account.accountId);
    expect(rotated).not.toBeNull();
    const fresh = rotated?.recoveryCode ?? '';
    expect(fresh).not.toBe(old);
    expect(store.authenticate(fresh)?.accountId).toBe(account.accountId);
    expect(store.authenticate(old)).toBeNull();
  });

  it('重启（重新读同一份文件）后账号与哈希校验都还在', () => {
    const file = tempFile();
    const first = createPlayerAccountStore({ file, randomBytes: sequentialRandom() });
    const { account, recoveryCode } = first.create('小明', stats({ wins: 3, gamesPlayed: 5 }));

    const second = createPlayerAccountStore({ file });
    const restored = second.authenticate(recoveryCode);
    expect(restored?.accountId).toBe(account.accountId);
    expect(restored?.nickname).toBe('小明');
    expect(restored?.stats.wins).toBe(3);
  });

  it('账号不存在时 accumulate / rotate 返回 null，而不是伪造一份空账号', () => {
    const store = storeWith(sequentialRandom());
    expect(store.accumulate('ffffffffffffffff', stats())).toBeNull();
    expect(store.rotate('ffffffffffffffff')).toBeNull();
  });

  it('超过保留期的账号在读取时被清理', () => {
    let clock = 1_000_000;
    const file = tempFile();
    const store = createPlayerAccountStore({ file, now: () => clock, retentionMs: 60_000, randomBytes: sequentialRandom() });
    const { recoveryCode } = store.create('小明', stats());

    clock += 120_000;
    const reopened = createPlayerAccountStore({ file, now: () => clock, retentionMs: 60_000 });
    expect(reopened.size()).toBe(0);
    expect(reopened.authenticate(recoveryCode)).toBeNull();
  });

  it('坏 JSON 被改名隔离，服务端照常启动（空账号表）', () => {
    const file = tempFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ 这不是 json', 'utf8');

    const store = createPlayerAccountStore({ file });
    expect(store.size()).toBe(0);
    expect(readdirSync(dirname(file)).some((name) => name.endsWith('.corrupt'))).toBe(true);
  });

  it('schemaVersion 不匹配整份丢弃，不会带进半新半旧的状态', () => {
    const file = tempFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ schemaVersion: 99, accounts: [] }), 'utf8');

    expect(createPlayerAccountStore({ file }).size()).toBe(0);
  });

  it('单条记录坏掉只丢那一条，整份文件仍然可用', () => {
    const file = tempFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      schemaVersion: PLAYER_ACCOUNT_SCHEMA_VERSION,
      accounts: [{ accountId: 'not-an-id', nickname: '坏', codeHash: 'x', stats: {}, createdAt: 1, updatedAt: 1 }],
    }), 'utf8');

    const store = createPlayerAccountStore({ file });
    expect(store.size()).toBe(0);
    // 结构合法的文件不该被当成损坏文件丢掉（那会让「一条坏记录」升级成「全表清空」）。
    expect(readdirSync(dirname(file)).some((name) => name.endsWith('.corrupt'))).toBe(false);
  });
});

describe('parseStatsPayload — 公网写接口的输入校验', () => {
  it('接受一份正常战绩，并丢掉白名单以外的字段', () => {
    const parsed = parseStatsPayload({ ...stats(), 注入的字段: 'x' });
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed ?? {})).not.toContain('注入的字段');
  });

  it('拒收结构不符、版本不符与自相矛盾的战绩', () => {
    expect(parseStatsPayload(null)).toBeNull();
    expect(parseStatsPayload({ ...stats(), schemaVersion: 2 })).toBeNull();
    expect(parseStatsPayload({ ...stats(), wins: 99 })).toBeNull();
    expect(parseStatsPayload({ ...stats(), losses: 99 })).toBeNull();
    expect(parseStatsPayload({ ...stats(), gamesPlayed: -1 })).toBeNull();
    expect(parseStatsPayload({ ...stats(), bestAsset: 1.5 })).toBeNull();
    expect(parseStatsPayload({ ...stats(), bestAsset: 10_000_001 })).toBeNull();
    expect(parseStatsPayload({ ...stats(), lastPlayedAt: -1 })).toBeNull();
    expect(parseStatsPayload({ ...stats(), lastPlayedAt: 9_999_999_999_999 })).toBeNull();
    expect(parseStatsPayload({ ...stats(), favoriteMaps: { 'china-tour': 0 } })).toBeNull();
    expect(parseStatsPayload({ ...stats(), favoriteMaps: { 'china-tour': -3 } })).toBeNull();
    expect(parseStatsPayload({ ...stats(), favoriteMaps: [] })).toBeNull();
  });

  it('地图数量超过上限会被拒收（挡住「塞一万个键撑爆文件」）', () => {
    const many = Object.fromEntries(Array.from({ length: 65 }, (_v, index) => [`map-${index}`, 1]));
    expect(parseStatsPayload({ ...stats(), favoriteMaps: many })).toBeNull();
  });

  it('文件解析同样严格：版本不符整份作废', () => {
    expect(parsePlayerAccountFile({ schemaVersion: 99, accounts: [] })).toBeNull();
    expect(parsePlayerAccountFile({ schemaVersion: PLAYER_ACCOUNT_SCHEMA_VERSION })).toBeNull();
  });
});

describe('accumulateStats — 纯函数语义', () => {
  it('wins / losses 被夹到不超过 gamesPlayed，云端不会存下自相矛盾的数据', () => {
    const merged = accumulateStats(
      { ...emptyStatsPayload(), gamesPlayed: 1, wins: 1, losses: 0 },
      { ...emptyStatsPayload(), gamesPlayed: 0, wins: 5, losses: 5 },
    );
    // 夹紧的是「各自的上下界」，而不是「两者之和」。刻意不强制 `wins + losses <= gamesPlayed`：
    // 客户端自己的 `parseStats` 也不检查这一条（导入的战绩码不保证它成立），
    // 服务端若比客户端严格，就会把一份客户端认为完全正常的数据以 400 驳回 —— 那种错很难查。
    expect(merged.gamesPlayed).toBe(1);
    expect(merged.wins).toBe(1);
    expect(merged.losses).toBe(1);
  });

  it('空基线 + 增量 = 增量（除峰值取 max 外）', () => {
    const merged = accumulateStats(emptyStatsPayload(), stats());
    expect(merged.gamesPlayed).toBe(4);
    expect(merged.bestAsset).toBe(12_000);
    expect(merged.favoriteMaps['china-tour']).toBe(4);
  });
});

// ───────────────────── HTTP 接口 ─────────────────────

interface ApiOptions {
  rateLimit?: false | { windowMs: number; maxPerWindow: number };
  maxBodyBytes?: number;
}

async function startApi(store: PlayerAccountStore, options: ApiOptions = {}): Promise<string> {
  const api = createPlayerAccountApi({
    store,
    rateLimit: options.rateLimit ?? false,
    maxBodyBytes: options.maxBodyBytes,
  });
  const server = createServer((request, response) => {
    if (api(request, response)) return;
    response.statusCode = 404;
    response.end('not-api');
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function post(baseUrl: string, path: string, body: unknown, init: { raw?: string } = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: init.raw ?? JSON.stringify(body),
  });
}

describe('POST /api/player — 建号、同步、恢复、换码', () => {
  it('不带 code 建号，响应里给出一次明文恢复码；带 code 再同步则是累加', async () => {
    const store = storeWith(sequentialRandom());
    const baseUrl = await startApi(store);

    const created = await post(baseUrl, PLAYER_SYNC_PATH, { nickname: '小明', stats: stats() });
    expect(created.status).toBe(200);
    const createdBody = await created.json() as { ok: boolean; created: boolean; recoveryCode: string; accountId: string; stats: StatsPayload };
    expect(createdBody.ok).toBe(true);
    expect(createdBody.created).toBe(true);
    expect(normalizeRecoveryCode(createdBody.recoveryCode)).not.toBeNull();

    const synced = await post(baseUrl, PLAYER_SYNC_PATH, {
      nickname: '小明',
      code: createdBody.recoveryCode,
      stats: stats({ gamesPlayed: 1, wins: 1, losses: 0, bestAsset: 20_000 }),
    });
    expect(synced.status).toBe(200);
    const syncedBody = await synced.json() as { created: boolean; stats: StatsPayload; recoveryCode?: string };
    expect(syncedBody.created).toBe(false);
    expect(syncedBody.stats.gamesPlayed).toBe(5);
    // 平时同步**不回**明文码 —— 少一处泄露面，客户端本来就已经有它了。
    expect(syncedBody.recoveryCode).toBeUndefined();
  });

  it('restore 是只读的：取回战绩但不改动 updatedAt（试一下恢复码对不对不算「同步过」）', async () => {
    const store = storeWith(sequentialRandom());
    const baseUrl = await startApi(store);
    const created = await post(baseUrl, PLAYER_SYNC_PATH, { nickname: '小明', stats: stats() });
    const { recoveryCode, accountId, updatedAt } = await created.json() as {
      recoveryCode: string; accountId: string; updatedAt: number;
    };

    const restored = await post(baseUrl, PLAYER_RESTORE_PATH, { code: formatRecoveryCode(recoveryCode) });
    expect(restored.status).toBe(200);
    const body = await restored.json() as { accountId: string; nickname: string; stats: StatsPayload; updatedAt: number };
    expect(body.accountId).toBe(accountId);
    expect(body.nickname).toBe('小明');
    expect(body.stats.gamesPlayed).toBe(4);
    expect(body.updatedAt).toBe(updatedAt);
  });

  it('换码接口回一段新码，旧码随即失效', async () => {
    const store = storeWith(sequentialRandom());
    const baseUrl = await startApi(store);
    const created = await post(baseUrl, PLAYER_SYNC_PATH, { nickname: '小明', stats: stats() });
    const { recoveryCode: old } = await created.json() as { recoveryCode: string };

    const rotated = await post(baseUrl, PLAYER_ROTATE_PATH, { code: old });
    expect(rotated.status).toBe(200);
    const { recoveryCode: fresh } = await rotated.json() as { recoveryCode: string };
    expect(fresh).not.toBe(old);

    expect((await post(baseUrl, PLAYER_RESTORE_PATH, { code: old })).status).toBe(401);
    expect((await post(baseUrl, PLAYER_RESTORE_PATH, { code: fresh })).status).toBe(200);
  });

  it('错码 / 缺字段 / 畸形 JSON 分别回 401 与 400，且都不写盘', async () => {
    const store = storeWith(sequentialRandom());
    const baseUrl = await startApi(store);

    expect((await post(baseUrl, PLAYER_RESTORE_PATH, { code: 'RM-AAAA-AAAA-AAAA-AAAA-AAAA' })).status).toBe(401);
    expect((await post(baseUrl, PLAYER_SYNC_PATH, { nickname: '', stats: stats() })).status).toBe(400);
    expect((await post(baseUrl, PLAYER_SYNC_PATH, { nickname: '小明', stats: { schemaVersion: 1 } })).status).toBe(400);
    expect((await post(baseUrl, PLAYER_SYNC_PATH, { nickname: '小明' })).status).toBe(400);
    expect((await post(baseUrl, PLAYER_SYNC_PATH, 'nope', { raw: '{ 坏 json' })).status).toBe(400);
    expect((await post(baseUrl, PLAYER_SYNC_PATH, [1, 2, 3])).status).toBe(400);

    expect(store.size()).toBe(0);
  });

  it('GET 回 405 而不是去读请求体；未知路径交给后续处理器', async () => {
    const baseUrl = await startApi(storeWith(sequentialRandom()));
    expect((await fetch(`${baseUrl}${PLAYER_SYNC_PATH}`)).status).toBe(405);
    expect((await fetch(`${baseUrl}/api/player/unknown`)).status).toBe(404);
  });

  it('超过请求体上限回 413', async () => {
    const baseUrl = await startApi(storeWith(sequentialRandom()), { maxBodyBytes: 256 });
    const huge = JSON.stringify({ nickname: '小明', stats: { ...stats(), 填充: 'x'.repeat(2000) } });
    const response = await post(baseUrl, PLAYER_SYNC_PATH, null, { raw: huge });
    expect(response.status).toBe(413);
  });

  it('限流按窗口生效（这是一条任何人都能调的建号接口）', async () => {
    const baseUrl = await startApi(storeWith(sequentialRandom()), {
      rateLimit: { windowMs: 60_000, maxPerWindow: 2 },
    });
    expect((await post(baseUrl, PLAYER_SYNC_PATH, { nickname: '小明', stats: stats() })).status).toBe(200);
    expect((await post(baseUrl, PLAYER_SYNC_PATH, { nickname: '小红', stats: stats() })).status).toBe(200);
    expect((await post(baseUrl, PLAYER_SYNC_PATH, { nickname: '小刚', stats: stats() })).status).toBe(429);
  });
});

describe('/api/player 必须排在静态托管之前', () => {
  it('挂进真的 createRoomServer 后返回 JSON，而不是被 SPA 兜底吞成 index.html', async () => {
    const root = mkdtempSync(join(tmpdir(), 'richman-player-static-'));
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
      leaderboard: false,
      playerAccounts: createPlayerAccountStore({ file: tempFile(), randomBytes: sequentialRandom() }),
      playerRateLimit: false,
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
    const baseUrl = `http://127.0.0.1:${port}`;

    const created = await post(baseUrl, PLAYER_SYNC_PATH, { nickname: '小明', stats: stats() });
    expect(created.status).toBe(200);
    expect(created.headers.get('content-type')).toMatch(/^application\/json/);
    const body = await created.json() as { ok: boolean; created: boolean };
    expect(body.ok).toBe(true);
    expect(body.created).toBe(true);

    // 顺带确认 SPA 兜底仍然正常（没有因为插了一条 API 就把静态托管挤掉）。
    const index = await fetch(`${baseUrl}/rooms/0007`);
    expect(await index.text()).toContain('id="app"');
  });
});
