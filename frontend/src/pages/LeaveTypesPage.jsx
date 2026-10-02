import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api/client';
import Photo from '../components/Photo';
import LeavePool, { PoolBar } from '../components/LeavePool';
import RowMenu from '../components/RowMenu';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { CompanySwitcher, Empty, Glossary, Hero, Insights, Section, Status, fmtDate, jump } from '../components/DashKit';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import './EmployeesPage.css';
import './LeaveTypesPage.css';

// Leave types & balances — the HR screen (nav-gated on employee.write).
// Same "explains itself" layout as the dashboards (components/DashKit.jsx):
// a year and company picker, the key numbers, what stands out (people with
// no balances for the year, people almost out of days, splits that do not
// add up to the agreed total, companies with no public holidays), then:
//  - Leave types: what each is worth per year (the company-wide default),
//    paid or not, and how much of it has been taken.
//  - Balances: everyone at once for the year (GET /leave/overview), with an
//    Adjust window per person for their agreed total, their own figure per
//    type (persists year to year) and the year's stored balance (a one-off
//    correction). "Used" only ever moves through approved requests.
//  - The yearly total (leavePool.service.js): each person's agreed days, or
//    their company's default, less that year's company holidays; annual,
//    compassionate and sick leave come out of it, and more can be taken —
//    owed, and settled here (Owed days).
//  - Public holidays per company, per year: taken off everyone's yearly
//    total on 1 January; a holiday inside a request isn't charged again.
//  - New year: grant everyone the year's balances ahead of time
//    (idempotent; never overwrites an existing balance).

const EMPTY_TYPE_FORM = { name: '', daysPerYear: '', paid: true, active: true, inPool: true };
const EMPTY_HOLIDAY_FORM = { date: '', name: '' };
const LOW_DAYS = 2;

