// Guards the service-worker cache version.
//
// Symptom this prevents: a new feature ships in the server's built artifacts (grep finds
// the new class in dist/assets/*.js) yet the page still runs the OLD chunks and the feature
// is invisible. Ctrl+Shift+R does not help: a hard reload bypasses the HTTP cache, not the
// Service Worker.
//
// Why the version matters: asset filenames carry a content hash, so any code change changes
// them — but the worker only re-installs and drops its cache when *its own* bytes change.
// Leaving the CACHE name alone means the worker still believes it is current and keeps
// serving stale chunks. The file's own header comment says "+1 on every static change";
// this test makes that a hard rule rather than a note nobody reads.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sw = readFileSync(resolve(here, '..', '..', 'public', 'sw.js'), 'utf8');

/** Reads the current cache version from the `const CACHE = 'richman-vN'` declaration. */
function cacheVersion(): number {
  const m = /const CACHE = 'richman-v(\d+)'/.exec(sw);
  if (m === null) throw new Error("sw.js no longer declares `const CACHE = 'richman-vN'`");
  return Number(m[1]);
}

describe('Service Worker 缓存版本', () => {
  it('版本号是数字（能被守卫递增）', () => {
    expect(Number.isInteger(cacheVersion())).toBe(true);
  });

  it('至少到 v3 —— v2 及更早会让改过前端后浏览器继续跑旧 chunk', () => {
    // v2 是「AI 托管按钮加了但用户看不到」那次事故的版本：产物已更新，页面仍是旧的。
    // 强刷无效，因为强刷只绕过 HTTP 缓存，绕不过 Service Worker。
    expect(cacheVersion()).toBeGreaterThanOrEqual(3);
  });

  it('文件头注释写明了「改静态产物就要 +1」', () => {
    // 规则只写在注释里必然会被忽略，所以把规则本身也钉住。
    expect(sw).toMatch(/版本号规则/);
    expect(sw).toMatch(/\+1/);
  });

  it('仍保留清旧缓存与接管页面的 activate 逻辑', () => {
    // 升版本号只有在 activate 真的会删旧缓存时才有意义。
    expect(sw).toMatch(/self\.skipWaiting\(\)/);
    expect(sw).toMatch(/k !== CACHE/);
    expect(sw).toMatch(/self\.clients\.claim\(\)/);
  });
});

/**
 * The rule that actually prevents the incident: a commit that changes the frontend bundle
 * must bump the worker's cache name.
 *
 * Reading the version number alone cannot catch a forgotten bump (the number is just a
 * number). What catches it is comparing against the previous commit: if this commit touched
 * anything that ends up inside the bundle, and the CACHE name did not change, the worker
 * will keep serving the previous chunks.
 *
 * Skipped when git history is unavailable (shallow CI checkout, tarball import) — the
 * constant-level checks above still apply then.
 */
describe('本次提交若改了前端产物，就必须升缓存版本', () => {
  const BUNDLE_PATH = /^(apps\/client\/(src|public)\/|packages\/(protocol|board-data|engine)\/src\/)/;

  it('改了前端/共享包的产物却没有升版本 —— Service Worker 会继续发旧 chunk', () => {
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repoRoot(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

    let base: string;
    let head: string;
    try {
      head = git('rev-parse', 'HEAD');
      base = git('rev-parse', 'HEAD~1');
    } catch {
      // 历史不可用（CI shallow / 归档导入）→ 跳过本条，交给上面的常量断言。
      return;
    }

    const touchedBundle = git('diff', '--name-only', base, head)
      .split('\n')
      .filter((f: string) => f.trim() !== '' && BUNDLE_PATH.test(f.trim()));
    if (touchedBundle.length === 0) return;

    const before = git('show', `${base}:apps/client/public/sw.js`);
    const beforeVersion = /richman-v(\d+)/.exec(before)?.[1];
    const afterVersion = String(cacheVersion());
    expect(
      afterVersion,
      `这次提交改了 ${touchedBundle.join(', ')}（会换掉带 hash 的 chunk），`
      + `但 sw.js 的缓存版本没动（仍是 v${beforeVersion}）。`
      + '浏览器会继续跑旧 chunk，新功能看不到，Ctrl+Shift+R 也无效。',
    ).not.toBe(beforeVersion);
  });
});

/** Repo root: two levels up from apps/client/src/ui. */
function repoRoot(): string {
  return resolve(here, '..', '..', '..', '..');
}