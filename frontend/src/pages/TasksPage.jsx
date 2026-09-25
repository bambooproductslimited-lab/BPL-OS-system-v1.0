import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import Photo from '../components/Photo';
import PeoplePicker from '../components/PeoplePicker';
import RowMenu from '../components/RowMenu';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { CompanySwitcher, Glossary, Hero, Insights, Section, Status, fmtDate, jump } from '../components/DashKit';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import './EmployeesPage.css';
import './TasksPage.css';

// Tasks. Same "explains itself" layout as the dashboards
// (components/DashKit.jsx): a company switcher, the key numbers (press one
// to show only those tasks), what stands out (who has overdue work,
// high-priority tasks not started, reviews waiting for you), then the tasks
// as a board — a column per status, drag a card to move it — or as a list.
// A task opens in a window with its status steps, people, dates,
// description and comments. Anyone who can see a task can move it and
// comment; creating, editing and deleting need task.manage.

const STATUSES = ['not_started', 'in_progress', 'waiting', 'under_review', 'completed', 'cancelled'];
const BOARD = ['not_started', 'in_progress', 'waiting', 'under_review', 'completed'];
const OPEN = (t) => t.status !== 'completed' && t.status !== 'cancelled';
const DONE_SHOWN = 12;
const EMPTY_FORM = { title: '', description: '', projectId: '', assigneeIds: [], priority: 'medium', dueDate: '' };

function isoDay(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function addDays(iso, n) { const d = new Date(iso + 'T00:00'); d.setDate(d.getDate() + n); return isoDay(d); }
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00') - new Date(a + 'T00:00')) / 86400000); }
function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return tr('just now');
  if (mins < 60) return tr('{n} min ago', { n: mins });
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return tr('{n} h ago', { n: hrs });
  return fmtDate(String(iso).slice(0, 10));
}

// How a task's timing reads: { text, tone } — tone 'bad' | 'warn' | ''.
function dueInfo(t, today) {
  if (t.status === 'completed') return { text: t.completedAt ? tr('Done {date}', { date: fmtDate(String(t.completedAt).slice(0, 10)) }) : tr('Done'), tone: 'good' };
  if (t.status === 'cancelled') return { text: tr('Cancelled'), tone: '' };
  if (!t.dueDate) return { text: tr('No due date'), tone: '' };
  const d = daysBetween(today, t.dueDate);
  if (d < 0) return { text: -d === 1 ? tr('1 day overdue') : tr('{n} days overdue', { n: -d }), tone: 'bad' };
  if (d === 0) return { text: tr('Due today'), tone: 'warn' };
  if (d === 1) return { text: tr('Due tomorrow'), tone: 'warn' };
  if (d < 7) return { text: tr('Due {day}', { day: new Date(t.dueDate + 'T00:00').toLocaleDateString(activeIntlLocale(), { weekday: 'long' }) }), tone: '' };
  return { text: tr('Due {date}', { date: fmtDate(t.dueDate) }), tone: '' };
}

function Faces({ people, size = 26, max = 3 }) {
  if (!people || !people.length) return <span className="dk-muted tk-small">{tr('Unassigned')}</span>;
  return (
    <span className="tk-faces" title={people.map((p) => p.name).join(', ')}>
      {people.slice(0, max).map((p) => <Photo key={p.id} id={p.id} name={p.name} photo={p.photo} size={size} />)}
      {people.length > max && <span className="tk-faces-more">+{people.length - max}</span>}
    </span>
  );
}

function PriorityMark({ priority }) {
  return <span className={'tk-prio is-' + priority} title={tr('{p} priority', { p: codeLabel(priority) })}>{codeLabel(priority)}</span>;
}

