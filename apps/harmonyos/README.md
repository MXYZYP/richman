# 大富翁联机 · HarmonyOS 封装（ArkTS Web 组件）

把网页版大富翁封装为鸿蒙原生 App，原理与 Android 的 Capacitor 一样：**原生外壳里跑 WebView**，游戏逻辑全在网页端，原生层只负责全屏承载 + 联网权限。

> ⚠️ 本目录是**可直接放进 DevEco 的工程骨架**（缺图标/签名这类二进制资源，DevEco 会自动生成或在控制台补齐）。你也可以在 DevEco 里「新建 Empty Ability 工程」后，只把 `EntryAbility.ts` 与 `Index.ets` 覆盖过去即可。

## 1. 在 DevEco 里跑起来

1. 安装 **DevEco Studio**（鸿蒙官方 IDE），首次启动会引导安装 HarmonyOS SDK（API 11）。
2. `File → Open` 选择本目录 `apps/harmonyos`。（若遇到问题，用 DevEco 新建 `Empty Ability` 工程，再把本目录的
   `entry/src/main/ets/...` 覆盖进新工程。）
3. 准备图标：DevEco 新建工程会自动生成 `startIcon.png` / `app_icon`（位于 `entry/src/main/resources/base/media`）。
   若用本骨架，请补一张 `startIcon.png`，否则编译会报资源缺失。
4. 真机调试：手机打开「开发者模式 → USB 调试 / 无线调试」，用数据线连电脑，DevEco 顶部选设备后点 ▶ Run。
   首次需**签名**：`File → Project Structure → Signing Configs`，勾「Automatically generate signature」并登录华为账号，自动生成调试证书。

## 2. 决定游戏从哪加载（二选一）

打开 `entry/src/main/ets/pages/Index.ets`：

- **云端模式（推荐）**：把 `SERVER_URL` 改成你的云地址，如 `https://richman.example.com`。
  server 端一更新，App 打开即最新，**无需发版**。
- **离线模式**：把 `pnpm build` 产出的 `apps/client/dist` 整个目录复制到
  `entry/src/main/resources/rawfile/`，然后把 `.src(SERVER_URL)` 改为 `.src($rawfile('index.html'))`。
  玩家不联网也能开首页（但联机对战仍需联网）。

> 联机对战用 WebSocket：云端模式务必用 **HTTPS** 地址，否则部分鸿蒙版本会拦截。

## 3. 打包 HAP / APP Pack（上架用）

1. `Build → Build Hap(s) → Build Debug Hap`：本地调试包（HAP）。
2. 上架前打 release 并签名：`Build → Build Apps → Build APP`（产出 `.app`，即 App Pack，内含 HAP）。
   发布证书需在 **AppGallery Connect** 里「证书、APP ID、Profile」三件套配置好（见 SOP 文档第 5 节）。
3. 签名配置：DevEco `Project Structure → Signing Configs`，选「Release」，导入从 AppGallery Connect 下载的
   `.p12` 证书 + `.cer` Profile + Profile 文件。

## 4. 上架鸿蒙应用市场（AppGallery）

完整傻瓜式步骤见仓库 `docs/发布SOP.html` 第 5 节。要点：

1. 注册 **华为开发者联盟** 账号并完成**实名认证**（个人/企业，企业需营业执照）。
2. 进入 **AppGallery Connect** → 创建应用（填包名 `com.richman.game`、应用名称、分类）。
3. 配置「证书、APP ID、Profile」三件套，回到 DevEco 打 Release APP。
4. 在 AppGallery Connect 填写：应用介绍、截图（手机+平板）、隐私政策网址、备案/资质（如涉及）。
5. 上传 `.app` → 提交审核 → 审核通过 → 发布到华为应用市场。

> 🔒 上架必须由**你本人的华为开发者账号**完成（实名认证 + 支付 + 平台审核均不可替代）。
> 我无法代替你提交，但已把工程、签名配置说明与逐项清单备齐，你按 SOP 即可独立完成。

## 5. 后续更新

- **云端模式**：只改 server、重新部署，用户打开 App 即最新，不用发版。
- **离线模式**：重新 `pnpm build` → 覆盖 `rawfile` → 重新打 APP → 重新提交审核。
