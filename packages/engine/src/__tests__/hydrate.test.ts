import { describe, expect, it } from 'vitest';
import { getActiveMapPack, worldTourMap } from '@richman/board-data';
import { applyIntent, createGame } from '../engine';
import { chooseBotIntent } from '../bot';
import { hydrateGameState, resolveOverriddenGameConfig } from '../hydrate';

const chinaMap = getActiveMapPack('china-tour');

function validState() {
  return createGame({
    mapRef: chinaMap.ref,
    ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: chinaMap.game.config,
    players: [
      { id: 'p1', nickname: '甲' },
      { id: 'p2', nickname: '乙', isBot: true },
    ],
    seed: 'hydrate-valid',
  });
}

function corrupted(mutator: (state: any) => void): unknown {
  const state = structuredClone(validState());
  mutator(state);
  return state;
}

function validWorldState() {
  return createGame({
    mapRef: worldTourMap.ref,
    ruleModules: worldTourMap.game.requiredRuleModules,
    board: worldTourMap.game.board,
    cards: worldTourMap.game.cards,
    config: worldTourMap.game.config,
    players: [
      { id: 'p1', nickname: '甲' },
      { id: 'p2', nickname: '乙' },
    ],
    seed: 'hydrate-world-tour',
  });
}

function worldAirportWaitState(): any {
  const state = structuredClone(validWorldState()) as any;
  const playerId = state.currentPlayerId;
  state.players.find((player: any) => player.id === playerId).position = 10;
    state.publicRuleState = {
    modules: {
      'world-tour@1': {
        pendingAirportByPlayerId: { [playerId]: 10 },
        branchAirportByPlayerId: {},
        tollImmunityPlayerIds: [],
      },
    },
    pendingActions: [{
      optionId: `world-tour@1:airport-entry:${playerId}:10:${state.turn}`,
      module: { id: 'world-tour', version: 1 },
      playerId,
      requiredPhase: 'awaiting_roll',
      label: '掷骰子',
      action: 'enter-airport-branch',
      payload: {
        optionId: `world-tour@1:airport-entry:${playerId}:10:${state.turn}`,
        airportCellId: 10,
      },
    }],
  };
  return state;
}

