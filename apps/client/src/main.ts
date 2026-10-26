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
// 二级整页（在线联网对战 / 单机模式）共用的排版与控件样式。
// 同样必须全局引入：这两页都用 <style scoped>，一旦各自持有副本就会漂移
// （单机卡片 720px 对在线卡片 560px 就是这么来的）。改动说明见文件头。
import './ui/entryPage.css';
import { setupPwaInstall } from './pwaInstall';

const app = createApp(App);
app.use(createPinia());
app.mount('#app');

// P2-11 PWA：仅在生产构建注册 Service Worker + 安装提示；开发态不注册，避免污染 HMR。
// 另外只在 http/https 下注册：原生壳（鸿蒙 rawfile / file:// 兜底场景）里没有 Service Worker
// 能力，注册必然失败并在控制台刷一条报错——而那条报错跟「游戏能不能玩」毫无关系，只会误导排查。
setupPwaInstall();
registerServiceWorkerWithUpdatePrompt();

// PWA Service Worker 注册 + 「新版本可用」提示。
// 原实现只在 load 时 register 一次、且 SW 在 install 阶段无条件 skipWaiting：
// 游戏是长会话单页应用，用户很少主动导航，于是新 SW 虽已安装就绪却不会接管，
// 用户一直跑旧代码、看不到新功能。改为「新 SW 进入 waiting → 弹轻量提示 →
// 用户点『刷新』才 postMessage(SKIP_WAITING) 真正接管并 reload」，不打断进行中的对局。
// 注意：改前端静态产物须同步升 sw.js 的 CACHE 版本（守卫见 ui/serviceWorkerCache.test.ts）。
function registerServiceWorkerWithUpdatePrompt(): void {
  const canRegister = import.meta.env.PROD
    && 'serviceWorker' in navigator
    && /^https?:$/.test(globalThis.location.protocol);
  if (!canRegister) return;

  let reg: ServiceWorkerRegistration | null = null;

  const promptReload = () => {
    if (document.querySelector('[data-sw-update-banner]')) return;
    const style = document.createElement('style');
    style.textContent = `
[data-sw-update-banner]{position:fixed;top:12px;left:50%;transform:translateX(-50%);
z-index:9998;display:flex;gap:10px;align-items:center;max-width:92vw;box-sizing:border-box;
padding:10px 14px;border-radius:12px;font:14px/1.4 system-ui,-apple-system,sans-serif;
color:#fff;background:rgba(20,20,28,.92);box-shadow:0 6px 24px rgba(0,0,0,.3)}
[data-sw-update-banner] b{font-weight:600}
[data-sw-update-banner] button{border:0;border-radius:8px;padding:6px 12px;font:600 13px/1 system-ui,sans-serif;cursor:pointer}
[data-sw-update-banner] .ok{background:#e23b3b;color:#fff}
[data-sw-update-banner] .no{background:rgba(255,255,255,.15);color:#fff}`;
    document.head.appendChild(style);
    const el = document.createElement('div');
    el.setAttribute('data-sw-update-banner', '');
    el.innerHTML = '<b>新版本已发布</b><button class="ok" type="button">刷新</button><button class="no" type="button">稍后</button>';
    const ok = el.querySelector('.ok') as HTMLButtonElement;
    const no = el.querySelector('.no') as HTMLButtonElement;
    no.addEventListener('click', () => el.remove());
    ok.addEventListener('click', () => {
      if (reg && reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    });
    document.body.appendChild(el);
  };

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((r) => {
      reg = r;
      // 注册时已有 waiting 的新 SW（上次部署装好但未接管）→ 直接提示。
      if (r.waiting && navigator.serviceWorker.controller) promptReload();
      r.addEventListener('updatefound', () => {
        const worker = r.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          // 仅当存在旧控制器（即这是一次「更新」而非首次安装）才提示，避免首装弹窗。
          if (worker.state === 'installed' && navigator.serviceWorker.controller) promptReload();
        });
      });
    }).catch(() => { /* 注册失败不影响正常游玩，静默忽略 */ });
  });

  // 用户同意更新、新 SW 接管页面后，刷新以加载新版本。
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (document.querySelector('[data-sw-update-banner]')) window.location.reload();
  });
}

