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

export default function UsersPage() {
  const { can, session } = useAuth();
  const canSeeRoles = can('employee.read');

  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [u, r] = await Promise.all([
        api.get('/users'),
        canSeeRoles ? api.get('/roles') : Promise.resolve([])
      ]);
      setUsers(u);
      setRoles(r);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [canSeeRoles]);

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

  if (loading) return <div className="eyebrow">Loading…</div>;

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

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
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!users.length && <p className="table-empty">No user accounts yet.</p>}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
