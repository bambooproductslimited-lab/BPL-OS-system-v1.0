import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import SearchInput, { matchesQuery } from '../components/SearchInput';
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
//
// Redesigned around the icon/avatar language established elsewhere:
// requester avatar + a subject-type icon per item, and a celebratory
// "all caught up" empty state instead of a plain sentence.

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

const ICON_PATHS = {
  calendar: <><rect x="4" y="5" width="16" height="15" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><path d="M4 9.5h16M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  cart: <><path d="M3 4h2.2l2 11.5h10.6l1.7-8.2H6.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><circle cx="9.5" cy="19.5" r="1.3" stroke="currentColor" strokeWidth="1.6" /><circle cx="16.5" cy="19.5" r="1.3" stroke="currentColor" strokeWidth="1.6" /></>,
  receipt: <><path d="M6 3.5h12v17l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3v-17Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M9 8h6M9 12h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  checkCircle: <><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.6" /><path d="M7.5 12.5l3 3 6-6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></>
};
function Icon({ name }) { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">{ICON_PATHS[name]}</svg>; }

function subjectIcon(subjectType) {
  if (subjectType === 'procurement_request') return 'cart';
  if (subjectType === 'expense') return 'receipt';
  return 'calendar';
}

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [decidingId, setDecidingId] = useState(null);
  const [search, setSearch] = useState('');

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

  const visibleApprovals = approvals.filter((a) => matchesQuery(search, a.title, a.requesterName, a.requesterRole, a.detail, a.reason));

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      {!!approvals.length && <SearchInput value={search} onChange={setSearch} placeholder="Search approval queue…" />}

      <div className="approvals-list" style={{ marginTop: approvals.length ? 16 : 0 }}>
        {visibleApprovals.map((a) => (
          <div className="approvals-item" key={a.id}>
            <span className="approvals-avatar" style={{ background: avatarColor(a.requesterName) }}>{initials(a.requesterName)}</span>
            <div className="approvals-item-body">
              <div className="approvals-item-eyebrow"><Icon name={subjectIcon(a.subjectType)} /> {a.title}</div>
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
        <div className="approvals-empty-state">
          <span className="approvals-empty-icon"><Icon name="checkCircle" /></span>
          <p className="approvals-empty-title">You're all caught up</p>
          <p className="approvals-empty-sub">Requests from the people you're responsible for will appear here.</p>
        </div>
      )}
      {!!approvals.length && !visibleApprovals.length && <p className="table-empty">No approvals match "{search}".</p>}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
