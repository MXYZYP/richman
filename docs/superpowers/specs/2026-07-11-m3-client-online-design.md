# M3 客户端联机改造设计

**日期：** 2026-07-11  
**状态：** Owner 已逐节确认，待实施计划  
**范围：** 首页三入口、大厅、现有游戏 UI 接入服务器、断线提示与重连、本机同乐回归

## 1. 目标

在不修改规则引擎行为、不复制第二套棋盘 UI 的前提下，将现有 Vue 客户端改造成同时支持两种运行模式的完整客户端：

- **本机同乐：** 浏览器本地运行 `@richman/engine`，保留当前热座玩法；
- **联机游戏：** 客户端只发送 `Intent`，由服务器推进唯一权威状态，并接收事件与公开快照进行展示。

M3 的用户可见交付物：

1. 首页提供“创建房间 / 加入房间 / 本机同乐”三个入口；
2. 页面启动时检测本地会话，通过恢复过渡页自动尝试回到上一局；
3. 大厅展示房间码、邀请链接、二维码、玩家状态与房主控制；
4. 现有棋盘、玩家栏、资产面板、操作面板和结算画面可直接呈现服务器状态；
5. 断线时冻结操作并显示状态横幅，重连后通过 `session:resume` 恢复；
6. 离线玩家状态和房主“托管本回合”操作可见且可用；
7. 本机同乐继续使用同一套游戏画面并保持现有行为。

## 2. 明确不做

- 不修改 `@richman/engine` 的规则、状态机、BOT 策略或随机数逻辑；
- 不修改棋盘、卡牌和配置数据；
- 不让联机客户端执行掷骰、抽牌、结算、BOT 决策或其他规则推进；
- 不在客户端还原、猜测或伪造服务器隐藏的 RNG seed 与洗牌队列；
- 不实现 M4 的 JSON 持久化、服务器崩溃恢复和房间长期回收；
- 不提前实现 M5 的四人完整局、服务器崩溃恢复等大型 Playwright 套件；
- 不引入 Vue Router、第二套状态管理方案、UI 组件库、动画库或通用网络框架；
- 不重做现有棋盘视觉风格。

## 3. 已确认的产品决策

### 3.1 页面启动与恢复上一局

页面发现 `localStorage` 中存在会话凭证时，先进入独立恢复过渡状态，显示“正在恢复上一局…”，然后自动发送 `session:resume`。

- 恢复成功：按服务器返回的 `room.status` 进入大厅、游戏或结算；
- 身份或房间已失效：清除凭证，回首页并显示原因；
- 暂时无法连接：保留凭证，显示“重试”和“返回首页”；
- 用户选择暂不恢复：进入首页但保留凭证，首页显示“回到上一局”；
- 用户明确“放弃记录”：清除本地凭证。

有效邀请链接不能覆盖已有会话身份。存在本地会话时，恢复流程优先于邀请链接。

### 3.2 首页

首页有三个独立入口：

- **创建房间：** 输入昵称，成功后保存会话并进入大厅；
- **加入房间：** 输入昵称和 4 位数字房间码；
- **本机同乐：** 打开现有 `GameSetup`，保留本地玩家、电脑玩家、胜利金额等配置。

邀请链接格式：

```text
https://当前地址/?room=1234
```

链接只携带房间码，不携带昵称、`playerId` 或 token。打开链接后自动展开加入表单并预填房间码，昵称仍由玩家输入和确认。

### 3.3 大厅

大厅按以下优先级展示信息与操作：

1. 大号 4 位房间码；
2. “复制邀请链接”和“显示邀请二维码”；
3. 玩家列表：座次、昵称、真人/电脑、在线/离线、房主标记；
4. 房主控制：添加电脑、逐个移除电脑、开始游戏；
5. 非房主状态：“等待房主开始”；
6. 所有人可主动离开大厅。

二维码按需生成并通过弹层显示，不长期占用手机首屏。开始按钮不可用时，界面直接说明原因，例如“至少需要 2 名玩家”。大厅完整状态始终以服务器 `room:state` 为准。

### 3.4 游戏操作权限

