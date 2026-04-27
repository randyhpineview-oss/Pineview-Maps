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

// Hide the inline boot splash (defined in index.html) once React has
// committed and painted the first frame. Two nested rAFs guarantee the
// browser has actually flushed the new DOM to the screen before we start
// fading the splash, otherwise users would see a brief flash of empty
// background between splash removal and the first React paint.
if (typeof window !== 'undefined' && typeof window.__pineviewHideSplash === 'function') {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.__pineviewHideSplash();
    });
  });
}
