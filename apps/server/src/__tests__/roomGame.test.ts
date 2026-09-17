import { describe, expect, test } from 'vitest';
import { getActiveMapPack } from '@richman/board-data';
import { applyIntent, chooseBotIntent, createGame } from '@richman/engine';
import type { ApplyResult, GameEvent, GameState, Intent, PlayerState } from '@richman/engine';
import { RoomManager } from '../rooms/roomManager';
import type { PublicRoomState } from '@richman/protocol';
import type { GameActionResult, RoomDomainEvent, RoomManagerDependencies } from '../rooms/roomTypes';
import type { GameRuntimeGateway } from '../game/gameRuntime';

type TimerHandle = {
  callback: () => void;
  delayMs: number;
  active: boolean;
};
const chinaMapPack = getActiveMapPack('china-tour');
const CHINA_MAP_SUMMARY = { ref: chinaMapPack.ref, title: chinaMapPack.metadata.title };

type HarnessOptions = {
  playerIds?: string[];
  tokens?: string[];
  roomNumbers?: number[];
  seed?: string;
  delays?: number[];
  gameGateway?: GameRuntimeGateway;
  onServerError?: (message: string, error: unknown) => void;
};

function createChinaRoom<TTimerHandle>(
  manager: Pick<RoomManager<TTimerHandle>, 'createRoom'>,
  nickname: string,
  requestId?: string,
) {
  return manager.createRoom(nickname, 'china-tour', requestId);
}

function createHarness(options: HarnessOptions = {}) {
  const roomNumbers = options.roomNumbers ?? [7];
  const playerIds = options.playerIds ?? [];
  const tokens = options.tokens ?? [];
  const delays = options.delays ?? [];
  const asyncEvents: RoomDomainEvent[] = [];
  const timers: TimerHandle[] = [];
  let roomNumberIndex = 0;
  let playerIdIndex = 0;
  let tokenIndex = 0;
  let delayIndex = 0;

  const dependencies: RoomManagerDependencies<TimerHandle> = {
    generatePlayerId() {
      const nextIndex = playerIdIndex;
      playerIdIndex += 1;
      return playerIds[nextIndex] ?? `player-${nextIndex}`;
    },
    generateToken() {
      const nextIndex = tokenIndex;
      tokenIndex += 1;
      return tokens[nextIndex] ?? `token-${nextIndex}`;
    },
    nextRoomNumber() {
      const nextIndex = roomNumberIndex;
      roomNumberIndex += 1;
      return roomNumbers[nextIndex] ?? nextIndex;
    },
    compareTokens(actual, supplied) {
      return actual === supplied;
    },
    setTimer(callback, delayMs) {
      let handle: TimerHandle;
      handle = {
        delayMs,
        active: true,
        callback: () => {
          handle.active = false;
          callback();
        },
      };
      timers.push(handle);
      return handle;
    },
    clearTimer(handle) {
      handle.active = false;
    },
    onAsyncEvents(events) {
      asyncEvents.push(...events);
    },
    generateGameSeed() {
      return options.seed ?? 'game-seed';
    },
    nextAutomationDelayMs() {
      const nextIndex = delayIndex;
      delayIndex += 1;
      return delays[nextIndex] ?? 1000;
    },
    gameGateway: options.gameGateway,
    onServerError: options.onServerError,
  };

  const manager = new RoomManager<TimerHandle>(dependencies);
  return { manager, asyncEvents, timers };
}

function createTwoHumanLobby(seed = 'game-seed') {
  const harness = createHarness({
    playerIds: ['host', 'guest'],
    tokens: ['tok-host', 'tok-guest'],
    seed,
  });

  const created = createChinaRoom(harness.manager, '房主');
  expect(created.ok).toBe(true);
  const joined = harness.manager.joinRoom('0007', '客人');
  expect(joined.ok).toBe(true);

  return harness;
}


type StartedRoomOptions = HarnessOptions & {
  secondPlayer?: 'guest' | 'bot';
};

function startedRoomWith(options: StartedRoomOptions = {}) {
  const secondPlayer = options.secondPlayer ?? 'guest';
  const harness = createHarness({
    ...options,
    playerIds: options.playerIds ?? (secondPlayer === 'bot' ? ['host', 'bot'] : ['host', 'guest']),
    tokens: options.tokens ?? (secondPlayer === 'bot' ? ['tok-host'] : ['tok-host', 'tok-guest']),
  });

  const created = createChinaRoom(harness.manager, '房主');
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(`createRoom failed: ${created.code}`);

  if (secondPlayer === 'bot') {
    const added = harness.manager.addBot('0007', 'host');
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error(`addBot failed: ${added.code}`);
  } else {
    const joined = harness.manager.joinRoom('0007', '客人');
    expect(joined.ok).toBe(true);
    if (!joined.ok) throw new Error(`joinRoom failed: ${joined.code}`);
  }

  const started = harness.manager.startRoom('0007', 'host');
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(`startRoom failed: ${started.code}`);

  const snapshotEvent = started.events.find((event) => event.type === 'game_snapshot');
  expect(snapshotEvent?.type).toBe('game_snapshot');
  if (snapshotEvent?.type !== 'game_snapshot') {
    throw new Error('startRoom did not emit a game_snapshot');
  }

  return { ...harness, started, state: snapshotEvent.state };
}

function seedWithBotFirst(players: { id: string; nickname: string; isBot: boolean }[], botId: string): string {
  for (let index = 0; index < 5000; index += 1) {
    const seed = `bot-first-${index}`;
    const state = createGame({
      mapRef: chinaMapPack.ref,
      ruleModules: chinaMapPack.game.requiredRuleModules,
      board: chinaMapPack.game.board,
      cards: chinaMapPack.game.cards,
      config: chinaMapPack.game.config,
      players,
      seed,
      cashGoal: null,
    });
    if (state.currentPlayerId === botId) {
      return seed;
    }
  }

  throw new Error(`no bot-first seed found for ${botId} within 5000 deterministic seeds`);
}

function startedBotFirstRoom(options: HarnessOptions = {}) {
  const botPlayers = [
    { id: 'host', nickname: '房主', isBot: false },
    { id: 'botA', nickname: '电脑 A', isBot: true },
  ];
  const seed = options.seed ?? seedWithBotFirst(botPlayers, 'botA');
  const harness = createHarness({
    ...options,
    playerIds: options.playerIds ?? ['host', 'botA'],
    tokens: options.tokens ?? ['tok-host'],
    seed,
  });

  const created = createChinaRoom(harness.manager, '房主');
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(`createRoom failed: ${created.code}`);

  const added = harness.manager.addBot('0007', 'host');
  expect(added.ok).toBe(true);
  if (!added.ok) throw new Error(`addBot failed: ${added.code}`);

  const started = harness.manager.startRoom('0007', 'host');
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(`startRoom failed: ${started.code}`);
  expect(started.events.map((event) => event.type)).toEqual(['room_state', 'game_snapshot']);

  const snapshotEvent = started.events.find((event) => event.type === 'game_snapshot');
  expect(snapshotEvent?.type).toBe('game_snapshot');
  if (snapshotEvent?.type !== 'game_snapshot') {
    throw new Error('startRoom did not emit a game_snapshot');
  }
  expect(snapshotEvent.state.currentPlayerId).toBe('botA');

  return { ...harness, seed, started, state: snapshotEvent.state };
}

function startedRoomBotFirstWithGateway(
  botActorId: 'botA' | 'botB',
  gameGateway: GameRuntimeGateway,
  options: Omit<HarnessOptions, 'gameGateway'> = {},
) {
  const players = [
    { id: 'host', nickname: '房主', isBot: false },
    { id: 'botA', nickname: '电脑 A', isBot: true },
    { id: 'botB', nickname: '电脑 B', isBot: true },
  ];
  const seed = options.seed ?? seedWithBotFirst(players, botActorId);
  const harness = createHarness({
    ...options,
    gameGateway,
    playerIds: options.playerIds ?? ['host', 'botA', 'botB'],
    tokens: options.tokens ?? ['tok-host'],
    seed,
  });

  const created = createChinaRoom(harness.manager, '房主');
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(`createRoom failed: ${created.code}`);

  for (const _ of ['botA', 'botB']) {
    const added = harness.manager.addBot('0007', 'host');
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error(`addBot failed: ${added.code}`);
  }

  const started = harness.manager.startRoom('0007', 'host');
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(`startRoom failed: ${started.code}`);

  const snapshotEvent = started.events.find((event) => event.type === 'game_snapshot');
  expect(snapshotEvent?.type).toBe('game_snapshot');
  if (snapshotEvent?.type !== 'game_snapshot') {
    throw new Error('startRoom did not emit a game_snapshot');
  }
  expect(snapshotEvent.state.currentPlayerId).toBe(botActorId);

  return { ...harness, seed, started, state: snapshotEvent.state };
}