- 本机同乐：继续由当前拿着设备的人操作当前玩家；
- 联机模式：只有本机 `playerId` 对应的真实行动者可以操作；
- 债务存在时，行动者是 `debt.debtorId`，否则是 `currentPlayerId`；
- 轮到其他在线真人：显示“等待 ×× 操作”，禁用操作；
- 轮到 BOT：显示“电脑思考中”，动作由服务器执行；
- 轮到离线真人且 `debt === null`：显示“等待 ×× 回来（离线）”；仅当前在线房主看到“托管本回合”，调用 `room:skip_offline_turn`；
- 离线真人处于未解决债务时：不显示托管按钮，明确提示“需要 ×× 回来处理债务”；
- 服务器已安排离线托管时，公开房间状态携带 `takeoverPlayerId`；即使该玩家此时重连，其手动操作仍保持禁用，并显示“房主托管正在执行”，直到服务器清除该字段。

## 4. 架构

### 4.1 页面状态

客户端使用显式有限状态，不引入 Router：

```text
restoring -> home -> lobby -> game -> settlement
```

其中：

- `restoring`：启动恢复、重连恢复；
- `home`：三入口与“回到上一局”；
- `lobby`：等待和房主控制；
- `game`：复用现有游戏组件；
- `settlement`：复用现有结算组件。

`App.vue` 只负责页面流转与当前 session 生命周期，不直接注册 Socket 监听、推进规则或维护动画队列。`OnlineSession` 是从首页开始就存在的长生命周期房间连接所有者：它在任何 create/join/resume/start 请求前注册全部监听，因此不会漏掉 ack 之前广播的 `room:state` 或开局 `game:snapshot`。

### 4.2 双 Session 适配层

游戏画面依赖统一 `GameSession` 契约；联机大厅额外调用同一个 `OnlineSession` 的房间命令，不创建第二份 Socket store：

```ts
type ConnectionStatus = 'local' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

interface GameSession {
  readonly mode: 'local' | 'online';
  readonly state: ShallowRef<RenderableGameState | null>;
  readonly room: ShallowRef<PublicRoomState | null>;
  readonly localPlayerId: Ref<string | null>;
  readonly connectionStatus: Ref<ConnectionStatus>;
  readonly displayPositions: Ref<Record<string, number>>;
  readonly dice: Ref<number[] | null>;
  readonly activeCard: Ref<DisplayCard | null>;
  readonly eventMessage: Ref<string>;
  readonly isAnimating: Ref<boolean>;
  readonly isBotThinking: Ref<boolean>;
  readonly lastError: Ref<string | null>;
  readonly availableActions: ComputedRef<ClientAction[]>;
  sendIntent(intent: Intent): Promise<void>;
  skipOfflineTurn(): Promise<void>;
  leave(): Promise<void>;
  dispose(): void;
}

interface OnlineSession extends GameSession {
  createRoom(nickname: string): Promise<void>;
  joinRoom(roomCode: string, nickname: string): Promise<void>;
  resume(stored: StoredOnlineSession): Promise<void>;
  addBot(): Promise<void>;
  removeBot(playerId: string): Promise<void>;
  startRoom(): Promise<void>;
}
```

最终签名可按现有类型命名调整，但必须保持以下不变量：

- `OnlineSession` 在首页创建，在退出联机流程时销毁；大厅、游戏、恢复页共享同一个实例和同一个 Socket；
- 游戏组件不按 `local/online` 分支执行规则；
- `LocalSession` 是唯一允许在客户端调用 `applyIntent` 的实现；
- `OnlineSession` 不依赖完整 `GameState` 中的 `seed` 或 `decks`；
- `LocalSession` 对 `room`、`localPlayerId` 和在线命令提供明确的本机值或不可用结果，不建立 Socket；
- 房间、连接、当前本机身份、托管状态和游戏状态都来自同一 session，不再建立旁路 store；
- session 被替换后，旧异步回调不得继续修改 UI。

### 4.3 展示状态类型

公开快照为：

```ts
type PublicGameSnapshot = Omit<GameState, 'seed' | 'decks'> & {
  deckCounts: { chance: number; destiny: number };
};
```

UI 使用不依赖私密字段的结构类型，例如：

```ts
type RenderableGameState = Omit<GameState, 'seed' | 'decks'>;
```

完整本地 `GameState` 和在线 `PublicGameSnapshot` 都可作为展示状态。现有只读展示 helper（格子详情、资产、可见动作、日志文案、回合标题）调整为接受展示状态，不通过类型断言伪装成完整 `GameState`。

### 4.4 共享网络协议

新增 `packages/protocol`，供 client 与 server 共同依赖。共享内容包括：

