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

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="projects-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search projects…" />
        {canManage && <button type="button" className="btn btn-primary" onClick={openNew}>New project</button>}
      </div>

      <div className="projects-grid">
        {visibleProjects.map((p) => {
          const progress = p.taskCount ? Math.round((p.doneCount / p.taskCount) * 100) : 0;
          return (
            <div className="projects-card" key={p.id}>
              <div className="projects-card-top">
                <div className="projects-card-eyebrow">{p.code} · {p.departmentName}</div>
                <span className={'tag ' + tagClass(p.status)}>{statusLabel(p.status)}</span>
              </div>
              <div className="projects-card-name">{p.name}</div>
              <div className="projects-card-meta">Owner: {p.ownerName} · Due {fmtDate(p.deadline)}</div>
              <div>
                <div className="projects-progress-track"><div className="projects-progress-bar" style={{ width: progress + '%' }} /></div>
                <div className="projects-task-line">{p.doneCount} / {p.taskCount} tasks done</div>
              </div>
            </div>
          );
        })}
      </div>
      {!projects.length && <p className="table-empty">No projects visible to your role.</p>}
      {!!projects.length && !visibleProjects.length && <p className="table-empty">No projects match "{search}".</p>}

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
              <label htmlFor="proj-dept">Department</label>
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
