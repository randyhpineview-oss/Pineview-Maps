import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'node:child_process';

// ── Build-time version metadata ──────────────────────────────────────────────
// We want a version label visible in the app (avatar popover) that auto-bumps
// on every push to master without anyone editing a number. The site is
// deployed by Vercel (not GitHub Pages), and Vercel exposes useful env vars
// during builds, so we layer fallbacks:
//
//   1. Explicit override:        VITE_APP_VERSION / VITE_APP_COMMIT
//      (used by .github/workflows/deploy.yml when/if Pages is the deploy
//      target, OR set manually in the Vercel dashboard to pin a specific
//      label.)
//   2. Vercel:                   VERCEL_GIT_COMMIT_SHA + a derived patch from
//      the git commit count, so each push to master gets a unique number.
//   3. Local git fallback:       same as Vercel but using local `git` calls.
//   4. Hard fallback:            'dev' / 'local' so dev mode never crashes.
//
// Patch prefix is `1.1.x` (not `1.0.x`) so post-v1.1.12 builds keep climbing
// even when run via the gitCount fallback — gitCount is currently in the
// hundreds, so the label naturally lands far above any prior pinned release.
// `git rev-list --count HEAD` is a stable monotonic patch number across CIs,
// independent of GitHub Actions' run_number (which Vercel obviously doesn't
// have). Wrapped in try/catch so a shallow-clone or missing-git environment
// degrades gracefully instead of failing the build.
function tryGit(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

const explicitVersion = process.env.VITE_APP_VERSION;
const explicitCommit = process.env.VITE_APP_COMMIT;

// Vercel sets VERCEL_GIT_COMMIT_SHA to the full SHA on every build.
const vercelSha = process.env.VERCEL_GIT_COMMIT_SHA || '';

const gitSha = explicitCommit || vercelSha || tryGit('git rev-parse HEAD');
const gitCount = tryGit('git rev-list --count HEAD');

const APP_VERSION = explicitVersion || (gitCount ? `1.1.${gitCount}` : 'dev');
const APP_COMMIT = (gitSha || 'local').slice(0, 7);
const APP_BUILD_TIME = new Date().toISOString();

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __APP_COMMIT__: JSON.stringify(APP_COMMIT),
    __APP_BUILD_TIME__: JSON.stringify(APP_BUILD_TIME),
  },
  plugins: [
    react(),
    // ── App-shell caching service worker (Fix #3) ──
    //
    // Generates a Workbox-based SW at build time that precaches the React
    // app shell (HTML / JS / CSS / icons) so the worker can open the PWA
    // cold-offline. IndexedDB-backed data persistence already worked once
    // the app loaded; the missing piece was the loader itself, which up
    // until now relied on the browser HTTP cache (and silently failed
    // when that cache expired or was evicted in the field).
    //
    // Strategy notes:
    // - registerType: 'autoUpdate' triggers a fresh SW install whenever
    //   the build hash of any precached asset changes. Combined with
    //   `skipWaiting + clientsClaim` below this gives users the new
    //   build on the next page load with no manual unregister.
    // - `navigateFallback: '/index.html'` lets deep links (e.g.
    //   /?ticket=HL000123) hydrate offline; the SPA router takes over
    //   on the client.
    // - `runtimeCaching` is intentionally LIMITED to static asset URLs.
    //   We don't cache /api/* — stale GET responses there would silently
    //   show outdated sites/tickets, and the existing IndexedDB cache
    //   is the right answer for those. Letting /api/* fall through to
    //   the network preserves the current online/offline detection.
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      // The `manifest.webmanifest` already exists at /public — let the
      // plugin pick it up via `manifestFilename`/`includeAssets` rather
      // than re-declaring it inline (single source of truth).
      manifestFilename: 'manifest.webmanifest',
      manifest: false,
      includeAssets: [
        'manifest.webmanifest',
        'icon.svg',
        'icon-32.png',
        'icon-192.png',
        'icon-512.png',
        'logo.png',
      ],
      workbox: {
        // Precache the JS/CSS/HTML produced by the build. `.mjs` is
        // critical: pdfjs-dist ships its worker as
        // `pdf.worker-<hash>.mjs` (~2 MB), and without it the lease-sheet
        // / T&M PDF preview can't render offline (PdfPreviewViewer's
        // getDocument() rejects with a network error). `.wasm` is
        // included defensively — neither lib uses one today, but a
        // dependency upgrade could silently introduce one.
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,ico,webp,wasm}'],
        // Map-tile chunks aren't matched (they're loaded at runtime
        // from Google's CDN, not bundled). The pdf.worker.mjs at ~2 MB
        // is the largest precached asset; bumped the cap to 6 MB so
        // a slightly larger build doesn't silently start dropping it.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024, // 6 MB
        navigateFallback: '/index.html',
        // /api/* is excluded from the navigation fallback so a 404 from
        // an API hit doesn't accidentally resolve to the SPA shell.
        navigateFallbackDenylist: [/^\/api\//],
        // App-shell takeover — replace any old SW from previous deploys
        // (or the unregistered stub from before this fix) on first
        // install. Pairs with the App.jsx unregister-removal below.
        skipWaiting: true,
        clientsClaim: true,
        runtimeCaching: [
          // Google Fonts CSS — small, infrequently changing.
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\//,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'gfonts-css' },
          },
          // Google Fonts files — long-lived, cache-first OK.
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'gfonts-files',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
      devOptions: {
        // Disable the SW in dev — Vite HMR + a controlling SW makes
        // local debugging painful. Production build still gets one.
        enabled: false,
      },
    }),
  ],
  base: '/',
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          maps: ['@react-google-maps/api'],
        },
      },
    },
  },
});
