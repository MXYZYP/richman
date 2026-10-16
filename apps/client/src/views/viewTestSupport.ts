import { createSSRApp, h, type Component } from 'vue';
import { renderToString } from '@vue/server-renderer';

/**
 * 视图测试的共用底座。
 *
 * 本项目**没装 `@vue/test-utils`**，所以「渲染一个视图」只有 SSR 一条路：`renderToString`。
 * 它观察不到点击，也拿不到挂载后的生命周期 —— 判定逻辑归各自的纯函数与接线守卫，
 * 这里只负责把视图渲成一个字符串。
 *
 * SSR 下 `globalThis.localStorage` 根本不存在，而战绩 / 成就 / 云同步 / 排行榜四页都要读它。
 * `withLocalStorage` 就是为这件事准备的：临时顶掉全局的 localStorage，跑完按原样还原
 * （原来的属性描述符取不到就删掉，避免把 stub 漏给下一个用例）。
 */
export function renderView(component: Component, props: Record<string, unknown> = {}): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(component, props) }));
}

/** 带一组预置键值跑一遍；`run` 里读到的就是这组值。 */
export async function withStorageValues<T>(
  values: Record<string, string>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const store = new Map<string, string>(Object.entries(values));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    },
  });
  try {
    return await run();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
    else Object.defineProperty(globalThis, 'localStorage', previous);
  }
}

/** 只要「有存储可用」，不需要预置内容时用这个。 */
export function withLocalStorage<T>(run: () => Promise<T>): Promise<T> {
  return withStorageValues({}, run);
}

/** 战绩在本机存储里的键名（`session/playerStats.ts`）。 */
export const PLAYER_STATS_KEY = 'richman_player_stats_v1';

/** 一份零战绩，或按需覆盖若干字段。 */
export function statsJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    bestAsset: 0,
    favoriteMaps: {},
    lastPlayedAt: 0,
    ...overrides,
  });
}
