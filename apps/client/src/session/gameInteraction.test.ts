import { describe, expect, it } from 'vitest';
import type { PublicRoomPlayer, PublicRoomState } from '@richman/protocol';
import { getGameInteractionState, type GameInteractionInput } from './gameInteraction';
import type { RenderableGameState } from './gameSession';
import { getActiveMapPack } from '@richman/board-data';

// ---- Fixtures -------------------------------------------------------------
// The selector reads only a handful of fields off state/room, so the fixtures
// stay minimal and are cast to the display-safe shapes the view actually holds.

const ME = 'p1';
const OTHER = 'p2';
const BOT = 'p3';
const chinaMapPack = getActiveMapPack('china-tour');

function player(id: string, over: Partial<PublicRoomPlayer> = {}): PublicRoomPlayer {
  return { id, nickname: id.toUpperCase(), isBot: false, online: true, ...over };
}

function room(over: Partial<PublicRoomState> = {}): PublicRoomState {
  return {
    roomCode: '123456',
    status: 'playing',
    hostId: ME,
    takeoverPlayerId: null,
    players: [player(ME), player(OTHER), player(BOT, { isBot: true })],
    spectators: [],
    map: { ref: chinaMapPack.ref, title: chinaMapPack.metadata.title },
    ...over,
  };
}

function gameState(over: Partial<RenderableGameState> = {}): RenderableGameState {
  return {
    phase: 'playing',
    turnPhase: 'awaiting_roll',
    currentPlayerId: ME,
    debt: null,
    players: [
      { id: ME, nickname: 'P1', isBot: false, online: true },
      { id: OTHER, nickname: 'P2', isBot: false, online: true },
      { id: BOT, nickname: 'P3', isBot: true, online: true },
    ],
    ...over,
  } as unknown as RenderableGameState;
}

function online(over: Partial<GameInteractionInput> = {}): GameInteractionInput {
  return {
    mode: 'online',
    state: gameState(),
    room: room(),
    localPlayerId: ME,
    connectionStatus: 'connected',
    isAnimating: false,
    compatibilityError: null,
    ...over,
  };
}

// ---- Matrix ---------------------------------------------------------------

describe('getGameInteractionState — local hot-seat', () => {
  it('always controls the current actor, never skips, shows the seat turn title', () => {
    const result = getGameInteractionState({
      mode: 'local',
      state: gameState({ currentPlayerId: OTHER }),
      room: null,
      localPlayerId: null,
      connectionStatus: 'local',
      isAnimating: false,
      compatibilityError: null,
    });
    expect(result).toEqual({
      kind: 'local',
      message: '轮到 P2',
      canSendIntent: true,
      canSkipOfflineTurn: false,
      requiresLeaveConfirm: false,
    });
  });

  it('locks intents while the local board animates but stays in the local kind', () => {
    const result = getGameInteractionState({
      mode: 'local',
      state: gameState(),
      room: null,
      localPlayerId: null,
      connectionStatus: 'local',
      isAnimating: true,
      compatibilityError: null,
    });
    expect(result.kind).toBe('local');
    expect(result.canSendIntent).toBe(false);
    expect(result.canSkipOfflineTurn).toBe(false);
  });

  it('keeps local control during a local debt so the debtor can liquidate', () => {
    const result = getGameInteractionState({
      mode: 'local',
      state: gameState({ currentPlayerId: OTHER, debt: { debtorId: OTHER, amount: 500 } as never }),
      room: null,
      localPlayerId: null,
      connectionStatus: 'local',
      isAnimating: false,
      compatibilityError: null,
    });
    expect(result.kind).toBe('local');
    expect(result.canSendIntent).toBe(true);
  });
});

describe('getGameInteractionState — online connection recovery', () => {
  it('reports reconnecting and locks every action', () => {
    const result = getGameInteractionState(online({ connectionStatus: 'reconnecting' }));
    expect(result).toEqual({
      kind: 'reconnecting',
      message: '正在重新连接…',
      canSendIntent: false,
      canSkipOfflineTurn: false,
      requiresLeaveConfirm: true,
    });
  });

  it('treats the initial connecting phase as a reconnecting lock', () => {
    const result = getGameInteractionState(online({ connectionStatus: 'connecting' }));
    expect(result.kind).toBe('reconnecting');
    expect(result.canSendIntent).toBe(false);
  });

  it('reports a failed connection with everything locked', () => {
    const result = getGameInteractionState(online({ connectionStatus: 'failed' }));
    expect(result).toEqual({
      kind: 'failed',
      message: '连接已断开',
      canSendIntent: false,
      canSkipOfflineTurn: false,
      requiresLeaveConfirm: true,
    });
  });

  it('recovery lock beats an otherwise-your-turn state', () => {
    const result = getGameInteractionState(online({
      connectionStatus: 'reconnecting',
      state: gameState({ currentPlayerId: ME }),
    }));
    expect(result.kind).toBe('reconnecting');
    expect(result.canSendIntent).toBe(false);
  });
});