function TaskForm({ form, setForm, projects, employees, showStarted }) {
  return (
    <>
      <div className="field">
        <label htmlFor="tk-title">{tr('What needs doing')}</label>
        <input id="tk-title" className="input" value={form.title} maxLength={100} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={tr('e.g. Service the kiln fans')} required autoFocus />
      </div>
      <div className="field">
        <label htmlFor="tk-desc">{tr('Details (optional)')}</label>
        <textarea id="tk-desc" className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={tr('Anything the person doing it should know.')} />
      </div>
      <div className="field">
        <span className="tk-label">{tr('Who does it')}</span>
        <PeoplePicker employees={employees} value={form.assigneeIds} onChange={(ids) => setForm({ ...form, assigneeIds: ids })} emptyText={tr('Nobody picked: the task is yours.')} />
      </div>
      <div className="tk-form-grid">
        <div className="field">
          <span className="tk-label">{tr('Priority')}</span>
          <div className="tk-seg" role="radiogroup" aria-label={tr('Priority')}>
            {['low', 'medium', 'high'].map((p) => (
              <button key={p} type="button" role="radio" aria-checked={form.priority === p} className={form.priority === p ? 'is-on is-' + p : ''} onClick={() => setForm({ ...form, priority: p })}>{codeLabel(p)}</button>
            ))}
          </div>
        </div>
        <div className="field">
          <label htmlFor="tk-due">{tr('Due')}</label>
          <input id="tk-due" className="input" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
        </div>
        {showStarted && (
          <div className="field">
            <label htmlFor="tk-started">{tr('Date started')}</label>
            <input id="tk-started" className="input" type="date" value={form.startedDate || ''} onChange={(e) => setForm({ ...form, startedDate: e.target.value })} />
          </div>
        )}
        <div className="field">
          <label htmlFor="tk-project">{tr('Project')}</label>
          <select id="tk-project" className="input" value={form.projectId || ''} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
            <option value="">{tr('None')}</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>
    </>
  );
}

