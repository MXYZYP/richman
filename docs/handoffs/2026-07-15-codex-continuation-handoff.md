# Richman — Codex 完整工程接管与长期维护手册

**日期：** 2026-07-15
**接手对象：** Codex（后续 bug 维护、新功能、测试、UI、联机、部署的长期 owner）
**文档性质：** 当前对话与待办续接 + 全仓库架构 atlas + 维护/扩展/验证/发布 SOP。
**最重要结论：** 当前业务基线已完成本地热座与联机可玩链路；工作区只有 6 份未跟踪文档，没有半成品业务代码。多地图、浏览器本机两槽断点续玩、bot 主动赎回尚未实现。本文不是只服务这三项任务，而是后续整个 Richman 项目的主交接入口。

---

## 0. 接手后先做什么

必须在下面这个 worktree 工作：

```text
/Users/admin/Documents/Richman/.worktrees/m3-client-online
```

不要在主目录 `/Users/admin/Documents/Richman` 开发，也不要回到旧的 `m3-1-static-board-ui` worktree。

先运行：

```bash
cd /Users/admin/Documents/Richman/.worktrees/m3-client-online
git status --short --branch
git log --oneline -12
pnpm test
pnpm typecheck
pnpm validate-data
pnpm --filter @richman/client build
```

说明：生成本交接文档时只重新核对了 git 状态和提交记录，没有重新跑测试。最近一次完整测试证据见本文第 8 节。

---

## 1. 当前仓库与 Git 状态

### 1.1 路径与分支

- 主仓库：`/Users/admin/Documents/Richman`
- 当前实现 worktree：`/Users/admin/Documents/Richman/.worktrees/m3-client-online`
- 当前分支：`m3-client-online`
- 当前 HEAD：`fb5d9c1 M3 gameplay feedback and mobile layout`

最近提交（已在本次交接时重新读取）：

```text
fb5d9c1 M3 gameplay feedback and mobile layout
5e0dd56 feat: complete local play assets and automation
9835e3c test(client): verify M3 online play flow
c7bbdef fix(client): preserve retryable recovery state
4f72b64 fix(client): meet game touch target sizes
b675a7b fix(client): harden shared game recovery
974c812 feat(client): share game UI across local and online sessions
9180a6e fix(client): harden live room lobby
abec081 feat(client): add live room lobby
485a7b8 fix(client): respect deferred room recovery
2bfd5b5 fix(client): harden online entry flow
260ad4d feat(client): add online entry and restore flow
```

### 1.2 未提交内容

生成本交接前：

- staged：0
- unstaged：0
- untracked：5

未跟踪文件：

```text
docs/superpowers/plans/2026-07-15-bot-redeem-strategy.md
docs/superpowers/plans/2026-07-15-local-game-resume.md
docs/superpowers/plans/2026-07-15-multi-map-modularization.md
docs/superpowers/specs/2026-07-15-local-game-resume-design.md
docs/superpowers/specs/2026-07-15-multi-map-modularization-design.md
```

本交接文件创建后会成为第 6 个 untracked 文件：

```text
docs/handoffs/2026-07-15-codex-continuation-handoff.md
```

这些文档都不是业务代码，不存在半完成的实现。不要假设已经有任何 `MapPack`、`MapRef`、本机存档或 bot 赎回代码。

**不要自动 commit、push、开 PR。** 当前用户只要求交接，并未明确授权这些 Git 操作。用户后续若明确要求执行并提交，再按要求处理。

---

## 2. 对话与项目推进时间线

### 2.1 最初交接：M2 / M3-1 / M3-1.5

用户最初要求阅读 3 份旧交接文档。它们不在主目录，而在旧 worktree：

```text
/Users/admin/Documents/Richman/.worktrees/m3-1-static-board-ui/docs/handoffs/2026-07-06-richman-current-state-handoff.md
/Users/admin/Documents/Richman/.worktrees/m3-1-static-board-ui/docs/handoffs/2026-07-06-m3-1-5-implementation-brief.md
/Users/admin/Documents/Richman/.worktrees/m3-1-static-board-ui/docs/handoffs/2026-07-06-verification-and-agent-log.md
```

旧交接当时说明：

- M2 规则引擎已完成；
- M3-1 静态棋盘 UI 已完成；
- M3-1.5 当时只有棋盘美化设计；
- 视觉验证必须基于真实 app 和真实浏览器截图；
- 不要依赖旧的 visual companion mockup；
- 不要随意改变 `boardLayout.ts` 坐标语义；
- 390 × 844 手机端短名和可读性是硬要求。

这些内容是历史背景。当前真正应开发的是 `m3-client-online` worktree；该分支已经远远超过旧的 M3-1 状态。

### 2.2 `m3-client-online` 已完成内容

当前分支已经完成并提交：

- 本地热座与联机游戏共享 UI；
- 联机房间创建、加入、邀请、开始、断线恢复；
- 房主、机器人、离线托管相关流程；
- 可玩的完整回合、掷骰、移动、购买、盖房、抵押、赎回、破产、结算；
- 玩家资产弹窗；
- bot 自动行动与防无限循环；
- 手机聚焦棋盘；
- 过路费与现金变化反馈；
- 最近一轮手机玩家栏布局修复。

最新提交 `fb5d9c1` 的可观察结果包括：

- 手机端玩家卡片保持单行水平排列；
- 390 px 四人局的卡片尺寸约为 92 × 72；
- 玩家名在窄屏使用省略，不再撑高卡片；
- `BOT`、离线、破产 badge 可同时存在且不裁切；
- 现金变化提示使用玩家卡下方固定轨道，不再把棋盘向下顶；
- 修复 320 px / 390 px 的布局溢出问题。

当时已做真实浏览器验证，含 1440 × 900、390 × 844、320 × 700。公开预览曾通过临时 ngrok 地址开放：

```text
https://serrated-majority-anatomist.ngrok-free.dev
```

这是临时地址，不应假设现在仍有效，也不应作为后续验证依据。

### 2.3 后续产品方向：多地图模块化

用户确认“中国之旅”现阶段可以先告一段落，下一步希望兑现前期“模块化”目标：后续可增加新地图和少量新机制，但主体仍是一款相同的大富翁游戏，而不是每张地图变成另一套完全不同的游戏。

经过逐项产品确认，形成并批准了：

```text
docs/superpowers/specs/2026-07-15-multi-map-modularization-design.md
```

随后写了实施计划：

```text
docs/superpowers/plans/2026-07-15-multi-map-modularization.md
```

### 2.4 “历史回溯”澄清为单机断点续玩

用户提出希望扩展“单机历史回溯”。对话中明确排除了回放、逐回合历史、回滚和从旧回合重开。真正需求是：

- 单机热座局关闭页面、刷新、浏览器进程丢失后仍能恢复；
- 首页最多显示最近两局未完成单机；
- 可以继续、删除；
- 第三局必须明确确认替换最旧存档。

批准设计：

```text
docs/superpowers/specs/2026-07-15-local-game-resume-design.md
```

实施计划：

```text
docs/superpowers/plans/2026-07-15-local-game-resume.md
```

此功能依赖多地图设计 Phase 2：`GameState` 必须已有精确 `mapRef`。

### 2.5 电脑玩家抵押后不会主动赎回

对话检查了当前引擎：

- `packages/engine/src/bot.ts` 的债务分支会按顺序卖房、抵押、卖地；
- 无债务 `managing` 阶段当前直接返回 `end_turn`；
- 因此 bot 抵押后不会主动赎回，除非规则外部触发（目前没有）。

用户定案：

> 电脑玩家赎回后至少保留 ¥1,000；符合条件时，按赎回后过路费从高到低优先赎回。

实施计划：

```text
docs/superpowers/plans/2026-07-15-bot-redeem-strategy.md
```

### 2.6 用户选择的执行方式

用户在两个执行方案中选择：

> 方案 1：Subagent-Driven Development

预定流程是：

1. 每个任务使用 fresh implementer subagent；
2. 每个任务先做 spec compliance review；
3. spec 通过后再做 code quality review；
4. 任一 reviewer 有问题，必须由 implementer 修复并重新审查；
5. 全部任务完成后做 final review；
6. 使用真实命令与真实浏览器验证。

对话在实际派出第一个 implementer 之前变得不稳定。这里只加载了 `subagent-driven-development` 和 `using-git-worktrees` skill，并读取了 bot 计划；**没有 subagent 被派出，没有测试被新增，没有业务代码被修改。**

---

## 3. 已确认的产品与技术决策

### 3.1 多地图模块化

批准设计文档是唯一权威来源。核心决策：

1. **继续使用现有项目。** 不为新地图另建项目，不复制 engine/server/client。
2. **中国之旅成为第一张版本化地图：** `china-tour@1`。
3. **地图使用精确不可变身份：**

   ```ts
   interface MapRef {
     id: string;
     version: number;
     contentHash: string;
   }
   ```

4. `contentHash` 覆盖 manifest、游戏数据和 presentation；排除 `contentHash` 字段自身；所有环境使用同一 canonical serialization。
5. 新游戏使用 active 版本；恢复和重连必须按精确 `MapRef`，不能自动替换为最新版本。
6. 每张地图都在正方形棋盘容器中渲染，但不要求 14 × 14。
7. cell 数量、坐标、路径形状、分支数量都属于地图数据。地图可以没有分支，也可以有多个分支。
8. 每张地图必须且只能有一个起点，起点 cell ID 固定为 `0`。
9. renderer 不再理解“外环 ID 0–51 / 支线 ID 52–60”；所有 cell 使用同一 data-driven placement 集合。
10. 地图只提供 allowlisted presentation：坐标、颜色 token、内置图标、包内本地素材、受控装饰；禁止任意 CSS、JavaScript、远程图片、网络字体。
11. 地图不能携带可执行代码。可声明 app 已编译、已审核的 `RuleModuleRef`。中国之旅只启用 `core@1`。
12. module handler 冲突必须在 registry 构建时失败；可组合 hook 按稳定 `module id + version` 排序，不能依赖 import 顺序。
13. `GameState` 增加精确 `mapRef` 和启用的 rule modules，同时继续持有完整 immutable `board/cards/config`，保证 `applyIntent` 自包含、可复现。
14. 新建在线房间只发送 `mapId`；server 选择 active `MapRef` 并在 room 创建时锁定。加入者继承房间地图，不能选择或中途切换。
15. 只有一张 active map 时，地图选择器隐藏；多张 active map 时自动显示。
16. `PublicRoomState` 包含安全地图摘要。
17. `PublicGameSnapshot` 不再通过 `Omit<GameState, ...>` 自动派生，也不能 spread 整个内部 state；必须逐字段公开，避免以后新增内部字段时自动泄露。
18. client 收到公开 runtime snapshot 后，用精确 `mapRef` 解析本地 map pack；缺少版本或 hash 不同必须显示兼容性错误，绝不回退到中国之旅或最新版本。
19. 必须有一张永久 test-only map：不同 cell 数量、非中国名称、不同 square layout、无分支、非连续非起点 ID；它不能出现在玩家 catalog。
20. 不做地图编辑器、运行时上传、第三方插件、推测性的传送门/监狱等机制，也不重做中国之旅视觉或规则。

