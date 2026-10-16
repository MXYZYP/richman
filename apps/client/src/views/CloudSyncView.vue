<script setup lang="ts">
import { computed, ref } from 'vue';
import ViewShell from './ViewShell.vue';
import { browserStorage, loadPlayerStats, savePlayerStats } from '../session/playerStats';
import {
  clearCloudLink,
  describeCloudFailure,
  formatRecoveryCode,
  linkAfterRotate,
  linkAfterSync,
  loadCloudLink,
  normalizeRecoveryCode,
  planCloudRestore,
  restoreFromCloud,
  rotateRecoveryCode,
  saveCloudLink,
  syncToCloud,
  type CloudAccountLink,
} from '../session/playerAccount';
import { formatMoney } from '../ui/format';

/**
 * 「云同步」详情页（《UI 改造方案》§四 + §四尾注）—— 首页那排图标里的第三个。
 *
 * 为什么值得独立成页：它是**唯一会给服务器发数据的操作**（建号 / 同步 / 换恢复码 / 用码恢复），
 * 出错文案也最长。原来挤在首页中部，既占地方，又让人不敢随便点。独立出来之后，
 * 「上传了什么、不传什么」能讲清楚，「恢复码只显示一次」这种需要专注看的步骤也不会被别的
 * 区块打断。
 *
 * 「不点不联网」的规矩不变：这里没有任何自动提交，只有挂在按钮上的调用。
 */
const props = withDefaults(defineProps<{
  /**
   * 首次建号时用作云端昵称。
   *
   * 已经绑定过账号就用**账号上的**昵称 —— 改名是账号的属性，不该被别处的输入框悄悄覆盖。
   * 由 App 持有、在线对战页输入，与首页那版行为一致。
   */
  nickname?: string;
}>(), {
  nickname: '',
});

const emit = defineEmits<{ back: [] }>();

function readCloudLink(): CloudAccountLink | null {
  const storage = browserStorage();
  return storage === undefined ? null : loadCloudLink(storage);
}

const cloudLink = ref<CloudAccountLink | null>(readCloudLink());
const cloudCodeInput = ref('');
// 刚建号 / 换码时拿到的明文恢复码：只显示这一次，因此单独一份状态。
const cloudNewCode = ref('');
const cloudNotice = ref<{ kind: 'ok' | 'error'; message: string } | null>(null);
const cloudBusy = ref(false);

const cloudSummary = computed(() => {
  const link = cloudLink.value;
  if (link === null) return null;
  return {
    nickname: link.nickname,
    wins: link.cloud.wins,
    gamesPlayed: link.cloud.gamesPlayed,
    bestAsset: link.cloud.bestAsset,
    syncedAt: link.lastSyncedAt === 0 ? null : new Date(link.lastSyncedAt).toLocaleString(),
  };
});

async function syncStatsToCloud(): Promise<void> {
  if (cloudBusy.value) return;
  const storage = browserStorage();
  if (storage === undefined) {
    cloudNotice.value = { kind: 'error', message: describeCloudFailure('storage') };
    return;
  }
  const link = cloudLink.value;
  cloudBusy.value = true;
  // 刻意重新读一遍战绩（而不是缓存一份）：刚打完一局进来时缓存可能还是旧值。
  const local = loadPlayerStats(storage);
  const result = await syncToCloud({
    local,
    nickname: link?.nickname ?? props.nickname,
    link,
  });
  cloudBusy.value = false;
  if (!result.ok) {
    cloudNotice.value = { kind: 'error', message: describeCloudFailure(result.reason) };
    return;
  }
  const next = linkAfterSync(link, result.outcome, local, Date.now());
  if (!saveCloudLink(storage, next)) {
    cloudNotice.value = { kind: 'error', message: describeCloudFailure('storage') };
    return;
  }
  cloudLink.value = next;
  cloudNewCode.value = result.outcome.created ? formatRecoveryCode(result.outcome.recoveryCode ?? '') : '';
  cloudCodeInput.value = '';
  cloudNotice.value = {
    kind: 'ok',
    message: result.outcome.created
      ? `已创建云端账号。请把下面的恢复码抄下来 —— 它只显示这一次，换设备时要用它取回战绩。云端现在记着 ${result.outcome.cloud.wins} 胜 / ${result.outcome.cloud.gamesPlayed} 局。`
      : `已同步。云端现在记着 ${result.outcome.cloud.wins} 胜 / ${result.outcome.cloud.gamesPlayed} 局。`,
  };
}

