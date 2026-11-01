<script setup lang="ts">
import { computed } from 'vue';
import type { ConnectionStatus } from '../session/gameSession';

/**
 * 断线 / 重连引导条（体验 E4）。
 *
 * 改造前：连接状态只有大厅顶部那一行小字（`已连接` / `重新连接中` / `连接已断开`）。
 * 玩家真断线时看到的是「棋盘不动了 + 角落一行小字」，既不知道该等也不知道该点哪儿，
 * 最常见的结局是杀掉页面重开 —— 而本机存档里其实还留着这局，重开等于白丢。
 *
 * 现在：断线时顶部明确一条 + 两个出口。
 *   - 「重新连接」：走 `retryResume()`，拿回原来那局的**控制权**（不是重开一局）；
 *   - 「返回首页」：明确放弃这次连接，回去还能从本机存档里继续。
 *
 * 只在**需要玩家做决定**时出现：`reconnecting` 是「系统正在自己恢复」，给一条进度提示即可，
 * 不放按钮（按钮只会诱导玩家在重试窗口里反复点，把重连越点越糟）。
 */

const props = defineProps<{ status: ConnectionStatus }>();

const emit = defineEmits<{ retry: []; exit: [] }>();

const visible = computed(() => props.status === 'reconnecting' || props.status === 'failed');

const copy = computed(() => (props.status === 'failed'
  ? {
    title: '连接已断开',
    detail: '这一局还留在本机上：重新连接可以继续刚才那局，也可以先回首页，之后从存档里接着玩。',
  }
  : {
    title: '正在重新连接',
    detail: '网络恢复后会自动回到刚才那局，稍等一下就好。',
  }));
</script>

<template>
  <div v-if="visible" class="connection-banner" :class="{ 'is-failed': props.status === 'failed' }" role="status">
    <div class="connection-copy">
      <p class="connection-title">{{ copy.title }}</p>
      <p class="connection-detail">{{ copy.detail }}</p>
    </div>
    <!-- 按钮只在「卡住了」的时候给：reconnecting 阶段系统自己在重试，玩家点了只会添乱。 -->
    <div v-if="props.status === 'failed'" class="connection-actions">
      <button type="button" class="connection-primary" @click="emit('retry')">重新连接</button>
      <button type="button" class="connection-secondary" @click="emit('exit')">返回首页</button>
    </div>
  </div>
</template>

<style scoped>
.connection-banner {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--panel-border, rgba(0, 0, 0, 0.08));
  background: var(--panel-muted-bg, rgba(0, 0, 0, 0.04));
}

.connection-banner.is-failed {
  background: var(--warn-bg, #fff4e5);
  color: var(--warn-text, #7a3b00);
}

.connection-copy {
  display: grid;
  gap: 2px;
}

.connection-title {
  margin: 0;
  font-size: 14px;
  font-weight: 800;
}

.connection-detail {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-muted);
}

.connection-actions {
  display: flex;
  gap: 8px;
}

.connection-primary,
.connection-secondary {
  min-height: 40px;
  padding-inline: 16px;
  border: 0;
  border-radius: 10px;
  font-size: 0.95rem;
  font-weight: 700;
  cursor: pointer;
}

.connection-primary {
  background: var(--button-enabled-bg);
  color: var(--button-enabled-text);
}

.connection-secondary {
  background: transparent;
  color: inherit;
  box-shadow: inset 0 0 0 1px currentColor;
}
</style>
