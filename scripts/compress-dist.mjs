#!/usr/bin/env node
// Build-time pre-compression for apps/client/dist (E1: static assets compression).
//
// Why this exists:
//   The production server hosts `apps/client/dist` through `sirv`, and sirv's
//   `gzip` / `brotli` options are **pre-compressed file lookups**, not on-the-fly
//   compression: it only serves `/assets/app.js.br` when that file already exists
//   next to `/assets/app.js`. Without this script every byte of the ~700 KB
//   first-screen JS travels uncompressed (verified on the server: a request for an
//   8 KB chunk came back with `Content-Length: 8062` and no `content-encoding`).
//
// Why build-time instead of runtime compression:
//   - zero CPU cost per request (the server box is a single small VPS);
//   - sirv already sets `Content-Encoding` and the correct `Content-Type`
//     (it strips the `.br` / `.gz` suffix before the mime lookup);
//   - degrading is safe: if this script never runs, sirv just serves the original.
//
// Usage:  node scripts/compress-dist.mjs [distDir]
// Skip:   RICHMAN_SKIP_DIST_COMPRESS=1  (leaves dist untouched, exits 0)

import { stat, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { brotliCompress, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

/** Text-ish payloads that actually shrink. Binaries (webp/png/woff2) are already
 *  compressed and would only waste disk. */
const COMPRESSIBLE = new Set([
  '.js', '.mjs', '.cjs', '.css', '.html', '.htm', '.json', '.svg',
  '.webmanifest', '.xml', '.txt', '.map',
]);

/** Files smaller than this are not worth an extra round trip / disk entry. */
const MIN_BYTES = 1024;

const DEFAULT_DIST = fileURLToPath(new URL('../apps/client/dist', import.meta.url));

async function walk(dir, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
      continue;
    }
    out.push(full);
  }
  return out;
}

async function isFresh(target, sourceMtimeMs) {
  try {
    const st = await stat(target);
    return st.mtimeMs >= sourceMtimeMs;
  } catch {
    return false;
  }
}

async function main() {
  const distDir = process.argv[2] ?? DEFAULT_DIST;

  if (process.env.RICHMAN_SKIP_DIST_COMPRESS === '1') {
    console.log('[compress-dist] skipped (RICHMAN_SKIP_DIST_COMPRESS=1)');
    return;
  }

  const distStat = await stat(distDir).catch(() => null);
  if (distStat === null || !distStat.isDirectory()) {
    console.error(`[compress-dist] dist directory not found: ${distDir}`);
    process.exitCode = 1;
    return;
  }

  const files = await walk(distDir, []);
  let written = 0;
  let skipped = 0;
  let rawBytes = 0;
  let brBytes = 0;
  let gzBytes = 0;

  for (const file of files) {
    const ext = extname(file).toLowerCase();
    if (!COMPRESSIBLE.has(ext)) continue;
    // Never compress an already-compressed artefact (idempotent re-runs).
    if (ext === '.br' || ext === '.gz') continue;

    const st = await stat(file);
    if (st.size < MIN_BYTES) continue;

    const brTarget = `${file}.br`;
    const gzTarget = `${file}.gz`;
    if ((await isFresh(brTarget, st.mtimeMs)) && (await isFresh(gzTarget, st.mtimeMs))) {
      skipped += 1;
      continue;
    }

    const source = await readFile(file);
    // zlib defaults: brotli quality 11, gzip level 9 (slowest, smallest) — both are
    // one-off build costs on ~30 files.
    const [br, gzipBuffer] = await Promise.all([
      brotli(source),
      gz(source, { level: 9 }),
    ]);

    // Brotli at max quality can occasionally lose to gzip on tiny inputs; still
    // write both because sirv negotiates per Accept-Encoding, and every file here
    // cleared MIN_BYTES.
    await writeFile(brTarget, br);
    await writeFile(gzTarget, gzipBuffer);

    written += 1;
    rawBytes += st.size;
    brBytes += br.length;
    gzBytes += gzipBuffer.length;
  }

  // Drop stale companions whose source file disappeared (chunk hashes rotate).
  for (const file of files) {
    const ext = extname(file).toLowerCase();
    if (ext !== '.br' && ext !== '.gz') continue;
    const source = file.slice(0, -3);
    const exists = await stat(source).catch(() => null);
    if (exists === null) {
      await unlink(file);
      skipped += 1;
    }
  }

  const pct = (part, whole) => (whole === 0 ? '-' : `${Math.round((part / whole) * 100)}%`);
  console.log(
    `[compress-dist] ${distDir}: +${written} compressed, ${skipped} up-to-date/removed`
    + ` | raw ${rawBytes} B -> br ${brBytes} B (${pct(brBytes, rawBytes)}), gz ${gzBytes} B (${pct(gzBytes, rawBytes)})`,
  );
}

await main();
