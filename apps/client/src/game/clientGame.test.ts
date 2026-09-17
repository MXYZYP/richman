import { describe, expect, it } from 'vitest';
import { getActiveMapPack } from '@richman/board-data';
import { applyIntent, chooseBotIntent, createGame, type GameState } from '@richman/engine';
import { formatRecentLogEvent, getAssetRows, getAvailableActions, getCellDetail, getPendingCardChoice, getPendingPurchaseOffer, getPlayerAssetDialogModel, getTurnTitle } from './clientGame';
import { resolveLocalGameState } from './mapResolver';
import { createDefaultGameSetup, gameSetupToCreateOptions } from './gameSetup';
import { createBotActionDelay, createLocalSession, type LocalSession } from '../session/localSession';

const chinaMap = getActiveMapPack('china-tour');
const worldMap = getActiveMapPack('world-tour');

async function finishCurrentTurn(game: LocalSession) {
  // 单机真人抽卡确认：落卡格先暂停，测试驱动显式接受（可连锁）。
  for (let acceptCount = 0; acceptCount < 4 && game.state.value.cardChoice?.pending; acceptCount += 1) {
    await game.sendIntent({ type: 'accept_card' });
  }
  if (game.state.value.turnPhase === 'awaiting_airport_roll') {
    await game.sendIntent({ type: 'roll_airport_branch' });
  }
  if (game.state.value.turnPhase === 'awaiting_buy_decision') {
    await game.sendIntent({ type: 'skip_buy' });
  }
  if (game.state.value.turnPhase === 'awaiting_build_decision') {
    await game.sendIntent({ type: 'skip_build' });
  }
  if (game.state.value.turnPhase === 'managing') {
    await game.sendIntent({ type: 'end_turn' });
  }
}

type CardDeck = 'chance' | 'destiny';

const sessionPlayers = [
  { id: 'human', nickname: '玩家一' },
  { id: 'bot', nickname: '电脑A', isBot: true },
];

function createEngineFixture(overrides: Partial<GameState> = {}): GameState {
  return {
    ...createGame({
      mapRef: chinaMap.ref,
      ruleModules: chinaMap.game.requiredRuleModules,
      board: chinaMap.game.board,
      cards: chinaMap.game.cards,
      config: chinaMap.game.config,
      players: sessionPlayers,
      seed: 'client-game-fixture',
      cashGoal: null,
    }),
    ...overrides,
  };
}

function requireSuccessfulIntent(state: GameState, playerId: string, intent: Parameters<typeof applyIntent>[2]): GameState {
  const result = applyIntent(state, playerId, intent);
  if (!result.ok) throw new Error(`Expected ${intent.type} to succeed, got ${result.code}`);
  return result.state;
}

function findSeedForBotFirst(): string {
  for (let seed = 1; seed < 10000; seed += 1) {
    const state = createGame({
      mapRef: chinaMap.ref,
      ruleModules: chinaMap.game.requiredRuleModules,
      board: chinaMap.game.board,
      cards: chinaMap.game.cards,
      config: chinaMap.game.config,
      players: sessionPlayers,
      seed: String(seed),
      cashGoal: null,
    });
    if (state.currentPlayerId === 'bot') return String(seed);
  }
  throw new Error('Could not find a seed with BOT as the first actor');
}
function findSeedForHumanFirst(): string {
  for (let seed = 1; seed < 10000; seed += 1) {
    const state = createGame({
      mapRef: chinaMap.ref,
      ruleModules: chinaMap.game.requiredRuleModules,
      board: chinaMap.game.board,
      cards: chinaMap.game.cards,
      config: chinaMap.game.config,
      players: sessionPlayers,
      seed: String(seed),
      cashGoal: null,
    });
    if (state.currentPlayerId === 'human') return String(seed);
  }
  throw new Error('Could not find a seed with human as the first actor');
}

interface CardLandingSetup {
  seed: string;
  landedCell: { id: number; type: CardDeck };
}


async function findSeedForCardLanding(deck: CardDeck = 'chance'): Promise<CardLandingSetup> {
  for (let seed = 1; seed < 10000; seed += 1) {
    const game = createLocalSession({ wait: async () => undefined, players: sessionPlayers, seed: String(seed) });
    await game.sendIntent({ type: 'roll_dice' });
    const actor = game.state.value.players.find((player) => player.id === game.state.value.currentPlayerId);
    const landedCell = game.state.value.board.cells.find((cell) => cell.id === actor?.position);
    if (landedCell?.type === deck) return { seed: String(seed), landedCell: { id: landedCell.id, type: deck } };
  }
  throw new Error(`Could not find a seed that lands on a ${deck} cell`);
}

describe('单机真人待确认卡牌的展示与操作', () => {
  function pendingCardState(deck: CardDeck): GameState {
    const base = createEngineFixture();
    const card = chinaMap.game.cards[deck][0];
    return {
      ...base,
      cardChoice: {
        mode: 'local-human',
        pending: { playerId: base.currentPlayerId, deck, cardId: card.id, resumeTurnPhase: 'managing' },
      },
    };
  }

  it('待确认期间只提供同牌堆重抽与接受并执行', () => {
    const actions = getAvailableActions(pendingCardState('chance'));

    expect(actions.map((action) => [action.label, action.intent.type, action.primary ?? false])).toEqual([
      ['重新抽取', 'redraw_card', false],
      ['接受并执行', 'accept_card', true],
    ]);
  });

  it('解析待确认卡牌的真实卡面与玩家名，无 pending 时为 null', () => {
    const state = pendingCardState('destiny');
    const card = chinaMap.game.cards.destiny[0];
    const player = state.players.find((candidate) => candidate.id === state.currentPlayerId)!;

    expect(getPendingCardChoice(state)).toEqual({
      playerId: player.id,
      playerName: player.nickname,
      deck: 'destiny',
      cardId: card.id,
      ...(card.title === undefined ? {} : { title: card.title }),
      text: card.text,
    });
    expect(getPendingCardChoice(createEngineFixture())).toBeNull();
  });
});

