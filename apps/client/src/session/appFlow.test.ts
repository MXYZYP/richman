import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ONLINE_NICKNAME,
  capRoomCode,
  classifyEntryFailure,
  isValidNickname,
  isValidRoomCode,
  normalizeNickname,
  normalizeRoomCode,
  planCreateSubmission,
  planJoinSubmission,
  planQuickCreate,
  resolvePage,
  type AppFlowSnapshot,
} from './appFlow';
import type { PendingRoomRequest } from './sessionStorage';

const createRequest: PendingRoomRequest = {
  operation: 'create',
  requestId: '0123456789abcdef0123456789abcdef',
  nickname: '房主',
  mapId: 'china-tour',
};

const joinRequest: PendingRoomRequest = {
  operation: 'join',
  requestId: 'fedcba9876543210fedcba9876543210',
  roomCode: '123456',
  nickname: '客人',
  role: 'player',
};

function online(overrides: Partial<AppFlowSnapshot> = {}): AppFlowSnapshot {
  return {
    stage: 'online',
    storedActive: false,
    pending: null,
    connection: 'connecting',
    room: null,
    gameOver: false,
    restoreDeferred: false,
    homePane: 'main',
    ...overrides,
  };
}

describe('resolvePage — page-state reducer', () => {
  describe('restore flow (stored active session, not yet in a room)', () => {
    it.each(['connecting', 'reconnecting', 'connected'] as const)(
      'shows the restoring page without failure while resume is in progress (%s)',
      (connection) => {
        const page = resolvePage(online({ storedActive: true, connection }));
        expect(page).toEqual({ kind: 'restoring', failure: null });
      },
    );

    it('marks the restore as transient when the connection failed but the session is still stored', () => {
      const page = resolvePage(online({ storedActive: true, connection: 'failed' }));
      expect(page).toEqual({ kind: 'restoring', failure: 'transient' });
    });

    it('prefers the active-session restore over a leftover pending request', () => {
      const page = resolvePage(online({ storedActive: true, pending: joinRequest, connection: 'reconnecting' }));
      expect(page).toEqual({ kind: 'restoring', failure: null });
    });

    it('falls back to the pure entry page once a permanent failure has cleared the stored session', () => {
      // Permanent failures (INVALID_TOKEN / ROOM_NOT_FOUND) clear storage before the
      // connection settles as failed, so storedActive is false here. Nothing is left to
      // resume, so the landing spot is the entry page itself rather than the online pane.
      const page = resolvePage(online({ storedActive: false, connection: 'failed', pending: null }));
      expect(page).toEqual({ kind: 'home' });
    });
  });

  describe('deferred restore (user chose 暂不恢复 — non-destructive)', () => {
    it('routes to the online pane while the stored session survives, offering an independent 回到上一局', () => {
      // 「回到上一局」这块提示住在在线页 ⇒ 停在入口页时自动落到那里。
      const page = resolvePage(online({ storedActive: true, restoreDeferred: true, connection: 'failed' }));
      expect(page).toEqual({ kind: 'online', resume: null, canResumeActive: true });
    });

    it('lands on the online pane even before the connection has settled as failed', () => {
      const page = resolvePage(online({ storedActive: true, restoreDeferred: true, connection: 'reconnecting' }));
      expect(page).toEqual({ kind: 'online', resume: null, canResumeActive: true });
    });

    it('stays on the online pane after a later transport connect while recovery remains deferred', () => {
      const page = resolvePage(online({ storedActive: true, restoreDeferred: true, connection: 'connected' }));
      expect(page).toEqual({ kind: 'online', resume: null, canResumeActive: true });
    });

    it('still surfaces a leftover pending request alongside the deferred active session', () => {
      const page = resolvePage(online({ storedActive: true, restoreDeferred: true, pending: joinRequest, connection: 'failed' }));
      expect(page).toEqual({ kind: 'online', resume: joinRequest, canResumeActive: true });
    });

    it('never defers when there is no stored session to return to', () => {
      const page = resolvePage(online({ storedActive: false, restoreDeferred: true, connection: 'failed' }));
      expect(page).toEqual({ kind: 'home' });
    });

    it('resumes the restore screen once the defer latch is cleared', () => {
      const page = resolvePage(online({ storedActive: true, restoreDeferred: false, connection: 'failed' }));
      expect(page).toEqual({ kind: 'restoring', failure: 'transient' });
    });
  });

  describe('home / online landing (no active session, not in a room)', () => {
    it('auto-lands on the online pane to offer a pending create request', () => {
      // 待续请求的提示住在在线页 ⇒ 停在入口页时自动落到那里，玩家才回得到自己那一局。
      const page = resolvePage(online({ storedActive: false, pending: createRequest }));
      expect(page).toEqual({ kind: 'online', resume: createRequest, canResumeActive: false });
    });

    it('auto-lands on the online pane to offer a pending join request', () => {
      const page = resolvePage(online({ storedActive: false, pending: joinRequest }));
      expect(page).toEqual({ kind: 'online', resume: joinRequest, canResumeActive: false });
    });

    it('shows the pure entry page when nothing is stored', () => {
      const page = resolvePage(online({ storedActive: false, pending: null, connection: 'connected' }));
      expect(page).toEqual({ kind: 'home' });
    });
  });

  describe('home pane routing (《UI 改造方案》§三)', () => {
    it.each(['online', 'stats', 'achievements', 'cloud', 'leaderboard'] as const)(
      'routes to the %s pane when the user navigated there',
      (pane) => {
        const page = resolvePage(online({ homePane: pane, connection: 'connected' }));
        expect(page.kind).toBe(pane);
      },
    );

    it('carries the resume payload when the online pane was opened explicitly', () => {
      const page = resolvePage(online({ homePane: 'online', pending: joinRequest }));
      expect(page).toEqual({ kind: 'online', resume: joinRequest, canResumeActive: false });
    });

    it('lets explicit navigation win over the resume auto-landing', () => {
      // 有东西可续、用户却点了「战绩」：必须真的去战绩页。不让导航压过自动落点的话，
      // 有待续请求时那个入口按钮看上去就是坏的。
      const page = resolvePage(online({ homePane: 'stats', pending: joinRequest, storedActive: false }));
      expect(page).toEqual({ kind: 'stats' });
    });

    it('lets explicit navigation win even with a deferred stored session', () => {
      const page = resolvePage(online({ homePane: 'leaderboard', storedActive: true, restoreDeferred: true }));
      expect(page).toEqual({ kind: 'leaderboard' });
    });

    it('keeps the entry page as the paneless default', () => {
      const page = resolvePage(online({ homePane: 'main', pending: null, storedActive: false }));
      expect(page).toEqual({ kind: 'home' });
    });
  });

  describe('recovered online room routing', () => {
    it('routes a lobby room to the lobby page', () => {
      const page = resolvePage(online({ storedActive: true, room: 'lobby', connection: 'connected' }));
      expect(page).toEqual({ kind: 'lobby' });
    });

    it('routes a playing room to the game page', () => {
      const page = resolvePage(online({ storedActive: true, room: 'playing', connection: 'connected' }));
      expect(page).toEqual({ kind: 'game' });
    });

    it('routes an ended room to the settlement page', () => {
      const page = resolvePage(online({ storedActive: true, room: 'ended', connection: 'connected' }));
      expect(page).toEqual({ kind: 'settlement' });
    });

    it('recovery into a room overrides the restoring page', () => {
      const page = resolvePage(online({ storedActive: true, room: 'playing', connection: 'reconnecting' }));
      expect(page).toEqual({ kind: 'game' });
    });

    it('treats a game_over snapshot as settlement even while the room still reports playing', () => {
      // Ended-priority guard: a stale playing room must never render the game page
      // when the authoritative snapshot has already ended.
      const page = resolvePage(online({ storedActive: true, room: 'playing', gameOver: true, connection: 'connected' }));
      expect(page).toEqual({ kind: 'settlement' });
    });

    it('routes an ended room to settlement even without a game_over snapshot', () => {
      const page = resolvePage(online({ storedActive: true, room: 'ended', gameOver: false, connection: 'connected' }));
      expect(page).toEqual({ kind: 'settlement' });
    });
  });

  describe('local flow', () => {
    it('shows the local setup page while configuring a hot-seat game', () => {
      expect(resolvePage(online({ stage: 'local_setup' }))).toEqual({ kind: 'local_setup' });
    });

    it('shows the game page for a running local session', () => {
      expect(resolvePage(online({ stage: 'local_game', gameOver: false }))).toEqual({ kind: 'game' });
    });

    it('shows the settlement page when the local game is over', () => {
      expect(resolvePage(online({ stage: 'local_game', gameOver: true }))).toEqual({ kind: 'settlement' });
    });

    it('ignores online storage facts while in a local stage', () => {
      const page = resolvePage(online({ stage: 'local_game', storedActive: true, room: 'lobby', connection: 'failed' }));
      expect(page).toEqual({ kind: 'game' });
    });
  });
});

