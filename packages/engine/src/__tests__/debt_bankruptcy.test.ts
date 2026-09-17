import { describe, it, expect } from 'vitest';
import { createGame, applyIntent } from '../engine';
import { applyCardEffect } from '../effects';
import { getActiveMapPack } from '@richman/board-data';
import { rollDice } from '../rng';
import type { CellEffect } from '@richman/board-data';
import type { GameState, PropertyState } from '../types';

const chinaMap = getActiveMapPack('china-tour');

function makeStarted(players = ['p1', 'p2', 'p3']): GameState {
  return createGame({
    mapRef: chinaMap.ref,
    ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: chinaMap.game.config,
    players: players.map((id) => ({ id, nickname: id })),
    seed: 'debt-bankruptcy-test',
  });
}

function player(s: GameState, id: string) {
  return s.players.find((p) => p.id === id)!;
}

function withProperty(
  s: GameState,
  cellId: number,
  ownerId: string,
  opts: { level?: number; mortgaged?: boolean } = {},
): GameState {
  const prop: PropertyState = { ownerId, level: opts.level ?? 0, mortgaged: opts.mortgaged ?? false };
  return { ...s, properties: { ...s.properties, [cellId]: prop } };
}

function makeStateForRoll(targetSum: number, startPos: number): GameState {
  for (let seed = 1; seed < 100000; seed++) {
    const [dice] = rollDice(seed);
    if (dice[0] + dice[1] === targetSum) {
      const state = makeStarted(['p1', 'p2']);
      return {
        ...state,
        seed: String(seed),
        players: state.players.map((p) => (p.id === state.currentPlayerId ? { ...p, position: startPos } : p)),
      };
    }
  }
  throw new Error(`no dice seed for ${targetSum}`);
}

