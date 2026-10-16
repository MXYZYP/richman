<script setup lang="ts">
import ReleaseNotesDialog from '../components/ReleaseNotesDialog.vue';

/**
 * 首页 = 纯入口页（《UI 改造方案》§二、§四）。
 *
 * 改造前这里塞着：标题、三个次要入口、本机存档、上一局恢复、我的战绩、成就折叠块、战绩码、
 * 云同步、排行榜、建房表单、加入表单、公开房间列表、单机按钮、页脚 —— 一屏放不下，主次不分。
 * 现在它只回答一个问题：**接下来玩什么**。
 *
 * 上下各司其职：上半屏只放游戏名与一句话（视觉锚点）；下半屏从「选玩法」到「看成果」
 * 按使用频率递减排下去，视线一条直线走完：
 *   两个等宽主按钮      在线联网对战 / 单机模式      ← 二级页承载全部细节
 *   三个胶囊次要入口    玩法说明 / 导入回看 / 地图工坊 ← 保持弹层，本来就对
 *   一排 4 个成果图标   战绩 / 成就 / 云同步 / 排行榜   ← 只留入口，明细点进去看
 *
 * **这一页不读任何存储、不发任何请求** —— 它是一张导航图，不是一个仪表盘。
 * 代价是「成就 8 / 12」那种角标数字不再出现在首页（《UI 改造方案》§四的图标行里也没有它），
 * 换来的是首屏包不必再为这几个数字拖进战绩与成就两个模块。
 *
 * 方向全部走 `navigate` 一个事件：六个落点都由 App 决定挂哪个视图，
 * 首页自己不需要知道「在线对战页」长什么样。
 */
withDefaults(defineProps<{ submitting?: boolean }>(), {
  submitting: false,
});

const emit = defineEmits<{
  /** 六个落点：两个二级页 + 四个成果详情页。 */
  navigate: [target: 'online' | 'local' | 'stats' | 'achievements' | 'cloud' | 'leaderboard'];
  /** 打开「玩法说明」（#109）：首次进站会自动弹一次，这里是不想等/想重看时的入口。 */
  openGuide: [];
  /** 打开「导入复盘」（#115）：收到别人发来的复盘码时，首页就是入口。 */
  openReplay: [];
  /** 打开「地图工坊」（#117）：本机装自定义地图、单机试玩、删掉不要的那张。 */
  openWorkshop: [];
}>();
</script>

