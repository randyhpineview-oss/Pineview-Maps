import { useEffect, useRef, useState } from 'react';
import { APP_SUPPORT } from '../lib/appSupport';

/** Match card exit duration (backdrop is 180ms; wait for the longer one). */
const EXIT_MS = 200;

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Full-screen overlay for App support — the card IS the logo, with phone /
 * email sitting on the dark area under the mark, plus a close (✕) control.
 *
 * Shell paints immediately (aspect-ratio + preloaded logo); enter/exit motion
 * is a short intentional fade/scale, not a wait-for-image reveal.
 */
export default function AppSupportOverlay({ onClose }) {
  const { business, email, phoneDisplay, phoneTel, logoSrc, logoWidth, logoHeight } = APP_SUPPORT;
  const [closing, setClosing] = useState(false);
  const closedRef = useRef(false);

  const requestClose = () => {
    if (closedRef.current || closing) return;
    if (prefersReducedMotion()) {
      closedRef.current = true;
      onClose();
      return;
    }
    setClosing(true);
  };

  useEffect(() => {
    if (!closing) return undefined;
    const timer = window.setTimeout(() => {
      if (closedRef.current) return;
      closedRef.current = true;
      onClose();
    }, EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [closing, onClose]);

  return (
    <div
      className={`app-support-backdrop${closing ? ' app-support-backdrop--closing' : ''}`}
      onClick={requestClose}
    >
      <div
        className="app-support-modal"
        role="dialog"
        aria-label="App support"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          className="app-support-logo"
          src={logoSrc}
          alt={business}
          width={logoWidth}
          height={logoHeight}
          decoding="async"
          fetchPriority="high"
        />
        <button
          type="button"
          className="app-support-close"
          onClick={requestClose}
          aria-label="Close"
        >
          ✕
        </button>
        <div className="app-support-contacts">
          <a className="app-support-link" href={`tel:${phoneTel}`}>
            {phoneDisplay}
          </a>
          <a className="app-support-link" href={`mailto:${email}`}>
            {email}
          </a>
        </div>
      </div>
    </div>
  );
}
