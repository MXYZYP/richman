# World Tour Card Titles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为世界之旅 23 张机会卡和 22 张命运卡补齐主题标题，并在抽卡预览中按“牌堆类型 → 标题 → 结算规则”展示，同时保持中国之旅卡牌和全部规则行为不变。

**Architecture:** 在共享 `Card` 数据契约中增加可选的纯展示字段 `title`，由地图包校验器验证、由权威快照原样携带，再由 `GamePresenter` 投影到 `DisplayCard`。`ActionPanel` 仅在标题存在时增加标题层级；engine、规则模块、协议事件、牌库顺序和动画时序均不修改。世界之旅地图内容变化后更新其 canonical SHA-256 hash，使 registry、联机 exact-map 校验和存档兼容性继续使用同一份版本化地图引用。

**Tech Stack:** TypeScript、Vue 3、Vue SSR、Vitest、pnpm、版本化 MapPack canonical hash

---

## Approved source and scope

- 批准设计：`docs/superpowers/specs/2026-07-17-world-tour-card-titles-design.md`
- 标题来源：飞书工作簿 revision 41，“机会卡”23 张、“命运卡”22 张的“卡片正文”第一个冒号之前。
- `title` 只用于展示；现有 `text` 和 `effect` 一字不改。
- 中国之旅卡牌继续省略 `title`，旧单段显示保持不变。
- 不修改 engine、server、protocol、牌库数量、洗牌顺序、抽卡停留时间或世界之旅规则模块。
- 不向飞书写回数据，不录入说明列和线下背景文字。

## File responsibility map

- `packages/board-data/src/types.ts`：共享卡牌数据契约，新增可选 `title`。
- `packages/board-data/src/mapValidation.ts`：验证标题存在时为去除首尾空白后仍非空的字符串。
- `packages/board-data/src/__tests__/mapValidation.test.ts`：覆盖合法标题、空标题、纯空白标题和非字符串标题。
- `packages/board-data/maps/world-tour/v1/cards.json`：保存 45 个已批准主题标题；现有规则文字和 effect 保持原值。
- `packages/board-data/maps/world-tour/v1/manifest.json`：保存标题加入 canonical 内容后的新 hash。
- `packages/board-data/src/__tests__/worldTourMap.test.ts`：锁定 45 个标题、现有规则文字、effect、数量和新 hash 的有效性。
- `apps/client/src/game/clientGame.ts`：让 `DisplayCard` 可携带可选标题。
- `apps/client/src/session/gamePresenter.ts`：从权威快照读取标题，不在 client 拆分或推导文案。
- `apps/client/src/session/gamePresenter.test.ts`：覆盖世界之旅有标题、中国之旅无标题、缺卡兜底三种投影。
- `apps/client/src/game/clientGame.test.ts`：在真实本地 session 抽卡链路中确认可选标题与权威卡牌一致。
- `apps/client/src/components/ActionPanel.vue`：渲染标题与规则两级文字，并保留无标题布局。
- `apps/client/src/components/ActionPanel.test.ts`：用 Vue SSR 验证有标题和无标题两种 DOM 输出。

### Task 1: Extend and validate the optional card-title contract

**Files:**
- Modify: `packages/board-data/src/__tests__/mapValidation.test.ts`
- Modify: `packages/board-data/src/types.ts`
- Modify: `packages/board-data/src/mapValidation.ts`

- [ ] **Step 1: Write the failing validator regression test**

在 `packages/board-data/src/__tests__/mapValidation.test.ts` 中加入：

```ts
it('接受可选的非空卡牌标题，并拒绝空白或非字符串标题', () => {
  const titled: any = makeMinimalMap();
  titled.game.cards.chance[0].title = 'Signal Boost';
  expect(() => assertValidMapPack(
    rehash(titled),
    [{ id: 'core', version: 1 }],
  )).not.toThrow();

  for (const invalidTitle of ['', '   ', 42]) {
    const invalid: any = makeMinimalMap();
    invalid.game.cards.chance[0].title = invalidTitle;
    expect(() => assertValidMapPack(
      rehash(invalid),
      [{ id: 'core', version: 1 }],
    )).toThrow(/game\.cards\.chance\[0\]\.title.*non-empty string/i);
  }
});
```

- [ ] **Step 2: Run the validator test and confirm RED**

Run:

```bash
pnpm exec vitest run packages/board-data/src/__tests__/mapValidation.test.ts
```