function debtInjectingGateway(debtorId: 'botB' | 'host'): {
  gateway: GameRuntimeGateway;
  chooseCalls: () => string[];
  applyCalls: () => string[];
} {
  const chosen: string[] = [];
  const applied: string[] = [];

  return {
    chooseCalls: () => [...chosen],
    applyCalls: () => [...applied],
    gateway: {
      createGame,
      chooseBotIntent(_state, playerId) {
        chosen.push(playerId);
        return { type: 'end_turn' };
      },
      applyIntent(state, playerId) {
        applied.push(playerId);
        if (playerId === 'botA') {
          const event: GameEvent = { type: 'debt_entered', debtorId, creditorId: null, amount: 100 };
          return {
            ok: true,
            state: {
              ...state,
              debt: { debtorId, creditorId: null, amount: 100 },
              turnPhase: 'managing',
              recentLog: [...state.recentLog, event].slice(-200),
            },
            events: [event],
          };
        }

        if (playerId === 'host' && state.debt?.debtorId === 'host') {
          const event: GameEvent = { type: 'debt_resolved', amount: state.debt.amount, creditorId: null };
          return {
            ok: true,
            state: {
              ...state,
              debt: null,
              currentPlayerId: 'botB',
              turnPhase: 'awaiting_roll',
              recentLog: [...state.recentLog, event].slice(-200),
            },
            events: [event],
          };
        }

        if (playerId === 'botB') {
          const event: GameEvent = { type: 'turn_ended', playerId };
          return {
            ok: true,
            state: {
              ...state,
              debt: null,
              currentPlayerId: 'host',
              turn: state.turn + 1,
              recentLog: [...state.recentLog, event].slice(-200),
            },
            events: [event],
          };
        }

        return { ok: false, code: 'ILLEGAL_INTENT' };
      },
    },
  };
}

function engineActor(state: GameState): string {
  return state.debt?.debtorId ?? state.currentPlayerId;
}

function activeTimers(timers: TimerHandle[]): TimerHandle[] {
  return timers.filter((timer) => timer.active);
}

function completeEngineTurn(
  initialState: GameState,
  maxSteps: number,
): { state: GameState; events: GameEvent[]; steps: number } | null {
  let state = initialState;
  const events: GameEvent[] = [];

  for (let step = 1; step <= maxSteps; step += 1) {
    const actorId = engineActor(state);
    const result = applyIntent(state, actorId, intentForTurnPhase(state));
    if (!result.ok) return null;

    state = result.state;
    events.push(...result.events);
    if (result.events.some((event) => event.type === 'turn_ended')) {
      return { state, events, steps: step };
    }
  }

  return null;
}

function seedWithHumanThenBot(players: { id: string; nickname: string; isBot: boolean }[]): string {
  const humanCount = players.filter((player) => !player.isBot).length;
  const botCount = players.filter((player) => player.isBot).length;
  if (players.length !== 3 || humanCount !== 2 || botCount !== 1) {
    throw new Error(`seedWithHumanThenBot requires exactly three seats with two humans and one bot`);
  }

  let lastChecked = 'none';
  for (let index = 0; index < 5000; index += 1) {
    const seed = `human-then-bot-${index}`;
    const state = createGame({
      mapRef: chinaMapPack.ref,
      ruleModules: chinaMapPack.game.requiredRuleModules,
      board: chinaMapPack.game.board,
      cards: chinaMapPack.game.cards,
      config: chinaMapPack.game.config,
      players,
      seed,
      cashGoal: null,
    });
    const firstActorId = engineActor(state);
    const firstActor = state.players.find((player) => player.id === firstActorId);
    if (firstActor === undefined || firstActor.isBot) {
      lastChecked = `${seed}: first actor ${firstActorId} was not a human`;
      continue;
    }

    const completed = completeEngineTurn(state, 8);
    if (completed === null) {
      lastChecked = `${seed}: human turn did not complete within 8 real phase intents`;
      continue;
    }

    const nextActorId = engineActor(completed.state);
    const nextActor = completed.state.players.find((player) => player.id === nextActorId);
    if (nextActor?.isBot) {
      return seed;
    }
    lastChecked = `${seed}: first human ${firstActorId} handed to ${nextActorId}, not a bot`;
  }

  throw new Error(
    `no deterministic three-seat human→BOT seed found within 5000 attempts; expected first actor human and next actor bot after a real completed human turn; last checked ${lastChecked}`,
  );
}

function startedHumanThenBotRoom(options: HarnessOptions = {}) {
  const players = [
    { id: 'host', nickname: '房主', isBot: false },
    { id: 'guest', nickname: '客人', isBot: false },
    { id: 'botA', nickname: '电脑 A', isBot: true },
  ];
  const seed = options.seed ?? seedWithHumanThenBot(players);
  const harness = createHarness({
    ...options,
    playerIds: options.playerIds ?? ['host', 'guest', 'botA'],
    tokens: options.tokens ?? ['tok-host', 'tok-guest'],
    seed,
  });

  const created = createChinaRoom(harness.manager, '房主');
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(`createRoom failed: ${created.code}`);

  const joined = harness.manager.joinRoom('0007', '客人');
  expect(joined.ok).toBe(true);
  if (!joined.ok) throw new Error(`joinRoom failed: ${joined.code}`);

  const added = harness.manager.addBot('0007', 'host');
  expect(added.ok).toBe(true);
  if (!added.ok) throw new Error(`addBot failed: ${added.code}`);

  const started = harness.manager.startRoom('0007', 'host');
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(`startRoom failed: ${started.code}`);

  const snapshotEvent = started.events.find((event) => event.type === 'game_snapshot');
  expect(snapshotEvent?.type).toBe('game_snapshot');
  if (snapshotEvent?.type !== 'game_snapshot') {
    throw new Error('startRoom did not emit a game_snapshot');
  }

  const firstActorId = engineActor(snapshotEvent.state);
  expect(gamePlayer(snapshotEvent.state, firstActorId).isBot).toBe(false);

  return { ...harness, seed, started, state: snapshotEvent.state };
}

function countingRealGameGateway(): {
  gateway: GameRuntimeGateway;
  chooseCalls: () => number;
  applyCalls: () => number;
} {
  let chooseCalls = 0;
  let applyCalls = 0;

  return {
    chooseCalls: () => chooseCalls,
    applyCalls: () => applyCalls,
    gateway: {
      createGame,
      chooseBotIntent(state, playerId) {
        chooseCalls += 1;
        return chooseBotIntent(state, playerId);
      },
      applyIntent(state, playerId, intent) {
        applyCalls += 1;
        return applyIntent(state, playerId, intent);
      },
    },
  };
}


function applyRoomGameIntent(
  manager: RoomManager<TimerHandle>,
  roomCode: string,
  playerId: string,
  intent: Intent,
): GameActionResult<Record<string, never>> {
  return manager.applyGameIntent(roomCode, playerId, intent);
}

function intentForTurnPhase(state: GameState): Intent {
  switch (state.turnPhase) {
    case 'awaiting_roll':
      return { type: 'roll_dice' };
    case 'awaiting_airport_roll':
      return { type: 'roll_airport_branch' };
    case 'awaiting_buy_decision':
      return { type: 'skip_buy' };
    case 'awaiting_build_decision':
      return { type: 'skip_build' };
    case 'managing':
      return { type: 'end_turn' };
  }
}

function playFullTurn(
  manager: RoomManager<TimerHandle>,
  roomCode: string,
  maxSteps: number,
): { result: Extract<GameActionResult<Record<string, never>>, { ok: true }>; events: GameEvent[]; steps: number } {
  if (maxSteps < 1) throw new Error(`playFullTurn maxSteps must be positive, got ${maxSteps}`);

  const events: GameEvent[] = [];
  for (let step = 1; step <= maxSteps; step += 1) {
    const snapshot = manager.getGameSnapshot(roomCode);
    if (snapshot === null) {
      throw new Error(`playFullTurn step ${step}: room ${roomCode} has no game snapshot`);
    }
    if (snapshot.phase !== 'playing') {
      throw new Error(`playFullTurn step ${step}: expected playing phase, got ${snapshot.phase}`);
    }

    const actorId = snapshot.debt?.debtorId ?? snapshot.currentPlayerId;
    const result = applyRoomGameIntent(manager, roomCode, actorId, intentForTurnPhase(snapshot));
    if (!result.ok) {
      throw new Error(`playFullTurn step ${step}: ${result.code} ${result.message}`);
    }
    expect(result.events.map((event) => event.type)).toEqual(['game_events', 'game_snapshot']);
    const transitionSnapshot = result.events[1];
    expect(transitionSnapshot?.type).toBe('game_snapshot');
    if (transitionSnapshot?.type !== 'game_snapshot') {
      throw new Error(`playFullTurn step ${step}: missing transition snapshot`);
    }
    expect(transitionSnapshot.state).toEqual(manager.getGameSnapshot(roomCode));

    const gameEvents = result.events.filter((event) => event.type === 'game_events');
    for (const event of gameEvents) {
      events.push(...event.events);
    }
    if (events.some((event) => event.type === 'turn_ended')) {
      return { result, events, steps: step };
    }
  }

  const snapshot = manager.getGameSnapshot(roomCode);
  throw new Error(
    `playFullTurn exceeded ${maxSteps} steps without turn_ended; last phase=${snapshot?.phase ?? 'missing'}, turnPhase=${snapshot?.turnPhase ?? 'missing'}`,
  );
}

function gameOverGateway(): { gateway: GameRuntimeGateway; applyCalls: () => number } {
  let applyCalls = 0;

  return {
    applyCalls: () => applyCalls,
    gateway: {
      createGame,
      chooseBotIntent: () => ({ type: 'end_turn' }),
      applyIntent(state: GameState, playerId: string): ApplyResult {
        applyCalls += 1;
        if (state.phase !== 'playing') return { ok: false, code: 'WRONG_PHASE' };

        const winnerId = playerId;
        const nextBotId = state.players.find((player) => player.isBot)?.id ?? state.currentPlayerId;
        const events: GameEvent[] = [
          { type: 'turn_ended', playerId },
          { type: 'game_over', winnerId, reason: 'cash_goal' },
        ];
        return {
          ok: true,
          state: {
            ...state,
            phase: 'game_over',
            currentPlayerId: nextBotId,
            winnerId,
            recentLog: [...state.recentLog, ...events].slice(-200),
          },
          events,
        };
      },
    },
  };
}

