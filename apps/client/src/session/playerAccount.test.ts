import { describe, expect, it } from 'vitest';
import {
  emptyPlayerStats,
  mergePlayerStats,
  subtractPlayerStats,
  type PlayerStats,
} from './playerStats';
import {
  applyCloudToLocal,
  buildSyncDelta,
  clearCloudLink,
  CLOUD_ACCOUNT_KEY,
  describeCloudFailure,
  formatRecoveryCode,
  linkAfterRotate,
  linkAfterSync,
  loadCloudLink,
  normalizeRecoveryCode,
  parseCloudStats,
  planCloudRestore,
  restoreFromCloud,
  rotateRecoveryCode,
  sanitizeCloudNickname,
  saveCloudLink,
  syncToCloud,
  type CloudAccountLink,
  type CloudRequest,
} from './playerAccount';
import type { StorageLike } from './sessionStorage';

/**
 * 战绩上云（路线图 #123，第五批-3）——客户端侧。
 *
 * 这一套测试的重心是**算错就会悄悄丢数据**的那几处：
 *  1. **增量模型**：客户端送的是「相对基线的差值」。算错的方向有两种 —— 送全量（每同步一次
 *     局数翻倍）和送 0（新打的几局永远上不了云）。两条都在这套里盯着。
 *  2. **恢复只吸收云端盈余**：把云端整份并进本机，会把「本机已经上传过的部分」再加一遍。
 *  3. **恢复码的本地镜像与服务端一致**：不一致的后果是「明明没错却被本地拦下」。
 */

const ACCOUNT_ID = 'a1b2c3d4e5f60718';
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * 造一段**校验位正确**的恢复码。
 *
 * 刻意用穷举字母表的方式找校验位，而不是在测试里再抄一遍校验算法：抄一遍就等于把
 * 「客户端与服务端是否一致」这件事变成「测试和客户端是否一致」，那正是需要被验的东西。
 * 32 个候选里必有且仅有一个成立，因此这是确定的、不是碰运气。
 */
function validCode(data = '0011223344556677889'): string {
  for (const symbol of ALPHABET) {
    const candidate = data + symbol;
    if (normalizeRecoveryCode(candidate) !== null) return candidate;
  }
  throw new Error('没有任何校验位能配上 —— 字母表或位数与实现不一致');
}

function memoryStorage(): StorageLike & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

function stats(overrides: Partial<PlayerStats> = {}): PlayerStats {
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

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response;
}

type RequestHandler = (url: string, body: Record<string, unknown>) => Response;

function makeRequest(handler: RequestHandler): { request: CloudRequest; calls: Array<{ url: string; body: Record<string, unknown> }> } {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const request: CloudRequest = async (url, init) => {
    const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
    calls.push({ url, body });
    return handler(url, body);
  };
  return { request, calls };
}

/**
 * 一个「像服务端那样累加」的假云端。
 *
 * 这里复用 `mergePlayerStats`，它和服务端 `accumulateStats` 是同一套语义
 * （计数器相加、`bestAsset` / `lastPlayedAt` 取 max）。用它模拟是刻意的：
 * 真正要验的是**客户端送出去的增量对不对**，而不是再验一遍服务端。
 */
function fakeCloud(initial: PlayerStats = emptyPlayerStats()) {
  let cloud = initial;
  return {
    get current() { return cloud; },
    handler: (url: string, body: Record<string, unknown>): Response => {
      if (url.endsWith('/sync')) {
        const delta = body.stats as PlayerStats;
        const created = body.code === undefined;
        if (created) cloud = delta;
        else cloud = mergePlayerStats(cloud, delta);
        return jsonResponse(200, {
          ok: true,
          created,
          accountId: ACCOUNT_ID,
          nickname: body.nickname,
          // 建号时才回明文码 —— 与真实接口一致，好让 `linkAfterSync` 的两条分支都被走到。
          ...(created ? { recoveryCode: formatRecoveryCode(validCode()) } : {}),
          stats: cloud,
          updatedAt: 1_700_000_000_000,
        });
      }
      return jsonResponse(200, {
        ok: true,
        accountId: ACCOUNT_ID,
        nickname: '小明',
        stats: cloud,
        updatedAt: 1_700_000_000_000,
      });
    },
  };
}