export default function TasksPage() {
  const { session, can } = useAuth();
  const canManage = can('task.manage');
  const myId = session && session.employee ? session.employee.id : null;

  // ?project=<id> (the Projects page's "See in Tasks") opens everything I
  // can see, narrowed to that project.
  const projectFromUrl = new URLSearchParams(window.location.search).get('project') || '';
  const [scope, setScope] = useState(() => (projectFromUrl ? 'all' : readPref('bos.tasksScope', 'mine')));
  const [view, setView] = useState(() => readPref('bos.tasksView', 'board'));
  const [companyCode, setCompanyCode] = useState(() => readPref('bos.tasksCompany', 'ALL'));
  const [chip, setChip] = useState('active');
  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState(projectFromUrl);

  const [tasks, setTasks] = useState([]);
  const [projects, setProjects] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [newOpen, setNewOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  const [detail, setDetail] = useState(null);
  const [editing, setEditing] = useState(null); // form while editing
  const [commentDraft, setCommentDraft] = useState('');
  const [detailError, setDetailError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [dragId, setDragId] = useState(null);
  const [dropCol, setDropCol] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [rows, projRows, depts] = await Promise.all([
        api.get('/tasks?scope=' + scope),
        api.get('/projects').catch(() => []),
        api.get('/departments')
      ]);
      setTasks(rows);
      setProjects(projRows);
      setDepartments(depts);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [scope]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (canManage) api.get('/employees').then(setEmployees).catch(() => {});
  }, [canManage]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const companies = useMemo(() => {
    const seen = new Map();
    departments.forEach((d) => { if (!seen.has(d.companyId)) seen.set(d.companyId, { id: d.companyId, name: d.companyName, code: d.companyCode || d.companyId }); });
    return Array.from(seen.values()).sort((a, b) => (a.code === 'BPL' ? -1 : b.code === 'BPL' ? 1 : a.name.localeCompare(b.name)));
  }, [departments]);
  const currentCompany = scope === 'all' ? companies.find((c) => c.code === companyCode) || null : null;

  function pickScope(s) { setScope(s); writePref('bos.tasksScope', s); setLoading(true); }
  function pickView(v) { setView(v); writePref('bos.tasksView', v); }
  function pickCompany(code) { setCompanyCode(code); setDeptFilter(''); writePref('bos.tasksCompany', code); }

  // ── actions ──────────────────────────────────────────────────────────
  async function setStatus(task, status) {
    if (task.status === status) return;
    setError(null);
    // Move it at once; the reload below confirms it.
    setTasks((list) => list.map((t) => (t.id === task.id ? { ...t, status, completedAt: status === 'completed' ? new Date().toISOString() : null } : t)));
    try {
      const updated = await api.post('/tasks/' + task.id + '/status', { status });
      if (detail && detail.id === task.id) setDetail(updated);
      await load();
    } catch (err) {
      setError(err.message);
      await load();
    }
  }

  function openNew() { setForm(EMPTY_FORM); setFormError(null); setNewOpen(true); }
  async function createTask(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const created = await api.post('/tasks', {
        title: form.title, description: form.description, projectId: form.projectId || null,
        assigneeIds: form.assigneeIds.length ? form.assigneeIds : undefined, priority: form.priority, dueDate: form.dueDate || undefined
      });
      setNewOpen(false);
      setToast(tr('Task added.'));
      await load();
      setDetail(created);
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }

  async function openDetail(t) {
    setDetailError(null);
    setEditing(null);
    setCommentDraft('');
    try { setDetail(await api.get('/tasks/' + t.id)); } catch (err) { setError(err.message); }
  }
  function startEdit() {
    setEditing({
      title: detail.title, description: detail.description || '', projectId: detail.projectId || '',
      assigneeIds: detail.assigneeIds.slice(), priority: detail.priority,
      dueDate: detail.dueDate || '', startedDate: (detail.createdAt || '').slice(0, 10)
    });
  }
  async function saveEdit(e) {
    e.preventDefault();
    setSaving(true);
    setDetailError(null);
    try {
      const updated = await api.patch('/tasks/' + detail.id, {
        title: editing.title, description: editing.description, projectId: editing.projectId || null,
        assigneeIds: editing.assigneeIds, priority: editing.priority, dueDate: editing.dueDate || detail.dueDate, startedDate: editing.startedDate
      });
      setDetail(updated);
      setEditing(null);
      setToast(tr('Task updated.'));
      await load();
    } catch (err) { setDetailError(err.message); } finally { setSaving(false); }
  }
  async function postComment(e) {
    if (e) e.preventDefault();
    const body = commentDraft.trim();
    if (!body) return;
    setDetailError(null);
    try {
      setDetail(await api.post('/tasks/' + detail.id + '/comments', { body }));
      setCommentDraft('');
      await load();
    } catch (err) { setDetailError(err.message); }
  }
  async function confirmDelete() {
    setDeleting(true);
    try {
      await api.del('/tasks/' + deleteTarget.id);
      setToast(tr('Task deleted.'));
      if (detail && detail.id === deleteTarget.id) setDetail(null);
      setDeleteTarget(null);
      await load();
    } catch (err) { setError(err.message); } finally { setDeleting(false); }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const today = isoDay(new Date());
  const weekEnd = addDays(today, 6);
  const weekAgo = addDays(today, -6);
  const scoped = tasks
    .filter((t) => !currentCompany || (t.companyCodes || []).includes(currentCompany.code))
    .filter((t) => !deptFilter || (t.departmentIds || []).includes(deptFilter))
    .filter((t) => !projectFilter || t.projectId === projectFilter);
  const open = scoped.filter(OPEN);
  const overdue = open.filter((t) => t.overdue);
  const dueWeek = open.filter((t) => t.dueDate && t.dueDate >= today && t.dueDate <= weekEnd);
  const dueToday = open.filter((t) => t.dueDate === today);
  const doneWeek = scoped.filter((t) => t.status === 'completed' && t.completedAt && isoDay(new Date(t.completedAt)) >= weekAgo);
  const high = open.filter((t) => t.priority === 'high');
  const reviewForMe = scoped.filter((t) => t.status === 'under_review' && t.createdBy === myId);

  const chipTest = {
    active: (t) => t.status !== 'cancelled',
    overdue: (t) => OPEN(t) && t.overdue,
    week: (t) => OPEN(t) && t.dueDate && t.dueDate >= today && t.dueDate <= weekEnd,
    high: (t) => OPEN(t) && t.priority === 'high',
    review: (t) => t.status === 'under_review',
    done: (t) => t.status === 'completed',
    cancelled: (t) => t.status === 'cancelled',
    all: () => true
  };
  function showOnly(key) { setChip(chip === key ? 'active' : key); jump('tk-list'); }
  const visible = scoped
    .filter(chipTest[chip] || chipTest.active)
    .filter((t) => matchesQuery(search, t.title, t.projectName, t.description, ...(t.assigneeNames || [])));

  const stats = [
    { icon: 'doc', value: String(open.length), label: tr('open tasks'), note: high.length ? tr('{n} high priority', { n: high.length }) : tr('none high priority'), onClick: () => { setChip('active'); jump('tk-list'); } },
    { icon: 'warn', value: String(overdue.length), label: tr('overdue'), note: overdue.length ? tr('oldest {n} days late', { n: Math.max(...overdue.map((t) => t.daysOverdue || 0)) }) : tr('nothing late'), tone: overdue.length ? 'bad' : '', onClick: () => showOnly('overdue') },
    { icon: 'calendar', value: String(dueWeek.length), label: tr('due this week'), note: dueToday.length ? tr('{n} due today', { n: dueToday.length }) : tr('in the next 7 days'), tone: dueToday.length ? 'alert' : '', onClick: () => showOnly('week') },
    { icon: 'check', value: String(doneWeek.length), label: tr('done this week'), note: tr('in the last 7 days'), tone: doneWeek.length ? 'good' : '', onClick: () => showOnly('done') }
  ];

  // What stands out.
  const insights = [];
  if (scope === 'all' && overdue.length) {
    const byPerson = new Map();
    overdue.forEach((t) => (t.assignees || []).forEach((a) => {
      if (!byPerson.has(a.id)) byPerson.set(a.id, { name: a.name, tasks: [] });
      byPerson.get(a.id).tasks.push(t);
    }));
    const worst = Array.from(byPerson.values()).sort((a, b) => b.tasks.length - a.tasks.length)[0];
    if (worst && worst.tasks.length > 1) {
      insights.push({ tone: 'bad', icon: 'people', text: tr('{name} has {n} overdue tasks.', { name: worst.name, n: worst.tasks.length }), action: { label: tr('Show them'), run: () => { setSearch(worst.name); setChip('overdue'); jump('tk-list'); } } });
    }
  }
  const oldest = overdue.slice().sort((a, b) => (b.daysOverdue || 0) - (a.daysOverdue || 0))[0];
  if (oldest) insights.push({ tone: 'bad', icon: 'clock', text: tr('"{title}" is {n} days overdue ({who}).', { title: oldest.title, n: oldest.daysOverdue, who: (oldest.assigneeNames || []).join(', ') || tr('Unassigned') }), action: { label: tr('Open'), run: () => openDetail(oldest) } });
  if (reviewForMe.length) insights.push({ tone: 'warn', icon: 'check', text: reviewForMe.length === 1 ? tr('"{title}" is waiting for you to review it.', { title: reviewForMe[0].title }) : tr('{n} tasks you set are waiting for you to review them.', { n: reviewForMe.length }), action: { label: tr('Review'), run: () => (reviewForMe.length === 1 ? openDetail(reviewForMe[0]) : showOnly('review')) } });
  const highIdle = high.filter((t) => t.status === 'not_started');
  if (highIdle.length) insights.push({ tone: 'warn', icon: 'warn', text: highIdle.length === 1 ? tr('High priority "{title}" has not been started.', { title: highIdle[0].title }) : tr('{n} high-priority tasks have not been started.', { n: highIdle.length }), action: { label: tr('Show them'), run: () => showOnly('high') } });
  const myToday = dueToday.filter((t) => (t.assigneeIds || []).includes(myId));
  if (myToday.length) insights.push({ tone: 'info', icon: 'calendar', text: myToday.length === 1 ? tr('Your task "{title}" is due today.', { title: myToday[0].title }) : tr('You have {n} tasks due today.', { n: myToday.length }), action: { label: tr('Show them'), run: () => showOnly('week') } });
  if (doneWeek.length >= 3) insights.push({ tone: 'good', icon: 'check', text: tr('{n} tasks were completed in the last 7 days.', { n: doneWeek.length }) });

  const chips = [
    ['active', tr('Active'), scoped.filter(chipTest.active).length],
    ['overdue', tr('Overdue'), overdue.length],
    ['week', tr('Due this week'), dueWeek.length],
    ['high', tr('High priority'), high.length],
    ['review', tr('Under review'), scoped.filter(chipTest.review).length],
    ['done', tr('Completed'), scoped.filter(chipTest.done).length],
    ['cancelled', tr('Cancelled'), scoped.filter(chipTest.cancelled).length]
  ].filter(([k, , n]) => n > 0 || k === 'active' || k === chip);

  const columns = chip === 'cancelled' ? ['cancelled'] : BOARD;
  const sortOpen = (a, b) => (a.overdue === b.overdue ? 0 : a.overdue ? -1 : 1)
    || ({ high: 0, medium: 1, low: 2 }[a.priority] - { high: 0, medium: 1, low: 2 }[b.priority])
    || String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999'));
  const listRows = visible.slice().sort((a, b) => {
    const ra = OPEN(a) ? 0 : 1, rb = OPEN(b) ? 0 : 1;
    if (ra !== rb) return ra - rb;
    if (ra === 0) return sortOpen(a, b);
    return String(b.completedAt || '').localeCompare(String(a.completedAt || ''));
  });

  function moveMenu(t) {
    return [
      { label: tr('Open'), onClick: () => openDetail(t) },
      ...STATUSES.filter((s) => s !== t.status).map((s) => ({ label: tr('Move to {status}', { status: codeLabel(s) }), onClick: () => setStatus(t, s) })),
      { label: tr('Delete'), onClick: () => setDeleteTarget(t), danger: true, hidden: !canManage }
    ];
  }

  function renderCard(t) {
    const due = dueInfo(t, today);
    return (
      <article key={t.id} className={'tk-card' + (t.overdue ? ' is-overdue' : '') + (dragId === t.id ? ' is-dragging' : '')} draggable
        onDragStart={(e) => { setDragId(t.id); e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; }}
        onDragEnd={() => { setDragId(null); setDropCol(null); }}>
        <div className="tk-card-top">
          <button type="button" className="tk-card-title" onClick={() => openDetail(t)}>{t.title}</button>
          <RowMenu actions={moveMenu(t)} />
        </div>
        {t.projectName && t.projectName !== '—' && <span className="tk-project">{t.projectName}</span>}
        <div className="tk-card-meta">
          <PriorityMark priority={t.priority} />
          <span className={'tk-due is-' + (due.tone || 'plain')}>{due.text}</span>
        </div>
        <div className="tk-card-foot">
          <Faces people={t.assignees} size={24} />
          {t.commentCount > 0 && (
            <span className="tk-comments" title={tr('{n} comments', { n: t.commentCount })}>
              <svg className="dk-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="M4.5 18.5 5.6 15A7 7 0 1 1 8.9 17.6z" /></svg>{t.commentCount}
            </span>
          )}
        </div>
      </article>
    );
  }

  const showCompany = scope === 'all' && companies.length > 1;

  return (
    <div className="dk tk">
      {error && <div className="error-banner" role="alert">{error}</div>}

      {showCompany && (
        <CompanySwitcher companies={[{ code: 'ALL', name: tr('All companies') }, ...companies]} company={currentCompany ? currentCompany.code : 'ALL'}
          onPick={pickCompany}
          describe={(co) => {
            const n = tasks.filter((t) => OPEN(t) && (co.code === 'ALL' || (t.companyCodes || []).includes(co.code))).length;
            return tr('{n} open', { n });
          }} />
      )}

      <Hero
        eyebrow={new Date().toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        title={scope === 'mine' ? tr('My tasks') : tr('Tasks')}
        sub={scope === 'mine'
          ? tr('The work given to you: what is late, what is due soon and what is done. Move a task along as you work on it, and comment to keep everyone up to date.')
          : currentCompany
            ? tr('All the tasks you can see at {company}: who is doing what, what is late and what is waiting for a review. Press a number to show only those tasks.', { company: currentCompany.name })
            : tr('All the tasks you can see: who is doing what, what is late and what is waiting for a review. Press a number to show only those tasks.')}
        actions={<>
          <div className="tk-seg" role="radiogroup" aria-label={tr('Show')}>
            <button type="button" role="radio" aria-checked={scope === 'mine'} className={scope === 'mine' ? 'is-on' : ''} onClick={() => pickScope('mine')}>{tr('My tasks')}</button>
            <button type="button" role="radio" aria-checked={scope === 'all'} className={scope === 'all' ? 'is-on' : ''} onClick={() => pickScope('all')}>{tr('Everything I can see')}</button>
          </div>
          {canManage && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('+ New task')}</button>}
        </>}
        stats={stats} />

      <Insights items={insights.slice(0, 6)} />

      <Section id="tk-list" title={view === 'board' ? tr('Board') : tr('List')}
        sub={view === 'board' ? tr('A column per status. Drag a card to move it, or use its ⋮ menu.') : tr('Late tasks first, then by priority and due date.')}
        action={
          <div className="ppl-view" role="radiogroup" aria-label={tr('Show as')}>
            <button type="button" role="radio" aria-checked={view === 'board'} className={view === 'board' ? 'is-on' : ''} onClick={() => pickView('board')} title={tr('Board')} aria-label={tr('Board')}>
              <svg className="dk-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><rect x="3.5" y="4" width="5" height="16" rx="1.2" /><rect x="10" y="4" width="5" height="11" rx="1.2" /><rect x="16.5" y="4" width="4" height="7" rx="1.2" /></svg>
            </button>
            <button type="button" role="radio" aria-checked={view === 'list'} className={view === 'list' ? 'is-on' : ''} onClick={() => pickView('list')} title={tr('List')} aria-label={tr('List')}>
              <svg className="dk-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5v.1M4.5 12v.1M4.5 17.5v.1" /></svg>
            </button>
          </div>
        }>
        <div className="tk-tools">
          <div className="tk-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search tasks, people, projects…')} /></div>
          {scope === 'all' && (
            <select className="input tk-select" value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} aria-label={tr('Filter by department')}>
              <option value="">{tr('All departments')}</option>
              {departments.filter((d) => !currentCompany || d.companyId === currentCompany.id).map((d) => <option key={d.id} value={d.id}>{currentCompany ? d.name : d.name + ' — ' + d.companyName}</option>)}
            </select>
          )}
          {projects.length > 0 && (
            <select className="input tk-select" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} aria-label={tr('Filter by project')}>
              <option value="">{tr('All projects')}</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, n]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
              {label} <span className="ppl-chip-n">{n}</span>
            </button>
          ))}
        </div>

        {!visible.length ? (
          <div className="dk-empty tk-empty">
            <p>{scoped.length ? tr('No tasks match. Try another search or filter.') : scope === 'mine' ? tr('Nothing on your plate. Tasks given to you will show here.') : tr('No tasks yet.')}</p>
            {(search || chip !== 'active' || deptFilter || projectFilter) && scoped.length > 0 && <button type="button" className="btn btn-secondary" onClick={() => { setSearch(''); setChip('active'); setDeptFilter(''); setProjectFilter(''); }}>{tr('Clear filters')}</button>}
            {canManage && !scoped.length && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('+ New task')}</button>}
          </div>
        ) : view === 'board' ? (
          <div className="tk-board" style={{ '--tk-cols': columns.length }}>
            {columns.map((s) => {
              const inCol = visible.filter((t) => t.status === s).sort(s === 'completed' ? (a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')) : sortOpen);
              const shown = s === 'completed' && chip !== 'done' ? inCol.slice(0, DONE_SHOWN) : inCol;
              return (
                <div key={s} className={'tk-col is-' + s + (dropCol === s ? ' is-drop' : '')}
                  onDragOver={(e) => { if (dragId) { e.preventDefault(); setDropCol(s); } }}
                  onDragLeave={(e) => { if (e.currentTarget === e.target) setDropCol(null); }}
                  onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData('text/plain') || dragId; const t = tasks.find((x) => x.id === id); setDropCol(null); setDragId(null); if (t) setStatus(t, s); }}>
                  <header className="tk-col-head">
                    <span className="tk-col-dot" aria-hidden="true" />
                    <strong>{codeLabel(s)}</strong>
                    <span className="tk-col-n">{inCol.length}</span>
                  </header>
                  <div className="tk-col-body">
                    {shown.map((t) => renderCard(t))}
                    {!inCol.length && <p className="tk-col-empty">{tr('Nothing here')}</p>}
                    {shown.length < inCol.length && <button type="button" className="dk-link tk-more" onClick={() => showOnly('done')}>{tr('Show all {n} completed', { n: inCol.length })}</button>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <ul className="tk-list">
            {listRows.map((t) => {
              const due = dueInfo(t, today);
              return (
                <li key={t.id} className={'tk-row' + (t.overdue ? ' is-overdue' : '') + (OPEN(t) ? '' : ' is-closed')}>
                  <button type="button" className="tk-row-main" onClick={() => openDetail(t)}>
                    <strong>{t.title}</strong>
                    <span className="dk-muted">{[t.projectName !== '—' ? t.projectName : null, t.commentCount ? tr('{n} comments', { n: t.commentCount }) : null].filter(Boolean).join(' · ') || ' '}</span>
                  </button>
                  <Faces people={t.assignees} size={28} />
                  <PriorityMark priority={t.priority} />
                  <span className={'tk-due is-' + (due.tone || 'plain')}>{due.text}</span>
                  <select className="input tk-status-select" value={t.status} onChange={(e) => setStatus(t, e.target.value)} aria-label={tr('Status of {title}', { title: t.title })}>
                    {STATUSES.map((s) => <option key={s} value={s}>{codeLabel(s)}</option>)}
                  </select>
                  <RowMenu actions={[{ label: tr('Open'), onClick: () => openDetail(t) }, { label: tr('Delete'), onClick: () => setDeleteTarget(t), danger: true, hidden: !canManage }]} />
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Glossary items={[
        [codeLabel('not_started'), tr('Given out, nobody has begun yet.')],
        [codeLabel('in_progress'), tr('Someone is working on it.')],
        [codeLabel('waiting'), tr('Held up by something or someone else: parts, an answer, another task.')],
        [codeLabel('under_review'), tr('Done by the person doing it, waiting for whoever set it to check. They get a notification.')],
        [codeLabel('completed'), tr('Finished. The date it was completed is kept.')],
        [tr('Overdue'), tr('Past its due date and not completed or cancelled.')]
      ]} />

      {newOpen && (
        <div className="dialog-backdrop" onClick={() => setNewOpen(false)}>
          <form className="dialog tk-dialog" onClick={(e) => e.stopPropagation()} onSubmit={createTask}>
            <h2>{tr('New task')}</h2>
            <TaskForm form={form} setForm={setForm} projects={projects} employees={employees} />
            <p className="dk-muted tk-small">{tr('Everyone you add gets a notification. With no due date, it is due today.')}</p>
            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setNewOpen(false)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Add task')}</button>
            </div>
          </form>
        </div>
      )}

      {detail && (
        <div className="dialog-backdrop" onClick={() => setDetail(null)}>
          <div className="dialog tk-dialog tk-detail" onClick={(e) => e.stopPropagation()}>
            {detailError && <div className="error-banner">{detailError}</div>}
            {editing ? (
              <form onSubmit={saveEdit} className="tk-edit">
                <h2>{tr('Edit task')}</h2>
                <TaskForm form={editing} setForm={setEditing} projects={projects} employees={employees} showStarted />
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>{tr('Cancel')}</button>
                  <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Save changes')}</button>
                </div>
              </form>
            ) : (
              <>
                <header className="tk-detail-head">
                  <div>
                    <h2>{detail.title}</h2>
                    <span className="dk-muted">
                      {[detail.projectName !== '—' ? detail.projectName : null, detail.createdByName ? tr('set by {name}', { name: detail.createdByName }) : null, tr('started {date}', { date: fmtDate((detail.createdAt || '').slice(0, 10)) })].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                  <button type="button" className="tk-close" onClick={() => setDetail(null)} aria-label={tr('Close')}>×</button>
                </header>

                <div className="tk-steps" role="radiogroup" aria-label={tr('Status')}>
                  {STATUSES.map((s) => (
                    <button key={s} type="button" role="radio" aria-checked={detail.status === s} className={'tk-step is-' + s + (detail.status === s ? ' is-on' : '')} onClick={() => setStatus(detail, s)}>
                      {codeLabel(s)}
                    </button>
                  ))}
                </div>

                <dl className="tk-facts">
                  <div><dt>{tr('Who does it')}</dt><dd className="tk-people">{detail.assignees && detail.assignees.length ? detail.assignees.map((a) => <span key={a.id} className="tk-person"><Photo id={a.id} name={a.name} photo={a.photo} size={26} />{a.name}</span>) : tr('Unassigned')}</dd></div>
                  <div><dt>{tr('Priority')}</dt><dd><PriorityMark priority={detail.priority} /></dd></div>
                  <div><dt>{tr('Due')}</dt><dd>{fmtDate(detail.dueDate)} {(() => { const d = dueInfo(detail, today); return d.tone === 'bad' || d.tone === 'warn' ? <Status tone={d.tone}>{d.text}</Status> : null; })()}</dd></div>
                  {detail.completedAt && <div><dt>{tr('Completed')}</dt><dd>{fmtDate(String(detail.completedAt).slice(0, 10))}</dd></div>}
                </dl>
                {detail.description ? <p className="tk-desc">{detail.description}</p> : null}

                {canManage && (
                  <div className="tk-detail-actions">
                    <button type="button" className="btn btn-secondary tk-btn" onClick={startEdit}>{tr('Edit')}</button>
                    <button type="button" className="btn btn-secondary tk-btn" onClick={() => setDeleteTarget(detail)}>{tr('Delete')}</button>
                  </div>
                )}

                <section className="tk-thread">
                  <h3>{tr('Comments')} <span className="dk-muted">{detail.comments.length}</span></h3>
                  {detail.comments.length ? (
                    <ul className="tk-comments-list">
                      {detail.comments.map((c) => (
                        <li key={c.id} className={c.authorId === myId ? 'is-mine' : ''}>
                          <Photo id={c.authorId} name={c.authorName} photo={c.authorPhoto} size={30} />
                          <div className="tk-comment">
                            <div className="tk-comment-head"><strong>{c.authorId === myId ? tr('You') : c.authorName}</strong><span className="dk-muted">{ago(c.at)}</span></div>
                            <p>{c.body}</p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="dk-muted tk-small">{tr('No comments yet. Ask a question or post an update; the people on the task are notified.')}</p>}
                  <form className="tk-compose" onSubmit={postComment}>
                    <textarea className="input" rows={2} value={commentDraft} onChange={(e) => setCommentDraft(e.target.value)} maxLength={1000}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); postComment(); } }}
                      placeholder={tr('Write a comment…')} aria-label={tr('Comment')} />
                    <button className="btn btn-primary" type="submit" disabled={!commentDraft.trim()}>{tr('Post')}</button>
                  </form>
                </section>
              </>
            )}
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Delete task')}</h2>
            <p className="dialog-body">{tr('Delete')} <strong>{deleteTarget.title}</strong>{tr('? This cannot be undone.')}</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDelete}>{deleting ? tr('Deleting…') : tr('Delete')}</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
