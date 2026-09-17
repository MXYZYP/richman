import { describe, it, expect } from 'vitest';
import { createGame, applyIntent } from '../engine';
import { applyCardEffect } from '../effects';
import { rollDice } from '../rng';
import { getActiveMapPack } from '@richman/board-data';
import type { CellEffect } from '@richman/board-data';
import type { GameState } from '../types';

const chinaMap = getActiveMapPack('china-tour');

function makeStarted(): GameState {
  return createGame({
    mapRef: chinaMap.ref, ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board, cards: chinaMap.game.cards, config: chinaMap.game.config,
    players: [{ id: 'p1', nickname: '甲' }, { id: 'p2', nickname: '乙' }, { id: 'p3', nickname: '丙' }],
    seed: 'cards-test',
  });
}

const P = (s: GameState) => s.players.find((p) => p.id === s.currentPlayerId)!;
const findCard = (deck: 'chance' | 'destiny', id: string) => chinaMap.game.cards[deck].find((c) => c.id === id)!;

describe('applyCardEffect (01 §9) // 步8 单元', () => {
  it('pay_bank: 扣钱', () => {
    const s = makeStarted();
    const before = P(s).cash;
    const r = applyCardEffect(s, s.currentPlayerId, findCard('chance', '71-03'), []); // 赔 1800
    expect(P(r.state).cash).toBe(before - 1800);
  });

  it('receive_bank: 加钱', () => {
    const s = makeStarted();
    const before = P(s).cash;
    const r = applyCardEffect(s, s.currentPlayerId, findCard('chance', '71-01'), []); // 得 500
    expect(P(r.state).cash).toBe(before + 500);
  });

  it('receive_from_each_player: 其他每位付 500 给本玩家', () => {
    const s = makeStarted();
    const before = P(s).cash;
    const r = applyCardEffect(s, s.currentPlayerId, findCard('chance', '71-02'), []); // 每人救济 500
    expect(P(r.state).cash).toBe(before + 500 * 2); // 2 个其他玩家
  });

  it('repairs: 按房屋数缴费（71-06: 房 400/旅馆 1150）', () => {
    const s = makeStarted();
    // 给玩家一个 level=2 的地（cell 2 福建 houseCost=1500）
    const s2 = {
      ...s,
      properties: { ...s.properties, 2: { ownerId: s.currentPlayerId, level: 2, mortgaged: false } },
    };
    const before = P(s2).cash;
    const r = applyCardEffect(s2, s2.currentPlayerId, findCard('chance', '71-06'), []);
    expect(P(r.state).cash).toBe(before - 2 * 400); // 2 幢房 × 400
  });

  it('repairs: 旅馆按 perHotel 计（level=5）', () => {
    const s = makeStarted();
    const s2 = {
      ...s,
      properties: { ...s.properties, 2: { ownerId: s.currentPlayerId, level: 5, mortgaged: false } },
    };
    const before = P(s2).cash;
    const r = applyCardEffect(s2, s2.currentPlayerId, findCard('chance', '71-06'), []); // 旅馆 1150
    expect(P(r.state).cash).toBe(before - 1150);
  });

  // === 金钱事件完备性（M2 收尾：仿真对账依赖）===
  it('pay_bank 发 bank_paid 事件（含实付金额）', () => {
    const s = makeStarted();
    const r = applyCardEffect(s, s.currentPlayerId, findCard('chance', '71-03'), []); // 赔 1800
    expect(r.events).toContainEqual({ type: 'bank_paid', playerId: s.currentPlayerId, amount: 1800 });
  });

  it('pay_bank 现金不足时 bank_paid.amount = 实付（非全额），差额进债务', () => {
    const base = makeStarted();
    const s = {
      ...base,
      players: base.players.map((p) => (p.id === base.currentPlayerId ? { ...p, cash: 1000 } : p)),
    };
    const r = applyCardEffect(s, s.currentPlayerId, findCard('chance', '71-03'), []); // 应付 1800，实付 1000
    expect(r.events).toContainEqual({ type: 'bank_paid', playerId: s.currentPlayerId, amount: 1000 });
    expect(r.newDebt).not.toBeNull();
  });

  it('receive_bank 发 bank_received 事件', () => {
    const s = makeStarted();
    const r = applyCardEffect(s, s.currentPlayerId, findCard('chance', '71-01'), []); // 得 500
    expect(r.events).toContainEqual({ type: 'bank_received', playerId: s.currentPlayerId, amount: 500 });
  });

  it('receive_from_each_player 每笔到账发 payment_made 事件（from/to/amount）', () => {
    const s = makeStarted();
    const cur = s.currentPlayerId;
    const r = applyCardEffect(s, cur, findCard('chance', '71-02'), []); // 每人救济 500
    const arrivals = r.events.filter((e) => e.type === 'payment_made') as Array<{ from: string; to: string; amount: number }>;
    expect(arrivals).toHaveLength(2); // 2 个其他玩家
    for (const e of arrivals) {
      expect(e.to).toBe(cur);
      expect(e.from).not.toBe(cur);
      expect(e.amount).toBe(500);
    }
  });

  it('repairs 发 bank_paid 事件（实付金额 = 房数×perHouse）', () => {
    const base = makeStarted();
    const s = {
      ...base,
      properties: { ...base.properties, 2: { ownerId: base.currentPlayerId, level: 2, mortgaged: false } },
    };
    const r = applyCardEffect(s, s.currentPlayerId, findCard('chance', '71-06'), []); // 2 幢 × 400 = 800
    expect(r.events).toContainEqual({ type: 'bank_paid', playerId: s.currentPlayerId, amount: 800 });
  });

  it('skip_turn: 设 skipTurns（71-08 暂停一次）', () => {
    const s = makeStarted();
    const r = applyCardEffect(s, s.currentPlayerId, findCard('chance', '71-08'), []);
    expect(P(r.state).skipTurns).toBe(1);
  });

  it('none: 无数值效果（71-20）', () => {
    const s = makeStarted();
    const before = P(s).cash;
    const r = applyCardEffect(s, s.currentPlayerId, findCard('destiny', '71-20'), []);
    expect(P(r.state).cash).toBe(before);
    expect(r.newDebt).toBeNull();
  });

  it('move_to collectSalary=true: 从 15 前进至上海站不经过起点，不领工资（71-24）', () => {
    const base = makeStarted();
    const s = {
      ...base,
      players: base.players.map((p) => (p.id === base.currentPlayerId ? { ...p, position: 15 } : p)),
    };
    const before = P(s).cash;
    const r = applyCardEffect(s, s.currentPlayerId, findCard('destiny', '71-24'), []);
    expect(P(r.state).position).toBe(19); // 上海站
    expect(P(r.state).cash).toBe(before); // 15→16→17→18→19，不经过起点
    const moved = r.events.find((e) => e.type === 'token_moved') as { path: number[] };
    expect(moved.path).toEqual([16, 17, 18, 19]);
  });

  it('move_to collectSalary=true: 从 48 前进至上海站经过起点，领工资（71-24）', () => {
    const base = makeStarted();
    const s = {
      ...base,
      players: base.players.map((p) => (p.id === base.currentPlayerId ? { ...p, position: 48 } : p)),
    };
    const before = P(s).cash;
    const r = applyCardEffect(s, s.currentPlayerId, findCard('destiny', '71-24'), []);
    expect(P(r.state).position).toBe(19);
    expect(P(r.state).cash).toBe(before + 2000);
    const moveIdx = r.events.findIndex((e) => e.type === 'token_moved');
    const salaryIdx = r.events.findIndex((e) => e.type === 'salary_collected');
    expect(moveIdx).toBeGreaterThanOrEqual(0);
    expect(salaryIdx).toBeGreaterThan(moveIdx); // 与普通掷骰一致：先移动动画，再发工资
  });

  it('move_to collectSalary=false: 退回起点不领（71-25）', () => {
    const s = makeStarted();
    const before = P(s).cash;
    const r = applyCardEffect(s, s.currentPlayerId, findCard('destiny', '71-25'), []);
    expect(P(r.state).position).toBe(0);
    expect(P(r.state).cash).toBe(before); // 不领
  });

  it('move_steps: 前进 3 步（71-09）', () => {
    const s = makeStarted();
    const startPos = P(s).position;
    const r = applyCardEffect(s, s.currentPlayerId, findCard('chance', '71-09'), []);
    expect(P(r.state).position).not.toBe(startPos);
  });

  it('move_steps: 前进 3 步落无主地产后进入购买决策（71-09）', () => {
    const base = makeStarted();
    const s = {
      ...base,
      turnPhase: 'managing' as const,
      players: base.players.map((p) => (p.id === base.currentPlayerId ? { ...p, position: 34 } : p)),
    };
    const r = applyCardEffect(s, s.currentPlayerId, findCard('chance', '71-09'), []);
    expect(P(r.state).position).toBe(37); // 海南省，无主地产
    expect(r.state.turnPhase).toBe('awaiting_buy_decision');
  });

  it('move_steps: 前进 3 步落他人地产后扣租（71-09）', () => {
    const base = makeStarted();
    const ids = base.players.map((p) => p.id);
    const s = {
      ...base,
      turnPhase: 'managing' as const,
      players: base.players.map((p) => (p.id === base.currentPlayerId ? { ...p, position: 34 } : p)),
      properties: { ...base.properties, 37: { ownerId: ids[1], level: 0, mortgaged: false } },
    };
    const beforeP1 = P(s).cash;
    const beforeP2 = s.players.find((p) => p.id === ids[1])!.cash;
    const r = applyCardEffect(s, s.currentPlayerId, findCard('chance', '71-09'), []);
    expect(P(r.state).position).toBe(37);
    expect(P(r.state).cash).toBe(beforeP1 - 160); // 海南省空地租金
    expect(r.state.players.find((p) => p.id === ids[1])!.cash).toBe(beforeP2 + 160);
    expect(r.state.turnPhase).toBe('managing');
  });

  it('world effect: 东京前进 5 步落命运格后抽命运牌', () => {
    const base = makeStarted();
    const tokyo = chinaMap.game.board.cells.find((c) => c.id === 53)! as { effect: CellEffect };
    const s = {
      ...base,
      players: base.players.map((p) => (p.id === base.currentPlayerId ? { ...p, position: 53 } : p)),
    };
    const r = applyCardEffect(s, s.currentPlayerId, { id: 'cell-53', effect: tokyo.effect }, []);
    expect(P(r.state).position).toBe(58);
    const drawn = r.events.find((e) => e.type === 'card_drawn') as { deck: string } | undefined;
    expect(drawn?.deck).toBe('destiny');
  });

  it('world effect: 首尔退回起点不领工资，最终 managing', () => {
    const base = makeStarted();
    const seoul = chinaMap.game.board.cells.find((c) => c.id === 52)! as { effect: CellEffect };
    const s = {
      ...base,
      players: base.players.map((p) => (p.id === base.currentPlayerId ? { ...p, position: 52 } : p)),
    };
    const before = P(s).cash;
    const r = applyCardEffect(s, s.currentPlayerId, { id: 'cell-52', effect: seoul.effect }, []);
    expect(P(r.state).position).toBe(0);
    expect(P(r.state).cash).toBe(before);
    expect(r.state.turnPhase).toBe('managing');
    expect(r.events.some((e) => e.type === 'salary_collected')).toBe(false);
  });

  it('world effect: 伦敦前进至上海站，经过起点领工资并继续触发购买决策', () => {
    const base = makeStarted();
    const london = chinaMap.game.board.cells.find((c) => c.id === 56)! as { effect: CellEffect };
    const s = {
      ...base,
      players: base.players.map((p) => (p.id === base.currentPlayerId ? { ...p, position: 56 } : p)),
    };
    const before = P(s).cash;
    const r = applyCardEffect(s, s.currentPlayerId, { id: 'cell-56', effect: london.effect }, []);
    expect(P(r.state).position).toBe(19);
    expect(P(r.state).cash).toBe(before + 2000);
    expect(r.state.turnPhase).toBe('awaiting_buy_decision');
    const moved = r.events.find((e) => e.type === 'token_moved') as { path: number[] };
    expect(moved.path).toContain(0);
  });

  it('world effect: 巴黎前进 1 步到命运格后抽命运牌', () => {
    const base = makeStarted();
    const paris = chinaMap.game.board.cells.find((c) => c.id === 57)! as { effect: CellEffect };
    const s = {
      ...base,
      players: base.players.map((p) => (p.id === base.currentPlayerId ? { ...p, position: 57 } : p)),
    };
    const r = applyCardEffect(s, s.currentPlayerId, { id: 'cell-57', effect: paris.effect }, []);
    expect(P(r.state).position).toBe(58);
    const drawn = r.events.find((e) => e.type === 'card_drawn') as { deck: string } | undefined;
    expect(drawn?.deck).toBe('destiny');
  });

  it('draw_card: 71-30 抽到 71-09 后，移动落点也会继续结算', () => {
    const base = makeStarted();
    const s = {
      ...base,
      decks: { ...base.decks, chance: ['71-09', ...base.decks.chance.filter((id) => id !== '71-09')] },
      players: base.players.map((p) => (p.id === base.currentPlayerId ? { ...p, position: 34 } : p)),
    };
    const r = applyCardEffect(s, s.currentPlayerId, findCard('destiny', '71-30'), []);
    expect(P(r.state).position).toBe(37);
    expect(r.events.some((e) => e.type === 'card_drawn' && (e as { cardId: string }).cardId === '71-09')).toBe(true);
    expect(r.state.turnPhase).toBe('awaiting_buy_decision');
  });

  it('链式效果超过深度上限时明确抛错，而不是静默转 managing', () => {
    const base = makeStarted();
    const loopCard = { id: 'loop', text: '循环抽牌', effect: { type: 'draw_card', deck: 'chance' } as CellEffect };
    const s = {
      ...base,
      decks: { ...base.decks, chance: ['loop'] },
      cards: { ...base.cards, chance: [loopCard] },
    };
    expect(() => applyCardEffect(s, s.currentPlayerId, loopCard, [])).toThrow(/effect depth exceeded/);
  });

  it('draw_card: 再抽一张机会（71-30 命运联动机会）', () => {
    const s = makeStarted();
    const r = applyCardEffect(s, s.currentPlayerId, findCard('destiny', '71-30'), []);
    // 事件应含 card_drawn（第二张）
    const drawn = r.events.filter((e) => e.type === 'card_drawn');
    expect(drawn.length).toBeGreaterThanOrEqual(1);
    expect((drawn[0] as { deck: string }).deck).toBe('chance');
  });

  it('现金不足 → 触发债务', () => {
    const s = makeStarted();
    const s2 = {
      ...s,
      players: s.players.map((p) => (p.id === s.currentPlayerId ? { ...p, cash: 500 } : p)),
    };
    const r = applyCardEffect(s2, s2.currentPlayerId, findCard('chance', '71-03'), []); // 赔 1800
    expect(r.newDebt).not.toBeNull();
    expect(r.newDebt?.amount).toBe(1300);
    expect(P(r.state).cash).toBe(0);
  });
});

