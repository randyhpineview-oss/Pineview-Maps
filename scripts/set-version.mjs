#!/usr/bin/env node
// Generates frontend/.version.json at build time.
//
// Goal: sequential version numbers (v1.1.15, v1.1.16, v1.1.17 …) that
// auto-increment on every push to master, visible on Vercel deploys.
//
// Why this is non-trivial: Vercel does shallow git clones (--depth=1), so
// `git rev-list --count HEAD` returns 1 in their build env. To get the real
// count we ask GitHub's REST API — specifically, the trick of requesting
// `?per_page=1` and reading the `Link: rel="last"` header, which gives the
// total commit count for free, no auth needed for public repos.
//
// Then we subtract VERSION_OFFSET so the patch number lands wherever we want
// (the first deploy after introducing this script should land at 1.1.15).
//
// Resolution order:
//   1. On Vercel: GitHub API → sequential count
//   2. Locally:   `git rev-list --count HEAD` → sequential count
//   3. Fallback:  derive from VERCEL_GIT_COMMIT_SHA (unique but not sequential)
//   4. Last:     timestamp-based

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, '../frontend/.version.json');

// Subtracted from the absolute commit count to produce the displayed patch.
// Tuned so the first deploy after this script ships shows v1.1.15.
// Bump only if you ever want to renumber.
const VERSION_OFFSET = 392;
const MIN_PATCH = 15; // floor (in case count ever falls below offset)

function tryGit(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

// Use GitHub's pagination Link header to learn the total commit count up to a
// given SHA without auth (public repos: 60 req/hr unauthenticated, plenty for
// deploys). Returns null on any failure so callers can fall back.
async function getCommitCountFromGitHub(owner, repo, sha) {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits?sha=${sha}&per_page=1`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'pineview-maps-build',
      },
    });
    if (!res.ok) {
      console.warn(`[set-version] GitHub API ${res.status} for ${url}`);
      return null;
    }
    const link = res.headers.get('link') || '';
    // Looks like: <https://...&page=405>; rel="last"
    const match = link.match(/[?&]page=(\d+)>;\s*rel="last"/);
    if (match) return parseInt(match[1], 10);
    // No Link header means there's only 1 page — a single commit.
    return 1;
  } catch (err) {
    console.warn('[set-version] GitHub API fetch failed:', err.message);
    return null;
  }
}

function patchFromCount(count) {
  const offset = Math.max(MIN_PATCH, count - VERSION_OFFSET);
  return String(offset);
}

let patch = '';
let commit = '';
let source = '';

const vercelSha = process.env.VERCEL_GIT_COMMIT_SHA || '';
const owner = process.env.VERCEL_GIT_REPO_OWNER || 'randyhpineview-oss';
const repo = process.env.VERCEL_GIT_REPO_SLUG || 'Pineview-Maps';

if (vercelSha) {
  // On Vercel — use GitHub API for true commit count.
  commit = vercelSha.slice(0, 7);
  const count = await getCommitCountFromGitHub(owner, repo, vercelSha);
  if (count != null) {
    patch = patchFromCount(count);
    source = `github-api(count=${count})`;
  } else {
    // API failed — fall back to SHA-derived unique number.
    const asInt = parseInt(vercelSha.slice(0, 7), 16);
    patch = String(asInt % 100000);
    source = 'sha-derived';
  }
} else {
  // Local / non-Vercel: use git directly.
  const count = tryGit('git rev-list --count HEAD');
  commit = (tryGit('git rev-parse HEAD') || 'local').slice(0, 7);
  if (count && count !== '1') {
    patch = patchFromCount(parseInt(count, 10));
    source = `git(count=${count})`;
  } else {
    patch = String(Math.floor(Date.now() / 1000) % 100000);
    source = 'timestamp';
  }
}

const version = `1.1.${patch}`;
const buildTime = new Date().toISOString();

writeFileSync(
  outPath,
  JSON.stringify({ version, commit, buildTime, source }, null, 2) + '\n'
);

console.log(`[set-version] Wrote ${outPath}: version=${version} commit=${commit} source=${source}`);
