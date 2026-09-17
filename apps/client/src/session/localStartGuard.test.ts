import { describe, expect, it } from 'vitest';
import { createLocalStartGuard } from './localStartGuard';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

describe('local start guard', () => {
  it.each(['start', 'replacement confirmation', 'storage retry'])(
    'ignores a late %s result after returning home',
    async () => {
      const guard = createLocalStartGuard();
      const ticket = guard.begin();
      const lock = deferred();
      let launched = false;
      const operation = lock.promise.then(() => {
        if (guard.isCurrent(ticket)) launched = true;
      });

      guard.cancel();
      lock.resolve();
      await operation;

      expect(launched).toBe(false);
    },
  );

  it('invalidates an older start when a newer start begins', () => {
    const guard = createLocalStartGuard();
    const first = guard.begin();
    const second = guard.begin();

    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });
});