function getCommittedGameState(manager: RoomManager<TimerHandle>, roomCode = '0007'): GameState {
  const snapshot = manager.getGameSnapshot(roomCode);
  expect(snapshot).not.toBeNull();
  if (snapshot === null) {
    throw new Error(`Expected room ${roomCode} to have a committed GameState`);
  }
  return snapshot;
}

function gamePlayer(state: GameState, playerId: string): PlayerState {
  const player = state.players.find((candidate) => candidate.id === playerId);
  expect(player).toBeDefined();
  if (player === undefined) {
    throw new Error(`Expected GameState player ${playerId}`);
  }
  return player;
}

function publicPlayer(room: PublicRoomState, playerId: string) {
  const player = room.players.find((candidate) => candidate.id === playerId);
  expect(player).toBeDefined();
  if (player === undefined) {
    throw new Error(`Expected public room player ${playerId}`);
  }
  return player;
}

function expectNoGameEmissions(events: RoomDomainEvent[]) {
  expect(events.some((event) => event.type === 'game_events')).toBe(false);
  expect(events.some((event) => event.type === 'game_snapshot')).toBe(false);
}

function expectPublicRoomStateOnly(room: PublicRoomState) {
  expect(Object.keys(room).sort()).toEqual(['hostId', 'map', 'players', 'roomCode', 'spectators', 'status', 'takeoverPlayerId']);
  expect('snapshot' in room).toBe(false);
}


describe('RoomManager authoritative GameState start', () => {
  test('startRoom emits room_state(playing) then a deterministic game_snapshot with cashGoal disabled', () => {
    const { manager } = createTwoHumanLobby('deterministic-seed');

    const result = manager.startRoom('0007', 'host');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expectedRoom = {
      roomCode: '0007',
      status: 'playing',
      hostId: 'host',
      players: [
        { id: 'host', nickname: '房主', isBot: false, online: true },
        { id: 'guest', nickname: '客人', isBot: false, online: true },
      ],
      spectators: [],
      takeoverPlayerId: null,
      map: CHINA_MAP_SUMMARY,
    };
    const expectedGame = createGame({
      mapRef: chinaMapPack.ref,
      ruleModules: chinaMapPack.game.requiredRuleModules,
      board: chinaMapPack.game.board,
      cards: chinaMapPack.game.cards,
      config: chinaMapPack.game.config,
      players: [
        { id: 'host', nickname: '房主', isBot: false },
        { id: 'guest', nickname: '客人', isBot: false },
      ],
      seed: 'deterministic-seed',
      cashGoal: null,
    });

    expect(result.value).toEqual(expectedRoom);
    expect(result.events).toEqual([
      { type: 'room_state', roomCode: '0007', room: expectedRoom },
      { type: 'game_snapshot', roomCode: '0007', state: expectedGame },
    ]);
    expect(expectedGame.cashGoal).toBeNull();
  });

  test('getGameSnapshot preserves dice-resolved player order from the initial GameState snapshot', () => {
    const seed = 'identity-seed';
    const { manager } = createTwoHumanLobby(seed);
    const result = manager.startRoom('0007', 'host');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const emittedSnapshotEvent = result.events.find((event) => event.type === 'game_snapshot');
    expect(emittedSnapshotEvent?.type).toBe('game_snapshot');
    if (emittedSnapshotEvent?.type !== 'game_snapshot') return;
    const realEngineOrder = createGame({
      mapRef: chinaMapPack.ref,
      ruleModules: chinaMapPack.game.requiredRuleModules,
      board: chinaMapPack.game.board,
      cards: chinaMapPack.game.cards,
      config: chinaMapPack.game.config,
      players: [
        { id: 'host', nickname: '房主', isBot: false },
        { id: 'guest', nickname: '客人', isBot: false },
      ],
      seed,
      cashGoal: null,
    }).players.map((player: PlayerState) => player.id);

    expect(realEngineOrder).toEqual(['guest', 'host']);
    const emittedOrder = emittedSnapshotEvent.state.players.map((player: PlayerState) => player.id);
    const accessorOrder = manager.getGameSnapshot('0007')?.players.map((player: PlayerState) => player.id);

    expect(emittedOrder).toEqual(realEngineOrder);
    expect(accessorOrder).toEqual(emittedOrder);
  });


  test('getGameSnapshot exposes the started room players exactly once and never leaks room tokens', () => {
    const { manager } = createTwoHumanLobby('identity-seed');
    const result = manager.startRoom('0007', 'host');
    expect(result.ok).toBe(true);

    const snapshot = manager.getGameSnapshot('0007');

    expect(snapshot).not.toBeNull();
    expect(snapshot?.players.map((player: PlayerState) => ({
      id: player.id,
      nickname: player.nickname,
      isBot: player.isBot,
      online: player.online,
    })).sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      { id: 'guest', nickname: '客人', isBot: false, online: true },
      { id: 'host', nickname: '房主', isBot: false, online: true },
    ]);
    expect(snapshot?.players.map((player: PlayerState) => player.id).sort()).toEqual(['guest', 'host']);
    expect(JSON.stringify(snapshot)).not.toContain('tok-host');
    expect(JSON.stringify(snapshot)).not.toContain('tok-guest');
    expect(JSON.stringify(result)).not.toContain('tok-host');
    expect(JSON.stringify(result)).not.toContain('tok-guest');
  });

  test('getGameSnapshot returns null for lobby and unknown rooms', () => {
    const { manager } = createTwoHumanLobby();

    expect(manager.getGameSnapshot('0007')).toBeNull();
    expect(manager.getGameSnapshot('9999')).toBeNull();
  });

  test('startRoom mirrors an offline lobby guest into the initial GameState and cancels its lobby timer', () => {
    const { manager, timers } = createTwoHumanLobby('offline-seed');
    const disconnected = manager.markDisconnected('0007', 'guest');
    expect(disconnected.ok).toBe(true);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.active).toBe(true);

    const result = manager.startRoom('0007', 'host');

    expect(result.ok).toBe(true);
    expect(timers[0]?.active).toBe(false);
    const snapshot = manager.getGameSnapshot('0007');
    expect(snapshot?.players.find((player: PlayerState) => player.id === 'host')?.online).toBe(true);
    expect(snapshot?.players.find((player: PlayerState) => player.id === 'guest')?.online).toBe(false);
  });

  test('createGame exceptions leave the lobby unchanged, log the original error, and expose no snapshot', () => {
    const boom = new Error('createGame internals should stay server-side');
    const serverErrors: unknown[] = [];
    const throwingGateway: GameRuntimeGateway = {
      createGame: () => {
        throw boom;
      },
      applyIntent: () => {
        throw new Error('applyIntent should not be used while starting a room');
      },
      chooseBotIntent: () => ({ type: 'roll_dice' }),
    };
    const { manager, asyncEvents } = createHarness({
      playerIds: ['host', 'guest'],
      tokens: ['tok-host', 'tok-guest'],
      seed: 'throwing-seed',
      gameGateway: throwingGateway,
      onServerError: (_message, error) => serverErrors.push(error),
    });
    const created = createChinaRoom(manager, '房主');
    expect(created.ok).toBe(true);
    const joined = manager.joinRoom('0007', '客人');
    expect(joined.ok).toBe(true);
    const publicLobbyBefore = manager.getPublicRoom('0007');

    const result = manager.startRoom('0007', 'host');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_ROOM_ACTION');
    expect(serverErrors).toEqual([boom]);
    expect(asyncEvents).toEqual([]);
    expect(manager.getPublicRoom('0007')).toEqual(publicLobbyBefore);
    expect(manager.getGameSnapshot('0007')).toBeNull();
  });
});

