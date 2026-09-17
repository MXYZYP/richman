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

export async function checkReleaseFiles(rootDir: string): Promise<ReleaseCatalog> {
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

  if (changelog !== renderChangelog(catalog)) {
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
    execFileSync('git', ['cat-file', '-e', `${previousSha}^{commit}`], { cwd: rootDir, stdio: 'pipe' });
  } catch {
    throw new Error(`无法读取上一提交 ${previousSha}；CI checkout 必须包含完整历史`);
  }

  const changedPaths = execFileSync('git', ['diff', '--name-only', previousSha, 'HEAD'], {
    cwd: rootDir,
    encoding: 'utf8',
  }).split('\n').filter(Boolean);

  let hasPreviousCatalog = true;
  try {
    execFileSync('git', ['cat-file', '-e', `${previousSha}:${RELEASE_FILE}`], { cwd: rootDir, stdio: 'pipe' });
  } catch {
    hasPreviousCatalog = false;
  }

  let previous: ReleaseCatalog | null = null;
  if (hasPreviousCatalog) {
    const previousText = execFileSync('git', ['show', `${previousSha}:${RELEASE_FILE}`], {
      cwd: rootDir,
      encoding: 'utf8',
    });
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
  throw new Error('命令必须是 create 或 check');
}

const entryPath = process.argv[1] === undefined ? '' : pathToFileURL(resolve(process.argv[1])).href;
if (entryPath === import.meta.url) {
  void main().catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`发布失败：${detail}\n`);
    process.exitCode = 1;
  });
}
