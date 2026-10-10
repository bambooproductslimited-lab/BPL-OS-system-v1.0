import { useMemo, useState } from 'react';
import { api } from '../api/client';
import { money, moneyBreakdown } from '../lib/currency';
import { tr, msg } from '../lib/i18n.jsx';
import { fmtDate } from './DashKit';
import './EmailDocumentDialog.css';
import './InvoiceCleanupDialog.css';

// Old invoices cleared in one go (backend invoiceCleanup.service.js): tick
// the ones that will never be paid, or that were paid and never recorded,
// say what happened and why, and each is recorded as paid, written off with
// a credit note, or voided, under the same rules as doing it by hand. What
// cannot be done is listed with why; the rest still go through.
// rent: Poki Properties' rent and utility bills (Rent & utilities, POST
// /poki/invoices/cleanup), in a landlord's words: tenants and bills.

const AGES = [[90, msg('Over 3 months')], [180, msg('Over 6 months')], [365, msg('Over a year')], [730, msg('Over 2 years')]];
const METHODS = [['bank_transfer', msg('Bank transfer')], ['cash', msg('Cash')], ['mobile_money', msg('Mobile Money')], ['card', msg('Card')], ['cheque', msg('Cheque')], ['other', msg('Other')]];
const ACTIONS = [
  { key: 'write_off', icon: 'eraser', title: msg('Write it off'), when: msg('The goods went out, but the money will not come.'),
    what: msg('A credit note takes off what is left. The invoice stays, with its total, and owes nothing.') },
  { key: 'paid', icon: 'cash', title: msg('They paid — record it'), when: msg('The money came in, but was never recorded here.'),
    what: msg('A payment of what is left, with a receipt. No email goes to the customer.') },
  { key: 'void', icon: 'ban', title: msg('Void — the sale never happened'), when: msg('Entered by mistake, twice, or the order was cancelled.'),
    what: msg('Cancelled and kept for the record; any stock it took goes back. Only for invoices with no payments.') }
];
// The same three, for rent and utility bills.
const RENT_ACTIONS = [
  { key: 'write_off', icon: 'eraser', title: msg('Write it off'), when: msg('The tenant had the place or the service, but the money will not come.'),
    what: msg('A credit note takes off what is left. The bill stays, with its total, and owes nothing.') },
  { key: 'paid', icon: 'cash', title: msg('They paid — record it'), when: msg('The money came in, but was never recorded here.'),
    what: msg('A payment of what is left, with a receipt. No email goes to the tenant. A rent bill paid off marks the deposit as held, as usual.') },
  { key: 'void', icon: 'ban', title: msg('Void — it should never have been billed'), when: msg('Billed by mistake, or twice.'),
    what: msg('Cancelled and kept for the record; meter readings and recurring charges on it go back to not billed. Only for bills with no payments.') }
];
// Why one could not be done (the server's words), so they can be shown in
// the reader's language.
const KNOWN_ERRORS = [
  msg('Nothing is owed on this invoice.'), msg('This invoice is paid; it cannot be voided.'),
  msg('Part of this invoice has been paid, so it cannot be voided. Write off what is left instead.'),
  msg('Invoice not found.'), msg('This invoice has been voided.'), msg('This invoice has already been voided.'), msg('This invoice is already fully paid.')
];
const GLYPHS = {
  broom: <><path d="M19 3 11 11" /><path d="M7.5 10.5 13.5 16.5" /><path d="M7.5 10.5C5 12 4 15 3 21c6-1 9-2 10.5-4.5" /><path d="M7 17l-1.5 1.5" /></>,
  eraser: <><path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 19" /><path d="M7 21h14" /><path d="m5 11 8 8" /></>,
  cash: <><rect x="2.5" y="6" width="19" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /><path d="M6 9.5v5M18 9.5v5" /></>,
  ban: <><circle cx="12" cy="12" r="9" /><path d="m5.7 5.7 12.6 12.6" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6 6 18" />
};
function Glyph({ name, size = 18 }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{GLYPHS[name]}</svg>;
}

