import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import WaybillPreview from '../components/WaybillPreview';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import CatalogPicker from '../components/CatalogPicker';
import './WaybillsPage.css';

// Waybills document goods leaving the factory or showroom — a delivery
// note, not a sales document (no pricing on the line items). The printed
// document (WaybillPreview.jsx) carries the full company letterhead, a
// "shipped to" contact block, and three sign-off lines.
//
// Redesigned around the icon language established elsewhere: an
// origin-colored truck badge per waybill, a driver avatar, icon'd
// empty states. The new-waybill dialog and printed preview are untouched.

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

function TruckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 6.5h10v9H3v-9Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M13 10h3.5L20 13v2.5h-7v-5.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="7" cy="17" r="1.6" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="17" cy="17" r="1.6" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function todayISO() { return new Date().toISOString().slice(0, 10); }

function blankItem() { return { itemNo: '', description: '', qty: 1, unit: 'each' }; }
const EMPTY_FORM = {
  origin: 'factory', destination: '', customerId: '', driverName: '', vehicleNo: '', receivedBy: '',
  shippedToName: '', shippedToAddress: '', shippedToPhone: '', shippedToEmail: '', shippingDate: todayISO(),
  salesRepId: '', packagedBy: '', approvedBy: '', notes: '', items: [blankItem()]
};

function tagClass(status) {
  if (status === 'delivered') return 'tag-neutral';
  if (status === 'cancelled') return 'tag-accent';
  return 'tag-outline';
}

