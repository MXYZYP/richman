<script setup lang="ts">
/**
 * 二级整页壳：一张居中的卡片 + 顶部返回条。**在线联网对战与单机模式共用这一个壳。**
 *
 * 为什么是共用组件
 *   这两页原来是各持一份壳（在线 `.home-shell/.home-card`、单机 `.setup-shell/.setup-card`），
 *   于是同一个「返回首页」一页在左上角、一页在最下面（用户原话：「单机跑到最下面，不合适」），
 *   卡片一处 560px、一处 720px。抄两份就一定漂移，所以壳只留一个。
 *
 * 尺寸只在这里写一次
 *   卡片宽度 / 内边距 / 圆角 / 底色 / 阴影、以及「窄屏顶部对齐、矮视口顶部对齐」这两条
 *   自适应规则，全都只写在本文件里。任何二级页都不许再给卡片改宽高
 *   （views/entryPageShell.test.ts 会扫全仓守着）。
 *
 * 返回条永远是「返回首页」在左、标题居中、状态字在右 —— 位置不随页面变。
 */
withDefaults(defineProps<{
  /** 页面标题，同时作为卡片的无障碍名。 */
  title: string;
  /** 右上角的一小段状态文字（「6 位房间码」/「无需联网」…）。留空则不渲染。 */
  aside?: string;
  /** 返回按钮上的字。默认「返回首页」。 */
  backLabel?: string;
  /** 返回按钮是否禁用（命令在途时防止重复提交）。默认可用。 */
  backDisabled?: boolean;
}>(), {
  aside: '',
  backLabel: '返回首页',
  backDisabled: false,
});

const emit = defineEmits<{ back: [] }>();
</script>

<template>
  <main class="view-shell">
    <section class="view-card" :aria-label="title">
      <header class="view-bar">
        <button
          type="button"
          class="view-bar__back"
          :disabled="backDisabled"
          @click="emit('back')"
        >{{ backLabel }}</button>
        <h1 class="view-bar__title">{{ title }}</h1>
        <span v-if="aside !== ''" class="view-bar__aside">{{ aside }}</span>
      </header>
      <slot />
    </section>
  </main>
</template>

<style scoped>
.view-shell {
  /* 与首页 .home-shell 同一套定位：移动端顶部对齐，桌面居中。
     100dvh 而非 100vh —— 移动端地址栏伸缩时 vh 不变、dvh 跟随可视区。
     安全区：index.html 开了 viewport-fit=cover，四边都要让出 inset，
     否则底部按钮会被 Home 指示条压住。 */
  position: relative;
  min-height: 100vh;
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding:
    max(18px, env(safe-area-inset-top))
    max(18px, env(safe-area-inset-right))
    max(18px, env(safe-area-inset-bottom))
    max(18px, env(safe-area-inset-left));
}

/* ★ 两个二级页的卡片就是这一条。宽 / 间距 / 内边距 / 圆角 / 底色 / 阴影全在这儿，
   别处再出现一次就等于「两页不一样」又回来了。 */
.view-card {
  position: relative;
  z-index: 1;
  width: min(560px, 100%);
  display: grid;
  gap: 18px;
  padding: clamp(20px, 4vw, 34px);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-card);
  background:
    var(--surface-card),
    var(--board-surface);
  box-shadow: 0 18px 48px rgb(53 39 20 / 14%);
}

.view-bar {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--color-border);
}

.view-bar__back {
  min-height: 36px;
  padding: 4px 12px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: transparent;
  color: var(--color-text);
  font-size: var(--text-body-size);
  font-weight: 800;
  cursor: pointer;
}

.view-bar__back:hover {
  border-color: var(--color-accent);
}

.view-bar__back:disabled {
  color: var(--color-muted);
  border-color: var(--color-border);
  cursor: not-allowed;
}

.view-bar__title {
  margin: 0;
  /* 与弹窗标题（MobileSheet .mobile-sheet-head h2）同号：都是 --text-sheet-title。
     用户要的「字体大小统一」—— 二级页和弹窗的标题不该点开一下就换字号。 */
  font-size: var(--text-sheet-title);
  font-weight: 900;
  text-align: center;
}

.view-bar__aside {
  color: var(--color-muted);
  font-size: var(--text-meta-size);
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}

/* 阈值与 GameView / MobileSheet 的紧凑布局（1024px）统一：
   折叠屏内屏与小平板竖屏的 CSS 宽度常落在 768–1024，用 767 会把它们误判成桌面。
   移动形态改为顶部对齐：单列内容常高于视口，居中会让首屏上下同时被裁。 */
@media (max-width: 1024px) {
  .view-shell {
    padding:
      max(10px, env(safe-area-inset-top))
      max(10px, env(safe-area-inset-right))
      max(10px, env(safe-area-inset-bottom))
      max(10px, env(safe-area-inset-left));
    place-items: start center;
  }
}

/* 矮视口（横屏手机、折叠屏半开）：一律顶部对齐，避免居中把内容上下切掉。 */
@media (max-height: 620px) {
  .view-shell {
    place-items: start center;
  }
}
</style>
