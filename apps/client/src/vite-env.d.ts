/// <reference types="vite/client" />
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

/**
 * 构建期注入的服务端根地址（如 `https://game.mxyzyp.xyz`）。
 *
 * 只给「页面与接口不同源」的产物用 —— 目前就是给 TapTap 创意工坊的 H5 包体用。
 * 同源部署（服务器自己托管 dist）**不要设**，留空即走相对路径。
 */
interface ImportMetaEnv {
  readonly VITE_SERVER_ORIGIN?: string;
}
