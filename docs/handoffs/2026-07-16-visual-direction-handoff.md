# 视觉方向变更 HANDOFF（一期棋盘区换肤）

> 日期：2026-07-16  
> 面向：新建独立 worktree 后接手「一期棋盘区换肤」的 agent  
> 当前交付性质：**方向与计划任务交接，不是生产实现批准**

## 1. 一句话结论

停止继续交付 `a1 / a2 / b1` 三个棋盘比稿方向；保留现有 dev-only 比稿基础设施和三种骰子动效，棋盘与整体界面改以 owner 已选定的 GPT 外部概念稿为目标风格。下一位 agent 的第一项交付只能是「一期棋盘区换肤」实施计划，计划通过评审前不得修改棋盘生产代码。

## 2. 建议的新 worktree 起点

### 2.1 启动前必须先读取本文件

本 HANDOFF 当前没有进入任何 Git 提交。创建新 worktree 后，Git 不会自动把它带过去。给新 agent 派发任务时，必须先明确提供本文件的绝对路径：

`/Users/admin/Documents/Richman/.worktrees/visual-polish/docs/handoffs/2026-07-16-visual-direction-handoff.md`

新 agent 应先从这个绝对路径完整读取交接，再检查或创建自己的 worktree；不得只根据新 worktree 内的旧版 `plan/09` 开始工作。除非 owner 另行授权，本次交接不自动 commit、push 或替 owner 整理主仓库未提交文档。

### 2.2 分支起点

建议从以下**干净提交点**创建新分支和 worktree：

- source branch：`visual-polish`
- source commit：`a1f92ace96dd03628329cc711fb09bad371ea6cb`
- 建议新分支：`codex/visual-board-phase1`

这个提交点已经包含可复用的 dev-only 比稿入口、确定性 fixture 和三种骰子动效；当前 `visual-polish` worktree 里另有未提交的 `onlineSession` bug 修复，不属于视觉任务，不得复制到新 worktree。

创建 worktree 后、同步新版文档前必须先确认：

```bash
git status --short --branch
git log --oneline -5
```

预期：新 worktree 干净，HEAD 为 `a1f92ac`。

最新视觉决策和三张概念稿已经进入 `main@76029b007a4fab13b9b0561408eddce971e8bcfc`。新 worktree 从 `visual-polish@a1f92ac` 建立后，必须先从该 main 提交同步以下材料，再编写实施计划：

```bash
git restore --source=76029b0 -- \
  plan/00-项目总览与协作约定.md \
  plan/09-视觉打磨.md \
  plan/assets/concepts
```

这一步只同步权威视觉文档与概念稿，不引入其他业务代码。同步后 `git status --short` 应只出现上述视觉文档/概念稿以及随后新建的一期计划；若出现 `onlineSession` 或其他业务文件，立即停止并检查 worktree 起点。同步后的文档改动应与一期计划放在独立视觉分支管理，不能回写或清理现有 `visual-polish` worktree 的未提交文件。

## 3. 权威材料与当前同步风险

### 3.1 必读材料

1. 主仓库工作区中的新版视觉决策记录：
   `/Users/admin/Documents/Richman/plan/09-视觉打磨.md`
2. 真实棋盘数据：
   `packages/board-data/maps/china-tour/v1/board.json`
3. 既有棋盘数据与视觉规范：
   `plan/02-棋盘数据与素材规范.md`，重点 §4.1–§4.4
4. 现有比稿设计及 presenter 不变量：
   `docs/superpowers/specs/2026-07-16-visual-polish-design.md`
5. 现有比稿实现计划，仅用于理解已交付基础设施，不再作为棋盘方向依据：
   `docs/superpowers/plans/2026-07-16-visual-polish-comparison.md`

### 3.2 开工前同步检查

1. `visual-polish` 分支内的 `plan/09-视觉打磨.md` 仍是旧版，记录的是 `a1 / a2 / b1` 比稿和“等待选型”；`main@76029b0` 中的同名文件才记录最新 owner 决策。新 agent 必须完成第 2 节的同步，不得从旧版结论继续铺开。
2. 三张概念原图已经进入 `main@76029b0`，本次交接已逐张实际打开，确认均为可读取的非空白 PNG：
   - `plan/assets/concepts/gpt-board-concept-desktop-1.png`：`1586×992`；
   - `plan/assets/concepts/gpt-board-concept-desktop-2.png`：`1586×992`；
   - `plan/assets/concepts/gpt-board-concept-mobile.png`：`853×1844`。
3. 新 agent 必须同时查看三张原图：两张桌面稿用于比较外围主环、中央地图、支线和侧栏构图；手机稿用于确认聚焦/全局切换、玩家栏、骰子区和事件播报的整体层次。概念图数据仍是占位，不得照抄城市、价格、编号或支线节点。

主仓库的权威视觉材料已形成独立文档提交；主仓库仍存在与视觉材料无关的未跟踪目录，不要覆盖、清理或顺手提交。

## 4. 已确认的新视觉方向

### 4.1 总体方向

