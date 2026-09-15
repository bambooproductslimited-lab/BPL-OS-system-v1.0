import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { money } from '../lib/currency';
import './PokiPages.css';

// Repairs and issues logged against a specific unit. Where the tenant is
// liable (a broken window rather than a failing water heater), the cost can
// be recharged as its own invoice instead of being folded into rent.

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const EMPTY = { unitId: '', title: '', description: '', category: 'general', priority: 'normal', reportedBy: '', chargeToTenant: false };

export default function PokiMaintenancePage() {
  const { can } = useAuth();
  const canManage = can('poki.manage');

  const [requests, setRequests] = useState([]);
  const [units, setUnits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [busyId, setBusyId] = useState(null);

  const [dialog, setDialog] = useState(null); // 'new' | 'edit'
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [r, u] = await Promise.all([api.get('/poki/maintenance'), api.get('/poki/units')]);
      setRequests(r);
      setUnits(u);
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

  function openDialog(r) {
    setDialogError(null);
    setEditId(r ? r.id : null);
    setForm(r ? { ...EMPTY, ...r } : { ...EMPTY, unitId: units[0] ? units[0].id : '' });
    setDialog(r ? 'edit' : 'new');
  }

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      if (editId) await api.patch('/poki/maintenance/' + editId, form);
      else await api.post('/poki/maintenance', form);
      setToast(editId ? 'Request updated.' : 'Request logged.');
      setDialog(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(r, status) {
    setBusyId(r.id);
    try {
      await api.patch('/poki/maintenance/' + r.id, { status });
      setToast('Marked ' + status.replace('_', ' ') + '.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function charge(r) {
    if (!window.confirm('Charge ' + money(r.cost, 'GHS') + ' to ' + r.tenantName + ' as a separate invoice?')) return;
    setBusyId(r.id);
    try {
      const res = await api.post('/poki/maintenance/' + r.id + '/charge');
      setToast('Raised ' + res.invoiceNo + ' for ' + money(res.amount, 'GHS') + '.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visible = requests.filter((r) =>
    matchesQuery(search, r.title, r.unitCode, r.propertyName, r.tenantName, r.category) &&
    (!statusFilter || r.status === statusFilter)
  );
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const openCount = requests.filter((r) => r.status === 'open' || r.status === 'in_progress').length;

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="poki-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search requests…" />
        <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="in_progress">In progress</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <span className="poki-muted">{openCount} open</span>
        <div className="poki-toolbar-spacer" />
        {canManage && <button type="button" className="btn btn-primary" disabled={!units.length} onClick={() => openDialog(null)}>Log request</button>}
      </div>

      {visible.length === 0 ? (
        <div className="poki-empty">
          <p className="poki-empty-title">{requests.length ? 'No requests match' : 'Nothing reported'}</p>
          <p className="poki-empty-sub">
            {requests.length
              ? 'Try a different search or status filter.'
              : 'Log repairs and issues against the unit they affect — the current tenant is attached automatically.'}
          </p>
        </div>
      ) : (
        <div className="poki-table-wrap">
<table className="table">
          <thead>
            <tr>
              <th>Issue</th><th>Unit</th><th>Tenant</th><th>Priority</th><th>Reported</th>
              <th className="poki-num">Cost</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.id}>
                <td>
                  <div className="poki-strong">{r.title}</div>
                  <div className="poki-muted">{r.category}</div>
                </td>
                <td className="poki-nowrap">{r.unitCode}<div className="poki-muted">{r.propertyName}</div></td>
                <td className="poki-nowrap">{r.tenantName || <span className="poki-muted">vacant</span>}</td>
                <td><span className={'poki-chip poki-chip-' + (r.priority === 'urgent' ? 'urgent' : r.priority === 'high' ? 'expiring' : 'open')}>{r.priority}</span></td>
                <td className="poki-nowrap">{fmtDate(r.reportedOn)}</td>
                <td className="poki-num">{r.cost > 0 ? money(r.cost, 'GHS') : <span className="poki-muted">—</span>}</td>
                <td><span className={'poki-chip poki-chip-' + r.status}>{r.status.replace('_', ' ')}</span></td>
                <td className="table-actions">
                  {canManage && r.status === 'open' && (
                    <button type="button" className="btn btn-secondary poki-row-btn" disabled={busyId === r.id} onClick={() => setStatus(r, 'in_progress')}>Start</button>
                  )}
                  {canManage && (r.status === 'open' || r.status === 'in_progress') && (
                    <button type="button" className="btn btn-secondary poki-row-btn" onClick={() => openDialog(r)}>Resolve</button>
                  )}
                  {canManage && r.status !== 'open' && (
                    <button type="button" className="btn btn-secondary poki-row-btn" onClick={() => openDialog(r)}>Edit</button>
                  )}
                  {canManage && r.cost > 0 && r.tenantName && (
                    <button type="button" className="btn btn-secondary poki-row-btn" disabled={busyId === r.id} onClick={() => charge(r)}>Charge tenant</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
</div>
      )}

      {dialog && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <form className="dialog poki-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
            <h2 className="poki-dialog-title">{editId ? 'Update request' : 'Log maintenance request'}</h2>
            {dialogError && <div className="error-banner poki-dialog-span">{dialogError}</div>}

            <div className="field poki-dialog-span">
              <label htmlFor="pmr-unit">Unit</label>
              <select id="pmr-unit" className="input" value={form.unitId} onChange={set('unitId')} required disabled={!!editId}>
                {units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.propertyName} · {u.code}{u.tenantName ? ' — ' + u.tenantName : ' (vacant)'}
                  </option>
                ))}
              </select>
            </div>
            <div className="field poki-dialog-span">
              <label htmlFor="pmr-title">Issue</label>
              <input id="pmr-title" className="input" value={form.title} onChange={set('title')} required placeholder="e.g. Leaking kitchen tap" />
            </div>
            <div className="field">
              <label htmlFor="pmr-cat">Category</label>
              <input id="pmr-cat" className="input" value={form.category} onChange={set('category')} placeholder="plumbing, electrical…" />
            </div>
            <div className="field">
              <label htmlFor="pmr-pri">Priority</label>
              <select id="pmr-pri" className="input" value={form.priority} onChange={set('priority')}>
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            <div className="field poki-dialog-span">
              <label htmlFor="pmr-desc">Description</label>
              <textarea id="pmr-desc" className="input" rows={2} value={form.description} onChange={set('description')} />
            </div>
            {!editId && (
              <div className="field poki-dialog-span">
                <label htmlFor="pmr-by">Reported by</label>
                <input id="pmr-by" className="input" value={form.reportedBy} onChange={set('reportedBy')} placeholder="tenant name, caretaker…" />
              </div>
            )}
            {editId && (
              <>
                <div className="field">
                  <label htmlFor="pmr-status">Status</label>
                  <select id="pmr-status" className="input" value={form.status} onChange={set('status')}>
                    <option value="open">Open</option>
                    <option value="in_progress">In progress</option>
                    <option value="resolved">Resolved</option>
                    <option value="closed">Closed</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="pmr-cost">Repair cost</label>
                  <input id="pmr-cost" className="input" type="number" step="0.01" value={form.cost || ''} onChange={set('cost')} />
                </div>
                <div className="field poki-dialog-span">
                  <label htmlFor="pmr-res">Resolution notes</label>
                  <textarea id="pmr-res" className="input" rows={2} value={form.resolutionNotes || ''} onChange={set('resolutionNotes')} />
                </div>
                <p className="poki-dialog-hint">
                  Recording a cost doesn't charge anyone. Use "Charge tenant" on the row to raise an invoice where the tenant is liable.
                </p>
              </>
            )}
            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
