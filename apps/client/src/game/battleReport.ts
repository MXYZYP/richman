/**
 * 一局战报：把结算数据写成一段**能直接粘进聊天窗口**的人话。
 *
 * 为什么不是再做一个回放入口：`ReplayDialog` 已经能做「导出整局码 / 导入回看 / 下载」，
 * 但那段码动辄几千字符，聊天窗口一粘就截断，实际没人会拿它分享。战报补的是另一件事：
 * 一眼能读完的**结论**（谁赢了、打了多久、各家终局如何），想复盘再走复盘码。
 *
 * 两条刻意约束：
 *  - **金额格式由调用方注入**（`formatAsset`）：货币单位随地图变（「两」/「金币」），
 *    唯一事实源是 `ui/format.ts`，这里绝不自己拼单位，也不 import 那份带全局状态的模块。
 *  - 只输出纯文本、不含 HTML：战报是要被粘到聊天/备忘录里的。
 */

export interface BattleReportPlayer {
  readonly name: string;
  /** 终局现金（破产者给 0 也行，文案会按 isBankrupt 处理）。 */
  readonly cash: number;
  readonly isWinner: boolean;
  readonly isBankrupt: boolean;
  readonly isBot: boolean;
  /** 该玩家撑过的回合数；用于给冠军那行标注「打了多久」。 */
  readonly survivedTurns: number;
  readonly propertyCount: number;
}

export interface BattleReportInput {
  readonly mapTitle: string;
  readonly players: readonly BattleReportPlayer[];
  /** 结束原因（结算里那句人话）；没有就省略这一行。 */
  readonly reason?: string;
  /** 金额格式化：由调用方注入（通常是 `formatCash`），保证单位与全局设置一致。 */
  readonly formatAsset: (value: number) => string;
}

function rankLines(players: readonly BattleReportPlayer[], formatAsset: (value: number) => string): string[] {
  // 冠军排最前，其余按现金降序；与结算表同一套观感（结算表里冠军也是第一行）。
  const ordered = [...players].sort((left, right) => {
    if (left.isWinner !== right.isWinner) return left.isWinner ? -1 : 1;
    return right.cash - left.cash;
  });
  return ordered.map((player, index) => {
    const money = player.isBankrupt ? '破产出局' : formatAsset(player.cash);
    const houses = player.propertyCount > 0 ? `　${player.propertyCount} 处地产` : '';
    const tag = player.isBot ? '（电脑）' : '';
    return `${index + 1}. ${player.name}${tag}　${money}${houses}`;
  });
}

export function buildBattleReport(input: BattleReportInput): string {
  const lines: string[] = [];
  lines.push(`【大富翁游戏棋 · ${input.mapTitle}】战报`);

  const winner = input.players.find((player) => player.isWinner) ?? null;
  if (winner !== null) {
    const turns = Number.isFinite(winner.survivedTurns) && winner.survivedTurns > 0
      ? `，第 ${Math.floor(winner.survivedTurns)} 回合分出胜负`
      : '';
    lines.push(`冠军：${winner.name}${turns}`);
  } else {
    lines.push('本局无人夺冠（所有人破产或提前结束）');
  }

  if (input.players.length > 0) {
    lines.push('名次：');
    lines.push(...rankLines(input.players, input.formatAsset));
  }

  const reason = input.reason?.trim();
  if (reason !== undefined && reason.length > 0) lines.push(reason);

  lines.push('—— 由「大富翁游戏棋」生成，复盘与约局：game.mxyzyp.xyz');
  return lines.join('\n');
}
