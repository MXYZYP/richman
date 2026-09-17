// 单机真人卡牌重抽（作弊）引擎行为：效果结算前暂停、同牌堆重抽、接受恰好一次、连锁逐张确认。
// 覆盖两份地图与两个牌堆；联机/电脑玩家（默认模式）始终保持原有立即结算。
import { describe, expect, it } from 'vitest';
import { getActiveMapPack, type MapPack } from '@richman/board-data';
import { applyIntent, createGame, skipCurrentTurn } from '../engine';
import { resolveLanding } from '../effects';
import type { GameState } from '../types';

const chinaMap = getActiveMapPack('china-tour');
const worldMap = getActiveMapPack('world-tour');

const players = [
  { id: 'p1', nickname: '甲' },
  { id: 'p2', nickname: '乙', isBot: true },
  { id: 'p3', nickname: '丙' },
];

function createPackGame(pack: MapPack, seed: string, mode?: 'local-human'): GameState {
  return createGame({
    mapRef: pack.ref,
    ruleModules: pack.game.requiredRuleModules,
    board: pack.game.board,
    cards: pack.game.cards,
    config: pack.game.config,
    players,
    seed,
    ...(mode === undefined ? {} : { cardChoiceMode: mode }),
  });
}

function cellIdOfType(pack: MapPack, type: 'chance' | 'destiny'): number {
  const cell = pack.game.board.cells.find((candidate) => candidate.type === type);
  if (cell === undefined) throw new Error(`no ${type} cell`);
  return cell.id;
}

/** 构造确定性局面：指定玩家站在指定卡格，指定卡牌置于牌堆顶；默认用真人玩家 p1 作行动者。 */
function craftedState(
  pack: MapPack,
  seed: string,
  mode: 'local-human' | undefined,
  deck: 'chance' | 'destiny',
  cardId: string,
  playerId = 'p1',
): GameState {
  const base = createPackGame(pack, seed, mode);
  return {
    ...base,
    currentPlayerId: playerId,
    turnPhase: 'managing',
    players: base.players.map((player) => (
      player.id === playerId ? { ...player, position: cellIdOfType(pack, deck) } : player
    )),
    decks: { ...base.decks, [deck]: [cardId, ...base.decks[deck].filter((id) => id !== cardId)] },
  };
}

function withoutCardChoice(state: GameState): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...state };
  delete copy.cardChoice;
  return copy;
}

function cashOf(state: GameState, playerId: string): number {
  return state.players.find((player) => player.id === playerId)!.cash;
}

/** 找一个"当前行动者是真人且首次掷骰落在指定卡格"的确定性种子。 */
function findSeedForCardLanding(pack: MapPack, deck: 'chance' | 'destiny'): { seed: string; playerId: string } {
  for (let seed = 1; seed < 20000; seed += 1) {
    const state = createPackGame(pack, String(seed));
    const actor = state.players.find((player) => player.id === state.currentPlayerId);
    if (actor === undefined || actor.isBot) continue;
    const rolled = applyIntent(state, actor.id, { type: 'roll_dice' });
    if (!rolled.ok) continue;
    const position = rolled.state.players.find((player) => player.id === actor.id)!.position;
    if (rolled.state.board.cells.find((cell) => cell.id === position)?.type === deck) {
      return { seed: String(seed), playerId: actor.id };
    }
  }
  throw new Error(`no seed lands on ${deck}`);
}

