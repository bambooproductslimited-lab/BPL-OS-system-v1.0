import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import LeavePool from '../components/LeavePool';
import { useAuth } from '../auth/AuthContext';
import TwoStepSettings from '../components/TwoStepSettings';
import Photo from '../components/Photo';
import { Glossary, Icon, Insights, Section, Status, fmtDate, jump } from '../components/DashKit';
import { money } from '../lib/currency';
import { tr, activeIntlLocale } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import { woStatusLabel } from '../lib/workOrders.js';
import './ToolRoomPage.css';
import './MySpacePage.css';
import './MySpaceFun.css';
import { ComingUp, Fortnight, MeBanner, PayCard, Tile, Week, longDay, skyOf } from './MySpaceFun';

// My space — the signed-in person's own day, leave, work, money and
// account: a banner whose sky follows the time of day with their live clock
// and how far through their shift they are; tiles for leave left, on time
// this month, open work orders and money; what needs them (clock in,
// overdue work, announcements to confirm, approvals waiting, leave to plan,
// two-step sign-in off); the fortnight with their on-time run and this
// week's hours; what is coming up (leave, payday, holiday, birthday, work
// anniversary); leave, work orders, payslips split into take-home and
// deductions, claims; and an ID card with their team and sign-in safety
// (GET /api/me/overview — mySpace.service.js — only ever their own).
// The livelier pieces are in MySpaceFun.jsx.
//
// Clock in / out needs attendance.self; everything else is self-service.
// Payslips appear once payroll has approved the run.

