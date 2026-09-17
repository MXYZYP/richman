import { describe, expect, it } from 'vitest';
import { getActiveMapPack, listActiveMaps, type MapCatalogEntry, type MapPack } from '@richman/board-data';
import testBoard from '../../../../packages/board-data/maps/__test__/test-map-v1/board.json';
import testCards from '../../../../packages/board-data/maps/__test__/test-map-v1/cards.json';
import testConfig from '../../../../packages/board-data/maps/__test__/test-map-v1/game-config.json';
import testManifest from '../../../../packages/board-data/maps/__test__/test-map-v1/manifest.json';
import {
  createDefaultGameSetup,
  gameSetupToCreateOptions,
  updateGameSetupCounts,
  updateGameSetupMapId,
  validateGameSetup,
} from './gameSetup';

const china = getActiveMapPack('china-tour');
const harbor = {
  ref: testManifest.ref,
  metadata: testManifest.metadata,
  game: {
    board: testBoard,
    cards: testCards,
    config: testConfig,
    requiredRuleModules: testManifest.requiredRuleModules,
  },
  presentation: testManifest.presentation,
} as unknown as MapPack;
const catalog: readonly MapCatalogEntry[] = [
  { ref: china.ref, title: china.metadata.title, description: china.metadata.description },
  { ref: harbor.ref, title: harbor.metadata.title, description: harbor.metadata.description },
];
const dependencies = {
  catalog,
  resolveActive: (mapId: string) => {
    if (mapId === china.ref.id) return china;
    if (mapId === harbor.ref.id) return harbor;
    throw new Error('inactive map');
  },
};

