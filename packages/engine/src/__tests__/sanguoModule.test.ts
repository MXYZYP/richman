// sanguo@1（三国风云：战场屯粮草 / 功德祠）的模块级测试。
//
// 覆盖六件事：
//   1) 落点只摆选项，战场按现金 / 粮草 / 免战动态增减分支。
//   2) 粮草：屯兵扣款入账、上限截断；犒军升级只挑**等级最低**的可升城池（保证能一路升满）。
//   3) 出阵厮杀：胜负随机但可复现；**战败现金不足必须进 core 债务队列**（意图处理器不经 payDebtIfPossible）。
//   4) 免战：有免战次数时不生成厮杀选项。
//   5) 功德祠：一人只许一炷香（INCENSE_CAP = 1），已上香者不再卖「上香」——否则纯诱导玩家白砸 800 两。
//   6) 粮草减租（positiveRentHook 出口）：每份减 10%、单次封顶 300、减免额取 10 的倍数。
// 另加 hydrate 的严格校验。
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@richman/board-data';
import { sanguoTourMap } from '@richman/board-data';
import { applyIntent, createGame } from '../engine';
import { resolveLanding } from '../effects';
import { chooseBotIntent } from '../bot';
import { hydrateGameState } from '../hydrate';
import { defaultRuleModuleRegistry } from '../moduleRegistry';
import {
  INCENSE_COST,
  INCENSE_PAYOUT,
  SANGUO_CELL_TYPES,
  SANGUO_MODULE_KEY,
  SKIRMISH_LOSS,
  SKIRMISH_WIN,
  SUPPLY_CAP,
  SUPPLY_RELIEF_CAP,
  TUNBIN_COST,
  UPGRADE_SUPPLY_COST,
  readSanguoState,
  sanguoCells,
  validateSanguoPublicModuleState,
} from '../sanguoModule';
import type { GameEvent, GameState, PendingModuleAction } from '../types';

const sanguoRef = { id: 'sanguo', version: 1 } as const;
const coreRef = { id: 'core', version: 1 } as const;

/** 三国风云上的战场（官渡 / 赤壁）与功德祠。 */
const BATTLE_CELLS = [3, 12] as const;
const SHRINE_CELLS = [9, 26] as const;
const BATTLE_A = BATTLE_CELLS[0];
const SHRINE_A = SHRINE_CELLS[0];

function makeGame(playerCount = 2, seed = 'sanguo-base'): GameState {
  return createGame({
    mapRef: sanguoTourMap.ref,
    ruleModules: sanguoTourMap.game.requiredRuleModules,
    board: sanguoTourMap.game.board,
    cards: sanguoTourMap.game.cards,
    config: sanguoTourMap.game.config,
    players: [
      { id: 'p1', nickname: '甲' },
      { id: 'p2', nickname: '乙' },
      { id: 'p3', nickname: '丙' },
    ].slice(0, playerCount),
    seed,
  });
}

function cashOf(state: GameState, playerId: string): number {
  return state.players.find((player) => player.id === playerId)!.cash;
}

function placePlayer(state: GameState, playerId: string, position: number): GameState {
  return {
    ...state,
    players: state.players.map((player) => (
      player.id === playerId ? { ...player, position } : player
    )),
  };
}

function setCash(state: GameState, playerId: string, cash: number): GameState {
  return {
    ...state,
    players: state.players.map((player) => (
      player.id === playerId ? { ...player, cash } : player
    )),
  };
}

/** 把某格判给 ownerId（用于构造「路过别人地盘」以触发收租与 positiveRentHook）。 */
function ownProperty(state: GameState, ownerId: string, cellId: number, level: number): GameState {
  return {
    ...state,
    properties: {
      ...state.properties,
      [cellId]: { ...(state.properties[cellId] ?? { level: 0 }), ownerId, level },
    },
  };
}

