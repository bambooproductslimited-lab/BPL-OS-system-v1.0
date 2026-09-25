import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import Photo from '../components/Photo';
import { CompanySwitcher, Empty, Glossary, Hero, Insights, Section, Status, fmtDate, jump } from '../components/DashKit';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import './EmployeesPage.css';
import './LeavePage.css';

// Leave: asking for time off, and — for approvers — deciding on requests
// and seeing who is away. Same "explains itself" layout as the dashboards
// (components/DashKit.jsx): a company switcher, a header with the key
// numbers (press one to show only those requests), what stands out (a
// request that clashes with others away from the same department, one
// waiting too long, a balance running low), your balances, a two-week
// "who is away" calendar, then the requests with Approve / Reject on each.
// Days are working days: Sundays and the company's public holidays are not
// counted (leave.service.js, utils/validate.js#businessDays).

const WINDOW_DAYS = 14;
const EMPTY_FORM = { leaveTypeId: '', startDate: '', endDate: '', reason: '' };

function isoDay(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00');
  d.setDate(d.getDate() + n);
  return isoDay(d);
}
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00') - new Date(a + 'T00:00')) / 86400000); }
// Working days in a range as the server counts them, less public holidays
// (which only the server knows): Sundays are skipped.
function countDays(start, end) {
  if (!start || !end || end < start) return 0;
  let n = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) if (new Date(d + 'T00:00').getDay() !== 0) n += 1;
  return n;
}
function overlaps(a, b) { return !(a.endDate < b.startDate || a.startDate > b.endDate); }
function dayMonth(iso) { return new Date(iso + 'T00:00').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' }); }
function shortRange(start, end) {
  if (start === end) return dayMonth(start);
  return dayMonth(start) + ' – ' + dayMonth(end);
}
function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }

const STATUS_TONE = { pending: 'warn', approved: 'good', rejected: 'bad', cancelled: 'muted' };

