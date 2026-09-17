// 金额格式化：用 zh-CN 千分位，便于中国玩家阅读
export function formatMoney(value: number): string {
  return value.toLocaleString('zh-CN');
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
  return `${sign}¥${formatMoney(Math.abs(delta))}`;
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
    announcements.push(`${player.nickname}${verb} ¥${formatMoney(Math.abs(notice.delta))}`);
  }

  return announcements.join('；');
}
