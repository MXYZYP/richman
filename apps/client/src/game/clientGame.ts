import { getCurrentRent, type GameEvent, type GameState, type Intent, type PlayerState, type PropertyState } from '@richman/engine';
import type { Cell, CellEffect, DeepReadonly, PropertyCell } from '@richman/board-data';
import type { RenderableGameState } from '../session/gameSession';
import { formatMoney } from '../ui/format';

export interface ClientAction {
  label: string;
  intent: Intent;
  primary?: boolean;
}

export interface PendingPurchaseOffer {
  cellId: number;
  name: string;
  price: number;
}

export interface DisplayCard {
  deck: 'chance' | 'destiny';
  cardId: string;
  title?: string;
  text: string;
}

/** 单机真人作弊的待确认卡牌展示模型：真实卡面 + 玩家名，按钮动作来自 getAvailableActions。 */
export interface PendingCardChoiceDisplay extends DisplayCard {
  playerId: string;
  playerName: string;
}

export interface AssetRow {
  cellId: number;
  name: string;
  displayName: string;
  subtype: PropertyCell['subtype'];
  level: number;
  mortgaged: boolean;
  mortgageValue: number | null;
  sellHouseRefund: number | null;
  sellPropertyValue: number | null;
  redeemCost: number | null;
  canSellHouse: boolean;
  canMortgage: boolean;
  canRedeem: boolean;
  canSellProperty: boolean;
  sellHouseReason: string | null;
  mortgageReason: string | null;
  redeemReason: string | null;
  sellPropertyReason: string | null;
}

export interface PlayerAssetDialogModel {
  player: PlayerState;
  positionName: string;
  debtAmount: number | null;
  assets: AssetRow[];
}

export interface CellDetailRentRow {
  label: string;
  amount: number;
}

export interface CellDetailCurrentRent {
  amount: number | null;
  note: string;
}

export interface CellDetail {
  cellId: number;
  name: string;
  typeLabel: string;
  description: string;
  currentRent: CellDetailCurrentRent | null;
  price: number | null;
  ownerName: string | null;
  levelLabel: string | null;
  mortgagedLabel: string | null;
  mortgageValue: number | null;
  rentRows: CellDetailRentRow[];
  houseCost: number | null;
  notes: string[];
}


function roundMoney(amount: number): number {
  return Math.round(amount);
}

function redeemCost(state: GameState | RenderableGameState, mortgageValue: number): number {
  return roundMoney(mortgageValue * (1 + state.config.mortgageInterestRate));
}

function sellHouseBlockedReason(canSellHouse: boolean, isAssetActionPhase: boolean, level: number): string | null {
  if (canSellHouse) return null;
  if (!isAssetActionPhase) return '非当前阶段';
  if (level <= 0) return '无房可卖';
  return null;
}

function mortgageBlockedReason(
  canMortgage: boolean,
  isAssetActionPhase: boolean,
  level: number,
  mortgaged: boolean,
): string | null {
  if (canMortgage) return null;
  if (!isAssetActionPhase) return '非当前阶段';
  if (mortgaged) return '已抵押';
  if (level > 0) return '需先卖房';
  return null;
}

function redeemBlockedReason(
  canRedeem: boolean,
  hasActiveDebt: boolean,
  mortgaged: boolean,
  isAssetActionPhase: boolean,
  hasCashToRedeem: boolean,
): string | null {
  if (canRedeem) return null;
  if (hasActiveDebt) return '债务中不可赎回';
  if (!mortgaged) return '未抵押';
  if (!isAssetActionPhase) return '非当前阶段';
  if (!hasCashToRedeem) return '现金不足';
  return null;
}

function sellPropertyBlockedReason(
  canSellProperty: boolean,
  hasActiveDebt: boolean,
  level: number,
  mortgaged: boolean,
): string | null {
  if (canSellProperty) return null;
  if (!hasActiveDebt) return '仅债务中可卖地';
  if (level > 0) return '需先卖房';
  if (mortgaged) return '已抵押';
  return null;
}

function propertyTypeLabel(subtype: PropertyCell['subtype'], isOcean = false): string {
  switch (subtype) {
    case 'normal':
      return '普通地产';
    case 'station':
      return isOcean ? '海洋' : '车站';
    case 'utility':
      return '公用事业';
  }
}

