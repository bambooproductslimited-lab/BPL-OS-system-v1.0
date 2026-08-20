import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import './WaybillsPage.css';

// Waybills document goods leaving the factory or showroom — a delivery
// note, not a sales document (no pricing on the line items).

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function blankItem() { return { description: '', qty: 1, unit: 'each' }; }
const EMPTY_FORM = { origin: 'factory', destination: '', customerId: '', driverName: '', vehicleNo: '', receivedBy: '', notes: '', items: [blankItem()] };

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [wbs, custs] = await Promise.all([api.get('/waybills'), can('customer.read') ? api.get('/customers') : Promise.resolve([])]);
      setWaybills(wbs);
      setCustomers(custs);
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

  function setItem(idx, key, value) {
    setForm({ ...form, items: form.items.map((it, i) => (i === idx ? { ...it, [key]: value } : it)) });
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
      const body = { ...form, customerId: form.customerId || null };
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

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      {canManage && (
        <div className="waybills-toolbar">
          <button type="button" className="btn btn-primary" onClick={openNew}>New waybill</button>
        </div>
      )}

      <table className="table">
        <thead>
          <tr><th>Waybill</th><th>Origin</th><th>Destination</th><th>Driver</th><th>Vehicle</th><th>Date</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {waybills.map((wb) => (
            <tr key={wb.id}>
              <td style={{ fontWeight: 600 }}>{wb.waybillNo}</td>
              <td style={{ textTransform: 'capitalize' }}>{wb.origin}</td>
              <td>{wb.destination}{wb.customerName ? ' (' + wb.customerName + ')' : ''}</td>
              <td>{wb.driverName || '—'}</td>
              <td>{wb.vehicleNo || '—'}</td>
              <td>{fmtDate(wb.createdAt)}</td>
              <td><span className={'tag ' + tagClass(wb.status)}>{wb.status}</span></td>
              <td className="table-actions">
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
      {!waybills.length && <p className="table-empty">No waybills yet.</p>}

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
              <select id="wb-customer" className="input" value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}>
                <option value="">None</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="wb-driver">Driver name</label>
              <input id="wb-driver" className="input" value={form.driverName} onChange={(e) => setForm({ ...form, driverName: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="wb-vehicle">Vehicle number</label>
              <input id="wb-vehicle" className="input" value={form.vehicleNo} onChange={(e) => setForm({ ...form, vehicleNo: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="wb-received">Received by</label>
              <input id="wb-received" className="input" value={form.receivedBy} onChange={(e) => setForm({ ...form, receivedBy: e.target.value })} />
            </div>

            <div className="waybills-dialog-span">
              <label className="waybills-items-label">Items</label>
              <table className="table waybills-items-table">
                <thead><tr><th>Description</th><th>Qty</th><th>Unit</th><th /></tr></thead>
                <tbody>
                  {form.items.map((it, idx) => (
                    <tr key={idx}>
                      <td><input className="input" value={it.description} onChange={(e) => setItem(idx, 'description', e.target.value)} required /></td>
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

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
