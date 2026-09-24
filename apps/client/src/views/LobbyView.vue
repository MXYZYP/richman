<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { ChatMessage, PublicRoomState, RoomRuleConfig, RoomSettings, RoomSettingsPatch } from '@richman/protocol';
import { TURN_TIME_LIMIT_OPTIONS } from '@richman/protocol';
import { getActiveMapPack } from '@richman/board-data';
import type { BotDifficulty } from '@richman/engine';
import { BOT_DIFFICULTY_OPTIONS } from '../game/gameSetup';
import type { LobbyCommand } from '../session/onlineSession';
import ChatPanel from '../components/ChatPanel.vue';
import SettingsDialog from '../components/SettingsDialog.vue';

// Mirrors the server's room capacity (roomManager MAX_PLAYERS, humans + bots combined).
// Adding a bot past this is rejected server-side; the client disables the control so the
// host never fires a doomed command.
const MAX_ROOM_PLAYERS = 6;
// Independent spectator seats: read-only members that never count toward MAX_ROOM_PLAYERS.
const MAX_ROOM_SPECTATORS = 3;

const props = withDefaults(defineProps<{
  room: PublicRoomState;
  localPlayerId: string | null;
  isHost: boolean;
  /** A human reason the host cannot start yet, or null when start is allowed. */
  startBlockedReason: string | null;
  /** The lobby command awaiting a server acknowledgement, or null while idle. */
  pendingCommand: LobbyCommand | null;
  /**
   * True only when a live, recovered session can accept a mutation (connected, active, no
   * recovery). While false every host control is disabled — a stale lobby fires no doomed command.
   */
  isCommandReady: boolean;
  error?: string | null;
  /** The canonical invitation URL — the single string shared by copy and the QR encoder. */
  inviteUrl: string;
  connectionLabel: string;
  showMapTitle?: boolean;
  /** 房间聊天消息（联机）。 */
  chatLog?: ChatMessage[];
  /** 发送聊天消息。 */
  chatSend?: (text: string) => void;
  /**
   * 房间设置（#4 规则自定义 / #6 电脑难度）：服务端 `room:settings` 广播的权威副本。
   * `null` = 还没收到，此时不渲染规则面板，避免先闪一帧默认值再跳变。
   */
  roomSettings?: RoomSettings | null;
}>(), {
  error: null,
  showMapTitle: false,
  roomSettings: null,
});

const emit = defineEmits<{
  addBot: [];
  removeBot: [playerId: string];
  renameBot: [playerId: string, nickname: string];
  kick: [playerId: string];
  /** 房主修改房间设置（#4 / #6）：只传要改的字段。 */
  updateSettings: [patch: RoomSettingsPatch];
  start: [];
  leave: [];
  copy: [];
  showQR: [];
}>();

// 房间聊天（#50）：改为大厅卡片文档流内的可折叠区块，取代此前的固定浮动按钮——
// 浮动面板会压住房间卡片底部的操作按钮。折叠态由 isChatOpen 控制。
const isChatOpen = ref(false);
const chatMessages = computed<ChatMessage[]>(() => props.chatLog ?? []);
function handleSendChat(text: string): void {
  props.chatSend?.(text);
}

// 统一设置弹窗（#13）：大厅与对局内共用同一个 SettingsDialog。
const settingsOpen = ref(false);


const botDrafts = ref<Record<string, string>>({});
const focusedBotId = ref<string | null>(null);

function syncBotDraftsFromRoom(): void {
  const nextDrafts = { ...botDrafts.value };
  for (const player of props.room.players) {
    if (!player.isBot) continue;
    if (focusedBotId.value === player.id) continue;
    nextDrafts[player.id] = player.nickname;
  }
  botDrafts.value = nextDrafts;
}

watch(() => props.room.players, syncBotDraftsFromRoom, { immediate: true, deep: true });

function botDraftFor(playerId: string, fallback: string): string {
  return botDrafts.value[playerId] ?? fallback;
}

function updateBotDraft(playerId: string, nickname: string): void {
  botDrafts.value = { ...botDrafts.value, [playerId]: nickname };
}

function commitBotNickname(playerId: string): void {
  const authoritative = props.room.players.find((player) => player.id === playerId)?.nickname ?? '';
  const draft = (botDrafts.value[playerId] ?? authoritative).trim();
  if (draft.length === 0) {
    botDrafts.value = { ...botDrafts.value, [playerId]: authoritative };
    return;
  }
  if (draft === authoritative || !canMutate.value) {
    botDrafts.value = { ...botDrafts.value, [playerId]: authoritative };
    return;
  }
  botDrafts.value = { ...botDrafts.value, [playerId]: authoritative };
  emit('renameBot', playerId, draft);
}

function handleBotNicknameKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    (event.currentTarget as HTMLInputElement).blur();
  }
}

