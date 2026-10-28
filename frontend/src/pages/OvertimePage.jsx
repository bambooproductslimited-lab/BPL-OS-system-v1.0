import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import Photo from '../components/Photo';
import './seventeenth.css';
import './twentysecond.css';

// Overtime (People → Overtime; backend overtime.service.js, migration
// 0205): hours worked past the shift, asked for by the person or put in by
// their manager, approved here or in the Approval centre, and paid by the
// next pay run at the day's multiple — a weekday, a rest day or a public
// holiday. What the clock said that day is shown beside each one.

const KIND = { weekday: ['☀️', msg('Weekday')], rest_day: ['🛌', msg('Rest day')], holiday: ['🎉', msg('Public holiday')] };
const STATUS = { pending: ['⏳', msg('Waiting'), 'is-warn'], approved: ['✅', msg('Approved'), 'is-good'], rejected: ['✋', msg('Not approved'), 'is-bad'], paid: ['💸', msg('Paid'), 'is-teal'], cancelled: ['↩️', msg('Taken back'), ''] };

function dayText(d) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : '—'; }
function num(v, p = 2) { return v == null ? '—' : (Math.round(v * 10 ** p) / 10 ** p).toLocaleString(activeIntlLocale()); }
function today() { return new Date().toISOString().slice(0, 10); }
function hours(h) { return h === 1 ? tr('1 hour') : tr('{n} hours', { n: num(h) }); }

function Dialog({ title, icon, sub, onClose, onSubmit, children, busy, error, submit, width, danger }) {
  return createPortal(
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(' + (width || 540) + 'px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="ot-d-t" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">{icon}</span><div><h2 id="ot-d-t">{title}</h2>{sub && <p>{sub}</p>}</div></div>
        {children}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>{submit && <button type="submit" className={'btn ' + (danger ? 'btn-danger' : 'btn-primary')} disabled={busy}>{submit}</button>}</div>
      </form>
    </div>,
    document.body
  );
}
function useSend(onDone) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  return { busy, error, send: async (fn) => { setBusy(true); setError(null); try { onDone(await fn()); } catch (e) { setError(e.message); setBusy(false); } } };
}

function KindPill({ r }) {
  return <span className={'x7-pill ot-kind is-' + r.kind}>{KIND[r.kind][0]} {tr(KIND[r.kind][1])} · ×{num(r.multiple)}</span>;
}

function AskDialog({ d, forOther, onClose, onDone }) {
  const [f, setF] = useState({ employeeId: forOther ? '' : d.me.id, day: today(), hours: '2', reason: '', approve: false });
  const s = useSend(onDone);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Dialog title={forOther ? tr('Put in overtime for someone') : tr('Ask for overtime')} icon="⏱️" sub={forOther ? tr('For someone you look after: approve it now, or leave it for another approver.') : tr('Once it has been worked: your manager approves it, and the next pay run pays it.')}
      onClose={onClose} onSubmit={() => s.send(() => api.post('/overtime', { ...f, hours: Number(f.hours) }))} busy={s.busy} error={s.error} submit={forOther && f.approve ? tr('Put in and approve') : tr('Send it')}>
      {forOther && <label><span>{tr('Who worked it')}</span><select className="input" required value={f.employeeId} onChange={(e) => set('employeeId', e.target.value)}><option value="">—</option>{d.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
      <div className="x7-grid2">
        <label><span>{tr('The day')}</span><input className="input" type="date" required max={today()} value={f.day} onChange={(e) => set('day', e.target.value)} /></label>
        <label><span>{tr('Hours past the shift')}</span><input className="input" type="number" min="0.25" max="16" step="0.25" required value={f.hours} onChange={(e) => set('hours', e.target.value)} /></label>
      </div>
      <label><span>{tr('What it was for')}</span><input className="input" required value={f.reason} onChange={(e) => set('reason', e.target.value)} placeholder={tr('e.g. unloading the kiln, a rush order')} /></label>
      <p className="x7-muted">{tr('Paid at {a}× on a weekday, {b}× on a rest day and {c}× on a public holiday.', { a: num(d.rules.weekday), b: num(d.rules.restDay), c: num(d.rules.holiday) })}</p>
      {forOther && <label className="ot-check"><input type="checkbox" checked={f.approve} onChange={(e) => set('approve', e.target.checked)} /> {tr('Approve it now')}</label>}
    </Dialog>
  );
}

function RulesDialog({ d, onClose, onDone }) {
  const [f, setF] = useState({ ...d.rules });
  const s = useSend(onDone);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Dialog title={tr('Overtime rates')} icon="⚙️" sub={tr('What an hour of overtime is paid, as a multiple of the hourly rate.')} onClose={onClose} onSubmit={() => s.send(() => api.put('/overtime/rules', f))} busy={s.busy} error={s.error} submit={tr('Save')}>
      <div className="x7-grid2">
        <label><span>☀️ {tr('Weekday')}</span><input className="input" type="number" min="1" max="5" step="0.05" value={f.weekday} onChange={(e) => set('weekday', e.target.value)} /></label>
        <label><span>🛌 {tr('Rest day')}</span><input className="input" type="number" min="1" max="5" step="0.05" value={f.restDay} onChange={(e) => set('restDay', e.target.value)} /></label>
        <label><span>🎉 {tr('Public holiday')}</span><input className="input" type="number" min="1" max="5" step="0.05" value={f.holiday} onChange={(e) => set('holiday', e.target.value)} /></label>
        <label><span>🕗 {tr('Hours in a working day')}</span><input className="input" type="number" min="4" max="12" step="0.5" value={f.hoursPerDay} onChange={(e) => set('hoursPerDay', e.target.value)} /></label>
      </div>
      <p className="x7-muted">{tr('The hourly rate is the person\'s own if they have one; else their monthly basic over the month\'s working days and the hours in a day, or their daily rate over the hours in a day. Overtime is taxed with the pay, not counted for SSNIT.')}</p>
    </Dialog>
  );
}