describe('cardChoice：单机真人确认模式契约', () => {
  it('默认 createGame 不产生 cardChoice，传 cardChoiceMode 时初始 pending 为 null', () => {
    expect(createPackGame(chinaMap, 'contract-seed').cardChoice).toBeUndefined();
    expect(createPackGame(chinaMap, 'contract-seed', 'local-human').cardChoice)
      .toEqual({ mode: 'local-human', pending: null });
  });

  it('默认模式（联机/BOT 路径）落卡格仍立即结算', () => {
    const state = craftedState(chinaMap, 'immediate-chance', undefined, 'chance', '71-03');
    const before = cashOf(state, state.currentPlayerId);

    const result = resolveLanding(state, state.currentPlayerId, []);

    expect(result.state.cardChoice).toBeUndefined();
    expect(cashOf(result.state, state.currentPlayerId)).toBe(before - 1800); // 71-03 赔 1800
    expect(result.events.some((event) => event.type === 'bank_paid')).toBe(true);
  });

  it('确认模式落卡格先暂停：卡牌移到堆底、事件只有抽卡、现金与债务不变', () => {
    const state = craftedState(chinaMap, 'pause-chance', 'local-human', 'chance', '71-03');
    const before = cashOf(state, state.currentPlayerId);

    const result = resolveLanding(state, state.currentPlayerId, []);

    expect(result.state.cardChoice?.pending).toEqual({
      playerId: state.currentPlayerId,
      deck: 'chance',
      cardId: '71-03',
      resumeTurnPhase: 'managing',
    });
    expect(result.state.turnPhase).toBe('managing');
    expect(result.state.debt).toBeNull();
    expect(cashOf(result.state, state.currentPlayerId)).toBe(before);
    expect(result.state.decks.chance.at(-1)).toBe('71-03');
    expect(result.events.map((event) => event.type)).toEqual(['card_drawn']);
  });
});

describe('cardChoice：重抽', () => {
  it('不限次数地从同一牌堆取下一张，放弃的卡留在牌堆且不结算', () => {
    const base = craftedState(chinaMap, 'redraw-seed', 'local-human', 'chance', '71-03');
    const state: GameState = {
      ...base,
      turnPhase: 'awaiting_roll', // 掷骰期间落卡：效果进入阶段应被记录并在重抽后保留
      decks: { ...base.decks, chance: ['71-04', ...base.decks.chance.filter((id) => id !== '71-04')] },
    };
    const paused = resolveLanding(state, state.currentPlayerId, []).state;
    expect(paused.cardChoice?.pending?.cardId).toBe('71-04');
    expect(paused.cardChoice?.pending?.resumeTurnPhase).toBe('awaiting_roll');
    expect(paused.turnPhase).toBe('managing'); // 暂停对外仍是 managing
    const before = cashOf(paused, state.currentPlayerId);

    const firstRedraw = applyIntent(paused, state.currentPlayerId, { type: 'redraw_card' });
    if (!firstRedraw.ok) throw new Error(`redraw failed: ${firstRedraw.code}`);
    expect(firstRedraw.state.cardChoice?.pending?.cardId).toBe('71-03');
    expect(firstRedraw.state.cardChoice?.pending?.deck).toBe('chance');
    expect(firstRedraw.state.cardChoice?.pending?.resumeTurnPhase).toBe('awaiting_roll');
    expect(firstRedraw.state.decks.chance.at(-1)).toBe('71-03');
    expect(cashOf(firstRedraw.state, state.currentPlayerId)).toBe(before);
    expect(firstRedraw.events).toEqual([
      { type: 'card_drawn', playerId: state.currentPlayerId, deck: 'chance', cardId: '71-03' },
    ]);

    const secondRedraw = applyIntent(firstRedraw.state, state.currentPlayerId, { type: 'redraw_card' });
    if (!secondRedraw.ok) throw new Error(`redraw failed: ${secondRedraw.code}`);
    const thirdCard = secondRedraw.state.cardChoice?.pending?.cardId;
    expect(thirdCard).not.toBe('71-03');
    expect(thirdCard).not.toBe('71-04');
    expect(secondRedraw.state.decks.chance).toContain('71-03'); // 被放弃的两张仍在牌堆
    expect(secondRedraw.state.decks.chance).toContain('71-04');
    expect(cashOf(secondRedraw.state, state.currentPlayerId)).toBe(before);
    expect(secondRedraw.state.debt).toBeNull();
  });

  it('单张牌堆重抽不报错：仍是同一张卡且不产生任何效果', () => {
    const base = craftedState(chinaMap, 'single-card-deck', 'local-human', 'chance', '71-01');
    const single = { ...base, decks: { ...base.decks, chance: ['71-01'] } };
    const paused = resolveLanding(single, single.currentPlayerId, []).state;
    expect(paused.cardChoice?.pending?.cardId).toBe('71-01');
    const before = cashOf(paused, single.currentPlayerId);

    const redraw = applyIntent(paused, single.currentPlayerId, { type: 'redraw_card' });

    expect(redraw).toMatchObject({ ok: true });
    if (!redraw.ok) return;
    expect(redraw.state.cardChoice?.pending?.cardId).toBe('71-01');
    expect(redraw.state.decks.chance).toEqual(['71-01']);
    expect(cashOf(redraw.state, single.currentPlayerId)).toBe(before);
  });
});