function todayIso() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function dayNum(iso) { return Math.floor(new Date(String(iso).slice(0, 10) + 'T00:00:00Z').getTime() / 86400000); }
function daysLate(inv) { return inv.dueDate ? dayNum(todayIso()) - dayNum(inv.dueDate) : 0; }
function sumOf(list) {
  const m = {};
  list.forEach((x) => { m[x.currency] = (m[x.currency] || 0) + Number(x.balanceDue || 0); });
  return Object.entries(m).filter(([, a]) => a > 0.005).map(([currency, amount]) => ({ currency, amount }));
}
function yearsMonths(days) {
  const y = Math.floor(days / 365), mo = Math.floor((days % 365) / 30);
  if (y && mo) return tr('{y} yr {m} mo late', { y, m: mo });
  if (y) return tr('{y} yr late', { y });
  return tr('{n} days late', { n: days });
}

export default function InvoiceCleanupDialog({ invoices, onClose, onDone, startDays = 365, rent = false }) {
  const actions = rent ? RENT_ACTIONS : ACTIONS;
  const [days, setDays] = useState(startDays);
  const [picked, setPicked] = useState(() => new Set());
  const [action, setAction] = useState('write_off');
  const [method, setMethod] = useState('bank_transfer');
  const [date, setDate] = useState(todayIso());
  // Old bills paid long ago: dated the day each was due, so they do not count as money in this week.
  const [paidOn, setPaidOn] = useState('due');
  const [reason, setReason] = useState('');
  const [step, setStep] = useState('pick'); // pick → confirm → done
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const old = useMemo(() => invoices
    .filter((inv) => (inv.status === 'unpaid' || inv.status === 'partially_paid') && inv.balanceDue > 0.005 && daysLate(inv) > days)
    .sort((a, b) => daysLate(b) - daysLate(a)), [invoices, days]);
  const ticked = old.filter((inv) => picked.has(inv.id));
  const withPayments = ticked.filter((inv) => inv.amountPaid > 0);
  const willDo = action === 'void' ? ticked.filter((inv) => !(inv.amountPaid > 0)) : ticked;
  const allOn = old.length > 0 && ticked.length === old.length;
  const busy = saving;

  function toggle(id) {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPicked(next);
  }
  function tickAll() { setPicked(allOn ? new Set() : new Set(old.map((inv) => inv.id))); }

  const verb = {
    write_off: (n) => (n === 1 ? tr('Write off 1 invoice') : tr('Write off {n} invoices', { n })),
    paid: (n) => (n === 1 ? tr('Record 1 invoice as paid') : tr('Record {n} invoices as paid', { n })),
    void: (n) => (n === 1 ? tr('Void 1 invoice') : tr('Void {n} invoices', { n }))
  }[action];
  const canGo = willDo.length > 0 && reason.trim() && !(action === 'paid' && paidOn === 'one' && (!date || date > todayIso()));

  async function run() {
    setSaving(true); setError(null);
    try {
      const res = await api.post(rent ? '/poki/invoices/cleanup' : '/invoices/cleanup', {
        invoiceIds: ticked.map((inv) => inv.id), action, reason: reason.trim(),
        method: action === 'paid' ? method : undefined, paidOn: action === 'paid' ? paidOn : undefined, date: action === 'paid' && paidOn === 'one' ? date : undefined
      });
      setResult(res); setStep('done');
      if (onDone) onDone(res);
    } catch (err) { setError(err.message); setStep('pick'); }
    setSaving(false);
  }

  const act = actions.find((a) => a.key === action);
  return (
    <div className="dialog-backdrop ed-over" onClick={() => !busy && onClose()}>
      <div className="dialog ed icu" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="icu-title">
        <div className="ed-head">
          <span className="ed-head-icon"><Glyph name="broom" size={20} /></span>
          <div>
            <h2 id="icu-title">{rent ? tr('Clean up old rent and utility bills') : tr('Clean up old invoices')}</h2>
            <p className="ed-sub">{rent
              ? tr('Clear out bills tenants will never pay, or that were paid and never recorded: tick them, say what happened and why, and they are all done in one go. Each one is kept in the audit log.')
              : tr('Clear out invoices that will never be paid, or that were paid and never recorded: tick them, say what happened and why, and they are all done in one go. Each one is kept in the audit log.')}</p>
          </div>
        </div>

        {step === 'done' && result ? (
          <>
            <div className="ed-done" role="status">
              <span className="ed-done-icon"><Glyph name="check" size={26} /></span>
              <strong>{{
                write_off: result.done === 1 ? tr('1 invoice written off') : tr('{n} invoices written off', { n: result.done }),
                paid: result.done === 1 ? tr('1 invoice recorded as paid') : tr('{n} invoices recorded as paid', { n: result.done }),
                void: result.done === 1 ? tr('1 invoice voided') : tr('{n} invoices voided', { n: result.done })
              }[result.action]}</strong>
              <span>
                {result.totals.length > 0 && tr('{amount} no longer shows as owed.', { amount: moneyBreakdown(result.totals) })}
                {result.failed > 0 && ' ' + (result.failed === 1 ? tr('1 could not be done; see why below.') : tr('{n} could not be done; see why below.', { n: result.failed }))}
              </span>
            </div>
            <ul className="icu-results">
              {result.results.map((x) => (
                <li key={x.id} className={x.ok ? 'is-ok' : 'is-bad'}>
                  <span className="icu-res-icon"><Glyph name={x.ok ? 'check' : 'x'} size={14} /></span>
                  <span className="icu-res-text">
                    <strong>{x.invoiceNo || '—'}{x.customerName ? ' · ' + x.customerName : ''}</strong>
                    <span>{x.ok
                      ? [x.amount > 0 && money(x.amount, x.currency), x.made && (result.action === 'paid' ? tr('receipt {no}', { no: x.made }) : tr('credit note {no}', { no: x.made }))].filter(Boolean).join(' · ') || tr('Voided')
                      : KNOWN_ERRORS.includes(x.error) ? tr(x.error) : x.error}</span>
                  </span>
                </li>
              ))}
            </ul>
            <div className="dialog-actions">
              <button type="button" className="btn btn-primary" onClick={onClose}>{tr('Done')}</button>
            </div>
          </>
        ) : step === 'confirm' ? (
          <>
            <div className={'icu-confirm is-' + action} role="alert">
              <span className="icu-confirm-icon"><Glyph name={act.icon} size={22} /></span>
              <div>
                <strong>{verb(willDo.length)} · {moneyBreakdown(sumOf(willDo))}</strong>
                <p>{tr(act.what)}</p>
                {action === 'paid' && <p>{paidOn === 'due' ? tr('Paid by {method}, each on the day it was due.', { method: tr(METHODS.find((m) => m[0] === method)[1]) }) : tr('Paid by {method} on {date}.', { method: tr(METHODS.find((m) => m[0] === method)[1]), date: fmtDate(date) })}</p>}
                <p className="icu-why">“{reason.trim()}”</p>
                {action === 'void' && withPayments.length > 0 && <p>{withPayments.length === 1 ? tr('1 ticked invoice has payments, so it will be left as it is.') : tr('{n} ticked invoices have payments, so they will be left as they are.', { n: withPayments.length })}</p>}
                <p className="icu-small">{tr('This cannot be undone from here. It is recorded in the audit log under your name.')}</p>
              </div>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setStep('pick')}>{tr('Back')}</button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={run}>{busy ? tr('Working…') : tr('Yes, do it')}</button>
            </div>
          </>
        ) : (
          <>
            <section className="icu-step" aria-labelledby="icu-s1">
              <div className="icu-step-head">
                <span className="icu-num">1</span>
                <h3 id="icu-s1">{tr('Which invoices')}</h3>
              </div>
              <div className="tl-seg icu-ages" role="radiogroup" aria-label={tr('How late')}>
                {AGES.map(([d, label]) => (
                  <button key={d} type="button" role="radio" aria-checked={days === d} className={'tl-seg-btn' + (days === d ? ' is-on' : '')}
                    onClick={() => { setDays(d); setPicked(new Set()); }}>{tr(label)}</button>
                ))}
              </div>
              {!old.length ? (
                <div className="dk-empty icu-empty"><p>{tr('Nothing is owed from that long ago.')}</p></div>
              ) : (
                <>
                  <div className="icu-bar">
                    <label className="icu-all">
                      <input type="checkbox" checked={allOn} onChange={tickAll} />
                      <span>{allOn ? tr('Untick all') : tr('Tick all {n}', { n: old.length })}</span>
                    </label>
                    <span className="icu-small">{tr('{n} owed · {amount}', { n: old.length, amount: moneyBreakdown(sumOf(old)) })}</span>
                  </div>
                  <ul className="icu-list">
                    {old.map((inv) => {
                      const on = picked.has(inv.id);
                      return (
                        <li key={inv.id}>
                          <label className={'icu-row' + (on ? ' is-on' : '')}>
                            <input type="checkbox" checked={on} onChange={() => toggle(inv.id)} />
                            <span className="icu-row-main">
                              <strong>{inv.customerName}</strong>
                              <span className="icu-small">{[inv.invoiceNo, inv.unitCode ? [inv.propertyName, inv.unitCode].filter(Boolean).join(' ') : null, tr('issued {date}', { date: fmtDate(inv.issuedAt) })].filter(Boolean).join(' · ')}</span>
                            </span>
                            <span className="icu-row-late">{yearsMonths(daysLate(inv))}{inv.amountPaid > 0 && <em>{tr('part-paid')}</em>}</span>
                            <span className="icu-row-amt">
                              <strong>{money(inv.balanceDue, inv.currency)}</strong>
                              {inv.amountPaid > 0 && <span className="icu-small">{tr('of {amount}', { amount: money(inv.grandTotal, inv.currency) })}</span>}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </section>

            <section className="icu-step" aria-labelledby="icu-s2">
              <div className="icu-step-head">
                <span className="icu-num">2</span>
                <h3 id="icu-s2">{tr('What happened')}</h3>
              </div>
              <div className="icu-actions" role="radiogroup" aria-labelledby="icu-s2">
                {actions.map((a) => (
                  <button key={a.key} type="button" role="radio" aria-checked={action === a.key} className={'icu-act is-' + a.key + (action === a.key ? ' is-on' : '')} onClick={() => setAction(a.key)}>
                    <span className="icu-act-icon"><Glyph name={a.icon} /></span>
                    <strong>{tr(a.title)}</strong>
                    <span className="icu-act-when">{tr(a.when)}</span>
                    <span className="icu-act-what">{tr(a.what)}</span>
                  </button>
                ))}
              </div>
              {action === 'paid' && (
                <div className="ed-grid icu-paid">
                  <label className="field">
                    <span className="field-label">{tr('Paid by')}</span>
                    <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
                      {METHODS.map(([k, label]) => <option key={k} value={k}>{tr(label)}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    <span className="field-label">{tr('Dated')}</span>
                    <select className="input" value={paidOn} onChange={(e) => setPaidOn(e.target.value)}>
                      <option value="due">{tr('The day each bill was due')}</option>
                      <option value="one">{tr('One date I choose')}</option>
                    </select>
                    {paidOn === 'one'
                      ? <input className="input" type="date" max={todayIso()} value={date} onChange={(e) => setDate(e.target.value)} aria-label={tr('On')} />
                      : null}
                    <small className="icu-small">{paidOn === 'due'
                      ? tr('Money that came in long ago is dated when it was due, so it does not count as money in this week.')
                      : tr('When the money came in. Today counts it as money in this week.')}</small>
                  </label>
                </div>
              )}
              {action === 'void' && withPayments.length > 0 && (
                <div className="ed-note is-warn">{withPayments.length === 1
                  ? tr('1 ticked invoice has payments and cannot be voided; it will be left as it is. Write off what is left on it instead.')
                  : tr('{n} ticked invoices have payments and cannot be voided; they will be left as they are. Write off what is left on them instead.', { n: withPayments.length })}</div>
              )}
            </section>

            <section className="icu-step" aria-labelledby="icu-s3">
              <div className="icu-step-head">
                <span className="icu-num">3</span>
                <h3 id="icu-s3"><label htmlFor="icu-reason">{tr('Why')}</label></h3>
              </div>
              <textarea id="icu-reason" className="input icu-reason" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder={rent
                  ? (action === 'paid' ? tr('e.g. Paid in cash at the office; found in the receipt book') : action === 'void' ? tr('e.g. March water billed twice') : tr('e.g. The tenant left in 2025 and cannot be reached'))
                  : (action === 'paid' ? tr('e.g. Paid in cash at the time; found in the Square records') : action === 'void' ? tr('e.g. Entered twice when the Square sales came in') : tr('e.g. Over a year old; the customer cannot be reached'))} />
              <small className="icu-small">{action === 'write_off' ? tr('Kept in the audit log, and written on each credit note.') : tr('Kept in the audit log with each invoice.')}</small>
            </section>

            {error && <div className="error-banner" role="alert">{error}</div>}
            <div className="dialog-actions icu-foot">
              <span className="icu-small icu-sum" aria-live="polite">{ticked.length ? tr('{n} ticked · {amount}', { n: ticked.length, amount: moneyBreakdown(sumOf(ticked)) }) : tr('Nothing ticked yet')}</span>
              <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={!canGo} onClick={() => setStep('confirm')}>{verb(willDo.length)}…</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