describe('getGameInteractionState — online turn ownership', () => {
  it('your own live turn can send intents', () => {
    const result = getGameInteractionState(online({ state: gameState({ currentPlayerId: ME }) }));
    expect(result).toEqual({
      kind: 'your_turn',
      message: '轮到你',
      canSendIntent: true,
      canSkipOfflineTurn: false,
      requiresLeaveConfirm: true,
    });
  });

  it('your turn locks intents while the board animates', () => {
    const result = getGameInteractionState(online({
      state: gameState({ currentPlayerId: ME }),
      isAnimating: true,
    }));
    expect(result.kind).toBe('your_turn');
    expect(result.canSendIntent).toBe(false);
  });

  it("another online human's turn only waits", () => {
    const result = getGameInteractionState(online({ state: gameState({ currentPlayerId: OTHER }) }));
    expect(result).toEqual({
      kind: 'other_turn',
      message: '等待 P2 行动',
      canSendIntent: false,
      canSkipOfflineTurn: false,
      requiresLeaveConfirm: true,
    });
  });

  it("a bot's turn waits and never offers a skip", () => {
    const result = getGameInteractionState(online({ state: gameState({ currentPlayerId: BOT }) }));
    expect(result).toEqual({
      kind: 'bot_turn',
      message: '电脑 P3 行动中',
      canSendIntent: false,
      canSkipOfflineTurn: false,
      requiresLeaveConfirm: true,
    });
  });
});

describe('getGameInteractionState — offline actor and host takeover', () => {
  it('host may skip an offline human turn', () => {
    const result = getGameInteractionState(online({
      state: gameState({ currentPlayerId: OTHER }),
      room: room({ hostId: ME, players: [player(ME), player(OTHER, { online: false }), player(BOT, { isBot: true })] }),
    }));
    expect(result).toEqual({
      kind: 'offline_turn',
      message: 'P2 已离线，等待重连',
      canSendIntent: false,
      canSkipOfflineTurn: true,
      requiresLeaveConfirm: true,
    });
  });

  it('a non-host cannot skip an offline turn', () => {
    const result = getGameInteractionState(online({
      localPlayerId: OTHER,
      state: gameState({ currentPlayerId: ME }),
      room: room({ hostId: BOT, players: [player(ME, { online: false }), player(OTHER), player(BOT, { isBot: true })] }),
    }));
    expect(result.kind).toBe('offline_turn');
    expect(result.canSkipOfflineTurn).toBe(false);
  });

  it('no skip once the offline turn is already being taken over', () => {
    const result = getGameInteractionState(online({
      state: gameState({ currentPlayerId: OTHER }),
      room: room({ hostId: ME, takeoverPlayerId: ME, players: [player(ME), player(OTHER, { online: false }), player(BOT, { isBot: true })] }),
    }));
    expect(result.kind).toBe('takeover');
    expect(result.canSkipOfflineTurn).toBe(false);
    expect(result.canSendIntent).toBe(false);
  });

  it('the host running a takeover sees the takeover-in-progress message', () => {
    const result = getGameInteractionState(online({
      state: gameState({ currentPlayerId: OTHER }),
      room: room({ hostId: ME, takeoverPlayerId: ME, players: [player(ME), player(OTHER, { online: false }), player(BOT, { isBot: true })] }),
    }));
    expect(result.message).toBe('房主托管正在执行');
  });

  it('a takeover blocked on the debtor asks for them to return', () => {
    const result = getGameInteractionState(online({
      state: gameState({ currentPlayerId: OTHER, debt: { debtorId: OTHER, amount: 300 } as never }),
      room: room({ hostId: ME, takeoverPlayerId: ME, players: [player(ME), player(OTHER, { online: false }), player(BOT, { isBot: true })] }),
    }));
    expect(result.kind).toBe('takeover');
    expect(result.message).toBe('需要 P2 回来处理债务');
  });

  it('a non-host viewer sees the neutral takeover banner', () => {
    const result = getGameInteractionState(online({
      localPlayerId: OTHER,
      state: gameState({ currentPlayerId: BOT }),
      room: room({ hostId: ME, takeoverPlayerId: ME, players: [player(ME), player(OTHER), player(BOT, { isBot: true, online: false })] }),
    }));
    expect(result.kind).toBe('takeover');
    expect(result.message).toBe('房主正在托管本回合');
  });
});

describe('getGameInteractionState — debt priority', () => {
  it('your own debt keeps you in control to liquidate', () => {
    const result = getGameInteractionState(online({
      state: gameState({ currentPlayerId: ME, debt: { debtorId: ME, amount: 800 } as never }),
    }));
    expect(result).toEqual({
      kind: 'debt',
      message: '请处理你的债务',
      canSendIntent: true,
      canSkipOfflineTurn: false,
      requiresLeaveConfirm: true,
    });
  });

  it("another player's debt waits and never offers a skip", () => {
    const result = getGameInteractionState(online({
      state: gameState({ currentPlayerId: OTHER, debt: { debtorId: OTHER, amount: 800 } as never }),
    }));
    expect(result).toEqual({
      kind: 'debt',
      message: '等待 P2 处理债务',
      canSendIntent: false,
      canSkipOfflineTurn: false,
      requiresLeaveConfirm: true,
    });
  });

  it('debt suppresses the offline skip affordance for the host', () => {
    const result = getGameInteractionState(online({
      state: gameState({ currentPlayerId: OTHER, debt: { debtorId: OTHER, amount: 800 } as never }),
      room: room({ hostId: ME, players: [player(ME), player(OTHER, { online: false }), player(BOT, { isBot: true })] }),
    }));
    expect(result.kind).toBe('debt');
    expect(result.canSkipOfflineTurn).toBe(false);
  });

  it('takeover outranks debt in the message priority', () => {
    const result = getGameInteractionState(online({
      state: gameState({ currentPlayerId: OTHER, debt: { debtorId: OTHER, amount: 800 } as never }),
      room: room({ hostId: ME, takeoverPlayerId: ME, players: [player(ME), player(OTHER, { online: false }), player(BOT, { isBot: true })] }),
    }));
    expect(result.kind).toBe('takeover');
  });
});

