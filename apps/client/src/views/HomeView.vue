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
    <!-- 首页背景（10-16 第三版）：换成 AI 生成的纸面插画 —— 墨山、骰子、茶盏、折扇与虚线棋路，
         中央大片留白正好托住卡片。图放 public/ 固定名（/home-bg.webp）并登记进 sw.js 的 SHELL；
         明暗由 style.css / ui/darkMode.css 里的 --home-scrim 那一层负责，组件不写 appearance 分支。
         整块 aria-hidden + pointer-events:none：纯装饰，不进无障碍树也不挡交互。 -->
    <div class="home-scene" aria-hidden="true"></div>
    <section class="home-card" aria-labelledby="home-title">
      <header class="home-hero">
        <!-- 一句话说清「这是什么游戏」。11-17 改版：原句「纸上中国 · 一局走遍山河」把棋盘
             钉死在中国——可地图里早就有《世界之旅》，地图工坊还让玩家自己画图。
             换成「纸上的世界 · 一局走遍四方」：既保住了「纸上」这个视觉母题，
             又不再给棋盘划国界（世界之旅、丝路、三国、自定义地图都装得进去）。
             字数与旧句一致（4 + 6），字距与居中排版不用动。 -->
        <p class="home-eyebrow">纸上的世界 · 一局走遍四方</p>
        <!-- 贴纸标题（10-16 第三版）：改用 AI 生成的厚描边卡通字（/home-logo.webp）并整块放大，
             就是用户那句「大富翁那几个字一定要上部居中，放大一些，美工要好一点」。
             ★ 可访问名必须仍是「进入大富翁」：整行文字视觉隐藏留在无障碍名里，贴纸本身是
             aria-hidden 的空 span（背景图上色），e2e 的 getByRole('heading', { name: '进入大富翁' }) 照旧命中。
             ★ 贴纸用 CSS 背景图，不用 img 标签：模板里的根绝对路径会被 @vitejs/plugin-vue 的
             transformAssetUrls 当成**项目内文件**去解析（实测渲染成 /@fs/home-logo.webp），
             而 CSS 的 url() 不会被改写 —— public/ 下的资源只能走后者。
             ★ 两个 span 之间**一个换行都不许有** —— 换行会在可访问名里塞进空白，e2e 当场失配。 -->
        <h1 id="home-title" class="home-sticker"><span class="home-sticker__lead">进入大富翁</span><span class="home-sticker__logo" aria-hidden="true"></span></h1>
        <p class="home-sticker__sub">掷骰 · 买地 · 收租</p>
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

    </section>

    <!-- 图标列（《UI 改造方案》§四，10-16 第二版）：不写可见文字、不做角标数字，
         位置照参考图贴在屏幕左上角竖排。aria-label 与 title 都给了 —— 纯图标按钮的名字
         只剩这两条去路，去掉就真的只是四个看不懂的图形。
         位置由 CSS 绝对定位决定；源码顺序排在卡片之后，是为了保住「先主操作、后元信息」的读写顺序。 -->
    <nav class="home-icon-row" aria-label="我的记录">
      <button type="button" class="home-icon" aria-label="战绩" title="战绩" @click="emit('navigate', 'stats')">
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M4 17V10M11 17V4M18 17v-5" /></svg>
      </button>
      <button type="button" class="home-icon" aria-label="成就" title="成就" @click="emit('navigate', 'achievements')">
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M7.5 4h7v4.5a3.5 3.5 0 0 1-7 0V4Z" /><path d="M7.5 5.5H5v1.8a2.5 2.5 0 0 0 2.5 2.5" /><path d="M14.5 5.5H17v1.8a2.5 2.5 0 0 1-2.5 2.5" /><path d="M11 12v3.2M8 18.5h6M9.3 18.5v-3.3h3.4v3.3" /></svg>
      </button>
      <button type="button" class="home-icon" aria-label="云同步" title="云同步" @click="emit('navigate', 'cloud')">
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6.6 15.5h8.8a3.1 3.1 0 0 0 .2-6.2A4.6 4.6 0 0 0 6.9 9.6a3 3 0 0 0-.3 5.9Z" /><path d="M11 12.4v-2.6M9.7 11l1.3-1.3 1.3 1.3" /></svg>
      </button>
      <button type="button" class="home-icon" aria-label="排行榜" title="排行榜" @click="emit('navigate', 'leaderboard')">
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M4 6.5h14M4 11h14M4 15.5h9" /></svg>
      </button>
    </nav>

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
  /* 图标列的边长。窄屏那段要按「4 个图标 + 3 个间距 + 上边距」算出卡片该让出的高度，
     所以尺寸必须落在一个变量上，不能散在 .home-icon 里写死。 */
  --home-icon-size: clamp(40px, 11vw, 48px);
  min-height: 100vh;
  min-height: 100dvh;
  display: grid;
  /* 10-16 第三版：整页改成「顶部对齐 + 横向居中」（用户：「大富翁那几个字一定要上部居中」）。
     ★ 必须是 align-content: start，不能只把 place-items 的 align 换成 start ——
     两行（卡片 / 页脚）的行高会被默认的 stretch 撑满整个视口，卡片与页脚会被撕到上下两端。
     换成 start 之后 @media (max-height:620px) 那条「矮屏顶部对齐」就恒真了，已一并删掉。 */
  justify-items: center;
  align-content: start;
  padding:
    max(22px, 5vh, env(safe-area-inset-top))
    max(18px, env(safe-area-inset-right))
    max(18px, env(safe-area-inset-bottom))
    max(18px, env(safe-area-inset-left));
}