完整 acceptance criteria 在设计文档 §14，共 13 条，不能缩减。

### 3.2 单机断点续玩

批准设计文档是唯一权威来源。核心决策：

1. 只针对 browser-local 热座局；在线恢复继续使用 server room + credential，现有 restore/defer/retry/abandon/reconnect 行为不变。
2. 首页显示 `继续单机`，最多两张卡，按 `updatedAt` 降序。
3. 每张有效卡显示地图名、玩家昵称和 BOT 标识、回合、保存时间、继续、删除。
4. 删除需要二次确认；删除一个本机存档不能碰另一个存档或在线恢复 key。
5. invalid / incompatible slot 不能静默删除，必须以 `无法恢复的本机存档` 留在首页并允许确认删除。
6. 两个固定 `localStorage` key：

   ```text
   richman_local_game_1
   richman_local_game_2
   ```

7. save envelope：`schemaVersion/gameId/createdAt/updatedAt/revision/state`；summary 必须由验证后的 state 派生，不重复存储。
8. 第一、第二局使用空 slot；第三局开始前，in-app confirmation 明确显示将替换的最旧存档。取消时不能改变旧存档、不能创建新 session、setup 表单保持不变。
9. 单机局退出文案改为 `保存并返回首页`。
10. `game_over` 后不占 resume slot；不保存已完成比赛历史。
11. resume 恢复精确 authoritative `GameState`；不生成新 seed、不重洗牌、不重置回合、不替换地图、不生成新 gameId，也不重放旧动画。
12. 每次 human 或 bot intent：先纯 `applyIntent`，再保存 proposed next state，保存成功后才更新内存 authoritative state、播放动画、安排下一 bot。
13. 持久局保存失败时，本次 transition 不能发布或播放，提示 `保存失败，本次操作未执行`，保证磁盘和内存仍一致。
14. 初始 storage 不可用时，用户可重试，或明确选择 temporary unsaved game；不能把临时局标成已保存。
15. local storage 是不可信输入，必须做真实 hydration validation，不能用 TypeScript assertion 冒充验证。
16. exact map resolution 使用 `getMapPack(state.mapRef)`，不能用 active/latest 代替。
17. 多 tab 使用 `gameId + revision` optimistic concurrency；storage event 发现 slot 被另一 tab 改动后，旧 tab 必须停止接受动作。
18. 错误文案与 online error state 分离，不能互相覆盖。
19. 完整 acceptance criteria 在设计文档 §12，共 8 条，不能缩减。

### 3.3 Bot 赎回

当前确认的产品规则只有两条：

1. 在无债务的 `managing` 阶段，bot 可以主动赎回自己已抵押的地产；
2. 赎回后现金必须 `>= ¥1,000`，候选按“赎回后过路费”从高到低。

赎回必须复用 engine 的真实 `redeem_property` intent 和现有赎回价格规则：

```ts
Math.round(mortgageValue * (1 + mortgageInterestRate))
```

不能绕过 `applyIntent` 直接改 state。

---

## 4. 现有实现结构与关键文件

### 4.1 Board data

```text
packages/board-data/data/board.json
packages/board-data/data/cards.json
packages/board-data/data/game-config.json
packages/board-data/src/types.ts
packages/board-data/src/index.ts
packages/board-data/src/validate.ts
```

当前仍通过全局 `boardData/cardsData/gameConfig` 导出，且 `validate.ts` 同时混有通用结构检查和中国之旅专属源材料对照。

### 4.2 Engine

```text
packages/engine/src/types.ts
packages/engine/src/engine.ts
packages/engine/src/movement.ts
packages/engine/src/effects.ts
packages/engine/src/selectors.ts
packages/engine/src/bot.ts
packages/engine/src/simulate.ts
packages/engine/src/__tests__/
```

关键现状：

- `GameState` 内含 `board/cards/config/seed/decks/runtime state`，但还没有 `mapRef` 和 rule modules；
- movement 是 board graph 驱动：显式 `nextId` 优先，否则数组下一格；
- airport branch 通过 `branchEntryId`；
- `getCurrentRent` 在 `selectors.ts`；
- `handleRedeemProperty` 已存在，价格是 mortgage value 加配置利率；
- bot 的 debt handling 会卖房、抵押、卖地；无债务 `managing` 仍直接 `end_turn`。

### 4.3 Protocol / server

```text
packages/protocol/src/index.ts
apps/server/src/publicGameSnapshot.ts
apps/server/src/rooms/roomTypes.ts
apps/server/src/rooms/roomManager.ts
apps/server/src/__tests__/
```

关键现状：

- `Room` 当前没有 map identity；
- `room:create` 当前没有 `mapId`；
- `PublicGameSnapshot` 当前从 `GameState` 派生；
- `toPublicGameSnapshot` 当前通过排除 `seed/decks` 再 spread，正是模块化设计要求消除的泄露风险。

### 4.4 Client

```text
apps/client/src/App.vue
apps/client/src/views/HomeView.vue
apps/client/src/views/GameView.vue
apps/client/src/components/GameSetup.vue
apps/client/src/components/GameBoard.vue
apps/client/src/components/BoardCell.vue
apps/client/src/components/FocusedBoard.vue
apps/client/src/components/PlayerRail.vue
apps/client/src/session/gamePresenter.ts
apps/client/src/session/localSession.ts
apps/client/src/session/onlineSession.ts
apps/client/src/session/sessionStorage.ts
apps/client/src/session/gameSession.ts
apps/client/src/ui/boardLayout.ts
```

关键现状：

- `localSession.ts` 只有内存局，没有本机持久化；
- browser storage 目前主要保存在线 room/session 身份；
- `GameBoard.vue` / `boardLayout.ts` 仍包含中国之旅固定 14 × 14、外环/支线、短名、图标、property bands 等假设；
- 现有移动端 full-board / focused-board 两种视图必须保留；
- `PlayerRail.vue` 最近经过严格 390/320 px 修复，不要在模块化或存档任务中顺手重构。

---

## 5. 文档优先级与已知计划问题

### 5.1 优先级

发生冲突时按以下顺序：

1. 用户已确认的产品行为；
2. `docs/superpowers/specs/*-design.md`；
3. 当前代码和测试的既有行为；
4. `docs/superpowers/plans/*.md`。

设计文档已逐段确认并标记 `Approved for implementation planning`。三份 plan 是刚生成的第一版执行草案，未经过 independent review，不能不加判断地逐字照抄。

### 5.2 多地图 plan 与批准 spec 的不一致

`2026-07-15-multi-map-modularization.md` 至少有这些需要先修正的问题：

1. **`MapRef` 字段名错误。** 批准 spec 使用 `id`，plan 示例用了 `mapId`。以 spec 的 `id` 为准。
2. **`MapPack` shape 不一致。** 批准 spec：

   ```ts
   interface MapPack {
     ref: MapRef;
     metadata: { title: string; description: string };
     game: {
       board: BoardData;
       cards: CardsData;
       config: GameConfig;
       requiredRuleModules: readonly RuleModuleRef[];
     };
     presentation: MapPresentation;
   }
   ```

   plan 草案却把 `board/cards/config/ruleModules` 放在顶层并添加了未确认的 `minPlayers/maxPlayers`。必须按批准 spec 重写任务契约，不要形成第二套 shape。
3. `RuleModuleRef` 同样应使用 spec 的 `id/version`，不是另造 `moduleId` convention。
4. plan 没有完整覆盖 spec 对 invalid map、module conflict、explicit snapshot、safe map summary、test-only map 全链路等全部 acceptance criteria。实施前应做 plan-to-spec checklist。
5. content hash 不能直接把 Node `crypto` 依赖带进 browser bundle。应设计一个跨 validation/runtime 一致且不会破坏 Vite browser build 的方案；不要先实现再补救。
6. 不能为了“兼容迁移”长期保留全局 `boardData/cardsData/gameConfig` 第二套 convention。允许阶段内短暂存在，但 Phase 5 必须 clean cutover，无 alias/shim。

### 5.3 Local resume plan 的遗漏

`2026-07-15-local-game-resume.md` 至少有这些需要修正：

1. 批准 spec 要求 invalid/incompatible slot 在首页可见；plan 的 `LocalSaveSummary` 和 `App.vue` 任务只描述 valid summaries，UI contract 不完整。
2. hydration 必须验证 exact map pack、immutable snapshot、rule modules、所有 runtime 引用；不能只做浅层字段检查。
3. `game_over` 删除失败时，首页 reader 仍应把它视为 non-resumable，并显示 cleanup failure；plan 没完整描述这个行为。
4. create/restore/commit API 必须适配现有 `LocalSession`、presenter、bot automation 的真实异步时序。先读完整文件和测试，再确定接口，不要只粘贴 plan 伪代码。
5. 存档功能依赖 map modularization Phase 2，不能提前硬编码一个临时 map identity，之后再迁移。

### 5.4 Bot plan 的测试与性能问题

`2026-07-15-bot-redeem-strategy.md` 至少有这些需要修正：

1. plan 中“找不到相同 rent 的 fixture 就直接 `return` 跳过测试”不可接受。测试必须确定性执行，不能静默 pass。
2. plan 用“为每个候选复制整个 `GameState` + properties，再调用 `getCurrentRent`”计算 projected rent，存在不必要分配。应复用/扩展一个纯 selector，直接计算假设解除抵押后的 rent，避免每个候选复制 state。
3. utility rent 依赖 dice。当前 `getCurrentRent` 默认用 `state.lastDice`，如果为 null，所谓“赎回后过路费”可能为 0。实现前必须在测试中明确 deterministic 排序语义；不要让它偶然依赖上一位玩家的骰子。若要改变用户可见策略，应向用户解释“水电公司过路费依赖骰点”的后果再定案。
4. tie-break 可以采用 rent 降序、赎回价升序、cell ID 升序作为确定性实现细节，但主要规则必须仍是现金底线和 rent 优先。

