/**
 * 小程序运行时 polyfill。
 *
 * 目的：让 apps/client 的逻辑层（session / game / engine）**一行不改**就能在
 * 微信小程序里跑。逻辑层直接依赖了三个浏览器全局对象，小程序基础库都没有：
 *
 *   1. structuredClone —— 9 处（engine/hydrate.ts、engine/engine.ts、
 *      board-data/registry.ts、game/mapResolver.ts），用于状态深拷贝。
 *   2. localStorage    —— 存档、主题、战绩、引导标记等。
 *   3. sessionStorage  —— 局内临时态（当前会话、复盘草稿等）。
 *
 * 这里只在缺失时定义，H5 端仍走浏览器原生实现，不会覆盖。
 */

type AnyRecord = Record<string, unknown>;

const globalScope = globalThis as unknown as AnyRecord;

/* ------------------------------------------------------------------ *
 * 1. structuredClone
 * ------------------------------------------------------------------ */

/** 循环引用安全的深拷贝：覆盖游戏状态里实际会出现的类型（纯对象/数组/Date/Map/Set/二进制）。 */
function deepClone<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value;

  const asObject = value as unknown as object;

  const existing = seen.get(asObject);
  if (existing !== undefined) return existing as T;

  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (value instanceof RegExp) return new RegExp(value.source, value.flags) as unknown as T;

  if (value instanceof Map) {
    const copy = new Map();
    seen.set(asObject, copy);
    for (const [k, v] of value) copy.set(deepClone(k, seen), deepClone(v, seen));
    return copy as unknown as T;
  }

  if (value instanceof Set) {
    const copy = new Set();
    seen.set(asObject, copy);
    for (const v of value) copy.add(deepClone(v, seen));
    return copy as unknown as T;
  }

  if (ArrayBuffer.isView(value)) {
    const ctor = value.constructor as new (source: unknown) => unknown;
    return new ctor(value) as T;
  }

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(asObject, copy);
    for (const item of value) copy.push(deepClone(item, seen));
    return copy as unknown as T;
  }

  const copy: AnyRecord = {};
  seen.set(asObject, copy);
  for (const key of Object.keys(value as AnyRecord)) {
    copy[key] = deepClone((value as AnyRecord)[key], seen);
  }
  return copy as unknown as T;
}

if (typeof globalScope.structuredClone !== 'function') {
  globalScope.structuredClone = deepClone;
}

/* ------------------------------------------------------------------ *
 * 2. Storage 适配层
 * ------------------------------------------------------------------ */

/**
 * 小程序 Storage 的键空间是所有代码共享的。用前缀把两类存储隔开，
 * 既避免 localStorage 与 sessionStorage 串味，也让 clear() 不会误删别人写的键。
 */
const LOCAL_PREFIX = 'ls:';
const SESSION_PREFIX = 'ss:';

/** 同步读写：uni.*StorageSync 在小程序里是同步 API，等价于 localStorage 的同步语义。 */
function storageApi() {
  const uniScope = globalScope.uni as
    | {
        getStorageSync?: (key: string) => unknown;
        setStorageSync?: (key: string, data: unknown) => void;
        removeStorageSync?: (key: string) => void;
        getStorageInfoSync?: () => { keys?: string[] };
      }
    | undefined;
  return uniScope;
}

/** uni 尚未注入时的兜底（单元测试 / 构建期预渲染）：退化成进程内 Map。 */
const memoryFallback = new Map<string, string>();

