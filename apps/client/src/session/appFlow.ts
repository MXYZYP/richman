import type { RoomRole, RoomStatus } from '@richman/protocol';
import type { ConnectionStatus } from './gameSession';
import type { PendingRoomRequest } from './sessionStorage';

/**
 * Which experience the app shell is currently driving.
 * - `online`   — the single OnlineSession owns routing (restore / home / lobby / game / settlement).
 * - `local_setup` — the user is configuring a local hot-seat game.
 * - `local_game`  — a LocalSession is running.
 */
export type AppShellStage = 'online' | 'local_setup' | 'local_game';

/** A restore attempt whose stored session survived the failure and can be retried. */
export type RestoreFailure = 'transient';

/** Read-only snapshot of everything the reducer needs — no session refs, no side effects. */
export interface AppFlowSnapshot {
  stage: AppShellStage;
  /** `readOnlineSession(storage) !== null`: a resumable session is persisted. */
  storedActive: boolean;
  /** `readPendingRoomRequest(storage)`: an unfinished create/join to offer for continuation. */
  pending: PendingRoomRequest | null;
  connection: ConnectionStatus;
  /** `room.value?.status ?? null`: null means "not recovered into a room yet". */
  room: RoomStatus | null;
  /** `state.value?.phase === 'game_over'`: the authoritative snapshot has ended. */
  gameOver: boolean;
  /**
   * The user chose 「暂不恢复」 on a failed restore: route to home this session without
   * touching storage. The stored session survives so home can still offer 回到上一局.
   */
  restoreDeferred: boolean;
  /**
   * 首页壳内的子页面（《UI 改造方案》§三）。首页从「什么都在一页上」拆成「入口页 + 若干子页」之后，
   * 这一项就是那一层子路由；`'main'` 即瘦身后的纯入口页。
   */
  homePane: HomePane;
}

/**
 * 首页壳下的子页面。
 * - `main`         — 纯入口页：hero + 两个等宽主按钮 + 三个胶囊入口 + 成果图标行 + 页脚。
 * - `online`       — 在线对战页：昵称/地图/建房 + 加房（房间码/密码/身份）+ 公开房间列表。
 * - `stats`        — 战绩详情页（含战绩码导入导出）。
 * - `achievements` — 成就详情页。
 * - `cloud`        — 云同步详情页。
 * - `leaderboard`  — 成就排行榜页。
 */
export type HomePane = 'main' | 'online' | 'stats' | 'achievements' | 'cloud' | 'leaderboard';

/**
 * 首页壳里的「非入口」子页各自是**独立的 `AppPage.kind`**，而不是 `{ kind: 'home'; pane }`
 * 一个变体。
 *
 * 理由：`App.vue` 用 `v-else-if="pageKind === …"` 分派视图，`pageKind` 必须是「现在是哪一页」
 * 的唯一真相源。把 pane 塞进 `home` 的载荷里，模板就得再套一层 `page.pane === …` 的条件 ——
 * 同一件事有了两个判据，早晚会分叉。
 *
 * 注意 `home` 不再带 `resume` / `canResumeActive`：两块「续上一局」的提示都搬去了在线对战页，
 * 而入口页位置上永远不会有它们（有东西可续时 `resolvePage` 直接落到 `online`，见 `resolveHomePane`）。
 */
export type AppPage =
  | { kind: 'restoring'; failure: RestoreFailure | null }
  | { kind: 'home' }
  | { kind: 'online'; resume: PendingRoomRequest | null; canResumeActive: boolean }
  | { kind: 'stats' }
  | { kind: 'achievements' }
  | { kind: 'cloud' }
  | { kind: 'leaderboard' }
  | { kind: 'local_setup' }
  | { kind: 'game' }
  | { kind: 'lobby' }
  | { kind: 'settlement' };