// Single-flight: one command in flight at a time. A mutation may fire only from a ready session
// with nothing pending, so every host control — add, remove, start, and leave — shares one gate.
const busy = computed(() => props.pendingCommand !== null);
const canMutate = computed(() => props.isCommandReady && !busy.value);
const isFull = computed(() => props.room.players.length >= MAX_ROOM_PLAYERS);
const canAddBot = computed(() => props.isHost && canMutate.value && !isFull.value);
const canStart = computed(() => props.startBlockedReason === null && canMutate.value);
const playerCountLabel = computed(() => `参赛 ${props.room.players.length}/${MAX_ROOM_PLAYERS}`);
const spectatorCountLabel = computed(() => `观众 ${props.room.spectators.length}/${MAX_ROOM_SPECTATORS}`);
const isSpectator = computed(() => props.room.spectators.some((member) => member.id === props.localPlayerId));
const waitCopy = computed(() => (
  isSpectator.value
    ? '观战中。你可以在开局后继续查看棋盘、资产与战报。'
    : '等待房主开始游戏，你可以先邀请更多好友加入。'
));

// ---- 房间规则（#4 房主自定义 / #6 电脑难度）----
// 联机是「先建房、后加电脑」：`room:create` 那一刻房间里只有房主，还没有任何电脑玩家，
// 所以难度根本不可能在建房前问出来——它只能在大厅设定，且只在真的有电脑玩家时才出现。
const botCount = computed(() => props.room.players.filter((player) => player.isBot).length);
const hasBot = computed(() => botCount.value > 0);

/** 地图自带的默认规则：房主改之前的取值，也是「恢复默认」的目标。 */
const ruleDefaults = computed(() => {
  try {
    const config = getActiveMapPack(props.room.map.ref.id).game.config;
    return {
      initialCash: config.initialCash,
      maxHouseLevel: config.maxHouseLevel,
      mortgageInterestRate: config.mortgageInterestRate,
    };
  } catch {
    // 地图解析失败（正常不该发生，房间创建时已锁定地图）。退化成隐藏数值面板。
    return null;
  }
});
const effectiveRule = computed<RoomRuleConfig | null>(() => props.roomSettings?.ruleConfig ?? ruleDefaults.value);
const isCustomized = computed(() => props.roomSettings?.ruleConfig != null);
const maxHouseLevelLimit = computed(() => ruleDefaults.value?.maxHouseLevel ?? 1);
const rulesReadOnly = computed(() => (
  !props.isHost || !canMutate.value || props.room.status !== 'lobby' || props.roomSettings === null
));
const rulesVisible = computed(() => props.roomSettings !== null && ruleDefaults.value !== null);
/** 悔棋开关（#101）：服务端广播的权威值；旧服务端/未收到时按「关闭」处理。 */
const undoEnabled = computed(() => props.roomSettings?.minimalUndoEnabled === true);
const ruleError = ref<string | null>(null);

// 输入框允许中途处于非法状态（例如清空重打），只在 change / blur 时才校验并提交。
// 注意：草稿只在「生效规则」变化时同步——用户输入了非法值没提交时，草稿保留，便于继续修改。
const cashDraft = ref('');
const interestPercentDraft = ref('');
watch(effectiveRule, (rule) => {
  cashDraft.value = rule === null ? '' : String(rule.initialCash);
  interestPercentDraft.value = rule === null ? '' : String(Math.round(rule.mortgageInterestRate * 1000) / 10);
}, { immediate: true });

function ruleProblem(rule: RoomRuleConfig): string | null {
  if (!Number.isFinite(rule.initialCash) || rule.initialCash <= 0) return '初始资金需为正数';
  if (!Number.isInteger(rule.maxHouseLevel) || rule.maxHouseLevel < 1 || rule.maxHouseLevel > maxHouseLevelLimit.value) {
    return `最高房级需为 1-${maxHouseLevelLimit.value} 之间的整数`;
  }
  if (!Number.isFinite(rule.mortgageInterestRate) || rule.mortgageInterestRate < 0 || rule.mortgageInterestRate > 1) {
    return '抵押利率需为 0% - 100% 之间';
  }
  return null;
}

/** 用「当前生效规则 + 本次改动」拼出完整三项再提交：服务端的 RoomRuleConfig 是全量三项。 */
function applyRuleChange(partial: Partial<RoomRuleConfig>): void {
  if (rulesReadOnly.value) {
    ruleError.value = null;
    return;
  }
  const base = effectiveRule.value;
  if (base === null) return;
  const next: RoomRuleConfig = {
    initialCash: partial.initialCash ?? base.initialCash,
    maxHouseLevel: partial.maxHouseLevel ?? base.maxHouseLevel,
    mortgageInterestRate: partial.mortgageInterestRate ?? base.mortgageInterestRate,
  };
  const problem = ruleProblem(next);
  if (problem !== null) {
    ruleError.value = problem;
    return;
  }
  ruleError.value = null;
  if (next.initialCash === base.initialCash
    && next.maxHouseLevel === base.maxHouseLevel
    && next.mortgageInterestRate === base.mortgageInterestRate) {
    return;
  }
  emit('updateSettings', { ruleConfig: next });
}

function handleCashChange(event: Event): void {
  applyRuleChange({ initialCash: Number((event.target as HTMLInputElement).value) });
}

