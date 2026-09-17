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

async function renderPendingCard(isAnimating = false): Promise<string> {
  return renderToString(createSSRApp({
    render: () => h(ActionPanel, {
      actions: [
        { label: '重新抽取', intent: { type: 'redraw_card' } },
        { label: '接受并执行', intent: { type: 'accept_card' }, primary: true },
      ],
      dice: [2, 3],
      activeCard: null,
      pendingCard: {
        deck: 'chance',
        cardId: 'C01',
        title: '罗马斗兽场涂写罚款',
        text: '向银行支付1500元',
        playerId: 'p1',
        playerName: '玩家一',
      },
      eventMessage: '等待选择',
      isAnimating,
      lastError: null,
      turnTitle: '',
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
    expect(html).toContain('罗马斗兽场涂写罚款');
    expect(html).toContain('向银行支付1500元');
  });

  it('无标题的 China Tour 卡牌继续使用单段规则布局', async () => {
    const html = await renderCard({
      deck: 'destiny',
      cardId: '72-01',
      text: '前进至北京',
    });
    expect(html).toContain('命运');
    expect(html).toContain('前进至北京');
  });
});

describe('ActionPanel dice result', () => {
  it.each([
    { dice: [4], expected: [4, 4] },
    { dice: [3, 5], expected: [3, 5, 8] },
  ])('announces every die and its actual total for $dice', async ({ dice, expected }) => {
    const html = await renderToString(createSSRApp({
      render: () => h(ActionPanel, {
        actions: [], dice, activeCard: null, eventMessage: '', isAnimating: false,
        lastError: null, turnTitle: '', purchaseOffer: null,
      }),
    }));
    const result = html.match(/role="group"[^>]*aria-label="([^"]+)"/)?.[1];
    expect(result?.match(/\d+/g)?.map(Number)).toEqual(expected);
  });
});

describe('ActionPanel pending card', () => {
  it('展示单机作弊标识、真实卡面与所属玩家，并保留重抽/接受按钮', async () => {
    const html = await renderPendingCard();

    expect(html).toContain('单机作弊');
    expect(html).toContain('玩家一 · 等待选择');
    expect(html).toContain('罗马斗兽场涂写罚款');
    expect(html).toContain('向银行支付1500元');
    expect(html).toContain('重新抽取');
    expect(html).toContain('接受并执行');
    expect(html).toContain('等待选择的卡牌');
  });

  it('动画播放期间两个按钮都禁用', async () => {
    const html = await renderPendingCard(true);

    const disabledButtons = html.match(/<button[^>]*disabled[^>]*>/g) ?? [];
    expect(disabledButtons).toHaveLength(2);
    expect(html).toContain('重新抽取');
    expect(html).toContain('接受并执行');
  });
});

describe('ActionPanel spectator row', () => {
  it('replaces the 44px action row with a read-only spectator placeholder', async () => {
    const html = await renderToString(createSSRApp({
      render: () => h(ActionPanel, {
        actions: [{ label: '掷骰子', intent: { type: 'roll_dice' }, primary: true }],
        dice: [2, 5],
        activeCard: null,
        eventMessage: '等待 P2 行动',
        isAnimating: false,
        lastError: null,
        turnTitle: '观战中',
        purchaseOffer: null,
        isSpectator: true,
      }),
    }));
    expect(html).toContain('观战中 · 仅可查看对局');
    expect(html).toContain('class="no-actions"');
    expect(html).not.toContain('掷骰子');
    expect(html).not.toContain('暂无主操作，请在资产面板处理可用资产');
  });
});
