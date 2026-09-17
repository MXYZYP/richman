# Phase 2 M1 Room Server Design

## 1. 目标

实现阶段 2 的第一个里程碑：Node.js 20 + Socket.IO 单端口服务器骨架，以及不依赖游戏引擎的大厅房间系统。

M1 完成后，应能通过真实 Socket.IO 客户端完成创建房间、加入房间、会话恢复、添加或移除电脑玩家、房主移交、开局锁定、主动离开和连接状态广播；同时提供 `pnpm party`，让 owner 可在电脑上启动服务并获得局域网地址与终端二维码。

M1 不创建 `GameState`，不处理 `game:intent`，不实现客户端大厅 UI、JSON 存档或 Playwright 整局测试。这些分别属于 M2、M3、M4、M5。

权威依据：

- `plan/03-架构与联机协议.md` §2、§5、§6；
- `plan/05-阶段2-联机版.md` M1；
- `plan/07-阶段4-部署指南.md` §A1。

## 2. 架构

M1 使用三层结构：

```text
Socket.IO 客户端
       │
       ▼
Socket adapter / protocol handlers
       │
       ▼
RoomManager（纯 TypeScript 房间领域层）
       │
       ▼
内存 Room 状态
```

### 2.1 RoomManager

`RoomManager` 负责所有房间规则：

- 创建和查找房间；
- 真人加入；
- 主动离开；
- 被动断线和恢复；
- 添加或移除电脑玩家；
- 房主移交；
- 开局前置校验；
- 生成不含敏感信息的公开房间状态；
- lobby 离线保留与超时清理。

它不依赖 Socket.IO，不监听端口，不读取环境变量，不执行游戏规则。随机数、ID、token、时钟和计时器通过窄接口注入，使房间规则可以用 Vitest 确定性验证。

### 2.2 Socket adapter

Socket adapter 只负责：

- 校验传入载荷的基本形状；
- 将一个 socket 绑定到一个真人会话；
- 调用 `RoomManager`；
- 按 `plan/03` 通过 ack 返回成功或错误；
- 广播 `room:state`、`player:connection`、`room:closed`；
- 维护当前有效 socket 绑定，忽略旧 socket 的迟到 disconnect。

房间业务规则不得散落在 Socket.IO 回调中。

### 2.3 HTTP server

同一个 Node HTTP server 同时承载：

- Socket.IO；
- 生产环境的 client 静态构建产物；
- SPA history fallback。

开发模式仍由 Vite 提供 client 页面，并把 `/socket.io` 代理到 server。生产模式使用单进程、单端口，默认 `3000`。

## 3. 房间模型

### 3.1 私有状态

```ts
interface Room {
  code: string;
  status: 'lobby' | 'playing';
  hostId: string;
  players: RoomPlayer[];
}

interface RoomPlayer {
  id: string;
  nickname: string;
  isBot: boolean;
  online: boolean;
  token: string | null;
}
```

约束：

- `code` 是保留前导零的四字符字符串，范围为 `"0000"` 至 `"9999"`；
- 真人 `id` 使用 `crypto.randomUUID()`；
- 真人 token 使用 `crypto.randomBytes()`，不得使用 `Math.random()`；
- bot 没有 token，始终在线；
- 真人与 bot 合计最多 4 名；
- 房主必须是真人；
- `players` 始终保持加入或添加顺序，房主移交不重排；
- lobby 顺序不代表最终游戏座次；M2 开局时仍按规则掷骰排序并分配颜色。

### 3.2 公开状态

```ts
interface PublicRoomState {
  roomCode: string;
  status: 'lobby' | 'playing';
  hostId: string;
  players: PublicRoomPlayer[];
}

interface PublicRoomPlayer {
  id: string;
  nickname: string;
  isBot: boolean;
  online: boolean;
}
```

任何 ack、广播、日志和错误均不得包含 token。M1 不给 lobby 玩家添加最终座次或玩家颜色字段。

### 3.3 昵称

真人昵称：

- 先执行 `trim()`；
- 处理后不得为空；
- 最长 20 个 Unicode code points；
- 在房间内按处理后的精确字符串比较，不区分额外的大小写或拼音规则；
- 必须与所有现有真人和 bot 昵称唯一。

