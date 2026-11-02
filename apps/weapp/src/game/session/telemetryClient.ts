import { createTelemetry, TELEMETRY_ID_KEY, type Telemetry } from './telemetry';
import type { StorageLike } from './sessionStorage';
import { resolveServerOrigin } from './serverOrigin';

/**
 * 埋点的进程内单例与生命周期接线（运营 O0 / 体验 E3 共用）。
 *
 * 为什么单独一层：`createTelemetry` 是纯逻辑（依赖全注入，方便测），而「从哪儿拿
 * localStorage / navigator / 构建期注入的服务端地址」只该有一份实现。所有调用点
 * （错误兜底、连接失败、对局开始结束）都只认 `trackEvent`，不碰传输细节。
 *
 * ★ 环境缺失时（SSR / 原生壳 / 测试）必须**静默降级**，不能抛：埋点把首屏搞崩是
 *   这类代码最典型的翻车方式。
 */

let instance: Telemetry | null = null;
let lifecycleBound = false;

function browserStorage(): StorageLike | undefined {
  try {
    const storage = (globalThis as { localStorage?: StorageLike }).localStorage;
    return storage ?? undefined;
  } catch {
    // Safari 无痕里读 localStorage 本身就会抛。
    return undefined;
  }
}

function serverOrigin(): string {
  const env = (import.meta.env ?? {}) as { VITE_SERVER_ORIGIN?: string };
  return resolveServerOrigin(env);
}

function beaconTransport(): ((url: string, body: string) => boolean) | undefined {
  const nav = (globalThis as { navigator?: { sendBeacon?: (url: string, body: string) => boolean } }).navigator;
  if (typeof nav?.sendBeacon !== 'function') return undefined;
  return (url, body) => nav.sendBeacon!(url, body);
}

export function getTelemetry(): Telemetry {
  if (instance !== null) return instance;
  instance = createTelemetry({
    storage: browserStorage(),
    origin: serverOrigin(),
    beacon: beaconTransport(),
  });
  return instance;
}

/** 记一个事件。任何调用点都不需要处理异常 —— 这里全部吞掉。 */
export function trackEvent(name: string, props?: Record<string, string | number | boolean>): void {
  try {
    getTelemetry().track(name, props);
  } catch {
    /* 埋点失败不影响游戏，见 telemetry.ts 文件头。 */
  }
}

export function flushTelemetry(preferBeacon = false): void {
  try {
    getTelemetry().flush(preferBeacon);
  } catch {
    /* 同上 */
  }
}

export function isTelemetryEnabled(): boolean {
  try {
    return getTelemetry().enabled();
  } catch {
    return false;
  }
}

export function setTelemetryEnabled(value: boolean): void {
  try {
    getTelemetry().setEnabled(value);
    // 关掉之后要把内存里残留的待发事件丢掉（setEnabled 已做），
    // 这里再 flush 一次是无意义的，特意不调。
  } catch {
    /* 同上 */
  }
}

/**
 * 页面隐藏 / 卸载时把队列发完。
 *
 * 用 `pagehide` 而不是 `unload`：后者在移动端（尤其是 iOS Safari 的返回手势）
 * 常常不触发，而且会阻止页面进入 bfcache。`visibilitychange → hidden` 覆盖切后台，
 * `pagehide` 覆盖关闭与导航。两次都调 flush(true)（走 sendBeacon），重复调用是幂等的
 * —— 队列已经在第一次清空了。
 */
export function installTelemetryLifecycle(): void {
  if (lifecycleBound) return;
  const target = (globalThis as { addEventListener?: (type: string, listener: () => void) => void }).addEventListener;
  if (typeof target !== 'function') return;

  lifecycleBound = true;
  const flush = () => {
    flushTelemetry(true);
  };
  try {
    target('visibilitychange', flush);
    target('pagehide', flush);
  } catch {
    lifecycleBound = false;
  }
}

/** 关掉统计后连本机编号一起删：服务端那份数据无法回溯删除，至少本机不再继续认人。 */
export function clearTelemetryClientId(): void {
  try {
    browserStorage()?.removeItem(TELEMETRY_ID_KEY);
  } catch {
    /* 同上 */
  }
}

/** 仅供测试：丢掉单例，避免用例之间互相污染。 */
export function resetTelemetryForTests(): void {
  instance = null;
  lifecycleBound = false;
}