function handleHouseLevelChange(event: Event): void {
  applyRuleChange({ maxHouseLevel: Number((event.target as HTMLInputElement).value) });
}

/** 界面上按百分数录入（10 表示 10%），提交前换算成 0-1 的比例。 */
function handleInterestChange(event: Event): void {
  applyRuleChange({ mortgageInterestRate: Number((event.target as HTMLInputElement).value) / 100 });
}

function chooseBotDifficulty(difficulty: BotDifficulty): void {
  if (rulesReadOnly.value) return;
  if (props.roomSettings?.botDifficulty === difficulty) return;
  emit('updateSettings', { botDifficulty: difficulty });
}

function resetRoomRules(): void {
  if (rulesReadOnly.value || !isCustomized.value) return;
  ruleError.value = null;
  emit('updateSettings', { ruleConfig: null });
}

/**
 * 「允许悔棋」开关（#101）。默认**关闭**——它改变的是「已经走过的棋能不能退」这件事，
 * 必须是房主显式的选择加入，而不是悄悄塞给所有人的默认能力。
 *
 * 开启后也不是单方面回退：走错一步的玩家发起后，要由在场对手逐一确认才真的退回，
 * 因此它是一个「双方同意的一步回退」，不会变成某一方随意改历史。
 */
function chooseMinimalUndo(enabled: boolean): void {
  if (rulesReadOnly.value) return;
  if (undoEnabled.value === enabled) return;
  emit('updateSettings', { minimalUndoEnabled: enabled });
}

/** 回合限时（#107）：0 = 不限时（默认）。档位来自协议常量，避免前后端各写一套数字。 */
const turnTimeLimitSec = computed(() => props.roomSettings?.turnTimeLimitSec ?? 0);
const TURN_LIMIT_CHOICES = TURN_TIME_LIMIT_OPTIONS.map((sec) => ({
  value: sec,
  label: sec === 0 ? '不限时' : `${sec} 秒`,
}));

/**
 * 设置回合限时（#107）。超时后**不是**简单跳过这一回合，而是由服务端按电脑策略替这位玩家
 * 走一步（与「离线托管」同一套决策）。因此它对挂机者是一种「温和的强制推进」，
 * 而不是「白丢一回合」——后者会让被限时的人直接输在运气上。
 */
function chooseTurnTimeLimit(sec: number): void {
  if (rulesReadOnly.value) return;
  if (turnTimeLimitSec.value === sec) return;
  emit('updateSettings', { turnTimeLimitSec: sec });
}

/**
 * 「允许被公开房间列表发现」（#108）：默认关闭。
 *
 * 默认关闭是刻意的——房间码本来就是准入凭据，把房间摆进全网列表属于**房主替所有人**做的
 * 曝光决定，不能由升级默认打开。打开后别人能在首页的「公开房间」区块看到这间房并一键进来
 * （对局中则是一键旁观）。
 */
const discoverable = computed(() => props.roomSettings?.isPublic === true);

function chooseDiscoverable(enabled: boolean): void {
  if (rulesReadOnly.value) return;
  if (discoverable.value === enabled) return;
  emit('updateSettings', { isPublic: enabled });
}

const botDifficultyHint = computed(
  () => BOT_DIFFICULTY_OPTIONS.find((option) => option.value === props.roomSettings?.botDifficulty)?.hint ?? '',
);

/** 规则摘要：非房主（或已开局）也能一眼看到这局用的是哪套规则。 */
const ruleSummary = computed(() => {
  const rule = effectiveRule.value;
  if (rule === null) return '';
  const percent = Math.round(rule.mortgageInterestRate * 1000) / 10;
  // 悔棋也写进摘要（#101）：它不是「规则三项」之一，但同样决定了这局的手感，
  // 非房主只能从摘要里知道这件事（开关本身只渲染在房主区）。
  const undo = undoEnabled.value ? ' · 可悔棋（需对手同意）' : '';
  // 回合限时也进摘要（#107）：非房主只能从摘要里知道这局有没有倒计时，
  // 不然他会以为是自己的网络或界面出了问题。
  const limit = turnTimeLimitSec.value > 0 ? ` · 每步限时 ${turnTimeLimitSec.value} 秒` : '';
  // 可被发现也进摘要（#108）：它决定「外面的人能不能搜到我们这间房」，是房间的公开性事实，
  // 不只在房主的开关里可见。
  const listed = discoverable.value ? ' · 已公开到房间列表' : '';
  return `初始资金 ¥${rule.initialCash} · 最高房级 ${rule.maxHouseLevel} 级 · 抵押利率 ${percent}%${undo}${limit}${listed}`;
});

// Copy feedback is transient and self-describing so a clipboard rejection is never silent.
const copyFeedback = ref<{ ok: boolean; message: string } | null>(null);

async function handleCopy() {
  emit('copy');
  try {
    await navigator.clipboard.writeText(props.inviteUrl);
    copyFeedback.value = { ok: true, message: '已复制邀请链接' };
  } catch {
    copyFeedback.value = { ok: false, message: '复制失败，请手动复制下方链接' };
  }
}