describe('getGameInteractionState — degenerate inputs', () => {
  it('a null state during online sync waits without crashing', () => {
    const result = getGameInteractionState(online({ state: null }));
    expect(result.canSendIntent).toBe(false);
    expect(result.canSkipOfflineTurn).toBe(false);
  });

  it('keeps an exact-map compatibility failure visible and non-interactive while connected', () => {
    const result = getGameInteractionState(online({
      state: null,
      compatibilityError: '当前客户端缺少房间所需地图，请刷新或更新后重试。',
    }));

    expect(result).toMatchObject({
      kind: 'incompatible',
      message: '当前客户端缺少房间所需地图，请刷新或更新后重试。',
      canSendIntent: false,
      canSkipOfflineTurn: false,
    });
  });

  it('game over never allows a skip', () => {
    const result = getGameInteractionState(online({
      state: gameState({ phase: 'game_over', currentPlayerId: OTHER }),
      room: room({ hostId: ME, players: [player(ME), player(OTHER, { online: false }), player(BOT, { isBot: true })] }),
    }));
    expect(result.canSkipOfflineTurn).toBe(false);
  });
});

describe('getGameInteractionState — leave confirmation', () => {
  it('never asks a local hot-seat game to confirm before restarting', () => {
    const result = getGameInteractionState({
      mode: 'local',
      state: gameState(),
      room: null,
      localPlayerId: null,
      connectionStatus: 'local',
      isAnimating: false,
      compatibilityError: null,
    });
    expect(result.requiresLeaveConfirm).toBe(false);
  });

  it('always confirms an online exit, whatever the connection state', () => {
    for (const connectionStatus of ['connected', 'connecting', 'reconnecting', 'failed'] as const) {
      const result = getGameInteractionState(online({ connectionStatus }));
      expect(result.requiresLeaveConfirm).toBe(true);
    }
  });

  it('confirms an online exit from a finished game just as from a live one', () => {
    const ended = getGameInteractionState(online({ state: gameState({ phase: 'game_over' }) }));
    expect(ended.requiresLeaveConfirm).toBe(true);
    const failedEnded = getGameInteractionState(online({
      connectionStatus: 'failed',
      state: gameState({ phase: 'game_over' }),
    }));
    expect(failedEnded.requiresLeaveConfirm).toBe(true);
  });
});

describe('getGameInteractionState — spectating', () => {
  const SPEC = 'spec-1';
  const spectatingRoom = () => room({
    spectators: [{ id: SPEC, nickname: '观众甲', online: true }],
  });

  it('locks every write path and names the spectator state', () => {
    const result = getGameInteractionState(online({
      localPlayerId: SPEC,
      room: spectatingRoom(),
      state: gameState({ currentPlayerId: ME }),
    }));
    expect(result).toEqual({
      kind: 'spectating',
      message: '观战中',
      canSendIntent: false,
      canSkipOfflineTurn: false,
      requiresLeaveConfirm: true,
    });
  });

  it('does not offer host skip even when the current actor is offline', () => {
    const result = getGameInteractionState(online({
      localPlayerId: SPEC,
      room: room({
        hostId: ME,
        spectators: [{ id: SPEC, nickname: '观众甲', online: true }],
        players: [player(ME), player(OTHER, { online: false }), player(BOT, { isBot: true })],
      }),
      state: gameState({ currentPlayerId: OTHER }),
    }));
    expect(result.kind).toBe('spectating');
    expect(result.canSkipOfflineTurn).toBe(false);
    expect(result.canSendIntent).toBe(false);
  });

  it('still surfaces connection recovery above the spectator banner', () => {
    const result = getGameInteractionState(online({
      localPlayerId: SPEC,
      room: spectatingRoom(),
      connectionStatus: 'reconnecting',
    }));
    expect(result.kind).toBe('reconnecting');
    expect(result.canSendIntent).toBe(false);
  });

  it('never treats a local hot-seat as spectating', () => {
    const result = getGameInteractionState({
      mode: 'local',
      state: gameState(),
      room: spectatingRoom(),
      localPlayerId: SPEC,
      connectionStatus: 'local',
      isAnimating: false,
      compatibilityError: null,
    });
    expect(result.kind).toBe('local');
    expect(result.canSendIntent).toBe(true);
  });
});
