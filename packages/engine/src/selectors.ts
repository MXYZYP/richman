// 只读查询函数（03 §4 引用）：UI 复用以保证规则口径不分裂
// M2 步 4 实现 getCurrentRent；步 11 实现其余
import type { GameState, PropertyState } from './types';

type RentState = Pick<GameState, 'board' | 'properties' | 'lastDice' | 'config'>;

/** 计算当前某格的过路费（考虑等级/持有数/抵押状态/当次骰点）
 *  - 无主、自有时返回 0（实际调用方保证是他人地）
 *  - 抵押中返回 0（01 §6.1，E06）
 *  - utility 用 dice 参数；缺省取 state.lastDice（当次掷骰，01 §6.1） */
export function getCurrentRent(
  state: RentState,
  cellId: number,
  dice?: number[],
): number {
  const cell = state.board.cells.find((c) => c.id === cellId);
  if (!cell || cell.type !== 'property') return 0;
  const prop = state.properties[cellId];
  if (!prop || !prop.ownerId || prop.mortgaged) return 0; // 无主/抵押中不收费（E06）

  switch (cell.subtype) {
    case 'normal':
      // normal rents 长度 6：[空地,1房,2房,3房,4房,旅馆]，按 level 取档
      return cell.rents?.[prop.level] ?? 0;
    case 'station': {
      // 按所有者"未抵押"车站数取档：250/500/1000/2000（K8：抵押中不计）
      const count = countUnmortgagedSubtype(state, prop.ownerId, 'station');
      return cell.rents?.[count - 1] ?? 0;
    }
    case 'utility': {
      // 过路费 = 当次骰点 × 倍数（持有 1 处 ×10；两处全有 ×100；K8：抵押中不计）
      const count = countUnmortgagedSubtype(state, prop.ownerId, 'utility');
      // 对骰子数组求和（兼容单颗机场支线 / 两颗普通掷骰）
      const diceArr = dice ?? state.lastDice;
      const diceSum = diceArr ? diceArr.reduce((a, b) => a + b, 0) : 0;
      const mult =
        count >= 2
          ? state.config.utilityMultipliers[1] // 100
          : state.config.utilityMultipliers[0]; // 10
      return diceSum * mult;
    }
    default:
      return 0;
  }
}

/** 计算目标地产解除抵押后的预计过路费，仅用于决策，不修改 state。 */
export function getProjectedRentAfterRedemption(state: GameState, cellId: number): number {
  const cell = state.board.cells.find((candidate) => candidate.id === cellId);
  if (!cell || cell.type !== 'property') return 0;
  const prop = state.properties[cellId];
  if (!prop || !prop.ownerId || !prop.mortgaged) return 0;

  switch (cell.subtype) {
    case 'normal':
      return cell.rents?.[prop.level] ?? 0;
    case 'station': {
      const countAfterRedemption = countUnmortgagedSubtype(state, prop.ownerId, 'station') + 1;
      return cell.rents?.[countAfterRedemption - 1] ?? 0;
    }
    case 'utility': {
      const countAfterRedemption = countUnmortgagedSubtype(state, prop.ownerId, 'utility') + 1;
      const multiplier = state.config.utilityMultipliers[countAfterRedemption >= 2 ? 1 : 0];
      return 7 * multiplier;
    }
    default:
      return 0;
  }
}

/** 统计某玩家持有的指定 subtype 且未抵押的地产数（K8 定案） */
function countUnmortgagedSubtype(
  state: RentState,
  ownerId: string,
  subtype: 'station' | 'utility',
): number {
  let n = 0;
  for (const cell of state.board.cells) {
    if (cell.type !== 'property' || cell.subtype !== subtype) continue;
    const p: PropertyState | undefined = state.properties[cell.id];
    if (p && p.ownerId === ownerId && !p.mortgaged) n++;
  }
  return n;
}

export function canBuyProperty(state: GameState): boolean {
  if (state.phase !== 'playing' || state.debt || state.turnPhase !== 'awaiting_buy_decision') return false;
  const player = state.players.find((p) => p.id === state.currentPlayerId);
  if (!player || player.bankrupt) return false;
  const cell = state.board.cells.find((c) => c.id === player.position);
  if (!cell || cell.type !== 'property') return false;
  const prop = state.properties[player.position];
  if (!prop || prop.ownerId) return false;
  return player.cash >= cell.price;
}

export function canBuild(state: GameState): boolean {
  if (state.phase !== 'playing' || state.debt || state.turnPhase !== 'awaiting_build_decision') return false;
  const player = state.players.find((p) => p.id === state.currentPlayerId);
  if (!player || player.bankrupt) return false;
  const cell = state.board.cells.find((c) => c.id === player.position);
  if (!cell || cell.type !== 'property' || cell.subtype !== 'normal') return false;
  const prop = state.properties[player.position];
  if (!prop || prop.ownerId !== player.id) return false;
  if (prop.mortgaged || prop.level >= state.config.maxHouseLevel) return false;
  return typeof cell.houseCost === 'number' && player.cash >= cell.houseCost;
}

export function getSellableAssets(state: GameState, playerId: string): {
  sellableHouses: number[];
  sellableProperties: number[];
} {
  const sellableHouses: number[] = [];
  const sellableProperties: number[] = [];

  for (const cell of state.board.cells) {
    if (cell.type !== 'property') continue;
    const prop = state.properties[cell.id];
    if (!prop || prop.ownerId !== playerId) continue;

    if (cell.subtype === 'normal' && prop.level > 0) {
      sellableHouses.push(cell.id);
      continue;
    }
    if (prop.level === 0 && !prop.mortgaged) {
      sellableProperties.push(cell.id);
    }
  }

  return { sellableHouses, sellableProperties };
}
