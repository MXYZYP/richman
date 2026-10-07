import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  bumpVersion,
  parseReleaseCatalog,
  renderChangelog,
  validateReleaseTransition,
  type ReleaseBump,
  type ReleaseCatalog,
} from './releaseNotes';

export interface CreateReleaseOptions {
  readonly rootDir: string;
  readonly bump: ReleaseBump;
  readonly title: string;
  readonly changes: readonly string[];
  readonly date?: string;
}

interface PackageJson {
  version?: unknown;
  [key: string]: unknown;
}

const RELEASE_FILE = 'release-notes.json';
const PACKAGE_FILE = 'package.json';
const CHANGELOG_FILE = 'CHANGELOG.md';
const ZERO_SHA = '0000000000000000000000000000000000000000';
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

async function readJson(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} 无法读取：${detail}`);
  }
}

function parsePackageJson(value: unknown): PackageJson {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('package.json 必须是 JSON 对象');
  }
  return value as PackageJson;
}

async function writeAtomicFiles(files: readonly { path: string; content: string }[]): Promise<void> {
  const token = `${process.pid}-${randomUUID()}`;
  const pending = files.map((file) => ({
    ...file,
    temporaryPath: join(dirname(file.path), `.${basename(file.path)}.${token}.tmp`),
  }));

  try {
    await Promise.all(pending.map((file) => writeFile(file.temporaryPath, file.content, { flag: 'wx' })));
    for (const file of pending) await rename(file.temporaryPath, file.path);
  } finally {
    await Promise.all(pending.map((file) => rm(file.temporaryPath, { force: true })));
  }
}

export interface CheckReleaseOptions {
  /**
   * 跳过「CHANGELOG.md 是否与 release-notes.json 同步」这一项比对。
   *
   * 只有 `rebuildChangelog` 需要它：那个命令存在的意义就是修复 CHANGELOG 失配，
   * 若先跑完整 check 就会在「CHANGELOG 过期」上抛错、永远走不到重建逻辑（死锁）。
   * 版本号一致性仍然照常校验，所以不会把别的问题一起掩盖掉。
   */
  readonly skipChangelog?: boolean;
}

export async function checkReleaseFiles(
  rootDir: string,
  options: CheckReleaseOptions = {},
): Promise<ReleaseCatalog> {
  const [catalogValue, packageValue, changelog] = await Promise.all([
    readJson(join(rootDir, RELEASE_FILE), RELEASE_FILE),
    readJson(join(rootDir, PACKAGE_FILE), PACKAGE_FILE),
    readFile(join(rootDir, CHANGELOG_FILE), 'utf8').catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${CHANGELOG_FILE} 无法读取：${detail}`);
    }),
  ]);

  const catalog = parseReleaseCatalog(catalogValue);
  const packageJson = parsePackageJson(packageValue);
  const catalogVersion = catalog.releases[0].version;
  if (packageJson.version !== catalogVersion) {
    throw new Error(`package.json 版本 ${String(packageJson.version)} 与发布清单 ${catalogVersion} 不一致`);
  }

  if (!options.skipChangelog && changelog !== renderChangelog(catalog)) {
    throw new Error('CHANGELOG.md 与 release-notes.json 不一致，请重新生成');
  }
  return catalog;
}

export async function createRelease(options: CreateReleaseOptions): Promise<string> {
  const current = await checkReleaseFiles(options.rootDir);
  const version = bumpVersion(current.releases[0].version, options.bump);
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const next = parseReleaseCatalog({
    releases: [{
      version,
      date,
      title: options.title,
      changes: options.changes,
    }, ...current.releases],
  });

  const packagePath = join(options.rootDir, PACKAGE_FILE);
  const packageJson = parsePackageJson(await readJson(packagePath, PACKAGE_FILE));
  packageJson.version = version;

  await writeAtomicFiles([
    {
      path: join(options.rootDir, RELEASE_FILE),
      content: `${JSON.stringify(next, null, 2)}\n`,
    },
    {
      path: packagePath,
      content: `${JSON.stringify(packageJson, null, 2)}\n`,
    },
    {
      path: join(options.rootDir, CHANGELOG_FILE),
      content: renderChangelog(next),
    },
  ]);
  return version;
}

/**
 * 统一的 git 调用出口。
 *
 * 必须显式给出 `stdio: ['ignore', 'pipe', 'pipe']`：用 `'pipe'` / `encoding` 这类简写形式，
 * libuv 会在部分 Windows 文件系统上尝试重叠 I/O 并以 `EBUSY` 失败（拿不到 exit code、
 * stderr 也是undefined）。对零输出的探测命令（如 `cat-file -e`）这种失败尤其致命 ——
 * 「对象存在」会被误判成「CI 历史不完整」。数组形式各平台语义一致：
 * stdin 丢弃、stdout/stderr 走管道。
 */
