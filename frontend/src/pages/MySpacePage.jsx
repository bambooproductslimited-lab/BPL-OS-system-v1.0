import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import TwoStepSettings from '../components/TwoStepSettings';
import Photo from '../components/Photo';
import { Glossary, Hero, Insights, Section, Status, fmtDate, jump } from '../components/DashKit';
import { money } from '../lib/currency';
import { tr, activeIntlLocale } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import './ToolRoomPage.css';
import './MySpacePage.css';

// My space — the signed-in person's own day, leave, work, money and
// account, in the same "explains itself" layout as the dashboards
// (components/DashKit.jsx): leave days left, how often they were on time
// this month, open tasks, money owed to them or their last pay; what needs
// them (clock in, overdue tasks, announcements to confirm, approvals
// waiting, leave to plan, two-step sign-in off); then today's clock with the
// last two weeks, leave balances and requests, tasks, claims, purchase
// requests and payslips, and their profile and sign-in safety
// (GET /api/me/overview — mySpace.service.js — only ever their own).
//
// Clock in / out needs attendance.self; everything else is self-service.
// Payslips appear once payroll has approved the run.

function fmtElapsed(hhmm, now) {
  const [h, m] = hhmm.split(':').map(Number);
  const start = new Date(now);
  start.setHours(h, m, 0, 0);
  const diffMs = Math.max(0, now.getTime() - start.getTime());
  return Math.floor(diffMs / 3600000) + 'h ' + Math.floor((diffMs % 3600000) / 60000) + 'm';
}
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

