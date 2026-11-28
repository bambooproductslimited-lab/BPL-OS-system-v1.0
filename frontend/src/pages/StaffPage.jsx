import { useCallback, useEffect, useMemo, useState } from 'react';
import { API_URL } from '../api/client';
import { tr, activeIntlLocale } from '../lib/i18n.jsx';
import './StaffPage.css';

// The staff page: each employee's own page on their phone (installed from
// /staff, staff.html and staff-manifest.webmanifest). No OS account needed:
// they sign in with the phone number on their staff record and a six-digit
// code texted to it, and stay signed in on that phone for 90 days. Two
// people sharing one phone pick who they are.
//
// What it shows is theirs alone: today's clock, their attendance month by
// month (a calendar and day by day: in, out, hours, how late; absent, day
// off, leave or public holiday — as HR's report reads it), their leave
// (what is left, what they asked for; asking for leave and calling off a
// request still waiting), the work orders they are on, and who they are
// on the record. No pay. Backend: staffPage.service.js, under /api/staff.

const TOKEN_KEY = 'bos.staff.token';
const PHONE_KEY = 'bos.staff.phone';
const REFRESH_MS = 5 * 60 * 1000;
const RESEND_S = 45;

function readStore(k) { try { return localStorage.getItem(k); } catch { return null; } }
function writeStore(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* this visit only */ } }

