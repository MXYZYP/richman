import { getActiveMapPack } from '@richman/board-data';
import { createGame } from '@richman/engine';

const chinaMap = getActiveMapPack('china-tour');

// 创建 M3-1 静态棋盘 UI 所需的初始游戏状态
// 固定 seed 与 cashGoal，确保任意时刻渲染的棋盘/玩家/牌堆均可在本地复现
export function createDemoGameState() {
  return createGame({
    mapRef: chinaMap.ref,
    ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: chinaMap.game.config,
    seed: 'm3-static-board-demo',
    cashGoal: 30000,
    players: [
      { id: 'p1', nickname: '玩家一' },
      { id: 'p2', nickname: '电脑A', isBot: true },
      { id: 'p3', nickname: '电脑B', isBot: true },
    ],
  });
}
