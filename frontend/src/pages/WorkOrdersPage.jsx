import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import Photo from '../components/Photo';
import PeoplePicker from '../components/PeoplePicker';
import RowMenu from '../components/RowMenu';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { CompanySwitcher, Glossary, Insights, Section, Status, fmtDate, jump } from '../components/DashKit';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import { WO_OPEN, WO_STATUSES, woStatusLabel } from '../lib/workOrders.js';
import {
  ForWhom, Linked, Managers, PanelHead, Pipeline, ProcessSteps, Speed, StatusPill, Weekly, WoBanner, WoCard, WoImport,
  addDays, dueInfo, forName, isoDay, pmOf, shortDate
} from './WorkOrdersFun.jsx';
import './EmployeesPage.css';
import './WorkOrdersPage.css';

// Work orders (WOs) — what the OS once called tasks, now recorded the way
// the workshop kept them on its Google Form and sheet: a number, who the
// work is for, the item, quantity, specification, materials and process,
// a project manager over the team, the date issued and the estimated date
// due. The page explains itself: a banner with the key numbers (press one
// to show only those WOs), the flow of statuses with how many sit in each,
// what stands out, who the work is for, the project managers' load, the
// WOs finished each week and how long they take; then the WOs as a board
// (drag a card to move it) or as a register like the sheet. A WO opens as
// its sheet, with its status steps, everything on the form, the timing and
// comments, and prints for the workshop floor. Anyone who can see a WO can
// move it and comment; issuing, editing, deleting and importing the sheet
// need task.manage.

const BOARD = ['discussing', 'not_started', 'in_progress', 'awaiting_material', 'waiting', 'under_review', 'completed'];
const DONE_SHOWN = 12;
const RECENT_DAYS = 14;
const PAGE = 60;
const EMPTY_FORM = {
  title: '', description: '', projectId: '', assigneeIds: [], priority: 'medium', issuedOn: '', dueDate: '', status: 'not_started',
  forKind: 'company', forCompanyId: '', customerText: '', contact: '', soRef: '', itemCode: '', quantity: '', specification: '',
  materials: '', materialQuantity: '', materialSpec: '', process: '', projectManagerId: '', workers: '', workDays: '', teamNames: ''
};

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function dayOf(ts) { return ts ? isoDay(new Date(ts)) : null; }
function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return tr('just now');
  if (mins < 60) return tr('{n} min ago', { n: mins });
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return tr('{n} h ago', { n: hrs });
  return fmtDate(String(iso).slice(0, 10));
}

