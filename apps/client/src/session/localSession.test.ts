import { describe, expect, it } from 'vitest';
import { applyIntent, chooseBotIntent, createGame, type GameState } from '@richman/engine';
import { getAvailableActions, type ClientAction } from '../game/clientGame';
import { createLocalSession, type LocalGamePersistence, type LocalSession } from './localSession';
import type { CommitLocalSaveResult } from './localGameSave';
import { getActiveMapPack, type MapPack } from '@richman/board-data';
import testBoard from '../../../../packages/board-data/maps/__test__/test-map-v1/board.json';
import testCards from '../../../../packages/board-data/maps/__test__/test-map-v1/cards.json';
import testConfig from '../../../../packages/board-data/maps/__test__/test-map-v1/game-config.json';
import testManifest from '../../../../packages/board-data/maps/__test__/test-map-v1/manifest.json';

const harbor = {
  ref: testManifest.ref,
  metadata: testManifest.metadata,
  game: {
    board: testBoard,
    cards: testCards,
    config: testConfig,
    requiredRuleModules: testManifest.requiredRuleModules,
  },
  presentation: testManifest.presentation,
} as unknown as MapPack;
const chinaMap = getActiveMapPack('china-tour');

function createSessionWithCurrentPlayer(
  playerId: string,
  options: NonNullable<Parameters<typeof createLocalSession>[0]>,
) {
  for (let index = 0; index < 100; index += 1) {
    const session = createLocalSession({ ...options, seed: `${options.seed ?? 'test'}-${index}` });
    if (session.state.value.currentPlayerId === playerId) return session;
    session.dispose();
  }
  throw new Error(`Unable to start a game with ${playerId} as the current player`);
}

function selectDebtSequenceAction(
  phase: LocalSession['state']['value']['turnPhase'],
  actions: ClientAction[],
): ClientAction {
  let intentType: ClientAction['intent']['type'];
  switch (phase) {
    case 'awaiting_roll':
      intentType = 'roll_dice';
      break;
    case 'awaiting_airport_roll':
      intentType = 'roll_airport_branch';
      break;
    case 'awaiting_buy_decision':
      intentType = 'buy_property';
      break;
    case 'awaiting_build_decision':
      intentType = 'build_house';
      break;
    case 'managing':
      intentType = 'end_turn';
      break;
    // 议价阶段（#105 交易 / #106 拍卖）当前玩家只能收尾：交易由目标答复、拍卖由叫价者出价，
    // 这里只是为了让 switch 穷尽，正常债务流程不会走到这两个阶段。
    case 'awaiting_trade_response':
      intentType = 'cancel_trade';
      break;
    case 'awaiting_auction_bid':
      intentType = 'pass_bid';
      break;
  }
  const action = actions.find((candidate) => candidate.intent.type === intentType);
  if (!action) throw new Error(`No ${intentType} action for debt sequence phase ${phase}`);
  return action;
}

function selectDebtSequenceFallback(
  phase: LocalSession['state']['value']['turnPhase'],
  actions: ClientAction[],
): ClientAction | null {
  const intentType = phase === 'awaiting_buy_decision'
    ? 'skip_buy'
    : phase === 'awaiting_build_decision'
      ? 'skip_build'
      : null;
  if (!intentType) return null;
  const action = actions.find((candidate) => candidate.intent.type === intentType);
  if (!action) throw new Error(`No ${intentType} action for debt sequence phase ${phase}`);
  return action;
}

async function reachDebtThroughVisibleActions(session: LocalSession): Promise<void> {
  for (let actionCount = 0; actionCount < 300; actionCount += 1) {
    // 先等动画/电脑思考结束再读 availableActions：presenter 在动画期间会把行动列表刻意清空
    // （见 localSession 的 availableActions computed），拿这个空数组去挑动作只会得到
    // 「No end_turn action for debt sequence phase managing」这种假失败。#23 之后地图带上了
    // 规则模块，落在模块格多出一段待选动作动画，这个窗口被撞上的概率明显变高。
    for (let microtask = 0; microtask < 1000; microtask += 1) {
      await Promise.resolve();
      if (!session.isAnimating.value && !session.isBotThinking.value) break;
    }
    if (session.state.value.debt) return;
    const phase = session.state.value.turnPhase;
    // 直接向快照要行动列表（getAvailableActions 就是 UI 用的同一个函数），不走 session.availableActions：
    // 后者是 computed，且动画期间被刻意清空，测试里很容易读到与 state 不一致的那一份（读到的空数组
    // 会被误当成「这个阶段没有 end_turn」）。
    const actions = getAvailableActions(session.state.value);
    // 单机真人抽卡确认：先接受待确认卡牌。接受后阶段可能仍是 managing（卡牌没有移动），
    // 所以这里不要求阶段推进，下一轮再找真正的推进动作。
    const acceptAction = actions.find((candidate) => candidate.intent.type === 'accept_card');
    if (acceptAction) {
      await session.sendIntent(acceptAction.intent);
      continue;
    }
    // #23 起每张地图都挂了规则模块：落在模块格会写入待选动作，先把它消费掉（同样不要求本步推进阶段，
    // 模块决策消费完之后通常仍是 managing，下一轮再取真正的推进动作）。
    const moduleAction = actions.find((candidate) => candidate.intent.type === 'module');
    if (moduleAction) {
      await session.sendIntent(moduleAction.intent);
      continue;
    }
    const action = selectDebtSequenceAction(phase, actions);

    await session.sendIntent(action.intent);
    if (session.state.value.debt) return;
    if (session.state.value.turnPhase !== phase) continue;

    const fallback = selectDebtSequenceFallback(phase, getAvailableActions(session.state.value));
    if (fallback) {
      await session.sendIntent(fallback.intent);
      if (session.state.value.debt) return;
      if (session.state.value.turnPhase !== phase) continue;
    }

    throw new Error(`Debt sequence action did not advance phase ${phase}`);
  }
}

type SessionDriveOutcome = 'condition_met' | 'error' | 'game_over' | 'step_limit';

