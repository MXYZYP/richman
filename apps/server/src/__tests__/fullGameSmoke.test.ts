/**
 * 服务端「整局冒烟」回归测试（路线图 H / #19 E2E 冒烟的 node 版）。
 *
 * 为什么需要这个文件
 * ------------------
 * 线上曾出现「联网对局永久卡在『电脑 B 行动中』、玩家无法掷骰」。根因是
 * apps/server/src/game/gameRuntime.ts 使用了 defaultRuleModuleRegistry 却从未 import，
 * 抛出的 ReferenceError 只在「自动化真正跑到那条代码路径」时才发生，被 roomManager 的
 * catch 吞掉后清空了自动化 → 整局冻结。
 *
 * 为什么既有测试拦不住
 * --------------------
 * 1. 服务端用 tsx 直跑 TS、不做类型检查（该问题在构建期完全静默）；
 * 2. 既有的 socket / roomManager 测试大多注入「假网关」，根本不经过真实 gameRuntime；
 * 3. 少数用真实网关的测试只跑「一拍」，不跑到终局，因此看不到停滞；
 * 4. 引擎侧的 runGame 仿真只调 chooseBotIntent(state, actor)，绕开了服务端网关与自动化调度。
 *
 * 本测试的做法
 * ------------
 * 用**真实 defaultGameGateway + 真实地图**，让 RoomManager 自己的自动化把一整局跑到
 * game_over，并断言三件事：
 *   - 服务端错误回调（onServerError）全程零调用；
 *   - 全程不出现「没有可用计时器但游戏尚未结束」的停滞；
 *   - 在步数预算内真正结束（且确实打了足够多步，不是空局）。
 * 覆盖两条曾经出错、且最容易再次出错的路径：
 *   - bot 决策：gateway.chooseBotIntent（gameRuntime.ts 第 22 行）；
 *   - 离线托管：chooseTakeoverIntent（gameRuntime.ts 第 261 行）。
 */
import { describe, expect, test } from 'vitest';
import type { BotDifficulty, GameState } from '@richman/engine';
import { RoomManager } from '../rooms/roomManager';
import type { RoomDomainEvent, RoomManagerDependencies } from '../rooms/roomTypes';
import { defaultGameGateway, type GameRuntimeGateway } from '../game/gameRuntime';

/** 座位数：1 名真人 + 3 名电脑。 */
const SEATS = 4;
/** 单局步数上限：一次「自动化拍」记一步；足够跑完一局长局，同时保证测试必然收敛。 */
const STEP_BUDGET = 40_000;
/** 一局至少应打这么多步，否则视为「空局」而非真实推进。 */
const MIN_MEANINGFUL_STEPS = 10;
/** 整局冒烟比普通单测慢得多，单独放宽超时。 */
const SMOKE_TIMEOUT_MS = 120_000;

type TestTimer = { active: boolean; delayMs: number; run(): void };

interface Harness {
  manager: RoomManager<TestTimer>;
  timers: TestTimer[];
  serverErrors: { message: string; error: unknown }[];
  asyncEvents: RoomDomainEvent[];
}

interface StartedRoom {
  roomCode: string;
  hostId: string;
}

interface DriveResult {
  steps: number;
  finalTurn: number;
  /** 非 null 表示在第几步发现「无可用计时器但游戏未结束」——即停滞。 */
  stalledAtStep: number | null;
  state: GameState | null;
}

function createHarness(seed: string, gameGateway?: GameRuntimeGateway): Harness {
  const timers: TestTimer[] = [];
  const serverErrors: { message: string; error: unknown }[] = [];
  const asyncEvents: RoomDomainEvent[] = [];
  let playerNumber = 0;
  let tokenNumber = 0;

  const dependencies: RoomManagerDependencies<TestTimer> = {
    generatePlayerId: () => `p${playerNumber++}`,
    generateToken: () => `tok-${tokenNumber++}`,
    nextRoomNumber: () => 7,
    compareTokens: (actual, supplied) => actual === supplied,
    setTimer(callback, delayMs) {
      const timer: TestTimer = {
        active: true,
        delayMs,
        run() {
          if (!timer.active) return;
          timer.active = false;
          callback();
        },
      };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.active = false;
    },
    onAsyncEvents(events) {
      asyncEvents.push(...events);
    },
    generateGameSeed: () => seed,
    // 延迟本身无关紧要：计时器由测试手动 run，无需真实等待。
    nextAutomationDelayMs: () => 1_000,
    onServerError(message, error) {
      serverErrors.push({ message, error });
    },
    gameGateway,
  };

  return { manager: new RoomManager<TestTimer>(dependencies), timers, serverErrors, asyncEvents };
}

