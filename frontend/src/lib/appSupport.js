/** Contact info shown in the signed-in account menu (App support). */
export const APP_SUPPORT = {
  name: 'Randy Horst',
  business: "Randy's Custom Apps",
  email: 'Randyscustomapps@gmail.com',
  phoneDisplay: '(604) 750-0793',
  phoneTel: '+16047500793',
  logoSrc: '/randys-custom-apps-logo.png',
  /** Intrinsic size of randys-custom-apps-logo.png — keeps the card shell
   *  sized before (or without waiting on) the bitmap decode. */
  logoWidth: 682,
  logoHeight: 1024,
};

/**
 * Warm the advertising logo into the browser image cache so the App
 * Support overlay paints instantly on first open (workers + clients).
 * Safe to call repeatedly; browsers dedupe in-flight / cached loads.
 */
export function preloadAppSupportLogo() {
  if (typeof window === 'undefined') return;
  const img = new Image();
  img.decoding = 'async';
  img.src = APP_SUPPORT.logoSrc;
}

// Eager import path: App.jsx / ClientPortal import AppSupportOverlay, which
// pulls this module — warm the logo during that first parse, not on open.
preloadAppSupportLogo();