- `PublicGameSnapshot`；
- `PublicRoomState`、`PublicRoomPlayer`、`RoomStatus`，其中 `PublicRoomState.takeoverPlayerId: string | null` 表示已安排且尚未结束的离线托管；
- ack 成功/失败结构和错误码；
- `ClientToServerEvents`、`ServerToClientEvents`；
- create/join/resume payload 与响应类型；
- create/join 的高熵 `requestId` 幂等键。

服务器安全投影函数 `toPublicGameSnapshot` 仍留在 server，不进入共享浏览器 package。服务器内部 `RoomDomainEvent`、RoomManager 类型、幂等记录和投影实现也不属于共享协议。

这次迁移为干净切换：server 和 client 全部改用共享协议，不留下 server 内第二份兼容别名或重复定义。

### 4.5 建议目录

```text
packages/protocol/
  package.json
  tsconfig.json
  src/index.ts

apps/client/src/session/
  gameSession.ts
  localSession.ts
  onlineSession.ts
  gamePresenter.ts
  sessionStorage.ts

apps/client/src/views/
  RestoreView.vue
  HomeView.vue
  LobbyView.vue
  GameView.vue
```

现有棋盘、玩家栏、操作面板、资产面板、格子详情和结算弹窗继续放在 `components/`。

## 5. 数据流

### 5.1 本机同乐

```text
UI intent
-> LocalSession
-> applyIntent(currentState, actorId, intent)
-> events + next GameState
-> GamePresenter 播放事件
-> 展示最终状态
```

BOT 继续只在 LocalSession 内由浏览器驱动。现有 BOT 连续行动上限与动画节奏保持不变。

### 5.2 联机游戏

```text
UI intent
-> OnlineSession emit game:intent
-> server 校验并推进唯一 GameState
-> server broadcast game:events
-> server broadcast game:snapshot
-> OnlineSession / GamePresenter 顺序消费
```

M3 明确调整 M2 的边界快照策略：**每个成功推进状态的 transition 都广播一份公开快照**，而不只在开局、回合结束和结算时广播。适用范围包括真人 `game:intent`、BOT 自动 intent 和离线托管自动 intent；`room:skip_offline_turn` 本身只安排托管、不推进规则，因此不广播游戏快照。每个 transition 的顺序固定为：

```text
game:events -> game:snapshot -> success ack（若该 transition 来自客户端请求）
```

这是必要的服务器协议扩展：联机客户端不运行 `applyIntent`，若普通掷骰、买地或盖房后没有权威快照，客户端无法安全得到新的现金、产权和 `turnPhase`。实现时同步更新 `plan/03-架构与联机协议.md` §5.1/§5.2 和真实 Socket.IO 回归测试。

客户端不做乐观状态推进。普通 intent 的 ack 失败或超时时，客户端状态不自行改变，等待广播或 resume 校准；create/join 的模糊超时按 §6.1 的幂等恢复处理，不能当作“服务器一定没创建”。

### 5.3 动画与快照校准

服务器的每次有效 transition 先广播 `game:events`，再广播 `game:snapshot`。客户端按顺序组成展示批次：

- 事件用于骰子、移动、卡牌与结果文案；
- 对应公开快照是该批次的最终权威状态；
- 多个 transition（例如 BOT 连续行动）排队播放，不互相覆盖；
- 初始开局、恢复或重连得到的独立快照立即成为新基准；
- 恢复快照会取消断线前未完成的旧动画和旧队列；
- 应用每个权威快照后，`displayPositions` 最终校准到玩家真实位置；
- `players[].online` 不直接信任排队快照中的旧值，而是在展示时始终叠加当前 `room.players[].online`，防止动画期间到达的离线事件被旧快照覆盖。

## 6. 房间与连接状态

### 6.1 会话凭证

使用 `localStorage` 键 `richman_session` 保存：

```ts
interface StoredOnlineSession {
  roomCode: string;
  playerId: string;
  token: string;
}
```

create/join 还使用独立的本地 pending 记录：

```ts
interface PendingRoomRequest {
  operation: 'create' | 'join';
  requestId: string;
  nickname: string;
  roomCode?: string;
}
```

