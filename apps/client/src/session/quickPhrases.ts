import { CHAT_TEXT_MAX_LENGTH } from '@richman/protocol';

/**
 * 聊天快捷短语（路线图 #109）。
 *
 * 为什么要它：手机上一句话要敲十几个键，联机时「轮到我啦」这类话本来也不值得打。
 * 一排按钮把「想说但懒得打」变成一次点击，这是把联机从「能用」推向「好用」最便宜的一步。
 *
 * 三条取舍：
 *  1. **点击即发送**，不是填进输入框。填字框只省了打字，仍要再点一次发送，「快捷」就没了意义；
 *     因此按钮上明确写了「点击即发送」，并且在冷却期内变灰 —— 不让玩家怀疑按钮坏了。
 *  2. 短语**保持无害**：没有「你怎么这么慢」这类容易变成吵架的话。快捷短语越方便，
 *     越要避免它变成一键挑衅。
 *  3. 短语列表本身是纯数据，被 `quickPhrases.test.ts` 逐条校验长度 ——
 *     将来有人加一条 250 字的短语，会在测试里当场失败，而不是在联机时被服务端丢掉。
 */
export const QUICK_PHRASES: readonly string[] = [
  '轮到我啦',
  '手气不错',
  '先走一步',
  '手下留情',
  '手下败将',
  '借过借过',
];

/**
 * 两次发送之间的本地间隔（毫秒）。
 *
 * 必须**对齐服务端的静默丢弃窗口**（`apps/server/src/socket/roomSocketAdapter.ts` 的
 * `CHAT_MIN_INTERVAL_MS = 700`）：服务端对过密的消息是「静默丢弃、回 ok」，
 * 客户端看不到任何异常。快捷短语是「连点两下」最容易发生的入口，
 * 所以本地先按住 700ms 把按钮变灰 —— 看得见的等待远好过看不见的丢消息。
 */
export const QUICK_PHRASE_SEND_INTERVAL_MS = 700;

/** 短语能否直接发给服务端：非空、且不超过协议上限。 */
export function isSendableQuickPhrase(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= CHAT_TEXT_MAX_LENGTH;
}

/**
 * 「现在发得出去吗」的闸门。
 *
 * 组件需要的状态只有两个：现在能不能发、发完多久恢复。把它抽成纯工厂（定时器由外部注入）
 * 而不留在组件里，有两个原因：
 *  1. 测试环境是 node、没有 DOM，组件里那段 `setTimeout` 状态机在 SSR 渲染下**根本跑不到** ——
 *     而「连点两下被服务端静默丢弃」正是这块功能唯一的真实风险，不能只靠「按钮渲染出来了」
 *     来假装它被验证过。
 *  2. 组件只剩下「把 ref 翻成按钮的 disabled」这一件事，职责干净。
 */
export interface QuickPhraseGate {
  /** 是否处于冷却中（按钮据此变灰）。 */
  isCooling(): boolean;
  /** 尝试发送：不在冷却中则返回 true 并开始冷却；冷却中返回 false（调用方不该再发）。 */
  trySend(): boolean;
  /** 取消挂起的冷却（组件卸载时调用，别把一个定时器留在那儿）。 */
  dispose(): void;
}

type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * 建一个闸门。`schedule` 必须是**异步回调**的（`setTimeout` 天然如此）——
 * 「先挂句柄、后置回空闲」的写法依赖这一点，否则同步回调会在赋值之前就把闸门打开。
 */
export function createQuickPhraseGate(
  onRelease: () => void,
  schedule: (callback: () => void, delayMs: number) => TimerHandle = (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle: TimerHandle) => void = (handle) => clearTimeout(handle),
  intervalMs: number = QUICK_PHRASE_SEND_INTERVAL_MS,
): QuickPhraseGate {
  let handle: TimerHandle | null = null;

  return {
    isCooling: () => handle !== null,
    trySend: () => {
      if (handle !== null) return false;
      handle = schedule(() => {
        handle = null;
        onRelease();
      }, intervalMs);
      return true;
    },
    dispose: () => {
      if (handle !== null) cancel(handle);
      handle = null;
    },
  };
}
