// 棋盘/卡牌/配置的数据类型
// 结构必须与 data/*.json 完全一致；02 §2.1-2.2 是权威
import type { ModuleCellData, ModuleEffect } from './mapTypes';

export type CoreCellType =
  | 'start' | 'property' | 'chance' | 'destiny' | 'tax'
  | 'airport' | 'special' | 'world';
export type CellType = CoreCellType | 'module';

export type PropertySubtype = 'normal' | 'station' | 'utility';

/** 格子效果（卡牌与 world/special 格共用同一套枚举，01 §9） */
export interface CoreCellEffect {
  type:
    | 'move_to' | 'move_steps'
    | 'pay_bank' | 'receive_bank'
    | 'pay_each_player' | 'receive_from_each_player'
    | 'repairs' | 'skip_turn'
    | 'draw_card' | 'none';
  cellId?: number;           // move_to
  collectSalary?: boolean;   // move_to
  steps?: number;            // move_steps
  amount?: number;           // pay/receive 类
  perHouse?: number;         // repairs
  perHotel?: number;         // repairs
  turns?: number;            // skip_turn
  deck?: 'chance' | 'destiny'; // draw_card
}
export type CellEffect = CoreCellEffect | ModuleEffect;

export interface BaseCell {
  id: number;
  type: CellType;
  name: string;
  nextId?: number; // 显式跳接（成环、支线出入口）；缺省 = 数组下一格
}

export interface StartCell extends BaseCell { type: 'start' }
export interface ChanceCell extends BaseCell { type: 'chance' }
export interface DestinyCell extends BaseCell { type: 'destiny' }
export interface TaxCell extends BaseCell { type: 'tax'; amount: number }
export interface AirportCell extends BaseCell { type: 'airport'; branchEntryId: number }
export interface SpecialCell extends BaseCell { type: 'special'; effect: CellEffect }
export interface WorldCell extends BaseCell { type: 'world'; effect: CellEffect }

export interface PropertyCell extends BaseCell {
  type: 'property';
  subtype: PropertySubtype;
  price: number;
  mortgageValue: number;
  rents?: number[];      // normal: 6 档；station: 4 档；utility: 无
  houseCost?: number;    // 仅 normal
  subtitle?: string;     // 仅 UI 展示（城市名）
}

export type ModuleCell = Omit<BaseCell, 'type'> & ModuleCellData;

export type Cell =
  | StartCell | ChanceCell | DestinyCell | TaxCell | AirportCell
  | SpecialCell | WorldCell | PropertyCell | ModuleCell;

export interface BoardData {
  boardName: string;
  direction?: 'clockwise'; // 旧地图的展示提示；移动规则只读取 nextId / 数组顺序
  cells: Cell[];
}

export interface Card {
  id: string;
  title?: string;
  text: string;
  effect: CellEffect;
}

export interface CardsData {
  chance: Card[];
  destiny: Card[];
}

export interface GameConfig {
  initialCash: number;
  passStartSalary: number;
  maxHouseLevel: number;
  sellHouseRefundRate: number;
  sellLandRate: number;
  mortgageInterestRate: number;
  utilityMultipliers: [number, number];
  jailExitMinRoll: number;
  jailMaxAttempts: number;
  /**
   * 保释金（元）：在押玩家在自己回合缴费立刻出狱（引擎侧 `prison@1`）。
   *
   * **刻意是可选字段，且只在 `jailEnabled === true` 的地图里出现**：`game.config` 参与 contentHash，
   * 若给其余已上线地图也补上这个键（哪怕是 undefined），它们的哈希会一起漂移，
   * 本地存档与联机房间快照就会被 hydrate 判为「地图不匹配」。
   * 校验规则见 mapValidation.ts 的 assertConfig。
   */
  jailBailCost?: number;
  cashGoalPresets: number[];
  diceMode: 'two_dice';
  airportBranchDice: number; // 机场支线掷骰颗数（本版 1 颗，01 §5.1 定案）
  jailEnabled: boolean;
}