function propertyDescription(
  subtype: PropertyCell['subtype'],
  isOcean = false,
  utilityMultipliers: readonly [number, number] = [10, 100],
): string {
  switch (subtype) {
    case 'normal':
      return '可购买、收租、盖房或旅馆的地产。';
    case 'station':
      return isOcean ? '按同一玩家持有的海洋数量计算过路费。' : '按同一玩家持有的车站数量计算租金。';
    case 'utility':
      return `过路费 = 骰点和 × ${utilityMultipliers[0]}（持有 1 处）或 × ${utilityMultipliers[1]}（持有 2 处全有）。`;
  }
}

function propertyLevelLabel(
  subtype: PropertyCell['subtype'],
  level: number,
  maxHouseLevel: number,
  isOcean = false,
): string {
  if (subtype === 'station') return isOcean ? '海洋' : '车站';
  if (subtype === 'utility') return '公用事业';
  if (level === 0) return '裸地';
  if (level === maxHouseLevel) return '旅馆';
  return `${level} 级房屋`;
}

function rentRowsForProperty(
  cell: DeepReadonly<PropertyCell>,
  maxHouseLevel: number,
  isOcean = false,
): CellDetailRentRow[] {
  const rents = cell.rents ?? [];
  if (cell.subtype === 'normal') {
    return rents.map((amount, index) => ({
      label: index === 0 ? '裸地' : index === maxHouseLevel ? '旅馆' : `${index} 级房屋`,
      amount,
    }));
  }
  if (cell.subtype === 'station') {
    return rents.map((amount, index) => ({
      label: isOcean ? `持有 ${index + 1} 片海洋` : `持有 ${index + 1} 座车站`,
      amount,
    }));
  }
  return rents.map((amount, index) => ({ label: `档位 ${index + 1}`, amount }));
}


function currentRentSummary(
  state: GameState | RenderableGameState,
  cell: DeepReadonly<PropertyCell>,
  property: PropertyState | undefined,
  isOcean: boolean,
): CellDetailCurrentRent {
  if (!property?.ownerId) {
    return { amount: 0, note: '无主地皮，当前不收费。' };
  }
  if (property.mortgaged) {
    return { amount: 0, note: '已抵押，当前不收费。' };
  }

  const amount = getCurrentRent(state, cell.id);
  if (cell.subtype === 'normal') {
    const level = propertyLevelLabel(cell.subtype, property.level, state.config.maxHouseLevel);
    return { amount, note: `按当前${level === '裸地' ? '裸地' : ` ${level}`}收费。` };
  }

  if (cell.subtype === 'station') {
    const tierIndex = cell.rents?.findIndex((rent) => rent === amount) ?? -1;
    const holdingCount = tierIndex + 1;
    return {
      amount,
      note: isOcean
        ? `按持有 ${holdingCount} 片海洋收费。`
        : `按持有 ${holdingCount} 座车站收费。`,
    };
  }

  const diceSum = state.lastDice?.reduce((sum, die) => sum + die, 0) ?? 0;
  const multiplier = getCurrentRent(state, cell.id, [1]);
  return {
    amount: state.lastDice ? amount : null,
    note: state.lastDice
      ? `按本次骰点和 ${diceSum} × ${multiplier} 计算；实际收费随本次掷骰变化。`
      : `按本次骰点和 × ${multiplier} 计算；掷骰后显示具体金额。`,
  };
}

function nonPropertyTypeLabel(cell: Exclude<Cell, PropertyCell>): string {
  switch (cell.type) {
    case 'start':
      return '起点';
    case 'chance':
      return '机会';
    case 'destiny':
      return '命运';
    case 'tax':
      return '税格';
    case 'airport':
      return '机场';
    case 'special':
      return '特殊格';
    case 'world':
      return '世界之窗';
    case 'module':
      return cell.cellType === 'airport-branch' ? '机场' : '特殊格';
  }
}

