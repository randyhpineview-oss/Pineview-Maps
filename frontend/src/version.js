// Build-time version metadata, injected by Vite's `define` (see vite.config.js)
// from CI env vars VITE_APP_VERSION / VITE_APP_COMMIT / VITE_APP_BUILD_TIME.
//
// In local dev these defines fall back to 'dev' so we never crash on a missing
// global. In CI (GitHub Actions, .github/workflows/deploy.yml) the version is
// computed as `1.0.<run_number>` and the commit is `github.sha` shortened to 7
// chars, so every push to main bumps the patch number automatically.

/* global __APP_VERSION__, __APP_COMMIT__, __APP_BUILD_TIME__ */

export const APP_VERSION =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

export const APP_COMMIT =
  typeof __APP_COMMIT__ !== 'undefined' ? __APP_COMMIT__ : 'local';

export const APP_BUILD_TIME =
  typeof __APP_BUILD_TIME__ !== 'undefined' ? __APP_BUILD_TIME__ : '';

// Short, user-facing label. e.g. "v1.0.42 (a1b2c3d)".
export const APP_VERSION_LABEL = `v${APP_VERSION}${APP_COMMIT && APP_COMMIT !== 'local' ? ` (${APP_COMMIT})` : ''}`;
