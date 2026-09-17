// 随机自弈仿真骨架（03 §4.4 合法性保证 + M2 收尾验证）
// 全 bot 对局：每个决策点由 chooseBotIntent 出招、applyIntent 结算。
// 验证三类不变量：
//   1. 合法性——bot 的每个 intent 必须被 applyIntent 接受（ok===true）；
//   2. 现金守恒——sum(玩家现金) + bankBalance === initialCash × 人数，每步成立；
//      bankBalance 仅由事件求和得到（事件已补全金额，无需反推状态/卡牌）；
//   3. 终局——每局在 MAX_TURNS 内达到 game_over（cashGoal=null 局可能撞上限，如实记录）。
import { createGame, applyIntent } from './engine';
import { chooseBotIntent } from './bot';
import { getActiveMapPack } from '@richman/board-data';
import type { MapPack, MapRef } from '@richman/board-data';
import type { GameEvent } from './types';
import { pathToFileURL } from 'node:url';

const simulationMap = getActiveMapPack('china-tour');

/** 单局最多执行的意图数；兼容世界之旅的合法长局，同时保留有限的防死循环上限。 */
export const MAX_TURNS = 10_000;

export interface GameConfig {
  seed: string;
  playerCount: number;
  cashGoal: number | null;
}

export interface GameResult {
  config: GameConfig;
  mapRef: MapRef;
  terminated: boolean;            // 是否达到 game_over
  turns: number;                  // 实际施加的意图数
  winReason: string | null;       // last_standing / cash_goal / null(未终局)
  winnerId: string | null;
  illegalIntents: number;         // applyIntent 拒绝的意图数（应为 0）
  conservationViolations: number; // 现金守恒被打破的步数（应为 0）
  exception: string | null;       // 抛出的异常（应为 null）
}

/** 单个事件对银行余额的影响（+= 钱进银行，-= 钱出银行）。事件金额已补全，纯求和。 */
function bankDelta(e: GameEvent, mapPack: MapPack): number {
  switch (e.type) {
    case 'salary_collected':
      return -e.amount;
    case 'property_bought':
      return +e.price;
    case 'tax_paid':
      return +e.amount;
    case 'bank_paid': // 玩家付银行（pay_bank / repairs）
      return +e.amount;
    case 'bank_received': // 玩家收银行（receive_bank）
      return -e.amount;
    case 'property_sold':
      return -e.amount;
    case 'property_mortgaged':
      return -e.amount;
    case 'property_redeemed':
      return +e.amount;
    case 'house_built':
      return +e.amount;
    case 'house_sold': {
      const cell = mapPack.game.board.cells.find((c) => c.id === e.cellId) as
        | { houseCost?: number }
        | undefined;
      return -Math.round((cell?.houseCost ?? 0) * mapPack.game.config.sellHouseRefundRate);
    }
    case 'debt_resolved': // creditorId=null 表示还银行
      return e.creditorId === null ? +e.amount : 0;
    case 'player_bankrupt': // creditorId=null 表示破产现金缴银行
      return e.creditorId === null ? +e.transferredCash : 0;
    case 'payment_made': // to=null 表示付银行；from=null 表示银行付（当前卡组不会，防御）
      return e.to === null ? +e.amount : e.from === null ? -e.amount : 0;
    default: // rent_paid（玩家间）、debt_entered（无现金移动）、移动/回合/日志类
      return 0;
  }
}

/** 跑一局全 bot 对局，返回完整结果（含不变量校验）。纯函数：同 config 必同结果。 */
export function runGame(
  config: GameConfig,
  maxTurns: number = MAX_TURNS,
  mapPack: MapPack = simulationMap,
): GameResult {
  const players = Array.from({ length: config.playerCount }, (_, i) => ({
    id: `b${i + 1}`,
    nickname: `电脑${i + 1}`,
    isBot: true,
  }));

  let state = createGame({
    board: mapPack.game.board,
    cards: mapPack.game.cards,
    config: mapPack.game.config,
    mapRef: mapPack.ref,
    ruleModules: mapPack.game.requiredRuleModules,
    players,
    seed: config.seed,
    cashGoal: config.cashGoal,
  });

  const initialTotal = mapPack.game.config.initialCash * config.playerCount;
  let bankBalance = 0;
  let illegalIntents = 0;
  let conservationViolations = 0;
  let turns = 0;
  let exception: string | null = null;

  try {
    while (state.phase !== 'game_over' && turns < maxTurns) {
      // 修正2（设计评审）：E15 队列下债务人可能不是当前玩家
      const actor = state.debt?.debtorId ?? state.currentPlayerId;
      const intent = chooseBotIntent(state, actor);
      const result = applyIntent(state, actor, intent);
      if (!result.ok) {
        illegalIntents++;
        break;
      }

      // 对账：本步事件求和累计银行余额
      for (const e of result.events) bankBalance += bankDelta(e, mapPack);

      state = result.state;
      turns++;

      // 现金守恒不变量
      const totalCash = state.players.reduce((sum, p) => sum + p.cash, 0);
      if (totalCash + bankBalance !== initialTotal) {
        conservationViolations++;
      }
    }
  } catch (err) {
    exception = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }

  const winEvent = state.recentLog.find((e) => e.type === 'game_over') as
    | { type: 'game_over'; winnerId: string; reason: string }
    | undefined;

  return {
    config,
    mapRef: mapPack.ref,
    terminated: state.phase === 'game_over',
    turns,
    winReason: winEvent?.reason ?? null,
    winnerId: state.winnerId,
    illegalIntents,
    conservationViolations,
    exception,
  };
}

