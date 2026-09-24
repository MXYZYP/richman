import { describe, expect, test } from 'vitest';
import { getActiveMapPack } from '@richman/board-data';
import { createGame } from '@richman/engine';
import type { GameState, Intent } from '@richman/engine';
import { RoomManager } from '../rooms/roomManager';
import type { RoomDomainEvent, RoomManagerDependencies } from '../rooms/roomTypes';

/**
 * 联机最小悔棋（#101）。
 *
 * 「不能单方面回退」这句话拆开来就是四件事，这一套测试逐条盯住：
 *  1. **闸门**：房主没开悔棋时，房间一步都不广播可悔权，发起也一律被拒（`UNDO_DISABLED`）；
 *  2. **归属**：只有「刚手动走完那一步的本人」能发起，且必须有在场人类对手可以确认——
 *     没有确认方就无从确认，这是「需对手同意」的物理前提；
 *  3. **表决**：集齐全部同意才真的退回上一步（事件顺序 `undo_result` 先于 `game_snapshot`），
 *     任一拒绝 / 超时 / 撤回都只收尾、不动对局；重复同意幂等；只退一步；
 *  4. **作废**：电脑走的一步、踢人出局都会清掉旧的可悔点，否则一次回退会把人原样复活。
 */

type TimerHandle = {
  callback: () => void;
  delayMs: number;
  active: boolean;
};

const chinaMapPack = getActiveMapPack('china-tour');
const ROOM_CODE = '000007';
/** 与 roomManager 内部的 `UNDO_REQUEST_TTL_MS` 对齐：超时即视为拒绝。 */
const UNDO_TTL_MS = 20_000;

function createHarness(playerIds: string[], seed = 'undo-seed') {
  const asyncEvents: RoomDomainEvent[] = [];
  const timers: TimerHandle[] = [];
  let playerIdIndex = 0;
  let tokenIndex = 0;
  let roomNumberIndex = 0;

  const dependencies: RoomManagerDependencies<TimerHandle> = {
    generatePlayerId() {
      const nextIndex = playerIdIndex;
      playerIdIndex += 1;
      return playerIds[nextIndex] ?? `player-${nextIndex}`;
    },
    generateToken() {
      const nextIndex = tokenIndex;
      tokenIndex += 1;
      return `token-${nextIndex}`;
    },
    nextRoomNumber() {
      const nextIndex = roomNumberIndex;
      roomNumberIndex += 1;
      return 7 + nextIndex;
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
      return seed;
    },
    nextAutomationDelayMs() {
      return 1000;
    },
  };

  const manager = new RoomManager<TimerHandle>(dependencies);
  return { manager, asyncEvents, timers };
}

type Harness = ReturnType<typeof createHarness>;

function stateOf(manager: RoomManager<TimerHandle>, roomCode = ROOM_CODE): GameState {
  const state = manager.getGameSnapshot(roomCode);
  if (state === null) throw new Error(`room ${roomCode} has no game snapshot`);
  return state;
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
    // 议价阶段（#105 / #106）：本套件不开「放弃购买即拍卖」，所以拍卖分支不可达；
    // 交易分支用撤回（发起者就是 currentPlayerId，是唯一对 currentPlayerId 合法的议价意图）。
    case 'awaiting_trade_response':
      return { type: 'cancel_trade' };
    case 'awaiting_auction_bid':
      return { type: 'pass_bid' };
  }
}

/** 让当前行动者手动走一步（真人手动通道）。 */
function moveCurrentActor(manager: RoomManager<TimerHandle>) {
  const state = stateOf(manager);
  const actorId = state.debt?.debtorId ?? state.currentPlayerId;
  const result = manager.applyGameIntent(ROOM_CODE, actorId, intentForTurnPhase(state));
  if (!result.ok) throw new Error(`manual move failed: ${result.code} ${result.message}`);
  return { actorId, result };
}

function otherOf(playerId: string): string {
  return playerId === 'host' ? 'guest' : 'host';
}

function enableUndo(manager: RoomManager<TimerHandle>): void {
  const result = manager.updateRoomSettings(ROOM_CODE, 'host', { minimalUndoEnabled: true });
  expect(result.ok).toBe(true);
}

function lobbyRoom(playerIds: string[], nicknames: string[]): Harness {
  const harness = createHarness(playerIds);
  const created = harness.manager.createRoom(nicknames[0], 'china-tour');
  expect(created.ok).toBe(true);
  for (let index = 1; index < nicknames.length; index += 1) {
    const joined = harness.manager.joinRoom(ROOM_CODE, nicknames[index]);
    expect(joined.ok).toBe(true);
  }
  return harness;
}