describe('cardChoice：接受', () => {
  it('只执行被接受卡牌的效果一次，重复接受被拒绝且状态不变', () => {
    const state = craftedState(chinaMap, 'accept-once', 'local-human', 'chance', '71-03');
    const paused = resolveLanding(state, state.currentPlayerId, []).state;
    const before = cashOf(paused, state.currentPlayerId);

    const accepted = applyIntent(paused, state.currentPlayerId, { type: 'accept_card' });
    if (!accepted.ok) throw new Error(`accept failed: ${accepted.code}`);
    expect(cashOf(accepted.state, state.currentPlayerId)).toBe(before - 1800);
    expect(accepted.state.cardChoice?.pending).toBeNull();
    expect(accepted.state.turnPhase).toBe('managing');

    const snapshot = structuredClone(accepted.state);
    const replay = applyIntent(accepted.state, state.currentPlayerId, { type: 'accept_card' });
    expect(replay).toEqual({ ok: false, code: 'WRONG_PHASE' });
    expect(accepted.state).toEqual(snapshot);
  });

  it('中国地图：暂停后接受与默认模式立即结算得到同一状态（恰好一次）', () => {
    const landing = findSeedForCardLanding(chinaMap, 'chance');
    const immediate = createPackGame(chinaMap, landing.seed);
    const immediateRoll = applyIntent(immediate, landing.playerId, { type: 'roll_dice' });
    if (!immediateRoll.ok) throw new Error(`roll failed: ${immediateRoll.code}`);
    expect(immediateRoll.state.cardChoice).toBeUndefined();

    const confirm = createPackGame(chinaMap, landing.seed, 'local-human');
    const pausedRoll = applyIntent(confirm, landing.playerId, { type: 'roll_dice' });
    if (!pausedRoll.ok) throw new Error(`roll failed: ${pausedRoll.code}`);
    expect(pausedRoll.state.cardChoice?.pending).toMatchObject({ playerId: landing.playerId, deck: 'chance' });

    const accepted = applyIntent(pausedRoll.state, landing.playerId, { type: 'accept_card' });
    if (!accepted.ok) throw new Error(`accept failed: ${accepted.code}`);
    expect(withoutCardChoice(accepted.state)).toEqual(immediateRoll.state);
  });

  it('世界地图：暂停后接受与默认模式立即结算得到同一状态（恰好一次）', () => {
    const landing = findSeedForCardLanding(worldMap, 'destiny');
    const immediate = createPackGame(worldMap, landing.seed);
    const immediateRoll = applyIntent(immediate, landing.playerId, { type: 'roll_dice' });
    if (!immediateRoll.ok) throw new Error(`roll failed: ${immediateRoll.code}`);

    const confirm = createPackGame(worldMap, landing.seed, 'local-human');
    const pausedRoll = applyIntent(confirm, landing.playerId, { type: 'roll_dice' });
    if (!pausedRoll.ok) throw new Error(`roll failed: ${pausedRoll.code}`);
    expect(pausedRoll.state.cardChoice?.pending).toMatchObject({ playerId: landing.playerId, deck: 'destiny' });

    const accepted = applyIntent(pausedRoll.state, landing.playerId, { type: 'accept_card' });
    if (!accepted.ok) throw new Error(`accept failed: ${accepted.code}`);
    expect(withoutCardChoice(accepted.state)).toEqual(immediateRoll.state);
  });

  it('连锁抽卡逐张确认：接受联动卡后再暂停，最终与默认模式一致', () => {
    const defaultState = { ...craftedState(chinaMap, 'chain-seed', undefined, 'destiny', '71-30'), turnPhase: 'awaiting_roll' as const };
    const immediate = resolveLanding(defaultState, defaultState.currentPlayerId, []);

    const confirmState = { ...craftedState(chinaMap, 'chain-seed', 'local-human', 'destiny', '71-30'), turnPhase: 'awaiting_roll' as const };
    const pausedLanding = resolveLanding(confirmState, confirmState.currentPlayerId, []);
    const paused = pausedLanding.state;
    expect(paused.cardChoice?.pending).toMatchObject({ deck: 'destiny', cardId: '71-30', resumeTurnPhase: 'awaiting_roll' });

    // 接受"再翻一张机会"后立即再次暂停，而不是继续结算下一张。
    const acceptedChain = applyIntent(paused, confirmState.currentPlayerId, { type: 'accept_card' });
    if (!acceptedChain.ok) throw new Error(`accept failed: ${acceptedChain.code}`);
    expect(acceptedChain.state.cardChoice?.pending).toMatchObject({
      playerId: confirmState.currentPlayerId,
      deck: 'chance',
      resumeTurnPhase: 'awaiting_roll', // 连锁抽牌继承真实的“效果进入阶段”
    });
    expect(acceptedChain.state.turnPhase).toBe('managing');

    const acceptedChained = applyIntent(acceptedChain.state, confirmState.currentPlayerId, { type: 'accept_card' });
    if (!acceptedChained.ok) throw new Error(`accept failed: ${acceptedChained.code}`);
    expect(acceptedChained.state.cardChoice?.pending).toBeNull();
    // resolveLanding 不写 recentLog（由调用方决定），因此这里比较状态与事件序列：
    // 两次接受的结算合起来必须与默认模式一次结算完全一致。
    const comparableState = withoutCardChoice(acceptedChained.state);
    delete comparableState.recentLog;
    const immediateComparable = withoutCardChoice(immediate.state);
    delete immediateComparable.recentLog;
    expect(comparableState).toEqual(immediateComparable);
    expect([...pausedLanding.events, ...acceptedChain.events, ...acceptedChained.events]).toEqual(immediate.events);
  });

  it('接受卡牌触发现金目标终局时保留默认模式的环境 turnPhase（与基线逐字段一致）', () => {
    // 卡牌移动经过起点领工资达标 → 效果内部提前终局。默认模式会把效果进入阶段
    // （awaiting_roll）带进 game_over；接受路径必须原样恢复该阶段，不能改写为 managing。
    const cashGoal = chinaMap.game.config.initialCash + 1;
    const destinyCellId = Math.max(...chinaMap.game.board.cells
      .filter((cell) => cell.type === 'destiny')
      .map((cell) => cell.id));

    function goalState(mode?: 'local-human'): GameState {
      const base = createGame({
        mapRef: chinaMap.ref,
        ruleModules: chinaMap.game.requiredRuleModules,
        board: chinaMap.game.board,
        cards: chinaMap.game.cards,
        config: chinaMap.game.config,
        players,
        seed: 'goal-card-edge',
        cashGoal,
        ...(mode === undefined ? {} : { cardChoiceMode: mode }),
      });
      return {
        ...base,
        currentPlayerId: 'p1',
        turnPhase: 'awaiting_roll', // 掷骰/支线掷骰时卡牌结算所处的环境阶段
        players: base.players.map((player) => (
          player.id === 'p1' ? { ...player, position: destinyCellId } : player
        )),
        decks: { ...base.decks, destiny: ['71-24', ...base.decks.destiny.filter((id) => id !== '71-24')] },
      };
    }

    const immediate = resolveLanding(goalState(), 'p1', []);
    expect(immediate.state.phase).toBe('game_over');
    expect(immediate.state.turnPhase).toBe('awaiting_roll');

    const paused = resolveLanding(goalState('local-human'), 'p1', []).state;
    expect(paused.cardChoice?.pending).toMatchObject({ playerId: 'p1', deck: 'destiny', cardId: '71-24', resumeTurnPhase: 'awaiting_roll' });
    expect(paused.turnPhase).toBe('managing'); // 暂停对外仍是 managing

    const accepted = applyIntent(paused, 'p1', { type: 'accept_card' });
    if (!accepted.ok) throw new Error(`accept failed: ${accepted.code}`);
    expect(accepted.state.phase).toBe('game_over');
    expect(accepted.state.turnPhase).toBe('awaiting_roll');

    const comparable = withoutCardChoice(accepted.state);
    delete comparable.recentLog;
    const immediateComparable: Record<string, unknown> = { ...immediate.state };
    delete immediateComparable.recentLog;
    expect(comparable).toEqual(immediateComparable);
  });

  it('电脑玩家在确认模式中保持立即结算，不产生待确认卡牌', () => {
    const botId = 'p2';
    const botState = craftedState(chinaMap, 'bot-seed', 'local-human', 'chance', '71-03', botId);
    const before = cashOf(botState, botId);

    const botResult = resolveLanding(botState, botId, []);
    expect(botResult.state.cardChoice?.pending ?? null).toBeNull();
    expect(cashOf(botResult.state, botId)).toBe(before - 1800);

    const defaultResult = resolveLanding(craftedState(chinaMap, 'bot-seed', undefined, 'chance', '71-03', botId), botId, []);
    expect(withoutCardChoice(botResult.state)).toEqual(defaultResult.state);
  });
});