// ---- QR modal ----
const qrOpen = ref(false);
const qrDataUrl = ref<string | null>(null);
const qrError = ref<string | null>(null);
const qrButton = ref<HTMLButtonElement | null>(null);
const qrClose = ref<HTMLButtonElement | null>(null);

async function handleShowQR() {
  emit('showQR');
  qrOpen.value = true;
  qrError.value = null;
  if (qrDataUrl.value !== null) return;
  try {
    // Load the QR generator only on demand: it never runs until the host opens the dialog.
    const { default: QRCode } = await import('qrcode');
    qrDataUrl.value = await QRCode.toDataURL(props.inviteUrl, { margin: 1, width: 320 });
  } catch {
    qrError.value = '二维码生成失败，请改用复制链接分享';
  }
}

function closeQR() {
  qrOpen.value = false;
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && qrOpen.value) closeQR();
}

// Move focus into the dialog on open and return it to the trigger on close — the minimum
// keyboard contract for an accessible modal without trapping the whole page.
watch(qrOpen, (open) => {
  if (open) {
    window.addEventListener('keydown', handleKeydown);
    void nextTick(() => qrClose.value?.focus());
  } else {
    window.removeEventListener('keydown', handleKeydown);
    void nextTick(() => qrButton.value?.focus());
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <main class="lobby-shell">
    <section class="lobby-card" aria-labelledby="lobby-title">
      <header class="lobby-head">
        <p class="lobby-eyebrow">联机对战</p>
        <h1 id="lobby-title">房间 {{ room.roomCode }}</h1>
        <p v-if="showMapTitle" class="lobby-map-title">{{ room.map.title }}</p>
        <p class="lobby-status" role="status">等待开始 · {{ connectionLabel }}</p>
      </header>

      <section class="lobby-invite" aria-label="邀请好友">
        <span class="lobby-invite-label">把这个链接发给好友，同一个房间开局：</span>
        <code class="lobby-invite-url">{{ inviteUrl }}</code>
        <div class="lobby-invite-actions">
          <button type="button" class="lobby-btn lobby-btn--accent" @click="handleCopy">复制邀请链接</button>
          <button ref="qrButton" type="button" class="lobby-btn lobby-btn--ghost" @click="handleShowQR">显示二维码</button>
        </div>
        <p v-if="copyFeedback" class="lobby-invite-feedback" :class="{ failed: !copyFeedback.ok }" role="status">
          {{ copyFeedback.message }}
        </p>
      </section>

      <p v-if="error" class="lobby-error" role="alert">{{ error }}</p>

      <section class="lobby-roster-block" aria-label="参赛名单">
        <header class="lobby-roster-head">
          <h2>参赛名单</h2>
          <span class="lobby-count">{{ playerCountLabel }}</span>
        </header>
        <ul class="lobby-roster">
          <li v-for="player in room.players" :key="player.id" class="lobby-player">
            <span class="lobby-dot" :class="{ offline: !player.online }" aria-hidden="true"></span>
            <input
              v-if="isHost && player.isBot && room.status === 'lobby'"
              class="lobby-bot-name-input"
              type="text"
              :value="botDraftFor(player.id, player.nickname)"
              :disabled="!canMutate"
              :aria-label="`重命名 ${player.nickname}`"
              maxlength="20"
              @input="updateBotDraft(player.id, ($event.target as HTMLInputElement).value)"
              @focus="focusedBotId = player.id"
              @blur="focusedBotId = null; commitBotNickname(player.id)"
              @keydown="handleBotNicknameKeydown($event)"
            />
            <span v-else class="lobby-name">
              {{ player.nickname }}<template v-if="player.id === localPlayerId">（你）</template>
            </span>
            <span v-if="!player.online" class="lobby-flag lobby-flag--offline">离线</span>
            <span v-if="player.id === room.hostId" class="lobby-flag lobby-flag--host">房主</span>
            <span v-else-if="player.isBot" class="lobby-flag lobby-flag--bot">电脑</span>
            <button
              v-if="isHost && !player.isBot && player.id !== localPlayerId"
              type="button"
              class="lobby-remove lobby-remove--kick"
              :disabled="!canMutate"
              :aria-label="`移出 ${player.nickname}`"
              @click="emit('kick', player.id)"
            >
              移出
            </button>
            <button
              v-if="isHost && player.isBot"
              type="button"
              class="lobby-remove"
              :disabled="!canMutate"
              :aria-label="`移除 ${player.nickname}`"
              @click="emit('removeBot', player.id)"
            >
              移除
            </button>
          </li>
        </ul>
      </section>

      <section class="lobby-roster-block" aria-label="观众名单">
        <header class="lobby-roster-head">
          <h2>观众名单</h2>
          <span class="lobby-count">{{ spectatorCountLabel }}</span>
        </header>
        <ul v-if="room.spectators.length > 0" class="lobby-roster lobby-roster--spectators">
          <li v-for="member in room.spectators" :key="member.id" class="lobby-player">
            <span class="lobby-dot" :class="{ offline: !member.online }" aria-hidden="true"></span>
            <span class="lobby-name">
              {{ member.nickname }}<template v-if="member.id === localPlayerId">（你 · 观战中）</template>
            </span>
            <span v-if="!member.online" class="lobby-flag lobby-flag--offline">离线</span>
            <span v-else-if="member.id === localPlayerId" class="lobby-flag lobby-flag--spectator">观战</span>
          </li>
        </ul>
        <p v-else class="lobby-spectators-empty">还没有观众。好友可在首页选择「观战」加入。</p>
      </section>

      <!-- 房间规则（#4 初始资金等 / #6 电脑难度）：房主可改，其他成员只读。
           规则由服务端 `room:settings` 广播同步，房主改完立刻对全房间生效。 -->
      <section v-if="rulesVisible" class="lobby-rules" aria-label="房间规则">
        <header class="lobby-roster-head">
          <h2>房间规则</h2>
          <span class="lobby-count">{{ isCustomized ? '已自定义' : '地图默认' }}</span>
        </header>

        <p class="lobby-rules__summary">{{ ruleSummary }}</p>

        <template v-if="isHost">
          <div class="lobby-rules__grid">
            <label class="lobby-rules__field">
              <span>初始资金</span>
              <input
                type="number"
                inputmode="numeric"
                min="1"
                step="1000"
                :value="cashDraft"
                :disabled="rulesReadOnly"
                @change="handleCashChange"
              />
            </label>
            <label class="lobby-rules__field">
              <span>最高房级</span>
              <input
                type="number"
                inputmode="numeric"
                min="1"
                :max="maxHouseLevelLimit"
                :value="roomSettings?.ruleConfig?.maxHouseLevel ?? ruleDefaults?.maxHouseLevel"
                :disabled="rulesReadOnly"
                @change="handleHouseLevelChange"
              />
            </label>
            <label class="lobby-rules__field">
              <span>抵押利率 %</span>
              <input
                type="number"
                inputmode="decimal"
                min="0"
                max="100"
                step="1"
                :value="interestPercentDraft"
                :disabled="rulesReadOnly"
                @change="handleInterestChange"
              />
            </label>
          </div>

          <p class="lobby-rules__hint">
            最高房级不得超过 {{ maxHouseLevelLimit }} 级（按地图档位；超出会让顶层房屋收 0 元租金）。
            <button
              type="button"
              class="lobby-rules__reset"
              :disabled="rulesReadOnly || !isCustomized"
              @click="resetRoomRules"
            >恢复地图默认</button>
          </p>

          <!-- 难度只在房间里确实存在电脑玩家时出现（#6）：没有电脑时它没有任何作用。 -->
          <div v-if="hasBot" class="lobby-rules__difficulty">
            <span class="lobby-rules__difficulty-label">电脑难度</span>
            <div class="lobby-rules__difficulty-options" role="radiogroup" aria-label="电脑难度">
              <button
                v-for="option in BOT_DIFFICULTY_OPTIONS"
                :key="option.value"
                type="button"
                class="lobby-rules__difficulty-option"
                :class="{ active: roomSettings?.botDifficulty === option.value }"
                :aria-pressed="roomSettings?.botDifficulty === option.value"
                :disabled="rulesReadOnly"
                @click="chooseBotDifficulty(option.value)"
              >{{ option.label }}</button>
            </div>
            <p class="lobby-rules__hint">{{ botDifficultyHint }}仅影响电脑决策，不影响真人玩家。</p>
          </div>

          <!-- 悔棋开关（#101）：默认关闭。开启后也不是单方面回退——发起方仍需在场对手
               逐一同意，因此它改变的是「历史能不能退一步」，而不改变任何一步的规则。 -->
          <div class="lobby-rules__difficulty">
            <span class="lobby-rules__difficulty-label">悔棋</span>
            <div class="lobby-rules__difficulty-options" role="radiogroup" aria-label="悔棋">
              <button
                type="button"
                class="lobby-rules__difficulty-option"
                :class="{ active: !undoEnabled }"
                :aria-pressed="!undoEnabled"
                :disabled="rulesReadOnly"
                @click="chooseMinimalUndo(false)"
              >关闭</button>
              <button
                type="button"
                class="lobby-rules__difficulty-option"
                :class="{ active: undoEnabled }"
                :aria-pressed="undoEnabled"
                :disabled="rulesReadOnly"
                @click="chooseMinimalUndo(true)"
              >允许悔棋</button>
            </div>
            <p class="lobby-rules__hint">
              开启后，走错一步的玩家可发起悔棋，但需在场对手逐一同意才会退回上一步；20 秒内没集齐即作废。
            </p>
          </div>

          <p v-if="ruleError" class="lobby-rules__error" role="alert">{{ ruleError }}</p>
        </template>

        <!-- 回合限时（#107）：所有人可见（只读给非房主），因为它直接决定每个人有没有倒计时。
             默认不限时；开了之后，到点由服务端按电脑策略替该玩家走一步。 -->
        <div class="lobby-rules__difficulty">
          <span class="lobby-rules__difficulty-label">每步限时</span>
          <div class="lobby-rules__difficulty-options" role="radiogroup" aria-label="每步限时">
            <button
              v-for="choice in TURN_LIMIT_CHOICES"
              :key="choice.value"
              type="button"
              class="lobby-rules__difficulty-option"
              :class="{ active: turnTimeLimitSec === choice.value }"
              :aria-pressed="turnTimeLimitSec === choice.value"
              :disabled="rulesReadOnly"
              @click="chooseTurnTimeLimit(choice.value)"
            >{{ choice.label }}</button>
          </div>
          <p class="lobby-rules__hint">
            {{ turnTimeLimitSec > 0
              ? '轮到你的每一步都有倒计时，到点由服务端替你走一步（与离线托管同一套决策），不会直接跳过整回合。'
              : '不限时：不催任何人的操作节奏。适合熟人局与边聊边玩。' }}
          </p>
        </div>

        <!-- 公开房间列表（#108）：同样所有人可见（只读给非房主）。默认关闭——
             房间码本就是准入凭据，把房间摆到全网列表上是房主替所有人做的曝光决定。 -->
        <div class="lobby-rules__difficulty">
          <span class="lobby-rules__difficulty-label">公开房间</span>
          <div class="lobby-rules__difficulty-options" role="radiogroup" aria-label="是否允许被公开房间列表发现">
            <button
              type="button"
              class="lobby-rules__difficulty-option"
              :class="{ active: !discoverable }"
              :aria-pressed="!discoverable"
              :disabled="rulesReadOnly"
              @click="chooseDiscoverable(false)"
            >仅凭房间码</button>
            <button
              type="button"
              class="lobby-rules__difficulty-option"
              :class="{ active: discoverable }"
              :aria-pressed="discoverable"
              :disabled="rulesReadOnly"
              @click="chooseDiscoverable(true)"
            >公开到列表</button>
          </div>
          <p class="lobby-rules__hint">
            {{ discoverable
              ? '别人能在首页的「公开房间」里看到这间房并一键进来；对局中则是一键旁观。'
              : '只有拿到房间码或邀请链接的人才能进来。' }}
          </p>
        </div>
      </section>

      <section v-if="isHost" class="lobby-controls" aria-label="房主操作">
        <button type="button" class="lobby-btn lobby-btn--ghost" :disabled="!canAddBot" @click="emit('addBot')">
          {{ isFull ? '房间已满' : '添加电脑玩家' }}
        </button>
        <button type="button" class="lobby-btn lobby-btn--primary" :disabled="!canStart" @click="emit('start')">
          {{ pendingCommand === 'start' ? '开始中…' : '开始游戏' }}
        </button>
        <p v-if="startBlockedReason" class="lobby-hint" role="status">{{ startBlockedReason }}</p>
      </section>
      <section v-else class="lobby-wait" aria-label="等待房主">
        <span class="lobby-wait-spinner" aria-hidden="true"></span>
        <p>{{ waitCopy }}</p>
      </section>

      <!-- 房间聊天（#50）：内联在大厅卡片内、可折叠，不再悬浮遮挡操作按钮。 -->
      <section class="lobby-chat" aria-label="房间聊天">
        <button
          type="button"
          class="lobby-chat__toggle"
          :aria-expanded="isChatOpen"
          @click="isChatOpen = !isChatOpen"
        >
          房间聊天
          <span v-if="chatMessages.length > 0" class="lobby-chat__badge">{{ chatMessages.length }}</span>
        </button>
        <ChatPanel
          v-if="isChatOpen"
          class="lobby-chat__panel"
          :messages="chatMessages"
          :local-player-id="localPlayerId"
          @send="handleSendChat"
        />
      </section>

      <!-- 设置：统一设置入口（#13）。原先这里只内联「安装应用」一行，现在整块设置
           （外观 / 声音 / 规则说明 / 安装应用）都收进同一个弹窗，与对局内保持一份实现。 -->
      <section class="lobby-settings" aria-label="设置">
        <SettingsDialog
          :open="settingsOpen"
          :map-id="room.map.ref.id"
          @update:open="settingsOpen = $event"
        />
        <button
          type="button"
          class="lobby-btn lobby-btn--ghost lobby-settings__trigger"
          aria-haspopup="dialog"
          :aria-expanded="settingsOpen"
          @click="settingsOpen = true"
        >设置</button>
      </section>

      <button
        type="button"
        class="lobby-btn lobby-btn--leave"
        :disabled="!canMutate"
        @click="emit('leave')"
      >
        {{ pendingCommand === 'leave' ? '正在离开…' : '离开房间' }}
      </button>
    </section>

    <div v-if="qrOpen" class="lobby-qr-backdrop" role="presentation" @click.self="closeQR">
      <section class="lobby-qr-dialog" role="dialog" aria-modal="true" aria-labelledby="lobby-qr-title">
        <h2 id="lobby-qr-title">扫码加入房间 {{ room.roomCode }}</h2>
        <img v-if="qrDataUrl" class="lobby-qr-image" :src="qrDataUrl" :alt="`房间 ${room.roomCode} 邀请二维码`" />
        <p v-else-if="qrError" class="lobby-qr-error" role="alert">{{ qrError }}</p>
        <p v-else class="lobby-qr-loading" role="status">正在生成二维码…</p>
        <button ref="qrClose" type="button" class="lobby-btn lobby-btn--ghost" @click="closeQR">关闭</button>
      </section>
    </div>

  </main>
</template>

<style scoped>
.lobby-shell {
  min-height: 100vh;
  display: grid;
  place-items: start center;
  padding: 18px;
}

.lobby-card {
  width: min(560px, 100%);
  display: grid;
  gap: 18px;
  padding: clamp(20px, 4vw, 34px);
  border: 1px solid var(--color-border);
  border-radius: 28px;
  background:
    var(--surface-card),
    var(--board-surface);
  box-shadow: 0 18px 48px rgb(53 39 20 / 14%);
}

.lobby-head {
  display: grid;
  gap: 4px;
}

.lobby-eyebrow {
  margin: 0;
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 900;
  letter-spacing: 0.2em;
}

.lobby-head h1 {
  margin: 0;
  color: var(--color-primary);
  font-size: clamp(30px, 6vw, 46px);
  line-height: 1;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.06em;
}

.lobby-status {
  margin: 0;
  color: var(--color-muted);
  font-weight: 800;
}

.lobby-map-title {
  margin: 2px 0 0;
  color: var(--color-text);
  font-weight: 900;
}

.lobby-invite {
  display: grid;
  gap: 8px;
  padding: 14px;
  border: 1px dashed var(--color-accent);
  border-radius: 16px;
  background: var(--event-bg);
}

.lobby-invite-label {
  color: var(--event-text);
  font-size: 13px;
  font-weight: 800;
}

.lobby-invite-url {
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--surface-soft);
  color: var(--color-text);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 13px;
  word-break: break-all;
}

.lobby-invite-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.lobby-invite-feedback {
  margin: 0;
  color: var(--color-gain);
  font-size: 12px;
  font-weight: 900;
}

.lobby-invite-feedback.failed {
  color: var(--color-primary);
}

.lobby-error {
  margin: 0;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--color-error-bg);
  color: var(--color-primary);
  font-weight: 900;
}

.lobby-roster-block {
  display: grid;
  gap: 8px;
}

.lobby-roster-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.lobby-roster-head h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 900;
}