interface DriveSessionWithBotStrategyOptions {
  observeState?: (state: LocalSession['state']['value']) => void;
  onHumanTurn?: (state: LocalSession['state']['value']) => void;
  stopWhen?: (state: LocalSession['state']['value']) => boolean;
}

async function driveSessionWithBotStrategy(
  session: LocalSession,
  options: DriveSessionWithBotStrategyOptions = {},
): Promise<SessionDriveOutcome> {
  for (let step = 0; step < 3000; step += 1) {
    for (let microtask = 0; microtask < 1000; microtask += 1) {
      await Promise.resolve();
      if (!session.isAnimating.value && !session.isBotThinking.value) break;
    }

    const state = session.state.value;
    options.observeState?.(state);
    if (options.stopWhen?.(state)) return 'condition_met';
    if (state.phase === 'game_over') return 'game_over';
    if (session.lastError.value) return 'error';

    const actorId = state.debt?.debtorId ?? state.currentPlayerId;
    const actor = state.players.find((player) => player.id === actorId);
    if (!actor) throw new Error(`Missing actor ${actorId}`);

    if (actor.isBot) {
      await session.runBotTurnIfNeeded();
      continue;
    }

    options.onHumanTurn?.(state);
    await session.sendIntent(chooseBotIntent(state as unknown as GameState, actorId));
  }

  return 'step_limit';
}

