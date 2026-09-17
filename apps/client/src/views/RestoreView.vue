<script setup lang="ts">
import { computed } from 'vue';
import type { RestoreFailure } from '../session/appFlow';

const props = withDefaults(defineProps<{
  failure?: RestoreFailure | null;
  error?: string | null;
}>(), {
  failure: null,
  error: null,
});

const isFailed = computed(() => props.failure !== null);

const emit = defineEmits<{
  retry: [];
  defer: [];
}>();
</script>

<template>
  <main class="restore-shell">
    <section class="restore-card" aria-labelledby="restore-title">
      <p class="restore-eyebrow">联机对战</p>
      <h1 id="restore-title">正在恢复上次房间</h1>

      <template v-if="!isFailed">
        <p class="restore-status" role="status" aria-live="polite">
          <span class="restore-spinner" aria-hidden="true"></span>
          正在连接服务器并恢复你的座位…
        </p>
      </template>

      <template v-else>
        <p class="restore-status restore-status--failed" role="alert">
          {{ error ?? '暂时无法恢复上次房间，请重试。' }}
        </p>
        <div class="restore-actions">
          <button type="button" class="restore-retry" @click="emit('retry')">重试恢复</button>
          <button type="button" class="restore-abandon" @click="emit('defer')">暂不恢复</button>
        </div>
        <p class="restore-hint">选择「暂不恢复」将回到首页并保留这局，你可以稍后回到上一局或重新加入房间。</p>
      </template>
    </section>
  </main>
</template>

<style scoped>
.restore-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 18px;
}

.restore-card {
  width: min(480px, 100%);
  display: grid;
  gap: 16px;
  padding: clamp(20px, 4vw, 34px);
  border: 1px solid var(--color-border);
  border-radius: 28px;
  background:
    linear-gradient(180deg, rgb(255 255 255 / 94%), rgb(247 243 234 / 84%)),
    var(--board-surface);
  box-shadow: 0 18px 48px rgb(53 39 20 / 14%);
  text-align: left;
}

.restore-eyebrow {
  margin: 0;
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 900;
  letter-spacing: 0.2em;
}

.restore-card h1 {
  margin: 0;
  color: var(--color-primary);
  font-size: clamp(26px, 5vw, 40px);
  line-height: 1.1;
}

.restore-status {
  display: flex;
  gap: 10px;
  align-items: center;
  margin: 0;
  color: var(--color-muted);
  font-weight: 800;
  line-height: 1.6;
}

.restore-status--failed {
  padding: 10px 12px;
  border-radius: 12px;
  background: #ffe1d8;
  color: var(--color-primary);
}

.restore-spinner {
  width: 18px;
  height: 18px;
  flex: none;
  border-radius: 50%;
  border: 3px solid var(--color-border);
  border-top-color: var(--color-primary);
  animation: restore-spin 0.9s linear infinite;
}

.restore-actions {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
}

.restore-retry,
.restore-abandon {
  min-height: 48px;
  border-radius: 16px;
  font-size: 1rem;
  font-weight: 900;
  cursor: pointer;
}

.restore-retry {
  border: 0;
  background: var(--button-enabled-bg);
  color: var(--button-enabled-text);
}

.restore-abandon {
  border: 1px solid var(--color-border);
  background: var(--button-disabled-bg);
  color: var(--color-text);
}

.restore-retry:focus-visible,
.restore-abandon:focus-visible {
  outline: 3px solid var(--color-accent);
  outline-offset: 2px;
}

.restore-hint {
  margin: 0;
  color: var(--color-muted);
  font-size: 12px;
}

@keyframes restore-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .restore-spinner {
    animation: none;
  }
}

@media (max-width: 767px) {
  .restore-shell {
    padding: 10px;
    place-items: start center;
  }

  .restore-actions {
    grid-template-columns: 1fr;
  }
}
</style>
