export type ReleaseBump = 'patch' | 'minor';

export interface ReleaseEntry {
  readonly version: string;
  readonly date: string;
  readonly title: string;
  readonly changes: readonly string[];
}

export interface ReleaseCatalog {
  readonly releases: readonly ReleaseEntry[];
}

type Semver = readonly [major: number, minor: number, patch: number];

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const NON_RUNTIME_PREFIXES = [
  '.github/',
  '.omp/',
  '.superpowers/',
  'docs/',
  'plan/',
  'scripts/',
] as const;

function parseSemver(version: string): Semver {
  const match = SEMVER_PATTERN.exec(version);
  if (match === null) throw new Error(`版本号“${version}”必须使用 major.minor.patch 格式`);

  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(`版本号“${version}”超出安全整数范围`);
  }
  return parts as unknown as Semver;
}

function compareVersions(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (let index = 0; index < a.length; index += 1) {
    const difference = a[index] - b[index];
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function parseDate(value: unknown, version: string): string {
  if (typeof value !== 'string') throw new Error(`版本 ${version} 的日期必须是 YYYY-MM-DD`);
  const match = DATE_PATTERN.exec(value);
  if (match === null) throw new Error(`版本 ${version} 的日期必须是 YYYY-MM-DD`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new Error(`版本 ${version} 的日期“${value}”无效`);
  }
  return value;
}

function parseEntry(value: unknown, index: number): ReleaseEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`第 ${index + 1} 条版本记录必须是对象`);
  }
  const entry = value as {
    version?: unknown;
    date?: unknown;
    title?: unknown;
    changes?: unknown;
  };
  if (typeof entry.version !== 'string') throw new Error(`第 ${index + 1} 条记录缺少版本号`);

  const version = entry.version;
  parseSemver(version);
  const date = parseDate(entry.date, version);
  if (typeof entry.title !== 'string' || entry.title.trim() === '') {
    throw new Error(`版本 ${version} 的标题不能为空`);
  }
  if (!Array.isArray(entry.changes) || entry.changes.length === 0) {
    throw new Error(`版本 ${version} 的更新内容不能为空`);
  }

  const changes = entry.changes.map((change, changeIndex) => {
    if (typeof change !== 'string' || change.trim() === '') {
      throw new Error(`版本 ${version} 的第 ${changeIndex + 1} 条更新内容不能为空`);
    }
    return change.trim();
  });

  return Object.freeze({
    version,
    date,
    title: entry.title.trim(),
    changes: Object.freeze(changes),
  });
}

export function parseReleaseCatalog(value: unknown): ReleaseCatalog {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('发布清单必须包含至少一个版本');
  }
  const catalog = value as { releases?: unknown };
  if (!Array.isArray(catalog.releases) || catalog.releases.length === 0) {
    throw new Error('发布清单必须包含至少一个版本');
  }

  const releases = catalog.releases.map(parseEntry);
  const seen = new Set<string>();
  for (const release of releases) {
    if (seen.has(release.version)) throw new Error(`版本号 ${release.version} 重复`);
    seen.add(release.version);
  }
  for (let index = 0; index < releases.length - 1; index += 1) {
    const release = releases[index];
    const older = releases[index + 1];
    if (compareVersions(release.version, older.version) <= 0) {
      throw new Error(`版本 ${release.version} 必须高于后一条版本 ${older.version}`);
    }
  }

  return Object.freeze({ releases: Object.freeze(releases) });
}

export function bumpVersion(version: string, bump: ReleaseBump): string {
  const [major, minor, patch] = parseSemver(version);
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  return `${major}.${minor + 1}.0`;
}

export function renderChangelog(catalog: ReleaseCatalog): string {
  const lines = [
    '# 更新说明',
    '',
    '> 此文件由 `release-notes.json` 自动生成，请勿直接编辑。',
    '',
  ];

  for (const release of catalog.releases) {
    lines.push(`## [${release.version}] - ${release.date}`, '', `### ${release.title}`, '');
    for (const change of release.changes) lines.push(`- ${change}`);
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export function requiresVersionBump(paths: readonly string[]): boolean {
  return paths.some((rawPath) => {
    const path = rawPath.replaceAll('\\', '/').replace(/^\.\//, '');
    return !path.endsWith('.md')
      && !NON_RUNTIME_PREFIXES.some((prefix) => path.startsWith(prefix));
  });
}

export function validateReleaseTransition(
  previous: ReleaseCatalog | null,
  current: ReleaseCatalog,
  changedPaths: readonly string[],
): void {
  if (previous === null) return;

  const previousVersion = previous.releases[0].version;
  const currentVersion = current.releases[0].version;
  const comparison = compareVersions(currentVersion, previousVersion);
  if (comparison < 0) {
    throw new Error(`当前版本 ${currentVersion} 不能低于上一版本 ${previousVersion}`);
  }
  if (requiresVersionBump(changedPaths) && comparison === 0) {
    throw new Error(`运行内容已变化，请递增版本 ${previousVersion} 并填写更新说明`);
  }
}
