import { useEffect, useMemo, useState } from 'react';

const LS_KEY = 'pv_install_prompt_seen';

function detectPlatform() {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua) && !window.MSStream) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}

function isRunningStandalone() {
  if (typeof window === 'undefined') return false;
  // iOS Safari
  if (window.navigator.standalone === true) return true;
  // Chrome / most others
  if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
  return false;
}

const PhoneFrame = ({ children }) => (
  <div style={{
    width: '120px',
    height: '200px',
    border: '3px solid #1f2937',
    borderRadius: '18px',
    margin: '0 auto 1rem',
    padding: '10px 6px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'space-between',
    background: '#f9fafb',
    position: 'relative',
  }}>
    <div style={{ width: '32px', height: '4px', background: '#1f2937', borderRadius: '2px' }} />
    {children}
    <div style={{ width: '40px', height: '4px', background: '#1f2937', borderRadius: '2px' }} />
  </div>
);

const ShareIconIOS = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#2563eb" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
    <polyline points="16 6 12 2 8 6" />
    <line x1="12" y1="2" x2="12" y2="15" />
  </svg>
);

const MenuIconAndroid = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" fill="#2563eb">
    <circle cx="12" cy="5" r="2" />
    <circle cx="12" cy="12" r="2" />
    <circle cx="12" cy="19" r="2" />
  </svg>
);

/**
 * One-time post-login "Add Pineview Maps to your home screen" overlay.
 *
 * - Mounts via App.jsx when a user logs in AND localStorage.pv_install_prompt_seen !== '1'.
 * - Detects iOS / Android / desktop to show the right 3-step instructions.
 * - Suppresses itself if the app is already running in standalone / installed mode.
 * - "Got it" persists the flag so it never shows again for this browser profile.
 *
 * No service-worker work here — we're intentionally showing manual instructions
 * on both platforms so every worker sees the same steps.
 */
export default function InstallAppPrompt() {
  const platform = useMemo(() => detectPlatform(), []);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Suppress on already-installed PWAs so the worker doesn't see nagging
    // instructions inside the home-screen app itself.
    if (isRunningStandalone()) setDismissed(true);
  }, []);

  const alreadySeen = (() => {
    try {
      return localStorage.getItem(LS_KEY) === '1';
    } catch {
      return false;
    }
  })();

  if (alreadySeen || dismissed) return null;

  const handleDismiss = () => {
    try {
      localStorage.setItem(LS_KEY, '1');
    } catch { /* ignore */ }
    setDismissed(true);
  };

  let headline = 'Install Pineview Maps on your phone';
  let icon = null;
  let steps = [];

  if (platform === 'ios') {
    icon = (
      <PhoneFrame>
        <div style={{ fontSize: '0.7rem', color: '#6b7280' }}>Safari</div>
        <ShareIconIOS />
        <div style={{ fontSize: '0.65rem', color: '#2563eb', fontWeight: 600 }}>Share</div>
      </PhoneFrame>
    );
    steps = [
      <>Tap the <strong>Share</strong> icon <span style={{ display: 'inline-block', verticalAlign: 'middle' }}><ShareIconIOS /></span> at the bottom of Safari.</>,
      <>Scroll down and tap <strong>&ldquo;Add to Home Screen&rdquo;</strong>.</>,
      <>Tap <strong>Add</strong> in the top-right. You're done — launch Pineview from your home screen.</>,
    ];
  } else if (platform === 'android') {
    icon = (
      <PhoneFrame>
        <div style={{ fontSize: '0.7rem', color: '#6b7280' }}>Chrome</div>
        <MenuIconAndroid />
        <div style={{ fontSize: '0.65rem', color: '#2563eb', fontWeight: 600 }}>Menu</div>
      </PhoneFrame>
    );
    steps = [
      <>Tap the <strong>⋮ menu</strong> in the top-right of Chrome.</>,
      <>Tap <strong>&ldquo;Install app&rdquo;</strong> (or <strong>&ldquo;Add to Home screen&rdquo;</strong>).</>,
      <>Tap <strong>Install</strong>. You're done — launch Pineview from your home screen.</>,
    ];
  } else {
    headline = 'Install Pineview Maps';
    steps = [
      <>On your phone, open this site in <strong>Safari (iPhone)</strong> or <strong>Chrome (Android)</strong>.</>,
      <>Open the browser menu (Share on iOS, ⋮ on Android).</>,
      <>Tap <strong>Add to Home Screen</strong> / <strong>Install app</strong>, then confirm.</>,
    ];
  }

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(15, 23, 42, 0.75)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '1rem',
      zIndex: 10000,
    }}>
      <div style={{
        background: '#ffffff',
        borderRadius: '1rem',
        maxWidth: '24rem',
        width: '100%',
        padding: '1.75rem 1.5rem',
        boxShadow: '0 25px 50px rgba(0,0,0,0.35)',
        maxHeight: '90vh',
        overflowY: 'auto',
      }}>
        <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700, color: '#111827', textAlign: 'center' }}>
          {headline}
        </h2>
        <p style={{ marginTop: '0.5rem', marginBottom: '1.25rem', color: '#6b7280', fontSize: '0.9rem', textAlign: 'center', lineHeight: 1.5 }}>
          Install the app for quick one-tap access from your home screen — no App Store needed.
        </p>

        {icon}

        <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {steps.map((step, i) => (
            <li key={i} style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
              <div style={{
                flexShrink: 0,
                width: '28px',
                height: '28px',
                background: 'linear-gradient(135deg, #2563eb, #4f46e5)',
                color: '#fff',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                fontSize: '0.85rem',
              }}>{i + 1}</div>
              <div style={{ color: '#374151', fontSize: '0.9rem', lineHeight: 1.5, paddingTop: '0.2rem' }}>
                {step}
              </div>
            </li>
          ))}
        </ol>

        <button
          type="button"
          onClick={handleDismiss}
          style={{
            marginTop: '1.5rem',
            width: '100%',
            background: 'linear-gradient(90deg, #2563eb, #4f46e5)',
            color: '#fff',
            fontWeight: 600,
            padding: '0.75rem',
            borderRadius: '0.5rem',
            border: 'none',
            cursor: 'pointer',
            fontSize: '0.95rem',
          }}
        >
          Got it
        </button>
      </div>
    </div>
  );
}