function describeCellEffect(effect: CellEffect, state: GameState | RenderableGameState): string {
  switch (effect.type) {
    case 'pay_bank':
      return `停下时向银行支付 ${formatMoney(effect.amount ?? 0)}。`;
    case 'receive_bank':
      return `停下时从银行获得 ${formatMoney(effect.amount ?? 0)}。`;
    case 'skip_turn':
      return `停下时暂停 ${effect.turns ?? 1} 回合。`;
    case 'pay_each_player':
      return `停下时向每位其他玩家支付 ${formatMoney(effect.amount ?? 0)}。`;
    case 'receive_from_each_player':
      return `停下时从每位其他玩家处获得 ${formatMoney(effect.amount ?? 0)}。`;
    case 'move_steps':
      return `停下时向前移动 ${effect.steps ?? 0} 格并结算。`;
    case 'move_to': {
      const target = state.board.cells.find((candidate) => candidate.id === effect.cellId);
      const targetName = target ? target.name : '指定格子';
      const salary = effect.collectSalary ? '；经过起点可领工资' : '；不领工资';
      return `停下时移动到「${targetName}」并结算${salary}。`;
    }
    case 'draw_card':
      return `停下时再抽一张${effect.deck === 'destiny' ? '命运' : '机会'}卡并执行。`;
    case 'repairs':
      return `停下时按每栋 ${formatMoney(effect.perHouse ?? 0)}、每旅馆 ${formatMoney(effect.perHotel ?? 0)} 支付维修费。`;
    case 'none':
      return '无特殊效果。';
    case 'module':
      return effect.module.id === 'world-tour'
        ? '由世界之旅模块规则结算。'
        : `由 ${effect.module.id}@${effect.module.version} 模块规则结算。`;
    default:
      return '按格子规则结算。';
  }
}


function describeAirportBranch(cell: Extract<Cell, { type: 'module' }>, state: GameState | RenderableGameState): string {
  if (cell.module.id === 'world-tour' && cell.cellType === 'airport-branch') {
    const payload = cell.payload as {
      branchCellIds?: number[];
      mergeCellId?: number;
    };
    const branchCount = payload.branchCellIds?.length ?? 0;
    const mergeCell = state.board.cells.find((candidate) => candidate.id === payload.mergeCellId);
    const mergeName = mergeCell ? mergeCell.name : '主环';
    return `恰好停在此时结束本回合；下个本人回合掷一颗骰子进入 ${branchCount} 格太平洋支线，在「${mergeName}」合回主环。`;
  }
  return `由 ${cell.module.id}@${cell.module.version} 模块规则结算。`;
}

function nonPropertyDescription(cell: Exclude<Cell, PropertyCell>, state: GameState | RenderableGameState): string {
  switch (cell.type) {
    case 'start':
      return `经过或停在起点时获得 ${formatMoney(state.config.passStartSalary)}。`;
    case 'chance':
      return '抽一张机会卡并执行效果。';
    case 'destiny':
      return '抽一张命运卡并执行效果。';
    case 'tax':
      return `停下时向银行缴税 ${formatMoney(cell.amount)}。`;
    case 'airport': {
      const entryCell = state.board.cells.find((candidate) => candidate.id === cell.branchEntryId);
      const entryName = entryCell ? entryCell.name : '支线';
      return `恰好停在此格时立即再掷一颗骰子，从「${entryName}」进入支线并结算。`;
    }
    case 'special':
      return 'effect' in cell ? describeCellEffect(cell.effect, state) : '按格子规则结算。';
    case 'world':
      return 'effect' in cell ? describeCellEffect(cell.effect, state) : '按格子规则结算。';
    case 'module':
      return describeAirportBranch(cell, state);
  }
}

