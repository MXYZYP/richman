# PublicGameSnapshot 安全投影设计

## 目标

在任何游戏快照离开服务器前移除可预测未来随机结果的信息：

- 不公开引擎 RNG 状态 `seed`；
- 不公开 `decks.chance` / `decks.destiny` 的抽牌队列顺序；
- 可公开两类牌堆当前张数，供未来 UI 展示；
- 初始、回合边界、结算和断线恢复快照必须使用同一公开结构；
- 内部规则引擎、RoomManager、BOT 与离线托管继续使用完整 `GameState`。

客户端抽牌展示继续由 `card_drawn` 事件驱动，不依赖 `seed` 或牌堆队列。

## 公开类型

在服务器协议层定义：

```ts
export type PublicGameSnapshot = Omit<GameState, 'seed' | 'decks'> & {
  deckCounts: {
    chance: number;
    destiny: number;
  };
};
```

`deckCounts` 使用新字段名，避免与内部 `GameState.decks` 的有序字符串数组产生同名异义。

静态 `cards` 数据仍可公开；它描述卡牌定义，不表示洗牌后的抽取顺序。

## 唯一投影函数

协议边界提供一个纯函数：

```ts
export function toPublicGameSnapshot(state: GameState): PublicGameSnapshot;
```

投影规则：

1. 删除 `seed`；
2. 删除 `decks`；
3. 写入 `deckCounts.chance = state.decks.chance.length`；
4. 写入 `deckCounts.destiny = state.decks.destiny.length`；
5. 其余字段保持当前结构与引用语义，不修改内部状态。

投影函数不得修改传入的 `GameState`。

## 边界与数据流

内部边界保持不变：

- `Room.gameState` 仍是完整 `GameState`；
- `RoomManager.getGameSnapshot()` 仍返回内部完整状态，供服务器测试和同步逻辑使用；
- `RoomDomainEvent.game_snapshot` 仍可携带内部 `GameState`，但不得直接写到 wire。

公共 wire 边界统一投影：

1. `ServerToClientEvents['game:snapshot']` 的 `state` 类型改为 `PublicGameSnapshot`；
2. `ResumeAck.snapshot` 类型改为 `PublicGameSnapshot`；
3. `dispatchDomainEvents()` 处理 `game_snapshot` 时调用唯一投影函数；
4. deferred `session:resume` ack 在真正发送时读取最新内部快照，再调用同一投影函数；
5. `game_over` 结算快照沿用 `game_snapshot` 分支，不创建第二套投影逻辑。

这样可以保留当前 resume freshness 修复：并发 transition 发生后，ack 仍以发送时的最新状态为准，同时不会泄露内部随机信息。

## 测试

新增安全回归断言，参照现有 token 隔离测试：

- 对真实 Socket.IO `game:snapshot` payload 序列化；
- 序列化结果不包含 `"seed"`；
- 序列化结果不包含内部 `"decks"`；
- `deckCounts` 精确等于内部两个队列的长度且两个值均为数字；
- 对 `session:resume` 返回的 snapshot 应用同一断言；
- 保留现有 token 隔离、事件顺序、resume freshness 与最终结算测试。

类型检查必须证明客户端协议只能看到 `PublicGameSnapshot`，而不是完整 `GameState`。

## 文档

更新 `plan/03-架构与联机协议.md` §5.2：

- `game:snapshot` 载荷写为 `{state: PublicGameSnapshot}`；
- 明确不下发 `seed` 与洗牌后的队列顺序；
- 明确只以 `deckCounts` 公开张数；
- 明确实际抽牌结果以 `card_drawn` 事件为准。

## 非目标

- 不修改纯规则引擎或 `GameState`；
- 不修改随机、洗牌、抽牌逻辑；
- 不新增客户端 UI；
- 不改持久化格式；
- 不隐藏静态棋盘、卡牌定义或当前已公开的玩家/地产/日志信息。
