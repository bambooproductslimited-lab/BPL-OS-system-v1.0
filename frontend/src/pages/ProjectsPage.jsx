import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import Photo from '../components/Photo';
import PeoplePicker from '../components/PeoplePicker';
import RowMenu from '../components/RowMenu';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { CompanySwitcher, Glossary, Insights, Section, Status, fmtDate, jump } from '../components/DashKit';
import { money } from '../lib/currency';
import { tr } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import { woStatusLabel } from '../lib/workOrders.js';
import './EmployeesPage.css';
import './ProjectsPage.css';
import './ProjectsFun.css';
import { ForWhom, Owners, PanelHead, PjBanner, PjFlow, RecentlyClosed, Ring, Timeline } from './ProjectsFun.jsx';

// Projects. Same "explains itself" layout as the dashboards
// (components/DashKit.jsx): a company switcher, the key numbers (press one
// to show only those projects), what stands out (past the deadline,
// falling behind — much of the time gone but little of the work done —
// overdue tasks, projects with no tasks), then a card per project showing
// time used next to work done. A project opens in a window with its
// status, who it is for, people, dates, budget, description, how its work
// orders went (completed, on time, days each, labour) and the work orders
// themselves; managers (project.manage) can edit it and change its status,
// and anyone who issues work orders can issue one for it from there — the
// new work order starts with the project's "for", owner and team.

const STATUSES = ['planning', 'active', 'on_hold', 'delayed', 'completed', 'cancelled'];
const OPEN = (p) => p.status !== 'completed' && p.status !== 'cancelled';
const EMPTY_FORM = { name: '', departmentId: '', ownerId: '', memberIds: [], startDate: '', deadline: '', budget: '', description: '', forKind: 'company', forCompanyId: '', customerText: '', autoClose: true };

// What the server reads for who the project is for.
function forBody(f) {
  return f.forKind === 'company' ? { forCompanyId: f.forCompanyId || null, customerName: '' } : { forCompanyId: null, customerName: f.customerText || '' };
}

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
  // Every work order done (none open, at least one completed) but still open: waiting to be closed.
  const openWork = Math.max(0, (p.taskCount || 0) - (p.doneCount || 0) - (p.cancelledCount || 0));
  let key = 'track';
  if (p.status === 'completed') key = 'done';
  else if (p.status === 'cancelled') key = 'cancelled';
  else if (work && !openWork && (p.doneCount || 0) > 0) key = 'ready';
  else if (daysLeft !== null && daysLeft < 0) key = 'overdue';
  else if (!work) key = 'notasks';
  else if (time >= 0.3 && time - done >= 0.25) key = 'behind';
  return { work, done, time, daysLeft, key };
}
const HEALTH = {
  track: { tone: 'good', label: () => tr('On track') },
  behind: { tone: 'warn', label: () => tr('Falling behind') },
  overdue: { tone: 'bad', label: () => tr('Past deadline') },
  notasks: { tone: 'muted', label: () => tr('No work orders yet') },
  ready: { tone: 'info', label: () => tr('Ready to close') },
  done: { tone: 'good', label: () => tr('Completed') },
  cancelled: { tone: 'muted', label: () => tr('Cancelled') }
};

// How a closed project came to be closed.
function closedText(p) {
  if (!p.closedAt) return p.status === 'cancelled' ? tr('Cancelled') : tr('Completed');
  const date = fmtDate(String(p.closedAt).slice(0, 10));
  if (p.status === 'cancelled') return p.closedByName ? tr('Cancelled on {date} by {name}.', { date, name: p.closedByName }) : tr('Cancelled on {date}.', { date });
  if (p.closedAuto) return tr('Closed by itself on {date}, when its last work order was done.', { date });
  return p.closedByName ? tr('Closed on {date} by {name}.', { date, name: p.closedByName }) : tr('Closed on {date}.', { date });
}

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