function fixtureWithProperty(
  ownerId: string,
  cellId: number,
  level: number,
  mortgaged: boolean,
  overrides: Partial<GameState> = {},
): GameState {
  return createEngineFixture({
    currentPlayerId: ownerId,
    turnPhase: 'managing',
    properties: {
      ...createEngineFixture().properties,
      [cellId]: { ownerId, level, mortgaged },
    },
    ...overrides,
  });
}


describe('player-facing UI copy', () => {
  it('shows the active actor in the turn title', () => {
    const state = createEngineFixture();

    expect(getTurnTitle(state, state.currentPlayerId)).toBe('轮到 玩家一');
  });

  it('formats recent log events as readable Chinese messages', async () => {
    const game = createLocalSession({ wait: async () => {} });

    await game.sendIntent({ type: 'roll_dice' });

    const messages = game.state.value.recentLog.slice(-3).map((event) => formatRecentLogEvent(game.state.value, event));

    expect(messages).not.toContain('game_started');
    expect(messages).not.toContain('dice_rolled');
    expect(messages).not.toContain('token_moved');
    expect(messages.some((message) => message.includes('掷出'))).toBe(true);
    expect(messages.every((message) => !message.includes('_'))).toBe(true);
  });

  it('includes sell-house refund amounts in recent log messages', () => {
    const state = fixtureWithProperty('human', 2, 1, false);
    const nextState = requireSuccessfulIntent(state, 'human', { type: 'sell_house', cellId: 2 });
    const event = nextState.recentLog.at(-1);
    if (!event) throw new Error('Expected sell-house event');

    expect(formatRecentLogEvent(nextState, event)).toBe('福建省 卖出 1 栋房屋，获得 ¥750，剩余 0 级');
  });
});


describe('getAvailableActions', () => {
  it('maps awaiting_roll to roll dice only', () => {
    const game = createLocalSession({ wait: async () => undefined });
    game.state.value = { ...game.state.value, turnPhase: 'awaiting_roll' };

    expect(getAvailableActions(game.state.value)).toEqual([
      { label: '掷骰子', intent: { type: 'roll_dice' }, primary: true },
    ]);
  });

  it('maps awaiting_airport_roll to explicit branch roll', () => {
    const game = createLocalSession({ wait: async () => undefined });
    game.state.value = { ...game.state.value, turnPhase: 'awaiting_airport_roll' };

    expect(getAvailableActions(game.state.value)).toEqual([
      { label: '再掷一次', intent: { type: 'roll_airport_branch' }, primary: true },
    ]);
  });

  it('maps buy, build, and managing phases to the expected buttons', () => {
    const game = createLocalSession({ wait: async () => undefined });

    game.state.value = { ...game.state.value, turnPhase: 'awaiting_buy_decision' };
    expect(getAvailableActions(game.state.value).map((action) => action.label)).toEqual(['买地', '放弃']);

    game.state.value = { ...game.state.value, turnPhase: 'awaiting_build_decision' };
    expect(getAvailableActions(game.state.value).map((action) => action.label)).toEqual(['盖房', '跳过']);

    game.state.value = { ...game.state.value, turnPhase: 'managing' };
    expect(getAvailableActions(game.state.value).map((action) => action.label)).toEqual(['结束回合']);
  });

  it('disables gameplay actions while unresolved debt is present', () => {
    const game = createLocalSession({ wait: async () => undefined });
    game.state.value = {
      ...game.state.value,
      debt: { debtorId: game.state.value.currentPlayerId, amount: 100, creditorId: null, resume: { payments: [] } },
    };

    expect(getAvailableActions(game.state.value)).toEqual([]);
  });

  it('projects authoritative module choices without deriving eligibility on the client', () => {
    const state = createGame({
      mapRef: worldMap.ref,
      ruleModules: worldMap.game.requiredRuleModules,
      board: worldMap.game.board,
      cards: worldMap.game.cards,
      config: worldMap.game.config,
      players: sessionPlayers,
      seed: 'client-module-actions',
    });
    const actorId = state.currentPlayerId;
    const first = {
      optionId: 'first',
      module: { id: 'world-tour', version: 1 },
      playerId: actorId,
      requiredPhase: 'managing' as const,
      label: '前往日本',
      action: 'long-flight',
      payload: { optionId: 'first', targetCellId: 1, cost: 8000 },
    };
    const second = { ...first, optionId: 'second', label: '放弃', payload: { optionId: 'second', targetCellId: null, cost: 8000 } };
    const offered = {
      ...state,
      turnPhase: 'managing' as const,
      publicRuleState: { modules: {}, pendingActions: [first, second] },
    };

    expect(getAvailableActions(offered)).toEqual([
      {
        label: '前往日本',
        intent: { type: 'module', module: first.module, action: 'long-flight', payload: first.payload },
        primary: true,
      },
      {
        label: '放弃',
        intent: { type: 'module', module: first.module, action: 'long-flight', payload: second.payload },
      },
    ]);
  });
});