---

## 6. 推荐执行顺序

用户已经选择 Subagent-Driven Development。建议按下面顺序，不要同时让多个 implementer 修改同一 worktree。

### 第一段：Bot 赎回（最小、独立）

1. 先修订 bot plan 的上述问题；
2. fresh implementer 按 TDD 写失败测试；
3. 实现最小策略；
4. focused bot tests；
5. engine suite + 500 局 simulation；
6. spec reviewer；
7. code-quality reviewer；
8. 修复并复审至无 Critical/Important。

### 第二段：多地图 Phase 1–2

1. 以批准 spec 重建准确的 task contract；
2. Phase 1：map types、registry、hash、China Tour pack、generic vs China validation、test-only map；
3. Phase 2：`GameState.mapRef`、rule module registry、`core@1`、determinism tests；
4. 每个 task 都做 TDD + spec review + quality review；
5. Phase 2 完成后，单机续玩才有合法依赖。

### 第三段：多地图 Phase 3–5

- protocol/server room map locking；
- explicit public snapshot；
- client exact pack composition；
- data-driven board presentation；
- clean cutover；
- test-only map 贯穿 engine/server/protocol/client；
- 真实桌面/手机浏览器验证。

### 第四段：单机断点续玩

虽然设计上只依赖 map Phase 2，但它与 map Phase 4 都会修改 `App.vue`、`GameSetup.vue`、`GameView.vue` 和 client session。单一 worktree 下建议在 map clean cutover 后执行，避免 subagent 冲突。若真要并行，必须使用单独 worktree，并明确最后集成策略。

---

## 7. Subagent 执行约束

用户选择方案 1 后，应该严格执行：

- 不是“一名 subagent 包办全部”；每个独立 task 使用 fresh implementer；
- 不并行派出会修改相同文件的 implementer；
- 给 subagent 完整 target/change/acceptance，不让它自己去猜对话；
- implementer 必须先读与任务直接相关的当前代码、现有测试和批准 spec；
- 使用 TDD：先看到新测试因缺少行为而失败，再实现；
- 每 task 先 spec reviewer，批准后才允许 quality reviewer；
- reviewer 发现问题必须修复并 re-review；
- 不用 implementer 的 self-review 代替两阶段独立 review；
- 不让 subagent 跑 formatter、project-wide test；controller 在最终统一运行；
- final reviewer 覆盖整项实现；
- 无用户明确要求，不 commit、不 push、不开 PR。

---

## 8. 验证证据与当前基线

### 8.1 最近一次已观察的完整验证

在提交 `fb5d9c1` 前后的当前分支， prior session 实际观察到：

- `pnpm test`：45 test files / 715 tests passed；
- `pnpm typecheck`：passed；
- `pnpm --filter @richman/client build`：passed；
- 真实浏览器 1440 × 900、390 × 844、320 × 700 验证通过；
- 手机玩家栏 3 人、4 人、BOT/离线/破产 badge 和现金提示均做过 DOM 尺寸检查与截图检查。

这些是历史证据，不是本交接生成时重跑的结果。接手后必须重新跑 baseline，避免把环境或依赖变化误当成新实现问题。

### 8.2 项目命令

根 `package.json`：

```text
pnpm dev
pnpm build
pnpm test
pnpm validate-data
pnpm typecheck
pnpm --filter @richman/client build
pnpm --filter @richman/engine simulate:500
```

项目使用：

- pnpm `10.33.2`
- Node `>=20`
- TypeScript
- Vitest
- Vue 3 + Vite
- Socket.IO

### 8.3 验证原则

- Bug fix：先复现，再修复，再用同一场景确认不再出现；
- permanent feature：focused contract tests + full suite；
- UI：代码检查不够，必须真实浏览器；
- 多地图：必须用 China Tour 和 test-only map 两条链路；
- 手机：必须至少 390 × 844；对玩家栏或窄屏变更继续检查 320 × 700；
- 不使用假的 mockup 代替真实 app；
- 不只跑 build 就宣称 UI 通过。

---

## 9. 明确禁止事项

1. 不在主目录或旧 `m3-1-static-board-ui` worktree 实现。
2. 不把 plan 草案当成比批准 spec 更高的权威。
3. 不创建第二个项目或复制 engine/server/client。
4. 不实现运行时 JavaScript/CSS/plugin 上传。
5. 不预做未确认的监狱、传送门、portal 等机制。
6. 不改变中国之旅现有规则值、地图数据、卡牌或视觉，除非模块化迁移为纯等价搬运。
7. 不在 shared client 中按 China cell ID/name 特判 test-only map。
8. 不让 map presentation 注入任意 CSS、远程图、网络字体。
9. 不让 `PublicGameSnapshot` spread 内部 `GameState`。
10. 不让 exact map restore 回退到 active/latest 或中国之旅。
11. 不静默删除 incompatible/corrupt local save。
12. 不让 local save 修改现有 online recovery key 或流程。
13. 不在保存失败时先播放动画再报告失败。
14. 不让两名 implementer 同时改同一 worktree 的相同文件。
15. 不依赖曾经的 ngrok 地址或旧 visual companion。
16. 不自动 commit、push、开 PR。

---

## 10. 用户沟通偏好

- 默认用简体中文沟通；技术词可保留 English；
- 用户是产品与规则 owner，不是实现 owner；
- 不要求用户读 diff、判断 TypeScript 或选择架构；
- 需要确认时，只问产品行为、UX、数据、安全、兼容性等会影响结果的问题；
- 实现细节由 Codex 负责选择，并用用户能判断的结果描述；
- 不要无必要反复确认；repo、测试、工具能查到的不要问用户；
- 每次交付必须说明：用户可观察到的变化、涉及文件、实际运行的验证、任何未验证事项；
- 不说“应该可以”，没有运行过就明确标为未验证；
- 视觉任务优先真实浏览器截图与 DOM 检查。

---

## 11. 给 Codex 的推荐启动指令

可以直接按下面理解并开始：

> 在 `/Users/admin/Documents/Richman/.worktrees/m3-client-online` 接手。先读本交接和两份批准 spec。把 3 份 plan 当草案，先修复本文第 5 节列出的 plan/spec 不一致。用户已选择 Subagent-Driven Development。先做独立的 bot 主动赎回：TDD、focused test、engine suite、500 局 simulation、spec review、quality review。不要 commit。然后按批准 spec 做多地图 Phase 1–2；完成 `GameState.mapRef` 后继续 Phase 3–5，最后做本机两槽断点续玩。任何任务都不能用局部测试代替最终 full suite 和真实浏览器验证。

---

## 12. 最终状态声明

截至本交接写入时：

- 当前业务代码停在已提交的 `fb5d9c1`；
- 当前工作区没有 staged/unstaged 业务代码；
- 只有 5 份新增设计/计划文档，以及本交接文件，均未跟踪；
- 多地图、单机断点续玩、bot 主动赎回都尚未实现；
- 用户已经批准进入方案 1（Subagent-Driven Development）；
- 实际执行尚未派出任何 implementer；
- 接手者可以从干净业务基线开始，不需要清理半成品代码。

---

## 13. 本文的长期接管范围

前 12 节保留了本次对话、当前 backlog、已批准设计和紧接着要做的工作。本节以后补齐长期维护所需的全局工程知识。

Codex 后续负责的范围包括：

- 规则 bug、棋盘数据 bug、卡牌 bug；
- bot 策略和仿真；
- 本地热座、在线房间、断线恢复、离线托管；
- 客户端页面、游戏 UI、移动端、可访问性、视觉回归；
- Socket.IO 协议、服务端房间生命周期、公开快照和安全边界；
- 数据 schema、存档兼容、地图版本和未来模块化；
- focused tests、full suite、类型检查、数据校验、build、生产 smoke、真实浏览器验收；
- 局域网聚会模式、云部署、运行故障定位；
- 设计文档、实施计划、README 进度与代码事实的同步。

本文不把每一行实现复制进文档。长期维护的原则是：

1. 先用本文定位责任边界和入口；
2. 再读取任务相关的 production file、直接测试和批准 spec；
3. 以本次运行的代码和测试为事实，不以过时进度表代替代码；
4. 修改 exported symbol 前用 LSP 查 references；
5. 行为改变必须有可观察验证，UI 改动必须看真实页面。

---

## 14. 项目全景与仓库 Atlas

### 14.1 产品边界

这是实体桌游《大富翁·中国之旅》的浏览器实现：

- 2D 棋盘；
- 2–4 个座位；
- 本地热座可由 1 个真人加 bot 开局；
- 在线使用 4 位房间码，无账号系统，昵称是显示身份；
- 客户端和服务端共享同一纯函数规则引擎；
- 当前只服务亲友内部游玩，不按公网站点的敌对安全模型设计；
- 当前没有数据库、Redis、账号、支付、遥测或第三方地图上传。

### 14.2 Monorepo 结构

```text
Richman/
├── apps/
│   ├── client/          Vue 3 + Vite 浏览器客户端
│   └── server/          Node + Socket.IO 权威房间服务器
├── packages/
│   ├── board-data/      棋盘、卡牌、配置 JSON 与校验器
│   ├── engine/          纯函数、确定性规则引擎与 bot
│   └── protocol/        Client/Server Socket.IO 类型契约
├── scripts/
│   ├── party.ts         聚会模式启动与局域网二维码
│   └── smoke-production.ts
├── raw/                 实体桌游转录原始材料
├── plan/                产品、规则、数据、架构、阶段计划
├── docs/superpowers/
│   ├── specs/           已确认设计及历史设计
│   └── plans/           实施计划及历史计划
└── plan/assets/screenshots/
    ├── phase1/
    └── phase2/
```

当前统计：

- 5 个 workspace package/app；
- 45 个 Vitest 文件：engine 19、server 11、client 15；
- 21 份 design spec；
- 27 份 implementation plan；
- 33 张真实浏览器验收截图。

### 14.3 包依赖方向

