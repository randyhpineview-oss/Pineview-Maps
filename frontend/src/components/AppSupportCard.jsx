import { APP_SUPPORT } from '../lib/appSupport';

/**
 * Compact “App support” block for the account avatar popover.
 * Signed-in surfaces only (main app + client portal) — not the login screen.
 */
export default function AppSupportCard() {
  const { name, business, email, phoneDisplay, phoneTel, logoSrc } = APP_SUPPORT;

  return (
    <div className="app-support-card" role="presentation">
      <div className="app-support-card-label">App support</div>
      <img
        className="app-support-card-logo"
        src={logoSrc}
        alt={business}
        width={160}
        height={64}
        decoding="async"
      />
      <div className="app-support-card-name">{name}</div>
      <div className="app-support-card-business">{business}</div>
      <a className="app-support-card-link" href={`tel:${phoneTel}`}>
        {phoneDisplay}
      </a>
      <a className="app-support-card-link" href={`mailto:${email}`}>
        {email}
      </a>
    </div>
  );
}
