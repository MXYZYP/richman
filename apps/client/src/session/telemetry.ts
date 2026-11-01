import type { StorageLike } from './sessionStorage';

/**
 * 客户端匿名埋点（运营 O0）。
 *
 * 设计前提：**埋点永远不能影响玩得下去**。所以这里没有重试、没有持久化队列、
 * 没有把失败抛给调用方 —— 上报失败就把这批丢掉，下一次攒够再试。
 * 一条统计丢了的代价是曲线少一个点，一次卡住主线程的代价是玩家骂人。
 *
 * 隐私边界：
 *  - 只有一个随机 `clientId`（`richman_telemetry_id_v1`），与昵称 / 账号 / 设备无关，
 *    服务端落盘时不记 IP、不记 UA；
 *  - 事件名与属性名必须匹配服务端白名单正则，属性值只接受标量；
 *  - `richman_telemetry_optout_v1 = '1'` 时**完全不采集也不上报**（设置页开关写这个键）；
 *  - 拿不到 storage（无痕 / 禁用存储）时仍然可用，但 clientId 只能是会话级随机串 ——
 *    这样至少能统计「这次会话里发生了什么」，只是没法跨会话认人。
 */

export const TELEMETRY_PATH = '/api/telemetry';
export const TELEMETRY_ID_KEY = 'richman_telemetry_id_v1';
export const TELEMETRY_OPT_OUT_KEY = 'richman_telemetry_optout_v1';

/** 攒够这么多条就发一次。一局游戏通常也就十来个事件。 */
export const TELEMETRY_FLUSH_THRESHOLD = 20;
/** 队列上限：上报持续失败时不能让内存无限涨，超出就丢最旧的。 */
export const TELEMETRY_MAX_QUEUE = 200;

export interface TelemetryEvent {
  readonly name: string;
  readonly t: number;
  readonly props?: Readonly<Record<string, string | number | boolean>>;
}

export interface Telemetry {
  /** 记一个事件。名字要匹配 `/^[a-z0-9][a-z0-9_.]{0,63}$/`（服务端同款白名单）。 */
  track(name: string, props?: Record<string, string | number | boolean>): void;
  /**
   * 立刻发送队列里的事件。
   * @param preferBeacon 页面正在隐藏/卸载时传 true：这时 fetch 可能被浏览器直接取消，
   *                     而 `sendBeacon` 是交给浏览器在后台发完的。
   */
  flush(preferBeacon?: boolean): void;
  /** 队列里还没发出去的条数（主要给测试用）。 */
  pending(): number;
  enabled(): boolean;
  setEnabled(value: boolean): void;
}

export interface TelemetryDeps {
  storage?: StorageLike;
  /** 上报实现。注入是为了能测；默认走 `fetch(..., keepalive)`。 */
  post?: (url: string, body: string) => Promise<boolean>;
  /** 卸载时用的上报通道；默认 `navigator.sendBeacon`。 */
  beacon?: (url: string, body: string) => boolean;
  now?: () => number;
  randomId?: () => string;
  /** 服务端根地址（跨域部署时由 `VITE_SERVER_ORIGIN` 注入）；空串 = 同源。 */
  origin?: string;
  /** 显式开关。不传 = 读 storage 里的 opt-out 标记（默认开）。 */
  enabled?: boolean;
}

function defaultRandomId(): string {
  const globalWithCrypto = globalThis as { crypto?: { randomUUID?: () => string } };
  if (typeof globalWithCrypto.crypto?.randomUUID === 'function') {
    return globalWithCrypto.crypto.randomUUID().replace(/-/g, '');
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** 读出（必要时生成）匿名 id。写不进去就退化成会话级 id。 */
export function resolveTelemetryClientId(storage: StorageLike | undefined, randomId: () => string): string {
  if (storage === undefined) return randomId();
  try {
    const existing = storage.getItem(TELEMETRY_ID_KEY);
    if (typeof existing === 'string' && existing.length > 0) return existing;
    const created = randomId();
    storage.setItem(TELEMETRY_ID_KEY, created);
    return created;
  } catch {
    // 隐私模式 / 存储被禁用：这次会话照样能统计，只是认不出「是不是上次那个人」。
    return randomId();
  }
}

export function isTelemetryOptedOut(storage: StorageLike | undefined): boolean {
  if (storage === undefined) return false;
  try {
    return storage.getItem(TELEMETRY_OPT_OUT_KEY) === '1';
  } catch {
    return false;
  }
}

export function setTelemetryOptOut(storage: StorageLike | undefined, optedOut: boolean): void {
  if (storage === undefined) return;
  try {
    if (optedOut) storage.setItem(TELEMETRY_OPT_OUT_KEY, '1');
    else storage.removeItem(TELEMETRY_OPT_OUT_KEY);
  } catch {
    /* 存不下就算了：本次会话按内存里的开关走。 */
  }
}

export function createTelemetry(deps: TelemetryDeps = {}): Telemetry {
  const storage = deps.storage;
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? defaultRandomId;
  const origin = deps.origin ?? '';
  const post = deps.post;
  const beacon = deps.beacon;

  let optedOut = deps.enabled === undefined ? isTelemetryOptedOut(storage) : !deps.enabled;
  const clientId = resolveTelemetryClientId(storage, randomId);
  let queue: TelemetryEvent[] = [];
  let sending = false;

  function send(payload: string, preferBeacon: boolean): void {
    const url = `${origin}${TELEMETRY_PATH}`;
    if (preferBeacon && beacon !== undefined) {
      beacon(url, payload);
      return;
    }
    if (post !== undefined) {
      void post(url, payload);
      return;
    }
    const globalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    if (typeof globalFetch !== 'function') return;
    // keepalive：页面跳转/关闭时这次请求仍有机会发完。失败静默吞掉 —— 见文件头。
    void globalFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => undefined);
  }

  return {
    track(name, props) {
      if (optedOut) return;
      if (!/^[a-z0-9][a-z0-9_.]{0,63}$/.test(name)) return;
      // 属性在服务端还会再洗一遍；这里只做「只留标量、截断长串」的轻量处理，
      // 免得把整个游戏状态对象塞进请求体。
      let cleanProps: Record<string, string | number | boolean> | undefined;
      if (props !== undefined) {
        cleanProps = {};
        for (const [key, value] of Object.entries(props)) {
          if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
            cleanProps[key] = typeof value === 'string' ? value.slice(0, 200) : value;
          }
        }
        if (Object.keys(cleanProps).length === 0) cleanProps = undefined;
      }

      queue.push(cleanProps === undefined ? { name, t: now() } : { name, t: now(), props: cleanProps });
      if (queue.length > TELEMETRY_MAX_QUEUE) queue = queue.slice(-TELEMETRY_MAX_QUEUE);
      if (queue.length >= TELEMETRY_FLUSH_THRESHOLD) this.flush();
    },

    flush(preferBeacon = false) {
      if (optedOut || queue.length === 0) return;
      if (sending) return;
      sending = true;
      const batch = queue;
      queue = [];
      try {
        send(JSON.stringify({ clientId, events: batch }), preferBeacon);
      } catch {
        /* 上报失败就是失败，不重试：见文件头。 */
      } finally {
        sending = false;
      }
    },

    pending() {
      return queue.length;
    },

    enabled() {
      return !optedOut;
    },

    setEnabled(value) {
      optedOut = !value;
      setTelemetryOptOut(storage, optedOut);
      // 关掉就立刻停止采集，连内存里的待发事件一起清掉。
      if (optedOut) queue = [];
    },
  };
}