```mermaid
flowchart TD
  Raw[raw/*.md] --> Data[@richman/board-data]
  Data --> Engine[@richman/engine]
  Engine --> Protocol[@richman/protocol]
  Data --> Client[@richman/client]
  Engine --> Client
  Protocol --> Client
  Data --> Server[@richman/server]
  Engine --> Server
  Protocol --> Server
  ClientBuild[apps/client/dist] --> Server
```

约束：

- `board-data` 不依赖 engine/client/server；
- engine 只依赖 `board-data`，不能引入 DOM、网络、文件 IO；
- protocol 依赖 engine 的公开类型；
- client 和 server 可以依赖三个 package；
- UI 不直接修改规则 state；
- server 不复制规则逻辑，所有合法性仍通过 engine；
- 未来多地图不得复制整套 engine/server/client。

### 14.4 系统入口

| 入口 | 文件 | 职责 |
|---|---|---|
| 浏览器 bootstrap | `apps/client/src/main.ts` | 创建 Vue app、Pinia、加载全局 CSS |
| App shell | `apps/client/src/App.vue` | 唯一在线 session、本地 session、页面路由 |
| 服务端进程 | `apps/server/src/index.ts` | 启动 production server、处理退出信号 |
| 生产 server 工厂 | `apps/server/src/production.ts` | 端口、token、UUID、静态目录、自动化延迟 |
| HTTP + Socket.IO | `apps/server/src/server.ts` | 同端口静态托管和 WebSocket |
| 规则入口 | `packages/engine/src/index.ts` | 导出 createGame/applyIntent/selectors/bot |
| 数据入口 | `packages/board-data/src/index.ts` | 导出 board/cards/config 与类型 |
| 协议入口 | `packages/protocol/src/index.ts` | 双向事件、ack、公开快照、SocketData |

---

## 15. 权威来源、文档优先级与漂移处理

### 15.1 行为权威

出现冲突时按以下顺序判断：

1. 用户在当前对话中明确确认的产品行为；
2. 对应的已批准 `docs/superpowers/specs/*-design.md`；
3. 当前 production code + 直接 contract tests；
4. `plan/01` 的既有中国之旅规则；
5. `plan/02` 的数据/视觉规范；
6. `plan/03` 的架构与协议目标；
7. `docs/superpowers/plans/*.md` 执行草案；
8. README 进度表和历史 handoff。

不能只因代码存在就把 bug 当成产品规则；也不能只因旧 plan 写过就覆盖后续用户定案。

### 15.2 当前已确认的文档漂移

1. `README.md` 仍写“下一步 M3 客户端 UI / GameSession 联机改造”，但当前分支已经完成共享 UI、在线 session、真实联机测试和移动端反馈；README 进度过时。
2. `plan/03` 描述了 `apps/server/saves/<roomCode>.json`，但当前 server 没有磁盘持久化；房间和 `gameState` 全在内存。
3. `apps/server/package.json` 的 description 也写“JSON 存档”，这是描述超前，不代表功能存在。
4. `pnpm e2e` 目前只是 echo 占位，不存在 Playwright 自动化套件。
5. `PublicGameSnapshot` 已实现，但仍使用 `Omit<GameState, 'seed' | 'decks'>`；多地图设计要求改为逐字段 allowlist。
6. Client production UI 仍固定中国之旅 61 格、14×14、单机场支线；engine movement 已较数据驱动，但 presentation 尚未模块化。
7. `docs/superpowers/specs` 和 `plans` 中 2026-07-06 至 2026-07-14 的大部分文件是已完成切片的历史设计，不是新的待办。

### 15.3 修改文档的规则

- 规则行为变化：更新 `plan/01` 或对应批准 spec；
- 数据/schema/视觉规范变化：更新 `plan/02`；
- 协议、状态权威、房间生命周期变化：更新 `plan/03`；
- 阶段完成：更新 README 状态；
- 当前一次性执行步骤：写/修 `docs/superpowers/plans`；
- 不为了“看起来整齐”回写所有历史 plan；
- 实现与 spec 有意偏离时，必须记录“原因、用户影响、验证”。

---

## 16. 根配置、命令与运行形态

### 16.1 工具链

- Node：`>=20`
- package manager：`pnpm@10.33.2`
- TypeScript：strict、ES2022、ESNext module、Bundler resolution
- Client：Vue 3、Vite 5、Pinia、Socket.IO client
- Server：Node、Socket.IO、sirv、tsx
- Tests：Vitest 1.6

### 16.2 根命令

| 命令 | 作用 | 重要说明 |
|---|---|---|
| `pnpm dev` | 并行 client/server 开发 | client `:5173`，server `:3000` |
| `pnpm build` | client production build + server typecheck | client 产物在 `apps/client/dist` |
| `pnpm test` | 运行全部 45 个 Vitest 文件 | Node environment |
| `pnpm typecheck` | 所有 workspace `tsc --noEmit` | 不等于 browser smoke |
| `pnpm validate-data` | 运行棋盘/卡牌/config 校验 | 数据变更必跑 |
| `pnpm --filter @richman/engine simulate:500` | 500 局全 bot 仿真 | bot/经济/规则改动必跑 |
| `pnpm start` | 启动 production server | 默认 `PORT=3000` |
| `pnpm party` | build 后启动并打印 LAN URL/二维码 | 同 WiFi 聚会 |
| `pnpm exec tsx scripts/smoke-production.ts` | production HTML smoke | 必须先有 client dist |
| `pnpm e2e` | 当前仅占位 | 不能声称 Playwright 已覆盖 |

### 16.3 开发网络

- Vite：`host: true`、默认 `5173`；
- `/socket.io` 代理到 `http://localhost:3000`，支持 WebSocket；
- production：sirv 静态页面和 Socket.IO 共用一个 HTTP 端口；
- production 默认 `PORT=3000`，无其他必需环境变量；
- 没有 `.env` 模板、数据库、Redis、对象存储或外部 API。

### 16.4 生产启动流

```text
pnpm build
  ├─ vue-tsc --noEmit
  ├─ vite build → apps/client/dist
  └─ server tsc --noEmit

pnpm start
  └─ apps/server/src/index.ts
      └─ startProductionServer()
          └─ createRoomServer()
              ├─ sirv(client/dist, SPA fallback)
              └─ Socket.IO adapter
```

`pnpm dev` 的 server 也使用 production server 工厂。若 `apps/client/dist` 不存在，Socket.IO 可以启动，但 server 根页面可能返回 404；这不是 socket 故障。

---

## 17. Board Data：数据源、Schema 与校验

### 17.1 唯一数据源

```text
packages/board-data/data/board.json
packages/board-data/data/cards.json
packages/board-data/data/game-config.json
```

`packages/board-data/src/types.ts` 定义：

- `CellType`
- `PropertySubtype`
- `CellEffect`
- `Cell`
- `BoardData`
- `Card`
- `CardsData`
- `GameConfig`

`packages/board-data/src/index.ts` 当前导出全局：

- `boardData`
- `cardsData`
- `gameConfig`

多地图 clean cutover 后，这三个全局实例不应继续成为第二套运行时 convention。

### 17.2 中国之旅当前数据

- 61 格；
- 外环 52 格：ID 0–51；
- 环游支线 9 格：ID 52–60；
- 起点 ID 0；
- 41 个 property：normal 35、station 4、utility 2；
- chance 4、destiny 4、airport 1、tax 1、special 2、world 7；
- 机会 15 张、命运 15 张；
- `boardName` 为中国之旅；
- 外环 cell 51 回到 0；
- 支线 cell 60 通过 `nextId` 汇回外环 cell 40。

### 17.3 数据校验

`packages/board-data/src/validate.ts` 直接读取 JSON 和 `raw/*.md`，覆盖：

1. id、type、唯一 start；
2. 地名和资产名对账；
3. price/houseCost/rents/mortgageValue 对账；
4. rents 长度与严格递增；
5. 抵押值比例；
6. 无监狱反向校验；
7. 两类卡牌数量、ID、文本、金额；
8. effect 参数与目标 cell；
9. 外环和支线移动图连通性；
10. config 字段、类型、定案值；
11. 统计输出。

修改 JSON 或 `raw/*.md` 时：

- 不只改 JSON；
- 先确认产品规则；
- 保持 raw、plan/02、JSON、types、validator、engine tests 一致；
- 必跑 `pnpm validate-data`；
- 若影响规则，再跑 engine focused tests、full suite、500 局仿真；
- 若影响格子展示，再做 desktop/mobile 浏览器验证。

---

## 18. Engine：规则核心与不变量

### 18.1 契约

```ts
createGame(input: CreateGameInput): GameState

applyIntent(
  state: GameState,
  playerId: string,
  intent: Intent,
): ApplyResult
```

核心要求：

- 无 IO；
- 无 DOM；
- 无网络；
- 不原地修改输入 state；
- 随机性全部由 `state.seed` 推进；
- 同 seed + 同输入序列得到同结果；
- local 和 server 都复用同一引擎；
- bot 只生成普通 `Intent`，不能绕过规则。

### 18.2 生产文件

| 文件 | 责任 |
|---|---|
| `packages/engine/src/types.ts` | `GameState`、玩家、地产、债务、Intent、Event、ErrorCode |
| `engine.ts` | `createGame`、`applyIntent`、各 intent handler、回合推进 |
| `rng.ts` | seed hash、shuffle、双骰、单骰 |
| `movement.ts` | `getNextCellId`、`walkPath` |
| `effects.ts` | 落点、卡牌/格子 effect、递归效果 |
| `payments.ts` | 多人付款队列、债务暂停与继续 |
| `selectors.ts` | 租金、购买、盖房、可出售资产 |
| `victory.ts` | cash goal 即时胜利 |
| `bot.ts` | `chooseBotIntent` |
| `simulate.ts` | 全 bot 对局与不变量对账 |

### 18.3 状态机

游戏阶段：

```text
playing → game_over
```

回合阶段：

```text
awaiting_roll
  ├─ roll_dice
  ├─ landed airport → awaiting_airport_roll
  ├─ landed unowned property → awaiting_buy_decision
  ├─ landed own normal property → awaiting_build_decision
  └─ otherwise → managing

awaiting_airport_roll → roll_airport_branch → resolve landing
awaiting_buy_decision → buy_property | skip_buy → managing
awaiting_build_decision → build_house | skip_build → managing
managing → sell/mortgage/redeem/end_turn
end_turn → next playable player → awaiting_roll
```

有 `debt` 时，普通流程冻结。actor 是 `debt.debtorId`，不一定是 `currentPlayerId`；只允许筹资/破产相关 intent。