// A call to the staff page's API: its answer, or an Error with the
// server's words and the status.
async function staffCall(method, path, body, token) {
  let res;
  try {
    res = await fetch(API_URL + '/staff' + path, {
      method,
      headers: Object.assign({}, token ? { Authorization: 'Bearer ' + token } : {}, body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    throw Object.assign(new Error(tr('No connection. Check the internet and try again.')), { status: 0 });
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw Object.assign(new Error(data && data.error ? data.error.message : tr('Something went wrong.')), { status: res.status });
  return data;
}

function d0(iso) { return new Date(String(iso).slice(0, 10) + 'T00:00'); }
function niceDay(iso) { return iso ? d0(iso).toLocaleDateString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short' }) : ''; }
function longDay(iso) { return iso ? d0(iso).toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long' }) : ''; }
function fullDate(iso) { return iso ? d0(iso).toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'long', year: 'numeric' }) : ''; }
function monthName(m) { return new Date(m + '-01T00:00').toLocaleDateString(activeIntlLocale(), { month: 'long', year: 'numeric' }); }
function addMonths(m, n) { const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)); return d.toISOString().slice(0, 7); }
function hoursText(h) { if (h === null || h === undefined) return ''; const hh = Math.floor(h), mm = Math.round((h - hh) * 60); return mm ? tr('{h} h {m} min', { h: hh, m: mm }) : tr('{h} h', { h: hh }); }
function minutesText(n) { return n >= 60 ? tr('{h} h {m} min', { h: Math.floor(n / 60), m: n % 60 }) : tr('{n} min', { n }); }
function greeting(name) { const h = new Date().getHours(); return h < 12 ? tr('Good morning, {name}', { name }) : h < 17 ? tr('Good afternoon, {name}', { name }) : tr('Good evening, {name}', { name }); }

const STATUS = {
  present: { icon: '✓', label: () => tr('On time') },
  late: { icon: '⏰', label: () => tr('Late') },
  half_day: { icon: '◐', label: () => tr('Half day') },
  absent: { icon: '✕', label: () => tr('Absent') },
  off: { icon: '·', label: () => tr('Day off') },
  leave: { icon: '🌴', label: () => tr('On leave') },
  holiday: { icon: '🎉', label: () => tr('Public holiday') },
  today: { icon: '…', label: () => tr('Not clocked in yet') }
};
function statusLabel(s) { return STATUS[s] ? STATUS[s].label() : s; }
const LEAVE_STATUS = { pending: () => tr('Waiting for approval'), approved: () => tr('Approved'), rejected: () => tr('Not approved'), cancelled: () => tr('Called off') };
const WO_STATUS = { discussing: () => tr('Discussing'), not_started: () => tr('Issued'), in_progress: () => tr('In process'), awaiting_material: () => tr('Awaiting material'), waiting: () => tr('Suspended'), under_review: () => tr('Ready for check') };
const WORK_WEEK = { mon_fri: () => tr('Monday to Friday'), all: () => tr('Every day') };

// ── signing in ───────────────────────────────────────────────────────────
function SignIn({ notice, onSignedIn }) {
  const [step, setStep] = useState('phone');
  const [phone, setPhone] = useState(() => readStore(PHONE_KEY) || '');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [wait, setWait] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { if (wait <= 0) return undefined; const t = setTimeout(() => setWait((w) => w - 1), 1000); return () => clearTimeout(t); }, [wait]);

  async function send(e) {
    if (e) e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await staffCall('POST', '/code', { phone });
      writeStore(PHONE_KEY, phone);
      setSentTo(r.to); setStep('code'); setCode(''); setWait(RESEND_S);
    } catch (x) { setErr(x.message); }
    setBusy(false);
  }
  async function verify(e) {
    if (e) e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await staffCall('POST', '/sign-in', { phone, code });
      writeStore(TOKEN_KEY, r.token);
      onSignedIn(r.token);
    } catch (x) { setErr(x.message); setBusy(false); }
  }
  return (
    <div className="sp-page sp-signin">
      <header className="sp-bar"><span className="sp-brand"><img src="/icon-192.png" alt="" width="28" height="28" /> {tr('My Info')}</span></header>
      <main className="sp-main">
        {notice && <p className="sp-notice" role="status">{notice}</p>}
        {step === 'phone' ? (
          <form className="sp-box" onSubmit={send}>
            <h1>{tr('Your staff page')}</h1>
            <p>{tr('See your attendance, your leave and your work. Type the phone number on your staff record; we send you a code by text message.')}</p>
            <label className="sp-field"><span>{tr('Your phone number')}</span>
              <input className="input sp-input" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="024 412 3456" autoFocus />
            </label>
            {err && <p className="sp-error" role="alert">{err}</p>}
            <button type="submit" className="sp-big" disabled={busy || phone.replace(/\D/g, '').length < 9}>{busy ? tr('Sending…') : tr('Send me a code')}</button>
            <p className="sp-small">{tr('No account or password needed. A new phone number? Ask HR to put it on your record first.')}</p>
          </form>
        ) : (
          <form className="sp-box" onSubmit={verify}>
            <h1>{tr('Type the code')}</h1>
            <p>{tr('If {phone} is on a staff record, a 6-digit code is on its way by text. It works for 10 minutes.', { phone: sentTo })}</p>
            <input className="input sp-input sp-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="••••••" aria-label={tr('The 6-digit code')} autoFocus />
            {err && <p className="sp-error" role="alert">{err}</p>}
            <button type="submit" className="sp-big" disabled={busy || code.length !== 6}>{busy ? tr('Signing in…') : tr('Sign in')}</button>
            <div className="sp-row">
              <button type="button" className="sp-link" disabled={busy || wait > 0} onClick={() => send()}>{wait > 0 ? tr('Send a new code in {n} s', { n: wait }) : tr('Send a new code')}</button>
              <button type="button" className="sp-link" onClick={() => { setStep('phone'); setErr(null); }}>{tr('Change the number')}</button>
            </div>
            <p className="sp-small">{tr('No text after a minute? Your number may not be on your staff record. Ask HR to check it.')}</p>
          </form>
        )}
      </main>
    </div>
  );
}