describe('createLocalSession', () => {
  it('exposes exact local presentation and public deck counts through the shared renderable contract', () => {
    const pack = getActiveMapPack('china-tour');
    const session = createLocalSession({ wait: async () => undefined, seed: 'renderable-map-contract' });

    expect(session.state.value.presentation).toBe(pack.presentation);
    expect(session.state.value.deckCounts).toEqual({
      chance: pack.game.cards.chance.length,
      destiny: pack.game.cards.destiny.length,
    });
  });

  it('creates a local game from the exact selected map pack without production-registry fallback', () => {
    const session = createLocalSession({
      mapPack: harbor,
      wait: async () => undefined,
      seed: 'harbor-local-session',
      players: [
        { id: 'p1', nickname: '甲' },
        { id: 'p2', nickname: '乙' },
      ],
    });

    expect(session.state.value.mapRef).toEqual(harbor.ref);
    expect(session.state.value.board).toBe(harbor.game.board);
    expect(session.state.value.presentation).toBe(harbor.presentation);
    expect(session.state.value.players.every((player) => harbor.game.board.cells.some((cell) => cell.id === player.position))).toBe(true);
  });

  it('chooses debt sequence intents independently of visible action order', () => {
    const skippedBuy: ClientAction = { label: '放弃', intent: { type: 'skip_buy' } };
    const boughtProperty: ClientAction = { label: '买地', intent: { type: 'buy_property' } };
    const skippedBuild: ClientAction = { label: '跳过', intent: { type: 'skip_build' } };
    const builtHouse: ClientAction = { label: '盖房', intent: { type: 'build_house' } };

    expect(selectDebtSequenceAction('awaiting_buy_decision', [skippedBuy, boughtProperty]).intent)
      .toEqual(boughtProperty.intent);
    expect(selectDebtSequenceAction('awaiting_build_decision', [skippedBuild, builtHouse]).intent)
      .toEqual(builtHouse.intent);
    expect(() => selectDebtSequenceAction('awaiting_roll', [])).toThrow(
      'No roll_dice action for debt sequence phase awaiting_roll',
    );
  });

  it('creates a self-contained local session with no room identity', () => {
    const session = createLocalSession({ wait: async () => undefined });

    expect(session.mode).toBe('local');
    expect(session.room.value).toBeNull();
    expect(session.localPlayerId.value).toBeNull();
    expect(session.connectionStatus.value).toBe('local');
    expect(session.state.value).not.toBeNull();
  });

  it('reports that offline turns cannot be skipped', async () => {
    const session = createLocalSession({ wait: async () => undefined });

    await session.skipOfflineTurn();

    expect(session.lastError.value).toBe('本地游戏不能跳过回合');
  });

  it('keeps the display snapshot behind a delayed local transition', async () => {
    const releases: Array<() => void> = [];
    const session = createLocalSession({
      players: [
        { id: 'human', nickname: '玩家' },
        { id: 'other', nickname: '对手' },
      ],
      seed: 'delayed-local-transition',
      wait: () => new Promise<void>((resolve) => { releases.push(resolve); }),
    });
    const initial = session.state.value;
    const initialPosition = initial.players.find((player) => player.id === 'human')!.position;

    const transition = session.sendIntent({ type: 'roll_dice' });
    await Promise.resolve();
    await Promise.resolve();

    expect(session.isAnimating.value).toBe(true);
    expect(session.state.value).toBe(initial);
    expect(session.displayPositions.value.human).toBe(initialPosition);
    expect(session.availableActions.value).toEqual([]);

    while (session.isAnimating.value || releases.length > 0) {
      releases.shift()?.();
      await Promise.resolve();
    }
    await transition;

    expect(session.state.value).not.toBe(initial);
    expect(session.displayPositions.value.human).toBe(
      session.state.value.players.find((player) => player.id === 'human')!.position,
    );
    expect(session.availableActions.value).toEqual(getAvailableActions(session.state.value));
  });
  it('does not publish a pending transition after disposal', async () => {
    let release!: () => void;
    const session = createLocalSession({
      wait: () => new Promise<void>((resolve) => { release = resolve; }),
    });
    const initial = session.state.value;
    const positions = { ...session.displayPositions.value };

    const transition = session.sendIntent({ type: 'roll_dice' });
    await Promise.resolve();
    await Promise.resolve();
    expect(session.isAnimating.value).toBe(true);

    session.dispose();
    release();
    await transition;

    expect(session.state.value).toBe(initial);
    expect(session.displayPositions.value).toEqual(positions);
    expect(session.isAnimating.value).toBe(false);
  });


  it('cancels delayed BOT work when disposed', async () => {
    let release!: () => void;
    const session = createLocalSession({
      autoPlayBots: true,
      botDelay: () => 1,
      players: [
        { id: 'bot', nickname: '电脑一', isBot: true },
        { id: 'bot-2', nickname: '电脑二', isBot: true },
      ],
      wait: () => new Promise<void>((resolve) => { release = resolve; }),
    });
    const stateBeforeDispose = session.state.value;
    const positionsBeforeDispose = { ...session.displayPositions.value };

    const pending = session.runBotTurnIfNeeded();
    await Promise.resolve();
    expect(session.isBotThinking.value).toBe(true);

    session.dispose();
    release();
    await pending;

    expect(session.isBotThinking.value).toBe(false);
    expect(session.state.value.currentPlayerId).toMatch(/^bot/);
    expect(session.displayPositions.value).toEqual(positionsBeforeDispose);
    expect(session.dice.value).toBeNull();
  });

  it('keeps engine authority when consumers replace the public snapshot', async () => {
    const session = createLocalSession({
      players: [
        { id: 'human', nickname: '玩家' },
        { id: 'other', nickname: '对手' },
      ],
      seed: 'private-engine-authority',
      wait: async () => undefined,
    });

    session.state.value = {
      ...session.state.value,
      phase: 'game_over',
      winnerId: 'other',
      players: session.state.value.players.map((player) =>
        player.id === 'human' ? { ...player, cash: 999_999 } : player,
      ),
    };

    await session.sendIntent({ type: 'roll_dice' });

    expect(session.state.value.phase).toBe('playing');
    expect(session.state.value.winnerId).toBeNull();
    expect(session.state.value.players.find((player) => player.id === 'human')?.cash).not.toBe(999_999);
  });

  it('rejects rolling while a legally reached debt remains unresolved', async () => {
    const session = createLocalSession({
      players: [
        { id: 'human', nickname: '玩家' },
        { id: 'other', nickname: '对手' },
      ],
      seed: '1',
      wait: async () => undefined,
    });

    await reachDebtThroughVisibleActions(session);

    expect(session.state.value.debt).not.toBeNull();
    const stateBeforeRejectedRoll = structuredClone(session.state.value);

    await session.sendIntent({ type: 'roll_dice' });

    expect(session.state.value).toEqual(stateBeforeRejectedRoll);
    expect(session.state.value.debt).toEqual(stateBeforeRejectedRoll.debt);
    expect(session.lastError.value).toBe('债务中只能卖房或抵押筹款');
  });

  it('never exposes engine seed or deck queues in snapshots', async () => {
    const session = createLocalSession({
      players: [
        { id: 'human', nickname: '玩家' },
        { id: 'other', nickname: '对手' },
      ],
      seed: 'private-engine-privacy',
      wait: async () => undefined,
    });

    expect(session.state.value).not.toHaveProperty('seed');
    expect(session.state.value).not.toHaveProperty('decks');

    await session.sendIntent({ type: 'roll_dice' });

    expect(session.state.value).not.toHaveProperty('seed');
    expect(session.state.value).not.toHaveProperty('decks');
  });

  it('continues BOT scheduling after a human presentation failure', async () => {
    let rejectPresentation = false;
    const session = createSessionWithCurrentPlayer('human', {
      autoPlayBots: true,
      botDelay: () => 1,
      players: [
        { id: 'human', nickname: '玩家' },
        { id: 'bot', nickname: '电脑', isBot: true },
      ],
      seed: 'presentation-failure-bot-schedule',
      wait: async () => {
        if (rejectPresentation) throw new Error('presentation failed');
      },
    });
    await session.sendIntent({ type: 'roll_dice' });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const state = session.state.value;
      if (!state.cardChoice?.pending && state.turnPhase === 'managing') break;
      const intent = state.cardChoice?.pending
        ? { type: 'accept_card' as const }
        : state.turnPhase === 'awaiting_buy_decision'
          ? { type: 'skip_buy' as const }
          : state.turnPhase === 'awaiting_build_decision'
            ? { type: 'skip_build' as const }
            : { type: 'roll_airport_branch' as const };
      await session.sendIntent(intent);
    }
    expect(session.state.value.turnPhase).toBe('managing');
    expect(session.state.value.cardChoice?.pending ?? null).toBeNull();

    rejectPresentation = true;
    await session.sendIntent({ type: 'end_turn' });
    for (let attempt = 0; attempt < 10 && session.isBotThinking.value; attempt += 1) await Promise.resolve();

    expect(session.state.value.currentPlayerId).toBe('bot');
    expect(session.lastError.value).toBe('presentation failed');
    expect(session.isBotThinking.value).toBe(false);
  });

  it('recovers from a rejected BOT delay without leaving the turn gated', async () => {
    const session = createSessionWithCurrentPlayer('bot', {
      autoPlayBots: true,
      botDelay: () => 1,
      players: [
        { id: 'bot', nickname: '电脑', isBot: true },
        { id: 'human', nickname: '玩家' },
      ],
      wait: async () => { throw new Error('BOT delay failed'); },
    });

    await session.runBotTurnIfNeeded();

    expect(session.isBotThinking.value).toBe(false);
    expect(session.lastError.value).toBe('BOT delay failed');

    await session.runBotTurnIfNeeded();
    expect(session.isBotThinking.value).toBe(false);
  });

  it('returns a skipped human to play after more than 20 successful BOT intents', async () => {
    const botDelay = 830_083;
    let botDelayCalls = 0;
    let burstBotDelays = 0;
    let previousBurstBotActorId: string | null = null;
    let humanWasSkippedInBurst = false;
    const session = createLocalSession({
      autoPlayBots: true,
      botDelay: () => botDelay,
      players: [
        { id: 'human', nickname: '玩家' },
        { id: 'bot-a', nickname: '电脑一', isBot: true },
        { id: 'bot-b', nickname: '电脑二', isBot: true },
      ],
      // Seed re-picked after china-tour gained rail-hub@1 (#23). The burst this test counts is
      // "how many BOT delay calls pass between two human turns", and every module decision a bot
      // makes is one more delay call inside the same round -- so the old seed '83' now ends with
      // the human acting on almost every step and never accumulates >20. A 400-seed sweep run
      // against this test's own predicate (burst > 20 && humanWasSkippedInBurst && playing &&
      // no debt && currentPlayerId === 'human') left exactly two seeds that still satisfy it:
      // '246' and '252'. A later map/module change can legitimately invalidate them again; if this
      // test starts failing on `expected 'game_over' to be 'condition_met'`, re-run that sweep
      // instead of weakening the threshold.
      // Note: a human turn never calls `wait(botDelay)` (only runBotTurnIfNeeded does), so
      // `humanWasSkippedInBurst` is really "a lap boundary passed between two BOT delays" -- it is
      // satisfied almost immediately. The load-bearing assertion is `burstBotDelays > 20`.
      seed: '252',
      wait: async (ms) => {
        if (ms !== botDelay) return;
        botDelayCalls += 1;
        const currentBotActor = session.state.value.players.find(
          (player) => player.id === session.state.value.currentPlayerId,
        );
        if (!currentBotActor?.isBot) return;

        burstBotDelays += 1;
        const human = session.state.value.players.find((player) => player.id === 'human')!;
        if (
          !human.bankrupt
          && previousBurstBotActorId === 'bot-b'
          && currentBotActor.id === 'bot-a'
        ) {
          humanWasSkippedInBurst = true;
        }
        previousBurstBotActorId = currentBotActor.id;
      },
    });

    try {
      const outcome = await driveSessionWithBotStrategy(session, {
        onHumanTurn: (state) => {
          if (
            burstBotDelays > 20
            && humanWasSkippedInBurst
            && state.phase === 'playing'
            && state.debt === null
            && state.currentPlayerId === 'human'
          ) return;

          burstBotDelays = 0;
          previousBurstBotActorId = null;
          humanWasSkippedInBurst = false;
        },
        stopWhen: (state) => (
          burstBotDelays > 20
          && humanWasSkippedInBurst
          && state.phase === 'playing'
          && state.debt === null
          && state.currentPlayerId === 'human'
        ),
      });

      expect(session.lastError.value).toBeNull();
      expect(outcome).toBe('condition_met');
      expect(burstBotDelays).toBeGreaterThan(20);
      expect(humanWasSkippedInBurst).toBe(true);
      expect(session.state.value.players.find((player) => player.id === 'human')?.bankrupt).toBe(false);
      expect(session.state.value.phase).toBe('playing');
      expect(session.state.value.debt).toBeNull();
      expect(session.state.value.currentPlayerId).toBe('human');
      expect(session.lastError.value).toBeNull();
    } finally {
      session.dispose();
    }
  });

  it('continues the BOT final after the human bankrupts until game over', async () => {
    const botDelay = 2;
    let humanBankrupt = false;
    let botDelaysAfterHumanBankruptcy = 0;
    const session = createLocalSession({
      autoPlayBots: true,
      botDelay: () => botDelay,
      players: [
        { id: 'human', nickname: '玩家' },
        { id: 'bot-a', nickname: '电脑一', isBot: true },
        { id: 'bot-b', nickname: '电脑二', isBot: true },
      ],
      // seed 只用来把「真人先破产、剩两台电脑打到底」这条剧本走通。
      // #23 给 china-tour 挂上 rail-hub@1 后经济与回合节奏变了，旧 seed '2' 会让真人一直不破产
      // （378 步后由真人获胜）；中间试过的 seed '3' 又走到另一个极端 —— 真人破产和终局发生在
      // 同一步，于是「真人破产之后电脑还在走」这段窗口为空（botDelaysAfterHumanBankruptcy === 0）。
      // seed '38' 实测真人先破产，之后两台电脑继续打完才终局（真人破产 → bot 胜），是本图上
      // 能稳定演出这条剧本的 seed。
      seed: '38',
      wait: async (ms) => {
        if (
          ms === botDelay
          && session.state.value.players.find((player) => player.id === 'human')?.bankrupt
        ) {
          botDelaysAfterHumanBankruptcy += 1;
        }
      },
    });

    try {
      const outcome = await driveSessionWithBotStrategy(session, {
        observeState: (state) => {
          humanBankrupt ||= state.players.find((player) => player.id === 'human')?.bankrupt === true;
        },
      });

      expect(humanBankrupt).toBe(true);
      expect(botDelaysAfterHumanBankruptcy).toBeGreaterThan(0);
      expect(session.lastError.value).toBeNull();
      expect(outcome).toBe('game_over');
      expect(session.state.value.phase).toBe('game_over');
      expect(session.state.value.winnerId).toMatch(/^bot-[ab]$/);
      expect(session.lastError.value).toBeNull();
    } finally {
      session.dispose();
    }
  });
});