describe('RoomManager online-state mirroring', () => {
  test('playing markDisconnected mirrors the human offline in PublicRoomState and GameState without game emissions', () => {
    const { manager } = startedRoomWith({ seed: 'online-mirror-disconnect-seed' });
    const beforeState = getCommittedGameState(manager);
    const beforeHost = gamePlayer(beforeState, 'host');
    const beforeGuest = gamePlayer(beforeState, 'guest');
    expect(beforeGuest.online).toBe(true);

    const disconnected = manager.markDisconnected('0007', 'guest');

    expect(disconnected.ok).toBe(true);
    if (!disconnected.ok) throw new Error(`markDisconnected failed: ${disconnected.code}`);
    expect(disconnected.value).not.toBeNull();
    if (disconnected.value === null) throw new Error('markDisconnected unexpectedly removed the playing room');
    expect(disconnected.events).toEqual([
      { type: 'player_connection', roomCode: '0007', playerId: 'guest', online: false },
    ]);
    expectNoGameEmissions(disconnected.events);
    expect(publicPlayer(disconnected.value, 'guest').online).toBe(false);
    expect(publicPlayer(disconnected.value, 'host').online).toBe(true);

    const afterState = getCommittedGameState(manager);
    const afterGuest = gamePlayer(afterState, 'guest');
    const afterHost = gamePlayer(afterState, 'host');
    expect(afterState).not.toBe(beforeState);
    expect(afterGuest).not.toBe(beforeGuest);
    expect(afterGuest.online).toBe(false);
    expect(beforeGuest.online).toBe(true);
    expect(afterHost).toBe(beforeHost);
    expect(afterHost.online).toBe(true);
  });

  test('playing leave retains the seat and mirrors the human offline without game emissions', () => {
    const { manager } = startedRoomWith({ seed: 'online-mirror-leave-seed' });
    const beforeState = getCommittedGameState(manager);
    const beforeHost = gamePlayer(beforeState, 'host');
    const beforeGuest = gamePlayer(beforeState, 'guest');

    const left = manager.leaveRoom('0007', 'guest');

    expect(left.ok).toBe(true);
    if (!left.ok) throw new Error(`leaveRoom failed: ${left.code}`);
    expect(left.value).not.toBeNull();
    if (left.value === null) throw new Error('leaveRoom unexpectedly removed the playing room');
    expect(left.events).toEqual([
      { type: 'player_connection', roomCode: '0007', playerId: 'guest', online: false },
    ]);
    expectNoGameEmissions(left.events);
    expect(left.value.players.map((player) => player.id).sort()).toEqual(['guest', 'host']);
    expect(publicPlayer(left.value, 'guest').online).toBe(false);
    expect(publicPlayer(left.value, 'host').online).toBe(true);

    const afterState = getCommittedGameState(manager);
    const afterGuest = gamePlayer(afterState, 'guest');
    const afterHost = gamePlayer(afterState, 'host');
    expect(afterState).not.toBe(beforeState);
    expect(afterGuest).not.toBe(beforeGuest);
    expect(afterGuest.online).toBe(false);
    expect(beforeGuest.online).toBe(true);
    expect(afterHost).toBe(beforeHost);
    expect(afterHost.online).toBe(true);
  });

  test('playing token resume restores PublicRoomState and GameState online while returning only the public room shape', () => {
    const { manager } = startedRoomWith({ seed: 'online-mirror-resume-seed' });
    const disconnected = manager.markDisconnected('0007', 'guest');
    expect(disconnected.ok).toBe(true);
    if (!disconnected.ok) throw new Error(`markDisconnected failed: ${disconnected.code}`);
    expect(gamePlayer(getCommittedGameState(manager), 'guest').online).toBe(false);

    const resumed = manager.resumeRoom('0007', 'guest', 'tok-guest');

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error(`resumeRoom failed: ${resumed.code}`);
    expect(Object.keys(resumed).sort()).toEqual(['events', 'ok', 'value']);
    expect('snapshot' in resumed).toBe(false);
    expectPublicRoomStateOnly(resumed.value);
    expect(resumed.events).toEqual([
      { type: 'player_connection', roomCode: '0007', playerId: 'guest', online: true },
    ]);
    expectNoGameEmissions(resumed.events);
    expect(publicPlayer(resumed.value, 'guest').online).toBe(true);
    expect(publicPlayer(resumed.value, 'host').online).toBe(true);
    expect(gamePlayer(getCommittedGameState(manager), 'guest').online).toBe(true);
    expect(gamePlayer(getCommittedGameState(manager), 'host').online).toBe(true);
  });

  test('playing BOT seats remain online in PublicRoomState and GameState when the human disconnects', () => {
    const { manager } = startedRoomWith({
      seed: 'online-mirror-bot-seat-seed',
      secondPlayer: 'bot',
    });

    const disconnected = manager.markDisconnected('0007', 'host');

    expect(disconnected.ok).toBe(true);
    if (!disconnected.ok) throw new Error(`markDisconnected failed: ${disconnected.code}`);
    expect(disconnected.value).not.toBeNull();
    if (disconnected.value === null) throw new Error('markDisconnected unexpectedly removed the bot room');
    expect(disconnected.events).toEqual([
      { type: 'player_connection', roomCode: '0007', playerId: 'host', online: false },
    ]);
    expectNoGameEmissions(disconnected.events);
    expect(publicPlayer(disconnected.value, 'host').online).toBe(false);
    expect(publicPlayer(disconnected.value, 'bot').online).toBe(true);
    const snapshot = getCommittedGameState(manager);
    expect(gamePlayer(snapshot, 'host').online).toBe(false);
    expect(gamePlayer(snapshot, 'bot').online).toBe(true);
  });

  test('ended-room disconnect, leave, and token resume retain the seat and mirror online while preserving game_over', () => {
    const scripted = gameOverGateway();
    const { manager, state } = startedRoomWith({
      seed: 'online-mirror-ended-seed',
      gameGateway: scripted.gateway,
    });
    const ended = applyRoomGameIntent(manager, '0007', state.currentPlayerId, { type: 'end_turn' });
    expect(ended.ok).toBe(true);
    if (!ended.ok) throw new Error(`forced game_over failed: ${ended.code}`);
    expect(getCommittedGameState(manager).phase).toBe('game_over');
    expect(manager.getPublicRoom('0007')?.status).toBe('ended');

    const endedDisconnect = manager.markDisconnected('0007', 'guest');

    expect(endedDisconnect.ok).toBe(true);
    if (!endedDisconnect.ok) throw new Error(`ended markDisconnected failed: ${endedDisconnect.code}`);
    expect(endedDisconnect.value).not.toBeNull();
    if (endedDisconnect.value === null) throw new Error('ended markDisconnected unexpectedly removed the room');
    expect(endedDisconnect.events).toEqual([
      { type: 'player_connection', roomCode: '0007', playerId: 'guest', online: false },
    ]);
    expectNoGameEmissions(endedDisconnect.events);
    expect(endedDisconnect.value.status).toBe('ended');
    expect(endedDisconnect.value.players.map((player) => player.id).sort()).toEqual(['guest', 'host']);
    expect(publicPlayer(endedDisconnect.value, 'guest').online).toBe(false);
    expect(gamePlayer(getCommittedGameState(manager), 'guest').online).toBe(false);
    expect(getCommittedGameState(manager).phase).toBe('game_over');

    const resumedAfterDisconnect = manager.resumeRoom('0007', 'guest', 'tok-guest');
    expect(resumedAfterDisconnect.ok).toBe(true);
    if (!resumedAfterDisconnect.ok) throw new Error(`ended resume failed: ${resumedAfterDisconnect.code}`);
    expectPublicRoomStateOnly(resumedAfterDisconnect.value);
    expect(resumedAfterDisconnect.value.status).toBe('ended');
    expect(resumedAfterDisconnect.events).toEqual([
      { type: 'player_connection', roomCode: '0007', playerId: 'guest', online: true },
    ]);
    expectNoGameEmissions(resumedAfterDisconnect.events);
    expect(publicPlayer(resumedAfterDisconnect.value, 'guest').online).toBe(true);
    expect(gamePlayer(getCommittedGameState(manager), 'guest').online).toBe(true);
    expect(getCommittedGameState(manager).phase).toBe('game_over');

    const endedLeave = manager.leaveRoom('0007', 'guest');
    expect(endedLeave.ok).toBe(true);
    if (!endedLeave.ok) throw new Error(`ended leaveRoom failed: ${endedLeave.code}`);
    expect(endedLeave.value).not.toBeNull();
    if (endedLeave.value === null) throw new Error('ended leaveRoom unexpectedly removed the room');
    expect(endedLeave.events).toEqual([
      { type: 'player_connection', roomCode: '0007', playerId: 'guest', online: false },
    ]);
    expectNoGameEmissions(endedLeave.events);
    expect(endedLeave.value.status).toBe('ended');
    expect(endedLeave.value.players.map((player) => player.id).sort()).toEqual(['guest', 'host']);
    expect(publicPlayer(endedLeave.value, 'guest').online).toBe(false);
    expect(gamePlayer(getCommittedGameState(manager), 'guest').online).toBe(false);
    expect(getCommittedGameState(manager).phase).toBe('game_over');

    const resumedAfterLeave = manager.resumeRoom('0007', 'guest', 'tok-guest');
    expect(resumedAfterLeave.ok).toBe(true);
    if (!resumedAfterLeave.ok) throw new Error(`ended resume after leave failed: ${resumedAfterLeave.code}`);
    expect(Object.keys(resumedAfterLeave).sort()).toEqual(['events', 'ok', 'value']);
    expect('snapshot' in resumedAfterLeave).toBe(false);
    expectPublicRoomStateOnly(resumedAfterLeave.value);
    expect(resumedAfterLeave.value.status).toBe('ended');
    expect(resumedAfterLeave.value).toEqual(manager.getPublicRoom('0007'));
    expect(resumedAfterLeave.events).toEqual([
      { type: 'player_connection', roomCode: '0007', playerId: 'guest', online: true },
    ]);
    expectNoGameEmissions(resumedAfterLeave.events);
    expect(publicPlayer(resumedAfterLeave.value, 'guest').online).toBe(true);
    expect(gamePlayer(getCommittedGameState(manager), 'guest').online).toBe(true);
    expect(getCommittedGameState(manager).phase).toBe('game_over');
    expect(scripted.applyCalls()).toBe(1);
  });
});

