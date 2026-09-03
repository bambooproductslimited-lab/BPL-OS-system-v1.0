import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
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

// Redesigned around the icon language established elsewhere: an icon'd
// empty state for the permission filter. The permission matrix itself is
// a checkbox grid, not a list of entities, so no per-row badges apply.

function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="8" cy="15" r="4" stroke="currentColor" strokeWidth="1.6" />
      <path d="M11 12 19 4M16 6l2.5 2.5M13.5 8.5 16 11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function RolesPage() {
  const { can } = useAuth();
  const canManage = can('role.manage');

  const [roles, setRoles] = useState([]);
  const [catalogue, setCatalogue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [search, setSearch] = useState('');

  const [newRoleDialog, setNewRoleDialog] = useState(false);
  const [newRoleForm, setNewRoleForm] = useState({ name: '', description: '' });
  const [newRoleError, setNewRoleError] = useState('');
  const [newRoleSaving, setNewRoleSaving] = useState(false);
  const [deletingRoleId, setDeletingRoleId] = useState(null);

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

  function openNewRoleDialog() {
    setNewRoleForm({ name: '', description: '' });
    setNewRoleError('');
    setNewRoleDialog(true);
  }

  async function saveNewRole(e) {
    e.preventDefault();
    setNewRoleSaving(true);
    setNewRoleError('');
    try {
      await api.post('/roles', { name: newRoleForm.name, description: newRoleForm.description });
      setNewRoleDialog(false);
      await load();
    } catch (err) {
      setNewRoleError(err.message);
    } finally {
      setNewRoleSaving(false);
    }
  }

  async function deleteRole(role) {
    if (!window.confirm('Delete the "' + role.name + '" role? This can\'t be undone.')) return;
    setDeletingRoleId(role.id);
    setError(null);
    try {
      await api.del('/roles/' + role.id);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingRoleId(null);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visibleCatalogue = catalogue.filter((p) => matchesQuery(search, p.group, p.label, p.key));

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}
      <div className="roles-section-header">
        <p className="roles-intro">
          Permissions are enforced on every operation in the system, not just hidden in the interface.
          The System Administrator role is locked to full access.
        </p>
        {canManage && (
          <button type="button" className="btn btn-primary" onClick={openNewRoleDialog}>+ New role</button>
        )}
      </div>
      <SearchInput value={search} onChange={setSearch} placeholder="Search permissions…" />
      <div className="roles-scroll" style={{ marginTop: 16 }}>
        <table className="table roles-table">
          <thead>
            <tr>
              <th className="roles-perm-col">Permission</th>
              {roles.map((r) => (
                <th key={r.id} className="roles-role-col">
                  {r.name}
                  <div className="roles-usercount">{r.userCount} users</div>
                  {canManage && !r.isSystem && (
                    <button
                      type="button" className="roles-delete-btn" disabled={deletingRoleId === r.id}
                      onClick={() => deleteRole(r)}
                    >
                      {deletingRoleId === r.id ? 'Deleting…' : 'Delete'}
                    </button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleCatalogue.map((p) => (
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
      {!!catalogue.length && !visibleCatalogue.length && (
        <div className="roles-empty-state">
          <span className="roles-empty-icon"><KeyIcon /></span>
          <p className="roles-empty-title">No permissions match "{search}"</p>
        </div>
      )}

      {newRoleDialog && (
        <div className="dialog-backdrop" onClick={() => setNewRoleDialog(false)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveNewRole}>
            <h2>New role</h2>
            {newRoleError && <div className="error-banner">{newRoleError}</div>}
            <div className="field">
              <label htmlFor="role-name">Name</label>
              <input
                id="role-name" className="input" value={newRoleForm.name}
                onChange={(e) => setNewRoleForm({ ...newRoleForm, name: e.target.value })} required
              />
            </div>
            <div className="field">
              <label htmlFor="role-description">Description (optional)</label>
              <input
                id="role-description" className="input" value={newRoleForm.description}
                onChange={(e) => setNewRoleForm({ ...newRoleForm, description: e.target.value })}
              />
            </div>
            <p className="roles-field-hint">
              The role is created with no permissions. Once saved, it appears as a new column in the table below,
              where you check off exactly what it should be able to do.
            </p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setNewRoleDialog(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={newRoleSaving}>{newRoleSaving ? 'Creating…' : 'Create role'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
