import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

import { api } from '../lib/api';

/**
 * Worker Signup QR card.
 *
 * Admin-only. Fetches the invite URL from the backend (GET /api/admin/signup-invite-url)
 * so the SIGNUP_INVITE_SECRET lives ONLY in Render env vars and never in the Vite bundle.
 *
 * Renders the URL as a QR code in a <canvas> via the `qrcode` npm lib, with
 * Copy-URL and Print buttons. Shows a helpful empty state when the backend
 * reports the secret isn't configured yet.
 */
function WorkerSignupQR() {
  const [url, setUrl] = useState(null);
  const [configured, setConfigured] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const canvasRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await api.getSignupInviteUrl();
        if (cancelled) return;
        setConfigured(!!resp.configured);
        setUrl(resp.url || null);
      } catch (err) {
        if (cancelled) return;
        setError(err.message || 'Failed to load invite URL');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Render QR whenever we have both a URL and the canvas is mounted (i.e. the
  // card is expanded). QRCode.toCanvas draws directly into the canvas element.
  useEffect(() => {
    if (!expanded || !url || !canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, url, {
      width: 240,
      margin: 2,
      color: { dark: '#0f172a', light: '#ffffff' },
    }).catch(() => { /* ignore render errors */ });
  }, [expanded, url]);

  async function handleCopy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  function handlePrint() {
    if (!url) return;
    // Render the QR into a data URL, open a new tab with a minimal print-ready
    // layout, and trigger print. Avoids printing the whole admin panel.
    QRCode.toDataURL(url, { width: 640, margin: 4 }).then((dataUrl) => {
      const w = window.open('', '_blank');
      if (!w) return;
      w.document.write(`<!doctype html><html><head><title>Pineview Maps — Worker Signup QR</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 2rem; text-align: center; color: #0f172a; }
  h1 { margin: 0 0 0.5rem 0; font-size: 1.75rem; }
  p { margin: 0 0 1.5rem 0; color: #475569; }
  img { max-width: 80vmin; height: auto; border: 1px solid #e2e8f0; padding: 12px; background: #fff; }
  .caption { margin-top: 1.5rem; font-size: 1.1rem; font-weight: 600; }
  .sub { margin-top: 0.5rem; color: #64748b; font-size: 0.9rem; }
  @media print { body { padding: 0; } .noprint { display: none; } }
</style>
</head><body>
  <h1>Scan to join Pineview Maps</h1>
  <p>Sign up for a worker account</p>
  <img src="${dataUrl}" alt="Pineview Maps signup QR" />
  <div class="caption">Scan with your phone's camera</div>
  <div class="sub">You'll be asked for your name, email, and a password.</div>
  <div class="noprint" style="margin-top: 2rem;"><button onclick="window.print()" style="padding: 0.6rem 1.5rem; font-size: 1rem; cursor: pointer;">Print</button></div>
</body></html>`);
      w.document.close();
    }).catch(() => { /* ignore */ });
  }

  return (
    <div className="site-row" style={{ marginBottom: '0.75rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
        <strong style={{ fontSize: '0.95rem' }}>Worker Signup QR</strong>
        <button
          className="secondary-button"
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{ fontSize: '0.8rem', padding: '4px 12px' }}
        >
          {expanded ? 'Hide' : 'Show'}
        </button>
      </div>

      {expanded && (
        <div style={{ marginTop: '0.75rem' }}>
          {loading && <div className="small-text">Loading…</div>}

          {!loading && error && (
            <div style={{ background: '#7f1d1d', color: '#fca5a5', padding: '0.5rem 0.75rem', borderRadius: '6px', fontSize: '0.85rem' }}>
              {error}
            </div>
          )}

          {!loading && !error && configured === false && (
            <div style={{ background: '#78350f', color: '#fcd34d', padding: '0.6rem 0.8rem', borderRadius: '6px', fontSize: '0.85rem', lineHeight: 1.5 }}>
              Self-signup is <strong>disabled</strong>. To enable the QR flow, set the{' '}
              <code style={{ background: 'rgba(0,0,0,0.25)', padding: '1px 4px', borderRadius: '3px' }}>SIGNUP_INVITE_SECRET</code>{' '}
              environment variable on your backend (Render → Environment), then redeploy.
            </div>
          )}

          {!loading && !error && configured && url && (
            <>
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: '0.5rem' }}>
                <canvas ref={canvasRef} style={{ background: '#fff', borderRadius: '6px', padding: '8px' }} />
              </div>

              <div className="small-text" style={{ marginTop: '0.75rem', wordBreak: 'break-all', userSelect: 'all', background: '#0f172a', color: '#e2e8f0', padding: '0.5rem', borderRadius: '4px', fontFamily: 'monospace', fontSize: '0.75rem' }}>
                {url}
              </div>

              <div className="button-row" style={{ marginTop: '0.6rem' }}>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={handleCopy}
                  style={{ fontSize: '0.8rem' }}
                >
                  {copied ? 'Copied!' : 'Copy URL'}
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={handlePrint}
                  style={{ fontSize: '0.8rem' }}
                >
                  Print QR
                </button>
              </div>

              <div className="small-text" style={{ marginTop: '0.6rem', color: '#fbbf24', lineHeight: 1.5 }}>
                ⚠ Anyone with this URL can create a worker account. Keep the printed QR in a supervised area.
                If it leaks, rotate <code>SIGNUP_INVITE_SECRET</code> on Render to invalidate the old QR.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const ROLES = [
  { value: 'admin', label: 'Admin' },
  { value: 'office', label: 'Office' },
  { value: 'worker', label: 'Worker' },
];

function roleBadgeStyle(role) {
  switch (role) {
    case 'admin':
      return { background: '#7c3aed', color: '#fff' };
    case 'office':
      return { background: '#2563eb', color: '#fff' };
    default:
      return { background: '#475569', color: '#fff' };
  }
}

function UserRow({ user, busy, onUpdateRole, onUpdateName, onDelete, currentUserEmail }) {
  const [editingRole, setEditingRole] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [selectedRole, setSelectedRole] = useState(user.role);
  const [editedName, setEditedName] = useState(user.name || '');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isSelf = currentUserEmail && user.email === currentUserEmail;

  function handleSaveRole() {
    if (selectedRole !== user.role) {
      onUpdateRole(user.id, selectedRole);
    }
    setEditingRole(false);
  }

  function handleSaveName() {
    if (editedName.trim() !== (user.name || '')) {
      onUpdateName(user.id, editedName.trim());
    }
    setEditingName(false);
  }

  function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    onDelete(user.id);
    setConfirmDelete(false);
  }

  return (
    <div className="site-row">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem' }}>
        <div style={{ minWidth: 0 }}>
          {editingName ? (
            <input
              type="text"
              value={editedName}
              onChange={(e) => setEditedName(e.target.value)}
              placeholder="Enter name"
              style={{ 
                fontWeight: 'bold', 
                wordBreak: 'break-all',
                border: '1px solid #2563eb',
                borderRadius: '4px',
                padding: '2px 6px',
                fontSize: '0.9rem'
              }}
            />
          ) : (
            <strong style={{ wordBreak: 'break-all' }}>{user.name || user.email.split('@')[0]}</strong>
          )}
          <div className="small-text" style={{ wordBreak: 'break-all' }}>{user.email}</div>
        </div>
        <span
          className="pending-badge"
          style={{ ...roleBadgeStyle(user.role), flexShrink: 0, fontSize: '0.7rem', padding: '2px 8px', borderRadius: '4px' }}
        >
          {user.role}
        </span>
      </div>

      <div className="small-text" style={{ marginTop: '0.35rem', color: '#94a3b8' }}>
        Joined: {user.created_at ? new Date(user.created_at).toLocaleDateString() : '—'}
        {user.last_sign_in_at ? ` · Last login: ${new Date(user.last_sign_in_at).toLocaleDateString()}` : ''}
      </div>

      {editingRole ? (
        <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <select
            value={selectedRole}
            onChange={(e) => setSelectedRole(e.target.value)}
            style={{ flex: 1 }}
          >
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
          <button className="primary-button" type="button" disabled={busy} onClick={handleSaveRole} style={{ padding: '4px 12px', fontSize: '0.8rem' }}>
            Save
          </button>
          <button className="secondary-button" type="button" onClick={() => { setEditingRole(false); setSelectedRole(user.role); }} style={{ padding: '4px 12px', fontSize: '0.8rem' }}>
            Cancel
          </button>
        </div>
      ) : editingName ? (
        <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button className="primary-button" type="button" disabled={busy} onClick={handleSaveName} style={{ padding: '4px 12px', fontSize: '0.8rem' }}>
            Save
          </button>
          <button className="secondary-button" type="button" onClick={() => { setEditingName(false); setEditedName(user.name || ''); }} style={{ padding: '4px 12px', fontSize: '0.8rem' }}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="button-row" style={{ marginTop: '0.55rem' }}>
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={() => setEditingName(true)}
            style={{ fontSize: '0.8rem' }}
          >
            Edit name
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={() => setEditingRole(true)}
            style={{ fontSize: '0.8rem' }}
          >
            Change role
          </button>
          {!isSelf ? (
            <button
              className="danger-button"
              type="button"
              disabled={busy}
              onClick={handleDelete}
              style={{ fontSize: '0.8rem' }}
            >
              {confirmDelete ? 'Confirm delete?' : 'Delete'}
            </button>
          ) : (
            <span className="small-text" style={{ color: '#94a3b8', alignSelf: 'center' }}>(you)</span>
          )}
          {confirmDelete && !isSelf ? (
            <button
              className="secondary-button"
              type="button"
              onClick={() => setConfirmDelete(false)}
              style={{ fontSize: '0.8rem' }}
            >
              Cancel
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default function UserManagementPanel({ busy: externalBusy, currentUserEmail, cachedUsers = [], onUsersChanged }) {
  const users = cachedUsers;
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  // New user form
  const [showForm, setShowForm] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('worker');

  const isBusy = busy || externalBusy;

  function clearMessages() {
    setError('');
    setSuccess('');
  }


  async function handleCreateUser(e) {
    e.preventDefault();
    clearMessages();

    if (!newEmail.trim() || !newPassword.trim()) {
      setError('Email and password are required');
      return;
    }
    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setBusy(true);
    try {
      await api.createUser({
        email: newEmail.trim(),
        password: newPassword,
        name: newName.trim() || undefined,
        role: newRole,
      });
      setSuccess(`User ${newEmail.trim()} created successfully`);
      setNewEmail('');
      setNewPassword('');
      setNewName('');
      setNewRole('worker');
      setShowForm(false);
      onUsersChanged?.();
    } catch (err) {
      setError(err.message || 'Failed to create user');
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateRole(userId, newRoleValue) {
    clearMessages();
    setBusy(true);
    try {
      await api.updateUser(userId, { role: newRoleValue });
      setSuccess('User role updated');
      onUsersChanged?.();
    } catch (err) {
      setError(err.message || 'Failed to update user');
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateName(userId, newName) {
    clearMessages();
    setBusy(true);
    try {
      await api.updateUser(userId, { name: newName });
      setSuccess('User name updated');
      onUsersChanged?.();
    } catch (err) {
      setError(err.message || 'Failed to update user');
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteUser(userId) {
    clearMessages();
    setBusy(true);
    try {
      await api.deleteUser(userId);
      setSuccess('User deleted');
      onUsersChanged?.();
    } catch (err) {
      setError(err.message || 'Failed to delete user');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {/* QR-code worker self-signup card. Admin-only; backend gates on
          SIGNUP_INVITE_SECRET so the URL is useless without it. */}
      <WorkerSignupQR />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <h3 style={{ margin: 0 }}>User Management</h3>
        <button
          className="primary-button"
          type="button"
          onClick={() => { setShowForm((c) => !c); clearMessages(); }}
          style={{ fontSize: '0.8rem', padding: '4px 12px' }}
        >
          {showForm ? 'Cancel' : '+ Add User'}
        </button>
      </div>

      {error ? (
        <div style={{ background: '#7f1d1d', color: '#fca5a5', padding: '0.5rem 0.75rem', borderRadius: '6px', marginBottom: '0.75rem', fontSize: '0.85rem' }}>
          {error}
        </div>
      ) : null}

      {success ? (
        <div style={{ background: '#14532d', color: '#86efac', padding: '0.5rem 0.75rem', borderRadius: '6px', marginBottom: '0.75rem', fontSize: '0.85rem' }}>
          {success}
        </div>
      ) : null}

      {showForm ? (
        <form onSubmit={handleCreateUser} className="site-row" style={{ marginBottom: '0.75rem' }}>
          <strong style={{ fontSize: '0.9rem' }}>Create User</strong>
          <div className="list-grid" style={{ marginTop: '0.5rem' }}>
            <input
              type="email"
              placeholder="Email address"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              required
            />
            <input
              type="text"
              placeholder="Full name (optional)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <input
              type="password"
              placeholder="Password (min 6 characters)"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              minLength={6}
            />
            <select value={newRole} onChange={(e) => setNewRole(e.target.value)}>
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
            <button className="primary-button" type="submit" disabled={isBusy}>
              {busy ? 'Creating…' : 'Create User'}
            </button>
          </div>
        </form>
      ) : null}

      <div className="list-grid">
          {users.length === 0 ? (
            <div className="site-row">
              <div className="small-text">No users found.</div>
            </div>
          ) : (
            users.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                busy={isBusy}
                onUpdateRole={handleUpdateRole}
                onUpdateName={handleUpdateName}
                onDelete={handleDeleteUser}
                currentUserEmail={currentUserEmail}
              />
            ))
          )}
      </div>
    </div>
  );
}
