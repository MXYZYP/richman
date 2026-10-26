# 大富翁·中国之旅 · 微信小程序端

把网页版 `apps/client` 移植成微信小程序。源码不复制、不改造源站：
**用一条同步管线把源站文件转换后生成小程序用的副本**，源站照旧给网页端用。

- 技术栈：uni-app 3（Vue 3）+ Vite 5 → 编译目标 `mp-weixin`
- 产物：`dist/build/mp-weixin`（主包约 1.3 MB，低于 2 MB 上限）

---

## 1. 怎么跑起来

```bash
# 依赖只需装一次
cd richman-main/apps/weapp
npm install

# 生成小程序包（同步源站 + 编译）
npm run build:mp
```

然后用**微信开发者工具**导入目录：

```
C:\Users\maxia\Desktop\大富翁游戏\richman-main\apps\weapp\dist\build\mp-weixin
```

导入时把 AppID 填成你自己的（`manifest.json` 里 `mp-weixin.appid` 留空时会用体验 AppID）。

想在浏览器里先看一眼（不用装开发者工具）：

```bash
npm run build:h5
# 然后用任意静态服务器指向 dist/build/h5
```

---

## 2. 目录结构

| 路径 | 作用 |
|---|---|
| `src/pages/index/index.vue` | 唯一页面，内部承载整个游戏的状态机（源站是单页应用，没有路由） |
| `src/game/` | **生成物，不要手改**。每次 `npm run sync` 从 `apps/client/src` 重新生成 |
| `src/overrides/` | 手写的移植版组件，同步最后覆盖同名文件（棋盘格、弹窗基座、socket 替身） |
| `src/platform/polyfill.ts` | 小程序缺失的 `structuredClone` / `localStorage` / `sessionStorage` / DOM 垫片 |
| `src/styles/` | 全局样式；`base.css` / `entry.css` 由同步管线从源站自动适配 |
| `scripts/sync-sources.mjs` | 同步 + 标签转换 + 样式适配 + 打桩 + 覆盖 |
| `scripts/patches.mjs` | 定点补丁表，每条必须命中恰好 1 次，否则构建中止 |

### 为什么要有同步管线

小程序不认 HTML 标签和部分 CSS 单元，源站有 34 个 `.vue`、上千处标签。手工改一遍无法维护，
而且改完源站就分叉了。管线的做法是：

1. 复制 `.vue` / `.ts`，只转换 `<template>` 块里的标签
   （`div→view`、`span→text`、`img→image`、`select→picker`…）
2. 适配 CSS：`:root→page`、`#app→.app-root`、`cqw → calc(var(--board-size) * N)`
3. 应用 `patches.mjs` 的定点补丁（棋盘路线、棋盘尺寸测量、socket 驱动…）
4. 打桩（音效、BGM）+ 覆盖（`src/overrides/`）

源站文件**只读**，任何改动都回到 `apps/client` 再跑一次同步。

---

## 3. 移植时踩到的坑（改代码前先看）

1. **`<svg>` 在小程序里是「不存在的自定义组件」**，不会报错，只会静默渲染为空。
   棋盘的格名、房屋、地球图标因此必须换实现：格名走 `<text>` 绝对定位，
   房屋走 CSS `clip-path`，路线走旋转细条。见 `src/overrides/components/BoardCell.vue`。
2. **`cqw` 小程序不支持**。棋盘画布是 100×100、`--board-size` 是其像素边长，
   所以 `N cqw` ⇔ `calc(var(--board-size) * N/100)`，数值完全等价，可无损换算。
3. **`<dialog>` / `showModal()` 不存在**。弹层基座改成「fixed 遮罩 + fixed 面板」，
   尺寸规则逐字保留（那是全项目弹窗大小的唯一事实源）。见 `src/overrides/components/MobileSheet.vue`。
4. **`margin-inline: auto` 在 flex 列布局里会取消拉伸**。
   `.game-shell` 因此塌成 268px（412 的手机上），连带棋盘缩水。
   兜底规则在 `src/styles/weapp.css`。
5. **`ResizeObserver` 拿不到 DOM Element**（ref 指向 uni 组件代理），会抛
   `parameter 1 is not of type 'Element'` 并打断后续测量。棋盘尺寸改用 `SelectorQuery`。
6. **`<label>` 必须转 `view` 而不是 `text`**：源站 label 是容器，里面装着 input，
   转 `text` 会把表单拆坏。
7. **小程序不支持原生 `<select>`**，改 `<picker>` 后事件语义变了：
   `detail.value` 是**下标**不是 option 的值。

---

## 4. 当前能力与限制

已验证（H5 端用 Playwright 实跑，非源码推断）：

- 首页渲染、隐私同意门、新手引导
- 单机开局 → 棋盘渲染（格名/色带/路线/棋子）→ AI 回合 → 玩家掷骰 → 回合推进
- 运行时零 JS 报错

尚未移植 / 不可用：

| 项 | 状态 | 原因 |
|---|---|---|
| **联机对战** | 不可用 | socket.io-client 依赖 WebSocket / XHR / window，小程序三样都没有。见 `src/overrides/session/socketIoShim.ts`，进联网入口会走源站既有的失败提示 |
| **音效 / BGM** | 静音 | 源站用 WebAudio 合成；小程序只有 `uni.createInnerAudioContext`（需真实音频文件） |
| **地图缩略图** | 空白 | `MapThumbnail` 的 svg 处在 `v-if/v-else` 链上，删掉会让 `v-else` 悬空；保留原位但渲染为空 |
| **5 套皮肤** | 仅默认主题 | `gameTheme.css` 依赖 `:root[data-theme]`，小程序没有 `:root` |
| **地图工坊 / 云端存档 / 排行榜** | 未验证 | 页面已编译进去，未逐一走查 |

**未做的事**：真机验证。本机没有微信开发者工具，所有渲染验证都在 H5 端完成；
小程序端只验证了产物结构与标签合法性。第一次导入开发者工具后，请重点看棋盘是否铺满、
弹层圆角是否正常、`calc()` 换算是否精确。

---

## 5. 上架前必须知道的两件事

1. **个人主体不能用 `web-view`**（官方文档原文：「个人类型的小程序暂不支持使用」），
   所以「把网页塞进小程序」这条路走不通，只能像现在这样做原生迁移。
2. **开发版 / 体验版不提交审核，不需要版号**。亲友内部玩直接把体验版二维码发出去即可
   （体验成员有数量上限，官方为 15 人）。要公开上线才需要小程序备案 + 游戏类目资质。
