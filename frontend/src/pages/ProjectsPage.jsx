import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import Photo from '../components/Photo';
import PeoplePicker from '../components/PeoplePicker';
import RowMenu from '../components/RowMenu';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { CompanySwitcher, Glossary, Hero, Insights, Section, Status, fmtDate, jump } from '../components/DashKit';
import { money } from '../lib/currency';
import { tr } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import './EmployeesPage.css';
import './ProjectsPage.css';

// Projects. Same "explains itself" layout as the dashboards
// (components/DashKit.jsx): a company switcher, the key numbers (press one
// to show only those projects), what stands out (past the deadline,
// falling behind — much of the time gone but little of the work done —
// overdue tasks, projects with no tasks), then a card per project showing
// time used next to work done. A project opens in a window with its
// status, people, dates, budget, description and tasks; managers
// (project.manage) can edit it and change its status.

const STATUSES = ['planning', 'active', 'on_hold', 'delayed', 'completed', 'cancelled'];
const OPEN = (p) => p.status !== 'completed' && p.status !== 'cancelled';
const EMPTY_FORM = { name: '', departmentId: '', ownerId: '', memberIds: [], startDate: '', deadline: '', budget: '', description: '' };

function isoDay(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00') - new Date(a + 'T00:00')) / 86400000); }
function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }

// Time used, work done and how the project is doing.
function healthOf(p, today) {
  const work = Math.max(0, (p.taskCount || 0) - (p.cancelledCount || 0));
  const done = work ? Math.min(1, (p.doneCount || 0) / work) : 0;
  const span = p.startDate && p.deadline ? daysBetween(p.startDate, p.deadline) : 0;
  const gone = p.startDate ? daysBetween(p.startDate, today) : 0;
  const time = span > 0 ? Math.max(0, Math.min(1, gone / span)) : (p.deadline && today >= p.deadline ? 1 : 0);
  const daysLeft = p.deadline ? daysBetween(today, p.deadline) : null;
  let key = 'track';
  if (p.status === 'completed') key = 'done';
  else if (p.status === 'cancelled') key = 'cancelled';
  else if (daysLeft !== null && daysLeft < 0) key = 'overdue';
  else if (!work) key = 'notasks';
  else if (time >= 0.3 && time - done >= 0.25) key = 'behind';
  return { work, done, time, daysLeft, key };
}
const HEALTH = {
  track: { tone: 'good', label: () => tr('On track') },
  behind: { tone: 'warn', label: () => tr('Falling behind') },
  overdue: { tone: 'bad', label: () => tr('Past deadline') },
  notasks: { tone: 'muted', label: () => tr('No tasks yet') },
  done: { tone: 'good', label: () => tr('Completed') },
  cancelled: { tone: 'muted', label: () => tr('Cancelled') }
};

function Faces({ people, size = 26, max = 4 }) {
  if (!people || !people.length) return null;
  return (
    <span className="pj-faces" title={people.map((x) => x.name).join(', ')}>
      {people.slice(0, max).map((x) => <Photo key={x.id} id={x.id} name={x.name} photo={x.photo} size={size} />)}
      {people.length > max && <span className="pj-faces-more">+{people.length - max}</span>}
    </span>
  );
}

function Bars({ h }) {
  return (
    <div className="pj-bars">
      <div className="pj-bar-row">
        <span className="pj-bar-label">{tr('Time used')}</span>
        <span className="pj-track" aria-hidden="true"><span className="is-time" style={{ width: Math.round(h.time * 100) + '%' }} /></span>
        <span className="pj-bar-n">{Math.round(h.time * 100)}%</span>
      </div>
      <div className="pj-bar-row">
        <span className="pj-bar-label">{tr('Work done')}</span>
        <span className="pj-track" aria-hidden="true"><span className={'is-work is-' + h.key} style={{ width: Math.round(h.done * 100) + '%' }} /></span>
        <span className="pj-bar-n">{h.work ? Math.round(h.done * 100) + '%' : '—'}</span>
      </div>
    </div>
  );
}

