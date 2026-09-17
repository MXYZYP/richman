import { webview, CacheMode } from '@kit.ArkWeb';

/**
 * 游戏入口页面：用系统 Web 组件承载网页版大富翁（与 Android 的 Capacitor 同思路）。
 *
 * 载入方式二选一：
 *  A) 云端最新版（推荐，server 更新即生效、无需发版）：
 *     把 SERVER_URL 改成你的云地址，例如 'https://richman.example.com'，保持 .src(SERVER_URL)。
 *  B) 离线本地版（玩家不联网也能进首页）：
 *     将 `pnpm build` 产出的 apps/client/dist 整个目录复制到
 *     entry/src/main/resources/rawfile/ 下，
 *     然后把下面 .src(...) 改为 .src($rawfile('index.html'))。
 *
 * 注意：联机对战依赖 WebSocket，系统 Web 组件原生支持；云端模式务必用 HTTPS 地址。
 */
const SERVER_URL: string = 'https://richman.example.com';

@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();

  build() {
    Column() {
      Web({ src: SERVER_URL, controller: this.controller })
        .domStorageAccess(true)
        .javaScriptAccess(true)
        .fileAccess(true)
        .databaseAccess(true)
        .imageAccess(true)
        .cacheMode(CacheMode.Default)
        .width('100%')
        .height('100%')
    }
    .width('100%')
    .height('100%')
  }
}
