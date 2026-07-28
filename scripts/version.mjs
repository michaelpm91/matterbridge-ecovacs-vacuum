/* eslint-disable */
/**
 * Stamp package.json with a prerelease version identifying the exact commit.
 *
 * Produces:  <baseVersion>-<tag>.<yyyymmddHHmm>.<7charSha>
 * e.g.       0.2.1-dev.202607282045.a1b2c3d
 *
 * The parts are dot-separated so semver compares them as separate identifiers:
 * the timestamp is numeric and therefore ordered chronologically. Joining them
 * with hyphens instead makes the whole suffix one alphanumeric identifier
 * compared character by character, so builds sort by commit hash — meaning a
 * newer build can appear older than one it replaced.
 *
 * Used by `npm run npmPackDev` so every test tarball carries a distinct,
 * traceable version: Matterbridge keys plugins by name+version, so re-uploading
 * the same version can leave you testing stale code, and a bare patch bump does
 * not tell you which commit you are running.
 *
 * The stamp is applied only for the duration of the pack — npmPackDev restores
 * the original package.json afterwards, so the repo stays on a plain x.y.z.
 *
 * Usage:
 *   node scripts/version.mjs <dev|edge|git|local> [--dry-run]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TAGS = ['dev', 'edge', 'git', 'local'];

function usage() {
  return [
    `Usage: node scripts/version.mjs <${TAGS.join('|')}> [--dry-run]`,
    '',
    'Updates package.json version to:',
    '  <baseVersion>-<tag>.<yyyymmddHHmm>.<7charSha>',
    '',
    'Options:',
    '  --dry-run, -n   Print the next version but do not write package.json',
  ].join('\n');
}

function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function getShortSha7(repoRoot) {
  let sha;
  try {
    sha = String(
      execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    ).trim();
  } catch (err) {
    throw new Error(`Unable to determine git short SHA: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!/^[0-9a-f]{7}$/i.test(sha)) {
    throw new Error(`Unexpected git short SHA output: ${JSON.stringify(sha)}`);
  }
  return sha.toLowerCase();
}

/** Refuse to stamp an already-stamped version, so tags never accumulate. */
function requirePlainSemver(version) {
  const trimmed = String(version ?? '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(trimmed)) {
    throw new Error(`package.json version must be plain x.y.z (got: ${JSON.stringify(trimmed)})`);
  }
  return trimmed;
}

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const knownFlags = new Set(['--dry-run', '-n']);
const unknownFlags = args.filter((a) => a.startsWith('-') && !knownFlags.has(a));
if (unknownFlags.length > 0) {
  console.error(`Unknown option(s): ${unknownFlags.join(', ')}\n`);
  console.error(usage());
  process.exit(1);
}

const dryRun = args.includes('--dry-run') || args.includes('-n');
const tag = args.filter((a) => !a.startsWith('-'))[0]?.toLowerCase();
if (!TAGS.includes(tag)) {
  console.error(usage());
  process.exit(1);
}

// ── Stamp ─────────────────────────────────────────────────────────────────────

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = path.join(repoRoot, 'package.json');

const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
const currentVersion = pkg.version;
const nextVersion = `${requirePlainSemver(currentVersion)}-${tag}.${formatTimestamp(new Date())}.${getShortSha7(repoRoot)}`;

if (dryRun) {
  console.log(`[dry-run] package.json version: ${currentVersion} -> ${nextVersion}`);
} else {
  pkg.version = nextVersion;
  await fs.writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  console.log(`package.json version: ${currentVersion} -> ${nextVersion}`);
}