function ProjectForm({ form, setForm, departments, employees, companies, customers }) {
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
      <div className="field pj-span">
        <span className="pj-label">{tr('Who it is for')}</span>
        <div className="pj-for">
          <div className="pj-seg" role="radiogroup" aria-label={tr('Who it is for')}>
            {[['company', tr('One of our companies')], ['customer', tr('A customer')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={form.forKind === k} className={form.forKind === k ? 'is-on' : ''} onClick={() => setForm({ ...form, forKind: k })}>{label}</button>
            ))}
          </div>
          {form.forKind === 'company' ? (
            <select id="pj-for-co" className="input" value={form.forCompanyId} onChange={(e) => setForm({ ...form, forCompanyId: e.target.value })} aria-label={tr('Company')}>
              <option value="">{tr('Not said')}</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          ) : (
            <>
              <input id="pj-for-cu" className="input" list="pj-customers" value={form.customerText} maxLength={120} onChange={(e) => setForm({ ...form, customerText: e.target.value })} placeholder={tr('Pick or type a name')} aria-label={tr('Customer')} />
              <datalist id="pj-customers">{(customers || []).map((c) => <option key={c.id} value={c.name} />)}</datalist>
            </>
          )}
        </div>
        <span className="dk-muted pj-small">{tr('Work orders issued for the project start with this filled in.')}</span>
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
      <label className="pj-span pj-check">
        <input type="checkbox" checked={!!form.autoClose} onChange={(e) => setForm({ ...form, autoClose: e.target.checked })} />
        <span>
          <strong>{tr('Close it by itself when all its work orders are done')}</strong>
          <span className="dk-muted">{tr('Its owner is told, and it reopens by itself if one of them is opened again or a new one is added. Leave this off to close the project yourself.')}</span>
        </span>
      </label>
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
  const [customers, setCustomers] = useState([]);
  const canIssue = can('task.manage');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [companyCode, setCompanyCode] = useState(() => readPref('bos.projectsCompany', 'ALL'));
  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [forFilter, setForFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [chip, setChip] = useState('open');

  const [newOpen, setNewOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  const [detail, setDetail] = useState(null);
  const [editing, setEditing] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [closeTarget, setCloseTarget] = useState(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [closing, setClosing] = useState(false);

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
  useEffect(() => { if (canManage && canIssue) api.get('/tasks/options').then((o) => setCustomers(o.customers || [])).catch(() => {}); }, [canManage, canIssue]);
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
        startDate: form.startDate || undefined, deadline: form.deadline || undefined, budget: form.budget || 0, description: form.description, autoClose: !!form.autoClose, ...forBody(form)
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
  function openClose(p) { setCloseTarget(p); setCancelOpen(false); }
  async function confirmClose() {
    setClosing(true);
    try {
      const closed = await api.post('/projects/' + closeTarget.id + '/close', { cancelOpen });
      setToast(closed.cancelledWorkOrders ? tr('{code} is closed; {n} open work orders were cancelled.', { code: closed.code, n: closed.cancelledWorkOrders }) : tr('{code} is closed.', { code: closed.code }));
      if (detail && detail.id === closed.id) setDetail(closed);
      setCloseTarget(null);
      await load();
    } catch (err) { setError(err.message); setCloseTarget(null); } finally { setClosing(false); }
  }
  function startEdit() {
    setEditing({
      name: detail.name, departmentId: detail.departmentId, ownerId: detail.ownerId, memberIds: detail.members.map((m) => m.id),
      startDate: detail.startDate || '', deadline: detail.deadline || '', budget: detail.budget ? String(detail.budget) : '', description: detail.description || '',
      forKind: detail.forCompanyId || !detail.customerName ? 'company' : 'customer', forCompanyId: detail.forCompanyId || '', customerText: detail.forCompanyId ? '' : detail.customerName || '',
      autoClose: !!detail.autoClose
    });
  }
  async function saveEdit(e) {
    e.preventDefault();
    setSaving(true);
    setDetailError(null);
    try {
      const { forKind, forCompanyId, customerText, ...rest } = editing; // eslint-disable-line no-unused-vars
      const saved = await api.patch('/projects/' + detail.id, { ...rest, ...forBody(editing), ownerId: editing.ownerId || undefined, budget: editing.budget === '' ? 0 : editing.budget });
      setDetail(saved);
      setEditing(null);
      setToast((saved.projectChanges || []).some((c) => c.change === 'closed') ? tr('Project updated. All its work orders are done, so it has closed itself.') : tr('Project updated.'));
      await load();
    } catch (err) { setDetailError(err.message); } finally { setSaving(false); }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const today = isoDay(new Date());
  const scoped = projects
    .filter((p) => !currentCompany || p.companyCode === currentCompany.code)
    .filter((p) => !deptFilter || p.departmentId === deptFilter)
    .filter((p) => !forFilter || p.requestedFor === forFilter)
    .filter((p) => !ownerFilter || p.ownerName === ownerFilter);
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
    ready: ({ h }) => h.key === 'ready',
    active: ({ p, h }) => p.status === 'active' && h.key !== 'ready',
    completed: ({ p }) => p.status === 'completed',
    cancelled: ({ p }) => p.status === 'cancelled',
    all: () => true
  };
  function showOnly(key) { setChip(chip === key ? 'open' : key); jump('pj-list'); }
  const order = { overdue: 0, ready: 1, behind: 2, notasks: 3, track: 4, done: 5, cancelled: 6 };
  const visible = withHealth
    .filter(chipTest[chip] || chipTest.open)
    .filter(({ p }) => matchesQuery(search, p.name, p.code, p.departmentName, p.companyName, p.ownerName, p.description, ...(p.members || []).map((m) => m.name)))
    .sort((a, b) => order[a.h.key] - order[b.h.key] || String(a.p.deadline || '9999').localeCompare(String(b.p.deadline || '9999')));


  const insights = [];
  overdue.slice().sort((a, b) => a.h.daysLeft - b.h.daysLeft).slice(0, 2).forEach(({ p, h }) => {
    insights.push({ tone: 'bad', icon: 'clock', text: tr('{name} is {n} days past its deadline with {pct}% of the work done.', { name: p.name, n: -h.daysLeft, pct: Math.round(h.done * 100) }), action: { label: tr('Open'), run: () => openDetail(p) } });
  });
  behind.slice(0, 2).forEach(({ p, h }) => {
    insights.push({ tone: 'warn', icon: 'warn', text: tr('{name} is falling behind: {t}% of the time is gone but only {w}% of the work is done.', { name: p.name, t: Math.round(h.time * 100), w: Math.round(h.done * 100) }), action: { label: tr('Open'), run: () => openDetail(p) } });
  });
  if (withLateTasks.length) {
    const worst = withLateTasks.slice().sort((a, b) => b.p.overdueTaskCount - a.p.overdueTaskCount)[0].p;
    insights.push({ tone: 'warn', icon: 'doc', text: withLateTasks.length === 1 ? tr('{name} has {n} overdue work orders.', { name: worst.name, n: worst.overdueTaskCount }) : tr('{n} projects have overdue work orders; {name} has the most ({t}).', { n: withLateTasks.length, name: worst.name, t: worst.overdueTaskCount }), action: { label: tr('See its work orders'), run: () => navigate('/tasks?project=' + worst.id) } });
  }
  if (noTasks.length) insights.push({ tone: 'info', icon: 'info', text: noTasks.length === 1 ? tr('{name} has no work orders yet, so its progress cannot be measured. Add work orders to it in Work orders.', { name: noTasks[0].p.name }) : tr('{n} open projects have no work orders yet, so their progress cannot be measured.', { n: noTasks.length }) });
  const ready = open.filter(({ h }) => h.key === 'ready');
  if (ready.length) {
    insights.unshift(ready.length === 1
      ? { tone: 'good', icon: 'check', text: tr('{name} has all its work orders done. Close it?', { name: ready[0].p.name }), action: canManage ? { label: tr('Close it'), run: () => openClose(ready[0].p) } : { label: tr('Open'), run: () => openDetail(ready[0].p) } }
      : { tone: 'good', icon: 'check', text: tr('{n} projects have all their work orders done and are waiting to be closed.', { n: ready.length }), action: { label: tr('Show them'), run: () => showOnly('ready') } });
  }
  const held = open.filter(({ p }) => p.status === 'on_hold' || p.status === 'delayed');
  if (held.length) insights.push({ tone: 'info', icon: 'clock', text: tr('On hold or delayed: {names}.', { names: held.map(({ p }) => p.name).join(', ') }), action: { label: tr('Show them'), run: () => showOnly('held') } });

  const chips = [
    ['open', tr('Open'), scoped.filter(OPEN).length],
    ['ready', tr('Ready to close'), ready.length],
    ['behind', tr('Behind or late'), overdue.length + behind.length],
    ['soon', tr('Deadline within 30 days'), soon.length],
    ['planning', codeLabel('planning'), withHealth.filter(chipTest.planning).length],
    ['held', tr('On hold or delayed'), held.length],
    ['completed', codeLabel('completed'), withHealth.filter(chipTest.completed).length],
    ['cancelled', codeLabel('cancelled'), withHealth.filter(chipTest.cancelled).length]
  ].filter(([k, , n]) => n > 0 || k === 'open' || k === chip);
  const showCompany = !currentCompany && companies.length > 1;
  const readyCount = ready.length;
  const notReady = open.filter(({ h }) => h.key !== 'ready');
  const flowCounts = {
    planning: notReady.filter(({ p }) => p.status === 'planning').length,
    active: notReady.filter(({ p }) => p.status === 'active').length,
    held: notReady.filter(({ p }) => p.status === 'on_hold' || p.status === 'delayed').length,
    ready: readyCount,
    completed: withHealth.filter(({ p }) => p.status === 'completed').length
  };

  const dh = detail ? healthOf({ ...detail, taskCount: detail.tasks.length, doneCount: detail.tasks.filter((t) => t.status === 'completed').length, cancelledCount: detail.tasks.filter((t) => t.status === 'cancelled').length }, today) : null;

  return (
    <div className="dk pj">
      {error && <div className="error-banner" role="alert">{error}</div>}

      {companies.length > 1 && (
        <CompanySwitcher companies={[{ code: 'ALL', name: tr('All companies') }, ...companies]} company={currentCompany ? currentCompany.code : 'ALL'}
          onPick={pickCompany}
          describe={(co) => tr('{n} open', { n: projects.filter((p) => OPEN(p) && (co.code === 'ALL' || p.companyCode === co.code)).length })} />
      )}

      <PjBanner
        eyebrow={currentCompany ? currentCompany.name : tr('All companies')}
        title={tr('Projects')}
        sub={tr('Bigger pieces of work, each made of work orders. For every project: how much of the time is gone next to how much of the work is done, so you can see which ones are falling behind. Press a number to show only those projects.')}
        actions={canManage && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('+ New project')}</button>}
        work={workAll ? doneAll / workAll : null}
        workText={tr('{d} of {t} work orders in open projects', { d: doneAll, t: workAll })}
        tiles={[
          { icon: 'doc', value: String(open.length), label: tr('open projects'), note: tr('{a} active · {p} planning', { a: open.filter(({ p }) => p.status === 'active').length, p: open.filter(({ p }) => p.status === 'planning').length }), onClick: () => showOnly('open'), active: chip === 'open' },
          { icon: 'warn', value: String(overdue.length + behind.length), label: tr('behind or late'), note: tr('{o} past deadline · {b} falling behind', { o: overdue.length, b: behind.length }), tone: overdue.length + behind.length ? 'alert' : 'good', onClick: () => showOnly('behind'), active: chip === 'behind' },
          { icon: 'check', value: String(readyCount), label: tr('ready to close'), note: readyCount ? tr('all their work orders done') : tr('none waiting'), tone: readyCount ? 'good' : '', onClick: () => showOnly('ready'), active: chip === 'ready' },
          { icon: 'calendar', value: String(soon.length), label: tr('deadline within 30 days'), note: soon.length ? tr('next: {name}', { name: soon.slice().sort((a, b) => a.h.daysLeft - b.h.daysLeft)[0].p.name }) : tr('none coming up'), onClick: () => showOnly('soon'), active: chip === 'soon' }
        ]} />

      <PjFlow counts={flowCounts} active={chip} onPick={showOnly} />

      {(forFilter || ownerFilter) && (
        <div className="pjx-filtered" role="status">
          <span>{tr('Showing only:')}</span>
          {forFilter && <button type="button" className="pjx-filter-chip" onClick={() => setForFilter('')}>{tr('for {name}', { name: forFilter })} ×</button>}
          {ownerFilter && <button type="button" className="pjx-filter-chip" onClick={() => setOwnerFilter('')}>{tr('owned by {name}', { name: ownerFilter })} ×</button>}
        </div>
      )}

      <Insights items={insights.slice(0, 6)} />

      {scoped.length > 0 && (
        <div className="pjx-panels">
          <section className="pjx-panel is-wide">
            <PanelHead icon="road" title={tr('The road to each deadline')} sub={tr('Every open project from its start to its deadline, filled with the work done so far, and today marked across them all. A bar that runs past its deadline in red is late. Press one to open it.')} />
            <Timeline rows={open} today={today} onOpen={openDetail} />
          </section>
          <section className="pjx-panel">
            <PanelHead icon="for" title={tr('Who the projects are for')} sub={tr('Our own companies and customers, with how many of their projects are still open. Press one to show only theirs.')} />
            <ForWhom projects={scoped} active={forFilter} onPick={(n) => { setForFilter(forFilter === n ? '' : n); jump('pj-list'); }} />
          </section>
          <section className="pjx-panel">
            <PanelHead icon="owner" title={tr('Owners')} sub={tr('Who owns the open projects, and how many are behind, late or ready to close. Press one to show only theirs.')} />
            <Owners rows={withHealth} active={ownerFilter} onPick={(n) => { setOwnerFilter(ownerFilter === n ? '' : n); jump('pj-list'); }} />
          </section>
          <section className="pjx-panel">
            <PanelHead icon="trophy" title={tr('Completed lately')} sub={tr('Projects completed in the last four months: closed by themselves or by hand, and whether they made their deadline.')} />
            <RecentlyClosed projects={scoped} today={today} onOpen={openDetail} />
          </section>
        </div>
      )}

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
          <div className="pjx-grid">
            {visible.map(({ p, h }) => (
              <article key={p.id} className={'pjx-card is-' + h.key + ' st-' + p.status}>
                <span className="pjx-card-band" aria-hidden="true" />
                <div className="pjx-card-top">
                  <span className="dk-muted pjx-card-code">{p.code} · {p.departmentName}{showCompany ? ' · ' + p.companyCode : ''}</span>
                  {canManage && <RowMenu actions={[
                    { label: tr('Open'), onClick: () => openDetail(p) },
                    ...STATUSES.filter((s) => s !== p.status).map((s) => ({ label: tr('Set to {status}', { status: codeLabel(s) }), onClick: () => setStatus(p, s) })),
                    { label: tr('Close the project'), onClick: () => openClose(p), hidden: !OPEN(p) }
                  ]} />}
                </div>
                <div className="pjx-card-head">
                  <Ring work={h.done} time={h.time} tone={h.key} />
                  <div className="pjx-card-title">
                    <button type="button" className="pjx-card-name" onClick={() => openDetail(p)}>{p.name}</button>
                    <div className="pjx-card-tags">
                      <span className={'pjx-pill st-' + p.status}><i aria-hidden="true" />{codeLabel(p.status)}</span>
                      {OPEN(p) && <span className={'pjx-pill is-' + h.key}><i aria-hidden="true" />{HEALTH[h.key].label()}</span>}
                    </div>
                  </div>
                </div>
                {p.requestedFor && <span className="pj-for-tag pjx-for">{tr('for {name}', { name: p.requestedFor })}</span>}
                <div className="pjx-card-stats">
                  <span className="pjx-count is-done" title={tr('Work orders completed')}><b>{p.doneCount || 0}</b> {tr('done')}</span>
                  <span className="pjx-count is-open" title={tr('Work orders still open')}><b>{Math.max(0, (p.taskCount || 0) - (p.doneCount || 0) - (p.cancelledCount || 0))}</b> {tr('open')}</span>
                  {p.overdueTaskCount > 0 && <span className="pjx-count is-late" title={tr('Work orders past their date due')}><b>{p.overdueTaskCount}</b> {tr('late')}</span>}
                  <span className={'pjx-deadline' + (h.key === 'overdue' ? ' is-bad' : h.daysLeft !== null && h.daysLeft <= 7 && OPEN(p) ? ' is-warn' : '')}>{OPEN(p) ? deadlineText(h, p) : p.deadline ? tr('Deadline {date}', { date: fmtDate(p.deadline) }) : ''}</span>
                </div>
                {h.key === 'ready' && canManage && <button type="button" className="pjx-ready-btn" onClick={() => openClose(p)}>{tr('All work done — close it')}</button>}
                <div className="pjx-card-foot">
                  <span className="pj-owner"><Photo id={p.ownerId} name={p.ownerName} photo={p.ownerPhoto} size={26} /><span>{p.ownerName}</span></span>
                  <Faces people={p.members} size={24} max={3} />
                </div>
                {p.status === 'completed' && <span className="pjx-stamp" aria-hidden="true">{p.closedAuto ? tr('Closed itself') : tr('Completed')}</span>}
              </article>
            ))}
          </div>
        ) : (
          <div className="dk-empty pj-empty">
            <p>{scoped.length ? tr('No projects match. Try another search or filter.') : tr('No projects visible to your role')}</p>
            {(search || chip !== 'open' || deptFilter || forFilter || ownerFilter) && <button type="button" className="btn btn-secondary" onClick={() => { setSearch(''); setChip('open'); setDeptFilter(''); setForFilter(''); setOwnerFilter(''); }}>{tr('Clear filters')}</button>}
            {canManage && !scoped.length && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('New project')}</button>}
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('The rings'), tr('On each project: the inner ring is the work done (its number in the middle), the outer ring the time used. Inner behind outer means the work is falling behind the calendar.')],
        [tr('Time used'), tr('How much of the time between the start date and the deadline has passed.')],
        [tr('Work done'), tr('Completed work orders out of all the project\'s work orders (cancelled ones not counted).')],
        [tr('Falling behind'), tr('At least 30% of the time is gone and the work done is 25 points or more behind it.')],
        [tr('Past deadline'), tr('The deadline has passed and the project is not completed or cancelled.')],
        [tr('Ready to close'), tr('Every work order is done — completed, or cancelled with at least one completed — and the project is waiting for someone to close it.')],
        [tr('Closes by itself'), tr('A project can be set to close itself when its last work order is done. Its owner is told, and it reopens if one of its work orders is opened again or a new one is added. One closed by hand stays closed.')],
        [codeLabel('planning'), tr('Being set up; work has not properly started.')],
        [tr('On hold or delayed'), tr('Paused on purpose (on hold) or running late for a known reason (delayed).')]
      ]} />

      {newOpen && (
        <div className="dialog-backdrop" onClick={() => setNewOpen(false)}>
          <form className="dialog pj-dialog" onClick={(e) => e.stopPropagation()} onSubmit={createProject}>
            <h2>{tr('New project')}</h2>
            <ProjectForm form={form} setForm={setForm} departments={departments} employees={employees} companies={companies} customers={customers} />
            <p className="dk-muted pj-small">{tr('The team members get a notification. Issue the project\'s work orders in Work orders and pick this project for each.')}</p>
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
                <ProjectForm form={editing} setForm={setEditing} departments={departments} employees={employees} companies={companies} customers={customers} />
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>{tr('Cancel')}</button>
                  <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Save changes')}</button>
                </div>
              </form>
            ) : (
              <>
                <header className="pj-detail-head pjx-detail-head">
                  <Ring work={dh.done} time={dh.time} tone={dh.key} size={72} />
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
                  {OPEN(detail) ? <span className={'pj-deadline' + (dh.key === 'overdue' ? ' is-bad' : '')}>{deadlineText(dh, detail)}</span> : <span className="pj-closed-line">{closedText(detail)}</span>}
                  {canManage && OPEN(detail) && <button type="button" className={'btn pj-close-btn ' + (dh.key === 'ready' ? 'btn-primary' : 'btn-secondary')} onClick={() => openClose(detail)}>{tr('Close the project')}</button>}
                </div>
                <Bars h={dh} />

                <dl className="pj-facts">
                  {detail.requestedFor && <div><dt>{tr('For')}</dt><dd>{detail.requestedFor}</dd></div>}
                  <div><dt>{tr('Owner')}</dt><dd className="pj-person"><Photo id={detail.ownerId} name={detail.ownerName} photo={detail.ownerPhoto} size={26} />{detail.ownerName}</dd></div>
                  <div><dt>{tr('Dates')}</dt><dd>{fmtDate(detail.startDate)} → {fmtDate(detail.deadline)}</dd></div>
                  <div><dt>{tr('Closing')}</dt><dd>{detail.autoClose ? tr('By itself, when all its work orders are done') : tr('By hand')}</dd></div>
                  {detail.budget > 0 && <div><dt>{tr('Budget')}</dt><dd>{money(detail.budget)}</dd></div>}
                  <div className="pj-span"><dt>{tr('Team')}</dt><dd className="pj-people">{detail.members.length ? detail.members.map((m) => <span key={m.id} className="pj-person"><Photo id={m.id} name={m.name} photo={m.photo} size={26} />{m.name}</span>) : <span className="dk-muted">{tr('No team members yet.')}</span>}</dd></div>
                </dl>
                {detail.description && <p className="pj-desc">{detail.description}</p>}

                {detail.figures && (detail.figures.completed > 0 || detail.figures.labourWos > 0) && (
                  <section className="pj-figs" aria-label={tr('How its work orders went')}>
                    <h3>{tr('How its work orders went')}</h3>
                    <div className="pj-figs-row">
                      <div><strong>{detail.figures.completed}</strong><span>{tr('completed')}</span></div>
                      <div><strong>{detail.figures.onTimePct === null ? '—' : detail.figures.onTimePct + '%'}</strong><span>{detail.figures.withDue ? tr('on time ({n} of {t})', { n: detail.figures.onTime, t: detail.figures.withDue }) : tr('on time')}</span></div>
                      <div><strong>{detail.figures.avgDaysToClose === null ? '—' : detail.figures.avgDaysToClose}</strong><span>{tr('days each, issued to completed')}</span></div>
                      <div><strong>{detail.figures.personDays === null ? '—' : detail.figures.personDays}</strong><span>{detail.figures.labourWos ? tr('person-days of labour (from {n} WOs)', { n: detail.figures.labourWos }) : tr('person-days of labour')}</span></div>
                    </div>
                  </section>
                )}

                <section className="pj-tasks">
                  <div className="pj-tasks-head">
                    <h3>{tr('Work orders')} <span className="dk-muted">{detail.tasks.length}</span></h3>
                    <span className="pj-tasks-actions">
                      {canIssue && OPEN(detail) && <button type="button" className="btn btn-primary pj-new-wo" onClick={() => navigate('/tasks?project=' + detail.id + '&new=1')}>{tr('+ Work order')}</button>}
                      <button type="button" className="dk-link" onClick={() => navigate('/tasks?project=' + detail.id)}>{tr('See its work orders')} →</button>
                    </span>
                  </div>
                  {detail.tasks.length ? (
                    <ul className="pj-task-list">
                      {detail.tasks.map((t) => (
                        <li key={t.id} className={'is-' + t.status + (t.overdue ? ' is-overdue' : '')}>
                          <span className={'pj-task-dot is-' + t.status} aria-hidden="true" />
                          <span className="pj-task-title">{t.number ? <span className="pj-wo">{t.number}</span> : null}{t.title}</span>
                          <Faces people={t.assignees} size={22} max={2} />
                          <span className={'pj-task-due' + (t.overdue ? ' is-bad' : '')}>{t.status === 'completed' ? tr('Done') : t.dueDate ? fmtDate(t.dueDate) : '—'}</span>
                          <span className="dk-muted pj-task-status">{woStatusLabel(t.status)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="dk-muted pj-small">{canIssue ? tr('No work orders yet. Press “+ Work order” to issue one for this project, or add existing ones from the register in Work orders.') : tr('No work orders yet.')}</p>}
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

      {closeTarget && (() => {
        const row = projects.find((x) => x.id === closeTarget.id) || closeTarget;
        const total = row.taskCount !== undefined ? row.taskCount : (closeTarget.tasks || []).length;
        const done = row.doneCount !== undefined ? row.doneCount : (closeTarget.tasks || []).filter((t) => t.status === 'completed').length;
        const cancelled = row.cancelledCount !== undefined ? row.cancelledCount : (closeTarget.tasks || []).filter((t) => t.status === 'cancelled').length;
        const left = Math.max(0, total - done - cancelled);
        return (
          <div className="dialog-backdrop" onClick={() => setCloseTarget(null)}>
            <div className="dialog pj-close-dialog" onClick={(e) => e.stopPropagation()}>
              <h2>{tr('Close {name}?', { name: closeTarget.name })}</h2>
              <div className="pj-close-counts">
                <div><strong>{done}</strong><span>{tr('completed')}</span></div>
                <div><strong>{cancelled}</strong><span>{codeLabel('cancelled').toLowerCase()}</span></div>
                <div className={left ? 'is-open' : ''}><strong>{left}</strong><span>{tr('still open')}</span></div>
              </div>
              {left > 0 ? (
                <div className="pj-close-choice" role="radiogroup" aria-label={tr('The work orders still open')}>
                  <label><input type="radio" name="pj-close-open" checked={!cancelOpen} onChange={() => setCancelOpen(false)} /> {left === 1 ? tr('Leave the 1 open work order as it is') : tr('Leave the {n} open work orders as they are', { n: left })}</label>
                  <label><input type="radio" name="pj-close-open" checked={cancelOpen} onChange={() => setCancelOpen(true)} /> {left === 1 ? tr('Cancel it too') : tr('Cancel them too')}</label>
                </div>
              ) : <p className="dialog-body">{total ? tr('Every work order is done. The project is marked completed today, by you.') : tr('It has no work orders. The project is marked completed today, by you.')}</p>}
              <div className="dialog-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setCloseTarget(null)}>{tr('Cancel')}</button>
                <button type="button" className="btn btn-primary" disabled={closing} onClick={confirmClose}>{closing ? tr('Saving…') : tr('Close the project')}</button>
              </div>
            </div>
          </div>
        );
      })()}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