Expected: FAIL；非法标题当前会被忽略，`toThrow` 断言不成立。

- [ ] **Step 3: Add the optional field and minimal validation**

把 `packages/board-data/src/types.ts` 中的 `Card` 改为：

```ts
export interface Card {
  id: string;
  title?: string;
  text: string;
  effect: CellEffect;
}
```

在 `packages/board-data/src/mapValidation.ts` 的卡牌循环中，完成 `id` 校验后、`text` 校验前加入：

```ts
assertOptionalText(card.title, `${path}.title`);
```

复用现有 `assertOptionalText`，不增加 World Tour 专用 validator，也不要求所有地图都必须提供标题。

- [ ] **Step 4: Run the focused validator and type checks**

Run:

```bash
pnpm exec vitest run packages/board-data/src/__tests__/mapValidation.test.ts
pnpm --filter @richman/board-data typecheck
```

Expected: validator test file PASS；board-data typecheck PASS。

- [ ] **Step 5: Commit the contract slice**

```bash
git add packages/board-data/src/types.ts packages/board-data/src/mapValidation.ts packages/board-data/src/__tests__/mapValidation.test.ts
git commit -m "feat: validate optional card titles"
```

### Task 2: Lock and populate all 45 World Tour titles

**Files:**
- Modify: `packages/board-data/src/__tests__/worldTourMap.test.ts`
- Modify: `packages/board-data/maps/world-tour/v1/cards.json`

- [ ] **Step 1: Add the complete title oracle to the data test**

在 `packages/board-data/src/__tests__/worldTourMap.test.ts` 的 `expectedChance` 之前加入：

```ts
const expectedChanceTitles = {
  C01: '罗马斗兽场涂写罚款',
  C02: '参观大英博物馆',
  C03: '吴哥窟导游服务',
  C04: '东非大裂谷考古发现',
  C05: '伊斯坦布尔冰淇淋体验',
  C06: '东京动漫授权收益',
  C07: '首尔演唱会门票',
  C08: '上海国际贸易订单',
  C09: '俄罗斯寒潮造成房产维修',
  C10: '胡志明市咖啡出口',
  C11: '印度尼西亚救援航班',
  C12: '班加罗尔软件项目',
  C13: '尼罗河游船费用',
  C14: '巴黎艺术沙龙收益',
  C15: '德国高速公路维修',
  C16: '加拿大暴风雪',
  C17: '纽约百老汇庆典',
  C18: '墨西哥城快速列车',
  C19: '加拿大机票',
  C20: '北京国际转机',
  C21: '新加坡观光巴士',
  C22: '欧洲短途航班',
  C23: '北京环球航线',
} as const;

const expectedDestinyTitles = {
  D01: '招待亲友入住八星级酋长国宫殿酒店',
  D02: '投资香榭丽舍大道精品连锁店',
  D03: '获得日本新干线世界之旅联票',
  D04: '中国深圳科技项目成功转化',
  D05: '北冰洋科考设备损坏',
  D06: '搭乘俄罗斯西伯利亚铁路',
  D07: '租用新加坡滨海湾会展场地',
  D08: '参加印度新德里国际文化节',
  D09: '使用土耳其安卡拉航空里程',
  D10: '埃及考古项目获得研究补助',
  D11: '印度洋风暴造成房产损坏',
  D12: '法国航空交通罢工',
  D13: '与德国企业达成工业合作',
  D14: '前往挪威领取国际和平奖',
  D15: '美国跨国企业反垄断和解',
  D16: '借助大西洋顺风航线',
  D17: '巴西农产品出口行情上涨',
  D18: '国际航班改降泰国曼谷机场',
  D19: '南极洲科考队紧急救援',
  D20: '完成环球旅行',
  D21: '拉斯维加斯骰子赛',
  D22: '华盛顿银行援助',
} as const;
```

把现有“locks the owner-approved 23 chance and 22 destiny rules”断言改为同时锁定标题，但继续复用现有 `expectedChance` / `expectedDestiny` 规则 oracle：

```ts
it('locks the owner-approved 23 chance and 22 destiny titles and rules', () => {
  const cards = readMapJson('cards.json');

  expect(cards.chance.map((card: any) => [
    card.id,
    card.title,
    card.text,
    card.effect,
  ])).toEqual(expectedChance.map(([id, text, effect]) => [
    id,
    expectedChanceTitles[id],
    text,
    effect,
  ]));
  expect(cards.destiny.map((card: any) => [
    card.id,
    card.title,
    card.text,
    card.effect,
  ])).toEqual(expectedDestiny.map(([id, text, effect]) => [
    id,
    expectedDestinyTitles[id],
    text,
    effect,
  ]));
  expect(cards.chance).toHaveLength(23);
  expect(cards.destiny).toHaveLength(22);
});
```