function deadlineText(h, p) {
  if (!p.deadline) return tr('No deadline');
  if (p.status === 'completed' || p.status === 'cancelled') return tr('Deadline {date}', { date: fmtDate(p.deadline) });
  if (h.daysLeft < 0) return -h.daysLeft === 1 ? tr('1 day past the deadline') : tr('{n} days past the deadline', { n: -h.daysLeft });
  if (h.daysLeft === 0) return tr('Deadline today');
  if (h.daysLeft === 1) return tr('1 day left');
  return tr('{n} days left', { n: h.daysLeft });
}

function ProjectForm({ form, setForm, departments, employees, companies }) {
  return (
    <div className="pj-form">
      <div className="field pj-span">
        <label htmlFor="pj-name">{tr('Name')}</label>
        <input id="pj-name" className="input" value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={tr('e.g. New kiln line')} required autoFocus />
      </div>
      <div className="field">
        <label htmlFor="pj-dept">{tr('Department')}</label>
        <select id="pj-dept" className="input" value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })} required>
          <option value="" disabled>{tr('Choose a department')}</option>
          {companies.map((c) => (
            <optgroup key={c.id} label={c.name}>
              {departments.filter((d) => d.companyId === c.id).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </optgroup>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="pj-owner">{tr('Owner')}</label>
        <select id="pj-owner" className="input" value={form.ownerId} onChange={(e) => setForm({ ...form, ownerId: e.target.value })}>
          <option value="">{tr('Me')}</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
        </select>
      </div>
      <div className="field pj-span">
        <span className="pj-label">{tr('Team')}</span>
        <PeoplePicker employees={employees} value={form.memberIds} onChange={(ids) => setForm({ ...form, memberIds: ids })} emptyText={tr('No team members yet.')} />
      </div>
      <div className="field">
        <label htmlFor="pj-start">{tr('Start')}</label>
        <input id="pj-start" className="input" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="pj-deadline">{tr('Deadline')}</label>
        <input id="pj-deadline" className="input" type="date" value={form.deadline} min={form.startDate || undefined} onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="pj-budget">{tr('Budget (GHS, optional)')}</label>
        <input id="pj-budget" className="input" type="number" min="0" step="0.01" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} />
      </div>
      <div className="field pj-span">
        <label htmlFor="pj-desc">{tr('Description')}</label>
        <textarea id="pj-desc" className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={tr('What the project is for and what "done" looks like.')} />
      </div>
    </div>
  );
}

export default function ProjectsPage() {
  const { can } = useAuth();
  const canManage = can('project.manage');
  const navigate = useNavigate();

  const [projects, setProjects] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [companyCode, setCompanyCode] = useState(() => readPref('bos.projectsCompany', 'ALL'));
  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [chip, setChip] = useState('open');

  const [newOpen, setNewOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  const [detail, setDetail] = useState(null);
  const [editing, setEditing] = useState(null);
  const [detailError, setDetailError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [rows, depts] = await Promise.all([api.get('/projects'), api.get('/departments')]);
      setProjects(rows);
      setDepartments(depts);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (canManage) api.get('/employees').then(setEmployees).catch(() => {}); }, [canManage]);
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
  const currentCompany = companies.find((c) => c.code === companyCode) || null;
  function pickCompany(code) { setCompanyCode(code); setDeptFilter(''); writePref('bos.projectsCompany', code); }

  // ── actions ──────────────────────────────────────────────────────────
  function openNew() {
    setForm({ ...EMPTY_FORM, departmentId: currentCompany ? ((departments.find((d) => d.companyId === currentCompany.id) || {}).id || '') : '' });
    setFormError(null);
    setNewOpen(true);
  }
  async function createProject(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const created = await api.post('/projects', {
        name: form.name, departmentId: form.departmentId, ownerId: form.ownerId || undefined, memberIds: form.memberIds,
        startDate: form.startDate || undefined, deadline: form.deadline || undefined, budget: form.budget || 0, description: form.description
      });
      setNewOpen(false);
      setToast(tr('Project created.'));
      await load();
      openDetail(created);
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }
  async function openDetail(p) {
    setDetailError(null);
    setEditing(null);
    try { setDetail(await api.get('/projects/' + p.id)); } catch (err) { setError(err.message); }
  }
  async function setStatus(p, status) {
    if (p.status === status) return;
    setDetailError(null);
    try {
      await api.post('/projects/' + p.id + '/status', { status });
      if (detail && detail.id === p.id) setDetail(await api.get('/projects/' + p.id));
      setToast(tr('{code} is now {status}.', { code: p.code, status: codeLabel(status).toLowerCase() }));
      await load();
    } catch (err) { (detail ? setDetailError : setError)(err.message); }
  }
  function startEdit() {
    setEditing({
      name: detail.name, departmentId: detail.departmentId, ownerId: detail.ownerId, memberIds: detail.members.map((m) => m.id),
      startDate: detail.startDate || '', deadline: detail.deadline || '', budget: detail.budget ? String(detail.budget) : '', description: detail.description || ''
    });
  }
  async function saveEdit(e) {
    e.preventDefault();
    setSaving(true);
    setDetailError(null);
    try {
      setDetail(await api.patch('/projects/' + detail.id, { ...editing, ownerId: editing.ownerId || undefined, budget: editing.budget === '' ? 0 : editing.budget }));
      setEditing(null);
      setToast(tr('Project updated.'));
      await load();
    } catch (err) { setDetailError(err.message); } finally { setSaving(false); }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const today = isoDay(new Date());
  const scoped = projects
    .filter((p) => !currentCompany || p.companyCode === currentCompany.code)
    .filter((p) => !deptFilter || p.departmentId === deptFilter);
  const withHealth = scoped.map((p) => ({ p, h: healthOf(p, today) }));
  const open = withHealth.filter(({ p }) => OPEN(p));
  const overdue = open.filter(({ h }) => h.key === 'overdue');
  const behind = open.filter(({ h }) => h.key === 'behind');
  const soon = open.filter(({ h }) => h.daysLeft !== null && h.daysLeft >= 0 && h.daysLeft <= 30);
  const noTasks = open.filter(({ h }) => h.key === 'notasks');
  const withLateTasks = open.filter(({ p }) => p.overdueTaskCount > 0);
  const workAll = open.reduce((n, { h }) => n + h.work, 0);
  const doneAll = open.reduce((n, { p }) => n + (p.doneCount || 0), 0);

  const chipTest = {
    open: ({ p }) => OPEN(p),
    behind: ({ h }) => h.key === 'behind' || h.key === 'overdue',
    soon: ({ p, h }) => OPEN(p) && h.daysLeft !== null && h.daysLeft >= 0 && h.daysLeft <= 30,
    planning: ({ p }) => p.status === 'planning',
    held: ({ p }) => p.status === 'on_hold' || p.status === 'delayed',
    completed: ({ p }) => p.status === 'completed',
    cancelled: ({ p }) => p.status === 'cancelled',
    all: () => true
  };
  function showOnly(key) { setChip(chip === key ? 'open' : key); jump('pj-list'); }
  const order = { overdue: 0, behind: 1, notasks: 2, track: 3, done: 4, cancelled: 5 };
  const visible = withHealth
    .filter(chipTest[chip] || chipTest.open)
    .filter(({ p }) => matchesQuery(search, p.name, p.code, p.departmentName, p.companyName, p.ownerName, p.description, ...(p.members || []).map((m) => m.name)))
    .sort((a, b) => order[a.h.key] - order[b.h.key] || String(a.p.deadline || '9999').localeCompare(String(b.p.deadline || '9999')));

  const stats = [
    { icon: 'doc', value: String(open.length), label: tr('open projects'), note: tr('{a} active · {p} planning', { a: open.filter(({ p }) => p.status === 'active').length, p: open.filter(({ p }) => p.status === 'planning').length }), onClick: () => { setChip('open'); jump('pj-list'); } },
    { icon: 'warn', value: String(overdue.length + behind.length), label: tr('behind or late'), note: tr('{o} past deadline · {b} falling behind', { o: overdue.length, b: behind.length }), tone: overdue.length ? 'bad' : behind.length ? 'alert' : '', onClick: () => showOnly('behind') },
    { icon: 'calendar', value: String(soon.length), label: tr('deadline within 30 days'), note: soon.length ? tr('next: {name}', { name: soon.slice().sort((a, b) => a.h.daysLeft - b.h.daysLeft)[0].p.name }) : tr('none coming up'), onClick: () => showOnly('soon') },
    { icon: 'check', value: workAll ? Math.round((doneAll / workAll) * 100) + '%' : '—', label: tr('of tasks done'), note: tr('{d} of {t} tasks in open projects', { d: doneAll, t: workAll }), onClick: () => { setChip('open'); jump('pj-list'); } }
  ];

  const insights = [];
  overdue.slice().sort((a, b) => a.h.daysLeft - b.h.daysLeft).slice(0, 2).forEach(({ p, h }) => {
    insights.push({ tone: 'bad', icon: 'clock', text: tr('{name} is {n} days past its deadline with {pct}% of the work done.', { name: p.name, n: -h.daysLeft, pct: Math.round(h.done * 100) }), action: { label: tr('Open'), run: () => openDetail(p) } });
  });
  behind.slice(0, 2).forEach(({ p, h }) => {
    insights.push({ tone: 'warn', icon: 'warn', text: tr('{name} is falling behind: {t}% of the time is gone but only {w}% of the work is done.', { name: p.name, t: Math.round(h.time * 100), w: Math.round(h.done * 100) }), action: { label: tr('Open'), run: () => openDetail(p) } });
  });
  if (withLateTasks.length) {
    const worst = withLateTasks.slice().sort((a, b) => b.p.overdueTaskCount - a.p.overdueTaskCount)[0].p;
    insights.push({ tone: 'warn', icon: 'doc', text: withLateTasks.length === 1 ? tr('{name} has {n} overdue tasks.', { name: worst.name, n: worst.overdueTaskCount }) : tr('{n} projects have overdue tasks; {name} has the most ({t}).', { n: withLateTasks.length, name: worst.name, t: worst.overdueTaskCount }), action: { label: tr('See in Tasks'), run: () => navigate('/tasks?project=' + worst.id) } });
  }
  if (noTasks.length) insights.push({ tone: 'info', icon: 'info', text: noTasks.length === 1 ? tr('{name} has no tasks yet, so its progress cannot be measured. Add tasks to it in Tasks.', { name: noTasks[0].p.name }) : tr('{n} open projects have no tasks yet, so their progress cannot be measured.', { n: noTasks.length }) });
  const held = open.filter(({ p }) => p.status === 'on_hold' || p.status === 'delayed');
  if (held.length) insights.push({ tone: 'info', icon: 'clock', text: tr('On hold or delayed: {names}.', { names: held.map(({ p }) => p.name).join(', ') }), action: { label: tr('Show them'), run: () => showOnly('held') } });

  const chips = [
    ['open', tr('Open'), scoped.filter(OPEN).length],
    ['behind', tr('Behind or late'), overdue.length + behind.length],
    ['soon', tr('Deadline within 30 days'), soon.length],
    ['planning', codeLabel('planning'), withHealth.filter(chipTest.planning).length],
    ['held', tr('On hold or delayed'), held.length],
    ['completed', codeLabel('completed'), withHealth.filter(chipTest.completed).length],
    ['cancelled', codeLabel('cancelled'), withHealth.filter(chipTest.cancelled).length]
  ].filter(([k, , n]) => n > 0 || k === 'open' || k === chip);
  const showCompany = !currentCompany && companies.length > 1;

  const dh = detail ? healthOf({ ...detail, taskCount: detail.tasks.length, doneCount: detail.tasks.filter((t) => t.status === 'completed').length, cancelledCount: detail.tasks.filter((t) => t.status === 'cancelled').length }, today) : null;

  return (
    <div className="dk pj">
      {error && <div className="error-banner" role="alert">{error}</div>}

      {companies.length > 1 && (
        <CompanySwitcher companies={[{ code: 'ALL', name: tr('All companies') }, ...companies]} company={currentCompany ? currentCompany.code : 'ALL'}
          onPick={pickCompany}
          describe={(co) => tr('{n} open', { n: projects.filter((p) => OPEN(p) && (co.code === 'ALL' || p.companyCode === co.code)).length })} />
      )}

      <Hero
        eyebrow={currentCompany ? currentCompany.name : tr('All companies')}
        title={tr('Projects')}
        sub={tr('Bigger pieces of work, each made of tasks. For every project: how much of the time is gone next to how much of the work is done, so you can see which ones are falling behind. Press a number to show only those projects.')}
        actions={canManage && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('New project')}</button>}
        stats={stats} />

      <Insights items={insights.slice(0, 6)} />

      <Section id="pj-list" title={tr('Projects')} sub={tr('Late and falling-behind projects first, then by deadline. Press a project to open it.')}>
        <div className="pj-tools">
          <div className="pj-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search projects, people, departments…')} /></div>
          <select className="input pj-select" value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} aria-label={tr('Filter by department')}>
            <option value="">{tr('All departments')}</option>
            {departments.filter((d) => !currentCompany || d.companyId === currentCompany.id).map((d) => <option key={d.id} value={d.id}>{currentCompany ? d.name : d.name + ' — ' + d.companyName}</option>)}
          </select>
        </div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, n]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
              {label} <span className="ppl-chip-n">{n}</span>
            </button>
          ))}
        </div>

        {visible.length ? (
          <div className="pj-grid">
            {visible.map(({ p, h }) => (
              <article key={p.id} className={'pj-card is-' + h.key}>
                <div className="pj-card-top">
                  <span className="dk-muted pj-card-code">{p.code} · {p.departmentName}{showCompany ? ' · ' + p.companyCode : ''}</span>
                  {canManage && <RowMenu actions={[
                    { label: tr('Open'), onClick: () => openDetail(p) },
                    ...STATUSES.filter((s) => s !== p.status).map((s) => ({ label: tr('Set to {status}', { status: codeLabel(s) }), onClick: () => setStatus(p, s) }))
                  ]} />}
                </div>
                <button type="button" className="pj-card-name" onClick={() => openDetail(p)}>{p.name}</button>
                <div className="pj-card-tags">
                  <Status tone={p.status === 'active' ? 'info' : p.status === 'completed' ? 'good' : p.status === 'delayed' ? 'bad' : 'muted'}>{codeLabel(p.status)}</Status>
                  {OPEN(p) && <Status tone={HEALTH[h.key].tone}>{HEALTH[h.key].label()}</Status>}
                </div>
                <Bars h={h} />
                <div className="pj-card-facts">
                  <span className={'pj-deadline' + (h.key === 'overdue' ? ' is-bad' : h.daysLeft !== null && h.daysLeft <= 7 && OPEN(p) ? ' is-warn' : '')}>{deadlineText(h, p)}</span>
                  <span className="dk-muted">{tr('{d} of {t} tasks', { d: p.doneCount, t: h.work })}{p.overdueTaskCount ? ' · ' : ''}{p.overdueTaskCount ? <span className="pj-late">{tr('{n} late', { n: p.overdueTaskCount })}</span> : null}</span>
                </div>
                <div className="pj-card-foot">
                  <span className="pj-owner"><Photo id={p.ownerId} name={p.ownerName} photo={p.ownerPhoto} size={26} /><span>{p.ownerName}</span></span>
                  <Faces people={p.members} size={24} max={3} />
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="dk-empty pj-empty">
            <p>{scoped.length ? tr('No projects match. Try another search or filter.') : tr('No projects visible to your role')}</p>
            {(search || chip !== 'open' || deptFilter) && scoped.length > 0 && <button type="button" className="btn btn-secondary" onClick={() => { setSearch(''); setChip('open'); setDeptFilter(''); }}>{tr('Clear filters')}</button>}
            {canManage && !scoped.length && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('New project')}</button>}
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('Time used'), tr('How much of the time between the start date and the deadline has passed.')],
        [tr('Work done'), tr('Completed tasks out of all the project\'s tasks (cancelled ones not counted).')],
        [tr('Falling behind'), tr('At least 30% of the time is gone and the work done is 25 points or more behind it.')],
        [tr('Past deadline'), tr('The deadline has passed and the project is not completed or cancelled.')],
        [codeLabel('planning'), tr('Being set up; work has not properly started.')],
        [tr('On hold or delayed'), tr('Paused on purpose (on hold) or running late for a known reason (delayed).')]
      ]} />

      {newOpen && (
        <div className="dialog-backdrop" onClick={() => setNewOpen(false)}>
          <form className="dialog pj-dialog" onClick={(e) => e.stopPropagation()} onSubmit={createProject}>
            <h2>{tr('New project')}</h2>
            <ProjectForm form={form} setForm={setForm} departments={departments} employees={employees} companies={companies} />
            <p className="dk-muted pj-small">{tr('The team members get a notification. Add the project\'s tasks in Tasks and pick this project for each.')}</p>
            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setNewOpen(false)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Creating…') : tr('Create project')}</button>
            </div>
          </form>
        </div>
      )}

      {detail && (
        <div className="dialog-backdrop" onClick={() => setDetail(null)}>
          <div className="dialog pj-dialog pj-detail" onClick={(e) => e.stopPropagation()}>
            {detailError && <div className="error-banner">{detailError}</div>}
            {editing ? (
              <form onSubmit={saveEdit}>
                <h2>{tr('Edit project')}</h2>
                <ProjectForm form={editing} setForm={setEditing} departments={departments} employees={employees} companies={companies} />
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>{tr('Cancel')}</button>
                  <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Save changes')}</button>
                </div>
              </form>
            ) : (
              <>
                <header className="pj-detail-head">
                  <div>
                    <span className="dk-muted">{detail.code} · {detail.departmentName} · {detail.companyName}</span>
                    <h2>{detail.name}</h2>
                  </div>
                  <button type="button" className="pj-close" onClick={() => setDetail(null)} aria-label={tr('Close')}>×</button>
                </header>

                {canManage ? (
                  <div className="pj-steps" role="radiogroup" aria-label={tr('Status')}>
                    {STATUSES.map((s) => (
                      <button key={s} type="button" role="radio" aria-checked={detail.status === s} className={'pj-step is-' + s + (detail.status === s ? ' is-on' : '')} onClick={() => setStatus(detail, s)}>{codeLabel(s)}</button>
                    ))}
                  </div>
                ) : (
                  <div className="pj-card-tags"><Status tone="info">{codeLabel(detail.status)}</Status></div>
                )}

                <div className="pj-detail-health">
                  {OPEN(detail) && <Status tone={HEALTH[dh.key].tone}>{HEALTH[dh.key].label()}</Status>}
                  <span className={'pj-deadline' + (dh.key === 'overdue' ? ' is-bad' : '')}>{deadlineText(dh, detail)}</span>
                </div>
                <Bars h={dh} />

                <dl className="pj-facts">
                  <div><dt>{tr('Owner')}</dt><dd className="pj-person"><Photo id={detail.ownerId} name={detail.ownerName} photo={detail.ownerPhoto} size={26} />{detail.ownerName}</dd></div>
                  <div><dt>{tr('Dates')}</dt><dd>{fmtDate(detail.startDate)} → {fmtDate(detail.deadline)}</dd></div>
                  {detail.budget > 0 && <div><dt>{tr('Budget')}</dt><dd>{money(detail.budget)}</dd></div>}
                  <div className="pj-span"><dt>{tr('Team')}</dt><dd className="pj-people">{detail.members.length ? detail.members.map((m) => <span key={m.id} className="pj-person"><Photo id={m.id} name={m.name} photo={m.photo} size={26} />{m.name}</span>) : <span className="dk-muted">{tr('No team members yet.')}</span>}</dd></div>
                </dl>
                {detail.description && <p className="pj-desc">{detail.description}</p>}

                <section className="pj-tasks">
                  <div className="pj-tasks-head">
                    <h3>{tr('Tasks')} <span className="dk-muted">{detail.tasks.length}</span></h3>
                    <button type="button" className="dk-link" onClick={() => navigate('/tasks?project=' + detail.id)}>{tr('See in Tasks')} →</button>
                  </div>
                  {detail.tasks.length ? (
                    <ul className="pj-task-list">
                      {detail.tasks.map((t) => (
                        <li key={t.id} className={'is-' + t.status + (t.overdue ? ' is-overdue' : '')}>
                          <span className={'pj-task-dot is-' + t.status} aria-hidden="true" />
                          <span className="pj-task-title">{t.title}</span>
                          <Faces people={t.assignees} size={22} max={2} />
                          <span className={'pj-task-due' + (t.overdue ? ' is-bad' : '')}>{t.status === 'completed' ? tr('Done') : t.dueDate ? fmtDate(t.dueDate) : '—'}</span>
                          <span className="dk-muted pj-task-status">{codeLabel(t.status)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="dk-muted pj-small">{tr('No tasks yet. In Tasks, add a task and pick this project for it.')}</p>}
                </section>

                <div className="dialog-actions">
                  {canManage && <button type="button" className="btn btn-secondary" onClick={startEdit}>{tr('Edit')}</button>}
                  <button type="button" className="btn btn-primary" onClick={() => setDetail(null)}>{tr('Close')}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
