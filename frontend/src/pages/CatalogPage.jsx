import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import './CatalogPage.css';

// Ported from Bamboo OS.dc.html's catalog screen (screens.catalog block +
// the catalog computed values, and the shared "catalog" create/edit
// dialog around its render()).
//
// Two deliberate deviations from the prototype:
// 1. The prototype shows Add/Edit/Archive/Delete to anyone with
//    catalog.read, with no can.catalogManage gate at all (unlike every
//    other CRUD screen here, which does gate). Roles exist with
//    catalog.read but not catalog.manage (supervisor, marketing_manager),
//    so literal fidelity would show controls that 403 on click. Gated on
//    catalog.manage instead, matching this app's consistent pattern for
//    every other screen and the backend's actual enforcement.
// 2. Tax rate options come from GET /commercial-settings, which requires
//    settings.manage — a narrower permission than catalog.manage (a
//    department_manager has the latter but not the former). Fetching
//    tax rates is attempted only when the viewer holds settings.manage;
//    otherwise the field is optional and omitted from the payload,
//    which the backend defaults to its own zero-rated tax ('tx_zero').

function statusLabel(active) { return active ? 'Active' : 'Archived'; }

const EMPTY_FORM = { name: '', description: '', code: '', category: '', unit: '', defaultQty: '', unitPrice: '', costPrice: '', taxRateId: '' };

export default function CatalogPage() {
  const { can } = useAuth();
  const canManage = can('catalog.manage');
  const canSeeTaxRates = can('settings.manage');

  const [items, setItems] = useState([]);
  const [taxRates, setTaxRates] = useState([]);
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
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await api.get('/catalog'));
      if (canSeeTaxRates) {
        const settings = await api.get('/commercial-settings');
        setTaxRates(settings.taxRates || []);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [canSeeTaxRates]);

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

  function openEdit(item) {
    setDialogError(null);
    setEditId(item.id);
    setForm({
      name: item.name, description: item.description === '—' ? '' : item.description, code: item.code,
      category: item.category, unit: item.unit, defaultQty: item.defaultQty, unitPrice: item.unitPrice,
      costPrice: item.costPrice, taxRateId: item.taxRateId || ''
    });
    setDialogOpen(true);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      const payload = { ...form };
      if (!payload.taxRateId) delete payload.taxRateId;
      if (editId) await api.put('/catalog/' + editId, payload);
      else await api.post('/catalog', payload);
      setToast(editId ? 'Item updated.' : 'Item added.');
      setDialogOpen(false);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(item) {
    setBusyId(item.id);
    setError(null);
    try {
      await api.post('/catalog/' + item.id + '/active', { active: !item.active });
      setToast(item.name + (item.active ? ' archived.' : ' unarchived.'));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete() {
    setDeleting(true);
    try {
      await api.del('/catalog/' + deleteTarget.id);
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
        <div className="catalog-toolbar">
          <button type="button" className="btn btn-primary" onClick={openNew}>Add item</button>
        </div>
      )}

      <table className="table">
        <thead>
          <tr><th>Item</th><th>Code</th><th>Category</th><th>Unit</th><th>Unit price</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <td>
                <div style={{ fontWeight: 600 }}>{c.name}</div>
                <div className="catalog-description">{c.description || '—'}</div>
              </td>
              <td>{c.code}</td>
              <td>{c.category}</td>
              <td>{c.unit}</td>
              <td>GHS {c.unitPrice.toLocaleString()}</td>
              <td><span className={'tag ' + (c.active ? 'tag-neutral' : 'tag-accent')}>{statusLabel(c.active)}</span></td>
              <td className="table-actions">
                {canManage && <button type="button" className="btn btn-secondary catalog-row-btn" onClick={() => openEdit(c)}>Edit</button>}
                {canManage && (
                  <button type="button" className="btn btn-secondary catalog-row-btn" disabled={busyId === c.id} onClick={() => toggleActive(c)}>
                    {c.active ? 'Archive' : 'Unarchive'}
                  </button>
                )}
                {canManage && <button type="button" className="btn btn-secondary catalog-row-btn" onClick={() => setDeleteTarget(c)}>Delete</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!items.length && <p className="table-empty">No catalogue items yet.</p>}

      {dialogOpen && (
        <div className="dialog-backdrop" onClick={() => setDialogOpen(false)}>
          <form className="dialog catalog-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2 className="catalog-dialog-title">{editId ? 'Edit catalogue item' : 'Add catalogue item'}</h2>
            {dialogError && <div className="error-banner catalog-dialog-span">{dialogError}</div>}
            <div className="field catalog-dialog-span">
              <label htmlFor="cat-name">Name</label>
              <input id="cat-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div className="field catalog-dialog-span">
              <label htmlFor="cat-desc">Description</label>
              <textarea id="cat-desc" className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="cat-code">Code</label>
              <input id="cat-code" className="input" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="cat-category">Category</label>
              <input id="cat-category" className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="cat-unit">Unit</label>
              <input id="cat-unit" className="input" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="cat-defaultqty">Default qty</label>
              <input id="cat-defaultqty" className="input" type="number" value={form.defaultQty} onChange={(e) => setForm({ ...form, defaultQty: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="cat-unitprice">Unit price (GHS)</label>
              <input id="cat-unitprice" className="input" type="number" value={form.unitPrice} onChange={(e) => setForm({ ...form, unitPrice: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="cat-costprice">Cost price (GHS)</label>
              <input id="cat-costprice" className="input" type="number" value={form.costPrice} onChange={(e) => setForm({ ...form, costPrice: e.target.value })} />
            </div>
            {canSeeTaxRates && (
              <div className="field">
                <label htmlFor="cat-tax">Tax rate</label>
                <select id="cat-tax" className="input" value={form.taxRateId} onChange={(e) => setForm({ ...form, taxRateId: e.target.value })}>
                  <option value="">Default</option>
                  {taxRates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.rate}%)</option>)}
                </select>
              </div>
            )}
            <div className="dialog-actions catalog-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{editId ? 'Save changes' : 'Add item'}</button>
            </div>
          </form>
        </div>
      )}

      {deleteTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Delete {deleteTarget.name}</h2>
            <p className="dialog-body">This cannot be undone.</p>
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