export function getCellDetail(state: GameState | RenderableGameState, cellId: number): CellDetail | null {
  const cell = state.board.cells.find((candidate) => candidate.id === cellId);
  if (!cell) return null;

  if (cell.type === 'property') {
    const isOcean = 'presentation' in state
      && state.presentation.cells[cell.id]?.propertyBand === 'band:ocean';
    const prop = state.properties[cell.id];
    const owner = prop ? state.players.find((player) => player.id === prop.ownerId) : undefined;
    const level = prop?.level ?? 0;
    const mortgaged = prop?.mortgaged ?? false;
    const ownerName = owner?.nickname ?? null;
    const notes: string[] = [];

    if (!ownerName) {
      notes.push('当前无主。');
    }
    if (mortgaged) {
      notes.push('抵押中不收租。');
    }

    return {
      cellId: cell.id,
      name: cell.name,
      typeLabel: propertyTypeLabel(cell.subtype, isOcean),
      description: propertyDescription(cell.subtype, isOcean, state.config.utilityMultipliers),
      currentRent: currentRentSummary(state, cell, prop, isOcean),
      price: cell.price,
      ownerName,
      levelLabel: propertyLevelLabel(cell.subtype, level, state.config.maxHouseLevel, isOcean),
      mortgagedLabel: mortgaged ? '已抵押' : '未抵押',
      mortgageValue: cell.mortgageValue,
      houseCost: cell.subtype === 'normal' ? (cell.houseCost ?? null) : null,
      rentRows: rentRowsForProperty(cell, state.config.maxHouseLevel, isOcean),
      notes,
    };
  }

  return {
    cellId: cell.id,
    name: cell.name,
    typeLabel: nonPropertyTypeLabel(cell),
    description: nonPropertyDescription(cell, state),
    currentRent: null,
    price: null,
    ownerName: null,
    levelLabel: null,
    mortgagedLabel: null,
    mortgageValue: null,
    houseCost: null,
    rentRows: [],
    notes: [],
  };
}
export function getAssetRows(state: GameState | RenderableGameState, playerId: string): AssetRow[] {
  const player = state.players.find((candidate) => candidate.id === playerId);
  // 单机真人待确认卡牌期间与引擎一致：卖房/抵押/赎回等资产操作全部不可用。
  const isManaging = state.turnPhase === 'managing' && !state.cardChoice?.pending;
  const activeDebt = state.debt;
  const isActiveFinancialActor = (activeDebt ? activeDebt.debtorId : state.currentPlayerId) === playerId;

  return state.board.cells
    .filter((cell): cell is PropertyCell => cell.type === 'property')
    .flatMap((cell) => {
      const prop = state.properties[cell.id];
      if (!prop || prop.ownerId !== playerId) return [];

      const mortgageValue = cell.mortgageValue;
      const sellHouseRefund = cell.subtype === 'normal' && typeof cell.houseCost === 'number'
        ? roundMoney(cell.houseCost * state.config.sellHouseRefundRate)
        : null;
      const currentRedeemCost = redeemCost(state, mortgageValue);
      const hasCashToRedeem = player ? player.cash >= currentRedeemCost : false;

      const isAssetActionPhase = isManaging && isActiveFinancialActor;
      const canSellHouse = isAssetActionPhase && cell.subtype === 'normal' && prop.level > 0;
      const sellHouseReason = sellHouseBlockedReason(canSellHouse, isAssetActionPhase, prop.level);

      const canMortgage = isAssetActionPhase && prop.level === 0 && !prop.mortgaged;
      const mortgageReason = mortgageBlockedReason(canMortgage, isAssetActionPhase, prop.level, prop.mortgaged);

      const canSellProperty = Boolean(activeDebt) && isAssetActionPhase && prop.level === 0 && !prop.mortgaged;
      const sellPropertyReason = sellPropertyBlockedReason(canSellProperty, Boolean(activeDebt), prop.level, prop.mortgaged);

      const canRedeem = isAssetActionPhase && !activeDebt && prop.mortgaged && hasCashToRedeem;
      const redeemReason = redeemBlockedReason(
        canRedeem,
        Boolean(activeDebt),
        prop.mortgaged,
        isAssetActionPhase,
        hasCashToRedeem,
      );

      return [{
        cellId: cell.id,
        name: cell.name,
        displayName: ('presentation' in state ? state.presentation.cells[cell.id]?.shortLabel : undefined) ?? cell.name,
        subtype: cell.subtype,
        level: cell.subtype === 'normal' && prop.level === state.config.maxHouseLevel ? 5 : prop.level,
        mortgaged: prop.mortgaged,
        mortgageValue,
        sellHouseRefund,
        sellPropertyValue: roundMoney((cell.price ?? 0) * state.config.sellLandRate),
        redeemCost: currentRedeemCost,
        canSellHouse,
        canMortgage,
        canSellProperty,
        canRedeem,
        sellHouseReason,
        mortgageReason,
        sellPropertyReason,
        redeemReason,
      }];
    });
}