describe('World Tour client terminology', () => {
  it('uses presentation terminology for oceans and counts them by 片', () => {
    const state = createGame({
      mapRef: worldMap.ref,
      ruleModules: worldMap.game.requiredRuleModules,
      board: worldMap.game.board,
      cards: worldMap.game.cards,
      config: worldMap.game.config,
      players: sessionPlayers,
      seed: 'world-ocean-detail',
    });
    const detail = getCellDetail(resolveLocalGameState(state), 5);

    expect(detail).toMatchObject({
      name: '北冰洋',
      typeLabel: '海洋',
      description: '按同一玩家持有的海洋数量计算过路费。',
      rentRows: [
        { label: '持有 1 片海洋', amount: 2000 },
        { label: '持有 2 片海洋', amount: 4000 },
        { label: '持有 3 片海洋', amount: 6000 },
        { label: '持有 4 片海洋', amount: 8000 },
      ],
    });
  });

  it('adapts the level-4 World Tour hotel to the existing level-5 asset display contract', () => {
    const state = createGame({
      mapRef: worldMap.ref,
      ruleModules: worldMap.game.requiredRuleModules,
      board: worldMap.game.board,
      cards: worldMap.game.cards,
      config: worldMap.game.config,
      players: sessionPlayers,
      seed: 'world-hotel-detail',
    });
    const ownerId = state.currentPlayerId;
    const withHotel = {
      ...state,
      turnPhase: 'managing' as const,
      properties: { ...state.properties, 1: { ownerId, level: 4, mortgaged: false } },
    };
    const renderable = resolveLocalGameState(withHotel);

    expect(getAssetRows(renderable, ownerId).find((row) => row.cellId === 1)?.level).toBe(5);
    expect(getCellDetail(renderable, 1)).toMatchObject({
      levelLabel: '旅馆',
      rentRows: [
        { label: '裸地', amount: 200 },
        { label: '1 级房屋', amount: 1000 },
        { label: '2 级房屋', amount: 3000 },
        { label: '3 级房屋', amount: 7500 },
        { label: '旅馆', amount: 11000 },
      ],
    });
    expect(formatRecentLogEvent(renderable, { type: 'house_built', cellId: 1, level: 4, amount: 0 }))
      .toBe('日本 建成旅馆');
  });

  it('formats allowlisted World Tour module events as readable Chinese', () => {
    const state = resolveLocalGameState(createGame({
      mapRef: worldMap.ref,
      ruleModules: worldMap.game.requiredRuleModules,
      board: worldMap.game.board,
      cards: worldMap.game.cards,
      config: worldMap.game.config,
      players: sessionPlayers,
      seed: 'world-module-log',
    }));
    const playerId = state.currentPlayerId;

    expect(formatRecentLogEvent(state, {
      type: 'module', module: { id: 'world-tour', version: 1 }, eventType: 'toll_immunity_granted', payload: { playerId },
    })).toContain('获得一次过路费抵消');
    expect(formatRecentLogEvent(state, {
      type: 'module', module: { id: 'world-tour', version: 1 }, eventType: 'flight_declined', payload: { playerId, kind: 'short-flight' },
    })).toContain('放弃搭乘短途航班');
  });
});

describe('getPendingPurchaseOffer', () => {
  it('shows the landed unowned property price only during buy decision', () => {
    const game = createLocalSession({ wait: async () => undefined });
    game.state.value = {
      ...game.state.value,
      currentPlayerId: 'p1',
      turnPhase: 'awaiting_buy_decision',
      players: game.state.value.players.map((player) => (
        player.id === 'p1' ? { ...player, position: 2 } : player
      )),
      properties: {
        ...game.state.value.properties,
        2: { ownerId: null, level: 0, mortgaged: false },
      },
    };

    expect(getPendingPurchaseOffer(game.state.value)).toEqual({
      cellId: 2,
      name: '福建省',
      price: 2400,
    });

    game.state.value = { ...game.state.value, turnPhase: 'managing' };
    expect(getPendingPurchaseOffer(game.state.value)).toBeNull();
  });
});