function restoredGame(seed = 'restored-local-game'): GameState {
  const pack = getActiveMapPack('china-tour');
  return createGame({
    mapRef: pack.ref,
    ruleModules: pack.game.requiredRuleModules,
    board: pack.game.board,
    cards: pack.game.cards,
    config: pack.game.config,
    players: [{ id: 'human', nickname: '玩家' }, { id: 'other', nickname: '对手' }],
    seed,
  });
}

function persistence(overrides: Partial<LocalGamePersistence> = {}): LocalGamePersistence {
  return {
    slot: 1,
    gameId: 'saved-game',
    revision: 1,
    recordToken: 'saved-record-1',
    commit: async () => ({ ok: true, slot: 1, revision: 2 }),
    complete: async () => ({ ok: true, slot: 1, revision: 2 }),
    ...overrides,
  };
}

describe('LocalSession durable resume boundary', () => {
  it('直接从 authoritative restoreState 初始化，不重置 seed、牌堆、回合、资产或债务', () => {
    const source = restoredGame();
    const propertyId = Number(Object.keys(source.properties)[0]);
    const restored = {
      ...source,
      turn: 17,
      properties: {
        ...source.properties,
        [propertyId]: { ownerId: source.currentPlayerId, level: 2, mortgaged: false },
      },
      debt: { debtorId: source.currentPlayerId, creditorId: null, amount: 400 },
    };
    const session = createLocalSession({
      restoreState: restored,
      mapPack: getActiveMapPack('china-tour'),
      persistence: persistence(),
      wait: async () => undefined,
    });

    expect(session.state.value).toMatchObject({
      turn: 17,
      properties: restored.properties,
      debt: restored.debt,
      currentPlayerId: restored.currentPlayerId,
    });
    expect(session.saveIdentity).toEqual({
      slot: 1, gameId: 'saved-game', revision: 1, recordToken: 'saved-record-1',
    });
  });

  it('human transition 必须先 commit，成功后才发布并开始动画', async () => {
    let proposed: GameState | undefined;
    let release!: (result: Awaited<ReturnType<LocalGamePersistence['commit']>>) => void;
    const source = restoredGame('save-before-human');
    const session = createLocalSession({
      restoreState: source,
      mapPack: getActiveMapPack('china-tour'),
      persistence: persistence({
        commit: (nextState) => {
          proposed = nextState;
          return new Promise((resolve) => { release = resolve; });
        },
      }),
      wait: async () => undefined,
    });

    const transition = session.sendIntent({ type: 'roll_dice' });
    const initial = session.state.value;
    await Promise.resolve();
    expect(proposed).toBeDefined();
    expect(session.state.value).toBe(initial);
    expect(session.isAnimating.value).toBe(false);

    release({ ok: true, slot: 1, revision: 2 });
    await transition;
    expect(session.state.value.lastDice).toEqual(proposed!.lastDice);
  });

  it('commit pending 期间 single-flight 阻止第二个 human intent 复用旧 engineState', async () => {
    let release!: (result: Awaited<ReturnType<LocalGamePersistence['commit']>>) => void;
    let commits = 0;
    const session = createLocalSession({
      restoreState: restoredGame('commit-single-flight'),
      mapPack: chinaMap,
      persistence: persistence({ commit: () => {
        commits += 1;
        if (commits > 1) return Promise.resolve({ ok: true, slot: 1, revision: commits + 1 });
        return new Promise((resolve) => { release = resolve; });
      } }),
      wait: async () => undefined,
    });

    const first = session.sendIntent({ type: 'roll_dice' });
    await Promise.resolve();
    const second = session.sendIntent({ type: 'roll_dice' });
    await second;
    expect(commits).toBe(1);
    expect(session.availableActions.value).toEqual([]);

    release({ ok: true, slot: 1, revision: 2 });
    await first;
    expect(commits).toBe(1);
  });

  it('commit 失败不发布 transition，storage error 可重试，revision conflict 令 session stale', async () => {
    const source = restoredGame('failed-save');
    const storageFailure = createLocalSession({
      restoreState: source,
      mapPack: getActiveMapPack('china-tour'),
      persistence: persistence({ commit: async () => ({ ok: false, reason: 'storage_error' }) }),
      wait: async () => undefined,
    });
    const storageFailureInitial = storageFailure.state.value;
    await storageFailure.sendIntent({ type: 'roll_dice' });
    expect(storageFailure.state.value).toBe(storageFailureInitial);
    expect(storageFailure.lastError.value).toBe('保存失败，本次操作未执行');
    expect(storageFailure.staleSession.value).toBe(false);

    const conflict = createLocalSession({
      restoreState: source,
      mapPack: getActiveMapPack('china-tour'),
      persistence: persistence({ commit: async () => ({ ok: false, reason: 'revision_mismatch' }) }),
      wait: async () => undefined,
    });
    const conflictInitial = conflict.state.value;
    await conflict.sendIntent({ type: 'roll_dice' });
    expect(conflict.state.value).toBe(conflictInitial);
    expect(conflict.staleSession.value).toBe(true);
    expect(conflict.lastError.value).toBe('这局已在另一个页面更新，请返回首页重新载入');
    expect(conflict.availableActions.value).toEqual([]);
  });

  it('game_over 先 commit final state，再 complete 清理，清理失败也进入 settlement', async () => {
    const base = restoredGame('complete-game');
    const source = {
      ...base,
      turnPhase: 'managing' as const,
      cashGoal: 16_000,
      players: base.players.map((player) => (
        player.id === base.currentPlayerId ? { ...player, cash: 16_000 } : player
      )),
    };
    const calls: string[] = [];
    const session = createLocalSession({
      restoreState: source,
      mapPack: getActiveMapPack('china-tour'),
      persistence: persistence({
        commit: async (nextState) => {
          calls.push(`commit:${nextState.phase}`);
          return { ok: true, slot: 1, revision: 2 };
        },
        complete: async (finalState) => {
          calls.push(`complete:${finalState.phase}`);
          return { ok: false, reason: 'storage_error' };
        },
      }),
      wait: async () => undefined,
    });

    await session.sendIntent({ type: 'end_turn' });
    expect(calls).toEqual(['commit:game_over', 'complete:game_over']);
    expect(session.state.value.phase).toBe('game_over');
    expect(session.lastError.value).toBe('本局已结束，但存档清理失败，请返回首页后重试删除');
  });

  it('markStale 模拟 storage event 后停止 human 与 bot actions', async () => {
    const source = restoredGame('stale-event');
    let commits = 0;
    const session = createLocalSession({
      restoreState: source,
      mapPack: getActiveMapPack('china-tour'),
      persistence: persistence({
        commit: async () => { commits += 1; return { ok: true, slot: 1, revision: 2 }; },
      }),
      wait: async () => undefined,
      autoPlayBots: true,
    });

    session.markStale();
    await session.sendIntent({ type: 'roll_dice' });
    await session.runBotTurnIfNeeded();
    expect(commits).toBe(0);
    expect(session.staleSession.value).toBe(true);
    expect(session.lastError.value).toBe('这局已在另一个页面更新，请返回首页重新载入');
  });

  it('bot action 同样在 commit 完成前保持旧 authoritative/presenter state', async () => {
    let botState: GameState | undefined;
    for (let index = 0; index < 100; index += 1) {
      const candidate = createGame({
        mapRef: chinaMap.ref,
        ruleModules: chinaMap.game.requiredRuleModules,
        board: chinaMap.game.board,
        cards: chinaMap.game.cards,
        config: chinaMap.game.config,
        players: [{ id: 'human', nickname: '玩家' }, { id: 'bot', nickname: '电脑', isBot: true }],
        seed: `restore-bot-${index}`,
      });
      if (candidate.currentPlayerId === 'bot') { botState = candidate; break; }
    }
    if (!botState) throw new Error('missing bot-first seed');
    let release!: (result: Awaited<ReturnType<LocalGamePersistence['commit']>>) => void;
    let proposed: GameState | undefined;
    const session = createLocalSession({
      restoreState: botState,
      mapPack: chinaMap,
      persistence: persistence({ commit: (nextState) => {
        proposed = nextState;
        return new Promise((resolve) => { release = resolve; });
      } }),
      autoPlayBots: true,
      botDelay: () => 0,
      wait: async () => undefined,
    });

    const botTurn = session.runBotTurnIfNeeded();
    const initial = session.state.value;
    await Promise.resolve();
    await Promise.resolve();
    expect(proposed).toBeDefined();
    expect(session.state.value).toBe(initial);
    release({ ok: false, reason: 'storage_error' });
    await botTurn;
    expect(session.state.value).toBe(initial);
  });
});