bot 正式命名为：

```text
电脑 A
电脑 B
电脑 C
```

添加 bot 时选择当前未占用的最小字母；若真人已占用某个名称，跳到下一个。房间人数已满时返回 `ROOM_FULL`；三个 bot 名称都被真人占用但房间仍有空位时返回 `INVALID_ROOM_ACTION`，并给出“没有可用的电脑玩家名称”安全提示。

## 4. 房间码、凭证和 socket 绑定

### 4.1 房间码

生产生成器安全随机选择 `0–9999`，并使用 `padStart(4, '0')`。随机候选碰撞时最多重试 100 次，随后按 `0000` 至 `9999` 顺序扫描第一个空闲码；只有 10000 个码全部占用时才返回内部容量错误。测试可注入固定序列验证碰撞、顺序兜底和真正耗尽。

### 4.2 token

创建和加入成功时向对应真人返回 token。恢复时同时校验 `roomCode`、`playerId`、token；token 使用恒定时间比较。bot 不能恢复真人会话。

### 4.3 socket 绑定

Socket adapter 保存双向绑定：

```text
socketId -> { roomCode, playerId }
roomCode + playerId -> currentSocketId
```

同一 socket 成功 create、join 或 resume 新会话前，先解除旧绑定。同一玩家从新 socket resume 时，新 socket 取代旧 socket；旧 socket 后续 disconnect 只清理自己的绑定，不得把玩家重新标记离线。

## 5. 生命周期

### 5.1 创建

`room:create { nickname }`：

1. 校验昵称；
2. 生成未占用房间码；
3. 创建 lobby；
4. 创建者成为房主和第一位玩家；
5. 绑定 socket；
6. 返回 `{ok:true, roomCode, playerId, token, room}`。

create ack 增加 `room`，使 create、join、resume 都能直接渲染统一的公开房间状态；该扩展需记入 `plan/03` 偏差记录。

### 5.2 加入

`room:join { roomCode, nickname }` 按顺序校验：

1. 房间存在；
2. 房间仍为 lobby；
3. 总人数小于 4；
4. 昵称有效且未占用。

成功后绑定 socket，返回 `{ok:true, playerId, token, room}`，并向房间广播新的 `room:state`。

### 5.3 添加或移除 bot

仅 lobby 房主可调用：

- `room:add_bot`；
- `room:remove_bot {playerId}`。

房间为 playing 时返回 `GAME_ALREADY_STARTED`；非房主返回 `NOT_HOST`；目标不存在或不是真正 bot 时返回 `INVALID_ROOM_ACTION`。成功后广播 `room:state`。

### 5.4 开始

`room:start` 依次校验：

1. 请求者是房主；
2. 房间仍为 lobby；
3. 总玩家至少 2 名；
4. 真人至少 1 名。

人数条件不满足时返回 `NOT_ENOUGH_PLAYERS`。成功后只把房间状态改为 `playing`，不创建 `GameState`；随后广播一次 `room:state`，其中 `status:'playing'` 是 M1 的大厅离开信号。M2 在同一成功路径中加入 `createGame` 和 `game:snapshot`。

### 5.5 主动离开

`room:leave` 永不失败；即使 socket 没有绑定会话，也返回 `{ok:true}`。

- lobby：立即移除真人；若其为房主，按稳定玩家顺序把房主移交给下一位真人；若仍有真人则广播 `room:state`，若已无真人则删除房间及所有 bot；
- playing：不删除座位，只把真人标记为离线，按 §5.8 必要时移交房主，广播 `player:connection {playerId, online:false}`；房主发生变化时再广播 `room:state`。玩家仍可后续 resume。

### 5.6 被动断线

socket disconnect 与主动离开不同：

- lobby 和 playing 都先将真人标记为离线；
- 广播 `player:connection {playerId, online:false}`；
- lobby 额外广播新的 `room:state`；
- playing 不因连接变化重发 `room:state`，连接增量以 `player:connection` 为准。

仅当前有效 socket 的 disconnect 可以改变玩家在线状态。

### 5.7 lobby 离线保留

lobby 中真人被动断线后保留 5 分钟：