- 保持主题 A「暖纸」视觉基因，不推翻既有产品气质。
- GPT 外部概念稿作为棋盘与整套界面的目标风格。
- 整套换肤拆成两期：
  - 一期：棋盘、外围主环、机场支线、中央区、骰子舞台；
  - 二期：玩家面板、事件播报、操作按钮。
- 本次新 worktree 只负责**一期计划及其后经批准的实现**，不得提前做二期。

### 4.2 对现有三套棋盘比稿的处理

- `a1 / a2 / b1` 三个棋盘方向正式终止，不再补手机全局棋盘样张，也不进入生产实现。
- 现有 `BoardArtReview.vue`、`FocusArtReview.vue`、相关 CSS 和六张截图是历史比稿证据；在新计划评审前不要急着删除。
- 后续正式实现收尾时，再按 owner“比稿页仅供本次评审、定稿后删除”的决定清理未采用棋盘候选。
- owner 先前关于“中央部分可以不做处理，外围与支线效果不错”的意见针对已终止的棋盘比稿；新实现应以外部概念稿和新版 `plan/09` 为准，不能把该句单独当作生产规格。

### 4.3 骰子动效仍保留选型

现有三种可交互动效继续保留：

1. `panel-shaker`：面板骰盅；
2. `route-roll`：路线滚入；
3. `ticket-flip`：票卡翻面。

共同口径：

- 同一次掷骰结果在定格时才揭晓；
- 表演约 `0.9–1.0s`；
- 重播会取消当前动画并从头开始，不排队；
- `prefers-reduced-motion: reduce` 时直接显示结果；
- owner 尚未在新版方向中最终选定生产方案，不能把任何一案直接接入正式界面。

此前 owner 还提出：正式接入后，骰子不再常驻于战报格，而是在棋盘中央出现结果、完成表演后消失，并且本地、联机、恢复后的所有版本行为一致。此要求应在一期实施计划中与最终骰子选型一起落到 `gamePresenter` 事件时序，不得由 UI 自行生成点数。

## 5. 概念稿必须替换为真实数据的部分

概念稿只提供构图和质感，不提供游戏数据。实施必须以 `china-tour@1` 的真实数据为唯一来源：

- 总计 61 格；
- 外围主环：`0–51`；
- 机场支线：`52–60`；
- 所有格子 id、类型、名称、价格、色组、建筑、归属和路径关系一格不改；
- 概念图中的“中卫、张掖、临沂”等城市名和编号均为占位，禁止进入代码或素材文件名；
- 真实支线内容必须按 `board.json` 和现有规则呈现，不能用概念图中的国内城市替代；
- “支线斜穿中央 + 地图剪影 + 虚线航迹”的构图可以采用，但文字和落点必须来自真实地图包。

实施计划必须附一份**61 格逐项对应清单**，至少包含：

| 字段 | 用途 |
|---|---|
| id / route / topology | `route` 是计划清单字段，不是现有 JSON 字段；必须结合数组顺序、特殊 `nextId`、机场 `branchEntryId` 与既有路径规则，确认主环、角格和支线拓扑 |
| type / subtype | 决定普通地产、车站、utility、机会、命运和特殊格的视觉组件 |
| name / subtitle | 替换概念图占位文字并校验地名净空 |
| price / color group | 复用真实价格与色带 |
| dynamic state | 归属、抵押、房屋/旅馆、棋子叠放、当前格 |
| concept element | 指明使用哪类构图、图标或装饰，不允许写“同上”或待定 |

## 6. 素材边界

实施计划必须把素材分成两类并列出文件清单、格式、尺寸预算和复用位置。

### 6.1 可用静态图片的装饰

仅限不随游戏状态变化的视觉底层，例如：

- 纸纹；
- 中国/世界地图剪影；
- 长城、帆船、云纹、罗盘、邮戳、卡背等线稿或装饰；
- 不承载规则、数值或交互的背景图形。

这些素材可以一次性生成，但必须轻量化、可压缩，且不能把地名或状态文字烘焙进图片。

### 6.2 必须由代码绘制的动态内容

- 61 个格子的结构、文字和价格；
- 玩家所有权和抵押状态；
- 1–4 栋房屋与第 5 级旅馆；
- 玩家棋子及同格错位；
- 骰子点数与动画；
- 当前玩家、当前格和交互状态；
- 机会/命运等会随地图包变化的标签。

实现限于 CSS、内联 SVG 和 Web Animations API，不引入 canvas 游戏引擎、重型动画库或新运行时依赖。

## 7. 城市地标图标必须提交的两档方案

一期实施计划必须把下列两档作为 owner 可直接判断的产品选择，并给出按“设计/生成、清理、接入、响应式验证、回归修正”拆分的工时估算：

### 方案 A：41 块地产全套独立地标

- 每块地产一个可辨识的低对比地标或城市剪影；
- 个性最强，但素材制作、地名净空、手机可读性和后续地图维护成本最高；
- 计划中必须说明重复风格控制、无合适地标时的处理和新增地图的维护成本。

