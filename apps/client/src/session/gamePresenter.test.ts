import { computed, ref, shallowRef } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGamePresenter, formatRecentLogEvent, getAvailableActions } from './gamePresenter';
import type { ConnectionStatus, GameSession, RenderableGameState } from './gameSession';
import type { ChatMessage } from '@richman/protocol';
import type { GameEvent } from '@richman/engine';
import { createGame } from '@richman/engine';
import { getActiveMapPack } from '@richman/board-data';
import { resolveLocalGameState } from '../game/mapResolver';

const chinaMap = getActiveMapPack('china-tour');
const worldMap = getActiveMapPack('world-tour');

function createTestSnapshot(seed = 'test-seed', playerIds = ['p1', 'p2']): RenderableGameState {
  const raw = createGame({
    mapRef: chinaMap.ref,
    ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: chinaMap.game.config,
    seed,
    players: playerIds.map((id) => ({
      id,
      nickname: id === 'p1' ? '玩家一' : '玩家二',
    })),
  });
  return resolveLocalGameState(raw);
}

function createWorldTourSnapshot(seed = 'world-card-title'): RenderableGameState {
  return resolveLocalGameState(createGame({
    mapRef: worldMap.ref,
    ruleModules: worldMap.game.requiredRuleModules,
    board: worldMap.game.board,
    cards: worldMap.game.cards,
    config: worldMap.game.config,
    seed,
    players: [
      { id: 'p1', nickname: '玩家一' },
      { id: 'p2', nickname: '玩家二' },
    ],
  }));
}

function positionsSnapshot(state: RenderableGameState): Record<string, number> {
  return Object.fromEntries(state.players.map((p) => [p.id, p.position]));
}

function withCash(snapshot: RenderableGameState, cashByPlayerId: Record<string, number>): RenderableGameState {
  return {
    ...snapshot,
    players: snapshot.players.map((player) => ({
      ...player,
      cash: cashByPlayerId[player.id] ?? player.cash,
    })),
  };
}

function cardDrawnEvent(snapshot: RenderableGameState): GameEvent {
  const card = snapshot.cards.chance[0];
  if (!card) throw new Error('Expected a chance card');
  return { type: 'card_drawn', playerId: 'p1', deck: 'chance', cardId: card.id };
}


