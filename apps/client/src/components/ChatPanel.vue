<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { ChatMessage } from '@richman/protocol';

const props = defineProps<{
  messages: ChatMessage[];
  localPlayerId: string | null;
  disabled?: boolean;
}>();

const emit = defineEmits<{ send: [text: string] }>();

const draft = ref('');
const listEl = ref<HTMLElement | null>(null);

function formatTime(ts: number): string {
  const date = new Date(ts);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function scrollToBottom(): void {
  nextTick(() => {
    const element = listEl.value;
    if (element !== null) element.scrollTop = element.scrollHeight;
  });
}

watch(() => props.messages.length, scrollToBottom);

function submit(): void {
  const text = draft.value.trim();
  if (text.length === 0 || props.disabled) return;
  emit('send', text);
  draft.value = '';
}
</script>

<template>
  <aside class="chat-panel" aria-label="房间聊天">
    <header class="chat-panel__head">房间聊天</header>
    <div ref="listEl" class="chat-panel__list">
      <p v-if="messages.length === 0" class="chat-panel__empty">还没有消息，开始聊天吧</p>
      <div
        v-for="(message, index) in messages"
        :key="index"
        class="chat-line"
        :class="{ 'chat-line--self': message.playerId === localPlayerId }"
      >
        <span class="chat-line__meta">
          <span class="chat-line__name">{{ message.nickname }}</span>
          <span v-if="message.role === 'spectator'" class="chat-line__tag">观战</span>
          <span class="chat-line__time">{{ formatTime(message.ts) }}</span>
        </span>
        <span class="chat-line__text">{{ message.text }}</span>
      </div>
    </div>
    <form class="chat-panel__form" @submit.prevent="submit">
      <input
        v-model="draft"
        class="chat-panel__input"
        type="text"
        maxlength="200"
        placeholder="说点什么…"
        :disabled="disabled"
      />
      <button type="submit" class="chat-panel__send" :disabled="disabled || draft.trim().length === 0">发送</button>
    </form>
  </aside>
</template>

<style scoped>
/* #10：这里原本通篇是硬编码深色兜底值（background: var(--color-surface, #1c1f26) 之类），
   而 --color-surface / --color-input / --color-accent-soft 在全局与任何对局皮肤里都**不存在**，
   于是永远回落到那串深色兜底值 —— 浅色皮肤下聊天框却是一块深色面板，点开就是「黑框」。
   现在一律改用两套主题都定义过的核心变量（--board-surface / --color-cell / --color-border /
   --color-text / --color-muted / --color-primary / --color-accent），聊天框就跟着当前皮肤走：
   经典/海洋是浅色纸面，暗夜是深色面板；深色模式下皮肤为 auto 时同样落到暗夜。 */
.chat-panel {
  display: flex;
  flex-direction: column;
  width: 280px;
  max-height: 60vh;
  background: var(--board-surface);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  box-shadow: var(--board-shadow);
  overflow: hidden;
  font-size: 13px;
  color: var(--color-text);
}

.chat-panel__head {
  padding: 8px 12px;
  font-weight: 600;
  border-bottom: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-accent) 18%, transparent);
  color: var(--title-color);
}

.chat-panel__list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.chat-panel__empty {
  margin: auto;
  color: var(--color-muted);
  text-align: center;
}

.chat-line {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 8px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-text) 7%, transparent);
}

.chat-line--self {
  background: color-mix(in srgb, var(--color-accent) 22%, transparent);
}

.chat-line__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--color-muted);
}

.chat-line__name {
  font-weight: 600;
  color: var(--color-text);
}

.chat-line__tag {
  padding: 0 4px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--color-text) 14%, transparent);
}

.chat-line__text {
  word-break: break-word;
  white-space: pre-wrap;
}

.chat-panel__form {
  display: flex;
  gap: 6px;
  padding: 8px;
  border-top: 1px solid var(--color-border);
}

.chat-panel__input {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-cell) 88%, var(--color-bg));
  color: var(--color-text);
}

.chat-panel__input::placeholder {
  color: var(--color-muted);
}

.chat-panel__input:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.chat-panel__send {
  padding: 6px 12px;
  border-radius: 8px;
  border: none;
  background: var(--button-enabled-bg);
  color: var(--button-enabled-text);
  font-weight: 600;
  cursor: pointer;
}

.chat-panel__send:disabled {
  background: var(--button-disabled-bg);
  color: var(--button-disabled-text);
  cursor: not-allowed;
}
</style>
