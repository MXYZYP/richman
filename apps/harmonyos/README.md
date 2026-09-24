# 大富翁联机 · HarmonyOS 封装（ArkTS Web 组件）

把网页版大富翁封装为鸿蒙原生 App。原理与 Android 的 Capacitor 一样：**原生外壳里跑 WebView**，
游戏逻辑全在网页端，原生层只负责全屏承载 + 联网权限。

> **先说结论（省得白折腾）**
>
> - 想「装到手机上、有图标、全屏、点开就能玩」——**今天就能做到，不需要应用市场**：
>   手机浏览器打开游戏地址 → 浏览器菜单 →「添加到主屏幕 / 安装应用」。这是 PWA，功能早已就位
>   （见仓库 README 的「当前界面」）。**鸿蒙/安卓原生壳解决的是另一件事：上应用市场分发。**
> - 本仓库**没有**鸿蒙 SDK，也跑不了 DevEco 的命令行构建。因此本目录交付的是
>   **结构完整、缺陷已修的工程骨架**，不是一个已验证可编译的 HAP。
>   真正打包上机必须在你装了 DevEco Studio 的电脑上执行，见第 2 节。
> - **签名与上架只能由你本人的华为开发者账号完成**，谁也替代不了。

---

## 1. 目录里有什么（以及为什么长这样）

```
apps/harmonyos/
├── AppScope/
│   ├── app.json5                     应用级配置：包名 com.richman.game、图标、名称
│   └── resources/base/
│       ├── element/string.json        应用名文案
│       └── media/app_icon.png         应用图标（取自 PWA 的 512×512 图标）
├── entry/                            入口模块
│   ├── hvigorfile.ts                 模块级构建脚本（hapTasks）
│   ├── build-profile.json5           模块构建配置（stageMode）
│   ├── oh-package.json5              模块包描述
│   └── src/main/
│       ├── module.json5              模块声明：ability、INTERNET 权限、页面表
│       ├── ets/
│       │   ├── entryability/EntryAbility.ets   入口 Ability（全屏 + 载入页面）
│       │   └── pages/Index.ets                 承载游戏的 Web 组件
│       └── resources/base/
│           ├── element/string.json    模块内文案（含权限用途说明）
│           ├── element/color.json     启动窗口背景色
│           ├── profile/main_pages.json 页面表
│           └── media/startIcon.png    启动图标
├── hvigorfile.ts                     应用级构建脚本（appTasks）
├── build-profile.json5               应用级构建配置
├── oh-package.json5                  应用级包描述
└── README.md                         本文件
```

`AppScope` 是**应用级**（整个 App 一份），`entry` 是**模块级**（一个 App 可以有多个模块，这里只有一个）。
两处的 `hvigorfile.ts` 与 `build-profile.json5` 都**必须存在**：缺了会直接卡在 Sync / Build，
且报错信息很难指向缺的是哪个文件。

### 相对上一版修掉的缺陷（2026-09-23）

| 问题 | 后果 | 处理 |
| --- | --- | --- |
| `module.json5` 的 `srcEntry` 指向 `EntryAbility.ets`，磁盘上却是 `EntryAbility.ts` | Sync 报「找不到入口文件」，且名字对不上极难一眼看出 | 把文件改名为 `.ets`（DevEco 模板的标准扩展名），与 `module.json5` 对齐 |
| 缺 `$media:startIcon` 与 `$media:app_icon` 两个图标资源 | 编译期报资源缺失，直接停下 | 补 `entry/.../media/startIcon.png` 与 `AppScope/.../media/app_icon.png`（暂用 PWA 的 512 图标，上架前可换成专门设计的一版） |
| 缺 `entry/hvigorfile.ts`、`entry/build-profile.json5`、`entry/oh-package.json5` | 模块级构建无法启动 | 补齐（内容与 IDE 版本无关，可以固化） |
| 缺 `hvigor/hvigor-config.json5` | `hvigorw` 命令行构建会报找不到配置 | **故意不写死**：这个文件的内容与 DevEco 版本强绑定（4.x 用 `hvigorVersion`、5.x 用 `modelVersion`），写错反而要人工迁移。DevEco 首次打开工程会自动生成/升级它，交给 IDE 更稳 |
| `Index.ets` 的 `SERVER_URL` 是 `https://richman.example.com` 占位符，填错只会看到空白页 | 分不清「地址没改」和「服务器挂了」 | 未配置时直接显示一屏中文提示（告诉你去改哪个文件），不再给空白页 |
| 上一版 README 建议直接把 `pnpm build` 产物放进 `rawfile` | **必然白屏**：默认构建的资源是绝对路径 `/assets/...`，`rawfile` 下解析不到 | 新增 `pnpm --filter @richman/client build:offline`（`vite build --base=./`），README 明确要求用它 |