/** 直接摆一份 sanguo 公开状态（跳过卡牌路径，直接测落点分支的裁剪）。 */
function withSanguo(
  state: GameState,
  tables: {
    supply?: Record<string, number>;
    battleShield?: Record<string, number>;
    incense?: Record<string, number>;
  },
): GameState {
  return {
    ...state,
    publicRuleState: {
      modules: {
        [SANGUO_MODULE_KEY]: {
          supplyByPlayerId: tables.supply ?? {},
          battleShieldByPlayerId: tables.battleShield ?? {},
          incenseByPlayerId: tables.incense ?? {},
        },
      },
      pendingActions: [],
    },
  };
}

function moduleEventTypes(events: readonly GameEvent[]): string[] {
  return events
    .filter((event) => event.type === 'module')
    .map((event) => (event as unknown as { eventType: string }).eventType);
}

function pendingKinds(state: GameState, playerId: string): string[] {
  return state.publicRuleState.pendingActions
    .filter((action) => action.playerId === playerId)
    .map((action) => (action.payload as Record<string, JsonValue>).kind as string);
}

function pendingOfKind(state: GameState, playerId: string, kind: string): PendingModuleAction {
  const action = state.publicRuleState.pendingActions.find((candidate) => (
    candidate.playerId === playerId
    && typeof candidate.payload === 'object'
    && candidate.payload !== null
    && (candidate.payload as Record<string, JsonValue>).kind === kind
  ));
  if (!action) throw new Error(`missing sanguo-choice action with kind=${kind}`);
  return action;
}

/** 由待选动作反推合法意图（optionId 必须原样带回，否则 matchOwnChoice 会判 ILLEGAL_INTENT）。 */
function intentFor(action: PendingModuleAction) {
  return {
    type: 'module' as const,
    module: action.module,
    action: action.action,
    payload: action.payload,
  };
}

/** 把玩家放到格子上并结算落点（得到 managing 阶段与待选动作）。 */
function landOn(state: GameState, playerId: string, cellId: number) {
  return resolveLanding(placePlayer(state, playerId, cellId), playerId, []);
}

/** 落点后按 kind 提交意图；非 ok 直接抛，避免 `if (!ok) return` 把整条用例静默跳过后续断言。 */
function chooseLanding(
  landed: ReturnType<typeof resolveLanding>,
  playerId: string,
  kind: string,
) {
  const applied = applyIntent(
    landed.state,
    playerId,
    intentFor(pendingOfKind(landed.state, playerId, kind)),
  );
  if (!applied.ok) throw new Error(`sanguo intent ${kind} was rejected: ${applied.code}`);
  return applied;
}