function errText(err, fallback) { return err instanceof ApiError ? err.message : fallback; }
function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function todayIso() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// One person's leave set-up: the total agreed with them, their own figure
// per leave type, and the chosen year's stored balance.
function AdjustDialog({ employee, year, onClose, onChanged }) {
  const [ent, setEnt] = useState(null);
  const [bal, setBal] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [totalDraft, setTotalDraft] = useState('');
  const [ownDrafts, setOwnDrafts] = useState({});
  const [entitledDrafts, setEntitledDrafts] = useState({});
  const [recalc, setRecalc] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const [e, b] = await Promise.all([
        api.get('/leave/entitlements/' + employee.id + '?year=' + year),
        api.get('/leave/balances/' + employee.id + '?year=' + year)
      ]);
      setEnt(e);
      setBal(b);
      setTotalDraft(e.leaveDaysTotal === null ? '' : String(e.leaveDaysTotal));
      setOwnDrafts(Object.fromEntries(e.types.map((t) => [t.leaveTypeId, String(t.daysPerYear)])));
      setEntitledDrafts(Object.fromEntries(b.map((r) => [r.leaveTypeId, String(r.entitled)])));
    } catch (err) { setError(errText(err, tr('Could not load entitlements.'))); }
  }, [employee.id, year]);
  useEffect(() => { load(); }, [load]);

  async function run(key, fn) {
    setBusy(key);
    setError('');
    try { await fn(); await load(); onChanged(); } catch (err) { setError(errText(err, tr('Could not save that.'))); } finally { setBusy(''); }
  }
  function wholeDays(v) {
    const n = Number(v);
    if (v === '' || !Number.isInteger(n) || n < 0) { setError(tr('Days must be a whole number, 0 or more.')); return null; }
    return n;
  }

  const pool = ent && ent.pool && ent.pool.inEffect ? ent.pool : null;
  const allocated = ent ? ent.types.reduce((sum, t) => sum + (Number(ownDrafts[t.leaveTypeId] ?? t.daysPerYear) || 0), 0) : 0;
  const balByType = Object.fromEntries((bal || []).map((b) => [b.leaveTypeId, b]));

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog lt-adjust" onClick={(e) => e.stopPropagation()}>
        <header className="lt-adjust-head">
          <Photo id={employee.id} name={employee.name} photo={employee.photo} size={48} />
          <div>
            <h2>{employee.name}</h2>
            <span className="dk-muted">{employee.code} · {employee.department} · {employee.companyName}</span>
          </div>
        </header>
        {error && <div className="error-banner">{error}</div>}
        {!ent || !bal ? <p className="dk-muted">{tr('Loading…')}</p> : (
          <>
            <div className="lt-adjust-total">
              <div className="field">
                <label htmlFor="lt-days-total">{tr('Yearly leave total agreed with this employee')}</label>
                <div className="lt-inline">
                  <input id="lt-days-total" className="input lt-num" inputMode="numeric" placeholder={pool && pool.totalFrom === 'company' ? String(pool.total) : tr('e.g. 20')} value={totalDraft} onChange={(e) => setTotalDraft(e.target.value)} />
                  <button type="button" className="btn btn-secondary lt-btn" disabled={busy === 'total' || totalDraft === (ent.leaveDaysTotal === null ? '' : String(ent.leaveDaysTotal))}
                    onClick={() => run('total', () => api.post('/leave/entitlements/total', { employeeId: employee.id, leaveDaysTotal: totalDraft === '' ? null : Number(totalDraft) }))}>
                    {busy === 'total' ? tr('Saving…') : tr('Save total')}
                  </button>
                  {!pool && ent.leaveDaysTotal !== null && (
                    <Status tone={allocated === ent.leaveDaysTotal ? 'good' : 'bad'}>{tr('Allocated {allocatedSum} of {leaveDaysTotal}', { allocatedSum: allocated, leaveDaysTotal: ent.leaveDaysTotal })}</Status>
                  )}
                </div>
              </div>
              <p className="dk-muted lt-small">
                {pool
                  ? (pool.totalFrom === 'company'
                    ? tr('Empty: they have their company\'s yearly total, {n} days. Type a number to give them their own.', { n: pool.total })
                    : tr('Their own yearly total. Empty it to give them their company\'s default instead.'))
                  : tr('No yearly total yet: type one here, or give their company a default under Yearly leave total. Until then their leave types keep their own allowances below.')}
              </p>
              {pool && <LeavePool pool={pool} />}
            </div>

            <div className="lt-adjust-table" role="table">
              <div className="lt-adjust-row is-head" role="row">
                <span role="columnheader">{tr('Leave type')}</span>
                <span role="columnheader">{tr('Their days a year')}</span>
                <span role="columnheader">{tr('{year} balance', { year })}</span>
                <span role="columnheader">{tr('Used')}</span>
                <span role="columnheader">{tr('Left')}</span>
              </div>
              {ent.types.map((t) => {
                const b = balByType[t.leaveTypeId];
                if (pool && t.inPool) {
                  return (
                    <div key={t.leaveTypeId} className="lt-adjust-row" role="row">
                      <span role="cell" className="lt-adjust-type"><strong>{t.name}</strong><span className="dk-muted">{tr('From the yearly total')}</span></span>
                      <span role="cell" className="dk-muted" data-label={tr('Their days a year')}>{tr('Shared total')}</span>
                      <span role="cell" className="dk-muted" data-label={tr('{year} balance', { year })}>{tr('Shared total')}</span>
                      <span role="cell" className="lt-figure" data-label={tr('Used')}>{pool.usedByType[t.leaveTypeId] || 0}</span>
                      <span role="cell" className="lt-figure dk-muted" data-label={tr('Left')}>—</span>
                    </div>
                  );
                }
                if (b && b.paid === false) {
                  return (
                    <div key={t.leaveTypeId} className="lt-adjust-row" role="row">
                      <span role="cell" className="lt-adjust-type"><strong>{t.name}</strong><span className="dk-muted">{tr('Unpaid')}</span></span>
                      <span role="cell" className="dk-muted" data-label={tr('Their days a year')}>{tr('No limit')}</span>
                      <span role="cell" className="dk-muted" data-label={tr('{year} balance', { year })}>{tr('No limit')}</span>
                      <span role="cell" className="lt-figure" data-label={tr('Used')}>{b.used}</span>
                      <span role="cell" className="lt-figure" data-label={tr('Left')}>—</span>
                    </div>
                  );
                }
                const ownDraft = ownDrafts[t.leaveTypeId] ?? String(t.daysPerYear);
                const entDraft = b ? (entitledDrafts[t.leaveTypeId] ?? String(b.entitled)) : '';
                return (
                  <div key={t.leaveTypeId} className="lt-adjust-row" role="row">
                    <span role="cell" className="lt-adjust-type">
                      <strong>{t.name}</strong>
                      <span className="dk-muted">{t.isCustom ? tr('Own figure · company default {n}', { n: t.companyDefault }) : tr('Company default')}</span>
                    </span>
                    <span role="cell" className="lt-inline" data-label={tr('Their days a year')}>
                      <input className="input lt-num" inputMode="numeric" value={ownDraft} aria-label={tr('Days a year for {type}', { type: t.name })}
                        onChange={(e) => setOwnDrafts({ ...ownDrafts, [t.leaveTypeId]: e.target.value })} />
                      <button type="button" className="btn btn-secondary lt-btn" disabled={busy === 'own' + t.leaveTypeId || ownDraft === String(t.daysPerYear)}
                        onClick={() => { const n = wholeDays(ownDraft); if (n !== null) run('own' + t.leaveTypeId, () => api.post('/leave/entitlements', { employeeId: employee.id, leaveTypeId: t.leaveTypeId, daysPerYear: n, year: Number(year) })); }}>
                        {tr('Save')}
                      </button>
                      {t.isCustom && (
                        <button type="button" className="btn btn-secondary lt-btn" disabled={busy === 'own' + t.leaveTypeId}
                          onClick={() => run('own' + t.leaveTypeId, () => api.del('/leave/entitlements/' + employee.id + '/' + t.leaveTypeId + '?year=' + encodeURIComponent(year)))}>
                          {tr('Reset to default')}
                        </button>
                      )}
                    </span>
                    <span role="cell" className="lt-inline" data-label={tr('{year} balance', { year })}>
                      {b && b.hasRow ? (
                        <>
                          <input className="input lt-num" inputMode="numeric" value={entDraft} aria-label={tr('{year} balance for {type}', { year, type: t.name })}
                            onChange={(e) => setEntitledDrafts({ ...entitledDrafts, [t.leaveTypeId]: e.target.value })} />
                          <button type="button" className="btn btn-secondary lt-btn" disabled={busy === 'bal' + t.leaveTypeId || entDraft === String(b.entitled)}
                            onClick={() => { const n = wholeDays(entDraft); if (n !== null) run('bal' + t.leaveTypeId, () => api.post('/leave/balances', { employeeId: employee.id, leaveTypeId: t.leaveTypeId, year: Number(year), entitled: n })); }}>
                            {tr('Save')}
                          </button>
                        </>
                      ) : <span className="dk-muted">{tr('Not granted yet')}</span>}
                    </span>
                    <span role="cell" className="lt-figure" data-label={tr('Used')}>{b ? b.used : 0}</span>
                    <span role="cell" className={'lt-figure' + (b && b.hasRow && b.entitled - b.used <= 0 && b.entitled > 0 ? ' is-out' : '')} data-label={tr('Left')}>{b && b.hasRow ? b.entitled - b.used : '—'}</span>
                  </div>
                );
              })}
            </div>
            <p className="dk-muted lt-small">{pool
              ? tr('Leave types in the yearly total share it; the others keep their own days a year. Used days only change when leave is approved.')
              : tr('"Their days a year" carries over to every year until changed. The {year} balance is what they can take this year; change it only for a one-off correction. Used days only change when leave is approved.', { year })}</p>

            {recalc && <p className="lt-ok">{tr('Checked {checked} leave type(s), updated {updated} to match the current company default/personal entitlement.', { checked: recalc.checked, updated: recalc.updated })}</p>}
            <div className="dialog-actions lt-adjust-actions">
              <button type="button" className="btn btn-secondary" disabled={busy === 'recalc'}
                onClick={() => run('recalc', async () => setRecalc(await api.post('/leave/balances/recalculate', { employeeId: employee.id, year: Number(year) })))}>
                {busy === 'recalc' ? tr('Recalculating…') : tr('Recalculate against current policy')}
              </button>
              <button type="button" className="btn btn-primary" onClick={onClose}>{tr('Done')}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// How owed leave days were settled (leavePool.service.js settle).
function HOW_TEXT() {
  return { pay: tr('deducted from pay'), next_year: tr('taken from next year\'s leave'), waived: tr('waived'), other: tr('settled another way') };
}

function SettleDialog({ person, year, onClose, onDone }) {
  const [days, setDays] = useState(String(person.owedOutstanding));
  const [how, setHow] = useState('pay');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function save(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      await api.post('/leave/owed/settle', { employeeId: person.employeeId, year: Number(year), days: Number(days), how, note });
      onDone(person.name);
    } catch (err) { setError(errText(err, tr('Could not save that.'))); } finally { setSaving(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog lt-settle" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>{tr('Settle {name}\'s owed days', { name: person.name })}</h2>
        <p className="dk-muted">{tr('{name} took {used} day(s) of leave in {year} against {avail} available ({total} yearly total − {h} company holidays), so they owe {n} day(s).', { name: person.name, used: person.used, year, avail: Math.max(0, person.available), total: person.total, h: person.holidays, n: person.owedOutstanding })}</p>
        {error && <div className="error-banner">{error}</div>}
        <div className="field">
          <label htmlFor="lt-settle-days">{tr('Days settled')}</label>
          <input id="lt-settle-days" className="input lt-num" inputMode="decimal" value={days} onChange={(e) => setDays(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="lt-settle-how">{tr('How')}</label>
          <select id="lt-settle-how" className="input" value={how} onChange={(e) => setHow(e.target.value)}>
            {Object.entries(HOW_TEXT()).map(([k, v]) => <option key={k} value={k}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="lt-settle-note">{tr('Note')}</label>
          <input id="lt-settle-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={how === 'other' ? tr('Say how it was settled') : tr('e.g. October payroll')} required={how === 'other'} maxLength={300} />
        </div>
        <p className="dk-muted lt-small">{tr('This only records the decision. A deduction from pay or from next year\'s leave is made where it belongs (payroll, or that person\'s total).')}</p>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Record it')}</button>
        </div>
      </form>
    </div>
  );
}

export default function LeaveTypesPage() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(String(thisYear));
  const [overview, setOverview] = useState(null);
  const [allTypes, setAllTypes] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);

  const [companyCode, setCompanyCode] = useState(() => readPref('bos.leaveTypesCompany', 'ALL'));
  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [chip, setChip] = useState('');

  const [typeDialog, setTypeDialog] = useState(null); // { mode: 'new'|'edit', id }
  const [typeForm, setTypeForm] = useState(EMPTY_TYPE_FORM);
  const [typeSaving, setTypeSaving] = useState(false);
  const [typeError, setTypeError] = useState('');

  const [holidayCompanyId, setHolidayCompanyId] = useState('');
  const [holidayForm, setHolidayForm] = useState(EMPTY_HOLIDAY_FORM);
  const [holidaySaving, setHolidaySaving] = useState(false);
  const [holidayError, setHolidayError] = useState('');

  const [rolloverYear, setRolloverYear] = useState(String(thisYear + 1));
  const [rolloverRunning, setRolloverRunning] = useState(false);
  const [rolloverResult, setRolloverResult] = useState(null);
  const [rolloverError, setRolloverError] = useState('');

  const [adjust, setAdjust] = useState(null);
  const [owed, setOwed] = useState({ people: [] }); // who owes leave days (leavePool.service.js owedList)
  const [settleFor, setSettleFor] = useState(null);
  const [totalDrafts, setTotalDrafts] = useState({}); // companyId -> draft of its yearly total
  const [savingTotal, setSavingTotal] = useState('');

  const loadOverview = useCallback(async (y) => {
    try {
      const [ov, ow] = await Promise.all([
        api.get('/leave/overview?year=' + encodeURIComponent(y)),
        api.get('/leave/owed?year=' + encodeURIComponent(y)).catch(() => ({ people: [] }))
      ]);
      setOverview(ov);
      setOwed(ow);
      setTotalDrafts(Object.fromEntries((ov.companyTotals || []).map((c) => [c.companyId, c.leaveDaysDefault === null ? '' : String(c.leaveDaysDefault)])));
      setError('');
    } catch (err) { setError(errText(err, tr('Could not load balances.'))); }
  }, []);
  const loadTypes = useCallback(async () => {
    try { setAllTypes(await api.get('/leave/types/all')); } catch (err) { setError(errText(err, tr('Could not load leave types.'))); }
  }, []);

  useEffect(() => {
    (async () => {
      await Promise.all([
        loadTypes(),
        api.get('/companies').then((rows) => setCompanies(rows)).catch(() => {})
      ]);
      setLoading(false);
    })();
  }, [loadTypes]);
  useEffect(() => { loadOverview(year); }, [year, loadOverview]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const sortedCompanies = useMemo(() => companies.slice().sort((a, b) => (a.code === 'BPL' ? -1 : b.code === 'BPL' ? 1 : a.name.localeCompare(b.name))), [companies]);
  const currentCompany = sortedCompanies.find((c) => c.code === companyCode) || null;
  useEffect(() => {
    if (!holidayCompanyId && sortedCompanies.length) setHolidayCompanyId((currentCompany || sortedCompanies[0]).id);
  }, [sortedCompanies, currentCompany, holidayCompanyId]);
  function pickCompany(code) {
    setCompanyCode(code);
    setDeptFilter('');
    writePref('bos.leaveTypesCompany', code);
    const co = sortedCompanies.find((c) => c.code === code);
    if (co) setHolidayCompanyId(co.id);
  }

  // ── leave types ──────────────────────────────────────────────────────
  async function saveCompanyTotal(c) {
    const v = (totalDrafts[c.companyId] || '').trim();
    if (v !== '' && (!/^\d+$/.test(v) || Number(v) > 366)) { setError(tr('The yearly total must be a whole number of days, 0 to 366.')); return; }
    setSavingTotal(c.companyId);
    try {
      await api.put('/leave/company-totals/' + c.companyId, { leaveDaysDefault: v === '' ? null : Number(v) });
      setToast(v === '' ? tr('{company} has no default yearly total now.', { company: c.name }) : tr('{company}: {n} days a year, less that year\'s company holidays.', { company: c.name, n: v }));
      await loadOverview(year);
    } catch (err) { setError(errText(err, tr('Could not save that.'))); } finally { setSavingTotal(''); }
  }

  function openNewType() { setTypeForm(EMPTY_TYPE_FORM); setTypeError(''); setTypeDialog({ mode: 'new' }); }
  function openEditType(t) {
    setTypeForm({ name: t.name, daysPerYear: String(t.daysPerYear), paid: t.paid, active: t.active, inPool: !!t.inPool });
    setTypeError('');
    setTypeDialog({ mode: 'edit', id: t.id });
  }
  async function saveType(e) {
    e.preventDefault();
    setTypeSaving(true);
    setTypeError('');
    try {
      const body = { name: typeForm.name, daysPerYear: Number(typeForm.daysPerYear), paid: typeForm.paid, active: typeForm.active, inPool: typeForm.paid && typeForm.inPool };
      if (typeDialog.mode === 'new') await api.post('/leave/types', body);
      else await api.patch('/leave/types/' + typeDialog.id, body);
      setTypeDialog(null);
      setToast(tr('Leave type saved.'));
      await Promise.all([loadTypes(), loadOverview(year)]);
    } catch (err) { setTypeError(errText(err, tr('Could not save that leave type.'))); } finally { setTypeSaving(false); }
  }

  // ── holidays ─────────────────────────────────────────────────────────
  async function addHoliday(e) {
    e.preventDefault();
    setHolidaySaving(true);
    setHolidayError('');
    try {
      await api.post('/leave/holidays', { companyId: holidayCompanyId, date: holidayForm.date, name: holidayForm.name });
      setHolidayForm(EMPTY_HOLIDAY_FORM);
      setToast(tr('Holiday added.'));
      if (holidayForm.date.slice(0, 4) !== year) setYear(holidayForm.date.slice(0, 4));
      else await loadOverview(year);
    } catch (err) { setHolidayError(errText(err, tr('Could not add that holiday.'))); } finally { setHolidaySaving(false); }
  }
  async function removeHoliday(h) {
    if (!window.confirm(tr('Remove {name} ({date})?', { name: h.name, date: fmtDate(h.date) }))) return;
    setHolidayError('');
    try { await api.del('/leave/holidays/' + h.id); await loadOverview(year); } catch (err) { setHolidayError(errText(err, tr('Could not remove that holiday.'))); }
  }

  // ── new year ─────────────────────────────────────────────────────────
  async function runRollover(yStr) {
    const y = Number(yStr);
    if (!Number.isInteger(y)) { setRolloverError(tr('Enter a valid year.')); return; }
    setRolloverRunning(true);
    setRolloverError('');
    setRolloverResult(null);
    try {
      const res = await api.post('/leave/rollover', { year: y });
      setRolloverResult(res);
      setToast(tr('Granted {granted} new balance record(s) for {year}, across {employees} active employee(s) and {types} leave type(s).', { granted: res.granted, year: res.year, employees: res.employees, types: res.types }));
      if (String(y) === year) await loadOverview(year);
    } catch (err) { setRolloverError(errText(err, tr('Could not run the rollover.'))); } finally { setRolloverRunning(false); }
  }

  if (loading || !overview) {
    return error ? <div className="error-banner">{error}</div> : <div className="eyebrow">{tr('Loading…')}</div>;
  }

  // ── what the page shows ────────────────────────────────────────────
  const types = overview.types; // active
  // The yearly total: types in it share one balance per person.
  const poolTypes = types.filter((t) => t.inPool);
  const ownTypes = poolTypes.length ? types.filter((t) => !t.inPool) : types;
  const companyTotals = (overview.companyTotals || []).filter((c) => c.people > 0 && (!currentCompany || c.companyId === currentCompany.id));
  const paidTypes = types.filter((t) => t.paid);
  const people = overview.employees.filter((e) => !currentCompany || e.companyCode === currentCompany.code);
  const typeById = Object.fromEntries(types.map((t) => [t.id, t]));
  const photoById = Object.fromEntries(overview.employees.map((e) => [e.id, e]));
  const leftOf = (b) => b.entitled - b.used;
  const lowIn = (e) => e.balances.filter((b) => typeById[b.leaveTypeId] && typeById[b.leaveTypeId].paid && b.hasRow && b.entitled > LOW_DAYS && leftOf(b) <= LOW_DAYS);
  const inPool = (e) => !!(e.pool && e.pool.inEffect);
  const mismatch = (e) => !inPool(e) && e.leaveDaysTotal !== null && e.allocated !== e.leaveDaysTotal;
  const poolLow = (e) => inPool(e) && e.pool.owed === 0 && e.pool.left <= LOW_DAYS;
  // Low on a type that is not counted in their yearly total.
  const lowOutside = (e) => lowIn(e).filter((b) => !(inPool(e) && typeById[b.leaveTypeId].inPool));
  const chipTest = {
    notgranted: (e) => !inPool(e) && !e.granted, low: (e) => poolLow(e) || lowOutside(e).length > 0,
    custom: (e) => e.customCount > 0, mismatch, owing: (e) => inPool(e) && e.pool.owedOutstanding > 0, nototal: (e) => poolTypes.length > 0 && !inPool(e)
  };
  const owing = people.filter(chipTest.owing);
  const noTotal = people.filter(chipTest.nototal);
  const notGranted = people.filter(chipTest.notgranted);
  const low = people.filter(chipTest.low);
  const withOwn = people.filter(chipTest.custom);
  const mismatched = people.filter(mismatch);
  const paidRows = people.flatMap((e) => e.balances.filter((b) => typeById[b.leaveTypeId] && typeById[b.leaveTypeId].paid && b.hasRow && !(inPool(e) && typeById[b.leaveTypeId].inPool)));
  const usedDays = paidRows.reduce((n, b) => n + b.used, 0) + people.filter(inPool).reduce((n, e) => n + e.pool.used, 0);
  const grantedDays = paidRows.reduce((n, b) => n + b.entitled, 0) + people.filter(inPool).reduce((n, e) => n + Math.max(0, e.pool.available), 0);
  const holidays = overview.holidays.filter((h) => !currentCompany || h.companyId === currentCompany.id);
  const companiesWithStaff = sortedCompanies.filter((c) => overview.employees.some((e) => e.companyId === c.id) && (!currentCompany || c.id === currentCompany.id));
  const noHolidays = companiesWithStaff.filter((c) => !overview.holidays.some((h) => h.companyId === c.id));
  const nameList = (arr) => (arr.length <= 3 ? arr.map((e) => e.name).join(', ') : tr('{names} and {n} more', { names: arr.slice(0, 2).map((e) => e.name).join(', '), n: arr.length - 2 }));
  function showOnly(key) { setChip(chip === key ? '' : key); jump('lt-balances'); }

  const stats = [
    { icon: 'doc', value: String(types.length), label: tr('leave types'), note: tr('{p} paid · {u} unpaid', { p: paidTypes.length, u: types.length - paidTypes.length }), onClick: () => jump('lt-types') },
    poolTypes.length
      ? { icon: 'warn', value: String(owing.length), label: tr('owe leave days'), note: owing.length ? tr('{n} day(s) to settle', { n: owing.reduce((t, e) => t + e.pool.owedOutstanding, 0) }) : tr('nobody owes days'), tone: owing.length ? 'alert' : '', onClick: () => jump('lt-owed') }
      : { icon: 'warn', value: String(notGranted.length), label: tr('without {year} balances', { year }), note: tr('of {n} people', { n: people.length }), tone: notGranted.length ? 'alert' : '', onClick: () => showOnly('notgranted') },
    { icon: 'check', value: String(usedDays), label: tr('days taken in {year}', { year }), note: tr('of {n} granted', { n: grantedDays }), onClick: () => { setChip(''); jump('lt-balances'); } },
    { icon: 'calendar', value: String(holidays.length), label: tr('public holidays'), note: currentCompany ? tr('in {year}', { year }) : tr('in {year}, all companies', { year }), onClick: () => jump('lt-holidays') }
  ];

  const insights = [];
  if (owing.length) insights.push({ tone: 'warn', icon: 'warn', text: owing.length === 1 ? tr('{name} has taken {n} day(s) more leave than their {year} balance. Settle it under Owed days.', { name: owing[0].name, n: owing[0].pool.owedOutstanding, year }) : tr('{n} people have taken more leave than their {year} balance. Settle each under Owed days.', { n: owing.length, year }), action: { label: tr('Show them'), run: () => jump('lt-owed') } });
  // Holidays are part of everyone's total: a year with none entered yet shows the full total.
  const missingHol = companyTotals.filter((c) => c.holidays === 0 && (c.leaveDaysDefault !== null || c.withoutOwnTotal < c.people));
  if (poolTypes.length && missingHol.length) insights.push({ tone: 'bad', icon: 'calendar', text: tr('{companies}: no company holidays entered for {year} yet, so everyone\'s balance shows the full yearly total until they are.', { companies: missingHol.map((c) => c.name).join(', '), year }), action: { label: tr('Add holidays'), run: () => { setHolidayCompanyId(missingHol[0].companyId); jump('lt-holidays'); } } });
  const nextMissing = new Date().getMonth() >= 10 && year === String(thisYear) ? companyTotals.filter((c) => c.nextYearHolidays === 0) : [];
  if (poolTypes.length && nextMissing.length) insights.push({ tone: 'info', icon: 'calendar', text: tr('{companies}: {next} company holidays are not entered yet. Enter them before 1 January, when they come off everyone\'s yearly total.', { companies: nextMissing.map((c) => c.name).join(', '), next: thisYear + 1 }), action: { label: tr('Go there'), run: () => { setYear(String(thisYear + 1)); jump('lt-holidays'); } } });
  if (poolTypes.length && noTotal.length) insights.push({ tone: 'warn', icon: 'people', text: noTotal.length === 1 ? tr('{name} has no yearly leave total: give them one, or give their company a default.', { name: noTotal[0].name }) : tr('{n} people have no yearly leave total: give their company a default under Yearly leave total.', { n: noTotal.length }), action: { label: tr('Set it'), run: () => jump('lt-total') } });
  if (notGranted.length && !poolTypes.length) {
    insights.push({ tone: 'warn', icon: 'warn', text: notGranted.length === 1 ? tr('{name} has no {year} balances yet, so the leave page shows them 0 days left until they first ask for leave. Grant them now.', { name: notGranted[0].name, year }) : tr('{n} people have no {year} balances yet, so the leave page shows them 0 days left until they first ask for leave. Grant everyone\'s in one go.', { n: notGranted.length, year }), action: { label: tr('Grant now'), run: () => { if (window.confirm(tr('Grant {year} balances to everyone who does not have them yet? Existing balances are not changed.', { year }))) runRollover(year); } } });
  }
  const month = new Date().getMonth();
  if (month >= 10 && year === String(thisYear)) {
    insights.push({ tone: 'info', icon: 'calendar', text: tr('The year is nearly over. Grant {next} balances before January so everyone starts the year with their days.', { next: thisYear + 1 }), action: { label: tr('Go there'), run: () => { setRolloverYear(String(thisYear + 1)); jump('lt-newyear'); } } });
  }
  if (low.length) {
    insights.push({ tone: 'warn', icon: 'people', text: low.length === 1
      ? (poolLow(low[0])
        ? tr('{name} has {n} day(s) of their {year} yearly leave left.', { name: low[0].name, n: low[0].pool.left, year })
        : tr('{name} has {n} or fewer days of {type} left.', { name: low[0].name, n: LOW_DAYS, type: typeById[lowOutside(low[0])[0].leaveTypeId].name.toLowerCase() })) : tr('{names} have {n} or fewer days left of a leave type.', { names: nameList(low), n: LOW_DAYS }), action: { label: tr('Show them'), run: () => showOnly('low') } });
  }
  if (mismatched.length) {
    insights.push({ tone: 'warn', icon: 'scale', text: mismatched.length === 1 ? tr('{name}\'s days split across leave types ({a}) do not add up to the {t} agreed with them.', { name: mismatched[0].name, a: mismatched[0].allocated, t: mismatched[0].leaveDaysTotal }) : tr('{n} people\'s days split across leave types do not add up to the total agreed with them.', { n: mismatched.length }), action: { label: tr('Show them'), run: () => showOnly('mismatch') } });
  }
  if (noHolidays.length) {
    insights.push({ tone: 'info', icon: 'calendar', text: tr('{companies}: no public holidays recorded for {year}. A holiday inside a leave request is not charged, so add them.', { companies: noHolidays.map((c) => c.name).join(', '), year }), action: { label: tr('Add holidays'), run: () => { setHolidayCompanyId(noHolidays[0].id); jump('lt-holidays'); } } });
  }
  if (withOwn.length) insights.push({ tone: 'info', icon: 'people', text: withOwn.length === 1 ? tr('{name} has their own figure for at least one leave type instead of the company default.', { name: withOwn[0].name }) : tr('{n} people have their own figure for at least one leave type instead of the company default.', { n: withOwn.length }), action: { label: tr('Show them'), run: () => showOnly('custom') } });

  const chips = [
    ['', tr('Everyone'), people.length],
    poolTypes.length ? ['owing', tr('Owe days'), owing.length] : ['notgranted', tr('Not granted'), notGranted.length],
    ['low', tr('Almost out'), low.length],
    poolTypes.length ? ['nototal', tr('No yearly total'), noTotal.length] : ['mismatch', tr('Total does not add up'), mismatched.length],
    ['custom', tr('Own figures'), withOwn.length]
  ].filter((c) => c[0] === '' || c[2] > 0 || c[0] === 'low');
  const departments = Array.from(new Map(people.map((e) => [e.departmentId, { id: e.departmentId, name: e.department, company: e.companyName }])).values()).sort((a, b) => a.name.localeCompare(b.name));
  const rows = people
    .filter((e) => !deptFilter || e.departmentId === deptFilter)
    .filter((e) => !chip || chipTest[chip](e))
    .filter((e) => matchesQuery(search, e.name, e.code, e.department, e.companyName));
  const showCompany = !currentCompany && sortedCompanies.length > 1;
  const gridCols = poolTypes.length
    ? { gridTemplateColumns: 'minmax(190px, 1.6fr) minmax(170px, 1.4fr) repeat(' + ownTypes.length + ', minmax(76px, 1fr)) auto' }
    : { gridTemplateColumns: 'minmax(190px, 1.6fr) repeat(' + types.length + ', minmax(76px, 1fr)) minmax(130px, 0.9fr) auto' };

  const holidayList = overview.holidays.filter((h) => h.companyId === holidayCompanyId);
  const today = todayIso();
  const years = Array.from(new Set([thisYear - 1, thisYear, thisYear + 1, Number(year)])).sort();

  return (
    <div className="dk lt">
      {error && <div className="error-banner" role="alert">{error}</div>}

      {sortedCompanies.length > 1 && (
        <CompanySwitcher companies={[{ code: 'ALL', name: tr('All companies') }, ...sortedCompanies]} company={currentCompany ? currentCompany.code : 'ALL'}
          onPick={pickCompany}
          describe={(co) => {
            const n = overview.employees.filter((e) => co.code === 'ALL' || e.companyCode === co.code).length;
            return tr('{n} people', { n });
          }} />
      )}

      <Hero
        eyebrow={currentCompany ? currentCompany.name : tr('All companies')}
        title={tr('Leave types & balances')}
        sub={tr('What each type of leave is worth, everyone\'s days for {year}, and each company\'s public holidays. Press a number to jump to it.', { year })}
        actions={<>
          <label className="lt-year">
            <span>{tr('Year')}</span>
            <select className="input" value={year} onChange={(e) => { setYear(e.target.value); setRolloverResult(null); }}>
              {years.map((y) => <option key={y} value={String(y)}>{y}</option>)}
            </select>
          </label>
          <button type="button" className="btn btn-primary" onClick={openNewType}>{tr('+ New leave type')}</button>
        </>}
        stats={stats} />

      <Insights items={insights.slice(0, 6)} />

      {poolTypes.length > 0 && (
        <Section id="lt-total" title={tr('Yearly leave total')}
          sub={tr('Each person\'s days a year — their own if they have one, else their company\'s — less that year\'s company holidays, taken off on 1 January. {types} all come out of it. Taking more than is left is allowed; the extra is owed and settled by HR.', { types: poolTypes.map((t) => t.name).join(', ') })}>
          <ul className="lt-totals">
            {companyTotals.map((c) => {
              const draft = totalDrafts[c.companyId] ?? '';
              const saved = c.leaveDaysDefault === null ? '' : String(c.leaveDaysDefault);
              return (
                <li key={c.companyId} className="lt-total-row">
                  <span className="lt-total-who">
                    <span className="lt-mono" aria-hidden="true">{c.name.slice(0, 1)}</span>
                    <strong>{c.name}</strong>
                    <span className="dk-muted">{tr('{n} people', { n: c.people })} · {c.people - c.withoutOwnTotal > 0 ? tr('{n} with their own total', { n: c.people - c.withoutOwnTotal }) : tr('none with their own total')}</span>
                  </span>
                  <span className="lt-inline">
                    <input className="input lt-num" inputMode="numeric" placeholder={tr('e.g. 14')} value={draft} aria-label={tr('Yearly leave total for {company}', { company: c.name })}
                      onChange={(e) => setTotalDrafts({ ...totalDrafts, [c.companyId]: e.target.value })} />
                    <button type="button" className="btn btn-secondary lt-btn" disabled={savingTotal === c.companyId || draft === saved} onClick={() => saveCompanyTotal(c)}>{tr('Save')}</button>
                  </span>
                  <span className="lt-total-math">
                    {c.leaveDaysDefault === null
                      ? <span className="dk-muted">{tr('No default: only people with their own total have one.')}</span>
                      : <span className="lpl-eq">
                          <span className="lpl-chip"><strong>{c.leaveDaysDefault}</strong><small>{tr('yearly total')}</small></span>
                          <span className="lpl-op" aria-hidden="true">−</span>
                          <span className="lpl-chip is-holidays"><strong>{c.holidays}</strong><small>{tr('company holidays in {year}', { year })}</small></span>
                          <span className="lpl-op" aria-hidden="true">=</span>
                          <span className="lpl-chip is-key"><strong>{Math.max(0, c.leaveDaysDefault - c.holidays)}</strong><small>{tr('days to take')}</small></span>
                        </span>}
                    {c.holidays === 0 && <Status tone="bad">{tr('no {year} holidays yet', { year })}</Status>}
                  </span>
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      <Section id="lt-types" title={tr('Leave types')} sub={tr('The company-wide days a year for each type. A person can have their own figure instead (Adjust, below).')}
        action={<button type="button" className="btn btn-secondary lt-btn" onClick={openNewType}>{tr('+ New leave type')}</button>}>
        {allTypes.length ? (
          <div className="lt-types">
            {allTypes.map((t) => {
              const rowsForType = people.flatMap((e) => e.balances.filter((b) => b.leaveTypeId === t.id));
              const used = rowsForType.reduce((n, b) => n + b.used, 0);
              const granted = rowsForType.filter((b) => b.hasRow).reduce((n, b) => n + b.entitled, 0);
              const own = rowsForType.filter((b) => b.custom).length;
              return (
                <article key={t.id} className={'lt-type' + (t.active ? '' : ' is-off')}>
                  <div className="lt-type-top">
                    <strong className="lt-type-name">{t.name}</strong>
                    <RowMenu actions={[{ label: tr('Edit'), onClick: () => openEditType(t) }]} />
                  </div>
                  <span className="lt-type-days">
                    {t.inPool && t.paid ? <><strong>{tr('Yearly total')}</strong> <span className="dk-muted">{tr('shared')}</span></> : t.paid ? <><strong>{t.daysPerYear}</strong> <span className="dk-muted">{tr('days a year')}</span></> : <><strong>{tr('No limit')}</strong> <span className="dk-muted">{tr('unpaid')}</span></>}
                  </span>
                  <span className="lt-type-tags">
                    <Status tone={t.paid ? 'good' : 'muted'}>{t.paid ? tr('Paid') : tr('Unpaid')}</Status>
                    {t.inPool && t.paid && <Status tone="info">{tr('In the yearly total')}</Status>}
                    {!t.active && <Status tone="muted">{tr('Inactive')}</Status>}
                    {own > 0 && <Status tone="info">{own === 1 ? tr('1 own figure') : tr('{n} own figures', { n: own })}</Status>}
                  </span>
                  {t.active && (t.paid ? (
                    <>
                      <span className="dk-track" aria-hidden="true"><span style={{ width: (granted ? Math.min(100, Math.round((used / granted) * 100)) : 0) + '%' }} /></span>
                      <span className="dk-muted lt-small">{tr('{used} of {granted} days taken in {year}', { used, granted, year })}</span>
                    </>
                  ) : <span className="dk-muted lt-small">{tr('{used} days taken in {year}', { used, year })}</span>)}
                  {!t.active && <span className="dk-muted lt-small">{tr('Not offered when asking for leave.')}</span>}
                </article>
              );
            })}
          </div>
        ) : <Empty icon="doc">{tr('No leave types yet.')}</Empty>}
      </Section>

      <Section id="lt-balances" title={tr('Balances for {year}', { year })}
        sub={poolTypes.length
          ? tr('Yearly leave: what each person has left of their total less the {year} company holidays, and what they owe. The other columns are leave types with their own days. Press Adjust to change someone\'s total.', { year })
          : tr('Days left out of each person\'s {year} balance. Grey figures are not granted yet (what they would get). Press Adjust to change someone\'s days.', { year })}>
        <div className="lt-tools">
          <div className="lt-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search name, code, department…')} /></div>
          <select className="input lt-select" value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} aria-label={tr('Filter by department')}>
            <option value="">{tr('All departments')}</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{showCompany ? d.name + ' — ' + d.company : d.name}</option>)}
          </select>
        </div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, n]) => (
            <button key={key || 'all'} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
              {label} <span className="ppl-chip-n">{n}</span>
            </button>
          ))}
        </div>

        {rows.length ? (
          <div className="lt-grid" role="table" aria-label={tr('Balances for {year}', { year })}>
            <div className="lt-row is-head" role="row" style={gridCols}>
              <span role="columnheader">{tr('Employee')}</span>
              {poolTypes.length > 0 && <span role="columnheader" className="lt-cell">{tr('Yearly leave')}</span>}
              {ownTypes.map((t) => <span key={t.id} role="columnheader" className="lt-cell" title={t.name}>{t.name}</span>)}
              {!poolTypes.length && <span role="columnheader">{tr('Agreed total')}</span>}
              <span />
            </div>
            {rows.map((e) => (
              <div key={e.id} className="lt-row" role="row" style={gridCols}>
                <span role="cell" className="lt-who">
                  <Photo id={e.id} name={e.name} photo={e.photo} size={36} />
                  <span className="lt-who-text">
                    <strong>{e.name}</strong>
                    <span className="dk-muted">{e.department}{showCompany ? ' · ' + e.companyCode : ''}{!e.granted ? ' · ' + tr('not granted') : ''}</span>
                  </span>
                </span>
                {poolTypes.length > 0 && (inPool(e) ? (
                  <span role="cell" className={'lt-cell lt-pool' + (e.pool.owedOutstanding > 0 ? ' is-owing' : '')}
                    title={tr('{total} yearly total − {h} company holidays = {a} to take; {u} taken', { total: e.pool.total, h: e.pool.holidays, a: e.pool.available, u: e.pool.used })}>
                    <span className="lt-bal-type">{tr('Yearly leave')}</span>
                    <span className="lt-pool-line">
                      <strong>{e.pool.left}</strong><small>/{Math.max(0, e.pool.available)} {tr('left')}</small>
                      {e.pool.owedOutstanding > 0 && <Status tone="bad">{tr('owes {n}', { n: e.pool.owedOutstanding })}</Status>}
                    </span>
                    <PoolBar pool={e.pool} slim />
                    <span className="lt-pool-sum dk-muted">{tr('{total} − {h} holidays', { total: e.pool.total, h: e.pool.holidays })}{e.pool.totalFrom === 'company' ? ' · ' + tr('company total') : ''}</span>
                  </span>
                ) : <span role="cell" className="lt-cell dk-muted">{tr('No yearly total')}</span>)}
                {e.balances.filter((b) => typeById[b.leaveTypeId] && (!poolTypes.length || !typeById[b.leaveTypeId].inPool)).map((b) => {
                  const t = typeById[b.leaveTypeId];
                  const left = leftOf(b);
                  const cls = !b.hasRow ? ' is-preview' : !t.paid ? '' : left <= 0 && b.entitled > 0 ? ' is-out' : b.entitled > LOW_DAYS && left <= LOW_DAYS ? ' is-low' : '';
                  return (
                    <span key={b.leaveTypeId} role="cell" className={'lt-cell lt-bal' + cls} title={t.name + ': ' + (t.paid ? tr('{left} of {total} days left', { left, total: b.entitled }) : tr('{n} taken', { n: b.used }))}>
                      <span className="lt-bal-type">{t.name}</span>
                      {t.paid ? <><strong>{left}</strong><small>/{b.entitled}</small></> : <><strong>{b.used}</strong><small>{tr('taken')}</small></>}
                      {b.custom && <i className="lt-own" title={tr('Own figure')} aria-label={tr('Own figure')} />}
                    </span>
                  );
                })}
                {!poolTypes.length && (
                  <span role="cell" className="lt-agreed">
                    {e.leaveDaysTotal === null ? <span className="dk-muted">—</span> : (
                      <Status tone={mismatch(e) ? 'bad' : 'good'}>{mismatch(e) ? tr('{a} of {t} split', { a: e.allocated, t: e.leaveDaysTotal }) : tr('{t} days', { t: e.leaveDaysTotal })}</Status>
                    )}
                  </span>
                )}
                <span role="cell" className="lt-row-action">
                  <button type="button" className="btn btn-secondary lt-btn" onClick={() => setAdjust(e)}>{tr('Adjust')}</button>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="dk-empty lt-empty">
            <p>{people.length ? tr('No one matches. Try another search, department or filter.') : tr('No active employees here.')}</p>
            {(search || chip || deptFilter) && <button type="button" className="btn btn-secondary" onClick={() => { setSearch(''); setChip(''); setDeptFilter(''); }}>{tr('Clear filters')}</button>}
          </div>
        )}
      </Section>

      {owed.people.length > 0 && (
        <Section id="lt-owed" title={tr('Owed days in {year}', { year })}
          sub={tr('People who took more leave than their yearly balance. Nothing is deducted by itself: decide how each is settled and record it.')}>
          <ul className="lt-owed">
            {owed.people.filter((x) => !currentCompany || x.company === currentCompany.name).map((x) => (
              <li key={x.employeeId} className={'lt-owed-row' + (x.owedOutstanding > 0 ? ' is-open' : '')}>
                <span className="lt-who">
                  <Photo id={x.employeeId} name={x.name} photo={(photoById[x.employeeId] || {}).photo} size={40} />
                  <span className="lt-who-text">
                    <strong>{x.name}</strong>
                    <span className="dk-muted">{x.code} · {x.department}{showCompany ? ' · ' + x.company : ''}</span>
                  </span>
                </span>
                <span className="lt-owed-math">
                  <PoolBar pool={x} slim />
                  <span className="dk-muted">{tr('{used} taken of {avail} ({total} − {h} holidays)', { used: x.used, avail: Math.max(0, x.available), total: x.total, h: x.holidays })}</span>
                </span>
                <span className="lt-owed-n">
                  {x.owedOutstanding > 0 ? <Status tone="bad">{tr('owes {n} day(s)', { n: x.owedOutstanding })}</Status> : <Status tone="good">{tr('settled')}</Status>}
                  {x.settlements.map((st) => <span key={st.id} className="dk-muted lt-small">{tr('{n} {how}', { n: st.days, how: HOW_TEXT()[st.how] })}{st.note ? ' — ' + st.note : ''} · {fmtDate(st.at)}{st.by ? ' · ' + st.by : ''}</span>)}
                </span>
                {x.owedOutstanding > 0 && <button type="button" className="btn btn-primary lt-btn" onClick={() => setSettleFor(x)}>{tr('Mark settled')}</button>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section id="lt-holidays" title={tr('Public holidays in {year}', { year })}
        sub={poolTypes.length
          ? tr('Each company keeps its own list for each year, and the number can differ from year to year. A year\'s holidays come off everyone\'s yearly total on 1 January; adding or removing one changes the balances at once. A holiday inside someone\'s leave is not charged again.')
          : tr('Each company keeps its own list. These aren\'t subtracted from anyone\'s entitlement — a holiday that falls inside an approved leave request simply isn\'t charged against the balance, the same way Sundays aren\'t.')}>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Company')}>
          {sortedCompanies.map((c) => {
            const n = overview.holidays.filter((h) => h.companyId === c.id).length;
            return (
              <button key={c.id} type="button" role="radio" aria-checked={holidayCompanyId === c.id} className={'ppl-chip' + (holidayCompanyId === c.id ? ' is-on' : '')} onClick={() => setHolidayCompanyId(c.id)}>
                {c.name} <span className="ppl-chip-n">{n}</span>
              </button>
            );
          })}
        </div>
        {holidayError && <div className="error-banner">{holidayError}</div>}
        {holidayList.length ? (
          <ul className="lt-holidays">
            {holidayList.map((h) => {
              const d = new Date(h.date + 'T00:00');
              const past = h.date < today;
              const sunday = d.getDay() === 0;
              return (
                <li key={h.id} className={'lt-holiday' + (past ? ' is-past' : '')}>
                  <span className="lt-holiday-date">
                    <strong>{d.getDate()}</strong>
                    <small>{d.toLocaleDateString(activeIntlLocale(), { month: 'short' })}</small>
                  </span>
                  <span className="lt-holiday-text">
                    <strong>{h.name}</strong>
                    <span className="dk-muted">{d.toLocaleDateString(activeIntlLocale(), { weekday: 'long' })}{sunday ? ' · ' + tr('a Sunday, already not counted') : ''}{h.date === today ? ' · ' + tr('today') : ''}</span>
                  </span>
                  <RowMenu actions={[{ label: tr('Remove'), onClick: () => removeHoliday(h), danger: true }]} />
                </li>
              );
            })}
          </ul>
        ) : <Empty icon="calendar">{tr('No holidays recorded for this company/year yet.')}</Empty>}
        <form className="lt-holiday-form" onSubmit={addHoliday}>
          <div className="field">
            <label htmlFor="lt-holiday-date">{tr('Date')}</label>
            <input id="lt-holiday-date" type="date" className="input" value={holidayForm.date} onChange={(e) => setHolidayForm({ ...holidayForm, date: e.target.value })} required />
          </div>
          <div className="field lt-holiday-name">
            <label htmlFor="lt-holiday-name">{tr('Name')}</label>
            <input id="lt-holiday-name" className="input" value={holidayForm.name} onChange={(e) => setHolidayForm({ ...holidayForm, name: e.target.value })} placeholder={tr('e.g. Independence Day')} required />
          </div>
          <button type="submit" className="btn btn-secondary" disabled={holidaySaving || !holidayCompanyId}>{holidaySaving ? tr('Adding…') : tr('+ Add holiday')}</button>
        </form>
      </Section>

      <Section id="lt-newyear" title={tr('Year rollover')} sub={tr('Gives every active employee a balance for each leave type for the year you pick, from their days a year. Safe to run more than once: it never changes a balance that already exists, including one you corrected.')} card>
        <div className="lt-rollover">
          <label className="lt-year">
            <span>{tr('Year')}</span>
            <input className="input lt-num" value={rolloverYear} onChange={(e) => setRolloverYear(e.target.value)} inputMode="numeric" />
          </label>
          <button type="button" className="btn btn-primary" disabled={rolloverRunning} onClick={() => runRollover(rolloverYear)}>
            {rolloverRunning ? tr('Granting…') : tr('Grant balances for this year')}
          </button>
        </div>
        {rolloverError && <div className="error-banner">{rolloverError}</div>}
        {rolloverResult && (
          <p className="lt-ok">{tr('Granted {granted} new balance record(s) for {year}, across {employees} active employee(s) and {types} leave type(s).', { granted: rolloverResult.granted, year: rolloverResult.year, employees: rolloverResult.employees, types: rolloverResult.types })}</p>
        )}
      </Section>

      <Glossary items={[
        [tr('Days a year'), tr('What a leave type is worth each year for everyone, unless a person has their own figure.')],
        [tr('Own figure'), tr('A person\'s own days a year for a type (seniority, a negotiated offer). It carries over to every year until changed.')],
        [tr('Balance'), tr('What a person can take in one year for a type. It is granted at the start of the year (or at their first request) from their days a year.')],
        [tr('Used and left'), tr('Used goes up only when leave is approved. Left is the balance less what has been used.')],
        poolTypes.length
          ? [tr('Yearly leave total'), tr('The days a year agreed with a person, or their company\'s default. That year\'s company holidays come off it on 1 January; annual, compassionate and sick leave are taken from what remains.')]
          : [tr('Agreed total'), tr('An optional record of the total days agreed with a person, checked against how it is split across the types. It does not limit any request.')],
        poolTypes.length && [tr('Owed days'), tr('Leave taken beyond what was left. It is allowed, recorded against the person, and settled by HR: from pay, from next year\'s leave, waived, or another way.')],
        [tr('Paid and unpaid'), tr('Paid types have a limit and come off the balance. Unpaid leave has no limit.')],
        [tr('Public holidays'), tr('Days a company is closed. A holiday inside a leave request is not charged, like a Sunday.')]
      ].filter(Boolean)} />

      {adjust && <AdjustDialog employee={adjust} year={year} onClose={() => setAdjust(null)} onChanged={() => loadOverview(year)} />}
      {settleFor && <SettleDialog person={settleFor} year={year} onClose={() => setSettleFor(null)} onDone={(name) => { setSettleFor(null); setToast(tr('Recorded how {name}\'s owed days were settled.', { name })); loadOverview(year); }} />}

      {typeDialog && (
        <div className="dialog-backdrop" onClick={() => setTypeDialog(null)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveType}>
            <h2>{typeDialog.mode === 'new' ? tr('New leave type') : tr('Edit leave type')}</h2>
            {typeError && <div className="error-banner">{typeError}</div>}
            <div className="field">
              <label htmlFor="lt-name">{tr('Name')}</label>
              <input id="lt-name" className="input" value={typeForm.name} onChange={(e) => setTypeForm({ ...typeForm, name: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="lt-days">{tr('Days per year')}</label>
              <input id="lt-days" className="input" value={typeForm.daysPerYear} onChange={(e) => setTypeForm({ ...typeForm, daysPerYear: e.target.value })} inputMode="numeric" required />
              <span className="lt-small dk-muted">{tr('The company-wide default for this type. A person can have their own figure instead: press Adjust next to them under Balances.')}</span>
            </div>
            <label className="lt-check">
              <input type="checkbox" checked={typeForm.paid} onChange={(e) => setTypeForm({ ...typeForm, paid: e.target.checked })} />
              {tr('Paid leave')}
            </label>
            {typeForm.paid && (
              <label className="lt-check">
                <input type="checkbox" checked={typeForm.inPool} onChange={(e) => setTypeForm({ ...typeForm, inPool: e.target.checked })} />
                {tr('Comes out of the yearly leave total (like annual, compassionate and sick leave)')}
              </label>
            )}
            {typeDialog.mode === 'edit' && (
              <label className="lt-check">
                <input type="checkbox" checked={typeForm.active} onChange={(e) => setTypeForm({ ...typeForm, active: e.target.checked })} />
                {tr('Active (shown when requesting leave)')}
              </label>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setTypeDialog(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={typeSaving}>{typeSaving ? tr('Saving…') : tr('Save')}</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