describe('cardChoice：待确认期间的封锁', () => {
  const frozen = craftedState(chinaMap, 'frozen-seed', 'local-human', 'chance', '71-03');
  const paused = resolveLanding(frozen, frozen.currentPlayerId, []).state;
  const actorId = frozen.currentPlayerId;

  it('掷骰、结束回合、托管与结算其他玩家的操作都被拒绝', () => {
    expect(applyIntent(paused, actorId, { type: 'roll_dice' })).toEqual({ ok: false, code: 'WRONG_PHASE' });
    expect(applyIntent(paused, actorId, { type: 'end_turn' })).toEqual({ ok: false, code: 'WRONG_PHASE' });
    expect(applyIntent(paused, 'p3', { type: 'redraw_card' })).toEqual({ ok: false, code: 'NOT_YOUR_TURN' });
    expect(applyIntent(paused, 'p3', { type: 'accept_card' })).toEqual({ ok: false, code: 'NOT_YOUR_TURN' });
    expect(skipCurrentTurn(paused, actorId)).toEqual({ ok: false, code: 'WRONG_PHASE' });
  });

  it('没有待确认卡牌时 redraw/accept 一律非法（联机与 BOT 的默认状态）', () => {
    const state = createPackGame(chinaMap, 'no-pending-seed');
    expect(applyIntent(state, state.currentPlayerId, { type: 'redraw_card' })).toEqual({ ok: false, code: 'WRONG_PHASE' });
    expect(applyIntent(state, state.currentPlayerId, { type: 'accept_card' })).toEqual({ ok: false, code: 'WRONG_PHASE' });
  });
});
