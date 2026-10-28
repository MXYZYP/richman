<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { PublicRoomSummary, RoomRole } from '@richman/protocol';
import { ROOM_PASSWORD_MAX_LENGTH, ROOM_PASSWORD_MIN_LENGTH } from '@richman/protocol';
import { listActiveMaps, type MapCatalogEntry } from '@richman/board-data';
import MapPicker from '../components/MapPicker.vue';
import ViewShell from './ViewShell.vue';
import {
  capRoomCode,
  isValidRoomCode,
  planCreateSubmission,
  planJoinSubmission,
  planQuickCreate,
} from '../session/appFlow';
import type { PendingRoomRequest } from '../session/sessionStorage';

/**
 * 「在线对战页」（《UI 改造方案》§三）—— 所有联机入口的唯一落点。
 *
 * 建房、加入、公开房间列表三件事原本散在首页中部的同一张长卡里，与单机、战绩、排行榜混排；
 * 现在它们独占一页，首页只留一个主按钮把人送过来。**逻辑一行没改**：props / emit 名字与
 * 处理函数全部照搬，变的只是挂载位置。
 *
 * 页面顶端那个「一键开房」是刻意的：把玩家送到这一页就等于是「填表再按一次」，
 * 而那正是这个项目走过一次的倒退。建房只强制两件输入（昵称 + 地图），两者都有默认值，
 * 所以进来就能直接开；想改名 / 换图 / 加别人的房，下面那张完整表单一个入口都没少。
 */
const props = withDefaults(defineProps<{
  /**
   * 这次会话里玩家自称什么。由 App 持有：昵称不止这一页要用 —— 战绩码署名、首次建号的
   * 云端昵称、上榜昵称都读它，留在这一页的局部状态里别处就取不到了。
   */
  nickname?: string;
  submitting?: boolean;
  resume?: PendingRoomRequest | null;
  /** A leftover pending entry can still be retried with the same request id. */
  pendingRetryable?: boolean;
  /** A stored active session survived a deferred restore and can be re-entered. */
  canResumeActive?: boolean;
  initialRoomCode?: string;
  error?: string | null;
  initialMapId?: string;
  activeMaps?: readonly MapCatalogEntry[];
  /** 公开房间列表（#108）：由 App 统一拉取，这里只负责渲染。 */
  publicRooms?: readonly PublicRoomSummary[];
  roomListLoading?: boolean;
  roomListError?: string | null;
}>(), {
  nickname: '',
  submitting: false,
  resume: null,
  pendingRetryable: true,
  canResumeActive: false,
  initialRoomCode: '',
  error: null,
  initialMapId: '',
  activeMaps: () => listActiveMaps(),
  publicRooms: () => [],
  roomListLoading: false,
  roomListError: null,
});

const emit = defineEmits<{
  // 建房只带昵称与地图：电脑难度与规则自定义（初始资金等）都改成「房主在大厅里设」，
  // 因为联机建房那一刻房间里还没有电脑玩家，先问难度是问不出所以然的（#4 / #6）。
  create: [nickname: string, mapId: string];
  join: [payload: { roomCode: string; nickname: string; role: RoomRole; password?: string }];
  /** 手动刷新公开房间列表（#108）；首屏那一次由 App 自己触发。 */
  refreshRooms: [];
  resume: [];
  abandonPending: [];
  resumeActive: [];
  abandonActive: [];
  /** 返回首页（页顶的返回条）。 */
  back: [];
  'update:nickname': [value: string];
}>();

