import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import './ProjectsPage.css';

// Ported from Bamboo OS.dc.html's projects screen (screens.projects block
// + the projects computed values, and the "New project" dialog around its
// render()). The prototype defines a setProjectStatus handler but never
// wires it to any control on this screen — cards are read-only status
// displays — so this screen intentionally has no status-change UI either,
// even though the backend's POST /projects/:id/status endpoint exists.
// (Cards stay non-interactive in this redesign for the same reason — no
// hover-lift/click affordance implying a drill-down that doesn't exist.)
//
// Redesigned around the icon/avatar language established elsewhere: an
// owner avatar per card, a summary strip, an overdue callout on the
// progress bar, and an icon'd empty state.

function tagClass(status) {
  if (['approved', 'present', 'active', 'completed'].includes(status)) return 'tag-neutral';
  if (['pending', 'late', 'in_progress', 'under_review', 'waiting', 'not_started', 'planning'].includes(status)) return 'tag-outline';
  if (['rejected', 'absent', 'disabled', 'cancelled', 'on_hold', 'delayed'].includes(status)) return 'tag-accent';
  return 'tag-neutral';
}

function statusLabel(s) {
  return s.replace(/_/g, ' ');
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function todayISO() { return new Date().toISOString().slice(0, 10); }

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
  folder: <><circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.6" /><path d="M2.5 19c0-3.6 2.5-6 5.5-6s5.5 2.4 5.5 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><circle cx="16.5" cy="9" r="2.3" stroke="currentColor" strokeWidth="1.6" /><path d="M14.8 13.3c2.6.4 4.7 2.5 4.7 5.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" /><path d="M12 7.5V12l3.2 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></>,
  checkCircle: <><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.6" /><path d="M7.5 12.5l3 3 6-6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></>,
  checklist: <><rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" /><path d="M8 12.5l2.3 2.3L16 9.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></>,
  calendar: <><rect x="4" y="5" width="16" height="15" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><path d="M4 9.5h16M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>
};
function Icon({ name }) { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">{ICON_PATHS[name]}</svg>; }

const EMPTY_FORM = { name: '', departmentId: '', ownerId: '', startDate: '', deadline: '', description: '' };

export default function ProjectsPage() {
  const { can } = useAuth();
  const canManage = can('project.manage');

  const [projects, setProjects] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [dialogError, setDialogError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [rows, depts] = await Promise.all([api.get('/projects'), api.get('/departments')]);
      setProjects(rows);
      setDepartments(depts);
      if (canManage) {
        const empRows = await api.get('/employees');
        setEmployees(empRows);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [canManage]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  function openNew() {
    setDialogError(null);
    setForm({ ...EMPTY_FORM, departmentId: (departments[0] && departments[0].id) || '' });
    setDialogOpen(true);
  }

  async function handleCreate(e) {
    e.preventDefault();
    setCreating(true);
    setDialogError(null);
    try {
      await api.post('/projects', {
        name: form.name, departmentId: form.departmentId, ownerId: form.ownerId || undefined,
        startDate: form.startDate || undefined, deadline: form.deadline || undefined, description: form.description
      });
      setToast('Project created.');
      setDialogOpen(false);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setCreating(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visibleProjects = projects.filter((p) => matchesQuery(search, p.name, p.code, p.departmentName, p.ownerName));
  const isOverdue = (p) => p.deadline && p.deadline < todayISO() && !['completed', 'cancelled'].includes(p.status);
  const overdueCount = projects.filter(isOverdue).length;
  const completedCount = projects.filter((p) => p.status === 'completed').length;
  const inProgressCount = projects.filter((p) => p.status === 'in_progress').length;

  const summary = [
    { label: 'Projects', value: projects.length, icon: 'folder', tone: 'people' },
    { label: 'In progress', value: inProgressCount, icon: 'clock', tone: 'people' },
    { label: 'Completed', value: completedCount, icon: 'checkCircle', tone: 'people' },
    { label: 'Overdue', value: overdueCount, icon: 'clock', tone: 'danger' }
  ];

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      {!!projects.length && (
        <div className="projects-summary">
          {summary.map((s) => (
            <div className={'projects-summary-tile projects-summary-tile-' + s.tone} key={s.label}>
              <span className="projects-summary-icon"><Icon name={s.icon} /></span>
              <div>
                <div className="projects-summary-value">{s.value}</div>
                <div className="projects-summary-label">{s.label}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="projects-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search projects…" />
        {canManage && <button type="button" className="btn btn-primary" onClick={openNew}>New project</button>}
      </div>

      <div className="projects-grid">
        {visibleProjects.map((p) => {
          const progress = p.taskCount ? Math.round((p.doneCount / p.taskCount) * 100) : 0;
          const overdue = isOverdue(p);
          return (
            <div className="projects-card" key={p.id}>
              <div className="projects-card-top">
                <div className="projects-card-eyebrow">{p.code} · {p.departmentName}</div>
                <span className={'tag ' + tagClass(p.status)}>{statusLabel(p.status)}</span>
              </div>
              <div className="projects-card-name">{p.name}</div>
              <div className="projects-card-meta">
                <span className="projects-owner-avatar" style={{ background: avatarColor(p.ownerName) }}>{initials(p.ownerName)}</span>
                {p.ownerName}
                <span className="projects-card-meta-sep">·</span>
                <Icon name="calendar" />
                Due {fmtDate(p.deadline)}
                {overdue && <span className="projects-overdue-badge">overdue</span>}
              </div>
              <div>
                <div className="projects-progress-track">
                  <div className={'projects-progress-bar' + (overdue ? ' projects-progress-bar-overdue' : '')} style={{ width: progress + '%' }} />
                </div>
                <div className="projects-task-line"><Icon name="checklist" /> {p.doneCount} / {p.taskCount} tasks done</div>
              </div>
            </div>
          );
        })}
      </div>
      {!projects.length && (
        <div className="projects-empty-state">
          <span className="projects-empty-icon"><Icon name="folder" /></span>
          <p className="projects-empty-title">No projects visible to your role</p>
        </div>
      )}
      {!!projects.length && !visibleProjects.length && (
        <div className="projects-empty-state">
          <span className="projects-empty-icon"><Icon name="folder" /></span>
          <p className="projects-empty-title">No projects match "{search}"</p>
        </div>
      )}

      {dialogOpen && (
        <div className="dialog-backdrop" onClick={() => setDialogOpen(false)}>
          <form className="dialog projects-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleCreate}>
            <h2 className="projects-dialog-title">New project</h2>
            {dialogError && <div className="error-banner projects-dialog-span">{dialogError}</div>}
            <div className="field projects-dialog-span">
              <label htmlFor="proj-name">Name</label>
              <input id="proj-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="proj-dept">Group</label>
              <select id="proj-dept" className="input" value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })} required>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="proj-owner">Owner</label>
              <select id="proj-owner" className="input" value={form.ownerId} onChange={(e) => setForm({ ...form, ownerId: e.target.value })}>
                <option value="">Me</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="proj-start">Start</label>
              <input id="proj-start" className="input" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="proj-deadline">Deadline</label>
              <input id="proj-deadline" className="input" type="date" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
            </div>
            <div className="field projects-dialog-span">
              <label htmlFor="proj-desc">Description</label>
              <textarea id="proj-desc" className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div className="dialog-actions projects-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={creating}>{creating ? 'Creating…' : 'Create project'}</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
