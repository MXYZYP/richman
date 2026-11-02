// 道具面板（#1）的客户端守卫：模型判据 + 战报文案 + 组件接线。
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import { createGame, type GameState } from '@richman/engine';
import { getActiveMapPack } from '@richman/board-data';
import { formatRecentLogEvent, getItemPanel } from './clientGame';
import ItemPanel from '../components/ItemPanel.vue';

const chinaMap = getActiveMapPack('china-tour');

function makeGame(): GameState {
  return createGame({
    mapRef: chinaMap.ref,
    ruleModules: chinaMap.game.requiredRuleModules,
    board: chinaMap.game.board,
    cards: chinaMap.game.cards,
    config: chinaMap.game.config,
    players: [
      { id: 'p1', nickname: '甲' },
      { id: 'p2', nickname: '乙' },
    ],
    seed: 'items-panel-test',
  });
}

function withCash(state: GameState, cash: number, turnPhase: GameState['turnPhase'] = 'managing'): GameState {
  return {
    ...state,
    turnPhase,
    players: state.players.map((p) => (p.id === state.currentPlayerId ? { ...p, cash } : p)),
  };
}

describe('getItemPanel', () => {
  it('轮到自己 + managing + 有钱时三种道具都能买', () => {
    const state = withCash(makeGame(), 99_999);
    const panel = getItemPanel(state, state.currentPlayerId);

    expect(panel).not.toBeNull();
    expect(panel!.entries.map((entry) => entry.id)).toEqual(['remote_die', 'toll_pass', 'rent_boost']);
    expect(panel!.entries.every((entry) => entry.canBuy)).toBe(true);
    expect(panel!.entries.every((entry) => entry.count === 0)).toBe(true);
  });

  it('没钱的买不了，但面板仍然给出（玩家要看得到自己攒了什么）', () => {
    const state = withCash(makeGame(), 100);
    const panel = getItemPanel(state, state.currentPlayerId);
    expect(panel!.entries.every((entry) => entry.canBuy)).toBe(false);
  });

  it('不是自己回合时买不了', () => {
    const base = makeGame();
    const other = base.players.find((player) => player.id !== base.currentPlayerId)!;
    const panel = getItemPanel(withCash(base, 99_999), other.id);
    expect(panel!.entries.every((entry) => entry.canBuy)).toBe(false);
  });

  it('遥控骰子的点数只在「自己回合 + 掷骰前 + 有卡」时给出', () => {
    const base = makeGame();
    const me = base.currentPlayerId;
    const withCard: GameState = { ...base, turnPhase: 'managing', itemBags: { [me]: { remote_die: 1, toll_pass: 0, rent_boost: 0 } } };

    expect(getItemPanel(withCard, me)!.remoteDieOptions).toEqual([]);

    const rolling: GameState = { ...withCard, turnPhase: 'awaiting_roll' };
    expect(getItemPanel(rolling, me)!.remoteDieOptions).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    // 没有卡就不给选项
    const noCard: GameState = { ...base, turnPhase: 'awaiting_roll' };
    expect(getItemPanel(noCard, me)!.remoteDieOptions).toEqual([]);
  });
});

describe('道具战报文案', () => {
  it('买入 / 遥控骰子 / 免租卡 / 收租翻倍 各自有可读文案', () => {
    const state = withCash(makeGame(), 99_999);
    const me = state.currentPlayerId;

    const bought = formatRecentLogEvent(state, { type: 'item_bought', playerId: me, itemId: 'toll_pass', price: 1200 });
    expect(bought).toContain('免租卡');

    const rolled = formatRecentLogEvent(state, { type: 'item_used', playerId: me, itemId: 'remote_die', cellId: null, amount: 9 });
    expect(rolled).toContain('遥控骰子');
    expect(rolled).toContain('9');

    const pass = formatRecentLogEvent(state, { type: 'item_used', playerId: me, itemId: 'toll_pass', cellId: null, amount: 800 });
    expect(pass).toContain('免租卡');

    const boost = formatRecentLogEvent(state, { type: 'item_used', playerId: me, itemId: 'rent_boost', cellId: null, amount: 600 });
    expect(boost).toContain('收租翻倍');
  });
});

describe('ItemPanel 组件接线', () => {
  it('渲染三张道具卡与买入按钮，并在选定点数时给出 2-12 的按钮', async () => {
    const base = makeGame();
    const me = base.currentPlayerId;
    const state: GameState = {
      ...base,
      turnPhase: 'awaiting_roll',
      players: base.players.map((p) => (p.id === me ? { ...p, cash: 99_999 } : p)),
      itemBags: { [me]: { remote_die: 1, toll_pass: 0, rent_boost: 0 } },
    };
    const panel = getItemPanel(state, me)!;
    const html = await renderToString(createSSRApp({
      render: () => h(ItemPanel as never, { panel, disabled: false, isSpectator: false } as never),
    }));

    expect(html).toContain('遥控骰子');
    expect(html).toContain('免租卡');
    expect(html).toContain('收租翻倍');
    expect(html.match(/item-card__buy/g)?.length).toBeGreaterThanOrEqual(3);
    // 11 个点数按钮（2-12）
    expect(html.match(/item-panel__remote-btn/g)).toHaveLength(11);
    expect(html).toContain('aria-label="道具"');
  });

  it('disabled 时按钮被禁用（动画/提交中不能连点）', async () => {
    const state = withCash(makeGame(), 99_999);
    const panel = getItemPanel(state, state.currentPlayerId)!;
    const html = await renderToString(createSSRApp({
      render: () => h(ItemPanel as never, { panel, disabled: true, isSpectator: false } as never),
    }));
    expect(html).toContain('disabled');
  });
});