- [ ] **Step 2: Run the World Tour data test and confirm RED**

Run:

```bash
pnpm exec vitest run packages/board-data/src/__tests__/worldTourMap.test.ts
```

Expected: FAIL；45 张现有 JSON 卡牌尚未提供 `title`。

- [ ] **Step 3: Insert the approved titles without changing rules**

在 `packages/board-data/maps/world-tour/v1/cards.json` 的每张卡中，把字段顺序统一为 `id`、`title`、`text`、`effect`。例如：

```json
{
  "id": "C01",
  "title": "罗马斗兽场涂写罚款",
  "text": "向银行支付1500元",
  "effect": { "type": "pay_bank", "amount": 1500 }
}
```

45 张卡的 `title` 必须逐项使用 Step 1 的完整 oracle。不得改写任何现有 `text`、`effect`、卡牌 ID、数组顺序或牌库数量。

- [ ] **Step 4: Prove the only card-data delta is the new title field**

Run:

```bash
git diff -- packages/board-data/maps/world-tour/v1/cards.json packages/board-data/src/__tests__/worldTourMap.test.ts
```

Expected: JSON 的每张卡只新增 `title`；测试只新增标题 oracle 和标题断言，现有 45 条规则 oracle 保持原值。

### Task 3: Refresh the immutable World Tour content hash

**Files:**
- Modify: `packages/board-data/maps/world-tour/v1/manifest.json`
- Test: `packages/board-data/src/__tests__/worldTourMap.test.ts`
- Test: `packages/board-data/src/__tests__/registry.test.ts`

- [ ] **Step 1: Confirm the stale hash fails after the title data change**

Run:

```bash
pnpm exec vitest run packages/board-data/src/__tests__/worldTourMap.test.ts packages/board-data/src/__tests__/registry.test.ts
```

Expected: FAIL with `ref.contentHash does not match canonical map content`，证明标题已经进入 canonical MapPack 内容。

- [ ] **Step 2: Recompute the canonical hash from the actual changed pack**

Run:

```bash
pnpm exec tsx -e "import { computeContentHash } from './packages/board-data/src/hash.ts'; import { worldTourMap } from './packages/board-data/src/worldTourMap.ts'; console.log(computeContentHash(worldTourMap));"
```

Expected exact output:

```text
394ba177b54978b8a7abd01da23c858a63bbf06b87b6905b74af1120d8f16801
```

- [ ] **Step 3: Update only the World Tour manifest hash**

把 `packages/board-data/maps/world-tour/v1/manifest.json` 中的 `ref.contentHash` 改为：

```json
"contentHash": "394ba177b54978b8a7abd01da23c858a63bbf06b87b6905b74af1120d8f16801"
```

catalog、server 房间和 client map resolver 都从 `worldTourMap.ref` 派生 exact ref，不增加第二份手写 hash。

- [ ] **Step 4: Run the full board-data focused gate**

Run:

```bash
pnpm exec vitest run packages/board-data/src/__tests__/mapValidation.test.ts packages/board-data/src/__tests__/worldTourMap.test.ts packages/board-data/src/__tests__/registry.test.ts packages/board-data/src/__tests__/hash.test.ts
pnpm validate-data
pnpm --filter @richman/board-data typecheck
```

Expected: all commands PASS；`validate-data` reports China Tour 15/15 and World Tour 23/22 without stale-hash errors。

- [ ] **Step 5: Commit the World Tour data slice**

```bash
git add packages/board-data/maps/world-tour/v1/cards.json packages/board-data/maps/world-tour/v1/manifest.json packages/board-data/src/__tests__/worldTourMap.test.ts
git commit -m "feat: add world tour card titles"
```

### Task 4: Carry the title through the authoritative presenter path

**Files:**
- Modify: `apps/client/src/game/clientGame.ts`
- Modify: `apps/client/src/session/gamePresenter.ts`
- Modify: `apps/client/src/session/gamePresenter.test.ts`
- Modify: `apps/client/src/game/clientGame.test.ts`

- [ ] **Step 1: Add RED tests for titled, untitled, and missing-card events**

在 `apps/client/src/session/gamePresenter.test.ts` 中增加 World Tour pack 和 snapshot helper：

