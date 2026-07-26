import { APP_SUPPORT } from '../lib/appSupport';

/**
 * Full-screen overlay for App support — the card IS the logo, with phone /
 * email sitting on the dark area under the mark, plus a close (✕) control.
 */
export default function AppSupportOverlay({ onClose }) {
  const { business, email, phoneDisplay, phoneTel, logoSrc } = APP_SUPPORT;

  return (
    <div className="app-support-backdrop" onClick={onClose}>
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
          decoding="async"
        />
        <button
          type="button"
          className="app-support-close"
          onClick={onClose}
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