function WoForm({ form, setForm, projects, employees, options, editing }) {
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const companies = options.companies || [];
  return (
    <>
      <fieldset className="wo-fs">
        <legend><b>1</b>{tr('The request')}</legend>
        <div className="field">
          <span className="wo-label">{tr('Who it is for')}</span>
          <div className="wo-seg" role="radiogroup" aria-label={tr('Who it is for')}>
            {[['company', tr('One of our companies')], ['customer', tr('A customer')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={form.forKind === k} className={form.forKind === k ? 'is-on' : ''} onClick={() => setForm({ ...form, forKind: k })}>{label}</button>
            ))}
          </div>
        </div>
        <div className="wo-grid">
          {form.forKind === 'company' ? (
            <div className="field">
              <label htmlFor="wo-for-co">{tr('Company')}</label>
              <select id="wo-for-co" className="input" value={form.forCompanyId} onChange={set('forCompanyId')}>
                <option value="">{tr('Not said')}</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          ) : (
            <div className="field">
              <label htmlFor="wo-for-cu">{tr('Customer')}</label>
              <input id="wo-for-cu" className="input" list="wo-customers" value={form.customerText} maxLength={120} onChange={set('customerText')} placeholder={tr('Pick or type a name')} />
              <datalist id="wo-customers">{(options.customers || []).map((c) => <option key={c.id} value={c.name} />)}</datalist>
            </div>
          )}
          <div className="field">
            <label htmlFor="wo-contact">{tr('Contact')}</label>
            <input id="wo-contact" className="input" value={form.contact} maxLength={120} onChange={set('contact')} placeholder={tr('Name or phone')} />
          </div>
          <div className="field">
            <label htmlFor="wo-so">{tr('Sales order no.')}</label>
            <input id="wo-so" className="input" value={form.soRef} maxLength={40} onChange={set('soRef')} placeholder={tr('If there is one')} />
          </div>
        </div>
      </fieldset>

      <fieldset className="wo-fs">
        <legend><b>2</b>{tr('The work')}</legend>
        <div className="field">
          <label htmlFor="wo-title">{tr('Description of the WO')}</label>
          <input id="wo-title" className="input" value={form.title} maxLength={200} onChange={set('title')} placeholder={tr('e.g. Round table and stand')} required autoFocus={!editing} />
        </div>
        <div className="wo-grid">
          <div className="field">
            <label htmlFor="wo-item">{tr('Item number')}</label>
            <input id="wo-item" className="input" value={form.itemCode} maxLength={60} onChange={set('itemCode')} placeholder={tr('Catalogue code, e.g. H51')} />
          </div>
          <div className="field">
            <label htmlFor="wo-qty">{tr('Quantity')}</label>
            <input id="wo-qty" className="input" value={form.quantity} maxLength={60} onChange={set('quantity')} placeholder="1" />
          </div>
        </div>
        <div className="field">
          <label htmlFor="wo-spec">{tr('Specification and link')}</label>
          <input id="wo-spec" className="input" value={form.specification} maxLength={1000} onChange={set('specification')} placeholder={tr('Sizes, e.g. L=59" W=36" H=30", or a link')} />
        </div>
      </fieldset>

      <fieldset className="wo-fs">
        <legend><b>3</b>{tr('Materials and process')}</legend>
        <div className="field">
          <label htmlFor="wo-mat">{tr('Material needed')}</label>
          <input id="wo-mat" className="input" value={form.materials} maxLength={1000} onChange={set('materials')} placeholder={tr('e.g. bamboo poles, V51 board')} />
        </div>
        <div className="wo-grid">
          <div className="field">
            <label htmlFor="wo-matq">{tr('Material quantity')}</label>
            <input id="wo-matq" className="input" value={form.materialQuantity} maxLength={200} onChange={set('materialQuantity')} />
          </div>
          <div className="field">
            <label htmlFor="wo-mats">{tr('Material specification')}</label>
            <input id="wo-mats" className="input" value={form.materialSpec} maxLength={500} onChange={set('materialSpec')} placeholder={tr('e.g. 2ft x 8ft')} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="wo-process">{tr('Process')}</label>
          <input id="wo-process" className="input" value={form.process} maxLength={1000} onChange={set('process')} placeholder={tr('e.g. cut to size, assemble and polish')} />
        </div>
      </fieldset>

      <fieldset className="wo-fs">
        <legend><b>4</b>{tr('People and dates')}</legend>
        <div className="wo-grid">
          <div className="field">
            <label htmlFor="wo-pm">{tr('Project manager')}</label>
            <select id="wo-pm" className="input" value={form.projectManagerId} onChange={set('projectManagerId')}>
              <option value="">{form.pmName ? tr('{name} (as written on the sheet)', { name: form.pmName }) : tr('None')}</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.firstName + ' ' + e.lastName}</option>)}
            </select>
          </div>
          <div className="field">
            <span className="wo-label">{tr('Priority')}</span>
            <div className="wo-seg" role="radiogroup" aria-label={tr('Priority')}>
              {['low', 'medium', 'high'].map((p) => (
                <button key={p} type="button" role="radio" aria-checked={form.priority === p} className={form.priority === p ? 'is-on is-' + p : ''} onClick={() => setForm({ ...form, priority: p })}>{codeLabel(p)}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="field">
          <span className="wo-label">{tr('Team members')}</span>
          <PeoplePicker employees={employees} value={form.assigneeIds} onChange={(ids) => setForm({ ...form, assigneeIds: ids })} emptyText={tr('Nobody picked: the WO is yours.')} />
        </div>
        {editing && form.teamNames ? (
          <div className="field">
            <label htmlFor="wo-teamtext">{tr('Others on the team, as written on the sheet')}</label>
            <input id="wo-teamtext" className="input" value={form.teamNames} maxLength={300} onChange={set('teamNames')} />
          </div>
        ) : null}
        <div className="wo-grid is-3">
          <div className="field">
            <label htmlFor="wo-issued">{tr('Date issued')}</label>
            <input id="wo-issued" className="input" type="date" value={form.issuedOn} onChange={set('issuedOn')} />
          </div>
          <div className="field">
            <label htmlFor="wo-due">{tr('Estimated date due')}</label>
            <input id="wo-due" className="input" type="date" value={form.dueDate} onChange={set('dueDate')} />
          </div>
          <div className="field">
            <label htmlFor="wo-project">{tr('Project')}</label>
            <select id="wo-project" className="input" value={form.projectId || ''} onChange={set('projectId')}>
              <option value="">{tr('None')}</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>
        {editing ? (
          <div className="wo-grid">
            <div className="field">
              <label htmlFor="wo-workers">{tr('Number of workers')}</label>
              <input id="wo-workers" className="input" type="number" min="0" max="500" step="1" value={form.workers} onChange={set('workers')} />
            </div>
            <div className="field">
              <label htmlFor="wo-days">{tr('Number of days worked')}</label>
              <input id="wo-days" className="input" type="number" min="0" step="0.5" value={form.workDays} onChange={set('workDays')} />
            </div>
          </div>
        ) : (
          <div className="field">
            <span className="wo-label">{tr('Start as')}</span>
            <div className="wo-seg" role="radiogroup" aria-label={tr('Start as')}>
              {['not_started', 'discussing'].map((s) => (
                <button key={s} type="button" role="radio" aria-checked={form.status === s} className={form.status === s ? 'is-on' : ''} onClick={() => setForm({ ...form, status: s })}>{woStatusLabel(s)}</button>
              ))}
            </div>
          </div>
        )}
        <div className="field">
          <label htmlFor="wo-notes">{tr('Notes (optional)')}</label>
          <textarea id="wo-notes" className="input" rows={2} value={form.description} maxLength={4000} onChange={set('description')} placeholder={tr('Anything else the team should know.')} />
        </div>
      </fieldset>
    </>
  );
}

// The body the server reads, from the form.
function payload(form, options) {
  const customers = options.customers || [];
  const cu = form.forKind === 'customer' ? customers.find((c) => c.name.toLowerCase() === form.customerText.trim().toLowerCase()) : null;
  return {
    title: form.title, description: form.description, projectId: form.projectId || null, priority: form.priority,
    assigneeIds: form.assigneeIds.length ? form.assigneeIds : undefined, issuedOn: form.issuedOn || undefined, dueDate: form.dueDate || undefined,
    forCompanyId: form.forKind === 'company' ? form.forCompanyId || null : null, customerId: cu ? cu.id : null,
    customerName: form.forKind === 'customer' && !cu ? form.customerText : '', contact: form.contact, soRef: form.soRef, itemCode: form.itemCode,
    quantity: form.quantity, specification: form.specification, materials: form.materials, materialQuantity: form.materialQuantity,
    materialSpec: form.materialSpec, process: form.process, projectManagerId: form.projectManagerId || null
  };
}

export default function WorkOrdersPage() {
  const { session, can } = useAuth();
  const canManage = can('task.manage');
  const myId = session && session.employee ? session.employee.id : null;

  // ?project=<id> (the Projects page's "See its work orders") opens
  // everything I can see, narrowed to that project.
  const projectFromUrl = new URLSearchParams(window.location.search).get('project') || '';
  const [scope, setScope] = useState(() => (projectFromUrl ? 'all' : readPref('bos.tasksScope', 'mine')));
  const [view, setView] = useState(() => readPref('bos.tasksView', 'board'));
  const [companyCode, setCompanyCode] = useState(() => readPref('bos.tasksCompany', 'ALL'));
  const [chip, setChip] = useState('active');
  const [search, setSearch] = useState('');
  const [forFilter, setForFilter] = useState('');
  const [pmFilter, setPmFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState(projectFromUrl);
  const [shownRows, setShownRows] = useState(PAGE);

  const [tasks, setTasks] = useState([]);
  const [projects, setProjects] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [options, setOptions] = useState({ companies: [], customers: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  const [detail, setDetail] = useState(null);
  const [editing, setEditing] = useState(null);
  const [commentDraft, setCommentDraft] = useState('');
  const [detailError, setDetailError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [dragId, setDragId] = useState(null);
  const [dropCol, setDropCol] = useState(null);
  // Whether the board is wider than the screen, to say so.
  const boardRef = useRef(null);
  const [boardWide, setBoardWide] = useState(false);
  useEffect(() => {
    const el = boardRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => setBoardWide(el.scrollWidth > el.clientWidth + 4);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });

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
    if (!canManage) return;
    api.get('/employees').then((list) => setEmployees(list.filter((e) => e.status !== 'terminated'))).catch(() => {});
    api.get('/tasks/options').then(setOptions).catch(() => {});
  }, [canManage]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => { setShownRows(PAGE); }, [chip, search, forFilter, pmFilter, projectFilter, companyCode, scope]);

  const companies = useMemo(() => {
    const seen = new Map();
    departments.forEach((d) => { if (!seen.has(d.companyId)) seen.set(d.companyId, { id: d.companyId, name: d.companyName, code: d.companyCode || d.companyId }); });
    return Array.from(seen.values()).sort((a, b) => (a.code === 'BPL' ? -1 : b.code === 'BPL' ? 1 : a.name.localeCompare(b.name)));
  }, [departments]);
  const currentCompany = scope === 'all' ? companies.find((c) => c.code === companyCode) || null : null;

  function pickScope(s) { setScope(s); writePref('bos.tasksScope', s); setLoading(true); }
  function pickView(v) { setView(v); writePref('bos.tasksView', v); }
  function pickCompany(code) { setCompanyCode(code); writePref('bos.tasksCompany', code); }

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

  function openNew() {
    const today = isoDay(new Date());
    const bpl = (options.companies || []).find((c) => c.code === 'BPL');
    setForm({ ...EMPTY_FORM, issuedOn: today, dueDate: addDays(today, 3), forCompanyId: bpl ? bpl.id : '' });
    setFormError(null);
    setNewOpen(true);
  }
  async function createWo(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const created = await api.post('/tasks', { ...payload(form, options), status: form.status });
      setNewOpen(false);
      setToast(tr('{no} issued.', { no: created.number }));
      await load();
      setDetail(created);
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }

  // A link like /tasks?open=<id> (a WO shared in a chat) opens that WO.
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const id = params.get('open');
    if (!id) return;
    openDetail({ id });
    setParams({}, { replace: true });
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps
  async function openDetail(t) {
    setDetailError(null);
    setEditing(null);
    setCommentDraft('');
    try { setDetail(await api.get('/tasks/' + t.id)); } catch (err) { setError(err.message); }
  }
  function startEdit() {
    const d = detail;
    setEditing({
      ...EMPTY_FORM, title: d.title, description: d.description || '', projectId: d.projectId || '', assigneeIds: d.assigneeIds.slice(), priority: d.priority,
      issuedOn: d.issuedOn || '', dueDate: d.dueDate || '', forKind: d.forCompanyId || (!d.customerId && !d.customerName) ? 'company' : 'customer',
      forCompanyId: d.forCompanyId || '', customerText: d.customerId || d.customerName ? d.customerName : '', contact: d.contact || '', soRef: d.soRef || '',
      itemCode: d.itemCode || '', quantity: d.quantity || '', specification: d.specification || '', materials: d.materials || '',
      materialQuantity: d.materialQuantity || '', materialSpec: d.materialSpec || '', process: d.process || '',
      projectManagerId: d.projectManagerId || '', pmName: d.projectManagerId ? '' : d.pmName, teamNames: d.teamNames || '',
      workers: d.workers === null || d.workers === undefined ? '' : String(d.workers), workDays: d.workDays === null || d.workDays === undefined ? '' : String(d.workDays)
    });
  }
  async function saveEdit(e) {
    e.preventDefault();
    setSaving(true);
    setDetailError(null);
    try {
      const body = { ...payload(editing, options), assigneeIds: editing.assigneeIds, workers: editing.workers === '' ? null : editing.workers, workDays: editing.workDays === '' ? null : editing.workDays };
      if (detail.teamNames) body.teamNames = editing.teamNames;
      const updated = await api.patch('/tasks/' + detail.id, body);
      setDetail(updated);
      setEditing(null);
      setToast(tr('{no} updated.', { no: updated.number }));
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
      setToast(tr('{no} deleted.', { no: deleteTarget.number }));
      if (detail && detail.id === deleteTarget.id) setDetail(null);
      setDeleteTarget(null);
      await load();
    } catch (err) { setError(err.message); } finally { setDeleting(false); }
  }
  function imported(result) {
    setImportOpen(false);
    setToast(tr('{n} work orders imported from the sheet.', { n: result.added }));
    if (scope !== 'all') pickScope('all'); else load();
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const today = isoDay(new Date());
  const weekEnd = addDays(today, 6);
  const weekAgo = addDays(today, -6);
  const recentFrom = addDays(today, -RECENT_DAYS);
  const inCompany = tasks.filter((t) => !currentCompany || (t.companyCodes || []).includes(currentCompany.code));
  const scoped = inCompany
    .filter((t) => !projectFilter || t.projectId === projectFilter)
    .filter((t) => !forFilter || forName(t) === forFilter)
    .filter((t) => !pmFilter || pmOf(t) === pmFilter);
  const open = scoped.filter(WO_OPEN);
  const overdue = open.filter((t) => t.overdue);
  const dueWeek = open.filter((t) => t.dueDate && t.dueDate >= today && t.dueDate <= weekEnd);
  const dueToday = open.filter((t) => t.dueDate === today);
  const doneWeek = scoped.filter((t) => t.status === 'completed' && t.completedAt && dayOf(t.completedAt) >= weekAgo);
  const doneWeekLate = doneWeek.filter((t) => t.onTime === false);
  const checkForMe = scoped.filter((t) => t.status === 'under_review' && (t.createdBy === myId || t.projectManagerId === myId));
  const counts = {};
  scoped.forEach((t) => { counts[t.status] = (counts[t.status] || 0) + 1; });

  const chipTest = {
    active: (t) => WO_OPEN(t) || (t.status === 'completed' && t.completedAt && dayOf(t.completedAt) >= recentFrom),
    open: WO_OPEN,
    overdue: (t) => WO_OPEN(t) && t.overdue,
    week: (t) => WO_OPEN(t) && t.dueDate && t.dueDate >= today && t.dueDate <= weekEnd,
    all: () => true
  };
  WO_STATUSES.forEach((s) => { chipTest[s] = (t) => t.status === s; });
  function showOnly(key) { setChip(chip === key ? 'active' : key); jump('wo-list'); }
  const visible = scoped
    .filter(chipTest[chip] || chipTest.active)
    .filter((t) => matchesQuery(search, t.number, t.title, forName(t), pmOf(t), t.process, t.materials, t.itemCode, t.projectName, ...(t.assigneeNames || [])));

  const tiles = [
    { icon: 'doc', value: String(open.length), label: tr('open work orders'), note: counts.awaiting_material ? tr('{n} awaiting material', { n: counts.awaiting_material }) : tr('none awaiting material'), onClick: () => showOnly('open'), active: chip === 'open' },
    { icon: 'warn', value: String(overdue.length), label: tr('overdue'), note: overdue.length ? tr('oldest {n} days late', { n: Math.max(...overdue.map((t) => t.daysOverdue || 0)) }) : tr('nothing late'), tone: overdue.length ? 'alert' : 'good', onClick: () => showOnly('overdue'), active: chip === 'overdue' },
    { icon: 'calendar', value: String(dueWeek.length), label: tr('due this week'), note: dueToday.length ? tr('{n} due today', { n: dueToday.length }) : tr('in the next 7 days'), onClick: () => showOnly('week'), active: chip === 'week' },
    { icon: 'check', value: String(doneWeek.length), label: tr('done this week'), note: doneWeek.length ? (doneWeekLate.length ? tr('{n} of them late', { n: doneWeekLate.length }) : tr('all on time')) : tr('in the last 7 days'), tone: doneWeek.length && !doneWeekLate.length ? 'good' : '', onClick: () => showOnly('completed'), active: chip === 'completed' }
  ];

  // What stands out.
  const insights = [];
  if (scope === 'all' && overdue.length) {
    const byPm = new Map();
    overdue.forEach((t) => { const n = pmOf(t); if (n) byPm.set(n, (byPm.get(n) || 0) + 1); });
    const worst = Array.from(byPm.entries()).sort((a, b) => b[1] - a[1])[0];
    if (worst && worst[1] > 1) insights.push({ tone: 'bad', icon: 'people', text: tr('{name} manages {n} overdue work orders.', { name: worst[0], n: worst[1] }), action: { label: tr('Show them'), run: () => { setPmFilter(worst[0]); setChip('overdue'); jump('wo-list'); } } });
  }
  const oldest = overdue.slice().sort((a, b) => (b.daysOverdue || 0) - (a.daysOverdue || 0))[0];
  if (oldest) insights.push({ tone: 'bad', icon: 'clock', text: tr('{no} "{title}" is {n} days overdue ({who}).', { no: oldest.number, title: oldest.title, n: oldest.daysOverdue, who: pmOf(oldest) || (oldest.assigneeNames || []).join(', ') || tr('nobody yet') }), action: { label: tr('Open'), run: () => openDetail(oldest) } });
  if (checkForMe.length) insights.push({ tone: 'warn', icon: 'check', text: checkForMe.length === 1 ? tr('{no} "{title}" is ready for you to check.', { no: checkForMe[0].number, title: checkForMe[0].title }) : tr('{n} work orders are ready for you to check.', { n: checkForMe.length }), action: { label: tr('Check'), run: () => (checkForMe.length === 1 ? openDetail(checkForMe[0]) : showOnly('under_review')) } });
  const mat = open.filter((t) => t.status === 'awaiting_material');
  if (mat.length) insights.push({ tone: 'warn', icon: 'layers', text: mat.length === 1 ? tr('{no} "{title}" is waiting for material.', { no: mat[0].number, title: mat[0].title }) : tr('{n} work orders are waiting for material.', { n: mat.length }), action: { label: tr('Show them'), run: () => showOnly('awaiting_material') } });
  const talk = open.filter((t) => t.status === 'discussing' && t.daysOpen !== null && t.daysOpen >= 7);
  if (talk.length) insights.push({ tone: 'info', icon: 'info', text: talk.length === 1 ? tr('{no} "{title}" has been under discussion for {n} days.', { no: talk[0].number, title: talk[0].title, n: talk[0].daysOpen }) : tr('{n} work orders have been under discussion for a week or more.', { n: talk.length }), action: { label: tr('Show them'), run: () => showOnly('discussing') } });
  const myToday = dueToday.filter((t) => (t.assigneeIds || []).includes(myId) || t.projectManagerId === myId);
  if (myToday.length) insights.push({ tone: 'info', icon: 'calendar', text: myToday.length === 1 ? tr('Your work order {no} "{title}" is due today.', { no: myToday[0].number, title: myToday[0].title }) : tr('You have {n} work orders due today.', { n: myToday.length }), action: { label: tr('Show them'), run: () => showOnly('week') } });
  if (doneWeek.length >= 3 && !doneWeekLate.length) insights.push({ tone: 'good', icon: 'check', text: tr('{n} work orders were completed in the last 7 days, all by their date due.', { n: doneWeek.length }) });

  const chips = [
    ['active', tr('Active'), scoped.filter(chipTest.active).length],
    ['overdue', tr('Overdue'), overdue.length],
    ['week', tr('Due this week'), dueWeek.length],
    ['discussing', woStatusLabel('discussing'), counts.discussing || 0],
    ['awaiting_material', woStatusLabel('awaiting_material'), counts.awaiting_material || 0],
    ['under_review', woStatusLabel('under_review'), counts.under_review || 0],
    ['completed', woStatusLabel('completed'), counts.completed || 0],
    ['cancelled', woStatusLabel('cancelled'), counts.cancelled || 0],
    ['all', tr('All'), scoped.length]
  ].filter(([k, , n]) => n > 0 || k === 'active' || k === chip);

  const columns = chip === 'cancelled' ? ['cancelled'] : chipTest[chip] && WO_STATUSES.includes(chip) ? [chip] : BOARD;
  const sortOpen = (a, b) => (a.overdue === b.overdue ? 0 : a.overdue ? -1 : 1)
    || ({ high: 0, medium: 1, low: 2 }[a.priority] - { high: 0, medium: 1, low: 2 }[b.priority])
    || String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999'));
  const byDone = (a, b) => String(b.completedAt || b.cancelledAt || '').localeCompare(String(a.completedAt || a.cancelledAt || ''));
  const rows = visible.slice().sort((a, b) => {
    const ra = WO_OPEN(a) ? 0 : 1, rb = WO_OPEN(b) ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return ra === 0 ? sortOpen(a, b) : byDone(a, b) || b.woNo - a.woNo;
  });

  function moveMenu(t) {
    return [
      { label: tr('Open'), onClick: () => openDetail(t) },
      ...WO_STATUSES.filter((s) => s !== t.status).map((s) => ({ label: tr('Move to {status}', { status: woStatusLabel(s) }), onClick: () => setStatus(t, s) })),
      { label: tr('Delete'), onClick: () => setDeleteTarget(t), danger: true, hidden: !canManage }
    ];
  }

  const showCompany = scope === 'all' && companies.length > 1;
  const forNames = Array.from(new Set(inCompany.map(forName).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  const pmNames = Array.from(new Set(inCompany.map(pmOf).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  const filtered = forFilter || pmFilter || projectFilter;
  const boardCols = columns.map((s) => {
    const inCol = visible.filter((t) => t.status === s).sort(s === 'completed' || s === 'cancelled' ? byDone : sortOpen);
    return { s, inCol, shown: (s === 'completed' || s === 'cancelled') && chip !== s ? inCol.slice(0, DONE_SHOWN) : inCol };
  });

  return (
    <div className="dk wo">
      {error && <div className="error-banner" role="alert">{error}</div>}

      {showCompany && (
        <CompanySwitcher companies={[{ code: 'ALL', name: tr('All companies') }, ...companies]} company={currentCompany ? currentCompany.code : 'ALL'}
          onPick={pickCompany}
          describe={(co) => {
            const n = tasks.filter((t) => WO_OPEN(t) && (co.code === 'ALL' || (t.companyCodes || []).includes(co.code))).length;
            return tr('{n} open', { n });
          }} />
      )}

      <WoBanner
        eyebrow={new Date().toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        title={scope === 'mine' ? tr('My work orders') : tr('Work orders')}
        sub={scope === 'mine'
          ? tr('The work orders you are on or manage: what is late, what is due soon and what is done. Move a WO along as the work goes, and comment to keep everyone up to date.')
          : currentCompany
            ? tr('Every work order you can see for {company}: who it is for, who is on it, what is late and how fast the work gets done. Press a number to show only those WOs.', { company: currentCompany.name })
            : tr('Every work order you can see: who it is for, who is on it, what is late and how fast the work gets done. Press a number to show only those WOs.')}
        actions={<>
          <div className="wo-seg is-hero" role="radiogroup" aria-label={tr('Show')}>
            <button type="button" role="radio" aria-checked={scope === 'mine'} className={scope === 'mine' ? 'is-on' : ''} onClick={() => pickScope('mine')}>{tr('Mine')}</button>
            <button type="button" role="radio" aria-checked={scope === 'all'} className={scope === 'all' ? 'is-on' : ''} onClick={() => pickScope('all')}>{tr('Everything I can see')}</button>
          </div>
          {canManage && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('+ New work order')}</button>}
          {canManage && <button type="button" className="btn btn-secondary" onClick={() => setImportOpen(true)}>{tr('Import from the sheet')}</button>}
        </>}
        tiles={tiles} />

      <Pipeline counts={counts} active={chip} onPick={(s) => showOnly(s)}
        doneLabel={doneWeek.length ? tr('{n} this week', { n: doneWeek.length }) : ''} />

      {filtered && (
        <div className="wo-filtered" role="status">
          <span>{tr('Showing only:')}</span>
          {forFilter && <button type="button" className="wo-filter-chip" onClick={() => setForFilter('')}>{tr('for {name}', { name: forFilter })} ×</button>}
          {pmFilter && <button type="button" className="wo-filter-chip" onClick={() => setPmFilter('')}>{tr('managed by {name}', { name: pmFilter })} ×</button>}
          {projectFilter && <button type="button" className="wo-filter-chip" onClick={() => setProjectFilter('')}>{(projects.find((p) => p.id === projectFilter) || {}).name || tr('one project')} ×</button>}
        </div>
      )}

      <Insights items={insights.slice(0, 6)} />

      {scoped.length > 0 && (
        <div className="wo-panels">
          <section className="wo-panel">
            <PanelHead icon="for" title={tr('Who the work is for')} sub={tr('Work orders by who asked for them — our own companies and customers — with how many are still open. Press one to show only theirs.')} />
            <ForWhom wos={scoped} active={forFilter} onPick={(n) => { setForFilter(forFilter === n ? '' : n); jump('wo-list'); }} />
          </section>
          <section className="wo-panel">
            <PanelHead icon="pm" title={tr('Project managers')} sub={tr('Open work orders each project manager has, how many are late, and what they finished in the last 30 days. Press one to show only theirs.')} />
            <Managers wos={scoped} today={today} active={pmFilter} onPick={(n) => { setPmFilter(pmFilter === n ? '' : n); jump('wo-list'); }} />
          </section>
          <section className="wo-panel">
            <PanelHead icon="week" title={tr('Finished each week')} sub={tr('Work orders completed each week for the last 12 weeks: on time means by the estimated date due. Point at a week for its numbers.')} />
            <Weekly wos={scoped} today={today} />
          </section>
          <section className="wo-panel">
            <PanelHead icon="speed" title={tr('How long the work takes')} sub={tr('Days from the date issued to completed, for the work orders completed in the last 90 days.')} />
            <Speed wos={scoped} today={today} />
          </section>
        </div>
      )}

      <Section id="wo-list" title={view === 'board' ? tr('Board') : tr('Register')}
        sub={view === 'board' ? tr('A column per status, in the order a WO moves. Drag a card to move it, or use its ⋮ menu.') : tr('Every WO as a row, like the sheet: late ones first, then by priority and date due; finished ones after, newest first.')}
        action={
          <div className="ppl-view" role="radiogroup" aria-label={tr('Show as')}>
            <button type="button" role="radio" aria-checked={view === 'board'} className={view === 'board' ? 'is-on' : ''} onClick={() => pickView('board')} title={tr('Board')} aria-label={tr('Board')}>
              <svg className="dk-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><rect x="3.5" y="4" width="5" height="16" rx="1.2" /><rect x="10" y="4" width="5" height="11" rx="1.2" /><rect x="16.5" y="4" width="4" height="7" rx="1.2" /></svg>
            </button>
            <button type="button" role="radio" aria-checked={view === 'list'} className={view === 'list' ? 'is-on' : ''} onClick={() => pickView('list')} title={tr('Register')} aria-label={tr('Register')}>
              <svg className="dk-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="1.5" /><path d="M3.5 9.5h17M3.5 14.5h17M9 4.5v15" /></svg>
            </button>
          </div>
        }>
        <div className="wo-tools">
          <div className="wo-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search WO number, description, customer, people…')} /></div>
          {forNames.length > 1 && (
            <select className="input wo-select" value={forFilter} onChange={(e) => setForFilter(e.target.value)} aria-label={tr('Filter by who it is for')}>
              <option value="">{tr('Everyone it is for')}</option>
              {forNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          )}
          {pmNames.length > 1 && (
            <select className="input wo-select" value={pmFilter} onChange={(e) => setPmFilter(e.target.value)} aria-label={tr('Filter by project manager')}>
              <option value="">{tr('All project managers')}</option>
              {pmNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          )}
          {projects.length > 0 && (
            <select className="input wo-select" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} aria-label={tr('Filter by project')}>
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
          <div className="dk-empty wo-empty">
            <p>{scoped.length ? tr('No work orders match. Try another search or filter.') : scope === 'mine' ? tr('Nothing on your plate. Work orders you are on or manage will show here.') : tr('No work orders yet.')}</p>
            {(search || chip !== 'active' || filtered) && scoped.length > 0 && <button type="button" className="btn btn-secondary" onClick={() => { setSearch(''); setChip('active'); setForFilter(''); setPmFilter(''); setProjectFilter(''); }}>{tr('Clear filters')}</button>}
            {canManage && !tasks.length && <div className="wo-empty-actions"><button type="button" className="btn btn-primary" onClick={openNew}>{tr('+ New work order')}</button><button type="button" className="btn btn-secondary" onClick={() => setImportOpen(true)}>{tr('Import from the sheet')}</button></div>}
          </div>
        ) : view === 'board' ? (
          <>
          {boardWide && <p className="wo-wide-hint">{tr('Scroll sideways to see every column')} →</p>}
          <div className="wo-board" ref={boardRef} style={{ gridTemplateColumns: boardCols.map((c) => (c.inCol.length || columns.length === 1 ? 'minmax(210px, 1fr)' : '58px')).join(' ') }}>
            {boardCols.map(({ s, inCol, shown }) => (
              <div key={s} className={'wo-col-b is-' + s + (dropCol === s ? ' is-drop' : '') + (!inCol.length && columns.length > 1 ? ' is-empty' : '')}
                onDragOver={(e) => { if (dragId) { e.preventDefault(); setDropCol(s); } }}
                onDragLeave={(e) => { if (e.currentTarget === e.target) setDropCol(null); }}
                onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData('text/plain') || dragId; const t = tasks.find((x) => x.id === id); setDropCol(null); setDragId(null); if (t) setStatus(t, s); }}>
                <header className="wo-col-head">
                  <span className="wo-col-dot" aria-hidden="true" />
                  <strong>{woStatusLabel(s)}</strong>
                  <span className="wo-col-n">{inCol.length}</span>
                </header>
                <div className="wo-col-body">
                  {shown.map((t) => (
                    <WoCard key={t.id} t={t} today={today} onOpen={() => openDetail(t)} menu={moveMenu(t)} dragging={dragId === t.id}
                      onDragStart={(e) => { setDragId(t.id); e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; }}
                      onDragEnd={() => { setDragId(null); setDropCol(null); }} />
                  ))}
                  {shown.length < inCol.length && <button type="button" className="dk-link wo-more" onClick={() => showOnly(s)}>{tr('Show all {n}', { n: inCol.length })}</button>}
                </div>
              </div>
            ))}
          </div>
          </>
        ) : (
          <>
            <div className="wo-register-wrap">
              <table className="wo-register">
                <thead>
                  <tr>
                    <th>{tr('WO')}</th><th>{tr('Issued')}</th><th>{tr('For')}</th><th>{tr('Description')}</th><th>{tr('Qty')}</th>
                    <th>{tr('Project manager')}</th><th>{tr('Team')}</th><th>{tr('Due')}</th><th>{tr('Status')}</th><th>{tr('Closed')}</th><th className="is-num">{tr('Days')}</th><th aria-label={tr('Actions')} />
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, shownRows).map((t) => {
                    const due = dueInfo(t, today);
                    const closed = t.completedAt || t.cancelledAt;
                    return (
                      <tr key={t.id} className={(t.overdue ? 'is-overdue' : '') + (WO_OPEN(t) ? '' : ' is-closed')}>
                        <td><button type="button" className="wo-no is-link" onClick={() => openDetail(t)}>{t.number}</button></td>
                        <td className="is-date">{t.issuedOn ? shortDate(t.issuedOn) : '—'}</td>
                        <td className="is-for" title={forName(t)}>{forName(t) || <span className="dk-muted">—</span>}</td>
                        <td className="is-title"><button type="button" className="wo-row-title" onClick={() => openDetail(t)}>{t.title}</button></td>
                        <td>{t.quantity || '—'}</td>
                        <td className="is-pm" title={pmOf(t)}>{pmOf(t) || <span className="dk-muted">—</span>}</td>
                        <td><Faces2 t={t} /></td>
                        <td className="is-date"><span className={'wo-due is-' + (WO_OPEN(t) ? due.tone || 'plain' : 'plain')}>{t.dueDate ? shortDate(t.dueDate) : '—'}</span></td>
                        <td>
                          <select className={'input wo-status-select is-' + t.status} value={t.status} onChange={(e) => setStatus(t, e.target.value)} aria-label={tr('Status of {no}', { no: t.number })}>
                            {WO_STATUSES.map((s) => <option key={s} value={s}>{woStatusLabel(s)}</option>)}
                          </select>
                        </td>
                        <td className="is-date">{closed ? shortDate(dayOf(closed)) : '—'}</td>
                        <td className="is-num">{t.daysToClose !== null ? <span className={t.onTime === false ? 'wo-late-n' : ''} title={t.onTime === false ? tr('Finished after the date due') : ''}>{t.daysToClose}</span> : t.daysOpen !== null ? <span className="dk-muted" title={tr('Open for {n} days so far', { n: t.daysOpen })}>{tr('{n} so far', { n: t.daysOpen })}</span> : '—'}</td>
                        <td><RowMenu actions={[{ label: tr('Open'), onClick: () => openDetail(t) }, { label: tr('Delete'), onClick: () => setDeleteTarget(t), danger: true, hidden: !canManage }]} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {rows.length > shownRows && <button type="button" className="btn btn-secondary wo-more-rows" onClick={() => setShownRows(shownRows + PAGE * 2)}>{tr('Show {n} more of {total}', { n: Math.min(PAGE * 2, rows.length - shownRows), total: rows.length })}</button>}
          </>
        )}
      </Section>

      <Glossary items={[
        [woStatusLabel('discussing'), tr('Still being talked over with whoever asked (the sheet’s “Discussing” and “Awaiting WO”). Nothing is made yet.')],
        [woStatusLabel('not_started'), tr('The WO is issued to the team; work has not begun.')],
        [woStatusLabel('in_progress'), tr('The team is working on it.')],
        [woStatusLabel('awaiting_material'), tr('Work waits for material to arrive or be released from stock.')],
        [woStatusLabel('waiting'), tr('Stopped for now, for another reason. Say why in a comment.')],
        [woStatusLabel('under_review'), tr('Done by the team, waiting for whoever issued it or the project manager to check. Both get a notification.')],
        [woStatusLabel('completed'), tr('Finished. The day it was completed is kept, for the days it took and whether it was on time.')],
        [tr('Days to close'), tr('From the date issued to the day it was completed, as the sheet counted it. Open WOs show the days so far.')],
        [tr('On time'), tr('Completed on or before the estimated date due.')],
        [tr('Active'), tr('Open work orders, and those completed in the last 14 days.')]
      ]} />

      {newOpen && (
        <div className="dialog-backdrop" onClick={() => setNewOpen(false)}>
          <form className="dialog wo-dialog" onClick={(e) => e.stopPropagation()} onSubmit={createWo}>
            <h2>{tr('New work order')}</h2>
            <p className="dk-muted wo-small">{tr('The same questions as the WO form. Only the description is needed; fill in what you know, and the rest can be added later.')}</p>
            <WoForm form={form} setForm={setForm} projects={projects} employees={employees} options={options} />
            <p className="dk-muted wo-small">{tr('Everyone you add, and the project manager, gets a notification. The WO gets the next number.')}</p>
            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setNewOpen(false)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Issue work order')}</button>
            </div>
          </form>
        </div>
      )}

      {importOpen && <WoImport employees={employees} onClose={() => setImportOpen(false)} onDone={imported} />}

      {detail && (
        <div className="dialog-backdrop wo-print-root" onClick={() => setDetail(null)}>
          <div className="dialog wo-dialog wo-sheet" onClick={(e) => e.stopPropagation()}>
            {detailError && <div className="error-banner">{detailError}</div>}
            {editing ? (
              <form onSubmit={saveEdit} className="wo-edit">
                <h2>{tr('Edit {no}', { no: detail.number })}</h2>
                <WoForm form={editing} setForm={setEditing} projects={projects} employees={employees} options={options} editing />
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>{tr('Cancel')}</button>
                  <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Save changes')}</button>
                </div>
              </form>
            ) : (
              <WoSheet d={detail} today={today} myId={myId} canManage={canManage} onClose={() => setDetail(null)} onStatus={(s) => setStatus(detail, s)}
                onEdit={startEdit} onDelete={() => setDeleteTarget(detail)} commentDraft={commentDraft} setCommentDraft={setCommentDraft} postComment={postComment} />
            )}
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Delete {no}', { no: deleteTarget.number })}</h2>
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

// The team in a register row: faces, then names kept from the sheet.
function Faces2({ t }) {
  const people = t.assignees || [];
  if (!people.length && !t.teamNames) return <span className="dk-muted">—</span>;
  // Names kept from the sheet count in the "+n"; the tooltip lists everyone.
  const named = t.teamNames ? t.teamNames.split(',').filter((x) => x.trim()).length : 0;
  return (
    <span className="wo-faces" title={people.map((p) => p.name).concat(t.teamNames ? [t.teamNames] : []).join(', ')}>
      {people.slice(0, 3).map((p) => <Photo key={p.id} id={p.id} name={p.name} photo={p.photo} size={22} />)}
      {people.length - Math.min(3, people.length) + named > 0 && <span className="wo-faces-more">+{people.length - Math.min(3, people.length) + named}</span>}
    </span>
  );
}

// A WO opened: its sheet, as the workshop knows it.
function WoSheet({ d, today, myId, canManage, onClose, onStatus, onEdit, onDelete, commentDraft, setCommentDraft, postComment }) {
  const due = dueInfo(d, today);
  const closedDay = d.completedAt ? dayOf(d.completedAt) : d.cancelledAt ? dayOf(d.cancelledAt) : null;
  const facts = (rows) => rows.filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== false);
  const request = facts([
    [tr('For'), forName(d) ? <>{forName(d)}{d.forCompanyCode && <span className="wo-ours">{tr('ours')}</span>}</> : null],
    [tr('Contact'), d.contact],
    [tr('Sales order'), d.soRef ? <>{d.soRef}{d.salesOrderId && <span className="wo-linked">{tr('in the OS')}</span>}</> : null],
    [tr('Item number'), d.itemCode ? <>{d.itemCode}{d.product && <span className="dk-muted"> — {d.product.name}</span>}</> : null],
    [tr('Quantity'), d.quantity],
    [tr('Project'), d.projectName !== '—' ? d.projectName : null]
  ]);
  const work = facts([
    [tr('Specification'), d.specification ? <Linked text={d.specification} /> : null],
    [tr('Material needed'), d.materials],
    [tr('Material quantity'), d.materialQuantity],
    [tr('Material specification'), d.materialSpec],
    [tr('Process'), d.process ? <ProcessSteps text={d.process} /> : null]
  ]);
  const timing = facts([
    [tr('Date issued'), d.issuedOn ? fmtDate(d.issuedOn) : null],
    [tr('Estimated date due'), d.dueDate ? <>{fmtDate(d.dueDate)}{d.plannedDays !== null && d.plannedDays >= 0 && <span className="dk-muted"> · {d.plannedDays === 1 ? tr('1 day planned') : tr('{n} days planned', { n: d.plannedDays })}</span>}</> : null],
    [d.status === 'cancelled' ? tr('Cancelled') : tr('Completed'), closedDay ? fmtDate(closedDay) : null],
    [tr('Days to close'), d.daysToClose !== null ? <>{d.daysToClose} {d.onTime === true && <Status tone="good">{tr('On time')}</Status>}{d.onTime === false && <Status tone="warn">{tr('Late')}</Status>}</> : d.daysOpen !== null ? tr('{n} so far', { n: d.daysOpen }) : null],
    [tr('Labour'), d.workers || d.workDays ? tr('{w} workers × {d} days', { w: d.workers || '—', d: d.workDays || '—' }) : null]
  ]);

  return (
    <>
      <header className="wo-sheet-head">
        <div className="wo-sheet-id">
          <span className="wo-no is-big">{d.number}</span>
          <StatusPill status={d.status} />
          {d.priority === 'high' && <span className="wo-hot">{codeLabel('high')}</span>}
          {d.imported && <span className="wo-from-sheet">{tr('from the sheet')}</span>}
        </div>
        <h2>{d.title}</h2>
        <span className="dk-muted">{[d.createdByName ? tr('prepared by {name}', { name: d.createdByName }) : null, tr('issued {date}', { date: fmtDate(d.issuedOn) })].filter(Boolean).join(' · ')}{(due.tone === 'bad' || due.tone === 'warn') && WO_OPEN(d) ? <> · <Status tone={due.tone}>{due.text}</Status></> : null}</span>
        <button type="button" className="wo-close" onClick={onClose} aria-label={tr('Close')}>×</button>
      </header>

      <div className="wo-steps" role="radiogroup" aria-label={tr('Status')}>
        {WO_STATUSES.map((s) => (
          <button key={s} type="button" role="radio" aria-checked={d.status === s} className={'wo-step is-' + s + (d.status === s ? ' is-on' : '')} onClick={() => onStatus(s)}>
            {woStatusLabel(s)}
          </button>
        ))}
      </div>

      <div className="wo-sheet-grid">
        {request.length > 0 && <dl className="wo-facts"><h4>{tr('The request')}</h4>{request.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
        <dl className="wo-facts">
          <h4>{tr('People')}</h4>
          <div><dt>{tr('Project manager')}</dt><dd>{d.projectManager ? <span className="wo-person"><Photo id={d.projectManager.id} name={d.projectManager.name} photo={d.projectManager.photo} size={26} />{d.projectManager.name}</span> : d.pmName || <span className="dk-muted">{tr('None')}</span>}</dd></div>
          <div><dt>{tr('Team')}</dt><dd className="wo-people">{d.assignees.map((a) => <span key={a.id} className="wo-person"><Photo id={a.id} name={a.name} photo={a.photo} size={26} />{a.name}</span>)}{d.teamNames && <span className="wo-person is-text">{d.teamNames}</span>}{!d.assignees.length && !d.teamNames && <span className="dk-muted">{tr('Nobody yet')}</span>}</dd></div>
          <div><dt>{tr('Prepared by')}</dt><dd>{d.createdByName}</dd></div>
        </dl>
        {work.length > 0 && <dl className="wo-facts is-wide"><h4>{tr('Work, materials and process')}</h4>{work.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
        <dl className="wo-facts is-wide"><h4>{tr('Dates and timing')}</h4>{timing.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      </div>
      {d.description ? <p className="wo-desc">{d.description}</p> : null}

      <div className="wo-detail-actions">
        {canManage && <button type="button" className="btn btn-secondary" onClick={onEdit}>{tr('Edit')}</button>}
        <button type="button" className="btn btn-secondary" onClick={() => window.print()}>{tr('Print')}</button>
        {canManage && <button type="button" className="btn btn-secondary" onClick={onDelete}>{tr('Delete')}</button>}
      </div>

      <section className="wo-thread">
        <h3>{tr('Comments')} <span className="dk-muted">{d.comments.length}</span></h3>
        {d.comments.length ? (
          <ul className="wo-comments-list">
            {d.comments.map((c) => (
              <li key={c.id} className={c.authorId === myId ? 'is-mine' : ''}>
                <Photo id={c.authorId} name={c.authorName} photo={c.authorPhoto} size={30} />
                <div className="wo-comment">
                  <div className="wo-comment-head"><strong>{c.authorId === myId ? tr('You') : c.authorName}</strong><span className="dk-muted">{ago(c.at)}</span></div>
                  <p>{c.body}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="dk-muted wo-small">{tr('No comments yet. Ask a question or post an update; the team, the project manager and whoever issued it are notified.')}</p>}
        <form className="wo-compose" onSubmit={postComment}>
          <textarea className="input" rows={2} value={commentDraft} onChange={(e) => setCommentDraft(e.target.value)} maxLength={1000}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); postComment(); } }}
            placeholder={tr('Write a comment…')} aria-label={tr('Comment')} />
          <button className="btn btn-primary" type="submit" disabled={!commentDraft.trim()}>{tr('Post')}</button>
        </form>
      </section>
    </>
  );
}