```ts
const worldMap = getActiveMapPack('world-tour');

function createWorldTourSnapshot(seed = 'world-card-title'): RenderableGameState {
  return resolveLocalGameState(createGame({
    mapRef: worldMap.ref,
    ruleModules: worldMap.game.requiredRuleModules,
    board: worldMap.game.board,
    cards: worldMap.game.cards,
    config: worldMap.game.config,
    seed,
    players: [
      { id: 'p1', nickname: '玩家一' },
      { id: 'p2', nickname: '玩家二' },
    ],
  }));
}
```

在 `card_drawn` 测试组中加入：

```ts
it('World Tour card_drawn preserves title and settlement text', async () => {
  const snapshot = createWorldTourSnapshot();
  const card = snapshot.cards.chance[0]!;
  const presenter = createGamePresenter(snapshot, async () => undefined);

  await presenter.playEvents([
    { type: 'card_drawn', playerId: 'p1', deck: 'chance', cardId: card.id },
  ], snapshot);

  expect(presenter.activeCard.value).toEqual({
    deck: 'chance',
    cardId: card.id,
    title: card.title,
    text: card.text,
  });
});

it('China Tour card_drawn keeps the legacy title-less shape', async () => {
  const snapshot = createTestSnapshot();
  const card = snapshot.cards.chance[0]!;
  const presenter = createGamePresenter(snapshot, async () => undefined);

  await presenter.playEvents([
    { type: 'card_drawn', playerId: 'p1', deck: 'chance', cardId: card.id },
  ], snapshot);

  expect(presenter.activeCard.value).toEqual({
    deck: 'chance',
    cardId: card.id,
    text: card.text,
  });
});

it('unknown card id keeps the existing id fallback without inventing a title', async () => {
  const snapshot = createWorldTourSnapshot();
  const presenter = createGamePresenter(snapshot, async () => undefined);

  await presenter.playEvents([
    { type: 'card_drawn', playerId: 'p1', deck: 'chance', cardId: 'missing-card' },
  ], snapshot);

  expect(presenter.activeCard.value).toEqual({
    deck: 'chance',
    cardId: 'missing-card',
    text: 'missing-card',
  });
});
```

在 `apps/client/src/game/clientGame.test.ts` 的真实抽卡断言中，在 `activeCard.text` 断言旁加入：

```ts
expect(activeCard.title).toBe(card.title);
```

这条现有真实 session 用 China Tour，断言应为 `undefined === undefined`，锁住无标题兼容性。

- [ ] **Step 2: Run the presenter/client session tests and confirm RED**

Run:

```bash
pnpm exec vitest run apps/client/src/session/gamePresenter.test.ts apps/client/src/game/clientGame.test.ts
```

Expected: TypeScript/Vitest FAIL because `DisplayCard` 尚无 `title`，World Tour 预期对象也无法匹配。

- [ ] **Step 3: Extend `DisplayCard` without making title required**

把 `apps/client/src/game/clientGame.ts` 中的类型改为：

```ts
export interface DisplayCard {
  deck: 'chance' | 'destiny';
  cardId: string;
  title?: string;
  text: string;
}
```

- [ ] **Step 4: Copy the authoritative title in `card_drawn` playback**

把 `apps/client/src/session/gamePresenter.ts` 的 `card_drawn` 分支改为：

```ts
case 'card_drawn': {
  const card = snapshot.cards[event.deck].find((candidate) => candidate.id === event.cardId);
  const text = card?.text ?? event.cardId;
  activeCard.value = {
    deck: event.deck,
    cardId: event.cardId,
    ...(card?.title === undefined ? {} : { title: card.title }),
    text,
  };
  eventMessage.value = formatRecentLogEvent(snapshot, event);
  await _wait(CARD_DWELL_MS);
  return;
}
```

不得在 presenter 中按冒号拆分 `text`，不得从 `cardId` 或地图 ID 推导标题。这样本地和联机都只消费权威快照中的同一字段，并保留缺卡兜底。

- [ ] **Step 5: Run the presenter/session tests and typecheck**

Run:

```bash
pnpm exec vitest run apps/client/src/session/gamePresenter.test.ts apps/client/src/game/clientGame.test.ts
pnpm --filter @richman/client exec vue-tsc --noEmit
```

Expected: both test files PASS；client typecheck PASS；现有 event-animation/final-snapshot pairing 测试不回退。

