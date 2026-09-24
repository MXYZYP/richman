import { describe, expect, it } from 'vitest';
import { createGame, type GameState } from '@richman/engine';
import { getActiveMapPack } from '@richman/board-data';
import {
  LOCAL_GAME_SAVE_KEYS,
  chooseLocalSaveSlot,
  commitLocalSave,
  createLocalSave,
  createLocalSaveLocked,
  createLocalSavePersistence,
  hasLocalSaveChanged,
  isStorageAvailable,
  readAllLocalSaveSlots,
  readLocalSaveSlot,
  removeLocalSave,
  removeLocalSaveLocked,
  replaceLocalSave,
  replaceLocalSaveLocked,
  type LocalSaveMutationLock,
  type StorageLike,
} from './localGameSave';

const chinaMap = getActiveMapPack('china-tour');

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  failGet = false;
  failSet = false;
  failRemove = false;
  onGet: ((key: string) => void) | undefined;
  onSet: ((key: string, value: string) => void) | undefined;
  onRemove: ((key: string) => void) | undefined;

  getItem(key: string): string | null {
    if (this.failGet) throw new Error('get rejected');
    const value = this.values.get(key) ?? null;
    this.onGet?.(key);
    return value;
  }

  setItem(key: string, value: string): void {
    if (this.failSet) throw new Error('set rejected');
    this.values.set(key, value);
    this.onSet?.(key, value);
  }

  removeItem(key: string): void {
    if (this.failRemove) throw new Error('remove rejected');
    this.values.delete(key);
    this.onRemove?.(key);
  }
}

class MemoryMutationLock implements LocalSaveMutationLock {
  private tail: Promise<void> = Promise.resolve();

  runExclusive<T>(operation: () => T): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

class DeferredMutationLock implements LocalSaveMutationLock {
  private releaseLock: (() => void) | undefined;

  async runExclusive<T>(operation: () => T): Promise<T> {
    await new Promise<void>((resolve) => { this.releaseLock = resolve; });
    return operation();
  }

