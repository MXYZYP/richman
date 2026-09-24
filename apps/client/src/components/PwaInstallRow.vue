<script setup lang="ts">
// 「安装应用」统一设置行（P2-11 收口）：
// 历史上首页/大厅/对局各挂了一枚固定定位的浮动按钮（.pwa-install-fab），会与聊天浮窗、
// 底部操作坞、房间卡片互相遮挡。现在统一收敛成一行「设置项」，由各页面的设置区域原位渲染，
// 样式自持（scoped），因此在首页、大厅、对局设置里长得完全一致。
// 仅在浏览器触发 beforeinstallprompt（canInstall）时出现；安装完成后自动消失，不留死入口。
import { canInstall, installPwa } from '../pwaInstall';

withDefaults(defineProps<{ hint?: string }>(), { hint: '' });

async function onInstall(): Promise<void> {
  await installPwa();
}
</script>

<template>
  <div v-if="canInstall" class="pwa-install-row">
    <span class="pwa-install-row__copy">
      <span class="pwa-install-row__label">安装应用</span>
      <span v-if="hint" class="pwa-install-row__hint">{{ hint }}</span>
    </span>
    <button type="button" class="pwa-install-row__action" @click="onInstall">安装到桌面</button>
  </div>
</template>

<style scoped>
.pwa-install-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--board-surface);
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text);
}

.pwa-install-row__copy {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.pwa-install-row__label {
  line-height: 1.2;
}

.pwa-install-row__hint {
  font-size: 12px;
  font-weight: 400;
  color: var(--color-muted);
}

.pwa-install-row__action {
  flex-shrink: 0;
  min-height: 40px;
  padding: 0 14px;
  border: 1px solid var(--color-primary);
  border-radius: 9px;
  background: var(--color-primary);
  color: #fff;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.pwa-install-row__action:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
</style>