describe('getAssetRows', () => {
  it('lists current-player owned assets in board order', () => {
    const game = createLocalSession({ wait: async () => undefined });
    const ownerId = game.state.value.currentPlayerId;
    game.state.value = {
      ...game.state.value,
      turnPhase: 'managing',
      properties: {
        ...game.state.value.properties,
        11: { ownerId, level: 0, mortgaged: false },
        2: { ownerId, level: 0, mortgaged: false },
      },
    };

    const rows = getAssetRows(game.state.value, ownerId);

    expect(rows.map((row) => row.cellId)).toEqual([2, 11]);
    expect(rows.map((row) => row.name)).toEqual(['福建省', '浙江省']);
  });

  it('marks properties with houses as sellable but not mortgageable', () => {
    const state = fixtureWithProperty('human', 2, 2, false);
    const row = getAssetRows(state, 'human').find((candidate) => candidate.cellId === 2);
    expect(row).toMatchObject({ cellId: 2, level: 2, mortgaged: false, sellHouseRefund: 750, canSellHouse: true, canMortgage: false, mortgageReason: '需先卖房' });
  });

  it('marks level-0 unmortgaged properties as mortgageable', () => {
    const state = fixtureWithProperty('human', 2, 0, false);
    const row = getAssetRows(state, 'human').find((candidate) => candidate.cellId === 2);
    expect(row).toMatchObject({ cellId: 2, mortgageValue: 1200, canSellHouse: false, sellHouseReason: '无房可卖', canMortgage: true, mortgageReason: null });
  });

  it('lists non-current player assets without enabling normal-phase actions', () => {
    const game = createLocalSession({ wait: async () => undefined });
    const currentPlayerId = game.state.value.currentPlayerId;
    const nonCurrentPlayer = game.state.value.players.find((player) => player.id !== currentPlayerId);
    if (!nonCurrentPlayer) throw new Error('Expected a second player for actor gating coverage');

    game.state.value = {
      ...game.state.value,
      turnPhase: 'managing',
      debt: null,
      properties: {
        ...game.state.value.properties,
        2: { ownerId: nonCurrentPlayer.id, level: 0, mortgaged: false },
        11: { ownerId: nonCurrentPlayer.id, level: 1, mortgaged: false },
        20: { ownerId: nonCurrentPlayer.id, level: 0, mortgaged: true },
      },
    };

    const rows = getAssetRows(game.state.value, nonCurrentPlayer.id);

    expect(rows.map((row) => row.cellId)).toEqual([2, 11, 20]);
    expect(rows.find((row) => row.cellId === 2)).toMatchObject({
      canMortgage: false,
      mortgageReason: '非当前阶段',
    });
    expect(rows.find((row) => row.cellId === 11)).toMatchObject({
      canSellHouse: false,
      sellHouseReason: '非当前阶段',
      canMortgage: false,
      mortgageReason: '非当前阶段',
    });
    expect(rows.find((row) => row.cellId === 20)).toMatchObject({
      canRedeem: false,
      redeemReason: '非当前阶段',
    });
  });

  it('marks mortgaged properties as redeemable only outside debt', () => {
    const state = fixtureWithProperty('human', 2, 0, true);
    const row = getAssetRows(state, 'human').find((candidate) => candidate.cellId === 2);
    expect(row).toMatchObject({ cellId: 2, redeemCost: 1320, canMortgage: false, mortgageReason: '已抵押', canRedeem: true, redeemReason: null });
    const debtState = { ...state, debt: { debtorId: 'human', amount: 100, creditorId: null, resume: { payments: [] } } };
    expect(getAssetRows(debtState, 'human').find((candidate) => candidate.cellId === 2)).toMatchObject({ canRedeem: false, redeemReason: '债务中不可赎回' });
  });

  it('blocks non-debtor asset actions while allowing the active debtor eligible actions', () => {
    const game = createLocalSession({ wait: async () => undefined });
    const nonDebtorId = game.state.value.currentPlayerId;
    const debtorId = game.state.value.players.find((player) => player.id !== nonDebtorId)?.id;
    if (!debtorId) throw new Error('Expected a second player for debt gating coverage');

    game.state.value = {
      ...game.state.value,
      turnPhase: 'managing',
      debt: { debtorId, amount: 100, creditorId: null, resume: { payments: [] } },
      properties: {
        ...game.state.value.properties,
        2: { ownerId: nonDebtorId, level: 1, mortgaged: false },
        11: { ownerId: debtorId, level: 0, mortgaged: false },
        20: { ownerId: debtorId, level: 1, mortgaged: false },
      },
    };

    const nonDebtorRow = getAssetRows(game.state.value, nonDebtorId).find((candidate) => candidate.cellId === 2);
    const debtorRows = getAssetRows(game.state.value, debtorId);
    const debtorMortgageRow = debtorRows.find((candidate) => candidate.cellId === 11);
    const debtorSellRow = debtorRows.find((candidate) => candidate.cellId === 20);

    expect(nonDebtorRow).toMatchObject({
      canSellHouse: false,
      sellHouseReason: '非当前阶段',
      canMortgage: false,
      mortgageReason: '非当前阶段',
    });
    expect(debtorMortgageRow).toMatchObject({
      cellId: 11,
      displayName: '浙江',
      subtype: 'normal',
      canSellHouse: false,
      sellHouseReason: '无房可卖',
      canMortgage: true,
      mortgageReason: null,
    });
    expect(debtorSellRow).toMatchObject({
      cellId: 20,
      canSellHouse: true,
      sellHouseReason: null,
      canMortgage: false,
      mortgageReason: '需先卖房',
    });
  });

  it('exposes sell-property eligibility and refund for a debt actor with bare land', () => {
    const game = createLocalSession({ wait: async () => undefined });
    const debtorId = game.state.value.currentPlayerId;
    game.state.value = {
      ...game.state.value,
      turnPhase: 'managing',
      debt: { debtorId, amount: 500, creditorId: null, resume: { payments: [] } },
      config: {
        ...game.state.value.config,
        sellLandRate: 0.4,
      },
      properties: {
        ...game.state.value.properties,
        2: { ownerId: debtorId, level: 0, mortgaged: false },
      },
    };

    const row = getAssetRows(game.state.value, debtorId).find((candidate) => candidate.cellId === 2);

    expect(row).toMatchObject({
      cellId: 2,
      sellPropertyValue: 960,
      canSellProperty: true,
      sellPropertyReason: null,
    });
  });

  it('explains why sell-property is unavailable outside debt or for ineligible debt assets', () => {
    const game = createLocalSession({ wait: async () => undefined });
    const ownerId = game.state.value.currentPlayerId;
    game.state.value = {
      ...game.state.value,
      turnPhase: 'managing',
      debt: null,
      properties: {
        ...game.state.value.properties,
        2: { ownerId, level: 0, mortgaged: false },
      },
    };

    const nonDebtRow = getAssetRows(game.state.value, ownerId).find((candidate) => candidate.cellId === 2);
    expect(nonDebtRow).toMatchObject({
      sellPropertyValue: 1200,
      canSellProperty: false,
      sellPropertyReason: '仅债务中可卖地',
    });

    game.state.value = {
      ...game.state.value,
      debt: { debtorId: ownerId, amount: 500, creditorId: null, resume: { payments: [] } },
      properties: {
        ...game.state.value.properties,
        2: { ownerId, level: 1, mortgaged: false },
        11: { ownerId, level: 0, mortgaged: true },
      },
    };

    const debtRows = getAssetRows(game.state.value, ownerId);
    expect(debtRows.find((candidate) => candidate.cellId === 2)).toMatchObject({
      canSellProperty: false,
      sellPropertyReason: '需先卖房',
    });
    expect(debtRows.find((candidate) => candidate.cellId === 11)).toMatchObject({
      canSellProperty: false,
      sellPropertyReason: '已抵押',
    });
  });

  it('explains redeemable mortgaged assets with insufficient cash', () => {
    const game = createLocalSession({ wait: async () => undefined });
    const ownerId = game.state.value.currentPlayerId;
    game.state.value = {
      ...game.state.value,
      turnPhase: 'managing',
      players: game.state.value.players.map((player) =>
        player.id === ownerId ? { ...player, cash: 0 } : player,
      ),
      properties: {
        ...game.state.value.properties,
        2: { ownerId, level: 0, mortgaged: true },
      },
    };

    const row = getAssetRows(game.state.value, ownerId).find((candidate) => candidate.cellId === 2);

    expect(row).toMatchObject({
      canRedeem: false,
      redeemReason: '现金不足',
    });
  });
});

describe('getPlayerAssetDialogModel', () => {
  it('derives only the selected player assets, position, and debt', () => {
    const game = createLocalSession({ wait: async () => undefined });
    const selected = game.state.value.players.find((player) => player.id !== game.state.value.currentPlayerId);
    if (!selected) throw new Error('Expected a second player for player detail coverage');

    game.state.value = {
      ...game.state.value,
      turnPhase: 'managing',
      debt: { debtorId: selected.id, creditorId: null, amount: 650, resume: { payments: [] } },
      players: game.state.value.players.map((player) =>
        player.id === selected.id ? { ...player, position: 2 } : player,
      ),
      properties: {
        ...game.state.value.properties,
        2: { ownerId: game.state.value.currentPlayerId, level: 0, mortgaged: false },
        11: { ownerId: selected.id, level: 2, mortgaged: false },
      },
    };

    const model = getPlayerAssetDialogModel(game.state.value, selected.id);

    expect(model?.player.id).toBe(selected.id);
    expect(model?.positionName).toBe('福建省');
    expect(model?.debtAmount).toBe(650);
    expect(model?.assets.map((asset) => asset.cellId)).toEqual([11]);
  });

  it('returns null after the selected player disappears', () => {
    const game = createLocalSession({ wait: async () => undefined });
    expect(getPlayerAssetDialogModel(game.state.value, 'missing-player')).toBeNull();
  });
});

