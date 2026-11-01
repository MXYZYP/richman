<script setup lang="ts">
import MobileSheet from './MobileSheet.vue';
import type { AppErrorReport } from '../session/errorBoundary';

/**
 * 致命错误的恢复卡（体验 E3）。
 *
 * 什么时候出现：只有 Vue 组件树里抛出的未捕获异常（渲染 / 生命周期）会走到这里 ——
 * 那正是白屏的成因。普通的 promise rejection 只上报、不打扰，理由见
 * `session/errorBoundary.ts` 文件头。
 *
 * 复用 `MobileSheet layout="modal"`：与设置面板 / 玩法说明同一套尺寸与表现，
 * 不另造一层弹层（弹窗尺寸的唯一事实源就那一处）。
 *
 * 两个出口是刻意的：
 *  - 「重新加载」是真正的修复动作 —— 组件树已经残缺，重建是最可靠的恢复；
 *  - 「继续使用」留给「报错了但这一局还能打完」的情况，玩家自己判断。
 */

const props = defineProps<{ error: AppErrorReport | null }>();

const emit = defineEmits<{ dismiss: []; reload: [] }>();
</script>

<template>
  <MobileSheet
    layout="modal"
    :open="props.error !== null"
    title="出了点问题"
    @close="emit('dismiss')"
  >
    <p class="error-lead">这一步没能正常显示。先重新加载一次通常就好。</p>

    <p v-if="props.error !== null" class="error-detail">{{ props.error.message }}</p>

    <div class="error-actions">
      <button type="button" class="error-primary" @click="emit('reload')">重新加载</button>
      <button type="button" class="error-secondary" @click="emit('dismiss')">继续使用</button>
    </div>
  </MobileSheet>
</template>

<style scoped>
.error-lead {
  margin: 0;
  color: var(--color-text);
  font-size: 14px;
  line-height: 1.6;
}

.error-detail {
  margin: 0;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--panel-muted-bg, rgba(0, 0, 0, 0.04));
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.error-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}

.error-primary,
.error-secondary {
  min-height: 44px;
  padding-inline: 20px;
  border: 0;
  border-radius: 12px;
  font-size: 1rem;
  font-weight: 900;
  cursor: pointer;
}

.error-primary {
  background: var(--button-enabled-bg);
  color: var(--button-enabled-text);
}

.error-secondary {
  background: var(--button-disabled-bg, rgba(0, 0, 0, 0.06));
  color: var(--color-text);
}
</style>