.lobby-count {
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 800;
}

.lobby-spectators-empty {
  margin: 0;
  color: var(--color-muted);
  font-size: 13px;
  font-weight: 700;
}

.lobby-roster {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.lobby-player {
  display: flex;
  gap: 8px;
  align-items: center;
  min-height: 44px;
  padding: 8px 10px;
  border-radius: 12px;
  background: var(--surface-quiet);
}

.lobby-dot {
  width: 10px;
  height: 10px;
  flex: none;
  border-radius: 50%;
  background: var(--color-gain);
}

.lobby-dot.offline {
  background: var(--color-border);
}


.lobby-bot-name-input {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 44px;
  margin-right: auto;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--surface-input);
  color: var(--color-text);
  font: inherit;
  font-weight: 800;
}

.lobby-bot-name-input:disabled {
  background: var(--button-disabled-bg);
  color: var(--button-disabled-text);
  cursor: not-allowed;
}


.lobby-name {
  font-weight: 800;
  color: var(--color-text);
  margin-right: auto;
}

.lobby-flag {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 900;
}

.lobby-flag--host {
  background: var(--color-accent);
  color: var(--color-text);
}

.lobby-flag--bot {
  background: var(--band-utility);
  color: #fff;
}

.lobby-flag--offline {
  background: var(--button-disabled-bg);
  color: var(--color-muted);
}

