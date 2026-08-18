import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import './ApprovalsPage.css';

// Ported from Bamboo OS.dc.html's approval centre screen (screens.approvals
// block + the approvals computed values around its render()). One
// deliberate deviation from the prototype: its Approve/Reject buttons
// always call leave.decide regardless of subject type, which only works
// for leave requests — a latent bug, since GET /approvals/queue already
// returns leave_request/procurement_request/expense entries (see
// approvals.service.js's polymorphic queue()). This port dispatches each
// decision to the real endpoint for its subjectType instead of carrying
// that bug forward, since doing otherwise would make procurement/expense
// approvals silently fail against the real backend.

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [decidingId, setDecidingId] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setApprovals(await api.get('/approvals/queue'));
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

  async function handleDecision(item, decision) {
    setDecidingId(item.id);
    setError(null);
    try {
      if (item.subjectType === 'leave_request') {
        await api.post('/leave/' + item.subjectId + '/decision', { decision: decision, note: '' });
      } else if (item.subjectType === 'procurement_request') {
        await api.post('/procurement/' + item.subjectId + '/decision', { decision: decision });
      } else if (item.subjectType === 'expense') {
        await api.post('/expenses/' + item.subjectId + '/decision', { decision: decision });
      }
      setToast(item.title + ' ' + decision + '.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDecidingId(null);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="approvals-list">
        {approvals.map((a) => (
          <div className="approvals-item" key={a.id}>
            <div className="approvals-item-body">
              <div className="approvals-item-eyebrow">{a.title}</div>
              <div className="approvals-item-name">{a.requesterName} · {a.requesterRole}</div>
              <div className="approvals-item-detail">{a.detail}</div>
              <div className="approvals-item-reason">{a.reason || '—'}</div>
            </div>
            <div className="approvals-item-actions">
              <button type="button" className="btn btn-primary" disabled={decidingId === a.id} onClick={() => handleDecision(a, 'approved')}>Approve</button>
              <button type="button" className="btn btn-secondary" disabled={decidingId === a.id} onClick={() => handleDecision(a, 'rejected')}>Reject</button>
            </div>
          </div>
        ))}
      </div>
      {!approvals.length && (
        <p className="table-empty">Your approval queue is clear. Requests from the people you are responsible for will appear here.</p>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
