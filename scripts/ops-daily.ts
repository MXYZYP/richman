/**
 * 每日运营摘要（运营 O1）。
 *
 * 输入：`apps/server/.runtime/telemetry-YYYY-MM-DD.ndjson`（O0 埋点落的盘，一行一个事件）。
 * 输出：`.runtime/ops-daily-YYYY-MM-DD.md`，人直接能读的一段 markdown。
 *
 * 为什么是脚本而不是在线面板：这台机器上只有这一个进程和一个小目录，为了看一眼昨天的
 * 数字再起一个 Web 服务、再配一层鉴权，成本与风险都远大于收益。cron 每天跑一次写个文件，
 * 想看就 `cat`，要回溯就 `ls`。
 *
 * 用法：
 *   tsx scripts/ops-daily.ts                  # 默认：昨天
 *   tsx scripts/ops-daily.ts --date 2026-11-01
 *   tsx scripts/ops-daily.ts --dir /root/richman-main/apps/server/.runtime
 *
 * ★ 纯只读 + 只写一个新文件：不删、不改任何既有数据。重复跑是幂等的（同名文件覆盖）。
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface TelemetryLine {
  readonly id?: string;
  readonly name?: string;
  readonly t?: number;
  readonly props?: Record<string, unknown>;
}

export interface DailySummary {
  readonly date: string;
  /** 当天出现的匿名 id 数（DAU）。 */
  readonly activeIds: number;
  /** 当天首次出现的匿名 id 数（新玩家）。 */
  readonly newIds: number;
  readonly opens: number;
  readonly starts: number;
  readonly startsLocal: number;
  readonly startsOnline: number;
  readonly ends: number;
  /** 结束局数 / 开局数；没有开局时为 null（不是 0 —— 0 会被误读成「全都没打完」）。 */
  readonly completionRate: number | null;
  readonly averageSeconds: number | null;
  readonly errors: number;
  readonly errorsBySource: Record<string, number>;
  /** 地图 → 开局数（降序）。 */
  readonly startsByMap: readonly (readonly [string, number])[];
}

function parseArgs(argv: readonly string[]): { date?: string; dir?: string } {
  const result: { date?: string; dir?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--date') result.date = argv[i + 1];
    else if (arg === '--dir') result.dir = argv[i + 1];
  }
  return result;
}

function dayKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 默认跑「昨天」：凌晨 4 点跑的时候，当天的数据还几乎不存在。 */
export function yesterdayKey(now: Date = new Date()): string {
  const previous = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return dayKey(previous);
}

function parseLines(raw: string): TelemetryLine[] {
  const lines: TelemetryLine[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) lines.push(parsed as TelemetryLine);
    } catch {
      // 坏行只坏一行：这是 ndjson 相对「整个 JSON 数组」最大的好处，跳过即可。
    }
  }
  return lines;
}

async function readDay(dir: string, date: string): Promise<TelemetryLine[]> {
  const raw = await readFile(join(dir, `telemetry-${date}.ndjson`), 'utf8').catch(() => '');
  return parseLines(raw);
}

/** 当天之前出现过的全部 id —— 「新玩家」的判据。只读不看内容，最多往前看 30 天。 */
async function knownIdsBefore(dir: string, date: string): Promise<Set<string>> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const files = entries
    .filter((name) => name.startsWith('telemetry-') && name.endsWith('.ndjson'))
    .filter((name) => name.slice('telemetry-'.length, -'.ndjson'.length) < date)
    .sort()
    .slice(-30);

  const ids = new Set<string>();
  for (const file of files) {
    const raw = await readFile(join(dir, file), 'utf8').catch(() => '');
    for (const line of parseLines(raw)) {
      if (typeof line.id === 'string') ids.add(line.id);
    }
  }
  return ids;
}

