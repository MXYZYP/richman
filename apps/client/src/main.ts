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
setupPwaInstall();
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // 注册失败不应影响正常游玩，静默忽略。
    });
  });
}