export function getPlayerAssetDialogModel(
  state: GameState | RenderableGameState,
  playerId: string,
): PlayerAssetDialogModel | null {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) return null;

  const positionName = state.board.cells.find((cell) => cell.id === player.position)?.name ?? '未知位置';
  const debtAmount = state.debt?.debtorId === playerId ? state.debt.amount : null;

  return {
    player,
    positionName,
    debtAmount,
    assets: getAssetRows(state, playerId),
  };
}
export function getAvailableActions(state: GameState | RenderableGameState): ClientAction[] {
  // 单机真人作弊：待确认卡牌期间冻结其他操作，只提供同牌堆重抽与接受。
  if (state.cardChoice?.pending) {
    return [
      { label: '重新抽取', intent: { type: 'redraw_card' } },
      { label: '接受并执行', intent: { type: 'accept_card' }, primary: true },
    ];
  }
  if (state.debt) return [];

  const pendingActions = state.publicRuleState.pendingActions.filter((action) => (
    action.playerId === state.currentPlayerId && action.requiredPhase === state.turnPhase
  ));
  if (pendingActions.length > 0) {
    return pendingActions.map((action, index) => ({
      label: action.label,
      intent: {
        type: 'module',
        module: action.module,
        action: action.action,
        payload: action.payload,
      },
      ...(index === 0 ? { primary: true } : {}),
    }));
  }

  switch (state.turnPhase) {
    case 'awaiting_roll':
      return [{ label: '掷骰子', intent: { type: 'roll_dice' }, primary: true }];
    case 'awaiting_airport_roll':
      return [{ label: '再掷一次', intent: { type: 'roll_airport_branch' }, primary: true }];
    case 'awaiting_buy_decision':
      return [
        { label: '买地', intent: { type: 'buy_property' }, primary: true },
        { label: '放弃', intent: { type: 'skip_buy' } },
      ];
    case 'awaiting_build_decision':
      return [
        { label: '盖房', intent: { type: 'build_house' }, primary: true },
        { label: '跳过', intent: { type: 'skip_build' } },
      ];
    case 'managing':
      return [{ label: '结束回合', intent: { type: 'end_turn' }, primary: true }];
  }
  const unreachable: never = state.turnPhase;
  return unreachable;
}

export function getPendingPurchaseOffer(state: GameState | RenderableGameState): PendingPurchaseOffer | null {
  if (state.turnPhase !== 'awaiting_buy_decision') return null;
  const player = state.players.find((candidate) => candidate.id === state.currentPlayerId);
  if (!player) return null;
  const cell = state.board.cells.find((candidate) => candidate.id === player.position);
  if (!cell || cell.type !== 'property') return null;
  const property = state.properties[cell.id];
  if (property?.ownerId) return null;
  return { cellId: cell.id, name: cell.name, price: cell.price };
}

/** 单机真人作弊：把待确认卡牌解析成可展示内容（真实卡面文字 + 所属玩家）；无 pending 时为 null。 */
export function getPendingCardChoice(state: GameState | RenderableGameState): PendingCardChoiceDisplay | null {
  const pending = state.cardChoice?.pending;
  if (!pending) return null;
  const card = state.cards[pending.deck].find((candidate) => candidate.id === pending.cardId);
  return {
    playerId: pending.playerId,
    playerName: playerName(state, pending.playerId),
    deck: pending.deck,
    cardId: pending.cardId,
    ...(card?.title === undefined ? {} : { title: card.title }),
    text: card?.text ?? pending.cardId,
  };
}

function playerName(state: GameState | RenderableGameState, playerId: string): string {
  return state.players.find((player) => player.id === playerId)?.nickname ?? playerId;
}

function cellName(state: GameState | RenderableGameState, cellId: number): string {
  return state.board.cells.find((cell) => cell.id === cellId)?.name ?? `格 ${cellId}`;
}

function deckLabel(deck: 'chance' | 'destiny'): string {
  return deck === 'chance' ? '机会' : '命运';
}

function money(amount: number): string {
  return `¥${formatMoney(amount)}`;
}

function modulePayload(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
}

function formatWorldTourModuleEvent(state: GameState | RenderableGameState, event: Extract<GameEvent, { type: 'module' }>): string | null {
  if (event.module.id !== 'world-tour' || event.module.version !== 1) return null;
  const payload = modulePayload(event.payload);
  const playerId = typeof payload.playerId === 'string' ? payload.playerId : '';
  const actor = playerName(state, playerId);
  switch (event.eventType) {
    case 'airport_wait_started':
      return `${actor} 停在泰国曼谷机场，下个个人回合进入支线`;
    case 'toll_immunity_granted':
      return `${actor} 获得一次过路费抵消`;
    case 'toll_immunity_used':
      return `${actor} 抵消本次过路费${typeof payload.amount === 'number' ? ` ${money(payload.amount)}` : ''}`;
    case 'flight_declined':
      return `${actor} 放弃搭乘${payload.kind === 'long-flight' ? '长途' : '短途'}航班`;
    default:
      return null;
  }
}

