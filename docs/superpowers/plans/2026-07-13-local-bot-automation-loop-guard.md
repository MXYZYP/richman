# Local BOT Automation Loop Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让本机热座中任意数量的成功 BOT 动作持续到真人或终局，并在第一个被规则引擎拒绝的 BOT intent 上立即停止且保留具体错误。

**Architecture:** 在 `localSession.ts` 内增加私有提交结果通道，公共 `GameSession.sendIntent(): Promise<void>` 保持不变。BOT 调度只根据 `applyIntent(...).ok` 判断是否继续；删除固定 20 次计数。使用真实规则引擎覆盖长合法链，并用隔离的 Vitest module mock 覆盖确定性失败只执行一次。

**Tech Stack:** TypeScript, Vue 3 refs, Vitest, `@richman/engine`, Vite browser app

**Design spec:** `docs/superpowers/specs/2026-07-13-local-bot-automation-loop-guard-design.md`

---

## File map

- Modify: `apps/client/src/session/localSession.ts` — 区分 intent 已提交与被拒绝，控制 BOT 后续调度。
- Modify: `apps/client/src/session/localSession.test.ts` — 使用真实引擎验证真人停走、长 BOT 链和真人破产后的 BOT 决赛。
- Create: `apps/client/src/session/localSession.botFailure.test.ts` — 隔离 mock `applyIntent`，验证第一次失败立即熔断且不改变公开快照。

不修改规则引擎、BOT 策略、在线 roomManager、公开 GameSession 接口或 UI 样式。

### Task 1: Lock the legal long-chain regression

**Files:**
- Modify: `apps/client/src/session/localSession.test.ts`

- [ ] **Step 1: Import the real BOT planner and state type**

在现有 imports 中增加：

```ts
import { chooseBotIntent, type GameState } from '@richman/engine';
```

- [ ] **Step 2: Add a deterministic session driver helper**

在测试 helper 区增加：

```ts
async function driveSessionWithBotStrategy(
  session: LocalSession,
  stop: () => boolean,
  maxSteps = 3_000,
): Promise<void> {
  for (let step = 0; step < maxSteps && !stop(); step += 1) {
    await Promise.resolve();
    await Promise.resolve();
    if (session.lastError.value || session.state.value.phase === 'game_over') return;

    const state = session.state.value;
    const actorId = state.debt?.debtorId ?? state.currentPlayerId;
    const actor = state.players.find((player) => player.id === actorId);
    if (!actor) throw new Error(`Missing actor ${actorId}`);

    if (actor.isBot) {
      await session.runBotTurnIfNeeded();
      continue;
    }

    const intent = chooseBotIntent(state as unknown as GameState, actorId);
    await session.sendIntent(intent);
  }
}
```

该 helper 只用 planner 为真人测试位选择合法动作；真正的 BOT 仍由 `localSession` 自己调度。

- [ ] **Step 3: Add the skipped-human long-burst test**

在 `describe('createLocalSession')` 中增加：

```ts
it('returns to a skipped human after more than twenty successful BOT intents', async () => {
  const botDelay = 7_319;
  let currentBurst = 0;
  let longestBurst = 0;
  let sawHumanSkip = false;
  const session = createLocalSession({
    autoPlayBots: true,
    botDelay: () => botDelay,
    wait: async (ms) => {
      if (ms === botDelay) currentBurst += 1;
    },
    players: [
      { id: 'human', nickname: '玩家一' },
      { id: 'bot-a', nickname: '电脑A', isBot: true },
      { id: 'bot-b', nickname: '电脑B', isBot: true },
    ],
    seed: '83',
  });

  await driveSessionWithBotStrategy(session, () => {
    const state = session.state.value;
    const human = state.players.find((player) => player.id === 'human');
    sawHumanSkip ||= (human?.skipTurns ?? 0) > 0;
    const actorId = state.debt?.debtorId ?? state.currentPlayerId;
    const actor = state.players.find((player) => player.id === actorId);
    if (actor?.isBot) return false;
    longestBurst = Math.max(longestBurst, currentBurst);
    if (sawHumanSkip && longestBurst > 20) return true;
    currentBurst = 0;
    return false;
  });

  longestBurst = Math.max(longestBurst, currentBurst);
  const state = session.state.value;
  const actorId = state.debt?.debtorId ?? state.currentPlayerId;

  expect(sawHumanSkip).toBe(true);
  expect(longestBurst).toBeGreaterThan(20);
  expect(actorId).toBe('human');
  expect(session.lastError.value).toBeNull();
  session.dispose();
});
```