describe('sanguo@1 战场与功德祠', () => {
  it('createGame 初始化干净的公开规则状态，注册表认识战场与功德祠两种格型', () => {
    const state = makeGame();

    expect(state.publicRuleState).toEqual({ modules: {}, pendingActions: [] });
    expect(state.ruleModules).toEqual([coreRef, sanguoRef]);
    expect(SANGUO_CELL_TYPES).toEqual(['battle', 'shrine']);
    // sanguoCells 按**棋盘数组顺序**返回，所以功德祠（9）夹在两个战场（3 / 12）中间。
    expect(sanguoCells(state.board).map((cell) => cell.id)).toEqual([3, 9, 12, 26]);
    for (const cell of sanguoCells(state.board)) {
      expect(() => defaultRuleModuleRegistry.getCellHandler(state.ruleModules, cell)).not.toThrow();
    }
  });

  it('首次落战场只有「屯兵 / 出阵厮杀 / 按兵不动」，落点本身不动钱', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOn(base, playerId, BATTLE_A);

    // 粮草为 0 → 没有「犒军升级」；没有免战 → 有「出阵厮杀」。开局现金 2000 恰好够屯兵。
    expect(pendingKinds(landed.state, playerId)).toEqual(['tunbin', 'skirmish', 'wait']);
    expect(landed.state.turnPhase).toBe('managing');
    expect(cashOf(landed.state, playerId)).toBe(base.config.initialCash);
    expect(moduleEventTypes(landed.events)).toEqual(['sanguo_battle_landed']);
  });

  it('屯兵扣 2000 两换 1 份粮草，军饷按付给银行记账', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const applied = chooseLanding(landOn(base, playerId, BATTLE_A), playerId, 'tunbin');

    expect(cashOf(applied.state, playerId)).toBe(base.config.initialCash - TUNBIN_COST);
    expect(readSanguoState(applied.state).supplyByPlayerId[playerId]).toBe(1);
    expect(moduleEventTypes(applied.events)).toEqual(['sanguo_tunbinned']);
    // 记账契约：钱离开牌桌进国库，必须补发 core 的 bank_paid，否则现金守恒对不上。
    expect(applied.events).toContainEqual({ type: 'bank_paid', playerId, amount: TUNBIN_COST });
  });

  it('粮草满 12 份后不再摆「屯兵」，且选项会被清空', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const full = withSanguo(base, { supply: { [playerId]: SUPPLY_CAP } });

    expect(pendingKinds(landOn(full, playerId, BATTLE_A).state, playerId))
      .toEqual(['skirmish', 'wait']);
  });

  it('现金不足 2000 时战场不再摆「屯兵」', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const broke = withSanguo(setCash(base, playerId, TUNBIN_COST - 1), {});

    expect(pendingKinds(landOn(broke, playerId, BATTLE_A).state, playerId))
      .toEqual(['skirmish', 'wait']);
  });

  it('犒军升级扣 2 份粮草、免费升一级，且总是挑等级最低的城池（保证能一路升满）', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    // 同时持有三处：等级 0 / 2 / 1。期望被升的是等级 0 的那一座（寿春）。
    const owned = ownProperty(ownProperty(ownProperty(base, playerId, 1, 0), playerId, 4, 2), playerId, 6, 1);
    const stocked = withSanguo(owned, { supply: { [playerId]: UPGRADE_SUPPLY_COST } });
    const landed = landOn(stocked, playerId, BATTLE_A);
    expect(pendingKinds(landed.state, playerId)).toContain('upgrade');

    const applied = chooseLanding(landed, playerId, 'upgrade');
    // 粮草从 2 花到 0：decrement 的契约是「归零即删键」，所以读出来是 undefined 而不是 0。
    // 落点分支一律用 `?? 0` 兜底（见 battleChoiceActions），两处口径必须一致。
    expect(readSanguoState(applied.state).supplyByPlayerId[playerId]).toBeUndefined();
    expect(applied.state.properties[1]!.level).toBe(1);
    expect(applied.state.properties[4]!.level).toBe(2);
    expect(applied.state.properties[6]!.level).toBe(1);
    // 升级不花钱：粮草是唯一支出。
    expect(cashOf(applied.state, playerId)).toBe(cashOf(landed.state, playerId));
    expect(moduleEventTypes(applied.events)).toEqual(['sanguo_upgraded']);
    // house_built 是 core 事件（模拟器按 amount 记账，粮草支付记 0）。
    expect(applied.events).toContainEqual({ type: 'house_built', cellId: 1, level: 1, amount: 0 });
  });

  it('没有可升城池时不摆「犒军升级」', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    // 满级（maxHouseLevel = 3）后再屯粮草也升不动。
    const maxed = ownProperty(base, playerId, 1, base.config.maxHouseLevel);
    const stocked = withSanguo(maxed, { supply: { [playerId]: UPGRADE_SUPPLY_COST } });

    expect(pendingKinds(landOn(stocked, playerId, BATTLE_A).state, playerId))
      .not.toContain('upgrade');
  });

  it('出阵厮杀：胜得 2000 两、负付 1000 两，同一 seed 结果可复现', () => {
    for (const seed of ['sanguo-win-a', 'sanguo-win-b', 'sanguo-loss-a', 'sanguo-loss-b']) {
      const base = makeGame(2, seed);
      const playerId = base.currentPlayerId;
      const landed = landOn(base, playerId, BATTLE_A);
      const applied = chooseLanding(landed, playerId, 'skirmish');

      const types = moduleEventTypes(applied.events);
      const delta = cashOf(applied.state, playerId) - cashOf(landed.state, playerId);
      if (types.includes('sanguo_skirmish_draw')) continue; // seed 退化成非数字时的防御分支
      expect(types).toEqual(['sanguo_skirmished']);
      if (delta > 0) {
        expect(delta).toBe(SKIRMISH_WIN);
        expect(applied.events).toContainEqual({ type: 'bank_received', playerId, amount: SKIRMISH_WIN });
      } else {
        expect(delta).toBe(-SKIRMISH_LOSS);
        // 战败刻意走 processQueuedPayments（core 的唯一付款入口），所以发的是 payment_made
        // 而不是 bank_paid —— 这正是「与 core 付银行同一套流程」的体现。
        expect(applied.events).toContainEqual({
          type: 'payment_made',
          from: playerId,
          to: null,
          amount: SKIRMISH_LOSS,
        });
        expect(applied.state.debt).toBeNull();
      }

      // 同 seed 重跑必须得到同一结果。
      const again = makeGame(2, seed);
      const againApplied = chooseLanding(landOn(again, again.currentPlayerId, BATTLE_A), again.currentPlayerId, 'skirmish');
      expect(cashOf(againApplied.state, again.currentPlayerId))
        .toBe(cashOf(applied.state, playerId));
    }
  });

  it('★ 战败现金不足时差额进 core 债务队列，而不是凭空免单', () => {
    // 意图处理器不经 payDebtIfPossible，所以模块必须自己把 debt 写进 state；
    // 否则事件说「欠 1000」而状态里没有债务 —— 玩家白欠一次、后续回合也不会被冻结。
    //
    // ★ 必须先给玩家一座地：applyIntent 收尾会跑 stabilizeAutomaticBankruptcies，
    //   一旦 debt 存在且 hasLegalFundraisingAction 为 false（名下无房可卖/可抵押），
    //   引擎会**立刻**判破产把债清掉。名下空空的「欠 900 两」在真实对局里不会停留。
    let checkedLoss = false;
    for (let attempt = 0; attempt < 60 && !checkedLoss; attempt += 1) {
      const base = makeGame(2, `sanguo-debt-${attempt}`);
      const playerId = base.currentPlayerId;
      // 持一间陈留（可抵押 1500 > 欠款 900），保证债务能进入正常筹款流程而不是当场破产。
      const landed = landOn(ownProperty(setCash(base, playerId, 100), playerId, 6, 0), playerId, BATTLE_A);
      const applied = chooseLanding(landed, playerId, 'skirmish');

      const delta = cashOf(applied.state, playerId) - 100;
      if (delta >= 0) continue; // 这一局赢了，换 seed
      checkedLoss = true;
      expect(moduleEventTypes(applied.events)).toContain('sanguo_skirmished');
      // 现金只有 100 → 先扣到 0，剩下 900 变成债务。
      expect(cashOf(applied.state, playerId)).toBe(0);
      expect(applied.state.debt).not.toBeNull();
      expect(applied.state.debt?.debtorId).toBe(playerId);
      expect(applied.state.debt?.amount).toBe(SKIRMISH_LOSS - 100);
      expect(applied.events).toContainEqual({ type: 'payment_made', from: playerId, to: null, amount: 100 });
      // debt_entered 是 core 事件（type 不叫 module），不能拿 moduleEventTypes 去命中。
      expect(applied.events).toContainEqual({
        type: 'debt_entered',
        debtorId: playerId,
        amount: SKIRMISH_LOSS - 100,
        creditorId: null,
      });
      // 债务冻结流程：此后任何非筹款意图都必须被拒，否则「欠债」形同虚设。
      expect(applyIntent(applied.state, playerId, { type: 'end_turn' }).ok).toBe(false);
    }
    expect(checkedLoss, '60 个种子里应至少出现一次战败').toBe(true);
  });

  it('有免战次数时不生成「出阵厮杀」，直接按兵不动即可', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const shielded = withSanguo(base, { battleShield: { [playerId]: 1 } });

    expect(pendingKinds(landOn(shielded, playerId, BATTLE_A).state, playerId))
      .toEqual(['tunbin', 'wait']);
  });

  it('落功德祠只有「上香 / 不祈福」，上香付 800 两且一人只许一次', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const landed = landOn(base, playerId, SHRINE_A);

    expect(pendingKinds(landed.state, playerId)).toEqual(['incense', 'salute']);
    expect(cashOf(landed.state, playerId)).toBe(base.config.initialCash);
    expect(moduleEventTypes(landed.events)).toEqual(['sanguo_shrine_landed']);

    const applied = chooseLanding(landed, playerId, 'incense');
    expect(cashOf(applied.state, playerId)).toBe(base.config.initialCash - INCENSE_COST);
    expect(readSanguoState(applied.state).incenseByPlayerId[playerId]).toBe(1);
    expect(moduleEventTypes(applied.events)).toEqual(['sanguo_incensed']);
    expect(applied.events).toContainEqual({ type: 'bank_paid', playerId, amount: INCENSE_COST });

    // ★ 第二次再落功德祠：不再摆「上香」。收益是「每次落战场发 300」，与上香次数无关，
    //   重复上香只是重复白砸 800 两。
    expect(pendingKinds(landOn(applied.state, playerId, SHRINE_A).state, playerId))
      .toEqual(['salute']);
  });

  it('落功德祠时「不祈福」不花钱、不上香', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const applied = chooseLanding(landOn(base, playerId, SHRINE_A), playerId, 'salute');

    expect(cashOf(applied.state, playerId)).toBe(base.config.initialCash);
    expect(readSanguoState(applied.state).incenseByPlayerId[playerId]).toBeUndefined();
    expect(moduleEventTypes(applied.events)).toEqual(['sanguo_saluted']);
  });

  it('上香之后每次落战场额外发 300 两香火钱（且只在落战场时发）', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const incensed = chooseLanding(landOn(base, playerId, SHRINE_A), playerId, 'incense');

    const beforeBattle = incensed.state;
    const landed = landOn(beforeBattle, playerId, BATTLE_A);
    expect(moduleEventTypes(landed.events)).toEqual(['sanguo_battle_landed', 'sanguo_incense_paid']);
    expect(landed.events).toContainEqual({
      type: 'bank_received',
      playerId,
      amount: INCENSE_PAYOUT,
    });
    expect(cashOf(landed.state, playerId))
      .toBe(cashOf(beforeBattle, playerId) + INCENSE_PAYOUT);

    // 停在功德祠不再发香火钱 —— 那是「落战场」的奖励，不是「上香」的次数奖励。
    const shrineAgain = landOn(landed.state, playerId, SHRINE_A);
    expect(moduleEventTypes(shrineAgain.events)).toEqual(['sanguo_shrine_landed']);
    expect(cashOf(shrineAgain.state, playerId)).toBe(cashOf(landed.state, playerId));
  });

  it('粮草抵减过路费：每份减 10%、单次封顶 300、减免额取 10 的倍数', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;
    const other = base.players.find((player) => player.id !== playerId)!.id;
    const reliefOf = (supply: number, cellId: number, level: number) => {
      const owned = ownProperty(base, other, cellId, level);
      const withSupply = withSanguo(owned, { supply: { [playerId]: supply } });
      return resolveLanding(placePlayer(withSupply, playerId, cellId), playerId, []).events
        .find((event) => event.type === 'module'
          && (event as unknown as { eventType: string }).eventType === 'sanguo_relief_applied') as
          | { payload: { relief: number; amount: number } }
          | undefined;
    };

    // 寿春空地租金 180：1 份 → 18 → 向下取到 10 的倍数 → 减 10，实收 170。
    const one = reliefOf(1, 1, 0);
    expect(one?.payload).toMatchObject({ relief: 10, amount: 170 });

    // 下邳空地租金 100：1 份 → 恰好 10 的倍数 → 减 10，实收 90。
    expect(reliefOf(1, 4, 0)?.payload).toMatchObject({ relief: 10, amount: 90 });

    // 长安空地租金 1500：5 份 → 750 远超封顶 → 只减 300，实收 1200。
    expect(reliefOf(5, 13, 0)?.payload)
      .toMatchObject({ relief: SUPPLY_RELIEF_CAP, amount: 1200 });

    // 减免额永远是 10 的倍数（避免 137 这种零头租金），且不超过原价。
    for (const [cellId, level, rent] of [[1, 0, 180], [4, 1, 500], [8, 2, 5000], [13, 0, 1500]] as const) {
      for (const supply of [1, 3, 7, SUPPLY_CAP]) {
        const hit = reliefOf(supply, cellId, level);
        expect(hit).toBeDefined();
        const { relief, amount } = hit!.payload;
        expect(relief % 10).toBe(0);
        expect(relief).toBeLessThanOrEqual(Math.min(SUPPLY_RELIEF_CAP, rent));
        expect(amount).toBe(rent - relief);
      }
    }

    // 没有粮草 → 完全不发减租事件（否则战报会被无意义的「减 0」刷屏）。
    expect(reliefOf(0, 13, 0)).toBeUndefined();
    // 地盘无主 → 落点是「待决策买地」而不是收租，钩子压根不跑。
    const unowned = withSanguo(base, { supply: { [playerId]: SUPPLY_CAP } });
    const buyable = resolveLanding(placePlayer(unowned, playerId, 13), playerId, []);
    expect(buyable.state.turnPhase).toBe('awaiting_buy_decision');
    expect(moduleEventTypes(buyable.events)).not.toContain('sanguo_relief_applied');
  });

  it('机器人策略：现金充裕先屯兵、缺钱则按兵不动，且永不主动进债务', () => {
    const base = makeGame();
    const playerId = base.currentPlayerId;

    // 8000 ≥ TUNBIN_COST + BOT_TUNBIN_RESERVE → 屯兵。
    const rich = landOn(setCash(base, playerId, 8000), playerId, BATTLE_A);
    const richDecision = chooseBotIntent(rich.state, playerId);
    expect(richDecision.type).toBe('module');
    expect((richDecision as { payload: Record<string, JsonValue> }).payload.kind).toBe('tunbin');

    // 现金 100 < SKIRMISH_LOSS：屯兵与厮杀都不划算（厮杀输了会欠债），应按兵不动。
    const poor = landOn(setCash(base, playerId, 100), playerId, BATTLE_A);
    const poorDecision = chooseBotIntent(poor.state, playerId);
    expect((poorDecision as { payload: Record<string, JsonValue> }).payload.kind).toBe('wait');

    // 中间档（够输但不够屯兵）→ 允许厮杀。
    const mid = landOn(setCash(base, playerId, SKIRMISH_LOSS + 500), playerId, BATTLE_A);
    const midDecision = chooseBotIntent(mid.state, playerId);
    expect((midDecision as { payload: Record<string, JsonValue> }).payload.kind).toBe('skirmish');

    // 有粮草 + 有可升城池 + 现金不够屯兵 → 升级（粮草已经攒够就没必要再买一份）。
    const owned = ownProperty(base, playerId, 1, 0);
    const stocked = withSanguo(setCash(owned, playerId, SKIRMISH_LOSS + 500), { supply: { [playerId]: UPGRADE_SUPPLY_COST } });
    const upgradeFirst = chooseBotIntent(landOn(stocked, playerId, BATTLE_A).state, playerId);
    expect((upgradeFirst as { payload: Record<string, JsonValue> }).payload.kind).toBe('upgrade');

    // ★ 现金同时够屯兵与升级时，**屯兵优先**（粮草既能升级又能长期减租，是投资而非存款）。
    // 这条优先级是刻意定的：反过来的话机器人会把粮草全烧在升级上、再也不屯，减租被动出口形同虚设。
    const richWithGrain = withSanguo(setCash(ownProperty(base, playerId, 1, 0), playerId, 8000), { supply: { [playerId]: UPGRADE_SUPPLY_COST } });
    const stillTunbin = chooseBotIntent(landOn(richWithGrain, playerId, BATTLE_A).state, playerId);
    expect((stillTunbin as { payload: Record<string, JsonValue> }).payload.kind).toBe('tunbin');

    // 粮草已满 12：不再摆屯兵，充裕现金下应转为升级。
    const capped = withSanguo(setCash(ownProperty(base, playerId, 1, 0), playerId, 8000), { supply: { [playerId]: SUPPLY_CAP } });
    const cappedDecision = chooseBotIntent(landOn(capped, playerId, BATTLE_A).state, playerId);
    expect((cappedDecision as { payload: Record<string, JsonValue> }).payload.kind).toBe('upgrade');
  });

  it('hydrate 严格校验三张计数表：键必须是存活玩家、值必须正且不超上限', () => {
    const base = makeGame();
    const valid = {
      supplyByPlayerId: { p1: SUPPLY_CAP },
      battleShieldByPlayerId: { p1: 2 },
      incenseByPlayerId: { p1: 1 },
    };
    expect(validateSanguoPublicModuleState(valid, base.players)).toBe(true);

    // 键指向不存在的玩家。
    expect(validateSanguoPublicModuleState(
      { ...valid, supplyByPlayerId: { ghost: 1 } },
      base.players,
    )).toBe(false);
    // 值超上限（否则损坏存档里的天文数字会让每次落战场都派发巨额香火钱）。
    expect(validateSanguoPublicModuleState(
      { ...valid, supplyByPlayerId: { p1: SUPPLY_CAP + 1 } },
      base.players,
    )).toBe(false);
    expect(validateSanguoPublicModuleState(
      { ...valid, battleShieldByPlayerId: { p1: 3 } },
      base.players,
    )).toBe(false);
    // 功德祠一人一炷： incense 记 2 属于损坏存档。
    expect(validateSanguoPublicModuleState(
      { ...valid, incenseByPlayerId: { p1: 2 } },
      base.players,
    )).toBe(false);
    // 缺键 / 多键 / 非整数 / 非正数。
    expect(validateSanguoPublicModuleState(
      { supplyByPlayerId: {}, battleShieldByPlayerId: {} },
      base.players,
    )).toBe(false);
    expect(validateSanguoPublicModuleState(
      { ...valid, supplyByPlayerId: {}, battleShieldByPlayerId: {}, incenseByPlayerId: {}, extra: 1 },
      base.players,
    )).toBe(false);
    expect(validateSanguoPublicModuleState(
      { ...valid, supplyByPlayerId: { p1: 1.5 } },
      base.players,
    )).toBe(false);
    expect(validateSanguoPublicModuleState(
      { ...valid, supplyByPlayerId: { p1: 0 } },
      base.players,
    )).toBe(false);

    // 走真实 hydrate：合法存档必须原样恢复。
    const state: GameState = {
      ...base,
      publicRuleState: {
        modules: { [SANGUO_MODULE_KEY]: valid },
        pendingActions: [],
      },
    };
    expect(hydrateGameState(state, sanguoTourMap).ok).toBe(true);
  });
});
