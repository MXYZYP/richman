import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createErrorBoundary,
  messageOf,
  useAppErrorState,
  type AppErrorReport,
} from './errorBoundary';

let reported: { name: string; props?: Record<string, string | number | boolean> }[];
let listeners: Record<string, (event: unknown) => void>;
let clock: number;

beforeEach(() => {
  reported = [];
  listeners = {};
  clock = 1_000_000;
  useAppErrorState().value = null;
});

afterEach(() => {
  useAppErrorState().value = null;
});

function deps(overrides: Partial<Parameters<typeof createErrorBoundary>[0]> = {}) {
  return {
    report: (name: string, props?: Record<string, string | number | boolean>) => {
      reported.push({ name, props });
    },
    now: () => clock,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners[type] = listener;
    },
    ...overrides,
  };
}

describe('messageOf', () => {
  it('reads Error messages, strings, and objects without throwing', () => {
    expect(messageOf(new Error('boom'))).toBe('boom');
    expect(messageOf('plain string')).toBe('plain string');
    expect(messageOf({ code: 42 })).toBe('{"code":42}');
    // 循环引用：JSON.stringify 会抛，这里必须退化成 'unknown error' 而不是二次崩溃。
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(messageOf(cyclic)).toBe('unknown error');
  });

  it('truncates long messages so the payload stays small', () => {
    expect(messageOf('x'.repeat(500)).length).toBe(200);
  });
});

describe('createErrorBoundary', () => {
  it('reports Vue errors and raises the recovery card', () => {
    const boundary = createErrorBoundary(deps());

    boundary.captureVueError(new Error('render failed'));

    expect(reported).toEqual([{ name: 'app_error', props: { source: 'vue', message: 'render failed' } }]);
    expect(boundary.fatal.value).toEqual({ source: 'vue', message: 'render failed' });
    // 与 App.vue 共用同一个单例 ref。
    expect(useAppErrorState().value).not.toBeNull();
  });

  it('reports window errors and unhandled rejections without interrupting the game', () => {
    const boundary = createErrorBoundary(deps());

    boundary.captureWindowError(new Error('asset failed'));
    boundary.captureRejection('promise boom');

    expect(reported.map((entry) => entry.props?.source)).toEqual(['window', 'promise']);
    // 关键：这两种情况**不弹**恢复卡 —— 一个无关的 promise 报错不该打断对局。
    expect(boundary.fatal.value).toBeNull();
  });

  it('dedupes identical errors inside the window, but reports again later', () => {
    const boundary = createErrorBoundary(deps({ dedupeWindowMs: 5_000 }));

    boundary.captureVueError(new Error('same'));
    boundary.captureVueError(new Error('same'));
    expect(reported).toHaveLength(1);

    clock += 6_000;
    boundary.captureVueError(new Error('same'));
    expect(reported).toHaveLength(2);
  });

  it('wires window error and rejection listeners on install', () => {
    const boundary = createErrorBoundary(deps());
    boundary.install();

    expect(Object.keys(listeners).sort()).toEqual(['error', 'unhandledrejection']);

    listeners.error!({ error: new Error('from window') });
    listeners.unhandledrejection!({ reason: 'from promise' });

    expect(reported.map((entry) => entry.props?.source)).toEqual(['window', 'promise']);
    expect(boundary.fatal.value).toBeNull();
  });

  it('falls back to the event message when the error object is missing', () => {
    const boundary = createErrorBoundary(deps());
    boundary.install();

    listeners.error!({ message: 'Script error.' });

    expect(reported[0]?.props?.message).toBe('Script error.');
  });

  it('clears the recovery card on dismiss', () => {
    const boundary = createErrorBoundary(deps());
    boundary.captureVueError(new Error('x'));
    expect(useAppErrorState().value).not.toBeNull();

    boundary.dismiss();
    expect(useAppErrorState().value).toBeNull();
  });

  it('never throws when the reporter itself blows up', () => {
    const boundary = createErrorBoundary({
      ...deps(),
      report: () => {
        throw new Error('reporter down');
      },
    });

    // ★ 兜底代码自己抛异常 = 白屏之上再叠一层白屏，这条必须硬。
    expect(() => boundary.captureVueError(new Error('x'))).not.toThrow();
    expect(boundary.fatal.value?.message).toBe('x');

    expect(() => boundary.install()).not.toThrow();
    expect(() => listeners.error!({ error: new Error('y') })).not.toThrow();
    expect(() => listeners.unhandledrejection!({ reason: 'z' })).not.toThrow();
  });
});

describe('recovery card state', () => {
  it('is a single shared ref so App.vue and the boundary never disagree', () => {
    const first = createErrorBoundary(deps());
    const second = createErrorBoundary(deps());

    first.captureVueError(new Error('shared'));

    const shared: AppErrorReport | null = second.fatal.value;
    expect(shared?.message).toBe('shared');
  });
});
