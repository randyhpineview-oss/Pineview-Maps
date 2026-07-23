import { useMemo, useState } from 'react';

import { api } from '../lib/api';

/**
 * "Invite Client" — creates an external, invite-only, read-only
 * client-portal account. Available to admin, office, AND crew_lead
 * ("field lead" in the product ask) — unlike the rest of User Management,
 * which stays admin/office only.
 *
 * Client is a required single-select dropdown sourced from the SAME list
 * as the map's client filter (`clients` prop) — no free typing, so a
 * misspelled company name can never silently scope someone to zero sites.
 * Areas are optional; leaving all unchecked means "every area for this
 * client". A client account is always scoped to exactly one company.
 *
 * Two ways to actually get the invite to the client (matches how Pineview
 * said they want to operate — sometimes email it themselves, sometimes
 * text a link):
 *   - "Email setup link" (Flow A): backend creates the account now and
 *     emails a one-tap "set your password" link directly.
 *   - "Generate invite link" (Flow B): backend returns a single-use URL
 *     the admin copies and sends themselves (text, email, whatever) — no
 *     account exists yet; the client's own visit + signup form creates it.
 */
export default function InviteClientPanel({ clients = [], getAreasForClient }) {
  const [selectedClient, setSelectedClient] = useState('');
  const [selectedAreas, setSelectedAreas] = useState([]);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [generatedLink, setGeneratedLink] = useState('');
  const [copied, setCopied] = useState(false);

  const availableAreas = useMemo(
    () => (selectedClient && typeof getAreasForClient === 'function' ? getAreasForClient(selectedClient) : []),
    [selectedClient, getAreasForClient]
  );

  function clearMessages() {
    setError('');
    setSuccess('');
    setGeneratedLink('');
  }

  function toggleArea(area) {
    setSelectedAreas((prev) =>
      prev.includes(area) ? prev.filter((a) => a !== area) : [...prev, area]
    );
  }

  // Reset the area selection whenever the client changes — an area picked
  // for one client is meaningless (and potentially confusing/wrong) for a
  // different one.
  function handleClientChange(value) {
    setSelectedClient(value);
    setSelectedAreas([]);
  }

  async function handleEmailSetupLink(e) {
    e.preventDefault();
    clearMessages();
    if (!selectedClient) {
      setError('Choose a client first.');
      return;
    }
    if (!email.trim()) {
      setError('Enter the client contact\'s email address.');
      return;
    }
    setBusy(true);
    try {
      const resp = await api.inviteClient({
        email: email.trim(),
        name: name.trim() || undefined,
        client_name: selectedClient,
        client_areas: selectedAreas.length > 0 ? selectedAreas : undefined,
      });
      setSuccess(resp?.message || `Setup link sent to ${email.trim()}.`);
      setEmail('');
      setName('');
    } catch (err) {
      setError(err.message || 'Failed to create client account.');
    } finally {
      setBusy(false);
    }
  }

  async function handleGenerateLink() {
    clearMessages();
    if (!selectedClient) {
      setError('Choose a client first.');
      return;
    }
    setBusy(true);
    try {
      const resp = await api.createClientInvite({
        client_name: selectedClient,
        client_areas: selectedAreas.length > 0 ? selectedAreas : undefined,
      });
      setGeneratedLink(resp?.url || '');
    } catch (err) {
      setError(err.message || 'Failed to generate invite link.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCopyLink() {
    if (!generatedLink) return;
    try {
      await navigator.clipboard.writeText(generatedLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="site-row">
      <strong style={{ fontSize: '0.95rem' }}>Invite a Client</strong>
      <p className="small-text" style={{ marginTop: '0.25rem', lineHeight: 1.5 }}>
        Gives an external contact (Shell, CNRL, etc.) a read-only login scoped to one
        company. They'll see their sites, spray history, and herbicide lease sheet
        PDFs — nothing else. There's no public sign-up; this is the only way in.
      </p>

      {error ? (
        <div style={{ background: '#7f1d1d', color: '#fca5a5', padding: '0.5rem 0.75rem', borderRadius: '6px', marginTop: '0.6rem', fontSize: '0.85rem' }}>
          {error}
        </div>
      ) : null}
      {success ? (
        <div style={{ background: '#14532d', color: '#86efac', padding: '0.5rem 0.75rem', borderRadius: '6px', marginTop: '0.6rem', fontSize: '0.85rem' }}>
          {success}
        </div>
      ) : null}

      <div className="list-grid" style={{ marginTop: '0.6rem' }}>
        <select value={selectedClient} onChange={(e) => handleClientChange(e.target.value)}>
          <option value="">Select client…</option>
          {clients.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        {selectedClient && availableAreas.length > 0 ? (
          <div>
            <div className="small-text" style={{ marginBottom: '0.35rem' }}>
              Areas (optional — leave all unchecked for every area of {selectedClient})
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
              {availableAreas.map((area) => (
                <label
                  key={area}
                  className="small-text"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    background: selectedAreas.includes(area) ? 'rgba(59,130,246,0.25)' : 'rgba(148,163,184,0.1)',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedAreas.includes(area)}
                    onChange={() => toggleArea(area)}
                  />
                  {area}
                </label>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {/* Flow A: email a one-tap setup link directly. */}
      <form onSubmit={handleEmailSetupLink} className="list-grid" style={{ marginTop: '0.75rem' }}>
        <div className="small-text" style={{ fontWeight: 600 }}>Option A — Email a setup link</div>
        <input
          type="email"
          placeholder="Client contact's email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="text"
          placeholder="Contact's name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="primary-button" type="submit" disabled={busy || !selectedClient}>
          {busy ? 'Working…' : 'Email setup link'}
        </button>
      </form>

      {/* Flow B: generate a link and send it yourself. */}
      <div style={{ marginTop: '0.75rem' }}>
        <div className="small-text" style={{ fontWeight: 600, marginBottom: '0.4rem' }}>
          Option B — Generate a link to text or email yourself
        </div>
        <button className="secondary-button" type="button" disabled={busy || !selectedClient} onClick={handleGenerateLink}>
          {busy ? 'Working…' : 'Generate invite link'}
        </button>
        {generatedLink ? (
          <div style={{ marginTop: '0.5rem' }}>
            <div
              className="small-text"
              style={{ wordBreak: 'break-all', userSelect: 'all', background: '#0f172a', color: '#e2e8f0', padding: '0.5rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem' }}
            >
              {generatedLink}
            </div>
            <button
              className="secondary-button"
              type="button"
              onClick={handleCopyLink}
              style={{ marginTop: '0.4rem', fontSize: '0.8rem' }}
            >
              {copied ? 'Copied!' : 'Copy link'}
            </button>
            <div className="small-text" style={{ marginTop: '0.4rem', color: '#fbbf24' }}>
              Valid for 7 days, single-use. Anyone with this link can sign up as this
              client — send it directly to the contact, don't post it anywhere public.
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
