import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import { getActiveMapPack, listActiveMaps } from '@richman/board-data';
import GameSetup from './GameSetup.vue';
import {
  createDefaultGameSetup,
  updateGameSetupBotDifficulty,
  updateGameSetupCounts,
  type GameSetupDependencies,
  type GameSetupForm,
} from '../game/gameSetup';

const dependencies: GameSetupDependencies = {
  catalog: listActiveMaps(),
  resolveActive: getActiveMapPack,
};

function renderSetup(initialSetup: GameSetupForm): Promise<string> {
  return renderToString(createSSRApp({
    render: () => h(GameSetup as never, { initialSetup, dependencies } as never),
  }));
}

/** 建一个「真人 1 / 电脑 2」的表单（默认值即如此，这里显式写出来，避免测试跟着默认值漂移）。 */
function setupWithBots(botDifficulty: GameSetupForm['botDifficulty'] = 'normal'): GameSetupForm {
  return updateGameSetupBotDifficulty(
    updateGameSetupCounts(createDefaultGameSetup(dependencies), { humanCount: 1, botCount: 2 }),
    botDifficulty,
  );
}

describe('GameSetup 的电脑玩家难度（#6：只在选了电脑玩家后才出现）', () => {
  it('一名电脑都没有时，整段难度选择都不渲染', async () => {
    // 2 真人 + 0 电脑才解得开人数下限（1 真人 0 电脑会被补成 1 电脑）。
    const setup = updateGameSetupCounts(createDefaultGameSetup(dependencies), { humanCount: 2, botCount: 0 });
    const html = await renderSetup(setup);

    expect(setup.botCount).toBe(0);
    expect(html).not.toContain('电脑玩家难度');
    expect(html).not.toContain('setup-difficulty-option');
    // 但难度值本身仍留在表单里（默认「普通」），不会因为隐藏就丢字段。
    expect(setup.botDifficulty).toBe('normal');
  });

  it('选了电脑玩家后出现三档难度，且只有当前档被标成已选', async () => {
    const html = await renderSetup(setupWithBots('hard'));

    expect(html).toContain('电脑玩家难度');
    for (const label of ['轻松', '普通', '困难']) {
      expect(html).toContain(label);
    }
    // 外层容器叫 setup-difficulty-options（复数），是按钮类名的前缀，所以必须用 `[">]` 收尾：
    // 按钮后面只会跟 `"`（未选中）或空格（选中时还有个 active），容器后面跟的是 `s`。
    expect(html.match(/setup-difficulty-option[">]/g)).toHaveLength(3);
    expect(html).toContain('class="setup-difficulty-options"');
    // role="radiogroup" + 每个按钮自己的 aria-pressed：无障碍上是一组单选，而不是三个普通按钮。
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/aria-pressed="/g)).toHaveLength(3);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toContain('仅影响电脑决策，不影响真人玩家');
  });

  it('提示文案跟着当前档位走，不是写死的一句', async () => {
    const normal = await renderSetup(setupWithBots('normal'));
    const hard = await renderSetup(setupWithBots('hard'));
    const easy = await renderSetup(setupWithBots('easy'));

    expect(normal).toContain('电脑留钱 2000');
    expect(hard).toContain('电脑只留 800');
    expect(easy).toContain('应急储备 4000');
    // 三档文案互不相同，否则玩家换了档也看不出差别。
    expect(new Set([normal, hard, easy]).size).toBe(3);
  });

  it('人数仍以 6 人为上限（#8），换档不难影响人数上限', async () => {
    const html = await renderSetup(setupWithBots('easy'));

    expect(html).toContain('最多 6 人');
    expect(html).toContain('6');
  });
});
