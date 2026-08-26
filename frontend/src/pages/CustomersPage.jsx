import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import './CustomersPage.css';

// Ported from Bamboo OS.dc.html's customers screen (screens.customers
// block + the customers computed values, and the shared "customer"
// create/edit dialog around its render()).

function tagClass(category) {
  if (category === 'vip' || category === 'active') return 'tag-neutral';
  if (category === 'inactive') return 'tag-accent';
  return 'tag-outline';
}

const CATEGORIES = ['lead', 'prospect', 'active', 'vip', 'inactive'];

const EMPTY_FORM = { name: '', contactPerson: '', email: '', phone: '', address: '', category: 'lead', accountManagerId: '', notes: '' };

export default function CustomersPage() {
  const { can } = useAuth();
  const canManage = can('customer.manage');

  const [customers, setCustomers] = useState([]);
  const [employees, setEmployees] = useState([]);
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
      setCustomers(await api.get('/customers'));
      if (canManage) setEmployees(await api.get('/employees'));
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

  function openNew() {
    setDialogError(null);
    setEditId(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(c) {
    setDialogError(null);
    setEditId(c.id);
    setForm({
      name: c.name, contactPerson: c.contactPerson || '', email: c.email || '', phone: c.phone || '',
      address: c.address || '', category: c.category, accountManagerId: c.accountManagerId || '', notes: c.notes || ''
    });
    setDialogOpen(true);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      if (editId) await api.put('/customers/' + editId, form);
      else await api.post('/customers', form);
      setToast(editId ? 'Customer updated.' : 'Customer added.');
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
      await api.del('/customers/' + deleteTarget.id);
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

  const visibleCustomers = customers.filter((c) => matchesQuery(search, c.name, c.contactPerson, c.email, c.phone));

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="customers-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search customers…" />
        {canManage && <button type="button" className="btn btn-primary" onClick={openNew}>Add customer</button>}
      </div>

      <table className="table">
        <thead>
          <tr><th>Customer</th><th>Contact</th><th>Email / phone</th><th>Category</th><th>Quoted</th><th>Invoiced</th><th>Paid</th><th>Outstanding</th><th /></tr>
        </thead>
        <tbody>
          {visibleCustomers.map((c) => {
            const canDelete = canManage && !(c.quotedTotal > 0 || c.invoicedTotal > 0);
            return (
              <tr key={c.id}>
                <td style={{ fontWeight: 600 }}>{c.name}</td>
                <td>{c.contactPerson}</td>
                <td className="customers-contact-cell">{c.email}<br />{c.phone}</td>
                <td><span className={'tag ' + tagClass(c.category)}>{c.category}</span></td>
                <td>GHS {c.quotedTotal.toLocaleString()}</td>
                <td>GHS {c.invoicedTotal.toLocaleString()}</td>
                <td>GHS {c.paidTotal.toLocaleString()}</td>
                <td style={{ fontWeight: 600 }}>GHS {c.outstandingTotal.toLocaleString()}</td>
                <td className="table-actions">
                  {canManage && <button type="button" className="btn btn-secondary customers-row-btn" onClick={() => openEdit(c)}>Edit</button>}
                  {canDelete && <button type="button" className="btn btn-secondary customers-row-btn" onClick={() => setDeleteTarget(c)}>Delete</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!customers.length && <p className="table-empty">No customers on file yet.</p>}
      {!!customers.length && !visibleCustomers.length && <p className="table-empty">No customers match "{search}".</p>}

      {dialogOpen && (
        <div className="dialog-backdrop" onClick={() => setDialogOpen(false)}>
          <form className="dialog customers-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2 className="customers-dialog-title">{editId ? 'Edit customer' : 'Add customer'}</h2>
            {dialogError && <div className="error-banner customers-dialog-span">{dialogError}</div>}
            <div className="field">
              <label htmlFor="cu-name">Name</label>
              <input id="cu-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="cu-contact">Contact person</label>
              <input id="cu-contact" className="input" value={form.contactPerson} onChange={(e) => setForm({ ...form, contactPerson: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="cu-email">Email</label>
              <input id="cu-email" className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="cu-phone">Phone</label>
              <input id="cu-phone" className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div className="field customers-dialog-span">
              <label htmlFor="cu-address">Address</label>
              <input id="cu-address" className="input" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="cu-category">Category</label>
              <select id="cu-category" className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="cu-manager">Account manager</label>
              <select id="cu-manager" className="input" value={form.accountManagerId} onChange={(e) => setForm({ ...form, accountManagerId: e.target.value })}>
                <option value="">Me</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
              </select>
            </div>
            <div className="field customers-dialog-span">
              <label htmlFor="cu-notes">Notes</label>
              <textarea id="cu-notes" className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <div className="dialog-actions customers-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{editId ? 'Save changes' : 'Add customer'}</button>
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
