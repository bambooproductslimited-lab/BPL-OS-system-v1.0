import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { tr } from '../lib/i18n.jsx';
import { Status, fmtDate } from './DashKit';
import './RepeatInvoice.css';

// Repeating invoices (backend invoiceSeries.service.js): an invoice raised
// again every week, month, quarter or year, until a day or a number of
// times, emailed to the customer when asked.

const EVERY = [['week', 'Every week'], ['month', 'Every month'], ['quarter', 'Every quarter'], ['year', 'Every year']];
function today() { return new Date().toISOString().slice(0, 10); }
// The same day, n periods on (the 31st becomes the last day of a short month).
function advance(day, every, n) {
  const d = new Date(day + 'T00:00:00Z');
  if (every === 'week') { d.setUTCDate(d.getUTCDate() + 7 * n); return d.toISOString().slice(0, 10); }
  const months = every === 'month' ? n : every === 'quarter' ? 3 * n : 12 * n;
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d.getUTCDate(), last));
  return t.toISOString().slice(0, 10);
}
function cadence(s) {
  const unit = { week: tr('weeks'), month: tr('months'), quarter: tr('quarters'), year: tr('years') }[s.every];
  return s.everyN > 1 ? tr('Every {n} {unit}', { n: s.everyN, unit }) : tr((EVERY.find((e) => e[0] === s.every) || EVERY[1])[1]);
}