describe('落 chance/destiny 触发抽牌 // 步8 集成', () => {
  function makeStateForRoll(targetSum: number, startPos: number): GameState {
    for (let i = 1; i < 100000; i++) {
      const [dice] = rollDice(i);
      if (dice[0] + dice[1] === targetSum) {
        const s = makeStarted();
        return {
          ...s,
          seed: String(i),
          players: s.players.map((p) => (p.id === s.currentPlayerId ? { ...p, position: startPos } : p)),
        };
      }
    }
    throw new Error('not found');
  }

  it('落 chance(id 3) → 抽牌 + card_drawn 事件 + 转 managing', () => {
    // cell 0 走 3 步 → cell 3（机会）
    const s = makeStateForRoll(3, 0);
    const before = P(s).cash;
    const r = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
    if (!r.ok) throw new Error('fail');
    expect(P(r.state).position).toBe(3);
    const drawn = r.events.find((e) => e.type === 'card_drawn');
    expect(drawn).toBeDefined();
    expect((drawn as { deck: string }).deck).toBe('chance');
    expect(r.state.turnPhase).toBe('managing');
    // 卡的 effect 应用了（现金或状态变化）——至少不是崩溃
    void before;
  });

  it('落 destiny(id 15) → 抽命运牌', () => {
    // cell 13 走 2 步 → cell 15（命运）
    const s = makeStateForRoll(2, 13);
    const r = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
    if (!r.ok) throw new Error('fail');
    expect(P(r.state).position).toBe(15);
    const drawn = r.events.find((e) => e.type === 'card_drawn');
    expect(drawn).toBeDefined();
    expect((drawn as { deck: string }).deck).toBe('destiny');
  });

  it('抽牌后牌堆顶变化（抽顶放回堆底）', () => {
    const s = makeStateForRoll(3, 0);
    const beforeQueue = s.decks.chance.slice();
    const r = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
    if (!r.ok) throw new Error('fail');
    const afterQueue = r.state.decks.chance;
    expect(afterQueue.length).toBe(beforeQueue.length);
    // 顶牌被抽走，放回堆底
    const drawnId = (r.events.find((e) => e.type === 'card_drawn') as { cardId: string }).cardId;
    expect(beforeQueue[0]).toBe(drawnId);
    expect(afterQueue[afterQueue.length - 1]).toBe(drawnId);
  });
});

describe('真实 cards.json 全量 // 步8', () => {
  it('30 张卡逐张 applyCardEffect 不崩', () => {
    for (const card of chinaMap.game.cards.chance) {
      const s = makeStarted();
      const r = applyCardEffect(s, s.currentPlayerId, card, []);
      expect(r.state).toBeDefined();
      expect(r.events).toBeDefined();
    }
    for (const card of chinaMap.game.cards.destiny) {
      const s = makeStarted();
      const r = applyCardEffect(s, s.currentPlayerId, card, []);
      expect(r.state).toBeDefined();
      expect(r.events).toBeDefined();
    }
  });

  it('支线格 world effect 逐格执行不崩（核对表 A2）', () => {
    const worldCells = chinaMap.game.board.cells.filter((c) => c.type === 'world');
    for (const cell of worldCells) {
      const s = makeStarted();
      const effect = (cell as { effect: unknown }).effect as { type: string };
      const r = applyCardEffect(s, s.currentPlayerId, { id: `cell-${cell.id}`, effect: effect as never }, []);
      expect(r.state).toBeDefined();
    }
  });
});