const cardChoicePlayers = [
  { id: 'human', nickname: '玩家' },
  { id: 'bot', nickname: '电脑A', isBot: true },
];

/** 与会话相同的引擎构造（可选择是否开启单机真人确认模式）。 */
function createCardChoiceGame(seed: string, mode?: 'local-human'): GameState {
  return createGame({
    mapRef: chinaMap.ref,
    ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: chinaMap.game.config,
    players: cardChoicePlayers,
    seed,
    ...(mode === undefined ? {} : { cardChoiceMode: mode }),
  });
}

/** 找"指定真人/电脑玩家首次掷骰落在机会格"的确定性种子（与本地会话使用同一引擎）。 */
function findChanceLandingSeed(actorId: 'human' | 'bot'): string {
  for (let seed = 1; seed < 20000; seed += 1) {
    const game = createCardChoiceGame(String(seed), 'local-human');
    if (game.currentPlayerId !== actorId) continue;
    const rolled = applyIntent(game, actorId, { type: 'roll_dice' });
    if (!rolled.ok) continue;
    const position = rolled.state.players.find((player) => player.id === actorId)!.position;
    if (rolled.state.board.cells.find((cell) => cell.id === position)?.type === 'chance') {
      return String(seed);
    }
  }
  throw new Error(`没有找到 ${actorId} 落在机会格的种子`);
}