export interface SimulationStats {
  totalGames: number;
  terminated: number;
  terminatedRate: number;
  avgTurns: number;
  medianTurns: number;
  maxTurns: number;
  winReasons: Record<string, number>;
  illegalIntents: number;
  conservationViolations: number;
  exceptions: number;
  failures: GameResult[]; // 任何不变量被打破或未终局的局
}

/** 跑多局并汇总统计。failureTriple：失败局报 (seed, 人数, cashGoal) 便于复现。 */
export function runSimulation(configs: GameConfig[], mapPack: MapPack = simulationMap): SimulationStats {
  // 注意：不能写 configs.map(runGame)，Array.map 会把 index 作为第二参数传入，
  // 误覆盖 runGame 的 maxTurns，导致第 0/1/2 局上限分别变成 0/1/2。
  const results = configs.map((config) => runGame(config, MAX_TURNS, mapPack));

  const terminated = results.filter((r) => r.terminated);
  const turnCounts = results.map((r) => r.turns).sort((a, b) => a - b);
  const winReasons: Record<string, number> = {};
  for (const r of results) {
    const key = r.winReason ?? 'non_terminated';
    winReasons[key] = (winReasons[key] ?? 0) + 1;
  }

  const failures = results.filter(
    (r) => !r.terminated || r.illegalIntents > 0 || r.conservationViolations > 0 || r.exception,
  );

  const mid = Math.floor(turnCounts.length / 2);
  return {
    totalGames: results.length,
    terminated: terminated.length,
    terminatedRate: terminated.length / results.length,
    avgTurns: turnCounts.reduce((a, b) => a + b, 0) / turnCounts.length,
    medianTurns: turnCounts.length % 2 === 0 ? (turnCounts[mid - 1] + turnCounts[mid]) / 2 : turnCounts[mid],
    maxTurns: turnCounts[turnCounts.length - 1],
    winReasons,
    illegalIntents: results.reduce((s, r) => s + r.illegalIntents, 0),
    conservationViolations: results.reduce((s, r) => s + r.conservationViolations, 0),
    exceptions: results.filter((r) => r.exception).length,
    failures,
  };
}

/** 生成随机配置：人数 ∈ {2,3,4}、cashGoal ∈ {null,30000,50000}、seed 唯一 */
export function randomConfigs(count: number, seedOffset = 0): GameConfig[] {
  const configs: GameConfig[] = [];
  for (let i = 0; i < count; i++) {
    const playerCount = 2 + ((seedOffset + i) % 3); // 轮转 2/3/4
    const goalPicker = Math.floor((seedOffset + i) / 3) % 3;
    const cashGoal: number | null = goalPicker === 0 ? null : goalPicker === 1 ? 30000 : 50000;
    configs.push({ seed: `sim-${seedOffset + i}`, playerCount, cashGoal });
  }
  return configs;
}

// 直接运行时跑 500 局并打印统计（ESM 入口判断）
const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  const mapId = process.argv[2] ?? 'china-tour';
  const mapPack = getActiveMapPack(mapId);
  const configs = randomConfigs(500);
  const stats = runSimulation(configs, mapPack);
  // eslint-disable-next-line no-console
  console.log(`=== 随机自弈仿真（${mapPack.ref.id}@${mapPack.ref.version}，500 局）===`);
  console.log(`总局数: ${stats.totalGames}`);
  console.log(`终局: ${stats.terminated} (${(stats.terminatedRate * 100).toFixed(1)}%)`);
  console.log(`平均局长: ${stats.avgTurns.toFixed(1)} 意图`);
  console.log(`中位局长: ${stats.medianTurns} 意图`);
  console.log(`最大局长: ${stats.maxTurns} 意图`);
  console.log(`胜利原因分布: ${JSON.stringify(stats.winReasons)}`);
  console.log(`非法意图总数: ${stats.illegalIntents}`);
  console.log(`现金守恒违例总数: ${stats.conservationViolations}`);
  console.log(`异常总数: ${stats.exceptions}`);
  console.log(`失败局数: ${stats.failures.length}`);
  if (stats.failures.length > 0 && stats.failures.length <= 20) {
    for (const f of stats.failures) {
      console.log(
        `  失败 (seed=${f.config.seed}, 人数=${f.config.playerCount}, cashGoal=${f.config.cashGoal}): ` +
          `terminated=${f.terminated} turns=${f.turns} illegal=${f.illegalIntents} ` +
          `conservation=${f.conservationViolations} exception=${f.exception ?? 'none'}`,
      );
    }
  }
}