/**
 * 建房 → 补满电脑 → 开局 → 房主掉线。
 * 房主掉线后由服务端自动托管，于是所有座位都由自动化驱动，整局可以无人干预地跑完。
 *
 * `options.auctionOnDecline` 在开局前通过房间设置打开（#106）：它必须在 `startRoom` 之前写进去，
 * 因为 `createInitialGame` 只在开局那一刻把房规固化进引擎状态。
 */
function startAutomatedRoom(
  harness: Harness,
  mapId: string,
  options: { auctionOnDecline?: boolean } = {},
): StartedRoom {
  const created = harness.manager.createRoom('房主', mapId);
  if (!created.ok) throw new Error(`createRoom 失败：${created.code} ${created.message}`);
  const { roomCode, playerId: hostId } = created.value;

  if (options.auctionOnDecline !== undefined) {
    const updated = harness.manager.updateRoomSettings(roomCode, hostId, {
      auctionOnDecline: options.auctionOnDecline,
    });
    if (!updated.ok) throw new Error(`updateRoomSettings 失败：${updated.code} ${updated.message}`);
  }

  for (let seat = 1; seat < SEATS; seat += 1) {
    const added = harness.manager.addBot(roomCode, hostId);
    if (!added.ok) throw new Error(`addBot 失败：${added.code} ${added.message}`);
  }

  const started = harness.manager.startRoom(roomCode, hostId);
  if (!started.ok) throw new Error(`startRoom 失败：${started.code} ${started.message}`);
  // 开局快照必须存在且处于 playing：真实网关若在建局阶段就出问题，在这里立刻暴露。
  const startedState = startingStateOf(started.events);
  if (startedState.phase !== 'playing') throw new Error(`开局相位异常：${startedState.phase}`);

  const disconnected = harness.manager.markDisconnected(roomCode, hostId);
  if (!disconnected.ok) throw new Error(`markDisconnected 失败：${disconnected.code} ${disconnected.message}`);

  return { roomCode, hostId };
}

function startingStateOf(events: RoomDomainEvent[]): GameState {
  const snapshot = events.find((event) => event.type === 'game_snapshot');
  if (snapshot === undefined || snapshot.type !== 'game_snapshot') {
    throw new Error('startRoom 未产出 game_snapshot 事件');
  }
  return snapshot.state;
}

/**
 * 反复唤起「当前仍活跃的计时器」，直到游戏结束或出现停滞。
 * 取最后一个活跃计时器：掉线托管有 15s 宽限计时器，自动化还有自己的调度计时器，
 * 最新的那个总是当前真正待执行的工作。
 */
function driveAutomation(harness: Harness, roomCode: string): DriveResult {
  const { manager, timers } = harness;
  for (let step = 1; step <= STEP_BUDGET; step += 1) {
    const state = manager.getGameSnapshot(roomCode);
    if (state === null) throw new Error(`房间 ${roomCode} 缺少权威快照`);
    if (state.phase === 'game_over') {
      return { steps: step - 1, finalTurn: state.turn, stalledAtStep: null, state };
    }
    const timer = [...timers].reverse().find((candidate) => candidate.active);
    if (timer === undefined) {
      return { steps: step - 1, finalTurn: state.turn, stalledAtStep: step, state };
    }
    timer.run();
  }
  const state = manager.getGameSnapshot(roomCode);
  return { steps: STEP_BUDGET, finalTurn: state?.turn ?? -1, stalledAtStep: null, state };
}

/** 包一层真实网关，让 bot 决策按指定次数抛错，用于验证自愈与有界放弃。 */
function gatewayWithBotIntentFailures(failures: number): GameRuntimeGateway {
  let remaining = failures;
  return {
    ...defaultGameGateway,
    chooseBotIntent(state: GameState, playerId: string, difficulty?: BotDifficulty) {
      if (remaining > 0) {
        remaining -= 1;
        throw new Error('注入的 bot 决策异常（整局冒烟回归测试用）');
      }
      return defaultGameGateway.chooseBotIntent(state, playerId, difficulty);
    },
  };
}

