import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import './SuppliersPage.css';

// Ported from Bamboo OS.dc.html's suppliers screen (screens.suppliers
// block + the suppliers computed values, and the shared "supplier"
// create/edit dialog around its render()).
//
// Redesigned around the icon language established elsewhere — suppliers
// are companies, not people, so each gets a hash-colored building badge
// (not an initials avatar) plus an icon'd empty state.

const BADGE_COLORS = ['#3f7d3b', '#2f5f2c', '#7d5c3f', '#3f5a7d', '#7d3f5c', '#5c3f7d', '#7d6b3f', '#3f7d6b'];
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function badgeColor(name) { return BADGE_COLORS[hashStr(name || '') % BADGE_COLORS.length]; }

function BuildingIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="3" width="9" height="18" stroke="currentColor" strokeWidth="1.6" />
      <rect x="14" y="9" width="6" height="12" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 7h1M8 11h1M8 15h1M11 7h1M11 11h1M11 15h1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

const EMPTY_FORM = { name: '', contactPerson: '', phone: '', email: '', address: '', materialsSupplied: '' };

export default function SuppliersPage() {
  const { can } = useAuth();
  const canManage = can('supplier.manage');

  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      setSuppliers(await api.get('/suppliers'));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  function openNew() {
    setDialogError(null);
    setEditId(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(s) {
    setDialogError(null);
    setEditId(s.id);
    setForm({
      name: s.name, contactPerson: s.contactPerson, phone: s.phone || '', email: s.email || '',
      address: s.address || '', materialsSupplied: s.materialsSupplied
    });
    setDialogOpen(true);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      if (editId) await api.put('/suppliers/' + editId, form);
      else await api.post('/suppliers', form);
      setToast(editId ? 'Supplier updated.' : 'Supplier added.');
      setDialogOpen(false);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    setDeleting(true);
    try {
      await api.del('/suppliers/' + deleteTarget.id);
      setToast(deleteTarget.name + ' deleted.');
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visibleSuppliers = suppliers.filter((s) => matchesQuery(search, s.name, s.contactPerson, s.phone, s.materialsSupplied));

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="suppliers-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search suppliers…" />
        {canManage && <button type="button" className="btn btn-primary" onClick={openNew}>Add supplier</button>}
      </div>

      <table className="table">
        <thead>
          <tr><th>Supplier</th><th>Contact</th><th>Phone</th><th>Materials supplied</th><th>Terms</th><th>Batches</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {visibleSuppliers.map((s) => (
            <tr key={s.id}>
              <td>
                <div className="suppliers-name-cell">
                  <span className="suppliers-badge" style={{ background: badgeColor(s.name) }}><BuildingIcon /></span>
                  <span style={{ fontWeight: 600 }}>{s.name}</span>
                </div>
              </td>
              <td>{s.contactPerson}</td>
              <td>{s.phone}</td>
              <td style={{ fontSize: 13 }}>{s.materialsSupplied}</td>
              <td>{s.paymentTerms}</td>
              <td>{s.batchCount}</td>
              <td><span className={'tag ' + (s.status === 'active' ? 'tag-neutral' : 'tag-accent')}>{s.status}</span></td>
              <td className="table-actions">
                {canManage && <button type="button" className="btn btn-secondary suppliers-row-btn" onClick={() => openEdit(s)}>Edit</button>}
                {canManage && s.batchCount === 0 && (
                  <button type="button" className="btn btn-secondary suppliers-row-btn" onClick={() => setDeleteTarget(s)}>Delete</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!suppliers.length && (
        <div className="suppliers-empty-state">
          <span className="suppliers-empty-icon"><BuildingIcon /></span>
          <p className="suppliers-empty-title">No suppliers on file yet</p>
        </div>
      )}
      {!!suppliers.length && !visibleSuppliers.length && (
        <div className="suppliers-empty-state">
          <span className="suppliers-empty-icon"><BuildingIcon /></span>
          <p className="suppliers-empty-title">No suppliers match "{search}"</p>
        </div>
      )}

      {dialogOpen && (
        <div className="dialog-backdrop" onClick={() => setDialogOpen(false)}>
          <form className="dialog suppliers-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2 className="suppliers-dialog-title">{editId ? 'Edit supplier' : 'Add supplier'}</h2>
            {dialogError && <div className="error-banner suppliers-dialog-span">{dialogError}</div>}
            <div className="field suppliers-dialog-span">
              <label htmlFor="sup-name">Supplier name</label>
              <input id="sup-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="sup-contact">Contact person</label>
              <input id="sup-contact" className="input" value={form.contactPerson} onChange={(e) => setForm({ ...form, contactPerson: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="sup-phone">Phone</label>
              <input id="sup-phone" className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="sup-email">Email</label>
              <input id="sup-email" className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="sup-address">Address</label>
              <input id="sup-address" className="input" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </div>
            <div className="field suppliers-dialog-span">
              <label htmlFor="sup-materials">Materials supplied</label>
              <input id="sup-materials" className="input" value={form.materialsSupplied} onChange={(e) => setForm({ ...form, materialsSupplied: e.target.value })} required />
            </div>
            <div className="dialog-actions suppliers-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{editId ? 'Save changes' : 'Add supplier'}</button>
            </div>
          </form>
        </div>
      )}

      {deleteTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Delete supplier</h2>
            <p className="dialog-body">Delete <strong>{deleteTarget.name}</strong>? This cannot be undone.</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDelete}>{deleting ? 'Deleting…' : 'Delete'}</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