---

## 2. 在 DevEco 里跑起来（需要你操作）

1. 安装 **DevEco Studio**，首次启动会引导安装 HarmonyOS SDK。本工程按 **API 11** 写
   （`compatibleSdkVersion: 11`），装 SDK 时勾上对应版本即可。
2. `File → Open` 选择本目录 `apps/harmonyos`。首次打开 DevEco 会做 Sync，并**自动生成
   `hvigor/hvigor-config.json5`**。如果它提示「工程模型版本需要升级」，按提示一键升级即可。
3. 真机调试：手机打开「开发者模式 → USB 调试 / 无线调试」，连上电脑，DevEco 顶部选中设备后点 ▶ Run。
   首次需**签名**：`File → Project Structure → Signing Configs`，勾「Automatically generate signature」
   并登录华为账号，IDE 会自动生成调试证书并回填 `build-profile.json5` 的 `signingConfigs`。

> 本工程 `build-profile.json5` 里 `signingConfigs` 是空数组、product 上写着 `"signingConfig": "default"`——
> 这正是 DevEco 新建工程的原样：**在你按上面第 3 步配置签名之前，它是填不出来的**，让 IDE 自动补即可。

---

## 3. 决定游戏从哪加载（二选一）

打开 `entry/src/main/ets/pages/Index.ets`：

### A) 云端模式（推荐）

把 `SERVER_URL` 改成**你自己的游戏服务地址**，保持 `.src(SERVER_URL)`。

> ⚠️ **别填只托管静态网页的地址**（例如仓库 README 里那个 Cloudflare Pages 地址）。
> 客户端默认连 `location.origin`（见 `apps/client/src/session/onlineSession.ts`：
> `io(browserGlobals.location?.origin)`）——**页面从哪个源加载，联机就往哪个源连**。
> 而 `apps/server` 会静态托管 `apps/client/dist`，并把 `/socket.io` 挂在同一个端口上，
> 所以云端模式该填的就是那台服务器的地址（例如 `https://你的域名/`）。
> 填纯静态站点的典型症状是「首页打得开、一建房就连不上」，排查起来很费时间。

server 端一更新，App 打开即最新，**无需发版**。联机走 WebSocket，务必用 **HTTPS**
（明文 HTTP 在部分鸿蒙版本会被拦截）。

### B) 离线模式（玩家不联网也能开首页）

```powershell
# 注意是 build:offline，不是 build —— 见下方说明
pnpm --filter @richman/client build:offline
```

把 `apps/client/dist` 整个目录复制到 `entry/src/main/resources/rawfile/`，然后把
`.src(SERVER_URL)` 改为 `.src($rawfile('index.html'))`。

> 为什么要专门的 `build:offline`：默认 `vite build` 的资源引用是**绝对路径**
> （`/assets/index-xxx.js`），浏览器用「站点根」解析，而 `rawfile` 场景下并没有那个根，
> 结果就是白屏 + 控制台一堆 404。`--base=./` 把它改成相对路径后就正常了。
> 另外原生壳里没有 Service Worker 能力，`main.ts` 已只在 `http/https` 下注册，不会再刷无关报错。

---

## 4. 打包 HAP / APP Pack（上架用）

1. `Build → Build Hap(s) → Build Debug Hap`：本地调试包（HAP），可直连真机安装。
2. 上架前打 release：`Build → Build Apps → Build APP`（产出 `.app`，即 App Pack，内含 HAP）。
3. 发布签名需在 **AppGallery Connect** 里配好「证书、APP ID、Profile」三件套，
   再把 `.p12` / `.cer` / Profile 导入 DevEco 的 `Signing Configs → Release`。