- 5 分钟内 resume：取消清理计时器，恢复原玩家身份；
- 超时仍离线：从 lobby 移除；
- 被移除者是房主时，按稳定玩家顺序移交；
- 没有真人后删除房间和 bot；
- 房间删除时向仍可达的 socket 广播 `room:closed {reason:'empty_lobby'|'lobby_idle_timeout'}`。

该 5 分钟 grace period 是 `plan/03` 未定义的 M1 产品决策，必须写入偏差记录。

### 5.8 playing 房主离线

为保证后续托管功能不会永久失效：

- 当前房主转为离线时，把房主移交给稳定顺序中的下一位在线真人；
- 原房主的游戏座位保持不变；
- 原房主 resume 后不自动夺回；
- 如果没有在线真人，暂时保留当前 `hostId`；
- 第一位恢复在线的真人获得房主角色；
- 房主变化广播公开 `room:state`，即使房间已在 playing。

这是一项房间元数据规则，不触碰 `GameState`。

### 5.9 恢复

`session:resume {roomCode, playerId, token}` 成功后：

1. 新 socket 取代该玩家旧 socket；
2. 取消 lobby 离线清理计时器；
3. 标记玩家在线；
4. 必要时按 §5.8 恢复房主；
5. 返回 `{ok:true, room}`；
6. 广播 `player:connection {playerId, online:true}`；
7. lobby 或房主发生变化时广播 `room:state`。

M1 不返回 `game:snapshot`；M2 接入。

### 5.10 playing 房间回收

M1 只实现 lobby 离线 grace period 与超时清理，不给 playing 房间增加内存回收计时器。`plan/03 §6.1` 规定的“playing 全员离线超过 24 小时回收”必须与 M4 的 JSON 存档和启动恢复一起实现；否则 M1 仅删除内存房间会造成“看似回收、实际丢局”。在 M4 落地前，playing 房间保留在当前 server 进程内，server 重启后自然消失，且不得宣称具备对局持久化或 24 小时回收能力。

## 6. 协议与错误

### 6.1 M1 客户端事件

- `room:create`
- `room:join`
- `session:resume`
- `room:add_bot`
- `room:remove_bot`
- `room:start`
- `room:leave`

### 6.2 M1 服务端事件

- `room:state`
- `player:connection`
- `room:closed`

### 6.3 M1 不实现的事件

- `game:intent`
- `game:events`
- `game:snapshot`
- `room:skip_offline_turn`

`room:skip_offline_turn` 依赖 M2 的 `GameState` 与自动 intent 驱动。M1 不提供假成功或永久失败的占位 handler；此偏差记录在 `plan/05`，M2 必须实现。

### 6.4 M1 错误码

M1 可返回：

- `ROOM_NOT_FOUND`
- `ROOM_FULL`
- `GAME_ALREADY_STARTED`
- `NICKNAME_TAKEN`
- `INVALID_TOKEN`
- `NOT_HOST`
- `INVALID_NICKNAME`
- `NOT_ENOUGH_PLAYERS`
- `INVALID_ROOM_ACTION`

`INVALID_ROOM_ACTION` 只用于移除目标不存在、目标不是 bot 等没有更精确既有错误码的房间参数错误，不得替代 `GAME_ALREADY_STARTED`、`NOT_HOST` 或 `NOT_ENOUGH_PLAYERS`。

所有失败 ack 使用：

```ts
{
  ok: false;
  code: RoomErrorCode;
  message: string;
}
```

未知内部异常不得原样返回客户端。

## 7. `pnpm party`

M1 必须提供根命令：

```bash
pnpm party
```

执行流程：

1. 构建 client 和 server；
2. 启动生产 server，默认端口 `3000`；
3. 探测可用的非 internal IPv4；
4. 打印 localhost 地址；
5. 找到局域网地址时打印 `http://<LAN-IP>:3000` 和终端二维码；
6. 未找到局域网地址时保留 localhost 服务并输出清晰提示。

IP 选择和输出内容由纯函数负责并单测；进程启动只负责调用这些函数。终端二维码使用一个小型、维护中的 Node 包，不自行实现二维码算法。M3 再实现页面内的邀请链接和二维码按钮。

