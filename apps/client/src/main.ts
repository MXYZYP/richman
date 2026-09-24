import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './style.css';
import './ui/darkMode.css';
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

