import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import './PaymentsPage.css';

// Ported from Bamboo OS.dc.html's payments screen (screens.payments block).
// Payments are a read-only ledger with one action: delete (which also
// removes the linked receipt and rolls back the invoice balance server-side
// — see backend/src/services/payments.service.js's remove()).

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function PaymentsPage() {
  const { can } = useAuth();
  const canManage = can('invoice.manage');

  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      setPayments(await api.get('/payments'));
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

  async function confirmDelete() {
    setDeleting(true);
    try {
      await api.del('/payments/' + deleteTarget.id);
      setToast('Payment on ' + deleteTarget.invoiceNo + ' deleted.');
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visiblePayments = payments.filter((p) => matchesQuery(search, p.invoiceNo, p.customerName, p.reference, p.receivedByName));

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <SearchInput value={search} onChange={setSearch} placeholder="Search payments…" />

      <table className="table" style={{ marginTop: 16 }}>
        <thead>
          <tr><th>Invoice</th><th>Customer</th><th>Amount</th><th>Date</th><th>Method</th><th>Reference</th><th>Received by</th><th></th></tr>
        </thead>
        <tbody>
          {visiblePayments.map((p) => (
            <tr key={p.id}>
              <td style={{ fontWeight: 600 }}>{p.invoiceNo}</td>
              <td>{p.customerName}</td>
              <td>GHS {p.amount.toLocaleString()}</td>
              <td>{fmtDate(p.date)}</td>
              <td className="payments-method">{p.method.replace('_', ' ')}</td>
              <td>{p.reference || '—'}</td>
              <td>{p.receivedByName}</td>
              <td className="table-actions">
                {canManage && <button type="button" className="btn btn-secondary payments-row-btn" onClick={() => setDeleteTarget(p)}>Delete</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!payments.length && <p className="table-empty">No payments recorded yet.</p>}
      {!!payments.length && !visiblePayments.length && <p className="table-empty">No payments match "{search}".</p>}

      {deleteTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Delete payment on {deleteTarget.invoiceNo}</h2>
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