function Choose({ people, onChoose, onSignOut, busy, err }) {
  return (
    <div className="sp-page sp-signin">
      <header className="sp-bar"><span className="sp-brand"><img src="/icon-192.png" alt="" width="28" height="28" /> {tr('My Info')}</span></header>
      <main className="sp-main">
        <div className="sp-box">
          <h1>{tr('Who are you?')}</h1>
          <p>{tr('More than one person has this phone number on their record. Choose your name.')}</p>
          <div className="sp-people">
            {people.map((p) => (
              <button key={p.id} type="button" className="sp-person" disabled={busy} onClick={() => onChoose(p.id)}>
                <b>{p.name}</b>{p.position && <small>{p.position}</small>}
              </button>
            ))}
          </div>
          {err && <p className="sp-error" role="alert">{err}</p>}
          <button type="button" className="sp-link" onClick={onSignOut}>{tr('Sign out')}</button>
        </div>
      </main>
    </div>
  );
}

// ── attendance ───────────────────────────────────────────────────────────
function Calendar({ month, days, picked, onPick }) {
  const byDate = useMemo(() => {
    const m = {};
    days.forEach((d) => { (m[d.date] = m[d.date] || []).push(d); });
    return m;
  }, [days]);
  const first = d0(month + '-01');
  const lead = (first.getDay() + 6) % 7; // Monday first
  const count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let n = 1; n <= count; n++) cells.push(month + '-' + String(n).padStart(2, '0'));
  const heads = [1, 2, 3, 4, 5, 6, 0].map((w) => new Date(2024, 0, 7 + w).toLocaleDateString(activeIntlLocale(), { weekday: 'narrow' }));
  const now = new Date(), todayIso = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  return (
    <div className="sp-cal" role="grid" aria-label={monthName(month)}>
      {heads.map((h, i) => <span key={'h' + i} className="sp-cal-head" aria-hidden="true">{h}</span>)}
      {cells.map((iso, i) => {
        if (!iso) return <span key={'e' + i} />;
        const recs = byDate[iso];
        const st = recs ? (recs.some((r) => r.status === 'late') ? 'late' : recs[0].status) : 'future';
        return (
          <button key={iso} type="button" className={'sp-cal-day is-' + st + (iso === todayIso ? ' is-now' : '') + (picked === iso ? ' is-picked' : '')} disabled={!recs} onClick={() => onPick(iso)}
            aria-label={niceDay(iso) + (iso === todayIso ? ' · ' + tr('today') : '') + (recs ? ' · ' + statusLabel(st) : '')} aria-pressed={picked === iso}>
            <span>{Number(iso.slice(8))}</span>
          </button>
        );
      })}
    </div>
  );
}

function DayRow({ d }) {
  return (
    <li className={'sp-day is-' + d.status}>
      <span className="sp-day-ico" aria-hidden="true">{(STATUS[d.status] || {}).icon}</span>
      <span className="sp-day-main">
        <b>{niceDay(d.date)}{d.shift > 1 ? ' · ' + tr('shift {n}', { n: d.shift }) : ''}</b>
        <small>
          {d.clockIn ? tr('In {time}', { time: d.clockIn }) : null}
          {d.clockIn && (d.clockOut ? ' · ' + tr('Out {time}', { time: d.clockOut }) : ' · ' + tr('not clocked out'))}
          {d.hours ? ' · ' + hoursText(d.hours) : ''}
          {!d.clockIn && d.holiday ? d.holiday : ''}
        </small>
        {d.autoClockedOut && <small className="sp-warn">{tr('Clocked out by the system: you forgot to clock out.')}</small>}
      </span>
      <span className={'sp-chip is-' + d.status}>{d.status === 'late' && d.minutesLate ? tr('Late {time}', { time: minutesText(d.minutesLate) }) : statusLabel(d.status)}</span>
    </li>
  );
}

