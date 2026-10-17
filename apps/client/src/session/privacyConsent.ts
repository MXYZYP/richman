import type { StorageLike } from './sessionStorage';

/**
 * 隐私政策的「已同意」标记。
 *
 * 为什么不是简单的布尔值：隐私政策**改一次就得重新征得同意**。
 * 所以存的是 `{version, acceptedAt}`，只有版本号与当前 `PRIVACY_POLICY_VERSION` 完全一致
 * 才算同意过；改了正文却忘了改版本号，等于让老用户沿用旧同意 —— 这是这类实现最常见的漏洞。
 *
 * 与 `firstRunGuide.ts` 是同一条约定：纯函数 + 显式传入 storage，UI 只负责调。
 */
export const PRIVACY_POLICY_VERSION = '2026-10-17';
export const PRIVACY_CONSENT_KEY = 'richman_privacy_consent_v1';

export interface PrivacyConsent {
  readonly version: string;
  readonly acceptedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 纯解析：只处理字符串，不碰 storage。值坏了返回 null（当没同意过）。 */
function parseConsent(raw: string | null): PrivacyConsent | null {
  if (raw === null || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const { version, acceptedAt } = parsed;
    if (typeof version !== 'string' || typeof acceptedAt !== 'string') return null;
    return { version, acceptedAt };
  } catch {
    return null;
  }
}

/** 读出同意记录。读不到 / 值坏了都当作「没同意过」。 */
export function readPrivacyConsent(storage: StorageLike | undefined): PrivacyConsent | null {
  if (storage === undefined) return null;
  try {
    return parseConsent(storage.getItem(PRIVACY_CONSENT_KEY));
  } catch {
    return null;
  }
}

/**
 * 此刻能不能直接进游戏。
 *
 * ★ 这里必须自己读一次、自己捕获异常，**不能**复用 `readPrivacyConsent` 的返回值：
 *   那个函数把「读不了」吞成了 `null`，和「确实没同意过」变成同一个结果。
 *   而这两件事的处置恰好相反 —— 读不了时应该与「无 storage」同档（放行），
 *   否则隐私模式 / 禁用存储的用户会被一个永远读不到的标记**永久挡在门外**。
 *
 * **拿不到 storage（SSR / 无痕模式 / 禁用存储）时返回 true** —— 与「玩法说明」同一条理由：
 * 我们没法记住这次的选择，而每次刷新都弹一遍是这个机制里最烦人的失败模式。
 */
export function hasAcceptedPrivacy(storage: StorageLike | undefined): boolean {
  if (storage === undefined) return true;
  let consent: PrivacyConsent | null;
  try {
    consent = parseConsent(storage.getItem(PRIVACY_CONSENT_KEY));
  } catch {
    return true;
  }
  return consent !== null && consent.version === PRIVACY_POLICY_VERSION;
}

/** 记下这次同意。写不进去不算失败：最多下次再问一遍。 */
export function markPrivacyAccepted(storage: StorageLike | undefined, now: Date = new Date()): void {
  if (storage === undefined) return;
  const consent: PrivacyConsent = {
    version: PRIVACY_POLICY_VERSION,
    acceptedAt: now.toISOString(),
  };
  try {
    storage.setItem(PRIVACY_CONSENT_KEY, JSON.stringify(consent));
  } catch {
    /* 存不下就存不下 —— 本次照常放行，下次再问。 */
  }
}