export default function WaybillsPage() {
  const { can } = useAuth();
  const canManage = can('waybill.manage');

  const [waybills, setWaybills] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [previewWb, setPreviewWb] = useState(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [wbs, custs, emps, cat] = await Promise.all([
        api.get('/waybills'),
        can('customer.read') ? api.get('/customers') : Promise.resolve([]),
        can('employee.read') ? api.get('/employees') : Promise.resolve([]),
        can('catalog.read') ? api.get('/catalog') : Promise.resolve([])
      ]);
      setWaybills(wbs);
      setCustomers(custs);
      setEmployees(emps);
      setCatalog(cat.filter((c) => c.active));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [can]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  function openNew() {
    setDialogError(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function pickCustomer(customerId) {
    const c = customers.find((x) => x.id === customerId);
    const autoFill = c && !form.shippedToName && !form.shippedToAddress && !form.shippedToPhone && !form.shippedToEmail;
    setForm({
      ...form, customerId,
      ...(autoFill ? { shippedToName: c.name, shippedToAddress: c.address || '', shippedToPhone: c.phone || '', shippedToEmail: c.email || '' } : {})
    });
  }

  function setItem(idx, key, value) {
    setForm({ ...form, items: form.items.map((it, i) => (i === idx ? { ...it, [key]: value } : it)) });
  }
  function pickCatalogItem(idx, catalogId) {
    const c = catalog.find((x) => x.id === catalogId);
    if (!c) return;
    setForm({
      ...form,
      items: form.items.map((it, i) => (i === idx ? { ...it, itemNo: c.code || it.itemNo, description: c.name, unit: c.unit } : it))
    });
  }
  function addItem() {
    setForm({ ...form, items: form.items.concat([blankItem()]) });
  }
  function removeItem(idx) {
    if (form.items.length <= 1) return;
    setForm({ ...form, items: form.items.filter((_, i) => i !== idx) });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      const body = { ...form, customerId: form.customerId || null, salesRepId: form.salesRepId || null };
      const created = await api.post('/waybills', body);
      setToast(created.waybillNo + ' dispatched.');
      setDialogOpen(false);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(wb, status) {
    setBusyId(wb.id);
    try {
      await api.post('/waybills/' + wb.id + '/status', { status });
      setToast(wb.waybillNo + ' marked ' + status + '.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visibleWaybills = waybills.filter((wb) => matchesQuery(search, wb.waybillNo, wb.destination, wb.customerName, wb.driverName, wb.vehicleNo));

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="waybills-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search waybills…" />
        {canManage && <button type="button" className="btn btn-primary" onClick={openNew}>New waybill</button>}
      </div>

      <table className="table">
        <thead>
          <tr><th>Waybill</th><th>Origin</th><th>Destination</th><th>Driver</th><th>Vehicle</th><th>Date</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {visibleWaybills.map((wb) => (
            <tr key={wb.id}>
              <td>
                <div className="waybills-no-cell">
                  <span className="waybills-badge" style={{ background: badgeColor(wb.origin) }}><TruckIcon /></span>
                  <span style={{ fontWeight: 600 }}>{wb.waybillNo}</span>
                </div>
              </td>
              <td style={{ textTransform: 'capitalize' }}>{wb.origin}</td>
              <td>{wb.destination}{wb.customerName ? ' (' + wb.customerName + ')' : ''}</td>
              <td>
                {wb.driverName ? (
                  <div className="waybills-driver-cell">
                    <span className="waybills-avatar" style={{ background: avatarColor(wb.driverName) }}>{initials(wb.driverName)}</span>
                    {wb.driverName}
                  </div>
                ) : '—'}
              </td>
              <td>{wb.vehicleNo || '—'}</td>
              <td>{fmtDate(wb.createdAt)}</td>
              <td><span className={'tag ' + tagClass(wb.status)}>{wb.status}</span></td>
              <td className="table-actions">
                <button type="button" className="btn btn-secondary waybills-row-btn" onClick={() => setPreviewWb(wb)}>Preview</button>
                {canManage && wb.status === 'dispatched' && (
                  <>
                    <button type="button" className="btn btn-secondary waybills-row-btn" disabled={busyId === wb.id} onClick={() => setStatus(wb, 'delivered')}>Mark delivered</button>
                    <button type="button" className="btn btn-secondary waybills-row-btn" disabled={busyId === wb.id} onClick={() => setStatus(wb, 'cancelled')}>Cancel</button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!waybills.length && (
        <div className="waybills-empty-state">
          <span className="waybills-empty-icon"><TruckIcon /></span>
          <p className="waybills-empty-title">No waybills yet</p>
        </div>
      )}
      {!!waybills.length && !visibleWaybills.length && (
        <div className="waybills-empty-state">
          <span className="waybills-empty-icon"><TruckIcon /></span>
          <p className="waybills-empty-title">No waybills match "{search}"</p>
        </div>
      )}

      {dialogOpen && (
        <div className="dialog-backdrop" onClick={() => setDialogOpen(false)}>
          <form className="dialog waybills-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2 className="waybills-dialog-title">New waybill</h2>
            {dialogError && <div className="error-banner waybills-dialog-span">{dialogError}</div>}

            <div className="field">
              <label htmlFor="wb-origin">Origin</label>
              <select id="wb-origin" className="input" value={form.origin} onChange={(e) => setForm({ ...form, origin: e.target.value })}>
                <option value="factory">Factory</option>
                <option value="showroom">Showroom</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="wb-destination">Destination</label>
              <input id="wb-destination" className="input" value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="wb-customer">Customer (optional)</label>
              <select id="wb-customer" className="input" value={form.customerId} onChange={(e) => pickCustomer(e.target.value)}>
                <option value="">None</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="wb-shipping-date">Shipping date</label>
              <input id="wb-shipping-date" className="input" type="date" value={form.shippingDate} onChange={(e) => setForm({ ...form, shippingDate: e.target.value })} />
            </div>

            <div className="waybills-dialog-span waybills-section-title">Shipped to</div>
            <div className="field">
              <label htmlFor="wb-ship-name">Name</label>
              <input id="wb-ship-name" className="input" value={form.shippedToName} onChange={(e) => setForm({ ...form, shippedToName: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="wb-ship-phone">Phone</label>
              <input id="wb-ship-phone" className="input" value={form.shippedToPhone} onChange={(e) => setForm({ ...form, shippedToPhone: e.target.value })} />
            </div>
            <div className="field waybills-dialog-span">
              <label htmlFor="wb-ship-address">Address</label>
              <input id="wb-ship-address" className="input" value={form.shippedToAddress} onChange={(e) => setForm({ ...form, shippedToAddress: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="wb-ship-email">Email</label>
              <input id="wb-ship-email" className="input" type="email" value={form.shippedToEmail} onChange={(e) => setForm({ ...form, shippedToEmail: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="wb-salesrep">Sales rep</label>
              <select id="wb-salesrep" className="input" value={form.salesRepId} onChange={(e) => setForm({ ...form, salesRepId: e.target.value })}>
                <option value="">None</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
              </select>
            </div>

            <div className="waybills-dialog-span waybills-section-title">Shipment</div>
            <div className="field">
              <label htmlFor="wb-driver">Driver name</label>
              <input id="wb-driver" className="input" value={form.driverName} onChange={(e) => setForm({ ...form, driverName: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="wb-vehicle">Vehicle number</label>
              <input id="wb-vehicle" className="input" value={form.vehicleNo} onChange={(e) => setForm({ ...form, vehicleNo: e.target.value })} />
            </div>

            <div className="waybills-dialog-span">
              <label className="waybills-items-label">Items</label>
              <table className="table waybills-items-table">
                <thead><tr><th>S/N</th><th>Description</th><th>Qty</th><th>Unit</th><th /></tr></thead>
                <tbody>
                  {form.items.map((it, idx) => (
                    <tr key={idx}>
                      <td><input className="input waybills-items-sn" value={it.itemNo} placeholder={String(idx + 1)} onChange={(e) => setItem(idx, 'itemNo', e.target.value)} /></td>
                      <td className="waybills-items-desc-cell">
                        {catalog.length > 0 && (
                          <CatalogPicker
                            options={catalog}
                            placeholder="Search products & services…"
                            onPick={(c) => pickCatalogItem(idx, c.id)}
                          />
                        )}
                        <input className="input" value={it.description} placeholder="Or type a custom item" onChange={(e) => setItem(idx, 'description', e.target.value)} required />
                      </td>
                      <td><input className="input" type="number" min="0.01" step="0.01" value={it.qty} onChange={(e) => setItem(idx, 'qty', e.target.value)} required /></td>
                      <td><input className="input" value={it.unit} onChange={(e) => setItem(idx, 'unit', e.target.value)} /></td>
                      <td>
                        <button type="button" className="btn btn-secondary waybills-row-btn" disabled={form.items.length <= 1} onClick={() => removeItem(idx)}>Remove</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button type="button" className="btn btn-secondary" onClick={addItem}>Add item</button>
            </div>

            <div className="waybills-dialog-span waybills-section-title">Sign-off (optional — printed with a signature line)</div>
            <div className="field">
              <label htmlFor="wb-packaged">Packaged by</label>
              <input id="wb-packaged" className="input" value={form.packagedBy} onChange={(e) => setForm({ ...form, packagedBy: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="wb-received">Received by</label>
              <input id="wb-received" className="input" value={form.receivedBy} onChange={(e) => setForm({ ...form, receivedBy: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="wb-approved">Approved by</label>
              <input id="wb-approved" className="input" value={form.approvedBy} onChange={(e) => setForm({ ...form, approvedBy: e.target.value })} />
            </div>

            <div className="field waybills-dialog-span">
              <label htmlFor="wb-notes">Notes</label>
              <textarea id="wb-notes" className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>

            <div className="dialog-actions waybills-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Dispatching…' : 'Dispatch waybill'}</button>
            </div>
          </form>
        </div>
      )}

      {previewWb && <WaybillPreview waybill={previewWb} onClose={() => setPreviewWb(null)} />}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