<template>
  <main class="home-shell">
    <!-- 首页场景（纯 CSS + 内联 SVG 绘制，无外链图片）：一张摊开的桌面 ——
         纸面、虚线棋路、两枚骰子、三枚棋子、一只茶盏、一方印章。
         全部由 CSS 变量上色，所以深色模式自动跟着变；整块 aria-hidden，不参与无障碍树。 -->
    <div class="home-scene" aria-hidden="true">
      <svg class="home-scene__art" viewBox="0 0 400 800" preserveAspectRatio="xMidYMid slice" focusable="false">
        <rect class="scene-sheet" x="26" y="118" width="348" height="566" rx="20" transform="rotate(-4 200 400)" />
        <path class="scene-route" d="M74 300H330V432H74V566H330" />
        <g class="scene-tile">
          <rect x="58" y="286" width="48" height="24" rx="6" />
          <rect x="124" y="286" width="48" height="24" rx="6" />
          <rect x="282" y="418" width="48" height="24" rx="6" />
          <rect x="58" y="552" width="48" height="24" rx="6" />
          <rect x="282" y="552" width="48" height="24" rx="6" />
        </g>
        <g class="scene-dice" transform="rotate(-14 100 200)">
          <rect x="72" y="172" width="56" height="56" rx="14" />
          <circle cx="89" cy="189" r="5" />
          <circle cx="111" cy="211" r="5" />
          <circle cx="100" cy="200" r="5" />
        </g>
        <g class="scene-dice" transform="rotate(11 306 218)">
          <rect x="278" y="190" width="56" height="56" rx="14" />
          <circle cx="295" cy="207" r="5" />
          <circle cx="317" cy="207" r="5" />
          <circle cx="295" cy="229" r="5" />
          <circle cx="317" cy="229" r="5" />
        </g>
        <g class="scene-pawn">
          <g transform="translate(118 648)">
            <circle cx="0" cy="-18" r="12" />
            <path d="M-15 18C-15 0-8-9 0-9s15 9 15 27z" />
          </g>
          <g transform="translate(192 678)">
            <circle cx="0" cy="-18" r="12" />
            <path d="M-15 18C-15 0-8-9 0-9s15 9 15 27z" />
          </g>
          <g transform="translate(262 640)">
            <circle cx="0" cy="-18" r="12" />
            <path d="M-15 18C-15 0-8-9 0-9s15 9 15 27z" />
          </g>
        </g>
        <g class="scene-cup" transform="rotate(-8 330 712)">
          <path d="M298 684h60l-8 42h-44z" />
          <path d="M358 690c19 0 19 24 0 24" />
        </g>
        <g class="scene-stamp" transform="translate(76 730)">
          <circle cx="0" cy="0" r="30" />
          <path d="M-13-13 13 13M13-13-13 13" />
        </g>
      </svg>
    </div>
    <section class="home-card" aria-labelledby="home-title">
      <header class="home-hero">
        <p class="home-eyebrow">纸上中国 · 一局走遍山河</p>
        <!-- 贴纸化标题（参考《完美清洁公司》的 Logo 手法）：逐字换色 + 粗描边 + 微旋转。
             前导「进入」用视觉隐藏保留在无障碍名里，所以标题的可访问名仍是「进入大富翁」
             （e2e 的 heading 定位依赖它），眼睛看到的只有贴纸「大富翁」。 -->
        <h1 id="home-title" class="home-sticker"><span class="home-sticker__lead">进入</span><span class="home-sticker__char">大</span><span class="home-sticker__char">富</span><span class="home-sticker__char">翁</span></h1>
        <p class="home-sticker__sub">中国之旅</p>
        <p class="home-copy">用 6 位房间码和好友同桌，或单机游玩开一局。手机、电脑浏览器皆可。</p>
        <!-- 两个等宽主按钮、两种色、地位对等：在线=朱砂，单机=竹青。
             刻意不用 --color-pay / --color-gain 给模式上色 —— 那两个是「钱在动」的语义色。
             两个按钮各带一行同样字数的副行，把「按下去会发生什么」写在按钮上：
             在线那个把人送到「在线对战页」（建房 / 加入 / 公开房间列表都在那儿），
             单机那个把人送到「单机模式页」（点里面的「开始新对局」直接开局）。 -->
        <div class="home-main-actions">
          <button type="button" class="home-main home-main--online" :disabled="submitting" @click="emit('navigate', 'online')">
            在线联网对战
            <span class="home-main__hint">开房 / 加入</span>
          </button>
          <button type="button" class="home-main home-main--local" :disabled="submitting" @click="emit('navigate', 'local')">
            单机模式
            <span class="home-main__hint">无需联网</span>
          </button>
        </div>
      </header>

      <!-- 玩法说明入口（#109）：首次进站会自动弹一次；这里是「想重看」或「没看到那次弹窗」的兜底。
           旁边并列「导入复盘」（#115）：别人发来一段复盘码时，首页就是入口 ——
           不该逼玩家先随便开一局，才能找到粘贴的地方。
           再旁边是「地图工坊」（#117）：本机装自定义地图的地方。三条入口都是「不需要先开一局」
           的动作，归在同一行；地图工坊那条刻意不叫「自定义地图」，因为玩家要装的正是编辑器导出的东西。 -->
      <div class="home-entry-row">
        <button type="button" class="home-guide" @click="emit('openGuide')">第一次玩？看玩法说明</button>
        <button type="button" class="home-guide" @click="emit('openReplay')">收到复盘码？导入回看</button>
        <button type="button" class="home-guide" @click="emit('openWorkshop')">自己画了图？地图工坊</button>
      </div>

      <!-- 成果图标区（《UI 改造方案》§四）：首页只承担「看得见、点得到」，明细一律往后放。
           原本摊在这里的是「我的战绩」一整块 + 成就折叠块 + 云同步一整块 + 排行榜一长串列表，
           首页高度要滚三屏；收成一行 4 个图标后一屏放得下。 -->
      <nav class="home-icon-row" aria-label="我的记录">
        <button type="button" class="home-icon" @click="emit('navigate', 'stats')">
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M4 17V10M11 17V4M18 17v-5" /></svg>
          <em>战绩</em>
        </button>
        <button type="button" class="home-icon" @click="emit('navigate', 'achievements')">
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M7.5 4h7v4.5a3.5 3.5 0 0 1-7 0V4Z" /><path d="M7.5 5.5H5v1.8a2.5 2.5 0 0 0 2.5 2.5" /><path d="M14.5 5.5H17v1.8a2.5 2.5 0 0 1-2.5 2.5" /><path d="M11 12v3.2M8 18.5h6M9.3 18.5v-3.3h3.4v3.3" /></svg>
          <em>成就</em>
        </button>
        <button type="button" class="home-icon" @click="emit('navigate', 'cloud')">
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6.6 15.5h8.8a3.1 3.1 0 0 0 .2-6.2A4.6 4.6 0 0 0 6.9 9.6a3 3 0 0 0-.3 5.9Z" /><path d="M11 12.4v-2.6M9.7 11l1.3-1.3 1.3 1.3" /></svg>
          <em>云同步</em>
        </button>
        <button type="button" class="home-icon" @click="emit('navigate', 'leaderboard')">
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M4 6.5h14M4 11h14M4 15.5h9" /></svg>
          <em>排行榜</em>
        </button>
      </nav>
      <p class="home-icon-hint">点任一图标进入对应详情页</p>
    </section>

    <footer class="home-beian">
      <!-- 更新说明入口：首页必须能看到当前版本并打开更新历史（组件自带触发按钮 + 弹层）。 -->
      <ReleaseNotesDialog />
      <a href="https://beian.miit.gov.cn" target="_blank" rel="noopener noreferrer">新ICP备2026008728号</a>
    </footer>
  </main>
