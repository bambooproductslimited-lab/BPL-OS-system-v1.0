import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import './RolesPage.css';

// Ported from Bamboo OS.dc.html's roles screen (screens.roles block + the
// permissionRows computed value), backed by GET /api/roles,
// GET /api/roles/permissions (the permission catalogue), and
// POST /api/roles/:roleId/permissions.
//
// A checkbox is locked for the System Administrator role (the backend
// rejects any change to it — "must always retain full access") and,
// beyond the prototype's own locking, also disabled for a viewer without
// role.manage — the nav already gates this whole screen on role.manage,
// so today that never actually differs, but roles.list itself only
// requires employee.read, so the code doesn't assume the nav gate is the
// only way here.

export default function RolesPage() {
  const { can } = useAuth();
  const canManage = can('role.manage');

  const [roles, setRoles] = useState([]);
  const [catalogue, setCatalogue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyKey, setBusyKey] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [r, c] = await Promise.all([api.get('/roles'), api.get('/roles/permissions')]);
      setRoles(r);
      setCatalogue(c);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function toggle(role, permission, on) {
    const cellKey = role.id + ':' + permission;
    setBusyKey(cellKey);
    setError(null);
    try {
      await api.post('/roles/' + role.id + '/permissions', { permission, on });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyKey(null);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}
      <p className="roles-intro">
        Permissions are enforced on every operation in the system, not just hidden in the interface.
        The System Administrator role is locked to full access.
      </p>
      <div className="roles-scroll">
        <table className="table roles-table">
          <thead>
            <tr>
              <th className="roles-perm-col">Permission</th>
              {roles.map((r) => (
                <th key={r.id} className="roles-role-col">
                  {r.name}
                  <div className="roles-usercount">{r.userCount} users</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {catalogue.map((p) => (
              <tr key={p.key}>
                <td>
                  <div className="roles-perm-label">{p.group} · {p.label}</div>
                  <div className="roles-perm-key">{p.key}</div>
                </td>
                {roles.map((r) => {
                  const on = r.permissions.indexOf(p.key) >= 0;
                  const locked = r.key === 'administrator' || !canManage;
                  const cellKey = r.id + ':' + p.key;
                  return (
                    <td key={r.id} className="roles-checkbox-cell">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={locked || busyKey === cellKey}
                        onChange={(e) => toggle(r, p.key, e.target.checked)}
                        className="roles-checkbox"
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