- [ ] **Step 4: Add the human-bankruptcy BOT-final test**

```ts
it('continues a BOT-only final after the human goes bankrupt', async () => {
  const session = createLocalSession({
    autoPlayBots: true,
    botDelay: () => 7_319,
    wait: async () => undefined,
    players: [
      { id: 'human', nickname: '玩家一' },
      { id: 'bot-a', nickname: '电脑A', isBot: true },
      { id: 'bot-b', nickname: '电脑B', isBot: true },
    ],
    seed: '2',
  });
  let sawHumanBankruptcy = false;

  await driveSessionWithBotStrategy(session, () => {
    const human = session.state.value.players.find((player) => player.id === 'human');
    sawHumanBankruptcy ||= human?.bankrupt === true;
    return session.state.value.phase === 'game_over';
  });

  expect(sawHumanBankruptcy).toBe(true);
  expect(session.state.value.phase).toBe('game_over');
  expect(session.state.value.winnerId).toMatch(/^bot-/);
  expect(session.lastError.value).toBeNull();
  session.dispose();
});
```

- [ ] **Step 5: Run the long-chain tests against the old implementation**

Run:

```bash
pnpm exec vitest run apps/client/src/session/localSession.test.ts
```

Expected before the fix: at least the new long-chain tests fail with `电脑自动行动次数过多，已暂停`, a burst capped at 20, or a non-terminal BOT actor.

### Task 2: Lock the first-rejection regression

**Files:**
- Create: `apps/client/src/session/localSession.botFailure.test.ts`

- [ ] **Step 1: Add an isolated engine mock**

Create the file with:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const engineMocks = vi.hoisted(() => ({
  applyIntent: vi.fn(),
}));

vi.mock('@richman/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@richman/engine')>();
  return { ...actual, applyIntent: engineMocks.applyIntent };
});

import { createLocalSession } from './localSession';

describe('local BOT rejected-intent guard', () => {
  beforeEach(() => {
    engineMocks.applyIntent.mockReset();
    engineMocks.applyIntent.mockReturnValue({ ok: false, code: 'ILLEGAL_INTENT' });
  });

  it('stops after the first rejected deterministic BOT intent', async () => {
    const botDelay = 9_991;
    let delayCount = 0;
    const session = createLocalSession({
      autoPlayBots: true,
      botDelay: () => botDelay,
      wait: async (ms) => {
        if (ms === botDelay) delayCount += 1;
      },
      players: [
        { id: 'bot-a', nickname: '电脑A', isBot: true },
        { id: 'bot-b', nickname: '电脑B', isBot: true },
      ],
      seed: 'rejected-bot-intent',
    });
    const before = structuredClone(session.state.value);

    await session.runBotTurnIfNeeded();
    for (let index = 0; index < 100; index += 1) await Promise.resolve();

    expect(engineMocks.applyIntent).toHaveBeenCalledTimes(1);
    expect(delayCount).toBe(1);
    expect(session.state.value).toEqual(before);
    expect(session.isBotThinking.value).toBe(false);
    expect(session.lastError.value).toBe('这个操作现在不可用');
    session.dispose();
  });
});
```

- [ ] **Step 2: Run the rejected-intent test against the old implementation**

Run:

```bash
pnpm exec vitest run apps/client/src/session/localSession.botFailure.test.ts
```

Expected before the fix: FAIL because `applyIntent` and BOT delay are repeated until the old 20-action cap, and the specific error is overwritten by `电脑自动行动次数过多，已暂停`.

### Task 3: Implement the private commit result

**Files:**
- Modify: `apps/client/src/session/localSession.ts`

- [ ] **Step 1: Remove the fixed successful-action counter**

Delete:

```ts
let consecutiveBotActions = 0;
```

Delete the human-reset and fixed-cap block from `runBotTurnIfNeeded`:

```ts
if (!actor?.isBot) {
  consecutiveBotActions = 0;
  return;
}
if (consecutiveBotActions >= 20) {
  lastError.value = '电脑自动行动次数过多，已暂停';
  return;
}
```

Replace it with:

```ts
if (!actor?.isBot) return;
```

Delete:

```ts
consecutiveBotActions += 1;
```

- [ ] **Step 2: Split public sending from the private commit result**

Rename the current internal implementation to `applyLocalIntent` and return whether the rules engine accepted the intent:

```ts
async function applyLocalIntent(intent: Intent, automated: boolean): Promise<boolean> {
  if (disposed) return false;
  if (presenter.isAnimating.value || (isBotThinking.value && !automated)) {
    lastError.value = isBotThinking.value ? '电脑玩家正在自动行动' : '动画播放中，请稍候';
    return false;
  }
  const actor = getActor(engineState);
  if (autoPlayBots && actor?.isBot && !automated) {
    lastError.value = '电脑玩家正在自动行动';
    return false;
  }
  if (engineState.debt && !canSendDuringDebt(intent)) {
    lastError.value = '债务中只能卖房或抵押筹款';
    return false;
  }

  const result = applyIntent(engineState, getActorId(engineState), intent);
  if (!result.ok) {
    lastError.value = ERROR_MESSAGES[result.code] ?? result.code;
    return false;
  }

  engineState = result.state;
  try {
    await presenter.playEvents(result.events, toRenderableGameState(result.state));
    if (!disposed && !automated) lastError.value = null;
  } catch (error) {
    if (!disposed) recordError(error);
  } finally {
    if (!disposed) scheduleBotTurnIfNeeded();
  }
  return true;
}