`requestId` 使用浏览器安全随机源生成至少 128 bit 熵，不进入邀请 URL、页面或日志。客户端在首次 emit 前持久化 pending 记录；服务器把 requestId 作为房间/玩家的私有幂等字段保存，只要对应房间或座位仍存在，使用相同 requestId 和相同规范化 payload 的重试就返回原始成功结果（包括同一个 token），不重复创建房间或玩家。相同 requestId 配不同 payload 返回安全失败。成功 ack 写入 `richman_session` 后删除 pending；超时、断线或刷新保留 pending 并用同一 requestId 重试。

约束：

- token 不进入 URL、页面、控制台日志或错误信息；
- create/join 成功后原子替换保存值；
- 普通刷新、网络变化和手机切后台不清除；
- 大厅主动离开时，等待 `room:leave` 成功 ack 后清除；
- 游戏中或结算后主动离开时，先明确提示“离开后将无法回到这个座位”；确认并收到 `room:leave` 成功 ack 后清除，服务器保留该座位为离线；
- 无法连接时选择“放弃记录”属于不可恢复的本地操作，必须再次确认；确认后允许清除，本机不再持有回到该座位所需的 token；
- 无效 token、房间不存在或关闭时清除；
- 解析失败的脏数据直接删除并回首页。

### 6.2 断线与重连

Socket 断开后：

- 顶部显示“连接断开，正在重连…”；
- 所有会改变状态的操作立即冻结；
- 保留最后一份可见棋盘，但明确标记为未连接状态。

每次 Socket 重新连接后，`OnlineSession` 都发送 `session:resume` 重新绑定房间身份，不能只依赖 Socket.IO transport 自动 reconnect。

恢复成功后：

- 更新完整 `room`，包括 `takeoverPlayerId`；
- playing/ended 房间使用 resume `snapshot` 重置展示状态；
- 清除旧事件队列；
- 只有在 `takeoverPlayerId !== localPlayerId` 且本机确实拥有当前操作权限时才恢复操作；
- 如果本机玩家已重连但其托管仍在执行，保持禁用并显示“房主托管正在执行”；
- 隐藏断线横幅。

恢复失败分为两类：

- 永久失败（无效 token、房间不存在、房间关闭）：清除凭证并回首页；
- 暂时失败（断网、超时、服务器暂不可达）：保留凭证并提供重试。

### 6.3 房间事件与在线状态

- `room:state`：替换完整大厅/房间公开状态，是房主身份、在线状态和 `takeoverPlayerId` 的权威来源；
- `player:connection`：增量更新当前 `room.players` 中对应玩家的在线状态；GameView 的玩家在线标记始终从 room presence 叠加到公开游戏快照；
- 安排离线托管和托管清除时，服务器都广播新的 `room:state`；resume ack 也返回当前托管字段；
- `room:closed`：停止 session、清除凭证、回首页并显示关闭原因；
- 房主变化、在线状态和托管锁都不能由客户端自行推断。

## 7. 错误与并发控制

- 所有 ack 有明确超时；超时后解除按钮 loading，并提示“服务器暂未响应”；
- create/join 超时属于结果不明确：保留 pending requestId 和表单 payload，重连或重试时复用，不生成第二个身份；
- 创建、加入、开始、添加/移除 BOT、离开和 intent 均防止重复请求；
- intent 在断线、恢复中、动画中、本机无操作权限或本机玩家处于 `takeoverPlayerId` 锁定时不发送；
- ack 失败使用服务器安全 `message`，已知 code 可映射成更明确的中文文案；
- session dispose 必须注销所有 Socket 监听并断开主动创建的 Socket；
- 所有异步响应在写入状态前确认当前 session 仍有效；
- 旧 session 的晚到 ack、事件、快照和 reconnect 回调必须被忽略；
- 联机模式不显示会在本地新建规则状态的“重新开局”；本机同乐保留该操作。

## 8. 依赖

必要新增或迁移：

- `apps/client` production dependency：`socket.io-client`；
- `apps/client` production dependency：`qrcode`；
- `apps/client` dev dependency：`@types/qrcode`；
- client/server 对 `@richman/protocol` 的 workspace dependency。

不新增 Router、额外 store、CSS 框架、动画库或通用请求库。所有依赖版本沿用仓库现有版本，避免无关升级。

## 9. 测试策略

### 9.1 自动测试

#### 共享协议

- client/server 同时通过共享事件类型编译；
- 公共快照类型明确排除 `seed` 与 `decks`；
- 服务器现有序列化安全测试继续通过。

#### LocalSession

- 发送 intent 后按事件推进展示；
- BOT 自动行动仍可运行；
- 债务操作、资产操作、结算与重新开局不倒退；
- 现有 `clientGame` 行为测试迁移后保持等价覆盖。