.home-card {
  position: relative;
  z-index: 1;
  width: min(560px, 100%);
  display: grid;
  /* 块间距随屏宽微调：折叠屏外屏（~320px）上省下的这几点高度，正好够首屏不被裁。
     10-16 第四版：主按钮组下缘带 5px 底边，「按钮组 ↔ 三条小入口」这段的实际留白
     也比 gap 看着少 5px ⇒ 再放开一档。 */
  gap: clamp(16px, 2.6vw, 22px);
  padding: clamp(20px, 4vw, 34px);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-card);
  background:
    var(--surface-card),
    var(--board-surface);
  /* 底图从浅色 SVG 换成有明暗层次的插画后，原来 14% 的落影不够把卡片托出来。 */
  box-shadow: 0 20px 52px rgb(53 39 20 / 22%);
}


.home-eyebrow,
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

/* 标题现在是位图（.home-sticker__logo）：字号、描边、渐变都在图里，
   这里只负责清掉 h1 的默认外边距，颜色对图片已经不起作用。 */
.home-card h1 {
  margin: 0;
}

/* 玩法说明入口（#109）：次要动作，所以是描边胶囊而不是实心主按钮。 */
.home-entry-row {
  /* 三条入口**等宽铺满一行**（10-16 用户：「间距调整一下」）。
     原来是 wrap 折行：卡片只有 560px，三条长标签会折成 2+1 —— 第二行孤零一条，
     行距也和上一行对不齐，看着像没排完。换成三列 grid 后一行排满、间距统一、三条等高
     （长句在窄屏内折成两行时由 grid 行拉伸对齐，不会参差）。
     窄屏不插新断点，靠下面 .home-guide 的 clamp 字号自适应。 */
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.home-guide {
  min-height: 38px;
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: transparent;
  color: var(--color-muted);
  /* 13px 随屏宽缩到 11px：320px 的折叠屏外屏也能一行塞下三条。 */
  font-size: clamp(11px, 2.6vw, 13px);
  line-height: 1.25;
  font-weight: 700;
  text-align: center;
  white-space: normal;
  cursor: pointer;
}

.home-guide:hover {
  color: var(--color-text);
}

.home-beian {
  margin: 14px 0 0;
  /* 原来是 12px + --color-muted(#6B6658)，用户反馈「颜色太浅」⇒ 换正文色 并加大一号。 */
  font-size: 13px;
  color: var(--color-text);
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
    /* 窄屏只收内边距：顶部对齐已由基类的 align-content:start 承担，全尺寸一致。 */
    padding:
      max(14px, env(safe-area-inset-top))
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

/* ============ P1 首页场景化（视觉升级提案 §一、§三）============ */

/* 场景层：铺满 shell 的纸面插画底（10-16 第三版换图，原先是纯 CSS + 内联 SVG 手绘的桌面）。
   位图走 public/ 固定名，明暗由 --home-scrim 那一层负责 —— 浅色是暖白柔光、深色是暗色幕布
   （见 style.css 与 ui/darkMode.css），所以组件里没有 appearance 分支。
   aria-hidden，且 pointer-events:none，不挡交互。 */
.home-scene {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  /* 两张底图同一套画风，按**视口方向**切：宽屏用横版（3:2），竖屏换竖版（2:3）。
     这里选的是「构图方向」而不是布局档次，所以用 aspect-ratio，不再插一个宽度断点。 */
  --home-bg: url('/home-bg.webp');
  background-color: var(--board-bg);
  background-image: var(--home-scrim), var(--home-bg);
  background-size: auto, cover;
  background-position: center, center;
  background-repeat: no-repeat, no-repeat;
}

/* 竖屏（含正方形）换竖版：横版 3:2 在 390x844 上只露出中间约 31% 的一条，两侧的山
   会被整块裁掉；竖版 2:3 能露出约七成宽度，构图才立得住。 */
@media (max-aspect-ratio: 1 / 1) {
  .home-scene {
    --home-bg: url('/home-bg-portrait.webp');
  }
}

.home-hero {
  position: relative;
  display: grid;
  gap: 10px;
  /* 10-16 第三版：hero 由左对齐改为**居中** —— 标题、角标、两个主按钮共用一条中轴，
     正是用户要的「上部居中」。左对齐时大字顶着卡片左边缘，看着像没排完。 */
  justify-items: center;
  text-align: center;
}

/* 贴纸标题（10-16 第三版）：换成 AI 生成的厚描边卡通字位图。
   旧版是 CSS 逐字换色 + -webkit-text-stroke 描边，字形受字体限制、细看发飘，也放不大；
   位图版笔画 / 描边 / 渐变都是成品，正好一次把「换个字体、再放大」两件事都办了。 */
.home-sticker {
  display: grid;
  place-items: center;
  /* width:100% 不是多余的：.home-hero 的 justify-items:center 会让子项 shrink-to-fit，
     那样贴纸的百分比宽度只能反过来依赖它自己的内容宽度（自指，百分比失效）。
     给 h1 一个定宽，里面的 min(400px, 92%) 才有确定的分母。 */
  width: 100%;
  margin: 2px 0 0;
}

.home-sticker__logo {
  display: block;
  /* min() 收口：手机（卡片内宽约 300px）按 92% 缩，电脑放到 400px 封顶 ——
     再大就会把两个主按钮挤出首屏。窄屏靠百分比、宽屏靠上限，不新增断点。 */
  width: min(400px, 92%);
  /* 位图是 820×452 那张贴纸。高度交给 aspect-ratio 跟着宽度算，窄屏自动等比缩，不写断点。 */
  aspect-ratio: 820 / 452;
  background-image: url('/home-logo.webp');
  background-size: contain;
  background-position: center;
  background-repeat: no-repeat;
  /* 图片自带柔和投影，这里再补一层极轻的落影，把贴纸从纸面插画上抬起来。 */
  filter: drop-shadow(0 6px 16px rgb(53 39 20 / 26%));
}

/* 视觉隐藏但仍留在无障碍名里：贴纸那个 span 是 aria-hidden 的（纯背景图），读屏不念它，
   所以标题的可访问名完全由这一行文字提供 —— 正好就是 e2e 要找的「进入大富翁」。 */
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

/* 标题下的角标。10-16 用户：「换个说法，我又不是只有这一个地图」
   —— 于是不再写任何地图名，改成三个字一组的**玩法动作**（掷骰 → 买地 → 收租），
   跟参考图里「整理装备 · 清洁房屋 · 扩张车队」是同一种句式：一句话说清这游戏在干嘛。 */
.home-sticker__sub {
  margin: 4px 0 0;
  padding: 4px 14px;
  max-width: 100%;
  border-radius: var(--radius-chip);
  background: var(--color-primary);
  color: #fff4ec;
  /* 字距从 0.32em 收到 0.14em：字符数从 4 个涨到 11 个，原字距会把卡片顶破。
     10-16 第三版随标题一起放大到 13.5px —— 标题大了，角标还留在 12.5px 会显小。 */
  font-size: 13.5px;
  font-weight: 800;
  letter-spacing: 0.14em;
  transform: rotate(-1.5deg);
}

/* 两个等宽主按钮、上下相邻、两种色、地位对等（手法 3）。
   10-16 第四版（用户：「这几个按钮上下距离…有点拥挤」）：
   主按钮各带一条 5px 实体底边（box-shadow: 0 5px 0），目看的白色间隔
   = gap - 5px，原来 10px 只剩 5px，两个按钮像粘在一起 ⇒ gap 提到 16px。 */
.home-main-actions {
  display: grid;
  gap: 16px;
  width: 100%;
  /* 与上方角标（.home-sticker__sub）之间也放开一点：4px 叠在 hero 自己的 10px
     gap 上仍偏紧。 */
  margin-top: 10px;
}

.home-main {
  /* 纵向 flex 是为副行留位：两个按钮各带一行**同样字数**的副行，高度才不会参差 ——
     「两个等宽主按钮」这条视觉承诺里，也含「等高」这半边。 */
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  /* 58px + 8px 纵向内边距：下缘现在多了一条 5px 厚的「贴纸底边」，
     不把高度补回来，文字会被底边挤得上移，两个按钮也不再等高。 */
  min-height: 58px;
  padding: 8px 12px;
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

/* 10-16 第三版：用户「这个条块的背景色也不好看」——
   纯色平涂改成**厚贴纸按钮**：同色上亮下深的渐变 + 一条深色底边 + 柔和落影，
   按下时整体下沉 3px、底边收窄，做出物理按键手感（手法与贴纸 logo 一致）。
   渐变的亮端与底边都用 color-mix 从 --mode-online / --mode-local 推出来 ——
   深色模式（ui/darkMode.css 已把这两个变量提亮）自动跟得上，不必各写一套，也不引硬编码字面量。 */
.home-main--online {
  --mode-deep: color-mix(in srgb, var(--mode-online) 62%, #000);
  color: #fff4ec;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--mode-online) 76%, #fff) 0%,
    var(--mode-online) 58%,
    color-mix(in srgb, var(--mode-online) 88%, #000) 100%
  );
}

.home-main--local {
  --mode-deep: color-mix(in srgb, var(--mode-local) 62%, #000);
  color: #f1fbf4;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--mode-local) 76%, #fff) 0%,
    var(--mode-local) 58%,
    color-mix(in srgb, var(--mode-local) 88%, #000) 100%
  );
}

.home-main--online,
.home-main--local {
  box-shadow:
    0 5px 0 var(--mode-deep),
    0 12px 22px rgb(53 39 20 / 22%);
}

.home-main:active:not(:disabled) {
  transform: translateY(3px);
  box-shadow:
    0 2px 0 var(--mode-deep),
    0 6px 12px rgb(53 39 20 / 18%);
}

.home-main:disabled {
  background: var(--button-disabled-bg);
  color: var(--button-disabled-text);
  /* 禁用态必须是平的：留着贴纸底边会看着像「还能按」。 */
  box-shadow: none;
  cursor: not-allowed;
}

.home-shell { row-gap: 10px; }

/* ---- 成果图标区（《UI 改造方案》§四）---- */
/* 替掉了原先把战绩 / 成就 / 云同步 / 排行榜全摊在首页的写法：明细全部搬进详情页，
   首页只留这四个入口。10-16 第二版：位置照参考图挪到**屏幕左上角竖排**。 */
.home-icon-row {
  /* 挂在 .home-shell 下（**不能留在卡片里**）：卡片自带 position:relative，留在里面
     就只会相对卡片定位，永远贴不到屏幕角上。这里靠绝对定位脱离网格居中。 */
  position: absolute;
  top: max(14px, env(safe-area-inset-top));
  left: max(14px, env(safe-area-inset-left));
  z-index: 2;
  display: grid;
  justify-items: center;
  gap: 10px;
}

.home-icon {
  display: grid;
  place-items: center;
  /* 照参考图做「白圆片 + 彩色图标 + 柔和投影」，取代原来的等宽描边卡片。 */
  width: var(--home-icon-size);
  height: var(--home-icon-size);
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--color-cell);
  box-shadow: 0 2px 8px rgb(53 39 20 / 18%);
  cursor: pointer;
}

/* 四个图标各一色。取的都是主题里已有的语义色，不引硬编码字面量：
   战绩=朱砂 · 成就=点缀金 · 云同步=竹青 · 排行榜=琥珀。 */
.home-icon:nth-child(1) { color: var(--color-primary); }
.home-icon:nth-child(2) { color: var(--color-accent); }
.home-icon:nth-child(3) { color: var(--color-gain); }
.home-icon:nth-child(4) { color: var(--color-warning); }

.home-icon:hover {
  transform: translateY(-1px);
  box-shadow: 0 5px 14px rgb(53 39 20 / 26%);
}

.home-icon svg {
  /* 图标紧跟按钮尺寸；描边从属性里的 1.5 提到 2 —— 小尺寸压在浅底上，1.5 会发灰。 */
  width: clamp(20px, 5vw, 24px);
  height: clamp(20px, 5vw, 24px);
  stroke-width: 2;
}

/* 更窄的屏：卡片按 100% 撑满，横向上必然与左上角那一列图标相交
   ⇒ 给 shell 让出「4 个图标 + 3 个间距 + 上下留白」的高度，图标留在左上角、卡片整体下移。
   阈值 700px 是算出来的不是拍的：卡片最宽 560px + 图标列约 62px × 2 侧 ≈ 684px，取 700 留余量。
   比这更宽的屏卡片居中、横向根本碰不到这一列，不必白占这段高度。 */
@media (max-width: 700px) {
  .home-shell {
    padding-top: calc(var(--home-icon-size) * 4 + 30px + 28px);
  }
}
</style>
