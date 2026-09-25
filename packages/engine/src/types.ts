import type {
  BoardData,
  CardsData,
  DeepReadonly,
  GameConfig,
  JsonValue,
  MapRef,
  ModuleEvent,
  ModuleIntent,
  RuleModuleRef,
} from '@richman/board-data';

// 核心类型定义（字段名以 plan/03 §4.1 为准）
// 本版无监狱字段（01 §8 关闭）；交易（01 §10）与拍卖已启用（#105 / #106），
// 见下方 PendingTrade / PendingAuction。

// === 阶段 ===
export type Phase = 'playing' | 'game_over';

export type TurnPhase =
  | 'awaiting_roll'
  | 'awaiting_airport_roll'
  | 'awaiting_buy_decision'
  | 'awaiting_build_decision'
  // 交易（#105）：当前玩家在 managing 阶段发起报价后，暂停回合等待**对手**答复。
  // 答复者是 pendingTrade.targetId（不是 currentPlayerId）——这是引擎里唯一
  // 「当前行动者之外的玩家可以合法提交意图」的阶段，applyIntent 的全局闸门为此开了特例。
  | 'awaiting_trade_response'
  // 拍卖（#106）：放弃购买且房规开启拍卖时进入。由 pendingAuction.bidderId 按座次轮流叫价 / 弃权。
  | 'awaiting_auction_bid'
  | 'managing';
// 监狱（prison@1）刻意**没有**独立阶段：狱中决策复用上面的 awaiting_roll，语义由
// publicRuleState.pendingActions 表达（详见 prisonModule.ts 文件头的「为什么没有新增
// awaiting_jail_decision」）。这行注释曾预告要加该阶段，实现时改为复用 —— 别再照旧注释去加。

// === 玩家颜色（按座次分配，02 §4.2 色盲友好：色+形状）===
export type PlayerColor = 'red' | 'blue' | 'yellow' | 'green' | 'purple' | 'orange';

export interface PendingModuleAction {
  readonly optionId: string;
  readonly module: RuleModuleRef;
  readonly playerId: string;
  readonly requiredPhase: TurnPhase;
  readonly label: string;
  readonly action: string;
  readonly payload: JsonValue;
}

export interface PublicRuleState {
  readonly modules: Readonly<Record<string, JsonValue>>;
  readonly pendingActions: readonly PendingModuleAction[];
}

// === 交易（#105）===
/** 交易的一侧：现金 + 地产格。cellIds 必须全部属于该侧的付出方。 */
export interface TradeSide {
  readonly cash: number;
  readonly cellIds: readonly number[];
}

/** 待答复的交易报价（turnPhase === 'awaiting_trade_response' 时必定非 null）。 */
export interface PendingTrade {
  readonly proposerId: string;
  readonly targetId: string;
  /** 发起方付出的东西。 */
  readonly offer: TradeSide;
  /** 发起方索取的东西。 */
  readonly request: TradeSide;
}

// === 拍卖（#106）===
/** 一次进行中的拍卖。轮到的叫价者是 `bidderId`（座次在 decliner 之后的存活玩家依次轮转）。 */
export interface PendingAuction {
  readonly cellId: number;
  /** 轮到谁叫价 / 弃权。 */
  readonly bidderId: string;
  /** 当前最高出价者；null = 还没有人出价。 */
  readonly leaderId: string | null;
  readonly leaderBid: number;
  /** 已弃权的玩家（永久退出本轮拍卖）。 */
  readonly passedIds: readonly string[];
}

// === 游戏状态 ===
export interface GameState {
  readonly mapRef: MapRef;                  // exact 地图身份；存档/重连不得 fallback 到其他版本
  readonly ruleModules: readonly RuleModuleRef[]; // exact 启用模块，顺序参与未来 deterministic hook 排序
  publicRuleState: PublicRuleState;      // 可公开、可恢复的 module JSON 状态与权威待选动作
  seed: string;                    // 随机数状态（掷骰、洗牌都从它推进）→ 同 seed 全局可复现
  turn: number;                    // 第几回合（每位玩家行动一次算一回合）
  phase: Phase;
  turnPhase: TurnPhase;
  currentPlayerId: string;
  players: PlayerState[];          // 座次顺序
  properties: Record<number, PropertyState>; // cellId → 产权状态
  decks: { chance: string[]; destiny: string[] }; // 卡 id 队列，抽顶补底
  debt: DebtState | null;          // 债务状态（01 §11）；同一时刻仅一笔，多笔按座次逐笔进入（E15）
  // 单机真人作弊：抽卡效果结算前的待确认状态；仅 createGame 显式开启时存在（联机/电脑玩家不产生）
  cardChoice?: CardChoiceState;
  // 交易报价（#105）：可选字段，缺省视为「没有进行中的交易」。
  // 刻意做成可选：既有存档 / 房间快照都不含这个键，强制必填会把它们一律判成损坏
  // （与 cardChoice 同一取舍；hydrate 里对「缺键」按 null 处理）。
  pendingTrade?: PendingTrade | null;
  // 拍卖（#106）：可选字段，缺省视为「没有进行中的拍卖」。
  pendingAuction?: PendingAuction | null;
  // 房规「放弃购买即拍卖」（#106）：可选，缺省 false = 沿用既有「无拍卖」行为。
  // 与 cashGoal 一样属于对局级选项，不进 GameConfig（那是地图包的一部分，受 contentHash 约束）。
  auctionOnDecline?: boolean;
  lastDice: number[] | null;
  recentLog: GameEvent[];          // 最近 200 条事件（供重连/刷新重建日志）
  winnerId: string | null;
  cashGoal: number | null;         // 现金目标房规（null = 关闭）
  // 数据引用（createGame 存入）——让 applyIntent 自包含（只需 state 即可执行规则）
  // 实施偏差：03 §4.1 字段清单未列此三项，但 applyIntent 签名（03 §4）只接受 state；
  // 移动需要 board 的 next 指针、抽卡需要 cards、结算需要 config 数值。存档因此也自包含（03 §7）。
  readonly board: DeepReadonly<BoardData>;
  readonly cards: DeepReadonly<CardsData>;
  readonly config: DeepReadonly<GameConfig>;
}

