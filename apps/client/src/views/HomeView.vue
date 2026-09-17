<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { RoomRole } from '@richman/protocol';
import { listActiveMaps, type MapCatalogEntry } from '@richman/board-data';
import { capRoomCode, isValidRoomCode, planCreateSubmission, planJoinSubmission } from '../session/appFlow';
import type { PendingRoomRequest } from '../session/sessionStorage';
import type { LocalSaveCard, LocalSaveIdentity, LocalSaveObservedRecord } from '../session/localGameSave';
import {
  localCardKey,
  requestLocalDelete as planLocalDelete,
  type LocalDeleteConfirmation,
} from './localDeleteConfirmation';

const props = withDefaults(defineProps<{
  submitting?: boolean;
  resume?: PendingRoomRequest | null;
  /** A leftover pending entry can still be retried with the same request id. */
  pendingRetryable?: boolean;
  /** A stored active session survived a deferred restore and can be re-entered. */
  canResumeActive?: boolean;
  initialRoomCode?: string;
  error?: string | null;
  localSaveError?: string | null;
  localSaveCards?: readonly LocalSaveCard[];
  initialMapId?: string;
  activeMaps?: readonly MapCatalogEntry[];
}>(), {
  submitting: false,
  resume: null,
  pendingRetryable: true,
  canResumeActive: false,
  initialRoomCode: '',
  error: null,
  localSaveError: null,
  localSaveCards: () => [],
  initialMapId: '',
  activeMaps: () => listActiveMaps(),
});

const emit = defineEmits<{
  create: [nickname: string, mapId: string];
  join: [payload: { roomCode: string; nickname: string; role: RoomRole }];
  local: [mapId: string];
  resume: [];
  abandonPending: [];
  resumeActive: [];
  abandonActive: [];
  resumeLocal: [observed: LocalSaveIdentity];
  deleteLocal: [observed: LocalSaveObservedRecord];
}>();

// Invite links prefill the room code only — never auto-submit.
const nickname = ref('');
const roomCode = ref(capRoomCode(props.initialRoomCode));
// Join role is an explicit choice (players by default); spectators may enter full or
// already-playing rooms read-only.
const joinRole = ref<RoomRole>('player');
const selectedMapId = ref(
  props.activeMaps.some((entry) => entry.ref.id === props.initialMapId)
    ? props.initialMapId
    : (props.activeMaps[0]?.ref.id ?? ''),
);
const showMapSelector = computed(() => props.activeMaps.length > 1);
watch(
  () => props.activeMaps,
  (activeMaps) => {
    if (!activeMaps.some((entry) => entry.ref.id === selectedMapId.value)) {
      selectedMapId.value = activeMaps[0]?.ref.id ?? '';
    }
  },
  { immediate: true },
);

const canCreate = computed(() => (
  props.activeMaps.some((entry) => entry.ref.id === selectedMapId.value)
  && planCreateSubmission(nickname.value, props.submitting) !== null
));
const canJoin = computed(() => planJoinSubmission(roomCode.value, nickname.value, props.submitting) !== null);
const showRoomError = computed(() => roomCode.value.length > 0 && !isValidRoomCode(roomCode.value));
const confirmingLocalDelete = ref<LocalDeleteConfirmation | null>(null);

function requestLocalDelete(card: LocalSaveCard): void {
  const request = planLocalDelete(confirmingLocalDelete.value, card);
  confirmingLocalDelete.value = request.confirmation;
  if (request.observed !== null) emit('deleteLocal', request.observed);
}