describe('恢复码 — 客户端镜像', () => {
  it('分组显示与规范化往返一致（玩家抄的就是它显示的样子）', () => {
    const code = validCode();
    const shown = formatRecoveryCode(code);
    expect(shown).toBe('RM-0011-2233-4455-6677-889' + code.charAt(19));
    expect(normalizeRecoveryCode(shown)).toBe(code);
  });

  it('小写、空格、换行都能规范化；抄错一位被当场拒绝', () => {
    const code = validCode();
    expect(normalizeRecoveryCode(` ${formatRecoveryCode(code).toLowerCase()} `)).toBe(code);
    expect(normalizeRecoveryCode(code.slice(0, 19))).toBeNull();
    expect(normalizeRecoveryCode('RM-!!!!-!!!!-!!!!-!!!!-!!!!')).toBeNull();
  });

  it('昵称清理：空白走兜底名，超长截断到 12 个字', () => {
    expect(sanitizeCloudNickname('   ')).toBe('大富翁玩家');
    expect(sanitizeCloudNickname(' 小明 ')).toBe('小明');
    expect(sanitizeCloudNickname('一二三四五六七八九十一二三')).toHaveLength(12);
  });
});

describe('subtractPlayerStats / buildSyncDelta — 增量', () => {
  it('计数器取差值，峰值与时间原样带上（它们在云端取 max，做成差值反而会算错）', () => {
    const delta = subtractPlayerStats(
      stats({ gamesPlayed: 6, wins: 4, losses: 2, bestAsset: 20_000, favoriteMaps: { 'china-tour': 6, 'x': 2 } }),
      stats({ gamesPlayed: 4, wins: 2, losses: 2, bestAsset: 12_000, favoriteMaps: { 'china-tour': 4 } }),
    );
    expect(delta.gamesPlayed).toBe(2);
    expect(delta.wins).toBe(2);
    expect(delta.losses).toBe(0);
    expect(delta.bestAsset).toBe(20_000);
    expect(delta.lastPlayedAt).toBe(1_700_000_000_000);
    expect(delta.favoriteMaps).toEqual({ 'china-tour': 2, 'x': 2 });
  });

  it('基线比当前还大（清过缓存又导入旧战绩码）时钳到 0，而不是送负数冲掉云端', () => {
    const delta = subtractPlayerStats(
      stats({ gamesPlayed: 1, wins: 0, losses: 1, bestAsset: 100, favoriteMaps: { 'china-tour': 1 } }),
      stats({ gamesPlayed: 9, wins: 5, losses: 4, bestAsset: 9_999, favoriteMaps: { 'china-tour': 8 } }),
    );
    expect(delta.gamesPlayed).toBe(0);
    expect(delta.wins).toBe(0);
    expect(delta.losses).toBe(0);
    expect(delta.favoriteMaps).toEqual({});
  });

  it('buildSyncDelta 把 gamesPlayed 抬到不小于胜负，避免被服务端以「不自洽」驳回', () => {
    // 本机是 2 局 3 胜（从旧战绩码导入来的历史数据可能长这样），而基线里这 3 场胜利一场都还没上传：
    // 差值算出来是 gamesPlayed 0 / wins 3。原样发出去，服务端 accumulateStats 会把 wins 夹回
    // min(gamesPlayed, ...) = 0 —— 3 个胜场被静默吃掉，且因为本地没有报错而极难察觉。
    const delta = buildSyncDelta(
      stats({ gamesPlayed: 2, wins: 3, losses: 0 }),
      stats({ gamesPlayed: 2, wins: 0, losses: 0 }),
    );
    expect(delta.gamesPlayed).toBe(3);
    expect(delta.wins).toBe(3);
    expect(delta.losses).toBe(0);
  });
});

