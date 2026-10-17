<script setup lang="ts">
import MobileSheet from './MobileSheet.vue';
import { PRIVACY_POLICY_VERSION } from '../session/privacyConsent';

/**
 * 隐私政策正文。
 *
 * 为什么要有这一页：TapTap 的「开放试玩」上架要求里，**隐私合规是硬门槛**
 * （联网 + 无内购只需 ICP 备案 + 防沉迷 + 隐私合规，不需要版号与软著）。
 * 政策必须能在 App 内随时打开，而不只是商店页上挂一个外链。
 *
 * 内容只写这个游戏**真实做过**的事：没有广告、没有统计 SDK、不读通讯录/相册/位置，
 * 也没有设备识别码。别往模板里抄「为改善服务可能收集日志」这类套话 ——
 * 写了就得做得到，审核也会照着问。
 *
 * ★ 正文改一个字，就要同步改 `session/privacyConsent.ts` 里的 `PRIVACY_POLICY_VERSION`，
 *   否则老玩家会沿用旧版本的同意。
 */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <MobileSheet
    :open="props.open"
    layout="modal"
    title="隐私政策"
    :aside="`更新 ${PRIVACY_POLICY_VERSION}`"
    @close="emit('close')"
  >
    <article class="policy">
      <p class="policy-lead">
        本政策说明《大富翁·中国之旅》（下称「本游戏」）在你使用时会处理哪些信息、为什么处理、
        存在哪里，以及你能怎么处置它们。
      </p>

      <section class="policy-section">
        <h3>一、我们处理哪些信息</h3>
        <ul>
          <li><b>昵称</b>：你在进入对局时自己填写的显示名，用于房间里认出彼此、以及在排行榜上显示。不需要真实姓名。</li>
          <li><b>本机存档</b>：对局进度、设置、成就与你自己导入的地图，保存在你浏览器的本地存储里，<b>不会上传</b>。</li>
          <li><b>联机对局数据</b>：房间码、座位、掷骰与买地等操作。这些数据在你与同房间玩家之间经我们的服务器转发，
            仅用于让这一局正常进行；房间结束后不再保留。</li>
          <li><b>排行榜与云同步（可选，需你主动提交）</b>：昵称、胜场、最高资产、玩过的地图数；
            云同步另存一个只用于找回存档的恢复码。不绑定手机号，也不要求邮箱。</li>
        </ul>
      </section>

      <section class="policy-section">
        <h3>二、我们不收集什么</h3>
        <p>
          不读取通讯录、短信、精确位置、相册与相机、麦克风；不采集设备识别码（IMEI / OAID / IDFA）
          与广告标识；不接入广告、统计或行为分析类 SDK。
        </p>
      </section>

      <section class="policy-section">
        <h3>三、第三方组件</h3>
        <p>
          安装包外壳使用 Capacitor（仅提供一个系统 WebView 容器，不含采集逻辑）。
          除此之外没有第三方 SDK。服务器为我们自有，部署在中国境内。
        </p>
      </section>

      <section class="policy-section">
        <h3>四、信息存在哪里、存多久</h3>
        <p>
          本机存档存在你的设备上，清掉浏览器数据即消失。联机房间数据只在房间存续期间存在于服务器。
          排行榜记录保留到你要求删除为止。
        </p>
      </section>

      <section class="policy-section">
        <h3>五、未成年人</h3>
        <p>
          未满 14 周岁的玩家应在监护人同意后使用。未成年人游戏时长与时段由所上架平台提供的
          通用防沉迷能力管理。
        </p>
      </section>

      <section class="policy-section">
        <h3>六、你可以怎么做</h3>
        <p>
          清除浏览器 / App 的本地数据即可移除本机存档与设置；云同步可在「云同步」页解绑；
          如需删除排行榜记录或对隐私政策有疑问，可通过本游戏在 TapTap 的游戏详情页留言联系我们。
        </p>
      </section>

      <section class="policy-section">
        <h3>七、政策更新</h3>
        <p>
          正文有实质变化时，我们会更新上方版本号并重新征求你的同意 —— 不会拿旧版本的同意默认延续。
        </p>
        <p class="policy-meta">生效日期：2026-10-17　备案号：新ICP备2026008728号</p>
      </section>
    </article>
  </MobileSheet>
</template>

<style scoped>
/* 字号只走 style.css 的命名档位（ui/sheetTypography.test.ts 扫全仓守着）。 */
.policy {
  display: grid;
  gap: 14px;
  color: var(--color-text);
  font-size: var(--text-body-size);
  line-height: 1.65;
}

.policy-lead {
  margin: 0;
  color: var(--color-muted);
}

.policy-section h3 {
  margin: 0 0 6px;
  font-size: var(--text-section-size);
  font-weight: 900;
}

.policy-section p {
  margin: 0;
}

.policy-section ul {
  margin: 0;
  padding-left: 18px;
  display: grid;
  gap: 6px;
}

.policy-meta {
  margin-top: 8px;
  color: var(--color-muted);
  font-size: var(--text-meta-size);
}
</style>
