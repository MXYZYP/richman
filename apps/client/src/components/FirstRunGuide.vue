<script setup lang="ts">
import MobileSheet from './MobileSheet.vue';

/**
 * 新手引导 / 玩法说明（路线图 #109）。
 *
 * 两条入口共用这一个组件：
 *  1. **首次进首页自动弹一次**（「已看过」标记见 `session/firstRunGuide.ts`）；
 *  2. **首页「玩法说明」按钮随时可重开** —— 主动打开不改标记（主动 ≠ 第一次）。
 *
 * 复用设置面板同一套 `MobileSheet layout="modal"`：手机是底部抽屉、桌面是居中弹窗。
 * native `<dialog>` 天然挡背景 / Esc 关闭 / 锁 body 滚动 / 关闭后焦点回到触发元素，
 * 这里不必再造一层弹层，两处弹窗的表现也就永远一致。
 *
 * 内容只讲「怎么开局、怎么走、怎么赢、联机要注意什么」四件事，**刻意不写任何具体数值**
 * （初始资金、地产档位、限时秒数…）—— 那些按地图与房间设置各不相同，设置面板里的
 * 「规则说明」已经按当前地图渲染过一份了；这里再抄一份，只会随着规则调整而悄悄过期。
 */
defineProps<{ open: boolean }>();

const emit = defineEmits<{ close: [] }>();

const SECTIONS: readonly { title: string; items: readonly string[] }[] = [
  {
    title: '一、怎么开局',
    items: [
      '联机：填好昵称点「创建房间」，把 6 位房间码或分享链接发给好友；好友在首页填码即可加入。',
      '建房后先进入房间大厅：房主可以添加电脑玩家、调整电脑难度、自定义初始资金等规则，人齐后由房主点「开始」。',
      '单机：点「单机游玩（无需联网）」，同一台设备上轮流操作，不需要任何网络。',
      '只想看不操作，可以在首页选「观战」加入 —— 观战仅查看棋盘、资产与战报。',
    ],
  },
  {
    title: '二、回合怎么走',
    items: [
      '轮到你时掷骰前进，棋子按点数落在棋盘格上。',
      '停在无主地产可以按标价买下；停在自家地产可以加盖房屋，等级越高对手要付的过路费越高。',
      '停在对手的地产要付过路费；现金不够时会先抵押或变卖资产来凑钱。',
      '机会、命运、机场、巡游等格子各有各的效果，踩到后按提示处理即可。',
    ],
  },
  {
    title: '三、怎么算赢',
    items: [
      '本局目标在设置面板的「规则说明」里写着：现金达到目标金额即获胜。',
      '或者把对手全部打到破产出局，最后留在场上的人也直接获胜。',
    ],
  },
  {
    title: '四、联机小贴士',
    items: [
      '每步限时：房主可以给每回合设限时，超时会自动替你走一步，不用怕有人一直不点。',
      '公开房间：房主把房间设为公开后，别人能在首页「公开房间」列表里直接加入或旁观。',
      '快捷短语：聊天框上方那一排按钮点一下就发出去，手机上不必打字。',
      '断线：掉线后凭本机记录重连可以收回自己的控制权；确实回不来时，其他玩家也可以把你交给电脑托管。',
    ],
  },
];
</script>

<template>
  <MobileSheet layout="modal" :open="open" title="玩法说明" @close="emit('close')">
    <p class="guide-lead">三分钟看懂：怎么开局、怎么走、怎么赢。</p>

    <section v-for="section in SECTIONS" :key="section.title" class="guide-section">
      <h3>{{ section.title }}</h3>
      <ul>
        <li v-for="item in section.items" :key="item">{{ item }}</li>
      </ul>
    </section>

    <button type="button" class="guide-dismiss" @click="emit('close')">知道了</button>
  </MobileSheet>
</template>

<style scoped>
.guide-lead {
  margin: 0;
  color: var(--color-muted);
  font-size: 13px;
  line-height: 1.6;
}

.guide-section {
  display: grid;
  gap: 6px;
}

.guide-section h3 {
  margin: 0;
  color: var(--title-color);
  font-size: 14px;
  font-weight: 800;
}

.guide-section ul {
  margin: 0;
  padding-left: 18px;
  display: grid;
  gap: 4px;
}

.guide-section li {
  color: var(--color-text);
  font-size: 13px;
  line-height: 1.65;
}

.guide-dismiss {
  justify-self: start;
  min-height: 44px;
  margin-top: 4px;
  padding-inline: 20px;
  border: 0;
  border-radius: 12px;
  background: var(--button-enabled-bg);
  color: var(--button-enabled-text);
  font-size: 0.95rem;
  font-weight: 900;
  cursor: pointer;
}
</style>