### 18.4 核心 Intent

当前引擎支持的行为包含：

- `roll_dice`
- `roll_airport_branch`
- `buy_property` / `skip_buy`
- `build_house` / `skip_build`
- `sell_house`
- `sell_property`
- `mortgage_property`
- `redeem_property`
- `declare_bankrupt`
- `end_turn`

以 `packages/engine/src/types.ts` 的 union 为准。新增 intent 必须同时更新：

- type union；
- `applyIntent` dispatch；
- 参数合法性；
- server `isValidIntent`；
- protocol；
- client action derivation；
- event formatting；
- focused tests 和 full suite。

### 18.5 关键经济规则

- 初始现金：¥15,000；
- 经过起点：¥2,000；
- 盖房上限：5，5 代表旅馆；
- 卖房退款：`houseCost × 0.5`；
- 卖地退款：`price × 0.5`；
- 抵押获得：`mortgageValue`；
- 赎回支付：`Math.round(mortgageValue × (1 + mortgageInterestRate))`；
- station 租金按未抵押 station 数；
- utility 租金按骰点和未抵押 utility 数；
- 抵押资产不收租，也不计入 station/utility 持有数；
- 现金不足形成债务，不直接允许负数；
- 破产后地产全部变无主、level 归零、解除抵押；
- cash goal 有债务时不触发；
- 最后一名未破产玩家获胜。

### 18.6 机场支线

- 只在停到机场时触发，经过机场不触发；
- 进入 `awaiting_airport_roll`；
- 再掷一颗骰子；
- 第一步必到 branch entry 52；
- 公式是 `[branchEntry] + walkPath(branchEntry, dice - 1)`；
- 支线末端按 board graph 汇回外环；
- 不要在 UI 或 server 复制支线移动规则。

### 18.7 随机性

`rng.ts` 使用确定性 seed 流：

```text
hashSeed → rngNext/rngInt → shuffle/rollDice/rollSingleDice
```

禁止：

- 在 engine 中直接 `Math.random()`；
- 根据 wall clock 产生规则结果；
- client 和 server 各自决定同一次在线掷骰；
- 恢复存档时重新洗牌或重建 seed。

### 18.8 债务与付款队列

`payments.ts` 处理多人收付：

- 每笔付款产生事件；
- 现金不足时暂停为 `DebtState`；
- `DebtResumeState.payments` 保存未完成队列；
- 债务人筹足后自动付清，再继续队列；
- 中途破产后按规则继续/停止剩余付款；
- 新的多收款 effect 不应自己另写一套循环。

### 18.9 Bot

当前 v1：

- roll phase：掷骰；
- buy/build：只有支付后还能保留 ¥2,000 才执行；
- debt：卖房 → 抵押 → 卖地 → 破产；
- 无债务 `managing`：直接 `end_turn`。

当前 backlog 的主动赎回是对最后一条的扩展，不是引擎规则改变。实现必须继续返回 `redeem_property` intent。

### 18.10 Engine 不变量

1. 输入 state 不被原地修改；
2. 同 seed 可复现；
3. 所有现金变化可被仿真 `bankDelta` 对账；
4. `sum(player cash) + bank balance` 守恒；
5. debt 冻结普通阶段；
6. 抵押资产不收费；
7. airport only-on-landing；
8. `recentLog` 只保留最近 200 条；
9. effect 链深度上限 8；
10. skipTurns、破产玩家和最后站立逻辑不能产生死循环；
11. 新现金收入路径必须检查 cash goal；
12. 新事件类型必须考虑 presenter、日志格式化和 simulation 对账。

---

## 19. Protocol 与 Server：在线权威链路

### 19.1 权威边界

- 在线游戏的 authoritative state 只在 server；
- client 不在本地 apply 在线 intent；
- server 接收 intent，经 engine 产生 `state + events`；
- client 使用 server broadcast 的 events/snapshot；
- token、seed、deck order 不能广播；
- 所有不可信 Socket payload 先验证。

### 19.2 Protocol 事件

当前 `ClientToServerEvents` 是 9 个，不是 10 个：

| C2S | 作用 |
|---|---|
| `session:resume` | 用 roomCode/playerId/token 恢复 |
| `room:create` | 昵称 + requestId 创建房间 |
| `room:join` | 房间码 + 昵称 + requestId 加入 |
| `room:add_bot` | 房主增加 bot |
| `room:remove_bot` | 房主移除指定 bot |
| `room:start` | 房主开局 |
| `room:leave` | 离开 |
| `game:intent` | 发送引擎 intent |
| `room:skip_offline_turn` | 房主请求托管当前离线真人 |

`ServerToClientEvents` 是 5 个：

| S2C | 作用 |
|---|---|
| `room:state` | 公开房间状态 |
| `player:connection` | online 状态变化 |
| `room:closed` | 空大厅/大厅闲置关闭 |
| `game:events` | 成功 transition 的事件 |
| `game:snapshot` | transition 后公开状态 |

所有 C2S 操作使用 ack union：

```ts
{ ok: true, ...successPayload }
| { ok: false, code, message }
```

### 19.3 成功 transition 顺序

```text
1. game:events
2. game:snapshot
3. ack({ ok: true })  // setTimeout(0) 延迟回执
```

客户端依赖这个顺序做 presenter FIFO 和丢 ack reconciliation。不能轻易调整。

### 19.4 房间生命周期

```text
create/join
   ↓
lobby
   ├─ add/remove bot
   ├─ leave/host transfer
   └─ start
       ↓
playing
   ├─ game intents
   ├─ bot automation
   ├─ offline takeover
   └─ game_over
       ↓
ended
```

当前重要事实：

- Room 全在内存；
- 没有 server JSON save；
- 进程重启会失去全部房间；
- ended room 没有完整持久化/长期回收实现；
- lobby 离线真人有 300 秒宽限；
- playing 中房主离线会立即转移给下一个在线真人；
- 所有人离线时，后来 resume 的真人可成为 host。

### 19.5 RoomManager 责任

`apps/server/src/rooms/roomManager.ts` 管理：

- rooms Map；
- 4 位房间码分配；
- create/join requestId 幂等索引；
- host 转移；
- player online 镜像；
- start/createGame；
- applyGameIntent；
- bot 和 offline takeover 定时器；
- game_over/ended；
- dispose 清理。

随机、token、clock/timer、game gateway 都通过 `RoomManagerDependencies` 注入，测试不依赖真实时钟或真实 crypto。

### 19.6 房间码、requestId、token

- roomCode：`0000`–`9999`；
- 随机尝试最多 100 次，之后顺序扫描；
- requestId：32 位 hex；
- create/join 同 requestId + 同规范化 payload 重放原始结果；
- 同 requestId + 不同 payload 必须失败；
- production token：32 bytes → 64 位 hex；
- production token 比较：`timingSafeEqual`；
- playerId：UUID；
- token 只保存在 server Room 和 client localStorage 的 active session 中。

### 19.7 公开快照

当前：

```ts
type PublicGameSnapshot =
  Omit<GameState, 'seed' | 'decks'> & {
    deckCounts: { chance: number; destiny: number };
  };
```

风险：

- 以后给 `GameState` 新增私有字段，会自动落入 public type；
- `toPublicGameSnapshot` 使用排除后 spread。

多地图改造必须：

- 改为逐字段 allowlist；
- 显式决定每个新增字段是否可公开；
- 保留 deck counts，不泄漏 deck order；
- server tests 继续断言 seed/decks/token 不在公开 payload。

### 19.8 自动化

两种 mode：

- `bot`
- `offline_takeover`

共同机制：

- 每个房间一条 automation record；
- generation 使陈旧 timer callback 失效；
- 每次 action 后重新校验 actor、turn、phase、debt；
- production 延迟随机 800–1600 ms；
- dispose 必须清除 timer。

Offline takeover 只做：

- 掷普通骰；
- 掷机场骰；
- 不买；
- 不盖；
- 结束回合。

它不卖资产、不抵押、不赎回、不破产；有 debt 时禁止启动。`takeoverPlayerId` 是 public room 状态的一部分。

### 19.9 Server 错误

房间/会话：

- `ROOM_NOT_FOUND`
- `ROOM_FULL`
- `GAME_ALREADY_STARTED`
- `NICKNAME_TAKEN`
- `INVALID_TOKEN`
- `NOT_HOST`
- `INVALID_NICKNAME`
- `NOT_ENOUGH_PLAYERS`
- `INVALID_ROOM_ACTION`

Engine：

- `NOT_YOUR_TURN`
- `WRONG_PHASE`
- `INSUFFICIENT_FUNDS`
- `ILLEGAL_INTENT`

原始异常只记录 server log，不能原样返回客户端。

---

## 20. Client App、Session 与恢复

### 20.1 App shell

`apps/client/src/App.vue`：

- app lifetime 只创建一个 `OnlineGameSession`；
- 按需创建/销毁 `LocalSession`；
- 持有 `stage`：`online | local_setup | local_game`；
- 把 session refs 转给纯 `resolvePage`；
- 根据 page kind 渲染 Home/Restore/Lobby/Game/Settlement/Setup。

不要在 view 内另造路由状态机。

### 20.2 统一 GameSession

`apps/client/src/session/gameSession.ts` 定义：

- `GameSession`
- `RenderableGameState`
- connection status 和 UI 需要的 refs/methods。

LocalSession 和 OnlineSession 都实现同一界面，因此 `GameView.vue` 不需要知道规则运行在浏览器还是 server。

当前 `RenderableGameState` 会去掉 `seed` 和 `decks`，用于展示，不等于可恢复的 authoritative save。

### 20.3 App 页面决策

`resolvePage()` 的优先级：

1. `local_setup`；
2. `local_game` → game/settlement；
3. 有 online room → lobby/game/settlement；
4. 有 stored active 且未 defer → restoring；
5. home。

`restoreDeferred=true` 只让用户暂时回首页，不删除在线 credential。

### 20.4 OnlineSession

`apps/client/src/session/onlineSession.ts` 负责：

- socket lifecycle；
- create/join/resume；
- lobby commands；
- intent；
- ack timeout；
- staged entry 和 pending request；
- authoritative recovery；
- reconnect；
- generation stale-callback guard；
- presenter events/snapshot FIFO；
- dispose。

关键不变量：

