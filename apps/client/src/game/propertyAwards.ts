import type { RenderableGameState } from '../session/gameSession';
import { formatMoney } from '../ui/format';

// 本局地块奖项：纯派生，输入 RenderableGameState，输出最多三项奖项。
// 数据来源：
//   - 过路费累计：recentLog 中 rent_paid 事件按 cellId 汇总（engine 保留最近 200 条事件）
//   - 投入：地皮买入价 + 当前房屋等级 × 单栋造价（来自当前棋盘快照，始终完整）
// 仅在已产生过路费数据后评选，避免开局噪声。

export type PropertyAwardKind = 'mvp' | 'worst' | 'bestValue';

export interface PropertyAward {
  readonly kind: PropertyAwardKind;
  readonly title: string;
  readonly cellId: number;
  readonly cellName: string;
  readonly metric: string;
}

export interface PropertyAwards {
  readonly awards: readonly PropertyAward[];
}

interface PropertyRow {
  cellId: number;
  name: string;
  ownerId: string | null;
  investment: number;
  rentCollected: number;
}

export function getPropertyAwards(state: RenderableGameState): PropertyAwards {
  const rentByCell = new Map<number, number>();
  for (const event of state.recentLog) {
    if (event.type === 'rent_paid') {
      rentByCell.set(event.cellId, (rentByCell.get(event.cellId) ?? 0) + event.amount);
    }
  }

  const rows: PropertyRow[] = [];
  for (const cell of state.board.cells) {
    if (cell.type !== 'property') continue;
    const property = state.properties[cell.id];
    const houseCost = cell.houseCost ?? 0;
    const level = property?.level ?? 0;
    rows.push({
      cellId: cell.id,
      name: cell.name,
      ownerId: property?.ownerId ?? null,
      investment: (cell.price ?? 0) + houseCost * level,
      rentCollected: rentByCell.get(cell.id) ?? 0,
    });
  }

  const awards: PropertyAward[] = [];

  // 最有价值：收取过路费最高（需有实际收租记录；与当前归属无关——地块本身收得最多即得奖）
  let mvp: PropertyRow | null = null;
  for (const row of rows) {
    if (row.rentCollected > 0 && (mvp === null || row.rentCollected > mvp.rentCollected)) {
      mvp = row;
    }
  }
  if (mvp) {
    awards.push({
      kind: 'mvp',
      title: '最有价值',
      cellId: mvp.cellId,
      cellName: mvp.name,
      metric: `收租 ¥${formatMoney(mvp.rentCollected)}`,
    });
  } else {
    return { awards };
  }

  // 最不划算：投入 − 收租 差额最大（仅当前持有的可买地块；差额越大回报越差）
  let worst: PropertyRow | null = null;
  let worstGap = -Infinity;
  for (const row of rows) {
    if (row.ownerId === null || row.investment <= 0) continue;
    const gap = row.investment - row.rentCollected;
    if (gap > worstGap) {
      worstGap = gap;
      worst = row;
    }
  }
  if (worst) {
    awards.push({
      kind: 'worst',
      title: '最不划算',
      cellId: worst.cellId,
      cellName: worst.name,
      metric: `回本 ¥${formatMoney(worst.rentCollected)} / ¥${formatMoney(worst.investment)}`,
    });
  }

  // 性价比最高：收租 / 投入 比值最高（需已产生过路费）
  let best: PropertyRow | null = null;
  let bestRatio = -Infinity;
  for (const row of rows) {
    if (row.ownerId === null || row.investment <= 0 || row.rentCollected <= 0) continue;
    const ratio = row.rentCollected / row.investment;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = row;
    }
  }
  if (best) {
    awards.push({
      kind: 'bestValue',
      title: '性价比最高',
      cellId: best.cellId,
      cellName: best.name,
      metric: `回报 ×${(best.rentCollected / best.investment).toFixed(1)}`,
    });
  }

  return { awards };
}
