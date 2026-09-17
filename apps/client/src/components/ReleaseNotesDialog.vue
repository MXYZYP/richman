<script setup lang="ts">
import { ref } from 'vue';
import { currentRelease, releaseCatalog } from '../releaseCatalog';

const dialog = ref<HTMLDialogElement | null>(null);
const releases = releaseCatalog.releases;

function show(): void {
  if (dialog.value !== null && !dialog.value.open) dialog.value.showModal();
}

function close(): void {
  dialog.value?.close();
}

function closeFromBackdrop(event: MouseEvent): void {
  if (event.target === dialog.value) close();
}

</script>

<template>
  <button type="button" class="release-notes-trigger" @click="show">
    v{{ currentRelease.version }} · 更新说明
  </button>
  <dialog
    ref="dialog"
    class="release-notes-dialog"
    aria-labelledby="release-notes-title"
    @click="closeFromBackdrop"
  >
    <article class="release-notes-sheet">
      <header class="release-notes-header">
        <div>
          <p class="release-notes-eyebrow">当前版本 v{{ currentRelease.version }}</p>
          <h2 id="release-notes-title">更新说明</h2>
        </div>
        <button type="button" class="release-notes-close" aria-label="关闭更新说明" @click="close">
          <span aria-hidden="true">×</span>
          <span class="release-notes-close-label">关闭</span>
        </button>
      </header>

      <div class="release-notes-body" role="region" aria-label="更新说明列表" tabindex="0">
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
    </article>
  </dialog>
</template>

<style scoped>
.release-notes-trigger {
  min-height: 44px;
  padding: 6px 10px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--color-primary);
  font: inherit;
  font-size: 12px;
  font-weight: 900;
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}

.release-notes-trigger:focus-visible {
  outline: 3px solid var(--color-accent);
  outline-offset: 2px;
}

.release-notes-dialog {
  width: min(720px, calc(100% - 24px));
  max-width: none;
  max-height: min(760px, calc(100dvh - 24px));
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: 24px;
  background: transparent;
  color: var(--color-text);
  box-shadow: 0 24px 80px rgb(42 31 19 / 32%);
  overflow: hidden;
}

.release-notes-dialog::backdrop {
  background: rgb(31 25 18 / 58%);
  backdrop-filter: blur(4px);
}

.release-notes-sheet {
  max-height: min(760px, calc(100dvh - 24px));
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  background:
    linear-gradient(180deg, rgb(255 255 255 / 96%), rgb(247 243 234 / 96%)),
    var(--board-surface);
}

.release-notes-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 22px 24px 18px;
  border-bottom: 1px solid var(--color-border);
}

.release-notes-header > div {
  min-width: 0;
}

.release-notes-eyebrow {
  margin: 0 0 4px;
  color: var(--color-primary);
  font-size: 12px;
  font-weight: 900;
  letter-spacing: 0.12em;
}

.release-notes-header h2 {
  margin: 0;
  font-size: clamp(24px, 5vw, 34px);
  line-height: 1.1;
}

.release-notes-close {
  min-width: 44px;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  flex: 0 0 auto;
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: rgb(255 255 255 / 74%);
  color: var(--color-text);
  font: inherit;
  font-weight: 900;
  cursor: pointer;
}

.release-notes-close span[aria-hidden='true'] {
  font-size: 22px;
  line-height: 1;
}

.release-notes-close:focus-visible {
  outline: 3px solid var(--color-accent);
  outline-offset: 2px;
}

.release-notes-body {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 18px 24px 26px;
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
  background: rgb(255 255 255 / 68%);
}

.release-entry.current .release-entry-content {
  border-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 12%, white);
}

.release-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 800;
}

.release-version {
  color: var(--color-primary);
  font-size: 14px;
  font-weight: 950;
}

.release-current {
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--color-primary);
  color: var(--button-enabled-text);
  font-size: 10px;
  letter-spacing: 0.05em;
}

.release-meta time {
  margin-left: auto;
}

.release-entry h3 {
  margin: 7px 0 8px;
  color: var(--color-text);
  font-size: 17px;
}

.release-entry ul {
  display: grid;
  gap: 6px;
  margin: 0;
  padding-left: 20px;
  color: var(--color-muted);
  font-size: 14px;
  line-height: 1.55;
}

@media (max-width: 520px) {
  .release-notes-dialog,
  .release-notes-sheet {
    max-height: calc(100dvh - 16px);
  }

  .release-notes-dialog {
    width: calc(100% - 16px);
    border-radius: 20px;
  }

  .release-notes-header {
    padding: 16px 16px 14px;
  }

  .release-notes-close {
    padding-inline: 10px;
  }

  .release-notes-close-label {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .release-notes-body {
    padding: 14px 14px 20px;
  }

  .release-entry {
    grid-template-columns: 14px minmax(0, 1fr);
    gap: 9px;
    padding-bottom: 18px;
  }

  .release-entry::before {
    left: 6px;
  }

  .release-marker {
    width: 14px;
    height: 14px;
    border-width: 3px;
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
