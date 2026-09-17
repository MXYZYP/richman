import { describe, expect, it } from 'vitest';
import {
  ACTIVE_ONLINE_SESSION_KEY,
  PENDING_ROOM_REQUEST_KEY,
  clearOnlineSession,
  clearStoredOnlineSession,
  clearPendingRoomRequest,
  commitOnlineSession,
  readOnlineSession,
  readPendingRoomRequest,
  savePendingRoomRequest,
  type OnlineSession,
  type PendingRoomRequest,
} from './sessionStorage';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

class TargetReadDeniedStorage extends MemoryStorage {
  readonly removedKeys: string[] = [];

  constructor(private readonly deniedKey: string) {
    super();
  }

  override getItem(key: string) {
    if (key === this.deniedKey) throw new DOMException('Storage access denied', 'SecurityError');
    return super.getItem(key);
  }

  override removeItem(key: string) {
    this.removedKeys.push(key);
    super.removeItem(key);
  }
}

const activeSession: OnlineSession = {
  roomCode: '1234',
  playerId: 'player-1',
  token: 'resume-token',
};

const createRequest: PendingRoomRequest = {
  operation: 'create',
  requestId: '0123456789abcdef0123456789abcdef',
  nickname: '小明',
  mapId: 'china-tour',
};

const joinRequest: PendingRoomRequest = {
  operation: 'join',
  requestId: 'fedcba9876543210fedcba9876543210',
  roomCode: '5678',
  nickname: '小红',
  role: 'player',
};

const spectatorJoinRequest: PendingRoomRequest = {
  operation: 'join',
  requestId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  roomCode: '9012',
  nickname: '观众',
  role: 'spectator',
};

function storeRaw(storage: Storage, key: string, value: unknown) {
  storage.setItem(key, JSON.stringify(value));
}