> 签名材料（`*.p12` / `*.cer` / `*.p7b`）已在仓库 `.gitignore` 里，**绝不入库**。

---

## 5. 上架鸿蒙应用市场（AppGallery）

完整傻瓜式步骤见仓库 `docs/发布SOP.html` 第 5 节。要点：

1. 注册 **华为开发者联盟** 账号并完成**实名认证**（个人/企业，企业需营业执照）。
2. **AppGallery Connect** → 创建应用（包名 `com.richman.game`、应用名称、分类）。包名一旦上架不可改，
   若要改请同时改 `AppScope/app.json5` 的 `bundleName`。
3. 配置「证书、APP ID、Profile」三件套，回 DevEco 打 Release APP。
4. 在 AGC 填：应用介绍、截图（手机 + 平板）、**隐私政策网址**、备案/资质（如涉及）。
5. 上传 `.app` → 提交审核 → 通过后发布。

> 🔒 上架必须由**你本人的华为开发者账号**完成（实名认证 + 支付 + 平台审核均不可替代）。
> 我无法代替你提交，但工程、签名配置说明与逐项清单已备齐。

---

## 6. 关于 Android / iOS

仓库的 `apps/client/package.json` 里有 Capacitor 依赖与脚本（`cap:init` / `cap:add:android` / `cap:sync` /
`cap:build:android`），但**没有 `apps/android` 原生工程**，而且本机没有 JDK、Android SDK 与 Gradle——
所以**现在无法产出 APK，也无法验证 Android 壳**。这是环境限制，不是配置遗漏。

要在有环境的机器上打通：

```powershell
# 1. 先构建前端（离线壳用 build:offline，走远程地址用 build）
pnpm --filter @richman/client build:offline

# 2. 初始化 Capacitor 配置（只做一次）
pnpm --filter @richman/client exec cap init "大富翁联机" com.richman.game --web-dir dist

# 3. 生成原生工程并同步前端产物
pnpm --filter @richman/client exec cap add android
pnpm --filter @richman/client cap:sync

# 4. 打包（需要 JDK 17 + Android SDK）
pnpm --filter @richman/client cap:build:android
```

前置条件：**JDK 17**、Android SDK（含 platform-tools / build-tools）、一台能跑 Android Studio 的机器。
上 Google Play 还需 **Google Play 开发者账号（一次性 25 美元）** 并走其审核。

---

## 7. 后续更新策略

| 模式 | 更新方式 | 是否需要重新发版 |
| --- | --- | --- |
| PWA（浏览器装到桌面） | 重新部署前端即可，Service Worker 会自动更新 | 否 |
| 原生壳 · 云端模式 | 只更新 server / 前端，用户打开 App 即最新 | 否 |
| 原生壳 · 离线模式 | `build:offline` → 覆盖 `rawfile` → 重新打 APP → 重新提审 | 是 |

**只要没有用到原生能力，就优先走云端模式**：一份前端改完部署，PWA 用户、iOS Safari、安卓/鸿蒙壳用户
同时生效。

---

## 8. 排查小抄

| 现象 | 先看这里 |
| --- | --- |
| Sync / Build 报「找不到模块构建脚本」 | `entry/hvigorfile.ts` 是否存在 |
| 报资源缺失（media） | `AppScope/resources/base/media/app_icon.png`、`entry/src/main/resources/base/media/startIcon.png` |
| 提示工程模型版本需要升级 | 让 DevEco 自动迁移；或删掉 `hvigor/hvigor-config.json5` 让它重新生成 |
| 打开是空白页 / 一直转圈 | `Index.ets` 的 `SERVER_URL` 是否还是 `richman.example.com`（未配置会显示中文提示页） |
| 首页能开、建房连不上 | `SERVER_URL` 填成了纯静态站点；要填同时托管网页与 Socket.IO 的那台服务器 |
| 离线模式白屏、控制台 404 | 用了 `build` 而不是 `build:offline`（绝对路径 vs 相对路径） |