- create/join 先存 pending request，再发网络请求；
- success 先把 active credential 写入 localStorage，再发布进入房间；
- storage 失败不能假装成功；
- definitive resume failure 才删除凭证；
- transient timeout/断线必须保留 retry；
- defer 不等于 abandon；
- lobby mutation 单飞；
- 丢失 ack 可用 room state/snapshot reconciliation 判定成功；
- dispose 后的 ack、timer、snapshot 不得重新写状态。

### 20.5 当前 browser localStorage

现有两个 key：

```text
richman_session
richman_pending_room_request
```

文件名虽然叫 `sessionStorage.ts`，实际默认使用 `globalThis.localStorage`。

`richman_session`：

```ts
{ roomCode, playerId, token }
```

`richman_pending_room_request`：

```ts
{ operation: 'create' | 'join', requestId, nickname, roomCode? }
```

读取时做 exact-key schema 检查；损坏记录被拒绝。不要把未来本机存档混入这两个 key。

### 20.6 LocalSession

`apps/client/src/session/localSession.ts`：

- `createGame` 建局；
- human intent 直接 `applyIntent`；
- 成功结果交给 presenter；
- bot 通过 `chooseBotIntent`；
- 连续 bot action 有 20 次循环保护；
- dispose/generation 取消陈旧 bot 延迟；
- 当前只在内存，不支持 reload 后恢复。

未来本机断点续玩必须按批准 spec 改成：

```text
applyIntent proposed next state
  → 持久化成功
  → 发布 authoritative in-memory state
  → 播放 events
  → 安排下一 bot
```

不能沿用当前“先改内存、后保存”的顺序。

### 20.7 Presenter

`apps/client/src/session/gamePresenter.ts`：

- local：`playEvents(events, snapshot)`；
- online：`receiveEvents` 与 `receiveSnapshot` FIFO 配对；
- token movement 按路径逐格播放；
- dice/card/message/displayPositions 都是展示状态；
- animation generation 在 reset/dispose 后取消陈旧 await；
- 最终 authoritative display snapshot 在动画后落地。

任何改变 server event 顺序、快照节奏、动画延迟的改动，都要同时检查 presenter race tests。

### 20.8 交互选择器

`gameInteraction.ts` 是连接状态、回合所有权、debt、takeover、offline actor 的统一 UI 决策点。

不要在 `GameView.vue`、`ActionPanel.vue` 各写一套：

- canSendIntent；
- canSkipOfflineTurn；
- requiresLeaveConfirm；
- 状态提示优先级。

---

## 21. Client UI、响应式与视觉不变量

### 21.1 组件树

```text
App.vue
├── HomeView
├── RestoreView
├── LobbyView
├── GameSetup
└── GameView
    ├── PlayerRail
    ├── GameBoard
    │   └── BoardCell
    ├── FocusedBoard
    ├── ActionPanel
    ├── AssetPanel
    ├── CellDetailPanel
    └── SettlementDialog
```

### 21.2 显示数据派生

`apps/client/src/game/clientGame.ts` 是 UI 规则文案/动作派生中心：

- `getAvailableActions`
- `getPendingPurchaseOffer`
- `getAssetRows`
- `getCellDetail`
- `getTurnTitle`
- `formatRecentLogEvent`

`settlement.ts` 负责排名；`gameSetup.ts` 负责本地设置；`ui/*.ts` 负责几何和格式。优先扩展这些纯函数，不把复杂判断塞进模板。

### 21.3 当前棋盘几何

`GameBoard.vue` + `boardLayout.ts` 当前固定：

- 61 格中国之旅；
- 外环 ID 0–51；
- 14×14 CSS grid；
- 9 格斜向支线；
- 单条 inline SVG branch track；
- 中央“中国之旅”装饰；
- cell short-name override；
- Feishu property bands。

这套约束是当前中国之旅 presentation，不是未来所有地图的通用规则。多地图迁移时应把坐标和 decoration 数据化，而不是继续按 ID/name 特判。

### 21.4 Desktop / Mobile

主断点：

```css
@media (max-width: 767px)
```

Desktop：

- 主布局 board + 340px side panel；
- GameBoard 默认显示；
- FocusedBoard 隐藏；
- board square 尺寸受 viewport height 限制；
- PlayerRail 横向排列。

Mobile：

- 纵向堆叠；
- FocusedBoard 默认显示；
- 用户可切到全局 GameBoard；
- PlayerRail 等宽卡片横向滚动；
- 玩家名省略；
- action/assets/detail/settlement 纵向可读；
- 主要可点击目标至少 44px。

高风险窄屏：

- 390×844 是必验 viewport；
- PlayerRail 或 badge/现金反馈变更还要验 320×700；
- 不得出现水平溢出；
- BOT/离线/破产 badge 要能共存；
- 现金变化提示不能把棋盘向下顶；
- 三张玩家卡在 390px 下保持单行，四人局允许横向滚动或既有压缩布局。

### 21.5 视觉 token

全局 token 在 `apps/client/src/style.css`：

- 米白背景；
- 中国红 primary；
- 金色 accent；
- gain/error/warning；
- player red/blue/yellow/green；
- property bands；
- board/panel/shadow/radius；
- button enabled/disabled；
- system CJK font stack。

玩家身份色必须在 avatar、token、owner strip 中保持同一语义。地图 theme 不能改变玩家身份识别。

### 21.6 可访问性

现有重点：

- 棋盘格和 focused cards 是 button；
- board/cell/action/assets/detail 使用 ARIA label；
- settlement/leave/QR 使用 dialog semantics；
- 连接提示使用 live/status；
- modal 有 Escape 和 focus trap/restore；
- disabled state 跟随 animation/session；
- keyboard focus 有可见 outline。

新增 modal 或替换现有按钮时，要验证：

- Tab 不逃出 modal；
- Escape 行为；
- 关闭后 focus 回到 trigger；
- 状态文案可被读屏更新；
- disabled 不只是视觉变灰；
- 点击目标不低于现有 44px 基线。

### 21.7 当前已知 UI 缺口

这些在旧计划里出现，但当前代码未完整实现：

- safe-area `env(safe-area-inset-*)`；
- 音效与静音；
- Web App Manifest / PWA icon；
- 更丰富的全屏输赢/现金动画；
- 自动化 Playwright browser e2e；
- 通用 data-driven multi-map presentation。

不要把旧计划里的“想做”写成“已完成”。

---

## 22. 测试架构与回归矩阵

### 22.1 当前实测基线

2026-07-15 在 worktree `/Users/admin/Documents/Richman/.worktrees/m3-client-online` 实际运行：

```bash
pnpm test
pnpm typecheck
pnpm validate-data
pnpm build
pnpm --filter @richman/engine simulate:500
pnpm exec tsx scripts/smoke-production.ts
```

观察结果：

- Vitest：45 files passed，715 tests passed；
- typecheck：passed；
- data validation：61 格、41 property、机会 15、命运 15，全部通过；
- client build：203 modules，production bundle 生成；
- server build：passed；
- 500 局仿真：500/500 终局；
- 平均 1012.9 intents，中位 972，最大 2151；
- 胜利原因：last_standing 314，cash_goal 186；
- 非法 intent：0；
- 现金守恒违例：0；
- 异常：0；
- 失败局：0；
- production smoke：`smoke ok`。

这是本次交接的当前证据。后续任何改动仍要重新运行相关检查。

### 22.2 测试分布

| 区域 | 文件数 | 主要合同 |
|---|---:|---|
| `packages/engine/src/__tests__` | 19 | 开局、骰子、移动、机场、资产、租金、卡牌、债务、胜利、bot、仿真 |
| `apps/server/src/__tests__` | 11 | RoomManager、Socket.IO、快照、重连、托管、生产 server、静态托管 |
| `apps/client/src/**/*.test.ts` | 15 | session、storage、presenter、app flow、UI selectors、棋盘/移动端回归 |

### 22.3 Engine 测试索引

| 测试 | 重点 |
|---|---|
| `createGame.test.ts` | 玩家数、初始状态、seed、颜色、cashGoal |
| `roll_dice.test.ts` | 权限、阶段、路径、工资、事件顺序 |
| `movement.test.ts` | board graph、绕圈、支线汇回 |
| `branch.test.ts` | 机场停留/再掷/支线路径 |
| `buy_property.test.ts` | 买/不买、现金边界 |
| `build_house.test.ts` | 一次一幢、上限、抵押门控 |
| `sell.test.ts` | 卖房/卖地、退款、债务 |
| `mortgage.test.ts` | 抵押、赎回、价格、非法状态 |
| `rent.test.ts` | normal/station/utility selector |
| `rent_payment.test.ts` | 落地实际扣租和债务 |
| `cards.test.ts` | 所有 effect、30 张卡、链式移动/抽牌 |
| `tax.test.ts` | 银行付款与债务 |
| `debt_bankruptcy.test.ts` | 债务恢复、排队、破产 |
| `victory.test.ts` | cashGoal/最后站立 |
| `end_turn.test.ts` | skipTurns、破产玩家、回合推进 |
| `selectors.test.ts` | UI 共享 selector |
| `bot.test.ts` | bot intent 策略 |
| `simulation.test.ts` | 50 局属性测试/守恒 |
| `engine.test.ts` | 基础集成/配置 |

### 22.4 Server 测试索引

| 测试 | 重点 |
|---|---|
| `roomManager.test.ts` | create/join/host/bot/leave/resume/idempotency/timers |
| `roomGame.test.ts` | engine transition、bot、takeover、debt、ended |
| `socketRooms.test.ts` | 真实 Socket.IO 房间协议 |
| `socketGame.test.ts` | events → snapshot → ack |
| `socketGameReconnect.test.ts` | resume、替换 socket、托管可见性 |
| `clientOnlineSession.test.ts` | client/server 联机链路 |
| `gameRuntime.test.ts` | intent validation、异常隔离、takeover 策略 |
| `public snapshot` 相关断言 | token/seed/decks 不泄漏 |
| `serverStatic.test.ts` | SPA fallback、静态文件、path traversal |
| `production.test.ts` | production bootstrap、crypto/port/static |
| `networkAddress.test.ts` | LAN IPv4 |
| `partyLauncher.test.ts` | 子进程启动与退出 |

### 22.5 Client 测试索引

