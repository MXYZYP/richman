import { describe, expect, it } from 'vitest';
import { getActiveMapPack, listActiveMaps, type MapCatalogEntry, type MapPack } from '@richman/board-data';
import type { BotDifficulty } from '@richman/engine';
import testBoard from '../../../../packages/board-data/maps/__test__/test-map-v1/board.json';
import testCards from '../../../../packages/board-data/maps/__test__/test-map-v1/cards.json';
import testConfig from '../../../../packages/board-data/maps/__test__/test-map-v1/game-config.json';
import testManifest from '../../../../packages/board-data/maps/__test__/test-map-v1/manifest.json';
import {
  BOT_DIFFICULTY_OPTIONS,
  createDefaultGameSetup,
  gameSetupToCreateOptions,
  updateGameSetupBotDifficulty,
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

    // 换图要走模型 API：直接改 mapId 会绕过「按新图档位夹取最高房级」，表单随即校验失败。
    const switched = updateGameSetupMapId(setup, harbor.ref.id, dependencies);
    const options = gameSetupToCreateOptions(switched, dependencies);
    expect(options.mapPack).toBe(harbor);
    expect(options.mapPack!.ref).toEqual(harbor.ref);
  });

  it('clamps the custom max house level down to the newly selected map ceiling', () => {
    const setup = createDefaultGameSetup(dependencies);
    expect(setup.config.maxHouseLevel).toBeGreaterThan(harbor.game.config.maxHouseLevel);

    const switched = updateGameSetupMapId(setup, harbor.ref.id, dependencies);

    expect(switched.config.maxHouseLevel).toBe(harbor.game.config.maxHouseLevel);
    // 夹回后表单恢复可提交，而不是卡在「最高房级需为 1-2 之间的整数」。
    expect(() => gameSetupToCreateOptions(switched, dependencies)).not.toThrow();
    // 其余规则项不受换图影响。
    expect(switched.config.initialCash).toBe(setup.config.initialCash);
    expect(switched.config.mortgageInterestRate).toBe(setup.config.mortgageInterestRate);
  });

  // #8：单机热座上限已对齐联机（MAX_PLAYERS = 6），裁剪阈值随之从 4 改为 6。
  it.each([
    {
      name: 'raises zero humans to one and fills bots up to the six-player maximum',
      counts: { humanCount: 0, botCount: 5 },
      expectedHumanCount: 1,
      expectedBotCount: 5,
      expectedBotFlags: [false, true, true, true, true, true],
    },
    {
      name: 'adds a bot when one human alone would make an illegal one-player game',
      counts: { humanCount: 1, botCount: 0 },
      expectedHumanCount: 1,
      expectedBotCount: 1,
      expectedBotFlags: [false, true],
    },
    {
      name: 'trims bots before humans when requested players exceed six',
      counts: { humanCount: 2, botCount: 5 },
      expectedHumanCount: 2,
      expectedBotCount: 4,
      expectedBotFlags: [false, false, true, true, true, true],
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

// #6：电脑难度原先只在首页设，现在搬进建房流程 —— 模型层要保证「一个字段搬了家，别的东西都没跟着动」。
describe('game setup model · 电脑玩家难度（#6）', () => {
  it('默认表单的难度是「普通」，且默认值取自档位表而不是另写一个字面量', () => {
    const setup = createDefaultGameSetup();
    const values = BOT_DIFFICULTY_OPTIONS.map((option) => option.value);

    expect(setup.botDifficulty).toBe('normal');
    expect(values).toContain(setup.botDifficulty);
    // 三档、值唯一、每档都有给玩家看的 label 与 hint（界面直接渲染，缺一个就是空白按钮）。
    expect(values).toEqual(['easy', 'normal', 'hard']);
    expect(new Set(values).size).toBe(BOT_DIFFICULTY_OPTIONS.length);
    for (const option of BOT_DIFFICULTY_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.hint.length).toBeGreaterThan(0);
    }
  });

  it('换难度只改 botDifficulty 这一个字段，且返回新对象、不改原表单', () => {
    const setup = updateGameSetupCounts(createDefaultGameSetup(), { humanCount: 2, botCount: 2 });
    setup.cashGoalEnabled = true;
    setup.cashGoal = china.game.config.initialCash + 5000;

    const next = updateGameSetupBotDifficulty(setup, 'hard');

    expect(next).not.toBe(setup);
    expect(next.botDifficulty).toBe('hard');
    // 原表单不被就地修改（Vue 里同一份 setup 被两处引用时，就地改会互相串味）。
    expect(setup.botDifficulty).toBe('normal');
    // 其他字段原样带过去：人数、名单、现金目标、规则项、地图一个都不能动。
    expect(next.humanCount).toBe(setup.humanCount);
    expect(next.botCount).toBe(setup.botCount);
    expect(next.players).toBe(setup.players);
    expect(next.mapId).toBe(setup.mapId);
    expect(next.cashGoalEnabled).toBe(true);
    expect(next.cashGoal).toBe(setup.cashGoal);
    expect(next.config).toBe(setup.config);
  });

  it.each(['easy', 'normal', 'hard'] as const)('难度 %s 一路透传到本机对局参数里', (botDifficulty: BotDifficulty) => {
    const setup = updateGameSetupBotDifficulty(createDefaultGameSetup(dependencies), botDifficulty);

    expect(validateGameSetup(setup, dependencies)).toEqual({ ok: true });
    expect(gameSetupToCreateOptions(setup, dependencies).botDifficulty).toBe(botDifficulty);
  });

  it('把电脑数减到 0 时仍保留已选难度，不悄悄回落到「普通」', () => {
    // 界面在 botCount === 0 时会把整段难度选择藏起来，但值本身要留着：
    // 玩家「2 真人 2 电脑 → 困难」后把电脑调成 0 再调回 2，不该发现难度自己变回普通了。
    const withBots = updateGameSetupBotDifficulty(
      updateGameSetupCounts(createDefaultGameSetup(), { humanCount: 2, botCount: 2 }),
      'hard',
    );

    const noBots = updateGameSetupCounts(withBots, { humanCount: 2, botCount: 0 });

    expect(noBots.botCount).toBe(0);
    expect(noBots.botDifficulty).toBe('hard');

    const backToBots = updateGameSetupCounts(noBots, { humanCount: 2, botCount: 2 });
    expect(backToBots.botDifficulty).toBe('hard');
  });

  it('换地图也不会重置难度（换图只该夹最高房级）', () => {
    const setup = updateGameSetupBotDifficulty(createDefaultGameSetup(dependencies), 'easy');

    const switched = updateGameSetupMapId(setup, harbor.ref.id, dependencies);

    expect(switched.mapId).toBe(harbor.ref.id);
    expect(switched.botDifficulty).toBe('easy');
  });
});
