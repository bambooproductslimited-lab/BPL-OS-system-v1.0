import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import './AnnouncementsPage.css';

// Ported from Bamboo OS.dc.html's announcements screen (screens.announcements
// block + the "Publish announcement" dialog around its render()). Pinned is
// always published as false — the prototype hardcodes it on publish and
// never renders a pin control or badge anywhere, so this port doesn't add
// one either.

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const EMPTY_FORM = { title: '', body: '', audience: 'all' };

export default function AnnouncementsPage() {
  const { can } = useAuth();
  const canPublish = can('announcement.publish');

  const [announcements, setAnnouncements] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [dialogError, setDialogError] = useState(null);
  const [publishing, setPublishing] = useState(false);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [rows, depts] = await Promise.all([api.get('/announcements'), api.get('/departments')]);
      setAnnouncements(rows);
      setDepartments(depts);
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

  function deptName(id) {
    const d = departments.find((x) => x.id === id);
    return d ? d.name : '—';
  }

  function audienceLabel(audience) {
    return audience === 'all' ? 'All staff' : deptName(audience);
  }

  function openNew() {
    setDialogError(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  async function handlePublish(e) {
    e.preventDefault();
    setPublishing(true);
    setDialogError(null);
    try {
      await api.post('/announcements', { title: form.title, body: form.body, audience: form.audience, pinned: false });
      setToast('Announcement published.');
      setDialogOpen(false);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setPublishing(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visibleAnnouncements = announcements.filter((a) => matchesQuery(search, a.title, a.body, a.publisherName));

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="announcements-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search announcements…" />
        {canPublish && <button type="button" className="btn btn-primary" onClick={openNew}>Publish announcement</button>}
      </div>

      <div className="announcements-list">
        {visibleAnnouncements.map((a) => (
          <div className="announcements-item" key={a.id}>
            <div className="announcements-eyebrow">{audienceLabel(a.audience)} · {fmtDate(a.publishedAt.slice(0, 10))} · {a.publisherName}</div>
            <div className="announcements-title">{a.title}</div>
            <p className="announcements-body">{a.body}</p>
          </div>
        ))}
      </div>
      {!announcements.length && <p className="table-empty">Nothing published yet.</p>}
      {!!announcements.length && !visibleAnnouncements.length && <p className="table-empty">No announcements match "{search}".</p>}

      {dialogOpen && (
        <div className="dialog-backdrop" onClick={() => setDialogOpen(false)}>
          <form className="dialog announcements-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handlePublish}>
            <h2>Publish announcement</h2>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="field">
              <label htmlFor="ann-title">Title</label>
              <input id="ann-title" className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="ann-body">Message</label>
              <textarea id="ann-body" className="input" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="ann-audience">Audience</label>
              <select id="ann-audience" className="input" value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })}>
                <option value="all">All staff</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name} only</option>)}
              </select>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={publishing}>{publishing ? 'Publishing…' : 'Publish'}</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
