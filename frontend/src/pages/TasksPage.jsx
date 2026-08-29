import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import './TasksPage.css';

// Ported from Bamboo OS.dc.html's tasks screen (screens.tasks block + the
// tasks/taskScopeFilters computed values, and the taskDetail dialog around
// its render()), redesigned around the icon/avatar language established
// for Messages/Dashboard/My Space/Employees/Attendance/Leave: assignee
// avatar stacks, a comment-count badge, an overdue indicator, avatars on
// comment authors, and an icon'd empty state.

const STATUS_OPTIONS = ['not_started', 'in_progress', 'waiting', 'under_review', 'completed', 'cancelled'];

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
  checklist: <><rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" /><path d="M8 12.5l2.3 2.3L16 9.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" /><path d="M12 7.5V12l3.2 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></>,
  message: <><rect x="3.5" y="5" width="17" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.6" /><path d="M8 20l3-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>
};
function Icon({ name }) { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">{ICON_PATHS[name]}</svg>; }

function AssigneeStack({ names }) {
  if (!names.length) return <span className="tasks-unassigned">Unassigned</span>;
  const shown = names.slice(0, 3);
  const extra = names.length - shown.length;
  return (
    <div className="tasks-assignee-stack" title={names.join(', ')}>
      {shown.map((n, i) => (
        <span key={n + i} className="tasks-assignee-avatar" style={{ background: avatarColor(n), zIndex: shown.length - i }}>{initials(n)}</span>
      ))}
      {extra > 0 && <span className="tasks-assignee-avatar tasks-assignee-extra">+{extra}</span>}
    </div>
  );
}

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

function statusLabel(s) {
  return s.replace(/_/g, ' ');
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const EMPTY_FORM = { title: '', projectId: '', assigneeId: '', dueDate: '' };

export default function TasksPage() {
  const { can } = useAuth();
  const canManage = can('task.manage');

  const [scope, setScope] = useState('mine');
  const [statusFilter, setStatusFilter] = useState('');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');

  const [tasks, setTasks] = useState([]);
  const [projects, setProjects] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);

  const [detail, setDetail] = useState(null);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState(null);
  const [commentDraft, setCommentDraft] = useState('');
  const [detailError, setDetailError] = useState(null);
  const [savingDetail, setSavingDetail] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQ(qInput), 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ scope: scope });
      if (statusFilter) params.set('status', statusFilter);
      if (q) params.set('q', q);
      const [rows, projRows] = await Promise.all([
        api.get('/tasks?' + params.toString()),
        api.get('/projects')
      ]);
      setTasks(rows);
      setProjects(projRows);
      if (canManage) {
        const empRows = await api.get('/employees');
        setEmployees(empRows);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [scope, statusFilter, q, canManage]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  async function handleCreate(e) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api.post('/tasks', {
        title: form.title, projectId: form.projectId || null,
        assigneeIds: form.assigneeId ? [form.assigneeId] : undefined,
        dueDate: form.dueDate || undefined
      });
      setToast('Task added.');
      setForm(EMPTY_FORM);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleSetStatus(row, status) {
    try {
      await api.post('/tasks/' + row.id + '/status', { status: status });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  function fullUpdatePayload(row, overrides) {
    return Object.assign({
      title: row.title, projectId: row.projectId, assigneeIds: row.assigneeIds,
      priority: row.priority, startedDate: (row.createdAt || '').slice(0, 10), dueDate: row.dueDate,
      description: row.description
    }, overrides);
  }

  async function handleSetStarted(row, value) {
    try {
      await api.patch('/tasks/' + row.id, fullUpdatePayload(row, { startedDate: value }));
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleSetDue(row, value) {
    try {
      await api.patch('/tasks/' + row.id, fullUpdatePayload(row, { dueDate: value }));
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function openDetail(row) {
    setDetailError(null);
    setEditing(false);
    try {
      const full = await api.get('/tasks/' + row.id);
      setDetail(full);
    } catch (err) {
      setError(err.message);
    }
  }

  function startEdit() {
    setEditForm({
      title: detail.title, priority: detail.priority,
      startedDate: (detail.createdAt || '').slice(0, 10), dueDate: detail.dueDate || '',
      description: detail.description || ''
    });
    setEditing(true);
  }

  async function submitEdit(e) {
    e.preventDefault();
    setSavingDetail(true);
    setDetailError(null);
    try {
      const updated = await api.patch('/tasks/' + detail.id, fullUpdatePayload(detail, editForm));
      setDetail(updated);
      setEditing(false);
      setToast('Task updated.');
      await load();
    } catch (err) {
      setDetailError(err.message);
    } finally {
      setSavingDetail(false);
    }
  }

  async function submitComment(e) {
    e.preventDefault();
    const body = commentDraft.trim();
    if (!body) return;
    setDetailError(null);
    try {
      const updated = await api.post('/tasks/' + detail.id + '/comments', { body: body });
      setDetail(updated);
      setCommentDraft('');
      await load();
    } catch (err) {
      setDetailError(err.message);
    }
  }

  async function handleDelete(row) {
    setDeleting(true);
    try {
      await api.del('/tasks/' + row.id);
      setToast('Task deleted.');
      setDeleteTarget(null);
      if (detail && detail.id === row.id) setDetail(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const overdueCount = tasks.filter((t) => t.overdue).length;

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="tasks-toolbar">
        <div className="seg">
          {[{ key: 'mine', label: 'My tasks' }, { key: 'all', label: 'In scope' }].map((opt) => (
            <label className="seg-opt" key={opt.key}>
              <input type="radio" name="task-scope" checked={scope === opt.key} onChange={() => setScope(opt.key)} />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
        <select className="input tasks-status-filter" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{statusLabel(s).charAt(0).toUpperCase() + statusLabel(s).slice(1)}</option>)}
        </select>
        <input className="input tasks-search" value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Search tasks…" />
        {overdueCount > 0 && (
          <span className="tasks-overdue-badge"><Icon name="clock" /> {overdueCount} overdue</span>
        )}
      </div>

      {canManage && (
        <form className="card tasks-create-form" onSubmit={handleCreate}>
          <div className="field">
            <label htmlFor="task-title">New task</label>
            <input id="task-title" className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Task title" required />
          </div>
          <div className="field">
            <label htmlFor="task-project">Project</label>
            <select id="task-project" className="input" value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
              <option value="">None</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="task-assignee">Assignee</label>
            <select id="task-assignee" className="input" value={form.assigneeId} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}>
              <option value="">Me</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="task-due">Due</label>
            <input id="task-due" className="input" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
          </div>
          <button className="btn btn-primary" type="submit" disabled={creating}>Add task</button>
        </form>
      )}

      <table className="table">
        <thead>
          <tr><th>Task</th><th>Project</th><th>Assignee(s)</th><th>Priority</th><th>Started</th><th>Due</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id}>
              <td>
                <button type="button" className="tasks-title-btn" onClick={() => openDetail(t)}>{t.title}</button>
                {t.commentCount > 0 && (
                  <span className="tasks-comment-badge"><Icon name="message" /> {t.commentCount}</span>
                )}
              </td>
              <td>{t.projectName}</td>
              <td><AssigneeStack names={t.assigneeNames} /></td>
              <td><span className={'tag ' + priorityClass(t.priority)}>{t.priority}</span></td>
              <td>
                <input type="date" className="input tasks-date-input" value={(t.createdAt || '').slice(0, 10)} disabled={!canManage} onChange={(e) => handleSetStarted(t, e.target.value)} />
              </td>
              <td>
                <input type="date" className="input tasks-date-input" value={t.dueDate || ''} disabled={!canManage} onChange={(e) => handleSetDue(t, e.target.value)} />
                {t.overdue && <div className="tasks-overdue">{t.daysOverdue} day(s) overdue</div>}
              </td>
              <td>
                <select className="input tasks-status-select" value={t.status} onChange={(e) => handleSetStatus(t, e.target.value)}>
                  {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{statusLabel(s).charAt(0).toUpperCase() + statusLabel(s).slice(1)}</option>)}
                </select>
              </td>
              <td className="table-actions">
                {canManage && <button type="button" className="btn btn-secondary tasks-row-btn" onClick={() => setDeleteTarget(t)}>Delete</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!tasks.length && (
        <div className="tasks-empty-state">
          <span className="tasks-empty-icon"><Icon name="checklist" /></span>
          <p className="tasks-empty-title">No tasks here</p>
          <p className="tasks-empty-sub">Nothing matches this scope, status, or search.</p>
        </div>
      )}

      {detail && (
        <div className="dialog-backdrop" onClick={() => setDetail(null)}>
          <div className="dialog tasks-detail-dialog" onClick={(e) => e.stopPropagation()}>
            {detailError && <div className="error-banner">{detailError}</div>}
            {editing ? (
              <form onSubmit={submitEdit} className="tasks-edit-form">
                <h2>Edit task</h2>
                <div className="field">
                  <label htmlFor="edit-title">Title</label>
                  <input id="edit-title" className="input" value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} required />
                </div>
                <div className="tasks-edit-grid">
                  <div className="field">
                    <label htmlFor="edit-priority">Priority</label>
                    <select id="edit-priority" className="input" value={editForm.priority} onChange={(e) => setEditForm({ ...editForm, priority: e.target.value })}>
                      <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="edit-started">Date started</label>
                    <input id="edit-started" className="input" type="date" value={editForm.startedDate} onChange={(e) => setEditForm({ ...editForm, startedDate: e.target.value })} />
                  </div>
                  <div className="field">
                    <label htmlFor="edit-due">Due date</label>
                    <input id="edit-due" className="input" type="date" value={editForm.dueDate} onChange={(e) => setEditForm({ ...editForm, dueDate: e.target.value })} />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="edit-desc">Description</label>
                  <textarea id="edit-desc" className="input" value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} />
                </div>
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setEditing(false)}>Cancel</button>
                  <button type="submit" className="btn btn-primary" disabled={savingDetail}>Save changes</button>
                </div>
              </form>
            ) : (
              <>
                <div className="tasks-detail-header">
                  <h2>{detail.title}</h2>
                  <span className={'tag ' + tagClass(detail.status)}>{statusLabel(detail.status)}</span>
                </div>
                <div className="tasks-detail-meta">
                  <div>Project: {detail.projectName}</div>
                  <div>Assignees: {detail.assigneeNames.join(', ')}</div>
                  <div>Priority: {detail.priority}</div>
                  <div>Started: {fmtDate((detail.createdAt || '').slice(0, 10))}</div>
                  <div>Due: {fmtDate(detail.dueDate)}</div>
                </div>
                {detail.overdue && <div className="tasks-overdue">{detail.daysOverdue} day(s) overdue</div>}
                {detail.description && <p className="tasks-detail-desc">{detail.description}</p>}
                {canManage && (
                  <div className="dialog-actions" style={{ justifyContent: 'flex-start' }}>
                    <button type="button" className="btn btn-secondary" onClick={startEdit}>Edit</button>
                    <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(detail)}>Delete</button>
                  </div>
                )}
                <hr className="hr" />
                <div className="tasks-comments">
                  <h3>Comments</h3>
                  {detail.comments.map((c) => (
                    <div className="tasks-comment" key={c.id}>
                      <div className="tasks-comment-head">
                        <span className="tasks-comment-author">
                          <span className="tasks-comment-avatar" style={{ background: avatarColor(c.authorName) }}>{initials(c.authorName)}</span>
                          {c.authorName}
                        </span>
                        <span>{fmtDate(c.at)}</span>
                      </div>
                      <div className="tasks-comment-body">{c.body}</div>
                    </div>
                  ))}
                  {!detail.comments.length && <p className="tasks-no-comments">No comments yet.</p>}
                  <form className="tasks-comment-form" onSubmit={submitComment}>
                    <input className="input" value={commentDraft} onChange={(e) => setCommentDraft(e.target.value)} placeholder="Add a comment…" />
                    <button className="btn btn-primary" type="submit">Post</button>
                  </form>
                </div>
              </>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDetail(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Delete task</h2>
            <p className="dialog-body">Delete <strong>{deleteTarget.title}</strong>? This cannot be undone.</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={() => handleDelete(deleteTarget)}>{deleting ? 'Deleting…' : 'Delete'}</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