describe('online session persistence', () => {
  it('round-trips valid active and pending session records', () => {
    const storage = new MemoryStorage();

    expect(savePendingRoomRequest(storage, createRequest)).toBe(true);
    expect(readPendingRoomRequest(storage)).toEqual(createRequest);
    expect(commitOnlineSession(storage, activeSession)).toBe(true);
    expect(readOnlineSession(storage)).toEqual(activeSession);
    expect(readPendingRoomRequest(storage)).toBeNull();
  });

  it('does not remove the pending request when persisting the active session fails', () => {
    class FailingActiveWriteStorage extends MemoryStorage {
      override setItem(key: string, value: string) {
        if (key === ACTIVE_ONLINE_SESSION_KEY) throw new Error('quota exceeded');
        super.setItem(key, value);
      }
    }

    const storage = new FailingActiveWriteStorage();
    savePendingRoomRequest(storage, joinRequest);

    expect(commitOnlineSession(storage, activeSession)).toBe(false);
    expect(readPendingRoomRequest(storage)).toEqual(joinRequest);
    expect(readOnlineSession(storage)).toBeNull();
  });

  it('returns true when the active session is committed but pending cleanup fails', () => {
    class FailingPendingRemoveStorage extends MemoryStorage {
      override removeItem(key: string) {
        if (key === PENDING_ROOM_REQUEST_KEY) throw new Error('storage locked');
        super.removeItem(key);
      }
    }

    const storage = new FailingPendingRemoveStorage();
    savePendingRoomRequest(storage, joinRequest);

    expect(commitOnlineSession(storage, activeSession)).toBe(true);
    expect(readOnlineSession(storage)).toEqual(activeSession);
    expect(readPendingRoomRequest(storage)).toEqual(joinRequest);
  });

  it('removes only a corrupt active record and preserves a valid pending request', () => {
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, '{not json');
    savePendingRoomRequest(storage, joinRequest);

    expect(readOnlineSession(storage)).toBeNull();
    expect(storage.getItem(ACTIVE_ONLINE_SESSION_KEY)).toBeNull();
    expect(readPendingRoomRequest(storage)).toEqual(joinRequest);
  });

  it('returns null without deleting the active record when its storage read is denied', () => {
    const storage = new TargetReadDeniedStorage(ACTIVE_ONLINE_SESSION_KEY);
    savePendingRoomRequest(storage, joinRequest);

    expect(readOnlineSession(storage)).toBeNull();
    expect(storage.removedKeys).toEqual([]);
    expect(readPendingRoomRequest(storage)).toEqual(joinRequest);
  });

  it('returns null without deleting the pending record when its storage read is denied', () => {
    const storage = new TargetReadDeniedStorage(PENDING_ROOM_REQUEST_KEY);
    storeRaw(storage, ACTIVE_ONLINE_SESSION_KEY, activeSession);

    expect(readPendingRoomRequest(storage)).toBeNull();
    expect(storage.removedKeys).toEqual([]);
    expect(readOnlineSession(storage)).toEqual(activeSession);
  });

  it('removes only a corrupt pending record and preserves a valid active session', () => {
    const storage = new MemoryStorage();
    storeRaw(storage, PENDING_ROOM_REQUEST_KEY, { ...createRequest, requestId: 'not-a-request-id' });
    commitOnlineSession(storage, activeSession);
    storeRaw(storage, PENDING_ROOM_REQUEST_KEY, { ...createRequest, requestId: 'not-a-request-id' });

    expect(readPendingRoomRequest(storage)).toBeNull();
    expect(storage.getItem(PENDING_ROOM_REQUEST_KEY)).toBeNull();
    expect(readOnlineSession(storage)).toEqual(activeSession);
  });

  it.each([
    '{not json',
    'null',
    '[]',
    JSON.stringify({ ...activeSession, extra: true }),
    JSON.stringify({ roomCode: 1234, playerId: activeSession.playerId, token: activeSession.token }),
    JSON.stringify({ ...activeSession, playerId: '' }),
    JSON.stringify({ ...activeSession, token: '   ' }),
    JSON.stringify({ ...activeSession, roomCode: '123' }),
  ])('rejects an invalid active schema: %s', (raw) => {
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, raw);

    expect(readOnlineSession(storage)).toBeNull();
    expect(storage.getItem(ACTIVE_ONLINE_SESSION_KEY)).toBeNull();
  });

  it.each([
    '{not json',
    'null',
    '[]',
    JSON.stringify({ ...createRequest, extra: true }),
    JSON.stringify({ ...createRequest, operation: 'resume' }),
    JSON.stringify({ ...createRequest, requestId: '0123' }),
    JSON.stringify({ ...createRequest, requestId: 'g123456789abcdef0123456789abcdef' }),
    JSON.stringify({ ...createRequest, nickname: '' }),
    JSON.stringify({ ...joinRequest, roomCode: '123' }),
    JSON.stringify({ ...joinRequest, roomCode: '' }),
    JSON.stringify({ ...joinRequest, roomCode: 1234 }),
    JSON.stringify({ ...createRequest, roomCode: '1234' }),
    JSON.stringify({ operation: 'join', requestId: joinRequest.requestId, roomCode: '5678', nickname: '小红' }),
    JSON.stringify({ ...joinRequest, role: 'host' }),
  ])('rejects an invalid pending schema: %s', (raw) => {
    const storage = new MemoryStorage();
    storage.setItem(PENDING_ROOM_REQUEST_KEY, raw);

    expect(readPendingRoomRequest(storage)).toBeNull();
    expect(storage.getItem(PENDING_ROOM_REQUEST_KEY)).toBeNull();
  });

  it('clears the active session while preserving a pending request', () => {
    const storage = new MemoryStorage();
    commitOnlineSession(storage, activeSession);
    savePendingRoomRequest(storage, joinRequest);

    expect(clearOnlineSession(storage)).toBe(true);

    expect(readOnlineSession(storage)).toBeNull();
    expect(storage.getItem(ACTIVE_ONLINE_SESSION_KEY)).toBeNull();
    expect(readPendingRoomRequest(storage)).toEqual(joinRequest);
  });

  it('does not throw when the storage rejects removing the active session', () => {
    class FailingActiveRemoveStorage extends MemoryStorage {
      override removeItem(key: string) {
        if (key === ACTIVE_ONLINE_SESSION_KEY) throw new Error('storage locked');
        super.removeItem(key);
      }
    }

    const storage = new FailingActiveRemoveStorage();
    commitOnlineSession(storage, activeSession);

    // Report the failure honestly instead of pretending the record was cleared.
    expect(clearOnlineSession(storage)).toBe(false);
    expect(readOnlineSession(storage)).not.toBeNull();
  });

  it('clears the pending request while preserving the active session, reporting success', () => {
    const storage = new MemoryStorage();
    commitOnlineSession(storage, activeSession);
    savePendingRoomRequest(storage, joinRequest);

    expect(clearPendingRoomRequest(storage)).toBe(true);

    expect(readPendingRoomRequest(storage)).toBeNull();
    expect(storage.getItem(PENDING_ROOM_REQUEST_KEY)).toBeNull();
    expect(readOnlineSession(storage)).toEqual(activeSession);
  });

  it('reports failure without throwing when the storage rejects removing the pending request', () => {
    class FailingPendingRemoveStorage extends MemoryStorage {
      override removeItem(key: string) {
        if (key === PENDING_ROOM_REQUEST_KEY) throw new Error('storage locked');
        super.removeItem(key);
      }
    }

    const storage = new FailingPendingRemoveStorage();
    savePendingRoomRequest(storage, joinRequest);

    expect(clearPendingRoomRequest(storage)).toBe(false);
    expect(readPendingRoomRequest(storage)).toEqual(joinRequest);
  });

  it.each([
    [PENDING_ROOM_REQUEST_KEY, [PENDING_ROOM_REQUEST_KEY]],
    [ACTIVE_ONLINE_SESSION_KEY, [PENDING_ROOM_REQUEST_KEY, ACTIVE_ONLINE_SESSION_KEY]],
  ] as const)('clears pending before active and preserves the active credential when %s removal fails', (deniedKey, removedKeys) => {
    class OrderedFailureStorage extends MemoryStorage {
      readonly calls: string[] = [];

      override removeItem(key: string) {
        this.calls.push(key);
        if (key === deniedKey) throw new Error('storage locked');
        super.removeItem(key);
      }
    }

    const storage = new OrderedFailureStorage();
    storage.setItem(ACTIVE_ONLINE_SESSION_KEY, JSON.stringify(activeSession));
    storage.setItem(PENDING_ROOM_REQUEST_KEY, JSON.stringify(joinRequest));

    expect(clearStoredOnlineSession(storage)).toBe(false);
    expect(storage.calls).toEqual(removedKeys);
    expect(readOnlineSession(storage)).toEqual(activeSession);
    expect(readPendingRoomRequest(storage)).toEqual(
      deniedKey === PENDING_ROOM_REQUEST_KEY ? joinRequest : null,
    );
  });

  it('round-trips a spectator join request and refuses to default a missing role to player', () => {
    const storage = new MemoryStorage();

    expect(savePendingRoomRequest(storage, spectatorJoinRequest)).toBe(true);
    expect(readPendingRoomRequest(storage)).toEqual(spectatorJoinRequest);

    storeRaw(storage, PENDING_ROOM_REQUEST_KEY, {
      operation: 'join',
      requestId: joinRequest.requestId,
      roomCode: joinRequest.roomCode,
      nickname: joinRequest.nickname,
    });
    expect(readPendingRoomRequest(storage)).toBeNull();
    expect(storage.getItem(PENDING_ROOM_REQUEST_KEY)).toBeNull();
  });
});