// 房主自定义规则的对局（#4）：state.config 与地图默认值不同。
// 这类对局单机存档、联机房间快照都要能恢复，因此 hydrate 必须支持「按本局生效的 config」校验。
describe('hydrateGameState 的 config 覆盖（房主自定义规则）', () => {
  const baseConfig = chinaMap.game.config;

  function customizedState(overrides: Partial<typeof baseConfig>): any {
    return createGame({
      mapRef: chinaMap.ref,
      ruleModules: chinaMap.game.requiredRuleModules,
      board: chinaMap.game.board,
      cards: chinaMap.game.cards,
      config: { ...baseConfig, ...overrides },
      players: [
        { id: 'p1', nickname: '甲' },
        { id: 'p2', nickname: '乙', isBot: true },
      ],
      seed: 'hydrate-custom-rule',
    });
  }

  it('不传 override 时，自定义规则的状态仍按旧行为被拒（默认路径完全不变）', () => {
    const state = customizedState({ initialCash: baseConfig.initialCash + 5000 });

    expect(hydrateGameState(state, chinaMap)).toMatchObject({ ok: false });
  });

  it('传入生效 config 后可以恢复，且写回的就是自定义那份', () => {
    const state = customizedState({
      initialCash: baseConfig.initialCash + 5000,
      maxHouseLevel: 3,
      mortgageInterestRate: 0.2,
    });
    const override = resolveOverriddenGameConfig(state.config, chinaMap);

    const result = hydrateGameState(state, chinaMap, override ?? undefined);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.config.initialCash).toBe(baseConfig.initialCash + 5000);
    expect(result.state.config.maxHouseLevel).toBe(3);
    expect(result.state.config.mortgageInterestRate).toBe(0.2);
    expect(Object.isFrozen(result.state.config)).toBe(true);
    // 必须写回 override：写回地图默认值会让调用方拿到的对局悄悄退回默认规则。
    expect(result.state.config).toBe(override);
  });

  it.each<[string, Record<string, unknown>]>([
    ['初始资金为零', { initialCash: 0 }],
    ['初始资金为负数', { initialCash: -1 }],
    ['房级上限超过地图档位', { maxHouseLevel: chinaMap.game.config.maxHouseLevel + 1 }],
    ['房级上限为零', { maxHouseLevel: 0 }],
    ['抵押利率超过 100%', { mortgageInterestRate: 1.5 }],
    ['改动了结构性字段（骰子模式）', { diceMode: 'one_die' }],
    ['改动了结构性字段（监狱开关）', { jailEnabled: true }],
    ['改动了结构性字段（水电倍率）', { utilityMultipliers: [1, 2] }],
  ])('不可信的 config 一律不认：%s', (_label, overrides) => {
    expect(resolveOverriddenGameConfig({ ...baseConfig, ...overrides }, chinaMap)).toBeNull();
  });

  it('自定义房级上限收紧后，超出该上限的产权状态被拒（房级也按生效 config 校验）', () => {
    const state = customizedState({ maxHouseLevel: 2 }) as any;
    const propertyCell = chinaMap.game.board.cells.find(
      (cell) => cell.type === 'property' && cell.subtype === 'normal',
    );
    if (propertyCell === undefined) throw new Error('test map has no normal property');
    state.properties[propertyCell.id] = { ownerId: state.players[0].id, level: 3, mortgaged: false };
    const override = resolveOverriddenGameConfig(state.config, chinaMap);

    expect(hydrateGameState(state, chinaMap, override ?? undefined)).toMatchObject({ ok: false });
  });
});