// Invite links prefill the room code only — never auto-submit.
// 昵称是受控的：本地不做副本，改它就走一条 emit 上去。
const nicknameModel = computed({
  get: () => props.nickname,
  set: (value: string) => emit('update:nickname', value),
});
const roomCode = ref(capRoomCode(props.initialRoomCode));
// Join role is an explicit choice (players by default); spectators may enter full or
// already-playing rooms read-only.
const joinRole = ref<RoomRole>('player');
// 房间密码（#23 ③）：只有房间设了密码时才需要填。**不预填、不回显**——
// 服务端只广播「有没有设密码」这一位事实，客户端不可能知道密码内容。
const roomPassword = ref('');
const selectedMapId = ref(
  props.activeMaps.some((entry) => entry.ref.id === props.initialMapId)
    ? props.initialMapId
    : (props.activeMaps[0]?.ref.id ?? ''),
);
// 建房时不再问电脑难度与皮肤：皮肤收进设置（#5），难度与规则自定义收进大厅的房主设置（#4 / #6）。
const showMapSelector = computed(() => props.activeMaps.length > 1);
// D6 阶段 2：选中了工坊自定义图（不在内置列表里）→ 显示版本兼容提示。
const selectedMapIsWorkshop = computed(
  () => !listActiveMaps().some((entry) => entry.ref.id === selectedMapId.value),
);
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
  && planCreateSubmission(nicknameModel.value, props.submitting) !== null
));
// 房间密码（#23 ③）：房间码是 6 位数字、密码是另一件事，所以两者分开校验。
// 密码**留空永远合法**（= 这间房没设密码，或用户不知道）；只有「填了但长度不对」
// 才算输入错误——服务端也认这个区间，两处口径一致。
const passwordLengthInvalid = computed(() => {
  const value = roomPassword.value.trim();
  if (value.length === 0) return false;
  const codePoints = [...value].length;
  return codePoints < ROOM_PASSWORD_MIN_LENGTH || codePoints > ROOM_PASSWORD_MAX_LENGTH;
});
const canJoin = computed(() => (
  planJoinSubmission(roomCode.value, nicknameModel.value, props.submitting, joinRole.value, roomPassword.value) !== null
  && !passwordLengthInvalid.value
));
const showRoomError = computed(() => roomCode.value.length > 0 && !isValidRoomCode(roomCode.value));

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
  const payload = planCreateSubmission(nicknameModel.value, props.submitting);
  if (payload !== null && props.activeMaps.some((entry) => entry.ref.id === selectedMapId.value)) {
    emit('create', payload.nickname, selectedMapId.value);
  }
}

/**
 * 「一键开房」：本页最上面那个大按钮。
 *
 * 建房只强制两件输入（昵称 + 地图），而地图已有默认选中项、昵称有约定俗成的兜底名，
 * 没有非问不可的字段 —— 所以进来就能直接开，房间码随后在大厅里出现。
 *
 * 兜底名会**写回输入框**：房间列表与大厅显示的就是它，玩家得看见自己叫什么。
 * 没有可选地图时回落到表单（不硬发请求，让玩家看见该选一张图）。
 */
function quickCreate(): void {
  const payload = planQuickCreate(nicknameModel.value, props.submitting);
  if (payload === null) return;
  if (!props.activeMaps.some((entry) => entry.ref.id === selectedMapId.value)) {
    jumpToForm();
    return;
  }
  nicknameModel.value = payload.nickname;
  emit('create', payload.nickname, selectedMapId.value);
}

function submitJoin() {
  const payload = planJoinSubmission(
    roomCode.value,
    nicknameModel.value,
    props.submitting,
    joinRole.value,
    roomPassword.value,
  );
  if (payload !== null) emit('join', payload);
}

// ---- 公开房间列表（#108） ----

const roomListHint = ref<{ kind: 'info' | 'error'; message: string } | null>(null);

/**
 * 从公开房间列表里加入 / 旁观。
 *
 * 复用与手动加入完全相同的 `planJoinSubmission`：昵称没填、或有人正在提交时一律不放行，
 * 因此列表入口不会绕开「必须填昵称」这条既有规则。被拦下时给出明确提示——
 * 静默什么都不做是最糟的表现（用户会以为按钮坏了）。
 *
 * 两类**不发出请求**的情形（#23 ③）：
 *  - 这间房设了密码：列表里只有「需要密码」这一位信息，密码本身无从得知，
 *    所以把它当作「把用户送到输入框」的快捷方式——回填房间码、切到对应身份、聚焦密码框；
 *  - 房主关掉了观战：按钮本身应已禁用，这里再兜一次底，避免任何路径绕过。
 */
