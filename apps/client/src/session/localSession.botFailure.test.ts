import type * as Engine from '@richman/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const engineMocks = vi.hoisted(() => ({
  applyIntent: vi.fn(),
}));

vi.mock('@richman/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof Engine>();
  return {
    ...actual,
    applyIntent: engineMocks.applyIntent,
  };
});

import { createLocalSession } from './localSession';

describe('createLocalSession BOT rejection handling', () => {
  beforeEach(() => {
    engineMocks.applyIntent.mockReset();
    engineMocks.applyIntent.mockReturnValue({ ok: false, code: 'ILLEGAL_INTENT' });
  });

  it('stops automatic BOT scheduling after the first rejected deterministic intent', async () => {
    const botDelay = 937_421;
    let botDelayCalls = 0;
    const session = createLocalSession({
      autoPlayBots: true,
      botDelay: () => botDelay,
      players: [
        { id: 'bot-a', nickname: '电脑一', isBot: true },
        { id: 'bot-b', nickname: '电脑二', isBot: true },
      ],
      seed: 'bot-rejection-stops-scheduling',
      wait: async (delay) => {
        if (delay === botDelay) botDelayCalls += 1;
      },
    });

    try {
      const snapshotBefore = structuredClone(session.state.value);

      await session.runBotTurnIfNeeded();
      for (let microtask = 0; microtask < 100; microtask += 1) await Promise.resolve();

      expect(engineMocks.applyIntent).toHaveBeenCalledTimes(1);
      expect(botDelayCalls).toBe(1);
      expect(session.state.value).toEqual(snapshotBefore);
      expect(session.isBotThinking.value).toBe(false);
      expect(session.lastError.value).toBe('这个操作现在不可用');
    } finally {
      session.dispose();
    }
  });
});
