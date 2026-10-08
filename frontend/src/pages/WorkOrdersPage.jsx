import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Confetti, DaysChip, ForBadge, ForWhom, Linked, Managers, MiniTimeline, NEXT, PanelHead, Pipeline, ProcessSteps, Speed, StatusGlyph, StatusPill, StatusSelect, Weekly, WoBanner, WoCard, WoImport, WoManagerDialog, colHint, downloadCsv,
  addDays, dueInfo, forName, isoDay, pmOf
} from './WorkOrdersFun.jsx';
import WorkOrdersPresent from './WorkOrdersPresent';
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
const NO_PROJECT = '__none__';
const EMPTY_FORM = {
  title: '', description: '', projectId: '', assigneeIds: [], priority: 'medium', issuedOn: '', dueDate: '', status: 'not_started',
  forKind: 'company', forCompanyId: '', customerText: '', contact: '', soRef: '', itemCode: '', quantity: '', specification: '',
  materials: '', materialQuantity: '', materialSpec: '', process: '', projectManagerId: '', workers: '', workDays: '', teamNames: ''
};

// What a change to a WO did to its project, if anything: a project set to
// close itself closes when its last work order is done and reopens when one
// is open again (projects.service.js syncClosing).
function projectNote(changes) {
  const c = (changes || [])[0];
  if (!c) return null;
  const project = c.code + ' — ' + c.name;
  return c.change === 'closed'
    ? tr('{project} is complete: all its work orders are done, so it has closed itself.', { project })
    : tr('{project} has reopened: one of its work orders is open again.', { project });
}
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

// A new WO for a project starts with what the project already says: who it
// is for, its owner as project manager and its members as the team —
// filling only what is still blank (and "who it is for" only until it is
// changed by hand).
function fillFromProject(form, project, staffIds) {
  if (!project) return { ...form, projectId: '', filled: null };
  const next = { ...form, projectId: project.id };
  const what = [];
  if (!form.forTouched && (project.forCompanyId || project.customerName)) {
    Object.assign(next, project.forCompanyId
      ? { forKind: 'company', forCompanyId: project.forCompanyId, customerText: '' }
      : { forKind: 'customer', forCompanyId: '', customerText: project.customerName });
    what.push(tr('who it is for'));
  }
  if (!form.projectManagerId && project.ownerId && staffIds.has(project.ownerId)) { next.projectManagerId = project.ownerId; what.push(tr('the project manager')); }
  if (!form.assigneeIds.length) {
    const team = (project.memberIds || []).filter((id) => staffIds.has(id));
    if (team.length) { next.assigneeIds = team; what.push(tr('the team')); }
  }
  next.filled = what.length ? { project: project.name, what } : null;
  return next;
}