- [ ] **Step 6: Commit the presenter slice**

```bash
git add apps/client/src/game/clientGame.ts apps/client/src/session/gamePresenter.ts apps/client/src/session/gamePresenter.test.ts apps/client/src/game/clientGame.test.ts
git commit -m "feat: present world tour card titles"
```

### Task 5: Render title and rule as separate visual levels

**Files:**
- Create: `apps/client/src/components/ActionPanel.test.ts`
- Modify: `apps/client/src/components/ActionPanel.vue`

- [ ] **Step 1: Create the RED Vue SSR rendering tests**

创建 `apps/client/src/components/ActionPanel.test.ts`：

```ts
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import type { DisplayCard } from '../game/clientGame';
import ActionPanel from './ActionPanel.vue';

async function renderCard(activeCard: DisplayCard): Promise<string> {
  return renderToString(createSSRApp({
    render: () => h(ActionPanel, {
      actions: [],
      dice: null,
      activeCard,
      eventMessage: '等待结算',
      isAnimating: false,
      lastError: null,
      turnTitle: '玩家一',
      purchaseOffer: null,
    }),
  }));
}

describe('ActionPanel card preview', () => {
  it('按牌堆、标题、规则展示 World Tour 卡牌', async () => {
    const html = await renderCard({
      deck: 'chance',
      cardId: 'C01',
      title: '罗马斗兽场涂写罚款',
      text: '向银行支付1500元',
    });

    expect(html).toContain('机会');
    expect(html).toContain('class="card-title"');
    expect(html).toContain('罗马斗兽场涂写罚款');
    expect(html).toContain('class="card-rule"');
    expect(html).toContain('向银行支付1500元');
  });

  it('无标题的 China Tour 卡牌继续使用单段规则布局', async () => {
    const html = await renderCard({
      deck: 'destiny',
      cardId: '72-01',
      text: '前进至北京',
    });

    expect(html).toContain('命运');
    expect(html).not.toContain('class="card-title"');
    expect(html).toContain('class="card-rule"');
    expect(html).toContain('前进至北京');
  });
});
```

- [ ] **Step 2: Run the component test and confirm RED**

Run:

```bash
pnpm exec vitest run apps/client/src/components/ActionPanel.test.ts
```

Expected: FAIL；现有模板没有 `.card-title` 和 `.card-rule` 层级。

- [ ] **Step 3: Add the minimal conditional markup**

把 `apps/client/src/components/ActionPanel.vue` 中卡牌预览改为：

```vue
<article v-if="activeCard" class="card-preview" :class="`card-${activeCard.deck}`" aria-label="抽到的卡牌">
  <div class="card-kicker">{{ activeCard.deck === 'chance' ? '机会' : '命运' }}</div>
  <strong v-if="activeCard.title" class="card-title">{{ activeCard.title }}</strong>
  <p class="card-rule">{{ activeCard.text }}</p>
</article>
```

无标题时不渲染空节点，原来的牌堆类型和规则文字仍存在。

- [ ] **Step 4: Add restrained warm-paper typography**

用以下规则替换现有 `.card-preview p`，不改变卡片容器宽度、颜色主题或展示时长：

```css
.card-title {
  display: block;
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 900;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.card-rule {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
```

`overflow-wrap: anywhere` 只处理超长主题标题在窄屏的换行，不缩小触控控件、不制造横向滚动。

- [ ] **Step 5: Run component and client focused tests**

Run:

```bash
pnpm exec vitest run apps/client/src/components/ActionPanel.test.ts apps/client/src/session/gamePresenter.test.ts apps/client/src/game/clientGame.test.ts apps/client/src/components/boardRendering.test.ts
pnpm --filter @richman/client exec vue-tsc --noEmit
```

Expected: all focused tests PASS；client typecheck PASS。

- [ ] **Step 6: Commit the component slice**

```bash
git add apps/client/src/components/ActionPanel.vue apps/client/src/components/ActionPanel.test.ts
git commit -m "feat: render titled card previews"
```

### Task 6: Run full automated verification and both-map simulations

**Files:**
- Verify only; no production files should be added in this task.

- [ ] **Step 1: Run the consolidated focused regression gate**

Run:

```bash
pnpm exec vitest run packages/board-data/src/__tests__/mapValidation.test.ts packages/board-data/src/__tests__/worldTourMap.test.ts packages/board-data/src/__tests__/registry.test.ts packages/board-data/src/__tests__/hash.test.ts apps/client/src/session/gamePresenter.test.ts apps/client/src/game/clientGame.test.ts apps/client/src/components/ActionPanel.test.ts apps/client/src/components/boardRendering.test.ts
```

