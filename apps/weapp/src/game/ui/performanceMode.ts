/**
 * 体验 E5：低端机降级（性能模式）。
 *
 * ★ 要解决什么：这个游戏在千元安卓机上最明显的卡顿不是逻辑算不动，而是**合成开销** ——
 *   棋子移动的 transition、弹窗的背景模糊（backdrop-filter）、格子上的多层阴影。
 *   这些在中端机上很漂亮，在低端机上每一次重绘都要几十毫秒，攒起来就成了「点了没反应」。
 *
 * ★ 判据为什么是这三条：`hardwareConcurrency`（逻辑核数）、`deviceMemory`（JS 堆上限，
 *   Chrome 系可用）、`connection.saveData`（用户自己开了省流量）。它们都是**只读信号**，
 *   不采集、不上传、不写文件；拿不到就当作「不低端」—— 宁可不降，也不误降。
 *
 * ★ 为什么还要手动开关：自动判定必然有误判（老旗舰核数少但不卡、模拟器报 1 核）。
 *   玩家自己能一键翻盘，比任何启发式都可靠。存下来的是明确偏好（on/off），
 *   没存过才是 auto。
 *
 * 落地方式：在根元素上打 `data-perf="low"`，全局 CSS 据此关掉动画与毛玻璃。
 * 用属性而不是加 class，是为了让它和主题/皮肤 class 互不干扰（主题走 `data-theme`）。
 */

export type PerformancePreference = 'auto' | 'on' | 'off';

export const PERF_MODE_KEY = 'richman_perf_mode_v1';
/** 逻辑核数 <= 4 视为低端：这是当前安卓千元机与中端机最常见的分界线。 */
export const LOW_END_CORES = 4;
/** deviceMemory <= 4GB 视为低端（Device Memory API，单位 GB，Chrome 系可用）。 */
export const LOW_END_MEMORY_GB = 4;

export interface DeviceSignals {
  readonly cores?: number;
  readonly deviceMemoryGb?: number;
  readonly saveData?: boolean;
}

interface NavigatorWithDeviceMemory extends Navigator {
  readonly deviceMemory?: number;
}

interface NetworkInformationLike {
  readonly saveData?: boolean;
}

/**
 * 存储的最小接口。与 `session/telemetry.ts` 的 StorageLike 同形 —— 之所以不直接复用，
 * 是为了让本模块不依赖埋点那一套（关掉统计也不该影响性能模式）。
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function readStorage(key: string, storage: StorageLike | undefined): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string, storage: StorageLike | undefined): void {
  try {
    storage?.setItem(key, value);
  } catch {
    /* 存不下就算了：本次会话按内存里的开关走 */
  }
}

function removeStorage(key: string, storage: StorageLike | undefined): void {
  try {
    storage?.removeItem(key);
  } catch {
    /* 同上 */
  }
}

/**
 * 从 navigator 里只读地取判定信号。**信号缺失时字段为 undefined，不猜、不填默认值** ——
 * 猜出来的数字会让判定在另一个浏览器上悄悄变样。
 */
export function readDeviceSignals(navigatorLike: Navigator | undefined): DeviceSignals {
  if (!navigatorLike) return {};
  const nav = navigatorLike as NavigatorWithDeviceMemory;
  const connection = (nav as Navigator & { connection?: NetworkInformationLike }).connection;
  const cores = typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : undefined;
  const memory = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : undefined;
  const saveData = typeof connection?.saveData === 'boolean' ? connection.saveData : undefined;
  return {
    ...(cores === undefined ? {} : { cores }),
    ...(memory === undefined ? {} : { deviceMemoryGb: memory }),
    ...(saveData === undefined ? {} : { saveData }),
  };
}

/** 三条里命中任意一条就算低端；一条信号都没有时不降级。 */
export function detectLowEndDevice(signals: DeviceSignals): boolean {
  if (signals.saveData === true) return true;
  if (signals.cores !== undefined && signals.cores > 0 && signals.cores <= LOW_END_CORES) return true;
  if (signals.deviceMemoryGb !== undefined && signals.deviceMemoryGb > 0 && signals.deviceMemoryGb <= LOW_END_MEMORY_GB) {
    return true;
  }
  return false;
}

/**
 * 读已存的偏好；没存过或值不合法一律按 auto（自动判定）。
 * storage 可注入：测试环境（node）没有 localStorage，硬摸全局会让「写了读不回」变成假失败。
 */
export function readPerformancePreference(storage: StorageLike | undefined = globalThis.localStorage): PerformancePreference {
  const raw = readStorage(PERF_MODE_KEY, storage);
  return raw === 'on' || raw === 'off' ? raw : 'auto';
}

export function writePerformancePreference(
  preference: PerformancePreference,
  storage: StorageLike | undefined = globalThis.localStorage,
): void {
  if (preference === 'auto') {
    removeStorage(PERF_MODE_KEY, storage);
    return;
  }
  writeStorage(PERF_MODE_KEY, preference, storage);
}

/** 显式偏好压过自动判定 —— 玩家手动选了，就不再拿设备信号去推翻他。 */
export function resolvePerformanceMode(detected: boolean, preference: PerformancePreference): boolean {
  if (preference === 'on') return true;
  if (preference === 'off') return false;
  return detected;
}

/** 把结果打到根元素上。全局 CSS 认 `data-perf="low"`。 */
export function applyPerformanceMode(root: HTMLElement | undefined, enabled: boolean): void {
  if (!root) return;
  if (enabled) root.setAttribute('data-perf', 'low');
  else root.removeAttribute('data-perf');
}

/**
 * 启动时跑一次：自动判定 + 已存偏好 → 打属性。
 * 传参是为了可测（不直接摸 window）；生产从 main.ts 无参调用。
 */
export function installPerformanceMode(options: {
  navigator?: Navigator | undefined;
  root?: HTMLElement | undefined;
  preference?: PerformancePreference;
  storage?: StorageLike | undefined;
} = {}): boolean {
  const detected = detectLowEndDevice(readDeviceSignals(options.navigator ?? globalThis.navigator));
  const preference = options.preference ?? readPerformancePreference(options.storage ?? globalThis.localStorage);
  const enabled = resolvePerformanceMode(detected, preference);
  applyPerformanceMode(options.root ?? globalThis.document?.documentElement, enabled);
  return enabled;
}