function formatSavedAt(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

const resumeLabel = computed(() => {
  const pending = props.resume;
  if (pending === null) return '';
  return pending.operation === 'create'
    ? `继续创建房间（${pending.nickname}）`
    : pending.role === 'spectator'
      ? `继续以观战身份加入房间 ${pending.roomCode}（${pending.nickname}）`
      : `继续加入房间 ${pending.roomCode}（${pending.nickname}）`;
});

// Normalize before capping so a pasted "12 34" becomes "1234" rather than a raw-truncated "12 3".
function onRoomInput(event: Event) {
  const input = event.target as HTMLInputElement;
  const next = capRoomCode(input.value);
  roomCode.value = next;
  // When the normalized value equals the current ref, Vue skips the patch, so the raw text
  // (e.g. an unstripped space) would linger in the DOM — force the element to agree.
  if (input.value !== next) input.value = next;
}

// Each field maps to exactly one action, bound to its own Enter key, so a single keystroke
// can never fire both create and join and the buttons below stay plain clicks.
function submitCreate() {
  const payload = planCreateSubmission(nickname.value, props.submitting);
  if (payload !== null && props.activeMaps.some((entry) => entry.ref.id === selectedMapId.value)) {
    emit('create', payload.nickname, selectedMapId.value);
  }
}

function submitJoin() {
  const payload = planJoinSubmission(roomCode.value, nickname.value, props.submitting, joinRole.value);
  if (payload !== null) emit('join', payload);
}

function submitLocal() {
  if (props.submitting || !props.activeMaps.some((entry) => entry.ref.id === selectedMapId.value)) return;
  emit('local', selectedMapId.value);
}
</script>

<template>
  <main class="home-shell">
    <section class="home-card" aria-labelledby="home-title">
      <p class="home-eyebrow">联机对战 · 单机游玩</p>
      <h1 id="home-title">进入大富翁</h1>
      <p class="home-copy">用 4 位房间码和好友同桌，或单机游玩开一局。手机、电脑浏览器皆可。</p>

      <p v-if="error" class="home-error" role="alert">{{ error }}</p>
      <p v-if="localSaveError" class="home-error" role="alert">{{ localSaveError }}</p>

      <section v-if="localSaveCards.length > 0" class="local-saves" aria-labelledby="local-saves-title">
        <h2 id="local-saves-title">继续单机</h2>
        <article v-for="card in localSaveCards" :key="localCardKey(card)" class="local-save-card">
          <template v-if="card.kind === 'valid'">
            <div class="local-save-copy">
              <strong>{{ card.summary.title }}</strong>
              <span>{{ card.summary.players.map((player) => `${player.nickname}${player.isBot ? '（电脑）' : ''}`).join('、') }}</span>
              <span>第 {{ card.summary.turn }} 回合 · 保存于 {{ formatSavedAt(card.summary.updatedAt) }}</span>
            </div>
            <div class="local-save-actions">
              <button type="button" class="home-resume-button" @click="emit('resumeLocal', card.summary)">继续游戏</button>
              <button type="button" class="home-resume-abandon" @click="requestLocalDelete(card)">
                {{ confirmingLocalDelete?.key === localCardKey(card) ? '确认删除' : '删除存档' }}
              </button>
              <button
                v-if="confirmingLocalDelete?.key === localCardKey(card)"
                type="button"
                class="home-resume-abandon"
                @click="confirmingLocalDelete = null"
              >取消</button>
            </div>
          </template>
          <template v-else>
            <div class="local-save-copy">
              <strong>无法恢复的本机存档</strong>
              <span>{{ card.reason }}</span>
            </div>
            <div class="local-save-actions">
              <button type="button" class="home-resume-abandon" :disabled="card.recordToken === undefined" @click="requestLocalDelete(card)">
                {{ confirmingLocalDelete?.key === localCardKey(card) ? '确认删除' : '删除存档' }}
              </button>
              <button
                v-if="confirmingLocalDelete?.key === localCardKey(card)"
                type="button"
                class="home-resume-abandon"
                @click="confirmingLocalDelete = null"
              >取消</button>
            </div>
          </template>
        </article>
      </section>

      <section v-if="canResumeActive" class="home-resume" aria-label="回到上一局">
        <div>
          <strong>你还有一局进行中</strong>
          <span>已选择暂不恢复，可随时回到上一局。</span>
        </div>
        <div class="home-resume-actions">
          <button type="button" class="home-resume-button" :disabled="submitting" @click="emit('resumeActive')">
            回到上一局
          </button>
          <button type="button" class="home-resume-abandon" :disabled="submitting" @click="emit('abandonActive')">
            放弃这局
          </button>
        </div>
      </section>

      <section v-if="resume" class="home-resume" aria-label="上次操作">
        <div>
          <strong>上次操作未完成</strong>
          <span>{{ resumeLabel }}</span>
          <span v-if="!pendingRetryable" class="home-resume-note">该房间已无法进入，请放弃后重新开始。</span>
        </div>
        <div class="home-resume-actions">
          <button v-if="pendingRetryable" type="button" class="home-resume-button" :disabled="submitting" @click="emit('resume')">
            继续上次操作
          </button>
          <button type="button" class="home-resume-abandon" :disabled="submitting" @click="emit('abandonPending')">
            放弃上次操作
          </button>
        </div>
      </section>

      <form class="home-form" @submit.prevent>
        <label class="home-field">
          <span>你的昵称</span>
          <input
            v-model="nickname"
            type="text"
            maxlength="12"
            autocomplete="nickname"
            placeholder="例如：小明"
            :disabled="submitting"
            @keydown.enter.prevent="submitCreate"
          />
        </label>

        <label v-if="showMapSelector" class="home-field home-map-field">
          <span>地图</span>
          <select v-model="selectedMapId" :disabled="submitting">
            <option v-for="entry in activeMaps" :key="entry.ref.id" :value="entry.ref.id">
              {{ entry.title }}
            </option>
          </select>
        </label>

        <div class="home-actions">
          <button type="button" class="home-primary" :disabled="!canCreate" @click="submitCreate">
            创建房间
          </button>
        </div>

        <div class="home-join">
          <label class="home-field">
            <span>房间码</span>
            <input
              :value="roomCode"
              type="text"
              inputmode="numeric"
              autocomplete="off"
              placeholder="4 位数字"
              aria-describedby="home-room-hint"
              :aria-invalid="showRoomError"
              :disabled="submitting"
              @keydown.enter.prevent="submitJoin"
              @input="onRoomInput"
            />
          </label>
          <div class="home-role-field" role="radiogroup" aria-label="加入身份">
            <button
              type="button"
              class="home-role-option"
              :class="{ active: joinRole === 'player' }"
              :aria-pressed="joinRole === 'player'"
              :disabled="submitting"
              @click="joinRole = 'player'"
            >参赛</button>
            <button
              type="button"
              class="home-role-option"
              :class="{ active: joinRole === 'spectator' }"
              :aria-pressed="joinRole === 'spectator'"
              :disabled="submitting"
              @click="joinRole = 'spectator'"
            >观战</button>
          </div>
          <button type="button" class="home-secondary" :disabled="!canJoin" @click="submitJoin">
            {{ joinRole === 'spectator' ? '以观战身份加入' : '加入房间' }}
          </button>
        </div>
        <p id="home-room-hint" class="home-hint" :class="{ invalid: showRoomError }" role="status">
          {{ showRoomError ? '房间码需为 4 位数字' : (joinRole === 'spectator'
            ? '观战仅查看棋盘、资产与战报；满员或已开局的房间也可加入'
            : '输入好友分享的 4 位房间码') }}
        </p>
      </form>

      <div class="home-divider" role="separator" aria-hidden="true"><span>或</span></div>

      <button type="button" class="home-local" :disabled="submitting" @click="submitLocal">
        单机游玩（无需联网）
      </button>
    </section>
  </main>
</template>

<style scoped>
.home-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 18px;
}