.lobby-flag--spectator {
  background: var(--color-accent);
  color: var(--color-text);
}

.lobby-remove {
  min-height: 44px;
  padding-inline: 12px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: transparent;
  color: var(--color-primary);
  font-weight: 900;
  cursor: pointer;
}

.lobby-remove:disabled {
  color: var(--button-disabled-text);
  cursor: not-allowed;
}

.lobby-remove--kick {
  color: var(--color-primary);
  border-color: var(--color-primary);
}

.lobby-remove--kick:disabled {
  color: var(--button-disabled-text);
  border-color: var(--color-border);
  cursor: not-allowed;
}

.lobby-controls {
  display: grid;
  gap: 10px;
}

.lobby-wait {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 12px 14px;
  border-radius: 16px;
  border: 1px solid var(--color-border);
  background: var(--surface-quiet);
}

.lobby-wait p {
  margin: 0;
  color: var(--color-muted);
  font-weight: 800;
  font-size: 13px;
}

.lobby-wait-spinner {
  width: 18px;
  height: 18px;
  flex: none;
  border-radius: 50%;
  border: 3px solid var(--color-border);
  border-top-color: var(--color-primary);
  animation: lobby-spin 0.9s linear infinite;
}

.lobby-hint {
  margin: 0;
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 800;
}