function numberProp(props: Record<string, unknown> | undefined, key: string): number | null {
  const value = props?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringProp(props: Record<string, unknown> | undefined, key: string): string | null {
  const value = props?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function summarize(date: string, lines: readonly TelemetryLine[], knownIds: ReadonlySet<string>): DailySummary {
  const todayIds = new Set<string>();
  const errorsBySource: Record<string, number> = {};
  const startsByMap = new Map<string, number>();
  let opens = 0;
  let starts = 0;
  let startsLocal = 0;
  let startsOnline = 0;
  let ends = 0;
  let totalSeconds = 0;
  let timedEnds = 0;
  let errors = 0;

  for (const line of lines) {
    if (typeof line.id === 'string') todayIds.add(line.id);

    switch (line.name) {
      case 'app_open':
        opens += 1;
        break;
      case 'game_start': {
        starts += 1;
        const mode = stringProp(line.props, 'mode');
        if (mode === 'local') startsLocal += 1;
        else if (mode === 'online') startsOnline += 1;
        const map = stringProp(line.props, 'map');
        if (map !== null) startsByMap.set(map, (startsByMap.get(map) ?? 0) + 1);
        break;
      }
      case 'game_end': {
        ends += 1;
        const seconds = numberProp(line.props, 'seconds');
        if (seconds !== null && seconds >= 0) {
          totalSeconds += seconds;
          timedEnds += 1;
        }
        break;
      }
      case 'app_error': {
        errors += 1;
        const source = stringProp(line.props, 'source') ?? 'unknown';
        errorsBySource[source] = (errorsBySource[source] ?? 0) + 1;
        break;
      }
      default:
        break;
    }
  }

  let newIds = 0;
  for (const id of todayIds) {
    if (!knownIds.has(id)) newIds += 1;
  }

  return {
    date,
    activeIds: todayIds.size,
    newIds,
    opens,
    starts,
    startsLocal,
    startsOnline,
    ends,
    completionRate: starts === 0 ? null : ends / starts,
    averageSeconds: timedEnds === 0 ? null : Math.round(totalSeconds / timedEnds),
    errors,
    errorsBySource,
    startsByMap: [...startsByMap.entries()].sort((a, b) => b[1] - a[1]),
  };
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}

function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export function renderSummaryMarkdown(summary: DailySummary): string {
  const lines: string[] = [];
  lines.push(`# 运营日报 ${summary.date}`, '');
  lines.push(`- 活跃玩家（当天出现过的匿名编号）：${summary.activeIds}`);
  lines.push(`- 新玩家（此前 30 天内没出现过）：${summary.newIds}`);
  lines.push(`- 打开次数：${summary.opens}`);
  lines.push(`- 开局：${summary.starts}（单机 ${summary.startsLocal} / 联机 ${summary.startsOnline}）`);
  lines.push(`- 打完：${summary.ends}`);
  lines.push(
    `- 完成率：${summary.completionRate === null ? '—（当天没有开局）' : formatPercent(summary.completionRate)}`,
  );
  lines.push(
    `- 平均时长：${summary.averageSeconds === null ? '—（当天没有打完的局）' : formatDuration(summary.averageSeconds)}`,
  );
  lines.push(`- 错误：${summary.errors}`);
  lines.push('');

  const sources = Object.entries(summary.errorsBySource);
  if (sources.length > 0) {
    lines.push('## 错误来源', '');
    lines.push('| 来源 | 次数 |');
    lines.push('| --- | --- |');
    for (const [source, count] of sources) lines.push(`| ${source} | ${count} |`);
    lines.push('');
  }

  if (summary.startsByMap.length > 0) {
    lines.push('## 地图分布（按开局数）', '');
    lines.push('| 地图 | 开局 |');
    lines.push('| --- | --- |');
    for (const [map, count] of summary.startsByMap) lines.push(`| ${map} | ${count} |`);
    lines.push('');
  }

  lines.push('---', '');
  lines.push('口径：匿名编号随机生成、与昵称账号无关；完成率 = 打完局数 / 开局数；');
  lines.push('「没有打完」包含中途退出与切后台，不等于失败。', '');

  return lines.join('\n');
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const dir = args.dir ?? join(process.cwd(), 'apps', 'server', '.runtime');
  const date = args.date ?? yesterdayKey();

  const lines = await readDay(dir, date);
  const knownIds = await knownIdsBefore(dir, date);
  const summary = summarize(date, lines, knownIds);
  const markdown = renderSummaryMarkdown(summary);
  const output = join(dir, `ops-daily-${date}.md`);
  await writeFile(output, markdown, 'utf8');

  console.log(`[ops-daily] ${output}`);
  console.log(
    `[ops-daily] ${date}: 活跃 ${summary.activeIds} / 新 ${summary.newIds}`
    + ` / 开局 ${summary.starts} / 打完 ${summary.ends} / 错误 ${summary.errors}`,
  );
}

if (process.argv[1] !== undefined && /ops-daily\.ts$/.test(process.argv[1])) {
  void main();
}