.home-card {
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

.home-eyebrow,
.home-copy,
.home-field span,
.home-hint {
  color: var(--color-muted);
}

.home-eyebrow {
  margin: 0;
  font-size: 12px;
  font-weight: 900;
  letter-spacing: 0.2em;
}

.home-card h1 {
  margin: 0;
  color: var(--color-primary);
  font-size: clamp(30px, 6vw, 48px);
  line-height: 1;
}

.home-copy {
  margin: 0;
  line-height: 1.6;
}

.home-error {
  margin: 0;
  padding: 10px 12px;
  border-radius: 12px;
  background: #ffe1d8;
  color: var(--color-primary);
  font-weight: 900;
}

.home-resume {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  padding: 12px 14px;
  border-radius: 16px;
  border: 1px solid var(--color-accent);
  background: var(--event-bg);
  color: var(--event-text);
}

.local-saves {
  display: grid;
  gap: 10px;
}

.local-saves h2 {
  margin: 0;
  color: var(--color-primary);
  font-size: 18px;
}

.local-save-card {
  min-width: 0;
  display: grid;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--color-accent);
  border-radius: 16px;
  background: var(--event-bg);
}

.local-save-copy {
  min-width: 0;
  display: grid;
  gap: 3px;
  color: var(--event-text);
}