function joinFromList(entry: PublicRoomSummary, role: RoomRole): void {
  if (role === 'spectator' && !entry.allowSpectators) {
    roomListHint.value = { kind: 'error', message: '房主关闭了观战，无法旁观这局。' };
    return;
  }
  if (entry.hasPassword) {
    roomCode.value = entry.roomCode;
    joinRole.value = role;
    roomPassword.value = '';
    roomListHint.value = {
      kind: 'info',
      message: `房间 ${entry.roomCode} 设了密码：请在上方「房间密码」里输入后点加入。`,
    };
    return;
  }
  const payload = planJoinSubmission(entry.roomCode, nicknameModel.value, props.submitting, role, roomPassword.value);
  if (payload === null) {
    roomListHint.value = {
      kind: 'error',
      message: nicknameModel.value.trim().length === 0
        ? '请先在上面填好昵称，才能从列表加入。'
        : '昵称需为 1 至 20 个字符。',
    };
    return;
  }
  roomListHint.value = null;
  emit('join', payload);
}

// 列表内容每次刷新都可能变，上一次的提示（「请先填昵称」）到那时已经过期了。
watch(() => props.publicRooms, () => {
  roomListHint.value = null;
});

/** 列表行的状态徽标：让「点进去会发生什么」在点之前就看得出来。 */
function roomStatusLabel(summary: PublicRoomSummary): string {
  if (summary.status === 'lobby') return '大厅等待中';
  if (summary.status === 'playing') return '对局进行中';
  return '已结束';
}

function roomSeatLabel(summary: PublicRoomSummary): string {
  const seat = `${summary.playerCount}/${summary.playerLimit} 人`;
  return summary.spectatorCount > 0 ? `${seat} · 观战 ${summary.spectatorCount}` : seat;
}

// 房间设置里也有一份限时（#107），列表上顺手标出来：限时 0 等于不限时，不必显示。
function roomLimitLabel(summary: PublicRoomSummary): string | null {
  return summary.turnTimeLimitSec > 0 ? `每步 ${summary.turnTimeLimitSec} 秒` : null;
}

/** 没有可选地图时的兜底：把玩家送到表单并聚焦，而不是硬发一个必然被拒的请求。 */
function jumpToForm(): void {
  const form = document.getElementById('home-form');
  if (form === null) return;
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const first = form.querySelector('input');
  if (first instanceof HTMLInputElement) first.focus({ preventScroll: true });
}
</script>

