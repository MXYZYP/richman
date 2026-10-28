/**
 * 移植补丁表。
 *
 * 设计原则：**能靠垫片降级的就不打补丁**。
 * platform/polyfill.ts 已经把 document / window / matchMedia / HTMLElement
 * 降级成 no-op，所以源站里上百处「Web 专属但无害」的调用不需要改。
 *
 * 剩下真正需要补丁的，只有「必须拿到真实像素」的那几处。
 *
 * 每条规则必须命中**恰好** `expect` 次（默认 1），否则抛错中止 ——
 * 源站改动导致补丁失效时，必须立刻发现，而不是静默产出错位的界面。
 */

export const PATCHES = [
  /* ---------------------------------------------------------------- *
   * 1. GameBoard：支线路线
   *
   * 源站用内联 <svg><line|polyline|path>。小程序没有 SVG，这些标签会被编译成
   * 不存在的自定义组件、静默渲染为空。line 类型改用「绝对定位细条 + rotate」，
   * 端点坐标按画布百分比换算；polyline / path 属纯装饰，第一版不渲染。
   * ---------------------------------------------------------------- */
  {
    file: 'components/GameBoard.vue',
    from: `        <svg
          v-for="(route, index) in routeModels"
          :key="\`route-\${index}\`"
          class="map-route"
          :viewBox="\`0 0 \${state.presentation.canvas.size} \${state.presentation.canvas.size}\`"
          aria-hidden="true"
          preserveAspectRatio="none"
        >
          <line
            v-if="route.type === 'line' && route.line"
            :x1="route.line.x1" :y1="route.line.y1" :x2="route.line.x2" :y2="route.line.y2"
            :style="[route.style]"
          />
          <polyline
            v-else-if="route.type === 'polyline'"
            :points="route.points ?? undefined"
            :style="[route.style]"
          />
          <path
            v-else-if="route.type === 'path'"
            :d="route.path ?? undefined"
            :style="[route.style]"
          />
        </svg>`,
    to: `        <view
          v-for="(route, index) in routeModels"
          v-show="routeStyle(route) !== null"
          :key="\`route-\${index}\`"
          class="map-route"
          :style="routeStyle(route) ?? undefined"
          aria-hidden="true"
        />`,
  },

  /* 路线样式的换算函数：SVG 的 stroke/strokeWidth → CSS 的 background/height。 */
  {
    file: 'components/GameBoard.vue',
    from: `const playerTokens = computed(() => {`,
    to: `/** 画布单位 → 像素（1 单位 = 棋盘边长的 1%）。 */
const units = (value: number) => \`calc(var(--board-size, 375px) * \${(value / 100).toFixed(6)})\`;

/**
 * 支线路线：line 类型换成一条旋转细条。
 * 源站的 stroke / strokeWidth 是 SVG 属性，这里翻译成 CSS 的 background / height。
 */
function routeStyle(route: (typeof routeModels.value)[number]) {
  if (route.type !== 'line' || route.line === null) return null;
  // script 上下文里没有裸 state（那是模板对 props 的自动解包），必须显式 props.state——
  // 否则渲染支线路线（13×10 宫格图全有）时 ReferenceError。typecheck 债清理时实测抓到。
  const size = props.state.presentation.canvas.size;
  const { x1, y1, x2, y2 } = route.line;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  if (!(length > 0)) return null;
  const stroke = String(route.style.stroke ?? 'transparent');
  const strokeWidth = Number(route.style.strokeWidth ?? 1);
  const style: Record<string, string> = {
    left: \`\${(x1 / size) * 100}%\`,
    top: \`\${(y1 / size) * 100}%\`,
    width: units(length),
    height: units(strokeWidth),
    background: stroke,
    transform: \`rotate(\${(Math.atan2(dy, dx) * 180) / Math.PI}deg)\`,
    transformOrigin: '0 50%',
  };
  if (route.style.opacity !== undefined) style.opacity = String(route.style.opacity);
  return style;
}

const playerTokens = computed(() => {`,
  },

  /* ---------------------------------------------------------------- *
   * 1. GameBoard：棋子阵型偏移里的 cqw
   *
   * 源站 `translate(${...}cqw, ...cqw)` 用的是容器查询单位，小程序不认。
   * 棋盘 100×100、1cqw = 容器宽的 1%，而 --board-size 正是容器的像素边长，
   * 所以 `X cqw` 等价于 `calc(var(--board-size) * X/100)`，无损换算。
   * ---------------------------------------------------------------- */
  {
    file: 'components/GameBoard.vue',
    from: 'transform: `translate(${xDirection * (index % columns) * stepX}cqw, ${yDirection * Math.floor(index / columns) * stepY}cqw)`,',
    to: 'transform: `translate(calc(var(--board-size) * ${(xDirection * (index % columns) * stepX) / 100}), calc(var(--board-size) * ${(yDirection * Math.floor(index / columns) * stepY) / 100})`,',
  },

  /* ---------------------------------------------------------------- *
   * 2. GameView：棋盘容器尺寸测量
   *
   * 源站读 el.clientWidth / el.clientHeight；小程序没有这两个属性，
   * 改走 SelectorQuery 量 .board-stage 的矩形。因为元素带 class，
   * 用 `.board-stage` 选择器即可，无需改模板加 id。
   * ---------------------------------------------------------------- */
  {
    file: 'views/GameView.vue',
    from: `function measureBoardStage(): void {
  const el = boardStageRef.value;
  if (!el) return;
  const width = el.clientWidth;
  const height = el.clientHeight;
  if (width <= 0 || height <= 0) return;
  const size = Math.floor(Math.min(width, height));
  if (size > 0 && size !== boardSize.value) boardSize.value = size;
}`,
    to: `function measureBoardStage(): void {
  // 小程序没有 clientWidth / ResizeObserver：用 SelectorQuery 量容器矩形。
  // 取 min(宽, 高) 的语义与源站一致——棋盘必须是正方形，多出来的方向留白。
  if (typeof uni === 'undefined' || typeof uni.createSelectorQuery !== 'function') return;
  uni.createSelectorQuery()
    .select('.board-stage')
    .boundingClientRect((rect) => {
      const box = rect as { width?: number; height?: number } | null;
      if (box === null || box === undefined) return;
      const width = Number(box.width ?? 0);
      const height = Number(box.height ?? 0);
      if (width <= 0 || height <= 0) return;
      const size = Math.floor(Math.min(width, height));
      if (size > 0 && size !== boardSize.value) boardSize.value = size;
    })
    .exec();
}`,
  },

  /* ---------------------------------------------------------------- *
   * 3. GameView：去掉 ResizeObserver
   *
   * 尺寸已经改由 SelectorQuery 实测（见上一条）。ResizeObserver 留着不仅多余，
   * 还会因为 boardStageRef 拿到的是 uni 组件代理而不是 DOM Element 而抛
   * 「parameter 1 is not of type 'Element'」，把后续测量打断。
   * ---------------------------------------------------------------- */
  {
    file: 'views/GameView.vue',
    from: `  if (!element || typeof ResizeObserver === 'undefined') return;
  measureBoardStage();
  stageObserver = new ResizeObserver(() => measureBoardStage());
  stageObserver.observe(element);`,
    to: `  if (!element) return;
  measureBoardStage();`,
  },

  {
    file: 'views/GameView.vue',
    from: `  if (typeof ResizeObserver !== 'undefined' && boardStageRef.value !== null) {
    stageObserver = new ResizeObserver(() => measureBoardStage());
    stageObserver.observe(boardStageRef.value);
  }`,
    to: ``,
  },

  /* ---------------------------------------------------------------- *
   * 4. <select> → <picker>
   *
   * 小程序没有 select/option。uni-app 用 picker（mode=selector），
   * 注意 event 语义变了：picker 的 detail.value 是**下标**，不是 option 的值。
   * ---------------------------------------------------------------- */
  {
    file: 'components/GameSetup.vue',
    from: `              <select :value="setup.humanCount" @change="setHumanCount">
                <option v-for="count in humanOptions" :key="count" :value="count" :disabled="isHumanOptionDisabled(count)">
                  {{ count }} 人
                </option>
              </select>`,
    to: `              <picker
                mode="selector"
                :range="humanOptions"
                :value="Math.max(0, humanOptions.indexOf(setup.humanCount))"
                @change="setHumanCount"
              >
                <view class="setup-picker">{{ setup.humanCount }} 人</view>
              </picker>`,
  },

  {
    file: 'components/GameSetup.vue',
    from: `              <select :value="setup.botCount" @change="setBotCount">
                <option v-for="count in botOptions" :key="count" :value="count" :disabled="isBotOptionDisabled(count)">
                  {{ count }} 人
                </option>
              </select>`,
    to: `              <picker
                mode="selector"
                :range="botOptions"
                :value="Math.max(0, botOptions.indexOf(setup.botCount))"
                @change="setBotCount"
              >
                <view class="setup-picker">{{ setup.botCount }} 人</view>
              </picker>`,
  },

  {
    file: 'components/GameSetup.vue',
    from: `function setHumanCount(event: Event) {
  const humanCount = Number((event.target as HTMLSelectElement).value);
  setup.value = updateGameSetupCounts(setup.value, { humanCount });
}`,
    to: `function setHumanCount(event: { detail: { value: number | string } }) {
  // 小程序 picker 回传的是下标，不是 option 的值。
  const humanCount = humanOptions[Number(event.detail.value)] ?? setup.value.humanCount;
  setup.value = updateGameSetupCounts(setup.value, { humanCount });
}`,
  },

  {
    file: 'components/GameSetup.vue',
    from: `function setBotCount(event: Event) {
  const botCount = Number((event.target as HTMLSelectElement).value);
  setup.value = updateGameSetupCounts(setup.value, { botCount });
}`,
    to: `function setBotCount(event: { detail: { value: number | string } }) {
  const botCount = botOptions[Number(event.detail.value)] ?? setup.value.botCount;
  setup.value = updateGameSetupCounts(setup.value, { botCount });
}`,
  },

  {
    file: 'components/BargainPanel.vue',
    from: `        <select id="trade-target" v-model="targetId">
          <option v-for="option in proposalOptions" :key="option.playerId" :value="option.playerId">
            {{ option.nickname }}（现金 {{ formatCash(option.cash) }}）
          </option>
        </select>`,
    to: `        <picker
          mode="selector"
          :range="proposalOptions"
          range-key="nickname"
          :value="Math.max(0, proposalOptions.findIndex((option) => option.playerId === targetId))"
          @change="targetId = proposalOptions[Number($event.detail.value)]?.playerId ?? targetId"
        >
          <view class="bargain-target-picker">
            {{ proposalOptions.find((option) => option.playerId === targetId)?.nickname ?? '请选择对手' }}
          </view>
        </picker>`,
  },
  /* ---------------------------------------------------------------- *
   * 4. 版本说明的数据文件路径
   *
   * 源站 apps/client/src/releaseCatalog.ts 用 ../../../release-notes.json
   * 指到仓库根。复制到 apps/weapp/src/game 后多了一层目录，需要再上一级。
   * ---------------------------------------------------------------- */
  {
    file: 'releaseCatalog.ts',
    from: "import releaseCatalogData from '../../../release-notes.json';",
    to: "import releaseCatalogData from '../../../../release-notes.json';",
  },
  /* ---------------------------------------------------------------- *
   * 5. 联机会话：socket.io 驱动换成小程序替身
   *
   * 源站的会话状态机整套保留（它在模块顶层构造，抛错会直接打挂整个应用），
   * 只把唯一碰传输层的地方换掉。socketIoShim 是「永不连上」的 socket，
   * 连接失败走源站既有的失败提示。
   * ---------------------------------------------------------------- */
  {
    file: 'session/onlineSession.ts',
    from: "import { io, type Socket } from 'socket.io-client';",
    to: "import { io, type Socket } from './socketIoShim';",
  },
];