function Attendance({ first, token, onAuth }) {
  const [month, setMonth] = useState(first.month);
  const [data, setData] = useState(first);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [picked, setPicked] = useState(null);
  useEffect(() => { if (month === first.month) setData(first); }, [first, month]);
  async function go(m) {
    setMonth(m); setPicked(null); setErr(null);
    if (m === first.month) { setData(first); return; }
    setBusy(true);
    try { setData(await staffCall('GET', '/attendance?month=' + m, undefined, token)); } catch (x) { if (x.status === 401) onAuth(); else setErr(x.message); }
    setBusy(false);
  }
  const t = data.totals;
  const shown = data.days.slice().reverse();
  const pickedDays = picked ? data.days.filter((d) => d.date === picked) : [];
  const thisMonth = new Date().toISOString().slice(0, 7);
  return (
    <section aria-label={tr('Attendance')}>
      <div className="sp-month">
        <button type="button" className="sp-month-btn" disabled={busy || month <= data.oldest || (data.hiredOn && month <= data.hiredOn.slice(0, 7))} onClick={() => go(addMonths(month, -1))} aria-label={tr('Month before')}>‹</button>
        <b>{monthName(month)}</b>
        <button type="button" className="sp-month-btn" disabled={busy || month >= thisMonth} onClick={() => go(addMonths(month, 1))} aria-label={tr('Month after')}>›</button>
      </div>
      {err && <p className="sp-error" role="alert">{err}</p>}
      <div className={'sp-tiles' + (busy ? ' is-busy' : '')}>
        <div className="sp-tile is-good"><b>{t.daysWorked}</b><span>{tr('days worked')}</span></div>
        <div className={'sp-tile' + (t.late ? ' is-warn' : '')}><b>{t.late}</b><span>{t.minutesLate ? tr('late · {time} in all', { time: minutesText(t.minutesLate) }) : tr('times late')}</span></div>
        <div className={'sp-tile' + (t.absent ? ' is-bad' : '')}><b>{t.absent}</b><span>{tr('absent')}</span></div>
        <div className="sp-tile"><b>{t.hours}</b><span>{tr('hours')}</span></div>
      </div>
      {(t.leave > 0 || t.holidays > 0 || t.autoClockedOut > 0) && (
        <p className="sp-small sp-also">
          {[t.leave ? tr('{n} days on leave', { n: t.leave }) : '', t.holidays ? tr('{n} public holidays', { n: t.holidays }) : '', t.autoClockedOut ? tr('{n} times clocked out by the system', { n: t.autoClockedOut }) : ''].filter(Boolean).join(' · ')}
        </p>
      )}
      <Calendar month={month} days={data.days} picked={picked} onPick={(d) => setPicked(picked === d ? null : d)} />
      <div className="sp-legend" aria-hidden="true">
        {['present', 'late', 'absent', 'off', 'leave', 'holiday'].map((s) => <span key={s}><i className={'is-' + s} />{statusLabel(s)}</span>)}
      </div>
      {pickedDays.length > 0 && <ul className="sp-days is-picked">{pickedDays.map((d) => <DayRow key={d.date + d.shift} d={d} />)}</ul>}
      <h2 className="sp-h2">{tr('Day by day')}</h2>
      {shown.length ? <ul className="sp-days">{shown.map((d) => <DayRow key={d.date + d.shift} d={d} />)}</ul> : <p className="sp-empty">{tr('Nothing in this month yet.')}</p>}
      <p className="sp-small">{tr('Something wrong, like a day you worked shown as absent? Tell your manager or HR: they can correct it.')}</p>
    </section>
  );
}