  release(): void {
    this.releaseLock?.();
  }
}

function state(seed: string, turn = 1): GameState {
  return {
    ...createGame({
      mapRef: chinaMap.ref,
      ruleModules: chinaMap.game.requiredRuleModules,
      board: chinaMap.game.board,
      cards: chinaMap.game.cards,
      config: chinaMap.game.config,
      players: [
        { id: 'p1', nickname: '玩家一' },
        { id: 'p2', nickname: '电脑A', isBot: true },
      ],
      seed,
    }),
    turn,
  };
}

function saveRaw(storage: MemoryStorage, slot: 1 | 2, value: unknown): void {
  storage.values.set(LOCAL_GAME_SAVE_KEYS[slot - 1], JSON.stringify(value));
}

/** 单机真人抽卡确认的待机存档：真人停在机会格、卡牌在堆顶等待接受。 */
function pausedCardState(seed: string): GameState {
  const base = state(seed);
  const chanceCell = chinaMap.game.board.cells.find((cell) => cell.type === 'chance')!;
  return {
    ...base,
    currentPlayerId: 'p1',
    turnPhase: 'managing',
    players: base.players.map((player) => (
      player.id === 'p1' ? { ...player, position: chanceCell.id } : player
    )),
    cardChoice: {
      mode: 'local-human',
      pending: { playerId: 'p1', deck: 'chance', cardId: base.decks.chance[0], resumeTurnPhase: 'managing' },
    },
  };
}

/**
 * 房主自定义过规则的存档（P2-10）：config 不等于地图默认值。
 * 这类存档若按「与地图默认值全等」去校验，会被误判成损坏 —— 恢复时必须把这份 config 传进 hydrate。
 */
function customRuleState(seed: string): GameState {
  return createGame({
    mapRef: chinaMap.ref,
    ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: { ...chinaMap.game.config, initialCash: chinaMap.game.config.initialCash + 5000, maxHouseLevel: 3 },
    players: [
      { id: 'p1', nickname: '玩家一' },
      { id: 'p2', nickname: '电脑A', isBot: true },
    ],
    seed,
  });
}

describe('localGameSave store', () => {
  it('读取 empty、valid 并由 validated state 派生 summary', () => {
    const storage = new MemoryStorage();
    expect(readLocalSaveSlot(storage, 1)).toEqual({ kind: 'empty', slot: 1 });

    const created = createLocalSave(storage, state('valid-save', 7), 100);
    expect(created.ok).toBe(true);
    const result = readLocalSaveSlot(storage, 1);
    expect(result).toMatchObject({
      kind: 'valid',
      slot: 1,
      summary: {
        title: chinaMap.metadata.title,
        players: [{ nickname: '玩家一', isBot: false }, { nickname: '电脑A', isBot: true }],
        turn: 7,
        updatedAt: 100,
      },
    });
  });

  it('待确认卡牌随存档往返：保留 CardChoice 且未结算任何效果', () => {
    const storage = new MemoryStorage();
    const paused = pausedCardState('card-choice-save');
    const created = createLocalSave(storage, paused, 100);
    expect(created.ok).toBe(true);

    const result = readLocalSaveSlot(storage, 1);
    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(result.save.state.cardChoice).toEqual(paused.cardChoice);
    expect(result.save.state.players).toEqual(paused.players);
    expect(result.save.state.decks).toEqual(paused.decks);
    expect(result.save.state.turnPhase).toBe('managing');
  });

  it('房主自定义规则的存档仍能恢复，不会被误判为损坏', () => {
    const storage = new MemoryStorage();
    const customized = customRuleState('custom-rule-save');
    expect(customized.config.initialCash).not.toBe(chinaMap.game.config.initialCash);

    const created = createLocalSave(storage, customized, 100);
    expect(created.ok).toBe(true);

    const result = readLocalSaveSlot(storage, 1);
    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    // 恢复出来的规则就是存进去的那份，而不是被地图默认值覆盖。
    expect(result.save.state.config.initialCash).toBe(customized.config.initialCash);
    expect(result.save.state.config.maxHouseLevel).toBe(3);
  });

  it('保留 malformed、unsupported schema、missing exact map 为可见错误且不影响另一槽', () => {
    const storage = new MemoryStorage();
    storage.values.set(LOCAL_GAME_SAVE_KEYS[0], '{broken');
    saveRaw(storage, 2, { schemaVersion: 1, state: {} });

    expect(readAllLocalSaveSlots(storage)).toMatchObject([
      { kind: 'corrupt', slot: 1, reason: '存档内容已损坏，无法恢复' },
      { kind: 'incompatible', slot: 2, reason: '该存档来自不兼容的游戏版本' },
    ]);

    const missingMap = state('missing-map');
    (missingMap as any).mapRef = { ...missingMap.mapRef, version: 999 };
    saveRaw(storage, 1, {
      schemaVersion: 2, gameId: 'missing-map', createdAt: 1, updatedAt: 1, revision: 1, state: missingMap,
    });
    expect(readLocalSaveSlot(storage, 1)).toMatchObject({
      kind: 'incompatible', slot: 1, reason: '找不到这局使用的地图版本',
    });
  });

  it('拒绝 envelope 时间、revision、额外字段和损坏 runtime state', () => {
    const storage = new MemoryStorage();
    const base = { schemaVersion: 2, gameId: 'g1', createdAt: 2, updatedAt: 1, revision: 0, state: state('bad') };
    saveRaw(storage, 1, base);
    expect(readLocalSaveSlot(storage, 1)).toMatchObject({ kind: 'corrupt' });

    const damaged = { ...base, createdAt: 1, updatedAt: 1, revision: 1, extra: true, state: structuredClone(base.state) };
    damaged.state.currentPlayerId = 'missing';
    saveRaw(storage, 1, damaged);
    expect(readLocalSaveSlot(storage, 1)).toMatchObject({
      kind: 'corrupt', slot: 1, reason: '存档内容已损坏，无法恢复',
    });
  });

  it('创建两槽、按更新时间排序，并稳定选择空槽或最旧有效槽', () => {
    const storage = new MemoryStorage();
    const first = createLocalSave(storage, state('first'), 200);
    const second = createLocalSave(storage, state('second'), 100);
    expect(first).toMatchObject({ ok: true, slot: 1, revision: 1 });
    expect(second).toMatchObject({ ok: true, slot: 2, revision: 1 });

    const results = readAllLocalSaveSlots(storage);
    expect(results.filter((result) => result.kind === 'valid').map((result) => result.summary.updatedAt)).toEqual([200, 100]);
    expect(chooseLocalSaveSlot(results)).toMatchObject({ kind: 'replace_oldest', slot: 2 });
    expect(chooseLocalSaveSlot([{ kind: 'empty', slot: 1 }, results[1]!])).toEqual({ kind: 'empty', slot: 1 });
  });

  it('commit revision+1，并拒绝 stale revision、错误 gameId 和 storage error', () => {
    const storage = new MemoryStorage();
    const created = createLocalSave(storage, state('commit'), 1);
    if (!created.ok) throw new Error('create failed');

    expect(commitLocalSave(storage, created.slot, created.gameId, 1, state('next', 2), 2)).toEqual({
      ok: true, slot: created.slot, revision: 2,
    });
    expect(commitLocalSave(storage, created.slot, created.gameId, 1, state('stale'), 3)).toEqual({
      ok: false, reason: 'revision_mismatch',
    });
    expect(commitLocalSave(storage, created.slot, 'wrong', 2, state('wrong'), 3)).toEqual({
      ok: false, reason: 'game_id_mismatch',
    });
    storage.failSet = true;
    expect(commitLocalSave(storage, created.slot, created.gameId, 2, state('error'), 3)).toEqual({
      ok: false, reason: 'storage_error',
    });
  });

  it('guarded remove 隔离另一槽与 online key，并捕获删除错误', () => {
    const storage = new MemoryStorage();
    const first = createLocalSave(storage, state('one'), 1);
    const second = createLocalSave(storage, state('two'), 2);
    if (!first.ok || !second.ok) throw new Error('create failed');
    storage.values.set('richman_session', 'online');

    expect(removeLocalSave(storage, { slot: first.slot, recordToken: `${first.recordToken}x` })).toEqual({ ok: false, reason: 'record_mismatch' });
    expect(removeLocalSave(storage, first)).toEqual({ ok: true, slot: 1 });
    expect(storage.values.has(LOCAL_GAME_SAVE_KEYS[1])).toBe(true);
    expect(storage.values.get('richman_session')).toBe('online');
    storage.failRemove = true;
    expect(removeLocalSave(storage, second)).toEqual({ ok: false, reason: 'storage_error' });
  });

  it('confirmed replacement 只覆盖 UI 观察到的 gameId，slot 改变后冲突', () => {
    const storage = new MemoryStorage();
    const first = createLocalSave(storage, state('old'), 1);
    createLocalSave(storage, state('other'), 2);
    if (!first.ok) throw new Error('create failed');

    const replaced = replaceLocalSave(storage, first, state('new'), 3);
    expect(replaced).toMatchObject({ ok: true, slot: 1, revision: 1 });
    expect(replaceLocalSave(storage, first, state('stale-confirm'), 4)).toEqual({
      ok: false, reason: 'record_mismatch',
    });
  });

  it('确认替换后另一 tab 推进 revision 时旧确认不得覆盖新状态', async () => {
    const storage = new MemoryStorage();
    const lock = new MemoryMutationLock();
    const created = createLocalSave(storage, state('replace-observed'), 1);
    if (!created.ok) throw new Error('create failed');
    const observed = readLocalSaveSlot(storage, created.slot);
    if (observed.kind !== 'valid') throw new Error('expected valid save');
    const writer = createLocalSavePersistence(storage, lock, created, () => 2);
    await writer.commit(state('replace-newer', 2));
    const newerRaw = storage.values.get(LOCAL_GAME_SAVE_KEYS[created.slot - 1]);

    await expect(replaceLocalSaveLocked(
      storage, lock, observed.summary, state('stale-replacement'), 3,
    )).resolves.toMatchObject({ ok: false });
    expect(storage.values.get(LOCAL_GAME_SAVE_KEYS[created.slot - 1])).toBe(newerRaw);
  });

  it('确认删除后另一 tab 推进 revision 时旧确认不得删除新状态', async () => {
    const storage = new MemoryStorage();
    const lock = new MemoryMutationLock();
    const created = createLocalSave(storage, state('delete-observed'), 1);
    if (!created.ok) throw new Error('create failed');
    const observed = readLocalSaveSlot(storage, created.slot);
    if (observed.kind !== 'valid') throw new Error('expected valid save');
    const writer = createLocalSavePersistence(storage, lock, created, () => 2);
    await writer.commit(state('delete-newer', 2));
    const newerRaw = storage.values.get(LOCAL_GAME_SAVE_KEYS[created.slot - 1]);

    await expect(removeLocalSaveLocked(
      storage, lock, observed.summary,
    )).resolves.toMatchObject({ ok: false });
    expect(storage.values.get(LOCAL_GAME_SAVE_KEYS[created.slot - 1])).toBe(newerRaw);
  });

  it('invalid 存档删除也要求确认时观察到的 exact raw token', async () => {
    const storage = new MemoryStorage();
    const lock = new MemoryMutationLock();
    storage.values.set(LOCAL_GAME_SAVE_KEYS[0], '{broken-at-confirm');
    const observed = readLocalSaveSlot(storage, 1);
    if (observed.kind !== 'corrupt' || observed.recordToken === undefined) throw new Error('expected corrupt save');
    storage.values.set(LOCAL_GAME_SAVE_KEYS[0], '{changed-after-confirm');

    await expect(removeLocalSaveLocked(storage, lock, {
      slot: observed.slot, recordToken: observed.recordToken,
    })).resolves.toEqual({
      ok: false, reason: 'record_mismatch',
    });
    expect(storage.values.get(LOCAL_GAME_SAVE_KEYS[0])).toBe('{changed-after-confirm');
  });

  it('persistence handle 维护 revision，完成时删除 exact game', async () => {
    const storage = new MemoryStorage();
    const created = createLocalSave(storage, state('persist'), 1);
    if (!created.ok) throw new Error('create failed');
    let now = 1;
    const persistence = createLocalSavePersistence(storage, new MemoryMutationLock(), created, () => ++now);

    await expect(persistence.commit(state('transition', 2))).resolves.toEqual({ ok: true, slot: 1, revision: 2 });
    await expect(persistence.complete({ ...state('complete'), phase: 'game_over' })).resolves.toEqual({ ok: true, slot: 1, revision: 2 });
    expect(readLocalSaveSlot(storage, 1)).toEqual({ kind: 'empty', slot: 1 });
  });

  it('两个 writer 从同一 revision 交错提交时最多一个成功', async () => {
    const storage = new MemoryStorage();
    const created = createLocalSave(storage, state('concurrent-base'), 1);
    if (!created.ok) throw new Error('create failed');
    const lock = new MemoryMutationLock();
    const first = createLocalSavePersistence(storage, lock, created, () => 2);
    const second = createLocalSavePersistence(storage, lock, created, () => 3);
    let secondCommit: Promise<Awaited<ReturnType<typeof second.commit>>> | undefined;
    storage.onGet = (key) => {
      if (key !== LOCAL_GAME_SAVE_KEYS[created.slot - 1]) return;
      storage.onGet = undefined;
      secondCommit = second.commit(state('concurrent-second', 2));
    };

    const firstResult = await first.commit(state('concurrent-first', 2));
    const secondResult = await secondCommit;

    expect([firstResult, secondResult].filter((result) => result?.ok)).toHaveLength(1);
    expect([firstResult, secondResult].filter((result) => result?.ok === false)).toHaveLength(1);
  });

  it('同 gameId/revision 的内容被外部篡改时 commit 拒绝覆盖', async () => {
    const storage = new MemoryStorage();
    const created = createLocalSave(storage, state('token-base'), 1);
    if (!created.ok) throw new Error('create failed');
    const persistence = createLocalSavePersistence(storage, new MemoryMutationLock(), created, () => 2);
    const tampered = JSON.parse(created.recordToken);
    tampered.state.seed = 'externally-tampered';
    saveRaw(storage, created.slot, tampered);

    await expect(persistence.commit(state('must-not-overwrite', 2))).resolves.toEqual({
      ok: false, reason: 'revision_mismatch',
    });
    expect(JSON.parse(storage.values.get(LOCAL_GAME_SAVE_KEYS[created.slot - 1]) ?? '').state.seed).toBe('externally-tampered');
  });

  it('写入后校验发现旧 build 同 revision 覆盖时不报告成功', async () => {
    const storage = new MemoryStorage();
    const created = createLocalSave(storage, state('post-write-base'), 1);
    if (!created.ok) throw new Error('create failed');
    const persistence = createLocalSavePersistence(storage, new MemoryMutationLock(), created, () => 2);
    storage.onSet = (key, value) => {
      if (key !== LOCAL_GAME_SAVE_KEYS[created.slot - 1]) return;
      storage.onSet = undefined;
      const overwritten = JSON.parse(value);
      overwritten.state.seed = 'old-build-overwrite';
      saveRaw(storage, created.slot, overwritten);
    };

    await expect(persistence.commit(state('new-build-write', 2))).resolves.toEqual({
      ok: false, reason: 'revision_mismatch',
    });
    expect(JSON.parse(storage.values.get(LOCAL_GAME_SAVE_KEYS[created.slot - 1]) ?? '').state.seed).toBe('old-build-overwrite');
  });

  it.each(['start', 'storage retry'])('cancelled %s does not write after a deferred lock opens', async () => {
    const storage = new MemoryStorage();
    const lock = new DeferredMutationLock();
    let current = true;
    const pending = createLocalSaveLocked(
      storage,
      lock,
      state('cancelled-create'),
      1,
      () => current,
    );

    current = false;
    lock.release();

    await expect(pending).resolves.toEqual({ ok: false, reason: 'storage_error' });
    expect(storage.values.size).toBe(0);
  });

  it('cancelled replacement confirmation does not overwrite after a deferred lock opens', async () => {
    const storage = new MemoryStorage();
    const created = createLocalSave(storage, state('replacement-base'), 1);
    if (!created.ok) throw new Error('create failed');
    const original = storage.values.get(LOCAL_GAME_SAVE_KEYS[created.slot - 1]);
    const lock = new DeferredMutationLock();
    let current = true;
    const pending = replaceLocalSaveLocked(
      storage,
      lock,
      created,
      state('cancelled-replacement'),
      2,
      () => current,
    );

    current = false;
    lock.release();

    await expect(pending).resolves.toEqual({ ok: false, reason: 'storage_error' });
    expect(storage.values.get(LOCAL_GAME_SAVE_KEYS[created.slot - 1])).toBe(original);
  });

  it('Web Lock boundary rejection 对所有 mutation 返回 storage_error 而不抛出', async () => {
    const storage = new MemoryStorage();
    const created = createLocalSave(storage, state('lock-reject'), 1);
    if (!created.ok) throw new Error('create failed');
    const rejectingLock: LocalSaveMutationLock = {
      runExclusive: async () => { throw new Error('lock rejected'); },
    };
    const persistence = createLocalSavePersistence(storage, rejectingLock, created, () => 2);

    await expect(createLocalSaveLocked(storage, rejectingLock, state('create-reject'), 2)).resolves.toEqual({ ok: false, reason: 'storage_error' });
    await expect(replaceLocalSaveLocked(storage, rejectingLock, created, state('replace-reject'), 2)).resolves.toEqual({ ok: false, reason: 'storage_error' });
    await expect(removeLocalSaveLocked(storage, rejectingLock, created)).resolves.toEqual({ ok: false, reason: 'storage_error' });
    await expect(persistence.commit(state('commit-reject', 2))).resolves.toEqual({ ok: false, reason: 'storage_error' });
    await expect(persistence.complete({ ...state('complete-reject'), phase: 'game_over' })).resolves.toEqual({ ok: false, reason: 'storage_error' });
  });

  it('create/replace/remove locked mutation 都校验写后实际 slot 状态', async () => {
    const lock = new MemoryMutationLock();
    const createStorage = new MemoryStorage();
    createStorage.onSet = (key) => {
      createStorage.onSet = undefined;
      createStorage.values.set(key, '{external-create-overwrite');
    };
    await expect(createLocalSaveLocked(createStorage, lock, state('create-post-check'), 1)).resolves.toEqual({
      ok: false, reason: 'storage_error',
    });

    const replaceStorage = new MemoryStorage();
    const replaceCreated = createLocalSave(replaceStorage, state('replace-post-base'), 1);
    if (!replaceCreated.ok) throw new Error('create failed');
    replaceStorage.onSet = (key) => {
      replaceStorage.onSet = undefined;
      replaceStorage.values.set(key, '{external-replace-overwrite');
    };
    await expect(replaceLocalSaveLocked(
      replaceStorage, lock, replaceCreated, state('replace-post-check'), 2,
    )).resolves.toEqual({ ok: false, reason: 'record_mismatch' });

    const removeStorage = new MemoryStorage();
    const removeCreated = createLocalSave(removeStorage, state('remove-post-base'), 1);
    if (!removeCreated.ok) throw new Error('create failed');
    removeStorage.onRemove = (key) => {
      removeStorage.onRemove = undefined;
      removeStorage.values.set(key, '{external-remove-write');
    };
    await expect(removeLocalSaveLocked(removeStorage, lock, removeCreated)).resolves.toEqual({
      ok: false, reason: 'record_mismatch',
    });
    expect(removeStorage.values.get(LOCAL_GAME_SAVE_KEYS[0])).toBe('{external-remove-write');
  });

  it('storage event re-read 仅在 active gameId/revision 真的改变或被删除时判 stale', () => {
    const storage = new MemoryStorage();
    const created = createLocalSave(storage, state('storage-event'), 1);
    if (!created.ok) throw new Error('create failed');
    const recordToken = storage.values.get(LOCAL_GAME_SAVE_KEYS[created.slot - 1]);
    if (recordToken === undefined) throw new Error('missing record token');
    const identity = { slot: created.slot, gameId: created.gameId, revision: created.revision, recordToken };

    expect(hasLocalSaveChanged(storage, identity)).toBe(false);
    const sameRevision = JSON.parse(recordToken);
    sameRevision.state.seed = 'same-revision-tampered';
    saveRaw(storage, created.slot, sameRevision);
    expect(hasLocalSaveChanged(storage, identity)).toBe(true);
    saveRaw(storage, created.slot, JSON.parse(recordToken));
    expect(commitLocalSave(storage, created.slot, created.gameId, created.revision, state('changed'), 2)).toMatchObject({ ok: true });
    expect(hasLocalSaveChanged(storage, identity)).toBe(true);
    const latest = readLocalSaveSlot(storage, created.slot);
    if (latest.kind !== 'valid') throw new Error('expected latest save');
    expect(removeLocalSave(storage, latest.summary)).toMatchObject({ ok: true });
    expect(hasLocalSaveChanged(storage, identity)).toBe(true);
  });

  it('storage get/set rejection 永不向外抛出', () => {
    const storage = new MemoryStorage();
    storage.failGet = true;
    expect(readLocalSaveSlot(storage, 1)).toEqual({ kind: 'corrupt', slot: 1, reason: '浏览器无法保存本次操作，请检查存储权限后重试' });
    storage.failGet = false;
    storage.failSet = true;
    expect(createLocalSave(storage, state('set-fail'), 1)).toEqual({ ok: false, reason: 'storage_error' });
  });

  it('durable capability 同时要求可写 storage 与 Web Lock', () => {
    const storage = new MemoryStorage();
    expect(isStorageAvailable(storage, undefined)).toBe(false);
    expect(isStorageAvailable(storage, new MemoryMutationLock())).toBe(true);
    storage.failSet = true;
    expect(isStorageAvailable(storage, new MemoryMutationLock())).toBe(false);
  });
});
