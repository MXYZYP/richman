import { describe, expect, it } from 'vitest';
import {
  bumpVersion,
  parseReleaseCatalog,
  renderChangelog,
  requiresVersionBump,
  validateReleaseTransition,
} from './releaseNotes';

const validCatalog = {
  releases: [
    {
      version: '2.4.0',
      date: '2026-07-30',
      title: '版本说明与更新记录',
      changes: ['首页新增当前版本入口。', '现在可以查看历史版本变化。'],
    },
    {
      version: '2.3.0',
      date: '2026-07-30',
      title: '地图扩展与体验打磨',
      changes: ['世界之旅增加更多可购买资产。'],
    },
  ],
};

describe('release catalog rules', () => {
  it('accepts a newest-first catalog and trims player-facing copy', () => {
    const catalog = parseReleaseCatalog({
      releases: [{
        version: '2.4.0',
        date: '2026-07-30',
        title: ' 版本说明 ',
        changes: [' 新增入口。 '],
      }],
    });

    expect(catalog.releases[0]).toEqual({
      version: '2.4.0',
      date: '2026-07-30',
      title: '版本说明',
      changes: ['新增入口。'],
    });
  });

  it('rejects duplicate, unordered, empty, and malformed entries', () => {
    expect(() => parseReleaseCatalog({
      releases: [validCatalog.releases[0], validCatalog.releases[0]],
    })).toThrow(/重复/);

    expect(() => parseReleaseCatalog({
      releases: [validCatalog.releases[1], validCatalog.releases[0]],
    })).toThrow(/必须高于/);

    expect(() => parseReleaseCatalog({
      releases: [{ ...validCatalog.releases[0], changes: [] }],
    })).toThrow(/更新内容/);

    expect(() => parseReleaseCatalog({
      releases: [{ ...validCatalog.releases[0], date: '2026-02-30' }],
    })).toThrow(/日期/);

    expect(() => parseReleaseCatalog({
      releases: [{ ...validCatalog.releases[0], version: 'v2.4' }],
    })).toThrow(/版本号/);
  });

  it('increments patch and minor versions deterministically', () => {
    expect(bumpVersion('2.3.4', 'patch')).toBe('2.3.5');
    expect(bumpVersion('2.3.4', 'minor')).toBe('2.4.0');
  });

  it('renders a stable newest-first changelog', () => {
    const markdown = renderChangelog(parseReleaseCatalog(validCatalog));

    expect(markdown).toContain('# 更新说明');
    expect(markdown).toContain('## [2.4.0] - 2026-07-30');
    expect(markdown).toContain('- 首页新增当前版本入口。');
    expect(markdown.indexOf('[2.4.0]')).toBeLessThan(markdown.indexOf('[2.3.0]'));
    expect(markdown.endsWith('\n')).toBe(true);
  });
});

describe('deployment release gate', () => {
  const previous = parseReleaseCatalog({ releases: [validCatalog.releases[1]] });
  const current = parseReleaseCatalog(validCatalog);
  const unchanged = parseReleaseCatalog({ releases: [validCatalog.releases[1]] });

  it('classifies only deployable runtime paths as player releases', () => {
    expect(requiresVersionBump(['apps/client/src/App.vue'])).toBe(true);
    expect(requiresVersionBump(['packages/engine/src/index.ts'])).toBe(true);
    expect(requiresVersionBump(['release-notes.json'])).toBe(true);
    expect(requiresVersionBump(['pnpm-lock.yaml'])).toBe(true);
    expect(requiresVersionBump(['workers/matchmaker.ts'])).toBe(true);
    expect(requiresVersionBump(['scripts/release.ts'])).toBe(false);
    expect(requiresVersionBump(['docs/spec.md', 'plan/04.md', '.github/workflows/deploy-pages.yml'])).toBe(false);
  });

  it('requires a higher version for runtime changes', () => {
    expect(() => validateReleaseTransition(previous, unchanged, ['apps/client/src/App.vue']))
      .toThrow(/递增版本/);
    expect(() => validateReleaseTransition(previous, current, ['packages/engine/src/index.ts']))
      .not.toThrow();
  });

  it('allows docs-only changes and the first catalog bootstrap', () => {
    expect(() => validateReleaseTransition(previous, unchanged, ['docs/spec.md']))
      .not.toThrow();
    expect(() => validateReleaseTransition(null, current, ['apps/client/src/App.vue']))
      .not.toThrow();
  });

  it('never allows the current version to move backwards', () => {
    expect(() => validateReleaseTransition(current, previous, ['docs/spec.md']))
      .toThrow(/低于/);
  });
});
