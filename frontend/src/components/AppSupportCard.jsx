import { APP_SUPPORT } from '../lib/appSupport';

/**
 * Full-screen overlay for App support contact info.
 * Opened from the account menu (same pattern as Tank Mix Recipes).
 */
export default function AppSupportOverlay({ onClose }) {
  const { business, email, phoneDisplay, phoneTel, logoSrc } = APP_SUPPORT;

  return (
    <div className="app-support-backdrop" onClick={onClose}>
      <div
        className="app-support-modal"
        role="dialog"
        aria-labelledby="app-support-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="app-support-header">
          <h2 id="app-support-title" className="app-support-title">App support</h2>
          <button
            type="button"
            className="app-support-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="app-support-body">
          <img
            className="app-support-logo"
            src={logoSrc}
            alt={business}
            decoding="async"
          />
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