describe('重复同步与恢复都不会翻倍', () => {
  it('本机战绩没变时再同步一次，云端数字不变（送的是 0 增量）', async () => {
    const cloud = fakeCloud();
    const { request, calls } = makeRequest(cloud.handler);
    const local = stats({ gamesPlayed: 6, wins: 3, losses: 3, bestAsset: 30_000 });

    const first = await syncToCloud({ local, nickname: '小明', link: null }, { request });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.outcome.created).toBe(true);
    const link = first.ok ? linkAfterSync(null, first.outcome, local, 1) : null;
    expect(link).not.toBeNull();
    expect(link?.code).toBe(validCode());

    const second = await syncToCloud({ local, nickname: '小明', link }, { request });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.outcome.cloud.gamesPlayed).toBe(6);
      expect(second.outcome.cloud.bestAsset).toBe(30_000);
    }
    // 第二次送的增量确实是 0（而不是把 6 局又送了一遍）。
    expect((calls[1]?.body.stats as PlayerStats).gamesPlayed).toBe(0);
  });

  it('本机又打了 2 局后只送 2 局，云端累加到 8 而不是 12', async () => {
    const cloud = fakeCloud();
    const { request } = makeRequest(cloud.handler);
    const before = stats({ gamesPlayed: 6, wins: 3, losses: 3 });
    const first = await syncToCloud({ local: before, nickname: '小明', link: null }, { request });
    const link = first.ok ? linkAfterSync(null, first.outcome, before, 1) : null;

    const after = stats({ gamesPlayed: 8, wins: 4, losses: 4 });
    const second = await syncToCloud({ local: after, nickname: '小明', link }, { request });
    if (second.ok) expect(second.outcome.cloud.gamesPlayed).toBe(8);
  });
});

describe('planCloudRestore — 换设备恢复', () => {
  it('新设备（没有本机战绩）吸收整份云端战绩，并把基线重置为云端快照', () => {
    const cloud = stats({ gamesPlayed: 10, wins: 6, losses: 4, bestAsset: 50_000 });
    const plan = planCloudRestore(emptyPlayerStats(), null, validCode(), { accountId: ACCOUNT_ID, nickname: '小明', cloud, updatedAt: 7 }, 9);

    expect(plan.merged.gamesPlayed).toBe(10);
    expect(plan.merged.bestAsset).toBe(50_000);
    expect(plan.link.accountId).toBe(ACCOUNT_ID);
    expect(plan.link.baseline).toEqual(cloud);
    expect(plan.link.lastSyncedAt).toBe(9);
  });

  it('本机已有战绩时只吸收「云端盈余」，本机的部分不会被覆盖、也不会被加第二遍', () => {
    const local = stats({ gamesPlayed: 3, wins: 1, losses: 2, bestAsset: 8_000, favoriteMaps: { 'china-tour': 3 } });
    const cloud = stats({ gamesPlayed: 10, wins: 6, losses: 4, bestAsset: 50_000, favoriteMaps: { 'china-tour': 7 } });
    const plan = planCloudRestore(local, null, validCode(), { accountId: ACCOUNT_ID, nickname: '小明', cloud, updatedAt: 7 }, 9);

    expect(plan.merged.gamesPlayed).toBe(13);
    expect(plan.merged.wins).toBe(7);
    expect(plan.merged.bestAsset).toBe(50_000);
    expect(plan.merged.favoriteMaps['china-tour']).toBe(10);
  });

  it('恢复之后再同步，云端只会收到「本机独有」的那部分（最终等于合并后的战绩）', async () => {
    const local = stats({ gamesPlayed: 3, wins: 1, losses: 2, bestAsset: 8_000, favoriteMaps: { 'china-tour': 3 } });
    const cloud = fakeCloud(stats({ gamesPlayed: 10, wins: 6, losses: 4, bestAsset: 50_000, favoriteMaps: { 'china-tour': 7 } }));
    const { request, calls } = makeRequest(cloud.handler);
    const code = validCode();

    const restored = await restoreFromCloud(code, { request });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    const plan = planCloudRestore(local, null, code, restored.outcome, 9);

    const synced = await syncToCloud({ local: plan.merged, nickname: '小明', link: plan.link }, { request });
    expect(synced.ok).toBe(true);
    if (synced.ok) expect(synced.outcome.cloud.gamesPlayed).toBe(13);
    // 送出去的正是本机独有的 3 局（10 是云端已有、且本机刚吸收过的部分）。
    expect((calls[1]?.body.stats as PlayerStats).gamesPlayed).toBe(3);
  });

  it('applyCloudToLocal 是「本机 + 云端盈余」，不是「本机 + 云端」', () => {
    const local = stats({ gamesPlayed: 3, wins: 1, losses: 2 });
    const baseline = stats({ gamesPlayed: 3, wins: 1, losses: 2 });
    const cloud = stats({ gamesPlayed: 10, wins: 6, losses: 4 });
    // 本机那 3 局已经在基线里（= 已上传），所以只该再加 7 局。
    expect(applyCloudToLocal(local, baseline, cloud).gamesPlayed).toBe(10);
    expect(applyCloudToLocal(local, emptyPlayerStats(), cloud).gamesPlayed).toBe(13);
  });
});