describe('hydrateGameState', () => {
  it('仅在 exact map、module 和 immutable game data 全部一致时返回 GameState', () => {
    const source = structuredClone(validState());
    const result = hydrateGameState(source, chinaMap);

    expect(result).toEqual({ ok: true, state: source });
    if (!result.ok) return;
    expect(result.state).not.toBe(source);
    expect(Object.isFrozen(result.state.board)).toBe(true);
    expect(Object.isFrozen(result.state.cards)).toBe(true);
    expect(Object.isFrozen(result.state.config)).toBe(true);
  });

  it.each([
    ['map hash', (state: any) => { state.mapRef.contentHash = '0'.repeat(64); }],
    ['rule modules', (state: any) => { state.ruleModules = []; }],
    ['board snapshot', (state: any) => { state.board.boardName = 'tampered'; }],
    ['cards snapshot', (state: any) => { state.cards.chance[0].text = 'tampered'; }],
    ['config snapshot', (state: any) => { state.config.initialCash += 1; }],
  ])('拒绝不匹配的 exact %s', (_label, mutate) => {
    expect(hydrateGameState(corrupted(mutate), chinaMap)).toMatchObject({ ok: false });
  });

  it.each([
    ['缺少玩家', (state: any) => { state.players = []; }],
    ['重复玩家 ID', (state: any) => { state.players[1].id = state.players[0].id; }],
    ['非法颜色', (state: any) => { state.players[0].color = 'pink'; }],
    ['负现金', (state: any) => { state.players[0].cash = -1; }],
    ['非法位置', (state: any) => { state.players[0].position = 99999; }],
    ['产权 owner 不存在', (state: any) => { state.properties[1].ownerId = 'missing'; }],
    ['产权 key 不是地产', (state: any) => { state.properties[0] = { ownerId: null, level: 0, mortgaged: false }; }],
    ['无主地产有房屋', (state: any) => { state.properties[1] = { ownerId: null, level: 1, mortgaged: false }; }],
    ['无主地产被抵押', (state: any) => { state.properties[1] = { ownerId: null, level: 0, mortgaged: true }; }],
    ['车站有房屋', (state: any) => {
      const station = chinaMap.game.board.cells.find((cell) => cell.type === 'property' && cell.subtype === 'station');
      if (station === undefined) throw new Error('test map has no station');
      state.properties[station.id] = { ownerId: state.players[0].id, level: 1, mortgaged: false };
    }],
    ['水电有房屋', (state: any) => {
      const utility = chinaMap.game.board.cells.find((cell) => cell.type === 'property' && cell.subtype === 'utility');
      if (utility === undefined) throw new Error('test map has no utility');
      state.properties[utility.id] = { ownerId: state.players[0].id, level: 1, mortgaged: false };
    }],
    ['牌堆张数错误', (state: any) => { state.decks.chance.pop(); }],
    ['当前玩家不存在', (state: any) => { state.currentPlayerId = 'missing'; }],
    ['赢家不存在', (state: any) => { state.phase = 'game_over'; state.winnerId = 'missing'; }],
    ['债务玩家不存在', (state: any) => { state.debt = { debtorId: 'missing', creditorId: null, amount: 1 }; }],
    ['排队付款引用不存在', (state: any) => {
      state.debt = { debtorId: state.players[0].id, creditorId: null, amount: 1, resume: {
        payments: [{ debtorId: state.players[0].id, creditorId: 'missing', amount: 1 }],
      } };
    }],
    ['非法 turnPhase', (state: any) => { state.turnPhase = 'unknown'; }],
    ['非法骰子', (state: any) => { state.lastDice = [0, 7]; }],
    ['非法 recentLog 引用', (state: any) => { state.recentLog = [{ type: 'turn_started', playerId: 'missing' }]; }],
    ['house_built 缺 amount（旧3键）', (state: any) => {
      state.recentLog = [{ type: 'house_built', cellId: 2, level: 1 }];
    }],
    ['house_built amount 为负数', (state: any) => {
      state.recentLog = [{ type: 'house_built', cellId: 2, level: 1, amount: -1 }];
    }],
    ['house_built amount 非有限数(NaN)', (state: any) => {
      state.recentLog = [{ type: 'house_built', cellId: 2, level: 1, amount: NaN }];
    }],
  ])('拒绝运行时损坏：%s', (_label, mutate) => {
    expect(hydrateGameState(corrupted(mutate), chinaMap)).toMatchObject({ ok: false });
  });
  it('接受含 4 键 house_built（含 amount）的 recentLog', () => {
    const state = corrupted((s: any) => {
      s.recentLog = [{ type: 'house_built', cellId: 2, level: 1, amount: 1500 }];
    });
    expect(hydrateGameState(state, chinaMap)).toMatchObject({ ok: true });
  });

  it.each([
    ['超长数值', '9'.repeat(400)],
    ['前导零', '01'],
    ['负零', '-0'],
    ['超过 int32 上界', '2147483648'],
    ['低于 int32 下界', '-2147483649'],
  ])('拒绝非规范 RNG state：%s', (_label, seed) => {
    expect(hydrateGameState(corrupted((state) => { state.seed = seed; }), chinaMap)).toMatchObject({ ok: false });
  });

  it.each(['0', '2147483647', '-2147483648'])('接受 engine RNG state 边界 %s', (seed) => {
    expect(hydrateGameState(corrupted((state) => { state.seed = seed; }), chinaMap)).toMatchObject({ ok: true });
  });

  it.each([
    ['playing 当前玩家已破产', (state: any) => {
      state.players[0].bankrupt = true;
      state.players[0].bankruptTurn = 1;
    }],
    ['等待机场骰但当前玩家不在机场', (state: any) => { state.turnPhase = 'awaiting_airport_roll'; }],
    ['债务人已经破产', (state: any) => {
      state.players[1].bankrupt = true;
      state.players[1].bankruptTurn = 1;
      state.debt = { debtorId: state.players[1].id, creditorId: null, amount: 1 };
      state.turnPhase = 'managing';
    }],
    ['终局仍有未清债务', (state: any) => {
      state.phase = 'game_over';
      state.winnerId = state.players[1].id;
      state.debt = { debtorId: state.players[0].id, creditorId: null, amount: 1 };
      state.turnPhase = 'managing';
    }],
    ['终局赢家已经破产', (state: any) => {
      state.phase = 'game_over';
      state.winnerId = state.players[1].id;
      state.players[1].bankrupt = true;
      state.players[1].bankruptTurn = 1;
    }],
  ])('拒绝不可达运行状态：%s', (_label, mutate) => {
    expect(hydrateGameState(corrupted(mutate), chinaMap)).toMatchObject({ ok: false });
  });

  it('接受真实 engine 连续产生的中局、债务与终局状态', () => {
    let state = createGame({
      mapRef: chinaMap.ref,
      ruleModules: chinaMap.game.requiredRuleModules,
      board: chinaMap.game.board,
      cards: chinaMap.game.cards,
      config: chinaMap.game.config,
      players: [
        { id: 'b1', nickname: '电脑一', isBot: true },
        { id: 'b2', nickname: '电脑二', isBot: true },
        { id: 'b3', nickname: '电脑三', isBot: true },
      ],
      seed: 'hydrate-engine-trace',
      cashGoal: 30_000,
    });

    for (let step = 0; step < 3_000; step += 1) {
      const hydrated = hydrateGameState(structuredClone(state), chinaMap);
      expect(hydrated, `step ${step}`).toMatchObject({ ok: true });
      if (state.phase === 'game_over') return;
      const actorId = state.debt?.debtorId ?? state.currentPlayerId;
      const result = applyIntent(state, actorId, chooseBotIntent(state, actorId));
      if (!result.ok) throw new Error(`illegal engine trace at ${step}: ${result.code}`);
      state = result.state;
    }
    throw new Error('engine trace did not finish');
  });

  it('接受一致的世界之旅机场等待公开状态与待选动作', () => {
    expect(hydrateGameState(worldAirportWaitState(), worldTourMap)).toMatchObject({ ok: true });
  });

  it.each([
    ['unknown module key', (state: any) => { state.publicRuleState.modules['unknown@1'] = {}; }],
    ['non-JSON module payload', (state: any) => {
      state.publicRuleState.modules['world-tour@1'].extra = undefined;
    }],
    ['wrong pending player', (state: any) => {
      state.publicRuleState.pendingActions[0].playerId = 'missing';
    }],
    ['wrong pending phase', (state: any) => {
      state.publicRuleState.pendingActions[0].requiredPhase = 'managing';
    }],
    ['duplicate option identity', (state: any) => {
      state.publicRuleState.pendingActions.push(structuredClone(state.publicRuleState.pendingActions[0]));
    }],
    ['inconsistent airport position', (state: any) => {
      const playerId = state.currentPlayerId;
      state.players.find((player: any) => player.id === playerId).position = 11;
    }],
    ['stale branch membership', (state: any) => {
      const playerId = state.currentPlayerId;
      state.publicRuleState.modules['world-tour@1'].pendingAirportByPlayerId = {};
      state.publicRuleState.modules['world-tour@1'].branchAirportByPlayerId = { [playerId]: 10 };
      state.publicRuleState.pendingActions = [];
      state.players.find((player: any) => player.id === playerId).position = 31;
    }],
    ['invalid pending airport option', (state: any) => {
      state.publicRuleState.pendingActions[0].payload.airportCellId = 9;
    }],
  ])('拒绝世界之旅损坏状态：%s', (_label, mutate) => {
    const state = worldAirportWaitState();
    mutate(state);
    expect(hydrateGameState(state, worldTourMap)).toMatchObject({ ok: false });
  });
});