// ── leave ────────────────────────────────────────────────────────────────
function AskLeave({ types, token, onDone, onClose }) {
  const [f, setF] = useState({ leaveTypeId: types[0] ? types[0].id : '', startDate: '', endDate: '', reason: '' });
  const [pre, setPre] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k, v) => setF((o) => ({ ...o, [k]: v, ...(k === 'startDate' && (!o.endDate || o.endDate < v) ? { endDate: v } : {}) }));
  useEffect(() => {
    setPre(null);
    if (!f.leaveTypeId || !f.startDate || !f.endDate || f.endDate < f.startDate) return undefined;
    let live = true;
    staffCall('POST', '/leave/preview', { leaveTypeId: f.leaveTypeId, startDate: f.startDate, endDate: f.endDate }, token).then((p) => { if (live) setPre(p); }).catch(() => {});
    return () => { live = false; };
  }, [f.leaveTypeId, f.startDate, f.endDate, token]);
  async function send(e) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { await staffCall('POST', '/leave', f, token); onDone(); } catch (x) { setErr(x.message); setBusy(false); }
  }
  const today = new Date().toISOString().slice(0, 10);
  return (
    <form className="sp-card sp-ask" onSubmit={send}>
      <h2>{tr('Ask for leave')}</h2>
      <label className="sp-field"><span>{tr('Kind of leave')}</span>
        <select className="input" value={f.leaveTypeId} onChange={(e) => set('leaveTypeId', e.target.value)}>
          {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <div className="sp-two">
        <label className="sp-field"><span>{tr('From')}</span><input className="input" type="date" min={today} value={f.startDate} onChange={(e) => set('startDate', e.target.value)} required /></label>
        <label className="sp-field"><span>{tr('To')}</span><input className="input" type="date" min={f.startDate || today} value={f.endDate} onChange={(e) => set('endDate', e.target.value)} required /></label>
      </div>
      {pre && <p className="sp-small sp-pre">{pre.days === 1 ? tr('1 working day') : tr('{n} working days', { n: pre.days })}{pre.wouldOwe ? ' · ' + tr('more than you have left: you would owe {n} day(s)', { n: pre.wouldOwe }) : ''}</p>}
      <label className="sp-field"><span>{tr('Why')}</span><textarea className="input" rows={2} maxLength={300} value={f.reason} onChange={(e) => set('reason', e.target.value)} placeholder={tr('A family event, a hospital visit…')} required /></label>
      {err && <p className="sp-error" role="alert">{err}</p>}
      <button type="submit" className="sp-big" disabled={busy || !f.startDate || !f.endDate || !f.reason.trim()}>{busy ? tr('Sending…') : tr('Send for approval')}</button>
      <button type="button" className="sp-link" onClick={onClose}>{tr('Cancel')}</button>
    </form>
  );
}

