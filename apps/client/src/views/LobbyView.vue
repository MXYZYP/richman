<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { PublicRoomState } from '@richman/protocol';
import type { LobbyCommand } from '../session/onlineSession';

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
}>(), {
  error: null,
  showMapTitle: false,
});

const emit = defineEmits<{
  addBot: [];
  removeBot: [playerId: string];
  renameBot: [playerId: string, nickname: string];
  start: [];
  leave: [];
  copy: [];
  showQR: [];
}>();


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
    linear-gradient(180deg, rgb(255 255 255 / 94%), rgb(247 243 234 / 84%)),
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
  background: rgb(255 255 255 / 72%);
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
  background: #ffe1d8;
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
  background: rgb(255 255 255 / 62%);
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
  background: rgb(255 255 255 / 88%);
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
  background: rgb(255 255 255 / 62%);
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
  background: rgb(255 255 255 / 72%);
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
</style>