describe('债务与破产（01 §11） // M2 step9', () => {
  it('E12: 债务状态下卖房后现金足额，立即支付债主并恢复 managing', () => {
    let s = makeStarted(['p1', 'p2']);
    s = withProperty(s, 2, 'p1', { level: 2 }); // 福建 houseCost=1500，卖一幢返 750
    s = {
      ...s,
      currentPlayerId: 'p1',
      turnPhase: 'managing',
      debt: { debtorId: 'p1', creditorId: 'p2', amount: 700 },
      players: s.players.map((p) => (p.id === 'p1' ? { ...p, cash: 0 } : p)),
    };
    const creditorBefore = player(s, 'p2').cash;
    const r = applyIntent(s, 'p1', { type: 'sell_house', cellId: 2 });
    if (!r.ok) throw new Error('fail');
    expect(r.state.debt).toBeNull();
    expect(player(r.state, 'p1').cash).toBe(50);
    expect(player(r.state, 'p2').cash).toBe(creditorBefore + 700);
    expect(r.events.some((e) => e.type === 'debt_resolved')).toBe(true);
    expect(r.state.turnPhase).toBe('managing');
  });

  it('保留可出售房屋时，债务不会自动破产', () => {
    let s = makeStarted(['p1', 'p2', 'p3']);
    s = withProperty(s, 2, 'p1', { level: 2 });
    s = {
      ...s,
      currentPlayerId: 'p1',
      turnPhase: 'managing',
      debt: { debtorId: 'p1', creditorId: 'p2', amount: 999999 },
      players: s.players.map((p) => (p.id === 'p1' ? { ...p, cash: 0 } : p)),
    };

    const r = applyIntent(s, 'p1', { type: 'sell_house', cellId: 2 });

    if (!r.ok) throw new Error('fail');
    expect(r.state.debt).toMatchObject({ debtorId: 'p1', amount: 999999 });
    expect(r.state.properties[2].level).toBe(1);
    expect(player(r.state, 'p1').bankrupt).toBe(false);
    expect(r.events.some((e) => e.type === 'player_bankrupt')).toBe(false);
  });

  it('抵押最后一块可用地产后仍不足时自动破产', () => {
    let s = makeStarted(['p1', 'p2', 'p3']);
    s = withProperty(s, 2, 'p1');
    s = {
      ...s,
      currentPlayerId: 'p1',
      turnPhase: 'managing',
      debt: { debtorId: 'p1', creditorId: 'p2', amount: 999999 },
      players: s.players.map((p) => (p.id === 'p1' ? { ...p, cash: 0 } : p)),
    };

    const r = applyIntent(s, 'p1', { type: 'mortgage_property', cellId: 2 });

    if (!r.ok) throw new Error('fail');
    expect(player(r.state, 'p1').bankrupt).toBe(true);
    expect(r.state.debt).toBeNull();
    expect(r.events.filter((e) => e.type === 'player_bankrupt')).toHaveLength(1);
    expect(r.state.properties[2]).toEqual({ ownerId: null, level: 0, mortgaged: false });
    expect(r.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['property_mortgaged', 'player_bankrupt']),
    );
  });

  it('忽略非地产格上的孤儿产权，不阻止自动破产', () => {
    let s = makeStarted(['p1', 'p2', 'p3']);
    s = withProperty(s, 2, 'p1');
    s = {
      ...s,
      currentPlayerId: 'p1',
      turnPhase: 'managing',
      debt: { debtorId: 'p1', creditorId: 'p2', amount: 999999 },
      players: s.players.map((p) => (p.id === 'p1' ? { ...p, cash: 0 } : p)),
      properties: {
        ...s.properties,
        3: { ownerId: 'p1', level: 0, mortgaged: false },
      },
    };

    const r = applyIntent(s, 'p1', { type: 'mortgage_property', cellId: 2 });

    if (!r.ok) throw new Error('fail');
    expect(player(r.state, 'p1').bankrupt).toBe(true);
    expect(r.events.some((event) => event.type === 'player_bankrupt')).toBe(true);
  });

  it('无资产玩家触发税务债务后立即自动破产', () => {
    const base = makeStateForRoll(2, 21);
    const debtorId = base.currentPlayerId;
    const s = {
      ...base,
      players: base.players.map((p) => (p.id === debtorId ? { ...p, cash: 500 } : p)),
    };

    const r = applyIntent(s, debtorId, { type: 'roll_dice' });

    if (!r.ok) throw new Error('fail');
    expect(player(r.state, debtorId).bankrupt).toBe(true);
    expect(r.state.debt).toBeNull();
    const eventTypes = r.events.map((event) => event.type);
    const debtEnteredIndex = eventTypes.indexOf('debt_entered');
    expect(debtEnteredIndex).toBeGreaterThanOrEqual(0);
    expect(eventTypes.indexOf('player_bankrupt')).toBeGreaterThan(debtEnteredIndex);
    expect(r.events.filter((event) => event.type === 'player_bankrupt')).toHaveLength(1);
  });

  it('一个抵押意图会从付款队列连续自动破产两个无力付款人', () => {
    let s = makeStarted(['p1', 'p2', 'p3', 'p4']);
    s = withProperty(s, 2, 'p2');
    s = {
      ...s,
      currentPlayerId: 'p1',
      turnPhase: 'managing',
      debt: {
        debtorId: 'p2',
        creditorId: 'p1',
        amount: 999999,
        resume: { payments: [{ debtorId: 'p3', creditorId: 'p1', amount: 500 }] },
      },
      players: s.players.map((p) => {
        if (p.id === 'p2') return { ...p, cash: 0 };
        if (p.id === 'p3') return { ...p, cash: 100 };
        return p;
      }),
    };

    const r = applyIntent(s, 'p2', { type: 'mortgage_property', cellId: 2 });

    if (!r.ok) throw new Error('fail');
    expect(player(r.state, 'p2').bankrupt).toBe(true);
    expect(player(r.state, 'p3').bankrupt).toBe(true);
    expect(r.state.debt).toBeNull();
    expect(r.events.filter((e) => e.type === 'player_bankrupt').map((e) => e.playerId)).toEqual(['p2', 'p3']);
    expect(r.state.recentLog.slice(-r.events.length)).toEqual(r.events);
  });

  it('E13: 欠玩家且全部变现仍不足时可破产，现金给债主，地产全部变无主', () => {
    let s = makeStarted(['p1', 'p2']);
    s = withProperty(s, 2, 'p1', { level: 0 });
    s = withProperty(s, 6, 'p1', { level: 0 });
    s = {
      ...s,
      currentPlayerId: 'p1',
      turnPhase: 'managing',
      debt: { debtorId: 'p1', creditorId: 'p2', amount: 999999 },
      players: s.players.map((p) => (p.id === 'p1' ? { ...p, cash: 123 } : p)),
    };
    const creditorBefore = player(s, 'p2').cash;
    const r = applyIntent(s, 'p1', { type: 'declare_bankrupt' });
    if (!r.ok) throw new Error('fail');
    expect(player(r.state, 'p1').bankrupt).toBe(true);
    expect(player(r.state, 'p1').cash).toBe(0);
    expect(player(r.state, 'p2').cash).toBe(creditorBefore + 123);
    expect(r.state.properties[2].ownerId).toBeNull();
    expect(r.state.properties[6].ownerId).toBeNull();
    expect(r.state.debt).toBeNull();
    expect(r.events.some((e) => e.type === 'player_bankrupt')).toBe(true);
  });

  it('E14: 欠银行破产时现金缴银行，地产同样变无主', () => {
    let s = makeStarted(['p1', 'p2']);
    s = withProperty(s, 2, 'p1', { level: 0 });
    s = {
      ...s,
      currentPlayerId: 'p1',
      turnPhase: 'managing',
      debt: { debtorId: 'p1', creditorId: null, amount: 999999 },
      players: s.players.map((p) => (p.id === 'p1' ? { ...p, cash: 123 } : p)),
    };
    const r = applyIntent(s, 'p1', { type: 'declare_bankrupt' });
    if (!r.ok) throw new Error('fail');
    expect(player(r.state, 'p1').bankrupt).toBe(true);
    expect(player(r.state, 'p1').cash).toBe(0);
    expect(r.state.properties[2].ownerId).toBeNull();
    expect(r.events.find((e) => e.type === 'player_bankrupt')).toMatchObject({ creditorId: null });
  });

  it('玩家破产时记录出局回合 bankruptTurn = 宣告破产时的 turn（01 §12 存活回合数）', () => {
    let s = makeStarted(['p1', 'p2']);
    s = {
      ...s,
      turn: 7, // 模拟进行到第 7 回合
      currentPlayerId: 'p1',
      turnPhase: 'managing',
      debt: { debtorId: 'p1', creditorId: 'p2', amount: 999999 },
      players: s.players.map((p) => (p.id === 'p1' ? { ...p, cash: 0 } : p)),
    };
    const r = applyIntent(s, 'p1', { type: 'declare_bankrupt' });
    if (!r.ok) throw new Error('fail');
    expect(player(r.state, 'p1').bankruptTurn).toBe(7);
  });

  it('未破产玩家 bankruptTurn 始终为 null', () => {
    const s = makeStarted();
    for (const p of s.players) {
      expect(p.bankruptTurn).toBeNull();
    }
  });

  // === 金钱事件完备性（M2 收尾：仿真对账依赖）===
  it('debt_resolved 带 amount + creditorId（债主为玩家）', () => {
    // E12 场景：p1 欠 p2 700，卖房后还清
    let s = makeStarted(['p1', 'p2']);
    s = withProperty(s, 2, 'p1', { level: 2 });
    s = {
      ...s,
      currentPlayerId: 'p1',
      turnPhase: 'managing',
      debt: { debtorId: 'p1', creditorId: 'p2', amount: 700 },
      players: s.players.map((p) => (p.id === 'p1' ? { ...p, cash: 0 } : p)),
    };
    const r = applyIntent(s, 'p1', { type: 'sell_house', cellId: 2 });
    if (!r.ok) throw new Error('fail');
    const resolved = r.events.find((e) => e.type === 'debt_resolved');
    expect(resolved).toMatchObject({ amount: 700, creditorId: 'p2' });
  });

  it('player_bankrupt 带 transferredCash（欠玩家时 = 转给债主的现金）', () => {
    let s = makeStarted(['p1', 'p2']);
    s = {
      ...s,
      currentPlayerId: 'p1',
      turnPhase: 'managing',
      debt: { debtorId: 'p1', creditorId: 'p2', amount: 999999 },
      players: s.players.map((p) => (p.id === 'p1' ? { ...p, cash: 123 } : p)),
    };
    const r = applyIntent(s, 'p1', { type: 'declare_bankrupt' });
    if (!r.ok) throw new Error('fail');
    const bankrupt = r.events.find((e) => e.type === 'player_bankrupt');
    expect(bankrupt).toMatchObject({ playerId: 'p1', creditorId: 'p2', transferredCash: 123 });
  });

  it('player_bankrupt 欠银行时 transferredCash = 缴银行的现金', () => {
    let s = makeStarted(['p1', 'p2']);
    s = {
      ...s,
      currentPlayerId: 'p1',
      turnPhase: 'managing',
      debt: { debtorId: 'p1', creditorId: null, amount: 999999 },
      players: s.players.map((p) => (p.id === 'p1' ? { ...p, cash: 200 } : p)),
    };
    const r = applyIntent(s, 'p1', { type: 'declare_bankrupt' });
    if (!r.ok) throw new Error('fail');
    const bankrupt = r.events.find((e) => e.type === 'player_bankrupt');
    expect(bankrupt).toMatchObject({ creditorId: null, transferredCash: 200 });
  });

  it('债务人不是 currentPlayerId 时，债务人仍可卖产筹款，且回合仍属于原当前玩家', () => {
    let s = makeStarted(['p1', 'p2', 'p3']);
    s = withProperty(s, 2, 'p2', { level: 1 });
    s = {
      ...s,
      currentPlayerId: 'p1',
      turnPhase: 'managing',
      debt: { debtorId: 'p2', creditorId: 'p1', amount: 500 },
      players: s.players.map((p) => (p.id === 'p2' ? { ...p, cash: 0 } : p)),
    };
    const r = applyIntent(s, 'p2', { type: 'sell_house', cellId: 2 });
    if (!r.ok) throw new Error('fail');
    expect(r.state.debt).toBeNull();
    expect(player(r.state, 'p1').cash).toBe(15500);
    expect(r.state.currentPlayerId).toBe('p1');
  });

  it('E15/A: receive_from_each_player 某付款人现金不足进入该付款人债务，后续付款排队', () => {
    let s = makeStarted(['p1', 'p2', 'p3']);
    s = {
      ...s,
      players: s.players.map((p) => {
        if (p.id === 'p1') return { ...p, cash: 1000 };
        if (p.id === 'p2') return { ...p, cash: 300 };
        return { ...p, cash: 1000 };
      }),
    };
    const card = chinaMap.game.cards.chance.find((c) => c.id === '71-02')!; // 每人给 p1 500
    const r = applyCardEffect(s, 'p1', card, []);
    expect(r.newDebt).toMatchObject({ debtorId: 'p2', creditorId: 'p1', amount: 200 });
    expect(r.newDebt?.resume?.payments).toEqual([
      { debtorId: 'p3', creditorId: 'p1', amount: 500 },
    ]);
    expect(player(r.state, 'p1').cash).toBe(1300);
    expect(player(r.state, 'p2').cash).toBe(0);
    expect(r.events.filter((e) => e.type === 'debt_entered')).toHaveLength(1);
  });

  it('E15/A: receive_from_each_player 中一个付款人破产后继续收后续玩家', () => {
    let s = makeStarted(['p1', 'p2', 'p3']);
    s = {
      ...s,
      currentPlayerId: 'p1',
      turnPhase: 'managing',
      debt: {
        debtorId: 'p2',
        creditorId: 'p1',
        amount: 200,
        resume: { payments: [{ debtorId: 'p3', creditorId: 'p1', amount: 500 }] },
      },
      players: s.players.map((p) => {
        if (p.id === 'p2') return { ...p, cash: 0 };
        if (p.id === 'p3') return { ...p, cash: 1000 };
        return p;
      }),
    };
    const before = player(s, 'p1').cash;
    const r = applyIntent(s, 'p2', { type: 'declare_bankrupt' });
    if (!r.ok) throw new Error('fail');
    expect(player(r.state, 'p2').bankrupt).toBe(true);
    expect(player(r.state, 'p3').cash).toBe(500);
    expect(player(r.state, 'p1').cash).toBe(before + 500);
    expect(r.state.debt).toBeNull();
    expect(r.state.currentPlayerId).toBe('p1');
    const bankruptcyIdx = r.events.findIndex((e) => e.type === 'player_bankrupt' && (e as { playerId: string }).playerId === 'p2');
    expect(bankruptcyIdx).toBeGreaterThanOrEqual(0);
  });

  it('E15/A: 后续付款人也现金不足时，继续进入后续付款人的新债务', () => {
    let s = makeStarted(['p1', 'p2', 'p3']);
    s = withProperty(s, 2, 'p3');
    s = {
      ...s,
      currentPlayerId: 'p1',
      turnPhase: 'managing',
      debt: {
        debtorId: 'p2',
        creditorId: 'p1',
        amount: 200,
        resume: { payments: [{ debtorId: 'p3', creditorId: 'p1', amount: 500 }] },
      },
      players: s.players.map((p) => {
        if (p.id === 'p2') return { ...p, cash: 0 };
        if (p.id === 'p3') return { ...p, cash: 100 };
        return p;
      }),
    };
    const before = player(s, 'p1').cash;
    const r = applyIntent(s, 'p2', { type: 'declare_bankrupt' });
    if (!r.ok) throw new Error('fail');
    expect(r.state.debt).toMatchObject({ debtorId: 'p3', creditorId: 'p1', amount: 400 });
    expect(player(r.state, 'p1').cash).toBe(before + 100);
    expect(player(r.state, 'p3').cash).toBe(0);
    expect(r.state.currentPlayerId).toBe('p1');
  });

  it('E15/A: 卖房还清当前付款人债务后，继续处理队列中的后续付款', () => {
    let s = makeStarted(['p1', 'p2', 'p3']);
    s = withProperty(s, 2, 'p2', { level: 1 });
    s = {
      ...s,
      currentPlayerId: 'p1',
      turnPhase: 'managing',
      debt: {
        debtorId: 'p2',
        creditorId: 'p1',
        amount: 200,
        resume: { payments: [{ debtorId: 'p3', creditorId: 'p1', amount: 500 }] },
      },
      players: s.players.map((p) => {
        if (p.id === 'p2') return { ...p, cash: 0 };
        if (p.id === 'p3') return { ...p, cash: 1000 };
        return p;
      }),
    };
    const before = player(s, 'p1').cash;
    const r = applyIntent(s, 'p2', { type: 'sell_house', cellId: 2 });
    if (!r.ok) throw new Error('fail');
    expect(r.state.debt).toBeNull();
    expect(player(r.state, 'p1').cash).toBe(before + 200 + 500);
    expect(player(r.state, 'p3').cash).toBe(500);
    const resolvedIdx = r.events.findIndex((e) => e.type === 'debt_resolved');
    expect(resolvedIdx).toBeGreaterThanOrEqual(0);
  });

  it('E15: pay_each_player 当前付款人破产后，后续收款人不再收到付款', () => {
    let s = makeStarted(['p1', 'p2', 'p3']);
    s = { ...s, players: s.players.map((p) => (p.id === 'p1' ? { ...p, cash: 300 } : p)) };
    const synthetic = { id: 'synthetic-pay-each', effect: { type: 'pay_each_player', amount: 500 } as CellEffect };
    const r = applyCardEffect(s, 'p1', synthetic, []);
    expect(r.newDebt).toMatchObject({ debtorId: 'p1', creditorId: 'p2', amount: 200 });
    expect(r.newDebt?.resume?.payments).toEqual([
      { debtorId: 'p1', creditorId: 'p3', amount: 500 },
    ]);
    const bankrupt = applyIntent({ ...r.state, currentPlayerId: 'p1', turnPhase: 'managing', debt: r.newDebt }, 'p1', { type: 'declare_bankrupt' });
    if (!bankrupt.ok) throw new Error('fail');
    expect(player(bankrupt.state, 'p3').cash).toBe(15000); // p1 已破产，后续付款停止
  });

  it('E17: 破产玩家在轮转中被跳过', () => {
    const base = makeStarted(['p1', 'p2', 'p3']);
    const s = {
      ...base,
      currentPlayerId: 'p1',
      turnPhase: 'managing' as const,
      players: base.players.map((p) => (p.id === 'p2' ? { ...p, bankrupt: true } : p)),
    };
    const r = applyIntent(s, 'p1', { type: 'end_turn' });
    if (!r.ok) throw new Error('fail');
    expect(r.state.currentPlayerId).toBe('p3');
  });

  it('E17: 多人局当前玩家破产后，自动结束其回合并轮到下一位存活玩家', () => {
    const base = makeStarted(['p1', 'p2', 'p3']);
    const s = {
      ...base,
      currentPlayerId: 'p1',
      turnPhase: 'managing' as const,
      debt: { debtorId: 'p1', creditorId: 'p2', amount: 999999 },
    };
    const r = applyIntent(s, 'p1', { type: 'declare_bankrupt' });
    if (!r.ok) throw new Error('fail');
    expect(r.state.phase).toBe('playing');
    expect(r.state.currentPlayerId).toBe('p2');
    expect(r.state.turnPhase).toBe('awaiting_roll');
    expect(r.events.some((e) => e.type === 'turn_ended' && (e as { playerId: string }).playerId === 'p1')).toBe(true);
    expect(r.events.some((e) => e.type === 'turn_started' && (e as { playerId: string }).playerId === 'p2')).toBe(true);
  });

  it('E17/E24: 当前玩家破产后自动换人时，会消耗并跳过暂停中的下一位玩家', () => {
    const base = makeStarted(['p1', 'p2', 'p3']);
    const ids = base.players.map((p) => p.id);
    const s = {
      ...base,
      currentPlayerId: ids[0],
      turnPhase: 'managing' as const,
      debt: { debtorId: ids[0], creditorId: ids[2], amount: 999999 },
      players: base.players.map((p) => (p.id === ids[1] ? { ...p, skipTurns: 1 } : p)),
    };
    const r = applyIntent(s, ids[0], { type: 'declare_bankrupt' });
    if (!r.ok) throw new Error('fail');
    expect(r.state.currentPlayerId).toBe(ids[2]);
    expect(player(r.state, ids[1]).skipTurns).toBe(0);
    expect(r.events.some((e) => e.type === 'turn_started' && (e as { playerId: string }).playerId === ids[1])).toBe(true);
    expect(r.events.some((e) => e.type === 'turn_ended' && (e as { playerId: string }).playerId === ids[1])).toBe(true);
  });

  it('E17/E24: 当前玩家破产后，所有存活玩家都 skipTurns>1 时，持续消耗到首个可行动玩家', () => {
    const base = makeStarted(['p1', 'p2', 'p3']);
    const ids = base.players.map((p) => p.id);
    const s = {
      ...base,
      currentPlayerId: ids[0],
      turnPhase: 'managing' as const,
      debt: { debtorId: ids[0], creditorId: ids[2], amount: 999999 },
      players: base.players.map((p) => {
        if (p.id === ids[1]) return { ...p, skipTurns: 2 };
        if (p.id === ids[2]) return { ...p, skipTurns: 2 };
        return p;
      }),
    };
    const r = applyIntent(s, ids[0], { type: 'declare_bankrupt' });
    if (!r.ok) throw new Error('fail');
    // 两人各被跳过两轮，skipTurns 全部消耗为 0
    expect(player(r.state, ids[1]).skipTurns).toBe(0);
    expect(player(r.state, ids[2]).skipTurns).toBe(0);
    // 当前玩家必须是 skipTurns===0 的存活玩家（按算法回到 ids[1]）
    const currentId = r.state.currentPlayerId;
    expect(player(r.state, currentId).bankrupt).toBe(false);
    expect(player(r.state, currentId).skipTurns).toBe(0);
    // 被跳过玩家应各留下至少 2 组空回合 turn_started/turn_ended
    for (const id of [ids[1], ids[2]]) {
      const ts = r.events.filter(
        (e) => e.type === 'turn_started' && (e as { playerId: string }).playerId === id,
      );
      const te = r.events.filter(
        (e) => e.type === 'turn_ended' && (e as { playerId: string }).playerId === id,
      );
      expect(ts.length).toBeGreaterThanOrEqual(2);
      expect(te.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('E17: 2 人局一人破产即终局，另一人为胜者', () => {
    const s = {
      ...makeStarted(['p1', 'p2']),
      currentPlayerId: 'p1',
      turnPhase: 'managing' as const,
      debt: { debtorId: 'p1', creditorId: 'p2', amount: 999999 },
    };
    const r = applyIntent(s, 'p1', { type: 'declare_bankrupt' });
    if (!r.ok) throw new Error('fail');
    expect(r.state.phase).toBe('game_over');
    expect(r.state.winnerId).toBe('p2');
    expect(r.events.some((e) => e.type === 'game_over')).toBe(true);
  });
});
