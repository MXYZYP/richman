import { describe, expect, it } from 'vitest';
import { applyIntent, chooseBotIntent } from '@richman/engine';
import type { GameState, Intent } from '@richman/engine';
import { getActiveMapPack } from '@richman/board-data';
import { createInitialLocalGameState, createLocalSession, resolveLocalGameRecipe } from './localSession';
import {
  MAX_REPLAY_CODE_LENGTH,
  REPLAY_CODE_PREFIX,
  buildReplayPayload,
  decodeReplayCode,
  describeReplayFailure,
  encodeReplayCode,
  prepareReplayPlayback,
  verifyReplayPayload,
  type ReplayPayload,
} from './replayCode';

/**
 * 复盘码（#115）。
 *
 * 这一层最核心的断言只有一条：**导出的码必须真的能跑**。
 * 所以每个涉及 payload 的用例都走「真推演」——用引擎的 `chooseBotIntent` 驱动一局，
 * 把每一步实际执行的意图收进 intents，导出、解码、再重放一遍，最后比对终局。
 * 一旦「起始态可由开局配方重建」这个前提被破坏（比如有人改了 createGame 的种子语义、
 * 或者把落座顺序当成输入顺序），这里会立刻红。
 */

const PROBE_PLAYERS = [
  { id: 'p1', nickname: '玩家一' },
  { id: 'p2', nickname: '电脑A', isBot: true },
  { id: 'p3', nickname: '电脑B', isBot: true },
];

/** 与 replayCode 内部同一套 32 位 FNV-1a；测试里重写一遍是为了能造出「校验和对、载荷错」的输入。 */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 用引擎自己的 bot 策略驱动一局：返回每一步真实执行过的意图。bot 策略恒产出合法意图，不依赖阶段分支。 */
function playDeterministicGame(seed: string, steps: number): { initial: GameState; intents: Intent[]; final: GameState } {
  const initial = createInitialLocalGameState({
    mapPack: getActiveMapPack('china-tour'),
    players: PROBE_PLAYERS,
    seed,
    cashGoal: null,
  });

  let state = initial;
  const intents: Intent[] = [];
  for (let index = 0; index < steps && state.phase !== 'game_over'; index += 1) {
    const actorId = state.debt?.debtorId ?? state.currentPlayerId;
    const intent = chooseBotIntent(state, actorId);
    const result = applyIntent(state, actorId, intent);
    // 不用 `expect(result.ok).toBe(true)`：断言不会收窄联合类型，下面那行 `result.state` 就没法过 tsc。
    if (!result.ok) throw new Error(`engine rejected its own bot intent ${JSON.stringify(intent)} (${result.code})`);
    state = result.state;
    intents.push(intent);
  }
  return { initial, intents, final: state };
}

function payloadFor(seed: string, steps: number, players = PROBE_PLAYERS): ReplayPayload {
  const { initial, intents } = playDeterministicGame(seed, steps);
  return buildReplayPayload({
    initialState: initial,
    recipe: { seed, players },
    intents,
    createdAt: 1_700_000_000_000,
  });
}

