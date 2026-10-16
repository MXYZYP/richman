<script setup lang="ts">
import { ref } from 'vue';
import { currentRelease, releaseCatalog } from '../releaseCatalog';
import MobileSheet from './MobileSheet.vue';

/**
 * 10-16 第五版：弹窗本体改走 `MobileSheet` 的 modal 变体。
 *
 * 它此前是全项目**唯一一个自带 `<dialog>` 的首页弹窗**：宽 min(720px, 100%-24px)、
 * 高 min(760px, 100dvh-24px)、圆角 24px、遮罩 58% + 模糊、自绘的「大标题 + 大关闭按钮」头部
 * （标题 clamp(24px, 5vw, 34px)、关闭按钮 44×44 带个 22px 的 ×）。
 * 于是同一屏里点「战绩」是 520px / 16px 圆角 / 1.15rem 标题的居中弹窗，点「更新说明」
 * 却换成完全另一套 —— 这正是用户说的「弹窗样式大小不统一」。
 * 现在它和另外五个弹窗共用同一份壳：尺寸、圆角、遮罩、标题字号、关闭按钮全部由
 * MobileSheet 的 modal 规则决定，**本文件一个宽高都不写**（components/sheetVariant.test.ts 扫全仓守着）。
 *
 * defer（默认 false）＝「首次点击才渲染正文」：
 *   首页那颗入口就在首屏，整段文本一起出来最省事，SSR 渲染出的 HTML 也自带完整版本记录；
 *   嵌在设置面板这类深处时如果照旧预先渲染，大厅与对局两个视图的已渲染文本里都会多出一整份
 *   更新说明 —— 既白白增重 DOM，也会让那些「观战者不该看到某某字样」的按文本断言被
 *   **无关的历史条目**误伤。关闭后再把正文释放掉，保持占用是临时的。
 *
 * ★ `open` 与 `bodyVisible` 是两件事，不能合并：
 *     open        = 弹窗现在是否显示
 *     bodyVisible = 正文是否已经渲染（defer 省的就是这部分）
 *   原来只有一个 `opened` 兼任两者。换成 MobileSheet 之后，`open === true` 会在**挂载时**
 *   立刻把弹窗弹出来 —— 首页一进来就糊一脸更新说明。所以 defer=false 时正文从挂载起就在，
 *   弹窗依然关着，等玩家点那颗入口。
 */
const props = withDefaults(defineProps<{ defer?: boolean }>(), { defer: false });

const open = ref(false);
const bodyVisible = ref(!props.defer);
const releases = releaseCatalog.releases;

function show(): void {
  bodyVisible.value = true;
  open.value = true;
}

/** 关闭：原生 Esc、点遮罩、点「关闭」都走这里。 */
function handleClose(): void {
  open.value = false;
  if (props.defer) bodyVisible.value = false;
}
</script>

<template>
  <button type="button" class="release-notes-trigger" @click="show">
    v{{ currentRelease.version }} · 更新说明
  </button>
  <MobileSheet
    layout="modal"
    :open="open"
    title="更新说明"
    :aside="`当前版本 v${currentRelease.version}`"
    @close="handleClose"
  >
    <div
      v-if="bodyVisible"
      class="release-notes-body"
      role="region"
      aria-label="更新说明列表"
      tabindex="0"
    >
      <section
        v-for="(release, index) in releases"
        :key="release.version"
        class="release-entry"
        :class="{ current: index === 0 }"
        :aria-labelledby="`release-${release.version}`"
      >
        <div class="release-marker" aria-hidden="true"></div>
        <div class="release-entry-content">
          <div class="release-meta">
            <span class="release-version">v{{ release.version }}</span>
            <span v-if="index === 0" class="release-current">当前版本</span>
            <time :datetime="release.date">{{ release.date }}</time>
          </div>
          <h3 :id="`release-${release.version}`">{{ release.title }}</h3>
          <ul>
            <li v-for="change in release.changes" :key="change">{{ change }}</li>
          </ul>
        </div>
      </section>
    </div>
  </MobileSheet>
</template>

<style scoped>
/* 弹窗外壳（尺寸 / 圆角 / 遮罩 / 标题 / 关闭按钮 / 正文滚动）全在 MobileSheet 里。
   本文件只有「时间线」这一件事的排版，外加那颗页脚入口。 */

.release-notes-trigger {
  min-height: 44px;
  padding: 6px 10px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--color-primary);
  font: inherit;
  /* 10-16 首页页脚反馈「更新说明颜色太浅」⇒ 提到与备案号同一档 13px（原来 12px）。 */
  font-size: var(--text-body-size);
  font-weight: 900;
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}

.release-notes-trigger:focus-visible {
  outline: 3px solid var(--color-accent);
  outline-offset: 2px;
}

.release-notes-body {
  display: grid;
  gap: 12px;
  min-height: 0;
}

.release-entry {
  position: relative;
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 12px;
  padding: 0 0 24px;
}

.release-entry:last-child {
  padding-bottom: 0;
}

/* 时间轴那条竖线：从当前圆点到下一个条目，最后一个不画。 */
.release-entry::before {
  content: '';
  position: absolute;
  top: 18px;
  bottom: -2px;
  left: 8px;
  width: 2px;
  background: var(--color-border);
}

.release-entry:last-child::before {
  display: none;
}

.release-marker {
  position: relative;
  z-index: 1;
  width: 18px;
  height: 18px;
  margin-top: 10px;
  border: 4px solid var(--board-surface);
  border-radius: 999px;
  background: var(--color-muted);
  box-shadow: 0 0 0 1px var(--color-border);
}

.release-entry.current .release-marker {
  background: var(--color-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 55%, transparent);
}

.release-entry-content {
  min-width: 0;
  padding: 10px 14px 12px;
  border: 1px solid var(--color-border);
  border-radius: 16px;
  /* 原来是 rgb(255 255 255 / 68%)：暗色模式下会变成一块白面板。改用有暗色覆盖的变量。 */
  background: var(--surface-raised);
}

.release-entry.current .release-entry-content {
  border-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 14%, var(--board-surface));
}

.release-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
  color: var(--color-muted);
  font-size: var(--text-meta-size);
  font-weight: 800;
}

.release-version {
  color: var(--color-primary);
  font-size: var(--text-section-size);
  font-weight: 950;
}

.release-current {
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--color-primary);
  color: var(--button-enabled-text);
  font-size: var(--text-badge-size);
  letter-spacing: 0.05em;
}

.release-meta time {
  margin-left: auto;
}

.release-entry h3 {
  margin: 7px 0 8px;
  color: var(--color-text);
  font-size: var(--text-section-size);
  font-weight: 900;
}

.release-entry ul {
  display: grid;
  gap: 6px;
  margin: 0;
  padding-left: 20px;
  color: var(--color-muted);
  font-size: var(--text-body-size);
  line-height: 1.55;
}

@media (max-width: 520px) {
  .release-entry {
    grid-template-columns: 18px minmax(0, 1fr);
    gap: 10px;
  }

  .release-entry::before {
    left: 6px;
  }

  .release-marker {
    width: 14px;
    height: 14px;
    border-width: 3px;
    margin-top: 9px;
  }

  .release-entry-content {
    padding: 9px 11px 11px;
  }

  .release-meta time {
    width: 100%;
    margin-left: 0;
  }
}
</style>
