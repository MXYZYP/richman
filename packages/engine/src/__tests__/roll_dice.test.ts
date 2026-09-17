import { describe, it, expect } from 'vitest';
import { createGame, applyIntent } from '../engine';
import { walkPath } from '../movement';
import { rollDice } from '../rng';
import { getActiveMapPack } from '@richman/board-data';
import type { GameState } from '../types';

const chinaMap = getActiveMapPack('china-tour');

function makeStarted(seed = 'roll-test'): GameState {
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
    seed,
  });
}

const currentPlayer = (s: GameState) =>
  s.players.find((p) => p.id === s.currentPlayerId)!;

/** 构造 state：其 seed 使首次 roll_dice 掷出指定点数和；当前玩家位置设为 startPos */
function makeStateForRoll(targetSum: number, startPos = 0): GameState {
  for (let i = 1; i < 100000; i++) {
    const [dice] = rollDice(i);
    if (dice[0] + dice[1] === targetSum) {
      const s = makeStarted();
      return {
        ...s,
        seed: String(i), // applyIntent 会 Number(seed)=i → rollDice(i) 得到预期 dice
        players: s.players.map((p) =>
          p.id === s.currentPlayerId ? { ...p, position: startPos } : p,
        ),
      };
    }
  }
  throw new Error(`找不到首次掷骰和=${targetSum} 的 state`);
}

describe('applyIntent: roll_dice (01 §4.1) // 步2', () => {
  it('awaiting_roll 阶段掷骰成功，turnPhase 推进、lastDice 设置', () => {
    const s = makeStarted();
    const r = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.lastDice).not.toBeNull();
    expect(r.state.turnPhase).not.toBe('awaiting_roll');
  });

  it('非当前玩家掷骰 → NOT_YOUR_TURN', () => {
    const s = makeStarted();
    const other = s.players.find((p) => p.id !== s.currentPlayerId)!;
    const r = applyIntent(s, other.id, { type: 'roll_dice' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('NOT_YOUR_TURN');
    }
  });

  it('非 awaiting_roll 阶段掷骰 → WRONG_PHASE', () => {
    const s = { ...makeStarted(), turnPhase: 'managing' as const };
    const r = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('WRONG_PHASE');
    }
  });

  it('棋子按骰点前进：position == walkPath(旧位置, 骰点和).finalCellId', () => {
    const s = makeStarted();
    const oldPos = currentPlayer(s).position;
    const r = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
    if (!r.ok) throw new Error('should succeed');
    const newPlayer = r.state.players.find((p) => p.id === s.currentPlayerId)!;
    const steps = r.state.lastDice![0] + r.state.lastDice![1];
    expect(newPlayer.position).toBe(walkPath(chinaMap.game.board, oldPos, steps).finalCellId);
  });

  it('事件流含 dice_rolled + token_moved（path 长度 = 骰点和）', () => {
    const s = makeStarted();
    const r = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
    if (!r.ok) throw new Error('fail');
    const types = r.events.map((e) => e.type);
    expect(types).toContain('dice_rolled');
    const moved = r.events.find((e) => e.type === 'token_moved')!;
    const steps = r.state.lastDice![0] + r.state.lastDice![1];
    expect((moved as { path: number[] }).path).toHaveLength(steps);
  });

  it('E01: 经过起点领 2000（salary_collected + 现金+2000）', () => {
    // 玩家 cell 50，走 4 步：50→51→0→1→2（越过起点，落 cell 2 无主地产不抽卡）
    const s = makeStateForRoll(4, 50);
    const before = currentPlayer(s).cash;
    const r = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
    if (!r.ok) throw new Error('fail');
    const after = r.state.players.find((p) => p.id === s.currentPlayerId)!.cash;
    expect(after - before).toBe(2000);
    expect(r.events.some((e) => e.type === 'salary_collected')).toBe(true);
  });

  it('不经过起点不领工资', () => {
    // 玩家在 cell 5，走 3 步：5→6→7→8（不经过起点）
    const s = makeStateForRoll(3, 5);
    const before = currentPlayer(s).cash;
    const r = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
    if (!r.ok) throw new Error('fail');
    const after = r.state.players.find((p) => p.id === s.currentPlayerId)!.cash;
    expect(after).toBe(before);
    expect(r.events.some((e) => e.type === 'salary_collected')).toBe(false);
  });

  it('落无主地产 → awaiting_buy_decision', () => {
    // 从 cell 0 走 2 步到 cell 2（福建省，开局无主）
    const s = makeStateForRoll(2, 0);
    const r = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
    if (!r.ok) throw new Error('fail');
    expect(currentPlayer(r.state).position).toBe(2);
    expect(r.state.turnPhase).toBe('awaiting_buy_decision');
  });

  it('落自己地产 → awaiting_build_decision', () => {
    const base = makeStateForRoll(2, 0);
    const s = {
      ...base,
      properties: {
        ...base.properties,
        2: { ...base.properties[2], ownerId: base.currentPlayerId },
      },
    };
    const r = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
    if (!r.ok) throw new Error('fail');
    expect(r.state.turnPhase).toBe('awaiting_build_decision');
  });

  it('落自己车站（广州站）→ managing（不可进入盖房决策）', () => {
    const base = makeStateForRoll(6, 0);
    const s = {
      ...base,
      properties: {
        ...base.properties,
        6: { ...base.properties[6], ownerId: base.currentPlayerId },
      },
    };
    const beforeCash = currentPlayer(s).cash;
    const r = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
    if (!r.ok) throw new Error('fail');
    expect(currentPlayer(r.state).position).toBe(6);
    expect(r.state.turnPhase).toBe('managing');
    expect(currentPlayer(r.state).cash).toBe(beforeCash);
    expect(r.events.some((e) => e.type === 'rent_paid')).toBe(false);
  });

  it('落自己特殊地皮（中国大运河）→ managing（不可进入盖房决策）', () => {
    const base = makeStateForRoll(10, 0);
    const s = {
      ...base,
      properties: {
        ...base.properties,
        10: { ...base.properties[10], ownerId: base.currentPlayerId },
      },
    };
    const beforeCash = currentPlayer(s).cash;
    const r = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
    if (!r.ok) throw new Error('fail');
    expect(currentPlayer(r.state).position).toBe(10);
    expect(r.state.turnPhase).toBe('managing');
    expect(currentPlayer(r.state).cash).toBe(beforeCash);
    expect(r.events.some((e) => e.type === 'rent_paid')).toBe(false);
  });

  it('落他人地产 → managing（过路费步4实现）', () => {
    const base = makeStateForRoll(2, 0);
    const otherId = base.players.find((p) => p.id !== base.currentPlayerId)!.id;
    const s = {
      ...base,
      properties: {
        ...base.properties,
        2: { ...base.properties[2], ownerId: otherId },
      },
    };
    const r = applyIntent(s, s.currentPlayerId, { type: 'roll_dice' });
    if (!r.ok) throw new Error('fail');
    expect(r.state.turnPhase).toBe('managing');
  });

  it('seed 确定性：同 seed 两次掷骰结果全等', () => {
    const s1 = makeStarted('det-1');
    const s2 = makeStarted('det-1');
    const r1 = applyIntent(s1, s1.currentPlayerId, { type: 'roll_dice' });
    const r2 = applyIntent(s2, s2.currentPlayerId, { type: 'roll_dice' });
    if (!r1.ok || !r2.ok) throw new Error('fail');
    expect(r1.state.lastDice).toEqual(r2.state.lastDice);
    expect(r1.state.players).toEqual(r2.state.players);
  });
});