describe('room code normalization and validation', () => {
  it('strips ASCII whitespace from raw room input', () => {
    expect(normalizeRoomCode(' 12 34 ')).toBe('1234');
    expect(normalizeRoomCode('1\t2\n3\r4')).toBe('1234');
    expect(normalizeRoomCode('\f\v0123\u000b')).toBe('0123');
  });

  it('accepts exactly six ASCII digits', () => {
    expect(isValidRoomCode('123456')).toBe(true);
    expect(isValidRoomCode('012345')).toBe(true);
  });

  it('rejects anything that is not six ASCII digits', () => {
    expect(isValidRoomCode('12345')).toBe(false);
    expect(isValidRoomCode('1234567')).toBe(false);
    expect(isValidRoomCode('12ab34')).toBe(false);
    expect(isValidRoomCode('')).toBe(false);
    expect(isValidRoomCode('１２３４５６')).toBe(false); // full-width digits
    expect(isValidRoomCode(' 123456 ')).toBe(false); // caller must normalize first
  });
});

describe('nickname normalization and validation', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeNickname('  房主  ')).toBe('房主');
  });

  it('accepts any non-empty trimmed nickname and rejects blank input', () => {
    expect(isValidNickname('房主')).toBe(true);
    expect(isValidNickname('   ')).toBe(false);
    expect(isValidNickname('')).toBe(false);
  });
});

