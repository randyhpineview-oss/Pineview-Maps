import { APP_SUPPORT } from '../lib/appSupport';

/**
 * Full-screen overlay for App support contact info.
 * Opened from the account menu (same pattern as Tank Mix Recipes).
 * Logo sits faded behind the text.
 */
export default function AppSupportOverlay({ onClose }) {
  const { name, business, email, phoneDisplay, phoneTel, logoSrc } = APP_SUPPORT;

  return (
    <div className="app-support-backdrop" onClick={onClose}>
      <div
        className="app-support-modal"
        role="dialog"
        aria-labelledby="app-support-title"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          className="app-support-bg-logo"
          src={logoSrc}
          alt=""
          aria-hidden="true"
          decoding="async"
        />
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
          <div className="app-support-name">{name}</div>
          <div className="app-support-business">{business}</div>
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