/**
 * Pure page-state reducer. Given the current shell stage and observable session
 * facts, decide exactly one page to render.
 *
 * Priority is deliberate: recovery into a room outranks the restore screen, and an
 * ended game (room `ended` or a `game_over` snapshot) outranks the playing page so a
 * stale `playing` room can never render the live game after the match is over.
 */
export function resolvePage(snapshot: AppFlowSnapshot): AppPage {
  if (snapshot.stage === 'local_setup') return { kind: 'local_setup' };
  if (snapshot.stage === 'local_game') {
    return { kind: snapshot.gameOver ? 'settlement' : 'game' };
  }

  // Online shell.
  if (snapshot.room !== null) {
    if (snapshot.room === 'ended' || snapshot.gameOver) return { kind: 'settlement' };
    if (snapshot.room === 'lobby') return { kind: 'lobby' };
    return { kind: 'game' };
  }

  // A stored active session normally drives the restore screen. If the user chose
  // 「暂不恢复」, honour that for this session: fall through to home, where the surviving
  // session is offered as an independent 回到上一局 (canResumeActive) rather than auto-restored.
  if (snapshot.storedActive && !snapshot.restoreDeferred) {
    return { kind: 'restoring', failure: snapshot.connection === 'failed' ? 'transient' : null };
  }

  return resolveHomePane(snapshot);
}

/**
 * 首页壳内的落点判定。到达这里时已经确定：不在本地局里、不在房间里、也不必走恢复页。
 *
 * 两条规则，顺序有意义：
 *  1. **用户点了哪个子页就给哪个** —— 显式导航压过下面的自动落点。否则「有待续请求时点开战绩」
 *     会被立刻弹回在线页，那个入口按钮看上去就是坏的。
 *  2. 停在入口页（`'main'`）时，**有东西可续就自动落到在线页**。待续的建房/加房请求与
 *     「回到上一局」两块提示都住在在线页，而瘦身后的入口页没有位置挂它们；不这样兜的话，
 *     「请求还存着、首页却一字不提」就成了功能黑洞 —— 玩家没有任何路径回到自己那一局。
 */
function resolveHomePane(snapshot: AppFlowSnapshot): AppPage {
  switch (snapshot.homePane) {
    case 'online':
      return { kind: 'online', resume: snapshot.pending, canResumeActive: snapshot.storedActive };
    case 'stats':
      return { kind: 'stats' };
    case 'achievements':
      return { kind: 'achievements' };
    case 'cloud':
      return { kind: 'cloud' };
    case 'leaderboard':
      return { kind: 'leaderboard' };
    case 'main':
      if (snapshot.pending !== null || snapshot.storedActive) {
        return { kind: 'online', resume: snapshot.pending, canResumeActive: snapshot.storedActive };
      }
      return { kind: 'home' };
  }
}

const ROOM_CODE_PATTERN = /^\d{6}$/;
const ROOM_CODE_LENGTH = 6;
const ASCII_WHITESPACE = /[ \t\r\n\f\v]+/g;

/** Strip ASCII whitespace so pasted / autofilled codes normalize before validation. */
export function normalizeRoomCode(raw: string): string {
  return raw.replace(ASCII_WHITESPACE, '');
}

/**
 * Normalize a raw room-code input, then cap to the code length. Normalizing before
 * capping is deliberate: a raw `maxlength` would truncate "12 34" to "12 3" before the
 * whitespace is stripped, corrupting the code. Callers bind this to the input instead.
 */
export function capRoomCode(raw: string): string {
  return normalizeRoomCode(raw).slice(0, ROOM_CODE_LENGTH);
}

/** A room code is exactly six ASCII digits (full-width digits are rejected). */
export function isValidRoomCode(code: string): boolean {
  return ROOM_CODE_PATTERN.test(code);
}

/** Trim surrounding whitespace from a nickname. */
export function normalizeNickname(raw: string): string {
  return raw.trim();
}

/** A nickname is any non-empty value once trimmed. */
export function isValidNickname(nickname: string): boolean {
  return nickname.trim().length > 0;
}

