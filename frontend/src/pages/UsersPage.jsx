import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import './UsersPage.css';

// Ported from Bamboo OS.dc.html's users screen (screens.users block + the
// users computed value), backed by GET /api/users, POST /api/users/:id/role,
// and POST /api/users/:id/status. The backend blocks changing your own role
// or disabling your own account (users.service.js's setRole/setStatus), so
// the row for the signed-in user disables both controls rather than letting
// the click round-trip into a 403.

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

  if (loading) return <div className="eyebrow">Loading…</div>;

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      {canCreate && (
        <div style={{ marginBottom: 16 }}>
          <button type="button" className="btn btn-primary" onClick={openCreate}>New user</button>
        </div>
      )}

      <table className="table">
        <thead>
          <tr><th>Employee</th><th>Email</th><th>Role</th><th>Last sign-in</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const isSelf = session && u.id === session.userId;
            return (
              <tr key={u.id}>
                <td style={{ fontWeight: 600 }}>{u.name}</td>
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
      {!users.length && <p className="table-empty">No user accounts yet.</p>}

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

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