export function RepeatDialog({ invoice, onClose, onDone }) {
  const issued = String(invoice.issuedAt || today()).slice(0, 10);
  const [every, setEvery] = useState('month');
  const [everyN, setEveryN] = useState(1);
  const [startOn, setStartOn] = useState(() => { let d = advance(issued, 'month', 1); while (d < today()) d = advance(d, 'month', 1); return d; });
  const [ends, setEnds] = useState('never');
  const [endsOn, setEndsOn] = useState('');
  const [maxCount, setMaxCount] = useState(12);
  const [dueDays, setDueDays] = useState(14);
  const [autoEmail, setAutoEmail] = useState(!!invoice.customerEmail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function pickEvery(v) {
    setEvery(v);
    let d = advance(issued, v, everyN);
    while (d < today()) d = advance(d, v, everyN);
    setStartOn(d);
  }
  // The next few days it will be raised, to see at a glance.
  const days = [];
  for (let d = startOn, k = 0; d && k < 4; k++) {
    if (ends === 'on' && endsOn && d > endsOn) break;
    if (ends === 'after' && k >= maxCount) break;
    days.push(d);
    d = advance(d, every, everyN);
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api.post('/invoices/' + invoice.id + '/repeat', {
        every, everyN, startOn, dueDays, autoEmail,
        endsOn: ends === 'on' ? endsOn : null, maxCount: ends === 'after' ? maxCount : null
      });
      onDone();
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <div className="dialog-backdrop ed-over no-print" onClick={() => !busy && onClose()}>
      <form className="dialog rpt" onClick={(e) => e.stopPropagation()} onSubmit={save} role="dialog" aria-modal="true" aria-labelledby="rpt-title">
        <div className="rpt-head">
          <span className="rpt-ico" aria-hidden="true">🔁</span>
          <div>
            <h2 id="rpt-title">{tr('Repeat this invoice')}</h2>
            <p className="dk-muted">{tr('{invoice} for {customer}, {amount}: raised again by itself, with the same lines and prices.', { invoice: invoice.invoiceNo, customer: invoice.customerName, amount: money(invoice.grandTotal, invoice.currency) })}</p>
          </div>
        </div>
        <div className="rpt-every" role="radiogroup" aria-label={tr('How often')}>
          {EVERY.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={every === k} className={every === k ? 'is-on' : ''} onClick={() => pickEvery(k)}>{tr(label)}</button>)}
        </div>
        <div className="rpt-grid">
          <label>{tr('Every how many')}
            <input className="input" type="number" min="1" max="12" value={everyN} onChange={(e) => setEveryN(Math.max(1, Math.min(12, Number(e.target.value) || 1)))} />
          </label>
          <label>{tr('First one on')}
            <input className="input" type="date" min={today()} value={startOn} onChange={(e) => setStartOn(e.target.value)} required />
          </label>
          <label>{tr('Due after (days)')}
            <input className="input" type="number" min="0" max="365" value={dueDays} onChange={(e) => setDueDays(Math.max(0, Math.min(365, Number(e.target.value) || 0)))} />
          </label>
        </div>
        <div className="rpt-ends">
          <span className="rpt-label">{tr('Stops')}</span>
          <label><input type="radio" name="rpt-ends" checked={ends === 'never'} onChange={() => setEnds('never')} /> {tr('Never, until stopped')}</label>
          <label><input type="radio" name="rpt-ends" checked={ends === 'after'} onChange={() => setEnds('after')} /> {tr('After')} <input className="input rpt-n" type="number" min="1" max="520" value={maxCount} onChange={(e) => { setEnds('after'); setMaxCount(Math.max(1, Number(e.target.value) || 1)); }} /> {tr('invoices')}</label>
          <label><input type="radio" name="rpt-ends" checked={ends === 'on'} onChange={() => setEnds('on')} /> {tr('On')} <input className="input rpt-date" type="date" min={startOn} value={endsOn} onChange={(e) => { setEnds('on'); setEndsOn(e.target.value); }} /></label>
        </div>
        <label className={'rpt-mail' + (invoice.customerEmail ? '' : ' is-off')}>
          <input type="checkbox" checked={autoEmail} disabled={!invoice.customerEmail} onChange={(e) => setAutoEmail(e.target.checked)} />
          <span><strong>{tr('Email each one to the customer')}</strong><small className="dk-muted">{invoice.customerEmail || tr('This customer has no email address.')}</small></span>
        </label>
        <div className="rpt-days" aria-label={tr('Next ones')}>
          {days.map((d, i) => <span key={d} className={'rpt-day' + (i === 0 ? ' is-first' : '')}><b>{new Date(d + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</b><small>{new Date(d + 'T00:00').getFullYear()}</small></span>)}
          {days.length === 4 && <span className="rpt-day is-more">…</span>}
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || (ends === 'on' && !endsOn)}>{busy ? tr('Saving…') : tr('Repeat it')}</button>
        </div>
      </form>
    </div>
  );
}

// Every repeating invoice: when the next one is raised, how many so far,
// pause, start again or stop.
export function SeriesDialog({ canManage, onClose, onChanged }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  function load() { api.get('/invoices/series').then(setList).catch((e) => setError(e.message)); }
  useEffect(load, []);
  async function set(s, status) {
    setBusy(s.id); setError('');
    try { await api.patch('/invoices/series/' + s.id, { status }); load(); onChanged(); }
    catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }
  return (
    <div className="dialog-backdrop ed-over no-print" onClick={onClose}>
      <div className="dialog rpt rpt-list" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="rpl-title">
        <div className="rpt-head">
          <span className="rpt-ico" aria-hidden="true">🔁</span>
          <div>
            <h2 id="rpl-title">{tr('Repeating invoices')}</h2>
            <p className="dk-muted">{tr('Invoices raised again by themselves. Open an invoice and press Repeat to add one.')}</p>
          </div>
        </div>
        {!list && !error && <p className="dk-muted">{tr('Loading…')}</p>}
        {list && !list.length && <p className="dk-muted rpt-empty">{tr('Nothing repeats yet.')}</p>}
        <ul className="rpt-cards">
          {(list || []).map((s) => (
            <li key={s.id} className={'rpt-card is-' + s.status}>
              <div className="rpt-card-main">
                <strong>{s.customerName}</strong>
                <span className="dk-muted tl-small">{cadence(s)} · {s.amount != null ? money(s.amount, s.currency) : ''}{s.templateNo ? ' · ' + tr('from {invoice}', { invoice: s.templateNo }) : ''}</span>
                <span className="rpt-card-tags">
                  <Status tone={s.status === 'active' ? 'good' : s.status === 'paused' ? 'warn' : 'muted'}>{s.status === 'active' ? tr('Next on {date}', { date: fmtDate(s.nextOn) }) : s.status === 'paused' ? tr('Paused') : tr('Stopped')}</Status>
                  <Status tone="muted">{s.raised === 1 ? tr('1 raised') : tr('{n} raised', { n: s.raised })}{s.maxCount ? ' / ' + s.maxCount : ''}</Status>
                  {s.endsOn && s.status !== 'ended' && <Status tone="muted">{tr('until {date}', { date: fmtDate(s.endsOn) })}</Status>}
                  {s.autoEmail && <Status tone="info">✉️ {tr('emailed')}</Status>}
                  {s.lastInvoice && <Link className="rpt-last" to={'/invoices?open=' + s.lastInvoice.id} onClick={onClose}>{s.lastInvoice.invoiceNo}</Link>}
                </span>
                {s.lastError && s.status === 'active' && <span className="rpt-err">⚠ {s.lastError}</span>}
              </div>
              {canManage && s.status !== 'ended' && (
                <div className="rpt-card-acts">
                  {s.status === 'active'
                    ? <button type="button" className="btn btn-secondary" disabled={busy === s.id} onClick={() => set(s, 'paused')}>{tr('Pause')}</button>
                    : <button type="button" className="btn btn-secondary" disabled={busy === s.id} onClick={() => set(s, 'active')}>{tr('Start again')}</button>}
                  <button type="button" className="btn btn-secondary" disabled={busy === s.id} onClick={() => set(s, 'ended')}>{tr('Stop')}</button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button></div>
      </div>
    </div>
  );
}