export default function LeavePage() {
  const { session, can } = useAuth();
  const myId = session && session.employee && session.employee.id;
  const canSeeAll = can('leave.read.all');
  const canApprove = can('leave.approve');
  const canRequest = can('leave.request');

  const [leaveTypes, setLeaveTypes] = useState([]);
  const [requests, setRequests] = useState([]);
  const [balances, setBalances] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [companyCode, setCompanyCode] = useState(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('company');
    return fromUrl ? fromUrl.toUpperCase() : readPref('bos.leaveCompany', 'ALL');
  });
  const [deptFilter, setDeptFilter] = useState('');
  const [chip, setChip] = useState(null); // null = not chosen yet (see below)
  const [search, setSearch] = useState('');

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const [decisionDialog, setDecisionDialog] = useState(null);
  const [decisionNote, setDecisionNote] = useState('');
  const [dialogError, setDialogError] = useState(null);
  const [deciding, setDeciding] = useState(false);

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const [types, list, me, depts] = await Promise.all([
        api.get('/leave/types'),
        api.get('/leave'),
        api.get('/me/summary'),
        api.get('/departments')
      ]);
      setLeaveTypes(types);
      setRequests(list);
      setBalances(me.balances || []);
      setDepartments(depts);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const companies = useMemo(() => {
    const seen = new Map();
    departments.forEach((d) => { if (!seen.has(d.companyId)) seen.set(d.companyId, { id: d.companyId, name: d.companyName, code: d.companyCode || d.companyId }); });
    return Array.from(seen.values()).sort((a, b) => (a.code === 'BPL' ? -1 : b.code === 'BPL' ? 1 : a.name.localeCompare(b.name)));
  }, [departments]);
  const currentCompany = canSeeAll ? companies.find((c) => c.code === companyCode) || null : null;
  function pickCompany(code) {
    setCompanyCode(code);
    setDeptFilter('');
    writePref('bos.leaveCompany', code);
    window.history.replaceState({}, '', window.location.pathname + (code !== 'ALL' ? '?company=' + code : ''));
  }

  function openForm() {
    setFormError(null);
    setForm((f) => ({ ...EMPTY_FORM, leaveTypeId: f.leaveTypeId || (leaveTypes[0] && leaveTypes[0].id) || '' }));
    setFormOpen(true);
  }

  async function handleSubmitRequest(e) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      const created = await api.post('/leave', form);
      setToast(tr('Request submitted for approval ({days} day(s)).', { days: created.days }));
      setFormOpen(false);
      setForm({ ...EMPTY_FORM, leaveTypeId: form.leaveTypeId });
      await loadAll();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  function openDecision(row, decision) {
    setDialogError(null);
    setDecisionNote('');
    setDecisionDialog({
      id: row.id, decision, employeeName: row.employeeName, typeName: row.typeName,
      days: row.days, startDate: row.startDate, endDate: row.endDate
    });
  }

  async function confirmDecision(e) {
    e.preventDefault();
    if (!decisionDialog) return;
    setDeciding(true);
    setDialogError(null);
    try {
      await api.post('/leave/' + decisionDialog.id + '/decision', { decision: decisionDialog.decision, note: decisionNote });
      setToast(decisionDialog.decision === 'approved' ? tr('Leave approved.') : tr('Leave rejected.'));
      setDecisionDialog(null);
      await loadAll();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setDeciding(false);
    }
  }

  async function handleCancel(row) {
    if (!window.confirm(tr('Cancel your {type} request for {dates}?', { type: row.typeName.toLowerCase(), dates: shortRange(row.startDate, row.endDate) }))) return;
    setError(null);
    try {
      await api.post('/leave/' + row.id + '/cancel');
      setToast(tr('Request cancelled.'));
      await loadAll();
    } catch (err) {
      setError(err.message);
    }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const today = isoDay(new Date());
  const year = today.slice(0, 4);
  const windowEnd = addDays(today, WINDOW_DAYS - 1);
  const showCompany = canSeeAll && !currentCompany && companies.length > 1;
  const scoped = requests.filter((r) => !currentCompany || r.companyCode === currentCompany.code);
  const live = scoped.filter((r) => r.status === 'pending' || r.status === 'approved');
  const pending = scoped.filter((r) => r.status === 'pending');
  const decidable = (r) => r.status === 'pending' && canApprove && r.employeeId !== myId;
  const toDecide = pending.filter(decidable);
  const awayToday = scoped.filter((r) => r.status === 'approved' && r.startDate <= today && r.endDate >= today);
  const comingUp = scoped.filter((r) => r.status === 'approved' && r.startDate > today && r.startDate <= windowEnd);
  const takenThisYear = scoped.filter((r) => r.status === 'approved' && String(r.startDate).slice(0, 4) === year);
  const takenDays = takenThisYear.reduce((n, r) => n + (r.days || 0), 0);
  const waitedDays = (r) => Math.max(0, daysBetween(isoDay(new Date(r.createdAt)), today));
  const firstName = (name) => String(name || '').split(' ')[0];
  const names = (list) => {
    const uniq = Array.from(new Set(list.map((r) => r.employeeName)));
    return uniq.length <= 3 ? uniq.join(', ') : tr('{names} and {n} more', { names: uniq.slice(0, 2).join(', '), n: uniq.length - 2 });
  };
  // Others from the same department who are away (or asking to be) at the
  // same time as this request.
  const clashesOf = (r) => live.filter((o) => o.id !== r.id && o.employeeId !== r.employeeId && o.departmentId && o.departmentId === r.departmentId && overlaps(o, r));

  const chipTest = {
    pending: (r) => r.status === 'pending',
    today: (r) => r.status === 'approved' && r.startDate <= today && r.endDate >= today,
    soon: (r) => r.status === 'approved' && r.startDate > today && r.startDate <= windowEnd,
    approved: (r) => r.status === 'approved',
    rejected: (r) => r.status === 'rejected',
    cancelled: (r) => r.status === 'cancelled',
    all: () => true
  };
  const activeChip = chip || (pending.length ? 'pending' : 'all');
  function showOnly(key) { setChip(key); jump('leave-list'); }

  const rows = scoped
    .filter((r) => !deptFilter || r.departmentId === deptFilter)
    .filter(chipTest[activeChip] || chipTest.all)
    .filter((r) => matchesQuery(search, r.employeeName, r.department, r.company, r.typeName, r.reason))
    .sort((a, b) => {
      if (a.status === 'pending' && b.status !== 'pending') return -1;
      if (b.status === 'pending' && a.status !== 'pending') return 1;
      if (a.status === 'pending') return String(a.createdAt).localeCompare(String(b.createdAt)); // oldest waiting first
      return String(b.startDate).localeCompare(String(a.startDate));
    });

  const paidBalances = balances.filter((b) => b.paid !== false);
  const daysLeft = paidBalances.reduce((n, b) => n + Math.max(0, b.left), 0);

  const stats = canSeeAll ? [
    { icon: 'clock', value: String(pending.length), label: tr('waiting for a decision'), note: pending.length ? tr('oldest asked {n} days ago', { n: Math.max(...pending.map(waitedDays)) }) : tr('nothing to decide'), tone: toDecide.length ? 'alert' : '', onClick: () => showOnly('pending') },
    { icon: 'people', value: String(new Set(awayToday.map((r) => r.employeeId)).size), label: tr('away today'), note: awayToday.length ? names(awayToday) : tr('everyone is in'), onClick: () => showOnly('today') },
    { icon: 'calendar', value: String(comingUp.length), label: tr('starting soon'), note: tr('in the next {n} days', { n: WINDOW_DAYS }), onClick: () => showOnly('soon') },
    { icon: 'check', value: String(takenDays), label: tr('days taken in {year}', { year }), note: tr('{n} approved requests', { n: takenThisYear.length }), onClick: () => showOnly('approved') }
  ] : [
    { icon: 'calendar', value: String(daysLeft), label: tr('days of leave left'), note: tr('in {year}', { year }), onClick: () => jump('leave-balances') },
    { icon: 'clock', value: String(pending.length), label: tr('waiting for a decision'), note: tr('your requests'), tone: pending.length ? 'alert' : '', onClick: () => showOnly('pending') },
    { icon: 'people', value: String(comingUp.length + awayToday.length), label: tr('coming up'), note: tr('approved leave ahead'), onClick: () => showOnly('soon') },
    { icon: 'check', value: String(takenDays), label: tr('days taken in {year}', { year }), note: tr('{n} approved requests', { n: takenThisYear.length }), onClick: () => showOnly('approved') }
  ];

  // What stands out.
  const insights = [];
  const clashing = toDecide.map((r) => ({ r, others: clashesOf(r) })).filter((x) => x.others.length);
  clashing.slice(0, 2).forEach(({ r, others }) => {
    const away = others.filter((o) => o.status === 'approved');
    const asking = others.filter((o) => o.status !== 'approved');
    const vars = { name: r.employeeName, dates: shortRange(r.startDate, r.endDate), dept: r.department };
    const text = away.length && asking.length
      ? tr('{name} asked for {dates}, when {away} from {dept} will be away and {asking} also asked for time off.', { ...vars, away: names(away), asking: names(asking) })
      : away.length
        ? tr('{name} asked for {dates}, when {others} from {dept} will also be away.', { ...vars, others: names(away) })
        : tr('{name} asked for {dates}, and {others} from {dept} also asked for time off then.', { ...vars, others: names(asking) });
    insights.push({ tone: 'warn', icon: 'people', text, action: { label: tr('Review'), run: () => showOnly('pending') } });
  });
  const slow = toDecide.filter((r) => waitedDays(r) >= 3).sort((a, b) => waitedDays(b) - waitedDays(a));
  if (slow.length) insights.push({ tone: 'warn', icon: 'clock', text: slow.length === 1 ? tr('{name} has been waiting {n} days for an answer.', { name: slow[0].employeeName, n: waitedDays(slow[0]) }) : tr('{n} requests have been waiting 3 days or more. The oldest is {name}\'s, from {days} days ago.', { n: slow.length, name: slow[0].employeeName, days: waitedDays(slow[0]) }), action: { label: tr('Review'), run: () => showOnly('pending') } });
  if (canSeeAll && awayToday.length) insights.push({ tone: 'info', icon: 'calendar', text: tr('Away today: {names}.', { names: names(awayToday) }), action: { label: tr('Show them'), run: () => showOnly('today') } });
  const starting = comingUp.filter((r) => daysBetween(today, r.startDate) <= 7).sort((a, b) => a.startDate.localeCompare(b.startDate));
  if (canSeeAll && starting.length) insights.push({ tone: 'info', icon: 'calendar', text: starting.length === 1 ? tr('{name} starts {type} on {date}.', { name: starting[0].employeeName, type: starting[0].typeName.toLowerCase(), date: fmtDate(starting[0].startDate) }) : tr('{n} people start leave in the next 7 days, the first is {name} on {date}.', { n: starting.length, name: starting[0].employeeName, date: fmtDate(starting[0].startDate) }), action: { label: tr('Show them'), run: () => showOnly('soon') } });
  const myNext = requests.filter((r) => r.employeeId === myId && r.status === 'approved' && r.startDate > today).sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
  if (myNext) insights.push({ tone: 'good', icon: 'check', text: tr('Your {type} from {dates} is approved.', { type: myNext.typeName.toLowerCase(), dates: shortRange(myNext.startDate, myNext.endDate) }) });
  const myWaiting = requests.filter((r) => r.employeeId === myId && r.status === 'pending');
  if (myWaiting.length) insights.push({ tone: 'info', icon: 'clock', text: tr('Your request for {dates} is waiting for your manager.', { dates: shortRange(myWaiting[0].startDate, myWaiting[0].endDate) }) });
  const low = paidBalances.filter((b) => b.entitled > 0 && b.left <= 2);
  if (canRequest && low.length) insights.push({ tone: 'warn', icon: 'warn', text: low.length === 1 ? tr('You have {n} days of {type} left this year.', { n: Math.max(0, low[0].left), type: low[0].name.toLowerCase() }) : tr('You are almost out of {types}.', { types: low.map((b) => b.name.toLowerCase()).join(', ') }) });

  const counts = Object.fromEntries(Object.keys(chipTest).map((k) => [k, scoped.filter((r) => (!deptFilter || r.departmentId === deptFilter) && chipTest[k](r)).length]));
  const chips = [
    ['pending', tr('Waiting')],
    canSeeAll && ['today', tr('Away today')],
    ['soon', tr('Coming up')],
    ['approved', tr('Approved')],
    ['rejected', tr('Rejected')],
    counts.cancelled > 0 && ['cancelled', tr('Cancelled')],
    ['all', tr('All')]
  ].filter(Boolean);

  // Who is away over the next two weeks, one row per request.
  const days = Array.from({ length: WINDOW_DAYS }, (_, i) => addDays(today, i));
  const calendar = live
    .filter((r) => !deptFilter || r.departmentId === deptFilter)
    .filter((r) => r.startDate <= windowEnd && r.endDate >= today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.employeeName.localeCompare(b.employeeName));
  const CAL_MAX = 12;

  // The request form's live preview.
  const selectedType = leaveTypes.find((t) => t.id === form.leaveTypeId);
  const selectedBalance = selectedType && balances.find((b) => b.leaveTypeId === selectedType.id || b.name === selectedType.name);
  const previewDays = countDays(form.startDate, form.endDate);
  const unlimited = selectedType && selectedType.paid === false;
  const over = !unlimited && selectedBalance && previewDays > selectedBalance.left;

  return (
    <div className="dk lv">
      {error && <div className="error-banner" role="alert">{error}</div>}

      {canSeeAll && companies.length > 1 && (
        <CompanySwitcher companies={[{ code: 'ALL', name: tr('All companies') }, ...companies]} company={currentCompany ? currentCompany.code : 'ALL'}
          onPick={pickCompany}
          describe={(co) => {
            const n = requests.filter((r) => r.status === 'pending' && (co.code === 'ALL' || r.companyCode === co.code)).length;
            return n ? tr('{n} waiting', { n }) : tr('Nothing waiting');
          }} />
      )}

      <Hero
        eyebrow={new Date().toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        title={canSeeAll ? tr('Leave') : tr('My leave')}
        sub={canSeeAll
          ? tr('Ask for time off, decide on your team\'s requests and see who is away, for {scope}. Days are working days: Sundays and public holidays are not counted. Press a number to show only those requests.', { scope: currentCompany ? currentCompany.name : tr('all companies') })
          : tr('Ask for time off and follow your requests. Days are working days: Sundays and public holidays are not counted.')}
        actions={canRequest && <button type="button" className="btn btn-primary" onClick={openForm}>{tr('Request leave')}</button>}
        stats={stats} />

      <Insights items={insights.slice(0, 6)} />

      {canRequest && balances.length > 0 && (
        <Section id="leave-balances" title={tr('Your days in {year}', { year })} sub={tr('What you are entitled to, what you have taken and what is left.')}>
          <div className="lv-balances">
            {balances.map((b) => {
              const pct = b.entitled ? Math.min(100, Math.round((b.used / b.entitled) * 100)) : 0;
              return (
                <button key={b.name} type="button" className={'lv-balance' + (b.paid !== false && b.entitled > 0 && b.left <= 2 ? ' is-low' : '')}
                  onClick={() => { openForm(); const t = leaveTypes.find((x) => x.id === b.leaveTypeId || x.name === b.name); if (t) setForm((f) => ({ ...f, leaveTypeId: t.id })); }}>
                  <span className="lv-balance-name">{b.name}</span>
                  {b.paid === false ? (
                    <span className="lv-balance-left"><strong>{b.used}</strong> <span className="dk-muted">{tr('days taken · no limit')}</span></span>
                  ) : (
                    <span className="lv-balance-left"><strong>{Math.max(0, b.left)}</strong> <span className="dk-muted">{tr('of {n} days left', { n: b.entitled })}</span></span>
                  )}
                  {b.paid !== false && <span className="dk-track" aria-hidden="true"><span style={{ width: pct + '%' }} /></span>}
                  <span className="dk-muted lv-balance-used">{tr('{n} taken', { n: b.used })}</span>
                </button>
              );
            })}
          </div>
        </Section>
      )}

      {canSeeAll && (
        <Section title={tr('Who is away, next {n} days', { n: WINDOW_DAYS })} sub={tr('Approved leave in solid colour, requests still waiting for a decision striped.')}>
          {calendar.length ? (
            <div className="lv-cal-wrap">
              <div className="lv-cal" style={{ '--lv-days': WINDOW_DAYS }}>
                <div className="lv-cal-head">
                  <span />
                  {days.map((d) => {
                    const dt = new Date(d + 'T00:00');
                    return (
                      <span key={d} className={'lv-cal-day' + (dt.getDay() === 0 ? ' is-sun' : '') + (d === today ? ' is-today' : '')}>
                        <small>{dt.toLocaleDateString(activeIntlLocale(), { weekday: 'narrow' })}</small>{dt.getDate()}
                      </span>
                    );
                  })}
                </div>
                {calendar.slice(0, CAL_MAX).map((r) => {
                  const from = Math.max(0, daysBetween(today, r.startDate));
                  const to = Math.min(WINDOW_DAYS - 1, daysBetween(today, r.endDate));
                  return (
                    <div key={r.id} className="lv-cal-row">
                      <span className="lv-cal-who">
                        <Photo id={r.employeeId} name={r.employeeName} photo={r.employeePhoto} size={24} />
                        <span className="lv-cal-name">{r.employeeName}</span>
                      </span>
                      {days.map((d, i) => <span key={d} className={'lv-cal-cell' + (new Date(d + 'T00:00').getDay() === 0 ? ' is-sun' : '')} style={{ gridColumn: i + 2 }} />)}
                      <span className={'lv-cal-bar' + (r.status === 'pending' ? ' is-pending' : '')} style={{ gridColumn: (from + 2) + ' / ' + (to + 3) }}
                        title={r.employeeName + ' · ' + r.typeName + ' · ' + shortRange(r.startDate, r.endDate) + ' · ' + (r.status === 'pending' ? tr('Waiting') : tr('Approved'))}>
                        <span>{r.typeName}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
              {calendar.length > CAL_MAX && <p className="dk-muted lv-cal-more">{tr('and {n} more — see the list below.', { n: calendar.length - CAL_MAX })}</p>}
            </div>
          ) : <Empty icon="check">{tr('Nobody is away or asking to be in the next {n} days.', { n: WINDOW_DAYS })}</Empty>}
        </Section>
      )}

      <Section id="leave-list" title={canSeeAll ? tr('Requests') : tr('My requests')}
        sub={tr('{shown} of {total} shown. Waiting requests come first, oldest at the top.', { shown: rows.length, total: scoped.length })}>
        <div className="lv-tools">
          <div className="lv-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search employee, department, type…')} /></div>
          {canSeeAll && (
            <select className="input lv-select" value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} aria-label={tr('Filter by department')}>
              <option value="">{tr('All departments')}</option>
              {departments.filter((d) => !currentCompany || d.companyId === currentCompany.id).map((d) => (
                <option key={d.id} value={d.id}>{currentCompany ? d.name : d.name + ' — ' + d.companyName}</option>
              ))}
            </select>
          )}
        </div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label]) => (
            <button key={key} type="button" role="radio" aria-checked={activeChip === key} className={'ppl-chip' + (activeChip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
              {label} <span className="ppl-chip-n">{counts[key]}</span>
            </button>
          ))}
        </div>

        {rows.length ? (
          <ul className="lv-list">
            {rows.map((r) => {
              const clash = r.status === 'pending' ? clashesOf(r) : [];
              const mine = r.employeeId === myId;
              return (
                <li key={r.id} className={'lv-row is-' + r.status}>
                  <span className="lv-who">
                    <Photo id={r.employeeId} name={r.employeeName} photo={r.employeePhoto} size={40} />
                    <span className="lv-who-text">
                      <strong>{r.employeeName}{mine && <span className="ppl-you">{tr('You')}</span>}</strong>
                      <span className="dk-muted">{r.department}{showCompany && r.company ? ' · ' + r.company : ''}</span>
                    </span>
                  </span>
                  <span className="lv-what">
                    <strong>{r.typeName}</strong>
                    <span>{shortRange(r.startDate, r.endDate)} · {r.days === 1 ? tr('1 day') : tr('{n} days', { n: r.days })}</span>
                  </span>
                  <span className="lv-why">
                    {r.reason && <span className="lv-reason">{r.reason}</span>}
                    {r.decisionNote && <span className="dk-muted lv-note">{tr('Note: {note}', { note: r.decisionNote })}</span>}
                    {clash.length > 0 && <span className="lv-clash">{tr('Also away then from {dept}: {names}', { dept: r.department, names: clash.map((o) => firstName(o.employeeName)).join(', ') })}</span>}
                  </span>
                  <span className="lv-state">
                    <Status tone={STATUS_TONE[r.status]}>{r.status === 'pending' ? tr('Waiting') : r.status === 'approved' ? tr('Approved') : r.status === 'rejected' ? tr('Rejected') : tr('Cancelled')}</Status>
                    <span className="dk-muted">
                      {r.status === 'pending'
                        ? (waitedDays(r) === 0 ? tr('asked today') : waitedDays(r) === 1 ? tr('asked yesterday') : tr('asked {n} days ago', { n: waitedDays(r) }))
                        : r.decidedAt ? tr('on {date}', { date: fmtDate(String(r.decidedAt).slice(0, 10)) }) : ''}
                    </span>
                  </span>
                  <span className="lv-actions">
                    {decidable(r) && <>
                      <button type="button" className="btn btn-primary lv-btn" onClick={() => openDecision(r, 'approved')}>{tr('Approve')}</button>
                      <button type="button" className="btn btn-secondary lv-btn" onClick={() => openDecision(r, 'rejected')}>{tr('Reject')}</button>
                    </>}
                    {r.status === 'pending' && mine && <button type="button" className="btn btn-secondary lv-btn" onClick={() => handleCancel(r)}>{tr('Cancel request')}</button>}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="dk-empty lv-empty">
            <p>{scoped.length ? tr('Nothing matches this filter.') : canRequest ? tr('No leave requests yet. Press "Request leave" to ask for time off.') : tr('No leave requests yet.')}</p>
            {(search || deptFilter || activeChip !== 'all') && scoped.length > 0 && <button type="button" className="btn btn-secondary" onClick={() => { setSearch(''); setDeptFilter(''); setChip('all'); }}>{tr('Show all')}</button>}
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('Waiting'), tr('Asked for, not decided yet. The person\'s manager (or HR) approves or rejects it.')],
        [tr('Approved'), tr('Agreed. The days come off the person\'s balance and attendance shows them as on leave.')],
        [tr('Rejected'), tr('Not agreed. Nothing comes off the balance; the note says why.')],
        [tr('Cancelled'), tr('Withdrawn by the person before a decision.')],
        [tr('Days'), tr('Working days only: Sundays and the company\'s public holidays in the range are not counted.')],
        [tr('Days left'), tr('This year\'s entitlement for that type of leave, less the approved days already taken. Unpaid leave has no limit.')]
      ]} />

      {formOpen && (
        <div className="dialog-backdrop" onClick={() => setFormOpen(false)}>
          <form className="dialog lv-form" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmitRequest}>
            <h2>{tr('Request leave')}</h2>
            <div className="field">
              <label htmlFor="leave-type">{tr('Type')}</label>
              <select id="leave-type" className="input" value={form.leaveTypeId} onChange={(e) => setForm({ ...form, leaveTypeId: e.target.value })} required>
                {leaveTypes.map((t) => {
                  const b = balances.find((x) => x.leaveTypeId === t.id || x.name === t.name);
                  return <option key={t.id} value={t.id}>{t.name}{t.paid === false ? ' — ' + tr('no limit') : b ? ' — ' + tr('{n} days left', { n: Math.max(0, b.left) }) : ''}</option>;
                })}
              </select>
            </div>
            <div className="lv-form-dates">
              <div className="field">
                <label htmlFor="leave-start">{tr('From')}</label>
                <input id="leave-start" className="input" type="date" value={form.startDate} min={today}
                  onChange={(e) => setForm({ ...form, startDate: e.target.value, endDate: form.endDate && form.endDate < e.target.value ? e.target.value : form.endDate })} required />
              </div>
              <div className="field">
                <label htmlFor="leave-end">{tr('To (last day off)')}</label>
                <input id="leave-end" className="input" type="date" value={form.endDate} min={form.startDate || today} onChange={(e) => setForm({ ...form, endDate: e.target.value })} required />
              </div>
            </div>
            {form.startDate && form.endDate && (
              <div className={'lv-preview' + (over ? ' is-over' : '')}>
                <strong>{previewDays === 1 ? tr('1 working day') : tr('{n} working days', { n: previewDays })}</strong>
                <span>
                  {unlimited
                    ? tr('Unpaid leave has no limit.')
                    : selectedBalance
                      ? (over
                        ? tr('That is more than the {n} days you have left.', { n: Math.max(0, selectedBalance.left) })
                        : tr('You will have {left} of {total} days left.', { left: selectedBalance.left - previewDays, total: selectedBalance.entitled }))
                      : tr('Your balance for this type is set when you send the request.')}
                </span>
                <small className="dk-muted">{tr('Sundays are not counted. Public holidays in these dates are taken off when you send it.')}</small>
              </div>
            )}
            <div className="field">
              <label htmlFor="leave-reason">{tr('Reason')}</label>
              <textarea id="leave-reason" className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder={tr('Kept on the record for HR.')} required maxLength={300} />
            </div>
            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setFormOpen(false)}>{tr('Cancel')}</button>
              <button className="btn btn-primary" type="submit" disabled={submitting}>{submitting ? tr('Submitting…') : tr('Submit request')}</button>
            </div>
          </form>
        </div>
      )}

      {decisionDialog && (
        <div className="dialog-backdrop" onClick={() => setDecisionDialog(null)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={confirmDecision}>
            <h2>{decisionDialog.decision === 'approved' ? tr('Approve leave') : tr('Reject leave')}</h2>
            <p className="dialog-body">
              {tr('{employeeName} · {typeName} · {days} day(s), {date} → {date2}', { employeeName: decisionDialog.employeeName, typeName: decisionDialog.typeName, days: decisionDialog.days, date: fmtDate(decisionDialog.startDate), date2: fmtDate(decisionDialog.endDate) })}
            </p>
            <div className="field">
              <label htmlFor="decision-note">{tr('Note for the record')}</label>
              <textarea id="decision-note" className="input" value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)}
                placeholder={tr('Optional for approval, expected for a rejection.')} />
            </div>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDecisionDialog(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={deciding}>
                {deciding ? tr('Saving…') : (decisionDialog.decision === 'approved' ? tr('Approve request') : tr('Reject request'))}
              </button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
