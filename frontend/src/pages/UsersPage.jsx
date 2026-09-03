import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import './UsersPage.css';

// Ported from Bamboo OS.dc.html's users screen (screens.users block + the
// users computed value), backed by GET /api/users, POST /api/users/:id/role,
// and POST /api/users/:id/status. The backend blocks changing your own role
// or disabling your own account (users.service.js's setRole/setStatus), so
// the row for the signed-in user disables both controls rather than letting
// the click round-trip into a 403.
//
// Redesigned around the icon language established elsewhere: an avatar
// per user row, an icon'd empty state. The create/reset-password dialogs
// are untouched.

const AVATAR_COLORS = ['#3f7d3b', '#2f5f2c', '#7d5c3f', '#3f5a7d', '#7d3f5c', '#5c3f7d', '#7d6b3f', '#3f7d6b'];
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return ((parts[0] ? parts[0][0] : '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function avatarColor(name) { return AVATAR_COLORS[hashStr(name || '') % AVATAR_COLORS.length]; }

function UsersIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M2.5 19c0-3.6 2.5-6 5.5-6s5.5 2.4 5.5 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="16.5" cy="9" r="2.3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M14.8 13.3c2.6.4 4.7 2.5 4.7 5.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function tagClass(status) {
  if (['approved', 'present', 'active', 'completed'].includes(status)) return 'tag-neutral';
  if (['pending', 'late', 'in_progress', 'under_review', 'waiting', 'not_started', 'planning'].includes(status)) return 'tag-outline';
  if (['rejected', 'absent', 'disabled', 'cancelled', 'on_hold', 'delayed'].includes(status)) return 'tag-accent';
  return 'tag-neutral';
}

function fmtLastLogin(iso) {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const EMPTY_NEW_USER = { employeeId: '', roleId: '', password: '', confirmPassword: '', mustChangePassword: true };

export default function UsersPage() {
  const { can, session } = useAuth();
  const canSeeRoles = can('employee.read');
  const canCreate = can('user.create');

  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const [availableEmployees, setAvailableEmployees] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newUser, setNewUser] = useState(EMPTY_NEW_USER);
  const [createError, setCreateError] = useState(null);
  const [creating, setCreating] = useState(false);

  const [resetTarget, setResetTarget] = useState(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetConfirm, setResetConfirm] = useState('');
  const [resetError, setResetError] = useState(null);
  const [resetting, setResetting] = useState(false);
  const [search, setSearch] = useState('');

  const [emailTarget, setEmailTarget] = useState(null);
  const [emailDraft, setEmailDraft] = useState('');
  const [emailError, setEmailError] = useState(null);
  const [emailSaving, setEmailSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [u, r, avail] = await Promise.all([
        api.get('/users'),
        canSeeRoles ? api.get('/roles') : Promise.resolve([]),
        canCreate ? api.get('/users/available-employees') : Promise.resolve([])
      ]);
      setUsers(u);
      setRoles(r);
      setAvailableEmployees(avail);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [canSeeRoles, canCreate]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  async function setRole(user, roleId) {
    setBusyId(user.id);
    setError(null);
    try {
      await api.post('/users/' + user.id + '/role', { roleId });
      setToast(user.name + "'s role updated.");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function toggleStatus(user) {
    setBusyId(user.id);
    setError(null);
    try {
      const nextStatus = user.status === 'active' ? 'disabled' : 'active';
      await api.post('/users/' + user.id + '/status', { status: nextStatus });
      setToast(user.name + ' account ' + nextStatus + '.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  function openCreate() {
    setCreateError(null);
    setNewUser(EMPTY_NEW_USER);
    setShowCreate(true);
  }

  async function handleCreate(e) {
    e.preventDefault();
    setCreateError(null);
    if (newUser.password.length < 8) { setCreateError('Password must be at least 8 characters.'); return; }
    if (newUser.password !== newUser.confirmPassword) { setCreateError('Passwords do not match.'); return; }

    setCreating(true);
    try {
      const created = await api.post('/users', {
        employeeId: newUser.employeeId,
        roleId: newUser.roleId,
        password: newUser.password,
        mustChangePassword: newUser.mustChangePassword
      });
      setToast(created.name + "'s account was created.");
      setShowCreate(false);
      await load();
    } catch (err) {
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  }

  function openReset(user) {
    setResetError(null);
    setResetPassword('');
    setResetConfirm('');
    setResetTarget(user);
  }

  async function handleReset(e) {
    e.preventDefault();
    setResetError(null);
    if (resetPassword.length < 8) { setResetError('Password must be at least 8 characters.'); return; }
    if (resetPassword !== resetConfirm) { setResetError('Passwords do not match.'); return; }

    setResetting(true);
    try {
      await api.post('/users/' + resetTarget.id + '/password', { password: resetPassword });
      setToast("Password reset for " + resetTarget.name + '.');
      setResetTarget(null);
      await load();
    } catch (err) {
      setResetError(err.message);
    } finally {
      setResetting(false);
    }
  }

  function openEmail(user) {
    setEmailError(null);
    setEmailDraft(user.email);
    setEmailTarget(user);
  }

  async function handleEmailSave(e) {
    e.preventDefault();
    setEmailError(null);
    setEmailSaving(true);
    try {
      await api.post('/users/' + emailTarget.id + '/email', { email: emailDraft });
      setToast("Login email updated for " + emailTarget.name + '.');
      setEmailTarget(null);
      await load();
    } catch (err) {
      setEmailError(err.message);
    } finally {
      setEmailSaving(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const roleName = (u) => { const r = roles.find((x) => x.id === u.roleIds[0]); return r ? r.name : ''; };
  const visibleUsers = users.filter((u) => matchesQuery(search, u.name, u.email, roleName(u), u.status));

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      {canCreate && (
        <div style={{ marginBottom: 16 }}>
          <button type="button" className="btn btn-primary" onClick={openCreate}>New user</button>
        </div>
      )}

      <SearchInput value={search} onChange={setSearch} placeholder="Search users…" />

      <table className="table" style={{ marginTop: 16 }}>
        <thead>
          <tr><th>Employee</th><th>Email</th><th>Role</th><th>Last sign-in</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          {visibleUsers.map((u) => {
            const isSelf = session && u.id === session.userId;
            return (
              <tr key={u.id}>
                <td>
                  <div className="users-name-cell">
                    <span className="users-avatar" style={{ background: avatarColor(u.name) }}>{initials(u.name)}</span>
                    <span style={{ fontWeight: 600 }}>{u.name}</span>
                  </div>
                </td>
                <td className="users-email">{u.email}</td>
                <td>
                  <select
                    className="input users-role-select"
                    value={u.roleIds[0] || ''}
                    disabled={isSelf || busyId === u.id}
                    onChange={(e) => setRole(u, e.target.value)}
                  >
                    {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </td>
                <td className="users-lastlogin">{fmtLastLogin(u.lastLoginAt)}</td>
                <td><span className={'tag ' + tagClass(u.status)}>{u.status}</span></td>
                <td className="table-actions">
                  {!isSelf && (
                    <button type="button" className="btn btn-secondary users-row-btn" disabled={busyId === u.id} onClick={() => toggleStatus(u)}>
                      {u.status === 'active' ? 'Disable' : 'Enable'}
                    </button>
                  )}
                  {canCreate && (
                    <button type="button" className="btn btn-secondary users-row-btn" onClick={() => openEmail(u)}>
                      Change email
                    </button>
                  )}
                  {canCreate && (
                    <button type="button" className="btn btn-secondary users-row-btn" onClick={() => openReset(u)}>
                      Reset password
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!users.length && (
        <div className="users-empty-state">
          <span className="users-empty-icon"><UsersIcon /></span>
          <p className="users-empty-title">No user accounts yet</p>
        </div>
      )}
      {!!users.length && !visibleUsers.length && (
        <div className="users-empty-state">
          <span className="users-empty-icon"><UsersIcon /></span>
          <p className="users-empty-title">No users match "{search}"</p>
        </div>
      )}

      {showCreate && (
        <div className="dialog-backdrop" onClick={() => setShowCreate(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>New user</h2>
            <form className="users-dialog-form" onSubmit={handleCreate}>
              <div className="field">
                <label htmlFor="nu-employee">Employee</label>
                <select
                  id="nu-employee"
                  className="input"
                  value={newUser.employeeId}
                  onChange={(e) => setNewUser({ ...newUser, employeeId: e.target.value })}
                  required
                >
                  <option value="" disabled>Select an employee…</option>
                  {availableEmployees.map((emp) => (
                    <option key={emp.id} value={emp.id}>{emp.name} ({emp.email})</option>
                  ))}
                </select>
                {!availableEmployees.length && (
                  <p className="field-hint">Every employee already has a login account.</p>
                )}
              </div>

              <div className="field">
                <label htmlFor="nu-role">Role</label>
                <select
                  id="nu-role"
                  className="input"
                  value={newUser.roleId}
                  onChange={(e) => setNewUser({ ...newUser, roleId: e.target.value })}
                  required
                >
                  <option value="" disabled>Select a role…</option>
                  {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>

              <div className="field">
                <label htmlFor="nu-password">Password</label>
                <input
                  id="nu-password"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={newUser.password}
                  onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                  required
                />
              </div>

              <div className="field">
                <label htmlFor="nu-confirm">Confirm password</label>
                <input
                  id="nu-confirm"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={newUser.confirmPassword}
                  onChange={(e) => setNewUser({ ...newUser, confirmPassword: e.target.value })}
                  required
                />
              </div>

              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={newUser.mustChangePassword}
                  onChange={(e) => setNewUser({ ...newUser, mustChangePassword: e.target.checked })}
                />
                Require a password change at first sign-in
              </label>

              {createError && <div className="error-banner">{createError}</div>}

              <div className="dialog-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={creating || !availableEmployees.length}>
                  {creating ? 'Creating…' : 'Create account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {resetTarget && (
        <div className="dialog-backdrop" onClick={() => setResetTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Reset password</h2>
            <p className="dialog-body">Set a new password for <strong>{resetTarget.name}</strong>. They'll be required to change it at their next sign-in.</p>
            <form className="users-dialog-form" onSubmit={handleReset}>
              <div className="field">
                <label htmlFor="rp-password">New password</label>
                <input
                  id="rp-password"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={resetPassword}
                  onChange={(e) => setResetPassword(e.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="rp-confirm">Confirm new password</label>
                <input
                  id="rp-confirm"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={resetConfirm}
                  onChange={(e) => setResetConfirm(e.target.value)}
                  required
                />
              </div>

              {resetError && <div className="error-banner">{resetError}</div>}

              <div className="dialog-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setResetTarget(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={resetting}>
                  {resetting ? 'Saving…' : 'Reset password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {emailTarget && (
        <div className="dialog-backdrop" onClick={() => setEmailTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Change login email</h2>
            <p className="dialog-body">
              Set the email <strong>{emailTarget.name}</strong> signs in with. This only changes their login
              account — it doesn't touch their employee record's own email address.
            </p>
            <form className="users-dialog-form" onSubmit={handleEmailSave}>
              <div className="field">
                <label htmlFor="ce-email">Login email</label>
                <input
                  id="ce-email"
                  className="input"
                  type="email"
                  autoComplete="off"
                  value={emailDraft}
                  onChange={(e) => setEmailDraft(e.target.value)}
                  required
                />
              </div>

              {emailError && <div className="error-banner">{emailError}</div>}

              <div className="dialog-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setEmailTarget(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={emailSaving}>
                  {emailSaving ? 'Saving…' : 'Save email'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
