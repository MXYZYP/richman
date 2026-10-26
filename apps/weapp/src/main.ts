import { createSSRApp } from 'vue';
import App from './App.vue';

// 必须在任何游戏代码 import 之前执行：逻辑层会直接调用 structuredClone /
// localStorage / sessionStorage，小程序基础库没有这些全局对象。
import './platform/polyfill';

// 全局样式走 main.ts 引入（与源站一致）。绝不能放进任何组件的 <style scoped>：
// 那会让 scoped 插件给全局选择器做笛卡尔积展开，产物膨胀且布局塌陷。
import './styles/base.css';
import './styles/entry.css';
import './styles/weapp.css';

export function createApp() {
  // 源站装了 Pinia 但全仓 0 个 defineStore（状态全部走 ref + session 对象），
  // 小程序端不引入，省一份运行时。
  const app = createSSRApp(App);
  return { app };
}