describe('capRoomCode — normalize before capping (never raw maxlength truncation)', () => {
  it('strips internal whitespace from a pasted code before capping to six digits', () => {
    expect(capRoomCode('12 3456')).toBe('123456');
    expect(capRoomCode(' 12 3456 ')).toBe('123456');
  });

  it('caps to the first six ASCII characters only after normalization', () => {
    // Raw maxlength=6 would truncate "12 34 56" to "12 34 " then strip to "1234 "; normalization first avoids that.
    expect(capRoomCode('12 34 567')).toBe('123456');
    expect(capRoomCode('1234567')).toBe('123456');
  });

  it('leaves a clean six-digit code untouched and preserves leading zeros', () => {
    expect(capRoomCode('012345')).toBe('012345');
    expect(capRoomCode('')).toBe('');
  });
});

describe('planCreateSubmission — explicit single create action', () => {
  it('returns a trimmed nickname payload for a valid, idle create', () => {
    expect(planCreateSubmission('  房主  ', false)).toEqual({ nickname: '房主' });
  });

  it('refuses to submit while already submitting (no accidental double-trigger)', () => {
    expect(planCreateSubmission('房主', true)).toBeNull();
  });

  it('refuses a blank nickname', () => {
    expect(planCreateSubmission('   ', false)).toBeNull();
    expect(planCreateSubmission('', false)).toBeNull();
  });
});

describe('planJoinSubmission — explicit single join action', () => {
  it('returns a normalized room-code and trimmed nickname for a valid, idle join', () => {
    expect(planJoinSubmission('12 3456', '  客人 ', false)).toEqual({ roomCode: '123456', nickname: '客人', role: 'player' });
  });

  it('refuses to submit while already submitting', () => {
    expect(planJoinSubmission('123456', '客人', true)).toBeNull();
  });

  it('refuses an invalid room code', () => {
    expect(planJoinSubmission('12', '客人', false)).toBeNull();
    expect(planJoinSubmission('１２３４５６', '客人', false)).toBeNull();
  });

  it('refuses a blank nickname even with a valid room code', () => {
    expect(planJoinSubmission('123456', '   ', false)).toBeNull();
  });

  it('carries an explicit spectator role through a valid join payload', () => {
    expect(planJoinSubmission('123456', '观众', false, 'spectator')).toEqual({
      roomCode: '123456',
      nickname: '观众',
      role: 'spectator',
    });
  });
});

describe('classifyEntryFailure — definitive vs transient entry errors', () => {
  it.each(['ROOM_NOT_FOUND', 'ROOM_FULL', 'NICKNAME_TAKEN', 'GAME_ALREADY_STARTED', 'INVALID_NICKNAME', 'INVALID_ROOM_ACTION'])(
    'treats %s as definitive (same-id retry is futile — offer abandon)',
    (code) => {
      expect(classifyEntryFailure(code)).toBe('definitive');
    },
  );

  it.each(['REQUEST_TIMEOUT', 'DISCONNECTED', 'OPERATION_IN_PROGRESS', 'SESSION_NOT_RECOVERED', 'CREATE_RATE_LIMITED', 'SOME_UNKNOWN_CODE'])(
    'treats %s as transient (default same-id retry)',
    (code) => {
      expect(classifyEntryFailure(code)).toBe('transient');
    },
  );
});

/**
 * 首页「在线联网对战」的一键开房判定。
 *
 * 与 planCreateSubmission 的差别只有一处，但正是那一处决定了按钮是「一键」还是「两步」：
 * 空昵称在这里是**合法**输入，会被补成默认名。
 */
describe("planQuickCreate（首页一键开房）", () => {
  it('昵称留空时补默认名，而不是拒绝 —— 否则一键就退化成两步', () => {
    expect(planQuickCreate('', false)).toEqual({ nickname: DEFAULT_ONLINE_NICKNAME });
    expect(planQuickCreate('   ', false)).toEqual({ nickname: DEFAULT_ONLINE_NICKNAME });
    expect(planQuickCreate('\t\n', false)).toEqual({ nickname: DEFAULT_ONLINE_NICKNAME });
  });

  it('填了昵称就用填的（去首尾空白），与手动建房完全一致', () => {
    expect(planQuickCreate('  阿蒙 ', false)).toEqual({ nickname: '阿蒙' });
  });

  it('正在提交时返回 null，连点开不出两间房', () => {
    expect(planQuickCreate('阿蒙', true)).toBeNull();
    expect(planQuickCreate('', true)).toBeNull();
  });

  it('默认名与战绩提交的兜底是同一个 —— 两处一漂移，排行榜上就认不出自己', () => {
    expect(DEFAULT_ONLINE_NICKNAME).toBe('大富翁玩家');
  });
});
