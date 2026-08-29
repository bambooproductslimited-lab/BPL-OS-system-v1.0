import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import './DepartmentsPage.css';

// Ported from Bamboo OS.dc.html's departments screen (screens.departments
// block) — a list with an inline (not modal) create/edit form, and a
// delete-confirmation dialog gated on headcount === 0, matching the
// backend's own guard (departments.service.js#remove).

const EMPTY_FORM = { code: '', name: '', managerId: '' };

export default function DepartmentsPage() {
  const { can } = useAuth();
  const canManage = can('department.manage');

  const [departments, setDepartments] = useState([]);
  const [managers, setManagers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [form, setForm] = useState(EMPTY_FORM);
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [dialogError, setDialogError] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const [search, setSearch] = useState('');
  const visibleDepartments = useMemo(
    () => departments.filter((d) => matchesQuery(search, d.code, d.name, d.managerName)),
    [departments, search]
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const depts = await api.get('/departments');
      setDepartments(depts);
      if (canManage) {
        const employees = await api.get('/employees');
        setManagers(employees.map((e) => ({ id: e.id, name: e.firstName + ' ' + e.lastName })));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [canManage]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  function startEdit(dept) {
    setEditId(dept.id);
    setForm({ code: dept.code, name: dept.name, managerId: dept.managerId || '' });
  }

  function cancelEdit() {
    setEditId(null);
    setForm(EMPTY_FORM);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = { code: form.code, name: form.name, managerId: form.managerId || null };
      const saved = editId ? await api.put('/departments/' + editId, body) : await api.post('/departments', body);
      setToast('Group ' + saved.code + ' saved.');
      setForm(EMPTY_FORM);
      setEditId(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    setDeleting(true);
    setDialogError(null);
    try {
      await api.del('/departments/' + deleteTarget.id);
      setToast(deleteTarget.name + ' deleted.');
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <SearchInput value={search} onChange={setSearch} placeholder="Search groups…" />

      <table className="table" style={{ marginBottom: 20, marginTop: 16 }}>
        <thead>
          <tr><th>Code</th><th>Group</th><th>Manager</th><th>Headcount</th><th /></tr>
        </thead>
        <tbody>
          {visibleDepartments.map((d) => (
            <tr key={d.id}>
              <td>{d.code}</td>
              <td style={{ fontWeight: 600 }}>{d.name}</td>
              <td>{d.managerName}</td>
              <td>{d.headcount}</td>
              <td className="table-actions">
                {canManage && <button type="button" className="btn btn-secondary departments-row-btn" onClick={() => startEdit(d)}>Edit</button>}
                {canManage && d.headcount === 0 && (
                  <button type="button" className="btn btn-secondary departments-row-btn" onClick={() => { setDialogError(null); setDeleteTarget(d); }}>Delete</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!departments.length && <p className="table-empty">No groups yet.</p>}
      {!!departments.length && !visibleDepartments.length && <p className="table-empty">No groups match "{search}".</p>}

      {canManage && (
        <form className="card departments-form" onSubmit={handleSubmit}>
          <div className="field departments-form-code">
            <label htmlFor="dept-code">Code</label>
            <input id="dept-code" className="input" maxLength={5} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="PKG" required />
          </div>
          <div className="field departments-form-name">
            <label htmlFor="dept-name">{editId ? 'Group name' : 'New group name'}</label>
            <input id="dept-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Packaging" required />
          </div>
          <div className="field departments-form-manager">
            <label htmlFor="dept-manager">Manager</label>
            <select id="dept-manager" className="input" value={form.managerId} onChange={(e) => setForm({ ...form, managerId: e.target.value })}>
              <option value="">Unassigned</option>
              {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          {editId && <button type="button" className="btn btn-secondary" onClick={cancelEdit}>Cancel</button>}
          <button className="btn btn-primary" type="submit" disabled={saving}>
            {saving ? 'Saving…' : (editId ? 'Save changes' : 'Create')}
          </button>
        </form>
      )}

      {deleteTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Delete group</h2>
            <p className="dialog-body">Delete <strong>{deleteTarget.name}</strong>? This cannot be undone.</p>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDelete}>
                {deleting ? 'Deleting…' : 'Delete group'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