function WoForm({ form, setForm, projects, employees, options, editing }) {
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const setFor = (k) => (e) => setForm({ ...form, [k]: e.target.value, forTouched: true });
  const staffIds = new Set(employees.map((e) => e.id));
  const companies = options.companies || [];
  return (
    <>
      {form.filled && <p className="wo-filled">{tr('Filled in from the project {project}: {what}. Change anything that differs.', { project: form.filled.project, what: form.filled.what.join(', ') })}</p>}
      <fieldset className="wo-fs">
        <legend><b>1</b>{tr('The request')}</legend>
        <div className="field">
          <span className="wo-label">{tr('Who it is for')}</span>
          <div className="wo-seg" role="radiogroup" aria-label={tr('Who it is for')}>
            {[['company', tr('One of our companies')], ['customer', tr('A customer')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={form.forKind === k} className={form.forKind === k ? 'is-on' : ''} onClick={() => setForm({ ...form, forKind: k, forTouched: true })}>{label}</button>
            ))}
          </div>
        </div>
        <div className="wo-grid">
          {form.forKind === 'company' ? (
            <div className="field">
              <label htmlFor="wo-for-co">{tr('Company')}</label>
              <select id="wo-for-co" className="input" value={form.forCompanyId} onChange={setFor('forCompanyId')}>
                <option value="">{tr('Not said')}</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          ) : (
            <div className="field">
              <label htmlFor="wo-for-cu">{tr('Customer')}</label>
              <input id="wo-for-cu" className="input" list="wo-customers" value={form.customerText} maxLength={120} onChange={setFor('customerText')} placeholder={tr('Pick or type a name')} />
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
            <select id="wo-project" className="input" value={form.projectId || ''} onChange={(e) => (editing ? setForm({ ...form, projectId: e.target.value }) : setForm(fillFromProject(form, projects.find((p) => p.id === e.target.value), staffIds)))}>
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
  // The register's order: its usual one (late, then open, then finished), or by a column.
  const [regSort, setRegSort] = useState(null);
  // Work orders ticked in the register, to put into a project together.
  const [picked, setPicked] = useState(() => new Set());
  const [pickProject, setPickProject] = useState('');
  const [moving, setMoving] = useState(false);

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
  const [presenting, setPresenting] = useState(false);
  const [pmDialog, setPmDialog] = useState(null); // { wos, remember }
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  const [detail, setDetail] = useState(null);
  // A WO being fetched: its window shows at once, with any error in it.
  const [opening, setOpening] = useState(null);
  const openingId = useRef(null);
  const [editing, setEditing] = useState(null);
  const [commentDraft, setCommentDraft] = useState('');
  const [detailError, setDetailError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [dragId, setDragId] = useState(null);
  const [dropCol, setDropCol] = useState(null);
  // The last WO completed here, for a burst of confetti over its column.
  const [cheer, setCheer] = useState(null);
  useEffect(() => {
    if (!cheer) return undefined;
    const t = setTimeout(() => setCheer(null), 2200);
    return () => clearTimeout(t);
  }, [cheer]);
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
  useEffect(() => { setShownRows(PAGE); setPicked(new Set()); }, [chip, search, forFilter, pmFilter, projectFilter, companyCode, scope, view]);

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
    if (status === 'completed') setCheer({ id: task.id, at: Date.now() });
    // Move it at once; the reload below confirms it.
    setTasks((list) => list.map((t) => (t.id === task.id ? { ...t, status, completedAt: status === 'completed' ? new Date().toISOString() : null } : t)));
    try {
      const updated = await api.post('/tasks/' + task.id + '/status', { status });
      if (detail && detail.id === task.id) setDetail(updated);
      const note = projectNote(updated.projectChanges);
      if (note) setToast(note);
      await load();
    } catch (err) {
      // Said where they are looking, not only in the banner at the top.
      setError(err.message);
      setToast(err.message);
      if (detail && detail.id === task.id) setDetailError(err.message);
      await load();
    }
  }

  function openNew(project) {
    const today = isoDay(new Date());
    const bpl = (options.companies || []).find((c) => c.code === 'BPL');
    const base = { ...EMPTY_FORM, issuedOn: today, dueDate: addDays(today, 3), forCompanyId: bpl ? bpl.id : '' };
    setForm(project ? fillFromProject(base, project, new Set(employees.map((e) => e.id))) : base);
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
      setToast(projectNote(created.projectChanges) || tr('{no} issued.', { no: created.number }));
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
  // /tasks?project=<id>&new=1 (a project's "+ Work order") opens a new WO
  // for that project, once the people to fill it in with have loaded.
  const newFromUrl = useRef(params.get('new') === '1');
  useEffect(() => {
    if (!newFromUrl.current || loading || !canManage || !employees.length) return;
    newFromUrl.current = false;
    const pid = params.get('project');
    openNew(projects.find((p) => p.id === pid) || null);
    setParams(pid ? { project: pid } : {}, { replace: true });
  }, [loading, employees, projects, canManage]); // eslint-disable-line react-hooks/exhaustive-deps
  async function openDetail(t) {
    setDetailError(null);
    setEditing(null);
    setCommentDraft('');
    setDetail(null);
    openingId.current = t.id;
    setOpening({ t, error: null });
    try {
      const d = await api.get('/tasks/' + t.id);
      if (openingId.current !== t.id) return;
      setDetail(d); setOpening(null);
    } catch (err) {
      if (openingId.current === t.id) setOpening({ t, error: err.message || tr('Could not open this work order.') });
    }
  }
  function closeOpening() { openingId.current = null; setOpening(null); }
  // A click anywhere on a row or card opens it, but not on its own controls.
  function openFromRow(e, t) {
    if (e.target.closest('button, a, input, select, label, textarea')) return;
    openDetail(t);
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
      setToast(projectNote(updated.projectChanges) || tr('{no} updated.', { no: updated.number }));
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
      const gone = await api.del('/tasks/' + deleteTarget.id);
      setToast(projectNote(gone && gone.projectChanges) || tr('{no} deleted.', { no: deleteTarget.number }));
      if (detail && detail.id === deleteTarget.id) setDetail(null);
      setDeleteTarget(null);
      await load();
    } catch (err) { setError(err.message); } finally { setDeleting(false); }
  }
  function togglePick(id) { setPicked((was) => { const s = new Set(was); if (s.has(id)) s.delete(id); else s.add(id); return s; }); }
  async function moveToProject(projectId) {
    setMoving(true);
    setError(null);
    try {
      const r = await api.post('/tasks/project', { ids: Array.from(picked), projectId });
      const moved = r.project ? tr('{n} work orders added to {project}.', { n: r.updated, project: r.project.code + ' — ' + r.project.name }) : tr('{n} work orders taken out of their project.', { n: r.updated });
      const note = projectNote(r.projectChanges);
      setToast(note ? moved + ' ' + note : moved);
      setPicked(new Set());
      setPickProject('');
      await load();
    } catch (err) { setError(err.message); } finally { setMoving(false); }
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
    .filter((t) => !projectFilter || (projectFilter === NO_PROJECT ? !t.projectId : t.projectId === projectFilter))
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

  const SORTS = {
    wo: (t) => t.woNo, title: (t) => t.title.toLowerCase(), for: (t) => forName(t).toLowerCase(), qty: (t) => parseFloat(String(t.quantity).replace(',', '.')) || 0,
    due: (t) => t.dueDate || '9999', status: (t) => WO_STATUSES.indexOf(t.status), days: (t) => (t.daysToClose !== null ? t.daysToClose : t.daysOpen !== null ? t.daysOpen : -1)
  };
  const sortedRows = regSort ? rows.slice().sort((a, b) => {
    const x = SORTS[regSort.key](a), y = SORTS[regSort.key](b);
    return (x < y ? -1 : x > y ? 1 : 0) * (regSort.dir === 'desc' ? -1 : 1) || b.woNo - a.woNo;
  }) : rows;
  const pageRows = sortedRows.slice(0, shownRows);
  // Without a column picked, the register reads in three parts.
  const regGroups = regSort ? [{ key: 'all', rows: pageRows }] : [
    { key: 'late', label: tr('Late'), n: rows.filter((t) => WO_OPEN(t) && t.overdue).length, rows: pageRows.filter((t) => WO_OPEN(t) && t.overdue) },
    { key: 'open', label: tr('Open'), n: rows.filter((t) => WO_OPEN(t) && !t.overdue).length, rows: pageRows.filter((t) => WO_OPEN(t) && !t.overdue) },
    { key: 'done', label: tr('Finished'), n: rows.filter((t) => !WO_OPEN(t)).length, rows: pageRows.filter((t) => !WO_OPEN(t)) }
  ].filter((g) => g.rows.length);
  function sortBy(key) {
    setRegSort((was) => (!was || was.key !== key ? { key, dir: key === 'due' || key === 'title' || key === 'for' ? 'asc' : 'desc' } : was.dir === 'desc' ? { key, dir: 'asc' } : null));
  }
  function sortBtn(k, children) {
    const on = regSort && regSort.key === k;
    return <button key={k} type="button" className={'wo-sort' + (on ? ' is-on' : '')} onClick={() => sortBy(k)}>{children}<span aria-hidden="true">{on ? (regSort.dir === 'asc' ? '▲' : '▼') : '↕'}</span></button>;
  }
  // A header that sorts by one or more columns: [[key, label], …].
  function sortTh(keys, className) {
    const on = keys.find(([k]) => regSort && regSort.key === k);
    return (
      <th key={keys[0][0]} className={(className || '') + (on ? ' is-sorted' : '')} aria-sort={on ? (regSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        {keys.length > 1 ? <span className="wo-sorts">{keys.map(([k, label]) => sortBtn(k, label))}</span> : sortBtn(keys[0][0], keys[0][1])}
      </th>
    );
  }

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
          {canManage && <button type="button" className="btn btn-primary" onClick={() => openNew()}>{tr('+ New work order')}</button>}
          {canManage && <button type="button" className="btn btn-secondary" onClick={() => setImportOpen(true)}>{tr('Import from the sheet')}</button>}
          <button type="button" className="btn btn-secondary wo-present-btn" onClick={() => setPresenting(true)} title={tr('This week’s completed and pending work orders as slides, for the Saturday meeting')}>
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" /></svg>
            {tr('Saturday review')}
          </button>
        </>}
        tiles={tiles} />

      <Pipeline counts={counts} active={chip} onPick={(s) => showOnly(s)}
        doneLabel={doneWeek.length ? tr('{n} this week', { n: doneWeek.length }) : ''} />

      {filtered && (
        <div className="wo-filtered" role="status">
          <span>{tr('Showing only:')}</span>
          {forFilter && <button type="button" className="wo-filter-chip" onClick={() => setForFilter('')}>{tr('for {name}', { name: forFilter })} ×</button>}
          {pmFilter && <button type="button" className="wo-filter-chip" onClick={() => setPmFilter('')}>{tr('managed by {name}', { name: pmFilter })} ×</button>}
          {pmFilter && canManage && (() => {
            const theirs = tasks.filter((t) => pmOf(t) === pmFilter);
            return theirs.length ? <button type="button" className="dk-link" onClick={() => setPmDialog({ wos: theirs, remember: true })}>{theirs.length === 1 ? tr('Wrong person? Give it to another project manager') : tr('Wrong person? Give all {n} to another project manager', { n: theirs.length })}</button> : null;
          })()}
          {projectFilter && <button type="button" className="wo-filter-chip" onClick={() => setProjectFilter('')}>{projectFilter === NO_PROJECT ? tr('no project') : (projects.find((p) => p.id === projectFilter) || {}).name || tr('one project')} ×</button>}
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
              <option value={NO_PROJECT}>{tr('No project')}</option>
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
            {canManage && !tasks.length && <div className="wo-empty-actions"><button type="button" className="btn btn-primary" onClick={() => openNew()}>{tr('+ New work order')}</button><button type="button" className="btn btn-secondary" onClick={() => setImportOpen(true)}>{tr('Import from the sheet')}</button></div>}
          </div>
        ) : view === 'board' ? (
          <>
          {boardWide && <p className="wo-wide-hint">{tr('Scroll sideways to see every column')} →</p>}
          <div className="wo-board" ref={boardRef} style={{ gridTemplateColumns: boardCols.map((c) => (c.inCol.length || columns.length === 1 ? 'minmax(236px, 1fr)' : '58px')).join(' ') }}>
            {boardCols.map(({ s, inCol, shown }) => (
              <div key={s} className={'wo-col-b is-' + s + (dropCol === s ? ' is-drop' : '') + (!inCol.length && columns.length > 1 ? ' is-empty' : '')}
                onDragOver={(e) => { if (dragId) { e.preventDefault(); setDropCol(s); } }}
                onDragLeave={(e) => { if (e.currentTarget === e.target) setDropCol(null); }}
                onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData('text/plain') || dragId; const t = tasks.find((x) => x.id === id); setDropCol(null); setDragId(null); if (t) setStatus(t, s); }}>
                <header className="wo-col-head">
                  <span className="wo-col-icon" aria-hidden="true"><StatusGlyph status={s} /></span>
                  <span className="wo-col-titles"><strong>{woStatusLabel(s)}</strong><small>{colHint(s)}</small></span>
                  <span className="wo-col-n">{inCol.length}</span>
                  {s === 'completed' && cheer && <Confetti key={cheer.at} />}
                </header>
                {(() => {
                  const late = inCol.filter((t) => t.overdue).length;
                  const soonDue = inCol.filter((t) => WO_OPEN(t) && !t.overdue && t.dueDate && t.dueDate <= weekEnd).length;
                  const doneNow = s === 'completed' ? inCol.filter((t) => t.completedAt && dayOf(t.completedAt) >= weekAgo).length : 0;
                  const bits = s === 'completed'
                    ? [doneNow ? <span key="w" className="wo-col-chip is-good">{tr('{n} this week', { n: doneNow })}</span> : null]
                    : [late ? <span key="l" className="wo-col-chip is-bad">{tr('{n} late', { n: late })}</span> : null, soonDue ? <span key="s" className="wo-col-chip is-warn">{tr('{n} due this week', { n: soonDue })}</span> : null];
                  return inCol.length && bits.some(Boolean) ? <div className="wo-col-meta">{bits}</div> : null;
                })()}
                <div className="wo-col-body">
                  {dragId && dropCol === s && !inCol.some((t) => t.id === dragId) && <div className="wo-drop-here">{tr('Drop here to move it to {status}', { status: woStatusLabel(s) })}</div>}
                  {shown.map((t) => (
                    <WoCard key={t.id} t={t} today={today} onOpen={() => openDetail(t)} onCardClick={(e) => openFromRow(e, t)} menu={moveMenu(t)} dragging={dragId === t.id}
                      onNext={NEXT[t.status] ? () => setStatus(t, NEXT[t.status]) : null} justDone={cheer && cheer.id === t.id && t.status === 'completed'}
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
            <div className="wo-reg-bar">
              <span className="wo-reg-summary">
                <b>{rows.length === 1 ? tr('1 work order') : tr('{n} work orders', { n: rows.length })}</b>
                {rows.filter((t) => WO_OPEN(t) && t.overdue).length > 0 && <span className="wo-reg-pill is-bad">{tr('{n} late', { n: rows.filter((t) => WO_OPEN(t) && t.overdue).length })}</span>}
                {rows.filter((t) => WO_OPEN(t)).length > 0 && <span className="wo-reg-pill is-open">{tr('{n} open', { n: rows.filter((t) => WO_OPEN(t)).length })}</span>}
                {rows.filter((t) => t.status === 'completed').length > 0 && <span className="wo-reg-pill is-good">{tr('{n} completed', { n: rows.filter((t) => t.status === 'completed').length })}</span>}
              </span>
              {regSort && <button type="button" className="dk-link" onClick={() => setRegSort(null)}>{tr('Back to the usual order')}</button>}
              <button type="button" className="btn btn-secondary wo-reg-csv" onClick={() => downloadCsv(sortedRows)} title={tr('Every work order shown here, as a spreadsheet for Excel or Google Sheets')}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" /></svg>
                {tr('Download (.csv)')}
              </button>
            </div>
            <div className="wo-register-wrap">
              <table className="wo-register is-fancy">
                <thead>
                  <tr>
                    {canManage && <th className="is-pick"><input type="checkbox" checked={pageRows.length > 0 && pageRows.every((t) => picked.has(t.id))} onChange={(e) => setPicked((was) => { const s = new Set(was); pageRows.forEach((t) => (e.target.checked ? s.add(t.id) : s.delete(t.id))); return s; })} aria-label={tr('Pick every row shown')} /></th>}
                    {sortTh([['wo', tr('WO no.')], ['title', tr('Work order')]])}
                    {sortTh([['for', tr('For')]])}
                    {sortTh([['qty', tr('Qty')]], 'is-num')}
                    <th>{tr('People')}</th>
                    {sortTh([['due', tr('Issued → due')]])}
                    {sortTh([['status', tr('Status')]])}
                    {sortTh([['days', tr('Days')]], 'is-num')}
                    <th aria-label={tr('Actions')} />
                  </tr>
                </thead>
                <tbody>
                  {regGroups.map((g) => (
                    <Fragment key={g.key}>
                      {g.label && (
                        <tr className={'wo-reg-group is-' + g.key}>
                          <td colSpan={canManage ? 9 : 8}><span className="wo-reg-group-label"><i aria-hidden="true" />{g.label}<b>{g.n}</b></span></td>
                        </tr>
                      )}
                      {g.rows.map((t, i) => (
                        <tr key={t.id} className={'wo-reg-row is-' + t.status + (t.overdue ? ' is-overdue' : '') + (WO_OPEN(t) ? '' : ' is-closed') + (picked.has(t.id) ? ' is-picked' : '')} style={{ '--i': Math.min(i, 20) }} onClick={(e) => openFromRow(e, t)}>
                          {canManage && <td className="is-pick"><input type="checkbox" checked={picked.has(t.id)} onChange={() => togglePick(t.id)} aria-label={tr('Pick {no}', { no: t.number })} /></td>}
                          <td className="is-title">
                            <span className="wo-row-top">
                              <button type="button" className="wo-no is-link" onClick={() => openDetail(t)}>{t.number}</button>
                              {t.priority === 'high' && (
                                <span className="wo-flame" title={tr('{p} priority', { p: codeLabel('high') })}>
                                  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.5 2.5c.6 3.2-1.2 4.9-2.6 6.5C8.4 10.7 7 12.4 7 15a5 5 0 0 0 10 0c0-1.9-.8-3.4-1.7-4.6-.2 1.3-.9 2.3-1.9 2.8.3-3.3-.1-7.6-.9-10.7z" /></svg>
                                  {codeLabel('high')}
                                </span>
                              )}
                            </span>
                            <button type="button" className="wo-row-title" onClick={() => openDetail(t)}>{t.title}</button>
                            {(t.projectName !== '—' || t.process) && <span className="wo-row-sub">{t.projectName && t.projectName !== '—' && <span className="wo-row-project">{t.projectName}</span>}{t.process && <span className="wo-row-process">{t.process}</span>}</span>}
                          </td>
                          <td className="is-for" data-label={tr('For')} title={forName(t)}>{forName(t) ? <span className="wo-reg-for"><ForBadge name={forName(t)} /><span>{forName(t)}</span></span> : <span className="dk-muted">—</span>}</td>
                          <td className="is-num is-qty" data-label={tr('Qty')}>{t.quantity ? <b>{t.quantity}</b> : <span className="dk-muted">—</span>}</td>
                          <td className="is-people" data-label={tr('People')}>
                            <span className="wo-reg-people">
                              {t.projectManager ? <span className="wo-reg-pm" title={tr('Project manager: {name}', { name: pmOf(t) })}><Photo id={t.projectManager.id} name={t.projectManager.name} photo={t.projectManager.photo} size={24} /><b>{tr('PM')}</b></span>
                                : pmOf(t) ? <span className="wo-reg-pm is-text" title={tr('Project manager: {name}', { name: pmOf(t) })}><b>{tr('PM')}</b>{pmOf(t)}</span> : null}
                              <Faces2 t={t} />
                            </span>
                          </td>
                          <td className="is-when" data-label={tr('Issued → due')}><MiniTimeline t={t} today={today} /></td>
                          <td className="is-status" data-label={tr('Status')}><StatusSelect status={t.status} onChange={(v) => setStatus(t, v)} label={tr('Status of {no}', { no: t.number })} /></td>
                          <td className="is-num is-days" data-label={tr('Days')}><DaysChip t={t} /></td>
                          <td className="is-menu"><RowMenu actions={[{ label: tr('Open'), onClick: () => openDetail(t) }, { label: tr('Delete'), onClick: () => setDeleteTarget(t), danger: true, hidden: !canManage }]} /></td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > shownRows && <button type="button" className="btn btn-secondary wo-more-rows" onClick={() => setShownRows(shownRows + PAGE * 2)}>{tr('Show {n} more of {total}', { n: Math.min(PAGE * 2, rows.length - shownRows), total: rows.length })}</button>}
            {canManage && picked.size > 0 && (
              <div className="wo-pickbar" role="region" aria-label={tr('Picked work orders')}>
                <strong>{tr('{n} picked', { n: picked.size })}</strong>
                {picked.size < rows.length && <button type="button" className="dk-link" onClick={() => setPicked(new Set(rows.map((t) => t.id)))}>{tr('Pick all {n} that match', { n: rows.length })}</button>}
                <span className="wo-pickbar-fill" />
                <select className="input" value={pickProject} onChange={(e) => setPickProject(e.target.value)} aria-label={tr('Project to add them to')}>
                  <option value="">{tr('Choose a project…')}</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.code + ' — ' + p.name}</option>)}
                </select>
                <button type="button" className="btn btn-primary" disabled={!pickProject || moving} onClick={() => moveToProject(pickProject)}>{moving ? tr('Saving…') : tr('Add to the project')}</button>
                <button type="button" className="btn btn-secondary" disabled={moving} onClick={() => moveToProject(null)}>{tr('Take out of their project')}</button>
                <button type="button" className="btn btn-secondary" disabled={moving} onClick={() => setPmDialog({ wos: tasks.filter((t) => picked.has(t.id)), remember: false })}>{tr('Change project manager')}</button>
                <button type="button" className="dk-link" onClick={() => setPicked(new Set())}>{tr('Clear')}</button>
              </div>
            )}
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

      {pmDialog && (
        <WoManagerDialog wos={pmDialog.wos} employees={employees} remember={pmDialog.remember} onClose={() => setPmDialog(null)}
          onDone={(r) => {
            setPmDialog(null); setPicked(new Set()); setPmFilter('');
            const said = r.updated === 1 ? tr('1 work order now managed by {name}.', { name: r.projectManager.name }) : tr('{n} work orders now managed by {name}.', { n: r.updated, name: r.projectManager.name });
            setToast(r.remembered ? said + ' ' + tr('The next imports will read “{sheet}” as them.', { sheet: r.remembered }) : said);
            load();
          }} />
      )}
      {presenting && (
        <WorkOrdersPresent wos={scoped} scopeName={scope === 'mine' ? tr('My work orders') : currentCompany ? currentCompany.name : tr('All companies')}
          onClose={() => setPresenting(false)} onOpen={openDetail} paused={!!detail || !!opening || !!deleteTarget} />
      )}
      {importOpen && <WoImport employees={employees} onClose={() => setImportOpen(false)} onDone={imported} />}

      {opening && !detail && (
        <div className="dialog-backdrop" onClick={closeOpening}>
          <div className="dialog wo-dialog wo-opening" role="status" onClick={(e) => e.stopPropagation()}>
            {opening.t.number && <span className="wo-no">{opening.t.number}</span>}
            {opening.error ? (
              <>
                <h2>{tr('This work order did not open')}</h2>
                <div className="error-banner" role="alert">{opening.error}</div>
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={closeOpening}>{tr('Close')}</button>
                  <button type="button" className="btn btn-primary" onClick={() => openDetail(opening.t)}>{tr('Try again')}</button>
                </div>
              </>
            ) : (
              <>
                <h2>{opening.t.title || tr('Opening the work order…')}</h2>
                <p className="wo-opening-wait"><span className="wo-spin" aria-hidden="true" />{tr('Opening…')}</p>
              </>
            )}
          </div>
        </div>
      )}

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
