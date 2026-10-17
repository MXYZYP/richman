<script lang="ts">
let openSheetCount = 0;
let previousBodyOverflow = '';
</script>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

// 专用手机底部抽屉：native <dialog> 承载 —— top layer 天然挡住背景点击、Esc 即 cancel、
// 焦点被困在弹层内；打开时锁 body 滚动，关闭时把焦点还给「仍连接且可见」的触发元素。
// 两种 layout（桌面行为不同，手机端一律是底部抽屉）：
//   inline —— 默认。桌面端用 display:contents 把内容原位摊平进宿主容器（侧栏分组用）。
//   modal  —— 桌面端保持真正的居中弹窗（设置等需要独立入口的场合）。
const props = withDefaults(defineProps<{
  open: boolean;
  title: string;
  layout?: 'inline' | 'modal';
  /** 标题右侧的一小段状态文字（「本机」/「8 / 12」/「已绑定」…）。
      以前在 ViewShell 的返回条上，详情页改成弹窗后跟着搬进弹窗头部。 */
  aside?: string;
  /**
   * 能不能被关掉。默认可以。
   *
   * 只有「首次启动的隐私同意」用 false：那颗 ×、点背景板、按 Esc 都不该能把
   * 一次尚未作出的选择糊过去 —— 玩家必须明确点「同意」或「不同意」。
   */
  dismissible?: boolean;
}>(), {
  layout: 'inline',
  aside: '',
  dismissible: true,
});

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

/** Esc = 系统级「关闭」。不可关闭的弹窗（隐私同意）连这条也要吃掉。 */
function onCancel(): void {
  if (!props.dismissible) return;
  emit('close');
}

function requestClose(): void {
  if (!props.dismissible) return;
  emit('close');
}

function closeFromBackdrop(event: MouseEvent): void {
  if (event.target !== dialog.value) return;
  // 点背景板是最容易被当成「误触」的关闭方式，不可关闭的弹窗必须拦掉。
  requestClose();
}
</script>

<template>
  <dialog
    ref="dialog"
    class="mobile-sheet"
    :data-variant="layout"
    :aria-labelledby="titleId"
    @cancel.prevent="onCancel"
    @click="closeFromBackdrop"
  >
    <section class="mobile-sheet-panel">
      <header class="mobile-sheet-head">
        <h2 :id="titleId">{{ props.title }}<span v-if="props.aside !== ''" class="mobile-sheet-aside">{{ props.aside }}</span></h2>
        <button
          v-if="props.dismissible"
          ref="closeButton"
          type="button"
          class="mobile-sheet-close"
          :aria-label="`关闭${props.title}`"
          @click="requestClose"
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
  /* 底部抽屉：顶角与全局弹窗同档，底边贴着屏幕所以保持直角。 */
  border-radius: var(--radius-dialog) var(--radius-dialog) 0 0;
  padding: 0;
  background: var(--board-surface);
  box-shadow: 0 -12px 36px rgb(53 39 20 / 20%);
  color: var(--color-text);
  /* ★★ 把内部滚动区（含它的滚动条）裁进圆角 —— 这一句就是「右边直角」的解药。
     内容一长（玩法说明、成就、云同步…），.mobile-sheet-body 出现竖向滚动条；滚动条画在
     自己的边界盒里、右边缘正好压在弹窗的右边线上，一条通到底的直角灰条把右下角那块圆角
     整个盖掉：左边圆、右边直。滚动条不属于弹窗的直接盒，只有父级裁切才收得住它，
     所以裁在这一层，而不是给滚动层加 border-radius（那样会连正文首尾两行一起削角）。 */
  overflow: hidden;
}

.mobile-sheet::backdrop {
  background: var(--overlay-scrim);
}

.mobile-sheet-panel {
  display: flex;
  flex-direction: column;
  max-height: calc(100dvh - 40px);
}

/* 10-16 第四版：头部改成「标题**居中** + 关闭按钮贴右上」，照参考图把弹窗做成真正的对话框。
   三列等分栅格让标题落在水平中轴上（左右两侧 1fr 相等），
   不会因为右边多了一个按钮而整体左偏。 */
.mobile-sheet-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--color-border);
  margin-bottom: 12px;
}

.mobile-sheet-head h2 {
  grid-column: 2;
  margin: 0;
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 8px;
  min-width: 0;
  color: var(--title-color);
  font-size: var(--text-sheet-title);
  font-weight: 800;
  text-align: center;
}

.mobile-sheet-aside {
  color: var(--color-muted);
  font-size: var(--text-meta-size);
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.mobile-sheet-close {
  grid-column: 3;
  justify-self: end;
  min-height: 44px;
  padding: 0 14px;
  border: 1px solid var(--color-border);
  border-radius: 9px;
  background: transparent;
  color: var(--color-muted);
  font-size: var(--text-meta-size);
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
  /* 滚动条自己也要「不带直角」：细拇指 + 透明轨道（Firefox 走这两行，
     WebKit/Blink 走下面的伪元素）。父级的 overflow:hidden 负责把角裁圆，
     这两处负责别让一条浅灰方条先糊在右边线上。 */
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--color-muted) 40%, transparent) transparent;
}