.local-save-copy span {
  overflow-wrap: anywhere;
  font-size: 13px;
}

.local-save-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.home-resume div {
  display: grid;
  gap: 2px;
}

.home-resume strong {
  font-size: 14px;
}

.home-resume span {
  font-size: 13px;
}

.home-form {
  display: grid;
  gap: 12px;
}

.home-field {
  display: grid;
  gap: 6px;
  font-weight: 800;
}

.home-card input,
.home-card select {
  min-height: 44px;
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  padding: 8px 10px;
  background: rgb(255 255 255 / 84%);
  color: var(--color-text);
  font-weight: 800;
}

.home-card input[aria-invalid='true'] {
  border-color: var(--color-primary);
}

.home-card input:focus-visible,
.home-card select:focus-visible,
.home-card button:focus-visible {
  outline: 3px solid var(--color-accent);
  outline-offset: 2px;
}

.home-join {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 12px;
  align-items: end;
}

.home-role-field {
  display: flex;
  border-radius: 12px;
  overflow: hidden;
  border: 2px solid var(--color-accent);
  align-self: end;
}

.home-role-option {
  min-height: 48px;
  padding-inline: 14px;
  border: 0;
  background: transparent;
  color: var(--color-text);
  font-size: 0.9rem;
  font-weight: 700;
  cursor: pointer;
}

.home-role-option.active {
  background: var(--color-accent);
}

.home-role-option:disabled {
  cursor: default;
  opacity: 0.6;
}


.home-hint {
  margin: 0;
  font-size: 12px;
}

.home-hint.invalid {
  color: var(--color-primary);
  font-weight: 900;
}

.home-primary,
.home-secondary,
.home-local,
.home-resume-button {
  min-height: 48px;
  border: 0;
  border-radius: 16px;
  font-size: 1rem;
  font-weight: 900;
  cursor: pointer;
}

.home-primary {
  width: 100%;
  background: var(--button-enabled-bg);
  color: var(--button-enabled-text);
}

.home-secondary {
  padding-inline: 18px;
  background: var(--color-accent);
  color: var(--color-text);
}

.home-resume-button {
  padding-inline: 16px;
  background: var(--color-primary);
  color: var(--button-enabled-text);
}

.home-resume-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.home-resume-abandon {
  min-height: 48px;
  padding-inline: 16px;
  border: 1px solid var(--color-border);
  border-radius: 16px;
  background: transparent;
  color: var(--event-text);
  font-size: 1rem;
  font-weight: 900;
  cursor: pointer;
}

.home-resume-note {
  color: var(--color-primary);
  font-weight: 900;
}

.home-local {
  background: var(--button-disabled-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
}

.home-primary:disabled,
.home-secondary:disabled,
.home-resume-button:disabled,
.home-resume-abandon:disabled,
.home-local:disabled {
  background: var(--button-disabled-bg);
  color: var(--button-disabled-text);
  cursor: not-allowed;
}

.home-divider {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 12px;
  align-items: center;
  color: var(--color-muted);
  font-size: 13px;
  font-weight: 800;
}

.home-divider::before,
.home-divider::after {
  content: '';
  height: 1px;
  background: var(--color-border);
}

@media (max-width: 767px) {
  .home-shell {
    padding: 10px;
    place-items: start center;
  }

  .home-join {
    grid-template-columns: 1fr;
  }

  .home-role-field {
    align-self: start;
  }
}
</style>
