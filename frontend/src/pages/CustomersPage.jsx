import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { moneyBreakdown } from '../lib/currency';
import './CustomersPage.css';

// Ported from Bamboo OS.dc.html's customers screen (screens.customers
// block + the customers computed values, and the shared "customer"
// create/edit dialog around its render()).
//
// Redesigned around the icon language established elsewhere — customers
// are companies, not people, so each gets a hash-colored building badge
// (not an initials avatar); the named contact person still gets one,
// since they are a person. Icon'd empty states. Add/edit dialog untouched.

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
function badgeColor(name) { return AVATAR_COLORS[hashStr(name || '') % AVATAR_COLORS.length]; }

function BuildingIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="3" width="9" height="18" stroke="currentColor" strokeWidth="1.6" />
      <rect x="14" y="9" width="6" height="12" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 7h1M8 11h1M8 15h1M11 7h1M11 11h1M11 15h1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function tagClass(category) {
  if (category === 'vip' || category === 'active') return 'tag-neutral';
  if (category === 'inactive') return 'tag-accent';
  return 'tag-outline';
}

const CATEGORIES = ['lead', 'prospect', 'active', 'vip', 'inactive'];

const EMPTY_FORM = { name: '', contactPerson: '', email: '', phone: '', address: '', category: 'lead', accountManagerId: '', notes: '', preferredCurrency: 'GHS' };

export default function CustomersPage() {
  const { can } = useAuth();
  const canManage = can('customer.manage');

  const [customers, setCustomers] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [currencies, setCurrencies] = useState(['GHS']);
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
    try {
      const settings = await api.get('/settings');
      if (settings.commercial && settings.commercial.currencies) setCurrencies(settings.commercial.currencies);
    } catch (err) { /* ignore — falls back to GHS only, see QuotationsPage's identical comment */ }
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
      address: c.address || '', category: c.category, accountManagerId: c.accountManagerId || '', notes: c.notes || '',
      preferredCurrency: c.preferredCurrency || 'GHS'
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
            const canDelete = canManage && !(c.quotedTotals.length || c.invoicedTotals.length);
            const outstandingTotals = c.invoicedTotals.map((r) => ({ currency: r.currency, amount: r.outstanding }));
            const paidTotals = c.invoicedTotals.map((r) => ({ currency: r.currency, amount: r.paid }));
            const invoicedTotals = c.invoicedTotals.map((r) => ({ currency: r.currency, amount: r.invoiced }));
            return (
              <tr key={c.id}>
                <td>
                  <div className="customers-name-cell">
                    <span className="customers-badge" style={{ background: badgeColor(c.name) }}><BuildingIcon /></span>
                    <span style={{ fontWeight: 600 }}>{c.name}</span>
                  </div>
                </td>
                <td>
                  {c.contactPerson ? (
                    <div className="customers-contact-person-cell">
                      <span className="customers-avatar" style={{ background: avatarColor(c.contactPerson) }}>{initials(c.contactPerson)}</span>
                      {c.contactPerson}
                    </div>
                  ) : '—'}
                </td>
                <td className="customers-contact-cell">{c.email}<br />{c.phone}</td>
                <td><span className={'tag ' + tagClass(c.category)}>{c.category}</span></td>
                <td>{moneyBreakdown(c.quotedTotals)}</td>
                <td>{moneyBreakdown(invoicedTotals)}</td>
                <td>{moneyBreakdown(paidTotals)}</td>
                <td style={{ fontWeight: 600 }}>{moneyBreakdown(outstandingTotals)}</td>
                <td className="table-actions">
                  {canManage && <button type="button" className="btn btn-secondary customers-row-btn" onClick={() => openEdit(c)}>Edit</button>}
                  {canDelete && <button type="button" className="btn btn-secondary customers-row-btn" onClick={() => setDeleteTarget(c)}>Delete</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!customers.length && (
        <div className="customers-empty-state">
          <span className="customers-empty-icon"><BuildingIcon /></span>
          <p className="customers-empty-title">No customers on file yet</p>
        </div>
      )}
      {!!customers.length && !visibleCustomers.length && (
        <div className="customers-empty-state">
          <span className="customers-empty-icon"><BuildingIcon /></span>
          <p className="customers-empty-title">No customers match "{search}"</p>
        </div>
      )}

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
              <label htmlFor="cu-currency">Preferred currency</label>
              <select id="cu-currency" className="input" value={form.preferredCurrency} onChange={(e) => setForm({ ...form, preferredCurrency: e.target.value })}>
                {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
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