.mobile-sheet-body::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.mobile-sheet-body::-webkit-scrollbar-track {
  background: transparent;
}

.mobile-sheet-body::-webkit-scrollbar-thumb {
  border-radius: var(--radius-chip);
  background: color-mix(in srgb, var(--color-muted) 40%, transparent);
}

/* 阈值从 768px 抬到 1024px，与 GameView 外壳的 isMobileLayout（max-width:1024px）一致。
   此前 768–1024px 区间里外壳认为是移动端（竖排 + 底部操作坞 + .sheet display:block），
   本组件却认为该走桌面分支（inline 摊平 / modal 居中弹窗），导致设置面板在竖排布局里
   弹出居中 modal 而非底部抽屉，与外壳形态不自洽。 */
@media (min-width: 1025px) {
  /* inline 变体：桌面端把抽屉外壳摊平成透明分组容器，内容直接流进宿主容器。 */
  .mobile-sheet[data-variant='inline'] .mobile-sheet-panel,
  .mobile-sheet[data-variant='inline'] .mobile-sheet-body {
    display: contents;
  }

  .mobile-sheet[data-variant='inline'] .mobile-sheet-head {
    display: none;
  }
}

/* modal 变体：**任何屏宽**都居中（10-16 第四版）。
   用户拿了参考图（手机上也居中弹窗）+「所有弹窗大小显示方式都要保持一致」。
   此前这段挂在 @media (min-width: 768px) 里：手机上退回底部抽屉、桌面上才居中 ——
   同一套弹窗两种长相，正是「不一致」的来源。现在整段提到顶层。
   ★ 宽度与高度**只在这里写一次**：谁都不许在别处再给弹窗改宽高，
   否则「所有弹窗尺寸一致」当场作废（components/sheetVariant.test.ts 会扫全仓）。 */
.mobile-sheet[data-variant='modal'] {
  top: 50%;
  bottom: auto;
  left: 50%;
  right: auto;
  translate: -50% -50%;
  width: min(92vw, 520px);
  max-width: 92vw;
  /* 上下都要留呼吸位：86dvh 在矮视口（笔记本 974×664 / 横屏手机）下也留出余量；
     dvh 而非 vh —— 移动端地址栏伸缩时 vh 不变、dvh 跟随可视区。 */
  max-height: min(86dvh, 720px);
  margin: 0;
  border: 1px solid var(--center-border);
  /* 四角都圆：底部抽屉是「上圆下直」（底边贴屏幕），居中弹窗不该留直角。
     数值走全局档位，与局内结算 / 资产 / 格详情同一个圆角 —— 四处各写一个数就会再散开。 */
  border-radius: var(--radius-dialog);
  border-bottom: 1px solid var(--center-border);
  box-shadow: 0 24px 64px rgb(53 39 20 / 28%);
}

.mobile-sheet[data-variant='modal'] .mobile-sheet-panel {
  max-height: min(86dvh, 720px);
}

/* 抽屉上滑进场：服务于「底部抽屉」形态，因此阈值必须与上面的形态分界互为补集。
 768–1024px 的 modal变体是居中弹窗，不该被这段"上滑"位移影响——
 它的 translate 承担居中职责（-50% -50%），一旦被这里覆盖成 0 24px，
 弹窗会整体偏移到视口右下角。 */
@media (max-width: 1024px) and (prefers-reduced-motion: no-preference) {
  .mobile-sheet:not([data-variant='modal']) {
    translate: 0 24px;
    opacity: 0;
    transition:
      translate 180ms cubic-bezier(0.4, 0, 1, 1),
      opacity 180ms ease,
      display 180ms allow-discrete,
      overlay 180ms allow-discrete;
  }

  .mobile-sheet:not([data-variant='modal'])[open] {
    translate: 0 0;
    opacity: 1;
    transition-duration: 320ms;
    transition-timing-function: cubic-bezier(0.22, 1, 0.36, 1);
  }

  .mobile-sheet:not([data-variant='modal'])::backdrop {
    background: transparent;
    transition: background 180ms ease, display 180ms allow-discrete, overlay 180ms allow-discrete;
  }

  .mobile-sheet:not([data-variant='modal'])[open]::backdrop {
    background: var(--overlay-scrim);
  }

  @starting-style {
    .mobile-sheet:not([data-variant='modal'])[open] {
      translate: 0 48px;
      opacity: 0;
    }

    .mobile-sheet[open]::backdrop {
      background: transparent;
    }
  }
}
</style>