async function restoreStatsFromCloud(): Promise<void> {
  if (cloudBusy.value) return;
  const storage = browserStorage();
  if (storage === undefined) {
    cloudNotice.value = { kind: 'error', message: describeCloudFailure('storage') };
    return;
  }
  const raw = cloudCodeInput.value;
  // 先在本地验一遍格式（含校验位）：抄错一位时当场指出来，而不是白跑一次必然失败的请求。
  if (normalizeRecoveryCode(raw) === null) {
    cloudNotice.value = {
      kind: 'error',
      message: '这段恢复码不完整或抄错了一位。它是 20 位字符、分成 5 组，请核对后重试。',
    };
    return;
  }
  cloudBusy.value = true;
  const result = await restoreFromCloud(raw);
  cloudBusy.value = false;
  if (!result.ok) {
    cloudNotice.value = { kind: 'error', message: describeCloudFailure(result.reason) };
    return;
  }
  const plan = planCloudRestore(loadPlayerStats(storage), cloudLink.value, raw, result.outcome, Date.now());
  if (!savePlayerStats(storage, plan.merged) || !saveCloudLink(storage, plan.link)) {
    cloudNotice.value = { kind: 'error', message: describeCloudFailure('storage') };
    return;
  }
  cloudLink.value = plan.link;
  cloudCodeInput.value = '';
  cloudNewCode.value = '';
  cloudNotice.value = {
    kind: 'ok',
    message: `已取回「${result.outcome.nickname}」的云端战绩，并与本机战绩合并（本机原有战绩没有被覆盖）。`,
  };
}

async function rotateCloudCode(): Promise<void> {
  const link = cloudLink.value;
  const storage = browserStorage();
  if (cloudBusy.value || link === null || storage === undefined) return;
  cloudBusy.value = true;
  const result = await rotateRecoveryCode(link.code);
  cloudBusy.value = false;
  if (!result.ok) {
    cloudNotice.value = { kind: 'error', message: describeCloudFailure(result.reason) };
    return;
  }
  const next = linkAfterRotate(link, result.outcome, Date.now());
  if (!saveCloudLink(storage, next)) {
    cloudNotice.value = { kind: 'error', message: describeCloudFailure('storage') };
    return;
  }
  cloudLink.value = next;
  const rotated = formatRecoveryCode(result.outcome.recoveryCode ?? '');
  cloudNewCode.value = rotated;
  cloudNotice.value = {
    kind: 'ok',
    message: rotated === ''
      ? '已请求换码，但服务器没有回新的恢复码，请稍后再试。'
      : '已换用新的恢复码，旧的那段立即失效。请把新的抄下来。',
  };
}

function unlinkCloud(): void {
  const storage = browserStorage();
  if (storage !== undefined) clearCloudLink(storage);
  cloudLink.value = null;
  cloudNewCode.value = '';
  cloudCodeInput.value = '';
  cloudNotice.value = {
    kind: 'ok',
    message: '已在这台设备上退出云同步。云端那份战绩不会被删除，随时可以用恢复码再取回。',
  };
}

async function copyCloudCode(): Promise<void> {
  if (cloudNewCode.value === '') return;
  try {
    await navigator.clipboard.writeText(cloudNewCode.value);
    cloudNotice.value = { kind: 'ok', message: '恢复码已复制到剪贴板，请粘贴到安全的地方保存。' };
  } catch {
    // 剪贴板权限被拒 / 非安全上下文：码就在下面的框里，手动选中抄写一样走通。
    cloudNotice.value = { kind: 'error', message: '复制失败，请手动选中下面的恢复码抄写。' };
  }
}
</script>

