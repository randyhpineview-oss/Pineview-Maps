import { useCallback, useEffect, useState } from 'react';

import { api } from '../lib/api';

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

function UserRow({ user, busy, onUpdateRole, onDelete, currentUserEmail }) {
  const [editingRole, setEditingRole] = useState(false);
  const [selectedRole, setSelectedRole] = useState(user.role);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isSelf = currentUserEmail && user.email === currentUserEmail;

  function handleSaveRole() {
    if (selectedRole !== user.role) {
      onUpdateRole(user.id, selectedRole);
    }
    setEditingRole(false);
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
          <strong style={{ wordBreak: 'break-all' }}>{user.name || user.email.split('@')[0]}</strong>
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
      ) : (
        <div className="button-row" style={{ marginTop: '0.55rem' }}>
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

export default function UserManagementPanel({ busy: externalBusy, currentUserEmail }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  // New user form
  const [showForm, setShowForm] = useState(false);
  const [inviteMode, setInviteMode] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('worker');

  const isBusy = busy || externalBusy;

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.listUsers();
      setUsers(data);
    } catch (err) {
      setError(err.message || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

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
      await loadUsers();
    } catch (err) {
      setError(err.message || 'Failed to create user');
    } finally {
      setBusy(false);
    }
  }

  async function handleInviteUser(e) {
    e.preventDefault();
    clearMessages();

    if (!newEmail.trim()) {
      setError('Email address is required');
      return;
    }

    setBusy(true);
    try {
      await api.inviteUser({
        email: newEmail.trim(),
        name: newName.trim() || undefined,
        role: newRole,
      });
      setSuccess(`Invitation sent to ${newEmail.trim()}`);
      setNewEmail('');
      setNewName('');
      setNewRole('worker');
      setShowForm(false);
      await loadUsers();
    } catch (err) {
      setError(err.message || 'Failed to send invitation');
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
      await loadUsers();
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
      await loadUsers();
    } catch (err) {
      setError(err.message || 'Failed to delete user');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <h3 style={{ margin: 0 }}>User Management</h3>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            className="secondary-button"
            type="button"
            onClick={() => { setShowForm((c) => !c); setInviteMode(true); clearMessages(); }}
            style={{ fontSize: '0.8rem', padding: '4px 12px' }}
          >
            {showForm && inviteMode ? 'Cancel' : '+ Invite'}
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => { setShowForm((c) => !c); setInviteMode(false); clearMessages(); }}
            style={{ fontSize: '0.8rem', padding: '4px 12px' }}
          >
            {showForm && !inviteMode ? 'Cancel' : '+ Add User'}
          </button>
        </div>
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
        <form onSubmit={inviteMode ? handleInviteUser : handleCreateUser} className="site-row" style={{ marginBottom: '0.75rem' }}>
          <strong style={{ fontSize: '0.9rem' }}>
            {inviteMode ? 'Invite User' : 'Create User'}
            {inviteMode && (
              <span className="small-text" style={{ marginLeft: '0.5rem', color: '#6b7280', fontWeight: 'normal' }}>
                They'll set their own password
              </span>
            )}
          </strong>
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
            {!inviteMode && (
              <input
                type="password"
                placeholder="Password (min 6 characters)"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={6}
              />
            )}
            <select value={newRole} onChange={(e) => setNewRole(e.target.value)}>
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
            <button className="primary-button" type="submit" disabled={isBusy}>
              {busy ? (inviteMode ? 'Inviting…' : 'Creating…') : (inviteMode ? 'Send Invitation' : 'Create User')}
            </button>
          </div>
        </form>
      ) : null}

      {loading ? (
        <div className="small-text" style={{ padding: '1rem 0' }}>Loading users…</div>
      ) : (
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
                onDelete={handleDeleteUser}
                currentUserEmail={currentUserEmail}
              />
            ))
          )}
        </div>
      )}

      <div style={{ marginTop: '0.5rem' }}>
        <button
          className="secondary-button"
          type="button"
          disabled={loading}
          onClick={loadUsers}
          style={{ fontSize: '0.8rem' }}
        >
          {loading ? 'Refreshing…' : 'Refresh list'}
        </button>
      </div>
    </div>
  );
}
