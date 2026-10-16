<script setup lang="ts">
/**
 * 二级页 / 详情页共用的页面壳：居中的一张卡片 + 顶部返回条。
 *
 * 为什么做成组件而不是各页各写一份：`.view-shell` / `.view-card` / `.view-bar` 这三段
 * 布局在两个二级页与四个详情页里完全一样，抄六遍迟早会漂移。做成组件后它是**自己 scoped**
 * 的 —— 每个视图各自的 `<style scoped>` 仍然只作用于自己的槽内容，两边互不干扰。
 *
 * 注意：槽内容由父组件编译，因此父组件自己的 scoped 规则照常命中它们；但**子组件**的
 * scoped 规则不会渗进槽里。这正是我们要的边界。
 */
withDefaults(defineProps<{
  /** 页面标题，同时作为卡片的无障碍名。 */
  title: string;
  /** 右上角的一小段状态文字（「本机」/「8 / 12」…）。留空则不渲染。 */
  aside?: string;
}>(), {
  aside: '',
});

const emit = defineEmits<{ back: [] }>();
</script>

<template>
  <main class="view-shell">
    <section class="view-card" :aria-label="title">
      <header class="view-bar">
        <button type="button" class="view-bar__back" @click="emit('back')">返回首页</button>
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
     100dvh 而非 100vh —— 移动端地址栏伸缩时 vh 不变、dvh 跟随可视区。 */
  display: grid;
  place-items: start center;
  min-height: 100dvh;
  padding:
    max(16px, env(safe-area-inset-top))
    max(12px, env(safe-area-inset-right))
    max(24px, env(safe-area-inset-bottom))
    max(12px, env(safe-area-inset-left));
}

.view-card {
  display: grid;
  gap: 14px;
  width: min(560px, 100%);
  padding: 18px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--surface-raised);
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
  font-size: 13px;
  font-weight: 800;
  cursor: pointer;
}

.view-bar__back:hover {
  border-color: var(--color-accent);
}

.view-bar__title {
  margin: 0;
  font-size: 17px;
  font-weight: 900;
  text-align: center;
}

.view-bar__aside {
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 1024px) {
  .view-shell {
    padding:
      max(10px, env(safe-area-inset-top))
      max(10px, env(safe-area-inset-right))
      max(10px, env(safe-area-inset-bottom))
      max(10px, env(safe-area-inset-left));
  }
}
</style>
