# 本机 BOT 自动行动误暂停修复设计

日期：2026-07-13
状态：已批准方案，待实施

## 1. 问题

本机热座模式在 `apps/client/src/session/localSession.ts` 中用 `consecutiveBotActions` 统计轮到真人前发生的全部 BOT intent。计数达到 20 后，自动行动直接停止并显示“电脑自动行动次数过多，已暂停”。

该计数无法区分正常推进与异常重试。以下合法流程都可能超过 20 次：

- 真人停走期间，相邻 BOT 连续完成多轮；
- BOT 欠款后连续卖房、抵押或卖地；
- 真人破产后，剩余 BOT 继续比赛直至最后一位未破产玩家获胜。

暂停后当前 actor 仍是 BOT，真人 intent 会被拒绝，页面也没有恢复自动行动的入口，导致本局永久卡死。

另一个缺陷是：自动 `sendIntent` 当前不返回提交结果。即使 `applyIntent` 返回 `ok: false`、状态没有推进，外层仍将 `appliedBotIntent` 设为 `true` 并继续调度。

## 2. 已确认行为

采用方案 A：

1. 成功的 BOT intent 不受固定次数限制。
2. 自动行动持续到以下任一条件成立：
   - 轮到真人；
   - 游戏进入 `game_over`；
   - session 被 dispose；
   - generation 失效；
   - BOT intent 第一次被规则引擎拒绝。
3. `applyIntent` 第一次返回 `ok: false` 时立即停止自动调度，保留对应的具体错误，不重试同一 intent。
4. 不增加“连续失败 N 次”的阈值。`chooseBotIntent` 是确定性纯函数；同一引擎状态没有变化时，重试只会再次选择同一 intent 并得到同一失败。
5. 真人破产但仍有多个 BOT 存活时，BOT 继续比赛，直到规则引擎产生最终胜者。
6. 保留 BOT 每个动作现有的 0.8–1.6 秒等待节奏。

该行为与在线模式 `apps/server/src/rooms/roomManager.ts` 一致：自动提交第一次失败时立即清除自动调度。

## 3. 最小实现边界

只修改本机 session 自动行动及其测试，预计涉及：

- `apps/client/src/session/localSession.ts`
- `apps/client/src/session/localSession.test.ts`
- 如现有测试组织更合适，可补充 `apps/client/src/game/clientGame.test.ts`

不修改：

- `chooseBotIntent` 策略；
- 规则引擎的回合、债务、破产或胜利条件；
- 棋盘和卡牌数据；
- 在线房间自动行动；
- UI 布局与视觉样式；
- 公开 `GameSession.sendIntent(intent): Promise<void>` 契约。

## 4. 控制流设计

### 4.1 私有提交结果

本机 session 内部增加一个私有结果通道，例如私有 `applyLocalIntent`，返回“是否已被规则引擎成功提交”。公共 `sendIntent` 仍返回 `Promise<void>`，只调用私有函数并丢弃内部结果。

“已提交”的唯一判据是：

```text
applyIntent(...).ok === true
```

不能把以下情况误当成提交成功：

- 异步函数正常返回；
- BOT 等待结束；
- 动画成功结束；
- 没有抛 JavaScript 异常。

### 4.2 成功提交

当 `applyIntent` 返回 `ok: true`：

1. 立即用 `result.state` 更新私有 `engineState`；
2. 播放对应事件；
3. 即使事件展示随后失败，引擎状态仍已推进，保留既有错误记录与后续 BOT 调度语义；
4. BOT 回调允许继续调度下一动作；
5. 不增加任何成功动作计数。

### 4.3 失败提交

当 `applyIntent` 返回 `ok: false`：

1. 不更新 `engineState`；
2. 不更新展示快照；
3. 使用现有 `ERROR_MESSAGES` 写入具体错误；
4. 私有提交函数返回失败；
5. BOT 回调不再调度下一动作；
6. 不用“电脑自动行动次数过多”覆盖原始原因。

### 4.4 生命周期与并发约束

必须保留现有保护：

- `disposed` 检查；
- `botGeneration` 代际检查；
- BOT 延迟结束后重新读取当前 actor；
- `presenter.isAnimating` 栅栏；
- `isBotThinking` 单飞锁；
- `finally` 中的 dispose 与 generation 复核；
- dispose 后不能提交状态、发布快照或再次调度；
- 陈旧回调不能清除新 generation 的思考状态。

移除：

- `consecutiveBotActions`；
- 固定 20 次判断；
- “电脑自动行动次数过多，已暂停”这一误报路径。

## 5. 错误与用户体验

合法 BOT 流程中，用户只看到正常的“电脑思考中”和战报，不再看到基于动作次数的暂停。

只有规则引擎真实拒绝 BOT intent 时才停止。此时保留现有具体中文错误，避免无限重试。新增“重试”“继续”或恢复入口不属于本次修复范围；失败发生时继续允许用户使用现有“重新开局”或离开流程。

## 6. 回归测试

实施前先增加能在当前代码上失败的测试，至少覆盖：

1. 连续超过 20 个成功 BOT intent 不会触发暂停；
2. 真人停走时，相邻两个 BOT 完成合法行动后能回到真人；
3. 单个 BOT 在同一笔债务中连续卖房、抵押或卖地，超过旧阈值仍能完成清算；
4. 真人破产后，剩余 BOT 可以继续到 `game_over`；
5. BOT intent 第一次被 `applyIntent` 拒绝后：
   - planner 与 apply 各只调用一次；
   - 引擎状态和展示快照不变；
   - `isBotThinking` 复位；
   - 具体错误保留；
   - 清空微任务后没有第二次自动调用；
6. 成功提交后若 presenter 动画失败，引擎状态仍推进，并保持现有调度语义；
7. 延迟期间 dispose、陈旧 generation、重复调用自动驱动和动画期间触发都不会产生重复提交；
8. `GameSession.sendIntent` 仍保持 `Promise<void>`。

## 7. 验收

自动化验证：

- 新增失败测试在旧实现上确实失败；
- 修复后相关 session/client 测试通过；
- 客户端 typecheck 通过；
- 客户端 production build 通过；
- 风险允许时再运行全量测试。

真实浏览器验证使用手机视口 `390×844`：

- 默认 1 真人 + 2 BOT；
- BOT 合法连续行动超过旧的 20 次阈值；
- 不出现“电脑自动行动次数过多，已暂停”；
- 自动流程最终回到真人或进入胜利结算；
- 页面不存在 BOT actor 卡住但真人又无法操作的状态。