/**
 * Resolve an explicit create submission into its emit payload, or null when it must not
 * fire — already submitting (no accidental double-trigger) or an invalid nickname.
 */
export function planCreateSubmission(rawNickname: string, submitting: boolean): { nickname: string } | null {
  if (submitting) return null;
  const nickname = normalizeNickname(rawNickname);
  return isValidNickname(nickname) ? { nickname } : null;
}

/**
 * 昵称留空时的兜底称号。首页「一键开房」与「提交战绩」都用它 ——
 * 两处若各写一个字面量，早晚会漂移到不同取值，玩家就会在排行榜上认不出自己。
 */
export const DEFAULT_ONLINE_NICKNAME = '大富翁玩家';

/**
 * 首页那个大按钮的判定：把留空的昵称补成默认名，其余只做 trim。
 *
 * 与 `planCreateSubmission` 只差一处 —— 空昵称在这里**不是**错误。首页大按钮的语义是
 * 「先开起来」：逼玩家先回表单填名字，就把一键变成了两步，那正是这条路走过一次的倒退。
 * `submitting` 仍然拦住，所以连点也开不出两间房。
 */
export function planQuickCreate(rawNickname: string, submitting: boolean): { nickname: string } | null {
  if (submitting) return null;
  const nickname = normalizeNickname(rawNickname);
  return { nickname: nickname.length > 0 ? nickname : DEFAULT_ONLINE_NICKNAME };
}

/**
 * Resolve an explicit join submission into its emit payload, or null when it must not
 * fire — already submitting, an invalid room code, or an invalid nickname.
 *
 * `rawPassword`（#23 ③）：房间设了密码时用户手输的那一串。这里只做「trim + 非空才带上」，
 * **不校验长度**。长度规则由服务端权威判定，客户端只在界面上给提示——
 * 把长度判据写成两处，早晚会漂移成「一边拦、一边放」。
 */
export function planJoinSubmission(
  rawRoomCode: string,
  rawNickname: string,
  submitting: boolean,
  role: RoomRole = 'player',
  rawPassword = '',
): { roomCode: string; nickname: string; role: RoomRole; password?: string } | null {
  if (submitting) return null;
  const roomCode = capRoomCode(rawRoomCode);
  const nickname = normalizeNickname(rawNickname);
  if (!isValidRoomCode(roomCode) || !isValidNickname(nickname)) return null;
  const password = rawPassword.trim();
  // 没填就不带这个字段：载荷里出现一个空串，会被服务端读成「提交了一个空密码」，
  // 在设了密码的房间里得到一句「密码错误」，而用户其实只是没打算输密码。
  return password.length === 0 ? { roomCode, nickname, role } : { roomCode, nickname, role, password };
}

export type EntryFailureKind = 'definitive' | 'transient';

/**
 * Entry (create/join) rejections that a same-request-id retry can never fix: the room or
 * nickname state is settled server-side, so the user must abandon and start fresh. Every
 * other code (timeouts, disconnects, in-progress) is transient and defaults to retry.
 */
const DEFINITIVE_ENTRY_ERROR_CODES: Record<string, true> = {
  ROOM_NOT_FOUND: true,
  ROOM_FULL: true,
  NICKNAME_TAKEN: true,
  GAME_ALREADY_STARTED: true,
  INVALID_NICKNAME: true,
  INVALID_ROOM_ACTION: true,
  // 房间密码与观战开关（#23 ③）同样是**确定性**失败：同一个 requestId 原样重试一万次，
  // 密码还是错的、房主还是关着观战。归到「determinitive」一侧，界面才会给出
  // 「改输入重试 / 换个房间」这类真正有用的下一步。
  WRONG_ROOM_PASSWORD: true,
  SPECTATING_DISABLED: true,
};

export function classifyEntryFailure(code: string): EntryFailureKind {
  return DEFINITIVE_ENTRY_ERROR_CODES[code] === true ? 'definitive' : 'transient';
}
