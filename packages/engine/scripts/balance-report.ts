// 平衡性仿真报告（P2）：全部正式地图 × bot 自弈，跨图对比 + 座次胜率。
// 复用 src/simulate 的 runGame（含合法性/现金守恒/异常三类硬不变量校验）。
// 用法：node_modules/tsx/dist/cli.mjs packages/engine/scripts/balance-report.ts [每图局数，默认 120]
// 输出：每图 终局率 / 局长 / 终局原因分布 / 座次胜率 / 不变量违例。
import { runGame, randomConfigs, MAX_TURNS } from '../src/simulate';
import { listActiveMaps, getActiveMapPack } from '@richman/board-data';
import type { GameResult } from '../src/simulate';

/** 单图汇总统计。 */
interface MapStats {
  mapId: string;
  games: number;
  terminatedRate: number;
  avgTurns: number;
  medianTurns: number;
  p90Turns: number;
  winReasons: Record<string, number>;
  seatWins: number[];          // 下标 0..3 对应 b1..b4
  seatGames: number[];         // 该座次在局里存在过的局数（按人数折算）
  illegal: number;
  conservation: number;
  exceptions: number;
}

function aggregate(mapId: string, results: GameResult[]): MapStats {
  const turns = results.map((r) => r.turns).sort((a, b) => a - b);
  const winReasons: Record<string, number> = {};
  const seatWins = [0, 0, 0, 0];
  const seatGames = [0, 0, 0, 0];
  for (const r of results) {
    const key = r.winReason ?? 'non_terminated';
    winReasons[key] = (winReasons[key] ?? 0) + 1;
    // 座次存在性：n 人局里 b1..bn 各计一局
    const n = r.config.playerCount;
    for (let i = 0; i < n; i++) seatGames[i] += 1;
    if (r.winnerId) {
      const idx = Number(r.winnerId.replace('b', '')) - 1;
      if (idx >= 0 && idx < 4) seatWins[idx] += 1;
    }
  }
  const mid = Math.floor(turns.length / 2);
  const p90 = turns[Math.min(turns.length - 1, Math.floor(turns.length * 0.9))];
  return {
    mapId,
    games: results.length,
    terminatedRate: results.filter((r) => r.terminated).length / results.length,
    avgTurns: turns.reduce((a, b) => a + b, 0) / turns.length,
    medianTurns: turns.length % 2 === 0 ? (turns[mid - 1] + turns[mid]) / 2 : turns[mid],
    p90Turns: p90,
    winReasons,
    seatWins,
    seatGames,
    illegal: results.reduce((s, r) => s + r.illegalIntents, 0),
    conservation: results.reduce((s, r) => s + r.conservationViolations, 0),
    exceptions: results.filter((r) => r.exception).length,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

async function main() {
  const games = Number(process.argv[2] ?? 120);
  if (!Number.isInteger(games) || games < 1) throw new Error(`局数须为 >=1 整数，实为 ${games}`);

  const entries = listActiveMaps();
  const all: MapStats[] = [];
  for (let m = 0; m < entries.length; m++) {
    const pack = getActiveMapPack(entries[m].ref.id);
    const configs = randomConfigs(games, m * 10000 + 7);
    // 用引擎语义跑满：goal=null 局由 D1 stalemate（10000 轮）收敛，
    // 别再让旧的意图数上限把长局拦腰截断成 non_terminated 假警报。
    const results = configs.map((config) => runGame(config, MAX_TURNS, pack));
    const stats = aggregate(pack.ref.id, results);
    all.push(stats);
    process.stdout.write(`[${m + 1}/${entries.length}] ${stats.mapId} 完成\n`);
  }

  console.log('\n=== 平衡性仿真报告（bot 自弈）===\n');
  console.log(
    '地图'.padEnd(14)
    + '局数'.padStart(5)
    + '终局率'.padStart(8)
    + '均长'.padStart(7)
    + '中位'.padStart(6)
    + 'P90'.padStart(6)
    + ' 先手胜率  终局原因分布',
  );
  for (const s of all) {
    const firstRate = s.seatGames[0] > 0 ? s.seatWins[0] / s.seatGames[0] : 0;
    const reasons = Object.entries(s.winReasons)
      .map(([k, v]) => `${k}:${v}`)
      .join(' ');
    console.log(
      s.mapId.padEnd(14)
      + String(s.games).padStart(5)
      + pct(s.terminatedRate).padStart(8)
      + s.avgTurns.toFixed(0).padStart(7)
      + String(s.medianTurns).padStart(6)
      + String(s.p90Turns).padStart(6)
      + `  ${pct(firstRate).padStart(7)}  ${reasons}`,
    );
  }

  const bad = all.filter((s) => s.illegal > 0 || s.conservation > 0 || s.exceptions > 0);
  if (bad.length > 0) {
    console.log('\n❌ 不变量违例（必须为 0）：');
    for (const s of bad) {
      console.log(`  ${s.mapId}: illegal=${s.illegal} conservation=${s.conservation} exceptions=${s.exceptions}`);
    }
  } else {
    console.log('\n✅ 全部地图三类硬不变量（合法性/现金守恒/无异常）均成立');
  }

  const fairness = all.filter((s) => s.seatGames[0] > 0 && s.seatWins[0] / s.seatGames[0] > 0.5);
  if (fairness.length > 0) {
    console.log('\n⚠️ 先手座次（b1）胜率超过 50%，疑似先手优势失衡：');
    for (const s of fairness) {
      console.log(`  ${s.mapId}: b1 胜率 ${pct(s.seatWins[0] / s.seatGames[0])}（${s.seatWins[0]}/${s.seatGames[0]}）`);
    }
  } else {
    console.log('✅ 无地图出现 b1 胜率 > 50% 的先手优势信号');
  }

  const stuck = all.filter((s) => (s.winReasons['non_terminated'] ?? 0) > 0 || (s.winReasons['stalemate'] ?? 0) > 0);
  if (stuck.length > 0) {
    console.log('\nℹ️ 撞意图上限/僵局终局的地图（收敛性观察，非缺陷）：');
    for (const s of stuck) {
      console.log(`  ${s.mapId}: non_terminated=${s.winReasons['non_terminated'] ?? 0} stalemate=${s.winReasons['stalemate'] ?? 0}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
