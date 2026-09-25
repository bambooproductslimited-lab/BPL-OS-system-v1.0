import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import RowMenu from '../components/RowMenu';
import { Glossary, Hero, Insights, PairBars, Section, Status, avatarColor, fmtDate, initials, jump } from '../components/DashKit';
import { money } from '../lib/currency';
import { downloadCsv, rowsToCsv } from '../lib/csvExport';
import { activeIntlLocale, tr, msg } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './RestaurantsPage.css';
import './PokiRentals.css';
import './CustomersPage.css';
import './EstimatesPage.css';
import './PayrollPage.css';

// Payroll — paying staff. Employees earn a daily rate on one of three
// cycles (monthly, biweekly, or daily for staff paid per day worked). A
// pay run makes one payslip per active employee on the cycle, with days
// worked taken from Attendance and SSNIT/PAYE worked out
// (payroll.service.js; see computePaye() in utils/payroll.js for the
// caveat on the tax figures). Days stay editable while the run is a draft,
// then lock once approved.
//
// Same "explains itself" layout as the dashboards (components/DashKit.jsx):
// what the last run cost and what it owes GRA and SSNIT, runs waiting to be
// approved or paid, the cost over six months; what stands out (a month not
// run yet, a run past its pay date, payslips with no days worked, staff
// with no daily rate); take-home pay against tax and SSNIT by month; the
// runs as cards or a list, each opening a window with its payslips; and
// one person's pay history. Runs on the same cycle can't overlap
// (payroll.service.js create), so nobody is paid twice for the same days.

const STEPS = [{ key: 'draft', label: msg('Draft') }, { key: 'approved', label: msg('Approved') }, { key: 'paid', label: msg('Paid') }];
const CYCLES = [['monthly', msg('Monthly')], ['biweekly', msg('Biweekly')], ['daily', msg('Daily')]];

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function todayIso() { return iso(new Date()); }
function lastMonth() {
  const t = new Date();
  const start = new Date(t.getFullYear(), t.getMonth() - 1, 1);
  const end = new Date(t.getFullYear(), t.getMonth(), 0);
  return { start: iso(start), end: iso(end), pay: iso(new Date(t.getFullYear(), t.getMonth(), 5)) };
}
function monthName(isoDate) { return new Date(String(isoDate).slice(0, 10) + 'T00:00').toLocaleDateString(activeIntlLocale(), { month: 'long', year: 'numeric' }); }
function periodText(r) {
  const a = new Date(String(r.periodStart).slice(0, 10) + 'T00:00'), b = new Date(String(r.periodEnd).slice(0, 10) + 'T00:00');
  const wholeMonth = a.getDate() === 1 && new Date(b.getFullYear(), b.getMonth() + 1, 0).getDate() === b.getDate() && a.getMonth() === b.getMonth();
  return wholeMonth ? monthName(r.periodStart) : fmtDate(r.periodStart) + ' – ' + fmtDate(r.periodEnd);
}
function cycleLabel(c) { return tr((CYCLES.find(([k]) => k === c) || CYCLES[0])[1]); }
function statusTone(s) { return s === 'paid' ? 'good' : s === 'approved' ? 'info' : 'warn'; }
function toAuthorities(t) { return (t.ssnitEmployee || 0) + (t.ssnitEmployer || 0) + (t.paye || 0); }

function Mark({ name, size = 36 }) {
  return <span className="pk-avatar cu-mark" style={{ width: size, height: size, background: avatarColor(name), fontSize: Math.round(size * 0.36) }} aria-hidden="true">{initials(name)}</span>;
}

const EMPTY_FORM = { cycle: 'monthly', periodStart: '', periodEnd: '', payDate: todayIso(), companyId: '' };