describe('replayCode', () => {
  describe('round trip', () => {
    it('survives encode → decode byte for byte', () => {
      const payload = payloadFor('replay-round-trip', 40);
      expect(payload.intents.length).toBeGreaterThan(10);

      const decoded = decodeReplayCode(encodeReplayCode(payload));
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.payload).toEqual(payload);
    });

    it('keeps a Chinese nickname intact through base64url (UTF-8, not latin1)', () => {
      const players = [{ id: 'p1', nickname: '小明·山西' }, ...PROBE_PLAYERS.slice(1)];
      const decoded = decodeReplayCode(encodeReplayCode(payloadFor('replay-utf8', 5, players)));
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.payload.players[0]?.nickname).toBe('小明·山西');
    });

    it('ignores whitespace so a code pasted from a chat window still works', () => {
      const code = encodeReplayCode(payloadFor('replay-whitespace', 8));
      const wrapped = `${code.slice(0, 20)}\n  ${code.slice(20)}`;
      expect(decodeReplayCode(wrapped).ok).toBe(true);
    });
  });

  describe('replay fidelity — the whole point of the feature', () => {
    it('rebuilds the exact same game from the code alone', () => {
      const seed = 'replay-fidelity';
      const played = playDeterministicGame(seed, 60);
      const payload = buildReplayPayload({
        initialState: played.initial,
        recipe: { seed, players: PROBE_PLAYERS },
        intents: played.intents,
        createdAt: 0,
      });

      const verified = verifyReplayPayload(payload);
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      expect(verified.steps).toBe(played.intents.length);
      // 终局必须逐字段一致：回合、当前行动者、赢家、以及每个人的现金。
      expect(verified.state.turn).toBe(played.final.turn);
      expect(verified.state.currentPlayerId).toBe(played.final.currentPlayerId);
      expect(verified.state.winnerId).toBe(played.final.winnerId);
      expect(verified.state.players.map((player) => player.cash)).toEqual(played.final.players.map((player) => player.cash));
    });

    it('reproduces the game without needing a bot difficulty in the payload', () => {
      // 电脑的动作也在意图序列里，所以难度设置不该影响重放结果。
      const seed = 'replay-difficulty-agnostic';
      const played = playDeterministicGame(seed, 30);
      const payload = buildReplayPayload({
        initialState: played.initial,
        recipe: { seed, players: PROBE_PLAYERS },
        intents: played.intents,
        createdAt: 0,
      });

      const first = verifyReplayPayload(payload);
      const second = verifyReplayPayload(payload);
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(first.state.players.map((player) => player.cash)).toEqual(second.state.players.map((player) => player.cash));
    });
  });

  describe('the two creation traps this feature must never fall back into', () => {
    it('GameState.seed is the RNG state AFTER creation — feeding it back is a different game', () => {
      const played = playDeterministicGame('replay-seed-trap', 8);
      // 这就是坑本身：状态里的 seed 与输入种子根本不是一回事。
      expect(played.initial.seed).not.toBe('replay-seed-trap');

      const viaStateSeed = createInitialLocalGameState({
        mapPack: getActiveMapPack('china-tour'),
        players: PROBE_PLAYERS,
        seed: played.initial.seed,
        cashGoal: null,
      });
      expect(viaStateSeed.seed).not.toBe(played.initial.seed);
      expect(viaStateSeed.currentPlayerId).not.toBe(played.initial.currentPlayerId);

      // 而用**输入种子**（配方）重建则逐字段一致。
      const recipe = resolveLocalGameRecipe({ players: PROBE_PLAYERS, seed: 'replay-seed-trap' });
      const rebuilt = createInitialLocalGameState({
        mapPack: getActiveMapPack('china-tour'),
        players: [...recipe.players],
        seed: recipe.seed,
        cashGoal: null,
      });
      expect(rebuilt.seed).toBe(played.initial.seed);
      expect(rebuilt.currentPlayerId).toBe(played.initial.currentPlayerId);
      expect(rebuilt.players).toEqual(played.initial.players);
      expect(rebuilt.decks).toEqual(played.initial.decks);
    });

    it('the seating order is a permutation of the input order — they are not interchangeable', () => {
      const played = playDeterministicGame('replay-seat-trap', 5);
      // 本局确实被打乱过座次，所以下面这条断言才有意义。
      const inputOrder = PROBE_PLAYERS.map((player) => player.id);
      const seated = played.initial.players.map((player) => player.id);
      expect([...seated].sort()).toEqual([...inputOrder].sort());
      expect(seated).not.toEqual(inputOrder);

      // 喂落座顺序 = 换了一局；这也是 payload 必须存输入顺序的原因。
      const wrong = createInitialLocalGameState({
        mapPack: getActiveMapPack('china-tour'),
        players: played.initial.players.map((player) => ({ id: player.id, nickname: player.nickname, isBot: player.isBot })),
        seed: 'replay-seat-trap',
        cashGoal: null,
      });
      expect(wrong.players.map((player) => player.id)).not.toEqual(played.initial.players.map((player) => player.id));
    });
  });

  describe('decode rejects bad input cheaply and precisely', () => {
    it('reports a checksum mismatch when a character was lost in copy-paste', () => {
      const code = encodeReplayCode(payloadFor('replay-tamper', 10));
      const [prefix, body, checksum] = code.split('.') as [string, string, string];
      const flipped = body[10] === 'A' ? 'B' : 'A';
      const tampered = `${prefix}.${body.slice(0, 10)}${flipped}${body.slice(11)}.${checksum}`;
      expect(decodeReplayCode(tampered)).toEqual({ ok: false, reason: 'checksum' });
    });

    it('rejects anything that is not one of our codes', () => {
      const code = encodeReplayCode(payloadFor('replay-format', 5));
      expect(decodeReplayCode('')).toEqual({ ok: false, reason: 'format' });
      expect(decodeReplayCode('RMSTATS1.abc.def')).toEqual({ ok: false, reason: 'format' });
      expect(decodeReplayCode(code.replace(REPLAY_CODE_PREFIX, 'RMREPLAY2'))).toEqual({ ok: false, reason: 'format' });
      expect(decodeReplayCode(`${code}.extra`)).toEqual({ ok: false, reason: 'format' });
      // 校验和正确、但载荷不是 JSON —— 必须走到 format 而不是抛异常。
      // 这里刻意在测试里重写一遍 FNV-1a：既造出「校验和正确」的前置条件，也把校验算法本身钉住。
      const notJsonBody = 'YWJj';
      expect(decodeReplayCode(`${REPLAY_CODE_PREFIX}.${notJsonBody}.${fnv1a(notJsonBody)}`)).toEqual({ ok: false, reason: 'format' });
    });

    it('refuses an absurdly long paste instead of freezing the tab', () => {
      expect(decodeReplayCode('x'.repeat(MAX_REPLAY_CODE_LENGTH + 1))).toEqual({ ok: false, reason: 'format' });
    });
  });

  describe('verification pinpoints where a replay stops matching the rules', () => {
    it('locates the exact step when an intent no longer applies', () => {
      const good = payloadFor('replay-diverged', 20);
      const broken: ReplayPayload = {
        ...good,
        // 插一条不存在的动作：它排在第二位，因此重放应在第 2 步失败。
        intents: [good.intents[0]!, { type: 'definitely-not-a-real-intent' } as unknown as Intent, ...good.intents.slice(1)],
      };
      const verified = verifyReplayPayload(broken);
      expect(verified.ok).toBe(false);
      if (verified.ok) return;
      expect(verified.reason).toBe('replay_diverged');
      expect(verified.stepIndex).toBe(2);
      expect(verified.detail.length).toBeGreaterThan(0);
    });

    it('says the map is unavailable when the replay came from another machine', () => {
      const payload = payloadFor('replay-map', 6);
      const foreign: ReplayPayload = { ...payload, map: { ...payload.map, id: 'not-a-shipped-map' } };
      const verified = verifyReplayPayload(foreign);
      expect(verified.ok).toBe(false);
      if (verified.ok) return;
      expect(verified.reason).toBe('map_unavailable');
      expect(verified.stepIndex).toBeNull();
    });

    it('detects that a same-named map changed its content', () => {
      const payload = payloadFor('replay-hash', 6);
      const edited: ReplayPayload = { ...payload, map: { ...payload.map, contentHash: 'f'.repeat(64) } };
      const verified = verifyReplayPayload(edited);
      expect(verified.ok).toBe(false);
      if (verified.ok) return;
      expect(verified.reason).toBe('map_hash_mismatch');
    });

    it('accepts an explicitly supplied map pack — the custom-map escape hatch', () => {
      const payload = payloadFor('replay-custom-map', 12);
      // 自定义地图不在生产注册表里，靠调用方把包递进来；包与 ref 一致时必须通过。
      const verified = verifyReplayPayload(payload, { mapPack: getActiveMapPack('china-tour') });
      expect(verified.ok).toBe(true);
    });

    it('every failure mode has human-readable guidance', () => {
      for (const reason of ['format', 'checksum', 'map_unavailable', 'map_hash_mismatch', 'replay_diverged'] as const) {
        expect(describeReplayFailure(reason).length).toBeGreaterThan(0);
      }
    });
  });

  describe('local session exposes exactly what the exporter needs', () => {
    it('hands out the start state, the ordered intents, the map pack and the creation recipe', () => {
      const session = createLocalSession({
        mapPack: getActiveMapPack('silk-road'),
        players: [{ id: 'p1', nickname: '玩家一' }, { id: 'p2', nickname: '电脑A', isBot: true }],
        seed: 'replay-session-wiring',
        // cashGoal 必须大于初始资金，否则 createGame 直接抛错（引擎的硬约束）。
        cashGoal: 60000,
        wait: async () => {},
      });
      try {
        expect(session.initialState.mapRef.id).toBe('silk-road');
        expect(session.mapPack.ref.id).toBe('silk-road');
        expect(session.createRecipe).toEqual({
          seed: 'replay-session-wiring',
          players: [{ id: 'p1', nickname: '玩家一' }, { id: 'p2', nickname: '电脑A', isBot: true }],
        });
        // 开局尚未行动：意图为空，此刻不该允许导出（界面上导出按钮也是灰的）。
        expect(session.intents.value).toEqual([]);

        const payload = buildReplayPayload({
          initialState: session.initialState,
          recipe: session.createRecipe!,
          intents: session.intents.value,
          createdAt: 0,
        });
        expect(verifyReplayPayload(payload, { mapPack: session.mapPack }).ok).toBe(true);
      } finally {
        session.dispose();
      }
    });

    it('reports no recipe for a session restored from an archive — those cannot be replayed from scratch', () => {
      const seeded = createLocalSession({
        mapPack: getActiveMapPack('silk-road'),
        players: PROBE_PLAYERS,
        seed: 'replay-restore-source',
        wait: async () => {},
      });
      const restored = createLocalSession({
        mapPack: getActiveMapPack('silk-road'),
        restoreState: seeded.initialState,
        wait: async () => {},
      });
      try {
        expect(restored.createRecipe).toBeNull();
      } finally {
        seeded.dispose();
        restored.dispose();
      }
    });
  });

  describe('buildReplayExport — 会话直接把「能不能给码」讲清楚', () => {
    // 这一组守的是视图契约：GameView 只调一次 `buildReplayExport()`，拿到码或原因，
    // 自己**不做任何判断**。所以三种「导不出来」必须各自有自己的说法，不能都退化成一坨空提示。
    const create = (seed: string) => createLocalSession({
      mapPack: getActiveMapPack('china-tour'),
      players: PROBE_PLAYERS,
      seed,
      wait: async () => {},
    });

    it('returns a verified code once a move has been played, and a reason before that', async () => {
      const session = create('replay-export-capable');
      try {
        // 开局还没走过半步：有配方但没动作 → 明确说「还没走过任何一步」，而不是给一段空码。
        const beforeAnyMove = session.buildReplayExport();
        expect(beforeAnyMove.code).toBeNull();
        expect(beforeAnyMove.steps).toBe(0);
        expect(beforeAnyMove.reason).toBe(describeReplayFailure('no_actions'));

        await session.sendIntent(chooseBotIntent(session.initialState, session.initialState.currentPlayerId));

        const outcome = session.buildReplayExport();
        expect(outcome.code).not.toBeNull();
        expect(outcome.reason).toBe('');
        expect(outcome.steps).toBe(1);
        expect(outcome.code?.startsWith(`${REPLAY_CODE_PREFIX}.`)).toBe(true);
        // 「自校验过」的真正含义：这段码此刻就能解出一局，且解出来的步数与导出时一致。
        const decoded = decodeReplayCode(outcome.code ?? '');
        expect(decoded.ok).toBe(true);
        if (decoded.ok) expect(decoded.payload.intents.length).toBe(1);
      } finally {
        session.dispose();
      }
    });

    it('returns null-code with a reason for a session restored from an archive', () => {
      const seeded = create('replay-export-restore-source');
      const restored = createLocalSession({
        mapPack: getActiveMapPack('china-tour'),
        restoreState: seeded.initialState,
        wait: async () => {},
      });
      try {
        const outcome = restored.buildReplayExport();
        expect(outcome.code).toBeNull();
        expect(outcome.steps).toBe(0);
        expect(outcome.reason).toContain('存档');
      } finally {
        seeded.dispose();
        restored.dispose();
      }
    });

    it('refuses to re-export a playback session, and reports its step count', () => {
      const played = playDeterministicGame('replay-export-playback', 30);
      const payload = buildReplayPayload({
        initialState: played.initial,
        recipe: { seed: 'replay-export-playback', players: PROBE_PLAYERS },
        intents: played.intents,
        createdAt: 0,
      });
      const prepared = prepareReplayPlayback(payload);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      const playback = createLocalSession({ ...prepared.options, autoPlayBots: false });
      try {
        expect(playback.isPlayback).toBe(true);
        // 回看会话的「这局有几个动作」正是它要重演的步数 —— 横幅据此显示「共 N 步」。
        expect(playback.replaySteps.value).toBe(played.intents.length);

        const outcome = playback.buildReplayExport();
        expect(outcome.code).toBeNull();
        expect(outcome.reason).toContain('回看');
      } finally {
        playback.dispose();
      }
    });

    it('a live local game reports its own step count growing with the action log', async () => {
      const session = createLocalSession({
        mapPack: getActiveMapPack('china-tour'),
        players: [{ id: 'p1', nickname: '玩家一' }, { id: 'p2', nickname: '电脑A', isBot: true }],
        seed: 'replay-export-steps',
        cashGoal: null,
        autoPlayBots: false,
        wait: async () => {},
      });
      try {
        expect(session.replaySteps.value).toBe(0);
        const actorId = session.initialState.currentPlayerId;
        await session.sendIntent(chooseBotIntent(session.initialState, actorId));
        expect(session.replaySteps.value).toBe(1);
        expect(session.intents.value.length).toBe(1);
      } finally {
        session.dispose();
      }
    });
  });
});
