import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
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
        // Precache the JS/CSS/HTML produced by the build. PDFs, fonts,
        // and images aren't precached — they're served via runtime
        // strategies below if the user actually visits them.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webp}'],
        // Don't precache massive map tile chunks — they load lazily and
        // are re-fetched online anyway. Caps the SW install size so the
        // first visit isn't slow.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024, // 4 MB
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
