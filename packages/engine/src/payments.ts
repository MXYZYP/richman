// 多笔付款队列（01 §11 / E15）：同一时刻只进入一笔债务，剩余付款排队
import type { DebtState, GameEvent, GameState, QueuedPayment } from './types';
import { finishCashGoalIfReached } from './victory';

export interface PaymentResult {
  state: GameState;
  events: GameEvent[];
  newDebt: DebtState | null;
}

export function processQueuedPayments(
  state: GameState,
  payments: QueuedPayment[],
  events: GameEvent[],
): PaymentResult {
  let s = state;
  let evts = events;

  for (let i = 0; i < payments.length; i++) {
    const payment = payments[i];
    const debtor = s.players.find((p) => p.id === payment.debtorId);
    if (!debtor || debtor.bankrupt) continue;

    const paid = Math.min(debtor.cash, payment.amount);
    s = {
      ...s,
      players: s.players.map((p) => {
        if (p.id === payment.debtorId) return { ...p, cash: p.cash - paid };
        if (payment.creditorId && p.id === payment.creditorId) return { ...p, cash: p.cash + paid };
        return p;
      }),
    };
    // 每笔到账发事件（to=null 表示银行；M2 收尾：仿真对账 + M3 日志显示）
    if (paid > 0) {
      evts = [...evts, { type: 'payment_made', from: payment.debtorId, to: payment.creditorId, amount: paid }];
    }

    // E18：债权人收到钱后现金达标 → 立即终局，剩余排队付款不再处理
    const cashGoalWin = finishCashGoalIfReached(s, evts);
    if (cashGoalWin) return { state: cashGoalWin.state, events: cashGoalWin.events, newDebt: null };

    if (paid < payment.amount) {
      const debt: DebtState = {
        debtorId: payment.debtorId,
        creditorId: payment.creditorId,
        amount: payment.amount - paid,
        resume: { payments: payments.slice(i + 1) },
      };
      evts = [...evts, { type: 'debt_entered', debtorId: debt.debtorId, amount: debt.amount, creditorId: debt.creditorId }];
      return { state: s, events: evts, newDebt: debt };
    }
  }

  return { state: s, events: evts, newDebt: null };
}
