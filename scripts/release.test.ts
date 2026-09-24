import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkPreviousRelease,
  checkReleaseFiles,
  createRelease,
  parseCreateArguments,
} from './release';
import { parseReleaseCatalog, renderChangelog } from './releaseNotes';

const roots: string[] = [];
const initialCatalog = parseReleaseCatalog({
  releases: [{
    version: '2.4.0',
    date: '2026-07-30',
    title: '版本说明与更新记录',
    changes: ['首页新增当前版本入口。'],
  }],
});
const bumpedCatalog = parseReleaseCatalog({
  releases: [{
    version: '2.4.1',
    date: '2026-07-31',
    title: '体验优化',
    changes: ['修复手机布局。'],
  }, ...initialCatalog.releases],
});

function git(rootDir: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function createFixture(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), 'richman-release-'));
  roots.push(rootDir);
  await Promise.all([
    writeFile(join(rootDir, 'release-notes.json'), `${JSON.stringify(initialCatalog, null, 2)}\n`),
    writeFile(join(rootDir, 'package.json'), `${JSON.stringify({ name: 'fixture', version: '2.4.0', private: true }, null, 2)}\n`),
    writeFile(join(rootDir, 'CHANGELOG.md'), renderChangelog(initialCatalog)),
  ]);
  return rootDir;
}

async function readReleaseFiles(rootDir: string): Promise<readonly string[]> {
  return Promise.all([
    readFile(join(rootDir, 'release-notes.json'), 'utf8'),
    readFile(join(rootDir, 'package.json'), 'utf8'),
    readFile(join(rootDir, 'CHANGELOG.md'), 'utf8'),
  ]);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((rootDir) => rm(rootDir, { recursive: true, force: true })));
});

describe('release file command', () => {
  it('defaults the CLI to patch and accepts an explicit minor bump', () => {
    expect(parseCreateArguments(['--title', '修复', '--change', '修复手机布局。'])).toEqual({
      bump: 'patch',
      title: '修复',
      changes: ['修复手机布局。'],
    });
    expect(parseCreateArguments(['minor', '--title', '新玩法', '--change', '新增正式地图。'])).toEqual({
      bump: 'minor',
      title: '新玩法',
      changes: ['新增正式地图。'],
    });
  });

  it('creates a patch release and synchronizes all generated files', async () => {
    const rootDir = await createFixture();

    const version = await createRelease({
      rootDir,
      bump: 'patch',
      title: '体验优化',
      changes: ['修复手机布局。'],
      date: '2026-07-31',
    });

    expect(version).toBe('2.4.1');
    const catalog = await checkReleaseFiles(rootDir);
    expect(catalog.releases[0]).toEqual({
      version: '2.4.1',
      date: '2026-07-31',
      title: '体验优化',
      changes: ['修复手机布局。'],
    });
    expect(JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8')).version).toBe('2.4.1');
    expect(await readFile(join(rootDir, 'CHANGELOG.md'), 'utf8')).toContain('## [2.4.1] - 2026-07-31');
  });

  it('creates an explicit minor release', async () => {
    const rootDir = await createFixture();

    const version = await createRelease({
      rootDir,
      bump: 'minor',
      title: '新玩法',
      changes: ['新增一张正式地图。'],
      date: '2026-08-01',
    });

    expect(version).toBe('2.5.0');
    const catalog = await checkReleaseFiles(rootDir);
    expect(catalog.releases[0].version).toBe('2.5.0');
  });

  it('validates every input before changing any file', async () => {
    const rootDir = await createFixture();
    const before = await readReleaseFiles(rootDir);

    await expect(createRelease({
      rootDir,
      bump: 'minor',
      title: '   ',
      changes: ['不会写入。'],
      date: '2026-08-01',
    })).rejects.toThrow(/标题/);

    expect(await readReleaseFiles(rootDir)).toEqual(before);
  });

  it('rejects a hand-edited changelog or mismatched package version', async () => {
    const changelogRoot = await createFixture();
    await writeFile(join(changelogRoot, 'CHANGELOG.md'), '# 手工修改\n');
    await expect(checkReleaseFiles(changelogRoot)).rejects.toThrow(/CHANGELOG/);

    const packageRoot = await createFixture();
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    await expect(checkReleaseFiles(packageRoot)).rejects.toThrow(/package\.json.*9\.9\.9.*2\.4\.0/);
  });

  it('treats an all-zero previous SHA as a first-push bootstrap and rejects malformed SHAs', async () => {
    const rootDir = await createFixture();
    const catalog = await checkReleaseFiles(rootDir);

    await expect(checkPreviousRelease(rootDir, catalog, '0000000000000000000000000000000000000000'))
      .resolves.toBeUndefined();
    await expect(checkPreviousRelease(rootDir, catalog, 'HEAD^'))
      .rejects.toThrow(/40 位十六进制/);
  });
  it('checks a real Git history and blocks runtime changes without a version bump', async () => {
    const rootDir = await createFixture();
    git(rootDir, ['init']);
    git(rootDir, ['config', 'user.email', 'release-test@example.com']);
    git(rootDir, ['config', 'user.name', 'Release Test']);
    git(rootDir, ['add', '.']);
    git(rootDir, ['commit', '-m', 'initial release']);
    const previousSha = git(rootDir, ['rev-parse', 'HEAD']);

    await mkdir(join(rootDir, 'apps', 'client'), { recursive: true });
    await writeFile(join(rootDir, 'apps', 'client', 'feature.ts'), 'export const enabled = true;\n');
    git(rootDir, ['add', '.']);
    git(rootDir, ['commit', '-m', 'runtime change']);

    await expect(checkPreviousRelease(rootDir, initialCatalog, previousSha))
      .rejects.toThrow(/递增版本/);
    await expect(checkPreviousRelease(rootDir, bumpedCatalog, previousSha))
      .resolves.toBeUndefined();
    // 这个用例会真的建一个 git 仓库、敲十几次 git 命令再扫一遍提交差异，
    // 单独跑就已经接近 5s（默认超时）——在全量套件里并行跑时必然被压过线，
    // 于是门禁会随机变红。它是发版拦截器唯一的端到端验证，宁可给它一个宽裕的上限，
    // 也不要让它成为一个「重跑一次就好了」的假失败。
  }, 30_000);

});
