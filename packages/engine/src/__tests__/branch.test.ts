import { describe, it, expect } from 'vitest';
import { createGame, applyIntent } from '../engine';
import { walkPath } from '../movement';
import { rollDice, rollSingleDice } from '../rng';
import { getActiveMapPack } from '@richman/board-data';
import type { GameEvent, GameState } from '../types';

const chinaMap = getActiveMapPack('china-tour');

function makeStarted(): GameState {
  return createGame({
    mapRef: chinaMap.ref,
    ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: chinaMap.game.config,
    players: [
      { id: 'p1', nickname: '甲' },
      { id: 'p2', nickname: '乙' },
    ],
    seed: 'branch-test',
  });
}

const P = (s: GameState) => s.players.find((p) => p.id === s.currentPlayerId)!;

const isDiceRolled = (event: GameEvent): event is Extract<GameEvent, { type: 'dice_rolled' }> => event.type === 'dice_rolled';
const isTokenMoved = (event: GameEvent): event is Extract<GameEvent, { type: 'token_moved' }> => event.type === 'token_moved';

function rollToAirportThenBranch(s: GameState) {
  const first = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
  if (!first.ok) throw new Error('first fail');
  return applyIntent(first.state, first.state.currentPlayerId, { type: 'roll_airport_branch' });
}

/** 找 seed 使玩家从 cell 11 掷骰(和=2)停机场 13，且支线骰点使初次落点= target */
function findBranchFirstLanding(targetFirstCellId: number): GameState {
  for (let i = 1; i < 100000; i++) {
    const [dice1, s1] = rollDice(i);
    if (dice1[0] + dice1[1] !== 2) continue;
    const [d] = rollSingleDice(s1);
    if (walkPath(chinaMap.game.board, 52, d - 1).finalCellId === targetFirstCellId) {
      const base = makeStarted();
      return {
        ...base,
        seed: String(i),
        players: base.players.map((p) => (p.id === base.currentPlayerId ? { ...p, position: 11 } : p)),
      };
    }
  }
  throw new Error('not found');
}

/** 任意停机场场景（不指定支线落点） */
function makeStoppedAtAirport(): GameState {
  for (let i = 1; i < 100000; i++) {
    const [dice1] = rollDice(i);
    if (dice1[0] + dice1[1] === 2) {
      const base = makeStarted();
      return {
        ...base,
        seed: String(i),
        players: base.players.map((p) => (p.id === base.currentPlayerId ? { ...p, position: 11 } : p)),
      };
    }
  }
  throw new Error('not found');
}

describe('E22: 机场支线（一颗骰子，首尔为第1步）01 §5.1', () => {
  it('停机场后停在机场并等待玩家再掷一颗骰子', () => {
    const s = makeStoppedAtAirport();
    const r = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
    if (!r.ok) throw new Error('fail');

    const diceEvents = r.events.filter(isDiceRolled);
    const moves = r.events.filter(isTokenMoved);
    expect(diceEvents).toHaveLength(1);
    expect(diceEvents[0].dice).toHaveLength(2);
    expect(moves).toHaveLength(1);
    expect(P(r.state).position).toBe(13);
    expect(r.state.turnPhase).toBe('awaiting_airport_roll');
  });

  it('非机场等待阶段不能掷机场支线骰', () => {
    const s = makeStarted();
    const r = applyIntent(s, s.currentPlayerId, { type: 'roll_airport_branch' });
    expect(r.ok).toBe(false);
  });

  it('机场等待阶段再掷一颗骰子后进入支线', () => {
    const s = makeStoppedAtAirport();
    const r = rollToAirportThenBranch(s);
    if (!r.ok) throw new Error('fail');

    const diceEvents = r.events.filter(isDiceRolled);
    expect(diceEvents).toHaveLength(1);
    expect(diceEvents[0].dice).toHaveLength(1);

    const moves = r.events.filter(isTokenMoved);
    expect(moves.length).toBeGreaterThanOrEqual(1);
    expect(moves[0].path[0]).toBe(52);
  });

  it('掷 1 → 支线路径=[52]（停首尔），首尔效果退回起点 → 最终 position=0', () => {
    const s = findBranchFirstLanding(52);
    const r = rollToAirportThenBranch(s);
    if (!r.ok) throw new Error('fail');
    const branchMove = r.events.filter(isTokenMoved)[0];
    expect(branchMove.path).toEqual([52]);
    expect(P(r.state).position).toBe(0); // 首尔 effect: move_to 0, collectSalary=false
  });

  it('掷 6 → 支线路径=[52,53,54,55,56,57]（到巴黎）', () => {
    const s = findBranchFirstLanding(57);
    const r = rollToAirportThenBranch(s);
    if (!r.ok) throw new Error('fail');
    const branchMove = r.events.filter(isTokenMoved)[0];
    expect(branchMove.path).toEqual([52, 53, 54, 55, 56, 57]);
  });

  it('一掷初次落点范围 52-57（首尔到巴黎，曼谷/河内不可达）', () => {
    for (let target = 52; target <= 57; target++) {
      const s = findBranchFirstLanding(target);
      const r = rollToAirportThenBranch(s);
      if (!r.ok) throw new Error('fail');
      const branchMove = r.events.filter(isTokenMoved)[0];
      expect(branchMove.path[branchMove.path.length - 1]).toBe(target);
    }
  });

  it('仅停留触发：经过机场(13)不触发支线', () => {
    for (let i = 1; i < 100000; i++) {
      const [dice1] = rollDice(i);
      if (dice1[0] + dice1[1] !== 5) continue;
      const base = makeStarted();
      const s = {
        ...base,
        seed: String(i),
        players: base.players.map((p) => (p.id === base.currentPlayerId ? { ...p, position: 10 } : p)),
      };
      const r = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
      if (!r.ok) throw new Error('fail');
      expect(r.events.filter(isDiceRolled)).toHaveLength(1);
      return;
    }
    throw new Error('not found');
  });

  it('事件顺序拆为两次玩家操作：普通掷骰先停机场，机场掷骰再进支线', () => {
    const s = makeStoppedAtAirport();
    const first = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
    if (!first.ok) throw new Error('first fail');
    expect(first.events.map((event) => event.type)).toEqual(['dice_rolled', 'token_moved']);

    const second = applyIntent(first.state, first.state.currentPlayerId, { type: 'roll_airport_branch' });
    if (!second.ok) throw new Error('second fail');
    expect(second.events[0].type).toBe('dice_rolled');
    expect(second.events[1].type).toBe('token_moved');
  });
});
