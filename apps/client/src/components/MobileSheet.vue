<script lang="ts">
let openSheetCount = 0;
let previousBodyOverflow = '';
</script>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

// 专用手机底部抽屉：native <dialog> 承载 —— top layer 天然挡住背景点击、Esc 即 cancel、
// 焦点被困在弹层内；打开时锁 body 滚动，关闭时把焦点还给「仍连接且可见」的触发元素。
// 组件常驻（由 open prop 控制），桌面端由 GameView 用 display:contents 原位渲染其内容。
const props = defineProps<{
  open: boolean;
  title: string;
}>();

const emit = defineEmits<{ close: [] }>();

const dialog = ref<HTMLDialogElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const titleId = `mobile-sheet-title-${props.title}`;
let holdsScrollLock = false;
let opener: HTMLElement | null = null;

function show(): void {
  if (!dialog.value || dialog.value.open) return;
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dialog.value.showModal();
  if (openSheetCount === 0) previousBodyOverflow = document.body.style.overflow;
  openSheetCount += 1;
  holdsScrollLock = true;
  document.body.style.overflow = 'hidden';
  void nextTick(() => {
    if (dialog.value?.open) closeButton.value?.focus();
  });
}

function hide(restoreFocus: boolean): void {
  if (holdsScrollLock) {
    holdsScrollLock = false;
    openSheetCount -= 1;
    if (openSheetCount === 0) document.body.style.overflow = previousBodyOverflow;
  }
  if (dialog.value?.open) dialog.value.close();
  const trigger = opener;
  opener = null;
  if (!restoreFocus || trigger === null) return;
  void nextTick(() => {
    if (!document.querySelector('dialog[open]') && trigger.isConnected && trigger.getClientRects().length > 0) {
      trigger.focus();
    }
  });
}

watch(() => props.open, (isOpen, wasOpen) => {
  if (isOpen === wasOpen) return;
  if (isOpen) show();
  else hide(true);
}, { flush: 'post' });

onMounted(() => {
  if (props.open) show();
});

onBeforeUnmount(() => {
  hide(false);
});

function closeFromBackdrop(event: MouseEvent): void {
  if (event.target === dialog.value) emit('close');
}
</script>

<template>
  <dialog
    ref="dialog"
    class="mobile-sheet"
    :aria-labelledby="titleId"
    @cancel.prevent="emit('close')"
    @click="closeFromBackdrop"
  >
    <section class="mobile-sheet-panel">
      <header class="mobile-sheet-head">
        <h2 :id="titleId">{{ props.title }}</h2>
        <button
          ref="closeButton"
          type="button"
          class="mobile-sheet-close"
          :aria-label="`关闭${props.title}`"
          @click="emit('close')"
        >关闭</button>
      </header>
      <div class="mobile-sheet-body">
        <slot />
      </div>
    </section>
  </dialog>
</template>

<style scoped>
.mobile-sheet {
  position: fixed;
  top: auto;
  left: 0;
  right: 0;
  bottom: 0;
  width: min(100%, 560px);
  max-width: 100%;
  margin: 0 auto;
  max-height: calc(100dvh - 40px);
  border: 1px solid var(--center-border);
  border-bottom: none;
  border-radius: 18px 18px 0 0;
  padding: 0;
  background: var(--board-surface);
  box-shadow: 0 -12px 36px rgb(53 39 20 / 20%);
  color: var(--color-text);
}

.mobile-sheet::backdrop {
  background: var(--overlay-scrim);
}

.mobile-sheet-panel {
  display: flex;
  flex-direction: column;
  max-height: calc(100dvh - 40px);
}

.mobile-sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 8px;
  border-bottom: 1px solid var(--color-border);
  margin-bottom: 12px;
}

.mobile-sheet-head h2 {
  margin: 0;
  color: var(--title-color);
  font-size: 1.15rem;
  font-weight: 800;
}

.mobile-sheet-close {
  min-height: 44px;
  padding: 0 14px;
  border: 1px solid var(--color-border);
  border-radius: 9px;
  background: transparent;
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  flex-shrink: 0;
}

.mobile-sheet-body {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  align-content: start;
  gap: 10px;
  padding: 0 14px max(14px, env(safe-area-inset-bottom));
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

@media (min-width: 768px) {
  .mobile-sheet-panel,
  .mobile-sheet-body {
    display: contents;
  }

  .mobile-sheet-head {
    display: none;
  }
}

@media (max-width: 767px) and (prefers-reduced-motion: no-preference) {
  .mobile-sheet {
    translate: 0 24px;
    opacity: 0;
    transition:
      translate 180ms cubic-bezier(0.4, 0, 1, 1),
      opacity 180ms ease,
      display 180ms allow-discrete,
      overlay 180ms allow-discrete;
  }

  .mobile-sheet[open] {
    translate: 0 0;
    opacity: 1;
    transition-duration: 320ms;
    transition-timing-function: cubic-bezier(0.22, 1, 0.36, 1);
  }

  .mobile-sheet::backdrop {
    background: transparent;
    transition: background 180ms ease, display 180ms allow-discrete, overlay 180ms allow-discrete;
  }

  .mobile-sheet[open]::backdrop {
    background: var(--overlay-scrim);
  }

  @starting-style {
    .mobile-sheet[open] {
      translate: 0 48px;
      opacity: 0;
    }

    .mobile-sheet[open]::backdrop {
      background: transparent;
    }
  }
}
</style>
