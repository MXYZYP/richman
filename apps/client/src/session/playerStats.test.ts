import { describe, expect, it } from 'vitest';
import {
  decodeStatsCode,
  encodeStatsCode,
  importStatsCode,
  loadPlayerStats,
  mergePlayerStats,
  PLAYER_STATS_IMPORTS_KEY,
  PLAYER_STATS_KEY,
  recordGameResult,
  STATS_CODE_PREFIX,
} from './playerStats';
import type { PlayerStats } from './playerStats';
import type { StorageLike } from './sessionStorage';

/**
 * 战绩码（路线图 #102）：「战绩上云」的最小版本——不引入账号密码，
 * 用一段可复制/可粘贴的码把「昵称 + 战绩」搬到另一台设备。
 *
 * 这一套测试盯住两条底线：
 *  1. 码能原样往返（含中文昵称），并且**坏码必须被挡住**而不是解出一半脏数据；
 *  2. 导入是**合并**（不覆盖掉本机已有的战绩），且同一份码重复导入不重复计数。
 */

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
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

/**
 * 与实现同源的 FNV-1a。只有自己算出校验和，才能伪造出「校验和对得上、但内容不合规」的码——
 * 那正是「格式检查」与「校验和检查」两条防线各自独立生效的证明。
 */
function fingerprintOf(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 按实现的格式手工拼一段码（UTF-8 → base64url），用来构造各种「合法编码 + 非法内容」。 */
function forgeCode(payload: unknown): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(JSON.stringify(payload))) binary += String.fromCharCode(byte);
  const body = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${STATS_CODE_PREFIX}.${body}.${fingerprintOf(body)}`;
}

describe('player stats 本地记录', () => {
  it('累加局数与胜负，峰值取最大，地图次数逐局累加', () => {
    const storage = new MemoryStorage();

    recordGameResult(storage, { won: true, finalAsset: 12_000, mapId: 'china-tour', at: 100 });
    recordGameResult(storage, { won: false, finalAsset: 8_000, mapId: 'china-tour', at: 200 });

    const stats = loadPlayerStats(storage);
    expect(stats).toMatchObject({ gamesPlayed: 2, wins: 1, losses: 1, bestAsset: 12_000, lastPlayedAt: 200 });
    expect(stats.favoriteMaps).toEqual({ 'china-tour': 2 });
  });

  it('损坏或缺字段的本地记录回退到空战绩，不抛错', () => {
    const storage = new MemoryStorage();
    storage.setItem(PLAYER_STATS_KEY, '{ not json');
    expect(loadPlayerStats(storage)).toEqual(EMPTY);

    storage.setItem(PLAYER_STATS_KEY, JSON.stringify({ schemaVersion: 1, gamesPlayed: 3 }));
    expect(loadPlayerStats(storage)).toEqual(EMPTY);
  });
});

describe('战绩码编解码', () => {
  it('往返后昵称与战绩一模一样（含中文昵称）', () => {
    const original = stats({ gamesPlayed: 42, wins: 18, losses: 24, bestAsset: 65_000, favoriteMaps: { 'china-tour': 30, 'world-tour': 12 }, lastPlayedAt: 1_700_000_000_000 });

    const code = encodeStatsCode({ nickname: '小明', stats: original });
    const decoded = decodeStatsCode(code);

    expect(code.startsWith(`${STATS_CODE_PREFIX}.`)).toBe(true);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.payload.nickname).toBe('小明');
    expect(decoded.payload.stats).toEqual(original);
  });

  it('粘贴产生的空白与换行被抹掉后仍能解析', () => {
    const code = encodeStatsCode({ nickname: '小明', stats: stats({ gamesPlayed: 3 }) });

    expect(decodeStatsCode(`  ${code}\n`).ok).toBe(true);
    expect(decodeStatsCode(code.replace(/\./g, '\n.\n')).ok).toBe(true);
  });

  it('码被改动一个字符就报校验和错误（不尝试「猜」原来的内容）', () => {
    const code = encodeStatsCode({ nickname: '小明', stats: stats({ gamesPlayed: 3 }) });
    const tampered = `${code.slice(0, code.length - 1)}${code.endsWith('0') ? '1' : '0'}`;

    expect(decodeStatsCode(tampered)).toEqual({ ok: false, reason: 'checksum' });
  });

  it('前缀 / 段数 / 载荷版本不对一律算格式错误', () => {
    expect(decodeStatsCode('')).toEqual({ ok: false, reason: 'format' });
    expect(decodeStatsCode('hello world')).toEqual({ ok: false, reason: 'format' });
    expect(decodeStatsCode('RMSTATS1.abc')).toEqual({ ok: false, reason: 'format' });
    expect(decodeStatsCode('RMSTATS2.abc.00000000')).toEqual({ ok: false, reason: 'format' });

    // 版本不符：内容本身合法（校验和对得上），但版本号是 2。
    expect(decodeStatsCode(forgeCode({ v: 2, nickname: '小明', stats: EMPTY })))
      .toEqual({ ok: false, reason: 'format' });
  });

  it('先校验和、后解码：连 JSON 都不合法的 body 在校验和这一步就被挡住', () => {
    // 顺序是刻意的：粘贴来的垃圾字符串不该让 JSON.parse 白跑一趟。
    expect(decodeStatsCode(`RMSTATS1.${btoa('not json')}.00000000`)).toEqual({ ok: false, reason: 'checksum' });
  });

  it('码里的战绩字段不合法时整份拒绝，可修复的越界值则被夹紧', () => {
    // 缺字段 / 类型不对：整份拒绝——宁可不导入，也不导入半份脏数据。
    expect(decodeStatsCode(forgeCode({ v: 1, nickname: '伪造', stats: { schemaVersion: 1, gamesPlayed: 1 } })))
      .toEqual({ ok: false, reason: 'format' });
    expect(decodeStatsCode(forgeCode({ v: 1, nickname: '伪造', stats: { ...EMPTY, gamesPlayed: 'many' } })))
      .toEqual({ ok: false, reason: 'format' });

    // 负数这类越界值走的是与本地记录同一套夹紧逻辑：归零而不是把脏数据带进合并。
    const clamped = decodeStatsCode(forgeCode({ v: 1, nickname: '伪造', stats: { ...EMPTY, gamesPlayed: -5, bestAsset: -1 } }));
    expect(clamped).toMatchObject({ ok: true, payload: { stats: { gamesPlayed: 0, bestAsset: 0 } } });
  });
});

describe('战绩码导入', () => {
  it('导入到空存储：战绩直接落地', () => {
    const storage = new MemoryStorage();
    const code = encodeStatsCode({ nickname: '小明', stats: stats({ gamesPlayed: 7, wins: 3, losses: 4, bestAsset: 20_000 }) });

    const outcome = importStatsCode(storage, code);

    expect(outcome).toMatchObject({ ok: true, applied: true, nickname: '小明' });
    expect(loadPlayerStats(storage)).toMatchObject({ gamesPlayed: 7, wins: 3, losses: 4, bestAsset: 20_000 });
  });

  it('导入是合并：本机已有的战绩不会被覆盖', () => {
    const storage = new MemoryStorage();
    recordGameResult(storage, { won: true, finalAsset: 30_000, mapId: 'china-tour', at: 500 });

    const code = encodeStatsCode({
      nickname: '小明',
      stats: stats({ gamesPlayed: 4, wins: 1, losses: 3, bestAsset: 20_000, favoriteMaps: { 'world-tour': 4 }, lastPlayedAt: 900 }),
    });
    const outcome = importStatsCode(storage, code);

    expect(outcome.ok).toBe(true);
    const merged = loadPlayerStats(storage);
    expect(merged).toMatchObject({ gamesPlayed: 5, wins: 2, losses: 3, bestAsset: 30_000, lastPlayedAt: 900 });
    expect(merged.favoriteMaps).toEqual({ 'china-tour': 1, 'world-tour': 4 });
  });

  it('同一份码重复导入不重复计数（指纹去重）', () => {
    const storage = new MemoryStorage();
    const code = encodeStatsCode({ nickname: '小明', stats: stats({ gamesPlayed: 4, wins: 1, losses: 3 }) });

    expect(importStatsCode(storage, code)).toMatchObject({ ok: true, applied: true });
    const second = importStatsCode(storage, code);

    expect(second).toMatchObject({ ok: true, applied: false });
    expect(loadPlayerStats(storage).gamesPlayed).toBe(4);
    expect(JSON.parse(storage.getItem(PLAYER_STATS_IMPORTS_KEY) ?? '[]')).toHaveLength(1);
  });

  it('带空白的同一份码也算同一份（去重前先归一化）', () => {
    const storage = new MemoryStorage();
    const code = encodeStatsCode({ nickname: '小明', stats: stats({ gamesPlayed: 4 }) });

    expect(importStatsCode(storage, code)).toMatchObject({ ok: true, applied: true });
    expect(importStatsCode(storage, ` ${code}\n`)).toMatchObject({ ok: true, applied: false });
    expect(loadPlayerStats(storage).gamesPlayed).toBe(4);
  });

  it('坏码被拒且不写入任何东西', () => {
    const storage = new MemoryStorage();

    expect(importStatsCode(storage, 'rmstats1.garbage.00000000')).toEqual({ ok: false, reason: 'format' });
    const good = encodeStatsCode({ nickname: '小明', stats: stats({ gamesPlayed: 1 }) });
    expect(importStatsCode(storage, `${good}x`)).toEqual({ ok: false, reason: 'checksum' });
    expect(loadPlayerStats(storage)).toEqual(EMPTY);
    expect(storage.getItem(PLAYER_STATS_KEY)).toBeNull();
  });

  it('存储不可用时如实报失败，而不是假装导入成功', () => {
    const broken: StorageLike = {
      getItem() { return null; },
      setItem() { throw new Error('quota exceeded'); },
      removeItem() { throw new Error('quota exceeded'); },
    };
    const code = encodeStatsCode({ nickname: '小明', stats: stats({ gamesPlayed: 2 }) });

    expect(importStatsCode(broken, code)).toEqual({ ok: false, reason: 'storage' });
  });

  it('mergePlayerStats 只做加与取大，不改动入参', () => {
    const base = stats({ gamesPlayed: 1, wins: 1, bestAsset: 10, favoriteMaps: { a: 1 }, lastPlayedAt: 10 });
    const incoming = stats({ gamesPlayed: 2, losses: 2, bestAsset: 5, favoriteMaps: { a: 1, b: 2 }, lastPlayedAt: 20 });

    const merged = mergePlayerStats(base, incoming);

    expect(merged).toMatchObject({ gamesPlayed: 3, wins: 1, losses: 2, bestAsset: 10, lastPlayedAt: 20 });
    expect(merged.favoriteMaps).toEqual({ a: 2, b: 2 });
    // 入参未被就地修改。
    expect(base.favoriteMaps).toEqual({ a: 1 });
    expect(incoming.favoriteMaps).toEqual({ a: 1, b: 2 });
  });
});
