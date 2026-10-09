import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './style.css';
import './ui/darkMode.css';
// 对局皮肤必须在这里全局引入，绝不能留在 GameView.vue 里 import。
// GameView 是 <style scoped> 组件，插件会把 gameTheme.css 的 16 个主题选择器当成父选择器，
// 与GameView 的每条 scoped 规则做笛卡尔积：产物一度膨胀到 8.2 MB（其中 98% 是永不匹配的
// 死选择器，要求 <html> 同时是 ocean+midnight+forest+sand）。
// 那批死规则里混进了 .game-shell{display:grid} —— 浏览器匹配不到就退回 display:block，
// 桌面整��塌成竖排（侧栏掉到棋盘下方全宽、无法上滑）。改为全局引入后产物 70 KB。
import './ui/gameTheme.css';
import { setupPwaInstall } from './pwaInstall';

const app = createApp(App);
app.use(createPinia());
app.mount('#app');

// P2-11 PWA：仅在生产构建注册 Service Worker + 安装提示；开发态不注册，避免污染 HMR。
// 另外只在 http/https 下注册：原生壳（鸿蒙 rawfile / file:// 兜底场景）里没有 Service Worker
// 能力，注册必然失败并在控制台刷一条报错——而那条报错跟「游戏能不能玩」毫无关系，只会误导排查。
setupPwaInstall();
const canRegisterServiceWorker = import.meta.env.PROD
  && 'serviceWorker' in navigator
  && /^https?:$/.test(globalThis.location.protocol);
if (canRegisterServiceWorker) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // 注册失败不应影响正常游玩，静默忽略。
    });
  });
}