</template>

<style scoped>
.home-shell {
  /* 100dvh 而非 100vh：移动端地址栏伸缩时 vh 不变、dvh 跟随可视区，
     用 vh 会让内容高度与实际可视区脱节（对局页 .game-view 早已因此改为钉死视口）。
     安全区：index.html 开了 viewport-fit=cover，内容会延伸到刘海/圆角区域，
     故四边都要让出 inset，否则底部按钮会被 Home 指示条压住。*/
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

.home-card {
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


.home-eyebrow,
.home-copy,
.home-field span,
.home-hint {
  color: var(--color-muted);
}

.home-eyebrow {
  margin: 0;
  font-size: 12px;
  font-weight: 900;
  letter-spacing: 0.2em;
}

/* 字号由 .home-sticker__char 各自给出：贴纸逐字微旋转，字号必须落在字上才不会被旋转带歪。 */
.home-card h1 {
  margin: 0;
  color: var(--title-color);
}

.home-copy {
  margin: 0;
  line-height: 1.6;
}

/* 玩法说明入口（#109）：次要动作，所以是描边胶囊而不是实心主按钮。 */
.home-entry-row {
  /* 三条入口并列，窄屏自动折行；整行仍靠左，保持与标题对齐。 */
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-self: start;
}

.home-guide {
  justify-self: start;
  min-height: 36px;
  padding-inline: 14px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: transparent;
  color: var(--color-muted);
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}

.home-guide:hover {
  color: var(--color-text);
}

.home-beian {
  margin: 14px 0 0;
  font-size: 12px;
  color: var(--color-muted);
  text-align: center;
  letter-spacing: 0.02em;
}

.home-beian a {
  color: inherit;
  text-decoration: none;
}

.home-beian a:hover {
  text-decoration: underline;
}

/* 阈值与 GameView / MobileSheet 的紧凑布局（1024px）统一：
   折叠屏内屏与小平板竖屏的 CSS 宽度常落在 768–1024，用 767 会把它们误判成桌面。 */
@media (max-width: 1024px) {
  .home-shell {
    /* 移动形态改为顶部对齐：单列内容常高于视口，居中会让首屏上下同时被裁。 */
    padding:
      max(10px, env(safe-area-inset-top))
      max(10px, env(safe-area-inset-right))
      max(10px, env(safe-area-inset-bottom))
      max(10px, env(safe-area-inset-left));
    place-items: start center;
  }

  .home-join {
    grid-template-columns: 1fr;
  }

  .home-role-field {
    align-self: start;
  }
}

/* 矮视口（横屏手机、折叠屏半开）：一律顶部对齐，避免居中把内容上下切掉。 */
@media (max-height: 620px) {
  .home-shell {
    place-items: start center;
  }
}

/* ============ P1 首页场景化（视觉升级提案 §一、§三）============ */

/* 场景层：铺满 shell 的「桌面」底。用全局变量上色 ⇒ 深色模式自动跟随，
   不必写 :root[data-appearance] 分支。aria-hidden，且 pointer-events:none，不挡交互。 */
.home-scene {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  background:
    radial-gradient(1200px 700px at 50% -10%, rgb(255 252 243 / 88%), transparent 70%),
    radial-gradient(900px 620px at 10% 90%, rgb(226 214 188 / 62%), transparent 72%),
    var(--board-bg);
}

.home-scene__art {
  display: block;
  width: 100%;
  height: 100%;
}

.scene-sheet { fill: var(--board-surface); opacity: 0.9; }

.scene-route {
  fill: none;
  stroke: var(--branch-track);
  stroke-width: 3;
  stroke-dasharray: 10 11;
  stroke-linecap: round;
  opacity: 0.5;
}

.scene-tile rect { fill: var(--color-accent); opacity: 0.48; }

.scene-dice rect {
  fill: var(--board-surface);
  stroke: var(--color-border);
  stroke-width: 3;
}

.scene-dice circle { fill: var(--title-color); opacity: 0.7; }

.scene-pawn circle,
.scene-pawn path { fill: var(--color-primary); opacity: 0.5; }

.scene-cup path {
  fill: none;
  stroke: var(--color-accent);
  stroke-width: 5;
  stroke-linejoin: round;
  opacity: 0.85;
}

.scene-stamp circle,
.scene-stamp path {
  fill: none;
  stroke: var(--color-primary);
  stroke-width: 6;
  stroke-linecap: round;
  opacity: 0.8;
}

.home-hero {
  position: relative;
  display: grid;
  gap: 10px;
  justify-items: start;
}

/* 贴纸标题：粗描边压在字的后面（paint-order: stroke fill），逐字换色 + 微旋转。 */
.home-sticker {
  display: flex;
  gap: 0.03em;
  margin: 2px 0 0;
  line-height: 1;
}

.home-sticker__char {
  font-size: clamp(46px, 12vw, 76px);
  font-weight: 900;
  line-height: 1;
  color: #fff7e8;
  -webkit-text-stroke: 9px var(--title-color);
  paint-order: stroke fill;
}

.home-sticker__char:nth-child(2) { color: var(--color-accent); transform: rotate(-3deg) translateY(3px); }
.home-sticker__char:nth-child(3) { transform: rotate(1.5deg) translateY(-3px); }
.home-sticker__char:nth-child(4) { color: var(--color-accent); transform: rotate(-1deg) translateY(1px); }

/* 视觉隐藏但仍留在无障碍名里：标题的可访问名 = 「进入」+ 贴纸三字 = 进入大富翁。 */
.home-sticker__lead {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.home-sticker__sub {
  margin: 4px 0 0;
  padding: 3px 16px;
  border-radius: var(--radius-chip);
  background: var(--color-primary);
  color: #fff4ec;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.32em;
  transform: rotate(-1.5deg);
}

/* 两个等宽主按钮、上下相邻、两种色、地位对等（手法 3）。 */
.home-main-actions {
  display: grid;
  gap: 10px;
  width: 100%;
  margin-top: 4px;
}

.home-main {
  /* 纵向 flex 是为副行留位：两个按钮各带一行**同样字数**的副行，高度才不会参差 ——
     「两个等宽主按钮」这条视觉承诺里，也含「等高」这半边。 */
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  min-height: 54px;
  border: 0;
  border-radius: var(--radius-control);
  font-size: 1.05rem;
  font-weight: 900;
  letter-spacing: 0.02em;
  cursor: pointer;
}

/* 副行：0.72rem 而不是更小，手机上也读得清。 */
.home-main__hint {
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0;
  opacity: 0.85;
}

.home-main--online { background: var(--mode-online); color: #fff4ec; }
.home-main--local { background: var(--mode-local); color: #f1fbf4; }

.home-main:disabled {
  background: var(--button-disabled-bg);
  color: var(--button-disabled-text);
  cursor: not-allowed;
}

.home-shell { row-gap: 10px; }

/* ---- 成果图标区（《UI 改造方案》§四）---- */
/* 替掉了原先把战绩 / 成就 / 云同步 / 排行榜全摊在首页的写法：明细全部搬进详情页，
   首页只留这四个入口。四个等宽，视线一行扫完。 */
.home-icon-row {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.home-icon {
  display: grid;
  justify-items: center;
  gap: 6px;
  min-height: 62px;
  padding: 10px 4px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--surface-raised);
  color: var(--color-primary);
  cursor: pointer;
}

.home-icon:hover {
  border-color: var(--color-accent);
  color: var(--title-color);
}

.home-icon em {
  /* 中文标签用 <em> 会被浏览器写成斜体，这里按设计稿保持正体。 */
  font-style: normal;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.02em;
  color: var(--color-text);
}

.home-icon-hint {
  margin: 0;
  color: var(--color-muted);
  font-size: 12px;
  text-align: center;
}

/* 窄屏：场景底压不住内容，亮一点。 */
@media (max-width: 1024px) {
  .home-scene { opacity: 0.9; }
}
</style>