export interface PlayerState {
  id: string;
  nickname: string;
  color: PlayerColor;
  isBot: boolean;                  // 仅供 UI 标识与驱动层识别；规则层面与真人无任何区别
  cash: number;
  position: number;                // = cellId（外环或支线任意格）
  skipTurns: number;               // "暂停 N 回合"剩余回合数（01 §9 skip_turn）
  // 未来启用监狱时增加 inJail / jailAttempts / jailCards
  bankrupt: boolean;
  bankruptTurn: number | null;     // 出局回合（宣告破产时的 state.turn），供结算画面"存活回合数"使用；未破产为 null
  online: boolean;                 // 由服务器层维护（阶段 1 热座始终 true）
}

export interface PropertyState {
  ownerId: string | null;
  level: number;                   // 0=空地，1-4=房屋数，5=旅馆
  mortgaged: boolean;              // 阶段 3 起用；阶段 1 恒为 false
}

export interface QueuedPayment {
  debtorId: string;
  creditorId: string | null;
  amount: number;
}

export interface DebtResumeState {
  payments: QueuedPayment[];
}

export interface DebtState {
  debtorId: string;
  creditorId: string | null;       // null = 银行
  amount: number;
  resume?: DebtResumeState;        // 多笔应付队列（E15）：当前债务清完/破产后继续处理
}

// === 单机真人抽卡确认（作弊重抽）===
// 'local-human' 模式由本地单机会话在 createGame 时开启：非电脑玩家抽到机会/命运时，
// 引擎在效果结算前暂停并记录 pending，等待 accept_card 或 redraw_card。
export type CardChoiceMode = 'local-human';

export interface PendingCardChoice {
  readonly playerId: string;
  readonly deck: 'chance' | 'destiny';
  readonly cardId: string;
  /** 效果进入时的 turnPhase（默认模式同一张牌立即结算时状态中的环境阶段）；接受时仅在结算期间恢复，暂停对外仍是 managing。 */
  readonly resumeTurnPhase: TurnPhase;
}

export interface CardChoiceState {
  readonly mode: CardChoiceMode;
  readonly pending: PendingCardChoice | null;
}

// === Intent（玩家意图，03 §4.2；与 01 §4 状态机的操作一一对应）===
export type CoreIntent =
  | { type: 'roll_dice' }
  | { type: 'roll_airport_branch' }
  | { type: 'buy_property' }
  | { type: 'skip_buy' }
  | { type: 'build_house' }        // 作用于当前停留格
  | { type: 'skip_build' }
  | { type: 'sell_house'; cellId: number }
  | { type: 'sell_property'; cellId: number }
  | { type: 'mortgage_property'; cellId: number }
  | { type: 'redeem_property'; cellId: number }
  | { type: 'end_turn' }
  | { type: 'declare_bankrupt' }
  // 主动投降：不受“是否轮到该玩家 / 是否处于债务态”限制，任何进行中的对局都可发动；
  // 两人对局按破产流程结算（胜负由破产流程判定），多人对局立即出局、现金清零、名下地产转为无主可售。
  | { type: 'surrender' }
  // 单机真人作弊：仅当 state.cardChoice.pending 指向该玩家时可用（联机/电脑玩家永不产生 pending）
  | { type: 'redraw_card' }
  | { type: 'accept_card' }
  // === 交易（#105）===
  // 报价由**当前玩家**在 managing 阶段发起（offer=我付出，request=我索取），
  // 随后暂停回合等 targetId 答复；答复只能由 targetId 本人发出（applyIntent 开了特例）。
  | { type: 'propose_trade'; targetId: string; offer: TradeSide; request: TradeSide }
  | { type: 'respond_trade'; accept: boolean }
  // 发起者本人撤回尚未答复的报价（对手离线 / 改变主意时用，避免回合被无限挂住）。
  | { type: 'cancel_trade' }
  // === 拍卖（#106）===
  | { type: 'place_bid'; amount: number }
  | { type: 'pass_bid' };