## 8. 文件职责

计划中的职责边界：

```text
apps/server/src/
├── index.ts                 # 进程入口、环境配置、启动/关闭
├── server.ts                # 创建 HTTP + Socket.IO server，静态托管
├── protocol.ts              # M1 事件、ack、公开 payload 类型
├── rooms/
│   ├── roomManager.ts       # 房间规则与状态转换
│   ├── roomTypes.ts         # 私有 Room 类型和依赖接口
│   └── roomErrors.ts        # 错误码与安全中文消息
└── party/
    └── networkAddress.ts    # 局域网地址选择与展示数据

apps/server/src/__tests__/
├── roomManager.test.ts
├── socketRooms.test.ts
└── networkAddress.test.ts

scripts/
└── party.ts                 # build 后启动 server、打印地址和二维码
```

具体文件可在实施计划中按现有构建约束微调，但职责不得重新混合。

## 9. TDD 与验证

### 9.1 RoomManager 单元测试

先写失败测试，再写最小实现。覆盖：

- 四位、补零房间码；
- 房间码碰撞重试及重试上限；
- 创建与加入；
- 稳定玩家顺序；
- 空昵称、超长昵称、重名；
- 满房；
- bot 命名跳过冲突；
- 非房主添加或移除 bot；
- 移除非 bot 或不存在目标；
- 开始人数不足；
- 房主 + bot 可以进入 playing；
- 重复开始；
- lobby 主动离开和房主移交；
- lobby 被动断线、5 分钟内 resume、超时移除；
- playing 离开保留座位；
- playing 房主断线后移交；
- 无在线真人时首位 resume 获得房主；
- token 正确恢复、错误 token 拒绝；
- 公开状态不含 token；
- 每个 M1 错误码至少一个测试。

### 9.2 Socket.IO 集成测试

使用真实临时 HTTP 端口和 `socket.io-client`：

1. A 创建、B 加入，两端收到一致的 `room:state`；
2. 非房主操作返回 `NOT_HOST`；
3. 房主添加 bot 并开始，所有端收到 `status:'playing'`；
4. disconnect 广播 `player:connection online:false`；
5. resume 广播 `online:true` 并恢复相同身份；
6. 新 socket 取代旧 socket，旧 disconnect 不覆盖新连接；
7. 所有 ack 和广播都不泄漏 token。

### 9.3 party 测试

纯函数测试：

- 排除 internal、loopback 和非 IPv4 地址；
- 从多个网卡中稳定选择局域网 IPv4；
- 没有 LAN IP 时返回明确的 localhost-only 结果；
- URL 保留配置端口。

### 9.4 M1 完成验证

```bash
pnpm test
pnpm typecheck
pnpm validate-data
pnpm build
pnpm --filter @richman/server build
```

另进行手动 smoke：

- 启动生产单端口 server；
- 确认 client 静态页面可访问；
- 用两个真实 Socket.IO 客户端完成创建、加入、添加 bot、开始、断线、resume；
- 运行 `pnpm party`，确认终端输出地址和二维码。

## 10. 计划文档同步

实施中同步：

- `plan/03-架构与联机协议.md`：记录 create ack 增加 `room`；所有 room/session 失败 ack 增加 `message` 字段；新增错误码；lobby 5 分钟断线保留；playing 房主离线移交；`room:closed` reason 枚举。`room:remove_bot` 与 `room:closed` 已分别存在于 §5.1、§5.2，无需重复补表；
- `plan/05-阶段2-联机版.md`：记录 `room:skip_offline_turn` 延至 M2；playing 房间的全员离线 24 小时回收随 M4 存档机制实现。
- `README.md`：M1 完成并验证后才更新阶段 2 进度。

## 11. 评审结论

本设计吸收了两次独立 review：

- 架构/协议 review：总体结构可用，要求补齐连接事件、lobby disconnect、party 脚本、错误码和每码测试；
- designer UX-contract review：要求解决 playing 房主离线死局、稳定玩家顺序、start 跳转信号和在线状态权威来源。

修订后，M1 保持服务器与房间系统边界，不提前实现 M2–M5，同时为后续大厅、断线提示、房主托管和邀请体验提供确定协议。