Expected: all listed test files PASS。

- [ ] **Step 2: Run the repository gates**

Run:

```bash
pnpm test
pnpm typecheck
pnpm validate-data
pnpm build
```

Expected: every command exits 0；记录本次实际 test file/test counts，不复用历史数字。

- [ ] **Step 3: Run 500 deterministic games on both formal maps**

Run:

```bash
pnpm --filter @richman/engine simulate:500
pnpm --filter @richman/engine simulate:500 world-tour
```

Expected for each map: `总局数: 500`、`终局: 500 (100.0%)`、非法意图 0、现金守恒违例 0、异常 0、失败局 0。

- [ ] **Step 4: Run production smoke after the client build**

Run:

```bash
pnpm exec tsx scripts/smoke-production.ts
```

Expected exact terminal marker: `smoke ok`。

- [ ] **Step 5: Audit the diff boundaries**

Run:

```bash
git diff --check
git status --short
git diff e9ead47...HEAD -- packages/engine apps/server packages/protocol packages/board-data/maps/china-tour/v1
```

Expected: `git diff --check` has no output；以批准设计提交 `e9ead47` 为本功能边界时，没有 engine、server、protocol 或 China Tour 地图包 diff；`git status --short` 为空，生产改动已由前三个 focused commits 收纳。

### Task 7: Verify the actual card preview in desktop and mobile browsers

**Files:**
- Verify: `apps/client/src/components/ActionPanel.vue`
- Verify: `apps/client/src/views/GameView.vue`

- [ ] **Step 1: Start the real development runtime**

Run in the worktree:

```bash
pnpm dev
```

Expected: client and server both start without application errors；使用终端打印的 client URL，不复用其他 worktree 的已有页面。

- [ ] **Step 2: Verify desktop at 1440×900**

在真实浏览器设置 1440×900，选择“世界之旅”并开始本地游戏；反复进行合法回合直到机会或命运卡出现。逐项确认：

1. 牌堆类型、主题标题、结算规则同时可见；
2. 标题比规则更醒目，但没有遮挡规则或操作按钮；
3. 规则只显示一次，没有把飞书“卡片正文”整句重复一遍；
4. 卡牌结算与现有战报一致，停留时长没有改变；
5. 浏览器 console 无新 error。

- [ ] **Step 3: Verify mobile at 390×844**

在同一真实游戏把 viewport 改为 390×844，再触发一张标题较长的卡（例如 D01“招待亲友入住八星级酋长国宫殿酒店”）。逐项确认：

1. 长标题可换行且完整可读；
2. 页面 `document.documentElement.scrollWidth <= document.documentElement.clientWidth`；
3. 规则、战报和主操作按钮仍可见；
4. 没有新增横向溢出或卡片覆盖。

- [ ] **Step 4: Verify the China Tour compatibility path**

返回首页选择“中国之旅”，开始本地游戏并触发一张机会或命运卡。确认只显示牌堆类型与原有单段文字，不出现空标题占位，原卡牌文案没有变化。

- [ ] **Step 5: Record observed evidence and final status**

在交付说明中记录：实际浏览器 URL、两个 viewport、抽到的 World Tour 卡 ID/标题、China Tour 卡 ID、console 结果，以及 Task 6 的实际命令和计数。若任何浏览器场景未触发或无法验证，明确列出已尝试步骤与未验证范围，不把它写成通过。

## Completion checklist

- [ ] 45 张 World Tour 卡牌标题与飞书 revision 41 一一对应。
- [ ] 45 张现有 `text`、`effect`、ID、顺序和数量无变化。
- [ ] China Tour 卡牌 JSON 与显示行为无变化。
- [ ] `title` 缺省兼容，非法显式值会被地图校验拒绝。
- [ ] presenter 只读取权威快照，不自行拆分文案或执行规则。
- [ ] ActionPanel 同时覆盖有标题和无标题布局。
- [ ] World Tour hash 为 `394ba177b54978b8a7abd01da23c858a63bbf06b87b6905b74af1120d8f16801`，registry exact-ref 校验通过。
- [ ] focused/full tests、typecheck、validate-data、build、两张地图各 500 局仿真和 production smoke 均有本次实际证据。
- [ ] 1440×900、390×844 与 China Tour 回归均有真实浏览器结果。
