import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import './ProcurementPage.css';

// Ported from Bamboo OS.dc.html's procurement screen (screens.procurement
// block + the procurement computed values around its render()).

function tagClass(status) {
  if (['approved', 'present', 'active', 'completed'].includes(status)) return 'tag-neutral';
  if (['pending', 'late', 'in_progress', 'under_review', 'waiting', 'not_started', 'planning'].includes(status)) return 'tag-outline';
  if (['rejected', 'absent', 'disabled', 'cancelled', 'on_hold', 'delayed'].includes(status)) return 'tag-accent';
  return 'tag-neutral';
}

function priorityClass(p) {
  if (p === 'high') return 'tag-accent';
  if (p === 'low') return 'tag-neutral';
  return 'tag-outline';
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const EMPTY_FORM = { item: '', quantity: '', estimatedPrice: '', requiredDate: '', priority: 'medium', reason: '' };

export default function ProcurementPage() {
  const { session, can } = useAuth();
  const employeeId = session && session.employee && session.employee.id;
  const canRequest = can('procurement.request');
  const canApprove = can('procurement.approve');

  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);

  const [decidingId, setDecidingId] = useState(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      setRequests(await api.get('/procurement'));
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

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/procurement', form);
      setToast('Purchase request submitted.');
      setForm(EMPTY_FORM);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDecision(row, decision) {
    setDecidingId(row.id);
    setError(null);
    try {
      await api.post('/procurement/' + row.id + '/decision', { decision: decision });
      setToast('Request ' + decision + '.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDecidingId(null);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visibleRequests = requests.filter((r) => matchesQuery(search, r.item, r.requesterName, r.departmentName));

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      {canRequest && (
        <form className="card procurement-form" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="pc-item">Request a purchase · item</label>
            <input id="pc-item" className="input" value={form.item} onChange={(e) => setForm({ ...form, item: e.target.value })} required />
          </div>
          <div className="field">
            <label htmlFor="pc-qty">Qty</label>
            <input id="pc-qty" className="input" type="number" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="pc-price">Est. price (GHS)</label>
            <input id="pc-price" className="input" type="number" value={form.estimatedPrice} onChange={(e) => setForm({ ...form, estimatedPrice: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="pc-date">Needed by</label>
            <input id="pc-date" className="input" type="date" value={form.requiredDate} onChange={(e) => setForm({ ...form, requiredDate: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="pc-priority">Priority</label>
            <select id="pc-priority" className="input" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
              <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
            </select>
          </div>
          <button className="btn btn-primary procurement-submit-btn" type="submit" disabled={submitting}>Submit</button>
          <div className="field procurement-reason">
            <label htmlFor="pc-reason">Reason</label>
            <input id="pc-reason" className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} required />
          </div>
        </form>
      )}

      <SearchInput value={search} onChange={setSearch} placeholder="Search item, requester, group…" />
      <table className="table" style={{ marginTop: 12 }}>
        <thead>
          <tr><th>Item</th><th>Qty</th><th>Requested by</th><th>Group</th><th>Est. cost</th><th>Needed by</th><th>Priority</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {visibleRequests.map((r) => {
            const decidable = r.status === 'pending' && canApprove && r.requesterId !== employeeId;
            return (
              <tr key={r.id}>
                <td style={{ fontWeight: 600 }}>{r.item}</td>
                <td>{r.quantity}</td>
                <td>{r.requesterName}</td>
                <td>{r.departmentName}</td>
                <td>GHS {r.estimatedPrice.toLocaleString()}</td>
                <td>{fmtDate(r.requiredDate)}</td>
                <td><span className={'tag ' + priorityClass(r.priority)}>{r.priority}</span></td>
                <td><span className={'tag ' + tagClass(r.status)}>{r.status}</span></td>
                <td className="table-actions">
                  {decidable && (
                    <>
                      <button type="button" className="btn btn-secondary procurement-row-btn" disabled={decidingId === r.id} onClick={() => handleDecision(r, 'approved')}>Approve</button>
                      <button type="button" className="btn btn-secondary procurement-row-btn" disabled={decidingId === r.id} onClick={() => handleDecision(r, 'rejected')}>Reject</button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!requests.length && <p className="table-empty">Nothing to show in your scope.</p>}
      {!!requests.length && !visibleRequests.length && <p className="table-empty">No requests match "{search}".</p>}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