describe('game setup model', () => {
  it('creates the visible default roster as one human and two bots', () => {
    const setup = createDefaultGameSetup();

    expect(setup.humanCount).toBe(1);
    expect(setup.botCount).toBe(2);
    expect(setup.mapId).toBe('china-tour');
    expect(setup.players).toEqual([
      { id: 'p1', nickname: '玩家一', isBot: false },
      { id: 'p2', nickname: '电脑A', isBot: true },
      { id: 'p3', nickname: '电脑B', isBot: true },
    ]);
  });

  it('updateGameSetupMapId preserves roster settings while switching maps', () => {
    const setup = createDefaultGameSetup();
    setup.players[0]!.nickname = '自定义昵称';
    setup.cashGoalEnabled = true;

    const next = updateGameSetupMapId(setup, 'world-tour');

    expect(next.mapId).toBe('world-tour');
    expect(next.players[0]!.nickname).toBe('自定义昵称');
    expect(next.cashGoalEnabled).toBe(true);
    expect(next.humanCount).toBe(setup.humanCount);
    expect(next.botCount).toBe(setup.botCount);
  });

  it('rejects a map id outside the active catalog', () => {
    const setup = createDefaultGameSetup(dependencies);
    setup.mapId = 'retired-map';

    expect(validateGameSetup(setup, dependencies)).toEqual({ ok: false, message: '所选地图当前不可用' });
    expect(() => gameSetupToCreateOptions(setup, dependencies)).toThrow('所选地图当前不可用');
  });

  it('keeps an empty catalog renderable as a visible unavailable-map state', () => {
    const empty = { catalog: [], resolveActive: () => { throw new Error('must not resolve'); } };
    const setup = createDefaultGameSetup(empty);

    expect(setup.mapId).toBe('');
    expect(validateGameSetup(setup, empty)).toEqual({ ok: false, message: '所选地图当前不可用' });
    expect(() => gameSetupToCreateOptions(setup, empty)).toThrow('所选地图当前不可用');
  });

  it('rejects a stale catalog ref when its resolver returns another exact version and resolves only once', () => {
    let resolveCalls = 0;
    const stale = {
      catalog: [{ ...catalog[0]!, ref: { ...china.ref, version: 999 } }],
      resolveActive: () => { resolveCalls += 1; return china; },
    };
    const setup = { ...createDefaultGameSetup(dependencies), mapId: 'china-tour' };

    expect(validateGameSetup(setup, stale)).toEqual({ ok: false, message: '所选地图当前不可用' });
    expect(resolveCalls).toBe(1);
    resolveCalls = 0;
    expect(() => gameSetupToCreateOptions(setup, stale)).toThrow('所选地图当前不可用');
    expect(resolveCalls).toBe(1);
  });

  it('把漏注册的 package-local asset 显示为地图不可用，阻止本机 session 构造异常', () => {
    const withAsset = {
      ...china,
      presentation: {
        ...china.presentation,
        cells: {
          ...china.presentation.cells,
          0: {
            ...china.presentation.cells[0]!,
            artwork: { type: 'local-asset' as const, path: 'assets/start.webp' as const },
          },
        },
      },
    } satisfies MapPack;
    const missingAssetDependencies = {
      catalog: [{ ref: withAsset.ref, title: withAsset.metadata.title, description: withAsset.metadata.description }],
      resolveActive: () => withAsset,
      resolveAsset: () => null,
    };
    const setup = createDefaultGameSetup(missingAssetDependencies);

    expect(validateGameSetup(setup, missingAssetDependencies)).toEqual({
      ok: false,
      message: '所选地图当前不可用',
    });
    expect(() => gameSetupToCreateOptions(setup, missingAssetDependencies)).toThrow('所选地图当前不可用');
  });

  it('resolves and passes the exact selected pack into local session options', () => {
    const setup = createDefaultGameSetup(dependencies);
    setup.mapId = harbor.ref.id;

    const options = gameSetupToCreateOptions(setup, dependencies);
    expect(options.mapPack).toBe(harbor);
    expect(options.mapPack!.ref).toEqual(harbor.ref);
  });

  it.each([
    {
      name: 'raises zero humans and trims bots to the four-player maximum',
      counts: { humanCount: 0, botCount: 4 },
      expectedHumanCount: 1,
      expectedBotCount: 3,
      expectedBotFlags: [false, true, true, true],
    },
    {
      name: 'adds a bot when one human alone would make an illegal one-player game',
      counts: { humanCount: 1, botCount: 0 },
      expectedHumanCount: 1,
      expectedBotCount: 1,
      expectedBotFlags: [false, true],
    },
    {
      name: 'trims bots before humans when requested players exceed four',
      counts: { humanCount: 2, botCount: 3 },
      expectedHumanCount: 2,
      expectedBotCount: 2,
      expectedBotFlags: [false, false, true, true],
    },
  ])('$name', ({ counts, expectedHumanCount, expectedBotCount, expectedBotFlags }) => {
    const setup = updateGameSetupCounts(createDefaultGameSetup(), counts);

    expect(setup.humanCount).toBe(expectedHumanCount);
    expect(setup.botCount).toBe(expectedBotCount);
    expect(setup.players.map((player) => player.isBot)).toEqual(expectedBotFlags);
    expect(setup.players).toHaveLength(expectedHumanCount + expectedBotCount);
  });

  it('validates cash goals only when enabled and requires enabled goals above initial cash', () => {
    const disabledSetup = createDefaultGameSetup();
    disabledSetup.cashGoalEnabled = false;
    disabledSetup.cashGoal = china.game.config.initialCash;
    expect(validateGameSetup(disabledSetup)).toEqual({ ok: true });

    const equalToInitialCash = createDefaultGameSetup();
    equalToInitialCash.cashGoalEnabled = true;
    equalToInitialCash.cashGoal = china.game.config.initialCash;
    expect(validateGameSetup(equalToInitialCash).ok).toBe(false);

    const aboveInitialCash = createDefaultGameSetup();
    aboveInitialCash.cashGoalEnabled = true;
    aboveInitialCash.cashGoal = china.game.config.initialCash + 1;
    expect(validateGameSetup(aboveInitialCash)).toEqual({ ok: true });
  });

  it.each([
    { name: 'positive infinity', cashGoal: Number.POSITIVE_INFINITY },
    { name: 'negative infinity', cashGoal: Number.NEGATIVE_INFINITY },
    { name: 'NaN', cashGoal: Number.NaN },
  ])('rejects enabled non-finite cash goal: $name', ({ cashGoal }) => {
    const setup = createDefaultGameSetup();
    setup.cashGoalEnabled = true;
    setup.cashGoal = cashGoal;

    expect(validateGameSetup(setup)).toEqual({
      ok: false,
      message: `现金目标必须高于初始资金 ¥${china.game.config.initialCash.toLocaleString('zh-CN')}`,
    });
  });

  it('maps disabled cash goal to null and enabled cash goal to the selected amount', () => {
    const disabledSetup = createDefaultGameSetup();
    disabledSetup.cashGoalEnabled = false;
    disabledSetup.cashGoal = china.game.config.initialCash + 5000;
    expect(gameSetupToCreateOptions(disabledSetup).cashGoal).toBeNull();

    const enabledSetup = createDefaultGameSetup();
    enabledSetup.cashGoalEnabled = true;
    enabledSetup.cashGoal = china.game.config.initialCash + 5000;
    expect(gameSetupToCreateOptions(enabledSetup).cashGoal).toBe(china.game.config.initialCash + 5000);
  });

  it('converts a four-player setup into deterministic local session players', () => {
    const setup = updateGameSetupCounts(createDefaultGameSetup(), { humanCount: 2, botCount: 2 });
    setup.players[0].nickname = '阿明';
    setup.players[1].nickname = '小红';

    expect(validateGameSetup(setup)).toEqual({ ok: true });
    expect(gameSetupToCreateOptions(setup).players).toEqual([
      { id: 'p1', nickname: '阿明', isBot: false },
      { id: 'p2', nickname: '小红', isBot: false },
      { id: 'p3', nickname: '电脑A', isBot: true },
      { id: 'p4', nickname: '电脑B', isBot: true },
    ]);
  });
});