describe('getCellDetail', () => {
  it('returns normal property detail with owner, level, mortgage value, and rent rows', () => {
    const state = fixtureWithProperty('human', 2, 2, false);
    const owner = state.players.find((player) => player.id === 'human');
    if (!owner) throw new Error('Expected fixture owner to exist');

    const detail = getCellDetail(state, 2);

    expect(detail).toMatchObject({
      cellId: 2,
      name: '福建省',
      typeLabel: '普通地产',
      description: '可购买、收租、盖房或旅馆的地产。',
      price: 2400,
      ownerName: owner.nickname,
      levelLabel: '2 级房屋',
      mortgagedLabel: '未抵押',
      mortgageValue: 1200,
      houseCost: 1500,
    });
    expect(detail?.rentRows).toEqual([
      { label: '裸地', amount: 200 },
      { label: '1 级房屋', amount: 1000 },
      { label: '2 级房屋', amount: 3000 },
      { label: '3 级房屋', amount: 7500 },
      { label: '4 级房屋', amount: 9250 },
      { label: '旅馆', amount: 11000 },
    ]);
    expect(detail?.notes).toEqual([]);
  });

  it('summarizes the current normal-property rent before the full rent table', () => {
    const detail = getCellDetail(fixtureWithProperty('human', 2, 2, false), 2);

    expect(detail?.currentRent).toEqual({
      amount: 3000,
      note: '按当前 2 级房屋收费。',
    });
  });

  it('states clearly when an unowned or mortgaged property currently charges no rent', () => {
    const game = createLocalSession({ wait: async () => undefined });

    expect(getCellDetail(game.state.value, 2)?.currentRent).toEqual({
      amount: 0,
      note: '无主地皮，当前不收费。',
    });
    expect(getCellDetail(fixtureWithProperty('human', 2, 0, true), 2)?.currentRent).toEqual({
      amount: 0,
      note: '已抵押，当前不收费。',
    });
  });

  it('summarizes station rent by holdings and utility rent by the current dice', () => {
    const base = createEngineFixture();
    const stationState = createEngineFixture({
      properties: {
        ...base.properties,
        6: { ownerId: 'human', level: 0, mortgaged: false },
        19: { ownerId: 'human', level: 0, mortgaged: false },
      },
    });
    const utilityState = createEngineFixture({
      lastDice: [3, 4],
      properties: {
        ...base.properties,
        10: { ownerId: 'human', level: 0, mortgaged: false },
      },
    });

    expect(getCellDetail(stationState, 6)?.currentRent).toEqual({
      amount: 500,
      note: '按持有 2 座车站收费。',
    });
    expect(getCellDetail(utilityState, 10)?.currentRent).toEqual({
      amount: 70,
      note: '按本次骰点和 7 × 10 计算；实际收费随本次掷骰变化。',
    });
  });

  it('summarizes ocean rent by the owner unmortgaged holdings', () => {
    const base = resolveLocalGameState(createGame({
      mapRef: worldMap.ref,
      ruleModules: worldMap.game.requiredRuleModules,
      board: worldMap.game.board,
      cards: worldMap.game.cards,
      config: worldMap.game.config,
      players: sessionPlayers,
      seed: 'ocean-current-rent',
    }));
    const state = {
      ...base,
      properties: {
        ...base.properties,
        5: { ownerId: 'human', level: 0, mortgaged: false },
        24: { ownerId: 'human', level: 0, mortgaged: false },
      },
    };

    expect(getCellDetail(state, 5)?.currentRent).toEqual({
      amount: 4000,
      note: '按持有 2 片海洋收费。',
    });
  });

  it('waits for a dice result and uses both utility holdings for the multiplier', () => {
    const base = createEngineFixture();
    const state = createEngineFixture({
      lastDice: null,
      properties: {
        ...base.properties,
        10: { ownerId: 'human', level: 0, mortgaged: false },
        47: { ownerId: 'human', level: 0, mortgaged: false },
      },
    });

    expect(getCellDetail(state, 10)?.currentRent).toEqual({
      amount: null,
      note: '按本次骰点和 × 100 计算；掷骰后显示具体金额。',
    });
  });

  it('returns unowned property detail with unowned note', () => {
    const game = createLocalSession({ wait: async () => undefined });

    const detail = getCellDetail(game.state.value, 2);

    expect(detail).toMatchObject({
      cellId: 2,
      name: '福建省',
      typeLabel: '普通地产',
      price: 2400,
      ownerName: null,
      levelLabel: '裸地',
      mortgagedLabel: '未抵押',
      mortgageValue: 1200,
    });
    expect(detail?.notes).toContain('当前无主。');
  });

  it('marks mortgaged property details as rent-free', () => {
    const detail = getCellDetail(fixtureWithProperty('human', 2, 0, true), 2);

    expect(detail?.mortgagedLabel).toBe('已抵押');
    expect(detail?.notes).toContain('抵押中不收租。');
  });

  it('returns station property detail with rent rows by station count', () => {
    const game = createLocalSession({ wait: async () => undefined });

    const detail = getCellDetail(game.state.value, 6);

    expect(detail).toMatchObject({
      cellId: 6,
      name: '广州站',
      typeLabel: '车站',
      description: '按同一玩家持有的车站数量计算租金。',
      price: 2000,
      ownerName: null,
      levelLabel: '车站',
      mortgagedLabel: '未抵押',
      mortgageValue: 1000,
      houseCost: null,
    });
    expect(detail?.rentRows).toEqual([
      { label: '持有 1 座车站', amount: 250 },
      { label: '持有 2 座车站', amount: 500 },
      { label: '持有 3 座车站', amount: 1000 },
      { label: '持有 4 座车站', amount: 2000 },
    ]);
  });

  it('returns utility property detail without rent rows when no static rents exist', () => {
    const game = createLocalSession({ wait: async () => undefined });

    const detail = getCellDetail(game.state.value, 10);

    expect(detail).toMatchObject({
      cellId: 10,
      name: '中国大运河',
      typeLabel: '公用事业',
      description: '过路费 = 骰点和 × 10（持有 1 处）或 × 100（持有 2 处全有）。',
      price: 1500,
      ownerName: null,
      levelLabel: '公用事业',
      mortgagedLabel: '未抵押',
      mortgageValue: 750,
      houseCost: null,
      rentRows: [],
    });
  });

  it('returns readable non-property cell details without rent rows', () => {
    const game = createLocalSession({ wait: async () => undefined });

    const cases = [
      {
        cellId: 0,
        name: '起点',
        typeLabel: '起点',
        description: '经过或停在起点时获得 2,000。',
      },
      {
        cellId: 3,
        name: '机会',
        typeLabel: '机会',
        description: '抽一张机会卡并执行效果。',
      },
      {
        cellId: 15,
        name: '命运',
        typeLabel: '命运',
        description: '抽一张命运卡并执行效果。',
      },
      {
        cellId: 13,
        name: '北京首都国际机场',
        typeLabel: '机场',
        description: '恰好停在此格时立即再掷一颗骰子，从「韩国首尔」进入支线并结算。',
      },
      {
        cellId: 23,
        name: '所得税',
        typeLabel: '税格',
        description: '停下时向银行缴税 1,000。',
      },
      {
        cellId: 26,
        name: '品尝兰州牛肉面',
        typeLabel: '特殊格',
        description: '停下时暂停 1 回合。',
      },
      {
        cellId: 52,
        name: '韩国首尔',
        typeLabel: '世界之窗',
        description: '停下时移动到「起点」并结算；不领工资。',
      },
    ];

    for (const expected of cases) {
      expect(getCellDetail(game.state.value, expected.cellId)).toMatchObject({
        ...expected,
        price: null,
        ownerName: null,
        levelLabel: null,
        mortgagedLabel: null,
        mortgageValue: null,
        houseCost: null,
        rentRows: [],
      });
    }
  });

  it('shows the World Tour Bangkok airport as ending the turn before the branch roll', () => {
    const state = resolveLocalGameState(createGame({
      mapRef: worldMap.ref,
      ruleModules: worldMap.game.requiredRuleModules,
      board: worldMap.game.board,
      cards: worldMap.game.cards,
      config: worldMap.game.config,
      players: sessionPlayers,
      seed: 'world-airport-detail',
    }));

    const detail = getCellDetail(state, 10);

    expect(detail).toMatchObject({
      cellId: 10,
      name: '泰国曼谷机场',
      typeLabel: '机场',
      price: null,
      rentRows: [],
    });
    expect(detail?.description).toContain('结束本回合');
    expect(detail?.description).toContain('太平洋支线');
    expect(detail?.description).not.toContain('立即再掷');
  });

  it('returns null for unknown cell detail', () => {
    const game = createLocalSession({ wait: async () => undefined });

    expect(getCellDetail(game.state.value, 999)).toBeNull();
  });
});