<template>
  <ViewShell title="在线联网对战" aside="6 位房间码" @back="emit('back')">
    <div class="entry-body">
      <!-- 两块「续上一局」提示都住在这一页：它们是联机的续玩入口，跟着来源走，不再和首页别的内容抢位置。
           10-16 第五版：形状换成与单机页「继续单机」同一种 `.entry-resume`，顺位也统一成
           「续玩 → 主行动 → 表单 →（本页多一段）列表」。 -->
      <section v-if="canResumeActive" class="entry-resume" aria-label="回到上一局">
        <div class="entry-resume__copy">
          <strong>你还有一局进行中</strong>
          <span>已选择暂不恢复，可随时回到上一局。</span>
        </div>
        <div class="entry-row">
          <button type="button" class="entry-primary" :disabled="submitting" @click="emit('resumeActive')">
            回到上一局
          </button>
          <button type="button" class="entry-secondary" :disabled="submitting" @click="emit('abandonActive')">
            放弃这局
          </button>
        </div>
      </section>

      <section v-if="resume" class="entry-resume" aria-label="上次操作">
        <div class="entry-resume__copy">
          <strong>上次操作未完成</strong>
          <span>{{ resumeLabel }}</span>
          <span v-if="!pendingRetryable" class="home-resume-note">该房间已无法进入，请放弃后重新开始。</span>
        </div>
        <div class="entry-row">
          <button v-if="pendingRetryable" type="button" class="entry-primary" :disabled="submitting" @click="emit('resume')">
            继续上次操作
          </button>
          <button type="button" class="entry-secondary" :disabled="submitting" @click="emit('abandonPending')">
            放弃上次操作
          </button>
        </div>
      </section>

      <p v-if="error" class="entry-error" role="alert">{{ error }}</p>

      <!-- 一键开房：进来就能开，不必先填表。下面的完整表单一个入口都没少。 -->
      <div class="home-main-actions">
        <button
          type="button"
          class="home-main home-main--online"
          :disabled="submitting"
          @click="quickCreate"
        >
          一键开房
          <span class="home-main__hint">用下面的昵称与地图直接开局</span>
        </button>
      </div>

      <!-- 建房与加入拆成两个带标题的分区（10-16 第五版）：原来这两件事混在一个 form 里，
           中间只隔一段提示文字，第一次进来的人得读完才知道「创建房间」和「加入房间」
           是两个不同的动作。现在各有一行小标题，页面上第一次看得出「我到底在干哪件事」。 -->
      <form id="home-form" class="home-form" @submit.prevent>
        <section class="entry-section">
          <h2 class="entry-section-title">开一间新房</h2>

          <label class="entry-field">
            <span>你的昵称</span>
            <input
              v-model="nicknameModel"
              type="text"
              maxlength="12"
              autocomplete="nickname"
              placeholder="例如：小明"
              :disabled="submitting"
              @keydown.enter.prevent="submitCreate"
            />
          </label>

          <MapPicker
            v-if="showMapSelector"
            v-model="selectedMapId"
            :maps="activeMaps"
            :disabled="submitting"
          />

          <button type="button" class="entry-primary" :disabled="!canCreate" @click="submitCreate">
            创建房间
          </button>
          <p v-if="selectedMapIsWorkshop" class="entry-hint">
            已选工坊自定义图：联机可玩。加入者需使用最新版本客户端，旧版客户端会提示无法进入。
          </p>
          <p class="entry-hint">
            建房后进入房间大厅：房主可添加电脑玩家并设定其难度、自定义初始资金等规则；
            皮肤与深色模式在设置里随时切换。
          </p>
        </section>

        <section class="entry-section">
          <h2 class="entry-section-title">加入一间房</h2>

          <div class="home-join">
            <!-- 房间码与房间密码同排（#23 ③）：它们是「进哪间房」的两个输入，天然属于一组；
                 身份选择与提交按钮留在同一行的右侧，保持原有的单行操作节奏。 -->
            <div class="home-join__fields">
              <label class="entry-field">
                <span>房间码</span>
                <input
                  :value="roomCode"
                  type="text"
                  inputmode="numeric"
                  autocomplete="off"
                  placeholder="6 位数字"
                  aria-describedby="home-room-hint"
                  :aria-invalid="showRoomError"
                  :disabled="submitting"
                  @keydown.enter.prevent="submitJoin"
                  @input="onRoomInput"
                />
              </label>
              <!-- 房间密码（#23 ③）：可选。只有知道密码的人才需要填；留空 = 直接尝试进入。
                   用 `type="password"` 让屏幕外的旁观者看不到内容，`autocomplete="off"` 避免
                   浏览器把「房间密码」错当成某个账号密码去自动填充。 -->
              <label class="entry-field">
                <span>房间密码</span>
                <input
                  v-model="roomPassword"
                  type="password"
                  autocomplete="off"
                  :placeholder="`可选，${ROOM_PASSWORD_MIN_LENGTH}-${ROOM_PASSWORD_MAX_LENGTH} 位`"
                  :maxlength="ROOM_PASSWORD_MAX_LENGTH"
                  :disabled="submitting"
                  @keydown.enter.prevent="submitJoin"
                />
              </label>
            </div>
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
            <button type="button" class="entry-secondary" :disabled="!canJoin" @click="submitJoin">
              {{ joinRole === 'spectator' ? '以观战身份加入' : '加入房间' }}
            </button>
          </div>
          <p
            id="home-room-hint"
            class="entry-hint"
            :class="{ 'entry-hint--invalid': showRoomError || passwordLengthInvalid }"
            role="status"
          >
            {{ showRoomError
              ? '房间码需为 6 位数字'
              : passwordLengthInvalid
                ? `房间密码需为 ${ROOM_PASSWORD_MIN_LENGTH}-${ROOM_PASSWORD_MAX_LENGTH} 个字符（留空表示这间房没设密码）`
                : (joinRole === 'spectator'
                  ? '观战仅查看棋盘、资产与战报；满员或已开局的房间也可加入'
                  : '输入好友分享的 6 位房间码；房间设了密码时一并填入密码') }}
          </p>
        </section>
      </form>

      <!-- 公开房间列表（#108）：默认展开，紧跟房间码输入框下方 —— 它是「加入房间」的第二种填法，
           形成「手输码 → 看列表」的自然顺序。手输房间码永远可用，列表拉不到也不妨碍任何人进屋。 -->
      <section class="home-rooms" aria-labelledby="home-rooms-title">
        <div class="home-rooms__head">
          <h2 id="home-rooms-title" class="home-rooms__title">公开房间</h2>
          <button
            type="button"
            class="home-rooms__refresh"
            :disabled="roomListLoading"
            @click="emit('refreshRooms')"
          >{{ roomListLoading ? '刷新中…' : '刷新' }}</button>
        </div>

        <p v-if="roomListError" class="home-rooms__notice home-rooms__notice--error" role="status">
          {{ roomListError }}
        </p>
        <p v-else-if="publicRooms.length === 0" class="home-rooms__notice" role="status">
          {{ roomListLoading ? '正在加载…' : '现在没有公开的房间。输入房间码可以直接加入好友的房。' }}
        </p>
        <ul v-else class="home-rooms__list">
          <li v-for="entry in publicRooms" :key="entry.roomCode" class="home-rooms__item">
            <div class="home-rooms__meta">
              <span class="home-rooms__code">{{ entry.roomCode }}</span>
              <span class="home-rooms__status">{{ roomStatusLabel(entry) }}</span>
              <p class="home-rooms__detail">
                {{ entry.hostNickname }} · {{ entry.mapTitle }} · {{ roomSeatLabel(entry) }}
                <template v-if="roomLimitLabel(entry)"> · {{ roomLimitLabel(entry) }}</template>
                <!-- 需要密码（#23 ③）：只说「要密码」，不泄露密码内容。提前标出来，
                     点进去才发现要密码比先说清楚更让人烦躁。 -->
                <template v-if="entry.hasPassword"> · 需要密码</template>
                <template v-if="!entry.allowSpectators"> · 禁止观战</template>
              </p>
            </div>
            <div class="home-rooms__actions">
              <button
                type="button"
                class="home-rooms__button"
                :disabled="submitting || !entry.joinable"
                :title="entry.joinable ? '' : '这局已经开局或人数已满，只能旁观'"
                @click="joinFromList(entry, 'player')"
              >加入</button>
              <button
                type="button"
                class="home-rooms__button home-rooms__button--ghost"
                :disabled="submitting || !entry.spectatable"
                :title="!entry.allowSpectators ? '房主关闭了观战' : (entry.spectatable ? '' : '观战位已满')"
                @click="joinFromList(entry, 'spectator')"
              >旁观</button>
            </div>
          </li>
        </ul>

        <p
          v-if="roomListHint"
          class="home-rooms__notice"
          :class="{ 'home-rooms__notice--error': roomListHint.kind === 'error' }"
          role="status"
        >
          {{ roomListHint.message }}
        </p>
      </section>
    </div>
  </ViewShell>