#### OnlineSession

- create/join/start/intent 的成功与失败；
- create/join ack 丢失后使用同一 requestId 重试，返回原始 token，不重复创建房间或玩家；
- opening `room:state` / `game:snapshot` 在 start ack 之前到达时不丢失；
- 每个成功 transition 都按 `game:events -> game:snapshot` 进入同一顺序队列；
- 多批事件按到达顺序消费；
- `player:connection` 在旧快照动画期间到达后，后续应用旧快照也不能覆盖最新离线状态；
- disconnect 立即冻结操作；
- reconnect 后重新 `session:resume`；
- resume snapshot 重置旧动画与状态；
- resume 发生在已安排托管期间时，`takeoverPlayerId` 继续禁用重连玩家；
- 无效 token、ack 超时、`room:closed`；
- dispose 后旧事件无法污染新 session；
- 大厅 leave 只有成功 ack 才删除 session；
- playing/ended leave 经确认后，超时或失败保留 token 且仍可 resume，成功后删除 token并让服务器座位保持离线；
- 复制邀请链接和传给 QR 生成器的精确字符串只包含规范房间 URL，明确不含 token、playerId 或 nickname。

#### 页面状态机

- 启动进入恢复过渡；
- 自动恢复成功和失败分支；
- 首页三入口与“回到上一局”；
- 邀请链接预填房间码且不覆盖已有 session；
- 大厅房主和非房主权限；
- 在线模式只能操作本机玩家；
- 离线真人回合仅在无债务、无现有托管且本机是房主时显示托管按钮；
- 离线债务玩家显示必须重连处理，不能显示必然失败的托管按钮；
- 本机同乐仍能进入现有游戏画面。

测试必须断言可观察行为、边界和状态迁移，不通过读取源码字符串证明功能存在。

### 9.2 真实浏览器验收

在 production 单端口模式下，使用两个独立浏览器上下文，其中至少一个为 390×844 手机视口：

```text
电脑创建房间
-> 复制邀请链接
-> 手机打开链接并加入
-> 房主添加一个 BOT
-> 开始游戏
-> 两端操作并看到一致状态
-> 强制断开手机
-> 电脑看到该玩家离线
-> 手机显示断线横幅
-> 手机重连并通过 resume 对齐状态
-> 再让当前行动真人离线
-> 房主托管本回合
-> 单独进入本机同乐并完成至少一个正常回合
```

至少保存以下真实页面截图：

- 首页：桌面、390×844 手机；
- 大厅：桌面、390×844 手机；
- 联机游戏：桌面、390×844 手机；
- 断线横幅与离线标记：至少一张可辨认截图。

视觉判断以真实 app 为准，不使用脱离仓库的 mockup 代替。

### 9.3 最终门禁

最终至少运行：

```text
pnpm test
pnpm typecheck
pnpm exec tsc -p scripts/tsconfig.json --noEmit
pnpm validate-data
pnpm build
pnpm exec tsx scripts/smoke-production.ts
```

并报告真实 test file / test 数量、构建结果、production smoke 输出和浏览器场景结果。

## 10. 验收标准

M3 完成必须同时满足：

1. 首页三个入口真实可用；
2. 创建、邀请加入、大厅房主操作和开局可在两台浏览器间完成；
3. 现有游戏 UI 在 local/online 两种 session 下共用，不复制棋盘页面；
4. 联机客户端不执行规则，不拥有 RNG seed 或洗牌队列；
5. 每个成功 transition 后两端对位置、现金、产权、阶段和回合状态保持一致；
6. 断线时有明确横幅且不能继续发送操作；
7. 重连后通过 resume 恢复最新权威状态，已安排的托管锁不会因重连丢失；
8. 其他玩家能看到不会被旧快照覆盖的离线标记；房主只能在无债务时托管离线真人回合；
9. create/join 丢失 ack 后可用同一 requestId 恢复原身份，不产生孤儿房间或重复玩家；
10. 邀请链接和二维码的实际 payload 不含 token、playerId 或昵称；
11. 主动离开的 token 只在成功 ack 后删除，失败或超时仍能恢复；
12. 本机同乐至少完成一个真实回合；
13. 桌面与手机关键页面真实渲染可用；
14. 自动测试、typecheck、数据校验、构建和 production smoke 全部通过。
