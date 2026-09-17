import { describe, it, expect } from 'vitest';
import { createGame, applyIntent } from '../engine';
import { getActiveMapPack } from '@richman/board-data';
import type { GameState } from '../types';

const chinaMap = getActiveMapPack('china-tour');

function makeAtBuildDecision(cellId: number, level = 0, mortgaged = false): GameState {
  const s = createGame({
    mapRef: chinaMap.ref,
    ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: chinaMap.game.config,
    players: [
      { id: 'p1', nickname: '甲' },
      { id: 'p2', nickname: '乙' },
    ],
    seed: 'build-test',
  });
  return {
    ...s,
    turnPhase: 'awaiting_build_decision',
    players: s.players.map((p) =>
      p.id === s.currentPlayerId ? { ...p, position: cellId } : p,
    ),
    properties: {
      ...s.properties,
      [cellId]: { ownerId: s.currentPlayerId, level, mortgaged },
    },
  };
}

const currentPlayer = (s: GameState) => s.players.find((p) => p.id === s.currentPlayerId)!;
const houseCost = (id: number) =>
  (chinaMap.game.board.cells.find((c) => c.id === id)! as { houseCost: number }).houseCost;

describe('build_house / skip_build (01 §6.3) // 步5', () => {
  it('build_house: 扣 houseCost、level+1、转 managing、house_built 事件', () => {
    const s = makeAtBuildDecision(2, 0); // 福建省 houseCost=1500
    const cost = houseCost(2);
    const before = currentPlayer(s).cash;
    const r = applyIntent(s, s.currentPlayerId, { type: 'build_house' });
    if (!r.ok) throw new Error('fail');
    expect(currentPlayer(r.state).cash).toBe(before - cost);
    expect(r.state.properties[2].level).toBe(1);
    expect(r.state.turnPhase).toBe('managing'); // E04 盖完转 managing
    const evt = r.events.find((e) => e.type === 'house_built')!;
    expect(evt).toMatchObject({ level: 1, amount: cost });
  });

  it('E04: 一次停留仅一幢——盖完进 managing，不可再 build_house', () => {
    const s = makeAtBuildDecision(2, 0);
    const r = applyIntent(s, s.currentPlayerId, { type: 'build_house' });
    if (!r.ok) throw new Error('fail');
    // 第二次 build_house 应 WRONG_PHASE（已在 managing）
    const r2 = applyIntent(r.state, s.currentPlayerId, { type: 'build_house' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('WRONG_PHASE');
  });

  it('E03: 满级（level=5 旅馆）不可再盖 → ILLEGAL_INTENT', () => {
    const s = makeAtBuildDecision(2, 5); // 已是旅馆
    const r = applyIntent(s, s.currentPlayerId, { type: 'build_house' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ILLEGAL_INTENT');
  });

  it('E05: 抵押中的自己地产不可盖 → ILLEGAL_INTENT（K8）', () => {
    const s = makeAtBuildDecision(2, 0, true); // 抵押中
    const r = applyIntent(s, s.currentPlayerId, { type: 'build_house' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ILLEGAL_INTENT');
  });

  it('第五次盖房 → 旅馆（level 4→5，house_built.level=5）', () => {
    const s = makeAtBuildDecision(2, 4); // 4 幢房
    const r = applyIntent(s, s.currentPlayerId, { type: 'build_house' });
    if (!r.ok) throw new Error('fail');
    expect(r.state.properties[2].level).toBe(5);
    const evt = r.events.find((e) => e.type === 'house_built')!;
    expect(evt).toMatchObject({ level: 5, amount: houseCost(2) });
  });

  it('车站不可盖房 → ILLEGAL_INTENT', () => {
    const s = makeAtBuildDecision(6, 0); // 广州站
    const r = applyIntent(s, s.currentPlayerId, { type: 'build_house' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ILLEGAL_INTENT');
  });

  it('特殊地皮（utility）不可盖房 → ILLEGAL_INTENT', () => {
    const s = makeAtBuildDecision(10, 0); // 中国大运河
    const r = applyIntent(s, s.currentPlayerId, { type: 'build_house' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ILLEGAL_INTENT');
  });

  it('现金不足 → INSUFFICIENT_FUNDS', () => {
    const cost = houseCost(2);
    const s = {
      ...makeAtBuildDecision(2, 0),
      players: makeAtBuildDecision(2, 0).players.map((p) =>
        p.id === makeAtBuildDecision(2, 0).currentPlayerId ? { ...p, cash: cost - 1 } : p,
      ),
    };
    const r = applyIntent(s, s.currentPlayerId, { type: 'build_house' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('skip_build: 转 managing，level 不变', () => {
    const s = makeAtBuildDecision(2, 0);
    const r = applyIntent(s, s.currentPlayerId, { type: 'skip_build' });
    if (!r.ok) throw new Error('fail');
    expect(r.state.properties[2].level).toBe(0);
    expect(r.state.turnPhase).toBe('managing');
  });
});
