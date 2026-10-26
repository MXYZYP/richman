<script setup lang="ts">
import { ref } from 'vue';
import MobileSheet from './MobileSheet.vue';

/**
 * 首次启动的隐私同意拦截。
 *
 * 为什么必须拦：TapTap「开放试玩」上架要求隐私合规 —— 政策不仅要能打开，
 * 还要玩家**明确同意过**才能开始收集（本作的昵称与联机数据）。
 *
 * 三条刻意的设计：
 *  1. **不可关闭**（MobileSheet 的 `dismissible=false`）：×、点背景板、按 Esc 都不该把
 *     一次尚未作出的选择糊过去。没有「稍后再说」这种模糊态。
 *  2. **不同意有明确出口**：不是把按钮藏起来，而是告诉他「不同意就无法进入游戏」，
 *     并保留「重新考虑」「再读一遍政策」两条路 —— 网页环境没有「退出 App」可点。
 *  3. **不在 SSR / 无痕模式里出现**：由调用方用 `hasAcceptedPrivacy()` 判断后 `v-if`，
 *     拿不到 storage 时该函数返回 true。这里不自己读存储，保证组件本身可测。
 */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ accept: []; openPolicy: [] }>();

/** 本轮点了「不同意」：换成拒绝态，而不是把弹窗关掉。 */
const declined = ref(false);
</script>

<template>
  <MobileSheet
    :open="props.open"
    layout="modal"
    title="隐私政策与个人信息"
    :dismissible="false"
  >
    <view class="gate">
      <template v-if="!declined">
        <view class="gate-lead">
          开始之前，先说明这个游戏会用到哪些信息。一共三类，没有广告，也没有统计 SDK。
        </view>
        <view class="gate-list">
          <view><text>昵称</text>：你填的显示名，只用于同房间玩家认出你、以及排行榜展示。</view>
          <view><text>本机存档</text>：对局进度、设置、成就存在你自己的设备上，不上传。</view>
          <view><text>联机数据</text>：房间码与掷骰、买地等操作，只为让这一局正常进行，结束后不保留。</view>
        </view>
        <button type="button" class="gate-link" @click="emit('openPolicy')">查看完整《隐私政策》</button>
        <view class="gate-actions">
          <button type="button" class="gate-primary" @click="emit('accept')">同意并继续</button>
          <button type="button" class="gate-ghost" @click="declined = true">不同意</button>
        </view>
      </template>

      <template v-else>
        <view class="gate-lead" role="alert">
          不同意这些条款，就无法进入游戏 —— 联机对战与存档都要用到上面这几项信息。
          你仍然可以再读一遍政策，或者改变主意。
        </view>
        <button type="button" class="gate-link" @click="emit('openPolicy')">再读一遍《隐私政策》</button>
        <view class="gate-actions">
          <button type="button" class="gate-primary" @click="declined = false">重新考虑</button>
        </view>
      </template>
    </view>
  </MobileSheet>
</template>

<style scoped>
/* 字号只走命名档位（ui/sheetTypography.test.ts 扫全仓守着）。 */
.gate {
  display: grid;
  gap: 14px;
  color: var(--color-text);
  font-size: var(--text-body-size);
  line-height: 1.6;
}

.gate-lead {
  margin: 0;
  color: var(--color-muted);
}

.gate-list {
  margin: 0;
  padding-left: 18px;
  display: grid;
  gap: 6px;
}

.gate-link {
  justify-self: start;
  min-height: 44px;
  padding: 6px 2px;
  border: 0;
  background: transparent;
  color: var(--color-primary);
  font: inherit;
  font-weight: 900;
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}

.gate-actions {
  display: grid;
  gap: 10px;
}

.gate-primary,
.gate-ghost {
  min-height: 46px;
  border-radius: var(--radius-control);
  font: inherit;
  font-size: 1rem;
  font-weight: 900;
  cursor: pointer;
}

.gate-primary {
  border: 1px solid var(--color-primary);
  background: var(--color-primary);
  color: #fff;
}

.gate-ghost {
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-muted);
}
</style>