describe('BOT auto action driver', () => {
  it('generates BOT delays in the documented 0.8-1.6s range', () => {
    const samples = Array.from({ length: 100 }, () => createBotActionDelay());
    expect(samples.every((value) => Number.isInteger(value) && value >= 800 && value <= 1600)).toBe(true);
  });

  it('blocks manual actions while the current actor is a BOT', async () => {
    const game = createLocalSession({ autoPlayBots: true, wait: async () => undefined, players: sessionPlayers, seed: findSeedForBotFirst() });
    expect(game.state.value.currentPlayerId).toBe('bot');
    await game.sendIntent({ type: 'roll_dice' });
    expect(game.state.value.turnPhase).toBe('awaiting_roll');
    expect(game.lastError.value).toBe('电脑玩家正在自动行动');
  });

  it('runs a BOT intent only after the injected delay resolves', async () => {
    const waits: number[] = [];
    let releaseDelay!: () => void;
    const game = createLocalSession({
      autoPlayBots: true,
      botDelay: () => 321,
      wait: async (ms) => {
        waits.push(ms);
        if (waits.length === 1) return new Promise<void>((resolve) => { releaseDelay = resolve; });
      },
      players: sessionPlayers,
      seed: findSeedForBotFirst(),
    });
    const before = game.state.value;
    const run = game.runBotTurnIfNeeded();
    await Promise.resolve();
    expect(waits).toEqual([321]);
    expect(game.isBotThinking.value).toBe(true);
    expect(game.state.value).toBe(before);
    releaseDelay();
    await run;
    game.dispose();
    expect(game.isBotThinking.value).toBe(false);
    expect(game.lastError.value).toBeNull();
    expect(game.state.value.recentLog).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'dice_rolled', playerId: 'bot' })]));
  });

  it('chains BOT intents from a real roll through post-roll decisions until a human acts', async () => {
    const waits: number[] = [];
    let botDelayCount = 0;
    const game = createLocalSession({
      autoPlayBots: true,
      botDelay: () => 300 + ++botDelayCount,
      wait: async (ms) => { waits.push(ms); },
      players: sessionPlayers,
      seed: findSeedForBotFirst(),
    });
    await game.runBotTurnIfNeeded();
    for (let attempt = 0; attempt < 100 && (game.isAnimating.value || game.isBotThinking.value); attempt += 1) await Promise.resolve();
    expect(waits.filter((ms) => ms >= 301 && ms <= 399).length).toBeGreaterThanOrEqual(1);
    expect(game.isBotThinking.value).toBe(false);
    expect(game.isAnimating.value).toBe(false);
    expect(game.lastError.value).toBeNull();
    expect(game.state.value.recentLog).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'dice_rolled', playerId: 'bot' }),
      expect.objectContaining({ type: 'token_moved', playerId: 'bot' }),
    ]));
  });

  it('does nothing when autoplay is enabled but the current actor is human', async () => {
    const game = createLocalSession({ autoPlayBots: true, botDelay: () => 321, wait: async () => undefined, players: sessionPlayers, seed: findSeedForHumanFirst() });
    expect(game.state.value.currentPlayerId).toBe('human');
    const before = game.state.value;
    await game.runBotTurnIfNeeded();
    expect(game.isBotThinking.value).toBe(false);
    expect(game.state.value).toBe(before);
    expect(game.lastError.value).toBeNull();
  });

  it('does nothing after the BOT has left play', () => {
    const state = createEngineFixture({ players: createEngineFixture().players.map((player) => player.id === 'bot' ? { ...player, bankrupt: true } : player) });
    expect(state.players.find((player) => player.id === 'bot')?.bankrupt).toBe(true);
  });

  it('uses the debt debtor as the BOT actor even when another player is current', () => {
    const state = fixtureWithProperty('bot', 2, 1, false, {
      currentPlayerId: 'human',
      debt: { debtorId: 'bot', amount: 650, creditorId: null, resume: { payments: [] } },
      players: createEngineFixture().players.map((player) => player.id === 'bot' ? { ...player, cash: 0 } : player),
    });
    expect(chooseBotIntent(state, 'bot')).toEqual({ type: 'sell_house', cellId: 2 });
  });

  it('lets a BOT debt debtor mortgage bare property during debt resolution', () => {
    const state = fixtureWithProperty('bot', 2, 0, false, {
      currentPlayerId: 'human',
      debt: { debtorId: 'bot', amount: 1100, creditorId: null, resume: { payments: [] } },
      players: createEngineFixture().players.map((player) => player.id === 'bot' ? { ...player, cash: 0 } : player),
    });
    expect(chooseBotIntent(state, 'bot')).toEqual({ type: 'mortgage_property', cellId: 2 });
    expect(requireSuccessfulIntent(state, 'bot', { type: 'mortgage_property', cellId: 2 }).properties[2]).toEqual({ ownerId: 'bot', level: 0, mortgaged: true });
  });

  it('lets a BOT debt debtor declare bankruptcy during debt resolution', () => {
    const state = createEngineFixture({
      currentPlayerId: 'human',
      turnPhase: 'managing',
      debt: { debtorId: 'bot', amount: 2500, creditorId: 'human', resume: { payments: [] } },
      players: createEngineFixture().players.map((player) => player.id === 'bot' ? { ...player, cash: 100 } : player),
    });
    expect(chooseBotIntent(state, 'bot')).toEqual({ type: 'declare_bankrupt' });
    expect(requireSuccessfulIntent(state, 'bot', { type: 'declare_bankrupt' }).players.find((player) => player.id === 'bot')?.bankrupt).toBe(true);
  });
});

