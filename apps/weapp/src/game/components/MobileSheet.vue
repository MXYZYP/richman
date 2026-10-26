<script lang="ts">
let openSheetCount = 0;
let previousBodyOverflow = '';
</script>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue';

/**
 * 小程序端弹层基座（源站 components/MobileSheet.vue 的移植版）。
 *
 * 源站用原生 `<dialog>` + showModal()：top layer 挡背景、Esc 取消、焦点被困。
 * 小程序没有 dialog，也没有 top layer，所以这里换成：
 *
 *   一层 fixed 遮罩（替代 ::backdrop）+ 一层 fixed 面板
 *
 * 尺寸规则**逐字保留**（modal 变体 min(92vw,520px) / max-height:min(86dvh,720px)）——
 * 那是全项目弹窗大小的唯一事实源，改这里等于把所有弹窗一起改掉。
 *
 * 丢失的能力：Esc 关闭（小程序没有物理返回键事件）、焦点陷阱（小程序无键盘焦点）。
 * 这两个在触屏上本来也用不到。
 */
const props = withDefaults(defineProps<{
  open: boolean;
  title: string;
  layout?: 'inline' | 'modal';
  aside?: string;
  dismissible?: boolean;
}>(), {
  layout: 'inline',
  aside: '',
  dismissible: true,
});

const emit = defineEmits<{ close: [] }>();

const titleId = `mobile-sheet-title-${props.title}`;
let holdsScrollLock = false;

function lockScroll(): void {
  if (openSheetCount === 0) previousBodyOverflow = document.body.style.overflow;
  openSheetCount += 1;
  holdsScrollLock = true;
  document.body.style.overflow = 'hidden';
}

function unlockScroll(): void {
  if (!holdsScrollLock) return;
  holdsScrollLock = false;
  openSheetCount -= 1;
  if (openSheetCount === 0) document.body.style.overflow = previousBodyOverflow;
}

watch(() => props.open, (isOpen, wasOpen) => {
  if (isOpen === wasOpen) return;
  if (isOpen) lockScroll();
  else unlockScroll();
}, { flush: 'post' });

onMounted(() => {
  if (props.open) lockScroll();
});

onBeforeUnmount(() => {
  unlockScroll();
});

function requestClose(): void {
  if (!props.dismissible) return;
  emit('close');
}

/** 点遮罩关闭。面板自身的点击由 @click.stop 拦下，不会冒到这里。 */
function onBackdropTap(): void {
  requestClose();
}

</script>

<template>
  <view class="mobile-sheet-root">
    <view
      v-show="open"
      class="mobile-sheet-backdrop"
      @click="onBackdropTap"
    />
    <view
      v-show="open"
      class="mobile-sheet"
      :data-variant="layout"
      :aria-labelledby="titleId"
      @click.stop
    >
      <view class="mobile-sheet-panel">
        <view class="mobile-sheet-head">
          <view :id="titleId" class="mobile-sheet-title">{{ props.title }}<text v-if="props.aside !== ''" class="mobile-sheet-aside">{{ props.aside }}</text></view>
          <button
            v-if="props.dismissible"
            type="button"
            class="mobile-sheet-close"
            :aria-label="`关闭${props.title}`"
            @click="requestClose"
          >关闭</button>
        </view>
        <view class="mobile-sheet-body">
          <slot />
        </view>
      </view>
    </view>
  </view>
</template>

<style scoped>
/* 遮罩：替代 dialog::backdrop。层级压在页面之上、面板之下。 */
.mobile-sheet-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: var(--overlay-scrim);
}

.mobile-sheet {
  position: fixed;
  top: auto;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 61;
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
  /* ★★ 把内部滚动区（含它的滚动条）裁进圆角 —— 内容一长，滚动条会铺到右边缘
     把右下圆角盖成直角。裁切必须在这一层，不能给滚动层加 border-radius。 */
  overflow: hidden;
}

.mobile-sheet-panel {
  display: flex;
  flex-direction: column;
  max-height: calc(100dvh - 40px);
}

.mobile-sheet-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--color-border);
  margin-bottom: 12px;
}

.mobile-sheet-title {
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
}

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

/* modal 变体：**任何屏宽**都居中。
   ★ 宽度与高度只在这里写一次：谁都不许在别处再给弹窗改宽高。 */
.mobile-sheet[data-variant='modal'] {
  top: 50%;
  bottom: auto;
  left: 50%;
  right: auto;
  translate: -50% -50%;
  width: min(92vw, 520px);
  max-width: 92vw;
  max-height: min(86dvh, 720px);
  margin: 0;
  border: 1px solid var(--center-border);
  /* 四角都圆：底部抽屉是「上圆下直」（底边贴屏幕），居中弹窗不该留直角。 */
  border-radius: var(--radius-dialog);
  border-bottom: 1px solid var(--center-border);
  box-shadow: 0 24px 64px rgb(53 39 20 / 28%);
}
</style>
