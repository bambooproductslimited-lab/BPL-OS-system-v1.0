import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import './SuppliersPage.css';

// Ported from Bamboo OS.dc.html's suppliers screen (screens.suppliers
// block + the suppliers computed values, and the shared "supplier"
// create/edit dialog around its render()).

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

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      {canManage && (
        <div className="suppliers-toolbar">
          <button type="button" className="btn btn-primary" onClick={openNew}>Add supplier</button>
        </div>
      )}

      <table className="table">
        <thead>
          <tr><th>Supplier</th><th>Contact</th><th>Phone</th><th>Materials supplied</th><th>Terms</th><th>Batches</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {suppliers.map((s) => (
            <tr key={s.id}>
              <td style={{ fontWeight: 600 }}>{s.name}</td>
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
      {!suppliers.length && <p className="table-empty">No suppliers on file yet.</p>}

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