</template>

<style scoped>

/* ---- 本页只保留「联机独有」的东西 ----
   一键开房那颗贴纸按钮、建房 / 加入两块的横向排布、公开房间列表。
   壳、卡片、返回条、输入框、按钮、分区小标题、续玩提示块 —— 全部在 ViewShell 与
   ui/entryPage.css 里，与单机模式页共用同一份（见那两个文件头部的说明）。
   ★ 别在本文件里再写一遍那些共用值，否则「两页统一」又变回两份。 */

/* ---- 一键开房：与首页那两颗大按钮同一套贴纸工艺（5px 实体底边）---- */
.home-main-actions {
  display: grid;
  gap: 16px;
  width: 100%;
  /* 与上方内容之间也放开一点：4px 叠在 .entry-body 自己的 gap 上仍偏紧。 */
  margin-top: 4px;
}

.home-main {
  /* 纵向 flex 是为副行留位：按钮带一行副行，高度要算上它。
     与首页同一套贴纸按钮：下缘多了 5px 厚底边，高度要补回来。 */
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  min-height: 58px;
  padding: 8px 12px;
  border: 0;
  border-radius: var(--radius-control);
  font-family: inherit;
  font-size: 1.05rem;
  font-weight: 900;
  letter-spacing: 0.02em;
  cursor: pointer;
}

/* 副行：0.72rem 而不是更小，手机上也读得清。 */
.home-main__hint {
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0;
  opacity: 0.85;
}