| 测试 | 重点 |
|---|---|
| `onlineSession.test.ts` | create/join/resume/retry/defer/ack race/storage-first |
| `localSession.test.ts` | local engine/presenter/bot/dispose |
| `localSession.botFailure.test.ts` | bot 异常/循环保护 |
| `gamePresenter.test.ts` | FIFO、动画、reset/dispose generation |
| `gameInteraction.test.ts` | 连接、回合、debt、takeover 优先级 |
| `sessionStorage.test.ts` | schema、不可信数据、写/删失败 |
| `appFlow.test.ts` | 页面 reducer 与 entry validation |
| `invitation.test.ts` | room URL、QR payload、凭证不泄漏 |
| `clientGame.test.ts` | action/asset/detail/log 文案派生 |
| `gameSetup.test.ts` | 本地局人数/昵称/cashGoal |
| `settlement.test.ts` | 排名和结算 |
| `boardLayout.test.ts` | 14×14 placement、支线、短名、色带 |
| `focusedRoute.test.ts` | 7 格窗口、环绕、支线边界 |
| `boardRentDisplay.test.ts` | 棋盘表面不显示租金回归 |
| `cashFeedback.test.ts` | 现金变化反馈 |

### 22.6 修改类型对应验证

| 改动 | 最小 focused check | 最终 check |
|---|---|---|
| board/cards/config | validator + 直接 engine test | full test + typecheck + validate-data + browser |
| engine rule | 对应 engine test | full test + typecheck + 500 simulation |
| bot | `bot.test.ts` | engine suite + full test + 500 simulation |
| protocol | protocol typecheck + socket focused test | full test + typecheck + client/server build |
| RoomManager | roomManager/roomGame focused | full test + typecheck + production smoke |
| onlineSession | onlineSession focused | full test + build + real 2-browser scenario |
| localSession | localSession focused | full test + build + real local scenario |
| presenter | presenter focused | full test + desktop/mobile browser |
| UI/CSS | nearest selector/UI tests | client build + 1440×900 + 390×844 |
| PlayerRail/narrow mobile | client tests | 390×844 + 320×700 DOM/visual check |
| deployment | production tests | build + smoke + actual start/fetch |
| save/schema | hydration/storage focused | reload/multi-tab/corrupt data browser scenarios |

---

## 23. Bug 维护 SOP

### 23.1 先分类，不先改

| 用户症状 | 首查位置 |
|---|---|
| 地名、价格、租金表错误 | board-data JSON、raw、validate、plan/02 |
| 走错格、重复工资、机场异常 | movement/effects/roll/branch tests |
| 买地/盖房/抵押/债务错误 | engine handler + selectors +对应测试 |
| bot 卡住/乱卖资产 | bot.ts、automation、simulation |
| 本地能玩、在线不同步 | server RoomManager/runtime/protocol |
| ack 超时后重复操作 | onlineSession reconciliation + requestId |
| 刷新后进不回房间 | localStorage keys、resume、token、room 仍否存在 |
| 事件动画错位/倒退 | events/snapshot 顺序、presenter FIFO/generation |
| 按钮不该亮或该亮没亮 | gameInteraction + clientGame selectors |
| 手机布局溢出 | PlayerRail/GameView/global CSS + 固定 viewport |
| 生产页面 404 | client dist、sirv path、build/smoke |
| Socket 连不上 | server :3000、Vite proxy、同源、firewall |

### 23.2 标准流程

1. 记录真实症状、输入、模式（local/online）、人数、回合阶段、viewport；
2. 在当前代码上复现；
3. 找到最小责任层，避免跨层补丁；
4. 写一个会在原 bug 上失败的 contract test；
5. 修根因；
6. 用同一场景确认不再触发；
7. 跑邻近 suite；
8. 按第 22.6 节跑最终检查；
9. UI/联机必须走真实运行场景；
10. 记录用户可观察结果和未验证项。

### 23.3 禁止的修 bug 方式

- 只隐藏错误文案；
- client 特判 server 错误 state；
- server 重写 engine 的合法性；
- 用 source-string test 代替行为 test（除既有明确视觉禁词回归）；
- 为一个坏输入加硬编码 cell ID/name；
- 通过清 localStorage 掩盖恢复 bug；
- ack 超时后无条件重发非幂等请求；
- 只跑 build 就说联机/UI 修好；
- 修改随机 seed 以“让失败局消失”；
- 降低 simulation 局数或跳过失败用例。

### 23.4 常见根因路线

**规则错误**

```text
plan/01 → state fixture → applyIntent → events/state → selector → client display
```

**在线不同步**

```text
client intent
→ protocol payload
→ socket adapter validation
→ RoomManager
→ gameRuntime/applyIntent
→ domain events
→ game:events
→ game:snapshot
→ presenter FIFO
→ rendered state
```

**恢复错误**

```text
localStorage record
→ OnlineSession initialization
→ socket connect
→ session:resume
→ server token validation
→ room/player online mirror
→ ack room/snapshot
→ presenter reset
→ resolvePage
```

**自动化错误**

```text
actor/debt/turn
→ automation record
→ timer generation
→ choose intent
→ apply transition
→ reconcileAfterTransition
→ keep/clear/start next automation
```

---

## 24. 新功能开发 SOP

### 24.1 产品行为先行

先确认用户能观察的行为：

- 谁能触发；
- 在哪个阶段；
- 成功后发生什么；
- 失败/取消怎么处理；
- local 与 online 是否都需要；
- reload/reconnect 是否保留；
- mobile 怎么呈现；
- 兼容旧房间/旧存档吗；
- 是否影响隐私、安全、数据。

用户不需要决定 class、interface、依赖或文件拆分；这些由 Codex 负责。

### 24.2 设计与实施

非 trivial feature：

1. 读 `brainstorming` skill；
2. 读相关 code/tests/spec；
3. 给出短设计并获得产品行为批准；
4. 写批准 design spec；
5. 用 `writing-plans` 写 bite-sized plan；
6. 若用户选择 Subagent-Driven，按 fresh implementer → spec review → quality review；
7. 每个任务 TDD；
8. controller 统一跑 final verification；
9. 必要时更新 README/plan；
10. 不自动 commit/push/PR。

### 24.3 新规则

通常涉及：

```text
plan/01
packages/board-data/src/types.ts（若数据 schema 变化）
packages/engine/src/types.ts
packages/engine/src/engine.ts 或 effects/payments/selectors
packages/engine/src/__tests__/
apps/server/src/game/gameRuntime.ts
packages/protocol/src/index.ts（若新增 intent/event）
apps/client/src/game/clientGame.ts
apps/client UI
simulation accounting
```

检查：

- state machine；
- debt actor；
- cash goal；
- bankDelta；
- deterministic seed；
- bot；
- server validation；
- public snapshot；
- presenter/log；
- local/online 一致性。

### 24.4 新地图

必须先完成已批准 multi-map modularization，不可直接复制 board.json。

新地图最小接入目标：

- versioned map pack；
- immutable `MapRef`；
- active catalog entry；
- generic validation；
- map-specific validation module；
- exact server room locking；
- exact client resolution；
- data-driven placements/presentation；
- test-only map 证明 shared code 不依赖中国 ID/name；
- desktop/mobile equivalence。

禁止：

- map pack 携带 JS/CSS；
- runtime remote assets；
- 加入者选择不同地图；
- 房间中途切图；
- unknown map 回退中国之旅；
- 为第二张图在 shared code 写第二套 if/else。

### 24.5 新 Socket 事件

必须同步：

1. protocol C2S/S2C type；
2. socket adapter payload guard；
3. RoomManager method/domain event；
4. ack success/failure；
5. client emit/listener；
6. request idempotency（若会改变状态）；
7. stale ack/dispose behavior；
8. server socket integration tests；
9. client onlineSession tests；
10. token/private-data leak tests。

### 24.6 新 UI 页面/弹窗

优先：

- 页面选择放 `appFlow`；
- session 状态放 session；
- 纯展示派生放 `game/` 或 `ui/`；
- view 只组合 props/emits；
- modal 复用 focus trap/restore 模式；
- CSS 使用既有 token；
- 390×844 必验；
- 涉及玩家栏再验 320×700。

### 24.7 新存档或 schema

存档视为不可信、兼容性敏感的数据模型：

- 必须有 schemaVersion；
- 必须做 runtime hydration validation；
- 不能只 `as GameState`；
- 必须验证 mapRef、rule modules、cell/player/property/debt/deck 引用；
- 写入采用 proposed-state-first commit；
- 写失败不能发布内存状态；
- 多 tab 必须有 revision/冲突检测；
- invalid slot 不能静默删除；
- migration/clean cutover 要有明确产品批准；
- 旧在线 credential keys 不得被本地存档改动。

---

## 25. 部署与运行维护

### 25.1 聚会同 WiFi

```bash
pnpm party
```

预期：

- 先 build；
- server 启动；
- 打印 localhost；
- 找到非 loopback IPv4 时打印 LAN URL；
- 打印 terminal QR；
- SIGINT/SIGTERM 优雅关闭。

排查：

- 手机与主机同一 WiFi；
- 不用访客隔离网络；
- macOS 首次允许 Node 接受连接；
- 防火墙开放当前端口；
- 手机访问 LAN IP，不是 localhost。

### 25.2 单进程生产

```bash
pnpm build
PORT=3000 pnpm start
```

一个进程同时服务：

- `/` 和静态 assets；
- SPA fallback；
- `/socket.io`。

进程重启会丢当前房间，这是当前已知产品限制。

### 25.3 最短 production smoke

```bash
pnpm build
pnpm exec tsx scripts/smoke-production.ts
```

它只证明：

- production server 能启动；
- 根 HTML 200；
- HTML 包含 doctype；
- server 能关闭。

它不证明：

- 多人 Socket.IO 链路；
- UI 可用；
- 手机布局；
- 断线恢复；
- 当前内存房间能跨进程恢复。

### 25.4 云部署

详细步骤仍看 `plan/07-阶段4-部署指南.md`。执行时注意：

- 用 systemd/pm2 只是进程守护，不会让内存房间跨重启恢复；
- 国内域名与服务器可能涉及备案；
- HTTPS 需要反向代理/证书；
- 开放游戏端口和 SSH 端口；
- 更新前先备份真正存在的数据；当前没有 server saves 目录可备份；
- 任何生产发布必须先走第 28 节 gate。

### 25.5 日志与隐私

当前没有结构化日志/监控平台。server 默认 console error。

排错时不要打印：

- token；
- localStorage 完整内容；
- seed；
- deck order；
- cookies/系统凭据；
- 用户机器私有网络信息到公开 issue。

---

## 26. 安全、隐私与兼容边界