function rawGet(key: string): string | null {
  const api = storageApi();
  if (api?.getStorageSync) {
    const value = api.getStorageSync(key);
    if (value === '' || value === undefined || value === null) return null;
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  return memoryFallback.get(key) ?? null;
}

function rawSet(key: string, value: string): void {
  const api = storageApi();
  if (api?.setStorageSync) {
    api.setStorageSync(key, value);
    return;
  }
  memoryFallback.set(key, value);
}

function rawRemove(key: string): void {
  const api = storageApi();
  if (api?.removeStorageSync) {
    api.removeStorageSync(key);
    return;
  }
  memoryFallback.delete(key);
}

function rawKeys(): string[] {
  const api = storageApi();
  if (api?.getStorageInfoSync) {
    return [...(api.getStorageInfoSync().keys ?? [])];
  }
  return [...memoryFallback.keys()];
}

/** 按 Web Storage 规范实现的最小 Storage。 */
class MiniStorage implements Storage {
  readonly #prefix: string;

  constructor(prefix: string) {
    this.#prefix = prefix;
  }

  get length(): number {
    return rawKeys().filter((key) => key.startsWith(this.#prefix)).length;
  }

  key(index: number): string | null {
    const keys = this.orderedKeys();
    return keys[index] ?? null;
  }

  getItem(key: string): string | null {
    return rawGet(this.#prefix + key);
  }

  setItem(key: string, value: string): void {
    rawSet(this.#prefix + key, String(value));
  }

  removeItem(key: string): void {
    rawRemove(this.#prefix + key);
  }

  clear(): void {
    for (const key of this.orderedKeys()) rawRemove(this.#prefix + key);
  }

  private orderedKeys(): string[] {
    return rawKeys()
      .filter((key) => key.startsWith(this.#prefix))
      .map((key) => key.slice(this.#prefix.length));
  }
}

if (typeof globalScope.localStorage === 'undefined') {
  globalScope.localStorage = new MiniStorage(LOCAL_PREFIX);
}

if (typeof globalScope.sessionStorage === 'undefined') {
  // 小程序没有「标签页会话」概念，用独立前缀持久化即可：
  // 它只需要在本次使用期间稳定，比纯内存更抗后台回收。
  globalScope.sessionStorage = new MiniStorage(SESSION_PREFIX);
}

/* ------------------------------------------------------------------ *
 * 3. 浏览器 DOM 垫片（把无害调用降级为 no-op）
 * ------------------------------------------------------------------ */

/**
 * 源站组件里有大量「Web 专属但无害」的调用：
 *   document.body.classList.add('game-view-active')
 *   document.activeElement / addEventListener('keydown')
 *   window.matchMedia('(max-width: 1024px)')
 *   window.addEventListener('resize')
 *
 * 它们在小程序里没有对应概念（没有 body、没有键盘、没有独立视口）。
 * 逐条改要动上百处、还会让源站分叉，所以这里做一层垫片：
 * **只降级为无效操作，不伪造布局**。
 *
 * 唯一不能靠垫片糊弄的是「棋盘尺寸测量」，它真的需要像素值 ——
 * 那处由 scripts/patches.mjs 定点替换成 SelectorQuery。
 */
const noop = (): void => undefined;

class MiniElement {
  classList = { add: noop, remove: noop, toggle: noop, contains: () => false };
  style = {};
  offsetHeight = 0;
  clientWidth = 0;
  clientHeight = 0;
  setAttribute = noop;
  removeAttribute = noop;
  getAttribute = () => null;
  appendChild = (child: unknown) => child;
  focus = noop;
  addEventListener = noop;
  removeEventListener = noop;
}

if (typeof globalScope.HTMLElement === 'undefined') {
  globalScope.HTMLElement = MiniElement;
}

if (typeof globalScope.document === 'undefined') {
  const documentShim = {
    activeElement: null,
    body: new MiniElement(),
    documentElement: new MiniElement(),
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => new MiniElement(),
  };
  globalScope.document = documentShim;
}

if (typeof globalScope.window === 'undefined') {
  // 小程序里 globalThis 就是全局作用域；把 window 指过去，
  // window.setTimeout / window.setInterval 这类调用自然可用。
  globalScope.window = globalThis;
}

const windowScope = globalScope.window as AnyRecord;

if (typeof windowScope.matchMedia !== 'function') {
  // 小程序端只有手机布局：恒按窄屏匹配。这与源站 1024px 断点的移动分支一致。
  windowScope.matchMedia = (query: string) => ({
    matches: /max-width/.test(query),
    media: query,
    addEventListener: noop,
    removeEventListener: noop,
    addListener: noop,
    removeListener: noop,
  });
}

if (typeof windowScope.addEventListener !== 'function') {
  windowScope.addEventListener = noop;
  windowScope.removeEventListener = noop;
}

/* ------------------------------------------------------------------ *
 * 4. 音频降级标记
 * ------------------------------------------------------------------ */

/**
 * 源站 audio/bgm.ts、audio/sfx.ts 依赖 window.AudioContext + window.addEventListener。
 * 小程序没有 WebAudio（只有 uni.createInnerAudioContext / wx.createWebAudioContext）。
 * 这两个模块在同步管线里被替换为空实现，这里只留一个环境标记备用。
 */
globalScope.__RICHMAN_MINI__ = true;

export const IS_MINI_PROGRAM = true;
