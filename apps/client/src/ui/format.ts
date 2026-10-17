import { ref } from 'vue';

// 金额格式化：用 zh-CN 千分位，便于中国玩家阅读
export function formatMoney(value: number): string {
  return value.toLocaleString('zh-CN');
}

/* ---- 货币单位（11-17）----------------------------------------------------
   用户的决定：**中国城市的地图用「两」，世界之旅用「金币」**。
   为什么不是「元」：TapTap《小游戏内容规范》明文禁止「出现涉及现金符号（如 ¥、$）
   或暗示真实货币交易的玩法」。「元」仍是人民币单位，等于没改；「¥」更是直接被点名的符号。

   为什么单位跟着地图走而不是一个全局常量
   同一局里「1,600 两」和「1,600 金币」都对，取决于棋盘是世界图还是中国图。
   所以单位由 **mapId** 决定（CASH_UNIT_BY_MAP），未收录的地图一律回落到「两」。

   为什么用模块级 ref 而不是层层传参
   51 处调用点里有一半在纯展示函数里（结算行、战报文案、规则摘要），它们手上没有 mapId。
   传参会把 mapId 一路塞进十几个函数签名，而这件事本质上只是「本局的显示单位」而已。
   改成 ref 之后，模板与 computed 里读它就会自动建立依赖 —— 换地图时相关文案会重算。 */
export type CashUnit = '两' | '金币';

/** 世界图用「金币」，其余（中国城市图）用「两」。新增外国地图时在这里补一行。 */
export const CASH_UNIT_BY_MAP: Readonly<Record<string, CashUnit>> = Object.freeze({
  'world-tour': '金币',
});

export const DEFAULT_CASH_UNIT: CashUnit = '两';

const activeCashUnit = ref<CashUnit>(DEFAULT_CASH_UNIT);

/** 某张地图该用哪个单位。未知 / 空地图一律回落默认值，绝不抛错。 */
export function cashUnitForMap(mapId: string | null | undefined): CashUnit {
  if (mapId === null || mapId === undefined || mapId === '') return DEFAULT_CASH_UNIT;
  return CASH_UNIT_BY_MAP[mapId] ?? DEFAULT_CASH_UNIT;
}

/** 进入一局 / 换一张图时调用。各页在拿到本局地图后就地设置。 */
export function setCashUnitForMap(mapId: string | null | undefined): void {
  activeCashUnit.value = cashUnitForMap(mapId);
}

export function currentCashUnit(): CashUnit {
  return activeCashUnit.value;
}

/** `1,600 两` / `15,000 金币`。数字与单位之间留一个空格，窄元素里更好断行。 */
export function formatCash(value: number, unit: CashUnit = activeCashUnit.value): string {
  return `${formatMoney(value)} ${unit}`;
}

type CashFeedbackPlayer = {
  readonly id: string;
  readonly nickname: string;
};

type CashFeedbackNotice = {
  readonly generation: number;
  readonly transitionId: number;
  readonly playerId: string;
  readonly delta: number;
};

export function formatCashDelta(delta: number): string {
  const sign = delta < 0 ? '−' : '+';
  return `${sign}${formatCash(Math.abs(delta))}`;
}

export function formatCashAnnouncement(
  players: readonly CashFeedbackPlayer[],
  notices: readonly CashFeedbackNotice[],
): string {
  if (notices.length === 0) return '';

  let generation = notices[0].generation;
  for (const notice of notices) {
    if (notice.generation > generation) generation = notice.generation;
  }

  let transitionId = -Infinity;
  for (const notice of notices) {
    if (notice.generation === generation && notice.transitionId > transitionId) {
      transitionId = notice.transitionId;
    }
  }

  const playersById = new Map(players.map((player) => [player.id, player]));
  const announcements: string[] = [];
  for (const notice of notices) {
    if (notice.generation !== generation || notice.transitionId !== transitionId) continue;

    const player = playersById.get(notice.playerId);
    if (!player) continue;

    const verb = notice.delta < 0 ? '减少' : '增加';
    announcements.push(`${player.nickname}${verb} ${formatCash(Math.abs(notice.delta))}`);
  }

  return announcements.join('；');
}