describe('本机绑定关系（localStorage）', () => {
  const link: CloudAccountLink = {
    schemaVersion: 1,
    accountId: ACCOUNT_ID,
    nickname: '小明',
    code: validCode(),
    baseline: stats(),
    cloud: stats(),
    lastSyncedAt: 1_700_000_000_000,
  };

  it('存下来再读回来是同一份', () => {
    const storage = memoryStorage();
    expect(saveCloudLink(storage, link)).toBe(true);
    expect(loadCloudLink(storage)).toEqual(link);
    clearCloudLink(storage);
    expect(loadCloudLink(storage)).toBeNull();
  });

  it('未存过、坏 JSON、字段不符时一律当「没绑定」，而不是抛错或半份采用', () => {
    const storage = memoryStorage();
    expect(loadCloudLink(storage)).toBeNull();
    storage.values.set(CLOUD_ACCOUNT_KEY, '{ 坏');
    expect(loadCloudLink(storage)).toBeNull();
    storage.values.set(CLOUD_ACCOUNT_KEY, JSON.stringify({ schemaVersion: 1, accountId: 'x' }));
    expect(loadCloudLink(storage)).toBeNull();
    // 恢复码读坏了 = 这个绑定已经不可用（同步必然被拒），整份丢弃让玩家重新输入。
    storage.values.set(CLOUD_ACCOUNT_KEY, JSON.stringify({ ...link, code: '抄错的一位' }));
    expect(loadCloudLink(storage)).toBeNull();
  });

  it('存储不可用时 saveCloudLink 如实返回 false（不假装已同步）', () => {
    const broken: StorageLike = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    };
    expect(saveCloudLink(broken, link)).toBe(false);
    expect(loadCloudLink(broken)).toBeNull();
    expect(() => clearCloudLink(broken)).not.toThrow();
  });
});