// One request, with what the clock said and the sum.
function Sheet({ id, d, onClose, onChanged }) {
  const [r, setR] = useState(null);
  const [error, setError] = useState(null);
  const [no, setNo] = useState(null);
  const s = useSend((x) => { setNo(null); onChanged(x); });
  useEffect(() => { api.get('/overtime/' + id).then(setR).catch((e) => setError(e.message)); }, [id]);
  if (!r) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const canDecide = d.canDecide && r.status === 'pending' && r.person.id !== d.me.id;
  const c = r.clock;
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet ot-sheet" role="dialog" aria-modal="true" aria-labelledby="ot-s-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={{ '--g1': r.kind === 'holiday' ? '#db2777' : r.kind === 'rest_day' ? '#7c3aed' : '#0f766e', '--g2': r.kind === 'holiday' ? '#f59e0b' : r.kind === 'rest_day' ? '#2563eb' : '#0891b2' }}>
          <Photo id={r.person.id} name={r.person.name} photo={r.person.photo} size={54} className="x7-avatar" />
          <div><small>{[r.person.role, r.person.department].filter(Boolean).join(' · ')}</small><h2 id="ot-s-t">{r.person.name}</h2>
            <p><b>{hours(r.hours)}</b><span className="x7-pill">📅 {dayText(r.day)}</span><span className="x7-pill">{KIND[r.kind][0]} {tr(KIND[r.kind][1])}</span><span className="x7-pill">{STATUS[r.status][0]} {tr(STATUS[r.status][1])}</span></p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <p className="x7-note">📝 {r.reason}{r.askedBy ? ' · ' + tr('put in by {name}', { name: r.askedBy }) : ''}</p>
        <div className="ot-clock">
          <h3>🕘 {tr('What the clock said')}</h3>
          {!c ? <p className="x7-muted">{tr('No clock-in that day.')}</p> : (
            <div className="ot-clock-row">
              <span><em>{c.in}</em><small>{tr('clocked in')}</small></span>
              <span className="ot-arrow" aria-hidden="true">→</span>
              <span><em>{c.out || '—'}</em><small>{tr('clocked out')}</small></span>
              {c.hours != null && <span><em>{num(c.hours, 1)} h</em><small>{tr('on site')}</small></span>}
              {c.shiftEnd && <span className={c.past != null && c.past + 0.25 < r.hours ? 'is-bad' : 'is-good'}><em>{c.past != null ? num(c.past, 1) + ' h' : '—'}</em><small>{tr('past the {t} end', { t: c.shiftEnd })}</small></span>}
            </div>
          )}
          {c && c.past != null && c.past + 0.25 < r.hours && <p className="x7-flash is-warn">⚠️ {tr('The clock shows less than the hours asked for.')}</p>}
        </div>
        <div className="ot-sum">
          <span>{hours(r.hours)}</span><i>×</i><span>{r.rate != null ? money(r.rate) : '—'}<small>{tr('an hour')}</small></span><i>×</i><span>{num(r.multiple)}<small>{tr(KIND[r.kind][1])}</small></span><i>=</i><b>{r.amount != null ? money(r.amount) : '—'}</b>
        </div>
        <p className="x7-muted">{tr('{h} approved this month for them, this one included if approved.', { h: hours(r.monthHours || 0) })}{r.payRun ? ' · ' + tr('On pay run {run}', { run: r.payRun.runNo }) : ''}</p>
        {r.decidedBy && <p className="x7-note">{STATUS[r.status][0]} {tr('{status} by {name}', { status: tr(STATUS[r.status][1]), name: r.decidedBy })}{r.note ? ': ' + r.note : ''}</p>}
        {s.error && <div className="error-banner" role="alert">{s.error}</div>}
        <div className="ot-acts">
          {canDecide && <button type="button" className="btn btn-primary" disabled={s.busy} onClick={() => s.send(() => api.post('/overtime/' + r.id + '/decision', { decision: 'approved' }))}>✅ {tr('Approve')}</button>}
          {canDecide && <button type="button" className="btn btn-secondary" onClick={() => setNo('')}>✋ {tr('Not approved')}</button>}
          {(r.status === 'pending' || (r.status === 'approved' && d.canDecide && r.person.id !== d.me.id)) && !r.payRun && <button type="button" className="btn btn-secondary" disabled={s.busy} onClick={() => { if (window.confirm(tr('Take this overtime back?'))) s.send(() => api.post('/overtime/' + r.id + '/cancel')); }}>↩️ {tr('Take back')}</button>}
        </div>
        {no != null && <Dialog title={tr('Not approved')} icon="✋" sub={tr('Say why, for them to read.')} onClose={() => setNo(null)} onSubmit={() => s.send(() => api.post('/overtime/' + r.id + '/decision', { decision: 'rejected', note: no }))} busy={s.busy} error={s.error} submit={tr('Not approved')} danger>
          <textarea className="input" rows={3} required value={no} onChange={(e) => setNo(e.target.value)} />
        </Dialog>}
      </div>
    </div>
  );
}

