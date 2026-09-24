import { webview, CacheMode } from '@kit.ArkWeb';

/**
 * 游戏入口页面：用系统 Web 组件承载网页版大富翁（与 Android 的 Capacitor 同思路）。
 *
 * 载入方式二选一：
 *  A) 云端最新版（推荐，server 更新即生效、无需发版）：
 *     把 SERVER_URL 改成你的游戏服务地址，保持 .src(SERVER_URL)。
 *  B) 离线本地版（玩家不联网也能进首页）：
 *     先用 **相对路径** 构建前端 —— `pnpm --filter @richman/client build:offline`
 *     （直接复制默认 `build` 的产物会白屏，原因见下）——再把 `apps/client/dist`
 *     整个目录复制到 entry/src/main/resources/rawfile/ 下，
 *     最后把下面 .src(...) 改为 .src($rawfile('index.html'))。
 *
 * 注意：联机对战依赖 WebSocket，系统 Web 组件原生支持；云端模式务必用 HTTPS 地址。
 */

/**
 * 要加载的地址。**必须填「同时托管网页与联机服务」的那一台**。
 *
 * 为什么不能随便填一个静态站点（比如只托管前端产物的 Cloudflare Pages 地址）：
 * 客户端默认连 `location.origin`（见 `apps/client/src/session/onlineSession.ts`，
 * `io(browserGlobals.location?.origin)`）——页面从哪个源加载，Socket.IO 就往哪个源连。
 * 而 `apps/server` 会静态托管 `apps/client/dist` 并把 `/socket.io` 挂在同一个端口上，
 * 所以云端模式的正确取值就是那台服务器的地址。
 * 填静态站点的后果是「首页打得开、一建房就连不上」，很难一眼看出是地址填错。
 */
const SERVER_URL: string = 'https://richman.example.com';

/**
 * 占位符没改就直说，别让玩家对着一个转圈的空白页猜发生了什么。
 * 判据故意放宽（包含 example.com 就算没配）：宁可多提示一次，也不要让「忘了改」看起来像「服务器挂了」。
 */
function isConfigured(url: string): boolean {
  return url.length > 0 && !url.includes('example.com');
}

@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();

  build() {
    Column() {
      if (isConfigured(SERVER_URL)) {
        Web({ src: SERVER_URL, controller: this.controller })
          .domStorageAccess(true)
          .javaScriptAccess(true)
          .fileAccess(true)
          .databaseAccess(true)
          .imageAccess(true)
          .cacheMode(CacheMode.Default)
          .width('100%')
          .height('100%')
      } else {
        Column() {
          Text('还没配置游戏地址')
            .fontSize(20)
            .fontWeight(FontWeight.Bold)
            .margin({ bottom: 12 })
          Text('打开 entry/src/main/ets/pages/Index.ets，把 SERVER_URL 换成你自己的游戏服务地址（需要同时托管网页与联机服务），然后重新运行。')
            .fontSize(15)
            .textAlign(TextAlign.Center)
        }
        .width('100%')
        .height('100%')
        .padding(24)
        .justifyContent(FlexAlign.Center)
      }
    }
    .width('100%')
    .height('100%')
  }
}