function twoHumanRoom(undoEnabled = false): Harness {
  const harness = lobbyRoom(['host', 'guest'], ['房主', '客人']);
  if (undoEnabled) enableUndo(harness.manager);
  expect(harness.manager.startRoom(ROOM_CODE, 'host').ok).toBe(true);
  return harness;
}

function threeHumanRoom(): Harness {
  const harness = lobbyRoom(['host', 'guest', 'third'], ['房主', '客人', '三号']);
  enableUndo(harness.manager);
  expect(harness.manager.startRoom(ROOM_CODE, 'host').ok).toBe(true);
  return harness;
}

/** 找一个「电脑先手」的确定性种子，好让开局就排好一枚自动化计时器。 */
function seedWithBotFirst(players: { id: string; nickname: string; isBot: boolean }[], botId: string): string {
  for (let index = 0; index < 5000; index += 1) {
    const seed = `undo-bot-first-${index}`;
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
    if (state.currentPlayerId === botId) return seed;
  }
  throw new Error(`no bot-first seed found for ${botId} within 5000 deterministic seeds`);
}

function botFirstRoom(): Harness {
  const players = [
    { id: 'host', nickname: '房主', isBot: false },
    { id: 'botA', nickname: '电脑 A', isBot: true },
  ];
  const harness = createHarness(['host', 'botA'], seedWithBotFirst(players, 'botA'));
  expect(harness.manager.createRoom('房主', 'china-tour').ok).toBe(true);
  expect(harness.manager.addBot(ROOM_CODE, 'host').ok).toBe(true);
  enableUndo(harness.manager);
  expect(harness.manager.startRoom(ROOM_CODE, 'host').ok).toBe(true);
  expect(stateOf(harness.manager).currentPlayerId).toBe('botA');
  return harness;
}