describe('hydrateGameState · 单机真人待确认卡牌', () => {
  interface CardChoiceFixture {
    currentPlayerId: string;
    turnPhase: string;
    phase: string;
    winnerId: string | null;
    cardChoice: {
      mode: string;
      pending: { playerId: string; deck: string; cardId: string; resumeTurnPhase: string; extra?: boolean } | null;
    };
    players: { id: string; position: number; isBot: boolean; bankrupt: boolean; bankruptTurn: number | null }[];
    decks: { chance: string[]; destiny: string[] };
  }

  function pausedCardState(): CardChoiceFixture {
    const created = structuredClone(createGame({
      mapRef: chinaMap.ref,
      ruleModules: chinaMap.game.requiredRuleModules,
      board: chinaMap.game.board,
      cards: chinaMap.game.cards,
      config: chinaMap.game.config,
      players: [
        { id: 'p1', nickname: '甲' },
        { id: 'p2', nickname: '乙', isBot: true },
      ],
      seed: 'hydrate-card-choice',
      cardChoiceMode: 'local-human',
    }));
    // GameState 的字段是 readonly；测试fixture只需要可变的结构视图，不改变真实取值。
    const state = created as unknown as CardChoiceFixture;
    const chanceCell = chinaMap.game.board.cells.find((cell) => cell.type === 'chance')!;
    state.currentPlayerId = 'p1';
    state.turnPhase = 'managing';
    state.players.find((player) => player.id === 'p1')!.position = chanceCell.id;
    state.cardChoice = {
      mode: 'local-human',
      pending: { playerId: 'p1', deck: 'chance', cardId: state.decks.chance[0], resumeTurnPhase: 'managing' },
    };
    return state;
  }

  it('保留待确认卡牌，恢复后可以接受且旧存档（无 cardChoice）仍可载入', () => {
    const state = pausedCardState();
    const result = hydrateGameState(state, chinaMap);

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.state.cardChoice).toEqual(state.cardChoice);

    const accepted = applyIntent(result.state, 'p1', { type: 'accept_card' });
    expect(accepted).toMatchObject({ ok: true });
    if (!accepted.ok) return;
    expect(accepted.state.cardChoice?.pending).toBeNull();
    expect(applyIntent(accepted.state, 'p1', { type: 'accept_card' })).toEqual({ ok: false, code: 'WRONG_PHASE' });

    const legacy = pausedCardState();
    delete (legacy as Partial<CardChoiceFixture>).cardChoice;
    const legacyResult = hydrateGameState(legacy, chinaMap);
    expect(legacyResult).toMatchObject({ ok: true });
    if (!legacyResult.ok) return;
    expect(legacyResult.state.cardChoice).toBeUndefined();
  });

  it.each([
    ['电脑玩家等待确认', (state: CardChoiceFixture) => {
      state.currentPlayerId = 'p2';
      state.cardChoice.pending!.playerId = 'p2';
    }],
    ['等待玩家与当前行动者不一致', (state: CardChoiceFixture) => {
      state.cardChoice.pending!.playerId = 'p2';
    }],
    ['卡牌不属于声明的牌堆', (state: CardChoiceFixture) => {
      state.cardChoice.pending!.cardId = chinaMap.game.cards.destiny[0].id;
    }],
    ['非 managing 阶段仍在等待确认', (state: CardChoiceFixture) => {
      state.turnPhase = 'awaiting_roll';
    }],
    ['对局已结束时仍等待确认', (state: CardChoiceFixture) => {
      state.phase = 'game_over';
      state.winnerId = 'p1';
    }],
    ['未知的确认模式', (state: CardChoiceFixture) => {
      state.cardChoice.mode = 'remote-cheat';
    }],
    ['非法的效果进入阶段', (state: CardChoiceFixture) => {
      state.cardChoice.pending!.resumeTurnPhase = 'unknown';
    }],
    ['待确认卡牌带未知字段', (state: CardChoiceFixture) => {
      state.cardChoice.pending!.extra = true;
    }],
  ])('拒绝损坏的待确认状态：%s', (_label, mutate) => {
    const state = pausedCardState();
    mutate(state);
    expect(hydrateGameState(state, chinaMap)).toMatchObject({ ok: false });
  });
});