async function sendIntent(intent: Intent): Promise<void> {
  await applyLocalIntent(intent, false);
}
```

`true` 表示引擎已经提交，即使 presenter 后续报错也不能改回失败；公开 `sendIntent` 仍为 `Promise<void>`。

- [ ] **Step 3: Gate BOT rescheduling on the real commit result**

把 BOT 回调中的无条件标记：

```ts
await sendIntent(chooseBotIntent(engineState, latestActor.id), true);
appliedBotIntent = true;
```

替换为：

```ts
appliedBotIntent = await applyLocalIntent(
  chooseBotIntent(engineState, latestActor.id),
  true,
);
```

保留 finally 中现有的 dispose/generation 检查、`isBotThinking = false` 和：

```ts
if (appliedBotIntent) scheduleBotTurnIfNeeded();
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm exec vitest run \
  apps/client/src/session/localSession.test.ts \
  apps/client/src/session/localSession.botFailure.test.ts \
  apps/client/src/game/clientGame.test.ts
```

Expected: all focused tests PASS; no `电脑自动行动次数过多，已暂停` assertion or runtime error.

- [ ] **Step 5: Run client typecheck and build**

Run:

```bash
pnpm --filter @richman/client exec vue-tsc --noEmit
pnpm --filter @richman/client build
```

Expected: both commands exit 0; `GameSession.sendIntent` remains compatible with `Promise<void>`.

### Task 4: Verify the real behavior

**Files:**
- No source changes unless verification exposes a defect within this spec.

- [ ] **Step 1: Run the complete test suite**

Run:

```bash
pnpm test
pnpm typecheck
pnpm validate-data
pnpm build
```

Expected: all existing tests, workspace typechecks, board-data validation, client build and server build pass.

- [ ] **Step 2: Start the real client and inspect mobile behavior**

Run the client on a local port, open it at `390×844`, create the default 1-human + 2-BOT hot-seat game, and accelerate only timer waits through browser instrumentation when needed.

Verify:

- BOT thinking and battle-log messages continue normally;
- a BOT turn returns control to the human;
- no `电脑自动行动次数过多，已暂停` message appears;
- controls remain locked only while a BOT is actually acting;
- dispose/restart cancels pending automation.

- [ ] **Step 3: Use the deterministic long-chain test as threshold proof**

Because the production UI intentionally creates a random seed, use the seed-83 integration test output as the deterministic proof that a 21+ action legal burst completes. Do not add a production seed/debug query parameter solely for QA.

- [ ] **Step 4: Record final evidence**

Report:

- files changed;
- focused test counts;
- full-suite test counts;
- typecheck/build/data-validation results;
- mobile browser scenario and whether the action panel returned to the human;
- any unverified condition with its exact reason.

No commit, branch, push or PR is part of this plan unless the owner explicitly requests it.