function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}
// "Tuesday 22 September" from the server's YYYY-MM-DD.
function noticeDate(iso) {
  return new Date(iso + 'T12:00:00').toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long' });
}
function shiftHours(s) {
  const h = (new Date(s.clockOutDate + 'T' + s.clockOut + ':00Z') - new Date(s.date + 'T' + s.clockIn + ':00Z')) / 3600000;
  return Number.isInteger(h) ? h : Math.round(h * 10) / 10;
}
function dayNum(iso) { return Math.floor(new Date(String(iso).slice(0, 10) + 'T00:00').getTime() / 86400000); }
function todayNum() { const t = new Date(); return Math.floor(new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime() / 86400000); }
function minutesNow(now) { return now.getHours() * 60 + now.getMinutes(); }
function toMinutes(hhmm) { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; }
function greeting(now, name) { const h = now.getHours(); return h < 12 ? tr('Good morning, {name}', { name }) : h < 17 ? tr('Good afternoon, {name}', { name }) : tr('Good evening, {name}', { name }); }
function isoDay(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

const TASK_DONE = ['done', 'completed'];
const EMPTY_PW = { currentPassword: '', newPassword: '', confirm: '' };

export default function MySpacePage() {
  const { session, can } = useAuth();
  const navigate = useNavigate();
  const now = useClock();
  const canSelf = can('attendance.self');

  const [data, setData] = useState(null);
  const [autoClosed, setAutoClosed] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [clocking, setClocking] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState(EMPTY_PW);
  const [pwError, setPwError] = useState(null);
  const [pwSaving, setPwSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get('/me/overview'));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  async function clockIn() {
    setClocking(true);
    setError(null);
    try {
      const r = await api.post('/attendance/clock-in');
      setToast(tr('Clocked in. Have a good shift.'));
      // Shifts the system clocked out because nobody did — told once, here
      // or at the kiosk, whichever they clock in at next.
      if (r && r.autoClosedShifts && r.autoClosedShifts.length) setAutoClosed(r.autoClosedShifts);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setClocking(false);
    }
  }
  async function clockOut() {
    setClocking(true);
    setError(null);
    try {
      await api.post('/attendance/clock-out');
      setToast(tr('Clocked out. Your hours are recorded.'));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setClocking(false);
    }
  }
  async function cancelLeave(row) {
    try {
      await api.post('/leave/' + row.id + '/cancel');
      setToast(tr('Request cancelled.'));
      await load();
    } catch (err) {
      setError(err.message);
    }
  }
  async function changePassword(e) {
    e.preventDefault();
    setPwError(null);
    if (pw.newPassword.length < 8) { setPwError(tr('Password must be at least 8 characters.')); return; }
    if (pw.newPassword !== pw.confirm) { setPwError(tr('Passwords do not match.')); return; }
    setPwSaving(true);
    try {
      await api.post('/me/password', { currentPassword: pw.currentPassword, newPassword: pw.newPassword });
      setPwOpen(false);
      setPw(EMPTY_PW);
      setToast(tr('Password changed.'));
    } catch (err) {
      setPwError(err.message);
    } finally {
      setPwSaving(false);
    }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;
  if (!data) return <div className="error-banner" role="alert">{error}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const p = data.profile;
  const att = data.todayAttendance;
  const onDuty = !!(att && !att.clockOut);
  const shiftText = data.shift.start ? (data.shift.name && !data.shift.name.includes(data.shift.start) ? data.shift.name + ' · ' : '') + data.shift.start + '–' + (data.shift.end || '?') : ((session && session.employee && session.employee.shift) || tr('No shift set'));
  // With a yearly total (LeavePool.jsx), the types in it are counted there.
  const lpool = data.leavePool && data.leavePool.inEffect ? data.leavePool : null;
  const ownBalances = lpool ? data.balances.filter((b) => !b.inPool) : data.balances;
  const paid = ownBalances.filter((b) => b.paid);
  const leftDays = lpool ? lpool.left : paid.reduce((s, b) => s + b.left, 0);
  const pendingDays = lpool ? lpool.pending + ownBalances.reduce((s, b) => s + b.pending, 0) : data.balances.reduce((s, b) => s + b.pending, 0);
  const entitled = lpool ? Math.max(0, lpool.available) : paid.reduce((s, b) => s + b.entitled, 0);
  const onTime = data.month.days ? Math.round(((data.month.days - data.month.late) / data.month.days) * 100) : null;
  const overdue = data.tasks.filter((t) => t.dueDate && dayNum(t.dueDate) < todayNum());
  const owed = data.claims.filter((c) => c.status === 'approved');
  const owedTotal = owed.reduce((s, c) => s + c.amount, 0);
  const sheet = data.expenseSheet || null;
  const owedOnSheet = sheet && sheet.balance < 0 ? -sheet.balance : 0;
  const lastPay = data.payslips[0];
  const pendingLeave = data.leave.filter((l) => l.status === 'pending');
  const toConfirm = data.announcements.filter((a) => a.requiresAck && !a.acknowledged);
  const unreadNews = data.announcements.filter((a) => !a.read);
  const twoStepOn = data.account.twoStep.app || data.account.twoStep.sms || data.account.twoStep.email;
  const lateNow = canSelf && !att && data.shift.start && minutesNow(now) > toMinutes(data.shift.start) && now.getDay() !== 0;
  const longShift = onDuty && att && (now - new Date(att.date + 'T' + att.clockIn + ':00')) > 12 * 3600000;
  const yearEnd = now.getMonth() >= 9 && leftDays > 5;
  const recentNo = data.leave.filter((l) => l.status === 'rejected' && l.decisionNote && l.decidedAt && Date.now() - new Date(l.decidedAt).getTime() < 14 * 86400000);
  const years = p.hireDate ? Math.floor((todayNum() - dayNum(p.hireDate)) / 365.25) : null;

  const insights = [];
  if (lateNow) insights.push({ tone: 'warn', icon: 'clock', text: tr('You haven\'t clocked in yet today. Your shift started at {time}.', { time: data.shift.start }), action: { label: tr('Clock in'), run: clockIn } });
  if (longShift) insights.push({ tone: 'warn', icon: 'clock', text: tr('You\'ve been clocked in since {time} on {date}. Clock out if you have finished.', { time: att.clockIn, date: fmtDate(att.date) }), action: { label: tr('Clock out'), run: clockOut } });
  if (overdue.length) insights.push({ tone: 'bad', icon: 'check', text: overdue.length === 1 ? tr('"{title}" was due {date}.', { title: overdue[0].title, date: fmtDate(overdue[0].dueDate) }) : tr('{n} of your work orders are past their due date.', { n: overdue.length }), action: { label: tr('Open work orders'), run: () => navigate('/tasks') } });
  if (data.approvalsWaiting) insights.push({ tone: 'warn', icon: 'people', text: data.approvalsWaiting === 1 ? tr('One request is waiting for your decision.') : tr('{n} requests are waiting for your decision.', { n: data.approvalsWaiting }), action: { label: tr('Open'), run: () => navigate('/approvals') } });
  if (toConfirm.length) insights.push({ tone: 'warn', icon: 'info', text: toConfirm.length === 1 ? tr('Please read and confirm "{title}".', { title: toConfirm[0].title }) : tr('{n} announcements need you to confirm you have read them.', { n: toConfirm.length }), action: { label: tr('Open'), run: () => navigate('/announcements') } });
  else if (unreadNews.length) insights.push({ tone: 'info', icon: 'info', text: unreadNews.length === 1 ? tr('New announcement: "{title}".', { title: unreadNews[0].title }) : tr('{n} announcements you haven\'t read.', { n: unreadNews.length }), action: { label: tr('Open'), run: () => navigate('/announcements') } });
  if (pendingLeave.length) insights.push({ tone: 'info', icon: 'calendar', text: pendingLeave.length === 1 ? tr('Your {type} request for {date} is waiting for a decision.', { type: pendingLeave[0].typeName.toLowerCase(), date: fmtDate(pendingLeave[0].startDate) }) : tr('{n} of your leave requests are waiting for a decision.', { n: pendingLeave.length }), action: { label: tr('Show'), run: () => jump('msp-leave') } });
  if (recentNo.length) insights.push({ tone: 'info', icon: 'calendar', text: tr('Your {type} request was turned down: "{note}"', { type: recentNo[0].typeName.toLowerCase(), note: recentNo[0].decisionNote }), action: null });
  if (owedTotal) insights.push({ tone: 'good', icon: 'cash', text: tr('{amount} of your claims is approved and waiting to be paid out.', { amount: money(owedTotal, 'GHS') }), action: { label: tr('Show'), run: () => jump('msp-money') } });
  if (owedOnSheet) insights.push({ tone: 'info', icon: 'cash', text: tr('The company owes you {amount} on your expense sheet. Finance pays it back.', { amount: money(owedOnSheet, 'GHS') }), action: { label: tr('Open my sheet'), run: () => navigate('/expensesheets?sheet=' + sheet.id) } });
  if (sheet && sheet.topupWaiting) insights.push({ tone: 'info', icon: 'cash', text: tr('Your top-up of {amount} is waiting for finance.', { amount: money(sheet.topupWaiting, 'GHS') }), action: null });
  if (lpool && lpool.owedOutstanding > 0) insights.push({ tone: 'warn', icon: 'warn', text: tr('You have taken {n} day(s) more than your leave for {year}. They are owed to the company; HR will settle them with you.', { n: lpool.owedOutstanding, year: lpool.year }), action: { label: tr('Show'), run: () => jump('msp-leave') } });
  if (yearEnd) insights.push({ tone: 'info', icon: 'calendar', text: tr('You still have {n} days of paid leave this year. Plan them before 31 December.', { n: leftDays }), action: { label: tr('Request leave'), run: () => navigate('/leave') } });
  if (!twoStepOn) insights.push({ tone: 'warn', icon: 'warn', text: tr('Two-step sign-in is off. Turn it on so a stolen password alone can\'t open your account.'), action: { label: tr('Turn it on'), run: () => jump('msp-account') } });
  if (!insights.length) insights.push({ tone: 'good', icon: 'check', text: tr('Nothing needs you right now.') });

  // The last 14 days, today last, with gaps shown as days without a record.
  const byDate = Object.fromEntries(data.recent.map((r) => [r.date, r]));
  const strip = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i); strip.push({ date: isoDay(d), row: byDate[isoDay(d)] || null, weekday: d.getDay(), today: i === 0 }); }

  const f = data.fun || { streak: 0, bestStreak: 0, week: [], weekHours: 0, lastWeekHours: 0, team: { size: 0, people: [] } };
  const sky = skyOf(now);
  const todayIso = data.today || isoDay(now);
  const tiles = [
    { icon: 'calendar', value: String(leftDays), label: tr('days of paid leave left'), note: pendingDays ? tr('{n} more waiting for a decision', { n: pendingDays }) : tr('of {n} this year', { n: entitled }), ring: entitled ? leftDays / entitled : null, tone: 'leave', onClick: () => jump('msp-leave') },
    { icon: 'clock', value: onTime === null ? '—' : onTime + '%', label: tr('on time this month'), note: tr('{days} days · {hours} hours worked', { days: data.month.days, hours: data.month.hours }), ring: onTime === null ? null : onTime / 100, tone: onTime === null ? 'time' : onTime >= 90 ? 'time' : onTime < 70 ? 'warn' : 'time', onClick: () => jump('msp-day') },
    { icon: 'check', value: String(data.tasks.length), label: tr('work orders open for you'), note: overdue.length ? tr('{n} overdue', { n: overdue.length }) : tr('{n} done this month', { n: data.tasksDoneThisMonth }), tone: overdue.length ? 'bad' : 'work', onClick: () => jump('msp-work') },
    owedTotal
      ? { icon: 'cash', value: money(owedTotal, 'GHS'), label: tr('approved claims not paid yet'), note: owed.length === 1 ? tr('1 claim') : tr('{n} claims', { n: owed.length }), tone: 'money', onClick: () => jump('msp-money') }
      : owedOnSheet
      ? { icon: 'cash', value: money(owedOnSheet, 'GHS'), label: tr('owed to you on your expense sheet'), note: tr('finance pays it back'), tone: 'money', onClick: () => jump('msp-money') }
      : { icon: 'cash', value: lastPay ? money(lastPay.net, 'GHS') : '—', label: tr('last take-home pay'), note: lastPay ? tr('for {from} – {to}', { from: fmtDate(lastPay.periodStart), to: fmtDate(lastPay.periodEnd) }) : tr('no payslip yet'), tone: 'money', onClick: () => jump('msp-money') }
  ];

  // What is coming up, soonest first.
  const coming = [];
  if (f.nextLeave) coming.push(f.nextLeave.onNow
    ? { key: 'leave', glyph: 'plane', days: 0, tone: 'leave', label: tr('You are on {type}', { type: f.nextLeave.type.toLowerCase() }), date: tr('until {date}', { date: fmtDate(f.nextLeave.endDate) }) }
    : { key: 'leave', glyph: 'plane', days: f.nextLeave.daysTo, tone: 'leave', label: tr('Your {type} starts', { type: f.nextLeave.type.toLowerCase() }), date: longDay(f.nextLeave.startDate) + ' · ' + (f.nextLeave.days === 1 ? tr('1 day') : tr('{n} days', { n: f.nextLeave.days })) });
  if (lastPay && lastPay.status !== 'paid' && lastPay.payDate && String(lastPay.payDate).slice(0, 10) >= todayIso) coming.push({ key: 'pay', glyph: 'cash', days: Math.round((new Date(String(lastPay.payDate).slice(0, 10) + 'T00:00') - new Date(todayIso + 'T00:00')) / 86400000), tone: 'money', label: tr('Payday'), date: longDay(lastPay.payDate) + ' · ' + money(lastPay.net, 'GHS') });
  if (f.nextHoliday) coming.push({ key: 'holiday', glyph: 'flag', days: f.nextHoliday.daysTo, tone: 'holiday', label: f.nextHoliday.name, date: longDay(f.nextHoliday.date) });
  if (f.birthday) coming.push({ key: 'birthday', glyph: 'cake', days: f.birthday.daysTo, tone: 'birthday', label: f.birthday.daysTo === 0 ? tr('Happy birthday!') : tr('Your birthday'), date: longDay(f.birthday.date) });
  if (f.anniversary) coming.push({ key: 'anniversary', glyph: 'medal', days: f.anniversary.daysTo, tone: 'anniversary', label: f.anniversary.years === 1 ? tr('1 year with us') : tr('{n} years with us', { n: f.anniversary.years }), date: longDay(f.anniversary.date) });
  coming.sort((a, b) => a.days - b.days);

  const safety = [
    { ok: true, label: tr('Password'), text: tr('Set. Change it if anyone else may know it.') },
    { ok: !!twoStepOn, label: tr('Two-step sign-in'), text: twoStepOn ? [data.account.twoStep.app && tr('authenticator app'), data.account.twoStep.sms && tr('text message'), data.account.twoStep.email && tr('email code')].filter(Boolean).join(', ') : tr('Off — password only') },
    { ok: true, neutral: !data.account.claudeConnected, label: tr('Claude app'), text: data.account.claudeConnected ? tr('Connected') : tr('Not connected') }
  ];
  const strong = safety.filter((s) => s.ok && !s.neutral).length;

  return (
    <div className="dk tl msp msx">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <MeBanner sky={sky} eyebrow={tr('My space') + ' · ' + longDay(todayIso)} title={greeting(now, p.firstName)}
        sub={[p.title, p.department, p.company].filter(Boolean).join(' · ') || tr('Your day, your leave, your work and your pay, in one place. Only you see this page.')}
        person={p}
        clock={{ now, att, shift: data.shift, onDuty, canSelf, clocking, onIn: clockIn, onOut: clockOut }} />

      <div className="msx-tiles">{tiles.map((t, i) => <Tile key={i} {...t} />)}</div>

      <Insights items={insights.slice(0, 5)} />

      <Section id="msp-day" title={tr('Your fortnight and your week')} sub={tr('Each of the last 14 days, your on-time run, and the hours you have worked this week.')}>
        <div className="msx-two">
          <Fortnight strip={strip} month={data.month} streak={f.streak} best={f.bestStreak} />
          <Week week={f.week} total={f.weekHours} last={f.lastWeekSoFar !== undefined ? f.lastWeekSoFar : f.lastWeekHours} today={todayIso}
            live={onDuty && att.date === todayIso ? Math.max(0, (now - new Date(att.date + 'T' + att.clockIn + ':00')) / 3600000) : 0} />
        </div>
      </Section>

      {coming.length > 0 && (
        <Section title={tr('Coming up for you')} sub={tr('Your next leave, payday, public holiday, birthday and work anniversary, counted down.')}>
          <ComingUp items={coming} />
        </Section>
      )}

      <Section id="msp-leave" title={tr('Leave')} sub={tr('What you have left this year and what you asked for.')} action={<Link className="btn btn-secondary" to="/leave">{tr('Request leave')}</Link>}>
        {lpool && <LeavePool pool={lpool} mine />}
        {ownBalances.length > 0 && (
          <div className="msx-leaves">
            {ownBalances.map((b) => {
              const share = b.entitled > 0 ? Math.max(0, Math.min(1, b.left / b.entitled)) : 0;
              const r = 30, c = 2 * Math.PI * r;
              return (
                <div className="msx-leave" key={b.leaveTypeId}>
                  <span className="msx-leave-ring" role="img" aria-label={tr('{left} of {entitled} left', { left: b.left, entitled: b.entitled })}>
                    <svg viewBox="0 0 72 72" width="72" height="72"><circle cx="36" cy="36" r={r} className="msx-ring-track" /><circle cx="36" cy="36" r={r} className="msx-ring-fill" strokeDasharray={c} strokeDashoffset={c * (1 - share)} transform="rotate(-90 36 36)" /></svg>
                    <b>{b.left}</b>
                  </span>
                  <span className="msx-leave-text">
                    <strong>{b.name}{!b.paid && <small> · {tr('unpaid')}</small>}</strong>
                    <span>{tr('{left} of {entitled} left', { left: b.left, entitled: b.entitled })}</span>
                    <small>{tr('{used} used', { used: b.used })}{b.pending ? ' · ' + tr('{n} waiting', { n: b.pending }) : ''}</small>
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {!data.balances.length && !lpool && <p className="dk-muted">{tr('No leave balances set up yet.')}</p>}
        {data.leave.length > 0 && (
          <ul className="msx-list">
            {data.leave.slice(0, 8).map((l) => (
              <li key={l.id} className={'is-' + l.status}>
                <span className="msx-list-icon"><Icon name="calendar" /></span>
                <span className="msx-main">
                  <strong>{l.typeName} · {l.days === 1 ? tr('1 day') : tr('{n} days', { n: l.days })}</strong>
                  <span className="msx-muted">{fmtDate(l.startDate)}{l.endDate !== l.startDate ? ' → ' + fmtDate(l.endDate) : ''}{l.decisionNote ? ' · “' + l.decisionNote + '”' : ''}</span>
                </span>
                <Status tone={l.status === 'approved' ? 'good' : l.status === 'rejected' ? 'bad' : l.status === 'pending' ? 'warn' : 'muted'}>{codeLabel(l.status)}</Status>
                {l.status === 'pending' && <button type="button" className="msp-link" onClick={() => cancelLeave(l)}>{tr('Cancel')}</button>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="msp-work" title={tr('My work orders')} sub={tr('Open work orders you are on or manage, soonest due first.')} action={<Link className="btn btn-secondary" to="/tasks">{tr('Open work orders')}</Link>}>
        {!data.tasks.length ? <div className="dk-empty"><p>{tr('No open work orders. Nice.')}</p></div> : (
          <div className="msx-wos">
            {data.tasks.slice(0, 9).map((t) => {
              const days = t.dueDate ? dayNum(t.dueDate) - todayNum() : null;
              const late = days !== null && days < 0;
              const soon = days !== null && days >= 0 && days <= 7;
              return (
                <Link key={t.id} to={'/tasks?open=' + t.id} className={'msx-wo' + (late ? ' is-late' : soon ? ' is-soon' : '')}>
                  <span className="msx-wo-top">{t.number && <span className="msp-wo">{t.number}</span>}{t.priority === 'high' && <Status tone="bad">{tr('High priority')}</Status>}<span style={{ flex: 1 }} />{t.managing && <span className="msx-muted">{tr('you manage it')}</span>}</span>
                  <strong>{t.title}</strong>
                  {t.project && <span className="msx-muted">{t.project}</span>}
                  <span className="msx-wo-due">
                    <span className={'msx-due' + (late ? ' is-late' : soon ? ' is-soon' : '')}>
                      {days === null ? tr('no due date') : late ? (days === -1 ? tr('1 day late') : tr('{n} days late', { n: -days })) : days === 0 ? tr('due today') : days === 1 ? tr('due tomorrow') : tr('due in {n} days', { n: days })}
                    </span>
                    <Status tone={late ? 'bad' : TASK_DONE.includes(t.status) ? 'good' : 'muted'}>{woStatusLabel(t.status)}</Status>
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </Section>

      <Section id="msp-money" title={tr('My money')} sub={tr('Your payslips, your expense sheet and purchase requests.')} action={<Link className="btn btn-secondary" to={sheet ? '/expensesheets?sheet=' + sheet.id : '/expensesheets'}>{sheet ? tr('Open my expense sheet') : tr('I paid for something')}</Link>}>
        <div className="msx-two">
          <div className="msx-card">
            <h4 className="msp-h4">{tr('Payslips')}</h4>
            {!data.payslips.length ? <p className="dk-muted">{tr('Your payslips show here once payroll approves a pay run.')}</p> : (
              <>
                <PayCard slip={data.payslips[0]} />
                {data.payslips.length > 1 && (
                  <ul className="msx-list">
                    {data.payslips.slice(1).map((s) => (
                      <li key={s.runNo}>
                        <span className="msx-list-icon"><Icon name="cash" /></span>
                        <span className="msx-main"><strong>{fmtDate(s.periodStart)} – {fmtDate(s.periodEnd)}</strong><span className="msx-muted">{tr('{days} days · gross {gross}', { days: s.daysWorked, gross: money(s.gross, 'GHS') })}</span></span>
                        <span className="msp-net"><strong>{money(s.net, 'GHS')}</strong><span className="msx-muted">{s.status === 'paid' ? tr('paid {date}', { date: fmtDate(s.payDate) }) : tr('to be paid {date}', { date: fmtDate(s.payDate) })}</span></span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
          <div className="msx-card">
            <h4 className="msp-h4">{tr('My expense sheet')}</h4>
            {sheet ? (
              <Link className="msx-sheet" to={'/expensesheets?sheet=' + sheet.id}>
                <span className={'msx-sheet-bal' + (sheet.balance < 0 ? ' is-owed' : '')}>
                  <small>{sheet.balance < 0 ? tr('owed to you') : tr('cash in hand')}</small>
                  <strong>{money(Math.abs(sheet.balance), 'GHS')}</strong>
                  {sheet.floatLimit ? <small>{tr('float {amount}', { amount: money(sheet.floatLimit, 'GHS') })}</small> : null}
                </span>
                <span className="msx-sheet-facts">
                  <span>{tr('Spent this month')} <b>{money(sheet.spentThisMonth, 'GHS')}</b></span>
                  <span>{tr('Last check')} <b>{sheet.checkedUntil ? fmtDate(sheet.checkedUntil) : tr('never')}</b></span>
                  {sheet.uncheckedLines > 0 && <span>{sheet.uncheckedLines === 1 ? tr('1 line waiting for a check') : tr('{n} lines waiting for a check', { n: sheet.uncheckedLines })}</span>}
                </span>
              </Link>
            ) : <p className="dk-muted">{tr('No expense sheet. If you pay for something for the company from your own pocket, record it and finance pays you back.')}</p>}
            {data.claims.length > 0 && <h4 className="msp-h4">{tr('Older expense claims')}</h4>}
            {data.claims.length > 0 && (
              <ul className="msx-list">
                {data.claims.slice(0, 6).map((c) => (
                  <li key={c.id}>
                    <span className="msx-list-icon"><Icon name="receipt" /></span>
                    <span className="msx-main"><strong>{c.category} · {money(c.amount, 'GHS')}</strong><span className="msx-muted">{fmtDate(c.date)}{c.note ? ' · “' + c.note + '”' : ''}{!c.hasReceipt && c.status === 'pending' ? ' · ' + tr('no receipt attached') : ''}</span></span>
                    <Status tone={c.status === 'paid' ? 'good' : c.status === 'approved' ? 'info' : c.status === 'rejected' ? 'bad' : 'warn'}>{c.status === 'approved' ? tr('Approved · to pay out') : c.status === 'paid' ? tr('Paid out') : codeLabel(c.status)}</Status>
                  </li>
                ))}
              </ul>
            )}
            {data.purchases.length > 0 && (
              <>
                <h4 className="msp-h4">{tr('Purchase requests')}</h4>
                <ul className="msx-list">
                  {data.purchases.slice(0, 5).map((r) => (
                    <li key={r.id}>
                      <span className="msx-list-icon"><Icon name="bag" /></span>
                      <span className="msx-main"><strong>{r.quantity} × {r.item}</strong><span className="msx-muted">{fmtDate(r.createdAt)} · {tr('about {amount}', { amount: money(r.estimatedPrice, 'GHS') })}</span></span>
                      <Status tone={r.status === 'rejected' ? 'bad' : r.status === 'pending' ? 'warn' : 'good'}>{codeLabel(r.status)}</Status>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      </Section>

      <Section id="msp-account" title={tr('About me')} sub={tr('Your record, your team and how you sign in. Ask HR if something here is wrong.')}>
        <div className="msx-about">
          <div className="msx-idcard">
            <div className="msx-idcard-band"><span>{p.company || 'Bamboo OS'}</span><span>{p.code}</span></div>
            <div className="msx-idcard-who">
              <span className="msx-idcard-photo"><Photo id={p.id} name={p.name} photo={p.photo} size={84} /></span>
              <div>
                <h3>{p.name}</h3>
                <span>{[p.title, p.department].filter(Boolean).join(' · ')}</span>
                {years !== null && <span className="msx-badge">{years === 0 ? tr('New this year') : years === 1 ? tr('1 year with us') : tr('{n} years with us', { n: years })}</span>}
              </div>
            </div>
            <dl className="msx-facts">
              <div><dt>{tr('Manager')}</dt><dd>{p.manager || '—'}</dd></div>
              <div><dt>{tr('With us since')}</dt><dd>{p.hireDate ? fmtDate(p.hireDate) : '—'}</dd></div>
              <div><dt>{tr('Shift')}</dt><dd>{shiftText}</dd></div>
              <div><dt>{tr('Employment')}</dt><dd>{p.employmentType ? codeLabel(p.employmentType) : '—'}</dd></div>
              <div><dt>{tr('Phone')}</dt><dd>{p.phone || '—'}</dd></div>
              <div><dt>{tr('Email')}</dt><dd className="msp-wrap">{p.email || '—'}</dd></div>
            </dl>
          </div>
          <div className="msx-side">
            {f.team && f.team.size > 0 && (
              <div className="msx-card msx-team">
                <h4 className="msp-h4">{tr('Your team')}{p.department ? ' · ' + p.department : ''}</h4>
                <div className="msx-team-faces">
                  {f.team.people.map((m) => (
                    <span key={m.id} className="msx-mate" title={m.name + (m.title ? ' · ' + m.title : '')}>
                      <Photo id={m.id} name={m.name} photo={m.photo} size={44} />
                      <small>{m.name.split(' ').slice(-2).join(' ')}</small>
                    </span>
                  ))}
                  {f.team.size > f.team.people.length && <span className="msx-mate is-more"><span>+{f.team.size - f.team.people.length}</span><small>{tr('more')}</small></span>}
                </div>
                <p className="msx-muted">{f.team.size === 1 ? tr('1 other person works in your department.') : tr('{n} other people work in your department.', { n: f.team.size })}{p.manager ? ' ' + tr('Your manager is {name}.', { name: p.manager }) : ''}</p>
              </div>
            )}
            <div className="msx-card msx-safety">
              <div className="msx-safety-head">
                <span className={'msx-shield' + (twoStepOn ? ' is-good' : ' is-warn')} aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z" /><path d={twoStepOn ? 'm8.5 12 2.5 2.5 4.5-5' : 'M12 8v5M12 16h.01'} /></svg></span>
                <span><strong>{twoStepOn ? tr('Your account is well protected') : tr('Your account could be safer')}</strong><small>{tr('{n} of 2 protections on', { n: strong })} · {tr('Login email')}: {data.account.email}</small></span>
              </div>
              <ul className="msx-checks">
                {safety.map((s) => (
                  <li key={s.label} className={s.neutral ? 'is-neutral' : s.ok ? 'is-ok' : 'is-off'}>
                    <span className="msx-check" aria-hidden="true">{s.neutral ? '–' : s.ok ? '✓' : '!'}</span>
                    <span><b>{s.label}</b><small>{s.text}</small></span>
                  </li>
                ))}
              </ul>
              <div className="msx-row">
                <span className="msx-muted">{tr('Roles')}: {(data.account.roles || []).join(', ') || '—'}</span>
                <span style={{ flex: 1 }} />
                <button type="button" className="btn btn-secondary" onClick={() => { setPwError(null); setPw(EMPTY_PW); setPwOpen(true); }}>{tr('Change password')}</button>
              </div>
            </div>
          </div>
        </div>
        <h4 className="msp-h4">{tr('Two-step sign-in')}</h4>
        <TwoStepSettings />
      </Section>

      <Glossary items={[
        [tr('On time'), tr('Clocked in no later than your shift start plus the grace the company allows. Days marked late or absent by a supervisor count too.')],
        [tr('Days of paid leave left'), tr('Your entitlement this year minus what you have used, for paid leave types. Requests still waiting are not taken off until approved.')],
        [tr('Clocked out by the system'), tr('Shifts you forgot to clock out of. The system closes them after a set time — tell your supervisor if you left at a different time.')],
        [tr('Take-home pay'), tr('What reaches you after SSNIT and PAYE are taken off the gross. Where the company pays your PAYE, only SSNIT is taken off.')],
        [tr('Two-step sign-in'), tr('A code from your phone or email as well as your password, so a stolen password alone can\'t open your account.')]
      ]} />

      {pwOpen && (
        <div className="dialog-backdrop" onClick={() => setPwOpen(false)}>
          <form className="dialog msp-pw" onClick={(e) => e.stopPropagation()} onSubmit={changePassword}>
            <h2>{tr('Change password')}</h2>
            <div className="field"><label htmlFor="msp-cur">{tr('Current password')}</label><input id="msp-cur" className="input" type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} required /></div>
            <div className="field"><label htmlFor="msp-new">{tr('New password')}</label><input id="msp-new" className="input" type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} required /></div>
            <div className="field"><label htmlFor="msp-conf">{tr('Confirm new password')}</label><input id="msp-conf" className="input" type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required /></div>
            <p className="dk-muted tl-small">{tr('At least 8 characters. Any Claude app connected to your account will need to sign in again.')}</p>
            {pwError && <div className="error-banner">{pwError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setPwOpen(false)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={pwSaving}>{pwSaving ? tr('Saving…') : tr('Change password')}</button>
            </div>
          </form>
        </div>
      )}

      {autoClosed && (
        <div className="dialog-backdrop" onClick={() => setAutoClosed(null)}>
          <div className="dialog" role="alertdialog" aria-labelledby="myspace-autoclosed-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="myspace-autoclosed-title">{tr('Your last shift was not clocked out')}</h2>
            <p className="dialog-body">
              {tr('You clocked in at {clockIn} on {date} but didn\'t clock out, so the system clocked you out automatically at {clockOut}, {hours} hours later.', {
                clockIn: autoClosed[0].clockIn, date: noticeDate(autoClosed[0].date), clockOut: autoClosed[0].clockOut, hours: shiftHours(autoClosed[0])
              })}
            </p>
            {autoClosed.length > 1 && (
              <p className="dialog-body">
                {autoClosed.length === 2 ? tr('One earlier shift was also clocked out automatically.') : tr('{n} earlier shifts were also clocked out automatically.', { n: autoClosed.length - 1 })}
              </p>
            )}
            <p className="dialog-body">{tr('If you left at a different time, tell your supervisor so they can correct it. Remember to clock out at the end of every shift.')}</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-primary" onClick={() => setAutoClosed(null)}>{tr('OK, got it')}</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