function execGit(rootDir: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export async function checkPreviousRelease(
  rootDir: string,
  current: ReleaseCatalog,
  previousSha: string,
): Promise<void> {
  if (!SHA_PATTERN.test(previousSha)) {
    throw new Error('RELEASE_PREVIOUS_SHA 必须是 40 位十六进制 Git SHA');
  }
  if (previousSha === ZERO_SHA) return;

  try {
    execGit(rootDir, ['cat-file', '-e', `${previousSha}^{commit}`]);
  } catch {
    throw new Error(`无法读取上一提交 ${previousSha}；CI checkout 必须包含完整历史`);
  }

  const changedPaths = execGit(rootDir, ['diff', '--name-only', previousSha, 'HEAD'])
    .split('\n').filter(Boolean);

  let hasPreviousCatalog = true;
  try {
    execGit(rootDir, ['cat-file', '-e', `${previousSha}:${RELEASE_FILE}`]);
  } catch {
    hasPreviousCatalog = false;
  }

  let previous: ReleaseCatalog | null = null;
  if (hasPreviousCatalog) {
    const previousText = execGit(rootDir, ['show', `${previousSha}:${RELEASE_FILE}`]);
    try {
      previous = parseReleaseCatalog(JSON.parse(previousText));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`上一提交的 ${RELEASE_FILE} 不是合法 JSON`);
      throw error;
    }
  }

  validateReleaseTransition(previous, current, changedPaths);
}

export function parseCreateArguments(args: readonly string[]): Omit<CreateReleaseOptions, 'rootDir'> {
  let bump: ReleaseBump = 'patch';
  let flags = args;
  const requestedBump = args[0];
  if (requestedBump === 'patch' || requestedBump === 'minor') {
    bump = requestedBump;
    flags = args.slice(1);
  } else if (requestedBump !== undefined && !requestedBump.startsWith('--')) {
    throw new Error('发布类型必须是 patch 或 minor');
  }

  let title = '';
  const changes: string[] = [];
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    const value = flags[index + 1];
    if ((flag !== '--title' && flag !== '--change') || value === undefined || value.startsWith('--')) {
      throw new Error(`无法识别或缺少参数：${flag}`);
    }
    if (flag === '--title') title = value;
    else changes.push(value);
    index += 1;
  }

  return { bump, title, changes };
}

/**
 * 按 release-notes.json 重建 CHANGELOG.md，**不**动版本号。
 *
 * 为什么需要它：CHANGELOG.md 是纯派生文件（由 `renderChangelog()` 生成），
 * 手改几乎必然与生成规则不一致，`check` 会报「CHANGELOG.md 与 release-notes.json 不一致」。
 * 典型触发场景就是**精简既有版本的更新说明文案** —— 你改了 json，但不想发一个新版本号。
 * 此时 `create` 不适用（它会 bump 版本），只能重建派生的 CHANGELOG。
 */
export async function rebuildChangelog(rootDir: string): Promise<number> {
  // skipChangelog 是必须的：CHANGELOG 过期正是本命令要修的那一个故障，
  // 若在这里跑完整 check 就会先抛错、永远到不了下面这行重建逻辑。
  // 版本号一致性仍然校验，避免「顺手把 CHANGELOG 对齐到一个错版本号上」。
  const current = await checkReleaseFiles(rootDir, { skipChangelog: true });
  await writeAtomicFiles([
    { path: join(rootDir, CHANGELOG_FILE), content: renderChangelog(current) },
  ]);
  return current.releases.length;
}

async function main(): Promise<void> {
  const rootDir = fileURLToPath(new URL('../', import.meta.url));
  const [command, ...args] = process.argv.slice(2);
  if (command === 'create') {
    const version = await createRelease({ rootDir, ...parseCreateArguments(args) });
    process.stdout.write(`Release ${version} created.\n`);
    return;
  }
  if (command === 'check') {
    const catalog = await checkReleaseFiles(rootDir);
    const previousSha = process.env.RELEASE_PREVIOUS_SHA?.trim();
    if (previousSha) await checkPreviousRelease(rootDir, catalog, previousSha);
    process.stdout.write(`Release metadata valid: ${catalog.releases[0].version}.\n`);
    return;
  }
  if (command === 'rebuild-changelog') {
    // 刻意不 bump 版本号：只把 CHANGELOG 同步到当前的 release-notes.json。
    const count = await rebuildChangelog(rootDir);
    process.stdout.write(`CHANGELOG.md rebuilt from release-notes.json (${count} releases).\n`);
    return;
  }
  throw new Error('命令必须是 create、check 或 rebuild-changelog');
}

const entryPath = process.argv[1] === undefined ? '' : pathToFileURL(resolve(process.argv[1])).href;
if (entryPath === import.meta.url) {
  void main().catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`发布失败：${detail}\n`);
    process.exitCode = 1;
  });
}