export type Intent = CoreIntent | ModuleIntent;
// 监狱（prison@1）**不使用** core 意图：狱中决策是模块待选动作 `jail-choice`
// （分支在 payload.choice，见 prisonModule.ts）。这行原先是「未来模块保留 use_jail_card / jail_roll」，
// 实现时改成了模块动作，别再照着它往 CoreIntent 里加意图。

// === GameEvent（动画与日志驱动源，03 §4.3）===
// 客户端按顺序播放动画，全部播完后界面应与快照一致
export type CoreGameEvent =
  | { type: 'game_started' }
  | { type: 'turn_started'; playerId: string }
  | { type: 'dice_rolled'; playerId: string; dice: number[] }
  | { type: 'token_moved'; playerId: string; path: number[] }
  | { type: 'salary_collected'; playerId: string; amount: number }
  | { type: 'property_bought'; playerId: string; cellId: number; price: number }
  | { type: 'buy_declined' }
  | { type: 'rent_paid'; from: string; to: string; cellId: number; amount: number }
  | { type: 'tax_paid'; playerId: string; amount: number }
  | { type: 'card_drawn'; playerId: string; deck: 'chance' | 'destiny'; cardId: string }
  | { type: 'house_built'; cellId: number; level: number; amount: number } // amount=实付建房费（free-upgrade=0）；level=5 即旅馆落成
  | { type: 'house_sold'; cellId: number; level: number }
  | { type: 'property_sold'; playerId: string; cellId: number; amount: number }
  | { type: 'property_mortgaged'; playerId: string; cellId: number; amount: number }
  | { type: 'property_redeemed'; playerId: string; cellId: number; amount: number }
  // 阶段 3 起产生：mortgaged / redeemed
  | { type: 'bank_paid'; playerId: string; amount: number }      // 玩家付银行（pay_bank / repairs），amount=实付
  | { type: 'bank_received'; playerId: string; amount: number }  // 玩家收银行（receive_bank）
  | { type: 'payment_made'; from: string; to: string | null; amount: number } // 排队付款到账（to=null=银行）
  | { type: 'debt_entered'; debtorId: string; amount: number; creditorId: string | null }
  | { type: 'debt_resolved'; amount: number; creditorId: string | null }
  | { type: 'player_bankrupt'; playerId: string; creditorId: string | null; transferredCash: number }
  // 主动投降出局：现金及资产清零、名下地产转为无主可售；两人对局时 creditorId 指向对手（按破产流程结算）。
  | { type: 'player_surrendered'; playerId: string; creditorId: string | null; transferredCash: number }
  | { type: 'turn_ended'; playerId: string }
  // === 交易（#105）===
  // 刻意不带 offer / request 明细：报价全文在 state.pendingTrade 里，事件只负责驱动战报与动画，
  // 塞进日志会让「最近 200 条」被交易明细挤满（且 hydrate 要为此写一层嵌套校验）。
  | { type: 'trade_proposed'; proposerId: string; targetId: string }
  // 结算事件：accepted=false 时后续字段全为 0/空（仅用于战报文案）。
  | {
      type: 'trade_resolved';
      proposerId: string;
      targetId: string;
      accepted: boolean;
      cashFromProposer: number;
      cashFromTarget: number;
      cellsToProposer: readonly number[];
      cellsToTarget: readonly number[];
    }
  | { type: 'trade_cancelled'; proposerId: string; targetId: string }
  // === 拍卖（#106）===
  | { type: 'auction_started'; cellId: number; firstBidderId: string }
  | { type: 'auction_bid_placed'; playerId: string; cellId: number; amount: number }
  | { type: 'auction_passed'; playerId: string; cellId: number }
  | { type: 'auction_resolved'; cellId: number; winnerId: string | null; amount: number }
  | { type: 'game_over'; winnerId: string; reason: 'last_standing' | 'cash_goal' };
export type GameEvent = CoreGameEvent | ModuleEvent;
// 未来模块保留事件（本版不产生）：sent_to_jail / jail_roll_failed / jail_exited（监狱）

// === applyIntent 结果（03 §4）===
export type ApplyResult =
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; code: ErrorCode };

export type ErrorCode =
  | 'NOT_YOUR_TURN'
  | 'WRONG_PHASE'
  | 'INSUFFICIENT_FUNDS'
  | 'ILLEGAL_INTENT';   // 参数不合法（如对不可盖房的格子盖房）
// 阶段 2 起增加房间/会话相关错误码（03 §5.3）