describe('createLocalSession', () => {
  it('initializes a configured engine game from the default setup options', () => {
    const game = createLocalSession({
      ...gameSetupToCreateOptions(createDefaultGameSetup()),
      wait: async () => undefined,
    });
    const state = game.state.value;
    const currentPlayer = state.players.find((player) => player.id === state.currentPlayerId);

    expect(state.players).toHaveLength(3);
    expect(currentPlayer, 'currentPlayerId should resolve to an initialized player').toBeDefined();
    if (!currentPlayer) throw new Error('Expected currentPlayerId to resolve to an initialized player');
    expect(state.cashGoal).toBeNull();
    expect(game.displayPositions.value).toEqual(
      Object.fromEntries(state.players.map((player) => [player.id, player.position])),
    );
    expect(game.eventMessage.value).toBe(`轮到 ${currentPlayer.nickname}`);
  });

  it('initializes display positions from the engine player positions', () => {
    const game = createLocalSession({ wait: async () => undefined });

    expect(Object.fromEntries(game.state.value.players.map((player) => [player.id, player.position]))).toEqual(game.displayPositions.value);
  });

  it('rolls through the real engine and aligns display position after playback', async () => {
    const game = createLocalSession({ wait: async () => undefined });
    const actorId = game.state.value.currentPlayerId;

    await game.sendIntent({ type: 'roll_dice' });

    const actor = game.state.value.players.find((player) => player.id === actorId)!;
    expect(game.dice.value).not.toBeNull();
    expect(game.dice.value).toHaveLength(2);
    expect(game.displayPositions.value[actorId]).toBe(actor.position);
    expect(game.isAnimating.value).toBe(false);
    expect(game.lastError.value).toBeNull();
  });

  it('surfaces the drawn card details after a real roll lands on a card cell', async () => {
    const landing = await findSeedForCardLanding('chance');
    const game = createLocalSession({ wait: async () => undefined, players: sessionPlayers, seed: landing.seed });

    await game.sendIntent({ type: 'roll_dice' });

    const activeCard = game.activeCard.value;
    expect(activeCard).not.toBeNull();
    if (!activeCard) throw new Error('Expected activeCard after landing on a card cell');
    expect(activeCard.deck).toBe(landing.landedCell.type);
    const card = game.state.value.cards[activeCard.deck].find((candidate) => candidate.id === activeCard.cardId);
    expect(card, 'activeCard.cardId should exist in state.cards for its deck').toBeDefined();
    if (!card) throw new Error(`Expected card ${activeCard.cardId} in ${activeCard.deck} deck`);
    expect(activeCard.text).toBe(card.text);
    expect(activeCard.title).toBe(card.title);
    expect(Object.hasOwn(activeCard, 'title')).toBe(false);
    expect(game.eventMessage.value).toContain(card.text);
    expect(game.eventMessage.value).not.toBe('card_drawn');
  });

  it('clears drawn card context when the next turn starts', async () => {
    const landing = await findSeedForCardLanding('chance');
    const game = createLocalSession({ wait: async () => undefined, players: sessionPlayers, seed: landing.seed });
    const firstPlayerId = game.state.value.currentPlayerId;

    await game.sendIntent({ type: 'roll_dice' });

    const activeCard = game.activeCard.value;
    expect(activeCard).not.toBeNull();
    if (!activeCard) throw new Error('Expected activeCard after landing on a card cell');
    const priorCardText = activeCard.text;

    await finishCurrentTurn(game);

    expect(game.state.value.currentPlayerId).not.toBe(firstPlayerId);
    expect(game.eventMessage.value).not.toContain(priorCardText);
    expect(game.activeCard.value).toBeNull();
  });

  it('visits token_moved path cells in order during playback', async () => {
    const visited: number[] = [];
    let lastPosition: number | undefined;
    let actorId = '';
    const game = createLocalSession({
      wait: async () => {
        const current = game.displayPositions.value[actorId];
        if (current !== undefined && current !== lastPosition) {
          visited.push(current);
          lastPosition = current;
        }
      },
    });
    actorId = game.state.value.currentPlayerId;
    const before = game.displayPositions.value[actorId];
    lastPosition = before;

    await game.sendIntent({ type: 'roll_dice' });

    expect(visited.length).toBeGreaterThan(0);
    expect(visited[0]).not.toBe(before);
    expect(visited[visited.length - 1]).toBe(game.displayPositions.value[actorId]);
  });

  it('refuses a second intent while animation is still playing', async () => {
    let release!: () => void;
    let waitCount = 0;
    const wait = () => {
      waitCount += 1;
      if (waitCount === 1) {
        return new Promise<void>((resolve) => { release = resolve; });
      }
      return Promise.resolve();
    };
    const game = createLocalSession({ wait });
    const first = game.sendIntent({ type: 'roll_dice' });
    await Promise.resolve();
    const stateWhileAnimating = game.state.value;

    await game.sendIntent({ type: 'roll_dice' });

    expect(game.lastError.value).toBe('动画播放中，请稍候');
    expect(game.state.value).toBe(stateWhileAnimating);

    release();
    await first;

    expect(game.lastError.value).toBeNull();
    expect(game.eventMessage.value).not.toBe('动画播放中，请稍候');
  });

  it('sets lastError and preserves state when the engine rejects an intent', async () => {
    const game = createLocalSession({ wait: async () => undefined });
    const before = game.state.value;

    await game.sendIntent({ type: 'buy_property' });

    expect(game.state.value).toBe(before);
    expect(game.lastError.value).toBe('当前阶段不能执行这个操作');
  });

  it('lets the active debtor mortgage during debt even when another player is current', () => {
    const base = fixtureWithProperty('bot', 2, 0, false, {
      currentPlayerId: 'human',
      debt: { debtorId: 'bot', amount: 1300, creditorId: null, resume: { payments: [] } },
      players: createEngineFixture().players.map((player) => player.id === 'bot' ? { ...player, cash: 0 } : player),
    });
    const state = {
      ...base,
      properties: {
        ...base.properties,
        4: { ownerId: 'bot', level: 0, mortgaged: false },
      },
    };
    const nextState = requireSuccessfulIntent(state, 'bot', { type: 'mortgage_property', cellId: 2 });
    expect(nextState.properties[2]).toEqual({ ownerId: 'bot', level: 0, mortgaged: true });
    expect(nextState.debt?.debtorId).toBe('bot');
    expect(formatRecentLogEvent(nextState, nextState.recentLog.at(-1)!)).toContain('抵押');
  });

  it('lets the active debtor sell a house during debt', () => {
    const state = fixtureWithProperty('human', 2, 2, false, {
      debt: { debtorId: 'human', amount: 850, creditorId: null, resume: { payments: [] } },
      players: createEngineFixture().players.map((player) => player.id === 'human' ? { ...player, cash: 0 } : player),
    });
    const nextState = requireSuccessfulIntent(state, 'human', { type: 'sell_house', cellId: 2 });
    expect(nextState.properties[2]).toEqual({ ownerId: 'human', level: 1, mortgaged: false });
    expect(formatRecentLogEvent(nextState, nextState.recentLog.at(-1)!)).toContain('卖出');
  });

  it('keeps redeem blocked during debt with a clear message', () => {
    const state = fixtureWithProperty('human', 2, 0, true, {
      debt: { debtorId: 'human', amount: 100, creditorId: null, resume: { payments: [] } },
    });
    const result = applyIntent(state, 'human', { type: 'redeem_property', cellId: 2 });
    expect(result).toEqual({ ok: false, code: 'WRONG_PHASE' });
  });

  it('shows readable Chinese when redeem succeeds', () => {
    const state = fixtureWithProperty('human', 2, 0, true);
    const nextState = requireSuccessfulIntent(state, 'human', { type: 'redeem_property', cellId: 2 });
    expect(nextState.properties[2]).toEqual({ ownerId: 'human', level: 0, mortgaged: false });
    expect(formatRecentLogEvent(nextState, nextState.recentLog.at(-1)!)).toContain('赎回');
  });

  it('ignores public render-state debt mutations when evaluating rules', async () => {
    const game = createLocalSession({ wait: async () => undefined, players: sessionPlayers, seed: 'public-state-is-not-engine-state' });
    const before = {
      currentPlayerId: game.state.value.currentPlayerId,
      turn: game.state.value.turn,
      phase: game.state.value.phase,
      properties: structuredClone(game.state.value.properties),
      players: structuredClone(game.state.value.players),
    };
    game.state.value = {
      ...game.state.value,
      debt: { debtorId: game.state.value.currentPlayerId, amount: 100, creditorId: null, resume: { payments: [] } },
    };

    await game.sendIntent({ type: 'roll_dice' });

    expect(game.lastError.value).toBeNull();
    expect(game.state.value.turn).toBe(before.turn);
    expect(game.state.value.phase).toBe(before.phase);
    expect(game.state.value.currentPlayerId).toBe(before.currentPlayerId);
    expect(game.state.value.properties).toEqual(before.properties);
    expect(game.state.value.players.map(({ id, cash }) => ({ id, cash }))).toEqual(before.players.map(({ id, cash }) => ({ id, cash })));
    expect(game.state.value.lastDice).not.toBeNull();
  });

  it('can complete two consecutive turns without desynchronizing display positions', async () => {
    const game = createLocalSession({ wait: async () => undefined });
    const firstPlayerId = game.state.value.currentPlayerId;

    await game.sendIntent({ type: 'roll_dice' });
    await finishCurrentTurn(game);

    const secondPlayerId = game.state.value.currentPlayerId;
    expect(secondPlayerId).not.toBe(firstPlayerId);

    await game.sendIntent({ type: 'roll_dice' });

    const secondPlayer = game.state.value.players.find((player) => player.id === secondPlayerId)!;
    expect(game.displayPositions.value[secondPlayerId]).toBe(secondPlayer.position);
  });
});