/* 与首页 HomeView 保持一致：纯色平涂 -> 同色渐变 + 深色底边的厚贴纸按钮。
   「一键开房」用的就是这个 --online，不该和首页那两个大按钮长得不一样。 */
.home-main--online {
  --mode-deep: color-mix(in srgb, var(--mode-online) 62%, #000);
  color: #fff4ec;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--mode-online) 76%, #fff) 0%,
    var(--mode-online) 58%,
    color-mix(in srgb, var(--mode-online) 88%, #000) 100%
  );
}

.home-main--online {
  box-shadow:
    0 5px 0 var(--mode-deep),
    0 12px 22px rgb(53 39 20 / 22%);
}

.home-main:active:not(:disabled) {
  transform: translateY(3px);
  box-shadow:
    0 2px 0 var(--mode-deep),
    0 6px 12px rgb(53 39 20 / 18%);
}

.home-main:disabled {
  background: var(--button-disabled-bg);
  color: var(--button-disabled-text);
  box-shadow: none;
  cursor: not-allowed;
}

/* ---- 建房 / 加入：两个分区 ---- */
.home-form {
  display: grid;
  gap: 18px;
  min-width: 0;
}

.home-join {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 12px;
  align-items: end;
}

/* 房间码 + 房间密码（#23 ③）同排：两者都是「进哪间房」的输入，横向并排比上下堆叠更好读。
   窄屏退化成上下两行，避免两个输入框各挤到放不下 placeholder。 */
.home-join__fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
}

@media (max-width: 480px) {
  .home-join__fields {
    grid-template-columns: minmax(0, 1fr);
  }
}

.home-role-field {
  display: flex;
  border-radius: 12px;
  overflow: hidden;
  border: 2px solid var(--color-accent);
  align-self: end;
}

.home-role-option {
  flex: 1;
  min-height: 44px;
  padding-inline: 14px;
  border: 0;
  background: transparent;
  color: var(--color-text);
  font-family: inherit;
  font-size: var(--text-body-size);
  font-weight: 800;
  cursor: pointer;
}

.home-role-option.active {
  background: var(--color-accent);
}

.home-role-option:disabled {
  cursor: default;
  opacity: 0.6;
}

.home-resume-note {
  color: var(--color-pay);
  font-weight: 900;
}

/* ---- 公开房间列表（#108）---- */
.home-rooms {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-panel);
  background: var(--surface-raised);
}

.home-rooms__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.home-rooms__title {
  margin: 0;
  color: var(--title-color);
  font-size: var(--text-section-size);
  font-weight: 900;
}

.home-rooms__refresh {
  min-height: 32px;
  padding: 4px 10px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: transparent;
  color: var(--color-muted);
  font-family: inherit;
  font-size: var(--text-meta-size);
  font-weight: 700;
  cursor: pointer;
}

.home-rooms__refresh:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.home-rooms__notice {
  margin: 0;
  color: var(--color-muted);
  font-size: var(--text-meta-size);
  line-height: 1.6;
}

.home-rooms__notice--error {
  color: var(--color-pay);
}

.home-rooms__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.home-rooms__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  border-left: 3px solid var(--color-primary);
}

.home-rooms__meta {
  min-width: 0;
}

.home-rooms__code {
  font-variant-numeric: tabular-nums;
  font-size: var(--text-section-size);
  font-weight: 800;
  letter-spacing: 1px;
}

.home-rooms__status {
  margin-left: 8px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--color-border);
  color: var(--color-muted);
  font-size: var(--text-badge-size);
  font-weight: 700;
}

.home-rooms__detail {
  margin: 2px 0 0;
  overflow: hidden;
  color: var(--color-muted);
  font-size: var(--text-meta-size);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.home-rooms__actions {
  display: flex;
  flex-shrink: 0;
  gap: 6px;
}

.home-rooms__button {
  min-height: 32px;
  padding: 5px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-primary, #2563eb);
  color: #fff;
  font-family: inherit;
  font-size: var(--text-meta-size);
  font-weight: 700;
  cursor: pointer;
}

.home-rooms__button--ghost {
  background: transparent;
  color: inherit;
}

.home-rooms__button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

@media (max-width: 1024px) {
  .home-join {
    grid-template-columns: 1fr;
  }

  .home-role-field {
    align-self: start;
  }
}
</style>