describe('悔棋开关（房主可开）', () => {
  test('默认关闭：一步都不广播可悔权，也没人可悔', () => {
    const harness = twoHumanRoom();
    expect(harness.manager.getRoomSettings(ROOM_CODE)?.minimalUndoEnabled).toBe(false);
    expect(harness.manager.getUndoAvailability(ROOM_CODE)).toBeNull();

    const { result } = moveCurrentActor(harness.manager);

    // 关着的时候连「没人可悔」这条事件都不发——否则每个房间每一步都白添一路流量。
    expect(result.events.map((event) => event.type)).toEqual(['game_events', 'game_snapshot']);
    expect(harness.manager.getUndoAvailability(ROOM_CODE)).toBeNull();
  });

  test('房主开启：设置事件带最新开关，并立刻广播一次可悔权（此刻还没人可悔）', () => {
    const harness = lobbyRoom(['host', 'guest'], ['房主', '客人']);
    const result = harness.manager.updateRoomSettings(ROOM_CODE, 'host', { minimalUndoEnabled: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.minimalUndoEnabled).toBe(true);
    expect(result.events.map((event) => event.type)).toEqual(['room_settings', 'undo_available']);

    const availability = result.events[1];
    expect(availability.type).toBe('undo_available');
    if (availability.type !== 'undo_available') return;
    expect(availability.playerId).toBeNull();
  });

  test('开启后每走一步都广播「可悔的是谁」', () => {
    const harness = twoHumanRoom(true);
    const { actorId, result } = moveCurrentActor(harness.manager);

    expect(result.events.map((event) => event.type)).toEqual(['game_events', 'game_snapshot', 'undo_available']);
    const availability = result.events[2];
    expect(availability.type).toBe('undo_available');
    if (availability.type !== 'undo_available') return;
    expect(availability.playerId).toBe(actorId);
    expect(harness.manager.getUndoAvailability(ROOM_CODE)).toBe(actorId);
  });

  test('开关只收布尔值（别的类型一律拒）', () => {
    const harness = lobbyRoom(['host', 'guest'], ['房主', '客人']);
    const result = harness.manager.updateRoomSettings(ROOM_CODE, 'host', {
      minimalUndoEnabled: 'yes' as unknown as boolean,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_ROOM_ACTION');
  });
});

describe('发起悔棋的前置条件', () => {
  test('房主没开悔棋时发起被拒：UNDO_DISABLED', () => {
    const harness = twoHumanRoom();
    const { actorId } = moveCurrentActor(harness.manager);

    const result = harness.manager.requestUndo(ROOM_CODE, actorId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('UNDO_DISABLED');
  });

  test('开了悔棋但还没人走过：UNDO_UNAVAILABLE', () => {
    const harness = twoHumanRoom(true);

    const result = harness.manager.requestUndo(ROOM_CODE, 'host');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('UNDO_UNAVAILABLE');
  });

  test('只有上一手行动者本人能发起，别人发起一律 UNDO_UNAVAILABLE', () => {
    const harness = twoHumanRoom(true);
    const { actorId } = moveCurrentActor(harness.manager);

    const denied = harness.manager.requestUndo(ROOM_CODE, otherOf(actorId));

    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.code).toBe('UNDO_UNAVAILABLE');
    // 被拒之后可悔权仍在原行动者手上，没有被这次误操作吃掉。
    expect(harness.manager.getUndoAvailability(ROOM_CODE)).toBe(actorId);
  });

  test('同一时刻只允许一个悔棋请求：重复发起 → UNDO_PENDING', () => {
    const harness = twoHumanRoom(true);
    const { actorId } = moveCurrentActor(harness.manager);

    expect(harness.manager.requestUndo(ROOM_CODE, actorId).ok).toBe(true);
    const again = harness.manager.requestUndo(ROOM_CODE, actorId);

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.code).toBe('UNDO_PENDING');
  });

  test('没有在场人类对手可确认时发起被拒（对手已掉线）', () => {
    const harness = twoHumanRoom(true);
    const { actorId } = moveCurrentActor(harness.manager);
    expect(harness.manager.markDisconnected(ROOM_CODE, otherOf(actorId)).ok).toBe(true);

    const result = harness.manager.requestUndo(ROOM_CODE, actorId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('UNDO_UNAVAILABLE');
  });

  test('请求里带着表决名单、发起者昵称，且初始无人表态', () => {
    const harness = twoHumanRoom(true);
    const { actorId } = moveCurrentActor(harness.manager);

    const result = harness.manager.requestUndo(ROOM_CODE, actorId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.requesterId).toBe(actorId);
    expect(result.value.requesterNickname).toBe(actorId === 'host' ? '房主' : '客人');
    expect(result.value.voterIds).toEqual([otherOf(actorId)]);
    expect(result.value.approvals).toEqual([]);
    expect(result.events.map((event) => event.type)).toEqual(['undo_request']);
  });
});

describe('悔棋表决', () => {
  test('对手同意 → 真的退回上一步，且 undo_result 先于 game_snapshot', () => {
    const harness = twoHumanRoom(true);
    const before = stateOf(harness.manager);
    const { actorId } = moveCurrentActor(harness.manager);
    expect(stateOf(harness.manager)).not.toEqual(before);

    const requested = harness.manager.requestUndo(ROOM_CODE, actorId);
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    const voted = harness.manager.voteUndo(ROOM_CODE, requested.value.voterIds[0], requested.value.requestId, true);

    expect(voted.ok).toBe(true);
    if (!voted.ok) return;
    // 顺序是硬约束：客户端要靠「已回退」这条先到，才能把紧随其后的快照当硬重置处理。
    expect(voted.events.map((event) => event.type)).toEqual(['undo_result', 'game_snapshot', 'undo_available']);

    const resultEvent = voted.events[0];
    expect(resultEvent.type).toBe('undo_result');
    if (resultEvent.type !== 'undo_result') return;
    expect(resultEvent.result).toEqual({ requestId: requested.value.requestId, outcome: 'applied' });

    // 状态确实回到了走之前那一份。
    expect(stateOf(harness.manager)).toEqual(before);
    // 只退一步：退完就没有可悔点了，不能再无限往回走。
    expect(harness.manager.getUndoAvailability(ROOM_CODE)).toBeNull();
    expect(harness.manager.requestUndo(ROOM_CODE, actorId).ok).toBe(false);
  });

  test('多人表决要集齐全部同意：先同意只广播进度，最后一人同意才回退', () => {
    const harness = threeHumanRoom();
    const before = stateOf(harness.manager);
    const { actorId } = moveCurrentActor(harness.manager);

    const requested = harness.manager.requestUndo(ROOM_CODE, actorId);
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    expect(requested.value.voterIds).toHaveLength(2);
    const [firstVoter, secondVoter] = requested.value.voterIds;

    const partial = harness.manager.voteUndo(ROOM_CODE, firstVoter, requested.value.requestId, true);
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(partial.events.map((event) => event.type)).toEqual(['undo_request']);
    const progress = partial.events[0];
    expect(progress.type).toBe('undo_request');
    if (progress.type !== 'undo_request') return;
    expect(progress.request.approvals).toEqual([firstVoter]);
    // 还差一票，对局一动不动。
    expect(stateOf(harness.manager)).not.toEqual(before);

    const finalVote = harness.manager.voteUndo(ROOM_CODE, secondVoter, requested.value.requestId, true);
    expect(finalVote.ok).toBe(true);
    if (!finalVote.ok) return;
    expect(finalVote.events.map((event) => event.type)).toEqual(['undo_result', 'game_snapshot', 'undo_available']);
    expect(stateOf(harness.manager)).toEqual(before);
  });

  test('任一对手拒绝 → 立刻作废，且不动对局', () => {
    const harness = twoHumanRoom(true);
    const { actorId } = moveCurrentActor(harness.manager);
    const afterMove = stateOf(harness.manager);

    const requested = harness.manager.requestUndo(ROOM_CODE, actorId);
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    const voted = harness.manager.voteUndo(ROOM_CODE, requested.value.voterIds[0], requested.value.requestId, false);

    expect(voted.ok).toBe(true);
    if (!voted.ok) return;
    expect(voted.events.map((event) => event.type)).toEqual(['undo_result']);
    const resultEvent = voted.events[0];
    expect(resultEvent.type).toBe('undo_result');
    if (resultEvent.type !== 'undo_result') return;
    expect(resultEvent.result.outcome).toBe('rejected');
    expect(stateOf(harness.manager)).toEqual(afterMove);
    // 被拒之后可悔权仍然在原行动者手上（他还能重新发起一次，或者干脆认了）。
    expect(harness.manager.getUndoAvailability(ROOM_CODE)).toBe(actorId);
  });

  test('重复同意是幂等的：网络重发不会把一次请求算成两票', () => {
    const harness = threeHumanRoom();
    const { actorId } = moveCurrentActor(harness.manager);

    const requested = harness.manager.requestUndo(ROOM_CODE, actorId);
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    const [firstVoter] = requested.value.voterIds;

    const first = harness.manager.voteUndo(ROOM_CODE, firstVoter, requested.value.requestId, true);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.events.map((event) => event.type)).toEqual(['undo_request']);

    const repeated = harness.manager.voteUndo(ROOM_CODE, firstVoter, requested.value.requestId, true);
    expect(repeated.ok).toBe(true);
    if (!repeated.ok) return;
    expect(repeated.events).toEqual([]);
  });

  test('不需要表态的人投票 → UNDO_UNAVAILABLE', () => {
    const harness = threeHumanRoom();
    const { actorId } = moveCurrentActor(harness.manager);

    const requested = harness.manager.requestUndo(ROOM_CODE, actorId);
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    const asRequester = harness.manager.voteUndo(ROOM_CODE, actorId, requested.value.requestId, true);
    const asOutsider = harness.manager.voteUndo(ROOM_CODE, 'nobody', requested.value.requestId, true);

    expect(asRequester.ok).toBe(false);
    expect(asOutsider.ok).toBe(false);
  });

  test('拿旧 requestId 投票 → UNDO_UNAVAILABLE（请求已经结束了）', () => {
    const harness = twoHumanRoom(true);
    const { actorId } = moveCurrentActor(harness.manager);

    const requested = harness.manager.requestUndo(ROOM_CODE, actorId);
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    expect(harness.manager.cancelUndo(ROOM_CODE, actorId).ok).toBe(true);

    const stale = harness.manager.voteUndo(ROOM_CODE, requested.value.voterIds[0], requested.value.requestId, true);

    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.code).toBe('UNDO_UNAVAILABLE');
  });

  test('20 秒内没集齐票 → 超时视为拒绝（异步广播 expired），对局不动', () => {
    const harness = twoHumanRoom(true);
    const { actorId } = moveCurrentActor(harness.manager);
    const afterMove = stateOf(harness.manager);

    const requested = harness.manager.requestUndo(ROOM_CODE, actorId);
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    const timer = harness.timers.filter((candidate) => candidate.active).at(-1);
    expect(timer).toBeDefined();
    if (timer === undefined) return;
    expect(timer.delayMs).toBe(UNDO_TTL_MS);
    timer.callback();

    const expired = harness.asyncEvents.filter((event) => event.type === 'undo_result');
    expect(expired).toHaveLength(1);
    const expiredEvent = expired[0];
    expect(expiredEvent.type).toBe('undo_result');
    if (expiredEvent.type !== 'undo_result') return;
    expect(expiredEvent.result).toEqual({ requestId: requested.value.requestId, outcome: 'expired' });

    expect(stateOf(harness.manager)).toEqual(afterMove);
    // 超时只是作废这次请求，可悔权本身还在——玩家可以重新发起。
    expect(harness.manager.getUndoAvailability(ROOM_CODE)).toBe(actorId);
  });
});

describe('悔棋的撤回与作废', () => {
  test('发起者撤回自己的请求 → cancelled', () => {
    const harness = twoHumanRoom(true);
    const { actorId } = moveCurrentActor(harness.manager);
    const afterMove = stateOf(harness.manager);

    const requested = harness.manager.requestUndo(ROOM_CODE, actorId);
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    const cancelled = harness.manager.cancelUndo(ROOM_CODE, actorId);

    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.events.map((event) => event.type)).toEqual(['undo_result']);
    const resultEvent = cancelled.events[0];
    expect(resultEvent.type).toBe('undo_result');
    if (resultEvent.type !== 'undo_result') return;
    expect(resultEvent.result.outcome).toBe('cancelled');
    expect(stateOf(harness.manager)).toEqual(afterMove);
  });

  test('别人不能替发起者撤回 → UNDO_UNAVAILABLE', () => {
    const harness = twoHumanRoom(true);
    const { actorId } = moveCurrentActor(harness.manager);

    const requested = harness.manager.requestUndo(ROOM_CODE, actorId);
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    const denied = harness.manager.cancelUndo(ROOM_CODE, otherOf(actorId));

    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.code).toBe('UNDO_UNAVAILABLE');
  });

  test('没有请求时撤回 → UNDO_UNAVAILABLE', () => {
    const harness = twoHumanRoom(true);
    const { actorId } = moveCurrentActor(harness.manager);

    const denied = harness.manager.cancelUndo(ROOM_CODE, actorId);

    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.code).toBe('UNDO_UNAVAILABLE');
  });

  test('电脑走的一步不作数：它既不产生可悔权，也不会留下旧的可悔点', () => {
    const harness = botFirstRoom();

    // 电脑先手：开局就排好了一枚自动化计时器，此时还没有任何可悔点。
    expect(harness.manager.getUndoAvailability(ROOM_CODE)).toBeNull();

    const timer = harness.timers.filter((candidate) => candidate.active).at(-1);
    expect(timer).toBeDefined();
    if (timer === undefined) return;
    timer.callback();

    // 电脑走完之后依然没人可悔（电脑不能悔，也不该替上一位真人留一个可悔点）。
    expect(harness.manager.getUndoAvailability(ROOM_CODE)).toBeNull();
    const denied = harness.manager.requestUndo(ROOM_CODE, 'host');
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.code).toBe('UNDO_UNAVAILABLE');

    // 自动走的那一步只广播对局推进 + 一条「现在没人可悔」，让客户端把旧的可悔按钮摘掉；
    // 但它绝不产生任何请求事件——电脑不会请求悔棋。
    const availability = harness.asyncEvents.filter((event) => event.type === 'undo_available');
    expect(availability).toHaveLength(1);
    expect(availability[0].playerId).toBeNull();
    expect(harness.asyncEvents.some((event) => event.type === 'undo_request')).toBe(false);
  });

  test('房主踢人出局后旧的可悔点被作废，并广播「没人可悔」', () => {
    const harness = threeHumanRoom();
    const { actorId } = moveCurrentActor(harness.manager);
    expect(harness.manager.getUndoAvailability(ROOM_CODE)).toBe(actorId);

    const victim = actorId === 'host' ? 'guest' : 'host';
    const kicked = harness.manager.kickPlayer(ROOM_CODE, 'host', victim);

    expect(kicked.ok).toBe(true);
    if (!kicked.ok) return;
    expect(harness.manager.getUndoAvailability(ROOM_CODE)).toBeNull();
    const availability = kicked.events.at(-1);
    expect(availability?.type).toBe('undo_available');
    if (availability?.type !== 'undo_available') return;
    expect(availability.playerId).toBeNull();
  });
});
