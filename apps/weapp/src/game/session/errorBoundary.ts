import { ref, type Ref } from 'vue';

/**
 * 全局错误兜底（体验 E3）。
 *
 * 现状：客户端**一处**错误捕获都没有（全仓没有 `onerror` / `unhandledrejection` /
 * `app.config.errorHandler`）。后果是任何一次未捕获异常都直接表现为「白屏，没有任何提示」，
 * 而我们在服务器上完全看不到 —— 既修不了，也不知道该不该修。
 *
 * 两件事，分开处理：
 *  1. **上报**（运营 O0）：所有来源都上报，用于知道「线上到底崩了多少次、崩在哪」。
 *  2. **兜底 UI**：只有 Vue 渲染/生命周期里的异常才弹恢复卡。理由：组件树抛错意味着
 *     UI 大概率已经残缺（这正是白屏的成因），必须给玩家一个出路；而一个无关的
 *     promise rejection 不该打断正在进行的对局 —— 那种弹窗比错误本身更烦人。
 *
 * ★ 原则（见 telemetry.ts 文件头）：兜底自己**绝不**再抛异常，也绝不修改游戏状态。
 */

export type AppErrorSource = 'vue' | 'window' | 'promise';

export interface AppErrorReport {
  readonly source: AppErrorSource;
  readonly message: string;
}

export interface ErrorBoundaryDeps {
  /** 上报通道（默认 `trackEvent`，即 O0 埋点）。 */
  report?: (name: string, props?: Record<string, string | number | boolean>) => void;
  now?: () => number;
  /** 注入是为了能测；默认挂到 `globalThis`。 */
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  /** 同一条错误在这个窗口内只上报一次（默认 5 秒）。 */
  dedupeWindowMs?: number;
}

export interface ErrorBoundary {
  /** 当前需要玩家处理的致命错误；`null` = 没有。 */
  readonly fatal: Ref<AppErrorReport | null>;
  /** Vue 组件抛错（渲染 / 生命周期 / 事件处理）：上报告并弹恢复卡。 */
  captureVueError(error: unknown): void;
  /** `window.onerror`：只上报。 */
  captureWindowError(error: unknown): void;
  /** `unhandledrejection`：只上报。 */
  captureRejection(reason: unknown): void;
  install(): void;
  dismiss(): void;
}

/** 把任意 throw 出来的东西变成一条能上报、能显示的字符串。 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  if (typeof error === 'string') return error.slice(0, 200);
  try {
    return JSON.stringify(error).slice(0, 200);
  } catch {
    return 'unknown error';
  }
}

/** 全局单例：App.vue 直接读它，不必层层传 props。 */
const sharedFatal = ref<AppErrorReport | null>(null);

export function useAppErrorState(): Ref<AppErrorReport | null> {
  return sharedFatal;
}

export function createErrorBoundary(deps: ErrorBoundaryDeps = {}): ErrorBoundary {
  const report = deps.report ?? (() => undefined);
  const now = deps.now ?? Date.now;
  const addEventListener = deps.addEventListener
    ?? ((type: string, listener: (event: unknown) => void) => {
      const target = globalThis as { addEventListener?: (t: string, l: (event: unknown) => void) => void };
      target.addEventListener?.(type, listener);
    });
  const dedupeWindowMs = deps.dedupeWindowMs ?? 5_000;
  const fatal = sharedFatal;
  const lastReportedAt = new Map<string, number>();

  function reportOnce(source: AppErrorSource, message: string): void {
    const at = now();
    const previous = lastReportedAt.get(`${source}:${message}`);
    // 同一个渲染循环里同一个错会被重试好几次（Vue 会在多个生命周期钩子里报同一条），
    // 不去重的话一次白屏能在曲线上变成几十次崩溃。
    if (previous !== undefined && at - previous < dedupeWindowMs) return;
    lastReportedAt.set(`${source}:${message}`, at);
    // ★ 上报失败必须被吞掉：兜底代码自己抛异常 = 白屏之上再叠一层白屏。
    // 埋点通道（fetch / sendBeacon）在断网时本来就会抛，这条不是假想情况。
    try {
      report('app_error', { source, message: message.slice(0, 200) });
    } catch {
      /* 上报不了就上报不了，兜底 UI 照常工作。 */
    }
  }

  return {
    fatal,

    captureVueError(error) {
      const message = messageOf(error);
      reportOnce('vue', message);
      fatal.value = { source: 'vue', message };
    },

    captureWindowError(error) {
      reportOnce('window', messageOf(error));
    },

    captureRejection(reason) {
      reportOnce('promise', messageOf(reason));
    },

    install() {
      addEventListener('error', (event: unknown) => {
        const record = event as { message?: unknown; error?: unknown };
        // `error` 事件里优先取 error 对象（有堆栈），退回到 message 字符串。
        this.captureWindowError(record.error ?? record.message ?? event);
      });
      addEventListener('unhandledrejection', (event: unknown) => {
        const record = event as { reason?: unknown };
        this.captureRejection(record.reason ?? event);
      });
    },

    dismiss() {
      fatal.value = null;
    },
  };
}