describe('服务端整局冒烟：真实网关 + 真实地图', () => {
  // 逐张覆盖「会走特化规则模块 / 大盘几何」的地图：
  //   world-tour  → 世界巡游（机场等待 + 待选动作）
  //   great-wall  → 烽火台（占据待选动作 + 通行费 + beacon-patrol 卡）
  //   silk-road   → 此前未覆盖的大盘（纯 core，用于兜住地图几何差异）
  //   classic-tour→ 61 格环形老盘（纯 core，补上最后一张未跑的图）
  //   yellow-river→ 64 格螺旋大盘（纯 core、格数最多，继续兜住几何差异）
  //   yangtze-tour→ 54 格纵向蛇行盘（纯 core，首个「竖向铺开」几何，也是首张渡口 4 座的新图）
  //   pearl-tour  → 48 格三角洲三角形环（纯 core，首个「斜边收拢」的三角形环路几何）
  //   xinjiang-tour→ 46 格环形 + 「独库公路」6 格支线（纯 core，首个 core 版机场等待 + 支线掷骰，且渡口只有 3 座）
  //   shanxi-tour → 48 格 6×8 横向蛇形网格（纯 core，无机场无支线的大盘，渡口 3 座）
  //   northeast-tour → 48 格 6×8 蛇形网格 + prison@1（首个监狱图：进牢格 / 唯一监狱角格 /
  //                   掷骰出狱 / 出狱许可证 / 保释金，托管玩家必须能自己走出监狱）
  // 十一张正式地图在此清单里各跑一局：新增地图时务必加进来，否则它会「能选但从没被整局跑过」。
  for (const mapId of ['china-tour', 'world-tour', 'classic-tour', 'great-wall', 'silk-road', 'yellow-river', 'yangtze-tour', 'pearl-tour', 'xinjiang-tour', 'shanxi-tour', 'northeast-tour'] as const) {
    test(
      `${mapId}：自动化托管把一整局推进到 game_over，且服务端零错误、全程不卡死`,
      () => {
        const harness = createHarness(`smoke-${mapId}`);
        const room = startAutomatedRoom(harness, mapId);

        const result = driveAutomation(harness, room.roomCode);

        // 真实网关一旦缺 import / 逻辑出错，这里会先炸出来（正是线上事故的形态）。
        expect(harness.serverErrors).toEqual([]);
        expect(result.stalledAtStep).toBeNull();
        expect(result.state?.phase).toBe('game_over');
        expect(harness.manager.getPublicRoom(room.roomCode)?.status).toBe('ended');
        // 确实打了足够多步，证明是真实对局推进而非空局立即结束。
        expect(result.steps).toBeGreaterThan(MIN_MEANINGFUL_STEPS);
        expect(result.finalTurn).toBeGreaterThan(0);
      },
      SMOKE_TIMEOUT_MS,
    );
  }

  test(
    '开启「放弃购买即拍卖」后整局依然无人干预跑到终局，且拍卖确实发生过（#106）',
    () => {
      const harness = createHarness('smoke-auction-on-decline');
      const room = startAutomatedRoom(harness, 'china-tour', { auctionOnDecline: true });

      const result = driveAutomation(harness, room.roomCode);

      // 这一段同时兜住两件事：
      //  1) 拍卖能收敛（不会因为「没人再加价」而卡在 awaiting_auction_bid）；
      //  2) `#engineActor` 在拍卖阶段返回的是叫价者——否则服务端根本不会为下一位叫价者
      //     排期自动化，driveAutomation 会当场报 stalledAtStep，而不是安静地跑到终局。
      expect(harness.serverErrors).toEqual([]);
      expect(result.stalledAtStep).toBeNull();
      expect(result.state?.phase).toBe('game_over');

      // 电脑在现金不够留底时会放弃购买，因此这条房规下必然出现真实拍卖。
      // 若一条都没出现，说明房规没有真正传到引擎（而不是「恰好没触发」）。
      const auctionEvents = harness.asyncEvents
        .filter((event) => event.type === 'game_events')
        .flatMap((event) => (event.type === 'game_events' ? event.events : []))
        .filter((event) => event.type === 'auction_started');
      expect(auctionEvents.length).toBeGreaterThan(0);
    },
    SMOKE_TIMEOUT_MS,
  );

  test(
    'bot 决策异常后有界自愈：恢复后仍能跑到终局，不再永久冻结',
    () => {
      const harness = createHarness('smoke-self-heal', gatewayWithBotIntentFailures(2));
      const room = startAutomatedRoom(harness, 'china-tour');

      const result = driveAutomation(harness, room.roomCode);

      // 失败次数未超过自愈上限，因此不放弃、不上报服务端错误，对局继续推进到终局。
      expect(harness.serverErrors).toEqual([]);
      expect(result.stalledAtStep).toBeNull();
      expect(result.state?.phase).toBe('game_over');
    },
    SMOKE_TIMEOUT_MS,
  );

  test(
    'bot 决策永久异常时按上限放弃：有界、不无限空转，并上报一次服务端错误',
    () => {
      const harness = createHarness('smoke-give-up', gatewayWithBotIntentFailures(Number.POSITIVE_INFINITY));
      const room = startAutomatedRoom(harness, 'china-tour');

      const result = driveAutomation(harness, room.roomCode);

      // 有界放弃的契约：最终停滞（自动化被清空），但只上报一次、且很快发生。
      expect(result.stalledAtStep).not.toBeNull();
      expect(result.state?.phase).not.toBe('game_over');
      expect(harness.serverErrors).toHaveLength(1);
      expect(harness.serverErrors[0]?.message).toContain('automation choose intent threw');
      expect(result.steps).toBeLessThan(100);
    },
    SMOKE_TIMEOUT_MS,
  );
});
