#!/usr/bin/env node
// Generates frontend/.version.json at build time so vite.config.js can read
// the real commit count without depending on a working git CLI in Vercel's
// shallow-cloned build environment.
//
// Strategy:
//   1. If running on Vercel (VERCEL=1), use VERCEL_GIT_COMMIT_SHA — always set,
//      no shell needed. Patch number = first 7 hex chars converted to decimal,
//      then mod 100000 so the label stays 5 digits max (e.g. v1.1.84231).
//      This is monotonic ENOUGH for the popover label: each new commit gets
//      a unique number, and human-readable. NOT strictly sequential, but the
//      popover label only needs to *change visibly* on each deploy so the
//      user knows the update applied.
//   2. Locally, use `git rev-list --count HEAD` (works because dev clones
//      are full).
//   3. Hard fallback: timestamp-based.

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, '../frontend/.version.json');

function tryGit(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

let patch = '';
let commit = '';

const vercelSha = process.env.VERCEL_GIT_COMMIT_SHA || '';
if (vercelSha) {
  // Convert the first 7 hex chars of the SHA to a decimal number, mod 100000.
  // Each commit's SHA is unique, so each deploy gets a unique patch label.
  const hexPrefix = vercelSha.slice(0, 7);
  const asInt = parseInt(hexPrefix, 16);
  patch = String(asInt % 100000);
  commit = vercelSha.slice(0, 7);
} else {
  // Local dev or non-Vercel CI: use git commit count.
  const count = tryGit('git rev-list --count HEAD');
  if (count && count !== '1') {
    patch = count;
  } else {
    // Last-ditch fallback: timestamp.
    patch = String(Math.floor(Date.now() / 1000) % 100000);
  }
  commit = (tryGit('git rev-parse HEAD') || 'local').slice(0, 7);
}

const version = `1.1.${patch}`;
const buildTime = new Date().toISOString();

writeFileSync(
  outPath,
  JSON.stringify({ version, commit, buildTime }, null, 2) + '\n'
);

console.log(`[set-version] Wrote ${outPath}: version=${version} commit=${commit}`);