function createPausedCardState(): GameState {
  const started = createCardChoiceGame(findChanceLandingSeed('human'), 'local-human');
  const rolled = applyIntent(started, 'human', { type: 'roll_dice' });
  if (!rolled.ok) throw new Error(`roll failed: ${rolled.code}`);
  return rolled.state;
}

describe('单机真人抽卡确认（作弊重抽）', () => {
  const chanceSeed = findChanceLandingSeed('human');

  function createPausedSession(overrides: { persistence?: LocalGamePersistence } = {}): LocalSession {
    return createLocalSession({
      wait: async () => undefined,
      mapPack: chinaMap,
      players: cardChoicePlayers,
      seed: chanceSeed,
      ...overrides,
    });
  }

  function cashOf(session: LocalSession, playerId: string): number {
    return session.state.value.players.find((player) => player.id === playerId)!.cash;
  }

  it('真人落卡格先暂停：只提供重抽/接受，其他操作被拒绝', async () => {
    const session = createPausedSession();

    await session.sendIntent({ type: 'roll_dice' });

    const paused = session.state.value;
    expect(paused.cardChoice?.pending).toMatchObject({ playerId: 'human', deck: 'chance' });
    expect(session.availableActions.value.map((action) => action.label)).toEqual(['重新抽取', '接受并执行']);

    await session.sendIntent({ type: 'roll_dice' });
    expect(session.lastError.value).toBe('当前阶段不能执行这个操作');
    expect(session.state.value).toBe(paused);
  });

  it('重抽不限次数：卡面随牌堆更新、牌堆数量不变、未接受不产生效果', async () => {
    const session = createPausedSession();
    await session.sendIntent({ type: 'roll_dice' });
    const firstPending = session.state.value.cardChoice!.pending!;
    const cashBefore = cashOf(session, 'human');
    const deckCount = session.state.value.deckCounts.chance;

    await session.sendIntent({ type: 'redraw_card' });
    const secondPending = session.state.value.cardChoice?.pending;
    expect(secondPending?.deck).toBe('chance');
    expect(secondPending?.cardId).not.toBe(firstPending.cardId);
    expect(session.activeCard.value).toMatchObject({ deck: 'chance', cardId: secondPending?.cardId });

    await session.sendIntent({ type: 'redraw_card' });
    expect(session.state.value.cardChoice?.pending?.cardId).not.toBe(secondPending?.cardId);
    expect(session.state.value.deckCounts.chance).toBe(deckCount);
    expect(cashOf(session, 'human')).toBe(cashBefore);
    expect(session.availableActions.value.map((action) => action.label)).toEqual(['重新抽取', '接受并执行']);
  });

  it('接受只结算一次，重复接受被拒绝且状态不变', async () => {
    const session = createPausedSession();
    await session.sendIntent({ type: 'roll_dice' });

    await session.sendIntent({ type: 'accept_card' });
    expect(session.lastError.value).toBeNull();
    expect(session.state.value.cardChoice?.pending).toBeNull();
    const accepted = session.state.value;
    const acceptedCash = cashOf(session, 'human');

    await session.sendIntent({ type: 'accept_card' });
    expect(session.lastError.value).toBe('当前阶段不能执行这个操作');
    expect(session.state.value).toBe(accepted);
    expect(cashOf(session, 'human')).toBe(acceptedCash);
  });

  it('电脑玩家落卡格自动结算，不产生待确认卡牌', async () => {
    const botSeed = findChanceLandingSeed('bot');
    const session = createLocalSession({
      wait: async () => undefined,
      mapPack: chinaMap,
      players: cardChoicePlayers,
      seed: botSeed,
    });
    const immediate = createCardChoiceGame(botSeed);
    const rolled = applyIntent(immediate, 'bot', { type: 'roll_dice' });
    if (!rolled.ok) throw new Error(`roll failed: ${rolled.code}`);

    await session.sendIntent({ type: 'roll_dice' });

    expect(session.state.value.cardChoice?.pending ?? null).toBeNull();
    expect(session.state.value.players).toEqual(rolled.state.players);
    expect(session.state.value.turnPhase).toBe(rolled.state.turnPhase);
    expect(session.state.value.properties).toEqual(rolled.state.properties);
  });

  it('存档写入待确认卡牌；保存失败时保留完全相同的待确认状态与牌堆', async () => {
    let failCommits = false;
    const committed: GameState[] = [];
    const session = createPausedSession({
      persistence: persistence({
        commit: async (nextState) => {
          if (failCommits) return { ok: false, reason: 'storage_error' };
          committed.push(nextState);
          return { ok: true, slot: 1, revision: 2 };
        },
      }),
    });

    await session.sendIntent({ type: 'roll_dice' });
    const paused = session.state.value;
    expect(committed.at(-1)?.cardChoice?.pending).toMatchObject({ playerId: 'human', deck: 'chance' });

    failCommits = true;
    await session.sendIntent({ type: 'accept_card' });
    expect(session.lastError.value).toBe('保存失败，本次操作未执行');
    expect(session.state.value).toEqual(paused);
    expect(session.availableActions.value.map((action) => action.label)).toEqual(['重新抽取', '接受并执行']);

    failCommits = false;
    await session.sendIntent({ type: 'accept_card' });
    expect(session.state.value.cardChoice?.pending).toBeNull();
  });

  it('保存进行中重复点击只提交一次', async () => {
    let release!: (result: CommitLocalSaveResult) => void;
    let blockAccept = false;
    let commits = 0;
    const session = createPausedSession({
      persistence: persistence({
        commit: () => {
          commits += 1;
          if (!blockAccept) return Promise.resolve({ ok: true, slot: 1, revision: commits + 1 });
          return new Promise((resolve) => { release = resolve; });
        },
      }),
    });
    await session.sendIntent({ type: 'roll_dice' });

    blockAccept = true;
    const first = session.sendIntent({ type: 'accept_card' });
    await Promise.resolve();
    expect(session.availableActions.value).toEqual([]);
    await session.sendIntent({ type: 'accept_card' });
    expect(session.lastError.value).toBe('正在保存进度，请稍候');
    expect(commits).toBe(2);

    release({ ok: true, slot: 1, revision: 9 });
    await first;
    expect(commits).toBe(2);
    expect(session.state.value.cardChoice?.pending).toBeNull();
  });

  it('失效会话不能接受待确认卡牌', async () => {
    const session = createPausedSession();
    await session.sendIntent({ type: 'roll_dice' });
    const paused = session.state.value;

    session.markStale();

    expect(session.availableActions.value).toEqual([]);
    await session.sendIntent({ type: 'accept_card' });
    expect(session.lastError.value).toBe('这局已在另一个页面更新，请返回首页重新载入');
    expect(session.state.value).toBe(paused);
  });

  it('恢复存档：待确认卡牌立即展示，仍可重抽与接受一次', async () => {
    const restored = createPausedCardState();
    const session = createLocalSession({
      mapPack: chinaMap,
      restoreState: restored,
      persistence: persistence(),
      wait: async () => undefined,
    });

    const pending = session.state.value.cardChoice?.pending;
    expect(pending).toMatchObject({ playerId: 'human', deck: 'chance' });
    expect(session.activeCard.value).toMatchObject({ deck: 'chance', cardId: pending?.cardId });
    expect(session.availableActions.value.map((action) => action.label)).toEqual(['重新抽取', '接受并执行']);

    await session.sendIntent({ type: 'redraw_card' });
    expect(session.state.value.cardChoice?.pending?.cardId).not.toBe(pending?.cardId);
    await session.sendIntent({ type: 'accept_card' });
    expect(session.state.value.cardChoice?.pending).toBeNull();
  });

  it('旧存档（无 cardChoice 字段）载入后升级为确认模式', () => {
    const legacy = restoredGame('legacy-card-choice');
    expect(legacy.cardChoice).toBeUndefined();

    const session = createLocalSession({
      mapPack: getActiveMapPack('china-tour'),
      restoreState: legacy,
      wait: async () => undefined,
    });

    expect(session.state.value.cardChoice).toEqual({ mode: 'local-human', pending: null });
  });
});

