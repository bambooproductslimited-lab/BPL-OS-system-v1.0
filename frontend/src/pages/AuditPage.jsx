import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import './AuditPage.css';

// Ported from Bamboo OS.dc.html's audit log screen (screens.audit block +
// the auditRows computed value), backed by GET /api/audit?q= (matches
// action/summary/actor name, case-insensitive, most recent 120 entries).
//
// Redesigned around the icon language established elsewhere: an actor
// avatar per row (a muted gear badge for system-generated entries, an
// initials avatar for a real person), an icon'd empty state.

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

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 3v2.5M12 18.5V21M21 12h-2.5M5.5 12H3M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8M18.4 18.4l-1.8-1.8M7.4 7.4 5.6 5.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function HistoryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 7.5V12l3.2 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

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
                <td>
                  <div className="audit-actor-cell">
                    {l.actorName ? (
                      <span className="audit-avatar" style={{ background: avatarColor(l.actorName) }}>{initials(l.actorName)}</span>
                    ) : (
                      <span className="audit-avatar audit-avatar-system"><GearIcon /></span>
                    )}
                    {l.actorName || 'System'}
                  </div>
                </td>
                <td><span className="tag tag-neutral">{l.action}</span></td>
                <td className="audit-summary">{l.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!loading && !rows.length && (
        <div className="audit-empty-state">
          <span className="audit-empty-icon"><HistoryIcon /></span>
          <p className="audit-empty-title">No audit activity yet</p>
        </div>
      )}
    </div>
  );
}