describe('换码与响应校验', () => {
  it('换码只替换恢复码，不动基线（否则还没上传的那部分会永远送不上去）', () => {
    const previous: CloudAccountLink = {
      schemaVersion: 1,
      accountId: ACCOUNT_ID,
      nickname: '小明',
      code: validCode(),
      baseline: stats({ gamesPlayed: 4 }),
      cloud: stats({ gamesPlayed: 4 }),
      lastSyncedAt: 1,
    };
    const fresh = validCode('9999999999999999999');
    const next = linkAfterRotate(previous, {
      created: false,
      accountId: ACCOUNT_ID,
      nickname: '小明',
      cloud: stats({ gamesPlayed: 4 }),
      recoveryCode: formatRecoveryCode(fresh),
      updatedAt: 2,
    }, 2);

    expect(next.code).toBe(fresh);
    expect(next.baseline).toEqual(previous.baseline);
    expect(next.lastSyncedAt).toBe(2);
  });

  it('恢复码被服务端拒 / 网络不通 / 限流分别给出各自的人话', async () => {
    const { request } = makeRequest(() => jsonResponse(401, { ok: false, error: 'code_invalid' }));
    const denied = await restoreFromCloud(validCode(), { request });
    expect(denied).toEqual({ ok: false, reason: 'code_invalid' });
    expect(describeCloudFailure('code_invalid')).toContain('恢复码');

    const limited = makeRequest(() => jsonResponse(429, { ok: false, error: 'rate_limited' }));
    expect(await restoreFromCloud(validCode(), { request: limited.request })).toEqual({ ok: false, reason: 'rate_limited' });

    const tooLarge = makeRequest(() => jsonResponse(413, { ok: false, error: 'payload_too_large' }));
    expect(await syncToCloud({ local: stats(), nickname: '小明', link: null }, { request: tooLarge.request }))
      .toEqual({ ok: false, reason: 'too_large' });

    const offline = makeRequest(() => { throw new Error('offline'); });
    expect(await restoreFromCloud(validCode(), { request: offline.request })).toEqual({ ok: false, reason: 'network' });
  });

  it('响应形状不对（缺字段 / 半截数据）当「取不到」，绝不写进本地战绩', async () => {
    const bad = makeRequest(() => jsonResponse(200, { ok: true, accountId: ACCOUNT_ID, nickname: '小明', stats: { schemaVersion: 1 } }));
    expect(await restoreFromCloud(validCode(), { request: bad.request })).toEqual({ ok: false, reason: 'server' });

    const wrongId = makeRequest(() => jsonResponse(200, { ok: true, accountId: '短', nickname: '小明', stats: stats(), updatedAt: 1 }));
    expect(await restoreFromCloud(validCode(), { request: wrongId.request })).toEqual({ ok: false, reason: 'server' });

    // 服务端回了一段抄错的恢复码：宁可当作「没有新码」（沿用本机那段），也不把它存下来 ——
    // 存下去会让这台设备之后每次同步都失败。
    const wrongCode = makeRequest(() => jsonResponse(200, {
      ok: true, created: false, accountId: ACCOUNT_ID, nickname: '小明', stats: stats(), updatedAt: 1, recoveryCode: 'RM-!!!!-!!!!',
    }));
    const synced = await syncToCloud({ local: stats(), nickname: '小明', link: null }, { request: wrongCode.request });
    expect(synced.ok && synced.outcome.recoveryCode).toBe(null);
  });

  it('rotate 会把新码带回来（否则玩家换完码就再也进不来了）', async () => {
    const fresh = validCode('7777777777777777777');
    const { request } = makeRequest(() => jsonResponse(200, {
      ok: true, accountId: ACCOUNT_ID, nickname: '小明', recoveryCode: formatRecoveryCode(fresh), stats: stats(), updatedAt: 3,
    }));
    const result = await rotateRecoveryCode(validCode(), { request });
    expect(result.ok && result.outcome.recoveryCode).not.toBe(null);
    if (result.ok) expect(normalizeRecoveryCode(result.outcome.recoveryCode ?? '')).toBe(fresh);
  });
});

describe('parseCloudStats — 服务端回来的东西不可信', () => {
  it('接受一份正常战绩', () => {
    expect(parseCloudStats(stats())?.gamesPlayed).toBe(4);
    expect(parseCloudStats({ ...stats(), 注入: 1 })).not.toBeNull();
  });

  it('结构不符、版本不符、自相矛盾一律作废', () => {
    expect(parseCloudStats(null)).toBeNull();
    expect(parseCloudStats({ ...stats(), schemaVersion: 2 })).toBeNull();
    expect(parseCloudStats({ ...stats(), wins: 99 })).toBeNull();
    expect(parseCloudStats({ ...stats(), bestAsset: 10_000_001 })).toBeNull();
    expect(parseCloudStats({ ...stats(), favoriteMaps: { 'china-tour': 0 } })).toBeNull();
  });
});
