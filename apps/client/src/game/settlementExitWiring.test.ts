// Source-level guards for the settlement dialog's exit wiring.
//
// Why source assertions: this package has no @vue/test-utils (every .vue test here reads
// the file), and the defects guarded below are all "the wiring exists but cannot fire" —
// a template that renders fine and a runtime that never navigates. Reading the source is
// the only way to pin them without a DOM harness.
//
// Each guard names the failure it prevents, so a red test explains itself.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const viewPath = resolve(here, '..', 'views', 'GameView.vue');
const dialogPath = resolve(here, '..', 'components', 'SettlementDialog.vue');
const view = readFileSync(viewPath, 'utf8');
const dialog = readFileSync(dialogPath, 'utf8');

function zIndexOf(source: string, selector: string): number {
  // Anchor on the selector followed by a newline + the declaration block, so a class
  // attribute in the template (class="confirm-backdrop") can never match — it is
  // followed by `"` / ` role=`, never by `{`.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(escaped + '\\s*\\{\\s*\\n([\\s\\S]*?)\\}').exec(source);
  if (rule === null) throw new Error(`no CSS rule for ${selector}`);
  // Strip comments before reading: a comment mentioning "z-index: 20" would otherwise
  // be read as the declared value, which silently turns this guard into a liar.
  const declarations = rule[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const found = /z-index:\s*(\d+)/.exec(declarations);
  if (found === null) throw new Error(`${selector} declares no z-index`);
  return Number(found[1]);
}

describe('结算弹窗的退出链路', () => {
  it('二次确认弹窗压在结算弹窗之上，否则点主按钮看起来毫无反应', () => {
    const confirm = zIndexOf(view, '.confirm-backdrop');
    const settlement = zIndexOf(dialog, '.settlement-backdrop');
    expect(confirm).toBeGreaterThan(settlement);
  });

  it('结算弹窗不再出现「再开一局」字样（那个动作并不存在）', () => {
    expect(view).not.toContain('再开一局');
    expect(dialog).not.toContain('再开一局');
  });

  it('主按钮接的是退出链路，退出最终真的会离开这一屏', () => {
    // @restart -> requestExit -> emit('exit') -> App.handleGameExit -> returnHome / leaveRoom
    expect(view).toMatch(/@restart="requestExit"/);
    expect(view).toMatch(/function requestExit\(\)/);
    expect(view).toMatch(/if \(needsLeaveConfirm\.value\) \{[\s\S]*?isConfirmingLeave\.value = true;/);
    expect(view).toMatch(/function confirmLeave\(\)[\s\S]*?emit\('exit'\);/);
  });

  it('「查看棋盘」可被隐藏，且没有棋盘可看时 Escape 不会把玩家困住', () => {
    expect(dialog).toMatch(/v-if="props\.canInspectBoard"/);
    expect(dialog).toMatch(/if \(event\.key === 'Escape' && props\.canInspectBoard\)/);
  });

  it('GameView 确实把这个开关接了进去', () => {
    expect(view).toMatch(/:can-inspect-board="settlementCanInspectBoard"/);
  });
});