describe('RoomManager applyGameIntent shared committed transition', () => {
  test('accepted non-boundary real roll commits canonical state and publishes one matching snapshot after game events', () => {
    const { manager, state } = startedRoomWith({ seed: 'accepted-roll-seed' });
    const actorId = state.currentPlayerId;
    const intent = { type: 'roll_dice' } satisfies Intent;
    const beforeSnapshot = manager.getGameSnapshot('0007');
    expect(beforeSnapshot).toEqual(state);
    const expected = applyIntent(state, actorId, intent);
    expect(expected.ok).toBe(true);
    if (!expected.ok) throw new Error(`real engine rejected roll: ${expected.code}`);
    expect(expected.events.some((event) => event.type === 'turn_ended')).toBe(false);
    expect(expected.state).not.toBe(state);
    expect(expected.state.players).not.toEqual(beforeSnapshot?.players);
    expect(expected.state.recentLog.length).toBeGreaterThan(beforeSnapshot?.recentLog.length ?? 0);

    const result = applyRoomGameIntent(manager, '0007', actorId, intent);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({});
    const committed = manager.getGameSnapshot('0007');
    expect(committed).toEqual(expected.state);
    expect(committed).not.toEqual(beforeSnapshot);
    expect(committed?.players).toEqual(expected.state.players);
    expect(committed?.recentLog).toEqual(expected.state.recentLog);
    expect(committed?.recentLog).not.toBe(beforeSnapshot?.recentLog);

    const gameEventBatches = result.events.filter(
      (event): event is Extract<RoomDomainEvent, { type: 'game_events' }> => event.type === 'game_events',
    );
    expect(gameEventBatches).toHaveLength(1);
    expect(gameEventBatches[0]?.events).toEqual(expected.events);
    expect(result.events.map((event) => event.type)).toEqual(['game_events', 'game_snapshot']);
    const transitionSnapshot = result.events[1];
    expect(transitionSnapshot?.type).toBe('game_snapshot');
    if (transitionSnapshot?.type !== 'game_snapshot') return;
    expect(transitionSnapshot.state).toEqual(expected.state);
    expect(transitionSnapshot.state).toEqual(committed);
  });

  test('wrong actor returns NOT_YOUR_TURN, keeps the same committed state, and emits no events', () => {
    const { manager, state } = startedRoomWith({ seed: 'wrong-actor-seed' });
    const wrongActorId = state.players.find((player) => player.id !== state.currentPlayerId)?.id;
    if (wrongActorId === undefined) throw new Error('expected a second player for wrong actor coverage');
    const beforeSnapshot = manager.getGameSnapshot('0007');
    expect(beforeSnapshot).not.toBeNull();

    const result = applyRoomGameIntent(manager, '0007', wrongActorId, { type: 'roll_dice' });

    expect(result).toEqual({ ok: false, code: 'NOT_YOUR_TURN', message: '还没轮到你行动。' });
    const afterSnapshot = manager.getGameSnapshot('0007');
    expect(afterSnapshot).toEqual(beforeSnapshot);
    expect(afterSnapshot?.properties).toBe(beforeSnapshot?.properties);
    expect(afterSnapshot?.recentLog).toBe(beforeSnapshot?.recentLog);
  });

  test('thrown gateway apply retains state, maps ILLEGAL_INTENT, and logs safe context without tokens', () => {
    const boom = new Error('applyIntent internals should stay server-side');
    const serverErrors: Array<{ message: string; error: unknown }> = [];
    const throwingGateway: GameRuntimeGateway = {
      createGame,
      applyIntent: () => {
        throw boom;
      },
      chooseBotIntent: () => ({ type: 'roll_dice' }),
    };
    const { manager, state } = startedRoomWith({
      seed: 'throwing-apply-seed',
      gameGateway: throwingGateway,
      onServerError: (message, error) => serverErrors.push({ message, error }),
    });
    const beforeSnapshot = manager.getGameSnapshot('0007');

    const result = applyRoomGameIntent(manager, '0007', state.currentPlayerId, { type: 'roll_dice' });

    expect(result).toEqual({ ok: false, code: 'ILLEGAL_INTENT', message: '该操作不合法。' });
    expect(manager.getGameSnapshot('0007')).toEqual(beforeSnapshot);
    expect(serverErrors).toHaveLength(1);
    expect(serverErrors[0]?.error).toBe(boom);
    expect(serverErrors[0]?.message).toContain('applyGameIntent');
    expect(serverErrors[0]?.message).toContain('0007');
    expect(serverErrors[0]?.message).not.toContain(state.currentPlayerId);
    expect(serverErrors[0]?.message).not.toContain('roll_dice');
    expect(serverErrors[0]?.message).not.toContain('tok-host');
    expect(serverErrors[0]?.message).not.toContain('tok-guest');
    expect(serverErrors[0]?.message).not.toContain('房主');
    expect(serverErrors[0]?.message).not.toContain('客人');
  });

  test('bounded real full-turn helper reaches turn_ended and commits game_events immediately before game_snapshot', () => {
    const { manager } = startedRoomWith({ seed: 'full-turn-seed' });

    const fullTurn = playFullTurn(manager, '0007', 8);

    const turnEnded = fullTurn.events.find((event) => event.type === 'turn_ended');
    expect(turnEnded).toBeDefined();
    expect(fullTurn.result.events.map((event) => event.type).slice(-2)).toEqual(['game_events', 'game_snapshot']);
    const finalBatch = fullTurn.result.events.at(-2);
    const finalSnapshot = fullTurn.result.events.at(-1);
    expect(finalBatch?.type).toBe('game_events');
    expect(finalSnapshot?.type).toBe('game_snapshot');
    if (finalBatch?.type !== 'game_events' || finalSnapshot?.type !== 'game_snapshot') return;
    expect(finalBatch.events).toContainEqual(turnEnded);
    expect(finalSnapshot.state).toEqual(manager.getGameSnapshot('0007'));
  });

  test('forced game_over ends the public room once, publishes one final snapshot, and blocks later mutations', () => {
    const scripted = gameOverGateway();
    const { manager, asyncEvents, state, timers } = startedRoomWith({
      seed: 'forced-game-over-seed',
      secondPlayer: 'bot',
      gameGateway: scripted.gateway,
      delays: [1, 1],
    });
    const actorId = state.currentPlayerId;

    const result = applyRoomGameIntent(manager, '0007', actorId, { type: 'end_turn' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const eventTypes = result.events.map((event) => event.type);
    expect(result.value).toEqual({});
    expect(eventTypes).toEqual(['game_events', 'game_snapshot']);
    expect(eventTypes).not.toContain('room_state');

    const gameEventBatches = result.events.filter(
      (event): event is Extract<RoomDomainEvent, { type: 'game_events' }> => event.type === 'game_events',
    );
    const snapshots = result.events.filter(
      (event): event is Extract<RoomDomainEvent, { type: 'game_snapshot' }> => event.type === 'game_snapshot',
    );
    expect(gameEventBatches).toHaveLength(1);
    expect(gameEventBatches[0]?.events).toEqual([
      { type: 'turn_ended', playerId: actorId },
      { type: 'game_over', winnerId: actorId, reason: 'cash_goal' },
    ]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.state.phase).toBe('game_over');
    expect(manager.getPublicRoom('0007')?.status).toBe('ended');
    expect(manager.getGameSnapshot('0007')).toEqual(snapshots[0]?.state);
    expect(timers.filter((timer) => timer.active)).toEqual([]);
    expect(asyncEvents).toEqual([]);
    expect(scripted.applyCalls()).toBe(1);

    const endedSnapshot = manager.getGameSnapshot('0007');
    const laterIntent = applyRoomGameIntent(manager, '0007', actorId, { type: 'roll_dice' });
    expect(laterIntent.ok).toBe(false);
    if (laterIntent.ok) return;
    expect(laterIntent.code).toBe('INVALID_ROOM_ACTION');
    expect(scripted.applyCalls()).toBe(1);
    expect(manager.getGameSnapshot('0007')).toEqual(endedSnapshot);
    expect(timers.filter((timer) => timer.active)).toEqual([]);
    expect(asyncEvents).toEqual([]);

    const restart = manager.startRoom('0007', 'host');
    expect(restart.ok).toBe(false);
    if (restart.ok) return;
    expect(restart.code).toBe('INVALID_ROOM_ACTION');
    expect(manager.getGameSnapshot('0007')).toEqual(endedSnapshot);
  });
});
describe('automation infrastructure', () => {
  test('BOT-first start returns only sync room_state and game_snapshot while scheduling one injected-delay timer', () => {
    const { asyncEvents, started, timers } = startedBotFirstRoom({ delays: [4321] });

    expect(started.events.map((event) => event.type)).toEqual(['room_state', 'game_snapshot']);
    expect(asyncEvents).toEqual([]);
    expect(timers.filter((timer) => timer.active)).toHaveLength(1);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.delayMs).toBe(4321);
  });

  test('BOT debt debtor replaces botA automation with exactly one fresh botB timer', () => {
    const debtGateway = debtInjectingGateway('botB');
    const { asyncEvents, manager, started, timers } = startedRoomBotFirstWithGateway('botA', debtGateway.gateway, {
      delays: [101, 202],
    });
    const oldHandle = activeTimers(timers)[0];
    if (oldHandle === undefined) throw new Error('expected initial botA automation timer');

    oldHandle.callback();

    const debtState = getCommittedGameState(manager);
    const freshHandle = activeTimers(timers)[0];
    expect(debtState.debt?.debtorId).toBe('botB');
    expect(engineActor(debtState)).toBe('botB');
    expect(oldHandle.active).toBe(false);
    expect(activeTimers(timers)).toHaveLength(1);
    expect(freshHandle).toBeDefined();
    expect(freshHandle).not.toBe(oldHandle);
    expect(freshHandle?.delayMs).toBe(202);
    expect(debtGateway.chooseCalls()).toEqual(['botA']);
    expect(debtGateway.applyCalls()).toEqual(['botA']);

    const beforeBotBDebtAction = getCommittedGameState(manager);
    freshHandle?.callback();

    const afterBotBDebtAction = getCommittedGameState(manager);
    expect(debtGateway.chooseCalls()).toEqual(['botA', 'botB']);
    expect(debtGateway.applyCalls()).toEqual(['botA', 'botB']);
    expect(afterBotBDebtAction.turn).toBe(beforeBotBDebtAction.turn + 1);
    expect(afterBotBDebtAction.recentLog).not.toBe(beforeBotBDebtAction.recentLog);
    expect(asyncEvents.filter((event) => event.type === 'game_events')).toHaveLength(2);
    expect(activeTimers(timers)).toHaveLength(0);
    expect(JSON.stringify([started.events, asyncEvents])).not.toContain('tok-host');
  });

  test('human debt waits for manual resolution before scheduling the reconciled bot actor', () => {
    const debtGateway = debtInjectingGateway('host');
    const { asyncEvents, manager, started, timers } = startedRoomBotFirstWithGateway('botA', debtGateway.gateway, {
      delays: [303, 404],
    });
    const botAHandle = activeTimers(timers)[0];
    if (botAHandle === undefined) throw new Error('expected initial botA automation timer');

    botAHandle.callback();

    const humanDebtState = getCommittedGameState(manager);
    expect(humanDebtState.debt?.debtorId).toBe('host');
    expect(engineActor(humanDebtState)).toBe('host');
    expect(botAHandle.active).toBe(false);
    expect(activeTimers(timers)).toHaveLength(0);
    expect(debtGateway.chooseCalls()).toEqual(['botA']);

    const manualResolution = applyRoomGameIntent(manager, '0007', 'host', { type: 'end_turn' });

    expect(manualResolution.ok).toBe(true);
    if (!manualResolution.ok) throw new Error(`host debt resolution failed: ${manualResolution.code}`);
    const reconciledState = getCommittedGameState(manager);
    const botBHandle = activeTimers(timers)[0];
    expect(reconciledState.debt).toBeNull();
    expect(reconciledState.currentPlayerId).toBe('botB');
    expect(engineActor(reconciledState)).toBe('botB');
    expect(activeTimers(timers)).toHaveLength(1);
    expect(botBHandle?.delayMs).toBe(404);
    expect(debtGateway.applyCalls()).toEqual(['botA', 'host']);

    const turnBeforeBotB = reconciledState.turn;
    const gameEventBatchesBeforeBotB = asyncEvents.filter((event) => event.type === 'game_events').length;
    botBHandle?.callback();

    const afterBotB = getCommittedGameState(manager);
    expect(debtGateway.chooseCalls()).toEqual(['botA', 'botB']);
    expect(debtGateway.applyCalls()).toEqual(['botA', 'host', 'botB']);
    expect(afterBotB.turn).toBe(turnBeforeBotB + 1);
    expect(afterBotB.recentLog).not.toBe(reconciledState.recentLog);
    expect(asyncEvents.filter((event) => event.type === 'game_events')).toHaveLength(gameEventBatchesBeforeBotB + 1);
    expect(activeTimers(timers)).toHaveLength(0);
    expect(JSON.stringify([started.events, manualResolution.events, asyncEvents])).not.toContain('tok-host');
  });

  test('BOT-first room reschedules one fresh BOT timer after each same-turn real action until handoff', () => {
    const counting = countingRealGameGateway();
    const delays = [111, 222, 333, 444, 555, 666, 777, 888, 999];
    const { asyncEvents, manager, state, timers } = startedBotFirstRoom({
      delays,
      gameGateway: counting.gateway,
    });
    const initialActorId = engineActor(state);
    const initialTurn = state.turn;
    expect(gamePlayer(state, initialActorId).isBot).toBe(true);
    expect(activeTimers(timers)).toHaveLength(1);
    expect(timers[0]?.delayMs).toBe(111);

    let fireCount = 0;
    while (fireCount < 8) {
      const beforeState = getCommittedGameState(manager);
      if (beforeState.turn !== initialTurn || engineActor(beforeState) !== initialActorId) break;

      const activeBefore = activeTimers(timers);
      expect(activeBefore).toHaveLength(1);
      const handle = activeBefore[0];
      if (handle === undefined) throw new Error(`missing active BOT timer before fire ${fireCount + 1}`);
      const timerCountBefore = timers.length;
      const chooseCallsBefore = counting.chooseCalls();
      const applyCallsBefore = counting.applyCalls();

      handle.callback();
      fireCount += 1;

      expect(counting.chooseCalls()).toBe(chooseCallsBefore + 1);
      expect(counting.applyCalls()).toBe(applyCallsBefore + 1);
      expect(timers.length).toBeLessThanOrEqual(timerCountBefore + 1);

      const afterState = getCommittedGameState(manager);
      if (fireCount === 1) {
        expect(afterState.turn).toBe(initialTurn);
        expect(engineActor(afterState)).toBe(initialActorId);
        expect(timers[1]?.delayMs).toBe(222);
      }

      if (afterState.turn === beforeState.turn && engineActor(afterState) === engineActor(beforeState)) {
        const replacement = activeTimers(timers);
        expect(replacement).toHaveLength(1);
        expect(replacement[0]).not.toBe(handle);
        expect(replacement[0]?.delayMs).toBe(delays[fireCount]);
      } else {
        expect(activeTimers(timers)).toEqual([]);
        break;
      }
    }

    const finalState = getCommittedGameState(manager);
    expect(fireCount).toBeGreaterThan(0);
    expect(fireCount).toBeLessThanOrEqual(8);
    expect(finalState.turn).toBeGreaterThan(initialTurn);
    expect(engineActor(finalState)).not.toBe(initialActorId);
    expect(gamePlayer(finalState, engineActor(finalState)).isBot).toBe(false);
    expect(asyncEvents.filter((event) => event.type === 'game_events')).toHaveLength(counting.applyCalls());
    expect(timers.slice(0, 2).map((timer) => timer.delayMs)).toEqual([111, 222]);
  });

  test('manual completed human turn handing to a BOT schedules exactly one fresh BOT timer', () => {
    const { asyncEvents, manager, state, timers } = startedHumanThenBotRoom({ delays: [777] });
    const firstActorId = engineActor(state);
    expect(gamePlayer(state, firstActorId).isBot).toBe(false);
    expect(activeTimers(timers)).toEqual([]);

    const completed = playFullTurn(manager, '0007', 8);

    expect(completed.events.some((event) => event.type === 'turn_ended')).toBe(true);
    const afterHumanTurn = getCommittedGameState(manager);
    const nextActorId = engineActor(afterHumanTurn);
    expect(gamePlayer(afterHumanTurn, nextActorId).isBot).toBe(true);
    expect(timers).toHaveLength(1);
    expect(activeTimers(timers)).toHaveLength(1);
    expect(timers[0]?.delayMs).toBe(777);
    expect(asyncEvents).toEqual([]);
  });

  test('superseded fired BOT handle is inert after its same-turn replacement is scheduled', () => {
    const counting = countingRealGameGateway();
    const { asyncEvents, manager, timers } = startedBotFirstRoom({
      delays: [12, 34],
      gameGateway: counting.gateway,
    });
    const originalHandle = activeTimers(timers)[0];
    if (originalHandle === undefined) throw new Error('expected initial BOT timer');

    originalHandle.callback();

    expect(counting.applyCalls()).toBe(1);
    const replacement = activeTimers(timers);
    expect(replacement).toHaveLength(1);
    expect(replacement[0]).not.toBe(originalHandle);
    expect(replacement[0]?.delayMs).toBe(34);
    const snapshotAfterReplacement = getCommittedGameState(manager);
    const playerRefsAfterReplacement = snapshotAfterReplacement.players;
    const eventsAfterReplacement = [...asyncEvents];
    const timerCountAfterReplacement = timers.length;

    originalHandle.callback();

    const snapshotAfterStaleFire = getCommittedGameState(manager);
    expect(snapshotAfterStaleFire).toEqual(snapshotAfterReplacement);
    expect(snapshotAfterStaleFire.board).toBe(snapshotAfterReplacement.board);
    expect(snapshotAfterStaleFire.cards).toBe(snapshotAfterReplacement.cards);
    expect(snapshotAfterStaleFire.config).toBe(snapshotAfterReplacement.config);
    expect(snapshotAfterStaleFire.properties).toBe(snapshotAfterReplacement.properties);
    expect(snapshotAfterStaleFire.decks).toBe(snapshotAfterReplacement.decks);
    expect(snapshotAfterStaleFire.recentLog).toBe(snapshotAfterReplacement.recentLog);
    expect(snapshotAfterStaleFire.players[0]).toBe(playerRefsAfterReplacement[0]);
    expect(snapshotAfterStaleFire.players[1]).toBe(playerRefsAfterReplacement[1]);
    expect(asyncEvents).toEqual(eventsAfterReplacement);
    expect(timers).toHaveLength(timerCountAfterReplacement);
    expect(activeTimers(timers)).toEqual(replacement);
    expect(counting.applyCalls()).toBe(1);
  });

  test('BOT apply rule failure preserves committed state references, emits nothing, and stops retry', () => {
    const serverErrors: Array<{ message: string; error: unknown }> = [];
    const failureCodes: string[] = [];
    let chooseCalls = 0;
    let applyCalls = 0;
    const ruleFailureGateway: GameRuntimeGateway = {
      createGame,
      chooseBotIntent: () => {
        chooseCalls += 1;
        return { type: 'end_turn' };
      },
      applyIntent(state, playerId, intent) {
        applyCalls += 1;
        const result = applyIntent(state, playerId, intent);
        if (!result.ok) failureCodes.push(result.code);
        return result;
      },
    };
    const { asyncEvents, manager, timers } = startedBotFirstRoom({
      delays: [909],
      gameGateway: ruleFailureGateway,
      onServerError: (message, error) => serverErrors.push({ message, error }),
    });
    const handle = activeTimers(timers)[0];
    if (handle === undefined) throw new Error('expected initial BOT timer');
    const snapshotBeforeFailure = getCommittedGameState(manager);
    expect(snapshotBeforeFailure.turnPhase).toBe('awaiting_roll');
    const playerRefsBeforeFailure = snapshotBeforeFailure.players;

    handle.callback();

    const snapshotAfterFailure = getCommittedGameState(manager);
    expect(chooseCalls).toBe(1);
    expect(applyCalls).toBe(1);
    expect(failureCodes).toEqual(['WRONG_PHASE']);
    expect(snapshotAfterFailure).toEqual(snapshotBeforeFailure);
    expect(snapshotAfterFailure.board).toBe(snapshotBeforeFailure.board);
    expect(snapshotAfterFailure.cards).toBe(snapshotBeforeFailure.cards);
    expect(snapshotAfterFailure.config).toBe(snapshotBeforeFailure.config);
    expect(snapshotAfterFailure.properties).toBe(snapshotBeforeFailure.properties);
    expect(snapshotAfterFailure.decks).toBe(snapshotBeforeFailure.decks);
    expect(snapshotAfterFailure.recentLog).toBe(snapshotBeforeFailure.recentLog);
    expect(snapshotAfterFailure.players[0]).toBe(playerRefsBeforeFailure[0]);
    expect(snapshotAfterFailure.players[1]).toBe(playerRefsBeforeFailure[1]);
    expect(asyncEvents).toEqual([]);
    expect(activeTimers(timers)).toEqual([]);
    expect(timers).toHaveLength(1);
    expect(serverErrors).toEqual([]);
  });

  test('deterministic two-human start leaves no active automation timer', () => {
    const { asyncEvents, manager, timers } = startedRoomWith({ seed: 'human-first-no-automation-seed' });

    expect(manager.getGameSnapshot('0007')?.players.every((player) => !player.isBot)).toBe(true);
    expect(timers.filter((timer) => timer.active)).toEqual([]);
    expect(asyncEvents).toEqual([]);
  });

  test('dispose cancels and invalidates a queued BOT callback without mutating or emitting', () => {
    const { asyncEvents, manager, timers } = startedBotFirstRoom({ delays: [2468] });
    const handle = timers[0];
    const snapshotBeforeDispose = manager.getGameSnapshot('0007');

    manager.dispose();
    expect(handle?.active).toBe(false);
    handle?.callback();

    expect(manager.getGameSnapshot('0007')).toEqual(snapshotBeforeDispose);
    expect(asyncEvents).toEqual([]);
    expect(timers.filter((timer) => timer.active)).toEqual([]);
  });

  test('throwing BOT planner logs the original error safely, preserves state, emits nothing, and stops automation', () => {
    const boom = new Error('chooseBotIntent internals should stay server-side');
    const serverErrors: Array<{ message: string; error: unknown }> = [];
    let chooseCalls = 0;
    let applyCalls = 0;
    const throwingGateway: GameRuntimeGateway = {
      createGame,
      applyIntent: (state, playerId, intent) => {
        applyCalls += 1;
        return applyIntent(state, playerId, intent);
      },
      chooseBotIntent: () => {
        chooseCalls += 1;
        throw boom;
      },
    };
    const { asyncEvents, manager, state, timers } = startedBotFirstRoom({
      delays: [1357],
      gameGateway: throwingGateway,
      onServerError: (message, error) => serverErrors.push({ message, error }),
    });
    const handle = timers[0];
    const snapshotBeforeThrow = manager.getGameSnapshot('0007');

    handle?.callback();

    expect(chooseCalls).toBe(1);
    expect(applyCalls).toBe(0);
    expect(manager.getGameSnapshot('0007')).toEqual(snapshotBeforeThrow);
    expect(manager.getGameSnapshot('0007')).toEqual(state);
    expect(asyncEvents).toEqual([]);
    expect(timers.filter((timer) => timer.active)).toEqual([]);
    expect(serverErrors).toHaveLength(1);
    expect(serverErrors[0]?.error).toBe(boom);
    expect(serverErrors[0]?.message).toContain('automation');
    expect(serverErrors[0]?.message).toContain('0007');
    expect(serverErrors[0]?.message).not.toContain('tok-host');
    expect(serverErrors[0]?.message).not.toContain('botA');
    expect(serverErrors[0]?.message).not.toContain('房主');
    expect(serverErrors[0]?.message).not.toContain('电脑 A');
  });
});

type OfflineTakeoverManager = RoomManager<TimerHandle> & {
  requestSkipOfflineTurn(roomCode: string, requesterId: string): GameActionResult<Record<string, never>>;
};

// Keep this narrow until Task 10 adds the public RoomManager entry point.
function requestOfflineTakeover(
  manager: RoomManager<TimerHandle>,
  roomCode: string,
  requesterId: string,
): GameActionResult<Record<string, never>> {
  return (manager as OfflineTakeoverManager).requestSkipOfflineTurn(roomCode, requesterId);
}

function startedRoomWithOfflineActor(options: HarnessOptions = {}) {
  const harness = startedRoomWith({
    ...options,
    playerIds: options.playerIds ?? ['host', 'guest'],
    tokens: options.tokens ?? ['tok-host', 'tok-guest'],
    seed: options.seed ?? 'offline-takeover-seed',
  });
  const actor = harness.state.currentPlayerId;
  const disconnected = harness.manager.markDisconnected('0007', actor);
  expect(disconnected.ok).toBe(true);
  if (!disconnected.ok) throw new Error(`markDisconnected failed: ${disconnected.code}`);

  const room = harness.manager.getPublicRoom('0007');
  expect(room).not.toBeNull();
  if (room === null) throw new Error('offline takeover setup lost room');
  const host = room.hostId;
  expect(host).not.toBe(actor);
  expect(publicPlayer(room, host).online).toBe(true);
  expect(gamePlayer(getCommittedGameState(harness.manager), actor).online).toBe(false);

  return { ...harness, actor, host };
}

function startedRoomWithOfflineActorGateway(gameGateway: GameRuntimeGateway, options: Omit<HarnessOptions, 'gameGateway'> = {}) {
  return startedRoomWithOfflineActor({ ...options, gameGateway });
}

function fixedPolicyGateway(): { gateway: GameRuntimeGateway; intents: () => Intent['type'][] } {
  const applied: Intent['type'][] = [];
  return {
    intents: () => [...applied],
    gateway: {
      createGame,
      chooseBotIntent: () => ({ type: 'end_turn' }),
      applyIntent(state, playerId, intent) {
        applied.push(intent.type);
        const event: GameEvent =
          intent.type === 'end_turn'
            ? { type: 'turn_ended', playerId }
            : { type: 'dice_rolled', playerId, dice: [1, 1] };
        const nextPhase: GameState['turnPhase'] =
          intent.type === 'roll_dice'
            ? 'awaiting_buy_decision'
            : intent.type === 'skip_buy'
              ? 'awaiting_build_decision'
              : intent.type === 'skip_build'
                ? 'managing'
                : 'awaiting_roll';
        const nextPlayerId =
          intent.type === 'end_turn'
            ? state.players.find((player) => player.id !== playerId)?.id ?? playerId
            : state.currentPlayerId;
        return {
          ok: true,
          state: {
            ...state,
            currentPlayerId: nextPlayerId,
            turn: intent.type === 'end_turn' ? state.turn + 1 : state.turn,
            turnPhase: nextPhase,
            recentLog: [...state.recentLog, event].slice(-200),
          },
          events: [event],
        };
      },
    },
  };
}

function debtDuringTakeoverGateway(): GameRuntimeGateway {
  return {
    createGame,
    chooseBotIntent: () => ({ type: 'end_turn' }),
    applyIntent(state, playerId, intent) {
      if (state.debt !== null && playerId === state.debt.debtorId && intent.type === 'end_turn') {
        const event: GameEvent = { type: 'debt_resolved', amount: state.debt.amount, creditorId: null };
        return {
          ok: true,
          state: { ...state, debt: null, turnPhase: 'managing', recentLog: [...state.recentLog, event].slice(-200) },
          events: [event],
        };
      }
      const event: GameEvent = { type: 'debt_entered', debtorId: playerId, creditorId: null, amount: 50 };
      return {
        ok: true,
        state: {
          ...state,
          debt: { debtorId: playerId, creditorId: null, amount: 50 },
          turnPhase: 'managing',
          recentLog: [...state.recentLog, event].slice(-200),
        },
        events: [event],
      };
    },
  };
}

describe('offline takeover', () => {
  test('host request for an offline current human schedules exactly one delayed takeover without a transition', () => {
    const { asyncEvents, manager, timers, actor, host } = startedRoomWithOfflineActor({ delays: [701] });
    const before = getCommittedGameState(manager);

    const result = requestOfflineTakeover(manager, '0007', host);

    expect(result).toEqual({
      ok: true,
      value: {},
      events: [{
        type: 'room_state',
        roomCode: '0007',
        room: expect.objectContaining({ takeoverPlayerId: actor }),
      }],
    });
    expect(manager.getPublicRoom('0007')).toEqual(expect.objectContaining({ takeoverPlayerId: actor }));
    expect(activeTimers(timers)).toHaveLength(1);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.delayMs).toBe(701);
    const after = getCommittedGameState(manager);
    expect(after).toEqual(before);
    expect(after.currentPlayerId).toBe(actor);
    expect(asyncEvents).toEqual([]);
  });

  test('rejects inactive rooms and every invalid requester or takeover actor with safe exact failures', () => {
    const lobby = createTwoHumanLobby('offline-takeover-lobby-seed');
    expect(requestOfflineTakeover(lobby.manager, '4040', 'host')).toEqual({
      ok: false,
      code: 'INVALID_ROOM_ACTION',
      message: 'No active game for that action.',
    });
    expect(requestOfflineTakeover(lobby.manager, '0007', 'host')).toEqual({
      ok: false,
      code: 'INVALID_ROOM_ACTION',
      message: 'No active game for that action.',
    });

    const offline = startedRoomWithOfflineActor();
    const before = getCommittedGameState(offline.manager);
    expect(requestOfflineTakeover(offline.manager, '0007', offline.actor)).toEqual({
      ok: false,
      code: 'NOT_HOST',
      message: 'Only the host can complete an offline turn.',
    });
    expect(activeTimers(offline.timers)).toEqual([]);
    expect(getCommittedGameState(offline.manager)).toEqual(before);

    const online = startedRoomWith({ seed: 'offline-takeover-online-seed' });
    expect(requestOfflineTakeover(online.manager, '0007', 'host')).toEqual({
      ok: false,
      code: 'INVALID_ROOM_ACTION',
      message: 'The current player is online.',
    });

    const bot = startedBotFirstRoom({ seed: seedWithBotFirst([{ id: 'host', nickname: '房主', isBot: false }, { id: 'botA', nickname: '电脑 A', isBot: true }], 'botA') });
    expect(requestOfflineTakeover(bot.manager, '0007', 'host')).toEqual({
      ok: false,
      code: 'INVALID_ROOM_ACTION',
      message: 'The current player is not a human.',
    });

    const debt = startedRoomWithOfflineActorGateway(debtDuringTakeoverGateway());
    // The typed gateway seam supplies debt through a canonical committed transition, not a mutable snapshot.
    const debtResult = applyRoomGameIntent(debt.manager, '0007', debt.actor, { type: 'roll_dice' });
    expect(debtResult.ok).toBe(true);
    expect(getCommittedGameState(debt.manager).debt?.debtorId).toBe(debt.actor);
    expect(requestOfflineTakeover(debt.manager, '0007', debt.host)).toEqual({
      ok: false,
      code: 'INVALID_ROOM_ACTION',
      message: 'Cannot skip while a debt is unresolved.',
    });

    expect(requestOfflineTakeover(offline.manager, '0007', offline.host)).toEqual({
      ok: true,
      value: {},
      events: [expect.objectContaining({ room: expect.objectContaining({ takeoverPlayerId: offline.actor }) })],
    });
    expect(requestOfflineTakeover(offline.manager, '0007', offline.host)).toEqual({
      ok: false,
      code: 'INVALID_ROOM_ACTION',
      message: 'Automation is already active for this turn.',
    });
    expect(activeTimers(offline.timers)).toHaveLength(1);
  });

  test('rejects the locked human manual intent while the timer callback commits and emits asynchronously', () => {
    const { asyncEvents, manager, timers, actor, host } = startedRoomWithOfflineActor({ delays: [702, 703] });
    expect(requestOfflineTakeover(manager, '0007', host).ok).toBe(true);
    const handle = activeTimers(timers)[0];
    if (handle === undefined) throw new Error('expected offline takeover timer');
    const before = getCommittedGameState(manager);

    expect(applyRoomGameIntent(manager, '0007', actor, { type: 'roll_dice' })).toEqual({
      ok: false,
      code: 'INVALID_ROOM_ACTION',
      message: 'The offline takeover is already committing this turn.',
    });
    handle.callback();

    expect(handle.active).toBe(false);
    const after = getCommittedGameState(manager);
    expect(after.lastDice).not.toBeNull();
    expect(after.recentLog).not.toBe(before.recentLog);
    expect(asyncEvents.filter((event) => event.type === 'game_events')).toHaveLength(1);
    expect(JSON.stringify(asyncEvents)).not.toContain('tok-');
  });

  test('uses the fixed roll, no-buy, no-build, end-turn policy one action per fresh timer', () => {
    const controlled = fixedPolicyGateway();
    const { asyncEvents, manager, timers, actor, host } = startedRoomWithOfflineActorGateway(controlled.gateway, {
      delays: [711, 712, 713, 714],
    });
    expect(requestOfflineTakeover(manager, '0007', host).ok).toBe(true);

    for (const expected of ['roll_dice', 'skip_buy', 'skip_build', 'end_turn'] satisfies Intent['type'][]) {
      const handle = activeTimers(timers)[0];
      if (handle === undefined) throw new Error(`missing takeover timer for ${expected}`);
      expect(activeTimers(timers)).toHaveLength(1);
      const callsBefore = controlled.intents().length;
      handle.callback();
      expect(controlled.intents()).toHaveLength(callsBefore + 1);
      expect(controlled.intents()[callsBefore]).toBe(expected);
      expect(activeTimers(timers)).toHaveLength(expected === 'end_turn' ? 0 : 1);
      if (expected === 'roll_dice') {
        const replacement = activeTimers(timers)[0];
        const callsAfter = controlled.intents().length;
        handle.callback();
        expect(controlled.intents()).toHaveLength(callsAfter);
        expect(activeTimers(timers)).toEqual(replacement === undefined ? [] : [replacement]);
      }
    }

    const state = getCommittedGameState(manager);
    expect(controlled.intents()).toEqual(['roll_dice', 'skip_buy', 'skip_build', 'end_turn']);
    expect(state.currentPlayerId).not.toBe(actor);
    expect(asyncEvents.filter((event) => event.type === 'game_events')).toHaveLength(4);
  });

  test('reconnect retains the takeover timer and lock until the automated turn completes and clears it', () => {
    const controlled = fixedPolicyGateway();
    const { asyncEvents, manager, timers, actor, host } = startedRoomWithOfflineActorGateway(controlled.gateway, {
      delays: [721, 722, 723, 724],
    });
    expect(requestOfflineTakeover(manager, '0007', host).ok).toBe(true);
    const handle = activeTimers(timers)[0];
    if (handle === undefined) throw new Error('expected retained takeover timer');
    const resumed = manager.resumeRoom('0007', actor, actor === 'host' ? 'tok-host' : 'tok-guest');
    expect(resumed).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({ takeoverPlayerId: actor }),
    }));
    expect(activeTimers(timers)).toEqual([handle]);
    const locked = applyRoomGameIntent(manager, '0007', actor, { type: 'roll_dice' });
    expect(locked.ok).toBe(false);
    if (locked.ok) throw new Error('takeover lock unexpectedly released on reconnect');
    expect(locked.code).toBe('INVALID_ROOM_ACTION');
    for (const expected of ['roll_dice', 'skip_buy', 'skip_build', 'end_turn'] satisfies Intent['type'][]) {
      const timer = activeTimers(timers)[0];
      if (timer === undefined) throw new Error(`missing timer for ${expected}`);
      timer.callback();
    }
    expect(asyncEvents.filter((event) => event.type === 'game_events')).toHaveLength(4);
    expect(asyncEvents.filter((event) => event.type === 'room_state')).toEqual([
      expect.objectContaining({ room: expect.objectContaining({ takeoverPlayerId: null }) }),
    ]);
  });

  test('host transfer room_state keeps the scheduled takeover actor public', () => {
    const { manager, actor, host } = startedRoomWithOfflineActor({ delays: [725] });
    expect(requestOfflineTakeover(manager, '0007', host).ok).toBe(true);

    expect(manager.markDisconnected('0007', host).ok).toBe(true);
    const resumed = manager.resumeRoom('0007', actor, actor === 'host' ? 'tok-host' : 'tok-guest');

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('resume failed');
    expect(resumed.value.takeoverPlayerId).toBe(actor);
    expect(resumed.events).toContainEqual(expect.objectContaining({
      type: 'room_state',
      room: expect.objectContaining({ takeoverPlayerId: actor }),
    }));
  });


  test('debt during takeover clears the lock without rescheduling, allowing reconnect and manual debt resolution', () => {
    const { asyncEvents, manager, timers, actor, host } = startedRoomWithOfflineActorGateway(debtDuringTakeoverGateway(), {
      delays: [731, 732],
    });
    expect(requestOfflineTakeover(manager, '0007', host).ok).toBe(true);
    const handle = activeTimers(timers)[0];
    if (handle === undefined) throw new Error('expected debt takeover timer');
    handle.callback();
    expect(getCommittedGameState(manager).debt?.debtorId).toBe(actor);
    expect(activeTimers(timers)).toEqual([]);
    expect(asyncEvents.filter((event) => event.type === 'room_state')).toEqual([
      expect.objectContaining({ room: expect.objectContaining({ takeoverPlayerId: null }) }),
    ]);
    const timerCount = timers.length;

    expect(manager.resumeRoom('0007', actor, actor === 'host' ? 'tok-host' : 'tok-guest').ok).toBe(true);
    expect(applyRoomGameIntent(manager, '0007', actor, { type: 'end_turn' }).ok).toBe(true);
    expect(getCommittedGameState(manager).debt).toBeNull();
    expect(timers).toHaveLength(timerCount);
    expect(JSON.stringify(asyncEvents)).not.toContain('tok-');
  });
});