function Leave({ leave, token, onChanged, say }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(null);
  async function callOff(r) {
    if (!window.confirm(tr('Call off this leave request?'))) return;
    setBusy(r.id);
    try { await staffCall('POST', '/leave/' + r.id + '/cancel', {}, token); say(tr('Leave request called off.')); await onChanged(); } catch (x) { say(x.message); }
    setBusy(null);
  }
  return (
    <section aria-label={tr('Leave')}>
      <h2 className="sp-h2">{tr('Leave left in {year}', { year: leave.year })}</h2>
      {leave.balances.length ? (
        <div className="sp-bal">
          {leave.balances.map((b) => (
            <div key={b.typeId} className="sp-bal-one">
              <b>{b.paid ? b.left : '—'}</b>
              <span>{b.name}</span>
              <small>{b.paid ? tr('of {n} days', { n: b.entitled }) : tr('unpaid, as needed')}{b.pending ? ' · ' + tr('{n} waiting', { n: b.pending }) : ''}</small>
            </div>
          ))}
        </div>
      ) : <p className="sp-empty">{tr('HR has not set your leave for this year yet.')}</p>}
      {asking
        ? <AskLeave types={leave.types} token={token} onClose={() => setAsking(false)} onDone={async () => { setAsking(false); say(tr('Sent. Your manager will approve it.')); await onChanged(); }} />
        : <button type="button" className="sp-big is-outline" onClick={() => setAsking(true)}>🌴 {tr('Ask for leave')}</button>}
      <h2 className="sp-h2">{tr('Your requests')}</h2>
      {leave.requests.length ? (
        <ul className="sp-list">
          {leave.requests.map((r) => (
            <li key={r.id} className={'sp-req is-' + r.status}>
              <span className="sp-req-main">
                <b>{r.typeName}</b>
                <small>{niceDay(r.startDate)}{r.endDate !== r.startDate ? ' → ' + niceDay(r.endDate) : ''} · {r.days === 1 ? tr('1 day') : tr('{n} days', { n: r.days })}</small>
                {r.decisionNote && <small>“{r.decisionNote}”</small>}
              </span>
              <span className="sp-req-foot">
                <span className={'sp-chip is-' + r.status}>{(LEAVE_STATUS[r.status] || (() => r.status))()}</span>
                {r.status === 'pending' && <button type="button" className="sp-link" disabled={busy === r.id} onClick={() => callOff(r)}>{tr('Call off')}</button>}
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="sp-empty">{tr('No leave asked for yet.')}</p>}
    </section>
  );
}

// ── work, and who they are ───────────────────────────────────────────────
function Work({ work }) {
  return (
    <section aria-label={tr('Work')}>
      <h2 className="sp-h2">{tr('Work orders you are on')}</h2>
      {work.orders.length ? (
        <ul className="sp-list">
          {work.orders.map((w) => (
            <li key={w.id} className="sp-wo">
              <span className="sp-wo-no">{w.number}</span>
              <span className="sp-req-main"><b>{w.title}</b><small>{(WO_STATUS[w.status] || (() => w.status))()}{w.due ? ' · ' + tr('due {date}', { date: niceDay(w.due) }) : ''}{w.manages ? ' · ' + tr('you manage it') : ''}</small></span>
            </li>
          ))}
        </ul>
      ) : <p className="sp-empty">{tr('No open work orders with your name on them.')}</p>}
      {work.maintenanceJobs > 0 && (
        <a className="sp-card sp-jobs" href="/myjobs">
          <span aria-hidden="true">🛠️</span>
          <span><b>{work.maintenanceJobs === 1 ? tr('1 maintenance job for you') : tr('{n} maintenance jobs for you', { n: work.maintenanceJobs })}</b><small>{tr('Open My Jobs to work on them')}</small></span>
          <span aria-hidden="true">›</span>
        </a>
      )}
    </section>
  );
}

function Me({ me, others, onSwitch, onSignOut }) {
  const shift = me.shift.start ? me.shift.start + (me.shift.end ? '–' + me.shift.end : '') + (me.shift.name ? ' (' + me.shift.name + ')' : '') : '';
  const facts = [
    [tr('Staff number'), me.code],
    [tr('Position'), me.position],
    [tr('Department'), me.department],
    [tr('Company'), me.company],
    [tr('Manager'), me.manager],
    [tr('Started on'), me.hiredOn ? fullDate(me.hiredOn) : ''],
    [tr('Shift'), shift + (me.shift.second ? ' · ' + tr('second shift from {time}', { time: me.shift.second }) : '')],
    [tr('Work week'), me.workDays && WORK_WEEK[me.workDays] ? WORK_WEEK[me.workDays]() : tr('Monday to Saturday')],
    [tr('Phone'), me.phone]
  ].filter(([, v]) => v);
  return (
    <section aria-label={tr('Me')}>
      <dl className="sp-card sp-facts">
        {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      <p className="sp-small">{tr('Something wrong or out of date? Tell HR: they keep your record.')}</p>
      {others.map((p) => <button key={p.id} type="button" className="sp-big is-outline" onClick={() => onSwitch(p.id)}>{tr('Switch to {name}', { name: p.name })}</button>)}
      <button type="button" className="sp-big is-outline is-quiet" onClick={onSignOut}>{tr('Sign out of this phone')}</button>
    </section>
  );
}

// ── the page ─────────────────────────────────────────────────────────────
export default function StaffPage() {
  const [token, setToken] = useState(() => readStore(TOKEN_KEY));
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [notice, setNotice] = useState(null);
  const [tab, setTab] = useState('attendance');
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);

  const ended = useCallback((why) => { writeStore(TOKEN_KEY, null); setToken(null); setData(null); setNotice(why || null); }, []);
  const load = useCallback(async () => {
    if (!token) return;
    try { setData(await staffCall('GET', '/me', undefined, token)); setErr(null); } catch (x) { if (x.status === 401) ended(tr('You were signed out. Sign in again with your phone number.')); else setErr(x.message); }
  }, [token, ended]);
  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    const back = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', back);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', back); };
  }, [load]);
  useEffect(() => { document.title = tr('My Info') + ' · Bamboo'; }, []);

  function say(t) { setToast(t); setTimeout(() => setToast(null), 3500); }
  async function choose(id) {
    setBusy(true); setErr(null);
    try { await staffCall('POST', '/choose', { employeeId: id }, token); setData(null); await load(); setTab('attendance'); } catch (x) { setErr(x.message); }
    setBusy(false);
  }
  async function signOut() {
    try { await staffCall('POST', '/sign-out', {}, token); } catch { /* signed out here either way */ }
    ended(null);
  }

  if (!token) return <SignIn notice={notice} onSignedIn={(t) => { setNotice(null); setToken(t); }} />;
  if (!data) {
    return (
      <div className="sp-page sp-wait">
        {err ? <div className="sp-box"><p className="sp-error" role="alert">{err}</p><button type="button" className="sp-big" onClick={load}>{tr('Try again')}</button></div> : <p>{tr('Loading…')}</p>}
      </div>
    );
  }
  if (data.choose) return <Choose people={data.choose} onChoose={choose} onSignOut={signOut} busy={busy} err={err} />;

  const today = data.today;
  const s = today.shifts[today.shifts.length - 1];
  const todayDay = data.attendance.days.find((d) => d.date === today.date);
  const tabs = [['attendance', tr('Attendance')], ['leave', tr('Leave')], ['work', tr('Work')], ['me', tr('Me')]];
  return (
    <div className="sp-page">
      <header className="sp-bar">
        <span className="sp-brand"><img src="/icon-192.png" alt="" width="28" height="28" /> {tr('My Info')}</span>
        <button type="button" className="sp-icon-btn" onClick={load} aria-label={tr('Refresh')} title={tr('Refresh')}>⟳</button>
      </header>
      <main className="sp-main">
        <div className="sp-hello">
          <h1>{greeting(data.me.firstName || data.me.name)}</h1>
          <p>{longDay(today.date)}{data.me.position ? ' · ' + data.me.position : ''}</p>
        </div>
        <div className={'sp-today is-' + (s ? s.status : todayDay ? todayDay.status : 'today')}>
          <span className="sp-today-ico" aria-hidden="true">{s ? (s.clockOut ? '🏁' : '🟢') : todayDay && todayDay.status === 'off' ? '😌' : todayDay && (todayDay.status === 'leave' || todayDay.status === 'holiday') ? (STATUS[todayDay.status] || {}).icon : '🕗'}</span>
          <span>
            <b>{s ? (s.clockOut ? tr('Today: in {in}, out {out}', { in: s.clockIn, out: s.clockOut }) : tr('Today: clocked in at {time}', { time: s.clockIn })) : todayDay && todayDay.status !== 'today' && todayDay.status !== 'absent' ? statusLabel(todayDay.status) : tr('Not clocked in yet today')}</b>
            <small>{s ? (s.status === 'late' ? tr('Marked late') : tr('On time')) + (s.hours ? ' · ' + hoursText(s.hours) : '') : data.me.shift.start ? tr('Your shift starts at {time}', { time: data.me.shift.start }) : tr('Clock in at the kiosk when you arrive.')}</small>
          </span>
        </div>
        {err && <p className="sp-error" role="alert">{err}</p>}
        <nav className="sp-tabs" role="tablist" aria-label={tr('Your page')}>
          {tabs.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-on' : ''} onClick={() => setTab(k)}>{label}</button>)}
        </nav>
        {tab === 'attendance' && <Attendance first={data.attendance} token={token} onAuth={() => ended(tr('You were signed out. Sign in again with your phone number.'))} />}
        {tab === 'leave' && <Leave leave={data.leave} token={token} onChanged={load} say={say} />}
        {tab === 'work' && <Work work={data.work} />}
        {tab === 'me' && <Me me={data.me} others={data.others} onSwitch={choose} onSignOut={signOut} />}
      </main>
      {toast && <div className="sp-toast" role="status">{toast}</div>}
    </div>
  );
}
