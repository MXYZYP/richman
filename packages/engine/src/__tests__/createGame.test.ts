import { describe, it, expect } from 'vitest';
import { createGame } from '../engine';
import { getActiveMapPack, type BoardData, type CardsData, type GameConfig } from '@richman/board-data';
import type { GameState } from '../types';

const chinaMap = getActiveMapPack('china-tour');

function assertSnapshotIsDeepReadonly(state: GameState): void {
  const property = state.board.cells.find((cell) => cell.type === 'property');
  if (property?.type !== 'property' || property.rents === undefined) return;
  // @ts-expect-error GameState 棋盘快照的嵌套数组不可写
  property.rents[0] = 1;
  // @ts-expect-error GameState 配置快照的普通数组不可写
  state.config.cashGoalPresets[0] = 1;
  // @ts-expect-error GameState 配置快照的 tuple 不可写
  state.config.utilityMultipliers[0] = 1;
}

void assertSnapshotIsDeepReadonly;

function assertCreateGameRequiresExactIdentity(): void {
  // @ts-expect-error Phase 5 起创建新游戏必须显式提供 exact mapRef 和 ruleModules
  createGame({
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: chinaMap.game.config,
    players: [{ id: 'p1', nickname: '甲' }, { id: 'p2', nickname: '乙' }],
    seed: 'missing-exact-identity',
  });
}

void assertCreateGameRequiresExactIdentity;

// 辅助：创建一局 3 人游戏
function makeGame(
  seed = 'test-seed-1',
  overrides: Partial<Parameters<typeof createGame>[0]> = {},
) {
  return createGame({
    mapRef: chinaMap.ref,
    ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: chinaMap.game.config,
    players: [
      { id: 'p1', nickname: '甲' },
      { id: 'p2', nickname: '乙' },
      { id: 'p3', nickname: '丙' },
    ],
    seed,
    ...overrides,
  });
}

