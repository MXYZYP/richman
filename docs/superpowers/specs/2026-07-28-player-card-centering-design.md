# 玩家卡片内容居中重设计

> 日期：2026-07-28
> 分支：player-rail-compact
> 状态：已批准（用户迭代反馈确认方向 A，头像缩小）

## 1. 背景

用户反馈：玩家卡片内容（头像、姓名、现金）当前靠左显示，要求居中。
进一步反馈：希望头像（彩色圆点）也缩小，视觉更轻。

## 2. 目标

让玩家卡片内部内容整体居中，并缩小头像尺寸。桌面与手机统一采用居中逻辑，
但仅在手机断点做紧凑单行处理，桌面保留现有长昵称换行能力。

## 3. 方案

**方案 A：两行居中（已选）**

每张卡片结构不变（头像 + 文字信息两列），但：

- `.player-card`：`justify-content: center`
- `.player-info`：`text-align: center`
- `.player-name`：`justify-content: center`
- 头像仍与姓名同行，但整组随 flex 居中，不再固定贴左

**方案 B（未选）：三行堆叠居中**——头像/姓名/现金各占一行，对称感最强，
但手机四人局过挤，需加高顶部栏。用户未选择。

## 4. 头像尺寸调整

| 场景 | 当前 | 调整后 |
|------|------|--------|
| 桌面 | 34px | 26px |
| 手机 ≤767px | 22px | 16px |
| 手机 ≤350px 四人局 | 18px | 14px |

## 5. 断点行为

### 桌面（>767px）

- `.player-card` 加 `justify-content: center`
- `.player-info` 加 `text-align: center`
- `.player-name` 加 `justify-content: center`
- **保留 `flex-wrap: wrap`**（上轮已修复，不回退）
- 长昵称仍可换行

### 手机（≤767px）

- 上述居中规则同样生效
- `.player-name` 保持 `flex-wrap: nowrap`（手机单行 + 省略号）
- 头像缩到 16px

### 手机 ≤350px 四人局（必须重做）

当前旧特例把四人卡改成 `display: block` + 头像 `position: absolute; left: 4px`
+ 姓名 `margin-left: 22px`，这些绝对定位/左移规则会覆盖通用手机居中，
导致 320px 四人局仍左偏。

**必须重做或删除该特例**：改为让头像与姓名作为一组随 flex 居中，
移除 `display: block` 与 `absolute`/`margin-left` 左偏定位。
现金行同样居中。

## 6. 不变的东西

- 棋盘数据、boardLayout、engine 规则
- `.player-rail` 的 grid/flex 容器结构
- 破产玩家过滤逻辑（visiblePlayers）
- 三人/四人等宽均分逻辑
- cash-notice-track / cash-pill 动画

## 7. 验证

- `pnpm test`（含 PlayerRail.test.ts 居中/四人/破产回归）
- `pnpm --filter @richman/client build`
- 浏览器实测：
  - 桌面 1440×900 四人局：内容居中，长昵称可换行
  - 390px 三人/四人：内容居中，无横向滚动
  - **320px 四人：内容居中，现金完整**（≤350px 特例重做后重点复测）
