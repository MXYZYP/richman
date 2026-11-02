/**
 * 房规三档预设。
 *
 * 为什么要有这一层：房规（初始资金 / 最高房级 / 抵押利率 / 现金目标 / 拍卖 / 悔棋 / 限时）
 * **全都已经能做**，但它们散在「规则自定义」的三四个输入框和五六个开关里，
 * 默认值又全是「地图默认 + 关闭」——绝大多数玩家从头到尾不知道这局还能换玩法。
 *
 * 所以这不是新机制，是**把已有能力打包成人能一眼看懂的三档**：
 * 点一下就把一组房规一起设好，想精细调仍然可以往下改每一项（改到不匹配任何一档时，
 * 界面显示「自定义」而不是硬把玩家按回某一档）。
 *
 * 约束（别踩）：
 *  - 预设只产出**现有协议字段**的组合，绝不新增协议/引擎字段 —— 服务端无需改动。
 *  - 现金目标必须严格大于本局初始资金（引擎 createGame 会抛错，服务端也会拦）。
 *    竞速局按初始资金的 3 倍取目标，天然满足；若地图默认小到取整后仍不达标，
 *    退回 `initialCash + 1`。
 *  - 每步限时只能取 `TURN_TIME_LIMIT_OPTIONS` 里的档位（0/30/60/120）。
 */

import type { RoomRuleConfig } from '@richman/protocol';

export type RulePresetId = 'standard' | 'sprint' | 'auction';

/** 地图自带的三项默认房规（预设的出发点，也是「标准局」的取值）。 */
export interface RulePresetDefaults {
  readonly initialCash: number;
  readonly maxHouseLevel: number;
  readonly mortgageInterestRate: number;
}

/** 一档预设要落到房间设置上的**全部**字段。 */
export interface RulePresetTarget {
  /** `null` = 不自定义（回到地图默认）。三档预设都不动这三项，只动玩法开关与目标。 */
  readonly ruleConfig: RoomRuleConfig | null;
  readonly cashGoal: number | null;
  readonly auctionOnDecline: boolean;
  readonly minimalUndoEnabled: boolean;
  readonly turnTimeLimitSec: number;
}

export interface RulePreset {
  readonly id: RulePresetId;
  readonly title: string;
  readonly description: string;
}

export const RULE_PRESETS: readonly RulePreset[] = [
  {
    id: 'standard',
    title: '标准局',
    description: '地图原样：打到只剩最后一人，不设现金目标、不拍卖、不限时。',
  },
  {
    id: 'sprint',
    title: '竞速局',
    description: '先攒到初始资金 3 倍现金即获胜，每步 30 秒限时 —— 适合只想快快打一局。',
  },
  {
    id: 'auction',
    title: '拍卖局',
    description: '放弃购买立刻公开拍卖，每步 60 秒 —— 抢地更凶，适合熟人开黑。',
  },
];

/** 竞速局每步限时（秒）：30 是 TURN_TIME_LIMIT_OPTIONS 里最短的非零档。 */
const SPRINT_TURN_LIMIT_SEC = 30;
/** 拍卖局每步限时（秒）：叫价要思考，给 60 而不是 30。 */
const AUCTION_TURN_LIMIT_SEC = 60;

/**
 * 竞速局的现金目标：初始资金的 3 倍，向上取整到千位（好记、好读）。
 * 兜底：任何情况下都必须严格大于初始资金。
 */
export function sprintCashGoal(initialCash: number): number {
  if (!Number.isFinite(initialCash) || initialCash <= 0) return 1;
  const rounded = Math.ceil((initialCash * 3) / 1000) * 1000;
  return Math.max(rounded, Math.floor(initialCash) + 1);
}

/** 一档预设的完整展开结果。 */
export function rulePresetTarget(id: RulePresetId, _defaults: RulePresetDefaults): RulePresetTarget {
  // 三档都不改「初始资金 / 最高房级 / 抵押利率」：那三项改的是难度基线，
  // 玩家点「竞速」只是想快点结束，不是想让地价变贵。要调数值请走下面的自定义项。
  switch (id) {
    case 'sprint':
      return {
        ruleConfig: null,
        cashGoal: sprintCashGoal(_defaults.initialCash),
        auctionOnDecline: false,
        minimalUndoEnabled: false,
        turnTimeLimitSec: SPRINT_TURN_LIMIT_SEC,
      };
    case 'auction':
      return {
        ruleConfig: null,
        cashGoal: null,
        auctionOnDecline: true,
        minimalUndoEnabled: false,
        turnTimeLimitSec: AUCTION_TURN_LIMIT_SEC,
      };
    case 'standard':
    default:
      return {
        ruleConfig: null,
        cashGoal: null,
        auctionOnDecline: false,
        minimalUndoEnabled: false,
        turnTimeLimitSec: 0,
      };
  }
}

/** 当前房间设置（已解析成生效值）的快照，用于判断落在哪一档。 */
export interface RulePresetSnapshot {
  readonly ruleConfig: RoomRuleConfig | null;
  readonly cashGoal: number | null;
  readonly auctionOnDecline: boolean;
  readonly minimalUndoEnabled: boolean;
  readonly turnTimeLimitSec: number;
}

function sameRule(a: RoomRuleConfig | null, b: RoomRuleConfig | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.initialCash === b.initialCash
    && a.maxHouseLevel === b.maxHouseLevel
    && a.mortgageInterestRate === b.mortgageInterestRate
  );
}

/**
 * 当前设置**完全等于**哪一档预设；都不等于则返回 `null`（界面显示「自定义」）。
 * 完全相等才认，是为了不让「玩家自己调了一下但大体像标准局」被错误高亮成标准局。
 */
export function matchRulePreset(
  snapshot: RulePresetSnapshot,
  defaults: RulePresetDefaults,
): RulePresetId | null {
  const ids: readonly RulePresetId[] = ['standard', 'sprint', 'auction'];
  for (const id of ids) {
    const target = rulePresetTarget(id, defaults);
    if (
      sameRule(snapshot.ruleConfig, target.ruleConfig)
      && snapshot.cashGoal === target.cashGoal
      && snapshot.auctionOnDecline === target.auctionOnDecline
      && snapshot.minimalUndoEnabled === target.minimalUndoEnabled
      && snapshot.turnTimeLimitSec === target.turnTimeLimitSec
    ) {
      return id;
    }
  }
  return null;
}
