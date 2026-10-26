/// <reference types="@dcloudio/types" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

/** 源站代码通过 uni-app 运行时注入的全局对象判断环境（见 platform/polyfill.ts）。 */
declare const uni: {
  getStorageSync: (key: string) => unknown;
  setStorageSync: (key: string, data: unknown) => void;
  removeStorageSync: (key: string) => void;
  getStorageInfoSync: () => { keys: string[] };
};