// ── 悔棋 / 回放（P1-5）────────────────────────────────────────────────────────
// 这两个能力此前只有「按钮接线」层面的覆盖（SettingsDialog 渲染出按钮、GameView 转发事件），
// localSession 里的 undo / replay 本体是零测试的。下面用两颗真人棋子（没有电脑玩家）驱动真实
// 意图，验证：还原精度、可连续撤回、撤回与本地存档的原子性、以及回放不污染真实对局。
describe('悔棋与回放（P1-5）', () => {
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  function humanOnlySession(seed: string, persistenceOverride?: LocalGamePersistence): LocalSession {
    const pack = getActiveMapPack('china-tour');
    const initial = createGame({
      mapRef: pack.ref,
      ruleModules: pack.game.requiredRuleModules,
      board: pack.game.board,
      cards: pack.game.cards,
      config: pack.game.config,
      players: [{ id: 'human', nickname: '玩家' }, { id: 'other', nickname: '对手' }],
      seed,
    });
    return createLocalSession({
      mapPack: pack,
      restoreState: initial,
      persistence: persistenceOverride,
      wait: async () => undefined,
    });
  }

  /** 按阶段挑一个「一定会推进状态」的可见动作。全是真人，所以不会有电脑玩家抢回合。 */
  function pickPlayableAction(session: LocalSession): ClientAction {
    const actions = session.availableActions.value;
    for (const intentType of ['accept_card', 'roll_dice', 'buy_property', 'skip_buy', 'end_turn', 'skip_build']) {
      const action = actions.find((candidate) => candidate.intent.type === intentType);
      if (action) return action;
    }
    throw new Error(
      `没有可执行动作（阶段 ${session.state.value.turnPhase}）：${actions.map((a) => a.intent.type).join(',') || '空'}`,
    );
  }

  async function playNextAction(session: LocalSession): Promise<void> {
    const before = session.state.value;
    const action = pickPlayableAction(session);
    await session.sendIntent(action.intent);
    if (session.state.value === before) {
      throw new Error(`动作 ${action.intent.type} 没有产生状态推进（lastError=${session.lastError.value ?? 'null'}）`);
    }
  }

  it('撤回一步精确还原到操作前的快照，并可一路撤回到本局起点', async () => {
    const session = humanOnlySession('undo-rewind');
    const origin = clone(session.state.value);
    expect(session.canUndo.value).toBe(false);
    expect(session.canReplay.value).toBe(false);

    const snapshots: unknown[] = [];
    for (let step = 0; step < 6; step += 1) {
      snapshots.push(clone(session.state.value));
      await playNextAction(session);
      expect(session.canUndo.value).toBe(true);
      expect(session.canReplay.value).toBe(true);
    }
    expect(session.state.value).not.toEqual(origin);

    // 逐级撤回：每退一步都要落在当时记录的那份快照上，而不是「差不多」。
    for (let step = snapshots.length - 1; step >= 0; step -= 1) {
      await session.undo();
      expect(session.state.value).toEqual(snapshots[step]);
    }
    expect(session.state.value).toEqual(origin);
    // 撤到起点后历史与动作日志同步清空：既没得撤，也没得回放。
    expect(session.canUndo.value).toBe(false);
    expect(session.canReplay.value).toBe(false);
  });

  it('撤回会把还原后的状态写回本地存档，而不是只改内存', async () => {
    const commits: GameState[] = [];
    const session = humanOnlySession('undo-commit', persistence({
      commit: async (nextState) => {
        commits.push(nextState);
        return { ok: true, slot: 1, revision: commits.length + 1 };
      },
    }));

    const before = clone(session.state.value);
    await playNextAction(session);
    const afterAction = commits[commits.length - 1]!;
    commits.length = 0;

    await session.undo();

    expect(commits).toHaveLength(1);
    expect(commits[0]).not.toEqual(afterAction);
    expect(commits[0]).toMatchObject({ currentPlayerId: before.currentPlayerId, phase: before.phase });
    expect(session.lastError.value).toBeNull();
  });

  it('存档提交失败时撤回整体回滚，内存与存档不会各说各话', async () => {
    let rejectCommit = false;
    const session = humanOnlySession('undo-commit-fail', persistence({
      commit: async () => (rejectCommit
        ? { ok: false, reason: 'storage_error' }
        : { ok: true, slot: 1, revision: 2 }),
    }));

    await playNextAction(session);
    const afterAction = clone(session.state.value);

    rejectCommit = true;
    await session.undo();

    expect(session.lastError.value).toBe('撤回失败，进度未改变');
    // 关键：不能出现「棋盘退回去了、存档还停在后面」的错位，并且历史没有被白吃掉。
    expect(session.state.value).toEqual(afterAction);
    expect(session.canUndo.value).toBe(true);
    expect(session.canReplay.value).toBe(true);
  });

  it('存档版本冲突时把会话标记失效，而不是继续改一盘已被别处改过的局', async () => {
    let conflict = false;
    const session = humanOnlySession('undo-stale', persistence({
      commit: async () => (conflict
        ? { ok: false, reason: 'revision_mismatch' }
        : { ok: true, slot: 1, revision: 2 }),
    }));

    await playNextAction(session);
    conflict = true;
    await session.undo();

    expect(session.staleSession.value).toBe(true);
    expect(session.canUndo.value).toBe(false);
    expect(session.canReplay.value).toBe(false);
  });

  it('撤回后再操作，历史重新对齐：再撤一次仍然精确回到同一步', async () => {
    const session = humanOnlySession('undo-realign');

    await playNextAction(session);
    const afterFirst = clone(session.state.value);

    await playNextAction(session);
    await session.undo();
    expect(session.state.value).toEqual(afterFirst);

    // 撤回来的这一步继续往前走：新的动作成为新的「上一步」，历史不能被旧条目顶掉。
    await playNextAction(session);
    expect(session.canUndo.value).toBe(true);
    await session.undo();
    expect(session.state.value).toEqual(afterFirst);
  });

  it('回放不动真实对局状态，只把动画从头推一遍', async () => {
    const waits: number[] = [];
    const pack = getActiveMapPack('china-tour');
    const initial = createGame({
      mapRef: pack.ref,
      ruleModules: pack.game.requiredRuleModules,
      board: pack.game.board,
      cards: pack.game.cards,
      config: pack.game.config,
      players: [{ id: 'human', nickname: '玩家' }, { id: 'other', nickname: '对手' }],
      seed: 'replay-animation',
    });
    const session = createLocalSession({
      mapPack: pack,
      restoreState: initial,
      wait: async (ms: number) => { waits.push(ms); },
    });

    for (let step = 0; step < 3; step += 1) await playNextAction(session);
    const live = clone(session.state.value);
    const waitsBeforeReplay = waits.length;

    await session.replay();

    expect(session.state.value).toEqual(live);
    expect(session.canReplay.value).toBe(true);
    expect(session.canUndo.value).toBe(true);
    expect(session.lastError.value).toBeNull();
    // 回放确实播了动画（否则这里等于什么都没发生，测试就成了空断言）。
    expect(waits.length).toBeGreaterThan(waitsBeforeReplay);
  });

  it('没有历史时撤回与回放都是安全空操作', async () => {
    const session = humanOnlySession('undo-empty');
    const origin = clone(session.state.value);

    await session.undo();
    await session.replay();

    expect(session.state.value).toEqual(origin);
    expect(session.lastError.value).toBeNull();
    expect(session.canUndo.value).toBe(false);
    expect(session.canReplay.value).toBe(false);
  });
});