### 26.1 当前威胁模型

- 亲友内部使用；
- 无账号；
- 房间码不是秘密；
- token 只用于重连身份；
- server 是在线权威；
- client bundle 可被玩家查看；
- 不承诺对恶意公网攻击的完整防护。

### 26.2 必须守住

- token 不出现在 public room、broadcast、log；
- seed/deck order 不出现在 public snapshot；
- payload runtime validation；
- intent allowlist；
- production token timing-safe compare；
- requestId 幂等；
- path traversal 防护；
- 不信任 localStorage；
- map presentation 不可执行；
- unknown/incompatible map/save 明确失败；
- 不把 private `GameState` 自动 spread 到 wire。

### 26.3 兼容性

当前没有正式存档 schema，因此不要虚构“已有存档迁移”。

一旦引入：

- mapRef；
- rule modules；
- local saves；
- server persistence；

就必须定义：

- exact version；
- content hash；
- supported old versions；
- unavailable/incompatible UX；
- cleanup；
- upgrade/downgrade 行为；
- test fixtures。

---

## 27. 已知技术债与高风险区域

### P0：会造成错误认知

1. README 阶段进度落后实际代码；
2. plan/package description 声称 server JSON persistence，但功能不存在；
3. e2e script 是占位。

### P1：后续功能直接会碰

1. `PublicGameSnapshot` 的 `Omit + spread` 泄漏风险；
2. Client board presentation 固定中国之旅 ID/14×14/单支线；
3. `engine.ts` 和 `RoomManager` 体积较大，修改需 focused tests；
4. 当前 LocalSession 无持久化，且 transition 顺序不满足 storage-first；
5. current GameState 没有 mapRef/rule modules；
6. server 房间没有 map identity；
7. server 无磁盘持久化和进程重启恢复。

### P2：质量/维护

1. 无 Playwright 自动 e2e；
2. 真实 browser 验收依赖手工/agent；
3. Vite allowed host 中可能保留过期 ngrok 域名；
4. safe-area、PWA、音效未完成；
5. `recentLog` 固定 slice 200；
6. effect depth 固定 8；
7. 新现金事件容易漏 cashGoal/bankDelta；
8. utility projected rent 与 `lastDice` 语义会影响 bot 赎回排序。

处理原则：

- 不在无关任务中顺手重构；
- 只有当前需求触达时才解决；
- P0 文档漂移可在下一次正式功能收尾更新；
- P1 必须在相应 spec 中明确；
- 不因为技术债存在就扩大当前用户范围。

---

## 28. 发布与交付 Gate

### 28.1 代码合并前

至少：

```bash
pnpm test
pnpm typecheck
pnpm validate-data
pnpm build
```

按变更增加：

```bash
pnpm --filter @richman/engine simulate:500
pnpm exec tsx scripts/smoke-production.ts
```

### 28.2 UI Gate

固定视口：

- Desktop：1440×900；
- Mobile：390×844；
- 玩家栏/极窄布局：320×700。

必须观察：

- 无水平 overflow；
- 当前玩家、BOT、offline、bankrupt；
- action buttons；
- board/focused toggle；
- modal focus/Escape；
- 现金反馈；
- 卡牌、详情、资产、结算；
- local 与 online；
- reload/reconnect（若相关）。

截图写入：

```text
plan/assets/screenshots/phase1/
plan/assets/screenshots/phase2/
```

命名继续使用：

```text
<feature>-desktop-1440x900.png
<feature>-mobile-390x844.png
```

### 28.3 联机 Gate

至少两个独立 browser context：

1. host create；
2. guest join；
3. add/remove bot；
4. start；
5. 两端收到同一 room/snapshot；
6. host/guest intent 权限；
7. events/snapshot 顺序；
8. 断开 guest；
9. host takeover/skip（若相关）；
10. guest resume；
11. ended settlement。

### 28.4 存档 Gate

本机存档：

- start → 操作 → reload → continue；
- close/reopen；
- bot turn 中 reload；
- 两槽排序；
- 第三局替换确认/取消；
- corrupt/incompatible slot；
- storage write failure；
- two tabs revision conflict；
- game_over cleanup；
- online keys 不变。

Server persistence（未来）：

- process restart；
- exact room/game/map restoration；
- token protection；
- corrupt file isolation；
- atomic write；
- ended/expired cleanup。

### 28.5 交付报告

每次必须写：

- 用户可观察到什么变化；
- 涉及哪些文件；
- 哪些实际命令通过；
- 哪些真实场景跑过；
- 哪些没验证及原因；
- 是否有兼容/数据/部署风险；
- 不说“应该可以”代替证据。

---

## 29. 故障排查速查

### 29.1 Client 首页打不开

1. `apps/client/dist` 是否存在；
2. `pnpm build` 是否通过；
3. server 的 static path；
4. `serverStatic.test.ts`；
5. production smoke。

### 29.2 页面打开但不能联机

1. server 是否监听 `:3000`；
2. dev 下 Vite `/socket.io` proxy；
3. browser network WebSocket；
4. firewall/LAN；
5. socket 是否 bind 到 room/player；
6. room 是否仍在内存；
7. token 是否匹配。

### 29.3 创建/加入后回首页

1. pending request 是否成功写入 localStorage；
2. ack 是 definitive 还是 transient；
3. active session commit 是否成功；
4. `resolvePage` 输入；
5. stale generation 是否丢弃了成功 ack；
6. server idempotency record。

### 29.4 Bot 不行动

1. actor 是否 bot/debt debtor；
2. automation record；
3. timer generation；
4. `chooseBotIntent` 是否返回合法 intent；
5. transition 后是否仍同 turn；
6. 20-action guard（local）；
7. server dispose/room ended。

### 29.5 棋子显示位置错但规则正确

1. engine state position；
2. presenter displayPositions；
3. token_moved path；
4. `boardLayout` placement；
5. branch token transform；
6. reset 是否取消陈旧 animation。

### 29.6 金额不一致

1. engine authoritative cash；
2. event amount；
3. selector/formatMoney；
4. pending debt；
5. cash feedback 聚合；
6. simulation bankDelta；
7. public snapshot 是否更新。

---

## 30. 关键文件索引

### 30.1 Product/Rules

```text
plan/00-项目总览与协作约定.md
plan/01-游戏规则规格书.md
plan/02-棋盘数据与素材规范.md
plan/03-架构与联机协议.md
plan/04-阶段1-单机热座版.md
plan/05-阶段2-联机版.md
plan/06-阶段3-手机适配与规则补全.md
plan/07-阶段4-部署指南.md
```

### 30.2 Engine/Data

```text
packages/board-data/data/*.json
packages/board-data/src/types.ts
packages/board-data/src/validate.ts
packages/engine/src/types.ts
packages/engine/src/engine.ts
packages/engine/src/effects.ts
packages/engine/src/payments.ts
packages/engine/src/movement.ts
packages/engine/src/selectors.ts
packages/engine/src/bot.ts
packages/engine/src/simulate.ts
```

### 30.3 Server/Protocol

```text
packages/protocol/src/index.ts
apps/server/src/production.ts
apps/server/src/server.ts
apps/server/src/socket/roomSocketAdapter.ts
apps/server/src/rooms/roomManager.ts
apps/server/src/rooms/roomTypes.ts
apps/server/src/rooms/roomErrors.ts
apps/server/src/game/gameRuntime.ts
apps/server/src/publicGameSnapshot.ts
```

### 30.4 Client State

```text
apps/client/src/App.vue
apps/client/src/session/appFlow.ts
apps/client/src/session/gameSession.ts
apps/client/src/session/localSession.ts
apps/client/src/session/onlineSession.ts
apps/client/src/session/gamePresenter.ts
apps/client/src/session/gameInteraction.ts
apps/client/src/session/sessionStorage.ts
apps/client/src/session/invitation.ts
```

### 30.5 Client UI

```text
apps/client/src/views/*.vue
apps/client/src/components/*.vue
apps/client/src/game/clientGame.ts
apps/client/src/game/gameSetup.ts
apps/client/src/game/settlement.ts
apps/client/src/ui/boardLayout.ts
apps/client/src/ui/focusedRoute.ts
apps/client/src/ui/format.ts
apps/client/src/style.css
```

---

## 31. Codex 长期执行守则

1. 默认在 `/Users/admin/Documents/Richman/.worktrees/m3-client-online` 工作，除非用户明确指定新 worktree。
2. 不把主仓库、旧 worktree 或历史 branch 的状态当作当前实现。
3. 用户负责产品/规则；Codex 负责技术实现与验证。
4. 不要求用户读 diff 或做架构选择。
5. 只在产品行为、UX、数据、安全、兼容性存在实质歧义时提问。
6. 先定位责任层，最小 diff，修根因。
7. exported symbol 变更前查 references。
8. feature/bug 按 TDD 和现有测试 convention。
9. local/online 共享 UI 与 engine，不建立第二套规则。
10. 服务端是在线权威；browser storage 是不可信输入。
11. UI 不能靠 build 代替真实浏览器。
12. 规则/bot 改动不能跳过 500 局仿真。
13. 数据改动不能跳过 validator。
14. 协议改动不能漏 client/server/ack/race/privacy。
15. 存档改动不能牺牲 storage-first、一致性、版本兼容。
16. 不自动 commit、push、开 PR、部署或发布。
17. 不泄漏 token、seed、deck order、凭据。
18. 不把历史 mockup 当真实 UI。
19. 不静默缩减批准 spec 的 acceptance criteria。
20. 每次交付用实际运行证据闭环。

---

## 32. 当前接手状态（2026-07-15 本次重写后）

- branch：`m3-client-online`
- HEAD：`fb5d9c1 M3 gameplay feedback and mobile layout`
- staged：0
- unstaged business code：0
- untracked：6 份文档
- 本交接已从“3 个后续任务续接”升级为“整个项目长期工程接管手册”
- 本次没有修改业务代码
- 本次完整 baseline 已实际通过：45/715 tests、typecheck、data validation、client/server build、500 局仿真、production smoke
- 真实浏览器没有在本次文档重写中重跑；最近 UI 证据仍是前文第 8 节记录和 33 张 repo 截图
- 下一项实现仍按第 6 节顺序：bot 主动赎回 → 多地图 → 本机两槽断点续玩
- 后续维护不局限于这三项；本文第 13–31 节是长期 bug、feature、test、UI、联机、部署的统一入口
