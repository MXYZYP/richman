// 守卫：首启隐私同意的判定逻辑。
//
// 为什么单独测这一层：App.vue 模块顶层就建 socket，没法在测试里渲染；
// 判定逻辑留在组件里等于没测。所以这里只钉 `session/privacyConsent.ts`。
import { describe, expect, it } from 'vitest';
import {
  PRIVACY_CONSENT_KEY,
  PRIVACY_POLICY_VERSION,
  hasAcceptedPrivacy,
  markPrivacyAccepted,
  readPrivacyConsent,
} from './privacyConsent';
import type { StorageLike } from './sessionStorage';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { dump(): Record<string, string> } {
  const data = { ...initial };
  return {
    getItem: (key) => (key in data ? data[key]! : null),
    setItem: (key, value) => { data[key] = value; },
    removeItem: (key) => { delete data[key]; },
    dump: () => ({ ...data }),
  };
}

describe('隐私同意', () => {
  it('没同意过就是没同意过（空存储 = 要弹）', () => {
    expect(hasAcceptedPrivacy(memoryStorage())).toBe(false);
    expect(readPrivacyConsent(memoryStorage())).toBeNull();
  });

  it('同意之后带上政策版本号与时间落盘', () => {
    const storage = memoryStorage();
    markPrivacyAccepted(storage, new Date('2026-10-17T12:00:00.000Z'));

    const consent = readPrivacyConsent(storage);
    expect(consent?.version).toBe(PRIVACY_POLICY_VERSION);
    expect(consent?.acceptedAt).toBe('2026-10-17T12:00:00.000Z');
    expect(hasAcceptedPrivacy(storage)).toBe(true);
  });

  it('政策版本一变，旧同意立即失效（必须重新征得）', () => {
    const storage = memoryStorage({
      [PRIVACY_CONSENT_KEY]: JSON.stringify({ version: '2025-01-01', acceptedAt: '2025-01-01T00:00:00.000Z' }),
    });
    expect(hasAcceptedPrivacy(storage)).toBe(false);
  });

  it('值被写坏时宁可再问一次，也不放行', () => {
    expect(hasAcceptedPrivacy(memoryStorage({ [PRIVACY_CONSENT_KEY]: '{oops' }))).toBe(false);
    expect(hasAcceptedPrivacy(memoryStorage({ [PRIVACY_CONSENT_KEY]: '"just a string"' }))).toBe(false);
    expect(hasAcceptedPrivacy(memoryStorage({ [PRIVACY_CONSENT_KEY]: JSON.stringify({ version: 1 }) }))).toBe(false);
  });

  it('拿不到 storage（SSR / 无痕）视为已同意 —— 否则每次刷新都弹', () => {
    expect(hasAcceptedPrivacy(undefined)).toBe(true);
    // 写不进去也不算失败。
    expect(() => markPrivacyAccepted(undefined)).not.toThrow();
  });

  it('存储本身抛异常时也不崩：读按已同意、写安静失败', () => {
    const hostile: StorageLike = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => {},
    };
    expect(hasAcceptedPrivacy(hostile)).toBe(true);
    expect(() => markPrivacyAccepted(hostile)).not.toThrow();
  });
});