function Row({ r, onOpen, mine }) {
  return (
    <button type="button" className={'x7-row ot-row is-' + r.status} onClick={() => onOpen(r)}>
      {mine ? <span className="x7-icon" aria-hidden="true">{KIND[r.kind][0]}</span> : <Photo id={r.person.id} name={r.person.name} photo={r.person.photo} size={40} />}
      <span className="x7-who"><b>{mine ? dayText(r.day) : r.person.name} · {hours(r.hours)}</b><small>{mine ? '' : dayText(r.day) + ' · '}{r.reason}</small></span>
      <span className="ot-row-tags"><KindPill r={r} /><span className={'x7-pill ' + STATUS[r.status][2]}>{STATUS[r.status][0]} {tr(STATUS[r.status][1])}</span></span>
      <span className="x7-money"><b>{r.amount != null ? money(r.amount) : '—'}</b>{r.payRun && <small>{r.payRun.runNo}</small>}</span>
    </button>
  );
}

export default function OvertimePage() {
  const [params, setParams] = useSearchParams();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [dlg, setDlg] = useState(null);
  const open = params.get('o');
  const load = useCallback(() => api.get('/overtime').then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const s = d.summary;
  const team = d.canDecide || d.canPay;
  const top = Math.max(1, ...d.days.map((x) => x.hours));
  const best = Math.max(1, ...d.top.map((x) => x.hours));
  const show = (r) => setParams(r ? { o: r.id } : {});
  const monthName = new Date(d.month + '-01T12:00:00Z').toLocaleDateString(activeIntlLocale(), { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return (
    <div className="x7 ot">
      <header className="x7-head">
        <div>
          <h1>⏱️ {tr('Overtime')}</h1>
          <p>{tr('Hours worked past the shift: asked for once worked, approved by the manager, and paid with the next pay run — more on rest days and public holidays.')}</p>
        </div>
        <div className="x7-head-actions">
          {d.canPay && <button type="button" className="btn btn-secondary" onClick={() => setDlg({ k: 'rules' })}>⚙️ {tr('Rates')}</button>}
          {d.canDecide && <button type="button" className="btn btn-secondary" onClick={() => setDlg({ k: 'ask', other: true })}>👥 {tr('Put in for someone')}</button>}
          <button type="button" className="btn btn-primary" onClick={() => setDlg({ k: 'ask' })}>⏱️ {tr('Ask for overtime')}</button>
        </div>
      </header>
      {team && <div className="x7-tiles">
        <div className="x7-tile is-teal"><small>⏱️ {tr('Hours this month')}</small><b>{num(s.hours, 1)}</b><span>{s.people === 1 ? tr('1 person') : tr('{n} people', { n: s.people })}</span></div>
        <div className="x7-tile is-violet"><small>💰 {tr('Cost this month')}</small><b>{money(s.cost)}</b><span>{tr('approved and paid')}</span></div>
        <div className={'x7-tile ' + (s.pending ? 'is-warn' : 'is-good')}><small>⏳ {tr('To approve')}</small><b>{s.pending}</b><span>{s.pending ? hours(s.pendingHours) : tr('nothing waiting')}</span></div>
        <div className="x7-tile is-calm"><small>💸 {tr('For the next pay run')}</small><b>{money(s.toPayAmount)}</b><span>{s.toPay === 1 ? tr('1 approved') : tr('{n} approved', { n: s.toPay })}</span></div>
        <div className="x7-tile is-bad"><small>🎉 {tr('Rest days and holidays')}</small><b>{num(s.holidayHours, 1)} h</b><span>{tr('at the higher rate')}</span></div>
      </div>}
      {team && <section className="x7-card ot-month">
        <h2>📊 {tr('Hours each day')} <small>{monthName}</small></h2>
        <div className="ot-days" role="img" aria-label={tr('{h} hours of overtime in {month}', { h: num(s.hours, 1), month: monthName })}>
          {d.days.map((x) => {
            const wd = new Date(x.day + 'T12:00:00Z').getUTCDay();
            return <span key={x.day} className={'ot-day' + (wd === 0 || wd === 6 ? ' is-weekend' : '') + (x.day === today() ? ' is-today' : '')} title={dayText(x.day) + ': ' + hours(x.hours)}><i style={{ height: (x.hours / top * 100) + '%' }} /><small>{Number(x.day.slice(8))}</small></span>;
          })}
        </div>
      </section>}
      <div className={team ? 'ot-cols' : ''}>
        <div className="ot-main">
          {d.canDecide && <section className="x7-card">
            <h2>⏳ {tr('Waiting for approval')} <small>{d.pending.length}</small></h2>
            {!d.pending.length ? <p className="x7-muted">{tr('Nothing waiting. 🎉')}</p> : <div className="x7-list">{d.pending.map((r) => <Row key={r.id} r={r} onOpen={show} />)}</div>}
          </section>}
          {team && <section className="x7-card">
            <h2>💸 {tr('Approved, for the next pay run')} <small>{money(s.toPayAmount)}</small></h2>
            {!d.approved.length ? <p className="x7-muted">{tr('Nothing waiting for the payroll.')}</p> : <div className="x7-list">{d.approved.map((r) => <Row key={r.id} r={r} onOpen={show} />)}</div>}
          </section>}
          <section className="x7-card">
            <h2>🙋 {tr('Mine')} <small>{d.mine.length}</small></h2>
            {!d.mine.length ? <div className="x7-empty"><span aria-hidden="true">⏱️</span><p>{tr('No overtime asked for yet.')}</p></div> : <div className="x7-list">{d.mine.map((r) => <Row key={r.id} r={r} onOpen={show} mine />)}</div>}
          </section>
          {team && d.done.length > 0 && <section className="x7-card">
            <h2>🗂️ {tr('Decided lately')}</h2>
            <div className="x7-list">{d.done.slice(0, 12).map((r) => <Row key={r.id} r={r} onOpen={show} />)}</div>
          </section>}
        </div>
        {team && <aside className="x7-card ot-top">
          <h2>🏅 {tr('Most overtime this month')}</h2>
          {!d.top.length ? <p className="x7-muted">{tr('None yet this month.')}</p> : d.top.map((p) => (
            <div key={p.person.id} className="ot-top-row">
              <Photo id={p.person.id} name={p.person.name} photo={p.person.photo} size={32} />
              <span><b>{p.person.name}</b><small>{hours(p.hours)} · {money(p.amount)}</small><i style={{ width: (p.hours / best * 100) + '%' }} /></span>
            </div>
          ))}
          <p className="x7-muted ot-rates">{tr('Paid at {a}× on a weekday, {b}× on a rest day and {c}× on a public holiday.', { a: num(d.rules.weekday), b: num(d.rules.restDay), c: num(d.rules.holiday) })}</p>
        </aside>}
      </div>
      {dlg && dlg.k === 'ask' && <AskDialog d={d} forOther={dlg.other} onClose={() => setDlg(null)} onDone={(r) => { setDlg(null); load(); show(r); }} />}
      {dlg && dlg.k === 'rules' && <RulesDialog d={d} onClose={() => setDlg(null)} onDone={() => { setDlg(null); load(); }} />}
      {open && <Sheet key={open} id={open} d={d} onClose={() => show(null)} onChanged={() => { load(); show(null); }} />}
    </div>
  );
}
