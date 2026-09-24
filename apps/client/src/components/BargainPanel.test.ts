import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import BargainPanel from './BargainPanel.vue';
import type { AuctionDisplay, TradeDisplay, TradeProposalOption } from '../game/clientGame';

function renderBargain(props: Record<string, unknown> = {}): Promise<string> {
  return renderToString(createSSRApp({
    render: () => h(BargainPanel as never, {
      trade: null,
      auction: null,
      proposalOptions: null,
      ownCells: [],
      ownCash: 0,
      ...props,
    } as never),
  }));
}

const trade: TradeDisplay = {
  proposerId: 'player-a',
  proposerName: '甲',
  targetId: 'player-b',
  targetName: '乙',
  offer: { cash: 500, cellIds: [3], cellNames: ['外滩'] },
  request: { cash: 0, cellIds: [7], cellNames: ['故宫'] },
  iAmProposer: false,
  iAmTarget: true,
  canRespond: true,
  canCancel: false,
};

const auction: AuctionDisplay = {
  cellId: 9,
  cellName: '兵马俑',
  cellPrice: 1_200,
  bidderId: 'player-b',
  bidderName: '乙',
  leaderId: 'player-a',
  leaderName: '甲',
  leaderBid: 300,
  minBid: 400,
  passedNames: ['丙'],
  isMyTurnToBid: true,
  myCash: 2_000,
  myMaxBid: 2_000,
};

const proposalOptions: TradeProposalOption[] = [
  {
    playerId: 'player-b',
    nickname: '乙',
    cash: 1_500,
    cells: [{ cellId: 7, name: '故宫' }],
  },
];

describe('BargainPanel', () => {
  it('交易报价把双方的「给出」都摊开，并给答复方一对按钮', async () => {
    const html = await renderBargain({ trade });

    expect(html).toContain('交易报价');
    expect(html).toContain('甲 → 乙');
    expect(html).toContain('甲 给出');
    expect(html).toContain('现金 ¥500 + 外滩');
    expect(html).toContain('乙 给出');
    expect(html).toContain('故宫');
    // 答复方拿到接受/拒绝；发起方的撤回不出现。
    expect(html).toContain('接受报价');
    expect(html).toContain('拒绝');
    expect(html).not.toContain('撤回报价');
  });

  it('发起方看到的是撤回，而不是自己的接受按钮', async () => {
    const html = await renderBargain({
      trade: { ...trade, iAmProposer: true, iAmTarget: false, canRespond: false, canCancel: true },
    });

    expect(html).toContain('撤回报价');
    expect(html).not.toContain('接受报价');
  });

  it('与报价无关的第三人只读：没有按钮，只说明在等谁答复', async () => {
    const html = await renderBargain({
      trade: { ...trade, iAmProposer: false, iAmTarget: false, canRespond: false, canCancel: false },
    });

    expect(html).toContain('等待 乙 答复');
    expect(html).not.toContain('接受报价');
    expect(html).not.toContain('撤回报价');
  });

  it('拍卖在轮到自己叫价时给出价输入与两个动作，并写明下一次的上下限', async () => {
    const html = await renderBargain({ auction });

    expect(html).toContain('地产拍卖');
    expect(html).toContain('兵马俑');
    // 领先者与已退出者都要看得见：玩家据此判断这块地还剩几个对手。
    expect(html).toContain('甲 以 ¥300 领先');
    expect(html).toContain('已退出叫价');
    expect(html).toContain('丙');
    // 出价下限 = 当前最高价 + 最小加价；上限 = 自己的现金。
    expect(html).toContain('下限 ¥400');
    expect(html).toContain('上限 ¥2,000');
    expect(html).toContain('出价');
    expect(html).toContain('放弃叫价');
  });

  it('拍卖没轮到自己时只读，不出现出价控件', async () => {
    const html = await renderBargain({
      auction: { ...auction, isMyTurnToBid: false, bidderId: 'player-c', bidderName: '丙' },
    });

    expect(html).toContain('等待 丙 出价或放弃叫价');
    // 只读视角没有任何可提交的控件：没有出价输入框，也没有「放弃叫价」按钮。
    expect(html).not.toContain('type="number"');
    expect(html).not.toContain('>放弃叫价<');
    expect(html).not.toContain('下限');
  });

  it('第一次叫价的下限是起拍价（没有领先者时）', async () => {
    const html = await renderBargain({
      auction: {
        ...auction,
        leaderId: null,
        leaderName: null,
        leaderBid: 0,
        minBid: 100,
        passedNames: [],
      },
    });

    expect(html).toContain('尚无出价');
    expect(html).toContain('下限 ¥100');
  });

  it('没有议价进行时给出折叠的发起入口，默认不展开表单', async () => {
    const html = await renderBargain({ proposalOptions, ownCells: [], ownCash: 3_000 });

    expect(html).toContain('发起交易');
    expect(html).toContain('aria-expanded="false"');
    // 折叠态不渲染任何表单控件，控制台不留常驻占位。
    expect(html).not.toContain('交易对手');
    expect(html).not.toContain('发出报价');
  });

  it('有进行中的报价时，发起入口让位给报价（三态互斥）', async () => {
    const html = await renderBargain({ trade, proposalOptions, ownCash: 3_000 });

    expect(html).toContain('交易报价');
    expect(html).not.toContain('发起交易');
  });

  it('三态都不成立时整块不渲染', async () => {
    const html = await renderBargain();
    // SSR 会留下注释占位，所以不能断言空串：这里断言的是三块内容都没有出现。
    expect(html).not.toContain('class="bargain-panel');
    expect(html).not.toContain('交易报价');
    expect(html).not.toContain('地产拍卖');
    expect(html).not.toContain('发起交易');
  });
});
