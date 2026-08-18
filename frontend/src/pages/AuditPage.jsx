import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import './AuditPage.css';

// Ported from Bamboo OS.dc.html's audit log screen (screens.audit block +
// the auditRows computed value), backed by GET /api/audit?q= (matches
// action/summary/actor name, case-insensitive, most recent 120 entries).

function fmtWhen(iso) {
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function AuditPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');

  // Debounce the filter box so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput), 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      setRows(await api.get('/audit' + (params.toString() ? '?' + params.toString() : '')));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [q]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="field audit-filter">
        <label htmlFor="audit-q">Filter</label>
        <input id="audit-q" className="input" value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="action, person, summary" />
      </div>

      {loading ? (
        <div className="eyebrow">Loading…</div>
      ) : (
        <table className="table">
          <thead>
            <tr><th className="audit-when-col">When</th><th className="audit-actor-col">Actor</th><th className="audit-action-col">Action</th><th>What happened</th></tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id}>
                <td className="audit-when">{fmtWhen(l.at)}</td>
                <td className="audit-actor">{l.actorName || 'System'}</td>
                <td><span className="tag tag-neutral">{l.action}</span></td>
                <td className="audit-summary">{l.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!loading && !rows.length && <p className="table-empty">No audit activity yet.</p>}
    </div>
  );
}