const DAY_TONE = { present: 'good', late: 'warn', absent: 'bad', half_day: 'info' };
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
  const shiftText = data.shift.start ? (data.shift.name ? data.shift.name + ' · ' : '') + data.shift.start + '–' + (data.shift.end || '?') : ((session && session.employee && session.employee.shift) || tr('No shift set'));
  const paid = data.balances.filter((b) => b.paid);
  const leftDays = paid.reduce((s, b) => s + b.left, 0);
  const pendingDays = data.balances.reduce((s, b) => s + b.pending, 0);
  const entitled = paid.reduce((s, b) => s + b.entitled, 0);
  const onTime = data.month.days ? Math.round(((data.month.days - data.month.late) / data.month.days) * 100) : null;
  const overdue = data.tasks.filter((t) => t.dueDate && dayNum(t.dueDate) < todayNum());
  const dueSoon = data.tasks.filter((t) => t.dueDate && dayNum(t.dueDate) >= todayNum() && dayNum(t.dueDate) - todayNum() <= 7);
  const owed = data.claims.filter((c) => c.status === 'approved');
  const owedTotal = owed.reduce((s, c) => s + c.amount, 0);
  const waitingClaims = data.claims.filter((c) => c.status === 'pending');
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

  const stats = [
    { icon: 'calendar', value: String(leftDays), label: tr('days of paid leave left'), note: pendingDays ? tr('{n} more waiting for a decision', { n: pendingDays }) : tr('of {n} this year', { n: entitled }), onClick: () => jump('msp-leave') },
    { icon: 'clock', value: onTime === null ? '—' : onTime + '%', label: tr('on time this month'), note: tr('{days} days · {hours} hours worked', { days: data.month.days, hours: data.month.hours }), tone: onTime === null ? '' : onTime >= 90 ? 'good' : onTime < 70 ? 'warn' : '', onClick: () => jump('msp-day') },
    { icon: 'check', value: String(data.tasks.length), label: tr('tasks open for you'), note: overdue.length ? tr('{n} overdue', { n: overdue.length }) : tr('{n} done this month', { n: data.tasksDoneThisMonth }), tone: overdue.length ? 'bad' : '', onClick: () => jump('msp-work') },
    owedTotal
      ? { icon: 'cash', value: money(owedTotal, 'GHS'), label: tr('approved claims not paid yet'), note: owed.length === 1 ? tr('1 claim') : tr('{n} claims', { n: owed.length }), tone: 'info', onClick: () => jump('msp-money') }
      : { icon: 'cash', value: lastPay ? money(lastPay.net, 'GHS') : '—', label: tr('last take-home pay'), note: lastPay ? tr('for {from} – {to}', { from: fmtDate(lastPay.periodStart), to: fmtDate(lastPay.periodEnd) }) : tr('no payslip yet'), onClick: () => jump('msp-money') }
  ];

  const insights = [];
  if (lateNow) insights.push({ tone: 'warn', icon: 'clock', text: tr('You haven\'t clocked in yet today. Your shift started at {time}.', { time: data.shift.start }), action: { label: tr('Clock in'), run: clockIn } });
  if (longShift) insights.push({ tone: 'warn', icon: 'clock', text: tr('You\'ve been clocked in since {time} on {date}. Clock out if you have finished.', { time: att.clockIn, date: fmtDate(att.date) }), action: { label: tr('Clock out'), run: clockOut } });
  if (overdue.length) insights.push({ tone: 'bad', icon: 'check', text: overdue.length === 1 ? tr('"{title}" was due {date}.', { title: overdue[0].title, date: fmtDate(overdue[0].dueDate) }) : tr('{n} of your tasks are past their due date.', { n: overdue.length }), action: { label: tr('Open Tasks'), run: () => navigate('/tasks') } });
  if (data.approvalsWaiting) insights.push({ tone: 'warn', icon: 'people', text: data.approvalsWaiting === 1 ? tr('One request is waiting for your decision.') : tr('{n} requests are waiting for your decision.', { n: data.approvalsWaiting }), action: { label: tr('Open'), run: () => navigate('/approvals') } });
  if (toConfirm.length) insights.push({ tone: 'warn', icon: 'info', text: toConfirm.length === 1 ? tr('Please read and confirm "{title}".', { title: toConfirm[0].title }) : tr('{n} announcements need you to confirm you have read them.', { n: toConfirm.length }), action: { label: tr('Open'), run: () => navigate('/announcements') } });
  else if (unreadNews.length) insights.push({ tone: 'info', icon: 'info', text: unreadNews.length === 1 ? tr('New announcement: "{title}".', { title: unreadNews[0].title }) : tr('{n} announcements you haven\'t read.', { n: unreadNews.length }), action: { label: tr('Open'), run: () => navigate('/announcements') } });
  if (pendingLeave.length) insights.push({ tone: 'info', icon: 'calendar', text: pendingLeave.length === 1 ? tr('Your {type} request for {date} is waiting for a decision.', { type: pendingLeave[0].typeName.toLowerCase(), date: fmtDate(pendingLeave[0].startDate) }) : tr('{n} of your leave requests are waiting for a decision.', { n: pendingLeave.length }), action: { label: tr('Show'), run: () => jump('msp-leave') } });
  if (recentNo.length) insights.push({ tone: 'info', icon: 'calendar', text: tr('Your {type} request was turned down: "{note}"', { type: recentNo[0].typeName.toLowerCase(), note: recentNo[0].decisionNote }), action: null });
  if (owedTotal) insights.push({ tone: 'good', icon: 'cash', text: tr('{amount} of your claims is approved and waiting to be paid out.', { amount: money(owedTotal, 'GHS') }), action: { label: tr('Show'), run: () => jump('msp-money') } });
  if (yearEnd) insights.push({ tone: 'info', icon: 'calendar', text: tr('You still have {n} days of paid leave this year. Plan them before 31 December.', { n: leftDays }), action: { label: tr('Request leave'), run: () => navigate('/leave') } });
  if (!twoStepOn) insights.push({ tone: 'warn', icon: 'warn', text: tr('Two-step sign-in is off. Turn it on so a stolen password alone can\'t open your account.'), action: { label: tr('Turn it on'), run: () => jump('msp-account') } });
  if (!insights.length) insights.push({ tone: 'good', icon: 'check', text: tr('Nothing needs you right now.') });

  // The last 14 days, today last, with gaps shown as days without a record.
  const byDate = Object.fromEntries(data.recent.map((r) => [r.date, r]));
  const strip = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i); strip.push({ date: isoDay(d), row: byDate[isoDay(d)] || null, weekday: d.getDay() }); }

  return (
    <div className="dk tl msp">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('My space')}
        title={greeting(now, p.firstName)}
        sub={tr('Your day, your leave, your work and your pay, in one place. Only you see this page. Press a number to go to it.')}
        actions={canSelf && (
          att && !att.clockOut
            ? <button type="button" className="btn btn-secondary" disabled={clocking} onClick={clockOut}>{tr('Clock out')}</button>
            : !att ? <button type="button" className="btn btn-primary" disabled={clocking} onClick={clockIn}>{tr('Clock in')}</button> : null
        )}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <Section id="msp-day" title={tr('Today')} sub={tr('Your clock, and the last two weeks.')}>
        <div className="myspace-top">
          <section className="card myspace-clock">
            <div className="myspace-clock-head">
              <div className="myspace-eyebrow">{tr('Today ·')} {shiftText}</div>
              <div className={'myspace-status-pill' + (onDuty ? ' myspace-status-pill-on' : '')}>
                <span className="myspace-status-dot" />
                {onDuty ? tr('On duty') : att ? tr('Shift complete') : tr('Not clocked in')}
              </div>
            </div>
            <div className="myspace-live-time">{now.toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
            <div className="myspace-headline">{att ? (att.clockOut ? att.clockIn + ' → ' + att.clockOut : tr('On duty since {time}', { time: att.clockIn })) : tr('Not clocked in')}</div>
            <div className="myspace-detail">
              {att ? (att.status === 'late' ? tr('Recorded as late.') : tr('Recorded as present.')) : tr('Clock in to start today’s record.')}
              {onDuty && tr(' · {elapsed} so far', { elapsed: fmtElapsed(att.clockIn, now) })}
            </div>
            {canSelf && (
              <div className="myspace-actions">
                <button type="button" className="btn btn-primary" disabled={!!att || clocking} onClick={clockIn}>{tr('Clock in')}</button>
                <button type="button" className="btn btn-secondary" disabled={!att || !!att.clockOut || clocking} onClick={clockOut}>{tr('Clock out')}</button>
              </div>
            )}
          </section>
          <div className="msp-month card">
            <div className="msp-month-nums">
              <div><strong>{data.month.days}</strong><span>{tr('days worked this month')}</span></div>
              <div><strong>{data.month.late}</strong><span>{tr('late')}</span></div>
              <div><strong>{data.month.hours}</strong><span>{tr('hours')}</span></div>
              {data.month.autoOut > 0 && <div><strong>{data.month.autoOut}</strong><span>{tr('clocked out by the system')}</span></div>}
            </div>
            <ol className="msp-strip" aria-label={tr('The last 14 days')}>
              {strip.map((d) => (
                <li key={d.date} className={'msp-day is-' + (d.row ? d.row.status : d.weekday === 0 ? 'off' : 'none')} title={fmtDate(d.date) + (d.row ? ': ' + codeLabel(d.row.status) + ' ' + (d.row.clockIn || '') + (d.row.clockOut ? '–' + d.row.clockOut : '') : '')}>
                  <span className="msp-day-bar" />
                  <span className="msp-day-n">{new Date(d.date + 'T12:00').getDate()}</span>
                </li>
              ))}
            </ol>
            <div className="msp-legend dk-muted tl-small">
              <span><i className="is-present" />{tr('On time')}</span><span><i className="is-late" />{tr('Late')}</span><span><i className="is-absent" />{tr('Absent')}</span><span><i className="is-none" />{tr('No record')}</span>
            </div>
          </div>
        </div>
      </Section>

      <Section id="msp-leave" title={tr('Leave')} sub={tr('What you have left this year and what you asked for.')} action={<Link className="btn btn-secondary" to="/leave">{tr('Request leave')}</Link>}>
        <div className="myspace-balance-grid">
          {data.balances.map((b) => {
            const pct = b.entitled > 0 ? Math.min(100, Math.round((b.used / b.entitled) * 100)) : 0;
            return (
              <div className="myspace-balance-card" key={b.leaveTypeId}>
                <div className="myspace-balance-name">{b.name}{!b.paid && <span className="dk-muted tl-small"> · {tr('unpaid')}</span>}</div>
                <div className="myspace-balance-remaining">{b.left}<span className="myspace-balance-unit">{' '}{tr('/ {entitled} left', { entitled: b.entitled })}</span></div>
                <div className="myspace-balance-track"><div className="myspace-balance-bar" style={{ width: pct + '%' }} /></div>
                <div className="myspace-balance-used">{tr('{used} used', { used: b.used })}{b.pending ? ' · ' + tr('{n} waiting', { n: b.pending }) : ''}</div>
              </div>
            );
          })}
        </div>
        {!data.balances.length && <p className="dk-muted">{tr('No leave balances set up yet.')}</p>}
        {data.leave.length > 0 && (
          <ul className="msp-list">
            {data.leave.slice(0, 8).map((l) => (
              <li key={l.id}>
                <span className="msp-main">
                  <strong>{l.typeName} · {l.days === 1 ? tr('1 day') : tr('{n} days', { n: l.days })}</strong>
                  <span className="dk-muted tl-small">{fmtDate(l.startDate)}{l.endDate !== l.startDate ? ' → ' + fmtDate(l.endDate) : ''}{l.decisionNote ? ' · “' + l.decisionNote + '”' : ''}</span>
                </span>
                <Status tone={l.status === 'approved' ? 'good' : l.status === 'rejected' ? 'bad' : l.status === 'pending' ? 'warn' : 'muted'}>{codeLabel(l.status)}</Status>
                {l.status === 'pending' && <button type="button" className="msp-link" onClick={() => cancelLeave(l)}>{tr('Cancel')}</button>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="msp-work" title={tr('My tasks')} sub={tr('Open tasks assigned to you, soonest due first.')} action={<Link className="btn btn-secondary" to="/tasks">{tr('Open Tasks')}</Link>}>
        {!data.tasks.length ? <div className="dk-empty"><p>{tr('No open tasks. Nice.')}</p></div> : (
          <ul className="msp-list">
            {data.tasks.slice(0, 10).map((t) => {
              const late = t.dueDate && dayNum(t.dueDate) < todayNum();
              const soon = dueSoon.includes(t);
              return (
                <li key={t.id} className={late ? 'is-late' : ''}>
                  <span className="msp-main">
                    <strong>{t.title}</strong>
                    <span className="dk-muted tl-small">{[t.project, t.dueDate ? tr('due {date}', { date: fmtDate(t.dueDate) }) : tr('no due date')].filter(Boolean).join(' · ')}</span>
                  </span>
                  {t.priority === 'high' && <Status tone="bad">{tr('High priority')}</Status>}
                  <Status tone={late ? 'bad' : soon ? 'warn' : TASK_DONE.includes(t.status) ? 'good' : 'muted'}>{late ? tr('Overdue') : codeLabel(t.status)}</Status>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section id="msp-money" title={tr('My money')} sub={tr('Your expense claims, purchase requests and payslips.')} action={<Link className="btn btn-secondary" to="/expenses">{tr('New expense claim')}</Link>}>
        <div className="msp-money">
          <div>
            <h4 className="msp-h4">{tr('Expense claims')}</h4>
            {!data.claims.length ? <p className="dk-muted">{tr('No claims yet.')}</p> : (
              <ul className="msp-list">
                {data.claims.slice(0, 6).map((c) => (
                  <li key={c.id}>
                    <span className="msp-main"><strong>{c.category} · {money(c.amount, 'GHS')}</strong><span className="dk-muted tl-small">{fmtDate(c.date)}{c.note ? ' · “' + c.note + '”' : ''}{!c.hasReceipt && c.status === 'pending' ? ' · ' + tr('no receipt attached') : ''}</span></span>
                    <Status tone={c.status === 'paid' ? 'good' : c.status === 'approved' ? 'info' : c.status === 'rejected' ? 'bad' : 'warn'}>{c.status === 'approved' ? tr('Approved · to pay out') : c.status === 'paid' ? tr('Paid out') : codeLabel(c.status)}</Status>
                  </li>
                ))}
              </ul>
            )}
            {data.purchases.length > 0 && (
              <>
                <h4 className="msp-h4">{tr('Purchase requests')}</h4>
                <ul className="msp-list">
                  {data.purchases.slice(0, 5).map((r) => (
                    <li key={r.id}>
                      <span className="msp-main"><strong>{r.quantity} × {r.item}</strong><span className="dk-muted tl-small">{fmtDate(r.createdAt)} · {tr('about {amount}', { amount: money(r.estimatedPrice, 'GHS') })}</span></span>
                      <Status tone={r.status === 'rejected' ? 'bad' : r.status === 'pending' ? 'warn' : 'good'}>{codeLabel(r.status)}</Status>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
          <div>
            <h4 className="msp-h4">{tr('Payslips')}</h4>
            {!data.payslips.length ? <p className="dk-muted">{tr('Your payslips show here once payroll approves a pay run.')}</p> : (
              <ul className="msp-list">
                {data.payslips.map((s) => (
                  <li key={s.runNo}>
                    <span className="msp-main">
                      <strong>{fmtDate(s.periodStart)} – {fmtDate(s.periodEnd)}</strong>
                      <span className="dk-muted tl-small">{tr('{days} days · gross {gross} · SSNIT {ssnit} · PAYE {paye}', { days: s.daysWorked, gross: money(s.gross, 'GHS'), ssnit: money(s.ssnit, 'GHS'), paye: money(s.paye, 'GHS') })}</span>
                    </span>
                    <span className="msp-net"><strong>{money(s.net, 'GHS')}</strong><span className="dk-muted tl-small">{s.status === 'paid' ? tr('paid {date}', { date: fmtDate(s.payDate) }) : tr('to be paid {date}', { date: fmtDate(s.payDate) })}</span></span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Section>

      <Section id="msp-account" title={tr('About me')} sub={tr('Your record and how you sign in. Ask HR if something here is wrong.')}>
        <div className="msp-about">
          <div className="card msp-profile">
            <div className="tl-detail-head">
              <Photo id={p.id} name={p.name} photo={p.photo} size={56} />
              <div>
                <span className="dk-muted tl-small">{p.code}</span>
                <h3 className="msp-name">{p.name}</h3>
                <span className="dk-muted tl-small">{[p.title, p.department, p.company].filter(Boolean).join(' · ')}</span>
              </div>
            </div>
            <dl className="tl-facts">
              <div><dt>{tr('Manager')}</dt><dd>{p.manager || '—'}</dd></div>
              <div><dt>{tr('With us since')}</dt><dd>{p.hireDate ? fmtDate(p.hireDate) + (years ? ' · ' + (years === 1 ? tr('1 year') : tr('{n} years', { n: years })) : '') : '—'}</dd></div>
              <div><dt>{tr('Shift')}</dt><dd>{shiftText}</dd></div>
              <div><dt>{tr('Phone')}</dt><dd>{p.phone || '—'}</dd></div>
              <div><dt>{tr('Email')}</dt><dd className="msp-wrap">{p.email || '—'}</dd></div>
              <div><dt>{tr('Employment')}</dt><dd>{p.employmentType ? codeLabel(p.employmentType) : '—'}</dd></div>
            </dl>
          </div>
          <div className="card msp-profile">
            <h4 className="msp-h4">{tr('Signing in')}</h4>
            <dl className="tl-facts">
              <div><dt>{tr('Login email')}</dt><dd className="msp-wrap">{data.account.email}</dd></div>
              <div><dt>{tr('Roles')}</dt><dd>{(data.account.roles || []).join(', ') || '—'}</dd></div>
              <div><dt>{tr('Two-step sign-in')}</dt><dd>{twoStepOn ? [data.account.twoStep.app && tr('authenticator app'), data.account.twoStep.sms && tr('text message'), data.account.twoStep.email && tr('email code')].filter(Boolean).join(', ') : tr('Off — password only')}</dd></div>
              <div><dt>{tr('Claude app')}</dt><dd>{data.account.claudeConnected ? tr('Connected') : tr('Not connected')}</dd></div>
            </dl>
            <button type="button" className="btn btn-secondary" onClick={() => { setPwError(null); setPw(EMPTY_PW); setPwOpen(true); }}>{tr('Change password')}</button>
          </div>
        </div>
        <h4 className="msp-h4">{tr('Two-step sign-in')}</h4>
        <TwoStepSettings />
      </Section>

      <Glossary items={[
        [tr('On time'), tr('Clocked in no later than your shift start plus the grace the company allows. Days marked late or absent by a supervisor count too.')],
        [tr('Days of paid leave left'), tr('Your entitlement this year minus what you have used, for paid leave types. Requests still waiting are not taken off until approved.')],
        [tr('Clocked out by the system'), tr('Shifts you forgot to clock out of. The system closes them after a set time — tell your supervisor if you left at a different time.')],
        [tr('Take-home pay'), tr('What reaches you after SSNIT and PAYE are taken off the gross.')],
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