.lobby-btn {
  min-height: 48px;
  border: 0;
  border-radius: 16px;
  font-size: 1rem;
  font-weight: 900;
  cursor: pointer;
  padding-inline: 18px;
}

.lobby-btn--primary {
  background: var(--button-enabled-bg);
  color: var(--button-enabled-text);
}

.lobby-btn--accent {
  background: var(--color-accent);
  color: var(--color-text);
}

.lobby-btn--ghost {
  background: var(--surface-soft);
  color: var(--color-primary);
  border: 1px solid var(--color-border);
}

.lobby-btn--leave {
  background: var(--button-disabled-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
}

.lobby-btn:disabled {
  background: var(--button-disabled-bg);
  color: var(--button-disabled-text);
  cursor: not-allowed;
}

.lobby-btn:focus-visible {
  outline: 3px solid var(--color-accent);
  outline-offset: 2px;
}

.lobby-qr-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  padding: 20px;
  background: var(--overlay-scrim);
}

.lobby-qr-dialog {
  width: min(360px, 100%);
  display: grid;
  gap: 14px;
  justify-items: center;
  padding: 24px;
  border: 2px solid var(--color-accent);
  border-radius: 24px;
  background: var(--board-surface);
  box-shadow: 0 24px 80px rgb(0 0 0 / 28%);
  text-align: center;
}