export function getTurnTitle(state: GameState | RenderableGameState, actorId: string): string {
  return `轮到 ${playerName(state, actorId)}`;
}

export function formatRecentLogEvent(state: GameState | RenderableGameState, event: GameEvent): string {
  switch (event.type) {
    case 'game_started':
      return '游戏开始';
    case 'turn_started':
      return getTurnTitle(state, event.playerId);
    case 'dice_rolled':
      return `${playerName(state, event.playerId)} 掷出 ${event.dice.join(' + ')}`;
    case 'token_moved': {
      const destination = event.path.at(-1);
      return destination === undefined
        ? `${playerName(state, event.playerId)} 原地停留`
        : `${playerName(state, event.playerId)} 前进到 ${cellName(state, destination)}`;
    }
    case 'salary_collected':
      return `${playerName(state, event.playerId)} 经过起点，领取 ${money(event.amount)}`;
    case 'property_bought':
      return `${playerName(state, event.playerId)} 买下 ${cellName(state, event.cellId)}`;
    case 'buy_declined':
      return '放弃购买';
    case 'rent_paid':
      return `${playerName(state, event.from)} 向 ${playerName(state, event.to)} 支付 ${cellName(state, event.cellId)} 租金 ${money(event.amount)}`;
    case 'tax_paid':
      return `${playerName(state, event.playerId)} 缴税 ${money(event.amount)}`;
    case 'card_drawn': {
      const card = state.cards[event.deck].find((candidate) => candidate.id === event.cardId);
      return `${playerName(state, event.playerId)} 抽到${deckLabel(event.deck)}：${card?.text ?? event.cardId}`;
    }
    case 'house_built':
      return event.level >= state.config.maxHouseLevel
        ? `${cellName(state, event.cellId)} 建成旅馆`
        : `${cellName(state, event.cellId)} 升到 ${event.level} 级`;
    case 'house_sold': {
      const cell = state.board.cells.find((candidate): candidate is PropertyCell =>
        candidate.type === 'property' && candidate.id === event.cellId,
      );
      const refund = cell?.subtype === 'normal' && typeof cell.houseCost === 'number'
        ? roundMoney(cell.houseCost * state.config.sellHouseRefundRate)
        : 0;
      return `${cellName(state, event.cellId)} 卖出 1 栋房屋，获得 ${money(refund)}，剩余 ${event.level} 级`;
    }
    case 'property_sold':
      return `${playerName(state, event.playerId)} 卖出 ${cellName(state, event.cellId)}，获得 ${money(event.amount)}`;
    case 'property_mortgaged':
      return `${playerName(state, event.playerId)} 抵押 ${cellName(state, event.cellId)}，获得 ${money(event.amount)}`;
    case 'property_redeemed':
      return `${playerName(state, event.playerId)} 赎回 ${cellName(state, event.cellId)}，支付 ${money(event.amount)}`;
    case 'bank_paid':
      return `${playerName(state, event.playerId)} 向银行支付 ${money(event.amount)}`;
    case 'bank_received':
      return `${playerName(state, event.playerId)} 从银行获得 ${money(event.amount)}`;
    case 'payment_made':
      return event.to
        ? `${playerName(state, event.from)} 向 ${playerName(state, event.to)} 支付 ${money(event.amount)}`
        : `${playerName(state, event.from)} 向银行支付 ${money(event.amount)}`;
    case 'debt_entered':
      return `${playerName(state, event.debtorId)} 资金不足，欠款 ${money(event.amount)}`;
    case 'debt_resolved':
      return `债务已结清 ${money(event.amount)}`;
    case 'player_bankrupt':
      return `${playerName(state, event.playerId)} 破产`;
    case 'turn_ended':
      return `${playerName(state, event.playerId)} 回合结束`;
    case 'game_over':
      return `${playerName(state, event.winnerId)} 获胜`;
    case 'module':
      return formatWorldTourModuleEvent(state, event)
        ?? `模块事件 ${event.module.id}@${event.module.version}:${event.eventType}`;
  }
  const unreachable: never = event;
  return unreachable;
}