describe('createGame (01 §3) // 步1', () => {
  it('每人初始资金 = config.initialCash (15000)', () => {
    const s = makeGame();
    for (const p of s.players) {
      expect(p.cash).toBe(15000);
    }
  });

  it('所有玩家棋子在起点 (cell 0)', () => {
    const s = makeGame();
    for (const p of s.players) {
      expect(p.position).toBe(0);
    }
  });

  it('phase=playing, turnPhase=awaiting_roll, turn=1', () => {
    const s = makeGame();
    expect(s.phase).toBe('playing');
    expect(s.turnPhase).toBe('awaiting_roll');
    expect(s.turn).toBe(1);
  });

  it('所有地产初始无主、level=0、未抵押', () => {
    const s = makeGame();
    const propertyCells = chinaMap.game.board.cells.filter((c) => c.type === 'property');
    expect(Object.keys(s.properties).length).toBe(propertyCells.length);
    for (const cell of propertyCells) {
      const ps = s.properties[cell.id];
      expect(ps.ownerId).toBeNull();
      expect(ps.level).toBe(0);
      expect(ps.mortgaged).toBe(false);
    }
  });

  it('牌堆已洗乱且包含全部卡 id（无丢失）', () => {
    const s = makeGame();
    expect(s.decks.chance).toHaveLength(chinaMap.game.cards.chance.length);
    expect(s.decks.destiny).toHaveLength(chinaMap.game.cards.destiny.length);
    const chanceIds = new Set(s.decks.chance);
    for (const c of chinaMap.game.cards.chance) expect(chanceIds.has(c.id)).toBe(true);
    const destinyIds = new Set(s.decks.destiny);
    for (const c of chinaMap.game.cards.destiny) expect(destinyIds.has(c.id)).toBe(true);
  });

  it('同 seed 两次 createGame 结果完全相等（确定性，03 §4）', () => {
    const s1 = makeGame('deterministic-42');
    const s2 = makeGame('deterministic-42');
    expect(s1).toEqual(s2);
  });

  it('显式写入 exact map/module identity，并与调用方后续 mutation 隔离', () => {
    const mapRef = {
      id: 'test-harbor-loop',
      version: 2,
      contentHash: 'a'.repeat(64),
    };
    const ruleModules = [
      { id: 'core', version: 1 },
      { id: 'harbor-rules', version: 3 },
    ];
    const state = makeGame('explicit-identity', { mapRef, ruleModules });

    expect(state.mapRef).toEqual(mapRef);
    expect(state.ruleModules).toEqual(ruleModules);
    expect(state.mapRef).not.toBe(mapRef);
    expect(state.ruleModules).not.toBe(ruleModules);
    expect(state.ruleModules[0]).not.toBe(ruleModules[0]);

    mapRef.id = 'mutated-map';
    ruleModules[0]!.id = 'mutated-module';
    ruleModules.push({ id: 'late-module', version: 1 });

    expect(state.mapRef.id).toBe('test-harbor-loop');
    expect(state.ruleModules).toEqual([
      { id: 'core', version: 1 },
      { id: 'harbor-rules', version: 3 },
    ]);
    expect(Object.isFrozen(state.mapRef)).toBe(true);
    expect(Object.isFrozen(state.ruleModules)).toBe(true);
    expect(Object.isFrozen(state.ruleModules[0])).toBe(true);
  });

  it('递归复制并冻结 board/cards/config，不受调用方后续 mutation 影响', () => {
    const board = structuredClone(chinaMap.game.board) as BoardData;
    const cards = structuredClone(chinaMap.game.cards) as CardsData;
    const config = structuredClone(chinaMap.game.config) as GameConfig;
    const state = makeGame('immutable-game-snapshot', { board, cards, config });
    const property = board.cells.find((cell) => cell.type === 'property' && cell.rents !== undefined)!;
    const originalBoardName = state.board.boardName;
    const stateProperty = state.board.cells.find((cell) => cell.id === property.id);
    if (stateProperty?.type !== 'property') throw new Error('property snapshot missing');
    const originalRent = stateProperty.rents![0];
    const originalCardText = state.cards.chance[0]!.text;
    const originalCashGoal = state.config.cashGoalPresets[0];

    board.boardName = 'mutated board';
    if (property.type === 'property') property.rents![0] = 999_999;
    cards.chance[0]!.text = 'mutated card';
    config.cashGoalPresets[0] = 999_999;

    expect(state.board.boardName).toBe(originalBoardName);
    const frozenProperty = state.board.cells.find((cell) => cell.id === property.id);
    if (frozenProperty?.type !== 'property') throw new Error('property snapshot missing');
    expect(frozenProperty.rents![0]).toBe(originalRent);
    expect(state.cards.chance[0]!.text).toBe(originalCardText);
    expect(state.config.cashGoalPresets[0]).toBe(originalCashGoal);
    expect(state.board).not.toBe(board);
    expect(state.cards).not.toBe(cards);
    expect(state.config).not.toBe(config);
    expect(Object.isFrozen(state.board)).toBe(true);
    expect(Object.isFrozen(state.board.cells)).toBe(true);
    expect(Object.isFrozen(state.board.cells[0])).toBe(true);
    expect(Object.isFrozen(frozenProperty.rents)).toBe(true);
    expect(Object.isFrozen(state.cards)).toBe(true);
    expect(Object.isFrozen(state.cards.chance)).toBe(true);
    expect(Object.isFrozen(state.cards.chance[0]!.effect)).toBe(true);
    expect(Object.isFrozen(state.config)).toBe(true);
    expect(Object.isFrozen(state.config.utilityMultipliers)).toBe(true);
    expect(Object.isFrozen(state.config.cashGoalPresets)).toBe(true);
  });

  it('显式写入 registry 提供的 china-tour exact identity', () => {
    const state = makeGame('registry-exact-identity');

    expect(state.mapRef).toEqual(chinaMap.ref);
    expect(state.ruleModules).toEqual(chinaMap.game.requiredRuleModules);
  });

  it('identity 输入不参与随机序列，不改变同 seed 的座次、牌堆或 RNG state', () => {
    const defaults = makeGame('identity-does-not-affect-rng');
    const explicit = makeGame('identity-does-not-affect-rng', {
      mapRef: { id: 'other-map', version: 7, contentHash: 'b'.repeat(64) },
      ruleModules: [{ id: 'other-rules', version: 4 }],
    });

    expect(explicit.seed).toBe(defaults.seed);
    expect(explicit.currentPlayerId).toBe(defaults.currentPlayerId);
    expect(explicit.players).toEqual(defaults.players);
    expect(explicit.decks).toEqual(defaults.decks);
  });

  it('不同 seed 产生不同状态（洗牌/定序不同）', () => {
    const s1 = makeGame('seed-A');
    const s2 = makeGame('seed-B');
    expect(JSON.stringify(s1)).not.toEqual(JSON.stringify(s2));
  });

  it('cashGoal 传入则记录，不传则 null', () => {
    expect(makeGame('g1', { cashGoal: 30000 }).cashGoal).toBe(30000);
    expect(makeGame('g2').cashGoal).toBeNull();
  });

  it('cashGoal <= initialCash 抛错（自定目标必须大于初始资金，01 §12）', () => {
    expect(() => makeGame('g-eq', { cashGoal: chinaMap.game.config.initialCash })).toThrow();
    expect(() => makeGame('g-less', { cashGoal: chinaMap.game.config.initialCash - 1 })).toThrow();
  });

  it('cashGoal > initialCash 正常创建', () => {
    expect(() => makeGame('g-ok', { cashGoal: chinaMap.game.config.initialCash + 1 })).not.toThrow();
    expect(makeGame('g-ok2', { cashGoal: chinaMap.game.config.initialCash + 1 }).cashGoal).toBe(chinaMap.game.config.initialCash + 1);
  });

  it('recentLog 含 game_started 事件', () => {
    const s = makeGame();
    expect(s.recentLog.some((e) => e.type === 'game_started')).toBe(true);
  });

  it('玩家颜色按座次分配（红蓝黄绿，02 §4.2）', () => {
    const s = makeGame();
    expect(s.players[0].color).toBe('red');
    expect(s.players[1].color).toBe('blue');
    expect(s.players[2].color).toBe('yellow');
  });

  it('isBot 标识正确（真人 false / 电脑 true）', () => {
    const s = makeGame('bot-test', {
      players: [
        { id: 'h', nickname: '真人' },
        { id: 'b1', nickname: '电脑A', isBot: true },
      ],
    });
    // 定序会重排数组顺序，按 id 查找而非索引
    const human = s.players.find((p) => p.id === 'h')!;
    const bot = s.players.find((p) => p.id === 'b1')!;
    expect(human.isBot).toBe(false);
    expect(bot.isBot).toBe(true);
  });

  it('玩家数 <2 或 >6 抛错（上限 6，安全门保留）', () => {
    expect(() => makeGame('x', { players: [{ id: 'a', nickname: 'A' }] })).toThrow();
    expect(() =>
      makeGame('y', {
        players: [1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: `p${i}`, nickname: `P${i}` })),
      }),
    ).toThrow();
  });

  it('定序确定：currentPlayerId 在同 seed 下稳定', () => {
    const s1 = makeGame('order-stable');
    const s2 = makeGame('order-stable');
    expect(s1.currentPlayerId).toBe(s2.currentPlayerId);
  });

  it('所有玩家初始无破产、online=true、skipTurns=0、lastDice=null', () => {
    const s = makeGame();
    for (const p of s.players) {
      expect(p.bankrupt).toBe(false);
      expect(p.online).toBe(true);
      expect(p.skipTurns).toBe(0);
    }
    expect(s.lastDice).toBeNull();
    expect(s.debt).toBeNull();
    expect(s.winnerId).toBeNull();
  });
});