.lobby-qr-dialog h2 {
  margin: 0;
  color: var(--color-text);
  font-size: 20px;
}

.lobby-qr-image {
  /* Fill the dialog on a narrow phone, cap at 240px on wider screens — never overflow at 320px. */
  width: min(240px, 100%);
  max-width: 100%;
  height: auto;
  aspect-ratio: 1 / 1;
  border-radius: 12px;
  background: #fff;
}

.lobby-qr-loading,
.lobby-qr-error {
  margin: 0;
  color: var(--color-muted);
  font-weight: 800;
}

.lobby-qr-error {
  color: var(--color-primary);
}

@keyframes lobby-spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 767px) {
  .lobby-shell {
    padding: 10px;
  }
}

/* ---- 聊天 + 设置（#50 / #52）----
   两者都内联在大厅卡片文档流内，不再使用 position:fixed，
   因此不会与卡片底部的「离开房间」等按钮发生遮挡。 */
.lobby-chat,
.lobby-settings {
  display: grid;
  gap: 8px;
}

.lobby-settings__trigger {
  justify-self: start;
}

.lobby-chat__toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 48px;
  padding: 0 14px;
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: var(--surface-soft);
  color: var(--color-text);
  font-size: 0.95rem;
  font-weight: 800;
  cursor: pointer;
}

.lobby-chat__badge {
  margin-left: auto;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: #c0392b;
  color: #fff;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}

/* 面板宽度铺满卡片，高度受控在卡片内滚动。 */
.lobby-chat__panel {
  width: 100%;
  max-height: min(320px, 46vh);
}

/* ---- 房间规则（#4 / #6）---- */
.lobby-rules {
  display: grid;
  gap: 8px;
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: 16px;
  background: var(--surface-soft);
}

.lobby-rules__summary {
  margin: 0;
  color: var(--color-text);
  font-size: 13px;
  font-weight: 800;
}

/* 三个数值字段：窄屏一列、宽屏三列，避免把大厅卡片撑得很高。 */
.lobby-rules__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 8px;
}

.lobby-rules__field {
  display: grid;
  gap: 4px;
}

.lobby-rules__field span {
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 800;
}

.lobby-rules__field input {
  min-height: 44px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--surface-input);
  color: var(--color-text);
  font: inherit;
  font-weight: 800;
}

.lobby-rules__field input:disabled {
  background: var(--button-disabled-bg);
  color: var(--button-disabled-text);
  cursor: not-allowed;
}

.lobby-rules__hint {
  margin: 0;
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 800;
}

.lobby-rules__reset {
  margin-left: 6px;
  padding: 4px 10px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: transparent;
  color: var(--color-primary);
  font: inherit;
  font-size: 12px;
  font-weight: 900;
  cursor: pointer;
}

.lobby-rules__reset:disabled {
  color: var(--button-disabled-text);
  border-color: var(--color-border);
  cursor: not-allowed;
}

.lobby-rules__difficulty {
  display: grid;
  gap: 6px;
}

.lobby-rules__difficulty-label {
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 800;
}

.lobby-rules__difficulty-options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(72px, 1fr));
  gap: 6px;
}

.lobby-rules__difficulty-option {
  min-height: 44px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--surface-input);
  color: var(--color-text);
  font: inherit;
  font-weight: 900;
  cursor: pointer;
}

.lobby-rules__difficulty-option.active {
  border-color: var(--color-primary);
  background: var(--button-enabled-bg);
  color: var(--button-enabled-text);
}

.lobby-rules__difficulty-option:disabled {
  background: var(--button-disabled-bg);
  color: var(--button-disabled-text);
  cursor: not-allowed;
}

.lobby-rules__difficulty-option:focus-visible {
  outline: 3px solid var(--color-accent);
  outline-offset: 2px;
}

.lobby-rules__error {
  margin: 0;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--color-error-bg);
  color: var(--color-primary);
  font-size: 12px;
  font-weight: 900;
}
</style>
