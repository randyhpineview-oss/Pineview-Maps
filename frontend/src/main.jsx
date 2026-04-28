import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import './index.css';

// Service worker registration is handled by vite-plugin-pwa
// (`injectRegister: 'auto'` in vite.config.js). The plugin generates a
// `registerSW.js` shim and inlines a <script> tag at build time, so
// production builds get the SW automatically. Dev builds skip it
// (`devOptions.enabled: false`) to avoid breaking Vite HMR.
//
// In dev we still proactively unregister any leftover SW from a
// previous production-mode visit on the same origin — without this,
// the cached app-shell from a prior deploy would intercept fetches
// in dev and serve stale code, masking changes.
if (import.meta.env.DEV && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      registrations.forEach((registration) => {
        void registration.unregister();
      });
    }).catch(() => undefined);
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Splash dismissal is now driven by MapView.jsx, which calls
// `window.__pineviewHideSplash()` once the Maps API has reached a
// terminal state (loaded, errored, or offline-fallback). Hiding on
// React-mount was too early: the Maps script typically takes another
// ~500 ms–2 s to finish, and the "Loading map…" / offline-fallback
// intermediate states would flash between the fading splash and the
// first map paint. Letting MapView own the hide keeps the Pineview
// logo steady through the entire load. The 15 s safety-net timer in
// index.html still guards against a wedged state where MapView never
// reaches a terminal render.