<template>
  <ViewShell title="云同步" :aside="cloudSummary ? '已绑定' : '未绑定'" @back="emit('back')">
    <div class="cloud-sync">
      <h3 class="cloud-sync-title">恢复码账号</h3>
      <p class="cloud-sync-hint">
        把战绩存到服务器上，换设备时凭一段「恢复码」取回。不需要邮箱，也不需要密码；
        上传的就是「我的战绩」里那份（昵称、局数、胜负、资产峰值、各地图次数），
        没有对局内容，也不会自动联网 —— 只有你按下按钮时才会发请求。
        云端的账号一年没有同步过会被清理，重要战绩请同时用「战绩」页里的「战绩码」留一份。
      </p>

      <p v-if="!cloudSummary" class="cloud-sync-state">这台设备还没有绑定云端账号。</p>
      <p v-else class="cloud-sync-state">
        已绑定 <strong>{{ cloudSummary.nickname }}</strong> 的云端账号：{{ cloudSummary.wins }} 胜 /
        {{ cloudSummary.gamesPlayed }} 局，资产峰值 {{ formatMoney(cloudSummary.bestAsset) }}。
        <span v-if="cloudSummary.syncedAt" class="cloud-sync-when">上次同步 {{ cloudSummary.syncedAt }}</span>
      </p>

      <div class="cloud-sync-actions">
        <button type="button" class="cloud-sync-button" :disabled="cloudBusy" @click="syncStatsToCloud">
          {{ cloudSummary ? '同步到云端' : '创建云端账号并同步' }}
        </button>
        <button
          v-if="cloudSummary"
          type="button"
          class="cloud-sync-button cloud-sync-button-ghost"
          :disabled="cloudBusy"
          @click="rotateCloudCode"
        >换一段恢复码</button>
        <button
          v-if="cloudSummary"
          type="button"
          class="cloud-sync-button cloud-sync-button-ghost"
          :disabled="cloudBusy"
          @click="unlinkCloud"
        >退出云同步</button>
      </div>

      <template v-if="cloudNewCode !== ''">
        <p class="cloud-sync-hint cloud-sync-hint-strong">
          这是你的恢复码，只显示这一次。请抄到纸上或存进密码管理器：忘了它就只能换新码，而旧码会失效。
        </p>
        <div class="cloud-sync-actions">
          <code class="cloud-sync-code">{{ cloudNewCode }}</code>
          <button type="button" class="cloud-sync-button" @click="copyCloudCode">复制恢复码</button>
        </div>
      </template>

      <label class="cloud-sync-field">
        <span>用恢复码恢复</span>
        <input
          v-model="cloudCodeInput"
          type="text"
          class="cloud-sync-input"
          placeholder="RM-XXXX-XXXX-XXXX-XXXX-XXXX"
          autocomplete="off"
          spellcheck="false"
        />
      </label>
      <button
        type="button"
        class="cloud-sync-button"
        :disabled="cloudBusy || cloudCodeInput.trim() === ''"
        @click="restoreStatsFromCloud"
      >从云端恢复</button>
      <p
        v-if="cloudNotice"
        class="cloud-sync-notice"
        :class="`cloud-sync-notice--${cloudNotice.kind}`"
        role="status"
      >{{ cloudNotice.message }}</p>
    </div>
  </ViewShell>
</template>

<style scoped>
/* ---- 云同步（#123）：与「战绩码」同格，但它是在线账号，因此独立成块。 ---- */
.cloud-sync {
  display: grid;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px dashed var(--color-border);
}

.cloud-sync-title {
  margin: 0;
  font-size: 13px;
  font-weight: 900;
  color: var(--color-text);
}

.cloud-sync-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-muted);
}

.cloud-sync-hint-strong {
  font-weight: 700;
  color: var(--color-text);
}

.cloud-sync-state {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text);
}

.cloud-sync-when {
  color: var(--color-muted);
}

.cloud-sync-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.cloud-sync-button {
  min-height: 36px;
  padding-inline: 14px;
  border: 0;
  border-radius: 12px;
  background: var(--color-accent);
  color: var(--color-text);
  font-size: 12px;
  font-weight: 800;
  cursor: pointer;
}

.cloud-sync-button:disabled {
  background: var(--button-disabled-bg);
  color: var(--color-muted);
  cursor: not-allowed;
}

.cloud-sync-button-ghost {
  background: transparent;
  border: 1px solid var(--color-border);
}

.cloud-sync-code {
  flex: 1 1 240px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--surface-input);
  color: var(--color-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.08em;
  word-break: break-all;
}

.cloud-sync-field {
  display: grid;
  gap: 4px;
  font-size: 12px;
  font-weight: 700;
  color: var(--color-muted);
}

.cloud-sync-input {
  min-height: 36px;
  padding-inline: 10px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--surface-input);
  color: var(--color-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  letter-spacing: 0.06em;
}

.cloud-sync-notice {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
}

.cloud-sync-notice--ok {
  color: var(--player-green);
}

.cloud-sync-notice--error {
  color: var(--color-pay);
}
</style>
