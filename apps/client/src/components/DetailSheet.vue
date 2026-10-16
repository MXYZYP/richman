<script setup lang="ts">
/**
 * 首页图标详情的弹窗外壳（10-16 第四版）。
 *
 * 四个图标入口（战绩 / 成就 / 云同步 / 排行榜）原来是**整页第二屏**（`ViewShell`），
 * 用户：「跳到第二屏感觉很突兀，而且显示内容也不是很多」⇒ 改成压在首页上的弹窗。
 *
 * 它只是 `MobileSheet` 的一层薄包装，刻意**不写任何宽高**：
 * 「所有弹窗大小、显示方式一致」这条要求靠「尺寸只在 MobileSheet 的 modal 变体里写一次」
 * 来保证；一旦哪个弹窗自己加一句 width / max-height，这条承诺立刻就散了
 * （守卫 `components/sheetVariant.test.ts` 会在全仓范围扫这两个数值）。
 *
 * 传 `open` 而不是恒真：把它留成 prop，是因为「是否打开」属于调用方（App）的状态，
 * 组件自身不该假设自己永远可见 —— 那样以后想给它加个进出场动画就没地方挂了。
 */
import MobileSheet from './MobileSheet.vue';

withDefaults(defineProps<{
  /** 弹窗是否打开。 */
  open: boolean;
  /** 弹窗标题，同时作为弹窗的无障碍名。 */
  title: string;
  /** 标题右侧的一小段状态文字（「本机」/「8 / 12」/「已绑定」…）。留空则不渲染。 */
  aside?: string;
}>(), {
  aside: '',
});

const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <MobileSheet
    layout="modal"
    :open="open"
    :title="title"
    :aside="aside"
    @close="emit('close')"
  >
    <slot />
  </MobileSheet>
</template>