function deferredWait(): { wait: () => Promise<void>; release: () => void } {
  let resolve: (() => void) | undefined;
  return {
    wait: () => new Promise<void>((next) => { resolve = next; }),
    release: () => resolve?.(),
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('GamePresenter', () => {
  describe('initial refs', () => {
    it('state ref starts with the initial snapshot', () => {
      const snapshot = createTestSnapshot();
      const presenter = createGamePresenter(snapshot);
      expect(presenter.state.value).toBe(snapshot);
    });

    it('displayPositions ref starts with player positions from snapshot', () => {
      const snapshot = createTestSnapshot();
      const presenter = createGamePresenter(snapshot);
      expect(presenter.displayPositions.value).toEqual(positionsSnapshot(snapshot));
    });

    it('dice ref starts null', () => {
      const presenter = createGamePresenter(createTestSnapshot());
      expect(presenter.dice.value).toBeNull();
    });

    it('activeCard ref starts null', () => {
      const presenter = createGamePresenter(createTestSnapshot());
      expect(presenter.activeCard.value).toBeNull();
    });

    it('isAnimating ref starts false', () => {
      const presenter = createGamePresenter(createTestSnapshot());
      expect(presenter.isAnimating.value).toBe(false);
    });

    it('eventMessage ref starts with turn title for first player', () => {
      const snapshot = createTestSnapshot();
      const presenter = createGamePresenter(snapshot);
      expect(presenter.eventMessage.value).toBe('轮到 玩家一');
    });
  });

  it('uses a complete GameSession contract with resolved local presentation and deck counts', () => {
    const snapshot = resolveLocalGameState(createGame({
      mapRef: chinaMap.ref,
      ruleModules: chinaMap.game.requiredRuleModules,
      board: chinaMap.game.board,
      cards: chinaMap.game.cards,
      config: chinaMap.game.config,
      seed: 'local-state',
      players: [{ id: 'p1', nickname: '玩家一' }, { id: 'p2', nickname: '玩家二' }],
    }));
    const statuses: ConnectionStatus[] = ['local', 'connecting', 'connected', 'reconnecting', 'failed'];
    const session: GameSession = {
      mode: 'local',
      state: shallowRef(snapshot),
      room: shallowRef(null),
      localPlayerId: ref('p1'),
      connectionStatus: ref('local'),
      displayPositions: ref({ p1: 0 }),
      dice: ref(null),
      activeCard: ref(null),
      eventMessage: ref('轮到 玩家一'),
      isAnimating: ref(false),
      isBotThinking: ref(false),
      lastError: ref(null),
      compatibilityError: ref(null),
      cashNotices: ref([]),
      displayCash: ref({ p1: 0 }),
      transientNotice: ref(null),
      availableActions: computed(() => []),
      chatLog: ref<ChatMessage[]>([]),
      sendChat() {},
      sendIntent: async () => undefined,
      skipOfflineTurn: async () => undefined,
      leave: async () => undefined,
      dispose: () => undefined,
    };

    expect(statuses).toHaveLength(5);
    expect(session.state.value).toBe(snapshot);
    expect(snapshot.deckCounts).toEqual({
      chance: snapshot.cards.chance.length,
      destiny: snapshot.cards.destiny.length,
    });
    expect(snapshot.presentation).toBeDefined();
  });

  describe('reset', () => {
    it('sync resets displayPositions to new snapshot positions', () => {
      const s1 = createTestSnapshot('seed-1');
      const presenter = createGamePresenter(s1);
      const s2 = createTestSnapshot('seed-2', ['p2', 'p1']);
      presenter.reset(s2);
      expect(presenter.displayPositions.value).toEqual(positionsSnapshot(s2));
    });

    it('sync resets activeCard to null', () => {
      const presenter = createGamePresenter(createTestSnapshot());
      const s2 = createTestSnapshot('seed-2');
      presenter.activeCard.value = { deck: 'chance', cardId: 'c1', text: 'test' };
      presenter.reset(s2);
      expect(presenter.activeCard.value).toBeNull();
    });
    it('sync resets dice to null', () => {
      const presenter = createGamePresenter(createTestSnapshot());
      const s2 = createTestSnapshot('seed-2');
      presenter.dice.value = [3, 4];
      presenter.reset(s2);
      expect(presenter.dice.value).toBeNull();
    });
    it('sync resets isAnimating to false', () => {
      const presenter = createGamePresenter(createTestSnapshot());
      const s2 = createTestSnapshot('seed-2');
      presenter.isAnimating.value = true;
      presenter.reset(s2);
      expect(presenter.isAnimating.value).toBe(false);
    });


    it('sync updates state ref to new snapshot', () => {
      const s1 = createTestSnapshot('seed-1');
      const presenter = createGamePresenter(s1);
      const s2 = createTestSnapshot('seed-2');
      presenter.reset(s2);
      expect(presenter.state.value).toBe(s2);
    });

    it('sync resets eventMessage to the new turn title', () => {
      const presenter = createGamePresenter(createTestSnapshot('seed-1'));
      presenter.eventMessage.value = '旧对局事件';
      const snapshot = createTestSnapshot('seed-2', ['p2', 'p1']);

      presenter.reset(snapshot);

      expect(presenter.eventMessage.value).toBe('轮到 玩家二');
    });

    it('reset during playEvents prevents stale overwrite', async () => {
      const snapshot = createTestSnapshot('seed-1');
      const presenter = createGamePresenter(snapshot, () => new Promise<void>((r) => globalThis.setTimeout(r, 5)));
      const s2 = createTestSnapshot('seed-2');

      const longPath = Array.from({ length: 5 }, (_, i) => i + 1);
      const playPromise = presenter.playEvents(
        [{ type: 'token_moved', playerId: 'p1', path: longPath }],
        snapshot,
      );

      // Yield once to let playback start, then reset
      await new Promise<void>((r) => globalThis.setTimeout(r, 1));
      presenter.reset(s2);

      await playPromise;

      // State should be the reset one, not overwritten by old generation
      expect(presenter.displayPositions.value).toEqual(positionsSnapshot(s2));
      expect(presenter.state.value).toBe(s2);
      expect(presenter.isAnimating.value).toBe(false);
    });

    it.each(['reset', 'dispose'] as const)('%s cancels both running and queued batches', async (operation) => {
      const initial = createTestSnapshot();
      const replacement = createTestSnapshot('replacement');
      const waits: Array<() => void> = [];
      const presenter = createGamePresenter(initial, () => new Promise<void>((resolve) => waits.push(resolve)));
      const first = presenter.playEvents([{ type: 'dice_rolled', playerId: 'p1', dice: [2, 3] }], initial);
      const second = presenter.playEvents([{ type: 'dice_rolled', playerId: 'p2', dice: [1, 4] }], initial);

      await Promise.resolve();
      await Promise.resolve();
      if (operation === 'reset') presenter.reset(replacement);
      else {
        presenter.dispose();
        presenter.reset(replacement);
      }

      waits[0]?.();
      await Promise.all([first, second]);

      expect(presenter.state.value).toBe(replacement);
      expect(presenter.displayPositions.value).toEqual(positionsSnapshot(replacement));
      expect(presenter.dice.value).toBeNull();
      expect(presenter.isAnimating.value).toBe(false);
    });
  });

  describe('play events', () => {
    it('playEvents sets dice for dice_rolled and turns isAnimating on/off', async () => {
      const snapshot = createTestSnapshot();
      const presenter = createGamePresenter(snapshot);
      const events: GameEvent[] = [
        { type: 'dice_rolled', playerId: 'p1', dice: [3, 4] },
      ];

      await presenter.playEvents(events, snapshot);

      expect(presenter.dice.value).toEqual([3, 4]);
      expect(presenter.isAnimating.value).toBe(false);
    });

    it('playEvents updates eventMessage for each event', async () => {
      const snapshot = createTestSnapshot();
      const presenter = createGamePresenter(snapshot, () => new Promise<void>((r) => globalThis.setTimeout(r, 1)));
      const events: GameEvent[] = [
        { type: 'dice_rolled', playerId: 'p1', dice: [1, 2] },
        { type: 'token_moved', playerId: 'p1', path: [2] },
      ];

      await presenter.playEvents(events, snapshot);

      expect(presenter.eventMessage.value).toContain('前进到');
      expect(presenter.isAnimating.value).toBe(false);
    });

    it('playEvents updates displayPositions for token_moved', async () => {
      const initial = createTestSnapshot();
      const snapshot = {
        ...initial,
        players: initial.players.map((player) => player.id === 'p1' ? { ...player, position: 5 } : player),
      };
      const presenter = createGamePresenter(snapshot, () => new Promise<void>((r) => globalThis.setTimeout(r, 1)));
      const events: GameEvent[] = [
        { type: 'token_moved', playerId: 'p1', path: [3, 5] },
      ];

      await presenter.playEvents(events, snapshot);

      expect(presenter.displayPositions.value.p1).toBe(5);
      expect(presenter.isAnimating.value).toBe(false);
    });

    it('publishes the final snapshot only after movement playback completes', async () => {
      const initial = createTestSnapshot();
      const final = {
        ...initial,
        players: initial.players.map((player) => player.id === 'p1'
          ? { ...player, position: 5, cash: player.cash - 1_000 }
          : player),
        properties: { ...initial.properties, 2: { ownerId: 'p1', level: 0, mortgaged: false } },
      };
      const next = deferredWait();
      const presenter = createGamePresenter(initial, next.wait);
      const playback = presenter.playEvents([{ type: 'token_moved', playerId: 'p1', path: [3, 5] }], final);
      expect(presenter.state.value).toBe(initial);
      expect(presenter.displayPositions.value).toEqual(positionsSnapshot(initial));

      await Promise.resolve();
      await Promise.resolve();
      expect(presenter.state.value).toBe(initial);
      expect(presenter.displayPositions.value.p1).toBe(3);

      next.release();
      await Promise.resolve();
      next.release();
      await playback;
      expect(presenter.state.value).toBe(final);
      expect(presenter.displayPositions.value).toEqual(positionsSnapshot(final));
      expect(presenter.availableActions.value).toEqual(getAvailableActions(final));
    });

    it('reconciles the final snapshot after a movement wait rejects while preserving the rejection', async () => {
      const initial = createTestSnapshot();
      const final = {
        ...initial,
        players: initial.players.map((player) => player.id === 'p1' ? { ...player, position: 5 } : player),
      };
      const rejection = new Error('animation wait failed');
      const presenter = createGamePresenter(initial, async () => Promise.reject(rejection));

      const playback = presenter.playEvents([{ type: 'token_moved', playerId: 'p1', path: [3, 5] }], final);

      await expect(playback).rejects.toBe(rejection);
      expect(presenter.state.value).toBe(final);
      expect(presenter.displayPositions.value).toEqual(positionsSnapshot(final));
      expect(presenter.isAnimating.value).toBe(false);
    });

    it('does not reconcile a rejected old generation over a reset snapshot', async () => {
      const initial = createTestSnapshot();
      const final = {
        ...initial,
        players: initial.players.map((player) => player.id === 'p1' ? { ...player, position: 5 } : player),
      };
      const replacement = {
        ...createTestSnapshot('replacement'),
        players: createTestSnapshot('replacement').players.map((player) => player.id === 'p1'
          ? { ...player, position: 9 }
          : player),
      };
      let rejectWait: ((reason?: unknown) => void) | undefined;
      const presenter = createGamePresenter(initial, () => new Promise<void>((_, reject) => { rejectWait = reject; }));
      const playback = presenter.playEvents([{ type: 'token_moved', playerId: 'p1', path: [3, 5] }], final);

      await Promise.resolve();
      await Promise.resolve();
      rejectWait?.(new Error('animation wait failed'));
      presenter.reset(replacement);

      await expect(playback).rejects.toThrow('animation wait failed');
      expect(presenter.state.value).toBe(replacement);
      expect(presenter.displayPositions.value).toEqual(positionsSnapshot(replacement));
      expect(presenter.isAnimating.value).toBe(false);
    });

    it('playEvents sets activeCard for card_drawn', async () => {
      const snapshot = createTestSnapshot();
      const presenter = createGamePresenter(snapshot, () => new Promise<void>((r) => globalThis.setTimeout(r, 1)));
      const events: GameEvent[] = [
        { type: 'card_drawn', playerId: 'p1', deck: 'chance', cardId: 'cc01' },
      ];

      await presenter.playEvents(events, snapshot);

      expect(presenter.activeCard.value).not.toBeNull();
      expect(presenter.activeCard.value?.deck).toBe('chance');
      expect(presenter.activeCard.value?.cardId).toBe('cc01');
      expect(presenter.isAnimating.value).toBe(false);
    });

    it('World Tour card_drawn preserves title and settlement text', async () => {
      const snapshot = createWorldTourSnapshot();
      const card = snapshot.cards.chance[0]!;
      const presenter = createGamePresenter(snapshot, async () => undefined);

      await presenter.playEvents([
        { type: 'card_drawn', playerId: 'p1', deck: 'chance', cardId: card.id },
      ], snapshot);

      expect(presenter.activeCard.value).toEqual({
        deck: 'chance', cardId: card.id, title: card.title, text: card.text,
      });
    });

    it('China Tour card_drawn keeps the legacy title-less shape', async () => {
      const snapshot = createTestSnapshot();
      const card = snapshot.cards.chance[0]!;
      const presenter = createGamePresenter(snapshot, async () => undefined);

      await presenter.playEvents([
        { type: 'card_drawn', playerId: 'p1', deck: 'chance', cardId: card.id },
      ], snapshot);

      expect(presenter.activeCard.value).toEqual({
        deck: 'chance', cardId: card.id, text: card.text,
      });
      expect(Object.hasOwn(presenter.activeCard.value!, 'title')).toBe(false);
    });

    it('unknown card id keeps the existing id fallback without inventing a title', async () => {
      const snapshot = createWorldTourSnapshot();
      const presenter = createGamePresenter(snapshot, async () => undefined);

      await presenter.playEvents([
        { type: 'card_drawn', playerId: 'p1', deck: 'chance', cardId: 'missing-card' },
      ], snapshot);

      expect(presenter.activeCard.value).toEqual({
        deck: 'chance', cardId: 'missing-card', text: 'missing-card',
      });
      expect(Object.hasOwn(presenter.activeCard.value!, 'title')).toBe(false);
    });

    it('playEvents updates eventMessage for salary events', async () => {
      const snapshot = createTestSnapshot();
      const presenter = createGamePresenter(snapshot, () => new Promise<void>((r) => globalThis.setTimeout(r, 1)));
      const events: GameEvent[] = [
        { type: 'salary_collected', playerId: 'p1', amount: 2000 },
      ];

      await presenter.playEvents(events, snapshot);

      expect(presenter.eventMessage.value).toContain('¥2,000');
      expect(presenter.isAnimating.value).toBe(false);
    });

    it('playEvents clears activeCard on turn_started', async () => {
      const snapshot = createTestSnapshot();
      const presenter = createGamePresenter(snapshot, () => new Promise<void>((r) => globalThis.setTimeout(r, 1)));
      const events: GameEvent[] = [
        { type: 'card_drawn', playerId: 'p1', deck: 'chance', cardId: 'cc01' },
        { type: 'turn_started', playerId: 'p2' },
      ];

      await presenter.playEvents(events, snapshot);

      expect(presenter.activeCard.value).toBeNull();
      expect(presenter.isAnimating.value).toBe(false);
    });

    it('playEvents sets isAnimating true during playback and false after', async () => {
      const snapshot = createTestSnapshot();
      const presenter = createGamePresenter(snapshot, () => new Promise<void>((r) => globalThis.setTimeout(r, 10)));

      const playPromise = presenter.playEvents(
        [{ type: 'dice_rolled', playerId: 'p1', dice: [1, 1] }],
        snapshot,
      );

      expect(presenter.isAnimating.value).toBe(true);

      await playPromise;
      expect(presenter.isAnimating.value).toBe(false);
    });

    it('dispose during playEvents prevents stale state writes', async () => {
      const snapshot = createTestSnapshot();
      const presenter = createGamePresenter(snapshot, () => new Promise<void>((r) => globalThis.setTimeout(r, 5)));
      const s2 = createTestSnapshot('seed-after-reset');

      const longPath = Array.from({ length: 10 }, (_, i) => i + 1);
      const playPromise = presenter.playEvents(
        [{ type: 'token_moved', playerId: 'p1', path: longPath }],
        snapshot,
      );

      // Yield to let playback start, then dispose
      await new Promise<void>((r) => globalThis.setTimeout(r, 1));
      presenter.dispose();
      presenter.reset(s2);

      await playPromise;

      expect(presenter.displayPositions.value).toEqual(positionsSnapshot(s2));
      expect(presenter.state.value).toBe(s2);
      expect(presenter.isAnimating.value).toBe(false);
    });

    it('dispose cancels pending playback without side effects', () => {
      const snapshot = createTestSnapshot();
      const presenter = createGamePresenter(snapshot);

      presenter.dispose();

      expect(presenter.state.value).toBe(snapshot);
      expect(presenter.isAnimating.value).toBe(false);
    });

    it('calling playEvents multiple times queues sequentially', async () => {
      const snapshot = createTestSnapshot();
      const presenter = createGamePresenter(snapshot, () => new Promise<void>((r) => globalThis.setTimeout(r, 1)));

      const firstEvents: GameEvent[] = [
        { type: 'dice_rolled', playerId: 'p1', dice: [2, 3] },
      ];
      const secondEvents: GameEvent[] = [
        { type: 'dice_rolled', playerId: 'p2', dice: [1, 4] },
      ];

      await presenter.playEvents(firstEvents, snapshot);
      expect(presenter.dice.value).toEqual([2, 3]);

      await presenter.playEvents(secondEvents, snapshot);
      expect(presenter.dice.value).toEqual([1, 4]);
      expect(presenter.isAnimating.value).toBe(false);
    });

    it('serializes overlapping batches in FIFO order until the queue drains', async () => {
      const snapshot = createTestSnapshot();
      const firstStep = deferredWait();
      const secondStep = deferredWait();
      let waits = 0;
      const presenter = createGamePresenter(snapshot, () => (++waits === 1 ? firstStep.wait() : secondStep.wait()));

      const first = presenter.playEvents([{ type: 'dice_rolled', playerId: 'p1', dice: [2, 3] }], snapshot);

      const second = presenter.playEvents([{ type: 'dice_rolled', playerId: 'p2', dice: [1, 4] }], snapshot);

      await Promise.resolve();
      expect(presenter.dice.value).toEqual([2, 3]);
      expect(presenter.isAnimating.value).toBe(true);

      await Promise.resolve();
      expect(presenter.dice.value).toEqual([2, 3]);
      firstStep.release();
      await first;
      await Promise.resolve();
      expect(presenter.dice.value).toEqual([1, 4]);
      expect(presenter.isAnimating.value).toBe(true);

      secondStep.release();
      await second;
      expect(presenter.isAnimating.value).toBe(false);
    });

    it('publishes each queued snapshot only when its FIFO batch starts', async () => {
      const initial = createTestSnapshot();
      const firstFinal = {
        ...initial,
        players: initial.players.map((player) => player.id === 'p1' ? { ...player, position: 5 } : player),
      };
      const secondFinal = {
        ...firstFinal,
        players: firstFinal.players.map((player) => player.id === 'p2' ? { ...player, position: 7 } : player),
      };
      const firstWait = deferredWait();
      const secondWait = deferredWait();
      let waitIndex = 0;
      const presenter = createGamePresenter(initial, () => (
        (++waitIndex === 1 ? firstWait : secondWait).wait()
      ));

      const first = presenter.playEvents(
        [{ type: 'token_moved', playerId: 'p1', path: [5] }],
        firstFinal,
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(presenter.state.value).toBe(initial);
      expect(presenter.displayPositions.value).toEqual({ p1: 5, p2: 0 });

      const second = presenter.playEvents(
        [{ type: 'dice_rolled', playerId: 'p2', dice: [3, 4] }],
        secondFinal,
      );
      expect(presenter.state.value).toBe(initial);
      expect(presenter.displayPositions.value).toEqual({ p1: 5, p2: 0 });

      firstWait.release();
      await first;
      expect(presenter.state.value).toBe(firstFinal);
      expect(presenter.displayPositions.value).toEqual({ p1: 5, p2: 0 });

      await Promise.resolve();
      await Promise.resolve();
      expect(presenter.state.value).toBe(firstFinal);
      expect(presenter.dice.value).toEqual([3, 4]);
      expect(presenter.displayPositions.value).toEqual({ p1: 5, p2: 0 });

      secondWait.release();
      await second;
      expect(presenter.state.value).toBe(secondFinal);
      expect(presenter.displayPositions.value).toEqual({ p1: 5, p2: 7 });
    });

    it('continues queued playback after a batch wait rejects', async () => {
      const snapshot = createTestSnapshot();
      let waits = 0;
      const presenter = createGamePresenter(snapshot, () => {
        waits++;
        return waits === 1 ? Promise.reject(new Error('animation failed')) : Promise.resolve();
      });
      const failed = presenter.playEvents([{ type: 'dice_rolled', playerId: 'p1', dice: [2, 3] }], snapshot);
      const next = presenter.playEvents([{ type: 'dice_rolled', playerId: 'p2', dice: [1, 4] }], snapshot);

      await expect(failed).rejects.toThrow('animation failed');
      await next;

      expect(presenter.dice.value).toEqual([1, 4]);
      expect(presenter.isAnimating.value).toBe(false);
    });

    it('holds a drawn card for 3000 ms while a dice roll dwells for 600 ms', async () => {
      const snapshot = createTestSnapshot();
      const waits: number[] = [];
      const presenter = createGamePresenter(snapshot, async (ms) => { waits.push(ms); });

      await presenter.playEvents([
        cardDrawnEvent(snapshot),
        { type: 'dice_rolled', playerId: 'p1', dice: [1, 2] },
      ], snapshot);

      expect(waits).toEqual([3_000, 600]);
    });

    it('scales durations by the live pace multiplier', async () => {
      const snapshot = createTestSnapshot();
      const waits: number[] = [];
      const presenter = createGamePresenter(snapshot, async (ms) => { waits.push(ms); }, () => 2);

      await presenter.playEvents([
        { type: 'payment_made', from: 'p1', to: 'p2', amount: 200 },
        { type: 'token_moved', playerId: 'p1', path: [3, 4] },
      ], snapshot);

      // payment_made 基础 700ms × pace2 = 1400ms；token_moved 基础已由 150ms 放慢到 260ms（棋子逐格可见）
      // → 260 × 2 = 520ms。
      expect(waits).toEqual([1_400, 520, 520]);
    });

    it.each([
      { pace: 10, expected: 4_500 },
      { pace: 0.2, expected: 1_500 },
    ])('clamps card dwell to $expected ms at pace $pace', async ({ pace, expected }) => {
      const snapshot = createTestSnapshot();
      const waits: number[] = [];
      const presenter = createGamePresenter(snapshot, async (ms) => { waits.push(ms); }, () => pace);

      await presenter.playEvents([cardDrawnEvent(snapshot)], snapshot);

      expect(waits).toEqual([expected]);
    });

    it('fast-forwards queued batches while the server is more than one transition ahead', async () => {
      const initial = createTestSnapshot();
      const waits: number[] = [];
      const presenter = createGamePresenter(initial, async (ms) => { waits.push(ms); });
      const payment: GameEvent = { type: 'bank_paid', playerId: 'p1', amount: 100 };

      await Promise.all([
        presenter.playEvents([payment], initial),
        presenter.playEvents([payment], initial),
        presenter.playEvents([payment], initial),
        presenter.playEvents([payment], initial),
      ]);

      expect(waits).toEqual([175, 175, 700, 700]);
    });

    it('does not let stale playback decrement the queue after reset', async () => {
      const initial = createTestSnapshot();
      const waits: number[] = [];
      const oldGate = deferredWait();
      const currentGate = deferredWait();
      const gates = [oldGate, currentGate];
      let waitIndex = 0;
      const presenter = createGamePresenter(initial, async (ms) => {
        waits.push(ms);
        const gate = gates[waitIndex++];
        if (gate !== undefined) await gate.wait();
      });
      const payment: GameEvent = { type: 'bank_paid', playerId: 'p1', amount: 100 };

      const stalePlayback = presenter.playEvents([payment], initial);
      await Promise.resolve();
      presenter.reset(initial);
      const currentPlayback = presenter.playEvents([payment], initial);
      await Promise.resolve();

      oldGate.release();
      await stalePlayback;
      const queuedPlayback = [
        presenter.playEvents([payment], initial),
        presenter.playEvents([payment], initial),
        presenter.playEvents([payment], initial),
      ];
      currentGate.release();
      await Promise.all([currentPlayback, ...queuedPlayback]);

      expect(waits).toEqual([700, 700, 175, 700, 700]);
    });

    it('keeps card text readable while queued batches catch up', async () => {
      const snapshot = createTestSnapshot();
      const waits: number[] = [];
      const presenter = createGamePresenter(snapshot, async (ms) => { waits.push(ms); });
      const card = cardDrawnEvent(snapshot);

      await Promise.all([
        presenter.playEvents([card], snapshot),
        presenter.playEvents([card], snapshot),
        presenter.playEvents([card], snapshot),
        presenter.playEvents([card], snapshot),
      ]);

      expect(waits).toEqual([1_500, 1_500, 3_000, 3_000]);
    });

    it('does not publish a cash notice when paired snapshots have equal cash', async () => {
      const snapshot = createTestSnapshot();
      const presenter = createGamePresenter(snapshot, async () => undefined);

      await presenter.playEvents([{ type: 'dice_rolled', playerId: 'p1', dice: [1, 2] }], snapshot);

      expect(presenter.cashNotices.value).toEqual([]);
    });

    it('replaces the cash pill with each cash event so the latest step stays visible', async () => {
      const initial = createTestSnapshot();
      const p1 = initial.players.find((player) => player.id === 'p1');
      if (!p1) throw new Error('Expected p1');
      const final = withCash(initial, { p1: p1.cash - 200 });
      const presenter = createGamePresenter(initial, async () => undefined);

      await presenter.playEvents([
        { type: 'bank_paid', playerId: 'p1', amount: 500 },
        { type: 'bank_received', playerId: 'p1', amount: 300 },
      ], final);

      expect(presenter.cashNotices.value.map(({ playerId, delta }) => ({ playerId, delta }))).toEqual([
        { playerId: 'p1', delta: 300 },
      ]);
      expect(presenter.displayCash.value.p1).toBe(p1.cash - 200);
    });

    it.each([
      {
        event: { type: 'property_sold', playerId: 'p1', cellId: 2, amount: 300 } as const,
        delta: 300,
      },
      {
        event: { type: 'property_mortgaged', playerId: 'p1', cellId: 2, amount: 300 } as const,
        delta: 300,
      },
      {
        event: { type: 'property_redeemed', playerId: 'p1', cellId: 2, amount: 300 } as const,
        delta: -300,
      },
    ])('publishes $event.type cash when that event starts', async ({ event, delta }) => {
      const initial = createTestSnapshot();
      const p1 = initial.players.find((player) => player.id === 'p1');
      if (!p1) throw new Error('Expected p1');
      const final = withCash(initial, { p1: p1.cash + delta });
      const wait = deferredWait();
      const presenter = createGamePresenter(initial, wait.wait);

      const playback = presenter.playEvents([event], final);
      await Promise.resolve();

      expect(presenter.displayCash.value.p1).toBe(p1.cash + delta);
      expect(presenter.cashNotices.value).toEqual([
        expect.objectContaining({ playerId: 'p1', delta }),
      ]);

      wait.release();
      await playback;
    });

    it('publishes payment notices for both sides in event order even when players reordered', async () => {
      const initial = createTestSnapshot();
      const p1 = initial.players.find((player) => player.id === 'p1');
      const p2 = initial.players.find((player) => player.id === 'p2');
      if (!p1 || !p2) throw new Error('Expected both players');
      const reordered = { ...initial, players: [...initial.players].reverse() };
      const final = withCash(reordered, { p1: p1.cash - 500, p2: p2.cash + 500 });
      const presenter = createGamePresenter(initial, async () => undefined);

      await presenter.playEvents([{ type: 'payment_made', from: 'p1', to: 'p2', amount: 500 }], final);

      expect(presenter.cashNotices.value.map(({ playerId, delta }) => ({ playerId, delta }))).toEqual([
        { playerId: 'p1', delta: -500 },
        { playerId: 'p2', delta: 500 },
      ]);
      expect(presenter.displayCash.value).toMatchObject({ p1: p1.cash - 500, p2: p2.cash + 500 });
    });

    it('publishes both sides of a bankruptcy cash transfer', async () => {
      const initial = createTestSnapshot();
      const p1 = initial.players.find((player) => player.id === 'p1');
      const p2 = initial.players.find((player) => player.id === 'p2');
      if (!p1 || !p2) throw new Error('Expected both players');
      const final = withCash(initial, { p1: p1.cash - 800, p2: p2.cash + 800 });
      const presenter = createGamePresenter(initial, async () => undefined);

      await presenter.playEvents([
        { type: 'player_bankrupt', playerId: 'p1', creditorId: 'p2', transferredCash: 800 },
      ], final);

      expect(presenter.cashNotices.value.map(({ playerId, delta }) => ({ playerId, delta }))).toEqual([
        { playerId: 'p1', delta: -800 },
        { playerId: 'p2', delta: 800 },
      ]);
    });

    it('publishes a residual notice when the final snapshot drifts from event-tracked cash', async () => {
      const initial = createTestSnapshot();
      const p1 = initial.players.find((player) => player.id === 'p1');
      if (!p1) throw new Error('Expected p1');
      const final = withCash(initial, { p1: p1.cash - 300 });
      const presenter = createGamePresenter(initial, async () => undefined);

      await presenter.playEvents([{ type: 'house_built', cellId: 2, level: 1, amount: 300 }], final);

      expect(presenter.cashNotices.value.map(({ playerId, delta }) => ({ playerId, delta }))).toEqual([
        { playerId: 'p1', delta: -300 },
      ]);
      expect(presenter.displayCash.value.p1).toBe(p1.cash - 300);
    });

    it('replaces a changed player notice in a new transition while retaining other players', async () => {
      const initial = createTestSnapshot();
      const p1 = initial.players.find((player) => player.id === 'p1');
      const p2 = initial.players.find((player) => player.id === 'p2');
      if (!p1 || !p2) throw new Error('Expected both players');
      const first = withCash(initial, { p1: p1.cash - 100, p2: p2.cash + 100 });
      const second = withCash(first, { p1: p1.cash - 300 });
      const presenter = createGamePresenter(initial, async () => undefined);

      await presenter.playEvents([{ type: 'payment_made', from: 'p1', to: 'p2', amount: 100 }], first);
      const p2Notice = presenter.cashNotices.value.find((notice) => notice.playerId === 'p2');
      await presenter.playEvents([{ type: 'bank_paid', playerId: 'p1', amount: 200 }], second);
      const p1Notice = presenter.cashNotices.value.find((notice) => notice.playerId === 'p1');

      expect(presenter.cashNotices.value).toHaveLength(2);
      expect(p1Notice).toMatchObject({ playerId: 'p1', delta: -200, transitionId: 2 });
      expect(p2Notice).toMatchObject({ playerId: 'p2', delta: 100, transitionId: 1 });
      expect(presenter.cashNotices.value.find((notice) => notice.playerId === 'p2')).toBe(p2Notice);
    });

    it('does not publish a cash notice for a standalone snapshot', async () => {
      const initial = createTestSnapshot();
      const p1 = initial.players.find((player) => player.id === 'p1');
      if (!p1) throw new Error('Expected p1');
      const presenter = createGamePresenter(initial, async () => undefined);

      await presenter.receiveSnapshot(withCash(initial, { p1: p1.cash - 500 }));

      expect(presenter.cashNotices.value).toEqual([]);
    });

    it.each(['reset', 'dispose'] as const)('%s clears notices and cancels stale playback publication', async (operation) => {
      const initial = createTestSnapshot();
      const p1 = initial.players.find((player) => player.id === 'p1');
      if (!p1) throw new Error('Expected p1');
      const visible = withCash(initial, { p1: p1.cash - 100 });
      const stale = withCash(visible, { p1: p1.cash - 300 });
      const next = deferredWait();
      let waits = 0;
      const presenter = createGamePresenter(initial, () => (++waits === 1 ? Promise.resolve() : next.wait()));

      await presenter.playEvents([{ type: 'bank_paid', playerId: 'p1', amount: 100 }], visible);
      const stalePlayback = presenter.playEvents([{ type: 'bank_paid', playerId: 'p1', amount: 200 }], stale);
      await Promise.resolve();
      if (operation === 'reset') presenter.reset(initial);
      else presenter.dispose();
      next.release();
      await stalePlayback;

      expect(presenter.cashNotices.value).toEqual([]);
      expect(presenter.state.value).toBe(operation === 'reset' ? initial : visible);
      expect(presenter.isAnimating.value).toBe(false);
    });

    const cardContextEvents: GameEvent[] = [
      { type: 'rent_paid', from: 'p1', to: 'p2', cellId: 2, amount: 200 },
      { type: 'tax_paid', playerId: 'p1', amount: 200 },
      { type: 'bank_paid', playerId: 'p1', amount: 200 },
      { type: 'bank_received', playerId: 'p1', amount: 200 },
      { type: 'payment_made', from: 'p1', to: 'p2', amount: 200 },
      { type: 'debt_entered', debtorId: 'p1', amount: 500, creditorId: null },
      { type: 'debt_resolved', amount: 500, creditorId: null },
    ];

    it.each(cardContextEvents)('preserves card context for $type', async (event) => {
      const snapshot = createTestSnapshot();
      const presenter = createGamePresenter(snapshot, () => Promise.resolve());
      const card = snapshot.cards.chance[0];
      if (!card) throw new Error('Expected a chance card');

      await presenter.playEvents([
        { type: 'card_drawn', playerId: 'p1', deck: 'chance', cardId: card.id },
        event,
      ], snapshot);

      expect(presenter.eventMessage.value).toBe(`${formatRecentLogEvent(snapshot, event)}｜卡牌：${card.text}`);
    });

    const plainEvents: GameEvent[] = [
      { type: 'game_started' },
      { type: 'salary_collected', playerId: 'p1', amount: 2000 },
      { type: 'property_bought', playerId: 'p1', cellId: 2, price: 1000 },
      { type: 'buy_declined' },
      { type: 'house_built', cellId: 2, level: 1, amount: 300 },
      { type: 'house_sold', cellId: 2, level: 0 },
      { type: 'property_sold', playerId: 'p1', cellId: 2, amount: 1000 },
      { type: 'property_mortgaged', playerId: 'p1', cellId: 2, amount: 500 },
      { type: 'property_redeemed', playerId: 'p1', cellId: 2, amount: 550 },
      { type: 'player_bankrupt', playerId: 'p1', creditorId: null, transferredCash: 0 },
      { type: 'turn_ended', playerId: 'p1' },
      { type: 'game_over', winnerId: 'p1', reason: 'last_standing' },
    ];

    it.each(plainEvents)('does not add card context for $type', async (event) => {
      const snapshot = createTestSnapshot();
      const presenter = createGamePresenter(snapshot, () => Promise.resolve());
      const card = snapshot.cards.chance[0];
      if (!card) throw new Error('Expected a chance card');

      await presenter.playEvents([
        { type: 'card_drawn', playerId: 'p1', deck: 'chance', cardId: card.id },
        event,
      ], snapshot);

      expect(presenter.eventMessage.value).toBe(formatRecentLogEvent(snapshot, event));
    });
    it('pairs FIFO event batches with their immediately following snapshots and resets on a standalone snapshot', async () => {
      const initial = createTestSnapshot();
      const firstSnapshot = { ...initial, players: initial.players.map((player) => player.id === 'p1' ? { ...player, position: 3 } : player) };
      const secondSnapshot = { ...firstSnapshot, players: firstSnapshot.players.map((player) => player.id === 'p2' ? { ...player, position: 4 } : player) };
      const firstWait = deferredWait();
      const secondWait = deferredWait();
      let waitIndex = 0;
      const presenter = createGamePresenter(initial, () => (++waitIndex === 1 ? firstWait : secondWait).wait());

      presenter.receiveEvents([{ type: 'dice_rolled', playerId: 'p1', dice: [1, 2] }]);
      const first = presenter.receiveSnapshot(firstSnapshot);
      presenter.receiveEvents([{ type: 'dice_rolled', playerId: 'p2', dice: [3, 4] }]);
      const second = presenter.receiveSnapshot(secondSnapshot);
      await Promise.resolve();
      await Promise.resolve();
      expect(presenter.dice.value).toEqual([1, 2]);
      expect(presenter.state.value).toBe(initial);

      firstWait.release();
      await first;
      await Promise.resolve();
      expect(presenter.state.value).toBe(firstSnapshot);
      expect(presenter.dice.value).toEqual([3, 4]);

      const resumed = createTestSnapshot('resumed');
      await presenter.receiveSnapshot(resumed);
      secondWait.release();
      await second;
      expect(presenter.state.value).toBe(resumed);
      expect(presenter.isAnimating.value).toBe(false);
    });
  });

  describe('cash notice lifetime', () => {
    /** 与 .cash-pill 的 cash-pill-float / cash-pill-fade 动画等长（2.4s）：动画一结束，提示就不该再留在 DOM 里。 */
    const NOTICE_LIFETIME_MS = 2_400;

    it('removes a notice once its display lifetime elapses', async () => {
      vi.useFakeTimers();
      const initial = createTestSnapshot();
      const p1 = initial.players.find((player) => player.id === 'p1');
      if (!p1) throw new Error('Expected p1');
      const presenter = createGamePresenter(initial, async () => undefined);

      await presenter.playEvents(
        [{ type: 'bank_paid', playerId: 'p1', amount: 200 }],
        withCash(initial, { p1: p1.cash - 200 }),
      );

      expect(presenter.cashNotices.value.map(({ playerId, delta }) => ({ playerId, delta }))).toEqual([
        { playerId: 'p1', delta: -200 },
      ]);
      await vi.advanceTimersByTimeAsync(NOTICE_LIFETIME_MS - 1);
      expect(presenter.cashNotices.value).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(presenter.cashNotices.value).toEqual([]);
    });

    it('gives a replaced notice a fresh lifetime so the retired timer cannot collect it early', async () => {
      vi.useFakeTimers();
      const initial = createTestSnapshot();
      const p1 = initial.players.find((player) => player.id === 'p1');
      if (!p1) throw new Error('Expected p1');
      const first = withCash(initial, { p1: p1.cash - 100 });
      const second = withCash(first, { p1: p1.cash - 300 });
      const presenter = createGamePresenter(initial, async () => undefined);

      await presenter.playEvents([{ type: 'bank_paid', playerId: 'p1', amount: 100 }], first);
      await vi.advanceTimersByTimeAsync(1_000);
      await presenter.playEvents([{ type: 'bank_paid', playerId: 'p1', amount: 200 }], second);
      const replaced = presenter.cashNotices.value.find((notice) => notice.playerId === 'p1');
      expect(replaced).toMatchObject({ playerId: 'p1', delta: -200, transitionId: 2 });

      // 第一条提示本该在此刻到期；它的计时器已被替换动作销毁，不能收走新提示。
      await vi.advanceTimersByTimeAsync(NOTICE_LIFETIME_MS - 1_000);
      expect(presenter.cashNotices.value.find((notice) => notice.playerId === 'p1')).toBe(replaced);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(presenter.cashNotices.value).toEqual([]);
    });

    it('expires each player notice on its own clock', async () => {
      vi.useFakeTimers();
      const initial = createTestSnapshot();
      const p1 = initial.players.find((player) => player.id === 'p1');
      const p2 = initial.players.find((player) => player.id === 'p2');
      if (!p1 || !p2) throw new Error('Expected both players');
      const paid = withCash(initial, { p1: p1.cash - 500, p2: p2.cash + 500 });
      const received = withCash(paid, { p1: p1.cash - 500, p2: p2.cash + 800 });
      const presenter = createGamePresenter(initial, async () => undefined);

      await presenter.playEvents([{ type: 'payment_made', from: 'p1', to: 'p2', amount: 500 }], paid);
      await vi.advanceTimersByTimeAsync(1_000);
      await presenter.playEvents([{ type: 'bank_received', playerId: 'p2', amount: 300 }], received);

      await vi.advanceTimersByTimeAsync(NOTICE_LIFETIME_MS - 1_000);
      expect(presenter.cashNotices.value.map(({ playerId }) => playerId)).toEqual(['p2']);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(presenter.cashNotices.value).toEqual([]);
    });

    it('leaves nothing to replay when a later transition reorders players', async () => {
      vi.useFakeTimers();
      const initial = createTestSnapshot();
      const p1 = initial.players.find((player) => player.id === 'p1');
      if (!p1) throw new Error('Expected p1');
      const paid = withCash(initial, { p1: p1.cash - 200 });
      const reordered = { ...paid, players: [...paid.players].reverse() };
      const presenter = createGamePresenter(initial, async () => undefined);

      await presenter.playEvents([{ type: 'bank_paid', playerId: 'p1', amount: 200 }], paid);
      await vi.advanceTimersByTimeAsync(NOTICE_LIFETIME_MS);
      expect(presenter.cashNotices.value).toEqual([]);

      await presenter.playEvents([{ type: 'turn_started', playerId: 'p2' }], reordered);

      expect(presenter.cashNotices.value).toEqual([]);
      expect(presenter.displayCash.value.p1).toBe(p1.cash - 200);
    });

    it.each(['reset', 'dispose'] as const)('%s cancels the pending expiry so the next notice keeps its full lifetime', async (operation) => {
      vi.useFakeTimers();
      const initial = createTestSnapshot();
      const p1 = initial.players.find((player) => player.id === 'p1');
      if (!p1) throw new Error('Expected p1');
      const first = withCash(initial, { p1: p1.cash - 100 });
      const second = withCash(first, { p1: p1.cash - 300 });
      const presenter = createGamePresenter(initial, async () => undefined);

      await presenter.playEvents([{ type: 'bank_paid', playerId: 'p1', amount: 100 }], first);
      await vi.advanceTimersByTimeAsync(1_000);
      if (operation === 'reset') presenter.reset(first);
      else presenter.dispose();
      expect(presenter.cashNotices.value).toEqual([]);

      await presenter.playEvents([{ type: 'bank_paid', playerId: 'p1', amount: 200 }], second);
      const fresh = presenter.cashNotices.value.find((notice) => notice.playerId === 'p1');
      expect(fresh).toMatchObject({ playerId: 'p1', delta: -200 });

      // 被清理掉的那条提示本该在此刻到期，绝不能收走重置/销毁之后发布的新提示。
      await vi.advanceTimersByTimeAsync(NOTICE_LIFETIME_MS - 1_000);
      expect(presenter.cashNotices.value.find((notice) => notice.playerId === 'p1')).toBe(fresh);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(presenter.cashNotices.value).toEqual([]);
    });
  });

  describe('dispose', () => {
    it('can be called multiple times safely', () => {
      const presenter = createGamePresenter(createTestSnapshot());
      presenter.dispose();
      presenter.dispose();
      expect(true).toBe(true);
    });

    it('dispose sets isAnimating to false synchronously', () => {
      const presenter = createGamePresenter(createTestSnapshot());
      presenter.isAnimating.value = true;
      presenter.dispose();
      expect(presenter.isAnimating.value).toBe(false);
    });

    it('after dispose, playEvents still resets isAnimating to false', async () => {
      const snapshot = createTestSnapshot();
      const presenter = createGamePresenter(snapshot, () => new Promise<void>((r) => globalThis.setTimeout(r, 1)));
      presenter.dispose();

      await presenter.playEvents(
        [{ type: 'dice_rolled', playerId: 'p1', dice: [1, 1] }],
        snapshot,
      );

      expect(presenter.isAnimating.value).toBe(false);
    });
  });
});
