import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import ChatPanel from './ChatPanel.vue';
import { QUICK_PHRASES } from '../session/quickPhrases';

function renderChat(props: Record<string, unknown> = {}): Promise<string> {
  return renderToString(createSSRApp({
    render: () => h(ChatPanel as never, { messages: [], localPlayerId: null, ...props } as never),
  }));
}

/** 取整排快捷短语按钮的起始标签。 */
function phraseButtons(html: string): string[] {
  return html.match(/<button[^>]*class="chat-panel__phrase"[^>]*>/g) ?? [];
}

describe('ChatPanel 快捷短语（#109）', () => {
  it('每条短语都是一个按钮，并且写明「点击即发送」', async () => {
    const html = await renderChat();

    expect(phraseButtons(html)).toHaveLength(QUICK_PHRASES.length);
    for (const phrase of QUICK_PHRASES) expect(html).toContain(phrase);
    // 「点了会发生什么」必须写出来：否则玩家会以为按钮是「把话填进输入框」。
    expect(html).toContain('点击即发送');
    expect(html).toContain('aria-label="快捷短语，点击即发送"');
  });

  it('是普通按钮而不是提交按钮，不会顺手把输入框里的半句话也发出去', async () => {
    const html = await renderChat();

    for (const button of phraseButtons(html)) {
      expect(button).toContain('type="button"');
      expect(button).not.toContain('type="submit"');
    }
  });

  it('聊天被禁用时整排一起变灰（不能只灰输入框）', async () => {
    const enabled = await renderChat();
    for (const button of phraseButtons(enabled)) expect(button).not.toContain('disabled');

    const disabled = await renderChat({ disabled: true });
    for (const button of phraseButtons(disabled)) expect(button).toContain('disabled');
  });

  it('快捷短语是补充，不是替换：输入框与发送按钮原样保留', async () => {
    const html = await renderChat();
    expect(html).toContain('chat-panel__input');
    expect(html).toContain('说点什么…');
    expect(html).toContain('chat-panel__send');
  });
});