export default function PayrollPage() {
  const { can } = useAuth();
  const canManage = can('payroll.manage');

  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);

  const [activeRun, setActiveRun] = useState(null);
  const [runError, setRunError] = useState(null);
  const [runBusy, setRunBusy] = useState(false);
  const [editingSlip, setEditingSlip] = useState(null);
  const [editDays, setEditDays] = useState('');
  const [slipSearch, setSlipSearch] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [search, setSearch] = useState('');
  const [chip, setChip] = useState('all');
  const [view, setView] = useState(() => readPref('bos.payrollView', 'cards'));
  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [companyFilter, setCompanyFilter] = useState('');
  const [employeeFilter, setEmployeeFilter] = useState('');
  const [history, setHistory] = useState(null);
  const [historyError, setHistoryError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams();
      if (companyFilter) params.set('companyId', companyFilter);
      setRuns(await api.get('/payroll/runs?' + params.toString()));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [companyFilter]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/employees').then(setEmployees).catch(() => setEmployees([]));
    api.get('/departments').then(setDepartments).catch(() => setDepartments([]));
  }, []);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // Departments carry companyId/companyName (departments.service.js list),
  // so the company list comes from that one fetch, as on Employees.
  const companies = useMemo(() => {
    const seen = new Map();
    departments.forEach((d) => { if (!seen.has(d.companyId)) seen.set(d.companyId, { id: d.companyId, name: d.companyName }); });
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [departments]);
  const deptCompany = useMemo(() => new Map(departments.map((d) => [d.id, d.companyId])), [departments]);
  const staff = useMemo(() => employees.filter((e) => e.status === 'active' && (!companyFilter || deptCompany.get(e.departmentId) === companyFilter)), [employees, companyFilter, deptCompany]);

  useEffect(() => {
    if (!employeeFilter) { setHistory(null); return undefined; }
    let cancelled = false;
    setHistoryError(null);
    api.get('/payroll/payslips?employeeId=' + employeeFilter)
      .then((res) => { if (!cancelled) setHistory(res); })
      .catch((err) => { if (!cancelled) setHistoryError(err.message); });
    return () => { cancelled = true; };
  }, [employeeFilter]);

  function openNew(cycle) {
    setDialogError(null);
    const lm = lastMonth();
    setForm({ ...EMPTY_FORM, cycle: cycle || 'monthly', periodStart: lm.start, periodEnd: lm.end, payDate: lm.pay < todayIso() ? todayIso() : lm.pay, companyId: companyFilter });
    setDialogOpen(true);
  }
  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      const created = await api.post('/payroll/runs', form);
      setToast(tr('{runNo} created with {n} payslip(s).', { runNo: created.runNo, n: created.payslips.length }));
      setDialogOpen(false);
      await load();
      setActiveRun(created);
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }
  async function openRun(id) {
    setRunError(null);
    setEditingSlip(null);
    setSlipSearch('');
    setConfirmDelete(false);
    try {
      setActiveRun(await api.get('/payroll/runs/' + id));
    } catch (err) {
      setError(err.message);
    }
  }
  async function runAction(fn, done) {
    setRunBusy(true);
    setRunError(null);
    try {
      const updated = await fn();
      if (done) setToast(done(updated));
      await load();
      return updated;
    } catch (err) {
      setRunError(err.message);
      return null;
    } finally {
      setRunBusy(false);
    }
  }
  async function saveSlipEdit(employeeId) {
    const updated = await runAction(() => api.put('/payroll/runs/' + activeRun.id + '/payslips/' + employeeId, { daysWorked: editDays }));
    if (updated) { setActiveRun(updated); setEditingSlip(null); }
  }
  async function approveRun() {
    const updated = await runAction(() => api.post('/payroll/runs/' + activeRun.id + '/approve'), (u) => tr('{runNo} approved.', { runNo: u.runNo }));
    if (updated) setActiveRun(updated);
  }
  async function markPaid() {
    const updated = await runAction(() => api.post('/payroll/runs/' + activeRun.id + '/paid'), (u) => tr('{runNo} marked paid.', { runNo: u.runNo }));
    if (updated) setActiveRun(updated);
  }
  async function deleteRun() {
    const no = activeRun.runNo;
    const ok = await runAction(() => api.del('/payroll/runs/' + activeRun.id), () => tr('{runNo} deleted.', { runNo: no }));
    if (ok) setActiveRun(null);
  }
  function exportRun(run) {
    const rows = [[tr('Employee'), tr('Code'), tr('Company'), tr('Department'), tr('Days'), tr('Daily rate'), tr('Gross'), 'SSNIT', 'PAYE', tr('Net'), tr('SSNIT (employer)')]]
      .concat(run.payslips.map((s) => [s.employeeName, s.employeeCode, s.companyName, s.departmentName, s.daysWorked, s.dailyRate, s.grossPay, s.ssnitEmployee, s.payeTax, s.netPay, s.ssnitEmployer]));
    downloadCsv(run.runNo + '.csv', rowsToCsv(rows));
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const done = runs.filter((r) => r.status !== 'draft');
  const latest = done[0] || runs[0];
  const drafts = runs.filter((r) => r.status === 'draft');
  const unpaid = runs.filter((r) => r.status === 'approved');
  const overdue = unpaid.filter((r) => String(r.payDate).slice(0, 10) < todayIso());
  const zeroDrafts = drafts.filter((r) => r.zeroDays > 0);
  const sixAgo = (() => { const t = new Date(); return iso(new Date(t.getFullYear(), t.getMonth() - 5, 1)); })();
  const recent = done.filter((r) => String(r.periodEnd).slice(0, 10) >= sixAgo);
  const cost6 = recent.reduce((s, r) => s + r.totals.cost, 0);
  const lm = lastMonth();
  const monthlyStaff = employees.filter((e) => e.status === 'active' && e.payCycle === 'monthly');
  const monthlyMissing = monthlyStaff.length > 0 && !runs.some((r) => r.cycle === 'monthly' && String(r.periodStart).slice(0, 10) <= lm.end && String(r.periodEnd).slice(0, 10) >= lm.start);
  const noRate = employees.filter((e) => e.status === 'active' && e.dailyRate !== undefined && !(e.dailyRate > 0));
  const prevSame = latest ? done.find((r) => r.id !== latest.id && r.cycle === latest.cycle && (r.companyId || '') === (latest.companyId || '')) : null;
  const change = latest && prevSame && prevSame.totals.cost > 0 ? Math.round(((latest.totals.cost - prevSame.totals.cost) / prevSame.totals.cost) * 100) : null;

  function showOnly(key) { setChip(chip === key ? 'all' : key); jump('pr-list'); }
  const stats = [
    { icon: 'people', value: latest ? money(latest.totals.cost) : '—', label: tr('the last pay run cost'), note: latest ? tr('{runNo}: {n} people, {net} take-home', { runNo: latest.runNo, n: latest.employeeCount, net: money(latest.totals.net) }) : tr('no pay runs yet'), onClick: () => latest && openRun(latest.id) },
    { icon: 'scale', value: latest ? money(toAuthorities(latest.totals)) : '—', label: tr('to GRA and SSNIT from it'), note: latest ? tr('PAYE {paye} · SSNIT {ssnit}', { paye: money(latest.totals.paye), ssnit: money(latest.totals.ssnitEmployee + latest.totals.ssnitEmployer) }) : '—', onClick: () => latest && openRun(latest.id) },
    { icon: 'clock', value: String(drafts.length + unpaid.length), label: tr('runs waiting'), note: tr('{d} to approve, {p} to pay', { d: drafts.length, p: unpaid.length }), tone: overdue.length ? 'bad' : drafts.length + unpaid.length ? 'warn' : 'good', onClick: () => showOnly('waiting') },
    { icon: 'cash', value: money(cost6), label: tr('payroll cost, last 6 months'), note: change === null ? tr('{n} runs approved or paid', { n: recent.length }) : change >= 0 ? tr('the last run cost {pct}% more than the one before', { pct: change }) : tr('the last run cost {pct}% less than the one before', { pct: -change }), onClick: () => jump('pr-months') }
  ];

  const insights = [];
  if (overdue.length) insights.push({ tone: 'bad', icon: 'warn', text: overdue.length === 1 ? tr('{runNo} was due to be paid on {date} and isn\'t marked paid.', { runNo: overdue[0].runNo, date: fmtDate(overdue[0].payDate) }) : tr('{n} approved runs are past their pay date and not marked paid.', { n: overdue.length }), action: { label: overdue.length === 1 ? tr('Open') : tr('Show them'), run: () => (overdue.length === 1 ? openRun(overdue[0].id) : showOnly('approved')) } });
  if (monthlyMissing) insights.push({ tone: 'warn', icon: 'calendar', text: tr('No monthly pay run covers {month} yet, for {n} staff on the monthly cycle.', { month: monthName(lm.start), n: monthlyStaff.length }), action: canManage ? { label: tr('Make it'), run: () => openNew('monthly') } : null });
  if (zeroDrafts.length) insights.push({ tone: 'warn', icon: 'people', text: zeroDrafts.length === 1 ? (zeroDrafts[0].zeroDays === 1 ? tr('Someone in {runNo} has no days worked. Check Attendance before approving.', { runNo: zeroDrafts[0].runNo }) : tr('{n} people in {runNo} have no days worked. Check Attendance before approving.', { n: zeroDrafts[0].zeroDays, runNo: zeroDrafts[0].runNo })) : tr('{n} draft runs have payslips with no days worked. Check Attendance before approving.', { n: zeroDrafts.length }), action: { label: tr('Open'), run: () => openRun(zeroDrafts[0].id) } });
  if (drafts.length && !zeroDrafts.length) insights.push({ tone: 'info', icon: 'check', text: drafts.length === 1 ? tr('{runNo} is waiting to be approved.', { runNo: drafts[0].runNo }) : tr('{n} pay runs are waiting to be approved.', { n: drafts.length }), action: { label: drafts.length === 1 ? tr('Open') : tr('Show them'), run: () => (drafts.length === 1 ? openRun(drafts[0].id) : showOnly('draft')) } });
  if (noRate.length) insights.push({ tone: 'warn', icon: 'owed', text: noRate.length === 1 ? tr('{name} has no daily rate, so their payslips come out at zero.', { name: noRate[0].firstName + ' ' + noRate[0].lastName }) : tr('{n} active staff have no daily rate, so their payslips come out at zero.', { n: noRate.length }), action: null });
  if (!insights.length && runs.length) insights.push({ tone: 'good', icon: 'check', text: tr('Every pay run is approved and paid, and last month is covered.') });

  // the last six months, by the month each run's period ends in
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const t = new Date(); const d = new Date(t.getFullYear(), t.getMonth() - i, 1);
    const key = iso(d).slice(0, 7);
    const inMonth = done.filter((r) => String(r.periodEnd).slice(0, 7) === key);
    months.push({ label: d.toLocaleDateString(activeIntlLocale(), { month: 'short' }), a: inMonth.reduce((s, r) => s + r.totals.net, 0), b: inMonth.reduce((s, r) => s + toAuthorities(r.totals), 0) });
  }

  const chipTest = { all: () => true, waiting: (r) => r.status !== 'paid', draft: (r) => r.status === 'draft', approved: (r) => r.status === 'approved', paid: (r) => r.status === 'paid', monthly: (r) => r.cycle === 'monthly', biweekly: (r) => r.cycle === 'biweekly', daily: (r) => r.cycle === 'daily' };
  const visible = runs.filter(chipTest[chip] || chipTest.all).filter((r) => matchesQuery(search, r.runNo, r.companyName, periodText(r), cycleLabel(r.cycle)));
  const chips = [
    ['all', tr('All'), runs.length], ['waiting', tr('Waiting'), drafts.length + unpaid.length], ['draft', tr('To approve'), drafts.length], ['approved', tr('To pay'), unpaid.length],
    ['paid', tr('Paid'), runs.filter(chipTest.paid).length], ...CYCLES.map(([k, l]) => [k, tr(l), runs.filter(chipTest[k]).length])
  ].filter(([k, , c]) => c > 0 || k === 'all' || k === chip);

  function stateOf(r) {
    if (r.status === 'paid') return { tone: 'good', text: tr('Paid') };
    if (r.status === 'approved') return String(r.payDate).slice(0, 10) < todayIso() ? { tone: 'bad', text: tr('Approved · pay date passed') } : { tone: 'info', text: tr('Approved · pay on {date}', { date: fmtDate(r.payDate) }) };
    return r.zeroDays ? { tone: 'warn', text: tr('Draft · {n} with no days', { n: r.zeroDays }) } : { tone: 'warn', text: tr('Draft · to approve') };
  }

  const run = activeRun;
  const slips = run ? run.payslips.filter((s) => (!companyFilter || s.companyId === companyFilter) && matchesQuery(slipSearch, s.employeeName, s.employeeCode, s.departmentName, s.positionTitle)) : [];
  const stepAt = run ? STEPS.findIndex((s) => s.key === run.status) : 0;
  const newStaff = employees.filter((e) => e.status === 'active' && e.payCycle === form.cycle && (!form.companyId || deptCompany.get(e.departmentId) === form.companyId));

  return (
    <div className="dk tl pk cu prl">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Finance')}
        title={tr('Payroll')}
        sub={tr('Paying staff: what each pay run cost, what goes to GRA and SSNIT, and which runs still need approving or paying. Days worked come from Attendance.')}
        actions={(
          <>
            {canManage && <button type="button" className="btn btn-primary" onClick={() => openNew()}>{tr('New pay run')}</button>}
            {companies.length > 1 && (
              <select className="input prl-company" value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)} aria-label={tr('Company')}>
                <option value="">{tr('All companies')}</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
          </>
        )}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <Section id="pr-months" title={tr('Take-home pay and deductions, by month')} sub={tr('Approved and paid runs over the last six months, by the month their period ends. Deductions are PAYE plus SSNIT from staff and employer.')} card>
        <PairBars rows={months} aLabel={tr('Take-home pay')} bLabel={tr('PAYE and SSNIT')} format={(n) => money(n)} />
      </Section>

      <Section id="pr-list" title={tr('Pay runs')} sub={tr('Press a run to see every payslip, change days worked while it is a draft, approve it and mark it paid.')}
        action={(
          <div className="ppl-view" role="radiogroup" aria-label={tr('View')}>
            {[['cards', tr('Cards')], ['list', tr('List')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'is-on' : ''} onClick={() => { setView(k); writePref('bos.payrollView', k); }}>{label}</button>
            ))}
          </div>
        )}>
        <div className="tl-tools"><div className="tl-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search pay runs…')} /></div></div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
        </div>
        {!visible.length ? (
          <div className="dk-empty tl-empty">
            <p>{runs.length ? tr('Nothing matches. Try another search or filter.') : tr('No pay runs yet')}</p>
            {canManage && !runs.length && <button type="button" className="btn btn-primary" onClick={() => openNew()}>{tr('New pay run')}</button>}
          </div>
        ) : view === 'cards' ? (
          <div className="tl-grid">
            {visible.map((r) => {
              const st = stateOf(r);
              return (
                <article key={r.id} className={'tl-card' + (st.tone === 'bad' ? ' st-late' : '')}>
                  <button type="button" className="tl-card-open" onClick={() => openRun(r.id)}>
                    <span className={'pk-unit-code prl-cycle is-' + r.cycle} aria-hidden="true">{cycleLabel(r.cycle).slice(0, 1)}</span>
                    <span className="tl-card-head">
                      <span className="dk-muted tl-small">{r.runNo} · {cycleLabel(r.cycle)} · {r.companyName === 'All companies' ? tr('All companies') : r.companyName}</span>
                      <span className="tl-name">{periodText(r)}</span>
                    </span>
                  </button>
                  <span className="tl-menu"><RowMenu actions={[{ label: tr('Open'), onClick: () => openRun(r.id) }]} /></span>
                  <div className="tl-tags"><Status tone={st.tone}>{st.text}</Status></div>
                  <div className="tl-foot">
                    <span className="iv-owe"><span className="es-total">{money(r.totals.net)}</span><span className="dk-muted tl-small">{tr('take-home for {n} people', { n: r.employeeCount })}</span></span>
                    <span className="dk-muted tl-small prl-cost">{tr('cost {amount}', { amount: money(r.totals.cost) })}</span>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="tl-table-wrap">
            <table className="tl-table">
              <thead><tr><th>{tr('Run')}</th><th>{tr('Period')}</th><th>{tr('Pay date')}</th><th className="is-num">{tr('People')}</th><th className="is-num">{tr('Take-home')}</th><th className="is-num">{tr('PAYE and SSNIT')}</th><th className="is-num">{tr('Cost')}</th><th>{tr('Where it stands')}</th></tr></thead>
              <tbody>
                {visible.map((r) => {
                  const st = stateOf(r);
                  return (
                    <tr key={r.id}>
                      <td><button type="button" className="tl-row-open" onClick={() => openRun(r.id)}><span className="tl-name">{r.runNo}</span></button><span className="dk-muted tl-small">{cycleLabel(r.cycle)} · {r.companyName === 'All companies' ? tr('All companies') : r.companyName}</span></td>
                      <td>{periodText(r)}</td>
                      <td>{fmtDate(r.payDate)}</td>
                      <td className="is-num">{r.employeeCount}</td>
                      <td className="is-num">{money(r.totals.net)}</td>
                      <td className="is-num">{money(toAuthorities(r.totals))}</td>
                      <td className="is-num">{money(r.totals.cost)}</td>
                      <td><Status tone={st.tone}>{st.text}</Status></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section id="pr-person" title={tr('One person\'s pay')} sub={tr('Every payslip for one employee, newest first.')} card>
        <select className="input prl-person" value={employeeFilter} onChange={(e) => setEmployeeFilter(e.target.value)} aria-label={tr('Employee')}>
          <option value="">{tr('Choose an employee…')}</option>
          {staff.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
        </select>
        {historyError && <div className="error-banner">{historyError}</div>}
        {history && (history.payslips.length ? (
          <div className="tl-table-wrap prl-history">
            <table className="tl-table">
              <thead><tr><th>{tr('Pay date')}</th><th>{tr('Run')}</th><th>{tr('Period')}</th><th className="is-num">{tr('Days')}</th><th className="is-num">{tr('Gross')}</th><th className="is-num">SSNIT</th><th className="is-num">PAYE</th><th className="is-num">{tr('Net')}</th><th>{tr('Status')}</th></tr></thead>
              <tbody>
                {history.payslips.map((s) => (
                  <tr key={s.id}>
                    <td>{fmtDate(s.payDate)}</td>
                    <td><button type="button" className="tl-row-open" onClick={() => openRun(s.payRunId)}><span className="tl-name">{s.runNo}</span></button></td>
                    <td>{periodText(s)}</td>
                    <td className="is-num">{s.daysWorked}</td>
                    <td className="is-num">{money(s.grossPay)}</td>
                    <td className="is-num">{money(s.ssnitEmployee)}</td>
                    <td className="is-num">{money(s.payeTax)}</td>
                    <td className="is-num"><strong>{money(s.netPay)}</strong></td>
                    <td><Status tone={statusTone(s.runStatus)}>{codeLabel(s.runStatus)}</Status></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="dk-muted tl-small">{tr('No payslips for {employeeName} yet.', { employeeName: history.employeeName })}</p>)}
      </Section>

      <Glossary items={[
        [tr('Pay run'), tr('One payment of every active employee on a cycle, for a period. It holds one payslip each.')],
        [tr('Take-home'), tr('What staff receive: gross pay less their SSNIT and PAYE.')],
        [tr('Cost'), tr('What the company pays in all: gross pay plus the employer\'s SSNIT.')],
        ['SSNIT', tr('Social security: a share taken from staff pay plus a share the employer adds on top, both paid to SSNIT.')],
        ['PAYE', tr('Income tax taken from staff pay and paid to GRA.')],
        [tr('Days worked'), tr('Present or late days in Attendance for the period. They can be changed while the run is a draft.')]
      ]} />

      {/* ── one pay run ── */}
      {run && (
        <div className="dialog-backdrop" onClick={() => !runBusy && setActiveRun(null)}>
          <div className="dialog tl-dialog prl-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="tl-detail-head">
              <span className={'pk-unit-code is-big prl-cycle is-' + run.cycle} aria-hidden="true">{cycleLabel(run.cycle).slice(0, 1)}</span>
              <div>
                <span className="dk-muted tl-small">{run.runNo} · {cycleLabel(run.cycle)} · {run.companyName === 'All companies' ? tr('All companies') : run.companyName}</span>
                <h2>{periodText(run)}</h2>
                <div className="tl-tags"><Status tone={stateOf({ ...run, zeroDays: run.payslips.filter((s) => s.daysWorked === 0).length }).tone}>{stateOf({ ...run, zeroDays: run.payslips.filter((s) => s.daysWorked === 0).length }).text}</Status></div>
              </div>
              <button type="button" className="tl-close" onClick={() => setActiveRun(null)} aria-label={tr('Close')}>×</button>
            </div>
            <ol className="es-path" aria-label={tr('Where it stands')}>
              {STEPS.map((s, i) => <li key={s.key} className={i <= stepAt ? 'is-done' : ''}>{tr(s.label)}</li>)}
            </ol>
            {runError && <div className="error-banner">{runError}</div>}
            <dl className="tl-facts">
              <div><dt>{tr('Take-home')}</dt><dd><strong>{money(run.totals.net)}</strong></dd></div>
              <div><dt>PAYE</dt><dd>{money(run.totals.paye)}</dd></div>
              <div><dt>{tr('SSNIT, staff + employer')}</dt><dd>{money(run.totals.ssnitEmployee)} + {money(run.totals.ssnitEmployer)}</dd></div>
              <div><dt>{tr('Cost')}</dt><dd><strong>{money(run.totals.cost)}</strong></dd></div>
              <div><dt>{tr('Pay date')}</dt><dd>{fmtDate(run.payDate)}</dd></div>
              <div><dt>{tr('Made / approved')}</dt><dd>{run.createdByName || '—'}{run.approvedByName ? ' · ' + run.approvedByName + (run.approvedAt ? ', ' + fmtDate(run.approvedAt) : '') : ''}</dd></div>
            </dl>
            <div className="prl-slip-head">
              <h3 className="tl-h3">{tr('Payslips ({n})', { n: run.payslips.length })}</h3>
              {run.payslips.length > 6 && <div className="tl-search"><SearchInput value={slipSearch} onChange={setSlipSearch} placeholder={tr('Search people…')} /></div>}
            </div>
            {companyFilter && !run.companyId && <p className="dk-muted tl-small">{tr('Showing {n} of {n2} payslip(s) — filtered to {name}. Clear the Company filter above to see everyone in this run.', { n: run.payslips.filter((s) => s.companyId === companyFilter).length, n2: run.payslips.length, name: (companies.find((c) => c.id === companyFilter) || {}).name })}</p>}
            <ul className="rs-list prl-slips">
              {slips.map((s) => (
                <li key={s.employeeId} className={'rs-row' + (s.daysWorked === 0 ? ' is-short' : '')}>
                  <div className="rs-row-open prl-slip">
                    <Mark name={s.employeeName} />
                    <span className="rs-row-main">
                      <strong>{s.employeeName}</strong>
                      <span className="dk-muted tl-small">{[s.employeeCode, s.positionTitle, s.departmentName].filter(Boolean).join(' · ')}</span>
                      <span className="dk-muted tl-small">
                        {editingSlip === s.employeeId ? (
                          <span className="prl-days-edit">
                            <input className="input" type="number" min="0" max={run.periodDays} step="0.5" value={editDays} onChange={(e) => setEditDays(e.target.value)} aria-label={tr('Days worked')} autoFocus />
                            <button type="button" className="btn btn-primary" disabled={runBusy} onClick={() => saveSlipEdit(s.employeeId)}>{tr('Save')}</button>
                            <button type="button" className="btn btn-secondary" onClick={() => setEditingSlip(null)}>{tr('Cancel')}</button>
                          </span>
                        ) : tr('{d} days × {rate} = {gross} gross · PAYE {paye} · SSNIT {ssnit}', { d: s.daysWorked, rate: money(s.dailyRate), gross: money(s.grossPay), paye: money(s.payeTax), ssnit: money(s.ssnitEmployee) })}
                      </span>
                    </span>
                    <span className="rs-row-side">
                      <strong className="rs-amount">{money(s.netPay)}</strong>
                      <span className="dk-muted tl-small">{tr('take-home')}</span>
                    </span>
                  </div>
                  {canManage && run.status === 'draft' && editingSlip !== s.employeeId && <span className="rs-row-menu"><RowMenu actions={[{ label: tr('Change days worked'), onClick: () => { setEditingSlip(s.employeeId); setEditDays(String(s.daysWorked)); } }]} /></span>}
                </li>
              ))}
            </ul>
            {!slips.length && <p className="dk-muted tl-small">{tr('No payslips match.')}</p>}
            {confirmDelete ? (
              <div className="dialog-actions tl-actions">
                <span className="dk-muted tl-small prl-confirm">{tr('Delete this draft and its {n} payslips?', { n: run.payslips.length })}</span>
                <button type="button" className="btn btn-secondary" onClick={() => setConfirmDelete(false)}>{tr('Cancel')}</button>
                <button type="button" className="btn btn-primary" disabled={runBusy} onClick={deleteRun}>{tr('Delete')}</button>
              </div>
            ) : (
              <div className="dialog-actions tl-actions">
                {canManage && run.status === 'draft' && <button type="button" className="btn btn-secondary" onClick={() => setConfirmDelete(true)}>{tr('Delete')}</button>}
                <button type="button" className="btn btn-secondary" onClick={() => exportRun(run)}>{tr('Download CSV')}</button>
                {canManage && run.status === 'draft' && <button type="button" className="btn btn-primary" disabled={runBusy} onClick={approveRun}>{runBusy ? tr('Approving…') : tr('Approve')}</button>}
                {canManage && run.status === 'approved' && <button type="button" className="btn btn-primary" disabled={runBusy} onClick={markPaid}>{runBusy ? tr('Saving…') : tr('Mark paid')}</button>}
              </div>
            )}
          </div>
        </div>
      )}

      {dialogOpen && (
        <div className="dialog-backdrop" onClick={() => !saving && setDialogOpen(false)}>
          <form className="dialog tl-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2>{tr('New pay run')}</h2>
            <p className="dk-muted tl-small">{tr('Makes one payslip for every active employee on the cycle, with days worked taken from Attendance for the period.')}</p>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="tl-form">
              <div className="field tl-span">
                <span className="iv-label" id="pr-cycle-l">{tr('Cycle')}</span>
                <div className="tl-seg" role="radiogroup" aria-labelledby="pr-cycle-l">
                  {CYCLES.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={form.cycle === k} className={'tl-seg-btn' + (form.cycle === k ? ' is-on' : '')} onClick={() => setForm({ ...form, cycle: k })}>{tr(label)}</button>)}
                </div>
              </div>
              <div className="field tl-span">
                <label htmlFor="pr-company">{tr('Company')}</label>
                <select id="pr-company" className="input" value={form.companyId} onChange={(e) => setForm({ ...form, companyId: e.target.value })}>
                  <option value="">{tr('All companies')}</option>
                  {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="pr-start">{tr('Period start')}</label>
                <input id="pr-start" className="input" type="date" value={form.periodStart} onChange={(e) => setForm({ ...form, periodStart: e.target.value })} required />
              </div>
              <div className="field">
                <label htmlFor="pr-end">{tr('Period end')}</label>
                <input id="pr-end" className="input" type="date" min={form.periodStart} value={form.periodEnd} onChange={(e) => setForm({ ...form, periodEnd: e.target.value })} required />
              </div>
              <div className="field">
                <label htmlFor="pr-paydate">{tr('Pay date')}</label>
                <input id="pr-paydate" className="input" type="date" value={form.payDate} onChange={(e) => setForm({ ...form, payDate: e.target.value })} required />
              </div>
            </div>
            <p className={'tl-small ' + (newStaff.length ? 'dk-muted' : 'pk-owe')}>{newStaff.length === 1 ? tr('1 active employee is on this cycle.') : tr('{n} active employees are on this cycle.', { n: newStaff.length })}</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialogOpen(false)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Generating…') : tr('Generate pay run')}</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