### 方案 B：色组通用图标 + 重点格独立地标

- 普通地产按色组/地域复用少量图标；
- 仅北京、长城、故宫、敦煌等重点格使用独立地标；
- 个性略少，但更容易保持统一、减少遮挡，也更符合当前组件化地图包的维护成本。

不要在计划里替 owner 选定。两档都必须有视觉影响、预计工时和长期维护代价，待 owner 评审时拍板。

## 8. 七类硬约束及计划中的落实要求

一期实施计划必须逐条写出“改哪些文件、如何测试、失败时如何判定”，不能只复制口号。

1. **暖纸基因**：沿用米白、暖红、金色、纸纹和轻阴影；先用真实 61 格做宽窗口样张，不能推翻为另一套主题。
2. **轻技术栈**：只用 CSS / SVG / Web Animations，不增加运行时动画依赖，不引入 canvas 游戏引擎。
3. **Presenter 时序不变量**：骰子只展示 authoritative `dice_rolled`；事件动画与最终 snapshot 严格配对；`reset`、`dispose`、重连、独立 snapshot、隐藏标签页恢复必须取消旧动画。
4. **时长与不积压**：骰子约 1 秒；bot 连续回合不排队；新 transition 到达时旧演出失效。
5. **减弱动态效果**：`prefers-reduced-motion` 直接定格；必须有确定性测试，并在支持模拟的真实浏览器/DevTools 补视觉验证。
6. **响应式与可读性**：桌面 `1440×900`、手机 `390×844`、极窄手机 `320×700`；手机无页面横向溢出、按钮高度 ≥44px；保留“聚焦视图默认 + 全局可切换”；任何所有权、建筑、图标和装饰不得遮挡地名。
7. **验证与交付纪律**：focused tests、完整 `pnpm test`、`pnpm typecheck`、`pnpm validate-data`、`pnpm build`、production smoke；本地/联机/reset/重连/隐藏页专项；正式截图保存到 `plan/assets/screenshots/`；棋盘定稿后更新 `plan/02` §4.2/§4.4。

附加零改动边界：一期换肤不得修改 engine、protocol、server、规则或地图数据；若视觉需求真的要求改变这些层，必须停止并回到 owner/评审重新定范围。

## 9. 下一位 agent 的唯一当前交付

在修改任何生产代码前，编写并提交评审：

`docs/superpowers/plans/2026-07-16-visual-board-phase-1.md`

计划至少包含：

1. 真实 61 格与概念稿元素的逐项对应清单；
2. 静态装饰素材与代码绘制内容的完整清单；
3. 城市地标方案 A/B 及可比较的工时估算；
4. 上述七类硬约束逐条落实方式；
5. 精确到文件和测试的 TDD 任务拆分；
6. 桌面、手机聚焦、手机全局、极窄手机的截图与测量 Gate；
7. 比稿基础设施何时保留、何时删除的清理步骤；
8. `plan/02` 和 `plan/09` 的最终同步步骤。

计划交付后必须暂停，等待评审和 owner 对地标方案、骰子方案作出选择。评审通过前不得修改 `GameBoard.vue`、`BoardCell.vue`、`GameView.vue`、`gamePresenter` 或其他生产 UI。

## 10. 明确不在本 worktree 处理的事项

- 联机“请求超时”错误生命周期 bug；
- 世界之旅地图、卡牌或飞书表格；
- 欠款按钮排版；
- 二期外围界面；
- 引擎、协议、服务器、存档和规则变化；
- 自动 commit、push、PR、部署或发布。

这些事项不得顺手混入一期棋盘计划或实现提交。

## 11. 当前已交付基础设施索引

- dev-only 入口：`apps/client/src/main.ts`、`apps/client/src/visual-review/reviewRoute.ts`
- 确定性 fixture：`apps/client/src/visual-review/reviewModel.ts`
- 骰子三案：`apps/client/src/visual-review/DiceMotionReview.vue`
- 临时总页：`apps/client/src/visual-review/VisualPolishReview.vue`
- 旧棋盘比稿：`BoardArtReview.vue`、`FocusArtReview.vue`、`ReviewBuildingIcons.vue`
- 比稿样式：`apps/client/src/visual-review/review.css`
- 测试：`reviewRoute.test.ts`、`reviewModel.test.ts`
- 历史截图：`plan/assets/screenshots/visual-polish/`

dev-only 入口已经验证不会创建游戏、读取存档或连接 Socket.IO。新 agent 可以复用其只读 fixture 做规划和样张，但不得把评审路由当作长期产品功能。

## 12. 已知证据与不可沿用的证据

`visual-polish@a1f92ac` 历史上完成过：

- `65 files / 1102 tests passed`；
- `pnpm typecheck` passed；
- `pnpm build` passed；
- `1440×900` 与 `390×844` 的旧三案截图检查；
- 骰子三案反复重播、定格揭晓和不排队检查。

这些只证明旧比稿提交当时可用，不能作为新一期实现的完成证据。任何代码或素材改动后都必须按第 8 节重新运行对应验证并记录本次实际输出。
