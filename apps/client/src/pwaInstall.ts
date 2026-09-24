// PWA 手动安装（P2-11 增强）：捕获 beforeinstallprompt 事件，提供可靠的「安装应用」入口，
// 不依赖浏览器原生 mini-infobar 的启发式（原生提示不一定弹出）。
// 用法：main.ts 调用 setupPwaInstall() 一次；组件中 import { canInstall, installPwa } 使用。
import { ref } from 'vue';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let initialized = false;

/** 当前是否满足「可安装」条件（beforeinstallprompt 已触发且尚未安装）。 */
export const canInstall = ref(false);
/** 当前是否已以 standalone / 主屏方式运行（已安装）。 */
export const isInstalled = ref(false);

function detectInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches === true;
  const iosStandalone = (navigator as unknown as { standalone?: boolean }).standalone === true;
  return standalone || iosStandalone;
}

function onBeforeInstallPrompt(event: Event): void {
  event.preventDefault();
  deferredPrompt = event as BeforeInstallPromptEvent;
  canInstall.value = true;
}

function onAppInstalled(): void {
  isInstalled.value = true;
  canInstall.value = false;
  deferredPrompt = null;
}

/** 在应用入口调用一次：注册全局监听并探测是否已安装。 */
export function setupPwaInstall(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  if (detectInstalled()) {
    isInstalled.value = true;
    return;
  }
  window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  window.addEventListener('appinstalled', onAppInstalled);
}

/** 触发安装提示；返回用户是否接受。无待处理事件时返回 false（按钮应已隐藏）。 */
export async function installPwa(): Promise<boolean> {
  if (deferredPrompt === null) return false;
  deferredPrompt.prompt();
  const choice = await deferredPrompt.userChoice;
  deferredPrompt = null;
  canInstall.value = false;
  if (choice.outcome === 'accepted') isInstalled.value = true;
  return choice.outcome === 'accepted';
}
